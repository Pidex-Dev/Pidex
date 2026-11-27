import type { AssistantMessageEvent, ProviderResponse } from '@earendil-works/pi-ai'
import type { ModelRecoveryState } from '@pidex/shared/thread'
import { providerHttpErrorStatus } from '../../provider/ModelHealthService'

const NETWORK_UNREACHABLE = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENETDOWN'])
const NETWORK_TRANSIENT = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'APIConnectionTimeoutError',
  'TimeoutError',
  'PROVIDER_HEADERS_TIMEOUT',
  'PROVIDER_STREAM_EOF',
])
const TERMINAL_CODES = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'credit_balance_too_low',
  'subscription_sharing_usage_limit_exceeded',
  'usage_limit_reached',
  'usage_not_included',
  'quota_exceeded',
  'billing_not_active',
  'payment_required',
  'invalid_api_key',
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'context_length_exceeded',
  'content_policy_violation',
  'unsupported_media_type',
  'invalid_media_type',
  'unsupported_content_type',
  'invalid_file',
  'file_too_large',
  'invalid_image',
  'invalid_video',
  'invalid_audio',
  'cert_has_expired',
  'cert_not_yet_valid',
  'self_signed_cert_in_chain',
  'depth_zero_self_signed_cert',
  'unable_to_get_issuer_cert',
  'unable_to_verify_leaf_signature',
  'err_tls_cert_altname_invalid',
])
const TRANSIENT_PROVIDER_CODES = new Set([
  'overloaded_error',
  'rate_limit_error',
  'rate_limit_exceeded',
  'server_error',
  'service_unavailable',
])
const TRANSIENT_HTTP = new Set([408, 429, 502, 503, 504, 529])
const STREAM_IDLE_MS = 300_000
const MAX_SERVER_WAIT_MS = 300_000
const MAX_BACKOFF_MS = 60_000

