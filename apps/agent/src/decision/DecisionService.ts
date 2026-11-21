import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import {
  DecisionConfigSchema,
  type DecisionConfig,
  type DecisionMode,
  type DecisionOutcomeRecord,
  type DecisionPointManifest,
  type DecisionPresentationNotice,
  type JudgeErrorKind,
} from '@pidex/shared/decision'
import type { DecisionEffectiveProvider } from '@pidex/agent-protocol'
import { Effect, Schema } from 'effect'
import { AgentError, type EventEnvelope } from '../Domain'
import {
  ConfigServiceError,
  type ConfigScope,
  type ConfigService,
  type ConfigValue,
} from '../config/ConfigService'
import type { AgentLogger } from '../observability/AgentLogger'
import type { AgentDatabase } from '../storage/database/AgentDatabase'
import type { EventHub } from '../storage/events/EventHub'
import { publishAgentEvent } from '../storage/events/EventPublisher'
import { DecisionEngine, type DecisionOrigin } from './DecisionEngine'
import { isJudgeError, judgeErrorKindOf } from './DecisionErrors'
import { buildCascade, buildJudge, buildProbeJudge, type JudgeFactoryDeps } from './JudgeFactory'
import { CascadeJudge } from './JudgeCascade'
import type { JudgeLike } from './Judge'

/** Effective config with no judges configured: every decision point stays off. */
export const EMPTY_DECISION_CONFIG: DecisionConfig = {
  tiers: [],
  judges: {},
  modes: {},
  routes: {},
  features: {},
  recordState: false,
}

export type DecisionProbeOutcome = {
  ok: boolean
  providerId: string
  modelId?: string
  latencyMs: number
  errorKind?: JudgeErrorKind
  httpStatus?: number
  endpoint?: string
  errorMessage?: string
}

const MAX_PROBE_DETAIL_LENGTH = 300
const PROBE_SECRET_PATTERNS = [
  /\bBearer\s+[^\s,;"']+/gi,
  /\bsk-[A-Za-z0-9._-]+\b/g,
  /\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;"']+/gi,
]
const PROBE_LOCAL_PATH_PATTERN =
  /(?:[A-Za-z]:\\[^\s"'`]+|\/(?:Users|home|var|tmp|etc|opt)\/[^\s"'`]+)/g

function sanitizeProbeMessage(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  let text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  for (const pattern of PROBE_SECRET_PATTERNS) {
    text = text.replace(pattern, '[REDACTED]')
  }
  text = text.replace(PROBE_LOCAL_PATH_PATTERN, '[PATH]')
  return text.slice(0, MAX_PROBE_DETAIL_LENGTH) || undefined
}

function probeHttpStatusOf(error: unknown): number | undefined {
  if (!isJudgeError(error)) return undefined
  const status = error.status
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined
}

function probeEndpointOf(error: unknown): string | undefined {
  if (!isJudgeError(error) || !error.endpoint) return undefined
  const value = error.endpoint.trim().slice(0, MAX_PROBE_DETAIL_LENGTH)
  return value || undefined
}

export type DecisionConfigPatch = {
  keyPath: readonly string[]
  value: unknown
  mergeStrategy?: 'replace' | 'upsert' | undefined
}

const decodeConfig = Schema.decodeUnknownSync(DecisionConfigSchema)

const mergeDecisionSection = (base: DecisionConfig, patch: unknown): DecisionConfig => {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key]
    merged[key] =
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
        ? { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) }
        : value
  }
  return decodeConfig(merged)
}

export type DecisionSetJudgeApiKeyResult = {
  judgeName: string
  credentialId: string | null
  apiKeyMasked: string | null
}

const DECISION_CREDENTIAL_PREFIX = 'decision.'

const decisionCredentialIntegrationID = (judgeName: string): string =>
  `${DECISION_CREDENTIAL_PREFIX}${judgeName}`

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex')

/**
 * Decision configuration, ledger access and presentation notices. The judge
 * engine is attached separately so storage and config work without any judge.
 */
export class DecisionService {
  private cached: { key: string; config: DecisionConfig } | null = null
  private engine: DecisionEngine | null = null
  private engineKey: string | null = null
  private readonly manifest: DecisionPointManifest[] = []
  private readonly credentialOperations = new Map<
    string,
    { fingerprint: string; result: DecisionSetJudgeApiKeyResult }
  >()
  private unsubscribe: (() => void) | null = null
  private origin: (() => DecisionOrigin | undefined) | null = null
  private readonly originScope = new AsyncLocalStorage<DecisionOrigin>()

