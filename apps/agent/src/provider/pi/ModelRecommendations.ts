import { Schema } from 'effect'
import { Model } from '@pidex/model-schema'

const recommendationFields = [
  'name',
  'contextWindow',
  'maxInputTokens',
  'maxTokens',
  'reasoning',
  'tools',
  'input',
  'reasoningLevels',
] as const
type RecommendationField = (typeof recommendationFields)[number]

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

/** 规范化端点：忽略大小写、查询串、哈希与尾部斜杠，只保留 origin + pathname。 */
const normalizeEndpoint = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`.toLowerCase()
  } catch {
    return undefined
  }
}

type Entry = {
  id: string
  canonical: string
  aliases: string[]
  type: string
  provider: string | undefined
  endpoint: string | undefined
  values: Model.Recommendation
}
export type RecommendationInput = {
  providerId: string
  baseUrl?: string | undefined
  modelId: string
  modelType: 'chat' | 'embedding' | 'rerank'
}

export type RecommendationMatch = {
  status: 'matched' | 'unmatched' | 'ambiguous' | 'no-cache'
  recommended: Model.Recommendation
  /** 命中的官方模型身份（canonical id）。 */
  identity?: string
  /** 基础规格来自官方目录，或叠加了当前供应商的差异。 */
  source?: 'official' | 'provider'
  /** 官方目录同阶段对应多个身份时的候选身份。 */
  candidates?: string[]
  /** 价格独立于规格标明来源；未知网关仅继承原厂参考价。 */
  priceSource?: { kind: 'provider' | 'reference'; providerId: string }
}

/**
 * 把推荐值合进已保存的模型配置：覆盖全部有推荐值的字段。
 * 未命中推荐时原样返回，所以调用方不需要分支。
 */
export function applyRecommendation<T extends PiModelFields>(
  model: T,
  recommended: Model.Recommendation | undefined,
): T {
  if (!recommended || !Object.keys(recommended).length) return model
  const pick = <K extends keyof Model.Recommendation>(key: K) => recommended[key]
  const name = pick('name')
  const contextWindow = pick('contextWindow')
  const maxInputTokens = pick('maxInputTokens')
  const maxTokens = pick('maxTokens')
  const reasoning = pick('reasoning')
  const tools = pick('tools')
  const inputCost = recommended.cost?.input
  const outputCost = recommended.cost?.output
  const cacheReadCost = recommended.cost?.cacheRead
  const cacheWriteCost = recommended.cost?.cacheWrite
  const input = recommended.input
  return {
    ...model,
    ...(name !== undefined ? { name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(recommended.optionSpecs ? { optionSpecs: {
      ...model.optionSpecs, ...recommended.optionSpecs,
      ...(recommended.optionSpecs.reasoningLevel ? { reasoningLevel: { ...model.optionSpecs?.reasoningLevel, ...recommended.optionSpecs.reasoningLevel } } : {}),
      ...(recommended.optionSpecs.maxOutputTokens ? { maxOutputTokens: { ...model.optionSpecs?.maxOutputTokens, ...recommended.optionSpecs.maxOutputTokens } } : {}),
    } } : {}),
    ...(inputCost !== undefined ||
    outputCost !== undefined ||
    cacheReadCost !== undefined ||
    cacheWriteCost !== undefined
      ? {
          cost: {
            ...model.cost,
            ...(inputCost !== undefined ? { input: inputCost } : {}),
            ...(outputCost !== undefined ? { output: outputCost } : {}),
            ...(cacheReadCost !== undefined ? { cacheRead: cacheReadCost } : {}),
            ...(cacheWriteCost !== undefined ? { cacheWrite: cacheWriteCost } : {}),
          },
        }
      : {}),
  }
}

type PiModelFields = {
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
  const cost = raw.cost === undefined ? undefined : object(raw.cost)
  const positive = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER ? v : undefined
  const efforts = Array.isArray(raw.reasoning_options)
    ? raw.reasoning_options.flatMap((item) => {
        const option = object(item)
        return option.type === 'effort' && Array.isArray(option.values) ? option.values : []
      })
    : []
  const explicitEfforts = [...new Set(efforts.filter((value): value is string => typeof value === 'string' && value.length > 0))]
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  return Schema.decodeUnknownSync(Model.Recommendation)({
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
    ...(positive(limit.context) ? { contextWindow: limit.context } : {}),
    ...(positive(limit.input) ? { maxInputTokens: limit.input } : {}),
    ...(positive(limit.output) ? { maxTokens: limit.output } : {}),
    ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
    ...(typeof raw.tool_call === 'boolean' ? { tools: raw.tool_call } : {}),
    ...(Array.isArray(modalities.input)
      ? {
          input: modalities.input.filter((v) =>
            ['text', 'image', 'audio', 'video'].includes(String(v)),
          ),
        }
      : {}),
    ...(explicitEfforts.length ? { optionSpecs: { reasoningLevel: { values: explicitEfforts } } } : {}),
    ...(efforts.length
      ? {
          reasoningLevels: levels.filter(
            (v) => efforts.includes(v) || (v === 'off' && efforts.includes('none')),
          ),
        }
      : {}),
    ...(cost
      ? {
          cost: {
            input: cost.input,
            output: cost.output,
            cacheRead: cost.cache_read,
            cacheWrite: cost.cache_write,
          },
        }
      : {}),
  })
}

const mergeValues = (entries: readonly Entry[]): Model.Recommendation =>
  entries.reduce<Model.Recommendation>((merged, entry) => ({ ...merged, ...entry.values }), {})

/**
 * 模型身份解析索引。
 *
 * 身份只由官方目录（`catalog.models`）决定；第三方供应商条目只提供当前
 * 供应商的规格差异，不参与同名投票，也不能否决官方匹配。
 */
export class ModelRecommendationIndex {
  private readonly entries: Entry[] = []
  constructor(payload: unknown) {
    const catalog = object(payload)
    const models = object(catalog.models)
    const providers = object(catalog.providers)
    const add = (id: string, input: unknown, provider?: string, endpoint?: string) => {
      const raw = object(input)
      const type = raw.type === 'reranking' ? 'rerank' : (raw.type ?? 'chat')
      if (!['chat', 'embedding', 'rerank'].includes(String(type))) return
      // 官方条目身份就是自身；供应商条目没有显式 canonical 时只代表自己，
      // 不再按裸名跨供应商推断别人家的身份。
      const canonical =
        typeof raw.canonical_model_id === 'string' ? raw.canonical_model_id : id
      this.entries.push({
        id,
        canonical,
        aliases: Array.isArray(raw.aliases)
          ? raw.aliases.filter((v): v is string => typeof v === 'string')
          : [],
        type: String(type),
        provider,
        endpoint,
        values: values(raw),
      })
    }
    for (const [id, model] of Object.entries(models)) add(id, model)
    for (const [id, input] of Object.entries(providers)) {
      const provider = object(input)
      for (const [modelId, model] of Object.entries(object(provider.models)))
        add(modelId, model, id, typeof provider.api === 'string' ? provider.api : undefined)
    }
    if (!this.entries.length) throw new Error('Empty models.dev catalog')
  }

  resolve(input: RecommendationInput): RecommendationMatch {
    const entries = this.entries.filter((entry) => entry.type === input.modelType)
    const official = entries.filter((entry) => !entry.provider)
    const supplied = entries.filter((entry) => !!entry.provider)
    const trimmed = input.modelId.trim()
    if (!trimmed) return { status: 'unmatched', recommended: {} }
    const plain = trimmed.toLowerCase()
    const suffixless = withoutLevelSuffix(trimmed).toLowerCase()
    const attempts = suffixless !== plain ? [plain, suffixless] : [plain]
    for (const value of attempts) {
      const located = this.locate(value, official, supplied)
      if (located) return this.compose(located, input, official, supplied)
    }
    return { status: 'unmatched', recommended: {} }
  }

  private locate(
    value: string,
    official: readonly Entry[],
    supplied: readonly Entry[],
  ):
    | { official: readonly Entry[] }
    | { official: readonly Entry[]; provider: Entry }
    | undefined {
    // 1. 完整官方 ID 或官方目录显式别名优先。
    const exact = official.filter(
      (entry) =>
        entry.id.toLowerCase() === value ||
        entry.aliases.some((alias) => alias.toLowerCase() === value),
    )
    if (exact.length) return { official: exact }
    // 2. 已知目录供应商前缀 + 该供应商确有对应完整模型条目。
    const separator = value.indexOf('/')
    if (separator > 0) {
      const prefix = value.slice(0, separator)
      const name = value.slice(separator + 1)
      const providerEntry = supplied.find(
        (entry) => entry.provider!.toLowerCase() === prefix && entry.id.toLowerCase() === name,
      )
      if (providerEntry) return { official: [], provider: providerEntry }
      // 3. 其余前缀只是请求命名空间，只在官方目录匹配末段模型名与显式别名。
      const bareName = bare(value)
      const bareMatch = this.matchBare(bareName, official)
      if (bareMatch.length) return { official: bareMatch }
      return undefined
    }
    const bareMatch = this.matchBare(value, official)
    return bareMatch.length ? { official: bareMatch } : undefined
  }

  private matchBare(name: string, official: readonly Entry[]): readonly Entry[] {
    return official.filter(
      (entry) =>
        bare(entry.id) === name || entry.aliases.some((alias) => bare(alias) === name),
    )
  }

  private compose(
    located: { official: readonly Entry[]; provider?: Entry },
    input: RecommendationInput,
    official: readonly Entry[],
    supplied: readonly Entry[],
  ): RecommendationMatch {
    if (located.provider) {
      const entry = located.provider
      const identity = entry.canonical
      const base = official.filter(
        (candidate) => candidate.canonical.toLowerCase() === identity.toLowerCase(),
      )
      return this.finalize(
        { status: 'matched', recommended: { ...mergeValues(base), ...entry.values } },
        identity,
        'provider',
        input,
        entry,
      )
    }

    const families = new Map<string, { identity: string; entries: Entry[] }>()
    for (const entry of located.official) {
      const key = entry.canonical.toLowerCase()
      const family = families.get(key) ?? { identity: entry.canonical, entries: [] }
      family.entries.push(entry)
      families.set(key, family)
    }
    if (families.size > 1) {
      return {
        status: 'ambiguous',
        recommended: {},
        candidates: [...families.values()].map((family) => family.identity),
      }
    }
    const family = [...families.values()][0]
    if (!family) return { status: 'unmatched', recommended: {} }
    const identity = family.identity
    const key = identity.toLowerCase()
    const endpoint = normalizeEndpoint(input.baseUrl)
    const specific =
      supplied.find(
        (entry) =>
          entry.canonical.toLowerCase() === key &&
          !!input.providerId &&
          entry.provider!.toLowerCase() === input.providerId.toLowerCase(),
      ) ??
      (endpoint
        ? supplied.filter(
            (entry) =>
              entry.canonical.toLowerCase() === key &&
              normalizeEndpoint(entry.endpoint) === endpoint,
          )
        : [])[0]
    if (specific) {
      return this.finalize(
        {
          status: 'matched',
          recommended: { ...mergeValues(family.entries), ...specific.values },
        },
        identity,
        'provider',
        input,
        specific,
      )
    }
    return this.finalize(
      { status: 'matched', recommended: mergeValues(family.entries) },
      identity,
      'official',
      input,
    )
  }

  private finalize(
    match: { status: 'matched'; recommended: Model.Recommendation },
    identity: string,
    source: 'official' | 'provider',
    input: RecommendationInput,
    providerEntry?: Entry,
  ): RecommendationMatch {
    const owner = identity.split('/')[0]!.toLowerCase()
    const reference = this.entries.find(
      (entry) =>
        entry.type === input.modelType &&
        entry.provider?.toLowerCase() === owner &&
        entry.canonical.toLowerCase() === identity.toLowerCase() &&
        bare(entry.id) === bare(identity) &&
        entry.values.cost !== undefined,
    )
    const price = providerEntry?.values.cost ? providerEntry : reference
    const recommended = {
      ...match.recommended,
      ...(price ? { cost: price.values.cost } : {}),
    }
    const priceSource = price
      ? {
          kind: providerEntry === price ? 'provider' as const : 'reference' as const,
          providerId: price.provider!,
        }
      : undefined
    if (input.modelType === 'chat')
      return {
        status: 'matched', recommended, identity, source,
        ...(priceSource ? { priceSource } : {}),
      }
    const { maxTokens: _maxTokens, reasoning: _reasoning, ...rest } = recommended
    const {
      optionSpecs: _optionSpecs,
      reasoningLevels: _reasoningLevels,
      tools: _tools,
      ...nonChat
    } = rest
    return {
      status: 'matched', recommended: nonChat, identity, source,
      ...(priceSource ? { priceSource } : {}),
    }
  }
}
