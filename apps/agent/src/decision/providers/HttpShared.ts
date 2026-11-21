import type { JudgeErrorKind } from '@pidex/shared/decision'
import type { JudgeWarning } from '@pidex/shared/decision'

export const MAX_ERROR_MESSAGE_LENGTH = 300

/**
 * The kind of a failed call by its HTTP status. A 403 that speaks of credit,
 * payment, billing or quota is an account that cannot pay yet; any other 403 is
 * a key without access.
 */
export function errorKindForStatus(status: number, message: string): JudgeErrorKind {
  if (status === 401) return 'auth'
  if (status === 402) return 'payment_required'
  if (status === 403) return /credit|payment|billing|quota/i.test(message) ? 'payment_required' : 'auth'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server'
  return 'bad_request'
}

/** Strips credentials, query parameters and fragments from an endpoint URL for safe diagnostics. */
export function safeEndpointOf(url: string): string {
  if (!URL.canParse(url)) return url.slice(0, MAX_ERROR_MESSAGE_LENGTH)
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}

/** Reads `{error:{message}}`, `{error:"..."}`, `{message}` or `{detail:"..."}`. */
export function messageFromErrorBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const record = body as Record<string, unknown>
  const nested = record.error
  if (typeof nested === 'object' && nested !== null) {
    const nestedMessage = (nested as Record<string, unknown>).message
    if (typeof nestedMessage === 'string') return nestedMessage
  }
  if (typeof nested === 'string') return nested
  if (typeof record.message === 'string') return record.message
  return typeof record.detail === 'string' ? record.detail : ''
}

/** Extracts a concise, secret-scrubbed error summary from JSON or plain-text HTTP error responses. */
export async function readErrorMessage(response: Response, secret?: string): Promise<string> {
  const raw = await response.text().catch(() => '')
  let message = ''
  if (raw.trim()) {
    try {
      message = messageFromErrorBody(JSON.parse(raw))
    } catch {}
    if (!message) message = raw.replace(/\s+/g, ' ').trim()
  }
  if (secret) message = message.replaceAll(secret, '…')
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
}

/** Keeps well-formed warnings and drops the rest. */
export function readWarnings(value: unknown): JudgeWarning[] | undefined {
  if (!Array.isArray(value)) return undefined
  const warnings: JudgeWarning[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.type !== 'string') continue
    warnings.push({
      type: record.type,
      ...(typeof record.message === 'string'
        ? { message: record.message.slice(0, MAX_ERROR_MESSAGE_LENGTH) }
        : {}),
      ...(typeof record.questionId === 'string' ? { questionId: record.questionId } : {}),
    })
  }
  return warnings.length > 0 ? warnings : undefined
}

export const numberOr = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const judgeInputText = (value: unknown): string =>
  value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)