  constructor(
    private readonly db: AgentDatabase,
    private readonly config: ConfigService,
    private readonly hub: EventHub,
    private readonly judgeDeps: JudgeFactoryDeps = {},
    private readonly logger?: Pick<AgentLogger, 'info' | 'warn' | 'debug'>,
  ) {}

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Host hook: where the current decision is asked from, stored with its record. */
  setOrigin(origin: (() => DecisionOrigin | undefined) | null): void {
    this.origin = origin
  }

  /** Binds the active thread/turn origin for all decisions evaluated within `fn`. */
  runWithOrigin<T>(origin: DecisionOrigin, fn: () => T): T {
    return this.originScope.run(origin, fn)
  }

  private async readConfig(cwd?: string): Promise<DecisionConfig> {
    this.unsubscribe ??= this.config.subscribe(() => {
      this.cached = null
      this.engineKey = null
    })
    const result = await this.config.read(cwd ? { cwd } : {})
    const key = JSON.stringify(result.config.decision ?? null)
    if (this.cached?.key === key) return this.cached.config
    const section = result.config.decision
    const config =
      section === undefined
        ? EMPTY_DECISION_CONFIG
        : mergeDecisionSection(EMPTY_DECISION_CONFIG, section)
    this.cached = { key, config }
    return config
  }

  private builtInModes(): Record<string, DecisionMode> {
    return Object.fromEntries(this.manifest.map((entry) => [entry.id, entry.defaultMode]))
  }

  /**
   * The engine for the effective config, rebuilt when judges, tiers, modes or
   * recordState change. Null when no judge is configured: every point stays off.
   */
  async ensureEngine(cwd?: string): Promise<DecisionEngine | null> {
    const config = await this.readConfig(cwd)
    const key = JSON.stringify({
      judges: config.judges,
      tiers: config.tiers,
      modes: config.modes,
      routes: config.routes,
      recordState: config.recordState,
      manifest: this.manifest.length,
    })
    if (this.engineKey === key) return this.engine
    this.engineKey = key
    const cascade = buildCascade(config, this.judgeDeps)
    if (!cascade) {
      this.engine = null
      return null
    }
    const engine = new DecisionEngine({
      judge: cascade,
      ledger: {
        append: async (record) => {
          const event = this.db.repositories.decisionLedger.appendRecord(record)
          if (event) await Effect.runPromise(this.hub.publish(event))
        },
      },
      defaultMode: 'off',
      modes: config.modes,
      builtInModes: this.builtInModes(),
      recordState: config.recordState,
      origin: () => this.origin?.() ?? this.originScope.getStore(),
      onError: (info) => {
        this.logger?.warn('decision.judge.failed', {
          details: {
            decision: info.specId,
            provider: info.providerId,
            kind: info.kind,
            ...(info.status !== undefined ? { status: info.status } : {}),
            ...(info.endpoint ? { path: info.endpoint } : {}),
            message: info.message,
          },
        })
      },
    })
    for (const [specId, route] of Object.entries(config.routes)) {
      const tiers = route
        .map((name) => {
          const judge = config.judges[name]
          if (!judge) return null
          try {
            return { judge: buildJudge(name, judge, this.judgeDeps) }
          } catch {
            return null
          }
        })
        .filter((tier): tier is { judge: JudgeLike } => tier !== null)
      if (tiers.length === 0) continue
      engine.setJudgeFor(specId, tiers.length === 1 ? tiers[0]!.judge : new CascadeJudge(tiers))
    }
    this.engine = engine
    return engine
  }

  registerManifest(entries: readonly DecisionPointManifest[]): void {
    this.manifest.push(...entries)
    this.engineKey = null
  }

  async getEffectiveConfig(cwd?: string): Promise<DecisionConfig> {
    return this.readConfig(cwd)
  }

  async getConfigView(cwd?: string): Promise<{
    config: DecisionConfig
    manifest: readonly DecisionPointManifest[]
    effectiveProviders: DecisionEffectiveProvider[]
  }> {
    const config = await this.getEffectiveConfig(cwd)
    const apiKeysById = new Map(
      (this.judgeDeps.credentials?.listApiKeys() ?? []).map((item) => [item.id, item]),
    )
    const effectiveProviders = Object.entries(config.judges).map(([name, judge]) => {
      const apiKeyMasked = judge.credentialId
        ? apiKeysById.get(judge.credentialId)?.maskedValue
        : undefined
      return {
        name,
        type: judge.type,
        providerId: judge.providerId ?? judge.type,
        ...(judge.model ? { modelId: judge.model } : {}),
        ...(apiKeyMasked ? { apiKeyMasked } : {}),
      }
    })
    return { config, manifest: this.manifest, effectiveProviders }
  }

