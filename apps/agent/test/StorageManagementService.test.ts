import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeFixturePaths } from './FixtureCleanup'
import { AgentDatabase } from '../src/storage/database/AgentDatabase'
import { StorageManagementService } from '../src/storage/StorageManagementService'

const roots: string[] = []
afterEach(async () => {
  await removeFixturePaths(roots.splice(0))
})

describe('StorageManagementService', () => {
  test('统计数据目录分类与明细，并支持筛选、聚合子智能体及删除旧聊天', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-storage-test-'))
    roots.push(root)
    const dbPath = join(root, 'history.db')
    const db = new AgentDatabase(dbPath)

    // 创建示例文件以验证目录分类统计
    await mkdir(join(root, 'managed-worktrees'), { recursive: true })
    await writeFile(join(root, 'managed-worktrees', 'wt.txt'), 'a'.repeat(1024))
    await mkdir(join(root, 'attachments'), { recursive: true })
    await writeFile(join(root, 'attachments', 'blob1'), 'b'.repeat(512))
    await mkdir(join(root, 'logs'), { recursive: true })
    await writeFile(join(root, 'logs', 'agent.log'), 'c'.repeat(256))

    const now = Date.now()
    const oldTs = now - 100 * 24 * 60 * 60 * 1000
    const recentTs = now - 2 * 24 * 60 * 60 * 1000

    // 插入旧的已归档父对话及其子智能体
    db.sqlite
      .query(
        `INSERT INTO threads (id, title, kind, parent_thread_id, created_at, updated_at, archived_at)
         VALUES (?, ?, 'main', NULL, ?, ?, ?)`,
      )
      .run('thread-old-1', '旧聊天一', oldTs, oldTs, oldTs)
    db.sqlite
      .query(
        `INSERT INTO threads (id, title, kind, parent_thread_id, created_at, updated_at, archived_at)
         VALUES (?, ?, 'subagent', ?, ?, ?, ?)`,
      )
      .run('thread-old-1-sub', '子智能体一', 'thread-old-1', oldTs, oldTs, oldTs)

    db.sqlite
      .query(
        `INSERT INTO inputs (id, thread_id, content, model_ref, strategy, task_mode, status, created_at)
         VALUES (?, ?, ?, 'openai/gpt-5', 'direct', 'chat', 'completed', ?)`,
      )
      .run('input-1', 'thread-old-1', 'x'.repeat(2048), oldTs)
    db.sqlite
      .query(
        `INSERT INTO inputs (id, thread_id, content, model_ref, strategy, task_mode, status, created_at)
         VALUES (?, ?, ?, 'openai/gpt-5', 'direct', 'chat', 'completed', ?)`,
      )
      .run('input-2', 'thread-old-1-sub', 'y'.repeat(1024), oldTs)

    // 插入近期未归档对话
    db.sqlite
      .query(
        `INSERT INTO threads (id, title, kind, parent_thread_id, created_at, updated_at, archived_at)
         VALUES (?, ?, 'main', NULL, ?, ?, NULL)`,
      )
      .run('thread-recent', '近期对话', recentTs, recentTs)

    const removedIds: string[] = []
    const service = new StorageManagementService(
      db,
      {
        userConfigPath: join(root, 'config.json'),
        snapshot: () => ({}),
      } as never,
      {
        remove: async (threadId: string) => {
          removedIds.push(threadId)
          db.sqlite.query('DELETE FROM threads WHERE id = ?').run(threadId)
        },
      } as never,
    )

    const summary = await service.getSummary()
    expect(summary.dataDir).toBe(root)
    expect(summary.breakdown.worktreeBytes).toBe(1024)
    expect(summary.breakdown.otherBytes).toBeGreaterThanOrEqual(256)
    expect(summary.breakdown.chatBytes).toBeGreaterThan(0)
    expect(
      summary.breakdown.chatBytes +
        summary.breakdown.worktreeBytes +
        summary.breakdown.artifactsBytes +
        summary.breakdown.otherBytes,
    ).toBe(summary.folders.dataDirBytes)

    // 列表筛选：早于 90 天 + 已归档
    const listed = service.listOldChats({
      olderThanDays: 90,
      scope: 'archived',
      limit: 20,
      offset: 0,
    })
    expect(listed.totalCount).toBe(1)
    expect(listed.totalSubagentCount).toBe(1)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.threadId).toBe('thread-old-1')
    expect(listed.items[0]?.subagentCount).toBe(1)
    expect(listed.items[0]?.subagentBytes).toBeGreaterThanOrEqual(1024)
    expect(listed.items[0]?.estimatedBytes).toBeGreaterThanOrEqual(2048 + 1024)

    // 删除旧聊天并回收空间
    const deleted = await service.deleteOldChats(['thread-old-1'])
    expect(deleted.deletedIds).toEqual(['thread-old-1'])
    expect(deleted.failed).toEqual([])
    expect(deleted.vacuumed).toBe(true)
    expect(removedIds).toEqual(['thread-old-1'])

    const afterList = service.listOldChats({
      olderThanDays: 90,
      scope: 'archived',
      limit: 20,
      offset: 0,
    })
    expect(afterList.totalCount).toBe(0)

    // 测试已下载资源的列表与删除
    await mkdir(join(root, 'speech', 'sensevoice-llamacpp'), { recursive: true })
    await writeFile(join(root, 'speech', 'sensevoice-llamacpp', 'model.gguf'), 'm'.repeat(4096))
    await mkdir(join(root, 'tooling', 'ripgrep'), { recursive: true })
    await writeFile(join(root, 'tooling', 'ripgrep', 'rg.exe'), 'r'.repeat(2048))

    const resources = await service.listDownloadedResources()
    expect(resources.items.map((item) => item.id)).toEqual([
      'speech:sensevoice',
      'tooling:ripgrep',
    ])

    const deleteSpeech = await service.deleteDownloadedResource('speech:sensevoice')
    expect(deleteSpeech.reclaimedBytes).toBe(4096)

    const resourcesAfter = await service.listDownloadedResources()
    expect(resourcesAfter.items.map((item) => item.id)).toEqual(['tooling:ripgrep'])

    db.close()
  })
})
