import { lstat, readdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  DownloadedResourceItem,
  OldChatStorageItem,
  OldChatsScope,
  StorageOldChatsDeleteResult,
  StorageOldChatsListResult,
  StorageResourcesDeleteResult,
  StorageResourcesListResult,
  StorageSummaryResult,
} from '@pidex/agent-protocol'
import type { ConfigService } from '../config/ConfigService'
import type { ThreadHistoryService } from '../session/ThreadHistoryService'
import type { SpeechTranscriptionService } from '../speech/SpeechTranscriptionService'
import type { ManagedToolID, ToolingManager } from '../tool/ToolingManager'
import { AgentError } from '../Domain'
import type { AgentDatabase } from './database/AgentDatabase'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_OLD_CHATS_LIMIT = 20
const MAX_OLD_CHATS_LIMIT = 100

const isContained = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function computePathSize(targetPath: string): Promise<number> {
  const rootStat = await lstat(targetPath).catch(() => null)
  if (!rootStat || rootStat.isSymbolicLink()) return 0
  if (rootStat.isFile()) return rootStat.size
  if (!rootStat.isDirectory()) return 0

  let total = 0
  const stack: string[] = [targetPath]
  while (stack.length > 0) {
    const current = stack.pop()!
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null)
    if (!entries) continue
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile()) {
        const fileStat = await lstat(fullPath).catch(() => null)
        if (fileStat && fileStat.isFile()) {
          total += fileStat.size
        }
      }
    }
  }
  return total
}

async function computeSqliteFilesSize(dbPath: string): Promise<number> {
  if (!dbPath || dbPath === ':memory:') return 0
  const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]
  const sizes = await Promise.all(candidates.map((candidate) => computePathSize(candidate)))
  return sizes.reduce((acc, size) => acc + size, 0)
}

const MANAGED_TOOLING_SPECS: ReadonlyArray<{
  id: ManagedToolID
  name: string
  description: string
}> = [
  { id: 'nodejs', name: 'Node.js 运行时', description: '内置工作空间 Node.js 工具链' },
  { id: 'python', name: 'Python 运行时', description: '内置工作空间 Python 工具链' },
  { id: 'git-bash', name: 'Git Bash 运行时', description: '内置 Windows Git Bash 环境' },
  { id: 'ripgrep', name: 'ripgrep 搜索工具', description: '内置高速代码检索工具' },
]

export class StorageManagementService {
  constructor(
    private readonly db: AgentDatabase,
    private readonly config: ConfigService,
    private readonly history: ThreadHistoryService,
    private readonly deps?: {
      speech?: SpeechTranscriptionService | undefined
      tooling?: ToolingManager | undefined
    },
  ) {}

  getDataDir(): string {
    return resolve(dirname(this.config.userConfigPath))
  }

  getDefaultWorktreeRoot(): string {
    return join(this.getDataDir(), 'managed-worktrees')
  }

  getConfiguredWorktreeRoot(): string | null {
    const desktop = this.config.snapshot().desktop as Record<string, unknown> | undefined
    const raw = typeof desktop?.worktreeRoot === 'string' ? desktop.worktreeRoot.trim() : ''
    if (!raw) return null
    const resolved = resolve(raw)
    if (resolved === resolve(this.getDefaultWorktreeRoot())) return null
    return resolved
  }

