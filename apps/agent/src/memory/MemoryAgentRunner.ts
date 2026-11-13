import type { Api, AssistantMessage, Context, Model as PiModel, Tool } from '@earendil-works/pi-ai'
import { z } from 'zod'
import type { Models } from '@earendil-works/pi-ai'
import type { MemoryAgentRunner, MemoryService, MemoryToolScope } from './MemoryService'

/**
 * Bounded background agent loop for memory extraction and organization.
 *
 * The tool surface is rebuilt per run and bound to exactly one namespace, so a
 * background model cannot reach another project, another agent identity or a
 * code file. Each iteration is capped at the caller's turn budget.
 */
export type MemoryRunnerModelResolver = (input: {
  modelRef: string
  projectId: string | null
}) => Promise<{ ref: string; model: PiModel<Api> } | null>

const listSchema = z.object({}).strict()
const readSchema = z
  .object({ path: z.string().min(1), offset: z.number().int().min(0).optional() })
  .strict()
const writeSchema = z
  .object({
    path: z.string().min(1),
    content: z.string().min(1),
    expected_revision: z.string().min(1).optional(),
  })
  .strict()
const deleteSchema = z
  .object({ path: z.string().min(1), expected_revision: z.string().min(1).optional() })
  .strict()

const toolDefinitions = (memory: MemoryService, scope: MemoryToolScope) => {
  const run = async (name: string, input: unknown) => {
    if (name === 'memory_list') {
      const listing = await memory.list(scope.namespace)
      return {
        namespace: scope.namespace.kind,
        files: listing.files.map((file) => ({
          path: file.path,
          name: file.name,
          description: file.description,
          type: file.type,
          revision: file.revision,
          indexed: file.indexed,
          diagnostics: file.diagnostics,
        })),
        index: { content: listing.index.content, revision: listing.index.revision },
        diagnostics: listing.diagnostics,
      }
    }
    if (name === 'memory_read') {
      const parsed = readSchema.parse(input)
      const file = await memory.read(scope.namespace, parsed.path, parsed.offset ?? 0)
      if (!file) throw new Error(`记忆文件 ${parsed.path} 不存在`)
      return {
        path: file.path,
        revision: file.revision,
        content: file.page.content,
        nextOffset: file.page.nextOffset,
        truncated: file.page.truncated,
      }
    }
    if (name === 'memory_write') {
      const parsed = writeSchema.parse(input)
      return memory.write({
        namespace: scope.namespace,
        path: parsed.path,
        content: parsed.content,
        ...(parsed.expected_revision ? { expectedRevision: parsed.expected_revision } : {}),
      })
    }
    if (name === 'memory_delete') {
      const parsed = deleteSchema.parse(input)
      return {
        deleted: await memory.delete({
          namespace: scope.namespace,
          path: parsed.path,
          ...(parsed.expected_revision ? { expectedRevision: parsed.expected_revision } : {}),
        }),
      }
    }
    throw new Error(`未知的记忆工具：${name}`)
  }
  const tools: Array<Tool & { schema: z.ZodType }> = [
    {
      name: 'memory_list',
      description: '列出当前记忆命名空间的文件与索引。',
      parameters: z.toJSONSchema(listSchema) as Tool['parameters'],
      schema: listSchema,
    },
    {
      name: 'memory_read',
      description: '读取一个记忆文件正文；单次最多 4,096 字节，truncated 时用 nextOffset 继续。',
      parameters: z.toJSONSchema(readSchema) as Tool['parameters'],
      schema: readSchema,
    },
    {
      name: 'memory_write',
      description:
        '写入一个记忆主题文件（YAML frontmatter：name/description/type）。覆盖已存在文件必须提交读取得到的 expected_revision，否则被拒绝。索引不会自动更新，需要时另外写 MEMORY.md。',
      parameters: z.toJSONSchema(writeSchema) as Tool['parameters'],
      schema: writeSchema,
    },
    {
      name: 'memory_delete',
      description: '删除一个记忆主题文件。删除后会同步移除 MEMORY.md 中指向该文件的索引条目。',
      parameters: z.toJSONSchema(deleteSchema) as Tool['parameters'],
      schema: deleteSchema,
    },
  ]
  return { tools, run }
}

const textOf = (message: AssistantMessage) =>
  message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')

const failureText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause).slice(0, 2_000)

export const createMemoryAgentRunner = (input: {
  models: Models
  memory: MemoryService
  resolveModel: MemoryRunnerModelResolver
}): MemoryAgentRunner => {
  return async (run) => {
    const selected = await input.resolveModel({
      modelRef: run.modelRef,
      projectId: run.namespace.kind === 'user' ? null : run.namespace.projectId,
    })
    if (!selected) return { status: 'unavailable', detail: '记忆模型不可用' }
    const scope: MemoryToolScope = { namespace: run.namespace, writable: [run.namespace] }
    const { tools, run: execute } = toolDefinitions(input.memory, scope)
    const context: Context = {
      systemPrompt: [
        run.system,
        '只能使用记忆工具，不能读取或修改代码、配置或工作区文件。',
        '完成后直接给出简短结论，不再调用工具。',
      ].join('\n'),
      messages: [{ role: 'user', content: run.prompt, timestamp: Date.now() }],
      tools,
    }
    let wrote = false
    try {
      for (let turn = 0; turn < run.maxTurns; turn += 1) {
        run.signal.throwIfAborted()
        const response = await input.models.completeSimple(selected.model, context, {
          signal: run.signal,
          maxRetries: 1,
        })
        if (response.stopReason === 'error')
          return { status: 'failed', detail: failureText(response.errorMessage) }
        context.messages.push(response)
        const calls = response.content.filter(
          (part): part is Extract<typeof part, { type: 'toolCall' }> => part.type === 'toolCall',
        )
        if (calls.length === 0) break
        for (const call of calls) {
          run.signal.throwIfAborted()
          // Unknown names never reach a host tool: the loop owns its surface.
          if (!tools.some((tool) => tool.name === call.name)) {
            context.messages.push({
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: `工具 ${call.name} 不在记忆工具范围内` }],
              isError: true,
              timestamp: Date.now(),
            })
            continue
          }
          try {
            const output = await execute(call.name, call.arguments)
            if (call.name === 'memory_write' || call.name === 'memory_delete') wrote = true
            context.messages.push({
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: JSON.stringify(output) }],
              isError: false,
              timestamp: Date.now(),
            })
          } catch (cause) {
            context.messages.push({
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: failureText(cause) }],
              isError: true,
              timestamp: Date.now(),
            })
          }
        }
        // Give the model one final synthesis turn after its last mutation.
        if (turn === run.maxTurns - 1) break
      }
      if (run.signal.aborted) return { status: 'failed', detail: '已取消' }
      return wrote ? { status: 'completed' } : { status: 'empty' }
    } catch (cause) {
      if (run.signal.aborted) throw cause
      return { status: 'failed', detail: failureText(cause) }
    }
  }
}
