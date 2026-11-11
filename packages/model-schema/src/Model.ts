export * as Model from './Model'

import { Schema } from 'effect'
import { Provider } from './Provider'
import { optional, statics } from './Schema'

export const ID = Schema.String.pipe(Schema.brand('Model.ID'))
export type ID = typeof ID.Type

export const VariantID = Schema.String.pipe(Schema.brand('Model.VariantID'))
export type VariantID = typeof VariantID.Type

export const Ref = Schema.Struct({
  providerID: Provider.ID,
  id: ID,
  variant: optional(VariantID),
}).annotate({ identifier: 'Model.Ref' })
export interface Ref extends Schema.Schema.Type<typeof Ref> {}

export const Family = Schema.String.pipe(Schema.brand('Model.Family'))
export type Family = typeof Family.Type

export const ReasoningLevels = Schema.Array(
  Schema.Literals(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
)

/**
 * 可被推荐值接管、也可被用户固定的模型草稿字段。
 * 固定值本身仍写在普通模型字段里，这里只记录哪些字段已脱离推荐。
 */
export const SmartConfigPinnedFields = [
  'name',
  'contextWindow',
  'maxInputTokens',
  'maxTokens',
  'reasoning',
  'tools',
  'imageInput',
  'audioInput',
  'videoInput',
  'inputCost',
  'outputCost',
  'cacheReadCost',
  'cacheWriteCost',
] as const
export const SmartConfigPinnedField = Schema.Literals(SmartConfigPinnedFields)
export type SmartConfigPinnedField = typeof SmartConfigPinnedField.Type


/**
 * 双层模型参数规格（沿用 ZCode 的 values + map 结构）。
 * - `values` 定义公开可选档位及展示顺序（可为 disabled/enabled、none/high/max 等实际值）。
 * - `map` 是受限 CEL 表达式，把选中的值转换成当前协议请求体的 JSON Merge Patch。
 * values 与 map 分别继承、分别覆盖；语义校验（CEL 可编译）在 Agent Provider 保存/导入边界完成。
 */
export const ReasoningLevelOptionSpec = Schema.Struct({
  values: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
  ),
  map: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
})
export type ReasoningLevelOptionSpec = typeof ReasoningLevelOptionSpec.Type

export const MaxOutputTokensOptionSpec = Schema.Struct({
  max: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))),
  map: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
})
export type MaxOutputTokensOptionSpec = typeof MaxOutputTokensOptionSpec.Type

export const OptionSpecs = Schema.Struct({
  reasoningLevel: Schema.optional(ReasoningLevelOptionSpec),
  maxOutputTokens: Schema.optional(MaxOutputTokensOptionSpec),
})
export type OptionSpecs = typeof OptionSpecs.Type

const Price = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const PricingPrice = Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })))
export const UnitPrices = Schema.Struct({
  input: PricingPrice, output: PricingPrice, cacheRead: PricingPrice, cacheWrite: PricingPrice,
})
export type UnitPrices = typeof UnitPrices.Type
export const BillingPeriod = Schema.Literals(['idle', 'busy'])
const ClockTime = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/))
export const Pricing = Schema.Struct({
  currency: Schema.Literals(['USD', 'CNY']),
  timeZone: Schema.String.check(Schema.isMinLength(1)),
  defaultPeriod: BillingPeriod,
  idle: UnitPrices, busy: UnitPrices,
  rules: Schema.Array(Schema.Struct({
    period: BillingPeriod,
    weekdays: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))).check(Schema.isMaxLength(7)),
    holiday: Schema.Literals(['any', 'exclude-cn', 'only-cn']),
    intervals: Schema.Array(Schema.Struct({ start: ClockTime, end: ClockTime })).check(Schema.isMaxLength(48)),
  })).check(Schema.isMaxLength(100)),
  dateOverrides: Schema.Array(Schema.Struct({
    date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)), period: BillingPeriod,
  })).check(Schema.isMaxLength(1000)),
})
export type Pricing = typeof Pricing.Type
export type RequestPriceUsage = {
  priceSnapshotId?: string
  priceSnapshotIds?: string[]
  costUnknown?: boolean
  conservativeCost?: boolean
  pricingReason?: string
}

