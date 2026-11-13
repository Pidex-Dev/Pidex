import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeFixturePaths } from './FixtureCleanup'
import { Capabilities, EventManifest, RpcMethods } from '@pidex/agent-protocol'
import { MemoryService } from '../src/memory/MemoryService'
import { MemoryRepository } from '../src/storage/repositories/MemoryRepository'
import { AgentDatabase } from '../src/storage/database/AgentDatabase'
import { RpcRouter, type RpcRouterDependencies } from '../src/transport/rpc/RpcRouter'
import { ThreadService } from '../src/session/ThreadService'

const roots: string[] = []
afterEach(async () => removeFixturePaths(roots.splice(0)), 30_000)

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-memory-rpc-'))
  roots.push(root)
  const db = new AgentDatabase(join(root, 'agent.sqlite'))
  const memory = new MemoryService(db, { enabled: true, rootDirectory: join(root, 'memories') })
  const dependencies = {
    db,
    memory,
    hub: null,
    threads: null,
    history: null,
    approvals: null,
    questions: null,
    subagents: null,
    attachments: null,
    providers: null,
    integrations: null,
  } as unknown as RpcRouterDependencies
  const router = new RpcRouter(dependencies)
  let id = 0
  const initialized = (await router.handle({
    jsonrpc: '2.0',
    id: ++id,
    method: 'initialize',
    params: {
      clientInfo: { name: 'memory-rpc-test', version: '1.0.0' },
      protocols: ['thread-rpc-v4'],
      capabilities: [...Capabilities],
      interactionDelivery: 'active',
    },
  })) as any
  const connectionId = initialized.result.connectionId as string
  await router.handle(
    {
      jsonrpc: '2.0',
      method: 'initialized',
      params: { protocol: 'thread-rpc-v4' },
    },
    { connectionId },
  )
  const call = async (method: string, params: Record<string, unknown>) =>
    (await router.handle({ jsonrpc: '2.0', id: ++id, method, params }, { connectionId })) as any
  return { root, db, memory, call }
}

