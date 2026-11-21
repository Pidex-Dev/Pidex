import { randomUUID } from 'node:crypto'
import type { DecisionOutcomeRecord } from '@pidex/shared/decision'
import type { AgentDatabase } from '../../storage/database/AgentDatabase'
import type { DecisionService } from '../DecisionService'
import { turnContinueSpec, type TurnContinueOutcome } from '../specs/TurnContinue'
import { turnCompletionSpec, type TurnCompletionOutcome } from '../specs/TurnCompletion'

/**
 * Pure turn-end adapters. The orchestrator wires these into the turn-end hook
 * of AgentRuntimeService; nothing here imports the runtime or the Goal code.
 * Without a DecisionService or judge, every path returns the host's behavior
 * without a judge (no continuation, no reminder).
 */

/** At most two continuations per user message. */
export const MAX_CONTINUATIONS_PER_MESSAGE = 2
/** At most one verification reminder per turn. */
export const MAX_COMPLETION_NUDGES_PER_TURN = 1

/** Goal state passed in by the caller; the adapters never read Goal storage themselves. */
export type TurnGoalState = {
  /** True when the thread has an active Goal. */
  readonly active: boolean
  /** True when this turn's end is about to enter Goal settlement or continuation. */
  readonly settling: boolean
}

export type TurnEndToolCall = {
  readonly name: string
  readonly input: Record<string, unknown>
}

export type TurnContinuationInput = {
  readonly threadId: string
  readonly turnId: string
  /** Stable identity of the user message this turn answers (input id or message id). */
  readonly userMessageId: string
  /** The host-recorded real user request; never model claims or tool output. */
  readonly userMessage: string
  readonly finalMessage: string
  /** Every tool call the turn executed; a non-empty list means the model acted. */
  readonly toolCalls: readonly TurnEndToolCall[]
  /** Files created or updated by this turn's patches. */
  readonly patches: readonly { readonly path: string; readonly operation: string }[]
  readonly goal: TurnGoalState
  /** Continuations already injected for this user message. */
  readonly continuationsUsed: number
  /** Verification reminders already injected for this turn. */
  readonly completionNudgesUsed: number
}

export type TurnEndDecision = {
  readonly action: 'none' | 'continue' | 'verify'
  /** The prompt to inject as the next turn's input; present only when action is not 'none'. */
  readonly prompt?: string | undefined
  readonly specId?: string | undefined
  readonly ledgerId?: string | undefined
  readonly outcome?: TurnContinueOutcome | TurnCompletionOutcome | undefined
}

const NONE: TurnEndDecision = { action: 'none' }

const CONTINUE_PROMPT =
  '<pidex_turn_continuation>\n上一轮你在消息中承诺了后续动作或对本已授权的工作请求许可，但没有执行。请继续完成用户已请求的剩余工作；不要执行删除、推送、发布或其他不可逆外发操作，遇到此类步骤先停下来说明。\n</pidex_turn_continuation>'

const VERIFY_PROMPT =
  '<pidex_completion_check>\n本轮存在代码改动，且改动后尚未运行任何测试、构建或类型检查。请先运行与改动相关的最小验证（测试/构建/类型检查），确认通过后再宣告完成；如验证失败，修复后重试。\n</pidex_completion_check>'

const VERIFICATION_COMMAND =
  /\b(?:test|tests|typecheck|type-check|tsc|lint|check|build|vitest|jest|pytest|oxlint|eslint|mypy|ruff|cargo\s+(?:check|clippy)|go\s+vet)\b/i

/** Host fact: whether a tool call ran a test, build, type check or lint. */
export const isVerificationCall = (call: TurnEndToolCall): boolean => {
  if (call.name !== 'exec_command') return false
  const command = call.input.command
  return typeof command === 'string' && VERIFICATION_COMMAND.test(command)
}

const editedFileCount = (input: TurnContinuationInput): number =>
  input.patches.filter((patch) => patch.operation !== 'delete').length

const ranVerificationAfterLastEdit = (input: TurnContinuationInput): boolean => {
  const calls = input.toolCalls
  let lastEdit = -1
  const editTools = new Set(['Write', 'Edit', 'ApplyPatch', 'apply_patch'])
  calls.forEach((call, index) => {
    if (editTools.has(call.name)) lastEdit = index
  })
  if (lastEdit === -1) return calls.some(isVerificationCall)
  return calls.slice(lastEdit + 1).some(isVerificationCall)
}

const appendNudgeOutcome = async (
  decisions: DecisionService | null | undefined,
  db: AgentDatabase | null | undefined,
  outcome: DecisionOutcomeRecord,
): Promise<void> => {
  try {
    if (decisions) {
      await decisions.recordOutcome(outcome)
    } else {
      db?.repositories.decisionLedger.appendOutcome(outcome)
    }
  } catch {
    // SAFETY: outcome bookkeeping must never change what the agent does.
  }
}