  async getSummary(): Promise<StorageSummaryResult> {
    const dataDir = this.getDataDir()
    const defaultWorktreeRoot = this.getDefaultWorktreeRoot()
    const configuredWorktreeRoot = this.getConfiguredWorktreeRoot()

    const dataDirEntries = await readdir(dataDir, { withFileTypes: true }).catch(() => [])
    const historyDbPath = this.db.sqlite.filename
    const profileDbPath = this.db.profileSqlite.filename

    const sqliteKnownFiles = new Set<string>(
      [
        historyDbPath,
        `${historyDbPath}-wal`,
        `${historyDbPath}-shm`,
        `${historyDbPath}-journal`,
        profileDbPath,
        `${profileDbPath}-wal`,
        `${profileDbPath}-shm`,
        `${profileDbPath}-journal`,
      ]
        .filter((item) => item && item !== ':memory:')
        .map((item) => resolve(item)),
    )

    let dataDirBytes = 0
    let worktreeInsideDataDirBytes = 0
    let attachmentsDirBytes = 0
    let directArtifactsDirBytes = 0
    let dbFilesInsideDataDirBytes = 0
    let otherInsideDataDirBytes = 0

    await Promise.all(
      dataDirEntries.map(async (entry) => {
        if (entry.isSymbolicLink()) return
        const fullPath = resolve(dataDir, entry.name)
        const size = await computePathSize(fullPath)
        dataDirBytes += size

        if (entry.isDirectory()) {
          if (entry.name === 'managed-worktrees' || entry.name === 'managed-worktree-state') {
            worktreeInsideDataDirBytes += size
          } else if (entry.name === 'attachments') {
            attachmentsDirBytes += size
          } else if (
            entry.name === 'artifacts' ||
            entry.name === 'visualizations' ||
            entry.name === 'recordings' ||
            entry.name === 'voice'
          ) {
            directArtifactsDirBytes += size
          } else {
            otherInsideDataDirBytes += size
          }
        } else if (entry.isFile()) {
          if (sqliteKnownFiles.has(fullPath)) {
            dbFilesInsideDataDirBytes += size
          } else {
            otherInsideDataDirBytes += size
          }
        }
      }),
    )

    // 如果历史库位于 dataDir 之外（例如测试环境），也纳入数据库文件大小统计
    const [historyFilesBytes, profileFilesBytes] = await Promise.all([
      computeSqliteFilesSize(historyDbPath),
      computeSqliteFilesSize(profileDbPath),
    ])
    const totalSqliteFilesBytes =
      dbFilesInsideDataDirBytes > 0
        ? dbFilesInsideDataDirBytes
        : historyFilesBytes + profileFilesBytes

    // 统计自定义的外部 worktreeRoot（若不在 dataDir 内部）
    let customWorktreeRootBytes: number | null = null
    let externalWorktreeBytes = 0
    if (configuredWorktreeRoot && !isContained(dataDir, configuredWorktreeRoot)) {
      const customSize = await computePathSize(configuredWorktreeRoot)
      customWorktreeRootBytes = customSize
      externalWorktreeBytes = customSize
    }

    // 统计工作树额外 owned_roots（不在 dataDir 也不在 configuredWorktreeRoot 下）
    const ownedRoots = this.db.sqlite
      .query('SELECT DISTINCT root_path FROM worktree_owned_roots')
      .all() as Array<{ root_path: string }>
    for (const row of ownedRoots) {
      if (!row.root_path) continue
      const resolvedRoot = resolve(row.root_path)
      if (isContained(dataDir, resolvedRoot)) continue
      if (configuredWorktreeRoot && isContained(configuredWorktreeRoot, resolvedRoot)) continue
      externalWorktreeBytes += await computePathSize(resolvedRoot)
    }

    // 统计 SQLite 内部消息/附件/归档估算大小
    const messageStats = this.db.sqlite
      .query(
        `SELECT
          COALESCE((SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM inputs), 0) +
          COALESCE((SELECT SUM(LENGTH(CAST(data AS BLOB))) FROM items), 0) +
          COALESCE((SELECT SUM(LENGTH(CAST(title AS BLOB)) + COALESCE(LENGTH(CAST(preview AS BLOB)), 0)) FROM threads), 0) +
          COALESCE((SELECT SUM(LENGTH(CAST(summary AS BLOB)) + LENGTH(CAST(replacement_history AS BLOB))) FROM agent_compactions), 0) +
          COALESCE((SELECT SUM(LENGTH(CAST(message AS BLOB)) + COALESCE(LENGTH(CAST(result AS BLOB)), 0)) FROM subagent_messages), 0) AS total_bytes`,
      )
      .get() as { total_bytes: number } | null

    const messagesBytes = Math.min(
      totalSqliteFilesBytes,
      Math.max(0, messageStats?.total_bytes ?? 0),
    )
    const sqliteOverheadBytes = Math.max(0, totalSqliteFilesBytes - messagesBytes)

    const artifactCatalogRow = this.db.sqlite
      .query('SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM item_artifacts')
      .get() as { total_bytes: number } | null
    const catalogArtifactsBytes = Math.max(0, artifactCatalogRow?.total_bytes ?? 0)

    // attachments 目录同时存放输入附件和 item_artifacts 的内容寻址 blob，按上限切分保证不重不漏
    const artifactsFromBlobs = Math.min(attachmentsDirBytes, catalogArtifactsBytes)
    const attachmentsBytes = Math.max(0, attachmentsDirBytes - artifactsFromBlobs)
    const artifactsBytes = directArtifactsDirBytes + artifactsFromBlobs

    const archivedStats = this.db.sqlite
      .query(
        `WITH RECURSIVE archived_tree(id) AS (
          SELECT id FROM threads WHERE archived_at IS NOT NULL
          UNION ALL
          SELECT child.id FROM threads AS child JOIN archived_tree ON child.parent_thread_id = archived_tree.id
        )
        SELECT
          COALESCE((SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM inputs WHERE thread_id IN (SELECT id FROM archived_tree)), 0) +
          COALESCE((SELECT SUM(LENGTH(CAST(data AS BLOB))) FROM items WHERE thread_id IN (SELECT id FROM archived_tree)), 0) +
          COALESCE((SELECT SUM(size_bytes) FROM input_attachments WHERE thread_id IN (SELECT id FROM archived_tree)), 0) AS total_bytes`,
      )
      .get() as { total_bytes: number } | null
    const archivedBytes = Math.max(0, archivedStats?.total_bytes ?? 0)

    const chatBytes = totalSqliteFilesBytes + attachmentsBytes
    const worktreeBytes = worktreeInsideDataDirBytes + externalWorktreeBytes
    const otherBytes = otherInsideDataDirBytes

    return {
      dataDir,
      defaultWorktreeRoot,
      configuredWorktreeRoot,
      breakdown: {
        chatBytes,
        worktreeBytes,
        artifactsBytes,
        otherBytes,
      },
      chatDetails: {
        messagesBytes,
        attachmentsBytes,
        archivedBytes,
        sqliteOverheadBytes,
      },
      folders: {
        dataDirBytes,
        customWorktreeRootBytes,
      },
      computedAt: Date.now(),
    }
  }

