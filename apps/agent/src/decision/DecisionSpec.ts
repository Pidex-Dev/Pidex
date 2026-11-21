import { createHash } from 'node:crypto'
import type {
  BooleanAnswer,
  ChoiceAnswer,
  DecisionCapability,
  DecisionQuestions,
  JudgeInput,
  ScoreAnswer,
} from '@pidex/shared/decision'
import { hasEscapeOption } from './DecisionPolicy'
import { validateQuestions } from './Judge'

export const ABSTAIN: unique symbol = Symbol('pidex.decision.abstain')
export type Abstain = typeof ABSTAIN

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export type AnswerFor<Q extends DecisionQuestions[string]> = Q extends { type: 'choice' }
  ? ChoiceAnswer
  : Q extends { type: 'score' }
    ? ScoreAnswer
    : BooleanAnswer

export type AnswersFor<Qs extends DecisionQuestions> = {
  readonly [Id in keyof Qs]: AnswerFor<Qs[Id]>
}

/**
 * A decision point: typed questions over a digested state, a policy that acts on
 * the answers, and a deterministic fallback equal to the host's behavior without
 * a judge. Bump `version` whenever question wording or policy changes so ledger
 * records stay comparable.
 */
export interface DecisionSpec<In, Qs extends DecisionQuestions, Out extends JsonValue> {
  readonly id: string
  readonly version: number
  readonly questions: Qs
  readonly questionsFor?: ((input: In) => DecisionQuestions) | undefined
  readonly capabilities?:
    DecisionCapability | Readonly<Partial<Record<string, DecisionCapability>>> | undefined
  readonly cacheImpact: 'none' | 'append-only' | 'prefix-mutating'
  readonly latency: 'inline' | 'parallel' | 'background'
  readonly allowChoicesWithoutEscape?: boolean | undefined
  readonly actsInShadow?: boolean | undefined
  buildState(input: In): JudgeInput
  policy(answers: AnswersFor<Qs>, input: In): Out | Abstain
  fallback(input: In): Out
}

export function defineDecision<In, const Qs extends DecisionQuestions, Out extends JsonValue>(
  spec: DecisionSpec<In, Qs, Out>,
): DecisionSpec<In, Qs, Out> {
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    throw new TypeError(`Decision "${spec.id}" needs a positive integer version`)
  }
  if (!spec.questionsFor) validateQuestions(spec.questions)
  if (!spec.allowChoicesWithoutEscape) {
    for (const [questionId, question] of Object.entries(spec.questions)) {
      if (question.type === 'choice' && !hasEscapeOption(question)) {
        throw new TypeError(
          `Choice question "${questionId}" in decision "${spec.id}" has no escape option (none, other, unclear, unknown)`,
        )
      }
    }
  }
  for (const question of Object.values(spec.questions)) {
    if (question.type === 'score' && question.criteria.length < 2) {
      throw new TypeError(`Score question in decision "${spec.id}" needs at least two levels`)
    }
  }
  return spec
}

/** A state's digest in the ledger: SHA-256 of its JSON, as the decision built it. */
export const digestOf = (state: unknown): string =>
  createHash('sha256').update(JSON.stringify(state)).digest('hex')
