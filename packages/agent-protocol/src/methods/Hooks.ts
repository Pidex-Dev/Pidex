import { Schema } from 'effect'
import { defineMethod, type MethodMap } from '../wire/Definition'
import {
  CursorSchema,
  NonEmptyStringSchema,
  SequenceSchema,
  TimestampSchema,
} from '../wire/Primitives'

const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const HookEventSchema = Schema.Literals([
  'session_start',
  'session_resume',
  'user_prompt_submit',
  'pre_tool_use',
  'permission_request',
  'post_tool_use',
  'post_tool_error',
  'pre_compact',
  'stop',
  'subagent_start',
  'subagent_stop',
])

export const HookSourceKindSchema = Schema.Literals(['config', 'plugin'])
export const HookScopeSchema = Schema.Literals(['user', 'project'])

export const HookDiagnosticSchema = Schema.Struct({
  severity: Schema.Literals(['warning', 'error']),
  code: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
})

export const DiscoveredHookSchema = Schema.Struct({
  identity: Sha256Schema,
  id: NonEmptyStringSchema,
  event: HookEventSchema,
  command: NonEmptyStringSchema,
  matcher: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 }))),
  statusMessage: Schema.optional(Schema.String),
  /** Absolute path to the declaring file, disclosed for user inspection / opening. */
  filePath: NonEmptyStringSchema,
  enabled: Schema.Boolean,
})

export const HookSourceGroupSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  kind: HookSourceKindSchema,
  scope: HookScopeSchema,
  displayName: NonEmptyStringSchema,
  scopeLabel: NonEmptyStringSchema,
  pluginId: Schema.optional(NonEmptyStringSchema),
  untrusted: Schema.optional(Schema.Boolean),
  hooks: Schema.Array(DiscoveredHookSchema),
  diagnostics: Schema.Array(HookDiagnosticSchema),
})

export const HookListParamsSchema = Schema.Struct({
  cwd: Schema.optional(NonEmptyStringSchema),
})

export const HookListResultSchema = Schema.Struct({
  groups: Schema.Array(HookSourceGroupSchema),
  generation: SequenceSchema,
  updatedAt: TimestampSchema,
})

export const HookSetEnabledParamsSchema = Schema.Struct({
  identity: Sha256Schema,
  enabled: Schema.Boolean,
  operationId: NonEmptyStringSchema,
})

export const HookSetEnabledResultSchema = Schema.Struct({
  identity: Sha256Schema,
  enabled: Schema.Boolean,
  generation: SequenceSchema,
  updatedAt: TimestampSchema,
})

export const HookRunSummarySchema = Schema.Struct({
  id: NonEmptyStringSchema,
  hookId: NonEmptyStringSchema,
  event: HookEventSchema,
  status: Schema.Literals(['running', 'completed', 'failed']),
  startedAt: TimestampSchema,
  finishedAt: Schema.optional(TimestampSchema),
  durationMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Scrubbed, host-bounded failure reason. No raw evidence or output. */
  errorSummary: Schema.optional(NonEmptyStringSchema),
})

export const HookRunsListParamsSchema = Schema.Struct({
  cwd: Schema.optional(NonEmptyStringSchema),
  hookId: Schema.optional(NonEmptyStringSchema),
  cursor: Schema.optional(CursorSchema),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
})

export const HookRunsListResultSchema = Schema.Struct({
  runs: Schema.Array(HookRunSummarySchema),
  nextCursor: Schema.optional(CursorSchema),
  generation: SequenceSchema,
})

const HookErrors = [
  'HOOK_SOURCE_INVALID',
  'HOOK_INVALID',
  'CONFLICT',
  'PATH_DENIED',
  'CURSOR_EXPIRED',
  'INTERNAL_ERROR',
] as const

export const HookRpcMethods = {
  'hook/list': defineMethod({
    params: HookListParamsSchema,
    result: HookListResultSchema,
    errors: HookErrors,
    capability: 'hooks.management.v1',
    mutation: false,
    exactParams: true,
    exactResult: true,
  }),
  'hook/setEnabled': defineMethod({
    params: HookSetEnabledParamsSchema,
    result: HookSetEnabledResultSchema,
    errors: HookErrors,
    capability: 'hooks.management.v1',
    mutation: true,
    exactParams: true,
    exactResult: true,
  }),
  'hook/runs/list': defineMethod({
    params: HookRunsListParamsSchema,
    result: HookRunsListResultSchema,
    errors: HookErrors,
    capability: 'hooks.management.v1',
    mutation: false,
    exactParams: true,
    exactResult: true,
  }),
} as const satisfies MethodMap

export type HookEventName = typeof HookEventSchema.Type
export type HookSourceKind = typeof HookSourceKindSchema.Type
export type HookScope = typeof HookScopeSchema.Type
export type DiscoveredHook = typeof DiscoveredHookSchema.Type
export type HookDiagnostic = typeof HookDiagnosticSchema.Type
export type HookSourceGroup = typeof HookSourceGroupSchema.Type
export type HookRunSummary = typeof HookRunSummarySchema.Type
export type HookListResult = typeof HookListResultSchema.Type
export type HookSetEnabledResult = typeof HookSetEnabledResultSchema.Type
export type HookRunsListResult = typeof HookRunsListResultSchema.Type
