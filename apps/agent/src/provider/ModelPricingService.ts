import type { Api, Model as PiModel, AssistantMessage } from '@earendil-works/pi-ai'
import type { Model } from '@pidex/model-schema'
import { createHash } from 'node:crypto'
import { ModelPricingRepository } from '../storage/repositories/ModelPricingRepository'
import { selectPricing, type CalendarYear } from './ModelPricing'

type Fx = { rate: number; date: string; source: string }
export class ModelPricingService {
  private pending = new Map<string, Promise<void>>()
  constructor(
    private readonly repository: ModelPricingRepository,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}
  private async update(id: string, force: boolean, load: () => Promise<unknown>) {
    const pending = this.pending.get(id)
    if (pending) return pending
    const cached = this.repository.read(id)
    if (!force && cached && this.now() - cached.checkedAt < 86400000) return
    const operation = (async () => {
      try {
        this.repository.cache(id, await load(), this.now())
      } catch {
        this.repository.cache(id, cached?.payload ?? null, this.now())
      }
    })().finally(() => this.pending.delete(id))
    this.pending.set(id, operation)
    return operation
  }
  private async json(url: string) {
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    })
    if (!response.ok) throw new Error('资料暂不可用')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('资料为空')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > 1048576) throw new Error('资料过大')
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel()
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }
  async refresh(force = false, year = new Date(this.now()).getUTCFullYear()) {
    await Promise.all([
      this.update('fx:CNY:USD', force, async () => {
        const raw = (await this.json(
          'https://api.frankfurter.dev/v2/rates?base=CNY&quotes=USD',
        )) as { rate?: number; date?: string; base?: string; quote?: string }[]
        const item = raw.find((row) => row.base === 'CNY' && row.quote === 'USD')
        if (
          !item ||
          !Number.isFinite(item.rate) ||
          item.rate! <= 0 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(item.date ?? '')
        )
          throw new Error('汇率无效')
        return { rate: item.rate!, date: item.date!, source: 'Frankfurter' } satisfies Fx
      }),
      ...[year - 1, year, year + 1].map((y) =>
        this.update(`calendar:${y}`, force, async () => {
          const raw = (await this.json(
            `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${y}.json`,
          )) as CalendarYear
          if (
            raw.year !== y ||
            !Array.isArray(raw.days) ||
            !Array.isArray(raw.papers) ||
            raw.days.some(
              (day) => typeof day.date !== 'string' || typeof day.isOffDay !== 'boolean',
            )
          )
            throw new Error('日历无效')
          return raw
        }),
      ),
    ])
    return this.status(year)
  }
  status(year = new Date(this.now()).getUTCFullYear()) {
    const fx = this.repository.read('fx:CNY:USD')
    const calendar = this.repository.read(`calendar:${year}`)
    return {
      fx: fx?.payload ?? null,
      fxCheckedAt: fx?.checkedAt,
      calendarYear: year,
      calendarAvailable: Boolean(calendar?.payload),
      calendarCheckedAt: calendar?.checkedAt,
    }
  }
  begin(model: PiModel<Api> & { pricing?: Model.Pricing }) {
    const at = this.now(),
      year = Number(
        new Intl.DateTimeFormat('en', {
          timeZone: model.pricing?.timeZone ?? 'UTC',
          year: 'numeric',
        }).format(at),
      )
    // 请求只使用本地快照；后台更新为后续请求准备，不延迟当前调用。
    void this.refresh(false, year)
    const records = [year - 1, year, year + 1].map((y) => this.repository.read(`calendar:${y}`))
    const calendars = records.flatMap((row) => (row?.payload ? [row.payload as CalendarYear] : []))
    const selected = model.pricing
      ? selectPricing(model.pricing, at, calendars)
      : { period: 'fixed', prices: model.cost, reason: 'fixed' }
    const originalPrices = structuredClone(selected.prices)
    const fx =
      model.pricing?.currency === 'CNY'
        ? (this.repository.read('fx:CNY:USD')?.payload as Fx | null | undefined)
        : { rate: 1, date: new Date(at).toISOString().slice(0, 10), source: 'USD' }
    const usd = Object.fromEntries(
      ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => [
        key,
        fx ? (originalPrices[key as keyof Model.UnitPrices] ?? 0) * fx.rate : 0,
      ]),
    ) as Record<keyof Model.UnitPrices, number>
    const id = crypto.randomUUID()
    const snapshot = {
      id,
      providerId: model.provider,
      modelId: model.id,
      at,
      ruleVersion: createHash('sha256')
        .update(JSON.stringify(model.pricing ?? model.cost))
        .digest('hex'),
      period: selected.period,
      reason: selected.reason,
      original: originalPrices,
      currency: model.pricing?.currency ?? 'USD',
      usd: fx ? usd : null,
      fx: fx ?? null,
      staleFx: Boolean(
        fx && fx.source !== 'USD' && fx.date !== new Date(at).toISOString().slice(0, 10),
      ),
      calendarVersions: records.map((row) =>
        row?.payload
          ? createHash('sha256').update(JSON.stringify(row.payload)).digest('hex')
          : null,
      ),
      estimated: true,
      unknown: !fx || Object.values(originalPrices).some((value) => value === null),
    }
    this.repository.snapshot(id, snapshot, at)
    return {
      model: { ...model, cost: model.pricing ? usd : { ...model.cost } },
      annotate: (message: AssistantMessage) => {
        const unknown =
          !fx ||
          (['input', 'output', 'cacheRead', 'cacheWrite'] as const).some(
            (key) => originalPrices[key] === null && message.usage[key] > 0,
          )
        Object.assign(message.usage, {
          priceSnapshotId: id,
          costUnknown: unknown,
          pricingReason: selected.reason,
          conservativeCost: selected.reason === 'calendar-unavailable',
        })
      },
    }
  }
}
