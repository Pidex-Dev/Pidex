import { Schema } from 'effect'
import { Model, Provider } from '@pidex/model-schema'
import { defineMethod } from '../wire/Definition'
import { NonNegativeIntSchema, OpaqueIDSchema } from '../wire/Primitives'

export const RecommendationPreviewParams = Schema.Struct({
  providerId: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  modelId: Schema.String,
  modelType: Schema.Literals(['chat', 'embedding', 'rerank']),
})
export const RecommendationSourceSchema = Schema.Literals(['official', 'provider'])

export const ModelSpecFieldSchema = Schema.Literals(['contextWindow', 'maxInputTokens', 'maxTokens'])
export type ModelSpecField = typeof ModelSpecFieldSchema.Type

export const ModelSpecMatchSchema = Schema.Struct({
  status: Schema.Literals(['official', 'provider', 'unmatched', 'ambiguous', 'no-cache']),
  identity: Schema.optional(Model.ID),
  source: Schema.optional(RecommendationSourceSchema),
  candidates: Schema.optional(Schema.Array(Model.ID)),
  updatedAt: Schema.optional(Schema.Finite),
})
export type ModelSpecMatch = typeof ModelSpecMatchSchema.Type

export const ModelSpecSuggestionSchema = Schema.Struct({
  field: ModelSpecFieldSchema,
  /** 当前保存值；缺失表示该字段原本没有显式额度。 */
  current: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  suggested: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** 该字段已固定，默认不勾选，但允许用户明确覆盖。 */
  pinned: Schema.Boolean,
  /** 推荐值仍是 32768 占位，无须修复。 */
  noRepair: Schema.Boolean,
  defaultSelected: Schema.Boolean,
})
export type ModelSpecSuggestion = typeof ModelSpecSuggestionSchema.Type

export const ModelSpecRepairItemSchema = Schema.Struct({
  modelId: Model.ID,
  name: Schema.String,
  match: ModelSpecMatchSchema,
  fields: Schema.Array(ModelSpecSuggestionSchema),
})
export type ModelSpecRepairItem = typeof ModelSpecRepairItemSchema.Type

export const ModelSpecRepairRpcMethods = {
  'provider/model/specs/preview': defineMethod({
    params: Schema.Struct({ providerId: Provider.ID }),
    result: Schema.Struct({
      providerId: Provider.ID,
      /** 预览基于的用户配置层版本；应用时必须一致。 */
      configVersion: Schema.String,
      /** 预览使用的推荐目录版本；缺失表示目录不可用。 */
      catalogUpdatedAt: Schema.optional(Schema.Finite),
      items: Schema.Array(ModelSpecRepairItemSchema),
    }),
    errors: ['PROVIDER_NOT_FOUND', 'INVALID_REQUEST', 'PROVIDER_UNAVAILABLE'],
    capability: 'provider.modelSpecs.v1',
    mutation: false,
    exactParams: true,
  }),
  'provider/model/specs/apply': defineMethod({
    params: Schema.Struct({
      providerId: Provider.ID,
      expectedConfigVersion: Schema.String,
      expectedCatalogUpdatedAt: Schema.optional(Schema.Finite),
      selections: Schema.Array(
        Schema.Struct({
          modelId: Model.ID,
          fields: Schema.Array(ModelSpecFieldSchema).check(Schema.isMinLength(1)),
        }),
      ).check(Schema.isMaxLength(500)),
      operationId: OpaqueIDSchema,
    }),
    result: Schema.Struct({
      providerId: Provider.ID,
      updatedModels: NonNegativeIntSchema,
      updatedFields: NonNegativeIntSchema,
    }),
    errors: ['PROVIDER_NOT_FOUND', 'INVALID_REQUEST', 'CONFLICT', 'PROVIDER_UNAVAILABLE'],
    capability: 'provider.modelSpecs.v1',
    mutation: true,
    exactParams: true,
  }),
} as const

export const ModelRecommendationRpcMethods = {
  'model/recommendation/preview': defineMethod({
    params: RecommendationPreviewParams,
    result: Schema.Struct({
      status: Schema.Literals(['matched', 'unmatched', 'ambiguous', 'no-cache']),
      recommended: Model.Recommendation,
      updatedAt: Schema.optional(Schema.Finite),
      /** 命中的官方模型身份（canonical id）。 */
      identity: Schema.optional(Model.ID),
      /** 基础规格来自官方目录，或叠加了当前供应商的差异。 */
      source: Schema.optional(RecommendationSourceSchema),
      /** 官方目录同阶段对应多个身份时的候选身份。 */
      priceSource: Schema.optional(Schema.Struct({
        kind: Schema.Literals(['provider', 'reference']),
        providerId: Provider.ID,
      })),
      candidates: Schema.optional(Schema.Array(Model.ID)),
    }),
    errors: ['INVALID_REQUEST', 'PROVIDER_UNAVAILABLE'],
    capability: 'model.recommendations.v1',
    mutation: false,
    exactParams: true,
  }),
  'model/recommendation/refresh': defineMethod({
    params: Schema.Struct({ operationId: OpaqueIDSchema }),
    result: Schema.Struct({ updatedAt: Schema.Finite }),
    errors: ['INVALID_REQUEST', 'PROVIDER_UNAVAILABLE'],
    capability: 'model.recommendations.v1',
    mutation: true,
    exactParams: true,
  }),
  ...ModelSpecRepairRpcMethods,
} as const

export type ModelRecommendation = Model.Recommendation
export type SmartConfig = Model.SmartConfig
export type SmartConfigPinnedField = Model.SmartConfigPinnedField
export const SmartConfigPinnedFields = Model.SmartConfigPinnedFields