  async setJudgeApiKey(input: {
    judgeName: string
    apiKey: string | null
    operationId: string
  }): Promise<DecisionSetJudgeApiKeyResult> {
    const judgeName = input.judgeName.trim()
    if (!judgeName) throw new AgentError('INVALID_REQUEST', 'Judge 名称不能为空', 400)
    const trimmedKey = input.apiKey === null ? null : input.apiKey.trim()
    if (input.apiKey !== null && !trimmedKey) {
      throw new AgentError('INVALID_REQUEST', 'API Key 不能为空', 400)
    }
    // SAFETY: only a SHA-256 fingerprint is kept in memory for idempotency; plaintext keys never enter SQLite or logs.
    const fingerprint = sha256Hex(
      JSON.stringify({
        judgeName,
        keyHash: trimmedKey === null ? null : sha256Hex(trimmedKey),
      }),
    )
    const existingOp = this.credentialOperations.get(input.operationId)
    if (existingOp) {
      if (existingOp.fingerprint !== fingerprint) {
        throw new AgentError('OPERATION_ID_CONFLICT', 'operationId 已用于其他请求', 409)
      }
      return existingOp.result
    }
    const credentials = this.judgeDeps.credentials
    if (!credentials) {
      throw new AgentError('CREDENTIAL_STORE_UNAVAILABLE', '凭据库不可用', 503)
    }
    const integrationID = decisionCredentialIntegrationID(judgeName)
    const existing = credentials.listApiKeys(integrationID)
    let result: DecisionSetJudgeApiKeyResult
    if (trimmedKey === null) {
      for (const item of existing) {
        await Effect.runPromise(credentials.deleteApiKey(item.id))
      }
      result = { judgeName, credentialId: null, apiKeyMasked: null }
    } else if (existing.length > 0) {
      const primary = existing[0]!
      const updated = await Effect.runPromise(credentials.replaceApiKey(primary.id, trimmedKey))
      for (const extra of existing.slice(1)) {
        await Effect.runPromise(credentials.deleteApiKey(extra.id))
      }
      result = {
        judgeName,
        credentialId: updated.id,
        apiKeyMasked: updated.maskedValue,
      }
    } else {
      const created = await Effect.runPromise(
        credentials.createApiKey({
          integrationID,
          label: judgeName,
          key: trimmedKey,
        }),
      )
      result = {
        judgeName,
        credentialId: created.id,
        apiKeyMasked: created.maskedValue,
      }
    }
    this.engineKey = null
    this.credentialOperations.set(input.operationId, { fingerprint, result })
    return result
  }

  private async cleanupOrphanedDecisionCredentials(
    previous: DecisionConfig,
    next: DecisionConfig,
  ): Promise<void> {
    const credentials = this.judgeDeps.credentials
    if (!credentials) return
    const referencedIds = new Set(
      Object.values(next.judges)
        .map((judge) => judge.credentialId)
        .filter((id): id is string => Boolean(id)),
    )
    const allApiKeys = credentials.listApiKeys()
    const byId = new Map(allApiKeys.map((item) => [item.id, item]))
    const toDelete = new Set<string>()
    for (const [name, prevJudge] of Object.entries(previous.judges)) {
      const nextJudge = next.judges[name]
      if (!nextJudge) {
        const integrationID = decisionCredentialIntegrationID(name)
        for (const item of allApiKeys) {
          if (item.integrationID === integrationID && !referencedIds.has(item.id)) {
            toDelete.add(item.id)
          }
        }
      }
      const prevId = prevJudge.credentialId
      if (prevId && prevId !== nextJudge?.credentialId && !referencedIds.has(prevId)) {
        const stored = byId.get(prevId)
        if (stored && stored.integrationID.startsWith(DECISION_CREDENTIAL_PREFIX)) {
          toDelete.add(prevId)
        }
      }
    }
    for (const id of toDelete) {
      try {
        await Effect.runPromise(credentials.deleteApiKey(id))
      } catch {
        this.logger?.warn('decision.credential.cleanup_failed', {
          details: { kind: 'cleanup' },
        })
      }
    }
  }

