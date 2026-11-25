import { expect, test } from 'bun:test'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatalogV2Cache } from '../src/provider/pi/CatalogV2Cache'
import { ModelRecommendationStore } from '../src/provider/pi/ModelRecommendationStore'
import { ProviderDirectoryStore } from '../src/provider/pi/ProviderDirectoryStore'
import { fixtureV2, respondV2 } from './fixtures/CatalogV2Fixture'

test('同步只下载哈希变化的文件，304 不切换代际，损坏下载不影响重启及 v1 文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-catalog-v2-'))
  const restarted = await mkdtemp(join(tmpdir(), 'pidex-catalog-restart-'))
  const providerPath = join(root, 'provider-directory.json')
  const recommendationPath = join(root, 'model-recommendations.json')
  const sharedPath = join(root, 'shared-model-catalog.json')
  const manifestPath = join(root, 'catalog-v2-manifest.json')
  let context = 128_000
  let endpoint = 'https://current.example/v1'
  let reply: 'ok' | '304' | 'corrupt' = 'ok'
  let etag = '"first"'
  const requests: string[] = []
  const seen: (string | null)[] = []
  const previous = process.env.PIDEX_MODEL_CATALOG_URL
  process.env.PIDEX_MODEL_CATALOG_URL = 'https://mirror.example.test/v1/catalog.json'
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(url)).origin).toBe('https://mirror.example.test')
    const path = new URL(String(url)).pathname
    requests.push(path)
    if (path.endsWith('manifest.json')) {
      seen.push(new Headers(init?.headers).get('If-None-Match'))
      if (reply === '304') return new Response(null, { status: 304 })
    }
    if (reply === 'corrupt' && path.endsWith('models.json')) return new Response('{}')
    return respondV2(
      url,
      fixtureV2({
        models: { 'maker/example': { limit: { context } } },
        providers: {
          maker: {
            api: endpoint,
            endpoints: ['https://legacy.example/v1'],
            marketVisible: true,
            models: { example: { canonical_model_id: 'maker/example' } },
          },
        },
      }),
      { ETag: etag },
    )
  }
  const providers = new ProviderDirectoryStore(providerPath, request)
  const recommendations = new ModelRecommendationStore(recommendationPath, request)
  const input = { providerId: 'gateway', modelId: 'example', modelType: 'chat' as const }
  try {
    for (const path of [providerPath, recommendationPath, sharedPath])
      await writeFile(path, 'v1 cached data')
    await Promise.all([providers.refresh(), recommendations.refresh()])
    expect(requests).toEqual(['/v2/manifest.json', '/v2/providers.json', '/v2/models.json'])
    expect(await providers.resolveProviderByBaseUrl('https://LEGACY.example/v1/')).toBe('maker')

    endpoint = 'https://changed.example/v1'
    etag = '"second"'
    requests.length = 0
    await providers.refresh()
    expect(requests).toEqual(['/v2/manifest.json', '/v2/providers.json'])
    expect(await providers.resolveProviderByBaseUrl(endpoint)).toBe('maker')
    const version = await recommendations.version()

    requests.length = 0
    reply = '304'
    await recommendations.refresh()
    expect(requests).toEqual(['/v2/manifest.json'])
    expect(seen).toEqual([null, '"first"', '"second"'])
    expect(await recommendations.version()).toBe(version)

    const before = await readFile(manifestPath, 'utf8')
    context = 256_000
    reply = 'corrupt'
    await expect(recommendations.refresh()).rejects.toThrow('checksum mismatch')
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
    expect((await recommendations.resolve(input)).recommended.contextWindow).toBe(128_000)
    for (const path of [providerPath, recommendationPath, sharedPath])
      expect(await readFile(path, 'utf8')).toBe('v1 cached data')

    await cp(join(root, 'catalog-v2'), join(restarted, 'catalog-v2'), { recursive: true })
    await cp(manifestPath, join(restarted, 'catalog-v2-manifest.json'))
    const cold = new ModelRecommendationStore(join(restarted, 'recommendations.json'))
    expect((await cold.resolve(input)).recommended.contextWindow).toBe(128_000)
  } finally {
    if (previous === undefined) delete process.env.PIDEX_MODEL_CATALOG_URL
    else process.env.PIDEX_MODEL_CATALOG_URL = previous
    await rm(root, { recursive: true, force: true })
    await rm(restarted, { recursive: true, force: true })
  }
})

test('离线快照保留下线模型的原厂价格，并区分目录模型、平台路由和独立权重', async () => {
  const cache = CatalogV2Cache.forPath(undefined, { bundledFallback: true })
  const catalog = await cache.current()
  expect(Object.keys(catalog!.providersDoc.providers['minimax-cn']!.models)).not.toContain(
    'MiniMax-M2.7',
  )
  expect(
    await cache.resolve({
      providerId: 'gateway',
      modelId: 'minimax/minimax-m2.7',
      modelType: 'chat',
    }),
  ).toMatchObject({
    identity: 'minimax/minimax-m2.7',
    priceSource: { kind: 'reference', providerId: 'minimax' },
    recommended: { pricing: { busy: { input: 0.3 } } },
  })
  const router = await cache.resolve({
    providerId: 'qwen-token-plan-cn',
    modelId: 'auto',
    modelType: 'chat',
  })
  expect(router.identity).toBeUndefined()
  expect(router.recommended.billingMode).toBe('subscription')
  expect(Object.keys(catalog!.modelsDoc.models).some((id) => id.endsWith('/auto'))).toBe(false)
  expect(catalog!.modelsDoc.models['zhipuai/glm-5.3-flashx']).toBeDefined()
  expect(catalog!.modelsDoc.models['zhipuai/glm-5.3-flash']).toBeDefined()
})
