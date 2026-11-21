import { createHash } from 'node:crypto'
import type {
  DecisionBatch,
  DecisionLedgerRecord,
  DecisionOutcomeRecord,
} from '@pidex/shared/decision'
import type { EventEnvelope } from '../../Domain'
import type { RepositoryDatabase } from './RepositoryDatabase'

/**
 * Decision audit storage. Independent additive tables: older clients ignore them
 * entirely, and thread deletion cascades both ledger rows and their outcomes.
 */
export const DECISION_LEDGER_SCHEMA = [
  `CREATE TABLE decision_ledger (
    id TEXT PRIMARY KEY,
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    turn_id TEXT,
    spec_id TEXT NOT NULL,
    spec_version INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('shadow', 'active')),
    provider_id TEXT NOT NULL,
    model_id TEXT,
    outcome_json TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('judge', 'fallback')),
    reason TEXT,
    judged_json TEXT,
    answers_json TEXT,
    latency_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_input_tokens INTEGER,
    cache_write_tokens INTEGER,
    warnings_json TEXT,
    tiers_json TEXT,
    batch_json TEXT,
    state_digest TEXT NOT NULL,
    state_json TEXT,
    questions_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX idx_decision_ledger_thread_created ON decision_ledger(thread_id, created_at DESC)',
  'CREATE INDEX idx_decision_ledger_spec_created ON decision_ledger(spec_id, created_at DESC)',
  `CREATE TABLE decision_outcomes (
    id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL REFERENCES decision_ledger(id) ON DELETE CASCADE,
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('permission', 'mark', 'nudge')),
    verdict TEXT NOT NULL,
    note TEXT,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX idx_decision_outcomes_ledger ON decision_outcomes(ledger_id, created_at DESC)',
  'CREATE INDEX idx_decision_outcomes_thread ON decision_outcomes(thread_id, created_at DESC)',
  `CREATE TABLE decision_operations (
    operation_id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL
  )`,
] as const

export type DecisionLedgerDatabase = Pick<
  RepositoryDatabase,
  'sqlite' | 'insertEvent' | 'transaction'
>

type LedgerRow = {
  id: string
  thread_id: string | null
  turn_id: string | null
  spec_id: string
  spec_version: number
  mode: 'shadow' | 'active'
  provider_id: string
  model_id: string | null
  outcome_json: string
  source: 'judge' | 'fallback'
  reason: string | null
  judged_json: string | null
  answers_json: string | null
  latency_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  cached_input_tokens: number | null
  cache_write_tokens: number | null
  warnings_json: string | null
  tiers_json: string | null
  batch_json: string | null
  state_digest: string
  state_json: string | null
  questions_json: string | null
  created_at: number
}

type OutcomeRow = {
  id: string
  ledger_id: string
  thread_id: string | null
  kind: 'permission' | 'mark' | 'nudge'
  verdict: string
  note: string | null
  payload_json: string | null
  created_at: number
}

