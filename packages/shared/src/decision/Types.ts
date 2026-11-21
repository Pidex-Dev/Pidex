import { Schema } from 'effect'

const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1))
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ProbabilitySchema = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

/**
 * - `off`: the judge is not called; the fallback is returned.
 * - `shadow`: the judge is called and recorded, but the fallback is returned.
 * - `active`: the judged outcome is returned unless the policy abstains or the call fails.
 */
export const DecisionModeSchema = Schema.Literals(['off', 'shadow', 'active'])
export type DecisionMode = typeof DecisionModeSchema.Type

/**
 * What acting on the decision does to the provider prompt cache.
 * `prefix-mutating` decisions rewrite earlier context and only apply at cache boundaries.
 */
export const CacheImpactSchema = Schema.Literals(['none', 'append-only', 'prefix-mutating'])
export type CacheImpact = typeof CacheImpactSchema.Type

/** `inline` blocks the agent loop, `parallel` races other work, `background` never blocks. */
export const LatencyClassSchema = Schema.Literals(['inline', 'parallel', 'background'])
export type LatencyClass = typeof LatencyClassSchema.Type

/** What answering a question takes, which separates judges in a cascade. */
export const DecisionCapabilitySchema = Schema.Literals([
  'classify',
  'relate',
  'rate',
  'meta',
  'screen',
  'intent',
])
export type DecisionCapability = typeof DecisionCapabilitySchema.Type

export const DecisionGroupSchema = Schema.Literals([
  'input',
  'context',
  'safety',
  'turn',
  'teamwork',
])
export type DecisionGroup = typeof DecisionGroupSchema.Type

/** Shared state or structured instructions shown to a judge. */
export const JudgeInputSchema = Schema.Json
export type JudgeInput = typeof JudgeInputSchema.Type

export const BooleanQuestionSchema = Schema.Struct({
  type: Schema.Literal('boolean'),
  instructions: JudgeInputSchema,
  criteria: Schema.optional(
    Schema.Struct({
      true: Schema.optional(Schema.NullOr(JudgeInputSchema)),
      false: Schema.optional(Schema.NullOr(JudgeInputSchema)),
    }),
  ),
})
export type BooleanQuestion = typeof BooleanQuestionSchema.Type

export const ChoiceQuestionSchema = Schema.Struct({
  type: Schema.Literal('choice'),
  instructions: JudgeInputSchema,
  criteria: Schema.Record(NonEmptyStringSchema, Schema.NullOr(JudgeInputSchema)),
})
export type ChoiceQuestion = typeof ChoiceQuestionSchema.Type

export const ScoreQuestionSchema = Schema.Struct({
  type: Schema.Literal('score'),
  instructions: JudgeInputSchema,
  criteria: Schema.Array(Schema.NullOr(JudgeInputSchema)),
})
export type ScoreQuestion = typeof ScoreQuestionSchema.Type

export const DecisionQuestionSchema = Schema.Union([
  BooleanQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
])
export type DecisionQuestion = typeof DecisionQuestionSchema.Type

export const DecisionQuestionsSchema = Schema.Record(NonEmptyStringSchema, DecisionQuestionSchema)
export type DecisionQuestions = typeof DecisionQuestionsSchema.Type

const AnswerSignalsFields = {
  confidence: Schema.optional(ProbabilitySchema),
  judge: Schema.optional(NonEmptyStringSchema),
} as const

export const BooleanAnswerSchema = Schema.Struct({
  type: Schema.Literal('boolean'),
  probability: ProbabilitySchema,
  ...AnswerSignalsFields,
})
export type BooleanAnswer = typeof BooleanAnswerSchema.Type

export const ChoiceAnswerSchema = Schema.Struct({
  type: Schema.Literal('choice'),
  choice: NonEmptyStringSchema,
  probabilities: Schema.optional(Schema.Record(NonEmptyStringSchema, ProbabilitySchema)),
  ...AnswerSignalsFields,
})
export type ChoiceAnswer = typeof ChoiceAnswerSchema.Type

export const ScoreAnswerSchema = Schema.Struct({
  type: Schema.Literal('score'),
  score: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  probabilities: Schema.optional(Schema.Record(NonEmptyStringSchema, ProbabilitySchema)),
  ...AnswerSignalsFields,
})
export type ScoreAnswer = typeof ScoreAnswerSchema.Type

export const DecisionAnswerSchema = Schema.Union([
  BooleanAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
])
export type DecisionAnswer = typeof DecisionAnswerSchema.Type

export const DecisionAnswersSchema = Schema.Record(NonEmptyStringSchema, DecisionAnswerSchema)
export type DecisionAnswers = typeof DecisionAnswersSchema.Type

export const JudgeUsageSchema = Schema.Struct({
  inputTokens: Schema.optional(NonNegativeIntSchema),
  outputTokens: Schema.optional(NonNegativeIntSchema),
  cachedInputTokens: Schema.optional(NonNegativeIntSchema),
  cacheWriteTokens: Schema.optional(NonNegativeIntSchema),
})
export type JudgeUsage = typeof JudgeUsageSchema.Type

