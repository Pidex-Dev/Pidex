import type { ProtocolCapability, RpcParams, RpcResult } from '@pidex/agent-protocol'
import type { createAgentRpcClient } from '../AgentRpcClient.js'
import type { DesktopDecisionApi } from './Types.js'

type DecisionCapability = Extract<ProtocolCapability, 'decision.engine.v1'>

type Dependencies = {
  hasAgentCapability: (name: DecisionCapability) => boolean
  requireAgentCapability: (name: DecisionCapability) => void
  rpc: Pick<ReturnType<typeof createAgentRpcClient>, 'call'>
}

const nextOperationId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `decision-op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

/**
 * Decision engine API is agent-only: without `decision.engine.v1` every call
 * surfaces an unsupported-operation error instead of inventing local state,
 * and callers gate their UI on `supportsDecisionEngine()`.
 */
export function createAgentDecisionApi({
  hasAgentCapability,
  requireAgentCapability,
  rpc,
}: Dependencies): DesktopDecisionApi {
  return {
    supportsDecisionEngine: () => hasAgentCapability('decision.engine.v1'),
    getDecisionConfig: (cwd?: string | null): Promise<RpcResult<'decision/getConfig'>> => {
      requireAgentCapability('decision.engine.v1')
      return rpc.call('decision/getConfig', { ...(cwd ? { cwd } : {}) })
    },
    updateDecisionConfig: (
      input: Omit<RpcParams<'decision/updateConfig'>, 'operationId'>,
    ): Promise<RpcResult<'decision/updateConfig'>> => {
      requireAgentCapability('decision.engine.v1')
      return rpc.call('decision/updateConfig', { ...input, operationId: nextOperationId() })
    },
    setDecisionJudgeApiKey: (
      input: Omit<RpcParams<'decision/setJudgeApiKey'>, 'operationId'>,
    ): Promise<RpcResult<'decision/setJudgeApiKey'>> => {
      requireAgentCapability('decision.engine.v1')
      return rpc.call('decision/setJudgeApiKey', { ...input, operationId: nextOperationId() })
    },
    probeDecisionJudge: (
      input: RpcParams<'decision/probe'>,
    ): Promise<RpcResult<'decision/probe'>> => {
      requireAgentCapability('decision.engine.v1')
      return rpc.call('decision/probe', input)
    },
    listDecisionLedger: (
      input: RpcParams<'decision/listLedger'>,
    ): Promise<RpcResult<'decision/listLedger'>> => {
      requireAgentCapability('decision.engine.v1')
      return rpc.call('decision/listLedger', input)
    },
    markDecisionOutcome: (
      input: Omit<RpcParams<'decision/markOutcome'>, 'operationId'>,
    ): Promise<RpcResult<'decision/markOutcome'>> => {
      requireAgentCapability('decision.engine.v1')
      return rpc.call('decision/markOutcome', { ...input, operationId: nextOperationId() })
    },
  }
}