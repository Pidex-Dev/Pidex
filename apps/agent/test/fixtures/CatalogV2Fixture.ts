import { createHash } from 'node:crypto'
import type { Model } from '@pidex/model-schema'
import type { ModelsV2, ProvidersV2 } from '../../src/provider/runtime/CatalogV2'

const header = {
  owner: 'pidex-model-catalog',
  schemaVersion: 2,
  generatedAt: '2026-11-23T00:00:00.000Z',
  piVersion: '0.99.2',
} as const

type Rates = { input?: number; output?: number; cache_read?: number; cache_write?: number }
type Facts = {
  name?: string
  type?: string
  canonical_model_id?: string
  aliases?: string[]
  base_url?: string
  pi_api?: string
  provider?: { npm?: string; api?: string; shape?: string }
  pricing?: Model.Pricing
  cost?: Rates & { context_over_200k?: Rates; tiers?: (Rates & { tier: { size: number } })[] }
  compat?: Record<string, unknown>
  thinking_level_map?: Record<string, string | null>
}
type Snapshot = {
  models?: Record<string, Facts>
  providers?: Record<
    string,
    {
      name?: string
      api?: string
      npm?: string
      env?: string[]
      marketVisible?: boolean
      endpoints?: string[]
      protocolEndpoints?: Record<string, string>
      models?: Record<string, Facts>
    }
  >
}

function fixturePrice(facts: Facts) {
  if (facts.pricing) return facts.pricing
  if (!facts.cost) return undefined
  const rates = (value: Rates) => ({
    input: value.input ?? null,
    output: value.output ?? null,
    cacheRead: value.cache_read ?? null,
    cacheWrite: value.cache_write ?? null,
  })
  const tiers =
    facts.cost.tiers ??
    (facts.cost.context_over_200k
      ? [{ ...facts.cost.context_over_200k, tier: { size: 200_000 } }]
      : [])
  return {
    busy: {
      ...rates(facts.cost),
      ...(tiers.length
        ? {
            tiers: tiers.map((tier) => ({ ...rates(tier), inputTokensAbove: tier.tier.size })),
          }
        : {}),
    },
  }
}

export function fixtureV2(raw: unknown): { models: ModelsV2; providers: ProvidersV2 } {
  const source = raw as Snapshot
  const models: ModelsV2['models'] = {}
  const providers: ProvidersV2['providers'] = {}
  const asModel = (id: string, facts: Facts): ModelsV2['models'][string] => ({
    ...facts,
    id,
    vendor: id.split('/')[0]!,
    name: facts.name ?? id,
    type:
      facts.type === 'embedding'
        ? 'embedding'
        : ['rerank', 'reranking'].includes(facts.type ?? '')
          ? 'rerank'
          : 'chat',
    providers: {},
  })
  for (const [id, facts] of Object.entries(source.models ?? {})) models[id] = asModel(id, facts)
  for (const [providerId, rawProvider] of Object.entries(source.providers ?? {})) {
    const endpoints = { ...rawProvider.protocolEndpoints }
    const defaultApi =
      Object.entries(endpoints).find(([, address]) => address === rawProvider.api)?.[0] ??
      Object.keys(endpoints)[0] ??
      (rawProvider.npm === '@ai-sdk/anthropic' ? 'anthropic-messages' : 'openai-completions')
    if (rawProvider.api) endpoints[defaultApi] ??= rawProvider.api
    const provider: ProvidersV2['providers'][string] = {
      name: rawProvider.name ?? providerId,
      marketVisible: rawProvider.marketVisible ?? false,
      defaultProtocol: Object.keys(endpoints).length ? defaultApi : undefined,
      protocolEndpoints: endpoints,
      endpointAliases: rawProvider.endpoints,
      env: rawProvider.env,
      models: {},
    }
    providers[providerId] = provider
    for (const [id, facts] of Object.entries(rawProvider.models ?? {})) {
      const direct = models[id]
        ? id
        : Object.keys(models).find((key) => key.split('/').at(-1) === id)
      const ref =
        facts.canonical_model_id ?? direct ?? (id.includes('/') ? id : providerId + '/' + id)
      const model = (models[ref] ??= asModel(ref, facts))
      const api =
        facts.pi_api ?? (facts.provider?.shape === 'responses' ? 'openai-responses' : defaultApi)
      const baseUrl = facts.base_url ?? facts.provider?.api
      if (baseUrl) endpoints[api] ??= baseUrl
      provider.defaultProtocol ??= api
      provider.models[id] = {
        modelRef: ref,
        name: facts.name,
        aliases: facts.aliases,
        api,
        baseUrl,
        compat: facts.compat,
        thinkingLevelMap: facts.thinking_level_map,
      }
      const pricing = fixturePrice(facts)
      model.providers[providerId] = {
        available: true,
        providerModelId: id,
        pricing,
        overrides: facts as Record<string, unknown>,
      }
      if (model.vendor === providerId && pricing) {
        model.referencePricing = { sourceProviderId: providerId, pricing }
      }
    }
  }
  return {
    models: { ...header, models, pricingSchedules: {} },
    providers: { ...header, providers },
  }
}

export const respondV2 = (
  url: string | URL | Request,
  fixture: ReturnType<typeof fixtureV2>,
  headers?: HeadersInit,
) => {
  const path = new URL(String(url)).pathname.split('/').at(-1)
  const file = (key: 'providers' | 'models') => {
    const text = JSON.stringify(fixture[key])
    return {
      path: key + '.json',
      text,
      sha256: createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text),
    }
  }
  if (path === 'manifest.json') {
    const { text: _providers, ...providers } = file('providers')
    const { text: _models, ...models } = file('models')
    return Response.json(
      { ...header, files: { providers, models } },
      headers ? { headers } : undefined,
    )
  }
  if (path === 'providers.json' || path === 'models.json') {
    return new Response(file(path === 'models.json' ? 'models' : 'providers').text)
  }
  throw new Error('Unexpected v2 catalog fixture URL: ' + path)
}

export const fixtureV2Fetch = (source: () => unknown) => async (url: string | URL | Request) =>
  respondV2(url, fixtureV2(source()))
