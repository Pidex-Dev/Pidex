import type { Project } from '@pidex/shared'
import type { RpcResult } from '@pidex/agent-protocol'
import type {
  DesktopApi,
  DesktopMemoryNamespace,
  DesktopMemoryTask,
  DesktopProjectMemory,
  DesktopProjectMemoryContent,
} from '../../../shared/Types.js'
import type { createAgentRpcClient } from '../AgentRpcClient.js'
import type { DesktopClient } from './Types.js'

type MemoryApiMethod =
  | 'listProjectMemories'
  | 'readProjectMemory'
  | 'saveProjectMemory'
  | 'deleteProjectMemory'
  | 'resetProjectMemory'
  | 'listMemoryUsage'
  | 'listMemoryTasks'
  | 'organizeMemory'
  | 'readMemorySettings'
  | 'saveMemorySettings'
  | 'listUserMemories'
  | 'readUserMemory'
  | 'saveUserMemory'
  | 'deleteUserMemory'
  | 'resetUserMemory'

type MemoryApi = Pick<DesktopClient, MemoryApiMethod>

type Dependencies = {
  loadProjectForPath: (workspacePath: string) => Promise<Project>
  mockClient: Pick<DesktopApi, MemoryApiMethod>
  requireAgentCapability: (name: 'memory', version?: number) => void
  rpc: Pick<ReturnType<typeof createAgentRpcClient>, 'call'>
  withAgentOrMock: <T>(
    agentOperation: () => Promise<T>,
    mockOperation: () => Promise<T>,
  ) => Promise<T>
}

