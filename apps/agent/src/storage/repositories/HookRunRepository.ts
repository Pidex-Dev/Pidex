import type { Database } from 'bun:sqlite'

export type HookRunStatus = 'running' | 'completed' | 'failed'

export type HookRunStartInput = {
  id: string
  threadID?: string | null
  turnID?: string | null
  toolCallID?: string | null
  event: string
  hookID: string
  /** Scrubbed evidence snapshot; never surfaced through management RPCs. */
  input: string
  /** Scrubbed command text; never surfaced through management RPCs. */
  command: string
  cwd?: string | null
  evidenceSummary: string
  startedAt: number
}

export type HookRunCursor = {
  startedAt: number
  id: string
}

/**
 * Deliberately narrow projection: input/output/evidence/command/cwd stay inside
 * the database so a management RPC can never leak tool arguments or secrets.
 */
export type HookRunSummaryRow = {
  id: string
  hookID: string
  event: string
  status: HookRunStatus
  startedAt: number
  finishedAt: number | null
  error: string | null
}

type HookRunRow = {
  id: string
  hook_id: string
  event: string
  status: string
  started_at: number
  finished_at: number | null
  error: string | null
}

const mapRow = (row: HookRunRow): HookRunSummaryRow => ({
  id: row.id,
  hookID: row.hook_id,
  event: row.event,
  status: row.status === 'completed' || row.status === 'failed' ? row.status : 'running',
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  error: row.error,
})

/**
 * All `hook_runs` SQL lives here. `HookService` records executions through
 * `start`/`complete`/`fail`; Hook management reads the redacted summary view.
 */
export class HookRunRepository {
  constructor(private readonly database: Database | { sqlite: Database }) {}

  private get sqlite(): Database {
    return 'sqlite' in this.database ? this.database.sqlite : this.database
  }

  start(input: HookRunStartInput) {
    this.sqlite
      .query(
        "INSERT INTO hook_runs (id, thread_id, turn_id, tool_call_id, event, hook_id, status, input, command, cwd, evidence_summary, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        input.threadID ?? null,
        input.turnID ?? null,
        input.toolCallID ?? null,
        input.event,
        input.hookID,
        input.input,
        input.command,
        input.cwd ?? null,
        input.evidenceSummary,
        input.startedAt,
      )
  }

  complete(input: { id: string; output: string; finishedAt: number }) {
    this.sqlite
      .query("UPDATE hook_runs SET status = 'completed', output = ?, finished_at = ? WHERE id = ?")
      .run(input.output, input.finishedAt, input.id)
  }

  fail(input: { id: string; error: string; finishedAt: number }) {
    this.sqlite
      .query("UPDATE hook_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(input.error, input.finishedAt, input.id)
  }

  /**
   * Newest-first page. The cursor is the last row of the previous page, so
   * inserts during pagination never shift an existing page.
   */
  list(input: { hookID?: string; cwd?: string; cursor?: HookRunCursor; limit: number }): {
    rows: HookRunSummaryRow[]
    nextCursor: HookRunCursor | null
    generation: number
  } {
    const where: string[] = []
    const params: Array<string | number> = []
    if (input.hookID) {
      where.push('hook_id = ?')
      params.push(input.hookID)
    }
    if (input.cwd) {
      // Records are scoped to the workspace that produced them so one project
      // cannot read another project's run history.
      where.push('cwd = ?')
      params.push(input.cwd)
    }
    if (input.cursor) {
      where.push('(started_at < ? OR (started_at = ? AND id < ?))')
      params.push(input.cursor.startedAt, input.cursor.startedAt, input.cursor.id)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.sqlite
      .query(
        `SELECT id, hook_id, event, status, started_at, finished_at, error
         FROM hook_runs ${clause}
         ORDER BY started_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, input.limit + 1) as HookRunRow[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      rows: page.map(mapRow),
      nextCursor:
        rows.length > input.limit && last ? { startedAt: last.started_at, id: last.id } : null,
      // rowid grows with every insert; a monotonic generation without new tables.
      generation: (
        this.sqlite.query('SELECT COALESCE(MAX(rowid), 0) AS value FROM hook_runs').get() as {
          value: number
        }
      ).value,
    }
  }
}
