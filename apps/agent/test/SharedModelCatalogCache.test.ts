import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderDirectoryStore } from '../src/provider/pi/ProviderDirectoryStore'
import { ModelRecommendationStore } from '../src/provider/pi/ModelRecommendationStore'

const commonModel = (overrides: Record<string, unknown> = {}) => ({
  name: 'Common model',
  limit: { context: 128000, input: 120000, output: 8000 },
  reasoning: true,
  tool_call: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
  reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
  description: 'noise description',
  family: 'noise-family',
  release_date: '2020-01-01',
  ...overrides,
})

const catalogPayload = () => ({
  models: { 'maker/example': commonModel() },
  providers: {
    vendor: {
      name: 'Vendor',
      api: 'https://vendor.example/v1',
      npm: '@ai-sdk/openai-compatible',
      env: ['VENDOR_API_KEY'],
      marketVisible: true,
      models: {
        example: commonModel({
          name: 'Provider model',
          canonical_model_id: 'maker/example',
          provider: 'vendor',
          description: 'noise provider description',
          cost: { input: 2, output: 3, cache_read: 0.5, cache_write: 1 },
        }),
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
    'extra-hidden': {
      name: 'Hidden Recommendation Only',
      api: 'https://hidden.example/v1',
      marketVisible: false,
      models: {
        example: commonModel({
          canonical_model_id: 'maker/example',
          cost: { input: 9, output: 10 },
        }),
      },
    },
  },
})

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

test('旧两份缓存迁移到共享文件：目录与推荐共用一份，旧文件保持原样', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pidex-shared-migrate-'))
  const directoryPath = join(directory, 'provider-directory.json')
  const recommendationPath = join(directory, 'model-recommendations.json')
  const sharedPath = join(directory, 'shared-model-catalog.json')
  try {
    const legacyDirectory = JSON.stringify({
      owner: 'pidex-provider-directory',
      formatVersion: 1,
      pi,
      modelsDev: catalogPayload(),
    })
    const legacyRecommendation = JSON.stringify({
      owner: 'pidex',
      formatVersion: 1,
      updatedAt: 123,
      catalog: catalogPayload(),
    })
    await writeFile(directoryPath, legacyDirectory, 'utf8')
    await writeFile(recommendationPath, legacyRecommendation, 'utf8')

    const directoryStore = new ProviderDirectoryStore(directoryPath)
    const recommendations = new ModelRecommendationStore(recommendationPath)
    // 目录先加载，内部迁移并写出共享缓存；推荐共用同一份内存/文件。
    expect((await directoryStore.providers()).some((entry) => entry.id === 'vendor')).toBe(true)
    expect(await readFile(sharedPath, 'utf8')).toContain('"owner":"pidex-model-catalog"')
    const resolved = (
      await recommendations.resolve({
        providerId: 'relay',
        baseUrl: 'https://vendor.example/v1',
        modelId: 'example',
        modelType: 'chat',
      })
    ).recommended
    expect(resolved).toMatchObject({ contextWindow: 128000, cost: { input: 2, output: 3 } })
    // 旧 updatedAt 迁移保留，fingerprint 不抖动。
    expect(await recommendations.version()).toBe(123)
    expect(await readFile(directoryPath, 'utf8')).toBe(legacyDirectory)
    expect(await readFile(recommendationPath, 'utf8')).toBe(legacyRecommendation)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('写入前裁剪：只保存消费字段，供应商层仅存差异且可完整重建', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pidex-shared-trim-'))
  const path = join(directory, 'provider-directory.json')
  const sharedPath = join(directory, 'shared-model-catalog.json')
  try {
    const store = new ProviderDirectoryStore(path, async (url) => {
      expect(String(url)).toBe('https://models.codepilotx.top/v1/catalog.json')
      return Response.json(catalogPayload(), { headers: { ETag: '"v1"' } })
    })
    await store.refresh()
    const persisted = await readFile(sharedPath, 'utf8')
    // v1 展示资料保留，未知字段仍裁剪。
    for (const field of ['noise description', 'noise-family', 'release_date', 'family'])
      expect(persisted).toContain(field)
    const document = JSON.parse(persisted)
    expect(document.etag).toBe('"v1"')
    expect(document.models['maker/example']).toMatchObject({
      name: 'Common model',
      limit: { context: 128000, input: 120000, output: 8000 },
      reasoning: true,
      tool_call: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
    })
    // 供应商层只存相对公共事实的差异 + 显式存在且相同的字段名。
    const delta = document.providers.vendor.models.example
    expect(delta.ref).toBe('maker/example')
    expect(delta.inherited).toEqual(expect.arrayContaining(['limit', 'modalities', 'reasoning']))
    expect(delta.diff).toMatchObject({
      name: 'Provider model',
      canonical_model_id: 'maker/example',
      cost: { input: 2, output: 3, cache_read: 0.5, cache_write: 1 },
    })
    // 重建后的目录只暴露 marketVisible=true 的厂商，而推荐索引仍覆盖全部白名单厂商。
    const entries = await store.providers()
    expect(entries.map((entry) => entry.id)).toEqual(['vendor'])
    expect(entries.find((entry) => entry.id === 'vendor')?.models.m).toMatchObject({
      contextWindow: 65536,
    })
    const restarted = new ModelRecommendationStore(join(directory, 'model-recommendations.json'))
    const recommended = (
      await restarted.resolve({
        providerId: 'relay',
        baseUrl: 'https://vendor.example/v1',
        modelId: 'example',
        modelType: 'chat',
      })
    ).recommended
    expect(recommended).toMatchObject({
      contextWindow: 128000,
      maxInputTokens: 120000,
      maxTokens: 8000,
      reasoning: true,
      tools: true,
      cost: { input: 2, output: 3 },
    })
    const hiddenRec = await restarted.resolve({
      providerId: 'extra-hidden',
      modelId: 'example',
      modelType: 'chat',
    })
    expect(hiddenRec.recommended.cost).toEqual({ input: 9, output: 10 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('刷新失败保留最近一次完整缓存，不写部分结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pidex-shared-failure-'))
  const path = join(directory, 'provider-directory.json')
  const sharedPath = join(directory, 'shared-model-catalog.json')
  let fail = false
  const store = new ProviderDirectoryStore(path, async () => {
    if (fail) return new Response(null, { status: 503 })
    return Response.json(catalogPayload())
  })
  try {
    await store.refresh()
    const sharedBefore = await readFile(sharedPath, 'utf8')
    const entries = await store.providers()
    fail = true
    await expect(store.refresh()).rejects.toThrow('模型清单')
    expect(await readFile(sharedPath, 'utf8')).toBe(sharedBefore)
    expect(await store.providers()).toEqual(entries)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('支持 ETag 304 条件刷新、PIDEX_MODEL_CATALOG_URL 覆盖与内置快照兜底', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pidex-shared-etag-'))
  const previousUrl = process.env.PIDEX_MODEL_CATALOG_URL
  process.env.PIDEX_MODEL_CATALOG_URL = 'https://mirror.example.test/v1/catalog.json'
  try {
    const recPath = join(directory, 'model-recommendations.json')
    const dirStore = new ProviderDirectoryStore(
      join(directory, 'provider-directory.json'),
      undefined,
      { bundledFallback: true },
    )
    const recStore = new ModelRecommendationStore(recPath, undefined, { bundledFallback: true })
    expect((await dirStore.providers()).some((p) => p.id === 'deepseek')).toBe(true)
    const bundledFlash = await recStore.resolve({
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
      modelType: 'chat',
    })
    expect(bundledFlash.recommended.pricing?.currency).toBe('CNY')

    const seenHeaders: Array<string | null> = []
    let mode: 'initial' | 'not-modified' = 'initial'
    const customRec = new ModelRecommendationStore(
      recPath,
      async (url, init) => {
        expect(String(url)).toBe('https://mirror.example.test/v1/catalog.json')
        const h = new Headers(init?.headers)
        seenHeaders.push(h.get('if-none-match'))
        if (mode === 'not-modified') {
          return new Response(null, { status: 304, headers: { ETag: '"etag-1"' } })
        }
        return Response.json(catalogPayload(), { headers: { ETag: '"etag-1"' } })
      },
      { bundledFallback: true },
    )
    const first = await customRec.refresh()
    mode = 'not-modified'
    const second = await customRec.refresh()
    expect(seenHeaders).toEqual([null, '"etag-1"'])
    expect(second.updatedAt).toBe(first.updatedAt)
  } finally {
    if (previousUrl === undefined) delete process.env.PIDEX_MODEL_CATALOG_URL
    else process.env.PIDEX_MODEL_CATALOG_URL = previousUrl
    await rm(directory, { recursive: true, force: true })
  }
})

test('别名歧义在迁移后仍不合并', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pidex-shared-ambiguous-'))
  const path = join(directory, 'model-recommendations.json')
  try {
    await writeFile(
      path,
      JSON.stringify({
        owner: 'pidex',
        formatVersion: 1,
        updatedAt: 7,
        catalog: {
          models: {
            'a/example': { name: 'A', limit: { context: 32000, output: 1000 } },
            'b/example': { name: 'B', limit: { context: 64000, output: 2000 } },
          },
          providers: {},
        },
      }),
      'utf8',
    )
    const store = new ModelRecommendationStore(path)
    expect(
      (await store.resolve({ providerId: 'relay', modelId: 'example', modelType: 'chat' })).status,
    ).toBe('ambiguous')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
