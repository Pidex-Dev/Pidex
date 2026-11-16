import { permissionConfigForPreset } from '@pidex/shared/thread'
export type ApprovalsReviewer = 'auto_review'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type AgentPermissionProfile = ':read-only' | ':workspace' | ':danger-full-access' | string

export type AgentApprovalMode = 'auto_review' | 'never'

export type AgentPermissionAction = 'read' | 'write' | 'shell' | 'network' | 'mcp'
export type AgentPermissionEffect = 'allow' | 'ask' | 'deny'
export type AgentPermissionActionScopes = Partial<
  Record<AgentPermissionAction, AgentPermissionEffect>
>

export type AgentPermissionPolicy = {
  profile: AgentPermissionProfile
  approvalMode: AgentApprovalMode
  approvalsReviewer?: ApprovalsReviewer
  sandboxMode?: SandboxMode
  sandboxPolicy?: AgentPermissionProfile
  actionScopes?: AgentPermissionActionScopes
  toolOverrides?: Record<string, AgentPermissionActionScopes>
}

export type AgentPermissionDecision = {
  behavior: 'allow' | 'deny'
  message?: string
  alwaysAllow?: boolean
  updatedInput?: Record<string, unknown>
}

export type AgentGuardianReview = {
  status: 'completed' | 'cached' | 'unavailable' | 'timeout' | 'circuit_open'
  source: 'model' | 'cache' | 'fallback'
  risk: 'low' | 'medium' | 'high' | 'critical'
  userAuthorization: 'unknown' | 'low' | 'medium' | 'high'
  confidence: 'low' | 'medium' | 'high'
  categories: readonly string[]
  rationale: string
  reviewedAt: number
  scoreLag?: number
  fallbackReason?: string
  model?: string
}

export type AgentPermissionRequest = {
  requestId: string
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  description: string
  profile?: AgentPermissionProfile
  approvalMode?: AgentApprovalMode
  approvalsReviewer?: ApprovalsReviewer
  requestKind?:
    | 'shell-command'
    | 'file-write'
    | 'network'
    | 'sandbox-escalation'
    | 'full-access'
    | 'tool'
    | 'permission-grant'
  autoReviewFallbackReason?: string
  guardian?: AgentGuardianReview
}

export type DesktopAgentPermissionMode = 'auto-review' | 'full-access'

export const DESKTOP_AGENT_PERMISSION_MODES = [
  'auto-review',
  'full-access',
] as const satisfies readonly DesktopAgentPermissionMode[]

export function normalizeDesktopAgentPermissionMode(mode: unknown): DesktopAgentPermissionMode {
  switch (mode) {
    case 'bypassPermissions':
    case 'full-access':
      return 'full-access'
    default:
      return 'auto-review'
  }
}

export function isDesktopAgentPermissionMode(value: unknown): value is DesktopAgentPermissionMode {
  return (
    typeof value === 'string' &&
    (DESKTOP_AGENT_PERMISSION_MODES as readonly string[]).includes(value)
  )
}

export function permissionPolicyForDesktopMode(
  mode: DesktopAgentPermissionMode | string | undefined,
): AgentPermissionPolicy {
  const normalized = normalizeDesktopAgentPermissionMode(mode)
  const config = permissionConfigForPreset(normalized)
  const profile = config.sandboxMode === 'danger-full-access' ? ':danger-full-access' : ':workspace'
  return {
    profile,
    sandboxPolicy: profile,
    sandboxMode: config.sandboxMode,
    approvalMode: config.approvalPolicy,
    approvalsReviewer: config.approvalsReviewer,
  }
}