describe('Memory RPC 项目作用域', () => {
  test('Prompt、compact 与 Memory Router 方法均可通过共享 RPC 边界', () => {
    for (const method of [
      'prompt/preview',
      'prompt/refresh',
      'thread/compact',
      'memory/list',
      'memory/read',
      'memory/save',
      'memory/delete',
      'memory/reset',
    ] as const) {
      expect(RpcMethods[method]).toBeDefined()
    }
  })

  test('Context、Hook trust 与审批取消事件通过共享 SSE 边界', () => {
    for (const method of [
      'context/compacted',
      'context/recoveryRequired',
      'hook/trust/requested',
      'hook/trust/resolved',
      'approval/cancelled',
    ] as const) {
      expect(EventManifest[method]).toBeDefined()
    }
  })

  test('新 RPC 方法按命名空间隔离文件，跨命名空间读取返回 404', async () => {
    const { root, db, memory, call } = await fixture()
    const workspaceA = join(root, 'workspace-a')
    const workspaceB = join(root, 'workspace-b')
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB)])
    const projectA = db.createProject({ rootPath: workspaceA })
    const projectB = db.createProject({ rootPath: workspaceB })
    const namespaceA = { kind: 'project' as const, projectId: projectA.id }
    const namespaceB = { kind: 'project' as const, projectId: projectB.id }
    await memory.write({
      namespace: namespaceA,
      path: 'only-a.md',
      content: ['---', 'name: only-a', 'description: A', 'type: project', '---', '', '正文 A', ''].join(String.fromCharCode(10)),
    })

    expect((await call('memory/read', { path: 'only-a.md' })).error).toMatchObject({ code: -32602 })
    expect(
      (await call('memory/read', { namespace: namespaceB, path: 'only-a.md' })).error,
    ).toMatchObject({ code: -32000, data: { code: 'MEMORY_NOT_FOUND' } })
    expect(
      (await call('memory/read', { namespace: namespaceA, path: 'only-a.md' })).result,
    ).toMatchObject({ file: { path: 'only-a.md' } })
    expect(
      (
        await call('memory/delete', {
          namespace: namespaceB,
          path: 'only-a.md',
          operationId: 'delete:b',
        })
      ).result,
    ).toEqual({ namespace: namespaceB, path: 'only-a.md', deleted: false })
    expect(
      (
        await call('memory/delete', {
          namespace: namespaceA,
          path: 'only-a.md',
          operationId: 'delete:a',
        })
      ).result,
    ).toEqual({ namespace: namespaceA, path: 'only-a.md', deleted: true })
    db.close()
  })

  test('project reset 只影响选定命名空间，其他项目文件保留', async () => {
    const { root, db, memory, call } = await fixture()
    const workspaceA = join(root, 'workspace-a')
    const workspaceB = join(root, 'workspace-b')
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB)])
    const projectA = db.createProject({ rootPath: workspaceA })
    const projectB = db.createProject({ rootPath: workspaceB })
    const namespaceA = { kind: 'project' as const, projectId: projectA.id }
    const namespaceB = { kind: 'project' as const, projectId: projectB.id }
    const document = (name: string) =>
      ['---', `name: ${name}`, 'description: d', 'type: project', '---', '', name, ''].join(
        String.fromCharCode(10),
      )
    await memory.write({ namespace: namespaceA, path: 'a.md', content: document('A') })
    await memory.write({ namespace: namespaceB, path: 'b.md', content: document('B') })

    expect(
      (await call('memory/reset', { namespace: namespaceB, operationId: 'reset:b' })).result,
    ).toEqual({ deleted: 1 })
    expect((await memory.list(namespaceA)).files).toHaveLength(1)
    expect((await memory.list(namespaceB)).files).toHaveLength(0)
    db.close()
  })

  test('memory/save 依赖 expectedRevision 阻止覆盖外部修改', async () => {
    const { db, call } = await fixture()
    const namespace = { kind: 'user' as const }
    const created = await call('memory/save', {
      namespace,
      path: 'pref.md',
      content: '第一版',
      operationId: 'save:create',
    })
    const revision = (created.result as { revision: string }).revision
    const updated = await call('memory/save', {
      namespace,
      path: 'pref.md',
      content: '第二版',
      expectedRevision: revision,
      operationId: 'save:update',
    })
    expect(updated.result).toMatchObject({ path: 'pref.md', created: false })
    expect(
      (
        await call('memory/save', {
          namespace,
          path: 'pref.md',
          content: '第三版',
          expectedRevision: revision,
          operationId: 'save:conflict',
        })
      ).error,
    ).toMatchObject({ code: -32000, data: { code: 'CONFLICT' } })
    expect((await call('memory/list', { namespace })).result).toMatchObject({
      files: [{ path: 'pref.md' }],
    })
    await Bun.sleep(0)
    db.close()
  })

  // 仓储列存的是扁平存储键（user / project:<id>），wire 契约要求结构化联合；
  // 出口漏转换会让 encodeSync 抛错并整包成 Internal RPC error，设置页四块数据同空。
  test('memory/tasks 与 memory/usage 返回结构化 namespace 并通过 wire 校验', async () => {
    const { root, db, memory, call } = await fixture()
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const project = db.createProject({ rootPath: workspace })
    const projectNamespace = { kind: 'project' as const, projectId: project.id }
    const agentNamespace = {
      kind: 'agent' as const,
      projectId: project.id,
      memoryKey: 'reviewer',
    }
    const repository = new MemoryRepository(db)
    for (const [namespace, key] of [
      [{ kind: 'user' as const }, 'user'],
      [projectNamespace, `project:${project.id}`],
      [agentNamespace, `agent:${project.id}:reviewer`],
    ] as const) {
      repository.enqueueTask({ namespace: key, kind: 'organize', trigger: 'manual' })
      memory.recordBodyUsage({
        namespace,
        threadId: 'thread:usage',
        turnId: null,
        path: 'MEMORY.md',
        revision: 'a'.repeat(64),
        truncated: false,
        bytes: 16,
      })
    }

    for (const namespace of [{ kind: 'user' as const }, projectNamespace, agentNamespace]) {
      const tasks = await call('memory/tasks', { namespace, limit: 20 })
      expect(tasks.error).toBeUndefined()
      expect(tasks.result.tasks).toHaveLength(1)
      expect(tasks.result.tasks[0].namespace).toEqual(namespace)
      const usage = await call('memory/usage', { namespace, limit: 20 })
      expect(usage.error).toBeUndefined()
      expect(usage.result.records).toHaveLength(1)
      expect(usage.result.records[0].namespace).toEqual(namespace)
    }

    // 不带 namespace 的全量读取同样必须是结构化联合，而不是存储键字符串。
    const all = await call('memory/tasks', { limit: 20 })
    expect(all.error).toBeUndefined()
    expect(
      [...all.result.tasks.map((task: { namespace: unknown }) => task.namespace)].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    ).toEqual(
      [agentNamespace, projectNamespace, { kind: 'user' }].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    )
    const allUsage = await call('memory/usage', { limit: 20 })
    expect(allUsage.error).toBeUndefined()
    expect(allUsage.result.records).toHaveLength(3)
    db.close()
  })

  test('新线程冻结 prompt settings，只有显式 refresh 才更新', async () => {
    const { db, memory } = await fixture()
    let promptConfig = {
      system_prompt: 'v1',
      features: { memory: true },
    }
    const questions = { setResumeHandler: () => undefined }
    const subagents = { setParentResumeHandler: () => undefined }
    const service = new ThreadService(
      db,
      null as never,
      null as never,
      null as never,
      questions as never,
      null as never,
      subagents as never,
      null as never,
      { dataRoot: '.', userHome: '.' },
      memory,
      null as never,
      null as never,
      undefined,
      undefined,
      undefined,
      {
        snapshot: () => promptConfig,
      } as never,
    )
    await Bun.sleep(0)
    const thread = db.createThread('snapshot')
    service.refreshPromptSettings(thread.id)
    expect(db.getThreadPromptSettings(thread.id)).toMatchObject({
      engine: 'prompt-engine-v2',
      version: 2,
      settings: { systemPrompt: 'v1', enableMemory: true },
    })
    promptConfig = {
      system_prompt: 'v2',
      features: { memory: false },
    }
    expect(
      db.getThreadPromptSettings<{ settings: { systemPrompt: string } }>(thread.id)?.settings
        .systemPrompt,
    ).toBe('v1')
    expect(service.refreshPromptSettings(thread.id)).toMatchObject({
      settings: { systemPrompt: 'v2', enableMemory: false },
    })
    db.close()
  })
})
