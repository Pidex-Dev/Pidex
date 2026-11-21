import type { DecisionService } from '../DecisionService'
import type { Decision } from '../DecisionEngine'
import {
  prEventTriageSpec,
  type PrEventTriageInput,
  type PrEventTriageRoute,
} from '../specs/PrEventTriage'
import { screenExternalContent } from './ToolOutputDecisionAdapter'

const PR_TRIAGE_TIMEOUT_MS = 10_000

/** Runs `pr.event_triage` before waking a full repair turn for a watched PR update. */
export async function triagePrWatchEvent(
  decisions: DecisionService | null | undefined,
  input: PrEventTriageInput & { threadId?: string | undefined },
  options: { signal?: AbortSignal | undefined; cwd?: string | undefined } = {},
): Promise<Decision<PrEventTriageRoute> | null> {
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return null
  if (engine.getMode(prEventTriageSpec.id) === 'off') return null
  const timeoutSignal = AbortSignal.timeout(PR_TRIAGE_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  return engine
    .decide(
      prEventTriageSpec,
      {
        prUrl: input.prUrl,
        headSha: input.headSha,
        hasFailedChecks: input.hasFailedChecks,
        failedChecks: input.failedChecks,
        changeRequests: input.changeRequests,
        userInstructions: input.userInstructions,
      },
      {
        signal,
        ...(input.threadId ? { origin: { threadId: input.threadId } } : {}),
      },
    )
    .catch(() => null)
}

/** Screens untrusted PR review bodies through `tool.injection` before embedding them in a repair prompt. */
export async function screenPrReviews<T extends { readonly body: string }>(
  decisions: DecisionService | null | undefined,
  reviews: readonly T[],
  options: {
    threadId: string
    cwd?: string | undefined
    signal?: AbortSignal | undefined
  },
): Promise<T[]> {
  if (!decisions || reviews.length === 0) return [...reviews]
  const out: T[] = []
  for (const review of reviews) {
    if (!review.body.trim()) {
      out.push(review)
      continue
    }
    const screened = await screenExternalContent(
      decisions,
      {
        threadId: options.threadId,
        source: 'pr_watch:review',
        text: review.body,
      },
      { signal: options.signal, cwd: options.cwd },
    )
    out.push(screened.withheld > 0 ? { ...review, body: screened.text } : review)
  }
  return out
}
