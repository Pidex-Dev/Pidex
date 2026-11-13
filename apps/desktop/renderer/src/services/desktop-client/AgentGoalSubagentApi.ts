import type { RpcResult } from '@pidex/agent-protocol'
import type { SubagentProjection } from '@pidex/shared/thread'
import type {
  DesktopApi,
  DesktopPermissionDecision,
  DesktopSubagentRead,
} from '../../../shared/Types.js'
import type { createAgentRpcClient } from '../AgentRpcClient.js'
import type { createAgentTurnQueueClient } from './AgentTurnQueueClient.js'
import type { DesktopClient } from './Types.js'

type PendingInteraction = RpcResult<'interaction/listPending'>['interactions'][number]

type GoalSubagentApiMethod =
  | 'listSubagents'
  | 'readSubagent'
  | 'stopSubagent'
  | 'retrySubagent'
  | 'sendSubagent'
  | 'followupSubagent'
  | 'applySubagentWorktree'
  | 'discardSubagentWorktree'
  | 'restoreSubagentWorkspace'
  | 'respondSubagentApproval'
  | 'respondSubagentPermission'
  | 'getSessionGoal'
  | 'setSessionGoal'
  | 'clearSessionGoal'

type GoalSubagentApi = Pick<DesktopClient, GoalSubagentApiMethod>

type Dependencies = {
  emitSessionStoreChange: () => void
  findPendingInteraction: (
    predicate: (interaction: PendingInteraction) => boolean,
    threadId?: string,
  ) => Promise<PendingInteraction>
  hasGoalCapability: () => boolean
  loadAgentSessionSnapshot: (sessionId: string) => Promise<unknown>
  mockClient: Pick<DesktopApi, 'getSessionGoal' | 'setSessionGoal' | 'clearSessionGoal'>
  respondToInteraction: (
    interaction: PendingInteraction,
    response: RpcResult<'interaction/respond'>['response'],
  ) => Promise<void>
  respondToPermissionInteraction: (
    interaction: Extract<PendingInteraction, { kind: 'permission' }>,
    decision: DesktopPermissionDecision,
  ) => Promise<void>
  rpc: Pick<ReturnType<typeof createAgentRpcClient>, 'call'>
  runGoalMutation: <T>(
    sessionId: string,
    operation: () => Promise<T>,
    retryConflict?: boolean,
  ) => Promise<T>
  turnQueueClient: Pick<ReturnType<typeof createAgentTurnQueueClient>, 'submitMessage'>
  unsupportedAgentOperation: (operation: string) => never
  withAgentOrMock: <T>(
    agentOperation: () => Promise<T>,
    mockOperation: () => Promise<T>,
  ) => Promise<T>
}

