import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  calculateCost,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai'
import { ModelService } from '../src/provider/runtime/ModelService'
import type { ProviderCredentialRepository } from '../src/auth/ProviderCredentialRepository'
import { describe, test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProviderDirectoryStore } from '../src/provider/runtime/ProviderDirectoryStore'
import { ModelRecommendationStore } from '../src/provider/runtime/ModelRecommendationStore'
import { fixtureV2, respondV2 } from './fixtures/CatalogV2Fixture'
import { Database } from 'bun:sqlite'
import { Effect } from 'effect'
import type { Model } from '@pidex/model-schema'
import { selectPricing, validatePricing, type CalendarYear } from '../src/provider/ModelPricing'
import { ModelPricingService } from '../src/provider/ModelPricingService'
import { observeCacheWriteUsage } from '../src/provider/runtime/CacheWriteUsage'
import {
  ModelPricingRepository,
  MODEL_PRICING_SCHEMA,
} from '../src/storage/repositories/ModelPricingRepository'
import { isPublicAddress, extractedModelSchema } from '../src/provider/ModelDocumentService'
import type { Api, Model as RuntimeModel, AssistantMessage } from '@earendil-works/pi-ai'
const prices = { input: 1, output: 4, cacheRead: 0.02, cacheWrite: null }
const pricing: Model.Pricing = {
  currency: 'CNY',
  timeZone: 'Asia/Shanghai',
  defaultPeriod: 'idle',
  idle: prices,
  busy: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: null },
  rules: [
    {
      period: 'busy',
      weekdays: [1, 2, 3, 4, 5],
      holiday: 'exclude-cn',
      intervals: [
        { start: '09:00', end: '12:00' },
        { start: '14:00', end: '18:00' },
      ],
    },
  ],
  dateOverrides: [],
}
const calendar: CalendarYear = {
  year: 2026,
  papers: ['https://www.gov.cn/'],
  days: [
    { date: '2026-10-01', isOffDay: true, name: '国庆节' },
    { date: '2026-10-10', isOffDay: false, name: '国庆节' },
  ],
}
const select = (date: string, value = pricing, years = [calendar]) =>
  selectPricing(value, Date.parse(date + '+08:00'), years)
