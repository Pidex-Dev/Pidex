import type { DecisionAnswer, DecisionPointManifest } from '@pidex/shared/decision'
import { defineDecision, type JsonValue } from '../DecisionSpec'
import { threeZone } from '../DecisionPolicy'

const standIn = (answer: DecisionAnswer): boolean =>
  answer.judge === 'untrusted' || answer.judge === 'unavailable'

export type ContextForgetInput = {
  readonly goal: string
  // INVARIANT: Tool and arguments, e.g. "bash: npm test".
  readonly call: string
  readonly resultChars: number
  // INVARIANT: User turns since the call.
  readonly ageTurns: number
  // INVARIANT: What the agent has been doing since, newest last.
  readonly since: readonly string[]
}

export type ContextForgetOutcome = 'keep' | 'shrink'

export const contextForgetSpec = defineDecision({
  id: 'context.forget',
  version: 1,
  cacheImpact: 'prefix-mutating',
  latency: 'inline',
  capabilities: 'meta',
  questions: {
    still_needed: {
      type: 'boolean',
      instructions: 'Will the full output of `call` be needed again for `goal`?',
    },
  },
  buildState(input: ContextForgetInput): JsonValue {
    return {
      call: input.call,
      goal: input.goal,
      result_chars: input.resultChars,
      age_turns: input.ageTurns,
      since: input.since,
    }
  },
  policy(answers): ContextForgetOutcome {
    return threeZone(answers.still_needed) === 'no' ? 'shrink' : 'keep'
  },
  fallback(): ContextForgetOutcome {
    return 'keep'
  },
})

export type ContextCompactInput = {
  // INVARIANT: What the user is after, from their latest messages.
  readonly goal: string
  // INVARIANT: `bash command="npm test"`.
  readonly call: string
  // INVARIANT: The beginning of the output.
  readonly resultHead: string
  readonly resultChars: number
  readonly isError: boolean
  // INVARIANT: What is known to have happened since, e.g. "12 more tool calls".
  readonly since: readonly string[]
}

export type ContextCompactOutcome = {
  readonly kind: string | null
  readonly keepResult: number | null
  readonly keepCall: number | null
}

export const contextCompactSpec = defineDecision({
  id: 'context.compact',
  version: 1,
  cacheImpact: 'prefix-mutating',
  latency: 'background',
  capabilities: { kind: 'classify', result_needed: 'relate', call_matters: 'relate' },
  questions: {
    kind: {
      type: 'choice',
      instructions: 'What is `result`?',
      criteria: {
        error: 'An error or failure message',
        listing: 'File names or search matches',
        content: 'Source code or document text',
        log: 'Build, test or progress output',
        data: 'Facts or values looked up for the task',
        other: 'Something else',
      },
    },
    result_needed: {
      type: 'boolean',
      instructions: 'Is the full text of `result` still needed to finish `goal`?',
    },
    call_matters: {
      type: 'boolean',
      instructions: 'Does it still matter for `goal` that `call` was made?',
    },
  },
  buildState(input: ContextCompactInput): JsonValue {
    return {
      result: input.resultHead,
      call: input.call,
      goal: input.goal,
      result_chars: input.resultChars,
      failed: input.isError,
      since: input.since,
    }
  },
  policy(answers): ContextCompactOutcome {
    const { kind, result_needed: needed, call_matters: matters } = answers
    const picked =
      !standIn(kind) && kind.choice !== 'other' && (kind.probabilities?.[kind.choice] ?? 1) >= 0.5
    return {
      kind: picked ? kind.choice : null,
      keepResult: standIn(needed) ? null : needed.probability,
      keepCall: standIn(matters) ? null : matters.probability,
    }
  },
  fallback(): ContextCompactOutcome {
    return { kind: null, keepResult: null, keepCall: null }
  },
})

export type GoalMetInput = {
  readonly goal: string
  // INVARIANT: The assistant's closing claim; reference text, never evidence of delivery.
  readonly finalMessage: string
  // INVARIANT: Acceptance items nobody has ticked; a host fact.
  readonly openItems: number
  // INVARIANT: Files were edited and nothing ran afterwards; a host fact.
  readonly unverified: boolean
}

// INVARIANT: `unjudged` means nobody could read the message: the user decides, as without a judge.
export type GoalMetOutcome = 'met' | 'continue' | 'ask' | 'unjudged'

// INVARIANT: goal.met 仅辅助判别；openItems/unverified 等宿主事实优先于模型断言，
export const goalMetSpec = defineDecision({
  id: 'goal.met',
  version: 1,
  cacheImpact: 'append-only',
  latency: 'inline',
  capabilities: 'relate',
  questions: {
    achieved: {
      type: 'boolean',
      instructions: 'Does `final_message` say that `goal` is fully achieved?',
    },
    needs_user: {
      type: 'boolean',
      instructions:
        'Does `final_message` ask the user for something the work cannot go on without?',
    },
  },
  buildState(input: GoalMetInput): JsonValue {
    return {
      goal: input.goal,
      final_message: input.finalMessage,
      open_acceptance_items: input.openItems,
      edited_without_running_anything: input.unverified,
    }
  },
  policy(answers, input): GoalMetOutcome {
    if (input.openItems > 0 || input.unverified) return 'continue'
    if (threeZone(answers.needs_user) === 'yes') return 'ask'
    return threeZone(answers.achieved) === 'yes' ? 'met' : 'continue'
  },
  fallback(input: GoalMetInput): GoalMetOutcome {
    return input.openItems > 0 || input.unverified ? 'continue' : 'unjudged'
  },
})

// INVARIANT: Registration entries for the context plane, including the auxiliary goal reading.
export const CONTEXT_MANIFEST: readonly DecisionPointManifest[] = [
  {
    id: 'context.forget',
    group: 'context',
    title: 'Active forgetting',
    titleZh: '陈旧结果遗忘',
    summary:
      'Judges whether an old tool result still earns its tokens; shrinking replaces it with a placeholder.',
    summaryZh: '判别陈旧工具结果是否仍值得保留全文，收缩时以占位符替换。',
    defaultMode: 'shadow',
    feature: 'decision.context',
  },
  {
    id: 'context.compact',
    group: 'context',
    title: 'Summary-free compaction',
    titleZh: '免摘要压缩',
    summary:
      'Scores old tool calls at compaction: what the output is and whether it must stay verbatim.',
    summaryZh: '压缩时逐个评估旧工具调用：输出类别与是否需要原文保留。',
    defaultMode: 'shadow',
    feature: 'decision.context',
  },
  {
    id: 'goal.met',
    group: 'context',
    title: 'Goal quick check',
    titleZh: '目标快速预判',
    summary:
      'Auxiliary goal-completion reading when enabled or when the structured verifier is unavailable; never bypasses delivery checks or budget gates.',
    summaryZh: '配置启用或结构化核验不可用时的辅助完成判别；绝不绕过未交付项检查与预算门禁。',
    defaultMode: 'shadow',
    feature: 'decision.context',
  },
]

export const CONTEXT_SPECS = {
  'context.forget': contextForgetSpec,
  'context.compact': contextCompactSpec,
  'goal.met': goalMetSpec,
} as const
