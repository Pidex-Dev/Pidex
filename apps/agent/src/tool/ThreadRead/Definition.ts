import { z } from 'zod'
import { resolveThreadReference } from '@pidex/shared/thread-reference'
import type { Thread, ThreadTurnBundle } from '@pidex/shared/thread'
import { AgentError } from '../../Domain'
import type { ThreadReadViewRepository } from '../../session/ThreadReadViewRepository'
import type { ThreadHistoryPage } from '../../transport/ThreadProjection'
import type { ToolDefinition } from '../ToolRegistry'

const MAX_TOOL_CONTENT = 4_000
const MAX_PAGE_LIMIT = 50

const schema = z
  .object({
    thread_ref: z.string().min(1),
    before: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  })
  .strict()

type ReadThreadInput = z.infer<typeof schema>

type ReadThreadEntry = {
  id: string
  turnId: string
  agentId?: string
  role: 'user' | 'assistant'
  kind: 'message' | 'text' | 'plan' | 'tool'
  status: string
  content: string
  createdAt: number
}

type ReadThreadOutput = {
  thread: {
    id: string
    title: string
    workspace: Thread['workspace']
    createdAt: number
    updatedAt: number
  }
  entries: ReadThreadEntry[]
  hasOlder: boolean
  olderCursor: string | null
}

const summarizeTool = (title: string, output: string): string => {
  const heading = title ? `${title}\n` : ''
  if (heading.length >= MAX_TOOL_CONTENT) return heading.slice(0, MAX_TOOL_CONTENT)
  return `${heading}${output.slice(0, MAX_TOOL_CONTENT - heading.length)}`
}

const entriesForBundle = (bundle: ThreadTurnBundle): ReadThreadEntry[] => {
  const entries: ReadThreadEntry[] = []
  for (const input of bundle.inputs) {
    entries.push({
      id: input.id,
      turnId: bundle.turn.id,
      role: 'user',
      kind: 'message',
      status: bundle.turn.status,
      content: input.content,
      createdAt: input.createdAt,
    })
  }
  for (const item of bundle.items) {
    if (item.type === 'text' && item.placement === 'result') {
      entries.push({
        id: item.id,
        turnId: bundle.turn.id,
        agentId: item.agentId,
        role: 'assistant',
        kind: 'text',
        status: item.status,
        content: item.text,
        createdAt: item.createdAt,
      })
    } else if (item.type === 'plan') {
      entries.push({
        id: item.id,
        turnId: bundle.turn.id,
        agentId: item.agentId,
        role: 'assistant',
        kind: 'plan',
        status: item.status,
        content: item.markdown,
        createdAt: item.createdAt,
      })
    } else if (item.type === 'tool') {
      entries.push({
        id: item.id,
        turnId: bundle.turn.id,
        agentId: item.agentId,
        role: 'assistant',
        kind: 'tool',
        status: item.state,
        content: summarizeTool(item.title, item.output ?? ''),
        createdAt: item.createdAt,
      })
    }
  }
  return entries
}

export const createThreadReadDefinition = (
  repository: ThreadReadViewRepository,
): ToolDefinition<ReadThreadInput, ReadThreadOutput> => ({
  sdkName: 'read_thread',
  name: 'read_thread',
  schema,
  description:
    'Read recent conversation history for a specified thread, including user messages, assistant results, plans and tool summaries. Use to recover context for follow-up work. Read-only; does not change data.',
  capabilities: {
    filesystem: 'none',
    network: 'none',
    process: false,
    externalState: false,
    userInteraction: false,
    readOnly: true,
  },
  allowedModes: ['chat', 'plan'],
  allowedProfiles: ['main', 'default', 'explorer', 'worker'],
  approvalStrategy: 'never-review',
  visibility: 'eager',
  executionMode: 'parallel',
  inputSchema: {
    type: 'object',
    properties: {
      thread_ref: {
        type: 'string',
        minLength: 1,
        description: 'Thread ID or Pidex deep link, such as pidex://threads/<id>.',
      },
      before: {
        type: 'string',
        description: 'The olderCursor from the previous page, to continue reading earlier history.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum turns returned; default 10.',
      },
    },
    required: ['thread_ref'],
    additionalProperties: false,
  },
  execute: async (input) => {
    const threadID = resolveThreadReference(input.thread_ref)
    if (!threadID) throw new AgentError('THREAD_NOT_FOUND', '无法解析线程引用', 404)
    let page: ThreadHistoryPage
    try {
      page = repository.history(threadID, {
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
    } catch (cause) {
      if (cause instanceof AgentError) throw cause
      throw new AgentError('THREAD_READ_FAILED', '读取线程历史失败', 500)
    }
    return {
      thread: {
        id: page.thread.id,
        title: page.thread.title,
        workspace: page.thread.workspace,
        createdAt: page.thread.createdAt,
        updatedAt: page.thread.updatedAt,
      },
      entries: page.turns.flatMap(entriesForBundle),
      hasOlder: page.hasOlder,
      olderCursor: page.olderCursor,
    }
  },
})
