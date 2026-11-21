import type {
  DecisionAnswer,
  DecisionQuestion,
  JudgeErrorKind,
  JudgeInput,
} from '@pidex/shared/decision'
import { JudgeError } from '../DecisionErrors'
import type { JudgeProvider, JudgeRequest, ProviderResponse } from '../Judge'
import { judgeInputText, MAX_ERROR_MESSAGE_LENGTH } from './HttpShared'

export type ClassifierWireQuestion =
  | { type: 'bool'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }

export type ClassifierWireAnswer =
  | { type: 'bool'; probability: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number }

/** One classification, as the host reports it; failures are in it, never thrown. */
export interface ClassifierOutcome {
  readonly answers: Readonly<Record<string, ClassifierWireAnswer>>
  readonly usage?: { readonly input: number; readonly output: number } | undefined
  readonly stopReason: 'stop' | 'error' | 'aborted'
  readonly errorMessage?: string | undefined
}

export type ClassifierCall = (request: {
  readonly state: JudgeInput
  readonly questions: Readonly<Record<string, ClassifierWireQuestion>>
  readonly signal?: AbortSignal | undefined
}) => Promise<ClassifierOutcome>

function toWire(question: DecisionQuestion): ClassifierWireQuestion {
  const instructions = judgeInputText(question.instructions)
  if (question.type === 'choice') {
    return {
      type: 'choice',
      instructions,
      criteria: Object.fromEntries(
        Object.entries(question.criteria).map(([key, value]) => [key, judgeInputText(value)]),
      ),
    }
  }
  if (question.type === 'score')
    return { type: 'score', instructions, criteria: question.criteria.map(judgeInputText) }
  return question.criteria
    ? {
        type: 'bool',
        instructions,
        criteria: {
          true: judgeInputText(question.criteria.true),
          false: judgeInputText(question.criteria.false),
        },
      }
    : { type: 'bool', instructions }
}

function fromWire(
  question: DecisionQuestion,
  answer: ClassifierWireAnswer | undefined,
): DecisionAnswer | undefined {
  if (!answer) return undefined
  if (question.type === 'boolean') {
    return answer.type === 'bool' ? { type: 'boolean', probability: answer.probability } : undefined
  }
  if (question.type === 'score') {
    return answer.type === 'score'
      ? { type: 'score', score: answer.score, confidence: answer.confidence }
      : undefined
  }
  if (answer.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice)) return undefined
  return {
    type: 'choice',
    choice: answer.choice,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
  }
}

// INVARIANT: pi-ai reports failures as words; map them to a stable JudgeErrorKind.
function kindOf(message: string): JudgeErrorKind {
  if (/no api key|no credentials|not configured/i.test(message)) return 'auth'
  if (/\b402\b/.test(message)) return 'payment_required'
  if (/\b403\b/.test(message))
    return /credit|payment|billing|quota/i.test(message) ? 'payment_required' : 'auth'
  if (/\b401\b|unauthori[sz]ed/i.test(message)) return 'auth'
  if (/\b429\b|rate.?limit/i.test(message)) return 'rate_limited'
  if (/\b5\d\d\b/.test(message)) return 'server'
  if (/\b4\d\d\b/.test(message)) return 'bad_request'
  if (/timed out/i.test(message)) return 'timeout'
  if (/did not return|invalid|unexpected response/i.test(message)) return 'invalid_response'
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(message)) return 'unreachable'
  return 'server'
}

/**
 * A classifier model from the host's catalog as a judge: System One models and
 * llama.cpp classify endpoints reached through pi-ai with the host's credentials.
 */
export class ClassifierJudgeProvider implements JudgeProvider {
  readonly id: string
  private readonly call: ClassifierCall

  constructor(options: { model: string; call: ClassifierCall }) {
    this.id = `classifier:${options.model}`
    this.call = options.call
  }

  async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [id, toWire(question)]),
    )
    const outcome = await this.call({ state: request.state, questions, signal: request.signal })
    if (outcome.stopReason === 'aborted') {
      const aborted = new Error('The classification was aborted')
      aborted.name = 'AbortError'
      throw aborted
    }
    if (outcome.stopReason === 'error') {
      const message = (outcome.errorMessage ?? 'The classifier call failed').slice(
        0,
        MAX_ERROR_MESSAGE_LENGTH,
      )
      throw new JudgeError(kindOf(message), message)
    }
    const answers: Record<string, DecisionAnswer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = fromWire(question, outcome.answers[id])
      if (!answer)
        throw new JudgeError('invalid_response', `${this.id} gave no usable answer for "${id}"`)
      answers[id] = answer
    }
    return {
      answers,
      usage: outcome.usage
        ? { inputTokens: outcome.usage.input, outputTokens: outcome.usage.output }
        : undefined,
      modelId: this.id.slice('classifier:'.length),
    }
  }
}
