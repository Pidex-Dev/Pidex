import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import extractZip from 'extract-zip'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  PluginComponent,
  PluginDetails,
  PluginAssetKind,
  PluginInstallSource,
  PluginInstallationPolicy,
  PluginSource,
  PluginSummary,
  PluginUsedApp,
} from '@pidex/agent-protocol'
import { parseSkillDocument } from '../prompt/SkillService'
import { hostManagedMcpDeclarations } from '../nodeRepl/Association'
import { MAX_PLUGIN_ARCHIVE_BYTES, PluginMarketplace } from './PluginMarketplace'
import {
  PluginSettingsConflictError,
  PluginSettingsRepository,
} from '../storage/repositories/PluginSettingsRepository'

import { renameWithRetry } from './PluginFileSystem'
import {
  MAX_PLUGIN_ASSET_BYTES,
  UNSUPPORTED_MANIFEST_KEYS,
  pluginAssetResult,
  pluginPresentation,
  unsupportedPluginComponents,
  type PluginAssets,
} from './PluginPresentation'

const MAX_JSON_BYTES = 1024 * 1024
const pluginIdPattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const decoder = new TextDecoder('utf-8', { fatal: true })

type PluginSkillRoot = {
  pluginId: string
  pluginRoot: string
  skillsRoot: string
}

export type PluginHookRoot = {
  pluginId: string
  pluginName: string
  pluginRoot: string
  source: PluginSource
  hooksPaths: string[]
}

type RemoteGitSource = {
  url: string
  ref?: string
  subpath?: string
}

export type DeclaredPluginApp = {
  id: string
  name?: string
  description?: string
  required?: boolean
  pluginId: string
  pluginName: string
  developerName: string
  pluginInstalled: boolean
  pluginEnabled: boolean
}

type PluginAppDeclaration = {
  id: string
  name?: string
  description?: string
  required?: boolean
}

type DiscoveredPlugin = {
  summary: PluginSummary
  details: PluginDetails
  pluginRoot?: string
  remoteGitSource?: RemoteGitSource
  assets?: PluginAssets
  skillRoot: PluginSkillRoot | null
  hookRoot: PluginHookRoot | null
  declaredApps?: readonly PluginAppDeclaration[]
}

type PluginRoots = {
  builtinPluginsRoot: string
  userHome?: string
  dataRoot?: string
  fetcher?: typeof fetch
  /** Optional diagnostics sink; never carries paths or credentials. */
  logger?: { warn(event: string, fields?: Record<string, unknown>): void } | undefined
  /** Cleanup of a staged uninstall directory; overridable for verification. */
  removeDirectory?: ((path: string) => Promise<void>) | undefined
}

type JsonRecord = Record<string, unknown>

export class PluginManagementError extends Error {
  constructor(
    readonly code:
      | 'PLUGIN_NOT_FOUND'
      | 'PLUGIN_NOT_INSTALLED'
      | 'PLUGIN_INVALID'
      | 'CONFLICT'
      | 'PATH_DENIED'
      | 'INTERNAL_ERROR',
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * Files are consistent on disk but the lifecycle state write failed. Carries a
 * refresh/retry instruction for the client instead of a generic failure.
 */
class PluginRegistrationError extends Error {}

const contained = (root: string, candidate: string) => {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

const stringValue = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const stringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const text = stringValue(entry)
        return text ? [text] : []
      })
    : []

const stringOrStringArray = (value: unknown) => {
  const single = stringValue(value)
  return single ? [single] : stringArray(value)
}

const readJson = async (path: string): Promise<unknown> => {
  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error('JSON 文件过大')
  return JSON.parse(decoder.decode(bytes)) as unknown
}

const removeDirectory = (path: string) => rm(path, { recursive: true, force: true })

const invalidPlugin = (
  id: string,
  source: PluginSource,
  unavailableReason = '插件清单无效',
): DiscoveredPlugin => ({
  summary: {
    id,
    name: id,
    version: '0.0.0',
    description: '',
    developerName: '未知开发者',
    category: 'Other',
    source,
    installationPolicy: 'NOT_AVAILABLE',
    installed: false,
    enabled: false,
    status: 'invalid',
    capabilities: [],
    skills: [],
    unavailableReason,
  },
  details: {
    pluginId: id,
    longDescription: '',
    displayCapabilities: [],
    defaultPrompts: [],
    skills: [],
  },
  skillRoot: null,
  hookRoot: null,
})

const execFileAsync = promisify(execFile)
const safeGitRefPattern = /^[A-Za-z0-9._/-]+$/

const parseRemoteGitSource = (sourceDescriptor: JsonRecord | null): RemoteGitSource | null => {
  if (sourceDescriptor?.source !== 'url') return null
  const rawUrl = stringValue(sourceDescriptor.url)
  if (!rawUrl || rawUrl.startsWith('-')) return null
  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsedUrl.protocol !== 'https:') return null
  const rawRef = stringValue(sourceDescriptor.ref)
  if (rawRef && (rawRef.startsWith('-') || rawRef.includes('..') || !safeGitRefPattern.test(rawRef))) {
    return null
  }
  const rawSubpath = stringValue(sourceDescriptor.path)
  if (
    rawSubpath &&
    (isAbsolute(rawSubpath) ||
      rawSubpath.startsWith('-') ||
      rawSubpath.split(/[\\/]+/).includes('..'))
  ) {
    return null
  }
  return {
    url: rawUrl,
    ...(rawRef ? { ref: rawRef } : {}),
    ...(rawSubpath ? { subpath: rawSubpath } : {}),
  }
}

