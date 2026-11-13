import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  HOOK_EVENTS,
  HookConfigError,
  MAX_HOOK_CONFIG_BYTES,
  MAX_HOOK_TIMEOUT_MS,
  parseHookDefinitions,
  type HookDefinition,
  type HookDiagnostic,
  type HookEvent,
} from './HookDefinitions'

const COMPATIBILITY_DIRS = ['.pidex', '.agents', '.claude', '.codex'] as const
const USER_COMPATIBILITY_DIRS = ['.agents', '.claude', '.codex'] as const
const INLINE_CONFIG_FILES = ['config.json', 'settings.json', 'settings.local.json'] as const
const decoder = new TextDecoder('utf-8', { fatal: true })
const EVENTS_SET = new Set<string>(HOOK_EVENTS)

const EVENT_ALIASES: Record<string, HookEvent> = {
  sessionstart: 'session_start',
  session_start: 'session_start',
  sessionresume: 'session_resume',
  session_resume: 'session_resume',
  userpromptsubmit: 'user_prompt_submit',
  user_prompt_submit: 'user_prompt_submit',
  pretooluse: 'pre_tool_use',
  pre_tool_use: 'pre_tool_use',
  permissionrequest: 'permission_request',
  permission_request: 'permission_request',
  posttooluse: 'post_tool_use',
  post_tool_use: 'post_tool_use',
  posttoolusefailure: 'post_tool_error',
  posttoolerror: 'post_tool_error',
  post_tool_error: 'post_tool_error',
  precompact: 'pre_compact',
  pre_compact: 'pre_compact',
  stop: 'stop',
  subagentstart: 'subagent_start',
  subagent_start: 'subagent_start',
  subagentstop: 'subagent_stop',
  subagent_stop: 'subagent_stop',
}

export type PluginHookSource = {
  pluginId: string
  pluginName: string
  pluginRoot: string
  scope: 'user' | 'project'
  hooksPaths: readonly string[]
}

export type DiscoveredHookEntry = HookDefinition & {
  identity: string
  filePath: string
  kind: 'config' | 'plugin'
  scope: 'user' | 'project'
  pluginId?: string
  pluginName?: string
}

export type HookDiscoveryGroup = {
  id: string
  kind: 'config' | 'plugin'
  scope: 'user' | 'project'
  displayName: string
  scopeLabel: string
  pluginId?: string
  hooks: DiscoveredHookEntry[]
  diagnostics: HookDiagnostic[]
  /** Combined sha256 of discovered files in this group (used for project trust). */
  configHash: string | null
  primaryConfigPath: string | null
}

export type HookDiscoveryResult = {
  groups: HookDiscoveryGroup[]
  userHooks: DiscoveredHookEntry[]
  projectHooks: DiscoveredHookEntry[]
  pluginHooks: DiscoveredHookEntry[]
  projectConfigHash: string | null
  projectPrimaryConfigPath: string | null
}

