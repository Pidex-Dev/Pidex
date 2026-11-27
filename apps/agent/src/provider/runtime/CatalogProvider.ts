import { createProvider, type Api, type Model, type Provider } from '@earendil-works/pi-ai'
import {
  type CatalogBinding,
  type CatalogProviderV2,
  catalogEndpoint,
  selectCatalogProtocol,
} from './CatalogV2'
import { providerApiStreams } from './ProviderApis'
import type { CustomProviderApi } from './ProviderConfig'

/** Projects provider bindings onto Pi while retaining native credential resolution and transport. */
export async function withCatalogProvider(
  source: Provider,
  entry: CatalogProviderV2,
  enrich: (model: Model<Api>, binding: CatalogBinding) => Promise<Model<Api>>,
): Promise<Provider> {
  const native = source.getAllModels?.() ?? source.getModels()
  const nativeById = new Map(native.map((model) => [model.id, model]))
  const nativeApis = new Set(native.map((model) => model.api))
  const models = await Promise.all(
    Object.entries(entry.models).flatMap(([id, binding]) => {
      const preferred = (binding.api ?? entry.defaultProtocol) as Api | undefined
      const api =
        (selectCatalogProtocol(entry, binding) as Api | undefined) ??
        (preferred && !binding.supportedProtocols && nativeApis.has(preferred)
          ? preferred
          : undefined)
      if (!api) return []
      const previous = nativeById.get(id)
      const baseUrl = catalogEndpoint(
        (preferred === api && binding.baseUrl) || entry.protocolEndpoints[api],
      )
      const type = binding.type ?? 'chat'
      // INVARIANT: Some Pi transports resolve their endpoint at request time. Only native transports can omit a URL.
      if (!baseUrl && !nativeApis.has(api)) return []
      const model: Model<Api> = {
        id,
        provider: source.id,
        api,
        name: binding.name ?? id,
        type: 'chat',
        baseUrl: baseUrl ?? '',
        input: ['text'],
        reasoning: false,
        contextWindow: 32_768,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(binding.type ? { modelType: type } : {}),
        ...(previous?.headers ? { headers: previous.headers } : {}),
        ...(preferred === api && binding.compat ? { compat: binding.compat } : {}),
        ...(binding.thinkingLevelMap ? { thinkingLevelMap: binding.thinkingLevelMap } : {}),
      } as Model<Api>
      return [enrich(model, binding)]
    }),
  )
  const adapters = createProvider({
    id: source.id,
    auth: source.auth,
    models: [],
    ...(source.headers ? { headers: source.headers } : {}),
    api: Object.fromEntries(
      Object.entries(providerApiStreams).map(([api, streams]) => [api, streams()]),
    ),
  })
  const implementation = (api: Api) =>
    !nativeApis.has(api) && Object.hasOwn(providerApiStreams, api as CustomProviderApi)
      ? adapters
      : source
  const { refreshModels: _refreshModels, ...base } = source
  return {
    ...base,
    name: entry.name,
    baseUrl: entry.defaultProtocol
      ? catalogEndpoint(entry.protocolEndpoints[entry.defaultProtocol])
      : undefined,
    getModels: () => models,
    getAllModels: () => models,
    stream: (model, context, options) => implementation(model.api).stream(model, context, options),
    streamSimple: (model, context, options) =>
      implementation(model.api).streamSimple(model, context, options),
  } as Provider
}