const normalizePolicy = (
  value: unknown,
  fallback: PluginInstallationPolicy,
): PluginInstallationPolicy =>
  value === 'NOT_AVAILABLE' || value === 'AVAILABLE' || value === 'INSTALLED_BY_DEFAULT'
    ? value
    : fallback

export class PluginManagementService {
  private readonly userHome: string
  private readonly installedRoot: string | undefined
  private readonly marketplace: PluginMarketplace | undefined
  private mutation: Promise<unknown> = Promise.resolve()
  private readonly knownPlugins = new Map<string, DiscoveredPlugin>()
  private readonly listeners = new Set<(pluginId: string, generation: number) => void>()
  private appResolver?:
    | ((ref: {
        id: string
        name?: string
        description?: string
        required?: boolean
      }) => Promise<PluginUsedApp> | PluginUsedApp)
    | undefined

  setAppResolver(
    resolver: (ref: {
      id: string
      name?: string
      description?: string
      required?: boolean
    }) => Promise<PluginUsedApp> | PluginUsedApp,
  ) {
    this.appResolver = resolver
  }

  constructor(
    private readonly settings: PluginSettingsRepository,
    private readonly roots: PluginRoots,
  ) {
    this.userHome = resolve(roots.userHome ?? homedir())
    if (roots.dataRoot) {
      this.installedRoot = resolve(roots.dataRoot, 'plugins', 'installed')
      this.marketplace = new PluginMarketplace(
        resolve(roots.dataRoot, 'plugins', 'cache'),
        roots.fetcher,
      )
    }
  }

  initializeComputerUse(legacyEnabled: boolean) {
    this.settings.initializeComputerUse(legacyEnabled)
  }

  isEnabled(pluginId: string) {
    const plugin = this.knownPlugins.get(pluginId)?.summary
    return (
      plugin?.installed === true &&
      plugin.status === 'ready' &&
      !this.settings.state().disabledPluginIds.includes(pluginId)
    )
  }

