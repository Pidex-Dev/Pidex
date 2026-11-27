import { expect, test } from 'bun:test'
import { directoryBaseUrlKey } from '../src/provider/runtime/ProviderDirectoryStore'

test('directory URL identity normalizes only URL syntax and trailing slashes', () => {
  expect(directoryBaseUrlKey('https://EXAMPLE.com:443/v1///')).toBe(
    directoryBaseUrlKey('https://example.com/v1'),
  )
  for (const url of [
    'http://example.com/v1',
    'https://example.com/v2',
    'https://example.com:8443/v1',
    'https://example.com/v1?region=cn',
    'https://example.com/coding/v1',
  ]) {
    expect(directoryBaseUrlKey(url)).not.toBe(directoryBaseUrlKey('https://example.com/v1'))
  }
  expect(directoryBaseUrlKey(undefined)).toBeUndefined()
  expect(directoryBaseUrlKey('invalid')).toBeUndefined()
})
