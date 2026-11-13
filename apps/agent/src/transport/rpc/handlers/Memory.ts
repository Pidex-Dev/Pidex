import type { RpcMethod } from '@pidex/agent-protocol'
import type { MemoryNamespace } from '../../../memory/MemoryFiles'
import type { RpcRouter } from '../RpcRouter'
import { AgentError } from '../RpcRouter'
import { optionalRpcRecord as optionalRecord } from '../Decoders'
import type { RpcHandlerGroup } from './Types'

/**
 * The desktop supplies the namespace explicitly (user/project/named agent) and
 * a relative file name. Absolute paths never cross this boundary.
 */
const namespaceParam = (params: Record<string, unknown>): MemoryNamespace => {
  const raw = params.namespace
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new AgentError('INVALID_REQUEST', '记忆 RPC 缺少 namespace', 400)
  const value = raw as Record<string, unknown>
  const projectId = (input: unknown): string => {
    if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input))
      throw new AgentError('INVALID_REQUEST', '记忆 namespace 的 projectId 不合法', 400)
    return input
  }
  if (value.kind === 'user') return { kind: 'user' }
  if (value.kind === 'project') return { kind: 'project', projectId: projectId(value.projectId) }
  if (value.kind === 'agent') {
    if (typeof value.memoryKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.memoryKey))
      throw new AgentError('INVALID_REQUEST', '记忆 namespace 的 memoryKey 不合法', 400)
    return {
      kind: 'agent',
      projectId: projectId(value.projectId),
      memoryKey: value.memoryKey.toLowerCase(),
    }
  }
  throw new AgentError('INVALID_REQUEST', '记忆 namespace 的 kind 不合法', 400)
}

const requiredString = (params: Record<string, unknown>, key: string) => {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim())
    throw new AgentError('INVALID_REQUEST', `记忆 RPC 缺少 ${key}`, 400)
  return value
}

const optionalString = (params: Record<string, unknown>, key: string) => {
  const value = params[key]
  return typeof value === 'string' && value ? value : null
}

const mapError = (cause: unknown): never => {
  if (cause instanceof AgentError) throw cause
  const code = (cause as { code?: string } | null)?.code
  const message = cause instanceof Error ? cause.message : String(cause)
  if (code === 'MEMORY_CONFLICT') throw new AgentError('CONFLICT', message, 409)
  if (code === 'MEMORY_REJECTED') throw new AgentError('MEMORY_REJECTED', message, 409)
  throw new AgentError('INTERNAL_ERROR', message, 500)
}

export const memoryHandlers = {
  name: 'memory',
  methods: [
    'memory/list',
    'memory/read',
    'memory/save',
    'memory/delete',
    'memory/reset',
    'memory/organize',
    'memory/tasks',
    'memory/usage',
    'memory/settings',
  ],
  async handle(runtime: RpcRouter, method: RpcMethod, rawParams: unknown): Promise<unknown> {
    const { memory } = runtime.dependencies
    const params = optionalRecord(rawParams)
    try {
      switch (method) {
        case 'memory/list': {
          const namespace = namespaceParam(params)
          const listing = await memory.list(namespace)
          return {
            namespace,
            files: listing.files,
            index: listing.index,
            diagnostics: listing.diagnostics,
            nextCursor: null,
          }
        }
        case 'memory/read': {
          const namespace = namespaceParam(params)
          const file = await memory.read(
            namespace,
            requiredString(params, 'path'),
            typeof params.offset === 'number' ? params.offset : 0,
          )
          if (!file) throw new AgentError('MEMORY_NOT_FOUND', '记忆文件不存在', 404)
          return {
            namespace,
            file: {
              path: file.path,
              name: file.name,
              description: file.description,
              type: file.type,
              revision: file.revision,
              size: file.size,
              updatedAt: Math.round(file.updatedAt),
              indexed: file.indexed,
              source: null,
              diagnostics: file.diagnostics,
              content: file.page.content,
            },
            nextOffset: file.page.nextOffset,
            truncated: file.page.truncated,
          }
        }
        case 'memory/save': {
          const namespace = namespaceParam(params)
          const result = await memory.write({
            namespace,
            path: requiredString(params, 'path'),
            content: requiredString(params, 'content'),
            expectedRevision: optionalString(params, 'expectedRevision'),
          })
          return { namespace, path: result.path, revision: result.revision, created: result.created }
        }
        case 'memory/delete': {
          const namespace = namespaceParam(params)
          const path = requiredString(params, 'path')
          return {
            namespace,
            path,
            deleted: await memory.delete({
              namespace,
              path,
              expectedRevision: optionalString(params, 'expectedRevision'),
            }),
          }
        }
        case 'memory/reset': {
          const namespace = namespaceParam(params)
          return { deleted: await memory.reset(namespace) }
        }
        case 'memory/organize': {
          const namespace = namespaceParam(params)
          const taskId = memory.enqueueOrganize({ namespace, trigger: 'manual' })
          return { taskId, queued: taskId !== null }
        }
        case 'memory/tasks': {
          const namespace = params.namespace === undefined ? undefined : namespaceParam(params)
          return {
            tasks: memory.tasks(namespace).map((task) => ({
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
            autoOrganize: memory.autoOrganizeEnabled(),
          }
        }
        case 'memory/usage': {
          const namespace = params.namespace === undefined ? undefined : namespaceParam(params)
          return {
            records: memory.usage({
              ...(namespace ? { namespace } : {}),
              ...(typeof params.cursor === 'number' ? { cursor: params.cursor } : {}),
              ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
            }),
            nextCursor: null,
          }
        }
        case 'memory/settings': {
          if (typeof params.autoOrganize === 'boolean')
            memory.setAutoOrganizeEnabled(params.autoOrganize)
          const namespace = params.namespace === undefined ? undefined : namespaceParam(params)
          const projectId = namespace && namespace.kind !== 'user' ? namespace.projectId : null
          return {
            autoOrganize: memory.autoOrganizeEnabled(),
            directory: memory.directoryFor(namespace),
            namedAgents: projectId ? memory.namedAgentKeys(projectId) : [],
          }
        }
        default:
          throw new AgentError('METHOD_NOT_FOUND', `未知 RPC 方法：${method}`, 404)
      }
    } catch (cause) {
      mapError(cause)
    }
  },
} as const satisfies RpcHandlerGroup
