import { Model } from './Model'

export type CalendarYear = {
  year: number
  papers: string[]
  days: { date: string; isOffDay: boolean; name: string }[]
}
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
const dayMs = 86400000
const weekday = (date: string) => new Date(date + 'T12:00:00Z').getUTCDay()
const previousDate = (date: string) =>
  new Date(Date.parse(date + 'T12:00:00Z') - dayMs).toISOString().slice(0, 10)
export const UNIT_PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
export type UnitPriceKey = (typeof UNIT_PRICE_KEYS)[number]

const conservativeScalar = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : Math.max(a, b)

type PriceBracket = Omit<Model.UnitPrices, 'tiers'>

export function cacheWritePrice(prices: PriceBracket, ttl: string): number | null {
  const rates = prices.cacheWriteByTtl
  return rates && Object.hasOwn(rates, ttl) ? rates[ttl]! : prices.cacheWrite
}

const conservativeBracket = (idle: PriceBracket, busy: PriceBracket): PriceBracket => {
  const ttls = new Set([
    ...Object.keys(idle.cacheWriteByTtl ?? {}),
    ...Object.keys(busy.cacheWriteByTtl ?? {}),
  ])
  return {
    input: conservativeScalar(idle.input, busy.input),
    output: conservativeScalar(idle.output, busy.output),
    cacheRead: conservativeScalar(idle.cacheRead, busy.cacheRead),
    cacheWrite: conservativeScalar(idle.cacheWrite, busy.cacheWrite),
    ...(ttls.size
      ? {
          cacheWriteByTtl: Object.fromEntries(
            [...ttls].map((ttl) => [
              ttl,
              conservativeScalar(cacheWritePrice(idle, ttl), cacheWritePrice(busy, ttl)),
            ]),
          ),
        }
      : {}),
  }
}

const bracketAt = (prices: Model.UnitPrices, threshold: number): PriceBracket => {
  let matched: PriceBracket = prices
  let best = -1
  for (const tier of prices.tiers ?? []) {
    if (tier.inputTokensAbove <= threshold && tier.inputTokensAbove > best) {
      matched = tier
      best = tier.inputTokensAbove
    }
  }
  return matched
}

export const ZERO_PRICES: Model.UnitPrices = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function selectBasePricing(pricing: Model.Pricing, at: number, calendars: readonly CalendarYear[]) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: pricing.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const part = (name: string) => parts.find((p) => p.type === name)!.value
  const date = `${part('year')}-${part('month')}-${part('day')}`,
    now = Number(part('hour')) * 60 + Number(part('minute'))
  const override = pricing.dateOverrides.find((item) => item.date === date)
  if (override)
    return { period: override.period, prices: pricing[override.period], reason: 'date-override' }
  let uncertain = false
  const matched = new Set<'idle' | 'busy'>()
  for (const rule of pricing.rules)
    for (const interval of rule.intervals) {
      const start = minutes(interval.start),
        end = minutes(interval.end)
      const anchor = end < start && now < end ? previousDate(date) : date
      if (!rule.weekdays.includes(weekday(anchor))) continue
      if (!(end > start ? now >= start && now < end : now >= start || now < end)) continue
      if (rule.holiday !== 'any') {
        const year = calendars.find((item) => item.year === Number(anchor.slice(0, 4)))
        if (!year) {
          uncertain = true
          continue
        }
        const holiday = calendars.some((item) =>
          item.days.some((day) => day.date === anchor && day.isOffDay),
        )
        if ((rule.holiday === 'only-cn') !== holiday) continue
      }
      matched.add(rule.period)
    }
  if (uncertain) {
    const thresholds = [
      ...new Set([
        ...(pricing.idle.tiers ?? []).map((tier) => tier.inputTokensAbove),
        ...(pricing.busy.tiers ?? []).map((tier) => tier.inputTokensAbove),
      ]),
    ].sort((a, b) => a - b)
    const tiers = thresholds.length
      ? thresholds.map((threshold) => {
          const idleBracket = bracketAt(pricing.idle, threshold)
          const busyBracket = bracketAt(pricing.busy, threshold)
          return {
            inputTokensAbove: threshold,
            ...conservativeBracket(idleBracket, busyBracket),
          }
        })
      : undefined
    return {
      period: 'conservative' as const,
      prices: {
        ...conservativeBracket(pricing.idle, pricing.busy),
        ...(tiers ? { tiers } : {}),
      } satisfies Model.UnitPrices,
      reason: 'calendar-unavailable',
    }
  }
  const period = matched.values().next().value ?? pricing.defaultPeriod
  return { period, prices: pricing[period], reason: matched.size ? 'time-rule' : 'default' }
}

export function selectPricing(
  pricing: Model.Pricing,
  at: number,
  calendars: readonly CalendarYear[],
) {
  if (pricing.billingMode === 'subscription' || pricing.billingMode === 'free') {
    return { period: pricing.defaultPeriod, prices: ZERO_PRICES, reason: pricing.billingMode }
  }
  const base = selectBasePricing(pricing, at, calendars)
  const promotion = Model.activePricingPromotion(pricing, at, base.period)
  if (!promotion) return base
  const factor = promotion.discountFactor ?? 1
  const scale = (prices: Model.UnitPrices) => {
    const value = (key: UnitPriceKey) => (prices[key] === null ? null : prices[key] * factor)
    return {
      input: value('input'),
      output: value('output'),
      cacheRead: value('cacheRead'),
      cacheWrite: value('cacheWrite'),
      ...(prices.cacheWriteByTtl
        ? {
            cacheWriteByTtl: Object.fromEntries(
              Object.entries(prices.cacheWriteByTtl).map(([ttl, price]) => [
                ttl,
                price === null ? null : price * factor,
              ]),
            ),
          }
        : {}),
    }
  }
  const prices = promotion.prices ?? {
    ...scale(base.prices),
    ...(base.prices.tiers
      ? { tiers: base.prices.tiers.map((tier) => ({ ...tier, ...scale(tier) })) }
      : {}),
  }
  return {
    ...base,
    prices,
    reason: 'promotion',
    promotionId: promotion.id,
    promotionLabel: promotion.label,
    promotionEndAt: promotion.endAt,
  }
}
