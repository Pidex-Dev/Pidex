import { createProvider, type Api, type Model, type Provider } from '@earendil-works/pi-ai'
import { builtinProviderEndpoints, type PiBuiltinProviderConfig } from './PiProviderConfig'
import { piProviderApiStreams } from './PiProviderApis'
import { isOtherCatalogProtocolEndpoint, type CatalogProviderV2 } from './CatalogV2'

export function builtinBaseUrlOverride(
  providerId: string,
  baseUrl: string | undefined,
  api: string | undefined,
  defaultEndpoints: Readonly<Record<string, string>> = {},
) {
  if (
    baseUrl &&
    api &&
    (isOtherCatalogProtocolEndpoint(baseUrl, api, defaultEndpoints) ||
      isOtherCatalogProtocolEndpoint(baseUrl, api, builtinProviderEndpoints(providerId)))
  )
    return undefined
  return baseUrl
}

export function builtinModelConnection(
  model: Model<Api>,
  config: PiBuiltinProviderConfig,
  defaultEndpoints?: Readonly<Record<string, string>>,
  catalog?: CatalogProviderV2,
) {
  const binding = catalog?.models[model.id]
  const api = binding ? model.api : (config.models[model.id]?.api ?? model.api)
  const baseUrl =
    !binding?.supportedProtocols || api === catalog?.defaultProtocol
      ? builtinBaseUrlOverride(model.provider, config.baseUrl, api, defaultEndpoints)
      : undefined
  return {
    api,
    baseUrl:
      config.endpoints?.[api] ??
      baseUrl ??
      (!catalog || api !== model.api ? defaultEndpoints?.[api] : undefined) ??
      model.baseUrl,
  }
}

/** Keep native auth, discovery and transport while applying explicit user overrides. */
export function withPiBuiltinProviderOverrides(
  source: Provider<Api>,
  config: PiBuiltinProviderConfig,
  defaultEndpoints?: Readonly<Record<string, string>>,
  catalog?: CatalogProviderV2,
): Provider<Api> {
  const configuredExtraIds = catalog
    ? []
    : [
        ...new Set([
          ...Object.entries(config.models)
            .filter(([, override]) => override.enabled !== false)
            .map(([id]) => id),
          ...config.allowModels.filter(
            (id) => !config.denyModels.includes(id) && config.models[id]?.enabled !== false,
          ),
        ]),
      ]
  const nativeModels = source.getModels()
  const knownIds = new Set(nativeModels.map((model) => model.id))
  const hasMissingConfiguredModels = configuredExtraIds.some((id) => !knownIds.has(id))
  const hasDefaultEndpointOverride =
    !catalog &&
    !!defaultEndpoints &&
    nativeModels.some(
      (model) =>
        defaultEndpoints[model.api] !== undefined && defaultEndpoints[model.api] !== model.baseUrl,
    )
  if (
    !config.baseUrl &&
    !config.endpoints &&
    !hasMissingConfiguredModels &&
    !hasDefaultEndpointOverride &&
    Object.values(config.models).every((model) =>
      Object.keys(model).every((key) => key === 'enabled'),
    )
  )
    return source
  const mapped = new WeakMap<Model<Api>, Model<Api>>()
  const getModels = () => {
    const original = source.getModels()
    const models = original.map((model) => {
      let result = mapped.get(model)
      if (!result) {
        const { enabled: _, compat, ...override } = config.models[model.id] ?? { enabled: true }
        const { api, baseUrl } = builtinModelConnection(model, config, defaultEndpoints, catalog)
        result = {
          ...model,
          ...override,
          ...(override.input ? { inputExplicit: true } : {}),
          api,
          baseUrl,
          input: [...(override.input ?? model.input)] as Model<Api>['input'],
          cost: { ...model.cost, ...override.cost },
        }
        if (compat && (!override.api || override.api === api)) result.compat = compat
        else if (api !== model.api) delete result.compat
        mapped.set(model, result)
      }
      return result
    })
    const known = new Set(original.map((model) => model.id))
    const template: Model<Api> = original[0] ?? {
      type: 'chat',
      id: '',
      name: '',
      provider: source.id,
      baseUrl: config.baseUrl ?? source.baseUrl ?? '',
      api: 'openai-completions',
      contextWindow: 32_768,
      maxTokens: 8_192,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    // INVARIANT: 已配置模型即使从上游目录或 Pi 下架，也按供应商协议模板兜底保留，不凭空消失。
    for (const id of configuredExtraIds) {
      if (known.has(id)) continue
      const { enabled: _, ...override } = config.models[id] ?? { enabled: true }
      const model = {
        ...template,
        ...override,
        ...(override.input ? { inputExplicit: true } : {}),
        input: [...(override.input ?? template.input)] as Model<Api>['input'],
        cost: { ...template.cost, ...override.cost },
        id,
        name: override.name ?? id,
      }
      if (model.api !== template.api && !(override.api === model.api && override.compat))
        delete model.compat
      model.baseUrl = builtinModelConnection(model, config, defaultEndpoints).baseUrl
      models.push(model)
    }
    return models
  }
  const adapters = createProvider({
    id: source.id,
    name: source.name,
    auth: source.auth,
    ...(source.headers ? { headers: source.headers } : {}),
    models: [],
    api: Object.fromEntries(
      Object.entries(piProviderApiStreams).map(([api, stream]) => [api, stream()]),
    ),
  })
  const changedApi = (model: Model<Api>) => {
    if (catalog) return false
    const original =
      source.getModels().find((item) => item.id === model.id) ?? source.getModels()[0]
    return model.api !== original?.api && model.api in piProviderApiStreams
  }
  const endpointModel = (model: Model<Api>) => {
    if (catalog) return model
    const baseUrl =
      config.endpoints?.[model.api as keyof NonNullable<typeof config.endpoints>] ??
      builtinBaseUrlOverride(source.id, config.baseUrl, model.api, defaultEndpoints) ??
      defaultEndpoints?.[model.api]
    return baseUrl ? { ...model, baseUrl } : model
  }
  const defaultApi = catalog?.defaultProtocol ?? nativeModels[0]?.api
  const baseUrl =
    (defaultApi ? config.endpoints?.[defaultApi] : undefined) ??
    builtinBaseUrlOverride(source.id, config.baseUrl, defaultApi, defaultEndpoints)
  return {
    ...source,
    ...(baseUrl ? { baseUrl } : {}),
    getModels,
    getAllModels: () => [
      ...getModels(),
      ...(!catalog ? (source.getAllModels?.().filter((model) => model.type !== 'chat') ?? []) : []),
    ],
    stream: (model, context, options) =>
      changedApi(model)
        ? adapters.stream(endpointModel(model), context, options)
        : source.stream(endpointModel(model), context, options),
    streamSimple: (model, context, options) =>
      changedApi(model)
        ? adapters.streamSimple(endpointModel(model), context, options)
        : source.streamSimple(endpointModel(model), context, options),
  }
}
