import type {
  DecisionAnswer,
  DecisionCapability,
  DecisionQuestions,
  JudgeInput,
  JudgeTierReport,
  JudgeUsage,
  JudgeWarning,
} from '@pidex/shared/decision'
import { JudgeError } from './DecisionErrors'

export interface JudgeRequest {
  readonly state: JudgeInput
  readonly questions: DecisionQuestions
  readonly signal?: AbortSignal | undefined
}

export interface ProviderResponse {
  readonly answers: Readonly<Record<string, DecisionAnswer>>
  readonly usage?: JudgeUsage | undefined
  readonly modelId?: string | undefined
  readonly warnings?: readonly JudgeWarning[] | undefined
}

/**
 * A backend that answers typed questions about one shared state. Implementations
 * throw `JudgeError` and must not retry: the kernel owns timeouts and fail-open.
 */
export interface JudgeProvider {
  readonly id: string
  evaluate(request: JudgeRequest): Promise<ProviderResponse>
}

export interface JudgeCall {
  readonly state: JudgeInput
  readonly questions: DecisionQuestions
  readonly signal?: AbortSignal | undefined
  readonly capabilities?: Readonly<Record<string, DecisionCapability>> | undefined
}

export interface JudgeResult {
  readonly answers: Readonly<Record<string, DecisionAnswer>>
  readonly usage: JudgeUsage
  readonly latencyMs: number
  readonly requests: number
  readonly providerId: string
  readonly modelId?: string | undefined
  readonly warnings: readonly JudgeWarning[]
  readonly tiers?: readonly JudgeTierReport[] | undefined
}

/** Anything that answers typed questions: one provider behind a timeout, or a cascade. */
export interface JudgeLike {
  readonly id: string
  evaluate(request: JudgeCall): Promise<JudgeResult>
}

export function validateQuestions(questions: DecisionQuestions): void {
  const ids = Object.keys(questions)
  if (ids.length === 0) throw new TypeError('A judge request needs at least one question')
  for (const id of ids) {
    const question = questions[id]!
    if (question.type === 'choice' && Object.keys(question.criteria).length === 0) {
      throw new TypeError(`Choice question "${id}" has no options`)
    }
    if (question.type === 'score' && question.criteria.length < 2) {
      throw new TypeError(`Score question "${id}" needs at least two levels`)
    }
  }
}

/** Mutable accumulator; the shared wire type stays readonly. */
export type MutableJudgeUsage = {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
}

/** Adds `part` to `total`; cache counts appear only once a provider reports them. */
export function addUsage(total: MutableJudgeUsage, part: JudgeUsage | undefined): void {
  total.inputTokens = (total.inputTokens ?? 0) + (part?.inputTokens ?? 0)
  total.outputTokens = (total.outputTokens ?? 0) + (part?.outputTokens ?? 0)
  if (part?.cachedInputTokens !== undefined)
    total.cachedInputTokens = (total.cachedInputTokens ?? 0) + part.cachedInputTokens
  if (part?.cacheWriteTokens !== undefined)
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + part.cacheWriteTokens
}

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

function withOwnProbabilities(
  question: DecisionQuestions[string],
  answer: DecisionAnswer,
): DecisionAnswer {
  if (answer.type !== 'choice' || question.type !== 'choice' || !answer.probabilities) return answer
  const own = Object.entries(answer.probabilities).filter(
    ([option, probability]) => Object.hasOwn(question.criteria, option) && isProbability(probability),
  )
  if (own.length === Object.keys(answer.probabilities).length) return answer
  return { ...answer, probabilities: own.length > 0 ? Object.fromEntries(own) : undefined }
}

function answerProblem(
  question: DecisionQuestions[string],
  answer: DecisionAnswer | undefined,
): string | undefined {
  if (!answer) return 'is missing'
  if (answer.type !== question.type) return `has type "${answer.type}", expected "${question.type}"`
  if (answer.type === 'boolean')
    return isProbability(answer.probability) ? undefined : 'has an invalid probability'
  if (answer.type === 'choice' && question.type === 'choice') {
    return Object.hasOwn(question.criteria, answer.choice)
      ? undefined
      : `picked unknown option "${answer.choice}"`
  }
  if (answer.type === 'score' && question.type === 'score') {
    const max = question.criteria.length - 1
    const inRange = Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= max
    return inRange ? undefined : `has score ${answer.score} outside [0, ${max}]`
  }
  return undefined
}

const DEFAULT_TIMEOUT_MS = 4_000
const DEFAULT_MAX_QUESTIONS_PER_REQUEST = 32

/**
 * One judge provider behind a hard timeout, with request fan-out and answer
 * validation. Throws `JudgeError`; `DecisionEngine` turns those into fallbacks.
 */
export class Judge implements JudgeLike {
  readonly provider: JudgeProvider
  private readonly timeoutMs: number
  private readonly maxQuestionsPerRequest: number

  get id(): string {
    return this.provider.id
  }

  constructor(options: {
    provider: JudgeProvider
    timeoutMs?: number | undefined
    maxQuestionsPerRequest?: number | undefined
  }) {
    this.provider = options.provider
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxQuestionsPerRequest = options.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS_PER_REQUEST
  }

  async evaluate(request: JudgeCall): Promise<JudgeResult> {
    validateQuestions(request.questions)
    const ids = Object.keys(request.questions)
    const chunks: DecisionQuestions[] = []
    for (let start = 0; start < ids.length; start += this.maxQuestionsPerRequest) {
      const chunkIds = ids.slice(start, start + this.maxQuestionsPerRequest)
      chunks.push(Object.fromEntries(chunkIds.map((id) => [id, request.questions[id]!])))
    }

    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout
    const startedAt = performance.now()

    let responses: ProviderResponse[]
    try {
      const requests = Promise.all(
        chunks.map((questions) => this.provider.evaluate({ state: request.state, questions, signal })),
      )
      // SAFETY: race provider work so a broken AbortSignal implementation still fails open at the deadline.
      const deadline = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new JudgeError('timeout', `Judge call exceeded ${this.timeoutMs} ms`)),
          this.timeoutMs,
        )
        requests.finally(() => clearTimeout(timer)).catch(() => undefined)
      })
      responses = await Promise.race([requests, deadline])
    } catch (error) {
      if (request.signal?.aborted)
        throw new JudgeError('aborted', 'Judge call was aborted', { cause: error })
      if (timeout.aborted)
        throw new JudgeError('timeout', `Judge call exceeded ${this.timeoutMs} ms`, { cause: error })
      if (error instanceof JudgeError) throw error
      throw new JudgeError('unreachable', 'Judge provider failed', { cause: error })
    }

    const answers: Record<string, DecisionAnswer> = {}
    const usage: MutableJudgeUsage = { inputTokens: 0, outputTokens: 0 }
    const warnings: JudgeWarning[] = []
    for (const response of responses) {
      Object.assign(answers, response.answers)
      if (response.warnings) warnings.push(...response.warnings)
      addUsage(usage, response.usage)
    }
    for (const id of ids) {
      const problem = answerProblem(request.questions[id]!, answers[id])
      if (problem) throw new JudgeError('invalid_response', `Answer for "${id}" ${problem}`)
      answers[id] = withOwnProbabilities(request.questions[id]!, answers[id]!)
    }

    return {
      answers,
      usage,
      latencyMs: Math.round(performance.now() - startedAt),
      requests: chunks.length,
      providerId: this.provider.id,
      modelId: responses.find((response) => response.modelId)?.modelId,
      warnings,
    }
  }
}