/** Something the provider did that the caller did not ask for, such as truncating the state. */
export const JudgeWarningSchema = Schema.Struct({
  type: NonEmptyStringSchema,
  message: Schema.optional(Schema.String),
  questionId: Schema.optional(NonEmptyStringSchema),
})
export type JudgeWarning = typeof JudgeWarningSchema.Type

export const JudgeTierReportSchema = Schema.Struct({
  judgeId: NonEmptyStringSchema,
  asked: NonNegativeIntSchema,
  kept: NonNegativeIntSchema,
  latencyMs: Schema.optional(NonNegativeIntSchema),
  error: Schema.optional(NonEmptyStringSchema),
})
export type JudgeTierReport = typeof JudgeTierReportSchema.Type

/** Sanitized failure category; never carries keys, endpoints or raw provider messages. */
export const JudgeErrorKindSchema = Schema.Literals([
  'auth',
  'payment_required',
  'rate_limited',
  'bad_request',
  'timeout',
  'aborted',
  'unreachable',
  'server',
  'invalid_response',
  'unexpected',
])
export type JudgeErrorKind = typeof JudgeErrorKindSchema.Type

export const JudgeTypeSchema = Schema.Literals([
  'openai',
  'typesafe',
  'systemone',
  'http',
  'classifier',
  'llm',
  'mock',
])
export type JudgeType = typeof JudgeTypeSchema.Type

export const JudgeConfigSchema = Schema.Struct({
  type: JudgeTypeSchema,
  providerId: Schema.optional(NonEmptyStringSchema),
  model: Schema.optional(NonEmptyStringSchema),
  baseUrl: Schema.optional(NonEmptyStringSchema),
  path: Schema.optional(NonEmptyStringSchema),
  credentialId: Schema.optional(NonEmptyStringSchema),
  thinking: Schema.optional(Schema.Literals(['off', 'low', 'medium', 'high'])),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  confidenceThreshold: Schema.optional(ProbabilitySchema),
})
export type JudgeConfig = typeof JudgeConfigSchema.Type

export const DecisionConfigSchema = Schema.Struct({
  tiers: Schema.Array(NonEmptyStringSchema),
  judges: Schema.Record(NonEmptyStringSchema, JudgeConfigSchema),
  modes: Schema.Record(NonEmptyStringSchema, DecisionModeSchema),
  routes: Schema.Record(NonEmptyStringSchema, Schema.Array(NonEmptyStringSchema)),
  features: Schema.Record(NonEmptyStringSchema, Schema.Record(Schema.String, Schema.Json)),
  recordState: Schema.Boolean,
})
export type DecisionConfig = typeof DecisionConfigSchema.Type

export const DecisionLedgerModeSchema = Schema.Literals(['shadow', 'active'])
export const DecisionSourceSchema = Schema.Literals(['judge', 'fallback'])

export const DecisionBatchSchema = Schema.Struct({
  size: NonNegativeIntSchema,
  failures: NonNegativeIntSchema,
  answers: Schema.optional(Schema.Array(Schema.NullOr(DecisionAnswersSchema))),
  digests: Schema.optional(Schema.Array(Sha256Schema)),
})
export type DecisionBatch = typeof DecisionBatchSchema.Type

export const DecisionLedgerRecordSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  threadId: Schema.optional(NonEmptyStringSchema),
  turnId: Schema.optional(NonEmptyStringSchema),
  specId: NonEmptyStringSchema,
  specVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  mode: DecisionLedgerModeSchema,
  providerId: NonEmptyStringSchema,
  modelId: Schema.optional(NonEmptyStringSchema),
  outcome: Schema.Json,
  source: DecisionSourceSchema,
  reason: Schema.optional(Schema.String),
  judged: Schema.optional(Schema.Json),
  answers: Schema.optional(DecisionAnswersSchema),
  latencyMs: Schema.optional(NonNegativeIntSchema),
  usage: Schema.optional(JudgeUsageSchema),
  warnings: Schema.optional(Schema.Array(JudgeWarningSchema)),
  tiers: Schema.optional(Schema.Array(JudgeTierReportSchema)),
  batch: Schema.optional(DecisionBatchSchema),
  stateDigest: Sha256Schema,
  state: Schema.optional(Schema.Json),
  questions: Schema.optional(Schema.Json),
  createdAt: Schema.Number,
})
export type DecisionLedgerRecord = typeof DecisionLedgerRecordSchema.Type

export const DecisionOutcomeKindSchema = Schema.Literals(['permission', 'mark', 'nudge'])

export const DecisionOutcomeRecordSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  ledgerId: NonEmptyStringSchema,
  threadId: Schema.optional(NonEmptyStringSchema),
  kind: DecisionOutcomeKindSchema,
  verdict: NonEmptyStringSchema,
  note: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Json),
  createdAt: Schema.Number,
})
export type DecisionOutcomeRecord = typeof DecisionOutcomeRecordSchema.Type

export const DecisionPresentationNoticeSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  threadId: NonEmptyStringSchema,
  turnId: Schema.optional(NonEmptyStringSchema),
  specId: NonEmptyStringSchema,
  code: NonEmptyStringSchema,
  params: Schema.Record(Schema.String, Schema.Json),
  message: NonEmptyStringSchema,
  createdAt: Schema.Number,
})
export type DecisionPresentationNotice = typeof DecisionPresentationNoticeSchema.Type