  subscribe(listener: (pluginId: string, generation: number) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async list(
    input: {
      workspace?: string | undefined
      forceReload?: boolean | undefined
    } = {},
  ) {
    if (this.marketplace) await this.managedRoot()
    await this.marketplace?.refresh(input.forceReload)
    return this.listLocal(input.workspace, true)
  }

  async listLocal(workspace?: string, includeCatalog = false) {
    const plugins = await this.discover(workspace)
    if (includeCatalog) {
      const ids = new Set(plugins.map((plugin) => plugin.summary.id))
      for (const entry of this.marketplace?.entries() ?? []) {
        if (!ids.has(entry.summary.id))
          plugins.push({ ...entry, skillRoot: null, hookRoot: null })
      }
    }
    this.knownPlugins.clear()
    for (const plugin of plugins) this.knownPlugins.set(plugin.summary.id, plugin)
    const state = this.settings.state()
    return {
      plugins: plugins.map(({ summary }) => ({
        ...summary,
        ...(includeCatalog
          ? {
              inMarketplace:
                this.marketplace?.entries().some((entry) => entry.summary.id === summary.id) ??
                false,
            }
          : {}),
      })),
      ...(includeCatalog ? { sections: this.marketplace?.sections() ?? [] } : {}),
      generation: state.generation,
      updatedAt: state.updatedAt,
      ...(includeCatalog && this.marketplace?.error
        ? { catalogError: this.marketplace.error }
        : {}),
    }
  }

  setEnabled(input: { pluginId: string; enabled: boolean; operationId: string }) {
    return this.serialize(() => this.updateEnabled(input))
  }

  private async updateEnabled(input: { pluginId: string; enabled: boolean; operationId: string }) {
    let plugin = this.knownPlugins.get(input.pluginId)
    if (!plugin) {
      await this.listLocal()
      plugin = this.knownPlugins.get(input.pluginId)
    }
    if (!plugin) {
      throw new PluginManagementError('PLUGIN_NOT_FOUND', '插件不存在', 404)
    }
    if (plugin.summary.status !== 'ready') {
      throw new PluginManagementError('PLUGIN_INVALID', '插件当前不可用', 409)
    }
    if (!plugin.summary.installed) {
      throw new PluginManagementError('PLUGIN_NOT_INSTALLED', '插件尚未安装', 409)
    }
    try {
      const result = this.settings.setEnabled(input)
      const summary = { ...plugin.summary, enabled: this.isEnabled(input.pluginId) }
      this.knownPlugins.set(input.pluginId, { ...plugin, summary })
      if (result.changed) this.notifyListeners(input.pluginId, result.state.generation)
      return {
        result: {
          plugin: summary,
          generation: result.state.generation,
          updatedAt: result.state.updatedAt,
        },
        changed: result.changed,
      }
    } catch (cause) {
      if (cause instanceof PluginSettingsConflictError) {
        throw new PluginManagementError('CONFLICT', cause.message, 409)
      }
      throw cause
    }
  }

  async getDetails(input: { pluginId: string; workspace?: string | undefined }) {
    const plugins = await this.discover(input.workspace)
    let plugin = plugins.find((candidate) => candidate.summary.id === input.pluginId)
    if (!plugin) {
      if (this.marketplace) await this.managedRoot()
      await this.marketplace?.refresh()
      const entry = this.marketplace
        ?.entries()
        .find((candidate) => candidate.summary.id === input.pluginId)
      if (entry) plugin = { ...entry, skillRoot: null, hookRoot: null }
    }
    if (!plugin) {
      throw new PluginManagementError('PLUGIN_NOT_FOUND', '插件不存在', 404)
    }
    this.knownPlugins.set(plugin.summary.id, plugin)
    const declaredApps = plugin.declaredApps ?? []
    if (declaredApps.length && this.appResolver) {
      const apps = await Promise.all(declaredApps.map((app) => this.appResolver!(app)))
      return { details: { ...plugin.details, apps } }
    }
    return { details: plugin.details }
  }

  async declaredApps(workspace?: string): Promise<DeclaredPluginApp[]> {
    const plugins = await this.discover(workspace)
    return plugins.flatMap((plugin) =>
      (plugin.declaredApps ?? []).map((app) => ({
        ...app,
        pluginId: plugin.summary.id,
        pluginName: plugin.summary.name,
        developerName: plugin.summary.developerName,
        pluginInstalled: plugin.summary.installed,
        pluginEnabled: plugin.summary.enabled,
      })),
    )
  }

  async readAsset(input: {
    pluginId: string
    kind: PluginAssetKind
    workspace?: string | undefined
  }) {
    try {
      const plugin = (await this.discover(input.workspace)).find(
        (entry) => entry.summary.id === input.pluginId,
      )
      if (!plugin) {
        if (this.marketplace) {
          await this.managedRoot()
          return await this.marketplace.readAsset(input.pluginId, input.kind)
        }
        throw new Error('图片不存在')
      }
      const path = plugin.assets?.[input.kind]
      if (!path || !plugin.pluginRoot) throw new Error('图片不存在')
      let candidate = plugin.pluginRoot
      for (const part of path.split('/')) {
        candidate = join(candidate, part)
        if ((await lstat(candidate)).isSymbolicLink()) throw new Error('图片路径无效')
      }
      const canonical = await realpath(candidate)
      const stat = await lstat(canonical)
      if (
        !contained(plugin.pluginRoot, canonical) ||
        !stat.isFile() ||
        stat.size > MAX_PLUGIN_ASSET_BYTES
      )
        throw new Error('图片无效')
      return pluginAssetResult(await readFile(canonical))
    } catch {
      throw new PluginManagementError('PLUGIN_INVALID', '插件图片暂不可用', 409)
    }
  }

  async enabledSkillRoots(workspace?: string): Promise<PluginSkillRoot[]> {
    const plugins = await this.discover(workspace)
    return plugins.flatMap((plugin) =>
      plugin.summary.installed &&
      plugin.summary.enabled &&
      !this.settings.state().disabledPluginIds.includes(plugin.summary.id) &&
      plugin.summary.status === 'ready' &&
      plugin.skillRoot
        ? [plugin.skillRoot]
        : [],
    )
  }

  async enabledHookRoots(workspace?: string): Promise<PluginHookRoot[]> {
    const plugins = await this.discover(workspace)
    return plugins.flatMap((plugin) =>
      plugin.summary.installed &&
      plugin.summary.enabled &&
      !this.settings.state().disabledPluginIds.includes(plugin.summary.id) &&
      plugin.summary.status === 'ready' &&
      plugin.hookRoot
        ? [plugin.hookRoot]
        : [],
    )
  }

  private async discover(workspace?: string) {
    const bundled = await this.scanBundled()
    const installed = await this.scanInstalled()
    const workspacePlugins = workspace
      ? await this.scanMarketplace(
          resolve(workspace, '.agents', 'plugins', 'marketplace.json'),
          resolve(workspace),
          'workspace',
        )
      : []
    const personal = await this.scanMarketplace(
      resolve(this.userHome, '.agents', 'plugins', 'marketplace.json'),
      this.userHome,
      'personal',
    )
    const selected = new Map<string, DiscoveredPlugin>()
    for (const plugin of [...bundled, ...installed, ...workspacePlugins, ...personal]) {
      if (!selected.has(plugin.summary.id)) selected.set(plugin.summary.id, plugin)
    }
    return [...selected.values()]
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work)
    this.mutation = result.catch(() => {})
    return result
  }

  install(input: {
    pluginId: string
    operationId: string
    expectedCatalogRevision?: string | undefined
  }) {
    return this.serialize(() => this.lifecycle(input, 'install'))
  }

  uninstall(input: { pluginId: string; operationId: string }) {
    return this.serialize(() => this.lifecycle(input, 'uninstall'))
  }

