import { Model } from '@pidex/model-schema'
import { z } from 'zod'
import { validatePricing, ZERO_PRICES } from '../ModelPricing'

const Header = z.object({
  owner: z.literal('pidex-model-catalog'),
  schemaVersion: z.literal(2),
  generatedAt: z.iso.datetime(),
  piVersion: z.string().min(1),
})
const Blob = z.object({
  sha256: z.hash('sha256'),
  bytes: z
    .int()
    .positive()
    .max(64 * 1024 * 1024),
})
export const ManifestV2 = Header.extend({
  files: z.object({
    providers: Blob.extend({ path: z.literal('providers.json') }),
    models: Blob.extend({ path: z.literal('models.json') }),
  }),
})
export type ManifestV2 = z.infer<typeof ManifestV2>

const BillingMode = z.enum(['pay-as-you-go', 'subscription', 'free'])
const ModelType = z.enum(['chat', 'embedding', 'rerank'])
const V2Api = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'openai-embeddings',
  'jina-rerank',
  'azure-openai-responses',
  'bedrock-converse-stream',
  'google-vertex',
  'mistral-conversations',
  'openai-codex-responses',
  'pi-messages',
])
const JsonObject = z.record(z.string(), z.unknown())
const Invocation = z.object({
  requestModelId: z.string().min(1).optional(),
  payloadPatch: JsonObject.optional(),
})
const tiers = <T extends z.ZodType>(tier: T) =>
  z.object({
    standard: tier.optional(),
    fast: tier.optional(),
    ultrafast: tier.optional(),
  })
const Binding = z.object({
  modelRef: z.string().optional(),
  name: z.string().optional(),
  type: ModelType.optional(),
  aliases: z.array(z.string()).optional(),
  api: z.string().optional(),
  supportedProtocols: z.array(V2Api).optional(),
  baseUrl: z.string().optional(),
  compat: JsonObject.optional(),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
  speedTiers: tiers(Invocation).optional(),
  routerFallback: z.looseObject({ billingMode: BillingMode.optional() }).optional(),
})
const Provider = z.object({
  name: z.string(),
  marketVisible: z.boolean(),
  defaultProtocol: z.string().optional(),
  protocolEndpoints: z.record(z.string(), z.string()),
  endpointAliases: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(),
  billingMode: BillingMode.optional(),
  models: z.record(z.string(), Binding),
})
const CompactPricing = z.looseObject({
  scheduleId: z.string().optional(),
  billingMode: BillingMode.optional(),
})
const OfferingDetails = z.object({
  reasoningCost: z.number().nonnegative().optional(),
  inputAudioCost: z.number().nonnegative().optional(),
  outputAudioCost: z.number().nonnegative().optional(),
  pricing: CompactPricing.optional(),
  overrides: JsonObject.optional(),
  speedTiers: tiers(
    z.object({
      label: z.string().optional(),
      speedMultiplier: z.number().positive().optional(),
      pricing: CompactPricing,
    }),
  ).optional(),
})
const Offering = OfferingDetails.extend({
  available: z.boolean(),
  providerModelId: z.string().optional(),
  modelOverrides: z.record(z.string(), OfferingDetails).optional(),
})
const Knowledge = z.looseObject({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  type: ModelType,
  aliases: z.array(z.string()).optional(),
  referencePricing: z.object({ sourceProviderId: z.string(), pricing: CompactPricing }).optional(),
  providers: z.record(z.string(), Offering),
})
export const ProvidersV2 = Header.extend({ providers: z.record(z.string(), Provider) })
export const OptionRule = z.object({
  modelMatch: z.string(),
  apiTypeMatch: z.string().optional(),
  baseUrlMatch: z.string().optional(),
  optionSpecs: z.object({
    reasoningLevel: z
      .object({ values: z.array(z.string()).optional(), map: z.string().optional() })
      .optional(),
    maxOutputTokens: z
      .object({ max: z.int().positive().optional(), map: z.string().optional() })
      .optional(),
  }),
})
export type OptionRule = z.infer<typeof OptionRule>
export const ModelsV2 = Header.extend({
  optionRules: z.array(OptionRule).optional(),
  pricingSchedules: z.record(z.string(), JsonObject),
  models: z.record(z.string(), Knowledge),
})
export type CatalogProviderV2 = z.infer<typeof Provider>
export type CatalogKnowledge = z.infer<typeof Knowledge>
export type CatalogOffering = z.infer<typeof Offering>
export type CatalogBinding = z.infer<typeof Binding>
export type SpeedTierInvocation = z.infer<typeof Invocation>
export type ProvidersV2 = z.infer<typeof ProvidersV2>
export type ModelsV2 = z.infer<typeof ModelsV2>