type Failure = {
  kind: 'offline' | 'transient' | 'terminal'
  retryAfterMs?: number
  networkInterrupted?: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function collectErrorCodes(value: unknown, codes: Set<string>, depth = 0): void {
  const error = record(value)
  if (!error || depth > 4) return
  for (const code of [error.code, error.type, error.name]) {
    if (typeof code === 'string') codes.add(code)
  }
  collectErrorCodes(error.cause, codes, depth + 1)
  collectErrorCodes(error.error, codes, depth + 1)
  if (Array.isArray(error.errors)) {
    for (const cause of error.errors.slice(0, 8)) collectErrorCodes(cause, codes, depth + 1)
  }
}

function parseRetryAfter(header: (key: string) => string | null | undefined): number | undefined {
  const ms = header('retry-after-ms')
  if (ms && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms)
  const retryAfter = header('retry-after')?.trim()
  if (!retryAfter) return undefined
  const delay = /^\d+(?:\.\d+)?$/.test(retryAfter)
    ? Number(retryAfter) * 1000
    : Date.parse(retryAfter) - Date.now()
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined
}

export class ModelAttempt {
  private readonly controller = new AbortController()
  readonly signal: AbortSignal
  private response?: ProviderResponse
  private error?: unknown
  private readonly codes = new Set<string>()
  private acquiringStreamEvent = false
  private idleTimer?: ReturnType<typeof setTimeout>
  private streaming = false
  private idle = false
  private localFailure = false

  constructor(parentSignal?: AbortSignal) {
    this.signal = parentSignal
      ? AbortSignal.any([parentSignal, this.controller.signal])
      : this.controller.signal
  }

  onResponse(response: ProviderResponse) {
    this.response = response
    if (response.status >= 200 && response.status < 300) this.onActivity()
  }

  onStreamEvent(value: unknown) {
    const event = record(value)
    if (!event || event.type === 'ping') return
    this.onActivity()
    if (event.type === 'error') collectErrorCodes(event, this.codes)
    if (event.type === 'response.failed') {
      collectErrorCodes(record(event.response)?.error, this.codes)
    }
  }

  onError(error: unknown) {
    this.error = error
    collectErrorCodes(error, this.codes)
  }

  onLocalFailure() {
    this.localFailure = true
  }

  onActivity() {
    this.streaming = true
    if (!this.acquiringStreamEvent) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idle = true
      this.controller.abort()
    }, STREAM_IDLE_MS)
  }

  get receivedResponse() {
    return this.streaming
  }

  get httpErrorStatus() {
    return providerHttpErrorStatus(this.error) ?? providerHttpErrorStatus(this.response)
  }

  failure(knownEndpoint: boolean, networkInterrupted: boolean): Failure {
    const error = record(this.error)
    const status = this.httpErrorStatus ?? this.response?.status
    const headers = error?.headers
    const header = (key: string) =>
      headers instanceof Headers ? headers.get(key) : this.response?.headers[key]
    const codes = [...this.codes]
    if (
      this.localFailure ||
      header('x-should-retry')?.toLowerCase() === 'false' ||
      codes.some((code) => TERMINAL_CODES.has(code.toLowerCase())) ||
      (typeof status === 'number' && status >= 400 && status < 500 && !TRANSIENT_HTTP.has(status))
    )
      return { kind: 'terminal' }
    const retryAfterMs = parseRetryAfter(header)
    if (this.idle) return { kind: 'transient', networkInterrupted: true }
    if (
      !this.streaming &&
      (typeof status !== 'number' || status < 400) &&
      (codes.some((code) => NETWORK_UNREACHABLE.has(code)) ||
        (knownEndpoint && networkInterrupted && this.codes.has('ENOTFOUND')))
    )
      return { kind: 'offline' }
    const networkError = codes.some(
      (code) => NETWORK_TRANSIENT.has(code) || NETWORK_UNREACHABLE.has(code),
    )
    if (
      (typeof status === 'number' && TRANSIENT_HTTP.has(status)) ||
      (typeof status === 'number' && status >= 500 && header('x-should-retry') === 'true') ||
      networkError ||
      codes.some((code) => TRANSIENT_PROVIDER_CODES.has(code.toLowerCase()))
    )
      return {
        kind: 'transient',
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(networkError && this.streaming ? { networkInterrupted: true } : {}),
      }
    return { kind: 'terminal' }
  }

  async read(
    iterator: AsyncIterator<AssistantMessageEvent>,
  ): Promise<IteratorResult<AssistantMessageEvent>> {
    this.signal.throwIfAborted()
    this.acquiringStreamEvent = true
    if (this.streaming) this.onActivity()
    let abort = () => {}
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(this.signal.reason)
        this.signal.addEventListener('abort', abort, { once: true })
      })
      return await Promise.race([iterator.next(), cancelled])
    } finally {
      clearTimeout(this.idleTimer)
      this.acquiringStreamEvent = false
      this.signal.removeEventListener('abort', abort)
    }
  }

  stop() {
    this.controller.abort()
  }
}

export class ModelRetryBudget {
  private used = 0
  private offlineUsed = 0
  private networkInterrupted = false

  constructor(private readonly waitForNetwork: boolean) {}

  next(
    attempt: ModelAttempt,
    knownEndpoint: boolean,
  ): { state: ModelRecoveryState; delayMs: number } | { retryAfterMs: number } | undefined {
    const failure = attempt.failure(knownEndpoint, this.networkInterrupted)
    if (failure.kind === 'terminal') return undefined
    if (failure.networkInterrupted || failure.kind === 'offline') this.networkInterrupted = true
    if (failure.kind === 'offline' && this.waitForNetwork) {
      return {
        state: 'waiting-for-network',
        delayMs: Math.min(MAX_BACKOFF_MS, 5000 * 2 ** this.offlineUsed++),
      }
    }
    if (failure.retryAfterMs !== undefined && failure.retryAfterMs > MAX_SERVER_WAIT_MS) {
      return { retryAfterMs: failure.retryAfterMs }
    }
    if (this.used >= 5) return undefined
    const backoff =
      Math.min(MAX_BACKOFF_MS, 2000 * 2 ** this.used++) * (0.75 + Math.random() * 0.25)
    return {
      state: 'retrying',
      delayMs: Math.max(backoff, failure.retryAfterMs ?? 0),
    }
  }
}
