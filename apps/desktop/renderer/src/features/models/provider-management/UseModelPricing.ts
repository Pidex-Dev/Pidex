import { useMemo, useState } from 'react'
import { useExternalSubscription } from '../../../hooks/UseExternalSubscription.js'
import { selectPricing, type ModelInfo } from '@pidex/shared'

export const modelPrice = (value: number | null | undefined, currency: 'USD' | 'CNY' = 'USD') =>
  value == null ? '未知' : value === 0 ? '免费' : `${currency === 'CNY' ? '¥' : '$'}${value}`

export const billingModeLabel = (mode?: ModelInfo['billingMode']) =>
  mode === 'subscription' ? '订阅额度' : mode === 'free' ? '免费' : '按量计费'

function createPricingClock(initialAt: number, pricing: ModelInfo['pricing']) {
  let at = initialAt
  const boundaries =
    pricing?.promotions?.flatMap((promotion) => [
      Date.parse(promotion.startAt),
      Date.parse(promotion.endAt),
    ]) ?? []
  const subscribe = (notify: () => void) => {
    at = Date.now()
    if (!boundaries.length && !pricing?.rules.length && !pricing?.dateOverrides.length)
      return () => {}
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const now = Date.now()
      const next = Math.min(
        now + 60_000 - (now % 60_000),
        ...boundaries.filter((time) => time > at),
      )
      timer = setTimeout(
        () => {
          at = Date.now()
          schedule()
          notify()
        },
        Math.max(0, next - now),
      )
    }
    schedule()
    return () => clearTimeout(timer)
  }
  return { subscribe, getSnapshot: () => at }
}

/** Keep visible prices current across schedule boundaries and promotion expiry. */
export function useModelPricing(pricing?: ModelInfo['pricing']) {
  const [mountedAt] = useState(() => Date.now())
  const clock = useMemo(() => createPricingClock(mountedAt, pricing), [mountedAt, pricing])
  const now = useExternalSubscription(clock.subscribe, clock.getSnapshot)
  if (!pricing) return undefined
  const active = selectPricing(pricing, now, [])
  return {
    ...active,
    promotion:
      'promotionEndAt' in active
        ? {
            label: active.promotionLabel ?? '限时优惠',
            endAt: new Intl.DateTimeFormat('zh-CN', {
              dateStyle: 'short',
              timeStyle: 'short',
              timeZone: pricing.timeZone,
            }).format(Date.parse(active.promotionEndAt)),
          }
        : undefined,
  }
}