export function createAgentMemoryApi({
  loadProjectForPath,
  mockClient,
  requireAgentCapability,
  rpc,
  withAgentOrMock,
}: Dependencies): MemoryApi {
  /** Memory namespaces never take a filesystem path; project identity comes from RPC. */
  async function projectNamespace(
    workspacePath: string | null | undefined,
  ): Promise<DesktopMemoryNamespace> {
    const normalized = workspacePath?.trim()
    if (!normalized) return { kind: 'user' }
    const project = await loadProjectForPath(normalized)
    return { kind: 'project', projectId: project.id }
  }

  function memoryFileView(file: RpcResult<'memory/list'>['files'][number]): DesktopProjectMemory {
    return {
      relativePath: file.path,
      absolutePath: file.path,
      type: file.type ?? undefined,
      description: file.description,
      size: file.size,
      mtimeMs: file.updatedAt,
      revision: file.revision,
      indexed: file.indexed,
      sourceThreadId: file.source?.threadId ?? null,
      sourceTurnId: file.source?.turnId ?? null,
    }
  }

  function memoryContentView(response: RpcResult<'memory/read'>): DesktopProjectMemoryContent {
    const view = memoryFileView(response.file)
    return {
      ...view,
      content: response.file.content,
      revision: response.file.revision,
      nextOffset: response.nextOffset,
      truncated: response.truncated,
    }
  }

  return {
    listProjectMemories: (workspacePath, namespace) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const target = namespace ?? (await projectNamespace(workspacePath))
          const response = await rpc.call<RpcResult<'memory/list'>>('memory/list', {
            namespace: target,
          })
          return {
            namespace: target,
            memoryDir: target.kind === 'user' ? '用户记忆' : '项目记忆',
            entrypointPath: response.index.exists ? response.index.content : 'MEMORY.md',
            diagnostics: response.diagnostics,
            indexContent: response.index.content,
            memories: response.files.map(memoryFileView),
          }
        },
        () => mockClient.listProjectMemories(workspacePath, namespace),
      ),
    readProjectMemory: (workspacePath, relativePath, namespace) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const target = namespace ?? (await projectNamespace(workspacePath))
          const response = await rpc.call<RpcResult<'memory/read'>>('memory/read', {
            namespace: target,
            path: relativePath,
          })
          return memoryContentView(response)
        },
        () => mockClient.readProjectMemory(workspacePath, relativePath, namespace),
      ),
    saveProjectMemory: (input) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const target = input.namespace ?? (await projectNamespace(input.workspacePath))
          const response = await rpc.call<RpcResult<'memory/save'>>('memory/save', {
            namespace: target,
            path: input.relativePath,
            content: input.content,
            ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
            operationId: crypto.randomUUID(),
          })
          const saved: DesktopProjectMemory = {
            relativePath: response.path,
            absolutePath: response.path,
            description: null,
            size: input.content.length,
            mtimeMs: Date.now(),
            revision: response.revision,
            indexed: false,
          }
          return saved
        },
        () => mockClient.saveProjectMemory(input),
      ),
    deleteProjectMemory: (input) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const target = input.namespace ?? (await projectNamespace(input.workspacePath))
          await rpc.call('memory/delete', {
            namespace: target,
            path: input.relativePath,
            ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
            operationId: crypto.randomUUID(),
          })
        },
        () => mockClient.deleteProjectMemory(input),
      ),
    resetProjectMemory: (input) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const target = input.namespace ?? (await projectNamespace(input.workspacePath))
          await rpc.call('memory/reset', { namespace: target, operationId: crypto.randomUUID() })
        },
        () => mockClient.resetProjectMemory(input),
      ),
    listMemoryUsage: (workspacePath, namespace) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const target = namespace ?? (await projectNamespace(workspacePath))
          const response = await rpc.call<RpcResult<'memory/usage'>>('memory/usage', {
            namespace: target,
            limit: 100,
          })
          return response.records.map((record) => ({
            id: record.id,
            namespace: record.namespace,
            kind: record.kind,
            threadId: record.threadId,
            turnId: record.turnId,
            relativePath: record.path,
            revision: record.revision,
            truncated: record.truncated,
            bytes: record.bytes,
            createdAt: record.createdAt,
          }))
        },
        () => mockClient.listMemoryUsage?.(workspacePath, namespace) ?? Promise.resolve([]),
      ),
    listMemoryTasks: (workspacePath, namespace) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const target = namespace ?? (await projectNamespace(workspacePath))
          const response = await rpc.call<RpcResult<'memory/tasks'>>('memory/tasks', {
            namespace: target,
            limit: 50,
          })
          return {
            tasks: response.tasks.map((task): DesktopMemoryTask => ({
              id: task.id,
              namespace: task.namespace,
              kind: task.kind,
              status: task.status,
              trigger: task.trigger,
              threadId: task.threadId,
              turnId: task.turnId,
              error: task.error,
              createdAt: task.createdAt,
              startedAt: task.startedAt,
              finishedAt: task.finishedAt,
            })),
            autoOrganize: response.autoOrganize,
          }
        },
        () =>
          mockClient.listMemoryTasks?.(workspacePath, namespace) ??
          Promise.resolve({ tasks: [], autoOrganize: true }),
      ),
    organizeMemory: (input) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const target = input.namespace ?? (await projectNamespace(input.workspacePath))
          return rpc.call<RpcResult<'memory/organize'>>('memory/organize', {
            namespace: target,
            operationId: crypto.randomUUID(),
          })
        },
        () =>
          mockClient.organizeMemory?.(input) ?? Promise.resolve({ taskId: null, queued: false }),
      ),
    readMemorySettings: (workspacePath, namespace) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const target = namespace ?? (await projectNamespace(workspacePath))
          const response = await rpc.call<RpcResult<'memory/settings'>>('memory/settings', {
            namespace: target,
            operationId: crypto.randomUUID(),
          })
          return {
            autoOrganize: response.autoOrganize,
            memoryDir: response.directory,
            namedAgents: [...response.namedAgents],
          }
        },
        () =>
          mockClient.readMemorySettings?.(workspacePath, namespace) ??
          Promise.resolve({ autoOrganize: true, memoryDir: '', namedAgents: [] }),
      ),
    saveMemorySettings: (input) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const target = input.namespace ?? (await projectNamespace(input.workspacePath))
          const response = await rpc.call<RpcResult<'memory/settings'>>('memory/settings', {
            namespace: target,
            autoOrganize: input.autoOrganize,
            operationId: crypto.randomUUID(),
          })
          return {
            autoOrganize: response.autoOrganize,
            memoryDir: response.directory,
            namedAgents: [...response.namedAgents],
          }
        },
        () =>
          mockClient.saveMemorySettings?.(input) ??
          Promise.resolve({ autoOrganize: input.autoOrganize, memoryDir: '', namedAgents: [] }),
      ),
    listUserMemories: () =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const response = await rpc.call<RpcResult<'memory/list'>>('memory/list', {
            namespace: { kind: 'user' },
          })
          return {
            memoryDir: '用户记忆',
            profilePath: 'MEMORY.md',
            preferencesPath: 'MEMORY.md',
            eventsPath: 'memory_usage',
            conversationIndexPath: 'history.sqlite',
            memories: response.files.map(memoryFileView),
          }
        },
        () => mockClient.listUserMemories(),
      ),
    readUserMemory: (relativePath) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const response = await rpc.call<RpcResult<'memory/read'>>('memory/read', {
            namespace: { kind: 'user' },
            path: relativePath,
          })
          return memoryContentView(response)
        },
        () => mockClient.readUserMemory(relativePath),
      ),
    saveUserMemory: (input) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          const response = await rpc.call<RpcResult<'memory/save'>>('memory/save', {
            namespace: { kind: 'user' },
            path: input.relativePath,
            content: input.content,
            ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
            operationId: crypto.randomUUID(),
          })
          const saved: DesktopProjectMemory = {
            relativePath: response.path,
            absolutePath: response.path,
            description: null,
            size: input.content.length,
            mtimeMs: Date.now(),
            revision: response.revision,
            indexed: false,
          }
          return saved
        },
        () => mockClient.saveUserMemory(input),
      ),
    deleteUserMemory: (input) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          await rpc.call('memory/delete', {
            namespace: { kind: 'user' },
            path: input.relativePath,
            ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
            operationId: crypto.randomUUID(),
          })
        },
        () => mockClient.deleteUserMemory(input),
      ),
    resetUserMemory: () =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('memory', 3)
          await rpc.call('memory/reset', {
            namespace: { kind: 'user' },
            operationId: crypto.randomUUID(),
          })
        },
        () => mockClient.resetUserMemory({}),
      ),
  }
}