describe('busy / idle billing', () => {
  test('DeepSeek boundaries, lunch, weekends, holidays and weekend makeup', () => {
    validatePricing(pricing)
    for (const [clock, period] of [
      ['08:59', 'idle'],
      ['09:00', 'busy'],
      ['11:59', 'busy'],
      ['12:00', 'idle'],
      ['13:59', 'idle'],
      ['14:00', 'busy'],
      ['17:59', 'busy'],
      ['18:00', 'idle'],
    ] as const)
      expect(select(`2026-11-09T${clock}:00`).period).toBe(period)
    expect(select('2026-11-08T10:00:00').period).toBe('idle')
    expect(select('2026-10-01T10:00:00').period).toBe('idle')
    expect(select('2026-10-10T10:00:00').period).toBe('idle')
  })
  test('cross midnight uses start date, including year boundary', () => {
    const cross = {
      ...pricing,
      rules: [
        {
          period: 'busy' as const,
          weekdays: [4],
          holiday: 'any' as const,
          intervals: [{ start: '23:00', end: '02:00' }],
        },
      ],
    }
    expect(select('2027-01-01T01:59:00', cross).period).toBe('busy')
    expect(select('2027-01-01T02:00:00', cross).period).toBe('idle')
  })
  test('date override precedes missing calendar; otherwise conservative', () => {
    expect(select('2026-11-09T10:00:00', pricing, []).period).toBe('conservative')
    expect(
      select(
        '2026-11-09T10:00:00',
        { ...pricing, dateOverrides: [{ date: '2026-11-09', period: 'idle' }] },
        [],
      ).period,
    ).toBe('idle')
  })
  test('conflicting periods reject with rule numbers; same period overlap is one price', () => {
    expect(() =>
      validatePricing({
        ...pricing,
        rules: [...pricing.rules, { ...pricing.rules[0]!, period: 'idle' }],
      }),
    ).toThrow('规则 1 与 2')
    const duplicated = { ...pricing, rules: [...pricing.rules, pricing.rules[0]!] }
    validatePricing(duplicated)
    expect(select('2026-11-09T10:00:00', duplicated).prices.input).toBe(2)
    expect(() => validatePricing({ ...pricing, timeZone: 'nonsense' })).toThrow('时区')
    expect(() =>
      validatePricing({ ...pricing, dateOverrides: [{ date: '2026-02-30', period: 'idle' }] }),
    ).toThrow('无效日期')
  })
})
test('per-request FX and period snapshots stay frozen and unknown is distinct from zero', async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(MODEL_PRICING_SCHEMA.join(';'))
  const repository = new ModelPricingRepository(sqlite)
  let now = Date.parse('2026-11-09T08:59:00+08:00'),
    requests = 0
  const fetcher = (async () => {
    requests++
    throw new Error('offline')
  }) as unknown as typeof fetch
  const service = new ModelPricingService(repository, fetcher, () => now)
  const model = {
    provider: 'test',
    id: 'test',
    api: 'openai-completions',
    pricing,
    cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
  } as unknown as RuntimeModel<Api> & { pricing: Model.Pricing }
  const unknown = service.begin(model)
  const message = {
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  } as AssistantMessage
  unknown.annotate(message)
  expect((message.usage as unknown as { costUnknown: boolean }).costUnknown).toBe(true)
  repository.cache('fx:CNY:USD', { rate: 0.15, date: '2026-11-09', source: 'Frankfurter' }, now)
  repository.cache('calendar:2026', calendar, now)
  const idle = service.begin(model)
  now = Date.parse('2026-11-09T09:00:00+08:00')
  const busy = service.begin(model)
  expect(idle.model.cost.input).toBe(0.15)
  expect(busy.model.cost.input).toBe(0.3)
  expect(model.cost.input).toBe(99)
  repository.cache('fx:CNY:USD', { rate: 0.2, date: '2026-11-10', source: 'Frankfurter' }, now)
  expect(idle.model.cost.input).toBe(0.15)
  const snapshots = sqlite
    .query('SELECT payload FROM model_price_snapshots ORDER BY created_at')
    .all() as { payload: string }[]
  expect(snapshots).toHaveLength(3)
  expect(JSON.parse(snapshots[1]!.payload).fx.rate).toBe(0.15)
  const free = service.begin({
    ...model,
    pricing: {
      ...pricing,
      currency: 'USD',
      idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      busy: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  })
  free.annotate(message)
  expect((message.usage as unknown as { costUnknown: boolean }).costUnknown).toBe(false)
  await service.refresh()
  expect(requests).toBeLessThan(8)
  sqlite.close()
})
test('document boundary rejects private and mapped addresses and strips executable fields', () => {
  for (const host of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
  ])
    expect(isPublicAddress(host)).toBe(false)
  expect(isPublicAddress('8.8.8.8')).toBe(true)
  const result = extractedModelSchema.parse({
    modelId: 'test',
    data: {
      contextWindow: 150000000,
      headers: { Authorization: 'malicious' },
      optionSpecs: { map: 'bad' },
    },
    evidence: ['source'],
  })
  expect(result.data).toEqual({ contextWindow: 150000000 })
  expect(() =>
    extractedModelSchema.parse({ modelId: 'test', data: { cost: { input: -1 } }, evidence: [] }),
  ).toThrow()
})

test('Pi 请求入口向真实 Provider 传入当次副本，completeSimple 与流式响应均关联快照', async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(MODEL_PRICING_SCHEMA.join(';'))
  const repository = new ModelPricingRepository(sqlite)
  let now = Date.parse('2026-11-09T08:59:00+08:00')
  repository.cache('fx:CNY:USD', { rate: 0.15, date: '2026-11-09', source: 'Frankfurter' }, now)
  for (const year of [2025, 2026, 2027])
    repository.cache(`calendar:${year}`, { ...calendar, year }, now)
  const pricingService = new ModelPricingService(
    repository,
    (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch,
    () => now,
  )
  const faux = fauxProvider({
    models: [{ id: 'priced', cost: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 } }],
  })
  const models = createModels()
  const service = new ModelService({} as ProviderCredentialRepository, {
    models,
    pricing: pricingService,
  })
  const captured: number[] = []
  models.setProvider({
    ...faux.provider,
    streamSimple: (requestModel) => {
      captured.push(requestModel.cost.input)
      const message = fauxAssistantMessage('response')
      message.usage = {
        input: 1000000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1000000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }
      calculateCost(requestModel, message.usage)
      now = Date.parse('2026-11-09T09:00:00+08:00')
      const stream = createAssistantMessageEventStream()
      stream.push({ type: 'done', reason: 'stop', message })
      return stream
    },
  })
  const model = { ...faux.getModel(), pricing }
  try {
    const first = await models.completeSimple(model, { messages: [] })
    const second = await models.streamSimple(model, { messages: [] }).result()
    expect(captured).toEqual([0.15, 0.3])
    expect(first.usage.cost.total).toBe(0.15)
    expect(second.usage.cost.total).toBe(0.3)
    expect(first.usage).toMatchObject({ costUnknown: false, priceSnapshotId: expect.any(String) })
    expect(model.cost.input).toBe(99)
    expect(sqlite.query('SELECT COUNT(*) AS count FROM model_price_snapshots').get()).toEqual({
      count: 2,
    })
  } finally {
    await service.dispose()
    sqlite.close()
  }
})

