import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  HookListResult,
  HookRunsListResult,
  HookSetEnabledResult,
  HookSourceGroup,
  RpcParams,
} from '@pidex/agent-protocol'
import { AgentError } from '../Domain'
import type { ConfigService } from '../config/ConfigService'
import { secretScrubber } from '../security/SecretScrubber'
import type { HookRunCursor } from '../storage/repositories/HookRunRepository'
import {
  HookSettingsConflictError,
  type HookSettingsRepository,
} from '../storage/repositories/HookSettingsRepository'
import { HookConfigError } from './HookDefinitions'
import { discoverHooks, type PluginHookSource } from './HookDiscovery'
import type { HookService } from './HookService'
import type { HooksManagementService } from './HooksManagement'

type RunStore = Pick<HookService['runRepository'], 'list'>

export type HooksManagementServiceInput = {
  configService: ConfigService
  settings: HookSettingsRepository
  /** `<dataRoot>/hooks.json`. */
  userHooksFile: string
  dataRoot?: string
  userHome?: string
  /** Scrubbed error text; the service never stores raw hook output. */
  scrub?: (value: string) => string
  /** Access to the live run log owned by `HookService`. */
  runs: RunStore
  /** Known project roots for cwd -> workspace resolution. */
  projectRoots?: () => readonly string[]
  /** Enabled plugins contributing hooks. */
  pluginHookSources?: (workspaceRoot?: string) => Promise<readonly PluginHookSource[]>
}

const MAX_ERROR_SUMMARY = 400

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

const statusFor = (code: string) =>
  code === 'HOOK_SOURCE_INVALID' || code === 'PATH_DENIED'
    ? 404
    : code === 'CONFLICT'
      ? 409
      : code === 'CURSOR_EXPIRED'
        ? 409
        : 400

const mapHookError = (cause: unknown): never => {
  if (cause instanceof AgentError) throw cause
  if (cause instanceof HookSettingsConflictError)
    throw new AgentError('CONFLICT', cause.message, 409)
  if (cause instanceof HookConfigError)
    throw new AgentError(cause.code, cause.message, statusFor(cause.code))
  throw new AgentError('INTERNAL_ERROR', 'Hook 配置处理失败', 500)
}

/** Cursor payload: `startedAt:id`, base64url-encoded to stay opaque. */
const encodeCursor = (cursor: HookRunCursor) =>
  Buffer.from(`${cursor.startedAt}:${cursor.id}`, 'utf8').toString('base64url')

const decodeCursor = (value: string): HookRunCursor => {
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  const separator = decoded.indexOf(':')
  const startedAt = Number(decoded.slice(0, separator))
  const id = decoded.slice(separator + 1)
  if (separator <= 0 || !Number.isSafeInteger(startedAt) || startedAt < 0 || !id)
    throw new AgentError('CURSOR_EXPIRED', '运行记录游标无效，请重新加载', 409)
  return { startedAt, id }
}

/**
 * Host-side Hook discovery & enable/disable management.
 */
export class HooksManagement implements HooksManagementService {
  private readonly scrub: (value: string) => string
  private readonly dataRoot: string
  private readonly userHome: string

  constructor(private readonly input: HooksManagementServiceInput) {
    this.scrub = input.scrub ?? ((value) => secretScrubber.scrubText(value))
    this.dataRoot = input.dataRoot ?? resolve(input.userHooksFile, '..')
    this.userHome = input.userHome ?? homedir()
  }

  projectRootFor(cwd: string): string {
    const canonical = safeRealpath(cwd)
    const roots = (this.input.projectRoots?.() ?? [])
      .map(safeRealpath)
      .filter((root) => contained(root, canonical))
      .sort((left, right) => right.length - left.length)
    return roots[0] ?? canonical
  }