export function createAgentGoalSubagentApi({
  emitSessionStoreChange,
  findPendingInteraction,
  hasGoalCapability,
  loadAgentSessionSnapshot,
  mockClient,
  respondToInteraction,
  respondToPermissionInteraction,
  rpc,
  runGoalMutation,
  turnQueueClient,
  unsupportedAgentOperation,
  withAgentOrMock,
}: Dependencies): GoalSubagentApi {
  return {
    listSubagents: async (threadId) => {
      const response = await rpc.call<{ subagents: SubagentProjection[] }>('subagent/list', {
        threadId,
      })
      return response.subagents
    },
    readSubagent: (taskId) => rpc.call<DesktopSubagentRead>('subagent/read', { taskId }),
    stopSubagent: (taskId) =>
      rpc.call('subagent/stop', { taskId, operationId: crypto.randomUUID() }),
    retrySubagent: (taskId) =>
      rpc.call('subagent/retry', { taskId, operationId: crypto.randomUUID() }),
    sendSubagent: (taskId, message) =>
      rpc.call('subagent/send', { taskId, message, operationId: crypto.randomUUID() }),
    followupSubagent: (taskId, message) =>
      rpc.call('subagent/followup', { taskId, message, operationId: crypto.randomUUID() }),
    applySubagentWorktree: (taskId) =>
      rpc.call('subagent/worktree/apply', { taskId, operationId: crypto.randomUUID() }),
    discardSubagentWorktree: (taskId) =>
      rpc.call('subagent/worktree/discard', { taskId, operationId: crypto.randomUUID() }),
    restoreSubagentWorkspace: (taskId) =>
      rpc.call('subagent/workspace/restore', { taskId, operationId: crypto.randomUUID() }),
    respondSubagentApproval: async (approval, decision) => {
      const interaction = await findPendingInteraction(
        (candidate) =>
          candidate.kind === 'approval' &&
          (candidate.interactionId === approval.id || candidate.toolCallId === approval.toolCallID),
        approval.threadId,
      )
      if (interaction.kind !== 'approval') return
      await respondToInteraction(interaction, {
        kind: 'approval',
        decision,
      })
    },
    respondSubagentPermission: async (approval, behavior, grantScope) => {
      const interaction = await findPendingInteraction(
        (candidate) =>
          candidate.kind === 'permission' &&
          (candidate.interactionId === approval.id || candidate.toolCallId === approval.toolCallID),
        approval.threadId,
      )
      if (interaction.kind !== 'permission') return
      await respondToPermissionInteraction(interaction, {
        behavior,
        ...(behavior === 'allow' ? { grantScope } : {}),
      })
    },
    getSessionGoal: (sessionId) =>
      withAgentOrMock(
        async () => {
          if (!hasGoalCapability()) unsupportedAgentOperation('getSessionGoal (thread.goal.v1)')
          return (await rpc.call('thread/goal/get', { threadId: sessionId })).goal
        },
        () => mockClient.getSessionGoal(sessionId),
      ),
    setSessionGoal: (sessionId, input) => {
      let originalGoal: { id: string; objective: string } | null | undefined
      return withAgentOrMock(
        async () =>
          runGoalMutation(
            sessionId,
            async () => {
              if (!hasGoalCapability())
                unsupportedAgentOperation('setSessionGoal (thread.goal.v1)')
              const current = (await rpc.call('thread/goal/get', { threadId: sessionId })).goal
              if (
                originalGoal !== undefined &&
                (originalGoal?.id !== current?.id || originalGoal?.objective !== current?.objective)
              )
                throw Object.assign(new Error('目标已被替换，已刷新，请确认新目标后重试。'), {
                  code: 'GOAL_VERSION_CONFLICT',
                })
              originalGoal = current
              if (
                current &&
                input.tokenBudget !== undefined &&
                input.tokenBudget !== current.tokenBudget &&
                !input.budgetBaseline
              )
                throw new Error('修改已有目标预算需要当前目标与预算基准，请刷新后重试。')
              // A budget edit is computed from the budget the panel showed. Re-read
              // that baseline before writing, so a concurrent replacement or budget
              // change is reported instead of applying a total derived from stale data.
              if (input.budgetBaseline) {
                const baseline = input.budgetBaseline
                if (
                  current?.id !== baseline.goalId ||
                  (current?.tokenBudget ?? null) !== baseline.tokenBudget
                ) {
                  await loadAgentSessionSnapshot(sessionId).catch(() => null)
                  emitSessionStoreChange()
                  throw Object.assign(new Error('目标或预算已被更新，已刷新，请确认后重试。'), {
                    code: 'GOAL_VERSION_CONFLICT',
                  })
                }
              }
              const snapshot = input.objective?.trim()
                ? (await rpc.call('thread/read', { threadId: sessionId })).snapshot
                : null
              const running = snapshot?.turns.some((turn) =>
                [
                  'queued',
                  'running',
                  'waiting-permission',
                  'waiting-question',
                  'waiting-subagents',
                ].includes(turn.status),
              )
              if (!current && input.objective?.trim() && input.status !== 'paused' && !running) {
                await turnQueueClient.submitMessage(
                  sessionId,
                  { text: input.objective.trim() },
                  'start',
                  {
                    goal: {
                      objective: input.objective.trim(),
                      expectedVersion: current?.version ?? null,
                      ...(input.tokenBudget === undefined
                        ? {}
                        : { tokenBudget: input.tokenBudget }),
                    },
                  },
                )
                return (await rpc.call('thread/goal/get', { threadId: sessionId })).goal!
              }
              const result = await rpc.call('thread/goal/set', {
                threadId: sessionId,
                expectedVersion: current?.version ?? null,
                operationId: crypto.randomUUID(),
                ...(input.objective === undefined ? {} : { objective: input.objective }),
                ...(input.status === undefined ? {} : { status: input.status }),
                ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
              })
              await loadAgentSessionSnapshot(sessionId)
              emitSessionStoreChange()
              return result.goal
            },
            input.objective === undefined && input.tokenBudget === undefined,
          ),
        () => mockClient.setSessionGoal(sessionId, input),
      )
    },
    clearSessionGoal: (sessionId) => {
      let originalGoal: { id: string; objective: string } | null | undefined
      return withAgentOrMock(
        async () =>
          runGoalMutation(
            sessionId,
            async () => {
              if (!hasGoalCapability())
                unsupportedAgentOperation('clearSessionGoal (thread.goal.v1)')
              const current = (await rpc.call('thread/goal/get', { threadId: sessionId })).goal
              if (!current) {
                await loadAgentSessionSnapshot(sessionId)
                emitSessionStoreChange()
                return true
              }
              if (
                originalGoal &&
                (originalGoal.id !== current.id || originalGoal.objective !== current.objective)
              )
                throw Object.assign(new Error('目标已被替换，已刷新，请确认新目标后重试。'), {
                  code: 'GOAL_VERSION_CONFLICT',
                })
              originalGoal = current
              await rpc.call('thread/goal/clear', {
                threadId: sessionId,
                expectedVersion: current.version,
                operationId: crypto.randomUUID(),
              })
              await loadAgentSessionSnapshot(sessionId)
              emitSessionStoreChange()
              return true
            },
            true,
          ),
        () => mockClient.clearSessionGoal(sessionId),
      )
    },
  }
}