test('日汇率与相邻年日历每天只更新一次，离线保留旧资料与汇率日期', async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(MODEL_PRICING_SCHEMA.join(';'))
  const repository = new ModelPricingRepository(sqlite)
  let now = Date.parse('2026-11-09T00:00:00Z'),
    calls = 0,
    offline = false
  const fetcher = (async (url: string) => {
    calls++
    if (offline) throw new Error('offline')
    if (url.includes('frankfurter'))
      return Response.json([{ base: 'CNY', quote: 'USD', rate: 0.15, date: '2026-11-09' }])
    const year = Number(url.match(/(\d{4})\.json/)![1])
    return Response.json({ ...calendar, year })
  }) as unknown as typeof fetch
  const service = new ModelPricingService(repository, fetcher, () => now)
  await service.refresh()
  expect(calls).toBe(4)
  expect(service.status()).toMatchObject({
    fx: { rate: 0.15, date: '2026-11-09' },
    calendarAvailable: true,
  })
  await service.refresh()
  expect(calls).toBe(4)
  offline = true
  now += 86400000
  await service.refresh()
  expect(calls).toBe(8)
  expect(service.status()).toMatchObject({
    fx: { rate: 0.15, date: '2026-11-09' },
    calendarAvailable: true,
  })
  await service.refresh()
  expect(calls).toBe(8)
  sqlite.close()
})

