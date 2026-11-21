import type { DecisionService } from '../DecisionService'
import {
  applyTaskFrameChange,
  inputInterjectionSpec,
  inputPreflightSpec,
  INTERJECTION_BUDGET_MS,
  taskFrameOf,
  taskFrameSpec,
  type InputPreflightOutcome,
  type InterjectionOutcome,
  type TaskFrame,
} from '../specs/InputSpecs'


export type InputDecisionThreadState = {
  readonly threadId: string
  readonly turnId?: string | undefined
  // INVARIANT: True while a turn is executing on this thread.
  readonly running: boolean
  // INVARIANT: True once this thread has executed any tool.
  readonly sessionHasWork?: boolean | undefined
  // INVARIANT: Short digests of the most recent turns, oldest first.
  readonly recentTurns?: readonly string[] | undefined
  // INVARIANT: What the agent is doing right now, when the message arrives mid-run.
  readonly currentAction?: string | undefined
  // INVARIANT: The thread's task goal, when one is known.
  readonly goal?: string | undefined
}

export type InputPreflightResult = {
  readonly outcome: InputPreflightOutcome
  readonly source: 'judge' | 'fallback'
}

export async function decideInputPreflight(
  decisions: DecisionService | null | undefined,
  input: { messageText: string; thread: InputDecisionThreadState },
  options: { signal?: AbortSignal | undefined; cwd?: string | undefined } = {},
): Promise<InputPreflightResult> {
  const preflightInput = {
    userMessage: input.messageText,
    recentTurns: input.thread.recentTurns ?? [],
    taskFrame: taskFrameOf(input.thread.threadId) ?? undefined,
    currentAction: input.thread.currentAction,
    sessionHasWork: input.thread.sessionHasWork,
  }
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) {
    return { outcome: inputPreflightSpec.fallback(preflightInput), source: 'fallback' }
  }
  const frameInput = {
    userMessage: input.messageText,
    frame: taskFrameOf(input.thread.threadId),
    recentTurns: input.thread.recentTurns ?? [],
  }
  const origin = {
    threadId: input.thread.threadId,
    ...(input.thread.turnId ? { turnId: input.thread.turnId } : {}),
  }
  const [decision, frameDecision] = await Promise.all([
    engine.decide(inputPreflightSpec, preflightInput, { signal: options.signal, origin }),
    engine.decide(taskFrameSpec, frameInput, { signal: options.signal, origin }),
  ])
  if (frameDecision.mode === 'active' && frameDecision.source === 'judge') {
    applyTaskFrameChange(input.thread.threadId, frameDecision.outcome, input.messageText)
  }
  return { outcome: decision.outcome, source: decision.source }
}

// INVARIANT: The current task frame for tool.approval / tool.constraint consumers; null without one.
export function currentTaskFrame(threadId: string): TaskFrame | null {
  return taskFrameOf(threadId)
}

export async function decideInterjectionDelivery(
  decisions: DecisionService | null | undefined,
  input: {
    messageText: string
    thread: InputDecisionThreadState
    // INVARIANT: What the host would do without a judge: the user's chosen delivery.
    requestedDelivery: InterjectionOutcome
  },
  options: { cwd?: string | undefined } = {},
): Promise<{ delivery: InterjectionOutcome; source: 'judge' | 'fallback' }> {
  const keep = { delivery: input.requestedDelivery, source: 'fallback' as const }
  if (!input.thread.running) return keep
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return keep
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INTERJECTION_BUDGET_MS)
  try {
    const decision = await engine.decide(
      inputInterjectionSpec,
      {
        userMessage: input.messageText,
        goal: input.thread.goal ?? taskFrameOf(input.thread.threadId)?.goal ?? '',
        currentAction: input.thread.currentAction ?? '',
      },
      {
        signal: controller.signal,
        origin: {
          threadId: input.thread.threadId,
          ...(input.thread.turnId ? { turnId: input.thread.turnId } : {}),
        },
      },
    )
    if (decision.source !== 'judge') return keep
    return { delivery: decision.outcome, source: 'judge' }
  } catch {
    return keep
  } finally {
    clearTimeout(timer)
  }
}