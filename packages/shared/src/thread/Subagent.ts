import { Model } from '@pidex/model-schema'
import { Schema } from 'effect'
import { PermissionConfigSchema } from './Permission'

export const MAX_SUBAGENT_DEPTH = 3

export const SubagentProfileSchema = Schema.Literals(['main', 'default', 'explorer', 'worker'])
export type SubagentProfile = typeof SubagentProfileSchema.Type

/**
 * 子智能体的展示职能，仅决定头像；不授予权限，也不改变 profile、模型、
 * 工具或工作区策略。显式指定优先，缺失时由 Renderer 按名称/任务推断。
 */
export const SubagentRoleSchema = Schema.Literals([
  'frontend',
  'backend',
  'devops',
  'qa',
  'designer',
  'data',
  'docs',
  'product',
  'general',
])
export type SubagentRole = typeof SubagentRoleSchema.Type

const ROLE_DISPLAY_NAMES: Readonly<Record<Exclude<SubagentRole, 'general'>, string>> = {
  frontend: 'Frontend',
  backend: 'Backend',
  devops: 'DevOps',
  qa: 'QA',
  designer: 'Designer',
  data: 'Data',
  docs: 'Docs',
  product: 'Product',
}

const PROFILE_DISPLAY_NAMES: Readonly<Record<Exclude<SubagentProfile, 'main'>, string>> = {
  default: 'General Purpose',
  explorer: 'Explorer',
  worker: 'Worker',
}

/**
 * Derive a clean default agent name from `role` and `profile` when no explicit name was provided.
 */
export function resolveDefaultSubagentName(input: {
  profile: Exclude<SubagentProfile, 'main'> | string
  role?: SubagentRole | null | undefined
  isFork?: boolean | undefined
}): string {
  if (input.role && input.role !== 'general') {
    return ROLE_DISPLAY_NAMES[input.role]
  }
  if (input.isFork) {
    return 'Context Fork'
  }
  if (input.profile === 'explorer' || input.profile === 'worker' || input.profile === 'default') {
    return PROFILE_DISPLAY_NAMES[input.profile]
  }
  return 'General Purpose'
}

const LEGACY_GENERATED_NAME_PATTERN = /^(?:Explorer|Worker|Agent) \d+$/

function summarizeFallbackTaskTitle(task: string | null | undefined): string {
  const firstLine = (task ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return ''
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine
}

/**
 * Resolve the agent's own name and short task title for UI and handback display,
 * preserving clean separation for both new records (`title` set) and legacy records.
 */
export function resolveSubagentDisplayParts(input: {
  displayName?: string | null | undefined
  title?: string | null | undefined
  profile: Exclude<SubagentProfile, 'main'> | string
  role?: SubagentRole | null | undefined
  task?: string | null | undefined
  isFork?: boolean | undefined
}): { agentName: string; taskTitle: string } {
  const defaultName = resolveDefaultSubagentName({
    profile: input.profile,
    role: input.role,
    isFork: input.isFork,
  })
  const explicitTitle = input.title?.trim() ?? ''
  const rawDisplayName = input.displayName?.trim() ?? ''
  if (explicitTitle) {
    return {
      agentName: rawDisplayName || defaultName,
      taskTitle: explicitTitle,
    }
  }
  // INVARIANT: Legacy rows stored the short task title in `displayName` with `title` unset.
  if (
    rawDisplayName &&
    rawDisplayName !== defaultName &&
    !LEGACY_GENERATED_NAME_PATTERN.test(rawDisplayName)
  ) {
    return {
      agentName: defaultName,
      taskTitle: rawDisplayName,
    }
  }
  return {
    agentName: rawDisplayName || defaultName,
    taskTitle: summarizeFallbackTaskTitle(input.task) || rawDisplayName || defaultName,
  }
}

export const SubagentWorkspaceSchema = Schema.Struct({
  mode: Schema.Literals(['shared', 'worktree']),
  state: Schema.Literals(['ready', 'preparing', 'conflict', 'applied', 'discarded']),
  rootPath: Schema.NullOr(Schema.String),
  baselineRef: Schema.NullOr(Schema.String),
})
export type SubagentWorkspace = typeof SubagentWorkspaceSchema.Type

export const SubagentStatusSchema = Schema.Literals([
  'queued',
  'preparing',
  'running',
  'steering',
  'waiting-question',
  'waiting-permission',
  'completed',
  'failed',
  'stopped',
  'interrupted',
])
export type SubagentStatus = typeof SubagentStatusSchema.Type

export const SubagentQueueReasonSchema = Schema.NullOr(
  Schema.Literals(['parent-limit', 'global-limit', 'workspace-writer']),
)
export type SubagentQueueReason = typeof SubagentQueueReasonSchema.Type

export const SubagentFindingSchema = Schema.Struct({
  title: Schema.String,
  detail: Schema.String,
  severity: Schema.Literals(['info', 'warning', 'error']),
})
export type SubagentFinding = typeof SubagentFindingSchema.Type

export const SubagentChangedFileSchema = Schema.Struct({
  path: Schema.String,
  summary: Schema.String,
})
export type SubagentChangedFile = typeof SubagentChangedFileSchema.Type

export const SubagentValidationSchema = Schema.Struct({
  command: Schema.String,
  status: Schema.Literals(['passed', 'failed', 'skipped']),
  output: Schema.optional(Schema.String),
})
export type SubagentValidation = typeof SubagentValidationSchema.Type

export const SubagentReferenceSchema = Schema.Struct({
  kind: Schema.Literals(['file', 'url', 'thread', 'subagent']),
  value: Schema.String,
  label: Schema.optional(Schema.String),
})
export type SubagentReference = typeof SubagentReferenceSchema.Type

export const SubagentStatsSchema = Schema.Struct({
  durationMs: Schema.optional(Schema.Number),
  toolUseCount: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
})
export type SubagentStats = typeof SubagentStatsSchema.Type

export const SubagentResultSchema = Schema.Struct({
  outcome: Schema.Literals(['succeeded', 'partial', 'blocked']),
  summary: Schema.String,
  reportText: Schema.optional(Schema.String),
  stats: Schema.optional(SubagentStatsSchema),
  findings: Schema.Array(SubagentFindingSchema),
  changedFiles: Schema.Array(SubagentChangedFileSchema),
  validation: Schema.Array(SubagentValidationSchema),
  risks: Schema.Array(Schema.String),
  references: Schema.Array(SubagentReferenceSchema),
})
export type SubagentResult = typeof SubagentResultSchema.Type
export const decodeSubagentResult = Schema.decodeUnknownSync(SubagentResultSchema)

export const SubagentRunSchema = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  generation: Schema.Number,
  status: SubagentStatusSchema,
  queueReason: SubagentQueueReasonSchema,
  model: Model.Ref,
  permissionConfig: PermissionConfigSchema,
  result: Schema.NullOr(SubagentResultSchema),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  updatedAt: Schema.Number,
})
export type SubagentRun = typeof SubagentRunSchema.Type

