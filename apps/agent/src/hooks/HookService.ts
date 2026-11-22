import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentDatabase } from '../storage/database/AgentDatabase'
import { AgentError, type EventEnvelope } from '../Domain'
import type { ConfigService } from '../config/ConfigService'
import { HookRunRepository } from '../storage/repositories/HookRunRepository'
import type { HookSettingsRepository } from '../storage/repositories/HookSettingsRepository'
import type { HookDecision, HookDefinition, HookEvent, HookResult } from './HookDefinitions'
import { discoverHooks, type PluginHookSource } from './HookDiscovery'
import {
  hookFileExists,
  inlineHookDefinitions as readInlineHooks,
  readStandaloneHookFile,
} from './HookConfigStore'

export type { HookDecision, HookDefinition, HookEvent, HookResult } from './HookDefinitions'

export interface HookToolRunner {
  run(input: {
    hookID: string
    command: string
    timeoutMs: number
    evidence: string
    threadID?: string
    turnID?: string
    toolCallID?: string
    workspaceRoot?: string
    pluginId?: string
    pluginRoot?: string
  }): Promise<{ output: string }>
}

export type HookScrubber = (value: string) => string
export type HookRunContext = {
  threadID?: string
  turnID?: string
  toolCallID?: string
  toolName?: string
  matcherValue?: string
  workspaceRoot?: string
}
export type HookServiceDiscovery = {
  dataRoot?: string
  userHome?: string
  settings?: HookSettingsRepository
  pluginHookSources?: (workspaceRoot?: string) => Promise<readonly PluginHookSource[]>
}
type ManagedHookEntry = HookDefinition & {
  identity?: string
  contentHash?: string
  kind?: 'config' | 'plugin'
  scope?: 'user' | 'project'
}
type HookConfiguration = {
  hooks: readonly HookDefinition[]
  userConfigHooks: readonly ManagedHookEntry[]
  pluginHooks: readonly ManagedHookEntry[]
  projectConfigHooks: readonly ManagedHookEntry[]
  workspaceRoot: string | null
  configPath: string | null
  configHash: string | null
}
const MAX_OUTPUT_CHARS = 64 * 1024

