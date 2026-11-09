import type { ApplicationErrorCode, ProviderFailure } from '@pidex/agent-protocol'
import { AgentError } from '../Domain'
import { providerFailureCategory, providerFailureMessage } from './ModelHealthService'

export class ProviderRequestError extends AgentError {
  constructor(
    code: ApplicationErrorCode,
    message: string,
    readonly retryable: boolean,
    details?: unknown,
  ) {
    super(code, message, retryable ? 502 : 400, details)
  }
}

export function providerRequestError(cause: unknown, providerId?: string): ProviderRequestError {
  const error = cause as { status?: number; statusCode?: number; code?: string }
  const status = error?.statusCode ?? error?.status ??
    Number(/\bHTTP (\d{3})\b/.exec(cause instanceof Error ? cause.message : '')?.[1])
  const category = providerFailureCategory(status ? { status } : cause)
  const code: ApplicationErrorCode = error?.code === 'CREDENTIAL_NOT_FOUND' ? 'CREDENTIAL_NOT_FOUND'
    : error?.code === 'MODEL_UNAVAILABLE' ? 'MODEL_UNAVAILABLE'
    : status === 403 ? 'PROVIDER_ACCESS_DENIED'
    : category === 'authentication' ? 'PROVIDER_AUTH_FAILED'
    : category === 'rate-limit' ? 'RATE_LIMITED'
    : category === 'timeout' ? 'PROVIDER_TIMEOUT'
    : category === 'network' ? 'PROVIDER_CONNECTION_FAILED' : 'PROVIDER_UNAVAILABLE'
  const retryable = ['RATE_LIMITED', 'PROVIDER_TIMEOUT', 'PROVIDER_CONNECTION_FAILED'].includes(code) ||
    (code === 'PROVIDER_UNAVAILABLE' && category === 'provider')
  return new ProviderRequestError(
    code,
    `${providerFailureMessage(category, 'request', status)}${status ? `（HTTP ${status}）` : ''}`,
    retryable,
    { ...(providerId ? { providerId } : {}), ...(status ? { httpStatus: status } : {}) },
  )
}

export function catalogRefreshError(failures: readonly ProviderFailure[]): ProviderRequestError {
  if (failures.length === 0)
    return new ProviderRequestError('PROVIDER_UNAVAILABLE', '模型目录刷新失败，请检查供应商配置和连接。', false)
  const first = failures[0]
  if (failures.length === 1 && first)
    return new ProviderRequestError(first.code, '模型目录刷新失败', first.retryable, {
      ...(first.providerId ? { providerId: first.providerId } : {}),
      ...(first.httpStatus ? { httpStatus: first.httpStatus } : {}),
    })
  return new ProviderRequestError(
    'PROVIDER_CATALOG_REFRESH_FAILED',
    '多个供应商模型目录刷新失败',
    failures.every(failure => failure.retryable),
    { failures: failures.slice(0, 5), totalFailures: failures.length },
  )
}
