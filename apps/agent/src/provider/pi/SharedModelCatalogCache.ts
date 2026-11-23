import { omitUndefined } from '@pidex/shared/guards'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import bundledCatalog from './data/bundled-model-catalog.json'
import { ModelRecommendationIndex, type RecommendationInput } from './ModelRecommendations'

/**
 * 自维护模型清单在 Pidex 内只保留一份共享缓存。
 *
 * - 默认在线源：`https://models.codepilotx.top/v1/catalog.json`（支持 `PIDEX_MODEL_CATALOG_URL` 覆盖）；
 * - 支持 `ETag` / `If-None-Match`（304）条件拉取；
 * - 目录（`ProviderDirectoryStore`）与推荐（`ModelRecommendationStore`）共用同一个内存索引与文件；
 * - 当启用 `bundledFallback` 且本地尚无缓存文件时，自动加载随包内置快照兜底；
 * - 旧文件只读兼容：新格式文件不存在时才读取旧两份缓存，绝不删除或覆盖旧文件。
 */

export const DEFAULT_CATALOG_URL = 'https://models.codepilotx.top/v1/catalog.json'
const SHARED_FILE = 'shared-model-catalog.json'
const LEGACY_DIRECTORY_FILE = 'provider-directory.json'
const LEGACY_RECOMMENDATION_FILE = 'model-recommendations.json'
const OWNER = 'pidex-model-catalog'
const FORMAT_VERSION = 1

export const resolveCatalogUrl = (): string => {
  const override = process.env.PIDEX_MODEL_CATALOG_URL?.trim()
  if (!override) return DEFAULT_CATALOG_URL
  try {
    const parsed = new URL(override)
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
      return parsed.href
    }
  } catch {
    // 忽略无效覆盖，回退默认托管地址。
  }
  return DEFAULT_CATALOG_URL
}

export type CatalogFacts = Record<string, unknown>

export type ProviderDelta = {
  /** 指向公共模型事实的规范 id；缺省表示该供应商模型没有可复用的公共事实。 */
  readonly ref?: string
  /** 原本显式存在、但与公共事实完全相同的字段名；重建时从公共事实补回。 */
  readonly inherited?: string[]
  /** 相对公共事实（或完整事实）的差异字段。 */
  readonly diff: CatalogFacts
}

type ProviderEntry = {
  readonly name?: string
  readonly api?: string
  readonly env?: string[]
  readonly npm?: string
  readonly marketVisible?: boolean
  readonly models: Record<string, ProviderDelta>
}

type StorageCatalog = {
  readonly models: Record<string, CatalogFacts>
  readonly providers: Record<string, ProviderEntry>
}

/** 重建后的原始形状目录，供目录构建与推荐索引共同消费。 */
export type RawProvider = {
  readonly name?: string
  readonly api?: string
  readonly env?: string[]
  readonly npm?: string
  readonly marketVisible?: boolean
  readonly models: Record<string, CatalogFacts>
}

export type RawCatalog = {
  readonly models: Record<string, CatalogFacts>
  readonly providers: Record<string, RawProvider>
}

type Document = StorageCatalog & {
  readonly owner: typeof OWNER
  readonly formatVersion: typeof FORMAT_VERSION
  readonly updatedAt: number
  readonly etag?: string
  readonly checkedAt?: number
}

export type PreparedCatalog =
  | { readonly notModified: true; readonly etag?: string }
  | { readonly notModified: false; readonly document: Document; readonly catalog: RawCatalog }

export interface SharedCatalogCacheOptions {
  readonly bundledFallback?: boolean
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const isEnoent = (error: unknown): boolean =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'

const LIMIT_KEYS = ['context', 'input', 'output'] as const
const COST_KEYS = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'reasoning',
  'input_audio',
  'output_audio',
  'tiers',
  'context_over_200k',
] as const

