import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import {
  DESKTOP_EXTERNAL_FONTS,
  findExternalFontById,
  type DesktopExternalFontDownloadResult,
  type DesktopExternalFontSpec,
  type DesktopExternalFontState,
} from '@pidex/shared/desktop-external-fonts'
import type { DesktopLogger } from '../logging/DesktopLogger.js'

const JSDELIVR_NPM_BASE = 'https://cdn.jsdelivr.net/npm'
const MANIFEST_FILENAME = 'manifest.json'
const CSS_FILENAME = 'index.css'
const SAFE_WOFF2_REL_PATH = /^(?:[a-z0-9._-]+\/)*[a-z0-9._-]+\.woff2$/i
const RAW_WOFF2_URL_PATTERN = /url\(\s*['"]?([^)'"\s]+?\.woff2)['"]?\s*\)/gi
const NORMALIZED_WOFF2_URL_PATTERN = /url\(\.\/((?:[a-z0-9._-]+\/)*[a-z0-9._-]+\.woff2)\)/gi
const DOWNLOAD_TIMEOUT_MS = 20_000
const DOWNLOAD_CONCURRENCY = 10

type FontManifestV1 = {
  version: 1
  id: string
  package: string
  packageVersion: string
  files: string[]
}

export type ExternalFontServiceOptions = {
  rootDirectory: string
  logger?: DesktopLogger
  fetchFn?: typeof fetch
  cdnBaseUrl?: string
}

export class ExternalFontService {
  readonly #rootDirectory: string
  readonly #logger?: DesktopLogger
  readonly #fetchFn: typeof fetch
  readonly #cdnBaseUrl: string
  readonly #inFlightDownloads = new Map<string, Promise<DesktopExternalFontDownloadResult>>()
  readonly #cssCache = new Map<string, string>()

  constructor(options: ExternalFontServiceOptions) {
    this.#rootDirectory = options.rootDirectory
    this.#logger = options.logger
    this.#fetchFn = options.fetchFn ?? fetch
    this.#cdnBaseUrl = (options.cdnBaseUrl ?? JSDELIVR_NPM_BASE).replace(/\/+$/, '')
  }