  listOldChats(input: {
    olderThanDays: number | null
    scope: OldChatsScope
    limit?: number | undefined
    offset?: number | undefined
  }): StorageOldChatsListResult {
    const limit = Math.min(
      MAX_OLD_CHATS_LIMIT,
      Math.max(1, input.limit ?? DEFAULT_OLD_CHATS_LIMIT),
    )
    const offset = Math.max(0, input.offset ?? 0)
    const cutoff =
      input.olderThanDays === null ? null : Date.now() - Math.max(0, input.olderThanDays) * DAY_MS

    const conditions: string[] = ['t.parent_thread_id IS NULL']
    const bindings: Array<number | string> = []

    if (input.scope === 'archived') {
      conditions.push('t.archived_at IS NOT NULL')
    } else if (input.scope === 'unarchived') {
      conditions.push('t.archived_at IS NULL')
    }

    if (cutoff !== null) {
      conditions.push('t.updated_at < ?')
      bindings.push(cutoff)
    }

    const whereClause = conditions.join(' AND ')

    const countRow = this.db.sqlite
      .query(`SELECT COUNT(*) AS count FROM threads t WHERE ${whereClause}`)
      .get(...bindings) as { count: number } | null
    const totalCount = countRow?.count ?? 0

    const subagentCountRow = this.db.sqlite
      .query(
        `WITH RECURSIVE matched_roots(id) AS (
          SELECT t.id FROM threads t WHERE ${whereClause}
        ),
        subtree(root_id, id, depth) AS (
          SELECT id, id, 0 FROM matched_roots
          UNION ALL
          SELECT subtree.root_id, child.id, subtree.depth + 1
          FROM threads AS child
          JOIN subtree ON child.parent_thread_id = subtree.id
        )
        SELECT COUNT(*) AS count FROM subtree WHERE depth > 0`,
      )
      .get(...bindings) as { count: number } | null
    const totalSubagentCount = subagentCountRow?.count ?? 0

    const rows = this.db.sqlite
      .query(
        `SELECT t.id, t.title, t.updated_at, t.archived_at
        FROM threads t
        WHERE ${whereClause}
        ORDER BY t.updated_at ASC, t.id ASC
        LIMIT ? OFFSET ?`,
      )
      .all(...bindings, limit, offset) as Array<{
      id: string
      title: string
      updated_at: number
      archived_at: number | null
    }>

    const items: OldChatStorageItem[] = rows.map((row) => {
      const metrics = this.computeThreadSubtreeMetrics(row.id)
      return {
        threadId: row.id,
        title: row.title?.trim() || '未命名对话',
        updatedAt: row.updated_at,
        archivedAt: row.archived_at,
        estimatedBytes: metrics.totalBytes,
        subagentCount: metrics.subagentCount,
        subagentBytes: metrics.subagentBytes,
      }
    })

    return {
      items,
      totalCount,
      totalSubagentCount,
      hasMore: offset + items.length < totalCount,
    }
  }