/** 只保留下游实际消费的字段。 */
const trimFacts = (raw: Record<string, unknown>): CatalogFacts => {
  const facts: CatalogFacts = {}
  for (const key of [
    'id',
    'description',
    'family',
    'knowledge',
    'release_date',
    'last_updated',
    'status',
    'open_weights',
    'license',
    'links',
    'weights',
    'benchmarks',
    'attachment',
    'temperature',
    'structured_output',
    'interleaved',
    'provider',
    'pricing',
    'pi_api',
    'base_url',
    'compat',
    'thinking_level_map',
  ]) {
    if (raw[key] !== undefined) facts[key] = raw[key]
  }
  if (typeof raw.name === 'string') facts.name = raw.name
  if (raw.type !== undefined) facts.type = raw.type
  if (typeof raw.canonical_model_id === 'string') facts.canonical_model_id = raw.canonical_model_id
  if (Array.isArray(raw.aliases)) {
    const aliases = raw.aliases.filter((value): value is string => typeof value === 'string')
    if (aliases.length) facts.aliases = aliases
  }
  const limit = asObject(raw.limit)
  if (limit) {
    const trimmed: Record<string, unknown> = {}
    for (const key of LIMIT_KEYS) if (limit[key] !== undefined) trimmed[key] = limit[key]
    if (Object.keys(trimmed).length) facts.limit = trimmed
  }
  const modalities = asObject(raw.modalities)
  if (modalities) {
    const trimmed: Record<string, unknown> = {}
    if (Array.isArray(modalities.input)) trimmed.input = modalities.input
    if (Array.isArray(modalities.output)) trimmed.output = modalities.output
    if (Object.keys(trimmed).length) facts.modalities = trimmed
  }
  if (typeof raw.reasoning === 'boolean') facts.reasoning = raw.reasoning
  if (typeof raw.tool_call === 'boolean') facts.tool_call = raw.tool_call
  if (Array.isArray(raw.reasoning_options)) {
    const options = raw.reasoning_options.flatMap((item) => {
      const option = asObject(item)
      return option && ['effort', 'toggle', 'budget_tokens'].includes(String(option.type))
        ? [option]
        : []
    })
    if (options.length) facts.reasoning_options = options
  }
  const cost = asObject(raw.cost)
  if (cost) {
    const trimmed: Record<string, unknown> = {}
    for (const key of COST_KEYS) if (cost[key] !== undefined) trimmed[key] = cost[key]
    if (Object.keys(trimmed).length) facts.cost = trimmed
  }
  if (raw.option_specs !== undefined) facts.option_specs = raw.option_specs
  if (raw.optionSpecs !== undefined) facts.optionSpecs = raw.optionSpecs
  return facts
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const normalizeCatalog = (payload: unknown): StorageCatalog => {
  const catalog = asObject(payload)
  const rawModels = catalog ? asObject(catalog.models) : undefined
  const rawProviders = catalog ? asObject(catalog.providers) : undefined
  if (!catalog || !rawModels || !rawProviders) throw new Error('Invalid model catalog')
  const models: Record<string, CatalogFacts> = {}
  for (const [id, input] of Object.entries(rawModels)) {
    const raw = asObject(input)
    if (!raw) throw new Error('Invalid model catalog')
    models[id] = trimFacts(raw)
  }
  const providers: Record<string, ProviderEntry> = {}
  for (const [id, input] of Object.entries(rawProviders)) {
    const raw = asObject(input)
    if (!raw) throw new Error('Invalid model catalog')
    const modelsOut: Record<string, ProviderDelta> = {}
    const rawModelsForProvider = asObject(raw.models)
    if (rawModelsForProvider) {
      for (const [modelId, modelInput] of Object.entries(rawModelsForProvider)) {
        const model = asObject(modelInput)
        if (!model) throw new Error('Invalid model catalog')
        const full = trimFacts(model)
        const ref =
          typeof model.canonical_model_id === 'string' &&
          models[model.canonical_model_id] !== undefined
            ? model.canonical_model_id
            : undefined
        if (!ref) {
          modelsOut[modelId] = { diff: full }
          continue
        }
        const common = models[ref]!
        const diff: CatalogFacts = {}
        const inherited: string[] = []
        for (const [key, value] of Object.entries(full)) {
          if (key === 'canonical_model_id') {
            diff[key] = value
            continue
          }
          if (common[key] === undefined) {
            diff[key] = value
            continue
          }
          if (same(common[key], value)) inherited.push(key)
          else diff[key] = value
        }
        modelsOut[modelId] = {
          ref,
          ...(inherited.length ? { inherited } : {}),
          diff,
        }
      }
    }
    providers[id] = {
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.api === 'string' ? { api: raw.api } : {}),
      ...(Array.isArray(raw.env)
        ? {
            env: raw.env.filter((value): value is string => typeof value === 'string'),
          }
        : {}),
      ...(typeof raw.npm === 'string' ? { npm: raw.npm } : {}),
      ...(typeof raw.marketVisible === 'boolean' ? { marketVisible: raw.marketVisible } : {}),
      models: modelsOut,
    }
  }
  return { models, providers }
}

