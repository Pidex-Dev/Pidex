import type { DecisionService } from '../DecisionService'
import type { AgentInputItem } from '../../context/ContextManager'
import {
  contextCompactSpec,
  contextForgetSpec,
  type ContextCompactOutcome,
  type ContextForgetOutcome,
} from '../specs/ContextSpecs'
import { taskFrameOf } from '../specs/InputSpecs'

/**
 * Context-plane adapters over the provider message items a compaction sees.
 * Pure functions with an optional DecisionService: without a service or an
 * engine every item keeps the host's behavior (nothing shrinks, nothing is
 * scored). Shrinking only rewrites tool results, never anything a user said.
 */

/** Below this size a result is never worth a judge call or a placeholder. */
export const FORGET_MIN_RESULT_CHARS = 2_000
/** Results younger than this many user turns are always kept. */
export const FORGET_MIN_AGE_TURNS = 2
const RESULT_HEAD_CHARS = 600
const CALL_TEXT_CHARS = 300
const GOAL_TEXT_CHARS = 500
const MAX_BATCH_CALLS = 24

type ToolResultItem = {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: Array<{ type: string; text?: string }>
  isError: boolean
  timestamp?: number
}

const isToolResult = (item: AgentInputItem): item is AgentInputItem & ToolResultItem =>
  item?.role === 'toolResult' &&
  typeof item.toolCallId === 'string' &&
  typeof item.toolName === 'string' &&
  Array.isArray(item.content)

const textOf = (item: AgentInputItem & ToolResultItem): string =>
  item.content
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('\n')

const userTextOf = (item: AgentInputItem): string => {
  if (item?.role !== 'user') return ''
  const content = item.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: { type?: string; text?: string }) =>
      part?.type === 'text' && typeof part.text === 'string' ? part.text : '',
    )
    .join('\n')
}

const callTextOf = (
  items: readonly AgentInputItem[],
  result: AgentInputItem & ToolResultItem,
): string => {
  for (const item of items) {
    if (item?.role !== 'assistant' || !Array.isArray(item.content)) continue
    for (const part of item.content as Array<{
      type?: string
      id?: string
      name?: string
      arguments?: unknown
    }>) {
      if (part?.type === 'toolCall' && part.id === result.toolCallId) {
        let args = ''
        try {
          args = JSON.stringify(part.arguments ?? {})
        } catch {
          args = ''
        }
        return `${result.toolName} ${args}`.slice(0, CALL_TEXT_CHARS)
      }
    }
  }
  return result.toolName
}

const goalTextOf = (items: readonly AgentInputItem[], threadId?: string | undefined): string => {
  const frame = threadId ? taskFrameOf(threadId) : null
  if (frame?.goal) return frame.goal.slice(0, GOAL_TEXT_CHARS)
  const users = items.map(userTextOf).filter((text) => text.trim())
  return (users.at(-1) ?? '').slice(0, GOAL_TEXT_CHARS)
}

const ageTurnsOf = (items: readonly AgentInputItem[], index: number): number => {
  let age = 0
  for (let cursor = index + 1; cursor < items.length; cursor++) {
    if (items[cursor]?.role === 'user') age += 1
  }
  return age
}

const sinceOf = (items: readonly AgentInputItem[], index: number): string[] => {
  let calls = 0
  for (let cursor = index + 1; cursor < items.length; cursor++) {
    if (isToolResult(items[cursor]!)) calls += 1
  }
  return calls > 0 ? [`${calls} more tool calls`] : []
}

/** One-line stand-in for a shrunk tool result; the call itself stays visible. */
export function forgetPlaceholder(
  call: string,
  resultChars: number,
  reason: 'forget' | 'compact',
): string {
  return `[早期工具结果已折叠：${call}（${resultChars} 字符，${reason === 'forget' ? '判定不再需要全文' : '压缩保留调用记录'}）。如需原文请重新执行或查阅会话归档。]`
}

const shrinkItem = (
  item: AgentInputItem & ToolResultItem,
  call: string,
  reason: 'forget' | 'compact',
): AgentInputItem => {
  const chars = textOf(item).length
  return {
    ...item,
    content: [{ type: 'text', text: forgetPlaceholder(call, chars, reason) }],
    details: undefined,
  }
}

export type ContextForgetPlan = {
  readonly items: AgentInputItem[]
  readonly shrunkToolCallIds: readonly string[]
}

/**
 * Active forgetting at a cache boundary: stale, large tool results a confident
 * judge deems unneeded are replaced with a one-line placeholder. Sticky by
 * construction: a shrunk result is already small and never re-judged.
 */
export async function planContextForget(
  decisions: DecisionService | null | undefined,
  input: {
    threadId?: string | undefined
    items: readonly AgentInputItem[]
    goal?: string | undefined
  },
  options: { signal?: AbortSignal | undefined; cwd?: string | undefined } = {},
): Promise<ContextForgetPlan> {
  const unchanged: ContextForgetPlan = { items: [...input.items], shrunkToolCallIds: [] }
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return unchanged
  const goal = input.goal ?? goalTextOf(input.items, input.threadId)
  const candidates: { index: number; item: AgentInputItem & ToolResultItem; call: string }[] = []
  input.items.forEach((item, index) => {
    if (!isToolResult(item)) return
    const chars = textOf(item).length
    if (chars < FORGET_MIN_RESULT_CHARS) return
    if (ageTurnsOf(input.items, index) < FORGET_MIN_AGE_TURNS) return
    candidates.push({ index, item, call: callTextOf(input.items, item) })
  })
  const batch = candidates.slice(0, MAX_BATCH_CALLS)
  if (batch.length === 0) return unchanged
  const decided = await engine.decideMany(
    contextForgetSpec,
    batch.map(({ index, item, call }) => ({
      goal,
      call,
      resultChars: textOf(item).length,
      ageTurns: ageTurnsOf(input.items, index),
      since: sinceOf(input.items, index),
    })),
    {
      signal: options.signal,
      ...(input.threadId ? { origin: { threadId: input.threadId } } : {}),
    },
  )
  return applyForgetDecisions(
    input.items,
    batch,
    decided.map((decision) => decision.outcome),
  )
}

