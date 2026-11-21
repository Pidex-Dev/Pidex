import type { DecisionAnswer, JudgeUsage } from '@pidex/shared/decision'
import { JudgeError } from '../DecisionErrors'
import type { JudgeProvider, JudgeRequest, ProviderResponse } from '../Judge'
import {
  errorKindForStatus,
  isRecord,
  judgeInputText,
  numberOr,
  readErrorMessage,
  safeEndpointOf,
} from './HttpShared'

export const OPENAI_DECISIONS_BASE_URL = 'https://api.openai.com/v1'
export const OPENAI_DECISIONS_DEFAULT_MODEL = 'gpt-6-luna'

// INVARIANT: API limits per request are 1-400 questions, 2-255 choices, 2-10 score levels.
const LIMITS = { questions: [1, 400], choices: [2, 255], levels: [2, 10] } as const

/** The Decisions endpoint at `https://host`, `https://host/v1` or the endpoint itself. */
export function decisionsEndpoint(baseUrl: string | undefined): string {
  const url = (baseUrl || OPENAI_DECISIONS_BASE_URL).replace(/\/+$/, '')
  if (!URL.canParse(url)) return url
  const path = new URL(url).pathname
  if (path === '/') return `${url}/v1/decisions`
  return path.endsWith('/decisions') ? url : `${url}/decisions`
}

/** Whether an address is OpenAI's own (empty is): the only one the shared openai key goes to. */
export function isOpenAIAddress(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true
  if (!URL.canParse(baseUrl)) return false
  const url = new URL(baseUrl)
  return url.protocol === 'https:' && url.host === 'api.openai.com'
}

type WireQuestion =
  | { type: 'predicate'; name: string; instructions: string }
  | { type: 'choice'; name: string; instructions: string; choices: { value: string; description?: string }[] }
  | { type: 'score'; name: string; instructions: string; levels: { label: string }[] }

// INVARIANT: yes/no maps to predicate; criteria meanings go into the instructions.
function toDecisionsQuestion(name: string, question: JudgeRequest['questions'][string]): WireQuestion {
  const instructions = judgeInputText(question.instructions)
  if (question.type === 'choice') {
    return {
      type: 'choice',
      name,
      instructions,
      choices: Object.entries(question.criteria).map(([value, meaning]) => {
        const description = judgeInputText(meaning)
        return description ? { value, description } : { value }
      }),
    }
  }
  if (question.type === 'score') {
    return {
      type: 'score',
      name,
      instructions,
      levels: question.criteria.map((level, index) => ({ label: judgeInputText(level) || String(index) })),
    }
  }
  const meaning = [
    question.criteria?.true ? `True means: ${judgeInputText(question.criteria.true)}` : '',
    question.criteria?.false ? `False means: ${judgeInputText(question.criteria.false)}` : '',
  ].filter(Boolean)
  return {
    type: 'predicate',
    name,
    instructions: meaning.length > 0 ? `${instructions}\n\n${meaning.join('\n')}` : instructions,
  }
}

function distribution(value: unknown, keep: (key: string) => boolean): Record<string, number> | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: [string, number][] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const key =
      typeof item.value === 'number' || typeof item.value === 'string' ? String(item.value) : undefined
    const probability = numberOr(item.probability)
    if (key !== undefined && probability !== undefined && keep(key)) entries.push([key, probability])
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function fromDecisionsAnswer(
  question: JudgeRequest['questions'][string],
  raw: Record<string, unknown> | undefined,
): DecisionAnswer | undefined {
  if (!raw) return undefined
  const confidence = numberOr(raw.confidence)
  const signals = confidence !== undefined ? { confidence } : {}
  if (question.type === 'boolean') {
    const probability = numberOr(raw.probability)
    return raw.type === 'predicate' && probability !== undefined
      ? { type: 'boolean', probability, ...signals }
      : undefined
  }
  if (question.type === 'score') {
    const score = numberOr(raw.score)
    if (raw.type !== 'score' || score === undefined) return undefined
    const levels = question.criteria.length
    const probabilities = distribution(raw.probabilities, (key) => /^\d+$/.test(key) && Number(key) < levels)
    return { type: 'score', score, ...(probabilities ? { probabilities } : {}), ...signals }
  }
  if (raw.type !== 'choice' || typeof raw.choice !== 'string' || !Object.hasOwn(question.criteria, raw.choice))
    return undefined
  const probabilities = distribution(raw.probabilities, (key) => Object.hasOwn(question.criteria, key))
  return { type: 'choice', choice: raw.choice, ...(probabilities ? { probabilities } : {}), ...signals }
}

