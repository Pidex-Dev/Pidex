import { defineDecision } from '../DecisionSpec'
import { isEscapeOption } from '../DecisionPolicy'

/** Approval input for a call routed to auto-review. `userMessage` is host-recorded real user speech only. */
export interface ToolApprovalInput {
  /** The whole call, e.g. `exec_command: rm -rf dist` or `Write: {"file_path":...}`. */
  readonly call: string
  /** Where the call acts, said plainly: inside the workspace or which external target. */
  readonly where: string
  /** The task summary the host captured for this turn. */
  readonly task: string
  /** Host-recorded real user messages, scrubbed. */
  readonly userMessage: string
  /** The call only runs a check (test/build/typecheck/lint) inside the workspace. Not shown to the judge. */
  readonly check?: boolean
}

export type ToolApprovalOutcome = 'approve' | 'beyond' | 'unrelated' | 'unsure'

/** How sure the judge must be that a regular step is needed before it can run without the user. */
export const APPROVE_AT = 0.8
/** The same for an in-workspace check the task plainly needs. A "beyond"/"unrelated" verdict still asks. */
export const CHECK_APPROVE_AT = 0.7

/**
 * Auxiliary auto-review verdict: is this call a step the task needs, done the
 * way the user would expect?
 * INVARIANT: only a high-confidence `needed` (checks >= 0.7, regular >= 0.8) may
 * be adopted as an allow, and the caller must bind it to the action hash and
 * authorization version captured at review start. Everything else falls back
 * to the existing Guardian deep review or human approval.
 */
export const toolApprovalSpec = defineDecision({
  id: 'tool.approval',
  version: 1,
  cacheImpact: 'none',
  latency: 'inline',
  capabilities: 'relate',
  questions: {
    verdict: {
      type: 'choice',
      instructions: 'What is `tool_call`, for `task` and `user_message` (real messages from the human user)?',
      criteria: {
        needed: 'A step the task needs, done the way the user would expect',
        beyond:
          'More than the user asked for: it deletes, overwrites, installs, publishes, sends or spends something, or acts outside the workspace, without being asked to',
        unrelated: 'Not part of the task',
        unclear: 'Cannot tell from what is here',
      },
    },
  },
  // SAFETY: `tool_call` and `where` are untrusted facts; only `user_message` is authorization evidence.
  buildState(input: ToolApprovalInput) {
    return {
      tool_call: input.call,
      where: input.where,
      task: input.task,
      user_message: input.userMessage,
    }
  },
  policy(answers, input): ToolApprovalOutcome {
    const { choice, probabilities } = answers.verdict
    if (isEscapeOption(choice)) return 'unsure'
    const probability = probabilities?.[choice]
    if (choice === 'needed') {
      const line = input.check ? CHECK_APPROVE_AT : APPROVE_AT
      return probability === undefined || probability >= line ? 'approve' : 'unsure'
    }
    return choice === 'beyond' || choice === 'unrelated' ? choice : 'unsure'
  },
  fallback(): ToolApprovalOutcome {
    return 'unsure'
  },
})