function applyForgetDecisions(
  items: readonly AgentInputItem[],
  batch: readonly { index: number; item: AgentInputItem & ToolResultItem; call: string }[],
  outcomes: readonly ContextForgetOutcome[],
): ContextForgetPlan {
  const next = [...items]
  const shrunk: string[] = []
  batch.forEach(({ index, item, call }, position) => {
    if (outcomes[position] !== 'shrink') return
    next[index] = shrinkItem(item, call, 'forget')
    shrunk.push(item.toolCallId)
  })
  return { items: next, shrunkToolCallIds: shrunk }
}

export type ContextCompactCallVerdict = {
  readonly toolCallId: string
  readonly call: string
  readonly resultChars: number
  readonly decision: ContextCompactOutcome
  readonly action: 'keep' | 'drop-result' | 'drop-call'
}

export type ContextCompactPlan = {
  readonly verdicts: readonly ContextCompactCallVerdict[]
  readonly items: AgentInputItem[]
  readonly droppedResultToolCallIds: readonly string[]
  readonly droppedToolCallIds: readonly string[]
}

/**
 * Summary-free compaction scoring: each old tool call is classified and rated.
 * A confident "the full text is not needed" replaces the result with a
 * placeholder; a confident "the call no longer matters" removes the pair.
 * Errors and anything the judge is unsure about stay word for word.
 */
export async function planContextCompaction(
  decisions: DecisionService | null | undefined,
  input: {
    threadId?: string | undefined
    items: readonly AgentInputItem[]
    goal?: string | undefined
  },
  options: { signal?: AbortSignal | undefined; cwd?: string | undefined } = {},
): Promise<ContextCompactPlan> {
  const items = [...input.items]
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return { verdicts: [], items, droppedResultToolCallIds: [], droppedToolCallIds: [] }
  const goal = input.goal ?? goalTextOf(items, input.threadId)
  const candidates: { index: number; item: AgentInputItem & ToolResultItem; call: string }[] = []
  items.forEach((item, index) => {
    if (!isToolResult(item)) return
    if (textOf(item).length < FORGET_MIN_RESULT_CHARS) return
    candidates.push({ index, item, call: callTextOf(items, item) })
  })
  const batch = candidates.slice(0, MAX_BATCH_CALLS)
  if (batch.length === 0)
    return { verdicts: [], items, droppedResultToolCallIds: [], droppedToolCallIds: [] }
  const decided = await engine.decideMany(
    contextCompactSpec,
    batch.map(({ index, item, call }) => ({
      goal,
      call,
      resultHead: textOf(item).slice(0, RESULT_HEAD_CHARS),
      resultChars: textOf(item).length,
      isError: item.isError === true,
      since: sinceOf(items, index),
    })),
    {
      signal: options.signal,
      ...(input.threadId ? { origin: { threadId: input.threadId } } : {}),
    },
  )
  return applyCompactDecisions(items, batch, decided)
}

const COMPACT_DROP_RESULT_AT = 0.2
const COMPACT_DROP_CALL_AT = 0.2

function applyCompactDecisions(
  items: readonly AgentInputItem[],
  batch: readonly { index: number; item: AgentInputItem & ToolResultItem; call: string }[],
  decided: readonly { outcome: ContextCompactOutcome; source: 'judge' | 'fallback' }[],
): ContextCompactPlan {
  const next: (AgentInputItem | null)[] = [...items]
  const verdicts: ContextCompactCallVerdict[] = []
  const droppedResults: string[] = []
  const droppedCalls: string[] = []
  batch.forEach(({ index, item, call }, position) => {
    const decision = decided[position]!
    let action: ContextCompactCallVerdict['action'] = 'keep'
    if (decision.source === 'judge' && item.isError !== true) {
      const { keepResult, keepCall } = decision.outcome
      if (
        keepCall !== null &&
        keepCall <= COMPACT_DROP_CALL_AT &&
        keepResult !== null &&
        keepResult <= COMPACT_DROP_RESULT_AT
      ) {
        action = 'drop-call'
      } else if (keepResult !== null && keepResult <= COMPACT_DROP_RESULT_AT) {
        action = 'drop-result'
      }
    }
    verdicts.push({
      toolCallId: item.toolCallId,
      call,
      resultChars: textOf(item).length,
      decision: decision.outcome,
      action,
    })
    if (action === 'drop-result') {
      next[index] = shrinkItem(item, call, 'compact')
      droppedResults.push(item.toolCallId)
    } else if (action === 'drop-call') {
      next[index] = null
      droppedCalls.push(item.toolCallId)
    }
  })
  if (droppedCalls.length > 0) {
    for (let index = 0; index < next.length; index++) {
      const item = next[index]
      if (item?.role !== 'assistant' || !Array.isArray(item.content)) continue
      const content = (item.content as Array<{ type?: string; id?: string }>).filter(
        (part) => !(part?.type === 'toolCall' && part.id && droppedCalls.includes(part.id)),
      )
      next[index] = content.length === item.content.length ? item : { ...item, content }
    }
  }
  return {
    verdicts,
    items: next.filter((item): item is AgentInputItem => item !== null),
    droppedResultToolCallIds: droppedResults,
    droppedToolCallIds: droppedCalls,
  }
}