test('busy/idle × long-context tiers validate, merge conservatively and compute USD tiered cost', async () => {
  const tieredPricing: Model.Pricing = {
    ...pricing,
    idle: {
      input: 1,
      output: 4,
      cacheRead: 0.02,
      cacheWrite: 0,
      tiers: [
        { inputTokensAbove: 200_000, input: 2, output: 6, cacheRead: 0.05, cacheWrite: 0 },
        { inputTokensAbove: 100_000, input: 1.5, output: 5, cacheRead: 0.03, cacheWrite: 0 },
      ],
    },
    busy: {
      input: 2,
      output: 8,
      cacheRead: 0.04,
      cacheWrite: 0,
      tiers: [
        { inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 0.1, cacheWrite: null },
      ],
    },
  }
  const validated = validatePricing(tieredPricing)
  expect(validated.idle.tiers?.map((t) => t.inputTokensAbove)).toEqual([100_000, 200_000])

  expect(() =>
    validatePricing({
      ...tieredPricing,
      idle: {
        ...tieredPricing.idle,
        tiers: [
          { inputTokensAbove: 100_000, input: 1.5, output: 5, cacheRead: 0.03, cacheWrite: 0 },
          { inputTokensAbove: 100_000, input: 2, output: 6, cacheRead: 0.05, cacheWrite: 0 },
        ],
      },
    }),
  ).toThrow('阶梯阈值不能重复')

  const conservative = selectPricing(validated, Date.parse('2026-11-09T10:00:00+08:00'), [])
  expect(conservative.period).toBe('conservative')
  expect(conservative.prices.tiers).toEqual([
    { inputTokensAbove: 100_000, input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 },
    { inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 0.1, cacheWrite: null },
  ])

  const sqlite = new Database(':memory:')
  sqlite.exec(MODEL_PRICING_SCHEMA.join(';'))
  const repository = new ModelPricingRepository(sqlite)
  const now = Date.parse('2026-11-09T08:59:00+08:00')
  repository.cache('fx:CNY:USD', { rate: 0.15, date: '2026-11-09', source: 'Frankfurter' }, now)
  repository.cache('calendar:2026', calendar, now)
  const pricingService = new ModelPricingService(
    repository,
    (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch,
    () => now,
  )
  const model = {
    provider: 'test',
    id: 'tiered',
    api: 'openai-completions',
    pricing: validated,
    cost: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
  } as unknown as RuntimeModel<Api> & { pricing: Model.Pricing }

  const started = pricingService.begin(model)
  expect(started.model.cost.tiers).toEqual([
    {
      inputTokensAbove: 100_000,
      input: 1.5 * 0.15,
      output: 5 * 0.15,
      cacheRead: 0.03 * 0.15,
      cacheWrite: 0,
    },
    {
      inputTokensAbove: 200_000,
      input: 2 * 0.15,
      output: 6 * 0.15,
      cacheRead: 0.05 * 0.15,
      cacheWrite: 0,
    },
  ])
  const usage = {
    input: 250_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 250_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  const cost = calculateCost(started.model, usage)
  expect(cost.total).toBeCloseTo(0.075, 6)
  const msg = { usage } as unknown as AssistantMessage
  started.annotate(msg)
  expect((msg.usage as unknown as { costUnknown: boolean }).costUnknown).toBe(false)
  await pricingService.refresh()
  sqlite.close()
})

test('促销左闭右开、覆盖价格与所有阶梯，免费和订阅跳过现金优惠', () => {
  const startAt = '2026-11-09T09:00:00+08:00'
  const endAt = '2026-11-09T10:00:00+08:00'
  const start = Date.parse(startAt)
  const end = Date.parse(endAt)
  const busy = { ...pricing.busy, tiers: [{ ...pricing.busy, inputTokensAbove: 100_000 }] }
  const offer = validatePricing({
    ...pricing,
    busy,
    promotions: [
      { id: 'busy-half', startAt, endAt, appliesTo: 'busy', discountFactor: 0.5 },
      { id: 'override', startAt, endAt, prices: { ...busy, input: 0.25 } },
    ],
  })
  expect(selectPricing(offer, start - 1, [calendar]).reason).not.toBe('promotion')
  expect(selectPricing(offer, start, [calendar])).toMatchObject({
    reason: 'promotion',
    promotionId: 'busy-half',
    prices: {
      input: busy.input! / 2,
      tiers: [{ inputTokensAbove: 100_000, output: busy.output! / 2 }],
    },
  })
  expect(selectPricing(offer, end, [calendar]).prices).toEqual(busy)
  expect(selectPricing(offer, start, []).prices.input).toBe(0.25)
  for (const billingMode of ['subscription', 'free'] as const) {
    expect(selectPricing({ ...offer, billingMode }, start, [])).toMatchObject({
      reason: billingMode,
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
  }
})

test('目录三档速度分别改写上游模型、合并请求体并切换本次计费', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidex-speed-tier-'))
  const sqlite = new Database(':memory:')
  sqlite.exec(MODEL_PRICING_SCHEMA.join(';'))
  const repository = new ModelPricingRepository(sqlite)
  const now = Date.parse('2026-11-09T09:00:00Z')
  const pricingService = new ModelPricingService(
    repository,
    (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch,
    () => now,
  )
  const faux = fauxProvider({ provider: 'nvidia', api: 'openai-completions' })
  const id = faux.provider.id
  const fixture = fixtureV2({
    models: { 'maker/example': { name: 'Example' } },
    providers: {
      [id]: {
        api: 'https://unit.example/v1',
        models: {
          standard: {
            canonical_model_id: 'maker/example',
            cost: { input: 2, output: 4 },
          },
        },
      },
    },
  })
  fixture.providers.providers[id]!.models.standard!.speedTiers = {
    standard: { requestModelId: 'upstream-standard' },
    fast: {
      requestModelId: 'upstream-fast',
      payloadPatch: { service_tier: 'priority', output: { format: 'text' } },
    },
    ultrafast: {
      requestModelId: 'upstream-ultrafast',
      payloadPatch: { service_tier: 'ultrafast' },
    },
  }
  fixture.models.models['maker/example']!.providers[id]!.speedTiers = {
    standard: {
      speedMultiplier: 1,
      pricing: { busy: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 } },
    },
    fast: { pricing: { busy: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 } } },
    ultrafast: {
      speedMultiplier: 3,
      pricing: { busy: { input: 11, output: 12, cacheRead: 0, cacheWrite: 0 } },
    },
  }
  const request = async (url: string | URL | Request) => respondV2(url, fixture)
  const directory = new ProviderDirectoryStore(join(dir, 'providers.json'), request)
  await directory.refresh()
  const recommendations = new ModelRecommendationStore(join(dir, 'recommendations.json'), request)
  const native = createModels()
  const calls: unknown[] = []
  native.setProvider({
    ...faux.provider,
    streamSimple: (upstream, _context, options) => {
      const stream = createAssistantMessageEventStream()
      void Promise.resolve(options?.onPayload?.({ output: { schema: 'stable' } }, upstream)).then(
        (body) => {
          calls.push({ id: upstream.id, input: upstream.cost.input, body })
          stream.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage('ok') })
        },
      )
      return stream
    },
  })
  const service = new ModelService({} as ProviderCredentialRepository, {
    models: native,
    directory,
    recommendations,
    pricing: pricingService,
    config: {
      schemaVersion: 2,
      providers: { [id]: { kind: 'builtin', allow_models: ['standard', faux.getModel().id] } },
    },
  })
  try {
    const ref = { providerID: id as Model.Ref['providerID'], id: 'standard' as Model.Ref['id'] }
    expect(await service.activeCatalogModelIDs(id)).toEqual(['standard'])
    const standard = await service.getRuntimeModel(ref)
    const fast = await service.getRuntimeModel({ ...ref, speedTier: 'fast' })
    const ultrafast = await service.getRuntimeModel({ ...ref, speedTier: 'ultrafast' })
    expect(
      (await service.resolve(ref)).speedTiers?.map(({ id, speedMultiplier }) => [
        id,
        speedMultiplier,
      ]),
    ).toEqual([
      ['standard', 1],
      ['fast', undefined],
      ['ultrafast', 3],
    ])
    await native.completeSimple(standard, { messages: [] })
    await native.completeSimple(fast, { messages: [] })
    await native.completeSimple(ultrafast, { messages: [] })
    expect(calls).toEqual([
      { id: 'upstream-standard', input: 2, body: undefined },
      {
        id: 'upstream-fast',
        input: 7,
        body: { service_tier: 'priority', output: { schema: 'stable', format: 'text' } },
      },
      {
        id: 'upstream-ultrafast',
        input: 11,
        body: { service_tier: 'ultrafast', output: { schema: 'stable' } },
      },
    ])
  } finally {
    await service.dispose()
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('按缓存写入 TTL 和上下文阶梯计费，区分未知价、缺失 TTL 与汇总用量', async () => {
  using sqlite = new Database(':memory:')
  sqlite.exec(MODEL_PRICING_SCHEMA.join(';'))
  const repository = new ModelPricingRepository(sqlite)
  const now = Date.parse('2026-11-09T09:00:00Z')
  for (const year of [2025, 2026, 2027]) repository.cache(`calendar:${year}`, null, now)
  repository.cache('fx:CNY:USD', null, now)
  const service = new ModelPricingService(repository, fetch, () => now)
  const active = {
    input: 2,
    output: 3,
    cacheRead: 1,
    cacheWrite: 7,
    cacheWriteByTtl: { '5m': 13, '1h': 26, '24h': null },
  }
  const standard = { ...active, cacheWrite: 60, tiers: [{ inputTokensAbove: 1000, ...active }] }
  const model = fauxProvider({ api: 'anthropic-messages' }).getModel()
  const request = service.begin({
    ...model,
    pricing: validatePricing({
      ...pricing,
      currency: 'USD',
      rules: [],
      idle: standard,
      busy: standard,
    }),
  })
  const check = (split: Record<string, number> | undefined, cost: number, costUnknown = false) => {
    const message = fauxAssistantMessage('')
    Object.assign(message.usage, { input: 1_000_000, cacheWrite: 1_000_000 })
    calculateCost(request.model, message.usage)
    request.annotate(message, split)
    expect(message.usage.cost.cacheWrite).toBeCloseTo(cost)
    expect(message.usage.cost.total).toBeCloseTo(2 + cost)
    expect(message.usage).toMatchObject({ costUnknown })
  }
  check({ '5m': 250_000, '1h': 250_000, '2h': 250_000 }, 13.25)
  check({ '5m': 500_000, '24h': 500_000 }, 6.5, true)
  check(undefined, 7)
  await service.refresh()
})

test('从 Anthropic 与 OpenAI 响应提取 TTL，OpenAI 输入扣除缓存读写各一次', async () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
    const model = fauxProvider({ api }).getModel()
    const observer = observeCacheWriteUsage(api)!
    const writeTokens = { '5m': 13, '1h': 7 }
    if (api === 'anthropic-messages') {
      await observer.options.onProviderStreamEvent(
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 50,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 20,
              cache_creation: { ephemeral_5m_input_tokens: 13, ephemeral_1h_input_tokens: 7 },
            },
          },
        },
        model,
      )
    } else {
      await observer.options.onResponse(
        {
          status: 200,
          headers: {
            'Msh-Usage-Cache-Write-Tokens-5m': '13',
            'msh-usage-cache-write-tokens-1h': '7',
          },
        },
        model,
      )
      await observer.options.onProviderStreamEvent(
        api === 'openai-completions'
          ? { usage: { prompt_tokens: 100, cached_tokens: 30, cache_write_tokens: 20 } }
          : {
              type: 'response.completed',
              response: {
                usage: {
                  input_tokens: 100,
                  input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
                },
              },
            },
        model,
      )
    }
    const message = fauxAssistantMessage('')
    Object.assign(message.usage, {
      input: api === 'openai-completions' ? 70 : 50,
      cacheRead: 30,
      cacheWrite: api === 'openai-completions' ? 0 : 20,
      totalTokens: 100,
    })
    expect(observer.settle(message.usage, model)).toEqual(writeTokens)
    expect(message.usage).toMatchObject({
      input: 50,
      cacheRead: 30,
      cacheWrite: 20,
      totalTokens: 100,
    })
  }
})

