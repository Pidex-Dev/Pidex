import { CatalogV2Cache, type CatalogV2CacheOptions } from './CatalogV2Cache'
import type { RecommendationInput } from './ModelRecommendations'

const REFRESH_INTERVAL_MS = 5 * 60 * 1000

export class ModelRecommendationStore {
  private readonly cache: CatalogV2Cache
  private readonly request: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  private refreshTimer: ReturnType<typeof setInterval> | undefined
  private onAutoUpdated: (() => void | Promise<void>) | undefined

  constructor(
    path?: string,
    request: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
    options: CatalogV2CacheOptions = {},
  ) {
    this.cache = CatalogV2Cache.forPath(path, options)
    this.request = request
  }

  startAutoRefresh(onUpdated?: () => void | Promise<void>) {
    if (onUpdated) this.onAutoUpdated = onUpdated
    if (this.refreshTimer) return
    const update = () => {
      void this.refresh()
        .then(() => this.onAutoUpdated?.())
        .catch(() => undefined)
    }
    update()
    this.refreshTimer = setInterval(update, REFRESH_INTERVAL_MS)
    this.refreshTimer.unref()
  }

  dispose() {
    this.onAutoUpdated = undefined
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
  }

  async optionRules() {
    return (await this.cache.current())?.modelsDoc.optionRules
  }

  async resolve(input: RecommendationInput) {
    return this.cache.resolve(input)
  }

  /** 当前目录版本；推荐更新后指纹变化会触发已保存模型重新合成。 */
  async version(): Promise<number | undefined> {
    return this.cache.version()
  }

  refresh() {
    return this.cache.refresh(this.request)
  }
}
