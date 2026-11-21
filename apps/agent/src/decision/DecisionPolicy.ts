import type {
  BooleanAnswer,
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionAnswer,
  DecisionQuestion,
  ScoreAnswer,
} from '@pidex/shared/decision'

/**
 * Policies turn probabilities into actions. The middle zone exists so a
 * wrong-but-confident reading is the only way a judge can cause harm: anything
 * it is unsure about falls through to the caller's default.
 */
export type DecisionVerdict = 'yes' | 'no' | 'unsure'

export const DEFAULT_YES_AT = 0.8
export const DEFAULT_NO_AT = 0.2

export function threeZone(
  answer: BooleanAnswer,
  yesAt = DEFAULT_YES_AT,
  noAt = DEFAULT_NO_AT,
): DecisionVerdict {
  if (noAt >= yesAt) throw new RangeError('Thresholds need noAt < yesAt')
  if (answer.probability >= yesAt) return 'yes'
  if (answer.probability <= noAt) return 'no'
  return 'unsure'
}

export type EscapeOption = 'none' | 'other' | 'unclear' | 'unknown'

export const ESCAPE_OPTIONS: readonly EscapeOption[] = ['none', 'other', 'unclear', 'unknown']

const ESCAPE_OPTION_SET: ReadonlySet<string> = new Set(ESCAPE_OPTIONS)

export const isEscapeOption = (option: string): option is EscapeOption =>
  ESCAPE_OPTION_SET.has(option)

export const hasEscapeOption = (question: ChoiceQuestion): boolean =>
  Object.keys(question.criteria).some(isEscapeOption)

/** The picked option, or undefined when it is an escape option or not probable enough. */
export function pickChoice(
  answer: ChoiceAnswer,
  options: { minProbability?: number } = {},
): string | undefined {
  if (isEscapeOption(answer.choice)) return undefined
  const probability = answer.probabilities?.[answer.choice]
  if (probability !== undefined && probability < (options.minProbability ?? 0.6)) return undefined
  return answer.choice
}

/** Nearest rubric level, zero-based. */
export const scoreLevel = (answer: ScoreAnswer): number => Math.round(answer.score)

/** Whether an answer is the neutral stand-in a cascade puts where no judge answered. */
export const isStandIn = (answer: { judge?: string } | undefined): boolean =>
  answer?.judge === 'untrusted' || answer?.judge === 'unavailable'

/** A maximally uncertain answer: every three-zone policy reads it as "unsure". */
export function neutralAnswer(question: DecisionQuestion): DecisionAnswer {
  if (question.type === 'boolean') return { type: 'boolean', probability: 0.5 }
  if (question.type === 'score') return { type: 'score', score: (question.criteria.length - 1) / 2 }
  const options = Object.keys(question.criteria)
  return { type: 'choice', choice: options.find(isEscapeOption) ?? options[0]! }
}
