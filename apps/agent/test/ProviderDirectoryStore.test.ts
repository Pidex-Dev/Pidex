import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ProviderDirectoryStore,
  directoryBaseUrlKey,
  parseProviderDirectory,
} from '../src/provider/pi/ProviderDirectoryStore'

const pi = {
  vendor: {
    m: {
      id: 'm',
      name: 'Pi model',
      api: 'openai-responses',
      baseUrl: 'https://vendor.example/v1',
      contextWindow: 65536,
      maxTokens: 4096,
      reasoning: false,
      input: ['text'],
    },
  },
}
const modelsDev = {
  models: { m: { name: 'Common model' } },
  providers: {
    vendor: {
      name: 'Vendor',
      api: 'https://fallback.example/v1',
      npm: '@ai-sdk/openai-compatible',
      env: ['VENDOR_API_KEY'],
      models: { m: { name: 'Dev model', limit: { context: 0, output: 0 } } },
    },
  },
}

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

test('Pi definitions take priority while models.dev fills provider metadata and unknown limits', () => {
  const entries = parseProviderDirectory({
    owner: 'pidex-provider-directory',
    formatVersion: 1,
    pi,
    modelsDev,
  })
  expect(entries[0]).toMatchObject({
    id: 'vendor',
    name: 'Vendor',
    api: 'openai-responses',
    origin: 'pi-remote',
    baseUrl: 'https://vendor.example/v1',
    env: ['VENDOR_API_KEY'],
    models: { m: { name: 'Pi model', contextWindow: 65536 } },
  })
})

test('single-source refresh commits atomically, enforces marketVisible and refuses foreign caches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-directory-'))
  const path = join(root, 'directory.json')
  const sharedPath = join(root, 'shared-model-catalog.json')
  const requests: string[] = []
  let fail = false
  const singleSourceCatalog = {
    models: { m: { name: 'Common model' } },
    providers: {
      vendor: {
        name: 'Vendor',
        api: 'https://vendor.example/v1',
        npm: '@ai-sdk/openai-compatible',
        env: ['VENDOR_API_KEY'],
        marketVisible: true,
        models: {
          m: {
            name: 'Pi model',
            pi_api: 'openai-responses',
            base_url: 'https://vendor.example/v1',
            limit: { context: 65536, output: 4096 },
            reasoning: false,
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
      'hidden-cn': {
        name: 'Hidden CN',
        api: 'https://hidden.example/v1',
        marketVisible: false,
        models: { m: { name: 'Hidden', limit: { context: 65536, output: 4096 } } },
      },
    },
  }
  const store = new ProviderDirectoryStore(path, async (url, init) => {
    requests.push(String(url))
    expect(init?.headers).toBeUndefined()
    expect(init?.redirect).toBe('error')
    if (fail) return new Response(null, { status: 503 })
    return Response.json(singleSourceCatalog)
  })
  try {
    await store.refresh()
    expect(requests).toEqual(['https://models.codepilotx.top/v1/catalog.json'])
    const before = await readFile(sharedPath, 'utf8')
    const entries = await store.providers()
    expect(entries.map((e) => e.id)).toEqual(['vendor'])
    expect(await new ProviderDirectoryStore(path).providers()).toEqual(entries)
    fail = true
    await expect(store.refresh()).rejects.toThrow('模型清单')
    expect(await store.providers()).toEqual(entries)
    expect(await readFile(sharedPath, 'utf8')).toBe(before)
    await writeFile(path, '{"owner":"someone-else","formatVersion":1}', 'utf8')
    await expect(store.refresh()).rejects.toThrow('Unsupported directory cache')
    await expect(new ProviderDirectoryStore(path).refresh()).rejects.toThrow(
      'Unsupported directory cache',
    )
    expect(await readFile(path, 'utf8')).toBe('{"owner":"someone-else","formatVersion":1}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('v1 模型级 SDK、shape 与地址覆盖默认协议；目录 body 与 headers 不进入配置', () => {
  const entries = parseProviderDirectory({
    owner: 'pidex-provider-directory',
    formatVersion: 1,
    pi,
    modelsDev: {
      ...modelsDev,
      providers: {
        ...modelsDev.providers,
        other: {
          name: 'Other',
          npm: '@ai-sdk/openai-compatible',
          api: 'https://other.example/v1',
          env: [],
          models: {
            example: {
              provider: {
                npm: '@ai-sdk/openai',
                shape: 'responses',
                api: 'https://responses.example/v1',
                body: { store: true },
                headers: { 'x-extra': 'ignored' },
              },
              limit: { context: 128000, output: 8192 },
            },
          },
        },
      },
    },
  })
  const other = entries.find((entry) => entry.id === 'other')!
  expect(other.models.example?.api).toBe('openai-responses')
  expect(other.modelBaseUrls?.example).toBe('https://responses.example/v1')
  expect(other.models.example?.headers).toBeUndefined()
  expect(other.models.example?.body).toBeUndefined()
})