  private computeThreadSubtreeMetrics(rootThreadId: string): {
    totalBytes: number
    subagentCount: number
    subagentBytes: number
  } {
    const row = this.db.sqlite
      .query(
        `WITH RECURSIVE subtree(id, depth) AS (
          SELECT id, 0 FROM threads WHERE id = ?
          UNION ALL
          SELECT child.id, subtree.depth + 1
          FROM threads AS child
          JOIN subtree ON child.parent_thread_id = subtree.id
        ),
        per_thread AS (
          SELECT
            s.id,
            s.depth,
            COALESCE((SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM inputs WHERE thread_id = s.id), 0) +
            COALESCE((SELECT SUM(LENGTH(CAST(data AS BLOB))) FROM items WHERE thread_id = s.id), 0) +
            COALESCE((SELECT SUM(size_bytes) FROM input_attachments WHERE thread_id = s.id), 0) +
            COALESCE((SELECT SUM(size_bytes) FROM item_artifacts WHERE thread_id = s.id), 0) +
            COALESCE((SELECT SUM(LENGTH(CAST(summary AS BLOB)) + LENGTH(CAST(replacement_history AS BLOB))) FROM agent_compactions WHERE thread_id = s.id), 0) +
            512 AS bytes
          FROM subtree s
        )
        SELECT
          COALESCE(SUM(bytes), 0) AS total_bytes,
          COALESCE(SUM(CASE WHEN depth > 0 THEN 1 ELSE 0 END), 0) AS subagent_count,
          COALESCE(SUM(CASE WHEN depth > 0 THEN bytes ELSE 0 END), 0) AS subagent_bytes
        FROM per_thread`,
      )
      .get(rootThreadId) as {
      total_bytes: number
      subagent_count: number
      subagent_bytes: number
    } | null

    return {
      totalBytes: Math.max(0, row?.total_bytes ?? 0),
      subagentCount: Math.max(0, row?.subagent_count ?? 0),
      subagentBytes: Math.max(0, row?.subagent_bytes ?? 0),
    }
  }