const parseJson = (text: string | null): unknown => {
  if (text === null) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const recordFromRow = (row: LedgerRow): DecisionLedgerRecord => {
  const usage = {
    ...(row.input_tokens != null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens != null ? { outputTokens: row.output_tokens } : {}),
    ...(row.cached_input_tokens != null ? { cachedInputTokens: row.cached_input_tokens } : {}),
    ...(row.cache_write_tokens != null ? { cacheWriteTokens: row.cache_write_tokens } : {}),
  }
  return {
    id: row.id,
    ...(row.thread_id != null ? { threadId: row.thread_id } : {}),
    ...(row.turn_id != null ? { turnId: row.turn_id } : {}),
    specId: row.spec_id,
    specVersion: row.spec_version,
    mode: row.mode,
    providerId: row.provider_id,
    ...(row.model_id != null ? { modelId: row.model_id } : {}),
    outcome: parseJson(row.outcome_json) as DecisionLedgerRecord['outcome'],
    source: row.source,
    ...(row.reason != null ? { reason: row.reason } : {}),
    ...(row.judged_json != null
      ? { judged: parseJson(row.judged_json) as DecisionLedgerRecord['judged'] }
      : {}),
    ...(row.answers_json != null
      ? { answers: parseJson(row.answers_json) as DecisionLedgerRecord['answers'] }
      : {}),
    ...(row.latency_ms != null ? { latencyMs: row.latency_ms } : {}),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(row.warnings_json != null
      ? { warnings: parseJson(row.warnings_json) as DecisionLedgerRecord['warnings'] }
      : {}),
    ...(row.tiers_json != null
      ? { tiers: parseJson(row.tiers_json) as DecisionLedgerRecord['tiers'] }
      : {}),
    ...(row.batch_json != null
      ? { batch: parseJson(row.batch_json) as DecisionBatch }
      : {}),
    stateDigest: row.state_digest,
    ...(row.state_json != null
      ? { state: parseJson(row.state_json) as DecisionLedgerRecord['state'] }
      : {}),
    ...(row.questions_json != null
      ? { questions: parseJson(row.questions_json) as DecisionLedgerRecord['questions'] }
      : {}),
    createdAt: row.created_at,
  }
}

const outcomeFromRow = (row: OutcomeRow): DecisionOutcomeRecord => ({
  id: row.id,
  ledgerId: row.ledger_id,
  ...(row.thread_id != null ? { threadId: row.thread_id } : {}),
  kind: row.kind,
  verdict: row.verdict,
  ...(row.note != null ? { note: row.note } : {}),
  ...(row.payload_json != null
    ? { payload: parseJson(row.payload_json) as DecisionOutcomeRecord['payload'] }
    : {}),
  createdAt: row.created_at,
})

export class DecisionLedgerRepository {
  constructor(private readonly db: DecisionLedgerDatabase) {}

  private hasColumns(name: string, required: readonly string[]): boolean {
    const columns = (
      this.db.sqlite.query(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>
    ).map(({ name }) => name)
    if (columns.length === 0) return false
    const present = new Set(columns)
    return required.every((column) => present.has(column))
  }

  /** Both tables must expose the baseline columns before any read or write. */
  available(): boolean {
    return (
      this.hasColumns('decision_ledger', [
        'id',
        'thread_id',
        'turn_id',
        'spec_id',
        'spec_version',
        'mode',
        'provider_id',
        'model_id',
        'outcome_json',
        'source',
        'reason',
        'judged_json',
        'answers_json',
        'latency_ms',
        'input_tokens',
        'output_tokens',
        'cached_input_tokens',
        'cache_write_tokens',
        'warnings_json',
        'tiers_json',
        'batch_json',
        'state_digest',
        'state_json',
        'questions_json',
        'created_at',
      ]) &&
      this.hasColumns('decision_outcomes', [
        'id',
        'ledger_id',
        'thread_id',
        'kind',
        'verdict',
        'note',
        'payload_json',
        'created_at',
      ]) &&
      this.hasColumns('decision_operations', [
        'operation_id',
        'method',
        'request_hash',
        'result',
        'created_at',
      ])
    )
  }

  /** Idempotent mutation journal, mirroring the goal operation contract. */
  completedOperation(
    operationId: string,
    method: string,
    request: unknown,
  ): { matches: boolean; result: unknown } | null {
    if (!this.available()) return null
    const row = this.db.sqlite
      .query('SELECT method, request_hash, result FROM decision_operations WHERE operation_id = ?')
      .get(operationId) as { method: string; request_hash: string; result: string | null } | null
    if (!row) return null
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    return {
      matches: row.method === method && row.request_hash === requestHash,
      result: row.result ? (parseJson(row.result) ?? null) : null,
    }
  }

  recordOperation(operationId: string, method: string, request: unknown, result: unknown): void {
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    this.db.sqlite
      .query(
        `INSERT INTO decision_operations (operation_id, method, request_hash, result, created_at)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(operationId, method, requestHash, JSON.stringify(result), Date.now())
  }

  /**
   * Appends one decision record and its outbox event in the same transaction, so
   * replay and the ledger never disagree. Callers scrub state before passing it in.
   */
  appendRecord(record: DecisionLedgerRecord): EventEnvelope | null {
    if (!this.available()) return null
    let event: EventEnvelope | null = null
    this.db.transaction(() => {
      this.db.sqlite
        .query(
          `INSERT INTO decision_ledger (id, thread_id, turn_id, spec_id, spec_version, mode,
            provider_id, model_id, outcome_json, source, reason, judged_json, answers_json,
            latency_ms, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
            warnings_json, tiers_json, batch_json, state_digest, state_json, questions_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.threadId ?? null,
          record.turnId ?? null,
          record.specId,
          record.specVersion,
          record.mode,
          record.providerId,
          record.modelId ?? null,
          JSON.stringify(record.outcome),
          record.source,
          record.reason ?? null,
          record.judged === undefined ? null : JSON.stringify(record.judged),
          record.answers === undefined ? null : JSON.stringify(record.answers),
          record.latencyMs ?? null,
          record.usage?.inputTokens ?? null,
          record.usage?.outputTokens ?? null,
          record.usage?.cachedInputTokens ?? null,
          record.usage?.cacheWriteTokens ?? null,
          record.warnings === undefined ? null : JSON.stringify(record.warnings),
          record.tiers === undefined ? null : JSON.stringify(record.tiers),
          record.batch === undefined ? null : JSON.stringify(record.batch),
          record.stateDigest,
          record.state === undefined ? null : JSON.stringify(record.state),
          record.questions === undefined ? null : JSON.stringify(record.questions),
          record.createdAt,
        )
      if (record.threadId != null) {
        event = this.db.insertEvent(record.threadId, record.turnId ?? null, 'decision/recorded', {
          threadId: record.threadId,
          record,
        })
      }
    })
    return event
  }

  /** Appends one outcome and its outbox event in the same transaction. */
  appendOutcome(outcome: DecisionOutcomeRecord): EventEnvelope | null {
    if (!this.available()) return null
    let event: EventEnvelope | null = null
    this.db.transaction(() => {
      this.db.sqlite
        .query(
          `INSERT INTO decision_outcomes (id, ledger_id, thread_id, kind, verdict, note, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          outcome.id,
          outcome.ledgerId,
          outcome.threadId ?? null,
          outcome.kind,
          outcome.verdict,
          outcome.note ?? null,
          outcome.payload === undefined ? null : JSON.stringify(outcome.payload),
          outcome.createdAt,
        )
      if (outcome.threadId != null) {
        event = this.db.insertEvent(outcome.threadId, null, 'decision/outcomeRecorded', {
          threadId: outcome.threadId,
          outcome,
        })
      }
    })
    return event
  }

  getRecord(ledgerId: string): DecisionLedgerRecord | null {
    if (!this.available()) return null
    const row = this.db.sqlite
      .query('SELECT * FROM decision_ledger WHERE id = ?')
      .get(ledgerId) as LedgerRow | null
    return row ? recordFromRow(row) : null
  }

  /**
   * Newest-first thread ledger page with the outcomes of the returned records.
   * The cursor is the last row's `id|createdAt`, keeping pagination stable under
   * same-millisecond inserts.
   */
  listByThread(input: {
    threadId: string
    turnId?: string | undefined
    specId?: string | undefined
    limit?: number | undefined
    cursor?: string | undefined
  }): { records: DecisionLedgerRecord[]; outcomes: DecisionOutcomeRecord[]; nextCursor?: string } {
    if (!this.available()) return { records: [], outcomes: [] }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500)
    const conditions = ['thread_id = ?']
    const params: Array<string | number> = [input.threadId]
    if (input.turnId != null) {
      conditions.push('turn_id = ?')
      params.push(input.turnId)
    }
    if (input.specId != null) {
      conditions.push('spec_id = ?')
      params.push(input.specId)
    }
    if (input.cursor != null) {
      const separator = input.cursor.lastIndexOf('|')
      const id = input.cursor.slice(0, separator)
      const createdAt = Number(input.cursor.slice(separator + 1))
      if (separator < 1 || id.length === 0 || !Number.isFinite(createdAt)) {
        return { records: [], outcomes: [] }
      }
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))')
      params.push(createdAt, createdAt, id)
    }
    const rows = this.db.sqlite
      .query(
        `SELECT * FROM decision_ledger WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as LedgerRow[]
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const records = page.map(recordFromRow)
    const outcomes: DecisionOutcomeRecord[] = []
    if (page.length > 0) {
      const placeholders = page.map(() => '?').join(', ')
      const outcomeRows = this.db.sqlite
        .query(
          `SELECT * FROM decision_outcomes WHERE ledger_id IN (${placeholders})
          ORDER BY created_at DESC, id DESC`,
        )
        .all(...page.map((row) => row.id)) as OutcomeRow[]
      outcomes.push(...outcomeRows.map(outcomeFromRow))
    }
    const last = page.at(-1)
    return {
      records,
      outcomes,
      ...(hasMore && last ? { nextCursor: `${last.id}|${last.created_at}` } : {}),
    }
  }
}