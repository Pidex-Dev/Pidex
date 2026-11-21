import type { RpcMethod } from '@pidex/agent-protocol'
import type { RpcRouter } from '../RpcRouter'
import { optionalRpcRecord as optionalRecord } from '../Decoders'
import { AgentError } from '../RpcRouter'
import type { RpcHandlerGroup } from './Types'

export const interactionHandlers = {
  name: 'interaction',
  methods: [
    'interaction/listPending',
    'interaction/questionPause',
    'approval/rules/list',
    'approval/rules/revoke',
    'approval/rules/upsert',
  ],
  async handle(runtime: RpcRouter, method: RpcMethod, rawParams: unknown): Promise<unknown> {
    const params = optionalRecord(rawParams)
    switch (method) {
      case 'interaction/listPending':
        return runtime.listPendingInteractions(params)
      case 'interaction/questionPause':
        return runtime.dependencies.questions.pause(
          String(params.interactionId),
          Number(params.expectedVersion),
        )
      case 'approval/rules/list':
        return runtime.dependencies.approvals.rules.list(
          typeof params.threadId === 'string' ? params.threadId : undefined,
          typeof params.cwd === 'string' ? params.cwd : undefined,
        )
      case 'approval/rules/revoke':
        return runtime.dependencies.approvals.rules.revoke(
          typeof params.threadId === 'string' ? params.threadId : undefined,
          String(params.ruleId),
          typeof params.expectedVersion === 'string' ? params.expectedVersion : undefined,
          typeof params.cwd === 'string' ? params.cwd : undefined,
        )
      case 'approval/rules/upsert':
        return runtime.dependencies.approvals.rules
          .upsert(
            typeof params.threadId === 'string' ? params.threadId : undefined,
            params.rule as import('@pidex/shared/thread').PermissionRuleInput,
            typeof params.expectedVersion === 'string' ? params.expectedVersion : undefined,
            typeof params.cwd === 'string' ? params.cwd : undefined,
          )
          .then((rule) => ({ rule }))
      default:
        throw new AgentError('METHOD_NOT_FOUND', `未知 RPC 方法：${method}`, 404)
    }
  },
} as const satisfies RpcHandlerGroup