test('Kimi K3.1 Pro 快速档通过真实 Pi 适配器使用专属模型 ID 和 TTL 单价', async () => {
  using sqlite = new Database(':memory:')
  sqlite.exec(MODEL_PRICING_SCHEMA.join(';'))
  const repository = new ModelPricingRepository(sqlite)
  const now = Date.parse('2026-11-09T09:00:00Z')
  for (const year of [2025, 2026, 2027]) repository.cache(`calendar:${year}`, null, now)
  repository.cache('fx:CNY:USD', null, now)
  const pricingService = new ModelPricingService(repository, fetch, () => now)
  const request = async () => {
    throw new Error('offline')
  }
  const service = new ModelService(
    { list: () => [], get: () => Effect.succeed(null) } as unknown as ProviderCredentialRepository,
    {
      directory: new ProviderDirectoryStore(undefined, request, { bundledFallback: true }),
      recommendations: new ModelRecommendationStore(undefined, request, { bundledFallback: true }),
      pricing: pricingService,
      env: { MOONSHOT_API_KEY: 'unit-moonshot-key' },
      config: {
        schemaVersion: 2,
        providers: { moonshotai: { kind: 'builtin', allow_models: ['kimi-k3.1-pro'] } },
      },
    },
  )
  let target: unknown
  try {
    const model = await service.getRuntimeModel({
      providerID: 'moonshotai',
      id: 'kimi-k3.1-pro',
      speedTier: 'fast',
    } as Model.Ref)
    const reply = await service.registry.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'test', timestamp: now }] },
      {
        maxRetries: 0,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const received = (await new Request(input, init).json()) as { model: string }
          target = received.model
          const chunk = {
            id: 'test',
            model: received.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
            },
          }
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: {
              'content-type': 'text/event-stream',
              'Msh-Usage-Cache-Write-Tokens-5m': '13',
              'Msh-Usage-Cache-Write-Tokens-1h': '7',
            },
          })
        }) as typeof fetch,
      },
    )
    expect(target).toBe('kimi-k3.1-pro-highspeed')
    expect(reply.stopReason).toBe('stop')
    expect(reply.usage).toMatchObject({
      input: 50,
      cacheRead: 30,
      cacheWrite: 20,
      costUnknown: false,
    })
    expect(reply.usage.cost.cacheWrite).toBeCloseTo(0.000108, 9)
    expect(reply.usage.cost.total).toBeCloseTo(0.000354, 9)
  } finally {
    await service.dispose()
    await pricingService.refresh()
  }
})
