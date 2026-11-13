import { z } from 'zod'
import type { PermissionConfig } from '@pidex/shared/thread'
import { AgentError, type SubagentProfile } from '../../Domain'
import { fileAccessProfileFromV4 } from '../../permission/ExecutionPolicy'
import type { MemoryService, MemoryToolScope } from '../../memory/MemoryService'
import { MEMORY_TYPES } from '../../memory/MemoryFiles'
import type { ToolDefinition } from '../ToolRegistry'

/**
 * Host binding: the model never supplies a namespace. The main Agent gets user +
 * current-project memory, a subagent gets its own agent namespace and cannot
 * widen it, and read-only profiles get list/read only.
 */
export type MemoryToolBinding = (context: {
  threadID: string
  profile: 'main' | 'default' | 'explorer' | 'worker'
}) => Promise<MemoryToolScope | null> | MemoryToolScope | null

const namespaceField = z
  .string()
  .min(1)
  .max(160)
  .optional()
  .describe('可选：宿主已绑定的命名空间标识；省略时使用当前默认命名空间。')

const pathField = z.string().min(1).max(160).describe('命名空间内的相对文件名，例如 preferences.md。')

const listSchema = z.object({ namespace: namespaceField }).strict()

const readSchema = z
  .object({
    namespace: namespaceField,
    path: pathField,
    offset: z.number().int().min(0).optional(),
  })
  .strict()

const writeSchema = z
  .object({
    namespace: namespaceField,
    path: pathField,
    content: z.string().min(1),
    expected_revision: z.string().min(1).optional(),
  })
  .strict()

const deleteSchema = z
  .object({
    namespace: namespaceField,
    path: pathField,
    expected_revision: z.string().min(1).optional(),
  })
  .strict()

const dataCapabilities = {
  filesystem: 'none',
  network: 'none',
  process: false,
  externalState: true,
  userInteraction: false,
} as const

const agentError = (cause: unknown) => {
  if (cause instanceof AgentError) return cause
  const code = (cause as { code?: string } | null)?.code
  const message = cause instanceof Error ? cause.message : String(cause)
  if (code === 'MEMORY_CONFLICT') return new AgentError('MEMORY_CONFLICT', message, 409)
  // A namespace outside the host binding is a permission failure, not a new code.
  if (code === 'MEMORY_SCOPE_DENIED') return new AgentError('PERMISSION_DENIED', message, 403)
  if (code === 'MEMORY_DISABLED') return new AgentError('MEMORY_DISABLED', message, 409)
  if (code === 'MEMORY_REJECTED') return new AgentError('MEMORY_REJECTED', message, 409)
  return new AgentError('MEMORY_IO_FAILED', message, 500)
}

/** Memory writes are data mutations: a read-only file access scope must deny them. */
const assertWritable = (context: { permissionConfig?: PermissionConfig }) => {
  const sandboxMode = context.permissionConfig?.sandboxMode ?? 'workspace-write'
  if (fileAccessProfileFromV4(sandboxMode) === 'read-only')
    throw new AgentError('PERMISSION_DENIED', '只读文件访问范围禁止写入记忆', 403)
}

const resolveScope = async (
  binding: MemoryToolBinding,
  context: { invocation?: { threadID: string }; profile?: SubagentProfile },
) => {
  const threadID = context.invocation?.threadID
  if (!threadID)
    throw new AgentError('MEMORY_DISABLED', '记忆工具缺少宿主线程身份', 500)
  const scope = await binding({ threadID, profile: context.profile ?? 'main' })
  if (!scope) throw new AgentError('MEMORY_DISABLED', '记忆功能未启用或当前任务没有记忆作用域', 409)
  return scope
}

