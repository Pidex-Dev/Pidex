import {
  DecisionConfigSchema,
  DecisionLedgerRecordSchema,
  DecisionOutcomeRecordSchema,
  DecisionPointManifestSchema,
  JudgeErrorKindSchema,
  JudgeTypeSchema,
} from '@pidex/shared/decision'
import { Schema } from 'effect'
import { defineMethod, type MethodMap } from '../wire/Definition'
import {
  CursorSchema,
  LimitSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  OpaqueIDSchema,
  OperationParamsSchema,
} from '../wire/Primitives'

const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

const DecisionReadErrors = ['THREAD_NOT_FOUND', 'INVALID_REQUEST', 'INTERNAL_ERROR'] as const

const DecisionWriteErrors = [
  'THREAD_NOT_FOUND',
  'OPERATION_ID_CONFLICT',
  'CONFLICT',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
] as const

const DecisionConfigErrors = [
  'CONFIG_LAYER_READONLY',
  'CONFIG_VERSION_CONFLICT',
  'CONFIG_VALIDATION_ERROR',
  'CONFIG_PATH_NOT_FOUND',
  'CONFIG_PROJECT_UNTRUSTED',
  'CONFIG_PROFILE_INVALID',
  'CONFIG_PROFILE_NOT_FOUND',
  'OPERATION_ID_CONFLICT',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
] as const

const DecisionCredentialErrors = [
  'OPERATION_ID_CONFLICT',
  'CREDENTIAL_STORE_UNAVAILABLE',
  'CREDENTIAL_NOT_FOUND',
  'CONFLICT',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
] as const

/** A configured judge with its identity resolved; never carries the key itself. */
export const DecisionEffectiveProviderSchema = Schema.Struct({
  name: NonEmptyStringSchema,
  type: JudgeTypeSchema,
  providerId: NonEmptyStringSchema,
  modelId: Schema.optional(NonEmptyStringSchema),
  apiKeyMasked: Schema.optional(NonEmptyStringSchema),
})
export type DecisionEffectiveProvider = typeof DecisionEffectiveProviderSchema.Type

export const DecisionGetConfigParamsSchema = Schema.Struct({
  cwd: Schema.optional(NonEmptyStringSchema),
})
export const DecisionGetConfigResultSchema = Schema.Struct({
  config: DecisionConfigSchema,
  manifest: Schema.Array(DecisionPointManifestSchema),
  effectiveProviders: Schema.Array(DecisionEffectiveProviderSchema),
})

/** Key-path partial edits under the `decision` config section; unknown keys are preserved. */
export const DecisionConfigPatchSchema = Schema.Struct({
  keyPath: Schema.Array(NonEmptyStringSchema).check(Schema.isMinLength(1)),
  value: Schema.Json,
  mergeStrategy: Schema.optional(Schema.Literals(['replace', 'upsert'])),
})

export const DecisionUpdateConfigParamsSchema = Schema.Struct({
  scope: Schema.Literals(['user', 'profile', 'project']),
  cwd: Schema.optional(NonEmptyStringSchema),
  patch: Schema.Array(DecisionConfigPatchSchema).check(Schema.isMinLength(1)),
  expectedVersion: Schema.optional(Sha256Schema),
  ...OperationParamsSchema.fields,
})
export const DecisionUpdateConfigResultSchema = Schema.Struct({
  config: DecisionConfigSchema,
  version: Sha256Schema,
})

export const DecisionSetJudgeApiKeyParamsSchema = Schema.Struct({
  judgeName: NonEmptyStringSchema,
  apiKey: Schema.NullOr(NonEmptyStringSchema),
  ...OperationParamsSchema.fields,
})
export const DecisionSetJudgeApiKeyResultSchema = Schema.Struct({
  judgeName: NonEmptyStringSchema,
  credentialId: Schema.NullOr(NonEmptyStringSchema),
  apiKeyMasked: Schema.NullOr(NonEmptyStringSchema),
})

export const DecisionProbeParamsSchema = Schema.Struct({
  judgeName: Schema.optional(NonEmptyStringSchema),
  cwd: Schema.optional(NonEmptyStringSchema),
})
export const DecisionProbeResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  providerId: NonEmptyStringSchema,
  modelId: Schema.optional(NonEmptyStringSchema),
  latencyMs: NonNegativeIntSchema,
  errorKind: Schema.optional(JudgeErrorKindSchema),
  httpStatus: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  endpoint: Schema.optional(NonEmptyStringSchema.check(Schema.isMaxLength(300))),
  errorMessage: Schema.optional(NonEmptyStringSchema.check(Schema.isMaxLength(300))),
})

export const DecisionListLedgerParamsSchema = Schema.Struct({
  threadId: OpaqueIDSchema,
  turnId: Schema.optional(OpaqueIDSchema),
  specId: Schema.optional(NonEmptyStringSchema),
  limit: Schema.optional(LimitSchema),
  cursor: Schema.optional(CursorSchema),
})
export const DecisionListLedgerResultSchema = Schema.Struct({
  records: Schema.Array(DecisionLedgerRecordSchema),
  outcomes: Schema.Array(DecisionOutcomeRecordSchema),
  nextCursor: Schema.optional(CursorSchema),
})

export const DecisionMarkOutcomeParamsSchema = Schema.Struct({
  ledgerId: OpaqueIDSchema,
  threadId: OpaqueIDSchema,
  verdict: Schema.Literals(['correct', 'wrong']),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
  ...OperationParamsSchema.fields,
})
export const DecisionMarkOutcomeResultSchema = Schema.Struct({
  outcome: DecisionOutcomeRecordSchema,
})

export const DecisionRpcMethods = {
  'decision/getConfig': defineMethod({
    params: DecisionGetConfigParamsSchema,
    result: DecisionGetConfigResultSchema,
    errors: DecisionReadErrors,
    capability: 'decision.engine.v1',
    mutation: false,
    exactParams: true,
    exactResult: true,
  }),
  'decision/updateConfig': defineMethod({
    params: DecisionUpdateConfigParamsSchema,
    result: DecisionUpdateConfigResultSchema,
    errors: DecisionConfigErrors,
    capability: 'decision.engine.v1',
    mutation: true,
    exactParams: true,
    exactResult: true,
  }),
  'decision/setJudgeApiKey': defineMethod({
    params: DecisionSetJudgeApiKeyParamsSchema,
    result: DecisionSetJudgeApiKeyResultSchema,
    errors: DecisionCredentialErrors,
    capability: 'decision.engine.v1',
    mutation: true,
    exactParams: true,
    exactResult: true,
  }),
  'decision/probe': defineMethod({
    params: DecisionProbeParamsSchema,
    result: DecisionProbeResultSchema,
    errors: DecisionReadErrors,
    capability: 'decision.engine.v1',
    mutation: false,
    exactParams: true,
    exactResult: true,
  }),
  'decision/listLedger': defineMethod({
    params: DecisionListLedgerParamsSchema,
    result: DecisionListLedgerResultSchema,
    errors: DecisionReadErrors,
    capability: 'decision.engine.v1',
    mutation: false,
    exactParams: true,
    exactResult: true,
  }),
  'decision/markOutcome': defineMethod({
    params: DecisionMarkOutcomeParamsSchema,
    result: DecisionMarkOutcomeResultSchema,
    errors: DecisionWriteErrors,
    capability: 'decision.engine.v1',
    mutation: true,
    exactParams: true,
    exactResult: true,
  }),
} as const satisfies MethodMap

export type DecisionRpcMethodMap = typeof DecisionRpcMethods