export function supportsCatalogProtocol(binding: CatalogBinding | undefined, api: string) {
  return binding?.supportedProtocols?.some((protocol) => protocol === api) ?? true
}

export function selectCatalogProtocol(
  provider: CatalogProviderV2,
  binding: CatalogBinding,
  requested?: string,
  availableApis?: ReadonlySet<string>,
) {
  const preferred = binding.api ?? provider.defaultProtocol
  const available = (api: string) =>
    availableApis
      ? availableApis.has(api)
      : Boolean(catalogEndpoint(provider.protocolEndpoints[api]) ||
          (preferred === api && catalogEndpoint(binding.baseUrl)))
  const candidates =
    requested === undefined
      ? [binding.api, ...(binding.supportedProtocols ?? []), provider.defaultProtocol]
      : [requested]
  return candidates.find(
    (api) => api !== undefined && supportsCatalogProtocol(binding, api) && available(api),
  )
}

export function catalogBinding(provider: CatalogProviderV2 | undefined, id: string) {
  if (!provider) return undefined
  if (Object.hasOwn(provider.models, id)) return { id, binding: provider.models[id]! }
  const name = id.toLowerCase()
  for (const [key, binding] of Object.entries(provider.models)) {
    if (
      key.toLowerCase() === name ||
      binding.aliases?.some((alias) => alias.toLowerCase() === name)
    )
      return { id: key, binding }
  }
  return undefined
}

export function catalogEndpoint(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash)
      return undefined
    return parsed.href
  } catch {
    return undefined
  }
}

function endpointKey(url?: string) {
  const value = catalogEndpoint(url)
  if (!value) return undefined
  const { origin, pathname } = new URL(value)
  return origin + pathname.replace(/\/+$/, '').toLowerCase()
}

export function isOtherCatalogProtocolEndpoint(
  url: string,
  api: string,
  endpoints: Readonly<Record<string, string>>,
) {
  const key = endpointKey(url)
  return (
    key !== undefined &&
    key !== endpointKey(endpoints[api]) &&
    Object.values(endpoints).some((endpoint) => endpointKey(endpoint) === key)
  )
}

export function providerEndpointIndex(document: ProvidersV2): ReadonlyMap<string, string | null> {
  const endpoints = new Map<string, string | null>()
  for (const [id, provider] of Object.entries(document.providers)) {
    for (const url of [
      ...Object.values(provider.protocolEndpoints),
      ...(provider.endpointAliases ?? []),
      ...Object.values(provider.models).map((binding) => binding.baseUrl),
    ]) {
      const key = endpointKey(url)
      if (!key) continue
      const previous = endpoints.get(key)
      endpoints.set(key, previous === undefined || previous === id ? id : null)
    }
  }
  return endpoints
}

export function resolveCatalogEndpoint(index: ReadonlyMap<string, string | null>, url?: string) {
  const key = endpointKey(url)
  return key ? (index.get(key) ?? undefined) : undefined
}

export function expandCatalogPricing(
  document: ModelsV2,
  pricing: z.infer<typeof CompactPricing>,
): Model.Pricing {
  const { scheduleId, ...overrides } = pricing
  const schedule = scheduleId === undefined ? undefined : document.pricingSchedules[scheduleId]
  if (scheduleId !== undefined && !schedule)
    throw new Error('Unknown model catalog pricing schedule')
  const busy =
    pricing.busy ??
    (pricing.billingMode === 'subscription' || pricing.billingMode === 'free'
      ? ZERO_PRICES
      : undefined)
  return validatePricing({
    currency: 'USD',
    timeZone: 'UTC',
    defaultPeriod: 'busy',
    rules: [],
    dateOverrides: [],
    ...schedule,
    ...overrides,
    busy,
    idle: pricing.idle ?? busy,
  })
}
