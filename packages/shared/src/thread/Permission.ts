import { Schema } from 'effect'

export const SandboxModeSchema = Schema.Literals([
  'read-only',
  'workspace-write',
  'danger-full-access',
])
export type SandboxMode = typeof SandboxModeSchema.Type

export const ApprovalPolicySchema = Schema.Literals(['auto_review', 'never'])
export type ApprovalPolicy = typeof ApprovalPolicySchema.Type

/**
 * Stable TEXT representation used by SQLite and other string-only transports.
 */
// INVARIANT: SQLite schema 21 stores 'on-request' for non-never policy so older schema-21 readers remain compatible.
export const encodeApprovalPolicy = (policy: ApprovalPolicy) =>
  policy === 'never' ? 'never' : 'on-request'

const LEGACY_GRANULAR_KEYS = [
  'sandboxApproval',
  'rules',
  'skillApproval',
  'requestPermissions',
  'mcpTools',
  'mcpElicitations',
] as const

export const decodeApprovalPolicy = (value: unknown): ApprovalPolicy => {
  if (value === 'never') return 'never'
  if (
    value === 'auto_review' ||
    value === 'auto-review' ||
    value === 'on-request' ||
    value === 'untrusted' ||
    value === 'on-failure'
  )
    return 'auto_review'
  const candidate = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error('approvalPolicy 无效')
  const config = candidate as Record<string, unknown>
  if (config.type !== 'granular') throw new Error('granular approvalPolicy 无效')
  if (LEGACY_GRANULAR_KEYS.some((key) => typeof config[key] !== 'boolean'))
    throw new Error('granular approvalPolicy 缺少布尔配置')
  return 'auto_review'
}

export const ApprovalsReviewerSchema = Schema.Literals(['auto_review'])
export type ApprovalsReviewer = typeof ApprovalsReviewerSchema.Type

/** Maps persisted reviewer values, including legacy `'user'`, to `'auto_review'`. */
export const decodeApprovalsReviewer = (value: unknown): ApprovalsReviewer => {
  if (value === 'auto_review' || value === 'auto' || value === 'user') return 'auto_review'
  throw new Error('approvalsReviewer 无效')
}

export const PermissionConfigSchema = Schema.Struct({
  sandboxMode: SandboxModeSchema,
  approvalPolicy: ApprovalPolicySchema,
  approvalsReviewer: ApprovalsReviewerSchema,
})
export type PermissionConfig = typeof PermissionConfigSchema.Type

/** Normalizes persisted PermissionConfig objects, including legacy policy and reviewer values. */
export const decodePermissionConfig = (value: unknown): PermissionConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('permissionConfig 无效')
  const raw = value as Record<string, unknown>
  const sandboxMode =
    raw.sandboxMode === 'read-only' ||
    raw.sandboxMode === 'workspace-write' ||
    raw.sandboxMode === 'danger-full-access'
      ? raw.sandboxMode
      : 'workspace-write'
  return {
    sandboxMode,
    approvalPolicy: decodeApprovalPolicy(raw.approvalPolicy),
    approvalsReviewer:
      raw.approvalsReviewer === undefined
        ? 'auto_review'
        : decodeApprovalsReviewer(raw.approvalsReviewer),
  }
}

export const AUTO_REVIEW_PERMISSION_CONFIG = {
  sandboxMode: 'workspace-write',
  approvalPolicy: 'auto_review',
  approvalsReviewer: 'auto_review',
} as const satisfies PermissionConfig

export const DEFAULT_PERMISSION_CONFIG = AUTO_REVIEW_PERMISSION_CONFIG

export const FULL_ACCESS_PERMISSION_CONFIG = {
  sandboxMode: 'danger-full-access',
  approvalPolicy: 'never',
  approvalsReviewer: 'auto_review',
} as const satisfies PermissionConfig

/**
 * Shared permission preset catalog. Every client must derive its labels,
 * selection state and generated config from this single source instead of
 * re-identifying permission combinations locally.
 */
export type PermissionPresetId = 'auto-review' | 'full-access'
export type PermissionPresetSelection = PermissionPresetId

export type PermissionPreset = {
  id: PermissionPresetId
  label: string
  description: string
  config: PermissionConfig
}

export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  {
    id: 'auto-review',
    label: '帮我批准',
    description: '仅对检测到的风险操作请求批准',
    config: AUTO_REVIEW_PERMISSION_CONFIG,
  },
  {
    id: 'full-access',
    label: '完全访问',
    description: '直接执行所有操作，无需请求批准',
    config: FULL_ACCESS_PERMISSION_CONFIG,
  },
]

export const PERMISSION_PRESET_OPTIONS: ReadonlyArray<{
  id: PermissionPresetSelection
  label: string
  description: string
}> = PERMISSION_PRESETS.map(({ id, label, description }) => ({ id, label, description }))

/** Full access requires both danger-full-access file scope and never approval policy. */
export const isFullAccessPermissionConfig = (config: PermissionConfig): boolean =>
  config.sandboxMode === 'danger-full-access' && config.approvalPolicy === 'never'

/** Matches stored config to one of the two active presets. */
export const matchPermissionPreset = (config: PermissionConfig): PermissionPresetSelection =>
  isFullAccessPermissionConfig(config) ? 'full-access' : 'auto-review'

/** Generates the stored config for a preset. */
export const permissionConfigForPreset = (
  preset: PermissionPresetSelection,
  _current?: PermissionConfig,
): PermissionConfig =>
  preset === 'full-access'
    ? { ...FULL_ACCESS_PERMISSION_CONFIG }
    : { ...AUTO_REVIEW_PERMISSION_CONFIG }