  async listSources(cwd?: string): Promise<HookListResult> {
    try {
      const workspaceRoot = cwd ? this.projectRootFor(cwd) : undefined
      const pluginHookSources = this.input.pluginHookSources
        ? await this.input.pluginHookSources(workspaceRoot)
        : []
      const discovered = discoverHooks({
        dataRoot: this.dataRoot,
        userHome: this.userHome,
        userHooksFile: this.input.userHooksFile,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        pluginHookSources,
      })
      const state = this.input.settings.state()
      const disabled = new Set(state.disabledIdentities)
      const projectUntrusted =
        workspaceRoot !== undefined && !this.input.configService.isProjectTrusted(workspaceRoot)

      const groups: HookSourceGroup[] = discovered.groups.map((group) => {
        const isUntrustedProject =
          group.scope === 'project' && projectUntrusted
        const diagnostics = isUntrustedProject
          ? [
              {
                severity: 'warning' as const,
                code: 'CONFIG_PROJECT_UNTRUSTED',
                message: '项目尚未信任，项目 Hook 首次运行前需确认。',
              },
              ...group.diagnostics,
            ]
          : group.diagnostics

        return {
          id: group.id,
          kind: group.kind,
          scope: group.scope,
          displayName: group.displayName,
          scopeLabel: group.scopeLabel,
          ...(group.pluginId ? { pluginId: group.pluginId } : {}),
          ...(isUntrustedProject ? { untrusted: true } : {}),
          hooks: group.hooks.map((hook) => ({
            identity: hook.identity,
            id: hook.id,
            event: hook.event,
            command: hook.command,
            ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
            ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
            ...(hook.statusMessage !== undefined ? { statusMessage: hook.statusMessage } : {}),
            filePath: hook.filePath,
            enabled: !disabled.has(hook.identity),
          })),
          diagnostics,
        }
      })

      return {
        groups,
        generation: state.generation,
        updatedAt: state.updatedAt,
      }
    } catch (cause) {
      return mapHookError(cause)
    }
  }

  async setEnabled(params: RpcParams<'hook/setEnabled'>): Promise<HookSetEnabledResult> {
    try {
      const result = this.input.settings.setEnabled({
        identity: params.identity,
        enabled: params.enabled,
        operationId: params.operationId,
      })
      return {
        identity: params.identity,
        enabled: params.enabled,
        generation: result.state.generation,
        updatedAt: result.state.updatedAt,
      }
    } catch (cause) {
      return mapHookError(cause)
    }
  }

  async listRuns(params: RpcParams<'hook/runs/list'>): Promise<HookRunsListResult> {
    const limit = params.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AgentError('HOOK_INVALID', 'limit 必须在 1..100', 400)
    try {
      const page = this.input.runs.list({
        ...(params.hookId ? { hookID: params.hookId } : {}),
        ...(params.cursor ? { cursor: decodeCursor(params.cursor) } : {}),
        // Runs record the canonical workspace root, so resolve before filtering.
        ...(params.cwd ? { cwd: this.projectRootFor(params.cwd) } : {}),
        limit,
      })
      return {
        runs: page.rows.map((row) => ({
          id: row.id,
          hookId: row.hookID,
          event: row.event as HookRunsListResult['runs'][number]['event'],
          status: row.status,
          startedAt: row.startedAt,
          ...(row.finishedAt !== null ? { finishedAt: row.finishedAt } : {}),
          ...(row.finishedAt !== null && row.startedAt <= row.finishedAt
            ? { durationMs: row.finishedAt - row.startedAt }
            : {}),
          ...(row.error ? { errorSummary: this.safeErrorSummary(row.error) } : {}),
        })),
        ...(page.nextCursor ? { nextCursor: encodeCursor(page.nextCursor) } : {}),
        generation: page.generation,
      }
    } catch (cause) {
      return mapHookError(cause)
    }
  }

  private safeErrorSummary(value: string) {
    const scrubbed = this.scrub(value).replace(/\s+/g, ' ').trim()
    return scrubbed.slice(0, MAX_ERROR_SUMMARY) || 'Hook 执行失败'
  }
}

export const createHooksManagement = (
  hooks: Pick<HookService, 'runRepository'>,
  configService: ConfigService,
  settings: HookSettingsRepository,
  userHooksFile: string,
  db: Pick<import('../storage/database/AgentDatabase').AgentDatabase, 'listProjects'>,
  options?: {
    dataRoot?: string
    userHome?: string
    pluginHookSources?: (workspaceRoot?: string) => Promise<readonly PluginHookSource[]>
    scrub?: (value: string) => string
  },
): HooksManagement =>
  new HooksManagement({
    configService,
    settings,
    userHooksFile,
    runs: hooks.runRepository,
    projectRoots: () => db.listProjects().map((project) => project.rootPath),
    ...(options?.dataRoot ? { dataRoot: options.dataRoot } : {}),
    ...(options?.userHome ? { userHome: options.userHome } : {}),
    ...(options?.pluginHookSources ? { pluginHookSources: options.pluginHookSources } : {}),
    ...(options?.scrub ? { scrub: options.scrub } : {}),
  })
