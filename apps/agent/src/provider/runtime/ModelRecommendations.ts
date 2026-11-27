import { omitUndefined } from '@pidex/shared/guards'
import { ProviderChatApiSchema } from '@pidex/agent-protocol'
import { Schema } from 'effect'
import { Model } from '@pidex/model-schema'
import {
  catalogBinding,
  expandCatalogPricing,
  isOtherCatalogProtocolEndpoint,
  providerEndpointIndex,
  resolveCatalogEndpoint,
  selectCatalogProtocol,
  supportsCatalogProtocol,
  type CatalogBinding,
  type CatalogKnowledge,
  type ModelsV2,
  type ProvidersV2,
} from './CatalogV2'

const isChatApi = Schema.is(ProviderChatApiSchema)

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid models.dev catalog')
  return value as JsonObject
}
const bare = (id: string) => id.toLowerCase().split('/').at(-1)!

/**
 * 推理档位括号后缀（`gpt-5(high)`）是历史兼容写法，仅剥离这一种后缀。
 * 日期、`preview`、`highspeed`、`think` 与量化尾都是不同模型，必须真实存在才匹配。
 */
const LEVEL_SUFFIX = /\((?:off|none|minimal|low|medium|high|xhigh|max)\)$/i

const withoutLevelSuffix = (value: string) => value.replace(LEVEL_SUFFIX, '')

export type RecommendationInput = {
  providerId: string
  baseUrl?: string | undefined
  modelId: string
  modelType: 'chat' | 'embedding' | 'rerank'
  api?: string | undefined
  endpoints?: Readonly<Record<string, string | undefined>> | undefined
}

export type RecommendationMatch = {
  status: 'matched' | 'unmatched' | 'ambiguous' | 'no-cache'
  recommended: Model.Recommendation
  recommendedApi?: typeof ProviderChatApiSchema.Type
  /** 命中的官方模型身份（canonical id）。 */
  identity?: string
  /** 基础规格来自官方目录，或叠加了当前供应商的差异。 */
  source?: 'official' | 'provider'
  /** 官方目录同阶段对应多个身份时的候选身份。 */
  candidates?: string[]
  /** 价格独立于规格标明来源；未知网关仅继承原厂参考价。 */
  priceSource?: { kind: 'provider' | 'reference'; providerId: string }
  unsupportedProtocol?: readonly string[]
}

/**
 * 把推荐值合进已保存的模型配置：覆盖全部有推荐值的字段。
 * 未命中推荐时原样返回，所以调用方不需要分支。
 */
