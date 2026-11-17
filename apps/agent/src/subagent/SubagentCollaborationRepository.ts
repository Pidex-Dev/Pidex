import type { AgentRuntimeResult } from '../orchestration/AgentRuntimeTypes'
import type { AgentDatabase } from '../storage/database/AgentDatabase'
import { AgentError } from '../Domain'
import { secretScrubber } from '../security/SecretScrubber'

export const SUBAGENT_FORK_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS subagent_fork_contexts (task_id TEXT PRIMARY KEY REFERENCES subagent_tasks(id) ON DELETE CASCADE, bundle TEXT NOT NULL, exposure_plan TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS subagent_background_notifications (task_id TEXT PRIMARY KEY REFERENCES subagent_tasks(id) ON DELETE CASCADE, parent_thread_id TEXT NOT NULL, parent_turn_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','notified','discarded')), created_at INTEGER NOT NULL, notified_at INTEGER)`,
] as const

export const SUBAGENT_COLLABORATION_SCHEMA = [
  // Independent tables preserve the schema 21 read/write contract.

  `CREATE TABLE IF NOT EXISTS subagent_messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES subagent_tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL, message TEXT NOT NULL, input_id TEXT REFERENCES inputs(id) ON DELETE SET NULL, turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL, result TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS subagent_completions (turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, result TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS subagent_task_policies (task_id TEXT PRIMARY KEY REFERENCES subagent_tasks(id) ON DELETE CASCADE, allowed_tools TEXT)`,
  `CREATE INDEX IF NOT EXISTS subagent_messages_task_created ON subagent_messages(task_id, created_at, id)`,
] as const

const forkContextStorage = new WeakMap<AgentDatabase, boolean>()
export const subagentForkAvailable = (db: AgentDatabase) => {
  const cached = forkContextStorage.get(db)
  if (cached !== undefined) return cached
  const available =
    (
      db.sqlite
        .query(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'subagent_fork_contexts'",
        )
        .get() as { count: number }
    ).count === 1
  forkContextStorage.set(db, available)
  return available
}

const backgroundNotificationsStorage = new WeakMap<AgentDatabase, boolean>()
export const subagentBackgroundNotificationsAvailable = (db: AgentDatabase) => {
  const cached = backgroundNotificationsStorage.get(db)
  if (cached !== undefined) return cached
  const available =
    (
      db.sqlite
        .query(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'subagent_background_notifications'",
        )
        .get() as { count: number }
    ).count === 1
  backgroundNotificationsStorage.set(db, available)
  return available
}

const inactiveTurnsStorage = new WeakMap<AgentDatabase, boolean>()
const hasInactiveTurnsTable = (db: AgentDatabase) => {
  const cached = inactiveTurnsStorage.get(db)
  if (cached !== undefined) return cached
  const available = Boolean(
    db.sqlite
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_inactive_turns'")
      .get(),
  )
  inactiveTurnsStorage.set(db, available)
  return available
}

const collaborationStorage = new WeakMap<AgentDatabase, boolean>()
export const subagentCollaborationAvailable = (db: AgentDatabase) => {
  const cached = collaborationStorage.get(db)
  if (cached !== undefined) return cached
  const available =
    (
      db.sqlite
        .query(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('subagent_messages','subagent_completions','subagent_task_policies')",
        )
        .get() as { count: number }
    ).count === 3
  collaborationStorage.set(db, available)
  return available
}

export class SubagentCollaborationRepository {
  readonly available: boolean
  constructor(private readonly db: AgentDatabase) {
    this.available = subagentCollaborationAvailable(db)
  }

  assertAvailable() {
    if (!this.available) throw new AgentError('CAPABILITY_REQUIRED', '当前存储不支持递归协作', 409)
  }

  allowedTools(taskID: string): readonly string[] | undefined {
    if (!this.available) return undefined
    const row = this.db.sqlite
      .query('SELECT allowed_tools FROM subagent_task_policies WHERE task_id = ?')
      .get(taskID) as { allowed_tools: string | null } | null
    return row?.allowed_tools ? JSON.parse(row.allowed_tools) : undefined
  }

  children(threadID: string) {
    return this.db.sqlite
      .query(
        'SELECT id, child_thread_id FROM subagent_tasks WHERE parent_thread_id = ? ORDER BY created_at, id',
      )
      .all(threadID) as Array<{ id: string; child_thread_id: string }>
  }

  descendants(threadID: string): Array<{ id: string; child_thread_id: string }> {
    return this.children(threadID).flatMap((child) => [
      child,
      ...this.descendants(child.child_thread_id),
    ])
  }

  assertChild(threadID: string, taskID: string) {
    const row = this.db.sqlite
      .query('SELECT parent_thread_id FROM subagent_tasks WHERE id = ?')
      .get(taskID) as { parent_thread_id: string } | null
    if (!row || row.parent_thread_id !== threadID)
      throw new AgentError('PERMISSION_DENIED', '只能操作直接子 Agent', 403)
  }

  assertRuns(threadID: string, runIDs: string[]) {
    if (!runIDs.length) throw new AgentError('INVALID_PARAMS', '等待目标不能为空', 400)
    for (const id of runIDs) {
      const row = this.db.sqlite
        .query(
          'SELECT t.id FROM subagent_runs r JOIN subagent_tasks t ON t.id = r.task_id WHERE r.id = ? AND t.parent_thread_id = ?',
        )
        .get(id, threadID)
      if (!row) throw new AgentError('PERMISSION_DENIED', '只能等待直接子 Agent', 403)
    }
  }

  rootTurn(turnID: string): string {
    const row = this.db.sqlite
      .query(
        'SELECT t.parent_turn_id FROM turns u JOIN subagent_tasks t ON t.child_thread_id = u.thread_id WHERE u.id = ?',
      )
      .get(turnID) as { parent_turn_id: string } | null
    return row ? this.rootTurn(row.parent_turn_id) : turnID
  }

  assertCapacity(turnID: string, addedTasks: number, addedRuns: number) {
    const row = this.db.sqlite
      .query(
        `WITH RECURSIVE tree AS (
      SELECT id, child_thread_id FROM subagent_tasks WHERE parent_turn_id = ?
      UNION ALL SELECT t.id, t.child_thread_id FROM subagent_tasks t JOIN tree p ON t.parent_thread_id = p.child_thread_id
    ) SELECT (SELECT COUNT(*) FROM tree) AS total, COUNT(*) AS queued FROM subagent_runs r JOIN tree t ON t.id = r.task_id WHERE r.status = 'queued'`,
      )
      .get(this.rootTurn(turnID)) as { total: number; queued: number }
    if (row.total + addedTasks > 64 || row.queued + addedRuns > 24)
      throw new AgentError('SUBAGENT_QUEUE_LIMIT', '根任务的子任务总量或排队量已达上限', 409)
  }

  pending(threadID: string) {
    const excludeBackgroundSql = this.backgroundNotificationsAvailable
      ? " AND NOT EXISTS (SELECT 1 FROM subagent_background_notifications n WHERE n.task_id = t.id AND n.status = 'pending')"
      : ''
    return this.db.sqlite
      .query(
        `SELECT r.id FROM subagent_tasks t JOIN subagent_runs r ON r.task_id = t.id WHERE t.parent_thread_id = ? AND r.status NOT IN ('completed','failed','stopped','interrupted')${excludeBackgroundSql}`,
      )
      .all(threadID) as Array<{ id: string }>
  }

  saved(turnID: string): AgentRuntimeResult | null {
    if (!this.available) return null
    const row = this.db.sqlite
      .query('SELECT result FROM subagent_completions WHERE turn_id = ?')
      .get(turnID) as { result: string } | null
    return row ? JSON.parse(row.result) : null
  }

  save(threadID: string, turnID: string, result: AgentRuntimeResult) {
    this.db.sqlite
      .query('INSERT OR IGNORE INTO subagent_completions VALUES (?, ?, ?, ?)')
      .run(turnID, threadID, JSON.stringify(secretScrubber.scrub(result)), Date.now())
    const agent = this.db.agentForTurn(turnID)
    if (agent) this.db.updateAgentStatus(agent.id, 'waiting_subagents')
    this.db.updateTurnStatus(turnID, 'waiting_subagents')
  }

  clear(turnID: string) {
    if (!this.available) return
    this.db.sqlite.query('DELETE FROM subagent_completions WHERE turn_id = ?').run(turnID)
  }

  completions() {
    if (!this.available) return []
    return this.db.sqlite
      .query('SELECT turn_id, thread_id FROM subagent_completions ORDER BY created_at')
      .all() as Array<{ turn_id: string; thread_id: string }>
  }

  replay(id: string, taskID: string, kind: string, message: string) {
    const row = this.db.sqlite
      .query('SELECT task_id, kind, message, result FROM subagent_messages WHERE id = ?')
      .get(id) as { task_id: string; kind: string; message: string; result: string | null } | null
    if (!row) return null
    if (row.task_id !== taskID || row.kind !== kind || row.message !== message)
      throw new AgentError('CONFLICT', 'operationId 已用于其他消息', 409)
    return row.result ? JSON.parse(row.result) : null
  }

  record(
    id: string,
    taskID: string,
    kind: string,
    message: string,
    result: unknown,
    inputID: string | null = null,
    turnID: string | null = null,
  ) {
    this.db.sqlite
      .query('INSERT INTO subagent_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, taskID, kind, message, inputID, turnID, JSON.stringify(result), Date.now())
  }

  ancestors(threadID: string): string[] {
    const row = this.db.sqlite
      .query('SELECT parent_thread_id FROM subagent_tasks WHERE child_thread_id = ?')
      .get(threadID) as { parent_thread_id: string } | null
    return row ? [row.parent_thread_id, ...this.ancestors(row.parent_thread_id)] : []
  }

  notices(threadID: string) {
    if (!this.available) return []
    return this.db.sqlite
      .query(
        `SELECT m.id, m.kind, m.message, m.created_at FROM subagent_messages m JOIN subagent_tasks t ON t.id = m.task_id WHERE t.parent_thread_id = ? AND m.kind IN ('report','settled') ORDER BY m.created_at, m.id`,
      )
      .all(threadID) as Array<{ id: string; kind: string; message: string; created_at: number }>
  }

  get forkAvailable() {
    return subagentForkAvailable(this.db)
  }

  get backgroundNotificationsAvailable() {
    return subagentBackgroundNotificationsAvailable(this.db)
  }

  isTurnInactive(turnID: string): boolean {
    if (!hasInactiveTurnsTable(this.db)) return false
    return Boolean(
      this.db.sqlite.query('SELECT 1 FROM thread_inactive_turns WHERE turn_id = ?').get(turnID),
    )
  }

  registerBackgroundNotification(taskID: string, parentThreadID: string, parentTurnID: string) {
    if (!this.backgroundNotificationsAvailable) return
    this.db.sqlite
      .query(
        `INSERT OR IGNORE INTO subagent_background_notifications
         (task_id, parent_thread_id, parent_turn_id, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(taskID, parentThreadID, parentTurnID, Date.now())
  }

  pendingBackgroundNotificationSourceTurn(taskID: string): string | null {
    if (!this.backgroundNotificationsAvailable) return null
    const excludeInactiveSql = hasInactiveTurnsTable(this.db)
      ? ' AND NOT EXISTS (SELECT 1 FROM thread_inactive_turns i WHERE i.turn_id = parent_turn_id)'
      : ''
    const row = this.db.sqlite
      .query(
        `SELECT parent_turn_id
         FROM subagent_background_notifications
         WHERE task_id = ? AND status = 'pending'${excludeInactiveSql}`,
      )
      .get(taskID) as { parent_turn_id: string } | null
    return row?.parent_turn_id ?? null
  }

  pendingBackgroundNotifications(parentThreadID: string): number {
    if (!this.backgroundNotificationsAvailable) return 0
    const excludeInactiveSql = hasInactiveTurnsTable(this.db)
      ? ' AND NOT EXISTS (SELECT 1 FROM thread_inactive_turns i WHERE i.turn_id = parent_turn_id)'
      : ''
    const row = this.db.sqlite
      .query(
        `SELECT COUNT(*) AS count
         FROM subagent_background_notifications
         WHERE parent_thread_id = ? AND status = 'pending'${excludeInactiveSql}`,
      )
      .get(parentThreadID) as { count: number }
    return row.count
  }

  discardBackgroundNotificationsForThread(parentThreadID: string) {
    if (!this.backgroundNotificationsAvailable) return
    this.db.sqlite
      .query(
        `UPDATE subagent_background_notifications
         SET status = 'discarded', notified_at = COALESCE(notified_at, ?)
         WHERE parent_thread_id = ? AND status = 'pending'`,
      )
      .run(Date.now(), parentThreadID)
  }

  discardBackgroundNotifications(taskIDs: readonly string[]) {
    if (!this.backgroundNotificationsAvailable || !taskIDs.length) return
    const now = Date.now()
    const update = this.db.sqlite.query(
      "UPDATE subagent_background_notifications SET status = 'discarded', notified_at = ? WHERE task_id = ?",
    )
    this.db.transaction(() => {
      for (const taskID of taskIDs) update.run(now, taskID)
    })
  }

  claimReadyBackgroundNotifications(parentThreadID: string): Array<{
    taskID: string
    parentThreadID: string
    parentTurnID: string
  }> {
    if (!this.backgroundNotificationsAvailable) return []
    const now = Date.now()
    return this.db.transaction(() => {
      if (hasInactiveTurnsTable(this.db)) {
        this.db.sqlite
          .query(
            `UPDATE subagent_background_notifications
             SET status = 'discarded', notified_at = ?
             WHERE parent_thread_id = ? AND status = 'pending'
               AND EXISTS (
                 SELECT 1 FROM thread_inactive_turns i
                 WHERE i.turn_id = subagent_background_notifications.parent_turn_id
               )`,
          )
          .run(now, parentThreadID)
      }
      this.db.sqlite
        .query(
          `UPDATE subagent_background_notifications
           SET status = 'discarded', notified_at = ?
           WHERE parent_thread_id = ? AND status = 'pending'
             AND NOT EXISTS (SELECT 1 FROM threads th WHERE th.id = subagent_background_notifications.parent_thread_id)`,
        )
        .run(now, parentThreadID)
      const ready = this.db.sqlite
        .query(
          `SELECT n.task_id, n.parent_thread_id, n.parent_turn_id
           FROM subagent_background_notifications n
           JOIN subagent_tasks t ON t.id = n.task_id
           JOIN subagent_runs r ON r.id = t.current_run_id
           WHERE n.parent_thread_id = ?
             AND n.status = 'pending'
             AND r.status IN ('completed','failed','stopped','interrupted')
           ORDER BY n.created_at, n.task_id`,
        )
        .all(parentThreadID) as Array<{
        task_id: string
        parent_thread_id: string
        parent_turn_id: string
      }>
      if (!ready.length) return []
      const seal = this.db.sqlite.query(
        "UPDATE subagent_background_notifications SET status = 'notified', notified_at = ? WHERE task_id = ? AND status = 'pending'",
      )
      const claimed: Array<{ taskID: string; parentThreadID: string; parentTurnID: string }> = []
      for (const row of ready) {
        if (seal.run(now, row.task_id).changes > 0) {
          claimed.push({
            taskID: row.task_id,
            parentThreadID: row.parent_thread_id,
            parentTurnID: row.parent_turn_id,
          })
        }
      }
      return claimed
    })
  }

  saveForkContext(
    taskID: string,
    context: {
      bundle: Record<string, unknown>
      exposurePlan: { eager: readonly string[]; deferred: readonly string[]; exposed: readonly string[] }
    },
  ) {
    if (!this.forkAvailable) return
    this.db.sqlite
      .query(
        'INSERT OR REPLACE INTO subagent_fork_contexts (task_id, bundle, exposure_plan, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(taskID, JSON.stringify(context.bundle), JSON.stringify(context.exposurePlan), Date.now())
  }

  forkContext(taskID: string): {
    bundle: Record<string, unknown>
    exposurePlan: { eager: string[]; deferred: string[]; exposed: string[] }
  } | null {
    if (!this.forkAvailable) return null
    const row = this.db.sqlite
      .query('SELECT bundle, exposure_plan FROM subagent_fork_contexts WHERE task_id = ?')
      .get(taskID) as { bundle: string; exposure_plan: string } | null
    if (!row) return null
    return {
      bundle: JSON.parse(row.bundle) as Record<string, unknown>,
      exposurePlan: JSON.parse(row.exposure_plan) as {
        eager: string[]
        deferred: string[]
        exposed: string[]
      },
    }
  }
}