const reconstruct = (delta: ProviderDelta, models: Record<string, CatalogFacts>): CatalogFacts => {
  if (!delta.ref || models[delta.ref] === undefined) return { ...delta.diff }
  const common = models[delta.ref]!
  const merged: CatalogFacts = {}
  for (const key of delta.inherited ?? []) if (common[key] !== undefined) merged[key] = common[key]
  return { ...merged, ...delta.diff }
}

const toRawCatalog = (document: StorageCatalog): RawCatalog => {
  const providers: Record<string, RawProvider> = {}
  for (const [id, entry] of Object.entries(document.providers)) {
    const models: Record<string, CatalogFacts> = {}
    for (const [modelId, delta] of Object.entries(entry.models))
      models[modelId] = reconstruct(delta, document.models)
    providers[id] = {
      ...omitUndefined({
        name: entry.name,
        api: entry.api,
        env: entry.env,
        npm: entry.npm,
        marketVisible: entry.marketVisible,
      }),
      models,
    }
  }
  return { models: document.models, providers }
}

const readJsonIfPresent = async (path: string): Promise<unknown | undefined> => {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return undefined
    throw error
  }
  return JSON.parse(text)
}

const readResponseJson = async (response: Response): Promise<unknown> => {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty catalog response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 64 * 1024 * 1024) throw new Error('Catalog too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 下载并解析模型清单；失败会抛错，调用方据此保留旧缓存。 */
export const downloadCatalogJson = async (
  request: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  url: string,
): Promise<unknown> => {
  const response = await request(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' })
  if (!response.ok) throw new Error('Catalog download failed')
  return readResponseJson(response)
}

const fetchCatalogWithEtag = async (
  request: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  url: string,
  etag?: string,
): Promise<
  | { readonly notModified: true; readonly etag?: string }
  | { readonly notModified: false; readonly payload: unknown; readonly etag?: string }
> => {
  const init: RequestInit = {
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
    ...(etag ? { headers: { 'If-None-Match': etag } } : {}),
  }
  const response = await request(url, init)
  const nextEtag = response.headers.get('etag')?.trim() || undefined
  if (response.status === 304) {
    const resolvedEtag = nextEtag ?? etag
    return resolvedEtag ? { notModified: true, etag: resolvedEtag } : { notModified: true }
  }
  if (!response.ok) throw new Error('Catalog download failed')
  const payload = await readResponseJson(response)
  return {
    notModified: false,
    payload,
    ...(nextEtag ? { etag: nextEtag } : {}),
  }
}

const sharedPathFor = (path: string): string => {
  const base = isAbsolute(path) ? path : resolve(path)
  return join(dirname(base), SHARED_FILE)
}

const instances = new Map<string, SharedModelCatalogCache>()

/**
 * 同一份共享缓存（同目录）在进程内是单例：ProviderDirectoryStore 与
 * ModelRecommendationStore 因此共用同一个内存索引与串行写入队列。
 */
export class SharedModelCatalogCache {
  static forPath(
    path: string | undefined,
    options: SharedCatalogCacheOptions = {},
  ): SharedModelCatalogCache {
    if (!path) return new SharedModelCatalogCache(undefined, options.bundledFallback === true)
    const shared = sharedPathFor(path)
    const existing = instances.get(shared)
    if (existing) {
      if (options.bundledFallback) existing.enableBundledFallback()
      return existing
    }
    const created = new SharedModelCatalogCache(shared, options.bundledFallback === true)
    instances.set(shared, created)
    return created
  }

  private document: Document | undefined
  private isBundledDocument = false
  private rawCache: RawCatalog | undefined
  private indexCache: { index: ModelRecommendationIndex; document: Document } | undefined
  private loaded = false
  private loading: Promise<void> | undefined
  private operation: Promise<unknown> = Promise.resolve()
  private inFlight: Promise<{ updatedAt: number }> | undefined

  private constructor(
    private readonly path: string | undefined,
    private bundledFallback: boolean,
  ) {}

  private enableBundledFallback(): void {
    if (this.bundledFallback) return
    this.bundledFallback = true
    if (this.loaded && !this.document) {
      this.loaded = false
    }
  }

  /** 当前缓存版本；未加载到任何目录时返回 undefined（与旧 updatedAt 语义一致）。 */
  async version(): Promise<number | undefined> {
    await this.ensureLoaded()
    return this.document?.updatedAt
  }

  /** 供目录构建使用的原始形状目录；无数据时返回 undefined。 */
  async catalog(): Promise<RawCatalog | undefined> {
    await this.ensureLoaded()
    return this.rawCatalog()
  }

  /** 共享的推荐索引（目录与推荐共用一个内存实例）。 */
  async index(): Promise<ModelRecommendationIndex | undefined> {
    await this.ensureLoaded()
    const document = this.document
    if (!document) return undefined
    if (this.indexCache?.document === document) return this.indexCache.index
    const index = new ModelRecommendationIndex(this.rawCatalog()!)
    this.indexCache = { index, document }
    return index
  }

  async resolve(input: RecommendationInput) {
    const index = await this.index()
    const result = index?.resolve(input) ?? {
      status: 'no-cache' as const,
      recommended: {} as import('@pidex/model-schema').Model.Recommendation,
    }
    const updatedAt = this.document?.updatedAt
    return { ...result, ...(updatedAt !== undefined ? { updatedAt } : {}) }
  }

  /** 下载 + 归一化，但不写盘；支持 304 Not Modified。 */
  async prepare(
    request: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  ): Promise<PreparedCatalog> {
    const url = resolveCatalogUrl()
    const fetched = await fetchCatalogWithEtag(
      request,
      url,
      this.isBundledDocument ? undefined : this.document?.etag,
    )
    if (fetched.notModified) {
      return { notModified: true, ...(fetched.etag ? { etag: fetched.etag } : {}) }
    }
    const normalized = normalizeCatalog(fetched.payload)
    const now = Date.now()
    const document: Document = {
      owner: OWNER,
      formatVersion: FORMAT_VERSION,
      updatedAt: now,
      checkedAt: now,
      ...(fetched.etag ? { etag: fetched.etag } : {}),
      ...normalized,
    }
    return { notModified: false, document, catalog: toRawCatalog(document) }
  }

  /** 原子替换共享缓存。 */
  async commit(prepared: PreparedCatalog): Promise<{ updatedAt: number }> {
    if (prepared.notModified) {
      if (!this.document) throw new Error('Catalog 304 received without cached catalog')
      this.document = {
        ...this.document,
        checkedAt: Date.now(),
        ...(prepared.etag ? { etag: prepared.etag } : {}),
      }
      this.isBundledDocument = false
      return { updatedAt: this.document.updatedAt }
    }
    await this.write(prepared.document)
    this.document = prepared.document
    this.isBundledDocument = false
    this.rawCache = undefined
    this.indexCache = undefined
    return { updatedAt: prepared.document.updatedAt }
  }

  /** 独立刷新在线模型清单（推荐定时刷新与手动刷新共用入口）。 */
  refresh(
    request: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  ): Promise<{ updatedAt: number }> {
    if (this.inFlight) return this.inFlight
    const next = this.serial(async () => {
      await this.ensureLoaded(true)
      const prepared = await this.prepare(request)
      return this.commit(prepared)
    })
    this.inFlight = next
    const clear = () => {
      if (this.inFlight === next) this.inFlight = undefined
    }
    void next.then(clear, clear)
    return next
  }

  private rawCatalog(): RawCatalog | undefined {
    if (!this.document) return undefined
    if (!this.rawCache) this.rawCache = toRawCatalog(this.document)
    return this.rawCache
  }

  private ensureLoaded(force = false): Promise<void> {
    if (this.loaded && !force) return Promise.resolve()
    if (!this.loading) {
      this.loading = this.load().finally(() => {
        this.loading = undefined
      })
    }
    return this.loading
  }

  private async load(): Promise<void> {
    if (this.path) {
      const shared = await this.readShared(this.path)
      if (shared) {
        this.apply(shared, false)
        this.loaded = true
        return
      }
      const migrated = await this.migrateLegacy()
      if (migrated) {
        this.apply(migrated, false)
        try {
          await this.write(migrated)
        } catch {
          // 迁移写盘失败不影响本进程可用；下次启动会重试迁移。
        }
        this.loaded = true
        return
      }
    }
    if (this.bundledFallback) {
      const normalized = normalizeCatalog(bundledCatalog)
      const parsedTimestamp = Date.parse(
        typeof (bundledCatalog as { generatedAt?: unknown }).generatedAt === 'string'
          ? (bundledCatalog as { generatedAt: string }).generatedAt
          : '',
      )
      this.apply(
        {
          owner: OWNER,
          formatVersion: FORMAT_VERSION,
          updatedAt: Number.isFinite(parsedTimestamp) && parsedTimestamp > 0 ? parsedTimestamp : 0,
          ...normalized,
        },
        true,
      )
      this.loaded = true
      return
    }
    this.apply(undefined, false)
    this.loaded = true
  }

  private apply(document: Document | undefined, bundled: boolean): void {
    this.document = document
    this.isBundledDocument = bundled
    this.rawCache = undefined
    this.indexCache = undefined
  }

  private async readShared(path: string): Promise<Document | undefined> {
    const value = await readJsonIfPresent(path)
    if (value === undefined) return undefined
    const document = asObject(value)
    if (
      !document ||
      document.owner !== OWNER ||
      document.formatVersion !== FORMAT_VERSION ||
      typeof document.updatedAt !== 'number' ||
      !Number.isFinite(document.updatedAt) ||
      (document.etag !== undefined && typeof document.etag !== 'string') ||
      (document.checkedAt !== undefined &&
        (typeof document.checkedAt !== 'number' || !Number.isFinite(document.checkedAt))) ||
      !asObject(document.models) ||
      !asObject(document.providers)
    )
      throw new Error('Unsupported model catalog cache')
    for (const entry of Object.values(document.providers as Record<string, unknown>)) {
      const provider = asObject(entry)
      if (!provider || !asObject(provider.models))
        throw new Error('Unsupported model catalog cache')
      for (const delta of Object.values(provider.models as Record<string, unknown>)) {
        if (!asObject(delta) || !asObject((delta as Record<string, unknown>).diff))
          throw new Error('Unsupported model catalog cache')
      }
    }
    return document as unknown as Document
  }

  private async migrateLegacy(): Promise<Document | undefined> {
    if (!this.path) return undefined
    const directory = dirname(this.path)
    const legacyDirectory = await readJsonIfPresent(join(directory, LEGACY_DIRECTORY_FILE))
    const legacyRecommendation = await readJsonIfPresent(
      join(directory, LEGACY_RECOMMENDATION_FILE),
    )
    let catalog: unknown
    let updatedAt: number | undefined
    const directoryDocument = asObject(legacyDirectory)
    if (
      directoryDocument &&
      directoryDocument.owner === 'pidex-provider-directory' &&
      directoryDocument.formatVersion === 1 &&
      directoryDocument.modelsDev !== undefined
    )
      catalog = directoryDocument.modelsDev
    const recommendationDocument = asObject(legacyRecommendation)
    if (
      recommendationDocument &&
      recommendationDocument.owner === 'pidex' &&
      recommendationDocument.formatVersion === 1 &&
      typeof recommendationDocument.updatedAt === 'number' &&
      Number.isFinite(recommendationDocument.updatedAt)
    ) {
      if (catalog === undefined) catalog = recommendationDocument.catalog
      updatedAt = recommendationDocument.updatedAt
    }
    if (catalog === undefined) return undefined
    const normalized = normalizeCatalog(catalog)
    return {
      owner: OWNER,
      formatVersion: FORMAT_VERSION,
      updatedAt: updatedAt ?? Date.now(),
      ...normalized,
    }
  }

  private async write(document: Document): Promise<void> {
    if (!this.path) return
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(document), 'utf8')
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(action, action)
    this.operation = next.catch(() => undefined)
    return next
  }
}
