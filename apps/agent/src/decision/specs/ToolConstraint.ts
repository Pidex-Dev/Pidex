import type { DecisionQuestions } from '@pidex/shared/decision'
import { defineDecision } from '../DecisionSpec'
import { threeZone } from '../DecisionPolicy'

/** Constraint check for a side-effecting call. `constraints` must be user-confirmed hard limits only. */
export interface ToolConstraintInput {
  readonly toolName: string
  /** What the call would do: a command, or a path and the start of the new text. */
  readonly call: string
  /** The user's own sentences, verbatim, confirmed in this conversation. */
  readonly constraints: readonly string[]
}

export type ToolConstraintOutcome = {
  /** Indexes into `constraints` that this call goes against. Empty means no violation found. */
  readonly broken: readonly number[]
}

const CONSTRAINT_LENGTH = 300

export const constraintQuestionId = (index: number): string => `constraint_${index}`

/**
 * One yes/no per confirmed hard constraint before a call that changes
 * something. Only a confident yes counts as a violation; no verdict lets the
 * call through to the normal permission chain, so a judge outage never freezes
 * the agent.
 * INVARIANT: this decision can only narrow what the permission chain already
 * allows; it never grants, and command text or tool output are never read as
 * user constraints.
 */
export const toolConstraintSpec = defineDecision({
  id: 'tool.constraint',
  version: 1,
  cacheImpact: 'none',
  latency: 'inline',
  capabilities: 'relate',
  questions: {} as DecisionQuestions,
  questionsFor(input: ToolConstraintInput): DecisionQuestions {
    return Object.fromEntries(
      input.constraints.map((constraint, index) => [
        constraintQuestionId(index),
        {
          type: 'boolean' as const,
          instructions: `Does \`tool_call\` go against this instruction from the user? "${constraint.slice(0, CONSTRAINT_LENGTH)}"`,
        },
      ]),
    )
  },
  // SAFETY: the state holds only the untrusted call; the user's constraints live in the questions.
  buildState(input: ToolConstraintInput) {
    return { tool_call: `${input.toolName}: ${input.call}` }
  },
  policy(answers, input): ToolConstraintOutcome {
    const broken: number[] = []
    input.constraints.forEach((_constraint, index) => {
      const answer = answers[constraintQuestionId(index)]
      if (answer?.type === 'boolean' && threeZone(answer) === 'yes') broken.push(index)
    })
    return { broken }
  },
  fallback(): ToolConstraintOutcome {
    return { broken: [] }
  },
})
