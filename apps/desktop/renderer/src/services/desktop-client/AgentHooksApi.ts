import type { ProtocolCapability } from '@pidex/agent-protocol'
import type { createAgentRpcClient } from '../AgentRpcClient.js'
import type { DesktopHooksApi } from './Types.js'

type Dependencies = {
  hasAgentCapability: (name: Extract<ProtocolCapability, 'hooks.management.v1'>) => boolean
  requireAgentCapability: (name: Extract<ProtocolCapability, 'hooks.management.v1'>) => void
  rpc: Pick<ReturnType<typeof createAgentRpcClient>, 'call'>
}

const nextOperationId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `hook-op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

/**
 * Hook management is agent-only: there is no browser mock or local fallback, so
 * a missing capability surfaces as an error and the settings page shows the
 * section as unavailable instead of inventing local state.
 */
export function createAgentHooksApi({
  hasAgentCapability,
  requireAgentCapability,
  rpc,
}: Dependencies): DesktopHooksApi {
  return {
    supportsHookManagement: () => hasAgentCapability('hooks.management.v1'),
    listHookGroups: (cwd) => rpc.call('hook/list', { ...(cwd ? { cwd } : {}) }),
    setHookEnabled: (input) =>
      rpc.call('hook/setEnabled', {
        ...input,
        operationId: nextOperationId(),
      }),
    requireHookManagement: () => requireAgentCapability('hooks.management.v1'),
  }
}
