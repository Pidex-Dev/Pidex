import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai'
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
} from './ModelOptionMapping'
import { resolveModelOptionSpecsDetailed, type ModelOptionRuleResolution } from './ModelOptionRules'
import { AgentError } from '../../Domain'
import type { AgentLogger } from '../../observability/AgentLogger'
import {
  providerFailureCategory,
  providerFailureMessage,
  providerHttpErrorStatus,
} from '../ModelHealthService'
import {
  requestModelOperation,
  operationInputTokens,
  type ModelOperationOptions,
} from './ModelOperations'
import type {
  Api,
  Model as RuntimeModel,
  Models,
  ModelsStore,
  MutableModels,
  Provider as RuntimeProvider,
  StreamOptions,
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
  parseProviderCatalog,
  PROVIDER_CONFIG_SCHEMA_VERSION,
  type CustomProviderApi,
  type ParsedProviderCatalog,
  type CustomModelConfig,
  type ModelCatalogConfig,
  type ProviderConfig,
  type ProviderConfigIssue,
  type ProviderDefinitionInput,
} from './ProviderConfig'
import { withCatalogProvider } from './CatalogProvider'
import {
  catalogBinding,
  supportsCatalogProtocol,
  type OptionRule,
  type SpeedTierInvocation,
} from './CatalogV2'
import { applyOrderedJsonMergePatches } from './option-map/merge-patch'
import type { JsonObject } from './option-map/types'
import { withOpenAIModelDiscovery } from './OpenAIModelDiscovery'
import {
  builtinBaseUrlOverride,
  builtinModelConnection,
  withBuiltinProviderOverrides,
} from './BuiltinProviderOverrides'
import { observeCacheWriteUsage } from './CacheWriteUsage'
import { nativeMediaFormat } from './MediaInput'
import { normalizeDeveloperRoleCompat } from './ProviderApis'
import { createCustomProvider, toRuntimeModel } from './CustomProvider'

export interface ModelServiceOptions extends EncryptedCredentialStoreOptions {
  readonly pricing?: ModelPricingService
  readonly logger?: Pick<AgentLogger, 'warn'>
  readonly recommendations?: ModelRecommendationStore
  readonly directory?: ProviderDirectoryStore
  readonly models?: Models
  readonly modelsStore?: ModelsStore
  readonly config?:
    ModelCatalogConfig | (() => ModelCatalogConfig | PromiseLike<ModelCatalogConfig>)
  readonly env?: Readonly<Record<string, string | undefined>>
}

export class ModelServiceError extends Error {
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
    this.name = 'ModelServiceError'
  }
}

import { builtinProviderEndpoints } from './ProviderConfig'

const clone = <T>(value: T): T => structuredClone(value)

