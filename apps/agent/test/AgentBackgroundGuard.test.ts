import { afterEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { DEFAULT_PERMISSION_CONFIG } from '@pidex/shared/thread'
import { AgentRuntimeService } from '../src/orchestration/AgentRuntimeService'
import type { AgentRuntimeRequest } from '../src/orchestration/AgentRuntimeTypes'
import { ContextCompactionService } from '../src/context/ContextCompactionService'
import { createPromptSections } from '../src/prompt/Sections'
import { SubagentService } from '../src/subagent/SubagentService'
import { AgentDatabase } from '../src/storage/database/AgentDatabase'
import { EventHub } from '../src/storage/events/EventHub'
import { SqlitePiSessionRepo } from '../src/storage/pi-session/SqlitePiSession'
import { ToolExecutor } from '../src/tool/ToolExecutor'
import { ToolRegistry } from '../src/tool/ToolRegistry'
import { WorkspaceService } from '../src/workspace/WorkspaceService'
import type { AgentModelCatalog } from '../src/provider/AgentModelCatalog'

const tempDirs: string[] = []
const databases: AgentDatabase[] = []

const tempRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidex-agent-bg-guard-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (databases.length) databases.pop()!.close()
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

const permission = {
  ...DEFAULT_PERMISSION_CONFIG,
  sandboxMode: 'workspace-write' as const,
  approvalPolicy: 'never' as const,
}

type SpawnRequest = {
  agents: Array<{ profile: string; task: string; background?: boolean; fork?: unknown }>
}

describe('Agent 后台派发守卫与同步兜底状态', () => {
  const createRuntimeFixture = async (
    responses: Array<Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0][number]>,
  ) => {
    const root = tempRoot()
    const db = new AgentDatabase({
      historyPath: join(root, 'history.sqlite'),
      profilePath: join(root, 'profile.sqlite'),
    })
    databases.push(db)
    const hub = await Effect.runPromise(EventHub.make)
    const faux = fauxProvider({
      models: [{ id: 'bg-guard-test', input: ['text'], contextWindow: 64_000 }],
    })
    faux.setResponses(responses)
    const models = createModels()
    models.setProvider(faux.provider)
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: 'test' }),
    })
    const runtime = new AgentRuntimeService({
      db,
      hub,
      models,
      toolExecutor: executor,
      contextCompaction: new ContextCompactionService(db),
    })
    const modelRef = { providerID: faux.getModel().provider, id: 'bg-guard-test' } as never
    return { root, db, hub, faux, models, executor, runtime, modelRef }
  }

  const syncDelegation = (
    spawned: SpawnRequest[],
    summary: string,
  ): NonNullable<AgentRuntimeRequest['delegation']> => ({
    spawn: async (input) => {
      spawned.push(input)
      return {
        agents: input.agents.map((agent) => ({
          taskId: 'task-1',
          runId: 'run-1',
          childThreadId: 'child-1',
          displayName: 'Child 1',
          profile: agent.profile,
        })),
      }
    },
    isWaitSatisfied: async () => true,
    wait: async () => ({
      mode: 'all',
      runs: [
        {
          id: 'run-1',
          taskId: 'task-1',
          status: 'completed',
          result: {
            outcome: 'succeeded',
            summary,
            findings: [],
            changedFiles: [],
            validation: [],
            risks: [],
            references: [],
          },
          error: null,
        },
      ],
    }),
    send: async () => ({}),
    stop: async () => ({}),
  })

  const runTurn = async (
    fixture: Awaited<ReturnType<typeof createRuntimeFixture>>,
    input: {
      profile?: 'main' | 'default' | 'explorer' | 'worker'
      depth?: number
      delegation: NonNullable<AgentRuntimeRequest['delegation']>
      pause?: AgentRuntimeRequest['pause']
    },
  ) => {
    const { root, db, faux, runtime, modelRef } = fixture
    const workspace = await WorkspaceService.open(root)
    const thread = db.createThread()
    const content = 'Delegation guard task'
    const turn = db.createTurn(thread.id, {
      content,
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(turn.turnID)
    const sessionID = crypto.randomUUID()
    const profile = input.profile ?? 'main'
    const result = await runtime.run({
      threadID: thread.id,
      turnID: turn.turnID,
      agentID: turn.agentID,
      sessionID,
      content,
      taskMode: 'chat',
      profile,
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
      fallbackModel: modelRef,
      permissionConfig: permission,
      signal: new AbortController().signal,
      workspace,
      delegation: input.delegation,
      promptSections: createPromptSections({
        permissionInstructions: 'allow',
        mode: 'chat',
        profile,
        userMessage: content,
      }),
      resolveModel: async () => ({ ref: modelRef, model: faux.getModel() }),
      pause: input.pause ?? (async () => {}),
    })
    const entries = await new SqlitePiSessionRepo(db)
      .openForThread(sessionID, thread.id)
      .then((session) => session.getEntries())
    let toolResultText = ''
    for (const entry of entries) {
      if (entry.type === 'message' && entry.message.role === 'toolResult') {
        toolResultText += entry.message.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('')
      }
    }
    return { result, thread, turn, sessionID, toolResultText }
  }

  test('非 main 父代理 run_in_background:true 在 spawn 之前被拒绝并提示同步委派', async () => {
    const fixture = await createRuntimeFixture([
      fauxAssistantMessage([
        fauxToolCall('Agent', {
          description: 'Background nested explore',
          prompt: 'Explore nested target',
          subagent_type: 'explorer',
          run_in_background: true,
        }),
      ]),
      fauxAssistantMessage('Switched to synchronous delegation.'),
    ])
    const spawnCalls: unknown[] = []
    const { result, toolResultText } = await runTurn(fixture, {
      profile: 'default',
      depth: 1,
      delegation: {
        spawn: async (input) => {
          spawnCalls.push(input)
          throw new Error('后台派发不应到达 spawn')
        },
        isWaitSatisfied: async () => true,
        wait: async () => ({ mode: 'all', runs: [] }),
        send: async () => ({}),
        stop: async () => ({}),
      },
    })
    expect(result.status).toBe('completed')
    expect(spawnCalls).toHaveLength(0)
    expect(toolResultText).toContain('子代理不支持后台派发')
    expect(toolResultText).toContain('同步委派')
  })

  test('非 main 父代理省略 subagent_type 走同步 default 子任务，不 fork 也不后台', async () => {
    const fixture = await createRuntimeFixture([
      fauxAssistantMessage([
        fauxToolCall('Agent', {
          description: 'Nested bounded work',
          prompt: 'Do bounded nested work',
        }),
      ]),
      fauxAssistantMessage('Nested delegation finished synchronously.'),
    ])
    const spawned: SpawnRequest[] = []
    const { result, toolResultText } = await runTurn(fixture, {
      profile: 'default',
      depth: 1,
      delegation: syncDelegation(spawned, 'Nested child summary'),
      pause: async () => {
        throw new Error('同步委派不应触发暂停')
      },
    })
    expect(result).toMatchObject({
      status: 'completed',
      output: 'Nested delegation finished synchronously.',
    })
    expect(result.status === 'completed' ? result.stats?.toolUseCount : undefined).toBe(1)
    expect(spawned).toHaveLength(1)
    const agent = spawned[0]!.agents[0]!
    expect(agent.profile).toBe('default')
    expect(agent.fork).toBeUndefined()
    expect(agent.background).toBeUndefined()
    expect(toolResultText).toContain('[Subagent hand-back (taskId=task-1, status=completed')
    expect(toolResultText).toContain('Nested child summary')
  })

  test('main 父代理省略 subagent_type 仍触发后台 Fork，且 fork boilerplate 声明宿主拒绝与文本收尾', async () => {
    const fixture = await createRuntimeFixture([
      fauxAssistantMessage([
        fauxToolCall('Agent', {
          description: 'Fork background audit',
          prompt: 'Audit recent changes in background',
        }),
      ]),
      fauxAssistantMessage('Started background audit.'),
    ])
    const { root, db, hub, faux, runtime, modelRef } = fixture
    const workspace = await WorkspaceService.open(root)
    const subagents = new SubagentService(
      db,
      hub,
      {
        resolve: async () => ({ ref: modelRef, model: faux.getModel() }),
        getModel: async () => faux.getModel(),
      } as unknown as AgentModelCatalog,
      { setAgentStatusHandler: () => {}, cancelTurn: () => {} } as never,
      { cancelTurn: () => {} } as never,
      {
        run: async () => ({ status: 'completed', output: 'fork child done' }),
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        clearTurnPermissionGrants: () => {},
      } as never,
      { listByBinding: async () => [] } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        acquire: async () => ({
          catalog: new ToolRegistry(),
          serverInstructions: [],
          release: async () => {},
        }),
      } as never,
      undefined,
      undefined,
      false,
    )
    const thread = db.createThread()
    const turn = db.createTurn(thread.id, {
      content: 'Audit this repo',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(turn.turnID)
    const spawnedSnapshots: SpawnRequest[] = []
    const result = await runtime.run({
      threadID: thread.id,
      turnID: turn.turnID,
      agentID: turn.agentID,
      sessionID: crypto.randomUUID(),
      content: 'Audit this repo',
      taskMode: 'chat',
      fallbackModel: modelRef,
      permissionConfig: permission,
      signal: new AbortController().signal,
      workspace,
      delegation: {
        ...subagents.delegationFor({
          threadID: thread.id,
          turnID: turn.turnID,
          agentID: turn.agentID,
          taskMode: 'chat',
          model: modelRef,
          permissionConfig: permission,
          workspaceRoot: root,
        }),
        spawn: async (input, policy) => {
          spawnedSnapshots.push(input)
          return subagents
            .delegationFor({
              threadID: thread.id,
              turnID: turn.turnID,
              agentID: turn.agentID,
              taskMode: 'chat',
              model: modelRef,
              permissionConfig: permission,
              workspaceRoot: root,
            })
            .spawn(input, policy)
        },
      },
      promptSections: createPromptSections({
        permissionInstructions: 'allow',
        mode: 'chat',
        profile: 'main',
        userMessage: 'Audit this repo',
      }),
      resolveModel: async () => ({ ref: modelRef, model: faux.getModel() }),
      pause: async () => {
        throw new Error('Fork should run asynchronously without pausing')
      },
    })
    expect(result.status).toBe('completed')
    expect(spawnedSnapshots).toHaveLength(1)
    const forkAgent = spawnedSnapshots[0]!.agents[0]!
    expect(forkAgent.profile).toBe('default')
    expect(forkAgent.background).toBe(true)
    expect(forkAgent.fork).toBeDefined()
    const tasks = subagents.list(thread.id)
    expect(tasks).toHaveLength(1)
    const forkTask = tasks[0]!.task
    const forkContext = subagents.collaboration.forkContext(forkTask.id)
    expect(forkContext).not.toBeNull()
    expect(forkContext!.exposurePlan.exposed).toContain('Agent')
    const childInput = db.sqlite
      .query('SELECT content FROM inputs WHERE thread_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(forkTask.childThreadId) as { content: string }
    expect(childInput.content).toContain('<fork_boilerplate>')
    expect(childInput.content).toContain('</fork_boilerplate>')
    expect(childInput.content).toContain('the host rejects every Agent call from a fork child')
    expect(childInput.content).toContain('Finish with your final report as ordinary text')
    const deadline = Date.now() + 2000
    while (
      subagents.repository.task(forkTask.id)?.currentRun?.status !== 'completed' &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(subagents.repository.task(forkTask.id)?.currentRun?.status).toBe('completed')
  })

  test('同步即时路径 wait 返回 null 时手交状态为 unknown 而非谎报 completed', async () => {
    const fixture = await createRuntimeFixture([
      fauxAssistantMessage([
        fauxToolCall('Agent', {
          description: 'Sync explore missing wait',
          prompt: 'Explore target',
          subagent_type: 'explorer',
        }),
      ]),
      fauxAssistantMessage('Handled missing wait result.'),
    ])
    const spawned: SpawnRequest[] = []
    const { result, toolResultText } = await runTurn(fixture, {
      delegation: {
        ...syncDelegation(spawned, 'unused summary'),
        wait: async () => null,
      },
    })
    expect(result.status).toBe('completed')
    expect(spawned).toHaveLength(1)
    expect(toolResultText).toContain('[Subagent hand-back (taskId=task-1, status=unknown')
    expect(toolResultText).not.toContain('status=completed')
  })
})
