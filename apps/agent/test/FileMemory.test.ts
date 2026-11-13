import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeFixturePaths } from './FixtureCleanup'
import { MemoryService } from '../src/memory/MemoryService'
import {
  memoryNamespaceDirectory,
  normalizeMemoryKey,
  normalizeMemoryPath,
  paginateMemoryContent,
} from '../src/memory/MemoryFiles'
import { AgentDatabase } from '../src/storage/database/AgentDatabase'

const roots: string[] = []
afterEach(async () => removeFixturePaths(roots.splice(0)), 30_000)

const document = (name: string, body: string, type = 'project') =>
  ['---', `name: ${name}`, 'description: d', `type: ${type}`, '---', '', body, ''].join('\n')

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-file-memory-'))
  roots.push(root)
  const db = new AgentDatabase(join(root, 'agent.sqlite'))
  const memory = new MemoryService(db, {
    enabled: true,
    rootDirectory: join(root, 'memories'),
  })
  return { root, db, memory }
}

describe('文件记忆存储', () => {
  test('路径必须是命名空间内的扁平 .md 文件名', () => {
    expect(normalizeMemoryPath('preferences.md')).toBe('preferences.md')
    expect(normalizeMemoryPath('  Stack.md ')).toBe('Stack.md')
    for (const invalid of [
      '../escape.md',
      'nested/file.md',
      'C:\\abs\\file.md',
      '/abs/file.md',
      'readme.txt',
      '',
      'CON.md',
      'trailing.',
    ])
      expect(() => normalizeMemoryPath(invalid)).toThrow()
  })

  test('memoryKey 只接受 1–64 位 ASCII 并统一小写', () => {
    expect(normalizeMemoryKey('Reviewer-01')).toBe('reviewer-01')
    for (const invalid of ['中文', 'has space', '', 'a'.repeat(65), 'semi;colon'])
      expect(normalizeMemoryKey(invalid)).toBeNull()
    expect(() =>
      memoryNamespaceDirectory('/root', {
        kind: 'agent',
        projectId: 'project-a',
        memoryKey: '../x',
      }),
    ).toThrow()
  })

  test('外部编辑后的内容成为下一次读取的真源，损坏 frontmatter 被诊断排除', async () => {
    const { root, db, memory } = await fixture()
    const namespace = { kind: 'project' as const, projectId: 'project-a' }
    await memory.write({ namespace, path: 'stack.md', content: document('技术栈', '使用 Bun') })
    const directory = memoryNamespaceDirectory(join(root, 'memories'), namespace)
    await writeFile(join(directory, 'stack.md'), document('技术栈', '外部改成 pnpm'), 'utf8')
    await writeFile(join(directory, 'broken.md'), '没有 frontmatter 的正文', 'utf8')

    const listing = await memory.list(namespace)
    const stack = listing.files.find((file) => file.path === 'stack.md')!
    expect((await memory.read(namespace, 'stack.md'))?.content).toContain('外部改成 pnpm')
    expect(stack.revision).toHaveLength(64)
    const broken = listing.files.find((file) => file.path === 'broken.md')!
    expect(broken.diagnostics.map((item) => item.code)).toContain('invalid-frontmatter')
    expect(broken.indexed).toBe(false)
    db.close()
  })

  test('未索引文件被标出，索引中的失效链接被诊断', async () => {
    const { db, memory } = await fixture()
    const namespace = { kind: 'user' as const }
    await memory.write({ namespace, path: 'a.md', content: document('A', 'A 正文', 'user') })
    await memory.write({
      namespace,
      path: 'MEMORY.md',
      content: '# 索引\n\n- [A](a.md)\n- [缺失](missing.md)\n',
    })
    const listing = await memory.list(namespace)
    expect(listing.files.find((file) => file.path === 'a.md')?.indexed).toBe(true)
    expect(listing.diagnostics.some((item) => item.path === 'missing.md')).toBe(true)
    db.close()
  })

  test('并发保存冲突要求重新读取且不覆盖外部编辑', async () => {
    const { root, db, memory } = await fixture()
    const namespace = { kind: 'user' as const }
    const created = await memory.write({ namespace, path: 'p.md', content: document('P', 'v1', 'user') })
    const directory = memoryNamespaceDirectory(join(root, 'memories'), namespace)
    await writeFile(join(directory, 'p.md'), document('P', '外部版本', 'user'), 'utf8')
    await expect(
      memory.write({
        namespace,
        path: 'p.md',
        content: document('P', '模型版本', 'user'),
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    expect(await readFile(join(directory, 'p.md'), 'utf8')).toContain('外部版本')
    db.close()
  })

  test('覆盖已存在文件但不提交 revision 时拒绝写入', async () => {
    const { root, db, memory } = await fixture()
    const namespace = { kind: 'user' as const }
    await memory.write({ namespace, path: 'q.md', content: document('Q', 'v1', 'user') })
    await expect(
      memory.write({ namespace, path: 'q.md', content: document('Q', 'v2', 'user') }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' })
    const directory = memoryNamespaceDirectory(join(root, 'memories'), namespace)
    expect(await readFile(join(directory, 'q.md'), 'utf8')).toContain('v1')
    db.close()
  })

  test('敏感内容拒绝写入，重置只删除本系统管理的文件', async () => {
    const { root, db, memory } = await fixture()
    const namespace = { kind: 'project' as const, projectId: 'project-a' }
    await expect(
      memory.write({ namespace, path: 'x.md', content: 'api_key={{SECRET_demo}}' }),
    ).rejects.toMatchObject({ code: 'MEMORY_REJECTED' })
    await memory.write({ namespace, path: 'keep.md', content: document('K', '保留') })
    const directory = memoryNamespaceDirectory(join(root, 'memories'), namespace)
    await writeFile(join(directory, 'notes.txt'), '不是记忆文件', 'utf8')
    await writeFile(join(directory, 'unknown.md'), '没有 frontmatter', 'utf8')
    expect(await memory.reset(namespace)).toBe(1)
    expect(await readFile(join(directory, 'notes.txt'), 'utf8')).toBe('不是记忆文件')
    expect(await readFile(join(directory, 'unknown.md'), 'utf8')).toBe('没有 frontmatter')
    db.close()
  })

  test('正文分页按 UTF-8 字节推进且不切断多字节字符', () => {
    const content = '记'.repeat(2_000)
    const first = paginateMemoryContent(content, 0)
    expect(first.truncated).toBe(true)
    expect(Buffer.byteLength(first.content, 'utf8')).toBeLessThanOrEqual(4_096)
    expect(first.content).not.toContain('\ufffd')
    const second = paginateMemoryContent(content, first.nextOffset!)
    expect(second.offset).toBe(first.nextOffset!)
  })
})

describe('记忆注入与命名空间', () => {
  test('子 Agent 只读取项目索引与其绑定身份，不注入全局用户索引', async () => {
    const { db, memory } = await fixture()
    db.createThread('host')
    await memory.write({
      namespace: { kind: 'user' },
      path: 'u.md',
      content: document('U', '用户记忆', 'user'),
    })
    await memory.write({
      namespace: { kind: 'project', projectId: 'project-a' },
      path: 'p.md',
      content: document('P', '项目记忆'),
    })
    await memory.write({
      namespace: { kind: 'agent', projectId: 'project-a', memoryKey: 'reviewer' },
      path: 'r.md',
      content: document('R', '评审员记忆', 'feedback'),
    })
    await memory.write({
      namespace: { kind: 'agent', projectId: 'project-a', memoryKey: 'other' },
      path: 'o.md',
      content: document('O', '其他身份'),
    })
    await memory.write({
      namespace: { kind: 'agent', projectId: 'project-b', memoryKey: 'reviewer' },
      path: 'b.md',
      content: document('B', '另一个项目'),
    })
    await memory.write({
      namespace: { kind: 'project', projectId: 'project-a' },
      path: 'MEMORY.md',
      content: '- [P](p.md)\n',
    })

    const injection = await memory.inject({
      projectId: 'project-a',
      memoryKey: 'reviewer',
      userMessage: '检查代码',
      threadId: 'host',
      turnId: null,
    })
    const text = injection.sections.map((section) => section.content).join('\n')
    expect(injection.sections.map((section) => section.namespace)).toContain(
      'agent:project-a:reviewer',
    )
    expect(text).not.toContain('用户记忆')
    expect(text).not.toContain('其他身份')
    expect(text).not.toContain('另一个项目')
    db.close()
  })

  test('索引注入在预算内按命名空间均分，并提示截断', async () => {
    const { db, memory } = await fixture()
    const namespace = { kind: 'project' as const, projectId: 'project-a' }
    // Both default namespaces need an index for the budget to be split in two.
    await memory.write({
      namespace: { kind: 'user' },
      path: 'MEMORY.md',
      content: `# 用户索引\n\n${'- [长条目](x.md)\n'.repeat(600)}`,
    })
    await memory.write({
      namespace,
      path: 'MEMORY.md',
      content: `# 项目索引\n\n${'- [长条目](x.md)\n'.repeat(600)}`,
    })
    const injection = await memory.inject({
      projectId: 'project-a',
      userMessage: '任意问题',
      threadId: 'thread-1',
      turnId: null,
    })
    expect(injection.sections).toHaveLength(2)
    for (const section of injection.sections) {
      expect(section.content.length).toBeLessThanOrEqual(4_000 + 120)
      expect(section.truncated).toBe(true)
      expect(section.content).toContain('索引已截断')
    }
    db.close()
  })

  test('用户要求忽略记忆时本轮不注入', async () => {
    const { db, memory } = await fixture()
    await memory.write({
      namespace: { kind: 'user' },
      path: 'u.md',
      content: document('U', '用户记忆', 'user'),
    })
    const injection = await memory.inject({
      projectId: null,
      userMessage: '这次先忽略你的记忆，直接看代码',
      threadId: 'thread-1',
      turnId: null,
    })
    expect(injection.ignored).toBe(true)
    expect(injection.sections).toHaveLength(0)
    db.close()
  })

  test('无关任务的索引注入不包含正文', async () => {
    const { db, memory } = await fixture()
    const namespace = { kind: 'user' as const }
    await memory.write({ namespace, path: 'a.md', content: document('A', '只有正文才有的内容', 'user') })
    await memory.write({ namespace, path: 'MEMORY.md', content: '- [A](a.md)\n' })
    const injection = await memory.inject({
      projectId: null,
      userMessage: '完全无关的问题',
      threadId: 'thread-1',
      turnId: null,
    })
    expect(injection.sections.map((section) => section.content).join('\n')).not.toContain(
      '只有正文才有的内容',
    )
    db.close()
  })
})

describe('自动整理门槛', () => {
  test('未满 24 小时或不足 5 个聊天不自动整理', async () => {
    const { db, memory } = await fixture()
    let queued = 0
    memory.attachRunner(async () => {
      queued += 1
      return { status: 'empty' }
    })
    memory.attachModelResolver(async () => 'provider:test/model')
    memory.attachIdleProbe(() => true)
    // No durable turns exist, so extraction completes as a no-op instead of
    // spending a model call; the automatic organize gate then has no sources.
    memory.enqueueExtract({
      namespace: { kind: 'project', projectId: 'project-a' },
      threadId: 'thread-1',
      turnId: 'turn-1',
    })
    await memory.drain()
    expect(memory.tasks().map((task) => task.status)).toEqual(['completed'])
    memory.maybeAutoOrganize()
    expect(memory.tasks().filter((task) => task.kind === 'organize')).toHaveLength(0)
    expect(queued).toBe(0)
    db.close()
  })

  test('关闭自动整理后不排队，且前台不空闲时跳过', async () => {
    const { db, memory } = await fixture()
    memory.attachRunner(async () => ({ status: 'empty' }))
    memory.attachModelResolver(async () => 'provider:test/model')
    memory.setAutoOrganizeEnabled(false)
    memory.attachIdleProbe(() => true)
    memory.maybeAutoOrganize()
    expect(memory.tasks()).toHaveLength(0)
    memory.setAutoOrganizeEnabled(true)
    memory.attachIdleProbe(() => false)
    memory.maybeAutoOrganize()
    expect(memory.tasks()).toHaveLength(0)
    db.close()
  })

  test('dispose 取消排队任务并阻止后续写入', async () => {
    const { db, memory } = await fixture()
    memory.attachRunner(async () => ({ status: 'empty' }))
    memory.attachModelResolver(async () => 'provider:test/model')
    memory.enqueueOrganize({ namespace: { kind: 'user' } })
    memory.dispose()
    expect(memory.tasks().map((task) => task.status)).toEqual(['cancelled'])
    db.close()
  })
})

describe('一次性旧记忆清理', () => {
  test('只删除本版本识别的旧记忆行，重复启动不会删除新文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-legacy-memory-'))
    roots.push(root)
    const db = new AgentDatabase(join(root, 'agent.sqlite'))
    db.profileSqlite
      .query(
        `INSERT INTO memory_entries (id, scope, project_key, content, content_hash, created_at, updated_at)
         VALUES ('legacy', 'user', '', '旧内容', 'h', 1, 1)`,
      )
      .run()
    db.sqlite
      .query(
        `INSERT INTO memory_jobs (id, status, payload, created_at, updated_at)
         VALUES ('legacy-job', 'queued', '{}', 1, 1)`,
      )
      .run()

    const first = new MemoryService(db, { enabled: true, rootDirectory: join(root, 'memories') })
    await first.write({
      namespace: { kind: 'user' },
      path: 'new.md',
      content: document('新', '新内容', 'user'),
    })
    first.dispose()
    expect(db.profileSqlite.query('SELECT COUNT(*) AS c FROM memory_entries').get()).toEqual({
      c: 0,
    })
    expect(db.sqlite.query('SELECT COUNT(*) AS c FROM memory_jobs').get()).toEqual({ c: 0 })

    const second = new MemoryService(db, { enabled: true, rootDirectory: join(root, 'memories') })
    expect((await second.list({ kind: 'user' })).files.map((file) => file.path)).toEqual([
      'new.md',
    ])
    second.dispose()
    db.close()
  })

  test('从 v72 升级同时补齐定价表与记忆表', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-v72-memory-'))
    roots.push(root)
    const path = join(root, 'agent.sqlite')
    const first = new AgentDatabase(path)
    first.sqlite.exec(
      'DROP TABLE memory_tasks; DROP TABLE model_price_snapshots; PRAGMA user_version = 72',
    )
    first.close()

    const db = new AgentDatabase(path)
    const names = new Set(
      (db.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>).map((row) => row.name),
    )
    // 定价迁移(72)与记忆迁移(73)必须占用不同编号，否则其中一个永远不会执行。
    expect(names.has('model_price_snapshots')).toBe(true)
    expect(names.has('memory_tasks')).toBe(true)
    db.close()
  })

  test('较高 schema 与未知表在初始化时保持原样', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-future-memory-'))
    roots.push(root)
    const db = new AgentDatabase(join(root, 'agent.sqlite'))
    db.sqlite.exec('PRAGMA user_version = 999; CREATE TABLE future_memory (id TEXT)')
    const memory = new MemoryService(db, { enabled: true, rootDirectory: join(root, 'memories') })
    expect(
      db.sqlite.query("SELECT name FROM sqlite_master WHERE name = 'future_memory'").get(),
    ).not.toBeNull()
    expect(db.sqlite.query('PRAGMA user_version').get()).toEqual({ user_version: 999 })
    memory.dispose()
    db.close()
  })
})

