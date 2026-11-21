import type {
  HookListResult,
  HookRunsListResult,
  HookSetEnabledResult,
  RpcParams,
} from '@pidex/agent-protocol'

/**
 * Host-owned Hook discovery and enable/disable management. All paths and
 * identities are resolved by the host from configured directories and enabled plugins.
 */
export interface HooksManagementService {
  listSources(cwd?: string): Promise<HookListResult>
  setEnabled(input: RpcParams<'hook/setEnabled'>): Promise<HookSetEnabledResult>
  listRuns(input: RpcParams<'hook/runs/list'>): Promise<HookRunsListResult>
}