/** Individual builders keep each schema's inferred input type intact. */
export const createMemoryToolDefinitions = (
  memory: MemoryService,
  binding: MemoryToolBinding,
): ToolDefinition<any, any>[] => [
  {
    sdkName: 'memory_list',
    name: 'memory_list',
    schema: listSchema,
    description:
      '列出当前记忆命名空间的文件与索引（MEMORY.md）。用真实文件名和描述判断哪些主题与本轮任务相关。',
    capabilities: { ...dataCapabilities, readOnly: true },
    allowedModes: ['chat', 'plan'],
    allowedProfiles: ['main', 'default', 'explorer', 'worker'],
    approvalStrategy: 'never-review',
    visibility: 'eager',
    executionMode: 'parallel',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: '宿主已绑定的命名空间标识；通常省略。' },
      },
      additionalProperties: false,
    },
    execute: async (input, context) => {
      const scope = await resolveScope(binding, context)
      const namespaces = input.namespace
        ? [memory.resolveScopedNamespace(scope, input.namespace)]
        : [...scope.writable]
      const listings = await Promise.all(
        namespaces.map(async (namespace) => ({
          namespace: (await memory.toolList({ namespace, writable: [namespace] }))[0]!.namespace,
          ...(await memory.list(namespace)),
        })),
      )
      return { namespaces: listings }
    },
  },
  {
    sdkName: 'memory_read',
    name: 'memory_read',
    schema: readSchema,
    description:
      '读取一个记忆文件的正文。单次最多返回 4,096 字节；truncated 为 true 时用 nextOffset 继续读取。',
    capabilities: { ...dataCapabilities, readOnly: true },
    allowedModes: ['chat', 'plan'],
    allowedProfiles: ['main', 'default', 'explorer', 'worker'],
    approvalStrategy: 'never-review',
    visibility: 'eager',
    executionMode: 'parallel',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: '宿主已绑定的命名空间标识；通常省略。' },
        path: { type: 'string', description: '命名空间内的相对文件名。' },
        offset: { type: 'integer', minimum: 0, description: '上次返回的 nextOffset。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      const scope = await resolveScope(binding, context)
      try {
        const result = await memory.toolRead({
          scope,
          ...(input.namespace ? { namespace: input.namespace } : {}),
          path: input.path,
          ...(input.offset === undefined ? {} : { offset: input.offset }),
        })
        if (!result) throw new AgentError('MEMORY_NOT_FOUND', `记忆文件 ${input.path} 不存在`, 404)
        memory.recordBodyUsage({
          namespace: memory.resolveScopedNamespace(scope, input.namespace),
          threadId: context.invocation?.threadID ?? '',
          turnId: context.invocation?.turnID ?? null,
          path: result.file.path,
          revision: result.file.revision,
          truncated: result.file.page.truncated,
          bytes: Buffer.byteLength(result.file.page.content, 'utf8'),
        })
        return {
          namespace: result.namespace,
          path: result.file.path,
          name: result.file.name,
          description: result.file.description,
          type: result.file.type,
          revision: result.file.revision,
          indexed: result.file.indexed,
          diagnostics: result.file.diagnostics,
          content: result.file.page.content,
          nextOffset: result.file.page.nextOffset,
          truncated: result.file.page.truncated,
        }
      } catch (cause) {
        throw agentError(cause)
      }
    },
  },
  {
    sdkName: 'memory_write',
    name: 'memory_write',
    schema: writeSchema,
    description: [
      '写入一个记忆主题文件。宿主不会替你改 MEMORY.md：同一轮内用 memory_write 写 MEMORY.md（分类 + 短链接）保持索引最新。',
      `文件必须以 YAML frontmatter 开头：name、description、type（${MEMORY_TYPES.join('/')}）。`,
      '保存前先用 memory_list 查找已有主题，优先更新而不是新建重复主题。',
      '写入已存在的文件时提交读取得到的 revision（expected_revision）；冲突会报错，需重新读取。',
    ].join('\n'),
    capabilities: { ...dataCapabilities, readOnly: false },
    allowedModes: ['chat'],
    allowedProfiles: ['main', 'default', 'worker'],
    approvalStrategy: 'never-review',
    visibility: 'eager',
    executionMode: 'sequential',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: '宿主已绑定的命名空间标识；通常省略。' },
        path: { type: 'string', description: '命名空间内的相对文件名，必须为 .md。' },
        content: { type: 'string', description: '完整文件内容，含 YAML frontmatter 与 Markdown 正文。' },
        expected_revision: { type: 'string', description: '覆盖已存在文件时必填。' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      assertWritable(context)
      const scope = await resolveScope(binding, context)
      try {
        const result = await memory.write({
          namespace: memory.resolveScopedNamespace(scope, input.namespace),
          path: input.path,
          content: input.content,
          ...(input.expected_revision === undefined
            ? {}
            : { expectedRevision: input.expected_revision }),
          ...(context.invocation ? { threadId: context.invocation.threadID } : {}),
          ...(context.invocation ? { turnId: context.invocation.turnID } : {}),
        })
        const scoped = memory.resolveScopedNamespace(scope, input.namespace)
        const listing = await memory.list(scoped)
        return {
          path: result.path,
          revision: result.revision,
          created: result.created,
          indexed: listing.files.find((file) => file.path === result.path)?.indexed ?? false,
          missingIndexLinks: listing.diagnostics,
        }
      } catch (cause) {
        throw agentError(cause)
      }
    },
  },
  {
    sdkName: 'memory_delete',
    name: 'memory_delete',
    schema: deleteSchema,
    description:
      '删除一个记忆主题文件。宿主不会替你改 MEMORY.md：同一轮内更新索引并移除指向该文件的链接。提交读取得到的 revision 可避免覆盖外部修改。',
    capabilities: { ...dataCapabilities, readOnly: false },
    allowedModes: ['chat'],
    allowedProfiles: ['main', 'default', 'worker'],
    approvalStrategy: 'never-review',
    visibility: 'eager',
    executionMode: 'sequential',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: '宿主已绑定的命名空间标识；通常省略。' },
        path: { type: 'string', description: '命名空间内的相对文件名。' },
        expected_revision: { type: 'string', description: '可选：读取时得到的 revision。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      assertWritable(context)
      const scope = await resolveScope(binding, context)
      try {
        const deleted = await memory.delete({
          namespace: memory.resolveScopedNamespace(scope, input.namespace),
          path: input.path,
          ...(input.expected_revision === undefined
            ? {}
            : { expectedRevision: input.expected_revision }),
        })
        return { path: input.path, deleted }
      } catch (cause) {
        throw agentError(cause)
      }
    },
  },
]