export function applyRecommendation<T extends ModelFields>(
  model: T,
  recommended: Model.Recommendation | undefined,
): T {
  if (!recommended || !Object.keys(recommended).length) return model
  const cost = omitUndefined({
    input: recommended.cost?.input,
    output: recommended.cost?.output,
    cacheRead: recommended.cost?.cacheRead,
    cacheWrite: recommended.cost?.cacheWrite,
  })
  return {
    ...model,
    ...(recommended.cost && !recommended.pricing ? { pricing: undefined } : {}),
    ...(recommended.catalog ? { catalog: recommended.catalog } : {}),
    ...omitUndefined({
      pricing: recommended.pricing,
      billingMode: recommended.billingMode,
      speedTiers: recommended.speedTiers,
      modelType: recommended.modelType,
      name: recommended.name,
      contextWindow: recommended.contextWindow,
      maxInputTokens: recommended.maxInputTokens,
      maxTokens: recommended.maxTokens,
      reasoning: recommended.reasoning,
      tools: recommended.tools,
      input: recommended.input,
    }),
    ...(recommended.optionSpecs || recommended.reasoningLevels
      ? {
          optionSpecs: {
            ...model.optionSpecs,
            ...(recommended.reasoningLevels
              ? {
                  reasoningLevel: {
                    ...model.optionSpecs?.reasoningLevel,
                    values: recommended.reasoningLevels,
                  },
                }
              : {}),
            ...recommended.optionSpecs,
            ...(recommended.optionSpecs?.reasoningLevel
              ? {
                  reasoningLevel: {
                    ...model.optionSpecs?.reasoningLevel,
                    ...recommended.optionSpecs?.reasoningLevel,
                  },
                }
              : {}),
            ...(recommended.optionSpecs?.maxOutputTokens
              ? {
                  maxOutputTokens: {
                    ...model.optionSpecs?.maxOutputTokens,
                    ...recommended.optionSpecs?.maxOutputTokens,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(cost).length
      ? {
          cost: {
            ...model.cost,
            ...cost,
            ...(recommended.cost?.tiers ? { tiers: recommended.cost.tiers } : {}),
          },
        }
      : {}),
  }
}

type ModelFields = {
  readonly optionSpecs?: Model.OptionSpecs | undefined
  readonly name: string
  readonly contextWindow: number
  readonly maxInputTokens?: number | undefined
  readonly maxTokens: number
  readonly reasoning: boolean
  readonly tools?: boolean | undefined
  readonly input: readonly ('text' | 'image' | 'audio' | 'video')[]
  readonly cost: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
}

function values(raw: JsonObject): Model.Recommendation {
  const limit = raw.limit === undefined ? {} : object(raw.limit)
  const modalities = raw.modalities === undefined ? {} : object(raw.modalities)
  const supportedInput = Array.isArray(modalities.input)
    ? modalities.input.filter((value) =>
        ['text', 'image', 'audio', 'video'].includes(String(value)),
      )
    : []
  const cost = raw.cost === undefined ? undefined : object(raw.cost)
  const positive = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER
      ? v
      : undefined
  const efforts = Array.isArray(raw.reasoning_options)
    ? raw.reasoning_options.flatMap((item) => {
        const option = object(item)
        return option.type === 'effort' && Array.isArray(option.values) ? option.values : []
      })
    : []
  const explicitEfforts = [
    ...new Set(
      efforts.filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  ]
  const toggle =
    Array.isArray(raw.reasoning_options) &&
    raw.reasoning_options.some((item) => object(item).type === 'toggle')
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  const catalog = Schema.decodeUnknownSync(Model.CatalogDetails)(
    omitUndefined({
      description: raw.description,
      family: raw.family,
      knowledge: raw.knowledge,
      releaseDate: raw.release_date,
      lastUpdated: raw.last_updated,
      status: raw.status,
      openWeights: raw.open_weights,
      license: raw.license,
      attachment: raw.attachment,
      temperature: raw.temperature,
      structuredOutput: raw.structured_output,
      ...(raw.provider && typeof raw.provider === 'object'
        ? {
            providerSdk: object(raw.provider).npm,
            apiShape: object(raw.provider).shape,
          }
        : {}),
      ...(raw.interleaved && typeof raw.interleaved === 'object'
        ? { interleavedField: object(raw.interleaved).field }
        : {}),
      input: modalities.input,
      output: modalities.output,
      reasoningOptions: raw.reasoning_options,
      links: raw.links,
      weights: raw.weights,
      benchmarks: raw.benchmarks,
      reasoningCost: raw.reasoningCost ?? cost?.reasoning,
      inputAudioCost: raw.inputAudioCost ?? cost?.input_audio,
      outputAudioCost: raw.outputAudioCost ?? cost?.output_audio,
    }),
  )
  let explicitOptionSpecs: Model.OptionSpecs | undefined
  const rawOptionSpecs = raw.option_specs ?? raw.optionSpecs
  if (rawOptionSpecs !== undefined) {
    try {
      explicitOptionSpecs = Schema.decodeUnknownSync(Model.OptionSpecs)(rawOptionSpecs)
    } catch {
      explicitOptionSpecs = undefined
    }
  }
  const mergedReasoningValues =
    explicitOptionSpecs?.reasoningLevel?.values ??
    (explicitEfforts.length ? explicitEfforts : toggle ? ['disabled', 'enabled'] : undefined)
  const mergedReasoningLevel =
    mergedReasoningValues || explicitOptionSpecs?.reasoningLevel?.map
      ? {
          ...(mergedReasoningValues ? { values: mergedReasoningValues } : {}),
          ...(explicitOptionSpecs?.reasoningLevel?.map
            ? { map: explicitOptionSpecs.reasoningLevel.map }
            : {}),
        }
      : undefined
  const mergedOptionSpecs =
    mergedReasoningLevel || explicitOptionSpecs?.maxOutputTokens
      ? {
          ...(mergedReasoningLevel ? { reasoningLevel: mergedReasoningLevel } : {}),
          ...(explicitOptionSpecs?.maxOutputTokens
            ? { maxOutputTokens: explicitOptionSpecs.maxOutputTokens }
            : {}),
        }
      : undefined
  return Schema.decodeUnknownSync(Model.Recommendation)({
    ...(Object.values(catalog).some((value) => value !== undefined) ? { catalog } : {}),
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
    ...(positive(limit.context) ? { contextWindow: limit.context } : {}),
    ...(positive(limit.input) ? { maxInputTokens: limit.input } : {}),
    ...(positive(limit.output) ? { maxTokens: limit.output } : {}),
    ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
    ...(typeof raw.tool_call === 'boolean' ? { tools: raw.tool_call } : {}),
    ...(supportedInput.length ? { input: supportedInput } : {}),
    ...(mergedOptionSpecs ? { optionSpecs: mergedOptionSpecs } : {}),
    ...(efforts.length
      ? {
          reasoningLevels: levels.filter(
            (v) => efforts.includes(v) || (v === 'off' && efforts.includes('none')),
          ),
        }
      : {}),
  })
}

export class ModelRecommendationIndex {
  private readonly endpoints: ReadonlyMap<string, string | null>
  private readonly exact = new Map<string, Set<CatalogKnowledge>>()
  private readonly names = new Map<string, Set<CatalogKnowledge>>()
  private readonly prices = new Map<object, Model.Pricing>()

  constructor(
    private readonly providers: ProvidersV2,
    private readonly models: ModelsV2,
  ) {
    this.endpoints = providerEndpointIndex(providers)
    const add = (
      index: Map<string, Set<CatalogKnowledge>>,
      key: string,
      model: CatalogKnowledge,
    ) => {
      const entries = index.get(key) ?? new Set()
      entries.add(model)
      index.set(key, entries)
    }
    for (const [id, model] of Object.entries(models.models)) {
      if (id !== model.id) throw new Error('Model catalog identity mismatch')
      for (const key of [id, ...(model.aliases ?? [])]) {
        add(this.exact, key.toLowerCase(), model)
        add(this.names, bare(key), model)
      }
      this.pricing(model.referencePricing?.pricing)
      for (const offering of Object.values(model.providers)) {
        for (const details of [offering, ...Object.values(offering.modelOverrides ?? {})]) {
          this.pricing(details.pricing)
          for (const tier of Object.values(details.speedTiers ?? {})) this.pricing(tier?.pricing)
        }
      }
    }
    for (const provider of Object.values(providers.providers)) {
      for (const binding of Object.values(provider.models)) {
        if (binding.modelRef && !Object.hasOwn(models.models, binding.modelRef))
          throw new Error('Unknown model catalog binding reference')
      }
    }
  }

  private pricing(raw: Parameters<typeof expandCatalogPricing>[1] | undefined) {
    if (!raw) return undefined
    const previous = this.prices.get(raw)
    if (previous) return previous
    const pricing = expandCatalogPricing(this.models, raw)
    this.prices.set(raw, pricing)
    return pricing
  }

  private providerId(input: RecommendationInput, value: string) {
    const explicit = input.providerId.toLowerCase()
    const known = Object.hasOwn(this.providers.providers, explicit) ? explicit : undefined
    if (known && catalogBinding(this.providers.providers[known], value)) return known
    const matched = resolveCatalogEndpoint(this.endpoints, input.baseUrl)
    if (matched && (!known || catalogBinding(this.providers.providers[matched], value)))
      return matched
    const separator = value.indexOf('/')
    const prefix = value.slice(0, separator)
    if (
      separator > 0 &&
      catalogBinding(this.providers.providers[prefix], value.slice(separator + 1))
    )
      return prefix
    return known ?? matched
  }

  resolve(input: RecommendationInput): RecommendationMatch {
    const baseUrl = (input.api && input.endpoints?.[input.api]) || input.baseUrl
    const endpointProvider = resolveCatalogEndpoint(this.endpoints, baseUrl)
    const plain = input.modelId.trim().toLowerCase()
    for (const value of new Set([plain, withoutLevelSuffix(plain)])) {
      if (!value) continue
      const providerId = endpointProvider ?? this.providerId(input, value)
      const provider = providerId ? this.providers.providers[providerId] : undefined
      const bindingMatch =
        catalogBinding(provider, value) ??
        (providerId && value.startsWith(providerId + '/')
          ? catalogBinding(provider, value.slice(providerId.length + 1))
          : undefined)
      const binding = bindingMatch?.binding
      const referenced = binding?.modelRef ? this.models.models[binding.modelRef] : undefined
      const bindingType = binding?.type ?? referenced?.type ?? 'chat'
      let recommendedApi: RecommendationMatch['recommendedApi']
      if (provider && binding && endpointProvider && bindingType === 'chat' &&
        input.modelType === 'chat' && input.endpoints) {
        const endpoints = {
          ...(input.api && baseUrl ? { [input.api]: baseUrl } : {}),
          ...input.endpoints,
        }
        const availableApis = new Set(
          Object.entries(endpoints).flatMap(([api, url]) =>
            isChatApi(api) && url &&
            resolveCatalogEndpoint(this.endpoints, url) === endpointProvider &&
            !isOtherCatalogProtocolEndpoint(url, api, provider.protocolEndpoints)
              ? [api]
              : [],
          ),
        )
        const preferred =
          availableApis.size > 1
            ? selectCatalogProtocol(provider, binding, undefined, availableApis)
            : undefined
        if (isChatApi(preferred)) recommendedApi = preferred
      }
      if (
        input.api &&
        !recommendedApi &&
        (endpointProvider || !baseUrl) &&
        !supportsCatalogProtocol(binding, input.api)
      ) {
        return {
          status: 'unmatched',
          recommended: {},
          unsupportedProtocol: binding!.supportedProtocols!,
        }
      }
      if (binding && !binding.modelRef && bindingType === input.modelType) {
        const mode = binding.routerFallback?.billingMode ?? provider?.billingMode
        const pricing =
          mode && mode !== 'pay-as-you-go' ? this.pricing({ billingMode: mode }) : undefined
        return {
          status: 'matched',
          source: 'provider',
          ...(recommendedApi ? { recommendedApi } : {}),
          recommended: {
            ...values({ ...binding.routerFallback, name: binding.name }),
            modelType: bindingType,
            ...(mode ? { billingMode: mode } : {}),
            ...(pricing
              ? { pricing, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
              : {}),
          },
        }
      }
      if (referenced && bindingType === input.modelType) {
        const aliasTier = Model.SpeedTierIds.find(
          (tier) => binding?.speedTiers?.[tier]?.requestModelId?.toLowerCase() === value,
        )
        return {
          ...this.compose(referenced, providerId, bindingMatch?.id, binding, aliasTier),
          ...(recommendedApi ? { recommendedApi } : {}),
        }
      }
      const matchingType = (candidates?: Set<CatalogKnowledge>) =>
        [...(candidates ?? [])].filter((candidate) => candidate.type === input.modelType)
      const exact = matchingType(this.exact.get(value))
      const candidates = exact.length ? exact : matchingType(this.names.get(bare(value)))
      if (candidates.length > 1) {
        return {
          status: 'ambiguous',
          recommended: {},
          candidates: candidates.map((entry) => entry.id),
        }
      }
      const model = candidates[0]
      if (model) return this.compose(model, providerId)
    }
    return { status: 'unmatched', recommended: {} }
  }

  private compose(
    model: CatalogKnowledge,
    providerId?: string,
    modelId?: string,
    binding?: CatalogBinding,
    aliasTier: Model.SpeedTierId = 'standard',
  ): RecommendationMatch {
    const offer = providerId ? model.providers[providerId] : undefined
    const available = offer?.available ? offer : undefined
    const details = (modelId && available?.modelOverrides?.[modelId]) || available
    const overrides = details?.overrides
    const mode = providerId ? this.providers.providers[providerId]?.billingMode : undefined
    const standardPrice =
      details?.pricing ??
      (available && mode && mode !== 'pay-as-you-go' ? { billingMode: mode } : undefined)
    const providerPrice = details?.speedTiers?.[aliasTier]?.pricing ?? standardPrice
    const priceSource =
      providerPrice && providerId
        ? { kind: 'provider' as const, providerId }
        : model.referencePricing
          ? { kind: 'reference' as const, providerId: model.referencePricing.sourceProviderId }
          : undefined
    const pricing = this.pricing(providerPrice ?? model.referencePricing?.pricing)
    const price = pricing?.busy
    const cost = price
      ? omitUndefined({
          input: price.input ?? undefined,
          output: price.output ?? undefined,
          cacheRead: price.cacheRead ?? undefined,
          cacheWrite: price.cacheWrite ?? undefined,
          tiers: price.tiers?.map((tier) => ({
            inputTokensAbove: tier.inputTokensAbove,
            input: tier.input ?? 0,
            output: tier.output ?? 0,
            cacheRead: tier.cacheRead ?? 0,
            cacheWrite: tier.cacheWrite ?? 0,
          })),
        })
      : undefined
    const profiles: Model.SpeedTierInfo[] = Model.SpeedTierIds.flatMap((id) => {
      const tier = details?.speedTiers?.[id]
      if (id !== 'standard' && (!tier || !binding?.speedTiers?.[id])) return []
      const price = tier?.pricing ?? standardPrice ?? model.referencePricing?.pricing
      return [
        {
          id,
          ...omitUndefined({
            label: tier?.label,
            speedMultiplier: tier?.speedMultiplier,
            pricing: this.pricing(price),
          }),
        },
      ]
    })
    const base = values({
      ...model,
      ...overrides,
      name: binding?.name ?? model.name,
      ...omitUndefined({
        reasoningCost: details?.reasoningCost,
        inputAudioCost: details?.inputAudioCost,
        outputAudioCost: details?.outputAudioCost,
      }),
      limit: { ...object(model.limit ?? {}), ...object(overrides?.limit ?? {}) },
      modalities: { ...object(model.modalities ?? {}), ...object(overrides?.modalities ?? {}) },
    })
    const recommended: Model.Recommendation = {
      ...base,
      modelType: model.type,
      ...omitUndefined({
        pricing,
        cost,
        billingMode: pricing?.billingMode ?? (pricing ? ('pay-as-you-go' as const) : undefined),
        speedTiers: profiles.length > 1 || details?.speedTiers?.standard ? profiles : undefined,
      }),
      ...(priceSource ? { catalog: { ...base.catalog, priceSource } } : {}),
    }
    const {
      maxTokens: _max,
      reasoning: _reasoning,
      optionSpecs: _options,
      reasoningLevels: _levels,
      tools: _tools,
      ...nonChat
    } = recommended
    return {
      status: 'matched',
      recommended: model.type === 'chat' ? recommended : nonChat,
      identity: model.id,
      source: available ? 'provider' : 'official',
      ...(priceSource ? { priceSource } : {}),
    }
  }
}
