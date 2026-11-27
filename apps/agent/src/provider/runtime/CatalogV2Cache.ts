import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import bundledProviders from './data/bundled-providers-v2.json'
import bundledModels from './data/bundled-models-v2.json'
import { catalogEndpoint, ManifestV2, ModelsV2, ProvidersV2 } from './CatalogV2'
import { ModelRecommendationIndex, type RecommendationInput } from './ModelRecommendations'

const DEFAULT_MANIFEST = 'https://models.codepilotx.top/v2/manifest.json'
const MANIFEST_FILE = 'catalog-v2-manifest.json'
const instances = new Map<string, CatalogV2Cache>()
const keys = ['providers', 'models'] as const
type Key = (typeof keys)[number]
type RequestCatalog = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export interface CatalogV2CacheOptions {
  readonly bundledFallback?: boolean
}

const StateSchema = z.object({
  manifest: ManifestV2,
  url: z.string(),
  etag: z.string().optional(),
  updatedAt: z.number(),
  checkedAt: z.number(),
})
type State = z.infer<typeof StateSchema>
type Payloads = Record<Key, Buffer>

function manifestUrl() {
  const override = catalogEndpoint(process.env.PIDEX_MODEL_CATALOG_URL?.trim())
  if (!override) return DEFAULT_MANIFEST
  const url = new URL(override)
  if (url.pathname.endsWith('/v1/catalog.json') || url.pathname.endsWith('/v1/manifest.json'))
    url.pathname = url.pathname.replace(/\/v1\/[^/]+$/, '/v2/manifest.json')
  else if (!url.pathname.endsWith('.json'))
    url.pathname = url.pathname.replace(/\/?$/, '/manifest.json')
  return url.href
}

async function fetchBytes(response: Response, maximum: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!response.ok || !reader) throw new Error('Model catalog download failed')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maximum) throw new Error('Model catalog response exceeds its size limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks)
}

const parse = (bytes: Buffer): unknown => JSON.parse(bytes.toString('utf8'))
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function authenticate(bytes: Buffer, entry: ManifestV2['files'][Key]) {
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
    throw new Error('Model catalog size or checksum mismatch')
  return bytes
}

async function atomicWrite(path: string, data: string | Buffer) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, data)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function snapshot(providers: unknown, models: unknown) {
  const providersDoc = ProvidersV2.parse(providers)
  const modelsDoc = ModelsV2.parse(models)
  if (providersDoc.piVersion !== modelsDoc.piVersion)
    throw new Error('Model catalog Pi version mismatch')
  const index = new ModelRecommendationIndex(providersDoc, modelsDoc)
  return { providersDoc, modelsDoc, index }
}
type Snapshot = ReturnType<typeof snapshot>
let bundled: Snapshot | undefined

export class CatalogV2Cache {
  static forPath(path?: string, options: CatalogV2CacheOptions = {}) {
    if (!path) return new CatalogV2Cache(undefined, options.bundledFallback === true)
    const directory = dirname(resolve(path))
    let instance = instances.get(directory)
    if (!instance) {
      instance = new CatalogV2Cache(directory, options.bundledFallback === true)
      instances.set(directory, instance)
    }
    if (options.bundledFallback) instance.bundledFallback = true
    return instance
  }

  private state: State | undefined
  private active: Snapshot | undefined
  private payloads: Payloads | undefined
  private loading: Promise<void> | undefined
  private foreignManifest = false
  private inFlight: Promise<{ updatedAt: number }> | undefined

  private constructor(
    private readonly directory: string | undefined,
    private bundledFallback: boolean,
  ) {}

  private blob(key: Key, hash: string) {
    return join(this.directory!, 'catalog-v2', hash, 'catalog-v2-' + key + '.json')
  }

  private load() {
    return (this.loading ??= this.readCache())
  }

