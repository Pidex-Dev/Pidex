import { isRecord as isObject } from '@pidex/shared/guards'
import type { AnyModel, ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai'
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const OWNER = 'pidex'
const FORMAT_VERSION = 1

interface StoreDocument {
  readonly owner: typeof OWNER
  readonly formatVersion: typeof FORMAT_VERSION
  readonly providers: Readonly<Record<string, ModelsStoreEntry>>
}

const validModel = (value: unknown): value is AnyModel =>
  isObject(value) &&
  typeof value.id === 'string' &&
  typeof value.provider === 'string' &&
  typeof value.api === 'string' &&
  typeof value.baseUrl === 'string'

const validEntry = (value: unknown): value is ModelsStoreEntry =>
  isObject(value) &&
  Array.isArray(value.models) &&
  value.models.every(validModel) &&
  (value.checkedAt === undefined || typeof value.checkedAt === 'number') &&
  (value.lastModified === undefined || typeof value.lastModified === 'number') &&
  (value.etag === undefined || typeof value.etag === 'string')

const emptyDocument = (): StoreDocument => ({
  owner: OWNER,
  formatVersion: FORMAT_VERSION,
  providers: {},
})

async function readCache(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (cause) {
    if (isObject(cause) && cause.code === 'ENOENT') return undefined
    throw cause
  }
}

function parseDocument(text: string): StoreDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Provider models cache is corrupt; refusing to overwrite it')
  }
  if (!isObject(value) || value.owner !== OWNER) {
    throw new Error('Provider models cache has unknown ownership; refusing to overwrite it')
  }
  if (value.formatVersion !== FORMAT_VERSION) {
    throw new Error('Provider models cache uses an unsupported format; refusing to overwrite it')
  }
  if (!isObject(value.providers)) {
    throw new Error('Provider models cache is corrupt; refusing to overwrite it')
  }
  for (const entry of Object.values(value.providers)) {
    if (!validEntry(entry)) {
      throw new Error('Provider models cache is corrupt; refusing to overwrite it')
    }
  }
  return structuredClone(value) as unknown as StoreDocument
}

/** UTF-8, ownership-checked provider model cache. Invalid or future files are never overwritten. */
export class ProviderModelsFileStore implements ModelsStore {
  private operation: Promise<unknown> = Promise.resolve()

  private legacyChecked: boolean

  constructor(readonly path: string) {
    this.legacyChecked = basename(path) !== 'provider-models.cache.json'
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    return this.serial(async () => {
      const document = await this.readDocument()
      const entry = document.providers[providerId]
      return entry ? structuredClone(entry) : undefined
    })
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    await this.serial(async () => {
      if (!validEntry(entry)) throw new Error('Invalid provider models cache entry')
      const document = await this.readDocument()
      await this.writeDocument({
        ...document,
        providers: {
          ...document.providers,
          [providerId]: structuredClone(entry),
        },
      })
    })
  }

  async delete(providerId: string): Promise<void> {
    await this.serial(async () => {
      const document = await this.readDocument()
      if (!(providerId in document.providers)) return
      const providers = { ...document.providers }
      delete providers[providerId]
      await this.writeDocument({ ...document, providers })
    })
  }

  private async readDocument(): Promise<StoreDocument> {
    const currentText = await readCache(this.path)
    const current = currentText === undefined ? undefined : parseDocument(currentText)
    if (this.legacyChecked) return current ?? emptyDocument()

    const legacyPath = join(dirname(this.path), 'pi-models.cache.json')
    const legacyText = await readCache(legacyPath)
    if (legacyText === undefined) {
      this.legacyChecked = true
      if (current) return current
      const latest = await readCache(this.path)
      return latest === undefined ? emptyDocument() : parseDocument(latest)
    }

    let legacy: StoreDocument
    try {
      legacy = parseDocument(legacyText)
    } catch (cause) {
      if (!current) throw cause
      this.legacyChecked = true
      return current
    }

    let result = current
    if (!result) {
      try {
        await this.writeDocument(legacy, true)
        result = legacy
      } catch (cause) {
        if (!isObject(cause) || cause.code !== 'EEXIST') throw cause
        result = parseDocument(await readFile(this.path, 'utf8'))
      }
    }
    if ((await readCache(legacyPath)) === legacyText) {
      await rm(legacyPath, { force: true })
    }
    this.legacyChecked = true
    return result
  }

  private async writeDocument(document: StoreDocument, createOnly = false) {
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      if (createOnly) await link(temporaryPath, this.path)
      else await rename(temporaryPath, this.path)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation)
    this.operation = next.catch(() => undefined)
    return next
  }
}