export const PriceTier = Schema.Struct({
  inputTokensAbove: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  input: Price,
  output: Price,
  cacheRead: Price,
  cacheWrite: Price,
})
export const ReasoningOption = Schema.Struct({
  type: Schema.Literals(['toggle', 'effort', 'budget_tokens']),
  values: Schema.optional(Schema.Array(Schema.NullOr(Schema.String))),
  min: Schema.optional(Schema.Finite),
  max: Schema.optional(Schema.Finite),
})
/** models.dev v1 资料；与当前客户端可执行能力分开。 */
export const CatalogDetails = Schema.Struct({
  description: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String),
  knowledge: Schema.optional(Schema.String),
  releaseDate: Schema.optional(Schema.String),
  lastUpdated: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(['alpha', 'beta', 'deprecated'])),
  openWeights: Schema.optional(Schema.Boolean),
  license: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Array(Schema.String)),
  output: Schema.optional(Schema.Array(Schema.String)),
  attachment: Schema.optional(Schema.Boolean),
  temperature: Schema.optional(Schema.Boolean),
  structuredOutput: Schema.optional(Schema.Boolean),
  providerSdk: Schema.optional(Schema.String),
  apiShape: Schema.optional(Schema.String),
  interleavedField: Schema.optional(Schema.String),
  reasoningOptions: Schema.optional(Schema.Array(ReasoningOption)),
  reasoningCost: Schema.optional(Price),
  inputAudioCost: Schema.optional(Price),
  outputAudioCost: Schema.optional(Price),
  priceSource: Schema.optional(Schema.Struct({
    kind: Schema.Literals(['provider', 'reference']), providerId: Schema.String,
  })),
  links: Schema.optional(Schema.Array(Schema.Struct({
    label: Schema.optional(Schema.String), url: Schema.String, type: Schema.optional(Schema.String),
  }))),
  weights: Schema.optional(Schema.Array(Schema.Struct({
    label: Schema.optional(Schema.String), url: Schema.String,
    format: Schema.optional(Schema.String), quantization: Schema.optional(Schema.String),
  }))),
  benchmarks: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.String, score: Schema.Union([Schema.Finite, Schema.String]),
    metric: Schema.optional(Schema.String), harness: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.String), dataset: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String), source: Schema.optional(Schema.String),
    date: Schema.optional(Schema.String),
  }))),
})
export type CatalogDetails = typeof CatalogDetails.Type

export const Recommendation = Schema.Struct({
  pricing: Schema.optional(Pricing),
  modelType: Schema.optional(Schema.Literals(['chat', 'embedding', 'rerank'])),
  catalog: Schema.optional(CatalogDetails),
  name: Schema.optional(Schema.String),
  contextWindow: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  ),
  maxInputTokens: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  ),
  maxTokens: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  ),
  reasoning: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Boolean),
  input: Schema.optional(Schema.Array(Schema.Literals(['text', 'image', 'audio', 'video'])).check(Schema.isMinLength(1))),
  reasoningLevels: Schema.optional(ReasoningLevels),
  /** 双层参数规格（values/map）；显式存在时优先于 reasoningLevels 固定七档。 */
  optionSpecs: Schema.optional(OptionSpecs),
  cost: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
      output: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
      cacheRead: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
      cacheWrite: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
      tiers: Schema.optional(Schema.Array(PriceTier)),
    }),
  ),
})
export type Recommendation = typeof Recommendation.Type

export const DocumentSnapshot = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048)),
  extractor: Ref,
  extractedAt: Schema.Finite,
  data: Recommendation,
  evidence: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(30)),
})
export type DocumentSnapshot = typeof DocumentSnapshot.Type
export const SmartConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  pinned: Schema.Array(SmartConfigPinnedField),
  source: Schema.optional(Schema.Literals(['catalog', 'document'])),
  document: Schema.optional(DocumentSnapshot),
})
export type SmartConfig = typeof SmartConfig.Type

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  tools: Schema.Boolean,
  input: Schema.Array(Schema.String),
  output: Schema.Array(Schema.String),
}).annotate({ identifier: 'Model.Capabilities' })

export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({
  tier: optional(
    Schema.Struct({
      type: Schema.Literal('context'),
      size: Schema.Int,
    }),
  ),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
}).annotate({ identifier: 'Model.Cost' })

export const Api = Schema.Union([
  Schema.Struct({
    id: ID,
    type: Schema.Literal('pi'),
    name: Schema.String,
    baseUrl: Schema.String,
  }),
])
  .pipe(Schema.toTaggedUnion('type'))
  .annotate({ identifier: 'Model.Api' })
export type Api = typeof Api.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  catalog: Schema.optional(CatalogDetails),
  id: ID,
  providerID: Provider.ID,
  family: optional(Family),
  name: Schema.String,
  modelType: optional(Schema.Literals(['chat', 'embedding', 'rerank'])),
  api: Api,
  variant: optional(Schema.String),
  capabilities: Capabilities,
  variants: Schema.Array(
    Schema.Struct({
      id: VariantID,
    }),
  ),
  time: Schema.Struct({
    released: Schema.Finite,
  }),
  cost: Schema.Array(Cost),
  status: Schema.Literals(['alpha', 'beta', 'deprecated', 'active']),
  enabled: Schema.Boolean,
  limit: Schema.Struct({
    context: Schema.Int,
    input: optional(Schema.Int),
    output: Schema.Int,
  }),
})
  .annotate({ identifier: 'Model.Info' })
  .pipe(
    statics((schema) => ({
      empty: (providerID: Provider.ID, modelID: ID) =>
        schema.make({
          id: modelID,
          providerID,
          name: modelID,
          api: { id: modelID, type: 'pi', name: '', baseUrl: '' },
          capabilities: { tools: false, input: [], output: [] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: 'active',
          enabled: true,
          limit: { context: 0, output: 0 },
        }),
    })),
  )