/**
 * Permission rules are additive user intent layered on top of the preset.
 * `effect` is the requested outcome, `scope` is the persistence boundary and
 * `match` describes the exact host-observed subject. Deny always outranks ask,
 * and ask always outranks allow.
 */
export const PermissionRuleEffectSchema = Schema.Literals(['allow', 'ask', 'deny'])
export type PermissionRuleEffect = typeof PermissionRuleEffectSchema.Type

export const PermissionRuleScopeSchema = Schema.Literals(['user', 'project', 'chat'])
export type PermissionRuleScope = typeof PermissionRuleScopeSchema.Type

/** Where the rule is stored; legacy rules come from old approval grants. */
export const PermissionRuleSourceSchema = Schema.Literals(['user', 'project', 'chat', 'legacy'])
export type PermissionRuleSource = typeof PermissionRuleSourceSchema.Type

export const PermissionRuleMatchSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('tool'),
    /** Canonical registered tool name. */
    tool: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('file'),
    access: Schema.Literals(['read', 'write']),
    /** Absolute, host-resolved path or directory. */
    path: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('command'),
    /** Exact raw command value, always matched literally. */
    command: Schema.String,
    cwd: Schema.optional(Schema.String),
    /** Safe argv prefix parsed by the host; absent means exact-command only. */
    argv: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal('network'),
    /** Exact lower-case hostname only; no wildcard or subdomain matching. */
    domain: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('mcp'),
    server: Schema.String,
    tool: Schema.optional(Schema.String),
  }),
])
export type PermissionRuleMatch = typeof PermissionRuleMatchSchema.Type

export const PermissionRuleSchema = Schema.Struct({
  id: Schema.String,
  effect: PermissionRuleEffectSchema,
  scope: PermissionRuleScopeSchema,
  source: PermissionRuleSourceSchema,
  match: PermissionRuleMatchSchema,
  editable: Schema.Boolean,
  /** Config layer version or chat-rule revision used for optimistic writes. */
  version: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
  workspace: Schema.optional(Schema.String),
})
export type PermissionRule = typeof PermissionRuleSchema.Type

export const PermissionRuleInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  effect: PermissionRuleEffectSchema,
  scope: PermissionRuleScopeSchema,
  match: PermissionRuleMatchSchema,
})
export type PermissionRuleInput = typeof PermissionRuleInputSchema.Type

export const permissionRuleEffectRank: Readonly<Record<PermissionRuleEffect, number>> = {
  deny: 3,
  ask: 2,
  allow: 1,
}

/** Deny > ask > allow, independent of storage source. */
export const strongestPermissionRuleEffect = (
  effects: readonly PermissionRuleEffect[],
): PermissionRuleEffect | null =>
  effects.reduce<PermissionRuleEffect | null>(
    (strongest, effect) =>
      strongest === null || permissionRuleEffectRank[effect] > permissionRuleEffectRank[strongest]
        ? effect
        : strongest,
    null,
  )

/** Stable identity for a match object, used to deduplicate and compare rules. */
export const permissionRuleMatchKey = (match: PermissionRuleMatch): string => {
  switch (match.kind) {
    case 'tool':
      return `tool:${match.tool}`
    case 'file':
      return `file:${match.access}:${match.path}`
    case 'command':
      return match.argv && match.argv.length > 0
        ? `command:${match.argv.join('\u0000')}`
        : `command-exact:${match.cwd ?? ''}:${match.command}`
    case 'network':
      return `network:${match.domain}`
    case 'mcp':
      return `mcp:${match.server}/${match.tool ?? '*'}`
  }
}

export const AdditionalPermissionsSchema = Schema.Struct({
  readPaths: Schema.optional(Schema.Array(Schema.String)),
  writePaths: Schema.optional(Schema.Array(Schema.String)),
  networkDomains: Schema.optional(Schema.Array(Schema.String)),
})
export type AdditionalPermissions = typeof AdditionalPermissionsSchema.Type

export const PermissionGrantScopeSchema = Schema.Literals(['tool-call', 'turn', 'session'])
export type PermissionGrantScope = typeof PermissionGrantScopeSchema.Type

export const ShellInputSchema = Schema.Struct({
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  shell: Schema.optional(Schema.String),
  tty: Schema.optional(Schema.Boolean),
  yieldTimeMs: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
  additionalPermissions: Schema.optional(AdditionalPermissionsSchema),
  justification: Schema.optional(Schema.String),
})
export type ShellInput = typeof ShellInputSchema.Type

export const RiskCategorySchema = Schema.Literals([
  'destructive',
  'irreversible_change',
  'system_modification',
  'security_control',
  'credential_access',
  'credential_exfiltration',
  'privilege_escalation',
  'persistence',
  'resource_exhaustion',
  'network_access',
  'scope_escape',
  'prompt_injection',
  'obfuscation',
  'unknown_infrastructure',
])
export type RiskCategory = typeof RiskCategorySchema.Type

export const ShellReviewSchema = Schema.Struct({
  decision: Schema.Literals(['allow', 'ask', 'deny']),
  risk: Schema.Literals(['low', 'medium', 'high', 'critical']),
  confidence: Schema.Literals(['low', 'medium', 'high']),
  categories: Schema.Array(RiskCategorySchema),
  requestedScopeValid: Schema.Boolean,
  reason: Schema.String,
})
export type ShellReview = typeof ShellReviewSchema.Type
