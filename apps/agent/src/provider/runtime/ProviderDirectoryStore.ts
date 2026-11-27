import { AgentError } from '../../Domain'
import { CatalogV2Cache, type CatalogV2CacheOptions } from './CatalogV2Cache'
import { providerEndpointIndex, resolveCatalogEndpoint, selectCatalogProtocol } from './CatalogV2'
import {
  CUSTOM_PROVIDER_APIS,
  parseProviderCatalog,
  validateCustomProviderBaseUrl,
  type CustomProviderApi,
  type CustomProviderConfig,
} from './ProviderConfig'

export type DirectoryProvider = {
  id: string
  name: string
  origin: 'pi-remote' | 'models-dev'
  baseUrl?: string
  api?: CustomProviderApi
  env: string[]
  models: Record<string, Record<string, unknown>>
  endpoints?: Partial<Record<CustomProviderApi, string>>
  modelBaseUrls?: Record<string, string>
}
const supported = (api: unknown): api is CustomProviderApi =>
  typeof api === 'string' && (CUSTOM_PROVIDER_APIS as readonly string[]).includes(api)
const address = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    return validateCustomProviderBaseUrl(value, false)
  } catch {
    return undefined
  }
}
export const directoryBaseUrlKey = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
      return undefined
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}${url.search}`
  } catch {
    return undefined
  }
}

export const directoryProviderConfig = (
  entry: DirectoryProvider,
): CustomProviderConfig | undefined => {
  if (!entry.api || !entry.baseUrl) return undefined
  const parsed = parseProviderCatalog({
    schemaVersion: 2,
    providers: {
      'pidex-directory-default': {
        kind: 'custom',
        name: entry.name,
        base_url: entry.baseUrl,
        env: entry.env,
        auth: 'api-key',
        models: entry.models,
        endpoints: { [entry.api]: entry.baseUrl, ...entry.endpoints },
      },
    },
  })
  const config = parsed.providers['pidex-directory-default']
  if (parsed.issues.length || config?.kind !== 'custom')
    throw new Error(
      `Invalid directory provider configuration: ${entry.id}: ${parsed.issues.map((issue) => issue.path).join(', ')}`,
    )
  return config
}

type SnapshotV2 = NonNullable<Awaited<ReturnType<CatalogV2Cache['current']>>>
const EMPTY_DIRECTORY: readonly DirectoryProvider[] = []

export class ProviderDirectoryStore {
  private readonly cache: CatalogV2Cache
  private projection:
    | {
        snapshot: SnapshotV2
        entries: DirectoryProvider[]
        endpoints: ReturnType<typeof providerEndpointIndex>
      }
    | undefined

  constructor(
    path?: string,
    private readonly request: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
    options: CatalogV2CacheOptions = {},
  ) {
    this.cache = CatalogV2Cache.forPath(path, options)
  }

  catalog() {
    return this.cache.current()
  }

  private async project() {
    const current = await this.catalog()
    if (!current) return undefined
    if (this.projection?.snapshot === current) return this.projection
    const entries: DirectoryProvider[] = []
    for (const [id, provider] of Object.entries(current.providersDoc.providers)) {
      if (!provider.marketVisible) continue
      const endpoints: NonNullable<DirectoryProvider['endpoints']> = {}
      for (const [api, raw] of Object.entries(provider.protocolEndpoints)) {
        const url = address(raw)
        if (supported(api) && url) endpoints[api] = url
      }
      const api = supported(provider.defaultProtocol) ? provider.defaultProtocol : undefined
      const baseUrl = api ? endpoints[api] : undefined
      const models: DirectoryProvider['models'] = {}
      const modelBaseUrls: Record<string, string> = {}
      for (const [modelID, binding] of Object.entries(provider.models)) {
        const kind =
          binding.type ??
          (binding.modelRef ? current.modelsDoc.models[binding.modelRef]?.type : undefined) ??
          'chat'
        const modelApi = selectCatalogProtocol(provider, binding)
        if (!supported(modelApi)) continue
        const { recommended } = current.index.resolve({
          providerId: id,
          modelId: modelID,
          modelType: kind,
        })
        if (recommended.catalog?.status === 'deprecated') continue
        models[modelID] = {
          api: modelApi,
          name: recommended.name ?? binding.name ?? modelID,
          contextWindow: recommended.contextWindow ?? (kind === 'chat' ? 32_768 : 8_192),
          maxTokens: recommended.maxTokens ?? 8_192,
          reasoning: recommended.reasoning ?? false,
          input: recommended.input ?? ['text'],
          ...(kind !== 'chat' ? { modelType: kind } : {}),
          ...(recommended.optionSpecs ? { optionSpecs: recommended.optionSpecs } : {}),
          ...(recommended.cost ? { cost: recommended.cost } : {}),
          ...(binding.compat ? { compat: binding.compat } : {}),
          ...(binding.thinkingLevelMap ? { thinkingLevelMap: binding.thinkingLevelMap } : {}),
        }
        const url = !binding.api || binding.api === modelApi ? address(binding.baseUrl) : undefined
        if (url) modelBaseUrls[modelID] = url
      }
      entries.push({
        id,
        name: provider.name,
        origin: 'pi-remote',
        env: provider.env ?? [],
        ...(api ? { api } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        endpoints,
        models,
        modelBaseUrls,
      })
    }
    return (this.projection = {
      snapshot: current,
      entries,
      endpoints: providerEndpointIndex(current.providersDoc),
    })
  }

  async providers(): Promise<readonly DirectoryProvider[]> {
    return (await this.project())?.entries ?? EMPTY_DIRECTORY
  }

  async resolveProviderByBaseUrl(url: string) {
    const endpoints = (await this.project())?.endpoints
    return endpoints ? resolveCatalogEndpoint(endpoints, url) : undefined
  }

  async protocolEndpoints(): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>> {
    const providers = (await this.catalog())?.providersDoc.providers ?? {}
    return Object.fromEntries(
      Object.entries(providers).map(([id, provider]) => [
        id,
        Object.fromEntries(
          Object.entries(provider.protocolEndpoints).flatMap(([api, raw]) => {
            const url = address(raw)
            return url ? [[api, url]] : []
          }),
        ),
      ]),
    )
  }

  async refresh(): Promise<void> {
    try {
      await this.cache.refresh(this.request)
    } catch {
      throw new AgentError(
        'PROVIDER_UNAVAILABLE',
        '模型清单官方目录下载失败，已保留原目录，请稍后重试。',
        502,
      )
    }
  }
}
