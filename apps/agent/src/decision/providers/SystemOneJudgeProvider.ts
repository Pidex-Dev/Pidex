import type { DecisionAnswer, DecisionQuestion } from '@pidex/shared/decision'
import { JudgeError } from '../DecisionErrors'
import type { JudgeProvider, JudgeRequest, ProviderResponse } from '../Judge'
import {
  errorKindForStatus,
  isRecord,
  numberOr,
  readErrorMessage,
  readWarnings,
  safeEndpointOf,
} from './HttpShared'

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai/v1/systemone'
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest'
export const SYSTEMONE_BASE_URL = 'http://127.0.0.1:8700'
export const SYSTEMONE_DEFAULT_MODEL = 'clm-latest'

/** A System One endpoint written as `http://host:8700`, `…/v1` or the full path. */
export function systemOneEndpoint(baseUrl: string | undefined): string {
  const url = (baseUrl || SYSTEMONE_BASE_URL).replace(/\/+$/, '')
  if (!URL.canParse(url)) return url
  const path = new URL(url).pathname
  return path === '/'
    ? `${url}/v1/systemone`
    : path === '/v1' || path.endsWith('/v1')
      ? `${url}/systemone`
      : url
}

/** Loopback endpoints may be called without a key; anything else must present one. */
export function isLoopbackAddress(baseUrl: string): boolean {
  if (!URL.canParse(baseUrl)) return false
  const host = new URL(baseUrl).hostname
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

// INVARIANT: System One names a yes/no question noul; other types keep the kernel shape.
function toWire(question: DecisionQuestion): Record<string, unknown> {
  if (question.type !== 'boolean') return { ...question }
  return question.criteria
    ? { type: 'noul', instructions: question.instructions, criteria: question.criteria }
    : { type: 'noul', instructions: question.instructions }
}

function probabilitiesOf(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function fromWire(question: DecisionQuestion, raw: Record<string, unknown> | undefined): DecisionAnswer | undefined {
  if (!raw) return undefined
  const confidence = numberOr(raw.confidence)
  const signals = confidence !== undefined ? { confidence } : {}
  if (question.type === 'boolean') {
    const probability = numberOr(raw.noul)
    return probability === undefined ? undefined : { type: 'boolean', probability, ...signals }
  }
  if (question.type === 'score') {
    const score = numberOr(raw.score)
    return score === undefined ? undefined : { type: 'score', score, ...signals }
  }
  if (typeof raw.choice !== 'string' || !Object.hasOwn(question.criteria, raw.choice)) return undefined
  const probabilities = probabilitiesOf(raw.probabilities)
  return { type: 'choice', choice: raw.choice, ...(probabilities ? { probabilities } : {}), ...signals }
}

interface SystemOneBody {
  model?: unknown
  answers?: Record<string, Record<string, unknown>>
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
  warnings?: unknown
}

/**
 * Jev / System One over HTTP: TypeSafe's hosted endpoint (`typesafe`), a
 * self-hosted System One server (`systemone`), or any relay speaking the same
 * protocol. Error messages name the service at most, never the key or state.
 */
export class SystemOneJudgeProvider implements JudgeProvider {
  readonly id: string
  private readonly apiKey: string | (() => Promise<string | undefined>)
  private readonly model: string
  private readonly kind: 'typesafe' | 'systemone'
  private readonly baseUrl: string | (() => Promise<string | undefined>) | undefined
  private readonly fetchImpl: typeof fetch

  constructor(options: {
    kind: 'typesafe' | 'systemone'
    apiKey: string | (() => Promise<string | undefined>)
    model?: string | undefined
    baseUrl?: string | (() => Promise<string | undefined>) | undefined
    idPrefix?: string | undefined
    fetch?: typeof fetch | undefined
  }) {
    this.apiKey = options.apiKey
    this.kind = options.kind
    this.baseUrl = options.baseUrl
    const hosted = options.kind === 'typesafe'
    const staticBase = typeof options.baseUrl === 'string' ? options.baseUrl : undefined
    const endpoint = hosted
      ? (staticBase || TYPESAFE_BASE_URL).replace(/\/+$/, '')
      : systemOneEndpoint(staticBase)
    const host = URL.canParse(endpoint) ? new URL(endpoint).host : endpoint
    const service = hosted && host === new URL(TYPESAFE_BASE_URL).host ? 'TypeSafe' : host
    this.model = options.model || (hosted ? TYPESAFE_DEFAULT_MODEL : SYSTEMONE_DEFAULT_MODEL)
    this.fetchImpl = options.fetch ?? fetch
    const prefix = options.idPrefix ?? (hosted && service === 'TypeSafe' ? 'typesafe' : host)
    this.id = `${prefix}:${this.model}`
  }

  async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
    const hosted = this.kind === 'typesafe'
    const resolvedBase = typeof this.baseUrl === 'function' ? await this.baseUrl() : this.baseUrl
    const endpoint = hosted
      ? (resolvedBase || TYPESAFE_BASE_URL).replace(/\/+$/, '')
      : systemOneEndpoint(resolvedBase)
    const keyOptional = !hosted && isLoopbackAddress(endpoint)
    const host = URL.canParse(endpoint) ? new URL(endpoint).host : endpoint
    const service = hosted && host === new URL(TYPESAFE_BASE_URL).host ? 'TypeSafe' : host

    const apiKey = typeof this.apiKey === 'string' ? this.apiKey : await this.apiKey()
    if (!apiKey && !keyOptional)
      throw new JudgeError('auth', `No API key is configured for ${service}`)

    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [id, toWire(question)]),
    )
    const safeEndpoint = safeEndpointOf(endpoint)
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.model, state: request.state, questions }),
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
      throw new JudgeError(
        errorKindForStatus(response.status, message),
        message || `${service} responded with HTTP ${response.status}`,
        { status: response.status, endpoint: safeEndpoint },
      )
    }

    const body = (await response.json().catch(() => undefined)) as SystemOneBody | undefined
    if (!body || typeof body.answers !== 'object' || body.answers === null) {
      throw new JudgeError('invalid_response', `${service} response has no answers`, {
        status: response.status,
        endpoint: safeEndpoint,
      })
    }
    const answers: Record<string, DecisionAnswer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = fromWire(question, body.answers[id])
      if (!answer) throw new JudgeError('invalid_response', `${service} gave no usable answer for "${id}"`)
      answers[id] = answer
    }
    return {
      answers,
      usage: {
        inputTokens: numberOr(body.usage?.input_tokens),
        outputTokens: numberOr(body.usage?.output_tokens),
      },
      modelId: typeof body.model === 'string' ? body.model : this.model,
      warnings: readWarnings(body.warnings),
    }
  }
}

