import { expect, test } from 'bun:test'
import { AgentError } from '../src/Domain'
import { catalogRefreshError, providerRequestError } from '../src/provider/ProviderError'
import { decodeProviderErrorDetails } from '@pidex/agent-protocol'

test.each([
  [401, 'PROVIDER_AUTH_FAILED', false],
  [403, 'PROVIDER_ACCESS_DENIED', false],
  [429, 'RATE_LIMITED', true],
  [503, 'PROVIDER_UNAVAILABLE', true],
  [404, 'PROVIDER_UNAVAILABLE', false],
])('upstream HTTP %s retains its business category', (status, code, retryable) => {
  const error = providerRequestError({ status, body: 'private response', headers: { authorization: 'private key' } }, 'fixture')
  expect(error).toMatchObject({ code, retryable, details: { providerId: 'fixture', httpStatus: status } })
  expect(JSON.stringify(error)).not.toContain('private')
})

test('network, timeout and explicit domain failures retain their categories', () => {
  expect(providerRequestError(new TypeError('fetch failed'))).toMatchObject({ code: 'PROVIDER_CONNECTION_FAILED', retryable: true })
  expect(providerRequestError(new DOMException('timeout', 'TimeoutError'))).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true })
  expect(providerRequestError(new AgentError('CREDENTIAL_NOT_FOUND', 'private', 404))).toMatchObject({ code: 'CREDENTIAL_NOT_FOUND', retryable: false })
  expect(providerRequestError(new AgentError('MODEL_UNAVAILABLE', 'private', 404))).toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: false })
})

test('catalog failure details are bounded and mixed failures are not retryable', () => {
  const failure = { providerId: 'fixture', code: 'PROVIDER_TIMEOUT' as const, retryable: true }
  const mixed = catalogRefreshError([...Array.from({ length: 6 }, () => failure), { ...failure, code: 'PROVIDER_AUTH_FAILED', retryable: false }])
  const details = decodeProviderErrorDetails(mixed.details)
  expect(mixed).toMatchObject({ code: 'PROVIDER_CATALOG_REFRESH_FAILED', retryable: false })
  expect(details.failures).toHaveLength(5)
  expect(details.totalFailures).toBe(7)
  expect(catalogRefreshError([failure])).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true, details: { providerId: 'fixture' } })
  expect(catalogRefreshError([failure, failure]).retryable).toBe(true)
})
