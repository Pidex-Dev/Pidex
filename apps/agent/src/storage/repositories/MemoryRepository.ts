import type { Database } from 'bun:sqlite'
import type { AgentDatabase } from '../database/AgentDatabase'
import { now } from './RepositoryCore'

/**
 * File memory metadata. Bodies live only in Markdown, so these tables never
 * mirror content: they track format migration, extraction cursors, background
 * tasks, provenance and usage. Legacy `memory_jobs`/`memory_entries` keep their
 * baseline shape and are never read by this generation.
 */
export type MemoryJobKind = 'extract' | 'organize'
export type MemoryJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type MemoryTask = {
  id: string
  namespace: string
  kind: MemoryJobKind
  status: MemoryJobStatus
  trigger: 'turn' | 'manual' | 'auto'
  threadId: string | null
  turnId: string | null
  projectId: string | null
  memoryKey: string | null
  modelRef: string | null
  generation: number
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  updatedAt: number
}

export type MemoryUsageRecord = {
  id: string
  namespace: string
  kind: 'index' | 'body'
  threadId: string | null
  turnId: string | null
  path: string | null
  revision: string | null
  truncated: boolean
  bytes: number
  createdAt: number
}

export const MEMORY_FILE_SCHEMA = [
  `CREATE TABLE memory_namespace_states (
    namespace TEXT PRIMARY KEY,
    generation INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE memory_extract_cursors (
    namespace TEXT PRIMARY KEY,
    last_turn_id TEXT,
    last_created_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE memory_tasks (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('extract','organize')),
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
    trigger TEXT NOT NULL CHECK(trigger IN ('turn','manual','auto')),
    thread_id TEXT,
    turn_id TEXT,
    project_id TEXT,
    memory_key TEXT,
    model_ref TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX memory_tasks_status ON memory_tasks(status, created_at)',
  'CREATE INDEX memory_tasks_namespace ON memory_tasks(namespace, created_at DESC)',
  `CREATE TABLE memory_sources (
    namespace TEXT NOT NULL,
    path TEXT NOT NULL,
    source_thread_id TEXT,
    source_turn_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(namespace, path)
  )`,
  'CREATE INDEX memory_sources_thread ON memory_sources(namespace, source_thread_id)',
  `CREATE TABLE memory_usage (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('index','body')),
    thread_id TEXT,
    turn_id TEXT,
    path TEXT,
    revision TEXT,
    truncated INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX memory_usage_namespace ON memory_usage(namespace, created_at DESC)',
] as const

const MEMORY_FORMAT_KEY = 'memoryFilesFormat'
const MEMORY_ORGANIZE_AUTO_KEY = 'memoryOrganizeAuto'

const rowToTask = (row: Record<string, string | number | null>): MemoryTask => ({
  id: String(row.id),
  namespace: String(row.namespace),
  kind: String(row.kind) as MemoryJobKind,
  status: String(row.status) as MemoryJobStatus,
  trigger: String(row.trigger) as MemoryTask['trigger'],
  threadId: row.thread_id == null ? null : String(row.thread_id),
  turnId: row.turn_id == null ? null : String(row.turn_id),
  projectId: row.project_id == null ? null : String(row.project_id),
  memoryKey: row.memory_key == null ? null : String(row.memory_key),
  modelRef: row.model_ref == null ? null : String(row.model_ref),
  generation: Number(row.generation),
  error: row.error == null ? null : String(row.error),
  createdAt: Number(row.created_at),
  startedAt: row.started_at == null ? null : Number(row.started_at),
  finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  updatedAt: Number(row.updated_at),
})

export class MemoryRepository {
  constructor(private readonly db: AgentDatabase) {}
  private get sqlite(): Database {
    return this.db.sqlite
  }

  /** One-shot switch marker. Present means the legacy rows were already cleaned. */
  filesFormatReady() {
    return Boolean(
      this.db.profileSqlite
        .query('SELECT 1 AS present FROM app_settings WHERE key = ?')
        .get(MEMORY_FORMAT_KEY),
    )
  }