export type HookDiscoveryOptions = {
  dataRoot?: string
  userHome?: string
  userHooksFile?: string
  workspaceRoot?: string
  includeProjectHooks?: boolean
  pluginHookSources?: readonly PluginHookSource[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const contained = (root: string, candidate: string) => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const safeRealpath = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

const normalizedPath = (path: string) => {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

const sha256Hex = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

const normalizeEventName = (raw: string): HookEvent | null => {
  const trimmed = raw.trim()
  if (EVENTS_SET.has(trimmed)) return trimmed as HookEvent
  return EVENT_ALIASES[trimmed.toLowerCase()] ?? null
}

const normalizeTimeoutMs = (raw: Record<string, unknown>): number | undefined => {
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
    return Math.min(MAX_HOOK_TIMEOUT_MS, Math.round(raw.timeoutMs))
  }
  if (typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) && raw.timeout > 0) {
    const ms = raw.timeout <= 120 ? raw.timeout * 1000 : raw.timeout
    return Math.min(MAX_HOOK_TIMEOUT_MS, Math.round(ms))
  }
  return undefined
}

const hookIdentity = (input: {
  kind: 'config' | 'plugin'
  scope: 'user' | 'project'
  pluginId?: string
  filePath: string
  event: HookEvent
  id: string
  occurrence: number
}) =>
  sha256Hex(
    JSON.stringify([
      input.kind,
      input.scope,
      input.pluginId ?? '',
      normalizedPath(input.filePath),
      input.event,
      input.id,
      input.occurrence,
    ]),
  )

const parseClaudeEventMap = (
  eventMap: Record<string, unknown>,
  diagnostics: HookDiagnostic[],
  origin: string,
): HookDefinition[] => {
  const definitions: HookDefinition[] = []
  for (const [rawEvent, rawEntries] of Object.entries(eventMap)) {
    const event = normalizeEventName(rawEvent)
    if (!event) {
      diagnostics.push({
        severity: 'warning',
        code: 'HOOK_UNSUPPORTED_EVENT',
        message: `${origin}: 忽略不支持的事件 ${rawEvent}`,
      })
      continue
    }
    if (!Array.isArray(rawEntries)) continue
    let index = 0
    for (const entry of rawEntries) {
      if (!isRecord(entry)) continue
      if (Array.isArray(entry.hooks)) {
        const matcher = typeof entry.matcher === 'string' && entry.matcher.trim() ? entry.matcher.trim() : undefined
        for (const inner of entry.hooks) {
          if (!isRecord(inner)) continue
          const type = typeof inner.type === 'string' ? inner.type : 'command'
          if (type !== 'command' || typeof inner.command !== 'string' || !inner.command.trim()) {
            diagnostics.push({
              severity: 'warning',
              code: 'HOOK_UNSUPPORTED_TYPE',
              message: `${origin}: 跳过非 command 类型 Hook (${rawEvent})`,
            })
            continue
          }
          index++
          const timeoutMs = normalizeTimeoutMs(inner)
          const statusMessage =
            typeof inner.statusMessage === 'string' && inner.statusMessage.trim()
              ? inner.statusMessage.trim()
              : undefined
          const id =
            typeof inner.id === 'string' && inner.id.trim()
              ? inner.id.trim()
              : `${event}:${index}`
          definitions.push({
            id,
            event,
            command: inner.command.trim(),
            ...(matcher ? { matcher } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
            ...(statusMessage ? { statusMessage } : {}),
          })
        }
        continue
      }
      if (typeof entry.command === 'string' && entry.command.trim()) {
        index++
        const timeoutMs = normalizeTimeoutMs(entry)
        const matcher = typeof entry.matcher === 'string' && entry.matcher.trim() ? entry.matcher.trim() : undefined
        const statusMessage =
          typeof entry.statusMessage === 'string' && entry.statusMessage.trim()
            ? entry.statusMessage.trim()
            : undefined
        const id =
          typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `${event}:${index}`
        definitions.push({
          id,
          event,
          command: entry.command.trim(),
          ...(matcher ? { matcher } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
          ...(statusMessage ? { statusMessage } : {}),
        })
      }
    }
  }
  return definitions
}

export const parseDiscoveredHookPayload = (
  parsed: unknown,
  origin: string,
  mode: 'file' | 'inline',
): { definitions: HookDefinition[]; diagnostics: HookDiagnostic[] } => {
  const diagnostics: HookDiagnostic[] = []
  if (mode === 'inline') {
    if (!isRecord(parsed) || parsed.hooks === undefined || parsed.hooks === null) {
      return { definitions: [], diagnostics }
    }
    return parseDiscoveredHookPayload(parsed.hooks, origin, 'file')
  }

  if (Array.isArray(parsed)) {
    return { definitions: parseHookDefinitions(parsed, origin), diagnostics }
  }
  if (!isRecord(parsed)) {
    throw new HookConfigError('HOOK_INVALID', `Hook 配置必须是对象或数组: ${origin}`)
  }

  if (parsed.hooks !== undefined && parsed.hooks !== null) {
    if (Array.isArray(parsed.hooks)) {
      return { definitions: parseHookDefinitions(parsed.hooks, origin), diagnostics }
    }
    if (isRecord(parsed.hooks)) {
      if (Array.isArray(parsed.hooks.config)) {
        return { definitions: parseHookDefinitions(parsed.hooks.config, origin), diagnostics }
      }
      const values = Object.values(parsed.hooks)
      const looksLikeEventMap =
        Object.keys(parsed.hooks).some((key) => normalizeEventName(key) !== null) ||
        values.some((value) => Array.isArray(value))
      if (looksLikeEventMap) {
        return {
          definitions: parseClaudeEventMap(parsed.hooks, diagnostics, origin),
          diagnostics,
        }
      }
      // Pidex id-map shape: { hooks: { [id]: { event, command, ... } } }
      const rawItems = Object.entries(parsed.hooks)
        .filter(([, value]) => isRecord(value))
        .map(([key, value]) => ({ id: key, ...(value as Record<string, unknown>) }))
      return { definitions: parseHookDefinitions(rawItems, origin), diagnostics }
    }
    throw new HookConfigError('HOOK_INVALID', `Hook 配置格式无效: ${origin}`)
  }

  // Top-level Claude Code event map without outer `hooks` wrapper
  if (Object.keys(parsed).some((key) => normalizeEventName(key) !== null)) {
    return {
      definitions: parseClaudeEventMap(parsed, diagnostics, origin),
      diagnostics,
    }
  }

  return { definitions: [], diagnostics }
}

const readJsonHookFile = (
  filePath: string,
  containmentRoot: string,
  mode: 'file' | 'inline',
): {
  canonicalPath: string
  hash: string
  definitions: HookDefinition[]
  diagnostics: HookDiagnostic[]
} | null => {
  if (!existsSync(filePath)) return null
  const canonical = safeRealpath(filePath)
  const canonicalRoot = safeRealpath(containmentRoot)
  if (!canonical || !canonicalRoot || !contained(canonicalRoot, canonical)) return null
  let bytes: Uint8Array
  try {
    const stat = statSync(canonical)
    if (!stat.isFile()) return null
    if (stat.size > MAX_HOOK_CONFIG_BYTES) {
      return {
        canonicalPath: canonical,
        hash: '',
        definitions: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'HOOK_INVALID',
            message: `Hook 配置超过 ${MAX_HOOK_CONFIG_BYTES} bytes: ${canonical}`,
          },
        ],
      }
    }
    bytes = readFileSync(canonical)
  } catch (cause) {
    return {
      canonicalPath: canonical,
      hash: '',
      definitions: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'HOOK_INVALID',
          message: `无法读取 Hook 配置: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      ],
    }
  }

  const hash = sha256Hex(bytes)
  try {
    const text = decoder.decode(bytes)
    const parsed = JSON.parse(text) as unknown
    const result = parseDiscoveredHookPayload(parsed, canonical, mode)
    return { canonicalPath: canonical, hash, ...result }
  } catch (cause) {
    return {
      canonicalPath: canonical,
      hash,
      definitions: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'HOOK_INVALID',
          message: `Hook 配置解析失败 (${canonical}): ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        },
      ],
    }
  }
}