function overLimit(questions: readonly WireQuestion[]): string | undefined {
  const within = (count: number, [min, max]: readonly [number, number]) => count >= min && count <= max
  if (!within(questions.length, LIMITS.questions)) return `takes 1 to 400 questions, not ${questions.length}`
  for (const question of questions) {
    if (question.type === 'choice' && !within(question.choices.length, LIMITS.choices))
      return `takes 2 to 255 choices, not ${question.choices.length} for "${question.name}"`
    if (question.type === 'score' && !within(question.levels.length, LIMITS.levels))
      return `takes 2 to 10 levels, not ${question.levels.length} for "${question.name}"`
  }
  return undefined
}

interface DecisionsBody {
  model?: unknown
  answers?: unknown
  usage?: {
    input_tokens?: unknown
    output_tokens?: unknown
    input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown }
  }
}

function usageOf(body: DecisionsBody): JudgeUsage {
  const details = body.usage?.input_tokens_details
  const cached = numberOr(details?.cached_tokens)
  const written = numberOr(details?.cache_write_tokens)
  return {
    inputTokens: numberOr(body.usage?.input_tokens),
    outputTokens: numberOr(body.usage?.output_tokens) ?? 0,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(written !== undefined ? { cacheWriteTokens: written } : {}),
  }
}

/**
 * OpenAI's Decisions API (`POST /v1/decisions`). A refusal or missing answer
 * fails the call so the next tier or the fallback answers. Error messages name
 * the service at most, never the key or the submitted state.
 */
export class OpenAIDecisionsJudgeProvider implements JudgeProvider {
  readonly id: string
  private readonly apiKey: string | (() => Promise<string | undefined>)
  private readonly model: string
  private readonly baseUrl: string | (() => Promise<string | undefined>) | undefined
  private readonly fetchImpl: typeof fetch

  constructor(options: {
    apiKey: string | (() => Promise<string | undefined>)
    model?: string | undefined
    baseUrl?: string | (() => Promise<string | undefined>) | undefined
    idPrefix?: string | undefined
    fetch?: typeof fetch | undefined
  }) {
    this.apiKey = options.apiKey
    this.model = options.model || OPENAI_DECISIONS_DEFAULT_MODEL
    this.baseUrl = options.baseUrl
    this.fetchImpl = options.fetch ?? fetch
    const staticBase = typeof options.baseUrl === 'string' ? options.baseUrl : undefined
    const endpoint = decisionsEndpoint(staticBase)
    const host = URL.canParse(endpoint) ? new URL(endpoint).host : endpoint
    const service = isOpenAIAddress(staticBase) ? 'OpenAI' : host
    const prefix = options.idPrefix ?? (service === 'OpenAI' ? 'openai' : host)
    this.id = `${prefix}:${this.model}`
  }

  async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
    const resolvedBase = typeof this.baseUrl === 'function' ? await this.baseUrl() : this.baseUrl
    const endpoint = decisionsEndpoint(resolvedBase)
    const host = URL.canParse(endpoint) ? new URL(endpoint).host : endpoint
    const service = isOpenAIAddress(resolvedBase) ? 'OpenAI' : host

    const questions = Object.entries(request.questions).map(([id, question]) =>
      toDecisionsQuestion(id, question),
    )
    const limit = overLimit(questions)
    if (limit) throw new JudgeError('bad_request', `${service}'s Decisions API ${limit}`)
    const apiKey = typeof this.apiKey === 'string' ? this.apiKey : await this.apiKey()
    if (!apiKey) throw new JudgeError('auth', `No API key is configured for ${service}`)

    const safeEndpoint = safeEndpointOf(endpoint)
    const input = judgeInputText(request.state)
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input, questions }),
        signal: request.signal ?? null,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new JudgeError('unreachable', `Could not reach ${service}`, {
        endpoint: safeEndpoint,
        cause: error,
      })
    }

    if (!response.ok) {
      const message = await readErrorMessage(response, apiKey)
      throw new JudgeError(errorKindForStatus(response.status, message), message || `${service} responded with HTTP ${response.status}`, {
        status: response.status,
        endpoint: safeEndpoint,
      })
    }

    const body = (await response.json().catch(() => undefined)) as DecisionsBody | undefined
    if (!body || !Array.isArray(body.answers)) {
      throw new JudgeError('invalid_response', `${service} response has no answers`, {
        status: response.status,
        endpoint: safeEndpoint,
      })
    }
    const byName = new Map<string, Record<string, unknown>>()
    for (const item of body.answers) {
      if (isRecord(item) && typeof item.name === 'string') byName.set(item.name, item)
    }
    const answers: Record<string, DecisionAnswer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const raw = byName.get(id)
      const answer = fromDecisionsAnswer(question, raw)
      if (!answer) {
        const why = raw?.type === 'refusal' ? 'declined to answer' : 'gave no usable answer for'
        throw new JudgeError('invalid_response', `${service} ${why} "${id}"`)
      }
      answers[id] = answer
    }
    return {
      answers,
      usage: usageOf(body),
      modelId: typeof body.model === 'string' ? body.model : this.model,
    }
  }
}