const extractAdditionalContext = (value: Record<string, unknown>): string | undefined => {
  const hookSpecific =
    value.hookSpecificOutput &&
    typeof value.hookSpecificOutput === 'object' &&
    !Array.isArray(value.hookSpecificOutput)
      ? (value.hookSpecificOutput as Record<string, unknown>)
      : null
  for (const candidate of [
    hookSpecific?.additionalContext,
    value.additionalContext,
    value.additional_context,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}

const parseResult = (output: string): HookResult => {
  const trimmed = output.trim()
  if (!trimmed) return { decision: 'continue' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { decision: 'continue', additionalContext: trimmed }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Hook 输出缺少有效 decision')
  }
  const value = parsed as Record<string, unknown>
  if (
    value.decision !== undefined &&
    !['continue', 'ask', 'deny'].includes(String(value.decision))
  ) {
    throw new Error('Hook 输出缺少有效 decision')
  }
  if (
    value.narrowedInput !== undefined &&
    (!value.narrowedInput ||
      typeof value.narrowedInput !== 'object' ||
      Array.isArray(value.narrowedInput))
  )
    throw new Error('Hook narrowedInput 无效')
  const additionalContext = extractAdditionalContext(value)
  return {
    decision: (value.decision as HookDecision | undefined) ?? 'continue',
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(Array.isArray(value.suggestions)
      ? {
          suggestions: value.suggestions
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 20),
        }
      : {}),
    ...(value.narrowedInput
      ? { narrowedInput: value.narrowedInput as Record<string, unknown> }
      : {}),
    ...(additionalContext ? { additionalContext } : {}),
  }
}

const isNarrowing = (original: unknown, narrowed: unknown): boolean => {
  if (Array.isArray(narrowed))
    return (
      Array.isArray(original) &&
      narrowed.every((item) =>
        original.some((candidate) => JSON.stringify(candidate) === JSON.stringify(item)),
      )
    )
  if (narrowed && typeof narrowed === 'object') {
    if (!original || typeof original !== 'object' || Array.isArray(original)) return false
    return Object.entries(narrowed as Record<string, unknown>).every(
      ([key, value]) =>
        key in (original as Record<string, unknown>) &&
        isNarrowing((original as Record<string, unknown>)[key], value),
    )
  }
  if (typeof narrowed === 'number' && typeof original === 'number') return narrowed <= original
  return Object.is(original, narrowed)
}

export class HookService {
  private readonly configurations = new Map<string, HookConfiguration>()
  private readonly threadConfigurations = new Map<string, string>()
  private readonly runs: HookRunRepository

  constructor(
    private readonly db: AgentDatabase,
    private readonly runner: HookToolRunner,
    private readonly scrub: HookScrubber = (value) => value,
    private readonly publishEvent?: (event: EventEnvelope) => Promise<void>,
    private readonly config?: ConfigService,
    private readonly discovery?: HookServiceDiscovery,
  ) {
    this.runs = new HookRunRepository(db.sqlite)
  }

  /** Runtime reads of the run log, kept for the management service. */
  get runRepository() {
    return this.runs
  }

  async loadWithPlugins(input: {
    userConfigPath?: string
    projectRoot?: string
    includeProjectHooks?: boolean
  }) {
    const pluginHookSources = this.discovery?.pluginHookSources
      ? await this.discovery.pluginHookSources(
          input.includeProjectHooks === false ? undefined : input.projectRoot,
        )
      : []
    return this.load({ ...input, pluginHookSources })
  }

  load(input: {
    userConfigPath?: string
    projectRoot?: string
    includeProjectHooks?: boolean
    pluginHookSources?: readonly PluginHookSource[]
  }) {
    const disabled = this.discovery?.settings?.disabledIdentities() ?? new Set<string>()
    const trustedHashes = this.discovery?.settings?.trustedHashes()
    const layers = this.config?.snapshotLayers(input.projectRoot) ?? []
    const userLayer = layers.find((layer) => layer.kind === 'user')
    const projectLayer = layers.find((layer) => layer.kind === 'project' && layer.trusted)

    const discovered = discoverHooks({
      ...(this.discovery?.dataRoot ? { dataRoot: this.discovery.dataRoot } : {}),
      ...(this.discovery?.userHome ? { userHome: this.discovery.userHome } : {}),
      ...(input.userConfigPath ? { userHooksFile: input.userConfigPath } : {}),
      ...(input.projectRoot ? { workspaceRoot: input.projectRoot } : {}),
      ...(input.includeProjectHooks !== undefined
        ? { includeProjectHooks: input.includeProjectHooks }
        : {}),
      ...(input.pluginHookSources ? { pluginHookSources: input.pluginHookSources } : {}),
    })

    // Preserve compatibility with ConfigService layers whose filePath may sit outside dataRoot (e.g. test fixtures).
    const seenUserFiles = new Set(discovered.userHooks.map((hook) => hook.filePath))
    const extraUserHooks =
      userLayer && (!userLayer.filePath || !seenUserFiles.has(userLayer.filePath))
        ? readInlineHooks(userLayer.config, userLayer.filePath ?? '用户 config.json')
        : []
    const seenProjectFiles = new Set(discovered.projectHooks.map((hook) => hook.filePath))
    const extraProjectHooks =
      input.includeProjectHooks !== false &&
      projectLayer &&
      (!projectLayer.filePath || !seenProjectFiles.has(projectLayer.filePath))
        ? readInlineHooks(projectLayer.config, projectLayer.filePath ?? '项目 config.json')
        : []

    const userConfigHooks: ManagedHookEntry[] = [...discovered.userHooks, ...extraUserHooks]
    const pluginHooks: ManagedHookEntry[] = [...discovered.pluginHooks]
    const projectConfigHooks: ManagedHookEntry[] = [
      ...discovered.projectHooks,
      ...extraProjectHooks,
    ]

    let projectConfigHash = discovered.projectConfigHash
    let projectConfigPath = discovered.projectPrimaryConfigPath
    if (extraProjectHooks.length && projectLayer) {
      projectConfigHash = createHash('sha256')
        .update(`${projectConfigHash ?? ''}:${projectLayer.version}`)
        .digest('hex')
      projectConfigPath = projectLayer.filePath ?? projectConfigPath
    } else if (input.projectRoot && input.includeProjectHooks !== false && !projectConfigPath) {
      const configFile = resolve(input.projectRoot, '.pidex/hooks.json')
      if (hookFileExists(configFile)) {
        const loaded = readStandaloneHookFile(configFile, input.projectRoot)
        projectConfigHash = loaded.hash
        projectConfigPath = loaded.canonical
      }
    }

    const isSnapshotActive = (entry: ManagedHookEntry) => {
      if (entry.identity && disabled.has(entry.identity)) return false
      if (entry.kind === 'plugin' && trustedHashes) {
        return (
          Boolean(entry.identity && entry.contentHash) &&
          trustedHashes.get(entry.identity!) === entry.contentHash
        )
      }
      return true
    }
    const hooks = Object.freeze(
      [...userConfigHooks, ...pluginHooks, ...projectConfigHooks].filter(isSnapshotActive),
    )
    const key = input.projectRoot
      ? `workspace:${realpathSync(input.projectRoot)}`
      : input.userConfigPath && hookFileExists(input.userConfigPath)
        ? `user:${realpathSync(input.userConfigPath)}`
        : 'default'
    this.configurations.set(key, {
      hooks,
      userConfigHooks: Object.freeze(userConfigHooks),
      pluginHooks: Object.freeze(pluginHooks),
      projectConfigHooks: Object.freeze(projectConfigHooks),
      workspaceRoot: input.projectRoot ? realpathSync(input.projectRoot) : null,
      configPath: projectConfigPath,
      configHash: projectConfigHash,
    })
    return hooks.slice()
  }

  definitions(workspaceRoot?: string) {
    if (workspaceRoot)
      return [...(this.configurations.get(`workspace:${realpathSync(workspaceRoot)}`)?.hooks ?? [])]
    if (this.configurations.size === 1) return [...this.configurations.values()][0]!.hooks.slice()
    return []
  }

  private hooksFor(evidence: unknown, context: HookRunContext) {
    const evidenceWorkspace =
      evidence &&
      typeof evidence === 'object' &&
      'workspace' in evidence &&
      typeof (evidence as { workspace?: unknown }).workspace === 'string'
        ? (evidence as { workspace: string }).workspace
        : undefined
    const workspaceRoot = context.workspaceRoot ?? evidenceWorkspace
    if (workspaceRoot) {
      const key = `workspace:${realpathSync(workspaceRoot)}`
      if (context.threadID) this.threadConfigurations.set(context.threadID, key)
      return this.configurations.get(key) ?? null
    }
    const threadKey = context.threadID ? this.threadConfigurations.get(context.threadID) : undefined
    if (threadKey) return this.configurations.get(threadKey) ?? null
    if (this.configurations.size === 1) return [...this.configurations.values()][0]!
    return null
  }

  async run(event: HookEvent, evidence: unknown, context: HookRunContext = {}) {
    // Capture an immutable workspace snapshot before the first await so
    // concurrent projects cannot replace one another's active hook set.
    const configuration = this.hooksFor(evidence, context)
    if (!configuration) return []
    const results: Array<{ hook: HookDefinition; result: HookResult }> = []
    const execute = async (hooks: readonly HookDefinition[]) => {
      for (const hook of hooks) {
        const id = crypto.randomUUID()
        const startedAt = Date.now()
        const safeEvidence = this.scrub(JSON.stringify(evidence)).slice(0, MAX_OUTPUT_CHARS)
        this.runs.start({
          id,
          threadID: context.threadID ?? null,
          turnID: context.turnID ?? null,
          toolCallID: context.toolCallID ?? null,
          event,
          hookID: hook.id,
          input: safeEvidence,
          command: this.scrub(hook.command).slice(0, 4_000),
          cwd: configuration.workspaceRoot,
          evidenceSummary: safeEvidence.slice(0, 2_000),
          startedAt,
        })
        try {
          // Trust gating is already enforced by HookService before reaching the host runner.
          const execution = await this.runner.run({
            hookID: hook.id,
            command: hook.command,
            timeoutMs: Math.min(60_000, hook.timeoutMs ?? 10_000),
            evidence: safeEvidence,
            ...(hook.pluginId ? { pluginId: hook.pluginId } : {}),
            ...(hook.pluginRoot ? { pluginRoot: hook.pluginRoot } : {}),
            ...context,
          })
          const scrubbed = this.scrub(execution.output).slice(0, MAX_OUTPUT_CHARS)
          const result = parseResult(scrubbed)
          if (result.narrowedInput) {
            const originalInput =
              evidence && typeof evidence === 'object' && 'input' in evidence
                ? (evidence as { input: unknown }).input
                : evidence
            if (!isNarrowing(originalInput, result.narrowedInput))
              throw new Error('Hook 试图扩大或替换 tool input scope')
          }
          this.runs.complete({ id, output: JSON.stringify(result), finishedAt: Date.now() })
          results.push({ hook, result })
        } catch (cause) {
          const error = this.scrub(cause instanceof Error ? cause.message : String(cause)).slice(
            0,
            4_000,
          )
          this.runs.fail({ id, error, finishedAt: Date.now() })
          throw new Error(`Hook ${hook.id} 执行失败: ${error}`)
        }
      }
    }
    const disabled = this.discovery?.settings?.disabledIdentities() ?? new Set<string>()
    const trustedHashes = this.discovery?.settings?.trustedHashes()
    const isEnabled = (hook: ManagedHookEntry) =>
      !hook.identity || !disabled.has(hook.identity.toLowerCase())
    const isIndividuallyTrusted = (hook: ManagedHookEntry) => {
      if (!trustedHashes || !hook.identity || !hook.contentHash) return false
      return trustedHashes.get(hook.identity.toLowerCase()) === hook.contentHash.toLowerCase()
    }
    const matchTarget = context.toolName ?? context.matcherValue
    const matches = (hook: HookDefinition) => {
      if (hook.event !== event) return false
      if (!hook.matcher || hook.matcher === '*') return true
      if (!matchTarget) return false
      return hook.matcher
        .split('|')
        .map((part) => part.trim())
        .includes(matchTarget)
    }

    await execute(configuration.userConfigHooks.filter((hook) => isEnabled(hook) && matches(hook)))

    const runnablePluginHooks = configuration.pluginHooks.filter(
      (hook) => isEnabled(hook) && matches(hook) && (!trustedHashes || isIndividuallyTrusted(hook)),
    )
    await execute(runnablePluginHooks)

    const projectHooks = configuration.projectConfigHooks.filter(
      (hook) => isEnabled(hook) && matches(hook),
    )
    if (!projectHooks.length) return results
    const individuallyTrustedProjectHooks = projectHooks.filter(isIndividuallyTrusted)
    const remainingProjectHooks = projectHooks.filter((hook) => !isIndividuallyTrusted(hook))
    await execute(individuallyTrustedProjectHooks)
    if (!remainingProjectHooks.length) return results

    if (configuration.workspaceRoot && configuration.configPath && configuration.configHash) {
      const trust = this.db.hookTrustDecision(configuration.workspaceRoot, configuration.configHash)
      if (trust === 'block') return results
      if (trust !== 'allow') {
        const auditSummary = {
          cwd: configuration.workspaceRoot,
          configPath: configuration.configPath,
          configHash: configuration.configHash,
          hooks: remainingProjectHooks.map((hook) => ({
            id: hook.id,
            event: hook.event,
            command: this.scrub(hook.command).slice(0, 2_000),
          })),
        }
        const pending = this.db.ensureHookTrustRequest({
          threadID: context.threadID ?? null,
          turnID: context.turnID ?? null,
          workspacePath: configuration.workspaceRoot,
          configPath: configuration.configPath,
          configHash: configuration.configHash,
          auditSummary,
        })
        if (pending.event && this.publishEvent) await this.publishEvent(pending.event)
        throw new AgentError(
          'HOOK_TRUST_REQUIRED',
          '项目 Hook 配置尚未获得信任，用户 Hook 已执行，项目 Hook 未执行',
          409,
          { request: pending.request },
        )
      }
    }
    await execute(remainingProjectHooks)
    return results
  }
}