  async listStates(): Promise<DesktopExternalFontState[]> {
    return Promise.all(
      DESKTOP_EXTERNAL_FONTS.map(async (spec) => this.#getStateForSpec(spec)),
    )
  }

  async getFontCss(fontId: string): Promise<string | null> {
    const spec = findExternalFontById(fontId)
    if (!spec) return null

    const cached = this.#cssCache.get(spec.id)
    if (cached && (await this.#verifyInstalled(spec))) {
      return cached
    }
    this.#cssCache.delete(spec.id)

    if (!(await this.#verifyInstalled(spec))) {
      return null
    }

    const css = await this.#buildInlineCss(spec)
    if (css) {
      this.#cssCache.set(spec.id, css)
    }
    return css
  }

  downloadFont(fontId: string): Promise<DesktopExternalFontDownloadResult> {
    const existing = this.#inFlightDownloads.get(fontId)
    if (existing) return existing

    const task = this.#performDownload(fontId).finally(() => {
      this.#inFlightDownloads.delete(fontId)
    })
    this.#inFlightDownloads.set(fontId, task)
    return task
  }

  getFontDirectory(fontId: string): string | null {
    const spec = findExternalFontById(fontId)
    if (!spec) return null
    return join(this.#rootDirectory, spec.id)
  }

  async removeFont(fontId: string): Promise<void> {
    const spec = findExternalFontById(fontId)
    if (!spec) {
      throw new Error(`未知外部字体：${fontId}`)
    }
    this.#cssCache.delete(spec.id)
    await rm(join(this.#rootDirectory, spec.id), { recursive: true, force: true })
  }

  async #getStateForSpec(spec: DesktopExternalFontSpec): Promise<DesktopExternalFontState> {
    if (this.#inFlightDownloads.has(spec.id)) {
      return {
        id: spec.id,
        family: spec.family,
        displayName: spec.displayName,
        kind: spec.kind,
        status: 'downloading',
      }
    }
    const installed = await this.#verifyInstalled(spec)
    return {
      id: spec.id,
      family: spec.family,
      displayName: spec.displayName,
      kind: spec.kind,
      status: installed ? 'downloaded' : 'not-downloaded',
    }
  }

  async #performDownload(fontId: string): Promise<DesktopExternalFontDownloadResult> {
    const spec = findExternalFontById(fontId)
    if (!spec) {
      return {
        ok: false,
        state: {
          id: fontId,
          family: fontId,
          displayName: fontId,
          kind: 'ui',
          status: 'error',
          error: '未知的外部字体',
        },
        error: '未知的外部字体',
      }
    }

    const baseUrl = `${this.#cdnBaseUrl}/${spec.fontsourcePackage}@${spec.fontsourceVersion}`
    const stagingDir = join(this.#rootDirectory, `.tmp-${spec.id}-${Date.now()}`)
    const targetDir = join(this.#rootDirectory, spec.id)

    try {
      const normalizedChunks: string[] = []
      for (const cssEntryFile of spec.cssEntryFiles) {
        const rawCss = await this.#fetchText(`${baseUrl}/${cssEntryFile}`)
        normalizedChunks.push(normalizeCssWoff2Urls(rawCss, cssEntryFile))
      }
      const combinedCss = normalizedChunks.join('\n')
      const relativeFiles = extractSafeWoff2Paths(combinedCss)
      if (relativeFiles.length === 0) {
        throw new Error('字体样式表中未找到有效的 WOFF2 文件引用')
      }

      await mkdir(stagingDir, { recursive: true })
      await writeFile(join(stagingDir, CSS_FILENAME), combinedCss, 'utf8')

      await runWithConcurrency(relativeFiles, DOWNLOAD_CONCURRENCY, async (relPath) => {
        const bytes = await this.#fetchBytes(`${baseUrl}/${relPath}`)
        if (bytes.byteLength === 0) {
          throw new Error(`字体文件为空: ${relPath}`)
        }
        const targetFile = join(stagingDir, relPath)
        await mkdir(dirname(targetFile), { recursive: true })
        await writeFile(targetFile, bytes)
      })

      const manifest: FontManifestV1 = {
        version: 1,
        id: spec.id,
        package: spec.fontsourcePackage,
        packageVersion: spec.fontsourceVersion,
        files: relativeFiles,
      }
      await writeFile(
        join(stagingDir, MANIFEST_FILENAME),
        JSON.stringify(manifest, null, 2),
        'utf8',
      )

      this.#cssCache.delete(spec.id)
      await mkdir(this.#rootDirectory, { recursive: true })
      await rm(targetDir, { recursive: true, force: true })
      await rename(stagingDir, targetDir)

      const css = await this.#buildInlineCss(spec)
      if (!css) {
        throw new Error('生成外部字体样式失败')
      }
      this.#cssCache.set(spec.id, css)

      this.#logger?.info('external-font.downloaded', { fontId: spec.id, files: relativeFiles.length })
      return {
        ok: true,
        state: {
          id: spec.id,
          family: spec.family,
          displayName: spec.displayName,
          kind: spec.kind,
          status: 'downloaded',
        },
        css,
      }
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      const message = error instanceof Error ? error.message : '字体下载失败'
      this.#logger?.warn('external-font.download-failed', {
        fontId: spec.id,
        message,
      })
      return {
        ok: false,
        state: {
          id: spec.id,
          family: spec.family,
          displayName: spec.displayName,
          kind: spec.kind,
          status: 'error',
          error: message,
        },
        error: message,
      }
    }
  }

  async #verifyInstalled(spec: DesktopExternalFontSpec): Promise<boolean> {
    const dir = join(this.#rootDirectory, spec.id)
    try {
      const manifestRaw = await readFile(join(dir, MANIFEST_FILENAME), 'utf8')
      const manifest = JSON.parse(manifestRaw) as Partial<FontManifestV1>
      if (
        manifest.version !== 1 ||
        manifest.id !== spec.id ||
        manifest.package !== spec.fontsourcePackage ||
        manifest.packageVersion !== spec.fontsourceVersion ||
        !Array.isArray(manifest.files) ||
        manifest.files.length === 0
      ) {
        return false
      }
      const cssInfo = await stat(join(dir, CSS_FILENAME))
      if (!cssInfo.isFile() || cssInfo.size === 0) return false

      for (const relPath of manifest.files) {
        if (typeof relPath !== 'string' || !SAFE_WOFF2_REL_PATH.test(relPath)) return false
        const fileInfo = await stat(join(dir, relPath))
        if (!fileInfo.isFile() || fileInfo.size === 0) return false
      }
      return true
    } catch {
      return false
    }
  }

  async #buildInlineCss(spec: DesktopExternalFontSpec): Promise<string | null> {
    const dir = join(this.#rootDirectory, spec.id)
    try {
      const rawCss = await readFile(join(dir, CSS_FILENAME), 'utf8')
      const relativeFiles = extractSafeWoff2Paths(rawCss)
      if (relativeFiles.length === 0) return null

      const dataUrls = new Map<string, string>()
      for (const relPath of relativeFiles) {
        const bytes = await readFile(join(dir, relPath))
        dataUrls.set(relPath, `data:font/woff2;base64,${bytes.toString('base64')}`)
      }

      const escapedSourceFamily = spec.sourceFamilyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const familyPattern = new RegExp(
        `font-family:\\s*['"]?${escapedSourceFamily}['"]?`,
        'g',
      )

      return rawCss
        .replace(familyPattern, `font-family: '${spec.family}'`)
        .replace(NORMALIZED_WOFF2_URL_PATTERN, (fullMatch, relPath: string) => {
          const dataUrl = dataUrls.get(relPath)
          return dataUrl ? `url(${dataUrl})` : fullMatch
        })
    } catch {
      return null
    }
  }

  async #fetchText(url: string): Promise<string> {
    const response = await this.#fetchWithTimeout(url)
    return response.text()
  }

  async #fetchBytes(url: string): Promise<Uint8Array> {
    const response = await this.#fetchWithTimeout(url)
    return new Uint8Array(await response.arrayBuffer())
  }

  async #fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    try {
      const response = await this.#fetchFn(url, { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return response
    } finally {
      clearTimeout(timer)
    }
  }
}

export function normalizeCssWoff2Urls(rawCss: string, cssEntryFile: string): string {
  const entryDir = posix.dirname(cssEntryFile)
  return rawCss.replace(RAW_WOFF2_URL_PATTERN, (fullMatch, rawRelPath: string) => {
    const trimmed = rawRelPath.trim()
    if (!trimmed || trimmed.startsWith('/') || trimmed.includes('..') || /^[a-z]+:/i.test(trimmed)) {
      return fullMatch
    }
    const joined = entryDir === '.' ? posix.normalize(trimmed) : posix.normalize(posix.join(entryDir, trimmed))
    if (!SAFE_WOFF2_REL_PATH.test(joined)) {
      return fullMatch
    }
    return `url(./${joined})`
  })
}

export function extractSafeWoff2Paths(css: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of css.matchAll(NORMALIZED_WOFF2_URL_PATTERN)) {
    const relPath = match[1]
    if (!relPath || relPath.includes('..') || !SAFE_WOFF2_REL_PATH.test(relPath)) continue
    if (seen.has(relPath)) continue
    seen.add(relPath)
    result.push(relPath)
  }
  return result
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = items[nextIndex++]
      if (current !== undefined) {
        await worker(current)
      }
    }
  })
  await Promise.all(runners)
}