const collectDirCandidates = (baseDir: string, containmentRoot: string) => {
  const candidates: Array<{ path: string; mode: 'file' | 'inline' }> = [
    { path: join(baseDir, 'hooks.json'), mode: 'file' },
  ]
  for (const name of INLINE_CONFIG_FILES) {
    candidates.push({ path: join(baseDir, name), mode: 'inline' })
  }
  const hooksSubdir = safeRealpath(join(baseDir, 'hooks'))
  const canonicalRoot = safeRealpath(containmentRoot)
  if (hooksSubdir && canonicalRoot && contained(canonicalRoot, hooksSubdir)) {
    try {
      const entries = readdirSync(hooksSubdir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        candidates.push({ path: join(hooksSubdir, entry.name), mode: 'file' })
      }
    } catch {
      // ignore unreadable subdir
    }
  }
  return candidates
}

const scanGroupCandidates = (input: {
  candidates: ReadonlyArray<{ path: string; containmentRoot: string; mode: 'file' | 'inline' }>
  kind: 'config' | 'plugin'
  scope: 'user' | 'project'
  pluginId?: string
  pluginName?: string
}) => {
  const seenFiles = new Set<string>()
  const hooks: DiscoveredHookEntry[] = []
  const diagnostics: HookDiagnostic[] = []
  const hashes: string[] = []
  let primaryConfigPath: string | null = null

  for (const candidate of input.candidates) {
    const loaded = readJsonHookFile(candidate.path, candidate.containmentRoot, candidate.mode)
    if (!loaded) continue
    const norm = normalizedPath(loaded.canonicalPath)
    if (seenFiles.has(norm)) continue
    seenFiles.add(norm)

    if (loaded.hash && (loaded.definitions.length > 0 || loaded.diagnostics.length > 0)) {
      hashes.push(`${norm}:${loaded.hash}`)
      if (!primaryConfigPath) primaryConfigPath = loaded.canonicalPath
    }
    diagnostics.push(...loaded.diagnostics)

    const seenPerFile = new Map<string, number>()
    for (const def of loaded.definitions) {
      const key = `${def.event}:${def.id}`
      const occurrence = seenPerFile.get(key) ?? 0
      seenPerFile.set(key, occurrence + 1)
      hooks.push({
        ...def,
        identity: hookIdentity({
          kind: input.kind,
          scope: input.scope,
          ...(input.pluginId ? { pluginId: input.pluginId } : {}),
          filePath: loaded.canonicalPath,
          event: def.event,
          id: def.id,
          occurrence,
        }),
        filePath: loaded.canonicalPath,
        kind: input.kind,
        scope: input.scope,
        ...(input.pluginId ? { pluginId: input.pluginId } : {}),
        ...(input.pluginName ? { pluginName: input.pluginName } : {}),
      })
    }
  }

  const configHash = hashes.length > 0 ? sha256Hex(hashes.join('|')) : null
  return { hooks, diagnostics, configHash, primaryConfigPath }
}