  async deleteOldChats(threadIds: readonly string[]): Promise<StorageOldChatsDeleteResult> {
    const uniqueIds = [...new Set(threadIds.map((id) => id.trim()).filter(Boolean))]
    const beforeBytes = await computeSqliteFilesSize(this.db.sqlite.filename)

    const deletedIds: string[] = []
    const failed: Array<{ threadId: string; reason: string }> = []

    for (const threadId of uniqueIds) {
      try {
        await this.history.remove(threadId)
        deletedIds.push(threadId)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : '删除失败'
        failed.push({ threadId, reason })
      }
    }

    let vacuumed = false
    if (deletedIds.length > 0) {
      vacuumed = this.reclaimSqliteSpace()
    }

    const afterBytes = await computeSqliteFilesSize(this.db.sqlite.filename)
    const reclaimedBytes = Math.max(0, beforeBytes - afterBytes)

    return {
      deletedIds,
      failed,
      reclaimedBytes,
      vacuumed,
    }
  }

  private reclaimSqliteSpace(): boolean {
    try {
      this.db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // WAL checkpoint may fail if another reader holds a lock; ignore and try VACUUM.
    }
    try {
      if (!this.db.sqlite.inTransaction) {
        this.db.sqlite.exec('VACUUM')
        return true
      }
    } catch {
      // Ignore VACUUM failures when concurrent transactions are active.
    }
    return false
  }

  async listDownloadedResources(): Promise<StorageResourcesListResult> {
    const dataDir = this.getDataDir()
    const items: DownloadedResourceItem[] = []

    const speechRoot = join(dataDir, 'speech')
    const speechSize = await computePathSize(speechRoot)
    if (speechSize > 0) {
      items.push({
        id: 'speech:sensevoice',
        name: 'SenseVoice 本地语音模型',
        category: 'speech',
        description: '本地离线语音转写模型与运行时',
        path: speechRoot,
        sizeBytes: speechSize,
      })
    }

    const toolingRoot = join(dataDir, 'tooling')
    for (const spec of MANAGED_TOOLING_SPECS) {
      const toolDir = join(toolingRoot, spec.id)
      const toolSize = await computePathSize(toolDir)
      if (toolSize > 0) {
        items.push({
          id: `tooling:${spec.id}`,
          name: spec.name,
          category: 'tooling',
          description: spec.description,
          path: toolDir,
          sizeBytes: toolSize,
        })
      }
    }

    return { items }
  }

  async deleteDownloadedResource(resourceId: string): Promise<StorageResourcesDeleteResult> {
    const dataDir = this.getDataDir()
    if (resourceId === 'speech:sensevoice') {
      const speechRoot = join(dataDir, 'speech')
      const beforeBytes = await computePathSize(speechRoot)
      if (beforeBytes === 0) {
        throw new AgentError('NOT_FOUND', 'SenseVoice 本地语音模型未安装', 404)
      }
      if (this.deps?.speech) {
        await this.deps.speech.dispose()
      }
      await rm(speechRoot, { recursive: true, force: true })
      if (this.deps?.speech) {
        await this.deps.speech.initialize()
      }
      return { resourceId, reclaimedBytes: beforeBytes }
    }

    if (resourceId.startsWith('tooling:')) {
      const toolId = resourceId.slice('tooling:'.length)
      const spec = MANAGED_TOOLING_SPECS.find((item) => item.id === toolId)
      if (!spec) {
        throw new AgentError('INVALID_REQUEST', `未知工具资源：${resourceId}`, 400)
      }
      const toolDir = join(dataDir, 'tooling', spec.id)
      const beforeBytes = await computePathSize(toolDir)
      if (beforeBytes === 0) {
        throw new AgentError('NOT_FOUND', `${spec.name}未安装`, 404)
      }
      if (this.deps?.tooling) {
        await this.deps.tooling.setPreference(spec.id, 'system')
      }
      await rm(toolDir, { recursive: true, force: true })
      if (this.deps?.tooling) {
        await this.deps.tooling.refreshStatuses()
      }
      return { resourceId, reclaimedBytes: beforeBytes }
    }

    throw new AgentError('INVALID_REQUEST', `未知资源标识：${resourceId}`, 400)
  }
}

export const storageDisplayName = (dirPath: string): string => basename(dirPath) || dirPath