  private async readCache() {
    if (!this.directory) return
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.directory, MANIFEST_FILE), 'utf8'))
      const header = z.object({
        manifest: z.object({
          owner: z.literal('pidex-model-catalog'),
          schemaVersion: z.literal(2),
        }),
      })
      if (!header.safeParse(raw).success) {
        this.foreignManifest = true
        return
      }
      const state = StateSchema.parse(raw)
      const [providers, models] = await Promise.all(
        keys.map(async (key) => {
          const entry = state.manifest.files[key]
          return authenticate(await readFile(this.blob(key, entry.sha256)), entry)
        }),
      )
      this.active = snapshot(parse(providers!), parse(models!))
      this.state = state
      this.payloads = { providers: providers!, models: models! }
    } catch {
      // INVARIANT: A missing or incomplete generation leaves the bundled snapshot available.
    }
  }

  async current(): Promise<Snapshot | undefined> {
    await this.load()
    return (
      this.active ??
      (this.bundledFallback ? (bundled ??= snapshot(bundledProviders, bundledModels)) : undefined)
    )
  }

  async version() {
    const current = await this.current()
    return (
      this.state?.updatedAt ?? (current ? Date.parse(current.modelsDoc.generatedAt) : undefined)
    )
  }

  async resolve(input: RecommendationInput) {
    const current = await this.current()
    const result = current?.index.resolve(input) ?? { status: 'no-cache' as const, recommended: {} }
    const updatedAt = await this.version()
    return { ...result, ...(updatedAt !== undefined ? { updatedAt } : {}) }
  }

  refresh(request: RequestCatalog = fetch) {
    if (!this.inFlight) {
      this.inFlight = this.update(request).finally(() => {
        this.inFlight = undefined
      })
    }
    return this.inFlight
  }

  private async update(request: RequestCatalog) {
    await this.load()
    if (this.foreignManifest) throw new Error('Unsupported model catalog cache format')
    const url = manifestUrl()
    const previous = this.state
    const etag = previous?.url === url ? previous.etag : undefined
    const init: RequestInit = { signal: AbortSignal.timeout(30_000), redirect: 'error' }
    const response = await request(url, {
      ...init,
      ...(etag ? { headers: { 'If-None-Match': etag } } : {}),
    })
    const checkedAt = Date.now()
    if (response.status === 304) {
      if (!previous || !etag)
        throw new Error('Model catalog returned 304 without a cached manifest')
      const checked = { ...previous, checkedAt }
      await this.persist(checked)
      this.state = checked
      return { updatedAt: previous.updatedAt }
    }
    const manifest = ManifestV2.parse(parse(await fetchBytes(response, 64 * 1024)))
    const changed = keys.filter(
      (key) => previous?.manifest.files[key].sha256 !== manifest.files[key].sha256,
    )
    const [providers, models] = await Promise.all(
      keys.map(async (key) => {
        const entry = manifest.files[key]
        const cached = !changed.includes(key) ? this.payloads?.[key] : undefined
        return authenticate(
          cached ?? (await fetchBytes(await request(new URL(entry.path, url), init), entry.bytes)),
          entry,
        )
      }),
    )
    const payloads = { providers: providers!, models: models! }
    const active = changed.length
      ? snapshot(parse(payloads.providers), parse(payloads.models))
      : this.active!
    if (active.modelsDoc.piVersion !== manifest.piVersion)
      throw new Error('Invalid model catalog manifest version')
    if (this.directory) {
      // INVARIANT: The manifest is the commit point. Its previous content-addressed blobs stay readable across interruption.
      await Promise.all(
        changed.map((key) =>
          atomicWrite(this.blob(key, manifest.files[key].sha256), payloads[key]),
        ),
      )
    }
    const updatedAt = changed.length
      ? Math.max(checkedAt, (previous?.updatedAt ?? 0) + 1)
      : previous!.updatedAt
    const state = {
      manifest,
      url,
      etag: response.headers.get('etag') ?? undefined,
      checkedAt,
      updatedAt,
    }
    await this.persist(state)
    this.state = state
    this.payloads = payloads
    this.active = active
    return { updatedAt }
  }

  private async persist(state: State) {
    if (this.directory)
      await atomicWrite(join(this.directory, MANIFEST_FILE), JSON.stringify(state))
  }
}

/** Read shipped protocol defaults for configuration fields that are parsed before the cache loads. */
export const bundledProviderProtocolEndpoints = (id: string): Readonly<Record<string, string>> =>
  (bundledProviders as ProvidersV2).providers[id]?.protocolEndpoints ?? {}
