import { defineDecision } from '../DecisionSpec'
import { threeZone } from '../DecisionPolicy'

/** Turn-end input. `userMessage` is the host-recorded real user request for this message. */
export interface TurnContinueInput {
  readonly userMessage: string
  readonly finalMessage: string
}

export type TurnContinueOutcome = 'end' | 'promised' | 'go_ahead'

/**
 * Detects a run that ended on a message making no tool call and not finishing
 * the work: a promise to act next, or asking for a go-ahead on work the user
 * already requested. A step that is hard to undo or reaches beyond this
 * machine (delete, push, deploy, publish, send, pay) is never pushed through.
 * INVARIANT: only the caller's per-user-message budget and Goal-settlement
 * check decide whether a verdict becomes a continuation; the spec itself never
 * authorizes an action.
 */
export const turnContinueSpec = defineDecision({
  id: 'turn.continue',
  version: 1,
  cacheImpact: 'append-only',
  latency: 'inline',
  capabilities: {
    promised: 'intent',
    asks_go_ahead: 'intent',
    work_requested: 'meta',
    beyond_request: 'relate',
    irreversible: 'meta',
  },
  questions: {
    promised: {
      type: 'boolean',
      instructions:
        'Does `final_message` say the assistant will now act, continue working, or call a tool, and then end without doing so?',
      criteria: {
        true: 'Like:\n- "I should do the same for the JS worker. Doing that now."\n- "Let me run the tests next."\n- "I\'ll fix that now."',
        false:
          'Like:\n- "I\'ve completed the task."\n- "The fix is done and tests pass."\n- "Is there anything else I can help with?"',
      },
    },
    asks_go_ahead: {
      type: 'boolean',
      instructions:
        'Does `final_message` end by asking whether the assistant should go ahead with a change or a task?',
    },
    work_requested: {
      type: 'boolean',
      instructions:
        'Does `user_message` ask the assistant to make a change or carry out a task, not only to explain, answer or propose?',
    },
    beyond_request: {
      type: 'boolean',
      instructions:
        'Is what `final_message` offers or asks about more than `user_message` asked for?',
    },
    irreversible: {
      type: 'boolean',
      instructions:
        'Is the next step `final_message` names hard to undo, or does it reach beyond this machine (push, deploy, publish, send, delete, pay)?',
    },
  },
  buildState(input: TurnContinueInput) {
    return { user_message: input.userMessage, final_message: input.finalMessage }
  },
  policy(answers): TurnContinueOutcome {
    // SAFETY: a pause before a step that cannot be taken back is the one the user wants, whatever else was said.
    if (threeZone(answers.irreversible) !== 'no') return 'end'
    if (threeZone(answers.promised) === 'yes') return 'promised'
    if (
      threeZone(answers.asks_go_ahead) === 'yes' &&
      threeZone(answers.work_requested) === 'yes' &&
      threeZone(answers.beyond_request) === 'no'
    ) {
      return 'go_ahead'
    }
    return 'end'
  },
  fallback(): TurnContinueOutcome {
    return 'end'
  },
})
