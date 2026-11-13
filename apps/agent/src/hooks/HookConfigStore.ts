import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ConfigObject, ConfigService, ConfigValue } from '../config/ConfigService'
import { ConfigServiceError } from '../config/ConfigService'
import type { HookDefinition } from './HookDefinitions'
import {
  HookConfigError,
  MAX_HOOK_CONFIG_BYTES,
  duplicateHookIds,
  parseHookDefinitions,
} from './HookDefinitions'

/**
 * Host-owned Hook sources. Clients only ever name a source; every file path is
 * derived here so a renderer can never aim a write at an arbitrary file.
 */
export type HookSourceName = 'user-file' | 'project-file' | 'user-config' | 'project-config'

export const HOOK_SOURCE_NAMES: readonly HookSourceName[] = [
  'user-file',
  'project-file',
  'user-config',
  'project-config',
]

export const hookSourceDisplayName = (source: HookSourceName) =>
  source === 'user-file'
    ? '用户 hooks.json'
    : source === 'project-file'
      ? '项目 .pidex/hooks.json'
      : source === 'user-config'
        ? '用户 config.json'
        : '项目 .pidex/config.json'

export const sha256Hex = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

export const EMPTY_VERSION = sha256Hex('')

/**
 * Document shapes accepted by the loader. Only three exist, and each one is
 * reproduced exactly on write so hand-authored structure is never replaced.
 */
export type HookDocumentShape = 'bare-array' | 'object-array' | 'config-array' | 'id-map'

export type HookDocumentItem = {
  id: string
  /** The original object; unknown keys are preserved verbatim. */
  raw: Record<string, unknown>
}

export type HookDocument = {
  shape: HookDocumentShape
  items: HookDocumentItem[]
  /** Keys beside `hooks` (file/object-array) or beside `config` (config-array). */
  extra: Record<string, unknown>
}

export type HookSourceSnapshot = {
  source: HookSourceName
  displayName: string
  filePath: string | null
  version: string
  writable: boolean
  exists: boolean
  hooks: HookDefinition[]
  diagnostics: Array<{ severity: 'warning' | 'error'; code: string; message: string }>
  mode: 'file' | 'inline'
  /** Null when the source is missing, invalid or not writable. */
  document: HookDocument | null
  /** Write routing resolved by the host; never accepted from a client. */
  target: { kind: 'user' } | { kind: 'project'; cwd: string } | null
}

export type HookConfigStoreInput = {
  configService: ConfigService
  /** `<dataRoot>/hooks.json`. */
  userHooksFile: string
  /** Known project roots, used to resolve the owning workspace for `cwd`. */
  projectRoots?: () => readonly string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const contained = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const safeRealpath = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const normalizedPath = (path: string) => {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Effective definitions. For `id-map` the loader has always let an explicit
 * `id` inside the value override the map key, so management keeps that same
 * precedence instead of inventing a second identity.
 */
const definitionsOf = (
  items: readonly HookDocumentItem[],
  origin: string,
  shape: HookDocumentShape,
) =>
  parseHookDefinitions(
    items.map((item) =>
      shape === 'id-map' ? { id: item.id, ...item.raw } : { ...item.raw, id: item.id },
    ),
    origin,
  )

/**
 * Parses one Hook document into a shape-preserving editable model. Every shape
 * is validated through `parseHookDefinitions`, so runtime and management agree.
 */
export const decodeHookDocument = (
  parsed: unknown,
  origin: string,
  kind: 'file' | 'inline',
): HookDocument => {
  if (Array.isArray(parsed)) {
    const hooks = parseHookDefinitions(parsed, origin)
    return {
      shape: 'bare-array',
      items: parsed.map((value, index) => ({
        id: hooks[index]!.id,
        raw: { ...(value as Record<string, unknown>) },
      })),
      extra: {},
    }
  }
  if (!isObject(parsed))
    throw new HookConfigError('HOOK_INVALID', `Hook 配置必须是对象或数组: ${origin}`)

  const hooksValue = parsed.hooks
  if (hooksValue === undefined || hooksValue === null)
    return { shape: 'object-array', items: [], extra: {} }
  if (kind === 'inline' && isObject(hooksValue) && !Array.isArray(hooksValue)) {
    const table = hooksValue
    if (Array.isArray(table.config)) {
      const hooks = parseHookDefinitions(table.config, origin)
      return {
        shape: 'config-array',
        items: table.config.map((value, index) => ({
          id: hooks[index]!.id,
          raw: { ...(value as Record<string, unknown>) },
        })),
        extra: Object.fromEntries(Object.entries(table).filter(([key]) => key !== 'config')),
      }
    }
    const entries = Object.entries(table).filter(([, value]) => isObject(value))
    const rawItems = entries.map(([key, value]) => ({
      id: key,
      raw: { ...(value as Record<string, unknown>) },
    }))
    // Canonicalise to the effective id so later edit/delete address one row.
    const definitions = definitionsOf(rawItems, origin, 'id-map')
    return {
      shape: 'id-map',
      items: rawItems.map((item, index) => ({ ...item, id: definitions[index]!.id })),
      extra: {},
    }
  }

  if (!Array.isArray(hooksValue))
    throw new HookConfigError('HOOK_INVALID', `Hook 配置必须包含 hooks 数组: ${origin}`)
  const hooks = parseHookDefinitions(hooksValue, origin)
  return {
    shape: 'object-array',
    items: hooksValue.map((value, index) => ({
      id: hooks[index]!.id,
      raw: { ...(value as Record<string, unknown>) },
    })),
    // Only standalone files carry sibling root keys forward; inline config
    // writes target `hooks` alone, so the surrounding document is untouched.
    extra:
      kind === 'file'
        ? Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'hooks'))
        : {},
  }
}

