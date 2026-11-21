import { defineDecision } from '../DecisionSpec'
import { threeZone } from '../DecisionPolicy'

/** Completion-gate input; the edit and verification counts are host facts, not model claims. */
export interface TurnCompletionInput {
  readonly userMessage: string
  readonly finalMessage: string
  readonly editedFiles: number
  /** True when a test, build or type check ran after the last code edit this turn. */
  readonly ranVerificationAfterLastEdit: boolean
}

export type TurnCompletionOutcome = 'done' | 'nudge'

/**
 * Whether files were edited and whether verification ran afterwards are facts
 * the host already has; the judge only reads the closing message and the
 * nature of the request. A nudge asks the model to verify once, at most one
 * per turn, enforced by the caller.
 */
export const turnCompletionSpec = defineDecision({
  id: 'turn.completion',
  version: 1,
  cacheImpact: 'append-only',
  latency: 'inline',
  capabilities: { claims_done: 'intent', needs_check: 'meta' },
  questions: {
    claims_done: {
      type: 'boolean',
      instructions: 'Does `final_message` say the work is finished?',
    },
    needs_check: {
      type: 'boolean',
      instructions:
        'Should the change asked for in `user_message` be checked by running it (tests, build or type check)?',
    },
  },
  buildState(input: TurnCompletionInput) {
    return {
      final_message: input.finalMessage,
      user_message: input.userMessage,
      edited_files: input.editedFiles,
      ran_verification_after_last_edit: input.ranVerificationAfterLastEdit,
    }
  },
  policy(answers, input): TurnCompletionOutcome {
    if (threeZone(answers.claims_done) !== 'yes') return 'done'
    if (input.editedFiles === 0 || input.ranVerificationAfterLastEdit) return 'done'
    return threeZone(answers.needs_check) === 'yes' ? 'nudge' : 'done'
  },
  fallback(): TurnCompletionOutcome {
    return 'done'
  },
})