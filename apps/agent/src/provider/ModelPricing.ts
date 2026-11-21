import { Schema } from 'effect'
import { Model } from '@pidex/model-schema'

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
  return pricing
}
export function selectPricing(
  pricing: Model.Pricing,
  at: number,
  calendars: readonly CalendarYear[],
) {
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
  if (uncertain)
    return {
      period: 'conservative' as const,
      prices: Object.fromEntries(
        Object.keys(pricing.idle).map((key) => [
          key,
          pricing.idle[key as keyof Model.UnitPrices] === null ||
          pricing.busy[key as keyof Model.UnitPrices] === null
            ? null
            : Math.max(
                pricing.idle[key as keyof Model.UnitPrices]!,
                pricing.busy[key as keyof Model.UnitPrices]!,
              ),
        ]),
      ) as Model.UnitPrices,
      reason: 'calendar-unavailable',
    }
  const period = matched.values().next().value ?? pricing.defaultPeriod
  return { period, prices: pricing[period], reason: matched.size ? 'time-rule' : 'default' }
}
