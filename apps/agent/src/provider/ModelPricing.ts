import { Schema } from 'effect'
import { Model } from '@pidex/model-schema'

export { selectPricing, ZERO_PRICES, UNIT_PRICE_KEYS, type CalendarYear } from '@pidex/model-schema'

const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))

const normalizeTiers = (
  tiers: readonly Model.PricingPriceTier[] | undefined,
): Model.PricingPriceTier[] | undefined => {
  if (!tiers?.length) return undefined
  const seen = new Set<number>()
  for (const tier of tiers) {
    if (seen.has(tier.inputTokensAbove)) {
      throw new PricingValidationError('计费阶梯阈值不能重复')
    }
    seen.add(tier.inputTokensAbove)
  }
  return [...tiers].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
}

export class PricingValidationError extends Error {}
export function validatePricing(value: unknown): Model.Pricing {
  let pricing: Model.Pricing
  try {
    pricing = Schema.decodeUnknownSync(Model.Pricing)(value)
  } catch {
    throw new PricingValidationError('计费配置包含无效价格、日期或时间段')
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: pricing.timeZone }).format()
  } catch {
    throw new PricingValidationError('计费时区无效，请填写 IANA 时区')
  }
  const promotions = pricing.promotions?.map((promotion) => {
    const hasPrices = promotion.prices !== undefined
    const hasFactor = promotion.discountFactor !== undefined
    const timestamp = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/
    if (
      hasPrices === hasFactor ||
      !timestamp.test(promotion.startAt) ||
      !timestamp.test(promotion.endAt) ||
      !(Date.parse(promotion.startAt) < Date.parse(promotion.endAt))
    ) {
      throw new PricingValidationError('优惠必须包含有效时间范围与一种价格调整方式')
    }
    return promotion.prices
      ? {
          ...promotion,
          prices: {
            ...promotion.prices,
            ...(promotion.prices.tiers ? { tiers: normalizeTiers(promotion.prices.tiers)! } : {}),
          },
        }
      : promotion
  })
  const idleTiers = normalizeTiers(pricing.idle.tiers)
  const busyTiers = normalizeTiers(pricing.busy.tiers)
  const dates = new Set<string>()
  for (const override of pricing.dateOverrides) {
    if (
      Number.isNaN(Date.parse(override.date)) ||
      new Date(override.date).toISOString().slice(0, 10) !== override.date
    )
      throw new PricingValidationError('日期覆盖包含无效日期')
    if (dates.has(override.date)) throw new PricingValidationError('日期覆盖不能重复')
    dates.add(override.date)
  }
  type Slot = { rule: number; holiday: Model.Pricing['rules'][number]['holiday']; day: number }
  const week = new Map<number, { idle: Map<string, Slot>; busy: Map<string, Slot> }>()
  pricing.rules.forEach((rule, index) => {
    if (!rule.weekdays.length || !rule.intervals.length)
      throw new PricingValidationError(`规则 ${index + 1} 缺少星期或时间段`)
    const intervals = rule.intervals
      .map((interval) => {
        const start = minutes(interval.start),
          end = minutes(interval.end)
        if (start === end)
          throw new PricingValidationError(`规则 ${index + 1} 开始和结束时间不能相同`)
        return { start, end: end < start ? end + 1440 : end }
      })
      .sort((a, b) => a.start - b.start)
    const merged: { start: number; end: number }[] = []
    for (const interval of intervals) {
      const last = merged.at(-1)
      if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end)
      else merged.push({ ...interval })
    }
    for (const day of new Set(rule.weekdays))
      for (const interval of merged) {
        for (
          let minute = day * 1440 + interval.start;
          minute < day * 1440 + interval.end;
          minute++
        ) {
          const position = minute % 10080
          const cell = week.get(position) ?? {
            idle: new Map<string, Slot>(),
            busy: new Map<string, Slot>(),
          }
          const opposite = rule.period === 'idle' ? cell.busy : cell.idle
          for (const other of opposite.values()) {
            // 跨午夜的条件取各自开始日期；只有相同开始日的节假日条件互斥。
            if (
              other.day === day &&
              other.holiday !== 'any' &&
              rule.holiday !== 'any' &&
              other.holiday !== rule.holiday
            )
              continue
            throw new PricingValidationError(
              `计费规则 ${other.rule + 1} 与 ${index + 1} 的忙闲时间冲突`,
            )
          }
          cell[rule.period].set(`${day}:${rule.holiday}`, {
            rule: index,
            holiday: rule.holiday,
            day,
          })
          week.set(position, cell)
        }
      }
  })
  return {
    ...pricing,
    ...(promotions ? { promotions } : {}),
    idle: {
      ...pricing.idle,
      ...(idleTiers ? { tiers: idleTiers } : {}),
    },
    busy: {
      ...pricing.busy,
      ...(busyTiers ? { tiers: busyTiers } : {}),
    },
  }
}