const providerToInfo = (
  provider: RuntimeProvider,
  kind: Provider.SourceKind,
  apis: readonly string[],
  disabled: boolean,
  configured?: ProviderConfig,
  catalogOrigin: Provider.CatalogOrigin = 'pi-bundled',
  catalogEndpoints?: Readonly<Record<string, string>>,
  catalogDefault?: string,
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
          endpoints: builtinProviderEndpoints(provider.id, catalogEndpoints),
          defaultApi: catalogDefault ?? apis[0],
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

const cost = (model: RuntimeModel<Api>): Model.Cost[] => [
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

type ConfiguredRuntimeModel = RuntimeModel<Api> & {
  catalog?: Model.CatalogDetails
  maxInputTokens?: number
  inputExplicit?: boolean
  mediaInput?: Model.MediaInputCapability
  modelType?: 'chat' | 'embedding' | 'rerank'
  tools?: boolean
  pricing?: Model.Pricing
  billingMode?: Model.BillingMode
  speedTiers?: readonly Model.SpeedTierInfo[]
  speedTier?: Model.SpeedTierId
  speedInvocation?: SpeedTierInvocation
  supportedProtocols?: readonly string[]
  /** 双层参数规格（仅 Pidex 内存模型携带，不进入 SDK 上游类型）。 */
  optionSpecs?: Model.OptionSpecs
}

const isChatModel = (model: RuntimeModel<Api>) => {
  const kind = (model as ConfiguredRuntimeModel).modelType
  return !kind || kind === 'chat'
}

/**
 * `.*` 兜底规则的产物：`values` 恰为 disabled/enabled 且 `map` 是空补丁
 * （不改写请求，交回 SDK 原生处理）。它是全局默认值，不是模型事实，
 * 只有在模型自身与推荐目录都没有更精确档位时才采用。
 */
const isGenericReasoningPlaceholder = (spec: Model.OptionSpecs['reasoningLevel']): boolean =>
  spec?.map === '{}' &&
  spec.values?.length === 2 &&
  spec.values[0] === 'disabled' &&
  spec.values[1] === 'enabled'

/** 模型在 SDK 目录里明确声明的档位（thinkingLevelMap 中非 null 的键），保持七档顺序。 */
const declaredThinkingValues = (
  reasoning: boolean,
  map: NonNullable<RuntimeModel<Api>['thinkingLevelMap']> | undefined,
): readonly string[] =>
  reasoning && map ? thinkingLevels.filter((level) => map[level] != null) : []

/** 显式 values 优先；显式值域不是通用兜底占位时严格使用，不再回退固定七档。 */
const supportedThinkingLevels = (model: RuntimeModel<Api>): readonly string[] => {
  if (!isChatModel(model)) return []
  const spec = (model as ConfiguredRuntimeModel).optionSpecs?.reasoningLevel
  if (spec?.values?.length && !isGenericReasoningPlaceholder(spec)) return spec.values
  const declared = declaredThinkingValues(model.reasoning, model.thinkingLevelMap)
  if (declared.length) return declared
  if (spec?.values?.length) return spec.values
  return model.reasoning
    ? thinkingLevels.filter((level) => model.thinkingLevelMap?.[level] !== null)
    : []
}

/**
 * 档位值域优先级：推荐目录/上游明确值 → 模型专用规则 → 模型自身声明
 * → `.*` 兜底。兜底只是全局默认值，仅在别无信息时使用。
 */
const resolveReasoningValues = (
  recommendation: Model.Recommendation,
  rules: ModelOptionRuleResolution,
  declared: readonly string[],
): readonly string[] | undefined => {
  const explicit =
    recommendation.optionSpecs?.reasoningLevel?.values ?? recommendation.reasoningLevels
  if (explicit?.length) return explicit
  const specific = rules.optionSpecs?.reasoningLevel?.values
  if (specific?.length && !rules.genericReasoningValues) return specific
  if (declared.length) return declared
  return specific?.length ? specific : undefined
}

/**
 * 合成运行时规格：档位值域按优先级取一个来源；清单显式提供的 CEL `map` 与输出上限
 * 优先于静态规则，缺失的字段由规则补全。
 */
const composeOptionSpecs = (
  recommendation: Model.Recommendation,
  rules: ModelOptionRuleResolution,
  declared: readonly string[] = [],
): Model.OptionSpecs | undefined => {
  const values = resolveReasoningValues(recommendation, rules, declared)
  const map =
    recommendation.optionSpecs?.reasoningLevel?.map ?? rules.optionSpecs?.reasoningLevel?.map
  const recMax = recommendation.optionSpecs?.maxOutputTokens
  const ruleMax = rules.optionSpecs?.maxOutputTokens
  const maxOutputTokens =
    recMax || ruleMax
      ? {
          ...(recMax?.max !== undefined
            ? { max: recMax.max }
            : ruleMax?.max !== undefined
              ? { max: ruleMax.max }
              : {}),
          ...(recMax?.map !== undefined
            ? { map: recMax.map }
            : ruleMax?.map !== undefined
              ? { map: ruleMax.map }
              : {}),
        }
      : undefined
  const reasoningLevel =
    values || map ? { ...(values ? { values } : {}), ...(map ? { map } : {}) } : undefined
  if (!reasoningLevel && !maxOutputTokens) return undefined
  return {
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  }
}

const effectiveInput = (model: RuntimeModel<Api>): string[] => {
  const kind = (model as ConfiguredRuntimeModel).modelType
  if (kind === 'embedding' || kind === 'rerank') return ['text']
  const gemini = model.api === 'google-generative-ai' || model.api === 'google-vertex'
  const nativeMedia =
    gemini && !(model as ConfiguredRuntimeModel).inputExplicit && model.id.includes('gemini')
  const input = new Set<string>([...model.input, ...(nativeMedia ? ['audio', 'video'] : [])])
  if (!(gemini || model.api === 'openai-completions')) input.delete('audio')
  if (Model.VideoInputMimeTypes.some((mimeType) => nativeMediaFormat(model, 'video', mimeType)))
    input.add('video')
  else input.delete('video')
  if (nativeMediaFormat(model, 'pdf', 'application/pdf')) input.add('pdf')
  else input.delete('pdf')
  return [...input]
}

const modelToInfo = (model: RuntimeModel<Api>, enabled: boolean, variant?: string): Model.Info => ({
  id: Model.ID.make(model.id),
  providerID: Provider.ID.make(model.provider),
  name: model.name,
  ...((model as ConfiguredRuntimeModel).pricing
    ? { pricing: (model as ConfiguredRuntimeModel).pricing }
    : {}),
  ...((model as ConfiguredRuntimeModel).billingMode ||
  (model as ConfiguredRuntimeModel).pricing?.billingMode
    ? {
        billingMode:
          (model as ConfiguredRuntimeModel).billingMode ??
          (model as ConfiguredRuntimeModel).pricing?.billingMode,
      }
    : {}),
  ...((model as ConfiguredRuntimeModel).speedTiers
    ? { speedTiers: (model as ConfiguredRuntimeModel).speedTiers }
    : {}),
  ...((model as ConfiguredRuntimeModel).speedTier
    ? { speedTier: (model as ConfiguredRuntimeModel).speedTier }
    : {}),
  ...((model as ConfiguredRuntimeModel).catalog
    ? { catalog: (model as ConfiguredRuntimeModel).catalog }
    : {}),
  ...((model as ConfiguredRuntimeModel).catalog?.family
    ? { family: Model.Family.make((model as ConfiguredRuntimeModel).catalog!.family!) }
    : {}),
  ...((model as ConfiguredRuntimeModel).modelType &&
  (model as ConfiguredRuntimeModel).modelType !== 'chat'
    ? { modelType: (model as ConfiguredRuntimeModel).modelType! }
    : {}),
  api: {
    id: Model.ID.make(model.id),
    type: 'pi',
    name: model.api,
    baseUrl: model.baseUrl,
    ...((model as ConfiguredRuntimeModel).supportedProtocols
      ? { supportedProtocols: (model as ConfiguredRuntimeModel).supportedProtocols }
      : {}),
  },
  ...(variant ? { variant } : {}),
  capabilities: {
    tools:
      (!(model as ConfiguredRuntimeModel).modelType ||
        (model as ConfiguredRuntimeModel).modelType === 'chat') &&
      (model as ConfiguredRuntimeModel).tools !== false,
    input: effectiveInput(model),
    output: [
      (model as ConfiguredRuntimeModel).modelType === 'embedding'
        ? 'embedding'
        : (model as ConfiguredRuntimeModel).modelType === 'rerank'
          ? 'rerank'
          : 'text',
    ],
  },
  variants: supportedThinkingLevels(model).map((level) => ({
    id: Model.VariantID.make(level),
  })),
  time: { released: Date.parse((model as ConfiguredRuntimeModel).catalog?.releaseDate ?? '') || 0 },
  cost: cost(model),
  status: (model as ConfiguredRuntimeModel).catalog?.status ?? 'active',
  enabled,
  limit: {
    context: model.contextWindow,
    ...((model as ConfiguredRuntimeModel).maxInputTokens !== undefined
      ? { input: (model as ConfiguredRuntimeModel).maxInputTokens! }
      : {}),
    output: model.maxTokens,
  },
})

export type ProviderDefinition = ProviderDefinitionInput

/** provider/list baseline summary; the full baseline stays internal. */
export interface ProviderModelSyncSummary {
  readonly fetchedAt: number
  readonly api: CustomProviderApi
  readonly modelCount: number
}

/** Maps the runtime model registry to the Pidex catalog. */
export class ModelService {
  readonly recommendations: ModelRecommendationStore
  readonly directory: ProviderDirectoryStore
  readonly registry: Models
  private readonly mediaModels = new WeakMap<RuntimeModel<Api>, RuntimeModel<Api>>()
  readonly credentials: EncryptedCredentialStore
  private readonly mutableRegistry: MutableModels | undefined
  private readonly configSource: ModelServiceOptions['config']
  private readonly baseProviders: ReadonlyMap<string, RuntimeProvider>
  private directoryBaseProviders: ReadonlyMap<string, RuntimeProvider> = new Map()
  private directoryEntries: readonly DirectoryProvider[] = []
  private catalogProtocolEndpoints: Readonly<Record<string, Readonly<Record<string, string>>>> = {}
  private readonly builtinProviderIDs: ReadonlySet<string>
  private configuredCustomProviderIDs = new Set<string>()
  private catalogVersion = 0
  private configFingerprint = ''
  private providerCatalog: Awaited<ReturnType<ProviderDirectoryStore['catalog']>>
  private optionRules: readonly OptionRule[] | undefined
  private parsedConfig: ParsedProviderCatalog = {
    schemaVersion: PROVIDER_CONFIG_SCHEMA_VERSION,
    providers: {},
    issues: [],
  }
  private syncOperation: Promise<ParsedProviderCatalog> = Promise.resolve(this.parsedConfig)
  private disposed = false
  /** 按运行时模型对象缓存编译后的 option map；配置同步重建模型对象时自动失效。 */
  private readonly optionMapCompiled = new WeakMap<object, CompiledOptionSpecs | null>()

  constructor(
    repository: ProviderCredentialRepository,
    private readonly options: ModelServiceOptions = {},
  ) {
    this.recommendations = options.recommendations ?? new ModelRecommendationStore()
    this.directory = options.directory ?? new ProviderDirectoryStore()
    this.credentials = new EncryptedCredentialStore(repository, options)
    this.registry =
      options.models ??
      builtinModels({
        credentials: this.credentials,
        ...(options.modelsStore ? { modelsStore: options.modelsStore } : {}),
        authContext: {
          env: async (name) => options.env?.[name] ?? process.env[name],
          // Pidex intentionally does not let SDK discover auth files.
          fileExists: async () => false,
        },
      })
    this.mutableRegistry = isMutableModels(this.registry) ? this.registry : undefined
    for (const provider of this.registry.getProviders()) {
      const discovered = withOpenAIModelDiscovery(
        provider,
        (signal) => this.registry.getAuth(provider.id, { signal }),
        () => {
          const config = this.parsedConfig.providers[provider.id]
          return config?.kind === 'builtin'
            ? (config.baseUrl ?? provider.baseUrl)
            : provider.baseUrl
        },
      )
      if (discovered !== provider) this.mutableRegistry?.setProvider(discovered)
    }
    this.baseProviders = new Map(
      this.registry.getProviders().map((provider) => [provider.id, provider]),
    )
    this.builtinProviderIDs = new Set(this.registry.getProviders().map((provider) => provider.id))
    this.installOptionMapBoundary()
    this.configSource = options.config
    options.recommendations?.startAutoRefresh()
  }

  async list(): Promise<readonly Provider.Info[]> {
    this.assertActive()
    const config = await this.syncProviders()
    const directory = new Map(this.directoryEntries.map((entry) => [entry.id, entry]))
    const marketVisibleIDs = this.directoryEntries.length
      ? new Set(this.directoryEntries.map((entry) => entry.id))
      : undefined
    const configuredIDs = new Set(Object.keys((await this.rawConfig()).providers ?? {}))
    const saved = new Set(configuredIDs)
    for (const credential of await this.credentials.list()) saved.add(credential.providerId)
    const providers = this.registry
      .getProviders()
      .flatMap((provider) => {
        const configured = config.providers[provider.id]
        const entry = directory.get(provider.id)
        const userCustom =
          configured?.kind === 'custom' &&
          !configured.directorySource &&
          configuredIDs.has(provider.id)
        const kind = userCustom ? 'custom' : 'builtin'
        // INVARIANT: 清单加载后仅展示 marketVisible 供应商，但保留用户已保存凭据或配置的旧内置供应商。
        if (
          kind === 'builtin' &&
          marketVisibleIDs &&
          !marketVisibleIDs.has(provider.id) &&
          !saved.has(provider.id)
        ) {
          return []
        }
        const origin: Provider.CatalogOrigin = userCustom
          ? 'user'
          : ((configured?.kind === 'custom' ? configured.directorySource : undefined) ??
            entry?.origin ??
            'pi-bundled')
        const info = providerToInfo(
          provider,
          kind,
          this.registry.getModels(provider.id).map((model) => model.api),
          !this.providerEnabled(provider.id, config),
          configured,
          origin,
          this.protocolDefaults(provider),
          this.providerCatalog?.providersDoc.providers[provider.id]?.defaultProtocol,
        )
        directory.delete(provider.id)
        const defaultApi =
          configured?.kind === 'custom'
            ? (Object.keys(configured.endpoints ?? {})[0] ??
              Object.values(configured.models)[0]?.api ??
              entry?.api)
            : (info.source.defaultApi ?? entry?.api)
        return [
          kind === 'builtin' && entry
            ? {
                ...info,
                name: configured?.kind === 'custom' ? configured.name : entry.name,
                source: {
                  ...info.source,
                  ...(entry.env.length ? { env: entry.env } : {}),
                  ...(defaultApi ? { defaultApi } : {}),
                  ...(entry.baseUrl
                    ? {
                        endpoints: {
                          ...info.source.endpoints,
                          ...entry.endpoints,
                          ...(defaultApi
                            ? {
                                [defaultApi]:
                                  provider.baseUrl ??
                                  entry.endpoints?.[defaultApi as CustomProviderApi] ??
                                  entry.baseUrl,
                              }
                            : {}),
                          ...configured?.endpoints,
                        },
                      }
                    : {}),
                },
              }
            : info,
        ]
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
          ...(entry.env.length ? { env: entry.env } : {}),
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
    const provider = this.registry.getProviders().find((candidate) => candidate.id === providerID)
    if (!provider) return false
    if (!provider.auth.apiKey && !provider.auth.oauth) return true
    return (await this.registry.checkAuth(providerID)) !== undefined
  }

  /** 判断是否为内置供应商（不含用户自定义 Provider）。 */
  isBuiltinProvider(providerID: string): boolean {
    return this.builtinProviderIDs.has(providerID)
  }

  /** 返回供应商在当前清单/运行时中的活跃模型数（不含已废弃模型，不受用户启用过滤影响）。 */
  catalogModelCount(providerID: string): number {
    this.assertActive()
    const directoryEntry = this.directoryEntries.find((entry) => entry.id === providerID)
    if (directoryEntry && !this.builtinProviderIDs.has(providerID))
      return Object.keys(directoryEntry.models).length
    const runtimeModels =
      this.directoryBaseProviders.get(providerID)?.getModels() ??
      this.registry.getModels(providerID)
    if (runtimeModels.length > 0) {
      return runtimeModels.filter(
        (model) => (model as ConfiguredRuntimeModel).catalog?.status !== 'deprecated',
      ).length
    }
    return 0
  }

  /** 返回内置供应商在当前目录中的全部活跃模型 ID（排除已废弃模型）。 */
  async activeCatalogModelIDs(providerID: string): Promise<readonly string[]> {
    this.assertActive()
    const config = await this.syncProviders()
    if (
      !this.builtinProviderIDs.has(providerID) ||
      config.providers[providerID]?.kind === 'custom'
    ) {
      return []
    }
    const current = (
      this.directoryBaseProviders.get(providerID)?.getModels() ??
      this.registry.getModels(providerID)
    ).filter(isChatModel)
    if (this.providerCatalog?.providersDoc.providers[providerID])
      return current.map((model) => model.id)
    const models = await Promise.all(current.map((model) => this.withCatalog(model)))
    return [
      ...new Set(
        models.filter((model) => model.catalog?.status !== 'deprecated').map((model) => model.id),
      ),
    ]
  }

  async providerDefinitions(): Promise<readonly ProviderDefinition[]> {
    this.assertActive()
    const config = await this.syncProviders()
    const definitions = this.registry.getProviders().map((provider): ProviderDefinition => {
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
            ...(model.mediaInput ? { mediaInput: structuredClone(model.mediaInput) } : {}),
            ...(model.pricing ? { pricing: model.pricing } : {}),
            cost: { ...model.cost },
            ...(Object.keys(model.headers).length ? { headers: { ...model.headers } } : {}),
            ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
            ...(model.compat ? { compat: structuredClone(model.compat) } : {}),
            ...(model.smartConfig ? { smartConfig: structuredClone(model.smartConfig) } : {}),
            ...(model.optionSpecs ? { optionSpecs: structuredClone(model.optionSpecs) } : {}),
          })),
        }
      }
      const builtin = configured?.kind === 'builtin' ? configured : undefined
      const catalog = this.providerCatalog?.providersDoc.providers[provider.id]
      const baseUrl = builtinBaseUrlOverride(
        provider.id,
        builtin?.baseUrl,
        catalog?.defaultProtocol ?? provider.getModels()[0]?.api,
        catalog?.protocolEndpoints,
      )
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
        ...(baseUrl ? { baseUrl } : {}),
        ...(builtin?.allowInsecureHttp !== undefined
          ? { allowInsecureHttp: builtin.allowInsecureHttp }
          : {}),
      }
    })
    return definitions.map(clone)
  }

  async discoverBuiltinModels(providerID: string) {
    const config = await this.syncProviders()
    if (!this.builtinProviderIDs.has(providerID) || config.providers[providerID]?.kind === 'custom')
      throw new AgentError('PROVIDER_NOT_FOUND', '内置供应商不存在', 404)
    const runtimeModels = this.registry.getModels(providerID)
    const catalogIds = new Set(
      this.directoryBaseProviders
        .get(providerID)
        ?.getModels()
        .map((model) => model.id),
    )
    return this.describeDiscoveredModels(
      catalogIds.size > 0
        ? runtimeModels.filter((model) => catalogIds.has(model.id))
        : runtimeModels,
    )
  }

  /** Reads the local catalog for a market provider represented by a custom runtime definition. */
  async discoverDirectoryModels(providerID: string) {
    await this.syncProviders()
    const entry = this.directoryEntries.find((candidate) => candidate.id === providerID)
    if (!entry) return []
    const config = directoryProviderConfig(entry)
    if (!config) return []
    const models = await Promise.all(
      Object.values(config.models).map((model) =>
        this.enrichBuiltinModel(providerID, {
          ...toRuntimeModel(providerID, config, model),
          baseUrl:
            entry.modelBaseUrls?.[model.id] ?? config.endpoints?.[model.api] ?? config.baseUrl,
        }),
      ),
    )
    return this.describeDiscoveredModels(models)
  }

  private describeDiscoveredModels(models: readonly RuntimeModel<Api>[]) {
    return Promise.all(
      models.map(async (original) => {
        const model = await this.withCatalog(original)
        const input = effectiveInput(model)
        return {
          ...(model.catalog ? { catalog: model.catalog } : {}),
          id: model.id,
          name: model.name,
          api: (CUSTOM_PROVIDER_APIS as readonly string[]).includes(model.api)
            ? (model.api as CustomProviderApi)
            : ('openai-completions' as const),
          enabled: false,
          contextWindow: model.contextWindow,
          ...(model.maxInputTokens !== undefined ? { maxInputTokens: model.maxInputTokens } : {}),
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          tools: modelToInfo(model, false).capabilities.tools,
          ...(model.modelType ? { modelType: model.modelType } : {}),
          ...(input.length ? { input: input.filter((kind) => kind !== 'pdf') } : {}),
          ...(model.optionSpecs ? { optionSpecs: model.optionSpecs } : {}),
          ...(model.pricing ? { pricing: model.pricing } : {}),
          cost: model.cost,
        }
      }),
    )
  }

  async models(providerID?: Provider.ID): Promise<readonly Model.Info[]> {
    this.assertActive()
    const config = await this.syncProviders()
    const available = new Set(
      (await this.registry.getAvailable(providerID ? String(providerID) : undefined)).map(
        (model) => `${model.provider}/${model.id}`,
      ),
    )
    return Promise.all(
      this.registry
        .getModels(providerID ? String(providerID) : undefined)
        .filter((model) => this.modelEnabled(model, config))
        .map(async (model) =>
          clone(
            modelToInfo(
              await this.withCatalog(model),
              available.has(`${model.provider}/${model.id}`),
            ),
          ),
        ),
    )
  }

  async resolve(ref: Model.Ref): Promise<Model.Info> {
    const model = await this.getRuntimeModel(ref)
    const auth = await this.registry.checkAuth(model.provider)
    const variant = ref.variant ? String(ref.variant) : supportedThinkingLevels(model)[0]
    return clone(modelToInfo(model, auth !== undefined, variant))
  }

  private async withCatalog(model: RuntimeModel<Api>): Promise<ConfiguredRuntimeModel> {
    const providerId =
      this.parsedConfig?.providers[model.provider]?.kind === 'custom'
        ? await this.directory.resolveProviderByBaseUrl(model.baseUrl)
        : model.provider
    const entry = providerId ? this.providerCatalog?.providersDoc.providers[providerId] : undefined
    const protocols = catalogBinding(entry, model.id)?.binding.supportedProtocols
    const configured: ConfiguredRuntimeModel = protocols
      ? { ...model, supportedProtocols: protocols }
      : model
    if (configured.catalog) return configured
    const { recommended } = await this.recommendations.resolve({
      providerId: model.provider,
      modelId: model.id,
      baseUrl: model.baseUrl,
      modelType: (model as ConfiguredRuntimeModel).modelType ?? 'chat',
      api: model.api,
    })
    if (!recommended.catalog && !recommended.speedTiers && !recommended.billingMode)
      return configured
    return {
      ...configured,
      ...(recommended.catalog ? { catalog: recommended.catalog } : {}),
      ...(recommended.speedTiers ? { speedTiers: recommended.speedTiers } : {}),
      ...(recommended.billingMode ? { billingMode: recommended.billingMode } : {}),
    }
  }

  async getRuntimeModel(ref: Model.Ref): Promise<RuntimeModel<Api>> {
    this.assertActive()
    const config = await this.syncProviders()
    const providerID = String(ref.providerID)
    const modelID = String(ref.id)
    if (!this.providerEnabled(providerID, config)) {
      throw new ModelServiceError('PROVIDER_NOT_FOUND', `Provider ${providerID} was not found`)
    }
    const source = this.providerCatalog?.providersDoc.providers[providerID]
    const alias =
      config.providers[providerID]?.kind === 'custom' ? undefined : catalogBinding(source, modelID)
    const found =
      this.registry.getModel(providerID, modelID) ??
      (alias ? this.registry.getModel(providerID, alias.id) : undefined)
    let model = found ? await this.withCatalog(found) : undefined
    if (
      !model ||
      (!this.modelEnabled(model, config) &&
        !(alias && alias.id !== modelID && this.modelEnabled({ ...model, id: modelID }, config)))
    ) {
      throw new ModelServiceError('MODEL_NOT_FOUND', `Model ${providerID}/${modelID} was not found`)
    }
    if (ref.variant && !supportedThinkingLevels(model).includes(String(ref.variant))) {
      throw new ModelServiceError(
        'VARIANT_NOT_FOUND',
        `Variant ${providerID}/${modelID}/${ref.variant} was not found`,
      )
    }
    const auth = await this.registry.checkAuth(providerID)
    if (!auth)
      throw new ModelServiceError(
        'PROVIDER_NOT_CONFIGURED',
        `Provider ${providerID} is not configured`,
      )
    const matchedProvider =
      config.providers[providerID]?.kind === 'custom'
        ? await this.directory.resolveProviderByBaseUrl(model.baseUrl)
        : providerID
    const match = matchedProvider
      ? catalogBinding(this.providerCatalog?.providersDoc.providers[matchedProvider], modelID)
      : undefined
    const binding = match?.binding
    if (!supportsCatalogProtocol(binding, model.api)) {
      throw this.unsupportedProtocol(binding!.supportedProtocols!)
    }
    const aliasTier = Model.SpeedTierIds.find(
      (id) => binding?.speedTiers?.[id]?.requestModelId?.toLowerCase() === modelID.toLowerCase(),
    )
    const speedTier = ref.speedTier ?? aliasTier ?? 'standard'
    const invocation =
      binding?.speedTiers?.[speedTier] ??
      (aliasTier && speedTier === 'standard' ? { requestModelId: match!.id } : undefined)
    const profile = model.speedTiers?.find((tier) => tier.id === speedTier)
    if (speedTier !== 'standard' && (!invocation || !profile)) {
      throw new ModelServiceError('VARIANT_NOT_FOUND', '该模型当前不支持所选速度档位。')
    }
    if (ref.speedTier || aliasTier || invocation) {
      model = {
        ...model,
        speedTier,
        ...(invocation ? { speedInvocation: invocation } : {}),
        ...(profile?.pricing ? { pricing: profile.pricing } : {}),
      }
    }
    model = normalizeDeveloperRoleCompat(model)
    const input = effectiveInput(model)
    if (
      input.length === model.input.length &&
      input.every((kind, index) => kind === model.input[index])
    )
      return model
    let extended = this.mediaModels.get(model)
    if (!extended) {
      extended = { ...model, input: input as RuntimeModel<Api>['input'] }
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
    const model = (await this.getRuntimeModel(ref)) as ConfiguredRuntimeModel & {
      maxInputTokens?: number
    }
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
    const explicitEndpoint =
      config?.endpoints?.[endpointKey] ??
      this.catalogProtocolEndpoints[model.provider]?.[endpointKey]
    if (
      !explicitEndpoint &&
      ![endpointKey, 'openai-completions', 'openai-responses'].includes(model.api)
    )
      throw new AgentError('INVALID_REQUEST', '请先为该模型类型添加对应端点', 400)
    const base = explicitEndpoint ?? model.baseUrl
    const suffix = kind === 'embedding' ? '/embeddings' : '/rerank'
    const endpoint = base.replace(/\/$/, '').endsWith(suffix)
      ? base
      : `${base.replace(/\/$/, '')}${suffix}`
    const auth = await this.registry.getAuth(model.provider)
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
    if (!this.registry.getProviders().some((provider) => provider.id === providerID)) {
      throw new AgentError('INVALID_REQUEST', '供应商不存在', 400)
    }
    const result = await this.registry.refresh({
      allowNetwork: true,
      force,
      providers: this.registry
        .getProviders()
        .filter(
          (provider) => provider.id === providerID && this.providerEnabled(provider.id, config),
        )
        .map((provider) => provider.id),
    })
    if (result.errors.size > 0) {
      const failures = [...result.errors].map(([provider, error]) => {
        const httpStatus = providerHttpErrorStatus(error, 'response')
        const category = providerFailureCategory(error, 'response')
        const discoveryReason = new Map([
          ['Model discovery response exceeds 1 MiB', '模型列表响应超过 1 MiB'],
          ['Model discovery returned no body', '模型列表响应为空'],
          ['Model discovery returned an invalid OpenAI catalog', '模型列表响应格式无效'],
          ['Provider credentials are unavailable for model discovery', '模型发现凭据不可用'],
        ]).get(error.message)
        const reason = `${discoveryReason ?? providerFailureMessage(category, 'request')}${httpStatus ? `（HTTP ${httpStatus}）` : ''}`
        this.options.logger?.warn('provider.catalog.refresh.failed', { provider, category, reason })
        const failure = providerRequestError(error, provider)
        return {
          providerId: provider,
          code: failure.code as ProviderFailure['code'],
          retryable: failure.retryable,
          ...(httpStatus ? { httpStatus } : {}),
        }
      })
      throw new ModelServiceError(
        'CATALOG_REFRESH_FAILED',
        'Failed to refresh one or more providers',
        {
          cause: new AggregateError(result.errors.values()),
        },
        failures,
      )
    }
    this.catalogVersion += 1
  }

  async refreshModelPricing(force = true, year?: number) {
    if (!this.options.pricing)
      throw new AgentError('PROVIDER_UNAVAILABLE', '计费资料服务暂不可用。', 503)
    return this.options.pricing.refresh(force, year)
  }

  async reload(): Promise<void> {
    this.assertActive()
    await this.syncProviders()
    await this.registry.refresh({ allowNetwork: false })
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

  getModel(ref: Model.Ref): Promise<RuntimeModel<Api>> {
    return this.getRuntimeModel(ref)
  }

  catalogRevision(): number {
    return this.catalogVersion
  }

  async configIssues(): Promise<readonly ProviderConfigIssue[]> {
    return [...(await this.syncProviders()).issues]
  }

  async catalogConfig(): Promise<ParsedProviderCatalog> {
    return structuredClone(await this.syncProviders())
  }

  /** Bounded provider/list summary of the saved upstream baseline. */
  async modelSyncSummary(providerID: string): Promise<ProviderModelSyncSummary | undefined> {
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
    const config = (await this.syncProviders()).providers[input.providerId]
    const endpoints: RecommendationInput['endpoints'] =
      config?.kind === 'custom' &&
      (!input.baseUrl ||
        input.baseUrl === config.baseUrl ||
        Object.values(config.endpoints ?? {}).includes(input.baseUrl))
        ? config.endpoints
        : undefined
    const resolved = await this.recommendations.resolve({ ...input, endpoints })
    if (resolved.unsupportedProtocol) throw this.unsupportedProtocol(resolved.unsupportedProtocol)
    const rules = resolveModelOptionSpecsDetailed(
      {
        modelId: input.modelId,
        api: resolved.recommendedApi ?? input.api ?? '',
        baseUrl:
          (resolved.recommendedApi && endpoints?.[resolved.recommendedApi]) ??
          (input.api && endpoints?.[input.api]) ??
          input.baseUrl,
      },
      await this.recommendations.optionRules(),
    )
    const optionSpecs = composeOptionSpecs(resolved.recommended, rules)
    if (!optionSpecs) return resolved
    return {
      ...resolved,
      recommended: { ...resolved.recommended, optionSpecs },
    }
  }

  private unsupportedProtocol(protocols: readonly string[]) {
    return new AgentError('INVALID_REQUEST', this.catalogProtocolMessage(protocols), 400)
  }

  private catalogProtocolMessage(protocols: readonly string[]) {
    return protocols.length
      ? `该模型当前仅支持 ${protocols.join('、')}，请选择支持的协议。`
      : '该模型当前没有可用的 API 协议。'
  }

  async draftProtocolProblem(
    modelId: string,
    api: string,
    baseUrl: string,
    providerId?: string,
    draftBaseUrl?: string,
  ) {
    const catalog = await this.directory.catalog()
    if (!catalog) return undefined
    const matched =
      (await this.directory.resolveProviderByBaseUrl(baseUrl)) ??
      (draftBaseUrl && draftBaseUrl !== baseUrl
        ? await this.directory.resolveProviderByBaseUrl(draftBaseUrl)
        : undefined)
    const id =
      matched ?? (providerId && this.builtinProviderIDs.has(providerId) ? providerId : undefined)
    const binding = id
      ? catalogBinding(catalog.providersDoc.providers[id], modelId)?.binding
      : undefined
    const protocols = binding?.supportedProtocols
    return protocols && !supportsCatalogProtocol(binding, api)
      ? this.catalogProtocolMessage(protocols)
      : undefined
  }

  refreshRecommendations() {
    return this.recommendations.refresh()
  }

  private async rawConfig(): Promise<ModelCatalogConfig> {
    return typeof this.configSource === 'function'
      ? await this.configSource()
      : (this.configSource ?? {})
  }

  /**
   * 内置 Provider 直接以自维护清单作为上游基线，不依赖 smartConfig；
   * 仅在缓存中存在匹配条目时叠加规格、思考强度、定价与闲时规则，
   * 用户显式手工覆写会在后续 `withBuiltinProviderOverrides` 层覆盖其上。
   */
  private async enrichBuiltinModel(
    id: string,
    model: RuntimeModel<Api>,
  ): Promise<RuntimeModel<Api>> {
    const { recommended } = await this.recommendations.resolve({
      providerId: id,
      modelId: model.id,
      modelType: (model as ConfiguredRuntimeModel).modelType ?? 'chat',
      baseUrl: model.baseUrl,
      api: model.api,
    })
    if (!Object.keys(recommended).length) return model
    const applied = applyRecommendation(
      model as ConfiguredRuntimeModel,
      recommended,
    ) as ConfiguredRuntimeModel
    const shouldComposeOptionSpecs =
      Boolean(recommended.optionSpecs) || Boolean(recommended.reasoningLevels?.length)
    const optionSpecs = shouldComposeOptionSpecs
      ? composeOptionSpecs(
          recommended,
          resolveModelOptionSpecsDetailed(
            {
              modelId: model.id,
              api: model.api,
              baseUrl: model.baseUrl,
            },
            this.optionRules,
          ),
          declaredThinkingValues(applied.reasoning, applied.thinkingLevelMap),
        )
      : applied.optionSpecs
    return {
      ...applied,
      ...(recommended.input ? { inputExplicit: true } : {}),
      ...(optionSpecs ? { optionSpecs } : {}),
    }
  }

  /**
   * 运行时合成：已启用智能配置的模型，用当前推荐值覆盖全部推荐字段。
   * 只作用于交给 SDK 的运行时配置；`parsedConfig` 仍保存用户原始值，
   * 否则 UI 读到的推荐值会被当成用户值回写并永久固定。
   */
  private async applyRecommendations(
    providerID: string,
    provider: Extract<ProviderConfig, { kind: 'custom' }>,
  ): Promise<Extract<ProviderConfig, { kind: 'custom' }>> {
    if (!Object.values(provider.models).some((model) => model.smartConfig)) return provider
    const models: Record<string, CustomModelConfig> = {}
    for (const [id, model] of Object.entries(provider.models)) {
      // 旧版逐字段固定配置按整份手动配置保留，重新采用推荐后切换自动模式。
      if (
        !model.smartConfig ||
        model.smartConfig.enabled === false ||
        model.smartConfig.pinned.length > 0
      ) {
        models[id] = model
        continue
      }
      const {
        recommended: baseRecommended,
        unsupportedProtocol,
        recommendedApi,
      } = await this.recommendations.resolve({
        providerId: providerID,
        baseUrl: provider.baseUrl,
        modelId: model.id,
        modelType: model.modelType ?? 'chat',
        api: model.api,
        endpoints: provider.endpoints,
      })
      if (unsupportedProtocol) {
        models[id] = model
        continue
      }
      const api = recommendedApi ?? model.api
      const baseUrl = provider.endpoints?.[api] ?? provider.baseUrl
      // 档位值域按“推荐 → 专用规则 → 模型自身声明 → 通用兜底”取值，
      // 协议 map 继续由静态规则补齐。
      const rules = resolveModelOptionSpecsDetailed(
        { modelId: model.id, api, baseUrl },
        this.optionRules,
      )
      const recommended = {
        ...baseRecommended,
        optionSpecs: composeOptionSpecs(
          baseRecommended,
          rules,
          declaredThinkingValues(model.reasoning, model.thinkingLevelMap),
        ),
      }
      const document =
        model.smartConfig.source === 'document' ? model.smartConfig.document?.data : undefined
      const applied = applyRecommendation(applyRecommendation(model, recommended), document ?? {})
      if (document?.pricing) (applied as { pricing?: Model.Pricing }).pricing = document.pricing
      if (api === model.api) models[id] = applied
      else {
        const { compat: _compat, ...configured } = applied
        models[id] = { ...configured, api }
      }
    }
    return { ...provider, models }
  }

  /**
   * 在 `Models` 单一出口处组合协议 map：聊天、非流式（completeSimple 走 streamSimple）、
   * 模型测试都消费同一个 运行时实例，因此这一处接线覆盖所有请求路径。
   * 显式 reasoningLevel map 存在时，抑制 SDK 固定 reasoning 枚举，避免把任意 values
   * 塞进 SDK 的 ThinkingLevel；由 map 成为请求字段的唯一权威。
   */
  private installOptionMapBoundary(): void {
    const registry = this.registry as unknown as {
      streamSimple?: (model: unknown, context: unknown, options?: unknown) => unknown
    }
    if (typeof registry.streamSimple !== 'function') return
    const original = registry.streamSimple.bind(this.registry)
    try {
      registry.streamSimple = (model: unknown, context: unknown, options?: unknown) => {
        const invocation = (model as ConfiguredRuntimeModel | undefined)?.speedInvocation
        const priced =
          model && typeof model === 'object'
            ? this.options.pricing?.begin(model as RuntimeModel<Api>)
            : undefined
        const pricedModel = priced?.model ?? model
        const requestModel = invocation?.requestModelId
          ? { ...(pricedModel as RuntimeModel<Api>), id: invocation.requestModelId }
          : pricedModel
        const dispatch = (m: unknown, c: unknown, o?: unknown) => {
          if (invocation?.payloadPatch) {
            const opts = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
            const previous =
              typeof opts.onPayload === 'function'
                ? (opts.onPayload as (payload: unknown, target: unknown) => unknown)
                : undefined
            const patch = invocation.payloadPatch as JsonObject
            o = {
              ...opts,
              onPayload: async (payload: JsonObject, target: unknown) => {
                const resolved = (await previous?.(payload, target)) ?? payload
                return applyOrderedJsonMergePatches(resolved as JsonObject, [
                  { option: 'speedTier', patch },
                ])
              },
            }
          }
          const rawTarget = (m === model ? requestModel : m) as RuntimeModel<Api>
          const target = rawTarget?.api ? normalizeDeveloperRoleCompat(rawTarget) : rawTarget
          const cacheUsage = target?.api
            ? observeCacheWriteUsage(target.api, o as StreamOptions | undefined)
            : undefined
          const source = original(
            target,
            c,
            cacheUsage?.options ?? o,
          ) as AssistantMessageEventStream
          if (!priced && !cacheUsage) return source
          const result = createAssistantMessageEventStream()
          void (async () => {
            try {
              for await (const event of source) {
                const terminal = event.type === 'done' || event.type === 'error'
                const message =
                  event.type === 'done'
                    ? event.message
                    : event.type === 'error'
                      ? event.error
                      : event.partial
                const split = terminal ? cacheUsage?.settle(message.usage, target) : undefined
                priced?.annotate(message, split)
                result.push(event)
              }
              result.end()
            } catch {
              const error = {
                role: 'assistant' as const,
                content: [],
                api: (requestModel as RuntimeModel<Api>).api,
                provider: (requestModel as RuntimeModel<Api>).provider,
                model: (requestModel as RuntimeModel<Api>).id,
                timestamp: Date.now(),
                stopReason: 'error' as const,
                errorMessage: '模型响应流未能完成，请重试。',
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              }
              priced?.annotate(error)
              result.push({ type: 'error', reason: 'error', error })
              result.end()
            }
          })().catch(() => undefined)
          return result
        }
        if (
          (model as ConfiguredRuntimeModel | undefined)?.catalog?.temperature === false &&
          options &&
          typeof options === 'object'
        ) {
          const { temperature: _temperature, ...rest } = options as Record<string, unknown>
          options = rest
        }
        const compiled =
          model && typeof model === 'object' ? this.compiledOptionMap(model as object) : null
        if (!compiled) {
          const catalog = (model as ConfiguredRuntimeModel | undefined)?.catalog
          if (
            catalog?.reasoningOptions?.some((option) => option.type === 'toggle') &&
            options &&
            typeof options === 'object'
          ) {
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
        // 显式 reasoning values 不再交给 SDK 的固定枚举处理。
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

  private syncProviders(force = false): Promise<ParsedProviderCatalog> {
    const operation = async () => {
      const raw = await this.rawConfig()
      const entries = await this.directory.providers()
      const catalog = await this.directory.catalog()
      const protocolEndpoints = await this.directory.protocolEndpoints()
      // 推荐目录更新后必须重新合成，否则已保存模型会停在旧推荐值上。
      const fingerprint = JSON.stringify([
        raw,
        await this.recommendations.version(),
        protocolEndpoints,
      ])
      if (
        !force &&
        fingerprint === this.configFingerprint &&
        entries === this.directoryEntries &&
        catalog === this.providerCatalog
      )
        return this.parsedConfig
      let parsed = parseProviderCatalog(raw)
      this.directoryEntries = entries
      this.providerCatalog = catalog
      this.optionRules =
        catalog?.modelsDoc.optionRules ?? (await this.recommendations.optionRules())
      this.catalogProtocolEndpoints = protocolEndpoints
      const defaults = new Map(entries.map((entry) => [entry.id, directoryProviderConfig(entry)]))
      if (parsed.schemaVersion <= PROVIDER_CONFIG_SCHEMA_VERSION) {
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
        }
        parsed = { ...parsed, providers }
      }
      this.directoryBaseProviders = new Map(
        await Promise.all(
          [...this.baseProviders].map(async ([id, source]): Promise<[string, RuntimeProvider]> => {
            const entry = catalog?.providersDoc.providers[id]
            if (entry) {
              const projected = await withCatalogProvider(source, entry, (model, binding) => {
                const kind =
                  binding.type ??
                  (binding.modelRef ? catalog?.modelsDoc.models[binding.modelRef]?.type : undefined)
                return this.enrichBuiltinModel(
                  id,
                  kind ? ({ ...model, modelType: kind } as ConfiguredRuntimeModel) : model,
                )
              })
              return [id, projected]
            }
            const getModels = () => source.getModels()
            const enriched = new Map(
              await Promise.all(
                getModels().map(
                  async (model) => [model.id, await this.enrichBuiltinModel(id, model)] as const,
                ),
              ),
            )
            return [
              id,
              {
                ...source,
                getModels: () => getModels().map((model) => enriched.get(model.id) ?? model),
              },
            ]
          }),
        ),
      )
      const custom = Object.entries(parsed.providers).filter(
        (entry): entry is [string, Extract<(typeof entry)[1], { kind: 'custom' }>] =>
          entry[1].kind === 'custom',
      )
      if (custom.length > 0 && !this.mutableRegistry) {
        throw new ModelServiceError(
          'CATALOG_REFRESH_FAILED',
          'The configured model registry is not mutable',
        )
      }
      for (const providerID of this.configuredCustomProviderIDs) {
        this.mutableRegistry?.deleteProvider(providerID)
      }
      const nextCustomProviderIDs = new Set<string>()
      for (const [providerID, provider] of custom) {
        this.mutableRegistry?.setProvider(
          createCustomProvider(providerID, await this.applyRecommendations(providerID, provider)),
        )
        nextCustomProviderIDs.add(providerID)
      }
      this.configuredCustomProviderIDs = nextCustomProviderIDs
      for (const [id, base] of this.directoryBaseProviders) {
        if (nextCustomProviderIDs.has(id)) continue
        const configured = parsed.providers[id]
        if (parsed.issues.some((issue) => issue.providerID === id) && this.configFingerprint)
          continue
        const source = base
        const catalogEntry = catalog?.providersDoc.providers[id]
        const defaultEndpoints = builtinProviderEndpoints(id, this.protocolDefaults(source))
        let runtimeConfig = configured
        if (configured?.kind === 'builtin') {
          const models = { ...configured.models }
          for (const [modelID, override] of Object.entries(models)) {
            if (!override.enabled) continue
            const native = source.getModels().find((model) => model.id === modelID)
            if (!native) continue
            const { api, baseUrl } = builtinModelConnection(
              native,
              configured,
              defaultEndpoints,
              catalogEntry,
            )
            if (
              override.smartConfig &&
              override.smartConfig.enabled !== false &&
              !override.smartConfig.pinned.length
            ) {
              const { recommended } = await this.recommendations.resolve({
                providerId: id,
                modelId: modelID,
                modelType: 'chat',
                baseUrl,
                api,
              })
              const document =
                override.smartConfig.source === 'document'
                  ? override.smartConfig.document?.data
                  : undefined
              const composed = applyRecommendation(
                applyRecommendation(
                  {
                    ...native,
                    ...override,
                    input: [...(override.input ?? native.input)] as CustomModelConfig['input'],
                    cost: { ...native.cost, ...override.cost },
                  },
                  recommended,
                ),
                document ?? {},
              )
              const optionSpecs = composeOptionSpecs(
                recommended,
                resolveModelOptionSpecsDetailed(
                  { modelId: modelID, api, baseUrl },
                  this.optionRules,
                ),
                declaredThinkingValues(composed.reasoning, composed.thinkingLevelMap),
              )
              const { pricing: _pricing, ...baseOverride } = override
              models[modelID] = {
                ...baseOverride,
                name: composed.name,
                contextWindow: composed.contextWindow,
                maxTokens: composed.maxTokens,
                reasoning: composed.reasoning,
                input: composed.input,
                cost: composed.cost,
                ...(composed.maxInputTokens !== undefined
                  ? { maxInputTokens: composed.maxInputTokens }
                  : {}),
                ...(composed.tools !== undefined ? { tools: composed.tools } : {}),
                ...(composed.modelType !== undefined ? { modelType: composed.modelType } : {}),
                ...(optionSpecs ? { optionSpecs } : {}),
                ...(composed.pricing ? { pricing: composed.pricing } : {}),
              }
              continue
            }
            // INVARIANT: 内置模型已由自维护清单热更新基线，仅协议或地址切换且未固定 optionSpecs 时重算 CEL map。
            if (!override.optionSpecs && (api !== native.api || baseUrl !== native.baseUrl)) {
              const { recommended } = await this.recommendations.resolve({
                providerId: id,
                modelId: modelID,
                modelType: 'chat',
                baseUrl,
                api,
              })
              if (
                recommended.optionSpecs ||
                recommended.reasoningLevels?.length ||
                (native as ConfiguredRuntimeModel).optionSpecs
              ) {
                const optionSpecs = composeOptionSpecs(
                  recommended,
                  resolveModelOptionSpecsDetailed(
                    { modelId: modelID, api, baseUrl },
                    this.optionRules,
                  ),
                  declaredThinkingValues(native.reasoning, native.thinkingLevelMap),
                )
                if (optionSpecs) models[modelID] = { ...override, optionSpecs }
              }
            }
          }
          runtimeConfig = { ...configured, models }
        }
        this.mutableRegistry?.setProvider(
          runtimeConfig?.kind === 'builtin'
            ? withBuiltinProviderOverrides(source, runtimeConfig, defaultEndpoints, catalogEntry)
            : withBuiltinProviderOverrides(
                source,
                { kind: 'builtin', enabled: true, allowModels: [], denyModels: [], models: {} },
                defaultEndpoints,
                catalogEntry,
              ),
        )
      }
      this.parsedConfig = parsed
      this.configFingerprint = fingerprint
      return parsed
    }
    this.syncOperation = this.syncOperation.then(operation, operation)
    return this.syncOperation
  }

  private protocolDefaults(
    provider: RuntimeProvider,
  ): Readonly<Record<string, string>> | undefined {
    const declared = this.catalogProtocolEndpoints[provider.id]
    if (declared || !this.providerCatalog) return declared
    return Object.fromEntries(
      provider
        .getModels()
        .filter((model) => model.baseUrl)
        .map((model) => [model.api, model.baseUrl]),
    )
  }

  private providerEnabled(providerID: string, config: ParsedProviderCatalog) {
    if (config.schemaVersion > PROVIDER_CONFIG_SCHEMA_VERSION) return false
    const provider = config.providers[providerID]
    if (!provider) return this.builtinProviderIDs.has(providerID)
    return provider.enabled
  }

  private modelEnabled(model: RuntimeModel<Api>, config: ParsedProviderCatalog) {
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
    return (
      provider.models[model.id]?.enabled !== false &&
      (provider.models[model.id] !== undefined || provider.allowModels.includes(model.id))
    )
  }

  private assertActive() {
    if (this.disposed) throw new ModelServiceError('DISPOSED', 'Model service has been disposed')
  }
}

const isMutableModels = (models: Models): models is MutableModels =>
  'setProvider' in models &&
  typeof (models as Partial<MutableModels>).setProvider === 'function' &&
  'deleteProvider' in models &&
  typeof (models as Partial<MutableModels>).deleteProvider === 'function'