  private async managedRoot() {
    if (!this.installedRoot || !this.roots.dataRoot) {
      throw new PluginManagementError('PATH_DENIED', '插件安装目录未配置', 403)
    }
    const dataRoot = await realpath(this.roots.dataRoot)
    const pluginRoot = join(dataRoot, 'plugins')
    await mkdir(pluginRoot, { recursive: true })
    if ((await realpath(pluginRoot)) !== pluginRoot) {
      throw new PluginManagementError('PATH_DENIED', '插件安装目录不可用', 403)
    }
    await mkdir(this.installedRoot, { recursive: true })
    const root = await realpath(this.installedRoot)
    if (!contained(pluginRoot, root) || (await lstat(this.installedRoot)).isSymbolicLink()) {
      throw new PluginManagementError('PATH_DENIED', '插件安装目录不可用', 403)
    }
    return root
  }

  private async scanInstalled(): Promise<DiscoveredPlugin[]> {
    if (!this.installedRoot) return []
    const entries = await readdir(this.installedRoot, { withFileTypes: true }).catch(() => [])
    if (!entries.length) return []
    const root = await this.managedRoot()
    const plugins: DiscoveredPlugin[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !pluginIdPattern.test(entry.name))
        continue
      const plugin = await this.loadPlugin({
        expectedId: entry.name,
        pluginRoot: join(root, entry.name),
        source: 'installed',
        policy: undefined,
      })
      plugins.push({
        ...plugin,
        summary: { ...plugin.summary, installed: true, canUninstall: true },
      })
    }
    return plugins
  }

  private async lifecycle(
    input: { pluginId: string; operationId: string; expectedCatalogRevision?: string | undefined },
    action: 'install' | 'uninstall',
  ) {
    let stagedRemoval: string | null = null
    try {
      if (!pluginIdPattern.test(input.pluginId)) {
        throw new PluginManagementError('PLUGIN_INVALID', '插件标识无效', 400)
      }
      const previous = this.settings.lifecycleOperation(input.operationId, input.pluginId, action)
      if (previous)
        return {
          pluginId: input.pluginId,
          generation: previous.generation,
          updatedAt: previous.updatedAt,
        }
      const root = await this.managedRoot()
      const target = join(root, input.pluginId)
      const existing = await lstat(target).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return null
        throw cause
      })
      if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
        throw new PluginManagementError('PATH_DENIED', '插件目录不可操作', 403)
      }
      const local = (await this.discover()).find((plugin) => plugin.summary.id === input.pluginId)
      if (local && local.summary.source !== 'installed' && !local.remoteGitSource) {
        throw new PluginManagementError('PATH_DENIED', '此插件不由下载安装管理', 403)
      }
      if (action === 'install') {
        if (local?.remoteGitSource) {
          if (existing) {
            const reused = await this.loadPlugin({
              expectedId: input.pluginId,
              pluginRoot: target,
              source: 'installed',
              policy: undefined,
            })
            if (reused.summary.status !== 'ready') {
              throw new PluginManagementError(
                'CONFLICT',
                '已存在插件目录但清单无效，请先移除后重试。',
                409,
              )
            }
          } else {
            await this.cloneRemotePlugin(root, target, input.pluginId, local.remoteGitSource)
          }
        } else {
          if (!this.marketplace)
            throw new PluginManagementError('PLUGIN_INVALID', '插件目录未配置', 409)
          await this.marketplace.refresh()
          this.assertCatalogRevision(input.expectedCatalogRevision)
          if (existing) {
            // A previous attempt may have activated files before saving state.
            // Only a valid, catalog-matching directory may be reused; otherwise
            // report a conflict instead of deleting the user's files.
            await this.assertReusableInstallation(target, input.pluginId)
          } else {
            await this.downloadPlugin(root, target, input.pluginId)
          }
        }
      } else if (existing) {
        if ((await realpath(target)) !== target || !contained(root, target)) {
          throw new PluginManagementError('PATH_DENIED', '插件目录不可操作', 403)
        }
        const trash = join(root, `.remove-${crypto.randomUUID()}`)
        await renameWithRetry(target, trash)
        stagedRemoval = trash
      } else if (
        !local &&
        !this.marketplace?.entries().some((entry) => entry.summary.id === input.pluginId)
      ) {
        throw new PluginManagementError('PLUGIN_NOT_FOUND', '插件不存在', 404)
      }
      let result
      try {
        result = this.settings.completeLifecycle(input.operationId, input.pluginId, action)
      } catch (cause) {
        await this.rollbackFailedRegistration({
          action,
          target,
          stagedRemoval,
          cause,
        })
        throw cause
      }
      if (stagedRemoval) {
        // Cleanup happens after the state is durable; a leftover staging folder
        // is invisible to discovery, so cleanup failures must not fail the
        // uninstall the user already completed.
        await (this.roots.removeDirectory ?? removeDirectory)(stagedRemoval).catch(() => {
          this.roots.logger?.warn('plugins.lifecycle.cleanup.failed', {
            operationId: input.operationId,
            action: 'uninstall',
          })
        })
        stagedRemoval = null
      }
      await this.listLocal()
      this.notifyListeners(input.pluginId, result.generation)
      return {
        pluginId: input.pluginId,
        generation: result.generation,
        updatedAt: result.updatedAt,
      }
    } catch (cause) {
      if (cause instanceof PluginRegistrationError) {
        throw new PluginManagementError('INTERNAL_ERROR', cause.message, 500)
      }
      if (cause instanceof PluginManagementError) throw cause
      if (cause instanceof PluginSettingsConflictError)
        throw new PluginManagementError('CONFLICT', cause.message, 409)
      throw new PluginManagementError('INTERNAL_ERROR', '插件操作失败，请检查网络后重试。', 500)
    }
  }

  /** Revision echoed by the installer must still match the pinned catalog. */
  private assertCatalogRevision(expectedCatalogRevision: string | undefined) {
    if (!expectedCatalogRevision) return
    const revision = this.marketplace?.revision()
    if (!revision) {
      throw new PluginManagementError(
        'CONFLICT',
        '插件目录当前不可用，无法校验安装来源，请刷新后重试。',
        409,
      )
    }
    if (revision !== expectedCatalogRevision) {
      throw new PluginManagementError('CONFLICT', '插件目录已更新，请重新查看详情后再安装。', 409)
    }
  }

  /**
   * Revalidates an existing install directory instead of trusting its presence.
   * Identity, manifest validity and catalog version must all agree.
   */
  private async assertReusableInstallation(pluginRoot: string, pluginId: string) {
    const plugin = await this.loadPlugin({
      expectedId: pluginId,
      pluginRoot,
      source: 'installed',
      policy: undefined,
    })
    if (plugin.summary.status !== 'ready') {
      throw new PluginManagementError('CONFLICT', '已存在插件目录但清单无效，请先移除后重试。', 409)
    }
    const entry = this.marketplace?.entries().find((candidate) => candidate.summary.id === pluginId)
    if (!entry) {
      throw new PluginManagementError(
        'CONFLICT',
        '插件目录中没有该插件，无法校验已存在的安装目录，请刷新后重试。',
        409,
      )
    }
    if (entry.summary.version !== plugin.summary.version) {
      throw new PluginManagementError(
        'CONFLICT',
        '已安装版本与插件目录不一致，请先移除后重试。',
        409,
      )
    }
  }

  private async cloneRemotePlugin(
    root: string,
    target: string,
    pluginId: string,
    remote: RemoteGitSource,
  ) {
    const stage = await mkdtemp(join(root, '.install-'))
    const cloneDir = join(stage, 'repo')
    try {
      const args = [
        'clone',
        '--depth',
        '1',
        ...(remote.ref ? ['--branch', remote.ref] : []),
        '--',
        remote.url,
        cloneDir,
      ]
      try {
        await execFileAsync('git', args, { timeout: 60_000 })
      } catch (cause) {
        const detail = cause instanceof Error && cause.message ? `：${cause.message}` : ''
        throw new PluginManagementError('PLUGIN_INVALID', `拉取远程插件仓库失败${detail}`, 502)
      }
      await rm(join(cloneDir, '.git'), { recursive: true, force: true })
      const candidate = remote.subpath ? resolve(cloneDir, remote.subpath) : cloneDir
      if (!contained(cloneDir, candidate)) {
        throw new PluginManagementError('PATH_DENIED', '远程插件路径无效', 403)
      }
      const pluginRoot = await realpath(candidate).catch(() => null)
      if (!pluginRoot || !contained(cloneDir, pluginRoot)) {
        throw new PluginManagementError('PLUGIN_INVALID', '远程插件目录不可用', 409)
      }
      const plugin = await this.loadPlugin({
        expectedId: pluginId,
        pluginRoot,
        source: 'installed',
        policy: undefined,
      })
      if (plugin.summary.status !== 'ready') {
        throw new PluginManagementError(
          'PLUGIN_INVALID',
          plugin.summary.unavailableReason ?? '远程仓库中的插件清单无效',
          409,
        )
      }
      await renameWithRetry(pluginRoot, target)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  private async downloadPlugin(root: string, target: string, pluginId: string) {
    const marketplace = this.marketplace
    if (!marketplace) throw new PluginManagementError('PLUGIN_INVALID', '插件目录未配置', 409)
    const stage = await mkdtemp(join(root, '.install-'))
    try {
      const { entry, bytes, prefix } = await marketplace.archive(pluginId)
      const archive = join(stage, 'plugin.zip')
      await writeFile(archive, bytes)
      let expandedBytes = 0
      let count = 0
      await extractZip(archive, {
        dir: join(stage, 'content'),
        filter: (zipEntry) => {
          expandedBytes += zipEntry.uncompressedSize
          const type = (zipEntry.externalFileAttributes >>> 16) & 0xf000
          if (
            ++count > 10_000 ||
            expandedBytes > MAX_PLUGIN_ARCHIVE_BYTES * 2 ||
            type === 0xa000 ||
            /[\\:]/.test(zipEntry.fileName) ||
            zipEntry.fileName.split('/').some((part) => part === '..' || /[. ]$/.test(part)) ||
            !zipEntry.fileName.startsWith(`${prefix}/`)
          )
            throw new Error('不安全的插件压缩包')
          return zipEntry.fileName.startsWith(`${prefix}/${entry.path}/`)
        },
      })
      const pluginRoot = join(stage, 'content', prefix, entry.path)
      const plugin = await this.loadPlugin({
        expectedId: pluginId,
        pluginRoot,
        source: 'installed',
        policy: undefined,
      })
      if (plugin.summary.status !== 'ready' || plugin.summary.version !== entry.summary.version) {
        throw new PluginManagementError('PLUGIN_INVALID', '下载的插件清单或版本无效', 409)
      }
      await renameWithRetry(pluginRoot, target)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  /**
   * Restores files after the state write failed so a retry can register the
   * same files. A failed rollback keeps the files and reports it instead of
   * pretending the operation completed.
   */
  private async rollbackFailedRegistration(input: {
    action: 'install' | 'uninstall'
    target: string
    stagedRemoval: string | null
    cause: unknown
  }) {
    const detail =
      input.cause instanceof Error && input.cause.message ? `（${input.cause.message}）` : ''
    if (input.action === 'install') {
      throw new PluginRegistrationError(
        `插件文件已就位，但保存安装状态失败${detail}。请刷新插件列表后重试（重复操作只补登记）。`,
      )
    }
    if (!input.stagedRemoval) {
      throw new PluginRegistrationError(`保存卸载状态失败${detail}。插件文件未受影响，请重试。`)
    }
    try {
      await renameWithRetry(input.stagedRemoval, input.target)
    } catch {
      throw new PluginRegistrationError(
        `保存卸载状态失败${detail}，且插件文件未能恢复到原位置。请刷新后重试。`,
      )
    }
    throw new PluginRegistrationError(`保存卸载状态失败${detail}，插件文件已恢复，请重试。`)
  }

  private notifyListeners(pluginId: string, generation: number) {
    for (const listener of this.listeners) {
      try {
        listener(pluginId, generation)
      } catch {
        // A subscriber failure must never rewrite a completed operation.
      }
    }
  }

  private async scanBundled(): Promise<DiscoveredPlugin[]> {
    const root = await realpath(resolve(this.roots.builtinPluginsRoot)).catch(() => null)
    if (!root) return []
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const plugins: DiscoveredPlugin[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (!pluginIdPattern.test(entry.name)) continue
      const pluginRoot = await realpath(join(root, entry.name)).catch(() => null)
      if (!pluginRoot || !contained(root, pluginRoot)) {
        plugins.push(invalidPlugin(entry.name, 'bundled', '插件目录无效'))
        continue
      }
      plugins.push(
        await this.loadPlugin({
          expectedId: entry.name,
          pluginRoot,
          source: 'bundled',
          policy: undefined,
        }),
      )
    }
    return plugins
  }

  private async scanMarketplace(
    marketplacePath: string,
    sourceRoot: string,
    source: 'workspace' | 'personal',
  ): Promise<DiscoveredPlugin[]> {
    let parsed: JsonRecord | null
    try {
      parsed = record(await readJson(marketplacePath))
    } catch {
      return []
    }
    if (!parsed || !Array.isArray(parsed.plugins)) return []
    const canonicalSourceRoot = await realpath(sourceRoot).catch(() => null)
    if (!canonicalSourceRoot) return []
    const plugins: DiscoveredPlugin[] = []
    for (const rawEntry of parsed.plugins) {
      const entry = record(rawEntry)
      const id = stringValue(entry?.name)
      if (!entry || !id || !pluginIdPattern.test(id)) continue
      const sourceDescriptor = record(entry.source)
      if (sourceDescriptor?.source === 'url') {
        const remoteGitSource = parseRemoteGitSource(sourceDescriptor)
        if (!remoteGitSource) {
          plugins.push(invalidPlugin(id, source, '插件远程仓库地址无效'))
          continue
        }
        const policy = normalizePolicy(record(entry.policy)?.installation, 'AVAILABLE')
        const category = stringValue(entry.category) ?? 'Other'
        const interfaceObj = record(entry.interface)
        const displayName = stringValue(interfaceObj?.displayName) ?? id
        const description =
          stringValue(entry.description) ??
          stringValue(interfaceObj?.shortDescription) ??
          remoteGitSource.url
        const developerName = stringValue(interfaceObj?.developerName) ?? '未知开发者'
        plugins.push({
          remoteGitSource,
          summary: {
            id,
            name: displayName,
            version: '0.0.0',
            description,
            developerName,
            category,
            source,
            installationPolicy: policy,
            installed: false,
            enabled: false,
            status: policy === 'NOT_AVAILABLE' ? 'invalid' : 'ready',
            capabilities: [],
            skills: [],
          },
          details: {
            pluginId: id,
            longDescription: description,
            displayCapabilities: [],
            defaultPrompts: [],
            skills: [],
            installSource: {
              repository: remoteGitSource.url,
              version: remoteGitSource.ref ?? 'HEAD',
              components: [],
              unsupportedComponents: [],
            },
          },
          skillRoot: null,
          hookRoot: null,
        })
        continue
      }
      const sourcePath = stringValue(sourceDescriptor?.path)
      if (sourceDescriptor?.source !== 'local' || !sourcePath) continue
      const candidate = resolve(canonicalSourceRoot, sourcePath)
      if (!contained(canonicalSourceRoot, candidate)) {
        plugins.push(invalidPlugin(id, source, '插件来源路径无效'))
        continue
      }
      const pluginRoot = await realpath(candidate).catch(() => null)
      if (!pluginRoot || !contained(canonicalSourceRoot, pluginRoot)) {
        plugins.push(invalidPlugin(id, source, '插件来源不可用'))
        continue
      }
      const policy = normalizePolicy(record(entry.policy)?.installation, 'AVAILABLE')
      plugins.push(
        await this.loadPlugin({
          expectedId: id,
          pluginRoot,
          source,
          policy,
        }),
      )
    }
    return plugins
  }

  private async loadPlugin(input: {
    expectedId: string
    pluginRoot: string
    source: PluginSource
    policy: PluginInstallationPolicy | undefined
  }): Promise<DiscoveredPlugin> {
    try {
      const manifestPath = await realpath(join(input.pluginRoot, '.codex-plugin', 'plugin.json'))
      if (!contained(input.pluginRoot, manifestPath)) throw new Error('manifest 路径无效')
      const manifest = record(await readJson(manifestPath))
      if (!manifest) throw new Error('manifest 无效')
      const id = stringValue(manifest.name)
      const version = stringValue(manifest.version)
      const description = stringValue(manifest.description)
      const author = record(manifest.author)
      const authorName = stringValue(author?.name)
      const interfaceMetadata = record(manifest.interface)
      const displayName = stringValue(interfaceMetadata?.displayName)
      const shortDescription = stringValue(interfaceMetadata?.shortDescription)
      const longDescription = stringValue(interfaceMetadata?.longDescription)
      const developerName = stringValue(interfaceMetadata?.developerName) ?? authorName
      const category = stringValue(interfaceMetadata?.category)
      if (
        !id ||
        id !== input.expectedId ||
        !pluginIdPattern.test(id) ||
        !version ||
        !semverPattern.test(version) ||
        !description ||
        !authorName ||
        !displayName ||
        !shortDescription ||
        !developerName ||
        !category
      ) {
        throw new Error('manifest 字段无效')
      }

      let extension: JsonRecord | null = null
      const extensionPath = await realpath(
        join(input.pluginRoot, '.cpx-plugin', 'plugin.json'),
      ).catch(() => null)
      if (extensionPath) {
        if (!contained(input.pluginRoot, extensionPath)) {
          throw new Error('Pidex 扩展清单路径无效')
        }
        extension = record(await readJson(extensionPath))
        if (
          !extension ||
          extension.schemaVersion !== 1 ||
          !Array.isArray(extension.capabilities) ||
          !extension.capabilities.every((value) => typeof value === 'string' && value.length > 0) ||
          !['NOT_AVAILABLE', 'AVAILABLE', 'INSTALLED_BY_DEFAULT'].includes(
            String(extension.installation),
          )
        ) {
          throw new Error('Pidex 扩展清单无效')
        }
      }

      const presentation = pluginPresentation(interfaceMetadata ?? {})
      const policy = input.policy ?? normalizePolicy(extension?.installation, 'AVAILABLE')
      // 项目 marketplace 显式声明 INSTALLED_BY_DEFAULT 时随该项目生效；个人来源仍不自动安装。
      const installed =
        input.source === 'installed' ||
        (policy === 'INSTALLED_BY_DEFAULT' &&
          (input.source === 'bundled' || input.source === 'workspace'))
      const disabled = new Set(this.settings.state().disabledPluginIds)
      const skills = await this.resolveSkills(input.pluginRoot, stringValue(manifest.skills))
      const docs = await this.resolveDocs(input.pluginRoot, stringValue(manifest.docs))
      const hooksPaths = await this.resolveHooks(
        input.pluginRoot,
        stringOrStringArray(manifest.hooks),
      )
      const declaredApps = await this.resolveApps(input.pluginRoot, stringValue(manifest.apps))
      const declaredHostServers = new Set([
        ...stringArray(extension?.hostMcpServers),
        ...Object.keys(record(manifest.mcpServers) ?? {}),
      ])
      const mcpComponents = hostManagedMcpDeclarations(id, input.source)
        .filter((entry) => declaredHostServers.has(entry.server))
        .map((entry) => ({
          kind: 'mcp' as const,
          id: entry.server,
          name: entry.title,
          description: entry.description,
          managedBy: 'host' as const,
        }))
      const status = policy === 'NOT_AVAILABLE' ? 'unavailable' : 'ready'
      // Components beyond skills: bundled documentation and host-provided MCP
      // servers. Skills keep their own `skills` field for older clients.
      const components = [...mcpComponents, ...docs]
      const hostManagedServers = new Set(mcpComponents.map((component) => component.id))
      const skillComponents: PluginComponent[] = skills.details.map((skill) => ({
        kind: 'skill',
        id: skill.id,
        name: skill.name,
        description: skill.description,
        managedBy: 'plugin',
      }))
      return {
        pluginRoot: input.pluginRoot,
        assets: presentation.assets,
        summary: {
          assetKinds: Object.keys(presentation.assets) as PluginAssetKind[],
          id,
          name: displayName,
          version,
          description: shortDescription,
          developerName,
          category,
          source: input.source,
          installationPolicy: policy,
          installed,
          enabled: installed && !disabled.has(id) && status === 'ready',
          status,
          capabilities: extension ? stringArray(extension.capabilities) : [],
          skills: skills.names,
          ...(status === 'unavailable' ? { unavailableReason: '此插件当前不可用' } : {}),
        },
        details: {
          ...presentation.links,
          pluginId: id,
          longDescription: longDescription ?? shortDescription ?? description,
          displayCapabilities: stringArray(interfaceMetadata?.capabilities),
          defaultPrompts: stringOrStringArray(interfaceMetadata?.defaultPrompt),
          skills: skills.details,
          installSource: {
            // Local sources are disclosed by their source name, never by path.
            repository: input.source,
            version,
            components: [...skillComponents, ...mcpComponents],
            unsupportedComponents: unsupportedPluginComponents([
              ...UNSUPPORTED_MANIFEST_KEYS.map((key) => manifest[key]),
              [...declaredHostServers].filter((server) => !hostManagedServers.has(server)),
            ]),
          },
          ...(components.length ? { components } : {}),
        },
        skillRoot: skills.root
          ? { pluginId: id, pluginRoot: input.pluginRoot, skillsRoot: skills.root }
          : null,
        hookRoot: hooksPaths.length
          ? {
              pluginId: id,
              pluginName: displayName,
              pluginRoot: input.pluginRoot,
              source: input.source,
              hooksPaths,
            }
          : null,
        ...(declaredApps.length ? { declaredApps } : {}),
      }
    } catch {
      return invalidPlugin(input.expectedId, input.source)
    }
  }

  private async resolveSkills(pluginRoot: string, configuredPath: string | null) {
    const candidate = resolve(pluginRoot, configuredPath ?? 'skills')
    if (!contained(pluginRoot, candidate)) return { root: null, names: [] as string[], details: [] }
    const skillsRoot = await realpath(candidate).catch(() => null)
    if (!skillsRoot || !contained(pluginRoot, skillsRoot)) {
      return { root: null, names: [] as string[], details: [] }
    }
    const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => [])
    const names: string[] = []
    const details: Array<PluginDetails['skills'][number]> = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (!pluginIdPattern.test(entry.name)) continue
      const document = await realpath(join(skillsRoot, entry.name, 'SKILL.md')).catch(() => null)
      if (!document || !contained(skillsRoot, document)) continue
      try {
        const bytes = await readFile(document)
        if (bytes.byteLength > MAX_JSON_BYTES) continue
        const { metadata } = parseSkillDocument(decoder.decode(bytes))
        const name = stringValue(metadata.name) ?? entry.name
        names.push(entry.name)
        details.push({
          id: entry.name,
          name,
          description: stringValue(metadata.description) ?? '',
        })
      } catch {
        continue
      }
    }
    return { root: skillsRoot, names, details }
  }

  private async resolveDocs(pluginRoot: string, configuredPath: string | null) {
    if (!configuredPath) return []
    const candidate = resolve(pluginRoot, configuredPath)
    if (!contained(pluginRoot, candidate)) return []
    const docsRoot = await realpath(candidate).catch(() => null)
    if (!docsRoot || !contained(pluginRoot, docsRoot)) return []
    const entries = await readdir(docsRoot, { withFileTypes: true }).catch(() => [])
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => ({
        kind: 'documentation' as const,
        id: entry.name.replace(/\.md$/i, ''),
        name: entry.name,
        description: '',
        managedBy: 'plugin' as const,
      }))
  }

  private async resolveHooks(pluginRoot: string, configuredPaths: string[]) {
    const candidates = configuredPaths.length ? configuredPaths : ['./hooks/hooks.json', './hooks']
    const resolved: string[] = []
    for (const rel of candidates) {
      const candidate = resolve(pluginRoot, rel)
      if (!contained(pluginRoot, candidate)) continue
      const canonical = await realpath(candidate).catch(() => null)
      if (!canonical || !contained(pluginRoot, canonical)) continue
      if (!resolved.includes(canonical)) resolved.push(canonical)
    }
    return resolved
  }

  private async resolveApps(
    pluginRoot: string,
    configuredPath: string | null,
  ): Promise<PluginAppDeclaration[]> {
    const candidate = resolve(pluginRoot, configuredPath ?? '.app.json')
    if (!contained(pluginRoot, candidate)) return []
    const canonical = await realpath(candidate).catch(() => null)
    if (!canonical || !contained(pluginRoot, canonical)) return []
    let parsed: JsonRecord | null
    try {
      parsed = record(await readJson(canonical))
    } catch {
      return []
    }
    const rawApps = record(parsed?.apps)
    if (!rawApps) return []
    const declarations: PluginAppDeclaration[] = []
    for (const [key, value] of Object.entries(rawApps)) {
      const entry = record(value)
      if (!entry) continue
      const id = stringValue(entry.id) ?? (pluginIdPattern.test(key) ? key : null)
      if (!id || !pluginIdPattern.test(id)) continue
      const name = stringValue(entry.name)
      const description = stringValue(entry.description)
      declarations.push({
        id,
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
        ...(typeof entry.required === 'boolean' ? { required: entry.required } : {}),
      })
    }
    return declarations
  }
}

export type { PluginSkillRoot }