  async updateConfig(input: {
    scope: ConfigScope
    cwd?: string | undefined
    patch: readonly DecisionConfigPatch[]
    expectedVersion?: string | undefined
    operationId: string
  }): Promise<{ config: DecisionConfig; version: string }> {
    const repository = this.db.repositories.decisionLedger
    const request = { scope: input.scope, cwd: input.cwd ?? null, patch: input.patch }
    const replay = repository.completedOperation(
      input.operationId,
      'decision/updateConfig',
      request,
    )
    if (replay) {
      if (!replay.matches)
        throw new AgentError('OPERATION_ID_CONFLICT', 'operationId 已用于其他请求', 409)
      return replay.result as { config: DecisionConfig; version: string }
    }
    const current = await this.getEffectiveConfig(input.cwd)
    let draft: Record<string, unknown> = { ...current }
    let next: DecisionConfig
    try {
      for (const edit of input.patch) {
        draft = applyDecisionPatch(draft, edit)
      }
      next = decodeConfig(draft)
    } catch (cause) {
      if (cause instanceof AgentError) throw cause
      throw new AgentError('CONFIG_VALIDATION_ERROR', 'decision 配置补丁无效', 400)
    }
    let write
    try {
      write = await this.config.batchWrite({
        edits: [
          {
            keyPath: ['decision'],
            value: next as unknown as ConfigValue,
            mergeStrategy: 'replace',
          },
        ],
        target: { kind: input.scope },
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
      })
    } catch (cause) {
      if (cause instanceof ConfigServiceError) throw new AgentError(cause.code, cause.message, 400)
      throw cause
    }
    const result = { config: next, version: write.version }
    this.db.transaction(() =>
      repository.recordOperation(input.operationId, 'decision/updateConfig', request, result),
    )
    await this.cleanupOrphanedDecisionCredentials(current, next)
    this.cached = null
    return result
  }

  async probe(input: {
    judgeName?: string | undefined
    cwd?: string | undefined
  }): Promise<DecisionProbeOutcome> {
    const config = await this.getEffectiveConfig(input.cwd)
    let built: { name: string; judge: JudgeLike } | null = null
    try {
      built = buildProbeJudge(config, this.judgeDeps, input.judgeName)
    } catch (error) {
      const errorKind = judgeErrorKindOf(error)
      const httpStatus = probeHttpStatusOf(error)
      const endpoint = probeEndpointOf(error)
      const errorMessage = sanitizeProbeMessage(error)
      const configured = config.judges[input.judgeName ?? '']
      this.logger?.warn('decision.probe.failed', {
        details: {
          stage: 'build',
          provider: configured?.providerId ?? configured?.type ?? 'none',
          ...(configured?.model ? { model: configured.model } : {}),
          kind: errorKind,
          ...(httpStatus !== undefined ? { status: httpStatus } : {}),
          ...(endpoint ? { path: endpoint } : {}),
          message: errorMessage ?? (error instanceof Error ? error.message : String(error)),
        },
      })
      return {
        ok: false,
        providerId: configured?.type ?? 'none',
        latencyMs: 0,
        errorKind,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      }
    }
    if (!built) {
      this.logger?.warn('decision.probe.failed', {
        details: {
          stage: 'resolve',
          provider: 'none',
          kind: 'auth',
          message: input.judgeName ? `Judge "${input.judgeName}" not found` : 'No judge configured',
        },
      })
      return { ok: false, providerId: 'none', latencyMs: 0, errorKind: 'auth' }
    }
    const judgeConfig = config.judges[built.name]
    const startedAt = performance.now()
    const result = await built.judge
      .evaluate({
        state: { text: 'ping' },
        questions: { ready: { type: 'boolean', instructions: 'Is `text` the word ping?' } },
      })
      .then(
        (value) => {
          this.logger?.info('decision.probe.succeeded', {
            details: {
              provider: built.judge.id,
              ...((value.modelId ?? judgeConfig?.model)
                ? { model: value.modelId ?? judgeConfig?.model }
                : {}),
              durationMs: value.latencyMs,
            },
          })
          return { ok: true as const, latencyMs: value.latencyMs, modelId: value.modelId }
        },
        (error: unknown) => {
          const latencyMs = Math.round(performance.now() - startedAt)
          const errorKind = judgeErrorKindOf(error)
          const httpStatus = probeHttpStatusOf(error)
          const endpoint = probeEndpointOf(error)
          const errorMessage = sanitizeProbeMessage(error)
          this.logger?.warn('decision.probe.failed', {
            details: {
              provider: built.judge.id,
              ...(judgeConfig?.model ? { model: judgeConfig.model } : {}),
              kind: errorKind,
              ...(httpStatus !== undefined ? { status: httpStatus } : {}),
              ...(endpoint ? { path: endpoint } : {}),
              durationMs: latencyMs,
              message: errorMessage ?? (error instanceof Error ? error.message : String(error)),
            },
          })
          return {
            ok: false as const,
            latencyMs,
            errorKind,
            ...(httpStatus !== undefined ? { httpStatus } : {}),
            ...(endpoint ? { endpoint } : {}),
            ...(errorMessage ? { errorMessage } : {}),
          }
        },
      )
    return {
      ok: result.ok,
      providerId: built.judge.id,
      ...(judgeConfig?.model ? { modelId: judgeConfig.model } : {}),
      ...('modelId' in result && result.modelId ? { modelId: result.modelId } : {}),
      latencyMs: result.latencyMs,
      ...('errorKind' in result ? { errorKind: result.errorKind } : {}),
      ...('httpStatus' in result && result.httpStatus !== undefined
        ? { httpStatus: result.httpStatus }
        : {}),
      ...('endpoint' in result && result.endpoint ? { endpoint: result.endpoint } : {}),
      ...('errorMessage' in result && result.errorMessage
        ? { errorMessage: result.errorMessage }
        : {}),
    }
  }