describe('数据目录布局', () => {
  test('用户/项目/命名 Agent 目录互不重叠', async () => {
    await mkdir(join(await mkdtemp(join(tmpdir(), 'pidex-layout-')), 'x'), { recursive: true })
    const user = memoryNamespaceDirectory('C:\\data', { kind: 'user' })
    const project = memoryNamespaceDirectory('C:\\data', { kind: 'project', projectId: 'p1' })
    const agent = memoryNamespaceDirectory('C:\\data', {
      kind: 'agent',
      projectId: 'p1',
      memoryKey: 'reviewer',
    })
    expect(user).not.toBe(project)
    expect(project).not.toBe(agent)
    expect(agent.endsWith(join('agents', 'reviewer'))).toBe(true)
  })
})

describe('删除记忆同步清理索引', () => {
  test('删除被 MEMORY.md 索引的文件时同步移除索引条目并消除悬挂诊断', async () => {
    const { db, memory } = await fixture()
    const namespace = { kind: 'user' as const }
    await memory.write({ namespace, path: 'A.md', content: document('A', 'A 正文', 'user') })
    await memory.write({ namespace, path: 'b.md', content: document('B', 'B 正文', 'user') })
    await memory.write({
      namespace,
      path: 'MEMORY.md',
      content: '# 索引\n\n- [A](./a.md#sec)\n- [B](b.md)\n',
    })

    expect(await memory.delete({ namespace, path: 'A.md' })).toBe(true)

    const listing = await memory.list(namespace)
    expect(listing.files.map((file) => file.path)).toEqual(['b.md'])
    expect(listing.index.content).toBe('# 索引\n\n- [B](b.md)\n')
    expect(listing.diagnostics).toEqual([])
    db.close()
  })

  test('删除未被索引的文件时 MEMORY.md 内容与 revision 保持不变', async () => {
    const { db, memory } = await fixture()
    const namespace = { kind: 'user' as const }
    await memory.write({ namespace, path: 'indexed.md', content: document('I', 'I 正文', 'user') })
    await memory.write({ namespace, path: 'orphan.md', content: document('O', 'O 正文', 'user') })
    const indexResult = await memory.write({
      namespace,
      path: 'MEMORY.md',
      content: '- [I](indexed.md)\n',
    })

    expect(await memory.delete({ namespace, path: 'orphan.md' })).toBe(true)

    const listing = await memory.list(namespace)
    expect(listing.index.content).toBe('- [I](indexed.md)\n')
    expect(listing.index.revision).toBe(indexResult.revision)
    db.close()
  })

  test('MEMORY.md 不存在时删除文件不报错且不创建索引', async () => {
    const { db, memory } = await fixture()
    const namespace = { kind: 'user' as const }
    await memory.write({ namespace, path: 'only.md', content: document('Only', '正文', 'user') })

    expect(await memory.delete({ namespace, path: 'only.md' })).toBe(true)

    const listing = await memory.list(namespace)
    expect(listing.files).toEqual([])
    expect(listing.index.exists).toBe(false)
    db.close()
  })
})