/** Merges the edited definition into the original object, preserving extras. */
const renderItem = (
  definition: HookDefinition,
  raw: Record<string, unknown>,
  shape: HookDocumentShape,
) => {
  const next: Record<string, unknown> = { ...raw }
  if (shape !== 'id-map') next.id = definition.id
  else if ('id' in raw) next.id = definition.id
  next.event = definition.event
  next.command = definition.command
  if (definition.matcher !== undefined) next.matcher = definition.matcher
  else delete next.matcher
  if (definition.timeoutMs !== undefined) next.timeoutMs = definition.timeoutMs
  else delete next.timeoutMs
  return next
}

const renderItems = (document: HookDocument, origin: string): Array<Record<string, unknown>> => {
  const hooks = definitionsOf(document.items, origin, document.shape)
  return document.items.map((item, index) => renderItem(hooks[index]!, item.raw, document.shape))
}

/** Renders an inline `hooks` value for `hook/config` batch writes. */
export const renderInlineHookValue = (document: HookDocument): ConfigValue => {
  const items = renderItems(document, 'hooks')
  if (document.shape === 'id-map')
    return Object.fromEntries(
      document.items.map((item, index) => [item.id, items[index]!]),
    ) as ConfigObject
  if (document.shape === 'config-array') return { ...document.extra, config: items } as ConfigObject
  return items as ConfigValue
}

/** Renders a standalone hooks file, keeping its original outer structure. */
export const renderHookFileText = (document: HookDocument): string => {
  const items = renderItems(document, 'hooks')
  const root =
    document.shape === 'bare-array'
      ? items
      : document.shape === 'id-map'
        ? {
            ...document.extra,
            hooks: Object.fromEntries(
              document.items.map((item, index) => [item.id, items[index]!]),
            ),
          }
        : { ...document.extra, hooks: items }
  return `${JSON.stringify(root, null, 2)}\n`
}

/** The single read/write implementation for all four Hook sources. */
export class HookConfigStore {
  private readonly writeQueues = new Map<string, Promise<void>>()

  constructor(private readonly input: HookConfigStoreInput) {}

  get configService() {
    return this.input.configService
  }

  get userHooksFile() {
    return this.input.userHooksFile
  }

  /**
   * Resolves the workspace that owns `cwd`: the longest known project root that
   * contains it, falling back to `cwd` itself for projectless workspaces.
   */
  projectRootFor(cwd: string): string {
    const canonical = safeRealpath(cwd)
    const roots = (this.input.projectRoots?.() ?? [])
      .map(safeRealpath)
      .filter((root) => contained(root, canonical))
      .sort((left, right) => right.length - left.length)
    return roots[0] ?? canonical
  }

  projectHooksFile(projectRoot: string) {
    return join(projectRoot, '.pidex', 'hooks.json')
  }

  private async readFileText(path: string): Promise<string | null> {
    try {
      const bytes = await readFile(path)
      if (bytes.byteLength > MAX_HOOK_CONFIG_BYTES)
        throw new HookConfigError(
          'HOOK_INVALID',
          `Hook 配置超过 ${MAX_HOOK_CONFIG_BYTES} bytes: ${path}`,
        )
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw cause
    }
  }

