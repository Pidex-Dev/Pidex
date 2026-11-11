import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  calculateCost,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai'
import { PiModelService } from '../src/provider/pi/PiModelService'
import type { ProviderCredentialRepository } from '../src/auth/ProviderCredentialRepository'
import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Model } from '@pidex/model-schema'
import { selectPricing, validatePricing, type CalendarYear } from '../src/provider/ModelPricing'
import { ModelPricingService } from '../src/provider/ModelPricingService'
import {
  ModelPricingRepository,
  MODEL_PRICING_SCHEMA,
} from '../src/storage/repositories/ModelPricingRepository'
import { isPublicAddress, extractedModelSchema } from '../src/provider/ModelDocumentService'
import type { Api, Model as PiModel, AssistantMessage } from '@earendil-works/pi-ai'
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
  } as unknown as PiModel<Api> & { pricing: Model.Pricing }
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
  const service = new PiModelService({} as ProviderCredentialRepository, {
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
