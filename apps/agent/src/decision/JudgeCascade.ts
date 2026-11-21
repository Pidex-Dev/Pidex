import type {
  DecisionAnswer,
  DecisionCapability,
  DecisionQuestion,
  DecisionQuestions,
  JudgeTierReport,
  JudgeWarning,
} from '@pidex/shared/decision'
import { JudgeError, judgeErrorKindOf } from './DecisionErrors'
import { addUsage, validateQuestions, type JudgeCall, type JudgeLike, type JudgeResult, type MutableJudgeUsage } from './Judge'
import { DEFAULT_NO_AT, DEFAULT_YES_AT, neutralAnswer } from './DecisionPolicy'

/**
 * What a judge is trusted on, per model and measured rather than assumed: a
 * small classifier can read one text well and still answer "yes" to nearly
 * every relational question. Over-confidence is the one failure a cascade
 * cannot see in the probabilities, so it must be declared here.
 */
export interface JudgeProfile {
  readonly capabilities?: Partial<Record<DecisionCapability, boolean>> | undefined
  readonly yesAt?: number | undefined
  readonly noAt?: number | undefined
  readonly minChoiceProbability?: number | undefined
}

/** Ordinal rubrics need `rate`; everything else defaults to `classify`. */
export const capabilityOf = (
  question: DecisionQuestion,
  declared?: DecisionCapability,
): DecisionCapability => declared ?? (question.type === 'score' ? 'rate' : 'classify')

export const isTrusted = (profile: JudgeProfile | undefined, capability: DecisionCapability): boolean =>
  profile?.capabilities?.[capability] !== false

export interface CascadeTier {
  readonly judge: JudgeLike
  readonly profile?: JudgeProfile | undefined
}

export function isUncertain(
  answer: DecisionAnswer,
  profile: JudgeProfile = {},
): boolean {
  if (answer.type === 'boolean') {
    const noAt = profile.noAt ?? DEFAULT_NO_AT
    const yesAt = profile.yesAt ?? DEFAULT_YES_AT
    return answer.probability > noAt && answer.probability < yesAt
  }
  if (answer.type === 'choice') {
    const probability = answer.probabilities?.[answer.choice]
    return probability !== undefined && probability < (profile.minChoiceProbability ?? 0.6)
  }
  return false
}

/**
 * Judges in order of cost: each tier only sees the questions the previous tier
 * could not settle, so the expensive judge is paid for the grey zone alone. A
 * failed tier is skipped; an uncertain answer beats none and is kept when every
 * later tier fails too. A question no tier is trusted on gets a neutral answer,
 * which every policy reads as "unsure".
 */
export class CascadeJudge implements JudgeLike {
  readonly id: string
  private readonly tiers: readonly CascadeTier[]

  constructor(tiers: readonly CascadeTier[]) {
    if (tiers.length === 0) throw new TypeError('A cascade needs at least one judge')
    this.tiers = tiers
    this.id =
      tiers.length === 1 ? tiers[0]!.judge.id : `cascade(${tiers.map((tier) => tier.judge.id).join('>')})`
  }

  trusts(capability: DecisionCapability): boolean {
    return this.tiers.some((tier) => isTrusted(tier.profile, capability))
  }

  async evaluate(request: JudgeCall): Promise<JudgeResult> {
    validateQuestions(request.questions)
    const startedAt = performance.now()
    const settled: Record<string, DecisionAnswer> = {}
    const tentative: Record<string, DecisionAnswer> = {}
    const usage: MutableJudgeUsage = { inputTokens: 0, outputTokens: 0 }
    const warnings: JudgeWarning[] = []
    const reports: JudgeTierReport[] = []
    let requests = 0
    let modelId: string | undefined
    const errors: unknown[] = []
    let pending: string[] = Object.keys(request.questions)

    const capability = (id: string) =>
      capabilityOf(request.questions[id]!, request.capabilities?.[id])

    for (const [index, tier] of this.tiers.entries()) {
      if (pending.length === 0) break
      if (request.signal?.aborted) throw new JudgeError('aborted', 'Judge call was aborted')
      const isLast = index === this.tiers.length - 1
      const mine = pending.filter((id) => isTrusted(tier.profile, capability(id)))
      if (mine.length === 0) continue
      const questions: DecisionQuestions = Object.fromEntries(
        mine.map((id) => [id, request.questions[id]!]),
      )
      const others = pending.filter((id) => !mine.includes(id))

      let result: JudgeResult
      try {
        result = await tier.judge.evaluate({ state: request.state, questions, signal: request.signal })
      } catch (error) {
        errors.push(error)
        reports.push({ judgeId: tier.judge.id, asked: mine.length, kept: 0, error: judgeErrorKindOf(error) })
        continue
      }

      requests += result.requests
      addUsage(usage, result.usage)
      warnings.push(...result.warnings)
      modelId ??= result.modelId

      const stillPending: string[] = [...others]
      let kept = 0
      for (const id of mine) {
        const answer: DecisionAnswer = { ...result.answers[id]!, judge: tier.judge.id }
        if (!isLast && isUncertain(answer, tier.profile)) {
          tentative[id] = answer
          stillPending.push(id)
        } else {
          settled[id] = answer
          kept += 1
        }
      }
      reports.push({ judgeId: tier.judge.id, asked: mine.length, kept, latencyMs: result.latencyMs })
      pending = stillPending
    }

    const trustedSomewhere = (id: string) =>
      this.tiers.some((tier) => isTrusted(tier.profile, capability(id)))
    for (const id of pending) {
      if (tentative[id]) settled[id] = tentative[id]!
      else if (!trustedSomewhere(id))
        settled[id] = { ...neutralAnswer(request.questions[id]!), judge: 'untrusted' }
    }
    const missing = Object.keys(request.questions).filter((id) => !(id in settled))
    if (missing.length > 0) {
      if (reports.length > 0 && reports.every((report) => report.error !== undefined)) {
        const lasting = (error: unknown) =>
          error instanceof JudgeError && (error.kind === 'auth' || error.kind === 'payment_required')
        const telling = [...errors].reverse().find((error) => !lasting(error)) ?? errors.at(-1)
        if (telling instanceof JudgeError) throw telling
        throw new JudgeError('unreachable', 'No judge in the cascade answered', { cause: telling })
      }
      for (const id of missing)
        settled[id] = { ...neutralAnswer(request.questions[id]!), judge: 'unavailable' }
    }

    return {
      answers: settled,
      usage,
      latencyMs: Math.round(performance.now() - startedAt),
      requests,
      providerId: this.id,
      modelId,
      warnings,
      tiers: reports,
    }
  }
}