const workspaceLabel = (workspaceRoot: string) => {
  const normalized = resolve(workspaceRoot).replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || normalized
}

export function discoverHooks(options: HookDiscoveryOptions): HookDiscoveryResult {
  const groups: HookDiscoveryGroup[] = []

  // 1. User configuration group (~/.pidex, ~/.agents, ~/.claude, ~/.codex)
  const userCandidates: Array<{ path: string; containmentRoot: string; mode: 'file' | 'inline' }> =
    []
  if (options.userHooksFile) {
    const root = resolve(options.userHooksFile, '..')
    userCandidates.push({ path: options.userHooksFile, containmentRoot: root, mode: 'file' })
  }
  if (options.dataRoot) {
    for (const candidate of collectDirCandidates(options.dataRoot, options.dataRoot)) {
      userCandidates.push({ ...candidate, containmentRoot: options.dataRoot })
    }
  }
  if (options.userHome) {
    for (const dir of USER_COMPATIBILITY_DIRS) {
      const baseDir = join(options.userHome, dir)
      for (const candidate of collectDirCandidates(baseDir, options.userHome)) {
        userCandidates.push({ ...candidate, containmentRoot: options.userHome })
      }
    }
  }
  const userScanned = scanGroupCandidates({
    candidates: userCandidates,
    kind: 'config',
    scope: 'user',
  })
  if (userScanned.hooks.length > 0 || userScanned.diagnostics.length > 0) {
    groups.push({
      id: 'config:user',
      kind: 'config',
      scope: 'user',
      displayName: '用户配置',
      scopeLabel: '所有项目',
      hooks: userScanned.hooks,
      diagnostics: userScanned.diagnostics,
      configHash: userScanned.configHash,
      primaryConfigPath: userScanned.primaryConfigPath,
    })
  }

  // 2. Project configuration group (<workspace>/.pidex, .agents, .claude, .codex)
  let projectHooks: DiscoveredHookEntry[] = []
  let projectConfigHash: string | null = null
  let projectPrimaryConfigPath: string | null = null
  if (options.workspaceRoot && options.includeProjectHooks !== false) {
    const projectCandidates: Array<{
      path: string
      containmentRoot: string
      mode: 'file' | 'inline'
    }> = []
    for (const dir of COMPATIBILITY_DIRS) {
      const baseDir = join(options.workspaceRoot, dir)
      for (const candidate of collectDirCandidates(baseDir, options.workspaceRoot)) {
        projectCandidates.push({ ...candidate, containmentRoot: options.workspaceRoot })
      }
    }
    const projectScanned = scanGroupCandidates({
      candidates: projectCandidates,
      kind: 'config',
      scope: 'project',
    })
    projectHooks = projectScanned.hooks
    projectConfigHash = projectScanned.configHash
    projectPrimaryConfigPath = projectScanned.primaryConfigPath
    if (projectScanned.hooks.length > 0 || projectScanned.diagnostics.length > 0) {
      groups.push({
        id: 'config:project',
        kind: 'config',
        scope: 'project',
        displayName: '项目配置',
        scopeLabel: workspaceLabel(options.workspaceRoot),
        hooks: projectScanned.hooks,
        diagnostics: projectScanned.diagnostics,
        configHash: projectScanned.configHash,
        primaryConfigPath: projectScanned.primaryConfigPath,
      })
    }
  }

  // 3. Enabled plugins
  const pluginHooks: DiscoveredHookEntry[] = []
  for (const plugin of options.pluginHookSources ?? []) {
    const canonicalRoot = safeRealpath(plugin.pluginRoot)
    if (!canonicalRoot) continue
    const candidates: Array<{ path: string; containmentRoot: string; mode: 'file' | 'inline' }> = []
    for (const hookPath of plugin.hooksPaths) {
      const canonical = safeRealpath(hookPath)
      if (!canonical || !contained(canonicalRoot, canonical)) continue
      try {
        const stat = statSync(canonical)
        if (stat.isFile()) {
          candidates.push({ path: canonical, containmentRoot: plugin.pluginRoot, mode: 'file' })
        } else if (stat.isDirectory()) {
          const entries = readdirSync(canonical, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
            .sort((a, b) => a.name.localeCompare(b.name))
          for (const entry of entries) {
            candidates.push({
              path: join(canonical, entry.name),
              containmentRoot: plugin.pluginRoot,
              mode: 'file',
            })
          }
        }
      } catch {
        continue
      }
    }
    const pluginScanned = scanGroupCandidates({
      candidates,
      kind: 'plugin',
      scope: plugin.scope,
      pluginId: plugin.pluginId,
      pluginName: plugin.pluginName,
    })
    if (pluginScanned.hooks.length > 0 || pluginScanned.diagnostics.length > 0) {
      const enrichedHooks = pluginScanned.hooks.map((hook) => ({
        ...hook,
        pluginRoot: canonicalRoot,
      }))
      pluginHooks.push(...enrichedHooks)
      groups.push({
        id: `plugin:${plugin.pluginId}`,
        kind: 'plugin',
        scope: plugin.scope,
        displayName: plugin.pluginName,
        scopeLabel:
          plugin.scope === 'project' && options.workspaceRoot
            ? workspaceLabel(options.workspaceRoot)
            : '所有项目',
        pluginId: plugin.pluginId,
        hooks: enrichedHooks,
        diagnostics: pluginScanned.diagnostics,
        configHash: pluginScanned.configHash,
        primaryConfigPath: pluginScanned.primaryConfigPath,
      })
    }
  }

  return {
    groups,
    userHooks: userScanned.hooks,
    projectHooks,
    pluginHooks,
    projectConfigHash,
    projectPrimaryConfigPath,
  }
}
