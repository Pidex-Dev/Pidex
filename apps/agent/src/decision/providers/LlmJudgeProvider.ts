import type { DecisionAnswer, DecisionQuestion } from '@pidex/shared/decision'
import { JudgeError } from '../DecisionErrors'
import type { JudgeProvider, JudgeRequest, ProviderResponse } from '../Judge'

export interface LlmCompletionRequest {
  readonly system: string
  readonly user: string
  readonly signal?: AbortSignal | undefined
}

export interface LlmCompletionResult {
  readonly text: string
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
}

/** The host supplies the model call, so the provider stays free of any model SDK. */
export type LlmCompletion = (request: LlmCompletionRequest) => Promise<LlmCompletionResult>

const SYSTEM_PROMPT = `You are a judgment function inside a coding agent harness. You read STATE and answer typed QUESTIONS about it. You never explain.

Answer formats, by question type:
- boolean: {"p": <number>}  probability in [0,1] that the statement is true. Use the whole range; 0.5 means the state does not say.
- choice:  {"choice": "<one option name>", "p": <number>}  p is the probability that this option is the right one.
- score:   {"score": <number>}  position on the rubric from 0 (first level) to N-1 (last level). Fractions are allowed.

Judge only from STATE. Answer every question id. Reply with exactly one JSON object and nothing else:
{"answers": {"<question id>": {...}}}`

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

function renderQuestion(question: DecisionQuestion): Record<string, unknown> {
  if (question.type === 'choice') {
    return { type: 'choice', instructions: question.instructions, options: question.criteria }
  }
  if (question.type === 'score') {
    return { type: 'score', instructions: question.instructions, levels: question.criteria }
  }
  return question.criteria
    ? { type: 'boolean', instructions: question.instructions, meaning: question.criteria }
    : { type: 'boolean', instructions: question.instructions }
}

function toAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (question.type === 'boolean') {
    return typeof record.p === 'number' ? { type: 'boolean', probability: clamp(record.p, 0, 1) } : undefined
  }
  if (question.type === 'score') {
    if (typeof record.score !== 'number') return undefined
    return { type: 'score', score: clamp(record.score, 0, question.criteria.length - 1) }
  }
  const options = Object.keys(question.criteria)
  if (typeof record.choice !== 'string' || !options.includes(record.choice)) return undefined
  const picked = typeof record.p === 'number' ? clamp(record.p, 0, 1) : 1
  const rest = options.length > 1 ? (1 - picked) / (options.length - 1) : 0
  const probabilities = Object.fromEntries(
    options.map((option) => [option, option === record.choice ? picked : rest]),
  )
  return { type: 'choice', choice: record.choice, probabilities }
}

// INVARIANT: parse the outermost JSON object; replies may be wrapped in prose or a code fence.
function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * Any generative model as a zero-shot judge: slower and costlier than a System
 * One model, with verbalized probabilities, but strong enough to be the
 * escalation tier behind a small local judge.
 */
export class LlmJudgeProvider implements JudgeProvider {
  readonly id: string
  private readonly complete: LlmCompletion

  constructor(options: { id: string; complete: LlmCompletion }) {
    this.id = options.id
    this.complete = options.complete
  }

  async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [id, renderQuestion(question)]),
    )
    const state = typeof request.state === 'string' ? request.state : JSON.stringify(request.state, null, 1)

    let result: LlmCompletionResult
    try {
      result = await this.complete({
        system: SYSTEM_PROMPT,
        user: `STATE:\n${state}\n\nQUESTIONS:\n${JSON.stringify(questions, null, 1)}`,
        signal: request.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      if (error instanceof JudgeError) throw error
      throw new JudgeError('unreachable', 'The judge model call failed', { cause: error })
    }

    const parsed = extractJson(result.text)
    const rawAnswers =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).answers : undefined
    if (typeof rawAnswers !== 'object' || rawAnswers === null) {
      throw new JudgeError('invalid_response', 'The judge model did not reply with an answers object')
    }

    const answers: Record<string, DecisionAnswer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = toAnswer(question, (rawAnswers as Record<string, unknown>)[id])
      if (!answer) throw new JudgeError('invalid_response', `The judge model gave no usable answer for "${id}"`)
      answers[id] = answer
    }
    return {
      answers,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      modelId: this.id,
    }
  }
}