  async listLedger(input: {
    threadId: string
    turnId?: string | undefined
    specId?: string | undefined
    limit?: number | undefined
    cursor?: string | undefined
  }) {
    if (!this.db.getThread(input.threadId))
      throw new AgentError('THREAD_NOT_FOUND', '会话不存在', 404)
    return this.db.repositories.decisionLedger.listByThread(input)
  }

  async markOutcome(input: {
    ledgerId: string
    threadId: string
    verdict: 'correct' | 'wrong'
    note?: string | undefined
    operationId: string
  }): Promise<{ outcome: DecisionOutcomeRecord }> {
    const repository = this.db.repositories.decisionLedger
    const request = {
      ledgerId: input.ledgerId,
      threadId: input.threadId,
      verdict: input.verdict,
      note: input.note ?? null,
    }
    const replay = repository.completedOperation(input.operationId, 'decision/markOutcome', request)
    if (replay) {
      if (!replay.matches)
        throw new AgentError('OPERATION_ID_CONFLICT', 'operationId 已用于其他请求', 409)
      return replay.result as { outcome: DecisionOutcomeRecord }
    }
    const record = repository.getRecord(input.ledgerId)
    if (!record || (record.threadId != null && record.threadId !== input.threadId)) {
      throw new AgentError('INVALID_REQUEST', '决策记录不存在或不属于该会话', 400)
    }
    const outcome: DecisionOutcomeRecord = {
      id: randomUUID(),
      ledgerId: input.ledgerId,
      threadId: input.threadId,
      kind: 'mark',
      verdict: input.verdict,
      ...(input.note ? { note: input.note } : {}),
      createdAt: Date.now(),
    }
    let event: EventEnvelope | null = null
    this.db.transaction(() => {
      event = repository.appendOutcome(outcome)
      repository.recordOperation(input.operationId, 'decision/markOutcome', request, { outcome })
    })
    if (event) await Effect.runPromise(this.hub.publish(event))
    return { outcome }
  }

  /** Persists a decision outcome and publishes its outbox event to live subscribers. */
  async recordOutcome(outcome: DecisionOutcomeRecord): Promise<void> {
    const event = this.db.repositories.decisionLedger.appendOutcome(outcome)
    if (event) await Effect.runPromise(this.hub.publish(event))
  }

  /** Publishes a user-visible decision notice through the transactional outbox. */
  async presentNotice(notice: DecisionPresentationNotice): Promise<void> {
    await publishAgentEvent(
      this.db,
      this.hub,
      notice.threadId,
      notice.turnId ?? null,
      'decision/notice',
      {
        threadId: notice.threadId,
        notice,
      },
    )
  }
}

const applyDecisionPatch = (
  config: Record<string, unknown>,
  edit: DecisionConfigPatch,
): Record<string, unknown> => {
  const root: Record<string, unknown> = { ...config }
  if (edit.keyPath.length === 0) throw new AgentError('INVALID_REQUEST', 'keyPath 不能为空', 400)
  let container = root
  for (const segment of edit.keyPath.slice(0, -1)) {
    const current = container[segment]
    const nextContainer =
      current !== null && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {}
    container[segment] = nextContainer
    container = nextContainer
  }
  const leaf = edit.keyPath.at(-1)!
  if (edit.value === null && edit.keyPath.length > 1) {
    delete container[leaf]
    return root
  }
  const previous = container[leaf]
  container[leaf] =
    edit.mergeStrategy === 'upsert' &&
    previous !== null &&
    typeof previous === 'object' &&
    !Array.isArray(previous) &&
    edit.value !== null &&
    typeof edit.value === 'object' &&
    !Array.isArray(edit.value)
      ? { ...(previous as Record<string, unknown>), ...(edit.value as Record<string, unknown>) }
      : edit.value
  return root
}