export const SubagentTaskSchema = Schema.Struct({
  id: Schema.String,
  parentThreadId: Schema.String,
  parentTurnId: Schema.String,
  parentAgentId: Schema.String,
  childThreadId: Schema.String,
  notices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        kind: Schema.Literals(['report', 'settled']),
        message: Schema.String,
        createdAt: Schema.Number,
      }),
    ),
  ),
  parentTaskId: Schema.optional(Schema.NullOr(Schema.String)),
  depth: Schema.optional(Schema.Number),
  waitingForDescendants: Schema.optional(Schema.Boolean),
  queuedFollowups: Schema.optional(Schema.Number),
  displayName: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  profile: Schema.Literals(['default', 'explorer', 'worker']),
  /** 显式指派的展示职能；缺失表示没有显式角色。 */
  role: Schema.optional(SubagentRoleSchema),
  /** 可选的命名记忆身份（1–64 位 ASCII，宿主统一小写）；缺失表示不使用命名记忆。 */
  memoryKey: Schema.optional(Schema.String),
  task: Schema.String,
  permissionCeiling: PermissionConfigSchema,
  workspace: SubagentWorkspaceSchema,
  currentRun: Schema.NullOr(SubagentRunSchema),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type SubagentTask = typeof SubagentTaskSchema.Type

export const SubagentProjectionSchema = Schema.Struct({
  task: SubagentTaskSchema,
  currentRun: Schema.NullOr(SubagentRunSchema),
})
export type SubagentProjection = typeof SubagentProjectionSchema.Type

export const AgentExecutionStatusSchema = Schema.Literals([
  'queued',
  'running',
  'waiting-question',
  'waiting-permission',
  'waiting-subagents',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
])
export type AgentExecutionStatus = typeof AgentExecutionStatusSchema.Type

export const AgentExecutionSchema = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  parentAgentId: Schema.NullOr(Schema.String),
  profile: Schema.String,
  task: Schema.String,
  model: Model.Ref,
  sessionId: Schema.String,
  depth: Schema.Number,
  status: AgentExecutionStatusSchema,
  error: Schema.NullOr(Schema.String),
  subagentRunId: Schema.NullOr(Schema.String),
  runSequence: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type AgentExecution = typeof AgentExecutionSchema.Type