/**
 * Records how the previous continuation ended, from host facts: `acted` when
 * the following turn executed tools, `ended` otherwise. Call once at the end
 * of the turn that followed an injected continuation.
 */
export async function settleTurnContinuationOutcome(
  db: AgentDatabase | null | undefined,
  input: {
    threadId: string
    ledgerId: string
    toolCalls: readonly TurnEndToolCall[]
  },
  decisions?: DecisionService | null | undefined,
): Promise<void> {
  if (!db && !decisions) return
  await appendNudgeOutcome(decisions, db, {
    id: randomUUID(),
    ledgerId: input.ledgerId,
    threadId: input.threadId,
    kind: 'nudge',
    verdict: input.toolCalls.length > 0 ? 'acted' : 'ended',
    createdAt: Date.now(),
  })
}

/**
 * Turn-end continuation gate. Skips entirely when the model acted, the budget
 * is spent, or Goal settlement owns this turn's end; then asks the judge
 * whether the closing message promised work or asked for a go-ahead on
 * already-requested work. Only an active judged verdict injects a prompt.
 */
export async function evaluateTurnContinuation(
  decisions: DecisionService | null | undefined,
  input: TurnContinuationInput,
  options: {
    db?: AgentDatabase | null | undefined
    signal?: AbortSignal | undefined
    cwd?: string | undefined
  } = {},
): Promise<TurnEndDecision> {
  if (input.toolCalls.length > 0) return NONE
  if (!input.finalMessage.trim() || !input.userMessage.trim()) return NONE
  if (input.continuationsUsed >= MAX_CONTINUATIONS_PER_MESSAGE) return NONE
  // INVARIANT: Goal 结算在即由 GoalContinuationCoordinator 决定是否续跑，此处不重复触发。
  if (input.goal.active && input.goal.settling) return NONE
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return NONE
  if (engine.getMode(turnContinueSpec.id) === 'off') return NONE
  const decision = await engine.decide(
    turnContinueSpec,
    { userMessage: input.userMessage, finalMessage: input.finalMessage },
    {
      signal: options.signal,
      origin: { threadId: input.threadId, turnId: input.turnId },
    },
  )
  if (decision.mode !== 'active' || decision.source !== 'judge') return NONE
  if (decision.outcome === 'end') return NONE
  if (decision.ledgerId) {
    await appendNudgeOutcome(decisions, options.db, {
      id: randomUUID(),
      ledgerId: decision.ledgerId,
      threadId: input.threadId,
      kind: 'nudge',
      verdict: 'queued',
      createdAt: Date.now(),
    })
  }
  return {
    action: 'continue',
    prompt: CONTINUE_PROMPT,
    specId: turnContinueSpec.id,
    ledgerId: decision.ledgerId,
    outcome: decision.outcome,
  }
}

/**
 * Turn-end verification gate: code changed, the model declares the work done,
 * and no test/build/type check ran after the last edit. At most one reminder
 * per turn; only an active judged verdict injects a prompt.
 */
export async function evaluateTurnCompletion(
  decisions: DecisionService | null | undefined,
  input: TurnContinuationInput,
  options: {
    db?: AgentDatabase | null | undefined
    signal?: AbortSignal | undefined
    cwd?: string | undefined
  } = {},
): Promise<TurnEndDecision> {
  if (input.completionNudgesUsed >= MAX_COMPLETION_NUDGES_PER_TURN) return NONE
  const editedFiles = editedFileCount(input)
  if (editedFiles === 0) return NONE
  if (ranVerificationAfterLastEdit(input)) return NONE
  if (!input.finalMessage.trim() || !input.userMessage.trim()) return NONE
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return NONE
  if (engine.getMode(turnCompletionSpec.id) === 'off') return NONE
  const decision = await engine.decide(
    turnCompletionSpec,
    {
      userMessage: input.userMessage,
      finalMessage: input.finalMessage,
      editedFiles,
      ranVerificationAfterLastEdit: false,
    },
    {
      signal: options.signal,
      origin: { threadId: input.threadId, turnId: input.turnId },
    },
  )
  if (decision.mode !== 'active' || decision.source !== 'judge') return NONE
  if (decision.outcome !== 'nudge') return NONE
  if (decision.ledgerId) {
    await appendNudgeOutcome(decisions, options.db, {
      id: randomUUID(),
      ledgerId: decision.ledgerId,
      threadId: input.threadId,
      kind: 'nudge',
      verdict: 'queued',
      createdAt: Date.now(),
    })
  }
  return {
    action: 'verify',
    prompt: VERIFY_PROMPT,
    specId: turnCompletionSpec.id,
    ledgerId: decision.ledgerId,
    outcome: decision.outcome,
  }
}