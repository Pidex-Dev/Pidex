import { createAssistantMessageEventStream, type AssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { ModelPricingService } from '../ModelPricingService'
import type { ProviderFailure } from '@pidex/agent-protocol'
import { providerRequestError } from '../ProviderError'
import { ModelRecommendationStore } from './ModelRecommendationStore'
import {
  ProviderDirectoryStore,
  directoryBaseUrlKey,
  directoryProviderConfig,
  type DirectoryProvider,
} from './ProviderDirectoryStore'
import { applyRecommendation, type RecommendationInput } from './ModelRecommendations'
import {
  applyModelOptionMap,
  compileOptionSpecs,
  type CompiledOptionSpecs,
} from './PiModelOptionMapping'
import {
  resolveZCodeOptionSpecsDetailed,
  type ZCodeOptionResolution,
} from './ZCodeModelOptions'
import { AgentError } from '../../Domain'
import type { AgentLogger } from '../../observability/AgentLogger'
import { providerFailureCategory, providerFailureMessage } from '../ModelHealthService'
import {
  requestModelOperation,
  operationInputTokens,
  type ModelOperationOptions,
} from './PiModelOperations'
import type {
  Api,
  Model as PiModel,
  Models,
  ModelsStore,
  MutableModels,
  Provider as PiProvider,
} from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { Model, Provider } from '@pidex/model-schema'
import type { ProviderCredentialRepository } from '../../auth/ProviderCredentialRepository'
import {
  EncryptedCredentialStore,
  type EncryptedCredentialStoreOptions,
} from './EncryptedCredentialStore'
import {
  CUSTOM_PROVIDER_APIS,
  parsePiProviderCatalog,
  PI_PROVIDER_CONFIG_SCHEMA_VERSION,
  DEEPSEEK_PROVIDER_ID,
  DEFAULT_DEEPSEEK_PROTOCOL,
  resolveDeepSeekProtocol,
  type CustomProviderApi,
  type DeepSeekProtocol,
  type ParsedPiProviderCatalog,
  type PiCustomModelConfig,
  type PiModelCatalogConfig,
  type PiProviderConfig,
  type PiProviderConfigIssue,
  type PiProviderDefinitionInput,
} from './PiProviderConfig'
import { createPiDeepSeekProvider } from './PiDeepSeekProvider'
import { withPiOpenAIModelDiscovery } from './PiOpenAIModelDiscovery'
import { withPiBuiltinProviderOverrides } from './PiBuiltinProviderOverrides'
import {
  createPiCustomProvider,
  toPiModel,
  discoverOpenAIModels,
  type DiscoveredOpenAIModel,
} from './PiCustomProvider'

export interface PiModelServiceOptions extends EncryptedCredentialStoreOptions {
  readonly pricing?: ModelPricingService
  readonly logger?: Pick<AgentLogger, 'warn'>
  readonly recommendations?: ModelRecommendationStore
  readonly directory?: ProviderDirectoryStore
  readonly models?: Models
  readonly modelsStore?: ModelsStore
  readonly config?:
    PiModelCatalogConfig | (() => PiModelCatalogConfig | PromiseLike<PiModelCatalogConfig>)
  readonly env?: Readonly<Record<string, string | undefined>>
}

export class PiModelServiceError extends Error {
  constructor(
    readonly code:
      | 'CATALOG_REFRESH_FAILED'
      | 'PROVIDER_NOT_FOUND'
      | 'MODEL_NOT_FOUND'
      | 'VARIANT_NOT_FOUND'
      | 'PROVIDER_NOT_CONFIGURED'
      | 'DISPOSED',
    message: string,
    options?: ErrorOptions,
    readonly refreshFailures: readonly ProviderFailure[] = [],
  ) {
    super(message, options)
    this.name = 'PiModelServiceError'
  }
}

import { builtinProviderEndpoints } from './PiProviderConfig'

const clone = <T>(value: T): T => structuredClone(value)

const piProviderToInfo = (
  provider: PiProvider,
  kind: Provider.SourceKind,
  apis: readonly string[],
  disabled: boolean,
  configured?: PiProviderConfig,
  catalogOrigin: Provider.CatalogOrigin = 'pi-bundled',
): Provider.Info => ({
  id: Provider.ID.make(provider.id),
  name: provider.name,
  ...(disabled ? { disabled: true } : {}),
  source: {
    type: 'pi',
    kind,
    apis: [...new Set(apis)],
    ...(kind === 'builtin'
      ? {
          endpoints: builtinProviderEndpoints(provider.id),
          defaultApi:
            configured?.kind === 'builtin' && configured.protocol ? configured.protocol : apis[0],
        }
      : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  },
  catalogOrigin,
  availability: { status: 'ready' },
  auth: {
    apiKey:
      configured?.kind === 'custom'
        ? configured.auth === 'api-key'
        : provider.auth.apiKey !== undefined,
    oauth: provider.auth.oauth !== undefined,
  },
})

const cost = (model: PiModel<Api>): Model.Cost[] => [
  {
    input: model.cost.input,
    output: model.cost.output,
    cache: { read: model.cost.cacheRead, write: model.cost.cacheWrite },
  },
  ...(model.cost.tiers ?? []).map((tier) => ({
    tier: { type: 'context' as const, size: tier.inputTokensAbove },
    input: tier.input,
    output: tier.output,
    cache: { read: tier.cacheRead, write: tier.cacheWrite },
  })),
]

const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type ConfiguredPiModel = PiModel<Api> & {
  catalog?: Model.CatalogDetails
  maxInputTokens?: number
  inputExplicit?: boolean
  modelType?: 'chat' | 'embedding' | 'rerank'
  tools?: boolean
  /** 双层参数规格（仅 Pidex 内存模型携带，不进入 Pi 上游类型）。 */
  optionSpecs?: Model.OptionSpecs
}

const isChatModel = (model: PiModel<Api>) => {
  const kind = (model as ConfiguredPiModel).modelType
  return !kind || kind === 'chat'
}

/**
 * ZCode `.*` 兜底规则的产物：`values` 恰为 disabled/enabled 且 `map` 是空补丁
 * （不改写请求，交回 Pi 原生处理）。它是全局默认值，不是模型事实，
 * 只有在模型自身与推荐目录都没有更精确档位时才采用。
 */
const isGenericReasoningPlaceholder = (
  spec: Model.OptionSpecs['reasoningLevel'],
): boolean =>
  spec?.map === '{}' &&
  spec.values?.length === 2 &&
  spec.values[0] === 'disabled' &&
  spec.values[1] === 'enabled'

/** 模型在 Pi 目录里明确声明的档位（thinkingLevelMap 中非 null 的键），保持七档顺序。 */
const declaredThinkingValues = (
  reasoning: boolean,
  map: NonNullable<PiModel<Api>['thinkingLevelMap']> | undefined,
): readonly string[] =>
  reasoning && map ? thinkingLevels.filter((level) => map[level] != null) : []

/** 显式 values 优先；显式值域不是通用兜底占位时严格使用，不再回退固定七档。 */
const supportedThinkingLevels = (model: PiModel<Api>): readonly string[] => {
  if (!isChatModel(model)) return []
  const spec = (model as ConfiguredPiModel).optionSpecs?.reasoningLevel
  if (spec?.values?.length && !isGenericReasoningPlaceholder(spec)) return spec.values
  const declared = declaredThinkingValues(model.reasoning, model.thinkingLevelMap)
  if (declared.length) return declared
  if (spec?.values?.length) return spec.values
  return model.reasoning
    ? thinkingLevels.filter((level) => model.thinkingLevelMap?.[level] !== null)
    : []
}

/**
 * 档位值域优先级：推荐目录/上游明确值 → ZCode 模型专用规则 → 模型自身声明
 * → ZCode `.*` 兜底。兜底只是全局默认值，仅在别无信息时使用。
 */
const resolveReasoningValues = (
  recommendation: Model.Recommendation,
  zcode: ZCodeOptionResolution,
  declared: readonly string[],
): readonly string[] | undefined => {
  const explicit =
    recommendation.optionSpecs?.reasoningLevel?.values ?? recommendation.reasoningLevels
  if (explicit?.length) return explicit
  const specific = zcode.optionSpecs?.reasoningLevel?.values
  if (specific?.length && !zcode.genericReasoningValues) return specific
  if (declared.length) return declared
  return specific?.length ? specific : undefined
}

/**
 * 合成运行时规格：档位值域按优先级取一个来源，协议 `map` 与输出上限始终由
 * ZCode 规则补缺（map 是请求字段的唯一权威，与档位来源无关）。
 */
const composeOptionSpecs = (
  recommendation: Model.Recommendation,
  zcode: ZCodeOptionResolution,
  declared: readonly string[] = [],
): Model.OptionSpecs | undefined => {
  const values = resolveReasoningValues(recommendation, zcode, declared)
  const map =
    zcode.optionSpecs?.reasoningLevel?.map ?? recommendation.optionSpecs?.reasoningLevel?.map
  const maxOutputTokens =
    zcode.optionSpecs?.maxOutputTokens ?? recommendation.optionSpecs?.maxOutputTokens
  const reasoningLevel =
    values || map
      ? { ...(values ? { values } : {}), ...(map ? { map } : {}) }
      : undefined
  if (!reasoningLevel && !maxOutputTokens) return undefined
  return {
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  }
}

const effectiveInput = (model: PiModel<Api>): string[] => {
  const kind = (model as ConfiguredPiModel).modelType
  if (kind === 'embedding' || kind === 'rerank') return ['text']
  const gemini = model.api === 'google-generative-ai' || model.api === 'google-vertex'
  const nativeMedia =
    gemini && !(model as ConfiguredPiModel).inputExplicit && model.id.includes('gemini')
  return [...new Set<string>([...model.input, ...(nativeMedia ? ['audio', 'video'] : [])])].filter(
    (input) =>
      (input !== 'audio' || gemini || model.api === 'openai-completions') &&
      (input !== 'video' || gemini),
  )
}

const piModelToInfo = (model: PiModel<Api>, enabled: boolean, variant?: string): Model.Info => ({
  id: Model.ID.make(model.id),
  providerID: Provider.ID.make(model.provider),
  name: model.name,
  ...((model as ConfiguredPiModel).catalog ? { catalog: (model as ConfiguredPiModel).catalog } : {}),
  ...((model as ConfiguredPiModel).catalog?.family ? { family: Model.Family.make((model as ConfiguredPiModel).catalog!.family!) } : {}),
  ...((model as ConfiguredPiModel).modelType && (model as ConfiguredPiModel).modelType !== 'chat'
    ? { modelType: (model as ConfiguredPiModel).modelType! }
    : {}),
  api: {
    id: Model.ID.make(model.id),
    type: 'pi',
    name: model.api,
    baseUrl: model.baseUrl,
  },
  ...(variant ? { variant } : {}),
  capabilities: {
    tools:
      (!(model as ConfiguredPiModel).modelType ||
        (model as ConfiguredPiModel).modelType === 'chat') &&
      (model as ConfiguredPiModel).tools !== false,
    input: effectiveInput(model),
    output: [
      (model as ConfiguredPiModel).modelType === 'embedding'
        ? 'embedding'
        : (model as ConfiguredPiModel).modelType === 'rerank'
          ? 'rerank'
          : 'text',
    ],
  },
  variants: supportedThinkingLevels(model).map((level) => ({
    id: Model.VariantID.make(level),
  })),
  time: { released: Date.parse((model as ConfiguredPiModel).catalog?.releaseDate ?? '') || 0 },
  cost: cost(model),
  status: (model as ConfiguredPiModel).catalog?.status ?? 'active',
  enabled,
  limit: {
    context: model.contextWindow,
    ...((model as ConfiguredPiModel).maxInputTokens !== undefined
      ? { input: (model as ConfiguredPiModel).maxInputTokens! }
      : {}),
    output: model.maxTokens,
  },
})

export type ProviderDefinition = PiProviderDefinitionInput

/** provider/list baseline summary; the full baseline stays internal. */
export interface PiProviderModelSyncSummary {
  readonly fetchedAt: number
  readonly api: CustomProviderApi
  readonly modelCount: number
}

/** Pi-backed model catalog with the existing Pidex catalog shape. */
export class PiModelService {
  readonly recommendations: ModelRecommendationStore
  readonly directory: ProviderDirectoryStore
  readonly pi: Models
  private readonly mediaModels = new WeakMap<PiModel<Api>, PiModel<Api>>()
  readonly credentials: EncryptedCredentialStore
  private readonly mutablePi: MutableModels | undefined
  private readonly configSource: PiModelServiceOptions['config']
  private readonly baseProviders: ReadonlyMap<string, PiProvider>
  private directoryBaseProviders: ReadonlyMap<string, PiProvider> = new Map()
  private directoryEntries: readonly DirectoryProvider[] = []
  private readonly builtinProviderIDs: ReadonlySet<string>
  private configuredCustomProviderIDs = new Set<string>()
  private catalogVersion = 0
  private configFingerprint = ''
  private parsedConfig: ParsedPiProviderCatalog = {
    schemaVersion: PI_PROVIDER_CONFIG_SCHEMA_VERSION,
    providers: {},
    issues: [],
  }
  private syncOperation: Promise<ParsedPiProviderCatalog> = Promise.resolve(this.parsedConfig)
  private deepSeekProtocol:
    | {
        readonly protocol: DeepSeekProtocol
        readonly provider: PiProvider
        readonly source: PiProvider
      }
    | undefined
  private disposed = false
  /** 按 Pi 模型对象缓存编译后的 option map；配置同步重建模型对象时自动失效。 */
  private readonly optionMapCompiled = new WeakMap<object, CompiledOptionSpecs | null>()

  constructor(
    repository: ProviderCredentialRepository,
    private readonly options: PiModelServiceOptions = {},
  ) {
    this.recommendations = options.recommendations ?? new ModelRecommendationStore()
    this.directory = options.directory ?? new ProviderDirectoryStore()
    this.credentials = new EncryptedCredentialStore(repository, options)
    this.pi =
      options.models ??
      builtinModels({
        credentials: this.credentials,
        ...(options.modelsStore ? { modelsStore: options.modelsStore } : {}),
        authContext: {
          env: async (name) => options.env?.[name] ?? process.env[name],
          // Pidex intentionally does not let Pi discover auth files.
          fileExists: async () => false,
        },
      })
    this.mutablePi = isMutableModels(this.pi) ? this.pi : undefined
    for (const provider of this.pi.getProviders()) {
      const discovered = withPiOpenAIModelDiscovery(
        provider,
        (signal) => this.pi.getAuth(provider.id, { signal }),
        () => {
          const config = this.parsedConfig.providers[provider.id]
          return config?.kind === 'builtin'
            ? (config.baseUrl ?? provider.baseUrl)
            : provider.baseUrl
        },
      )
      if (discovered !== provider) this.mutablePi?.setProvider(discovered)
    }
    this.baseProviders = new Map(this.pi.getProviders().map((provider) => [provider.id, provider]))
    this.builtinProviderIDs = new Set(this.pi.getProviders().map((provider) => provider.id))
    this.installOptionMapBoundary()
    this.configSource = options.config
    options.recommendations?.startAutoRefresh()
  }

  async list(): Promise<readonly Provider.Info[]> {
    this.assertActive()
    const config = await this.syncProviders()
    const directory = new Map(this.directoryEntries.map((entry) => [entry.id, entry]))
    const configuredIDs = new Set(Object.keys((await this.rawConfig()).providers ?? {}))
    const saved = new Set(configuredIDs)
    for (const credential of await this.credentials.list()) saved.add(credential.providerId)
    const providers = this.pi
      .getProviders()
      .map((provider) => {
        const configured = config.providers[provider.id]
        const entry = directory.get(provider.id)
        const userCustom =
          configured?.kind === 'custom' &&
          !configured.directorySource &&
          configuredIDs.has(provider.id)
        const kind = userCustom ? 'custom' : 'builtin'
        const origin: Provider.CatalogOrigin = userCustom
          ? 'user'
          : ((configured?.kind === 'custom' ? configured.directorySource : undefined) ??
            entry?.origin ??
            'pi-bundled')
        const info = piProviderToInfo(
          provider,
          kind,
          this.pi.getModels(provider.id).map((model) => model.api),
          !this.providerEnabled(provider.id, config),
          configured,
          origin,
        )
        directory.delete(provider.id)
        const defaultApi =
          configured?.kind === 'builtin' && configured.protocol
            ? configured.protocol
            : configured?.kind === 'custom'
              ? (Object.keys(configured.endpoints ?? {})[0] ??
                Object.values(configured.models)[0]?.api ??
                entry?.api)
              : (entry?.api ?? info.source.apis[0])
        return kind === 'builtin' && entry
          ? {
              ...info,
              name: configured?.kind === 'custom' ? configured.name : entry.name,
              source: {
                ...info.source,
                ...(defaultApi ? { defaultApi } : {}),
                ...(entry.baseUrl
                  ? {
                      endpoints: {
                        ...info.source.endpoints,
                        ...entry.endpoints,
                        ...(defaultApi
                          ? { [defaultApi]: configured?.baseUrl ?? entry.baseUrl }
                          : {}),
                        ...configured?.endpoints,
                      },
                    }
                  : {}),
              },
            }
          : info
      })
      .map(clone)
    const candidates: Provider.Info[] = [
      ...providers,
      ...[...directory.values()].map((entry): Provider.Info => ({
        ...Provider.Info.empty(Provider.ID.make(entry.id)),
        name: entry.name,
        catalogOrigin: entry.origin,
        source: {
          type: 'pi',
          kind: 'builtin',
          apis: [],
          ...(entry.api ? { defaultApi: entry.api } : {}),
          ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
        },
        auth: { apiKey: true, oauth: false },
        availability: {
          status: 'unavailable',
          reason: entry.api ? 'unresolved-endpoint' : 'missing-api',
        },
      })),
    ]
    const keys = new Set<string>()
    return candidates
      .sort(
        (a, b) =>
          Number(saved.has(String(b.id))) - Number(saved.has(String(a.id))) ||
          Number(!this.builtinProviderIDs.has(String(a.id))) -
            Number(!this.builtinProviderIDs.has(String(b.id))) ||
          Number(a.catalogOrigin === 'models-dev') - Number(b.catalogOrigin === 'models-dev') ||
          String(a.id).localeCompare(String(b.id)),
      )
      .filter((provider) => {
        if (provider.catalogOrigin === 'user') return true
        const api = provider.source.defaultApi
        const key = directoryBaseUrlKey(
          (api ? provider.source.endpoints?.[api] : undefined) ?? provider.source.baseUrl,
        )
        if (!key) return true
        if (saved.has(String(provider.id))) {
          keys.add(key)
          return true
        }
        if (keys.has(key)) return false
        keys.add(key)
        return true
      })
  }

  async isAuthConfigured(providerID: string): Promise<boolean> {
    this.assertActive()
    await this.syncProviders()
    const provider = this.pi.getProviders().find((candidate) => candidate.id === providerID)
    if (!provider) return false
    if (!provider.auth.apiKey && !provider.auth.oauth) return true
    return (await this.pi.checkAuth(providerID)) !== undefined
  }

  async providerDefinitions(): Promise<readonly ProviderDefinition[]> {
    this.assertActive()
    const config = await this.syncProviders()
    const definitions = this.pi.getProviders().map((provider): ProviderDefinition => {
      const configured = config.providers[provider.id]
      if (configured?.kind === 'custom') {
        return {
          kind: 'custom',
          id: provider.id,
          name: configured.name,
          ...(configured.directorySource ? { directorySource: configured.directorySource } : {}),
          enabled: configured.enabled,
          baseUrl: configured.baseUrl,
          ...(configured.endpoints ? { endpoints: configured.endpoints } : {}),
          auth: configured.auth,
          env: [...configured.env],
          allowInsecureHttp: configured.allowInsecureHttp,
          headers: { ...configured.headers },
          models: Object.values(configured.models).map((model) => ({
            id: model.id,
            api: model.api,
            name: model.name,
            ...(model.group !== undefined ? { group: model.group } : {}),
            enabled: model.enabled,
            contextWindow: model.contextWindow,
            ...(model.maxInputTokens !== undefined ? { maxInputTokens: model.maxInputTokens } : {}),
            maxTokens: model.maxTokens,
            ...(model.modelType ? { modelType: model.modelType } : {}),
            ...(model.tools !== undefined ? { tools: model.tools } : {}),
            reasoning: model.reasoning,
            input: [...model.input],
            ...(model.pricing ? { pricing: model.pricing } : {}),
            cost: { ...model.cost },
            ...(Object.keys(model.headers).length ? { headers: { ...model.headers } } : {}),
            ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
            ...(model.compat ? { compat: structuredClone(model.compat) } : {}),
            ...(model.smartConfig
              ? { smartConfig: structuredClone(model.smartConfig) }
              : {}),
            ...(model.optionSpecs ? { optionSpecs: structuredClone(model.optionSpecs) } : {}),
          })),
        }
      }
      const builtin = configured?.kind === 'builtin' ? configured : undefined
      return {
        kind: 'builtin',
        id: provider.id,
        enabled: builtin?.enabled ?? true,
        allowModels: [...(builtin?.allowModels ?? [])],
        denyModels: [...(builtin?.denyModels ?? [])],
        models: Object.entries(builtin?.models ?? {}).map(([id, model]) => ({
          id,
          ...model,
        })),
        ...(builtin?.endpoints ? { endpoints: builtin.endpoints } : {}),
        ...(builtin?.baseUrl ? { baseUrl: builtin.baseUrl } : {}),
        ...(builtin?.allowInsecureHttp !== undefined
          ? { allowInsecureHttp: builtin.allowInsecureHttp }
          : {}),
        ...(builtin?.protocol ? { protocol: builtin.protocol } : {}),
      }
    })
    return definitions.map(clone)
  }

  async discoverBuiltinModels(providerID: string) {
    const config = await this.syncProviders()
    if (!this.builtinProviderIDs.has(providerID) || config.providers[providerID]?.kind === 'custom')
      throw new AgentError('PROVIDER_NOT_FOUND', '内置供应商不存在', 404)
    return Promise.all(this.pi.getModels(providerID).map(async (original) => {
      const model = await this.withCatalog(original)
      const input = effectiveInput(model)
      return {
        ...(model.catalog ? { catalog: model.catalog } : {}),
        id: model.id,
        name: model.name,
        api: (CUSTOM_PROVIDER_APIS as readonly string[]).includes(model.api)
          ? model.api as CustomProviderApi : 'openai-completions' as const,
        enabled: false,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        tools: piModelToInfo(model, false).capabilities.tools,
        ...(input.length ? { input } : {}),
        cost: model.cost,
      }
    }))
  }

  async models(providerID?: Provider.ID): Promise<readonly Model.Info[]> {
    this.assertActive()
    const config = await this.syncProviders()
    const available = new Set(
      (await this.pi.getAvailable(providerID ? String(providerID) : undefined)).map(
        (model) => `${model.provider}/${model.id}`,
      ),
    )
    return Promise.all(this.pi
      .getModels(providerID ? String(providerID) : undefined)
      .filter((model) => this.modelEnabled(model, config))
      .map(async (model) => clone(piModelToInfo(await this.withCatalog(model), available.has(`${model.provider}/${model.id}`)))))
  }

  async resolve(ref: Model.Ref): Promise<Model.Info> {
    const model = await this.getPiModel(ref)
    const auth = await this.pi.checkAuth(model.provider)
    const variant = ref.variant ? String(ref.variant) : supportedThinkingLevels(model)[0]
    return clone(piModelToInfo(model, auth !== undefined, variant))
  }

  private async withCatalog(model: PiModel<Api>): Promise<ConfiguredPiModel> {
    const { recommended } = await this.recommendations.resolve({
      providerId: model.provider, modelId: model.id, baseUrl: model.baseUrl,
      modelType: (model as ConfiguredPiModel).modelType ?? 'chat',
    })
    return recommended.catalog ? { ...model, catalog: recommended.catalog } : model
  }

  async getPiModel(ref: Model.Ref): Promise<PiModel<Api>> {
    this.assertActive()
    const config = await this.syncProviders()
    const providerID = String(ref.providerID)
    const modelID = String(ref.id)
    if (!this.providerEnabled(providerID, config)) {
      throw new PiModelServiceError('PROVIDER_NOT_FOUND', `Provider ${providerID} was not found`)
    }
    const found = this.pi.getModel(providerID, modelID)
    const model = found ? await this.withCatalog(found) : undefined
    if (!model || !this.modelEnabled(model, config)) {
      throw new PiModelServiceError(
        'MODEL_NOT_FOUND',
        `Model ${providerID}/${modelID} was not found`,
      )
    }
    if (ref.variant && !supportedThinkingLevels(model).includes(String(ref.variant))) {
      throw new PiModelServiceError(
        'VARIANT_NOT_FOUND',
        `Variant ${providerID}/${modelID}/${ref.variant} was not found`,
      )
    }
    const auth = await this.pi.checkAuth(providerID)
    if (!auth)
      throw new PiModelServiceError(
        'PROVIDER_NOT_CONFIGURED',
        `Provider ${providerID} is not configured`,
      )
    const input = effectiveInput(model)
    if (
      input.length === model.input.length &&
      input.every((kind, index) => kind === model.input[index])
    )
      return model
    let extended = this.mediaModels.get(model)
    if (!extended) {
      extended = { ...model, input: input as PiModel<Api>['input'] }
      this.mediaModels.set(model, extended)
    }
    return extended
  }

  private async operationRequest(
    ref: Model.Ref,
    kind: 'embedding' | 'rerank',
    body: Record<string, unknown>,
    options: ModelOperationOptions,
  ) {
    const model = (await this.getPiModel(ref)) as ConfiguredPiModel & { maxInputTokens?: number }
    if (model.modelType !== kind)
      throw new AgentError('INVALID_REQUEST', '模型类型与请求操作不匹配', 400)
    const texts =
      kind === 'embedding'
        ? (body.input as string[])
        : [String(body.query), ...(body.documents as string[])]
    if (
      texts.some(
        (text) =>
          new TextEncoder().encode(text).length / 4 > (model.maxInputTokens ?? model.contextWindow),
      )
    )
      throw new AgentError('INVALID_REQUEST', '输入超过模型最大输入 Token 预算', 400)
    const config = (await this.syncProviders()).providers[model.provider]
    const endpointKey = kind === 'embedding' ? 'openai-embeddings' : 'jina-rerank'
    const explicitEndpoint = config?.endpoints?.[endpointKey]
    if (!explicitEndpoint && !['openai-completions', 'openai-responses'].includes(model.api))
      throw new AgentError('INVALID_REQUEST', '请先为该模型类型添加对应端点', 400)
    const base = explicitEndpoint ?? model.baseUrl
    const suffix = kind === 'embedding' ? '/embeddings' : '/rerank'
    const endpoint = base.replace(/\/$/, '').endsWith(suffix)
      ? base
      : `${base.replace(/\/$/, '')}${suffix}`
    const auth = await this.pi.getAuth(model.provider)
    const headers = new Headers({
      ...(config?.kind === 'custom' ? config.headers : {}),
      ...model.headers,
    })
    for (const [key, value] of Object.entries(auth?.auth.headers ?? {}))
      if (typeof value === 'string') headers.set(key, value)
    const apiKey = options.apiKey ?? auth?.auth.apiKey
    if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`)
    headers.set('Content-Type', 'application/json')
    return requestModelOperation(endpoint, headers, { ...body, model: model.id }, options)
  }

  async embed(
    ref: Model.Ref,
    input: readonly string[],
    dimensions?: number,
    options: ModelOperationOptions = {},
  ) {
    const result = await this.operationRequest(
      ref,
      'embedding',
      { input, ...(dimensions ? { dimensions } : {}) },
      options,
    )
    const data = result.data
    if (!Array.isArray(data) || data.length !== input.length)
      throw new AgentError('PROVIDER_UNAVAILABLE', '嵌入响应数量无效', 502)
    const vectors: number[][] = new Array(input.length)
    for (const item of data) {
      if (
        !item ||
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= input.length ||
        vectors[item.index] ||
        !Array.isArray(item.embedding) ||
        !item.embedding.length ||
        !item.embedding.every(
          (value: unknown) => typeof value === 'number' && Number.isFinite(value),
        )
      )
        throw new AgentError('PROVIDER_UNAVAILABLE', '嵌入响应格式无效', 502)
      vectors[item.index] = item.embedding
    }
    const dimension = dimensions ?? vectors[0]!.length
    if (vectors.some((vector) => vector.length !== dimension))
      throw new AgentError('PROVIDER_UNAVAILABLE', '嵌入向量维度不一致', 502)
    return { vectors, inputTokens: operationInputTokens(result) }
  }

  async rerank(
    ref: Model.Ref,
    query: string,
    documents: readonly string[],
    topN?: number,
    options: ModelOperationOptions = {},
  ) {
    if (topN !== undefined && topN > documents.length)
      throw new AgentError('INVALID_REQUEST', '重排数量不能超过文档数量', 400)
    const result = await this.operationRequest(
      ref,
      'rerank',
      { query, documents, ...(topN ? { top_n: topN } : {}) },
      options,
    )
    if (!Array.isArray(result.results) || result.results.length > (topN ?? documents.length))
      throw new AgentError('PROVIDER_UNAVAILABLE', '重排响应数量无效', 502)
    const indices = new Set<number>()
    const results = result.results.map((item) => {
      if (
        !item ||
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= documents.length ||
        indices.has(item.index) ||
        typeof item.relevance_score !== 'number' ||
        !Number.isFinite(item.relevance_score)
      )
        throw new AgentError('PROVIDER_UNAVAILABLE', '重排响应格式无效', 502)
      indices.add(item.index)
      return { index: item.index as number, score: item.relevance_score as number }
    })
    return { results, inputTokens: operationInputTokens(result) }
  }

  async refresh(force: boolean, providerID: string): Promise<void> {
    this.assertActive()
    const config = await this.syncProviders()
    if (!this.pi.getProviders().some((provider) => provider.id === providerID)) {
      throw new AgentError('INVALID_REQUEST', '供应商不存在', 400)
    }
    const result = await this.pi.refresh({
      allowNetwork: true,
      force,
      providers: this.pi
        .getProviders()
        .filter(
          (provider) => provider.id === providerID && this.providerEnabled(provider.id, config),
        )
        .map((provider) => provider.id),
    })
    if (result.errors.size > 0) {
      const failures = [...result.errors].map(([provider, error]) => {
        const httpStatus = /\bHTTP (\d{3})\b/.exec(error.message)?.[1]
        const category = providerFailureCategory(
          httpStatus ? { status: Number(httpStatus) } : error,
        )
        const discoveryReason = new Map([
          ['Model discovery response exceeds 1 MiB', '模型列表响应超过 1 MiB'],
          ['Model discovery returned no body', '模型列表响应为空'],
          ['Model discovery returned an invalid OpenAI catalog', '模型列表响应格式无效'],
          ['Provider credentials are unavailable for model discovery', '模型发现凭据不可用'],
        ]).get(error.message)
        const reason = `${discoveryReason ?? providerFailureMessage(category, 'request')}${httpStatus ? `（HTTP ${httpStatus}）` : ''}`
        this.options.logger?.warn('provider.catalog.refresh.failed', { provider, category, reason })
        const failure = providerRequestError(error, provider)
        return { providerId: provider, code: failure.code as ProviderFailure['code'], retryable: failure.retryable, ...(httpStatus ? { httpStatus: Number(httpStatus) } : {}) }
      })
      throw new PiModelServiceError(
        'CATALOG_REFRESH_FAILED',
        'Failed to refresh one or more Pi providers',
        {
          cause: new AggregateError(result.errors.values()),
        },
        failures,
      )
    }
    this.catalogVersion += 1
  }

  async refreshModelPricing(force = true, year?: number) {
    if (!this.options.pricing) throw new AgentError('PROVIDER_UNAVAILABLE', '计费资料服务暂不可用。', 503)
    return this.options.pricing.refresh(force, year)
  }

  async reload(): Promise<void> {
    this.assertActive()
    await this.syncProviders()
    await this.pi.refresh({ allowNetwork: false })
    this.catalogVersion += 1
  }

  async refreshDirectory(): Promise<void> {
    this.assertActive()
    try {
      await this.directory.refresh()
    } catch (cause) {
      this.options.logger?.warn('provider.directory.refresh.failed', {
        reason: cause instanceof AgentError ? cause.message : 'DIRECTORY_CACHE_UNAVAILABLE',
      })
      if (cause instanceof AgentError) throw cause
      throw new AgentError(
        'PROVIDER_UNAVAILABLE',
        '供应商目录更新失败，已保留现有目录，请稍后重试。',
        502,
      )
    }
    await this.reload()
  }

  getModel(ref: Model.Ref): Promise<PiModel<Api>> {
    return this.getPiModel(ref)
  }

  catalogRevision(): number {
    return this.catalogVersion
  }

  async discoverModels(
    providerID: string,
    options: {
      readonly signal?: AbortSignal
      readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    } = {},
  ): Promise<readonly DiscoveredOpenAIModel[]> {
    const config = await this.syncProviders()
    const provider = config.providers[providerID]
    if (!provider || provider.kind !== 'custom' || !provider.enabled) {
      throw new PiModelServiceError(
        'PROVIDER_NOT_FOUND',
        `Custom provider ${providerID} was not found`,
      )
    }
    if (
      !Object.values(provider.models).some(
        (model) => model.api === 'openai-completions' || model.api === 'openai-responses',
      )
    ) {
      throw new PiModelServiceError(
        'PROVIDER_NOT_CONFIGURED',
        `Provider ${providerID} does not use an OpenAI-compatible API`,
      )
    }
    const auth = await this.pi.getAuth(providerID)
    if (provider.auth === 'api-key' && !auth) {
      throw new PiModelServiceError(
        'PROVIDER_NOT_CONFIGURED',
        `Provider ${providerID} is not configured`,
      )
    }
    return discoverOpenAIModels({
      baseUrl: provider.baseUrl,
      headers: {
        ...provider.headers,
        ...Object.fromEntries(
          Object.entries(auth?.auth.headers ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
      },
      ...(auth?.auth.apiKey ? { apiKey: auth.auth.apiKey } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
  }

  async configIssues(): Promise<readonly PiProviderConfigIssue[]> {
    return [...(await this.syncProviders()).issues]
  }

  async catalogConfig(): Promise<ParsedPiProviderCatalog> {
    return structuredClone(await this.syncProviders())
  }

  /** Bounded provider/list summary of the saved upstream baseline. */
  async modelSyncSummary(providerID: string): Promise<PiProviderModelSyncSummary | undefined> {
    const provider = (await this.syncProviders()).providers[providerID]
    if (provider?.kind !== 'custom' || !provider.modelSync) return undefined
    return {
      fetchedAt: provider.modelSync.fetchedAt,
      api: provider.modelSync.api,
      modelCount: provider.modelSync.models.length,
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.recommendations.dispose()
  }

  async previewRecommendation(input: RecommendationInput) {
    const resolved = await this.recommendations.resolve(input)
    // 预览阶段通常没有协议的精确 api，仅用通用层规则贡献思考 values/map。
    const zcode = resolveZCodeOptionSpecsDetailed({
      modelId: input.modelId,
      api: '',
      baseUrl: input.baseUrl,
    })
    const optionSpecs = composeOptionSpecs(resolved.recommended, zcode)
    if (!optionSpecs) return resolved
    return {
      ...resolved,
      recommended: { ...resolved.recommended, optionSpecs },
    }
  }

  refreshRecommendations() {
    return this.recommendations.refresh()
  }

  private async rawConfig(): Promise<PiModelCatalogConfig> {
    return typeof this.configSource === 'function'
      ? await this.configSource()
      : (this.configSource ?? {})
  }

  /**
   * 运行时合成：已启用智能配置的模型，用当前推荐值覆盖全部推荐字段。
   * 只作用于交给 Pi 的运行时配置；`parsedConfig` 仍保存用户原始值，
   * 否则 UI 读到的推荐值会被当成用户值回写并永久固定。
   */
  private async applyRecommendations(
    providerID: string,
    provider: Extract<PiProviderConfig, { kind: 'custom' }>,
  ): Promise<Extract<PiProviderConfig, { kind: 'custom' }>> {
    if (!Object.values(provider.models).some((model) => model.smartConfig)) return provider
    const models: Record<string, PiCustomModelConfig> = {}
    for (const [id, model] of Object.entries(provider.models)) {
      // 旧版逐字段固定配置按整份手动配置保留，重新采用推荐后切换自动模式。
      if (!model.smartConfig || model.smartConfig.enabled === false || model.smartConfig.pinned.length > 0) {
        models[id] = model
        continue
      }
      const baseUrl = (model.api && provider.endpoints?.[model.api]) || provider.baseUrl
      const { recommended: baseRecommended } = await this.recommendations.resolve({
        providerId: providerID,
        baseUrl,
        modelId: model.id,
        modelType: model.modelType ?? 'chat',
      })
      // 档位值域按“推荐 → ZCode 专用规则 → 模型自身声明 → 通用兜底”取值，
      // 协议 map 继续由静态规则补齐。
      const zcode = resolveZCodeOptionSpecsDetailed({ modelId: model.id, api: model.api, baseUrl })
      const recommended = {
        ...baseRecommended,
        optionSpecs: composeOptionSpecs(
          baseRecommended,
          zcode,
          declaredThinkingValues(model.reasoning, model.thinkingLevelMap),
        ),
      }
      const document = model.smartConfig.source === 'document' ? model.smartConfig.document?.data : undefined
      const applied = applyRecommendation(applyRecommendation(model, recommended), document ?? {})
      if (document?.pricing) (applied as { pricing?: Model.Pricing }).pricing = document.pricing
      models[id] = applied
    }
    return { ...provider, models }
  }

  /**
   * 在 `Models` 单一出口处组合协议 map：聊天、非流式（completeSimple 走 streamSimple）、
   * 模型测试都消费同一个 pi 实例，因此这一处接线覆盖所有请求路径。
   * 显式 reasoningLevel map 存在时，抑制 pi 固定 reasoning 枚举，避免把任意 values
   * 塞进 Pi 的 ThinkingLevel；由 map 成为请求字段的唯一权威。
   */
  private installOptionMapBoundary(): void {
    const pi = this.pi as unknown as {
      streamSimple?: (model: unknown, context: unknown, options?: unknown) => unknown
    }
    if (typeof pi.streamSimple !== 'function') return
    const original = pi.streamSimple.bind(this.pi)
    try {
      pi.streamSimple = (model: unknown, context: unknown, options?: unknown) => {
        const priced = model && typeof model === 'object' ? this.options.pricing?.begin(model as PiModel<Api>) : undefined
        const requestModel = priced?.model ?? model
        const dispatch = (m: unknown, c: unknown, o?: unknown) => {
          const source = original(m === model ? requestModel : m, c, o) as AssistantMessageEventStream
          if (!priced) return source
          const result = createAssistantMessageEventStream()
          void (async () => {
            try {
              for await (const event of source) {
                priced.annotate(event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial)
                result.push(event)
              }
              result.end()
            } catch {
              const error = { role: 'assistant' as const, content: [], api: (requestModel as PiModel<Api>).api, provider: (requestModel as PiModel<Api>).provider, model: (requestModel as PiModel<Api>).id, timestamp: Date.now(), stopReason: 'error' as const, errorMessage: '模型响应流未能完成，请重试。', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
              priced.annotate(error)
              result.push({ type: 'error', reason: 'error', error })
              result.end()
            }
          })().catch(() => undefined)
          return result
        }
        if ((model as ConfiguredPiModel | undefined)?.catalog?.temperature === false && options && typeof options === 'object') {
          const { temperature: _temperature, ...rest } = options as Record<string, unknown>
          options = rest
        }
        const compiled =
          model && typeof model === 'object' ? this.compiledOptionMap(model as object) : null
        if (!compiled) {
          const catalog = (model as ConfiguredPiModel | undefined)?.catalog
          if (catalog?.reasoningOptions?.some((option) => option.type === 'toggle') && options && typeof options === 'object') {
            const opts = { ...options } as Record<string, unknown>
            if (opts.reasoning === 'disabled') delete opts.reasoning
            else if (opts.reasoning === 'enabled') opts.reasoning = 'medium'
            return dispatch(model, context, opts)
          }
          return dispatch(model, context, options)
        }
        const opts = (options && typeof options === 'object' ? options : {}) as Record<
          string,
          unknown
        >
        const reasoningLevel = typeof opts.reasoning === 'string' ? opts.reasoning : undefined
        const maxOutputTokens =
          typeof opts.maxTokens === 'number'
            ? opts.maxTokens
            : (model as { maxTokens?: number }).maxTokens
        const previous =
          typeof opts.onPayload === 'function'
            ? (opts.onPayload as (p: unknown, m: unknown) => unknown)
            : undefined
        const next: Record<string, unknown> = { ...opts }
        // 显式 reasoning values 不再交给 Pi 的固定枚举处理。
        if (compiled.reasoningLevel) delete next.reasoning
        next.onPayload = async (payload: unknown, target: unknown) => {
          const resolved = previous ? ((await previous(payload, target)) ?? payload) : payload
          try {
            return applyModelOptionMap(resolved, compiled, { reasoningLevel, maxOutputTokens })
          } catch {
            return resolved
          }
        }
        return dispatch(model, context, next)
      }
    } catch {
      /* 只读或冻结的 Models 实例保持原样；不影响其余行为 */
    }
  }

  private compiledOptionMap(model: object): CompiledOptionSpecs | null {
    if (this.optionMapCompiled.has(model)) return this.optionMapCompiled.get(model) ?? null
    const specs = (model as { optionSpecs?: Model.OptionSpecs }).optionSpecs
    let compiled: CompiledOptionSpecs | null = null
    if (specs) {
      try {
        compiled = compileOptionSpecs(specs) ?? null
      } catch {
        compiled = null
      }
    }
    this.optionMapCompiled.set(model, compiled)
    return compiled
  }

  private syncProviders(force = false): Promise<ParsedPiProviderCatalog> {
    const operation = async () => {
      const raw = await this.rawConfig()
      const entries = await this.directory.providers()
      // 推荐目录更新后必须重新合成，否则已保存模型会停在旧推荐值上。
      const fingerprint = JSON.stringify([raw, await this.recommendations.version()])
      if (!force && fingerprint === this.configFingerprint && entries === this.directoryEntries)
        return this.parsedConfig
      let parsed = parsePiProviderCatalog(raw)
      this.directoryEntries = entries
      const defaults = new Map(entries.map((entry) => [entry.id, directoryProviderConfig(entry)]))
      if (parsed.schemaVersion <= PI_PROVIDER_CONFIG_SCHEMA_VERSION) {
        const providers = { ...parsed.providers }
        for (const [id, config] of defaults) {
          if (
            config &&
            !this.builtinProviderIDs.has(id) &&
            !Object.hasOwn(raw.providers ?? {}, id)
          ) {
            providers[id] = {
              ...config,
              models: {},
              directorySource: entries.find((entry) => entry.id === id)!.origin,
            }
          }
          if (config && this.builtinProviderIDs.has(id)) {
            const existing = providers[id]
            const bundledModels = new Set(
              this.baseProviders
                .get(id)!
                .getModels()
                .map((model) => model.id),
            )
            const disabled = Object.fromEntries(
              Object.keys(config.models)
                .filter((modelID) => !bundledModels.has(modelID))
                .map((modelID) => [modelID, { enabled: false }]),
            )
            if (Object.keys(disabled).length && (!existing || existing.kind === 'builtin')) {
              providers[id] = {
                kind: 'builtin',
                enabled: true,
                allowModels: [],
                denyModels: [],
                ...existing,
                models: { ...disabled, ...existing?.models },
              }
            }
          }
        }
        parsed = { ...parsed, providers }
      }
      this.directoryBaseProviders = new Map(
        [...this.baseProviders].map(([id, base]) => {
          const config = defaults.get(id)
          if (!config) return [id, base]
          const entry = entries.find((candidate) => candidate.id === id)
          const apis = new Set(base.getModels().map((model) => model.api))
          const remoteModels = new Map<string, PiModel<Api>>()
          for (const model of Object.values(config.models)) {
            if (apis.has(model.api))
              remoteModels.set(model.id, {
                ...toPiModel(id, config, model),
                baseUrl:
                  entry?.modelBaseUrls?.[model.id] ??
                  config.endpoints?.[model.api] ??
                  config.baseUrl,
              })
          }
          const getModels = () => {
            const models = new Map(base.getModels().map((model) => [model.id, model]))
            for (const [modelID, model] of remoteModels) models.set(modelID, model)
            return [...models.values()]
          }
          return [
            id,
            {
              ...base,
              getModels,
              getAllModels: () => [
                ...(base.getAllModels?.() ?? []).filter(
                  (model) => model.type !== undefined && model.type !== 'chat',
                ),
                ...getModels(),
              ],
            },
          ]
        }),
      )
      const custom = Object.entries(parsed.providers).filter(
        (entry): entry is [string, Extract<(typeof entry)[1], { kind: 'custom' }>] =>
          entry[1].kind === 'custom',
      )
      if (custom.length > 0 && !this.mutablePi) {
        throw new PiModelServiceError(
          'CATALOG_REFRESH_FAILED',
          'The configured Pi Models collection is not mutable',
        )
      }
      for (const providerID of this.configuredCustomProviderIDs) {
        this.mutablePi?.deleteProvider(providerID)
      }
      const nextCustomProviderIDs = new Set<string>()
      for (const [providerID, provider] of custom) {
        this.mutablePi?.setProvider(
          createPiCustomProvider(providerID, await this.applyRecommendations(providerID, provider)),
        )
        nextCustomProviderIDs.add(providerID)
      }
      this.configuredCustomProviderIDs = nextCustomProviderIDs
      this.applyProviderProtocolOverride(parsed)
      for (const [id, base] of this.directoryBaseProviders) {
        const configured = parsed.providers[id]
        if (id === DEEPSEEK_PROVIDER_ID && parsed.issues.some((issue) => issue.providerID === id))
          continue
        const source =
          id === DEEPSEEK_PROVIDER_ID ? (this.deepSeekProtocol?.provider ?? base) : base
        let runtimeConfig = configured
        if (configured?.kind === 'builtin') {
          const models = { ...configured.models }
          for (const [modelID, override] of Object.entries(models)) {
            if (!override.enabled || (override.optionSpecs && !override.smartConfig) || override.smartConfig?.pinned.length || override.smartConfig?.enabled === false) continue
            const native = source.getModels().find((model) => model.id === modelID)
            if (!native) continue
            const api = override.api ?? configured.protocol ?? native.api
            const baseUrl = configured.endpoints?.[api as CustomProviderApi] ?? configured.baseUrl ?? native.baseUrl
            const { recommended } = await this.recommendations.resolve({ providerId: id, modelId: modelID, modelType: 'chat', baseUrl })
            if (override.smartConfig) {
              const document = override.smartConfig.source === 'document' ? override.smartConfig.document?.data : undefined
              const composed = applyRecommendation(applyRecommendation({ ...native, ...override, input: [...(override.input ?? native.input)] as PiCustomModelConfig['input'], cost: { ...native.cost, ...override.cost } }, recommended), document ?? {})
              const { pricing: _pricing, ...baseOverride } = override
              models[modelID] = { ...baseOverride, name: composed.name, contextWindow: composed.contextWindow, maxTokens: composed.maxTokens, reasoning: composed.reasoning, input: composed.input, cost: composed.cost,
                ...(composed.maxInputTokens !== undefined ? { maxInputTokens: composed.maxInputTokens } : {}),
                ...(composed.tools !== undefined ? { tools: composed.tools } : {}),
                ...(composed.modelType !== undefined ? { modelType: composed.modelType } : {}),
                ...(composed.optionSpecs ? { optionSpecs: composed.optionSpecs } : {}),
                ...(composed.pricing ? { pricing: composed.pricing } : {}),
              }
              continue
            }
            // 内置模型只在推荐目录给出档位时才改写；其自身 declaration 已由 Pi 目录驱动。
            if (!recommended.optionSpecs?.reasoningLevel?.values?.length && !recommended.reasoningLevels?.length && !(override.smartConfig && recommended.cost?.tiers)) continue
            const optionSpecs = composeOptionSpecs(
              recommended,
              resolveZCodeOptionSpecsDetailed({ modelId: modelID, api, baseUrl }),
            )
            models[modelID] = {
              ...override,
              ...(optionSpecs ? { optionSpecs } : {}),
              ...(override.smartConfig && recommended.cost?.tiers ? { cost: applyRecommendation(native, recommended).cost } : {}),
            }
          }
          runtimeConfig = { ...configured, models }
        }
        this.mutablePi?.setProvider(
          runtimeConfig?.kind === 'builtin'
            ? withPiBuiltinProviderOverrides(source, runtimeConfig)
            : source,
        )
      }
      this.parsedConfig = parsed
      this.configFingerprint = fingerprint
      return parsed
    }
    this.syncOperation = this.syncOperation.then(operation, operation)
    return this.syncOperation
  }

  /**
   * DeepSeek selects one global wire protocol per config write, so the runtime
   * provider is rebuilt from whatever catalog is currently installed.
   */
  private applyProviderProtocolOverride(config: ParsedPiProviderCatalog): void {
    if (!this.mutablePi) return
    const base =
      this.directoryBaseProviders.get(DEEPSEEK_PROVIDER_ID) ??
      this.baseProviders.get(DEEPSEEK_PROVIDER_ID)
    if (!base) return
    const active = this.deepSeekProtocol
    const current = base
    const protocol = resolveDeepSeekProtocol(config)
    // A rejected DeepSeek block keeps the provider that is already running.
    if (!protocol) return
    if (protocol === DEFAULT_DEEPSEEK_PROTOCOL) {
      if (!active) return
      this.deepSeekProtocol = undefined
      this.mutablePi.setProvider(active.source)
      return
    }
    if (active?.protocol === protocol && current === active.provider) return
    // A provider other than our own override means the catalog was rebuilt
    // underneath it, so that provider becomes the new mapping source.
    const source = current === active?.provider ? active.source : current
    const provider = createPiDeepSeekProvider(source, protocol)
    this.deepSeekProtocol = { protocol, provider, source }
    this.mutablePi.setProvider(provider)
  }

  private providerEnabled(providerID: string, config: ParsedPiProviderCatalog) {
    if (config.schemaVersion > PI_PROVIDER_CONFIG_SCHEMA_VERSION) return false
    const provider = config.providers[providerID]
    if (!provider) return this.builtinProviderIDs.has(providerID)
    return provider.enabled
  }

  private modelEnabled(model: PiModel<Api>, config: ParsedPiProviderCatalog) {
    if (!this.providerEnabled(model.provider, config)) return false
    const provider = config.providers?.[model.provider]
    if (!provider) return false
    if (provider.kind === 'custom') {
      return (
        provider.models[model.id]?.enabled !== false &&
        Object.values(provider.models).some(
          (configured) => configured.id === model.id && configured.enabled,
        )
      )
    }
    if (provider.allowModels.length > 0 && !provider.allowModels.includes(model.id)) return false
    if (provider.denyModels.includes(model.id)) return false
    return provider.models[model.id]?.enabled !== false &&
      (provider.models[model.id] !== undefined || provider.allowModels.includes(model.id))
  }

  private assertActive() {
    if (this.disposed)
      throw new PiModelServiceError('DISPOSED', 'Pi model service has been disposed')
  }
}

const isMutableModels = (models: Models): models is MutableModels =>
  'setProvider' in models &&
  typeof (models as Partial<MutableModels>).setProvider === 'function' &&
  'deleteProvider' in models &&
  typeof (models as Partial<MutableModels>).deleteProvider === 'function'