interface HttpJudgeBody {
  answers?: Record<string, DecisionAnswer>
  usage?: { inputTokens?: unknown; outputTokens?: unknown }
  warnings?: unknown
}

/**
 * A judge server of one's own: `{state, questions}` in, `{answers}` out, with
 * optional `usage` and `warnings`. The kernel validates the answers.
 */
export class HttpJudgeProvider implements JudgeProvider {
  readonly id: string
  private readonly baseUrl: string
  private readonly path: string
  private readonly apiKey: string | (() => Promise<string | undefined>)
  private readonly fetchImpl: typeof fetch

  constructor(options: {
    baseUrl: string
    path?: string | undefined
    apiKey?: string | (() => Promise<string | undefined>) | undefined
    fetch?: typeof fetch | undefined
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.path = options.path ?? '/evaluate'
    this.apiKey = options.apiKey ?? (async () => undefined)
    this.fetchImpl = options.fetch ?? fetch
    this.id = `http:${this.baseUrl}`
  }

  async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
    const apiKey = typeof this.apiKey === 'string' ? this.apiKey : await this.apiKey()
    if (!apiKey && !isLoopbackAddress(this.baseUrl))
      throw new JudgeError('auth', `No API key is configured for ${this.baseUrl}`)
    const endpoint = `${this.baseUrl}${this.path}`
    const safeEndpoint = safeEndpointOf(endpoint)
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: request.state, questions: request.questions }),
        signal: request.signal ?? null,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new JudgeError('unreachable', 'Judge server is not reachable', {
        endpoint: safeEndpoint,
        cause: error,
      })
    }

    if (!response.ok) {
      const message = await readErrorMessage(response, apiKey)
      throw new JudgeError(
        errorKindForStatus(response.status, message),
        message || `Judge server responded with HTTP ${response.status}`,
        { status: response.status, endpoint: safeEndpoint },
      )
    }

    const body = (await response.json().catch(() => undefined)) as HttpJudgeBody | undefined
    if (!body || typeof body.answers !== 'object' || body.answers === null) {
      throw new JudgeError('invalid_response', 'Judge server response has no answers', {
        status: response.status,
        endpoint: safeEndpoint,
      })
    }
    return {
      answers: { ...body.answers },
      usage: {
        inputTokens: numberOr(body.usage?.inputTokens),
        outputTokens: numberOr(body.usage?.outputTokens),
      },
      warnings: readWarnings(body.warnings),
    }
  }
}