  /** Reads one source without throwing for user-authored invalid content. */
  async read(source: HookSourceName, cwd?: string): Promise<HookSourceSnapshot> {
    const displayName = hookSourceDisplayName(source)
    if (source === 'user-file' || source === 'project-file') {
      const projectRoot = source === 'project-file' ? this.requireProjectRoot(cwd) : null
      const filePath = projectRoot ? this.projectHooksFile(projectRoot) : this.input.userHooksFile
      const trusted = projectRoot ? this.input.configService.isProjectTrusted(projectRoot) : true
      const untrustedDiagnostic = trusted
        ? []
        : [
            {
              severity: 'warning' as const,
              code: 'CONFIG_PROJECT_UNTRUSTED',
              message: '项目尚未信任，项目 Hook 不会执行，也不能在这里保存',
            },
          ]
      const text = await this.readFileText(filePath)
      const version = text === null ? EMPTY_VERSION : sha256Hex(text)
      const base = {
        source,
        displayName,
        filePath,
        version,
        writable: trusted,
        exists: text !== null,
        mode: 'file' as const,
        target: (projectRoot
          ? { kind: 'project', cwd: projectRoot }
          : { kind: 'user' }) as HookSourceSnapshot['target'],
      }
      if (text === null)
        return {
          ...base,
          hooks: [],
          diagnostics: untrustedDiagnostic,
          document: trusted ? { shape: 'object-array', items: [], extra: {} } : null,
        }
      try {
        const document = decodeHookDocument(JSON.parse(text) as unknown, filePath, 'file')
        const duplicates = duplicateHookIds(definitionsOf(document.items, filePath, document.shape))
        const writable = trusted && duplicates.length === 0
        return {
          ...base,
          writable,
          hooks: definitionsOf(document.items, filePath, document.shape),
          diagnostics: [
            ...untrustedDiagnostic,
            ...duplicates.map((id) => ({
              severity: 'warning' as const,
              code: 'HOOK_DUPLICATE_ID',
              message: `同一来源存在重复 Hook ID：${id}，请先手动修正文件`,
            })),
          ],
          document: writable ? document : null,
        }
      } catch (cause) {
        return {
          ...base,
          writable: false,
          hooks: [],
          diagnostics: [
            ...untrustedDiagnostic,
            {
              severity: 'error',
              code: 'HOOK_INVALID',
              message: `Hook 配置无法解析，已保留原文件：${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            },
          ],
          document: null,
        }
      }
    }

    const projectRoot = source === 'project-config' ? this.requireProjectRoot(cwd) : null
    // Always refresh: a hand edit or a previous save may have changed the layer.
    await this.input.configService
      .read(projectRoot ? { cwd: projectRoot } : {})
      .catch(() => undefined)
    const layers = this.input.configService.snapshotLayers(projectRoot ?? undefined)
    const layer = layers.find((entry) =>
      projectRoot ? entry.kind === 'project' : entry.kind === 'user',
    )
    if (!layer)
      return {
        source,
        displayName,
        filePath: null,
        version: EMPTY_VERSION,
        writable: false,
        exists: false,
        hooks: [],
        diagnostics: [
          ...(projectRoot
            ? [
                {
                  severity: 'warning' as const,
                  code: 'HOOK_SOURCE_INVALID',
                  message: '当前项目没有可用的 config.json',
                },
              ]
            : []),
        ],
        mode: 'inline',
        document: null,
        target: null,
      }
    const target = projectRoot
      ? ({ kind: 'project', cwd: projectRoot } as const)
      : ({ kind: 'user' } as const)
    const base = {
      source,
      displayName,
      filePath: layer.filePath ?? null,
      version: layer.version,
      writable: layer.writable && layer.trusted,
      exists: layer.config.hooks !== undefined,
      mode: 'inline' as const,
      target,
    }
    if (layer.config.hooks === undefined)
      return {
        ...base,
        hooks: [],
        diagnostics: [],
        document: { shape: 'object-array', items: [], extra: {} },
      }
    try {
      const document = decodeHookDocument(layer.config, layer.filePath ?? displayName, 'inline')
      const duplicates = duplicateHookIds(
        definitionsOf(document.items, displayName, document.shape),
      )
      return {
        ...base,
        writable: base.writable && duplicates.length === 0,
        hooks: definitionsOf(document.items, displayName, document.shape),
        diagnostics: [
          ...(layer.trusted
            ? []
            : [
                {
                  severity: 'warning' as const,
                  code: 'CONFIG_PROJECT_UNTRUSTED',
                  message: '项目尚未信任，项目 Hook 不会执行，也不能在这里保存',
                },
              ]),
          ...duplicates.map((id) => ({
            severity: 'warning' as const,
            code: 'HOOK_DUPLICATE_ID',
            message: `同一来源存在重复 Hook ID：${id}，请先手动修正文件`,
          })),
        ],
        document: base.writable && duplicates.length === 0 ? document : null,
      }
    } catch (cause) {
      return {
        ...base,
        writable: false,
        hooks: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'HOOK_INVALID',
            message: `内联 Hook 配置无法解析，已保留原配置：${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          },
        ],
        document: null,
      }
    }
  }

  async list(cwd?: string): Promise<HookSourceSnapshot[]> {
    // Populate the project config layer before snapshotLayers() can observe it.
    if (cwd) await this.input.configService.read({ cwd }).catch(() => undefined)
    const snapshots: HookSourceSnapshot[] = []
    for (const source of HOOK_SOURCE_NAMES) {
      if (!cwd && (source === 'project-file' || source === 'project-config')) continue
      snapshots.push(await this.read(source, cwd))
    }
    return snapshots
  }

  async save(input: {
    source: HookSourceName
    expectedVersion: string
    rowId?: string
    hook: HookDefinition
    cwd?: string
  }): Promise<{ version: string; rowId: string }> {
    const snapshot = await this.read(input.source, input.cwd)
    const document = this.requireWritableDocument(snapshot)
    if (document.items.some((item) => item.id === input.hook.id && item.id !== input.rowId))
      throw new HookConfigError('HOOK_DUPLICATE_ID', `Hook ID 已存在：${input.hook.id}`)
    if (input.rowId && !document.items.some((item) => item.id === input.rowId))
      throw new HookConfigError('HOOK_SOURCE_INVALID', `Hook ${input.rowId} 不存在`)

    const items = [...document.items]
    const index = input.rowId ? items.findIndex((item) => item.id === input.rowId) : -1
    if (index >= 0)
      items[index] = {
        id: input.hook.id,
        raw: renderItem(input.hook, items[index]!.raw, document.shape),
      }
    else items.push({ id: input.hook.id, raw: renderItem(input.hook, {}, document.shape) })
    const next: HookDocument = { ...document, items }
    // Re-validate the rendered document before it reaches disk.
    definitionsOf(next.items, input.source, next.shape)

    const version =
      snapshot.mode === 'file'
        ? await this.writeFileSource(snapshot, next, input.expectedVersion)
        : await this.writeInlineSource(snapshot, next, input.expectedVersion)
    return { version, rowId: input.hook.id }
  }

  async delete(input: {
    source: HookSourceName
    rowId: string
    expectedVersion: string
    cwd?: string
  }): Promise<{ version: string }> {
    const snapshot = await this.read(input.source, input.cwd)
    const document = this.requireWritableDocument(snapshot)
    const items = document.items.filter((item) => item.id !== input.rowId)
    if (items.length === document.items.length)
      throw new HookConfigError('HOOK_SOURCE_INVALID', `Hook ${input.rowId} 不存在`)
    const next: HookDocument = { ...document, items }
    const version =
      snapshot.mode === 'file'
        ? await this.writeFileSource(snapshot, next, input.expectedVersion)
        : await this.writeInlineSource(snapshot, next, input.expectedVersion)
    return { version }
  }

  private requireWritableDocument(snapshot: HookSourceSnapshot): HookDocument {
    // Precedence: unparsable content is the actionable failure, then project
    // trust, then a merely non-writable source.
    const invalid = snapshot.diagnostics.find((item) => item.severity === 'error')
    if (invalid) throw new HookConfigError('HOOK_INVALID', invalid.message)
    if (snapshot.diagnostics.some((item) => item.code === 'CONFIG_PROJECT_UNTRUSTED'))
      throw new HookConfigError('CONFIG_PROJECT_UNTRUSTED', '项目配置尚未信任')
    if (!snapshot.writable || !snapshot.document)
      throw new HookConfigError('HOOK_SOURCE_INVALID', '该 Hook 来源当前不可写')
    return snapshot.document
  }

  private requireProjectRoot(cwd?: string) {
    if (!cwd) throw new HookConfigError('HOOK_SOURCE_INVALID', '项目 Hook 需要当前项目目录')
    return this.projectRootFor(cwd)
  }

  private async writeFileSource(
    snapshot: HookSourceSnapshot,
    document: HookDocument,
    expectedVersion: string,
  ): Promise<string> {
    const filePath = snapshot.filePath
    if (!filePath) throw new HookConfigError('HOOK_SOURCE_INVALID', 'Hook 文件路径无法解析')
    if (snapshot.source === 'project-file') {
      const projectRoot = dirname(dirname(filePath))
      if (!this.input.configService.isProjectTrusted(projectRoot))
        throw new HookConfigError('CONFIG_PROJECT_UNTRUSTED', '项目配置尚未信任')
    }
    const text = renderHookFileText(document)
    JSON.parse(text)
    if (Buffer.byteLength(text, 'utf8') > MAX_HOOK_CONFIG_BYTES)
      throw new HookConfigError('HOOK_INVALID', `Hook 配置超过 ${MAX_HOOK_CONFIG_BYTES} bytes`)
    const key = normalizedPath(filePath)
    const task = (this.writeQueues.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const current = await this.readFileText(filePath)
        const currentVersion = current === null ? EMPTY_VERSION : sha256Hex(current)
        if (currentVersion !== expectedVersion)
          throw new HookConfigError('CONFIG_VERSION_CONFLICT', 'Hook 配置已被其他编辑更新')
        await writeAtomically(filePath, text)
        return sha256Hex(text)
      })
    const tail = task.then(
      () => undefined,
      () => undefined,
    )
    this.writeQueues.set(key, tail)
    void tail.then(() => {
      if (this.writeQueues.get(key) === tail) this.writeQueues.delete(key)
    })
    return task
  }

  private async writeInlineSource(
    snapshot: HookSourceSnapshot,
    document: HookDocument,
    expectedVersion: string,
  ): Promise<string> {
    const target = snapshot.target
    if (!target) throw new HookConfigError('HOOK_SOURCE_INVALID', 'Hook 配置写入目标无法解析')
    const value = document.items.length === 0 ? null : renderInlineHookValue(document)
    try {
      const result = await this.input.configService.batchWrite({
        edits: [{ keyPath: ['hooks'], value }],
        target,
        expectedVersion,
        ...(target.kind === 'project' ? { cwd: target.cwd } : {}),
      })
      return result.version
    } catch (cause) {
      if (cause instanceof ConfigServiceError) {
        if (cause.code === 'CONFIG_VERSION_CONFLICT')
          throw new HookConfigError('CONFIG_VERSION_CONFLICT', 'Hook 配置已被其他编辑更新')
        if (cause.code === 'CONFIG_PROJECT_UNTRUSTED')
          throw new HookConfigError('CONFIG_PROJECT_UNTRUSTED', '项目配置尚未信任')
        throw new HookConfigError('HOOK_INVALID', cause.message)
      }
      throw cause
    }
  }
}

const writeAtomically = async (filePath: string, text: string) => {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = join(dirname(filePath), `.${randomUUID()}.hooks.tmp`)
  try {
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, filePath)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Synchronous standalone-file reader used by the runtime loader. */
export const readStandaloneHookFile = (filePath: string, containmentRoot?: string) => {
  const canonical = realpathSync(filePath)
  if (containmentRoot && !contained(realpathSync(containmentRoot), canonical))
    throw new HookConfigError('HOOK_INVALID', `Hook 配置逃出 workspace: ${filePath}`)
  const bytes = readFileSync(canonical)
  if (bytes.byteLength > MAX_HOOK_CONFIG_BYTES)
    throw new HookConfigError('HOOK_INVALID', `Hook 配置超过 ${MAX_HOOK_CONFIG_BYTES} bytes`)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const document = decodeHookDocument(JSON.parse(text) as unknown, filePath, 'file')
  return {
    definitions: definitionsOf(document.items, filePath, document.shape),
    canonical,
    hash: sha256Hex(bytes),
  }
}

export const hookFileExists = (path: string) => existsSync(path)

/**
 * Inline `config.hooks` definitions for the runtime loader. Shares
 * `decodeHookDocument` with management so both accept exactly the same shapes
 * (array, `{ config: [...] }`, or an id-keyed object).
 */
export const inlineHookDefinitions = (config: ConfigObject, source: string): HookDefinition[] => {
  const document = decodeHookDocument(config, source, 'inline')
  return definitionsOf(document.items, source, document.shape)
}