  markFilesFormatReady() {
    this.db.profileSqlite
      .query(
        'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(MEMORY_FORMAT_KEY, '1', now())
  }

  autoOrganizeEnabled() {
    const row = this.db.profileSqlite
      .query('SELECT value FROM app_settings WHERE key = ?')
      .get(MEMORY_ORGANIZE_AUTO_KEY) as { value: string } | null
    return row?.value !== '0'
  }

  setAutoOrganizeEnabled(enabled: boolean) {
    this.db.profileSqlite
      .query(
        'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(MEMORY_ORGANIZE_AUTO_KEY, enabled ? '1' : '0', now())
  }

  /** Bumps the namespace generation so an in-flight snapshot cannot write back. */
  bumpGeneration(namespace: string) {
    this.sqlite
      .query(
        `INSERT INTO memory_namespace_states (namespace, generation, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(namespace) DO UPDATE SET generation = generation + 1, updated_at = excluded.updated_at`,
      )
      .run(namespace, now())
    return this.generation(namespace)
  }

  generation(namespace: string) {
    const row = this.sqlite
      .query('SELECT generation FROM memory_namespace_states WHERE namespace = ?')
      .get(namespace) as { generation: number } | null
    return row?.generation ?? 0
  }

  cursor(namespace: string) {
    const row = this.sqlite
      .query('SELECT last_turn_id, last_created_at FROM memory_extract_cursors WHERE namespace = ?')
      .get(namespace) as { last_turn_id: string | null; last_created_at: number | null } | null
    return row ? { turnId: row.last_turn_id, createdAt: row.last_created_at } : { turnId: null, createdAt: null }
  }

  advanceCursor(namespace: string, turnId: string | null, createdAt: number) {
    this.sqlite
      .query(
        `INSERT INTO memory_extract_cursors (namespace, last_turn_id, last_created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace) DO UPDATE SET
           last_turn_id = excluded.last_turn_id,
           last_created_at = excluded.last_created_at,
           updated_at = excluded.updated_at`,
      )
      .run(namespace, turnId, createdAt, now())
  }

  clearCursor(namespace: string) {
    this.sqlite.query('DELETE FROM memory_extract_cursors WHERE namespace = ?').run(namespace)
  }

  /**
   * Namespace work is serialized: an existing queued or running task absorbs the
   * new request instead of queueing one per message.
   */
  enqueueTask(input: {
    namespace: string
    kind: MemoryJobKind
    trigger: MemoryTask['trigger']
    threadId?: string | null
    turnId?: string | null
    projectId?: string | null
    memoryKey?: string | null
    modelRef?: string | null
  }) {
    return this.db.transaction(() => {
      const existing = this.sqlite        .query(
          "SELECT id, kind, status FROM memory_tasks WHERE namespace = ? AND status IN ('queued', 'running') ORDER BY created_at LIMIT 1",
        )
        .get(input.namespace) as { id: string; kind: MemoryJobKind; status: MemoryJobStatus } | null
      if (existing) {
        // A manual organize request outranks a pending extraction.
        if (input.kind === 'organize' && existing.kind === 'extract' && existing.status === 'queued')
          this.sqlite
            .query(
              "UPDATE memory_tasks SET kind = 'organize', trigger = ?, thread_id = ?, turn_id = ?, model_ref = COALESCE(?, model_ref), updated_at = ? WHERE id = ?",
            )
            .run(
              input.trigger,
              input.threadId ?? null,
              input.turnId ?? null,
              input.modelRef ?? null,
              now(),
              existing.id,
            )
        return { id: existing.id, created: false }
      }
      const id = crypto.randomUUID()
      const timestamp = now()
      this.sqlite
        .query(
          `INSERT INTO memory_tasks (id, namespace, kind, status, trigger, thread_id, turn_id, project_id, memory_key, model_ref, generation, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.namespace,
          input.kind,
          input.trigger,
          input.threadId ?? null,
          input.turnId ?? null,
          input.projectId ?? null,
          input.memoryKey ?? null,
          input.modelRef ?? null,
          this.generation(input.namespace),
          timestamp,
          timestamp,
        )
      return { id, created: true }
    })
  }

  nextQueuedTask() {
    const row = this.sqlite
      .query("SELECT * FROM memory_tasks WHERE status = 'queued' ORDER BY created_at LIMIT 1")
      .get() as Record<string, string | number | null> | null
    return row ? rowToTask(row) : null
  }

  claimTask(id: string) {
    return this.db.transaction(() => {
      const row = this.sqlite
        .query("SELECT * FROM memory_tasks WHERE id = ? AND status = 'queued'")
        .get(id) as Record<string, string | number | null> | null
      if (!row) return null
      this.sqlite
        .query(
          "UPDATE memory_tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(now(), now(), id)
      return rowToTask(row)
    })
  }

  finishTask(id: string, status: MemoryJobStatus, error: string | null = null) {
    this.sqlite
      .query('UPDATE memory_tasks SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?')
      .run(status, error, now(), now(), id)
  }

  /** Service shutdown and namespace resets cancel queued work and running claims. */
  cancelTasks(input: { namespace?: string } = {}) {
    return input.namespace
      ? this.sqlite
          .query(
            "UPDATE memory_tasks SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE namespace = ? AND status IN ('queued', 'running')",
          )
          .run(now(), now(), input.namespace).changes
      : this.sqlite
          .query(
            "UPDATE memory_tasks SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE status IN ('queued', 'running')",
          )
          .run(now(), now()).changes
  }

  /** A restart requeues claims that never settled instead of dropping them. */
  recoverInterruptedTasks() {
    this.sqlite
      .query("UPDATE memory_tasks SET status = 'queued', started_at = NULL, updated_at = ? WHERE status = 'running'")
      .run(now())
  }

  tasks(input: { namespace?: string; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(200, input.limit ?? 50))
    const rows = input.namespace
      ? this.sqlite
          .query('SELECT * FROM memory_tasks WHERE namespace = ? ORDER BY created_at DESC LIMIT ?')
          .all(input.namespace, limit)
      : this.sqlite.query('SELECT * FROM memory_tasks ORDER BY created_at DESC LIMIT ?').all(limit)
    return (rows as Array<Record<string, string | number | null>>).map(rowToTask)
  }

  hasActiveTasks() {
    return Boolean(this.sqlite.query("SELECT 1 AS present FROM memory_tasks WHERE status IN ('queued', 'running') LIMIT 1").get())
  }

  lastSuccessfulTask(namespace: string, kind: MemoryJobKind) {
    const row = this.sqlite
      .query(
        "SELECT * FROM memory_tasks WHERE namespace = ? AND kind = ? AND status = 'completed' ORDER BY finished_at DESC LIMIT 1",
      )
      .get(namespace, kind) as Record<string, string | number | null> | null
    return row ? rowToTask(row) : null
  }

  lastFailedTask(namespace: string, kind: MemoryJobKind) {
    const row = this.sqlite
      .query(
        "SELECT * FROM memory_tasks WHERE namespace = ? AND kind = ? AND status = 'failed' ORDER BY finished_at DESC LIMIT 1",
      )
      .get(namespace, kind) as Record<string, string | number | null> | null
    return row ? rowToTask(row) : null
  }

  /** Distinct chats that produced memory content since the last organize. */
  distinctSourceThreadsSince(namespace: string, since: number | null) {
    const rows = this.sqlite
      .query(
        `SELECT DISTINCT source_thread_id FROM memory_sources
         WHERE namespace = ? AND source_thread_id IS NOT NULL AND updated_at > ?
         ORDER BY updated_at DESC LIMIT 50`,
      )
      .all(namespace, since ?? 0) as Array<{ source_thread_id: string }>
    return rows.map((row) => row.source_thread_id)
  }

  recordSource(input: {
    namespace: string
    path: string
    threadId?: string | null
    turnId?: string | null
    updatedAt?: number
  }) {
    this.sqlite
      .query(
        `INSERT INTO memory_sources (namespace, path, source_thread_id, source_turn_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(namespace, path) DO UPDATE SET
           source_thread_id = COALESCE(excluded.source_thread_id, source_thread_id),
           source_turn_id = COALESCE(excluded.source_turn_id, source_turn_id),
           updated_at = excluded.updated_at`,
      )
      .run(input.namespace, input.path, input.threadId ?? null, input.turnId ?? null, input.updatedAt ?? now())
  }

  sources(namespace: string) {
    const rows = this.sqlite
      .query(
        'SELECT path, source_thread_id, source_turn_id, updated_at FROM memory_sources WHERE namespace = ? ORDER BY updated_at DESC',
      )
      .all(namespace) as Array<{
      path: string
      source_thread_id: string | null
      source_turn_id: string | null
      updated_at: number
    }>
    return rows.map((row) => ({
      path: row.path,
      threadId: row.source_thread_id,
      turnId: row.source_turn_id,
      updatedAt: row.updated_at,
    }))
  }

  forgetSource(namespace: string, path: string) {
    this.sqlite.query('DELETE FROM memory_sources WHERE namespace = ? AND path = ?').run(namespace, path)
  }

  clearSources(namespace: string) {
    this.sqlite.query('DELETE FROM memory_sources WHERE namespace = ?').run(namespace)
  }

  /**
   * Usage separates index injection from body reads. Content is never copied:
   * only where it came from and how much of it was seen.
   */
  recordUsage(input: {
    namespace: string
    kind: 'index' | 'body'
    threadId?: string | null
    turnId?: string | null
    path: string | null
    revision: string | null
    truncated: boolean
    bytes: number
  }) {
    this.sqlite
      .query(
        `INSERT INTO memory_usage (id, namespace, kind, thread_id, turn_id, path, revision, truncated, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        input.namespace,
        input.kind,
        input.threadId ?? null,
        input.turnId ?? null,
        input.path,
        input.revision,
        input.truncated ? 1 : 0,
        input.bytes,
        now(),
      )
  }

  usage(input: { namespace?: string; cursor?: number; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(200, input.limit ?? 50))
    const rows = input.namespace
      ? this.sqlite
          .query(
            'SELECT * FROM memory_usage WHERE namespace = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?',
          )
          .all(input.namespace, input.cursor ?? Number.MAX_SAFE_INTEGER, limit)
      : this.sqlite
          .query('SELECT * FROM memory_usage WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(input.cursor ?? Number.MAX_SAFE_INTEGER, limit)
    return (
      rows as Array<{
        id: string
        namespace: string
        kind: string
        thread_id: string | null
        turn_id: string | null
        path: string | null
        revision: string | null
        truncated: number
        bytes: number
        created_at: number
      }>
    ).map((row): MemoryUsageRecord => ({
      id: row.id,
      namespace: row.namespace,
      kind: row.kind as 'index' | 'body',
      threadId: row.thread_id,
      turnId: row.turn_id,
      path: row.path,
      revision: row.revision,
      truncated: row.truncated === 1,
      bytes: row.bytes,
      createdAt: row.created_at,
    }))
  }

  /** Named agent identities that already have memory in a project. */
  namedAgentKeys(projectId: string) {
    const prefix = `agent:${projectId}:`
    const rows = this.sqlite
      .query(
        `SELECT DISTINCT memory_key FROM memory_tasks WHERE project_id = ? AND memory_key IS NOT NULL
         UNION
         SELECT DISTINCT substr(namespace, ?) AS memory_key FROM memory_sources
         WHERE namespace LIKE ? AND substr(namespace, ?) <> ''`,
      )
      .all(projectId, prefix.length + 1, `${prefix}%`, prefix.length + 1) as Array<{
      memory_key: string
    }>
    return rows.map((row) => row.memory_key)
  }

  /** Legacy cleanup: rows this build can identify as the retired SQLite store. */
  deleteLegacyMemoryRows() {
    return this.db.transaction(() => {
      const entries = (
        this.db.profileSqlite.query('DELETE FROM memory_entries').run() as { changes: number }
      ).changes
      const jobs = (this.sqlite.query('DELETE FROM memory_jobs').run() as { changes: number }).changes
      return { entries, jobs }
    })
  }
}
