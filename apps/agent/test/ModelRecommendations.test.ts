import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fixture from './fixtures/models-dev-catalog.json'
import regression from './fixtures/model-recommendation-regressions.json'
import {
  ModelRecommendationIndex,
  applyRecommendation,
} from '../src/provider/pi/ModelRecommendations'
import { ModelRecommendationStore } from '../src/provider/pi/ModelRecommendationStore'

const row = (context: number, extra = {}) => ({
  name: 'Example',
  limit: { context, input: context - 1000, output: 4000 },
  reasoning: true,
  tool_call: false,
  modalities: { input: ['text', 'image'] },
  reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
  ...extra,
})
const catalog = (context = 128000) => ({
  models: { 'maker/example': row(context) },
  providers: {
    vendor: {
      api: 'https://vendor.example/v1',
      models: {
        example: row(context, {
          canonical_model_id: 'maker/example',
          cost: { input: 2, output: 3 },
        }),
      },
    },
  },
})
const input = { providerId: 'relay', modelId: 'example', modelType: 'chat' as const }
const response = (body: unknown) => async () => Response.json(body)

describe('models.dev recommendations', () => {
  test('启动更新一次，每五分钟刷新，重复启动不重复定时，退出清理定时器', () => {
    const store = new ModelRecommendationStore()
    const refresh = spyOn(store, 'refresh').mockResolvedValue({ updatedAt: 1 })
    const interval = spyOn(globalThis, 'setInterval')
    const clear = spyOn(globalThis, 'clearInterval')
    try {
      store.startAutoRefresh()
      store.startAutoRefresh()
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(interval).toHaveBeenCalledTimes(1)
      expect(interval.mock.calls[0]![1]).toBe(300000)
      const tick = interval.mock.calls[0]![0] as () => void
      tick()
      expect(refresh).toHaveBeenCalledTimes(2)
      store.dispose()
      expect(clear).toHaveBeenCalledTimes(1)
    } finally {
      store.dispose()
      refresh.mockRestore()
      interval.mockRestore()
      clear.mockRestore()
    }
  })

  test('真实组合接口 fixture：聊天、embedding、reranking 独立映射', () => {
    const index = new ModelRecommendationIndex(fixture)
    expect(index.resolve({ ...input, modelId: 'tencent/hy3' }).recommended).toMatchObject({
      contextWindow: 256000,
      maxInputTokens: 192000,
      maxTokens: 128000,
    })
    const embedding = index.resolve({ ...input, modelId: 'baai/bge-m3', modelType: 'embedding' })
    expect(embedding.status).toBe('matched')
    expect(embedding.recommended.contextWindow).toBe(8192)
    expect(embedding.recommended.maxTokens).toBeUndefined()
    expect(
      index.resolve({ ...input, modelId: 'baai/bge-reranker-v2-m3', modelType: 'rerank' }).status,
    ).toBe('matched')
    expect(index.resolve({ ...input, modelId: 'baai/bge-m3' }).status).toBe('unmatched')
  })

  test('canonical、前缀、大小写、显式别名和推理后缀；不改真实 ID，不进行模糊匹配', () => {
    const payload = catalog()
    Object.assign(payload.models['maker/example'], { aliases: ['old-example'] })
    Object.assign(payload.providers, { official: { models: { example: row(128000) } } })
    const index = new ModelRecommendationIndex(payload)
    for (const modelId of [
      'maker/example',
      'example',
      'proxy/EXAMPLE',
      'example(high)',
      'old-example',
    ])
      expect(index.resolve({ ...input, modelId }).status).toBe('matched')
    for (const modelId of ['example-preview', 'example(random)', 'ample'])
      expect(index.resolve({ ...input, modelId }).status).toBe('unmatched')
    expect(input.modelId).toBe('example')
  })

  test('日期版本必须真实存在；不剥离日期、网关标记或量化尾', () => {
    const index = new ModelRecommendationIndex({
      models: {
        'anthropic/claude-sonnet-4-5': row(200000),
        'openai/gpt-4o': row(128000),
        'meta-llama/llama-3.3-70b-instruct': row(131072),
        'qwen/qwen2.5-7b-instruct': row(32768),
        'deepseek/deepseek-v4.1-flash-1017': row(1000000),
      },
      providers: {},
    })
    for (const modelId of [
      'claude-sonnet-4-5-20250929',
      'gpt-4o-2024-08-06',
      'meta-llama/llama-3.3-70b-instruct:free',
      'qwen2.5-7b-instruct-q4_k_m',
      'qwen/deepseek-v4.1-flash',
    ])
      expect(index.resolve({ ...input, modelId }).status).toBe('unmatched')
    // 目录里确实存在的日期版本才命中。
    const dated = index.resolve({ ...input, modelId: 'workbuddy/deepseek-v4.1-flash-1017' })
    expect(dated.status).toBe('matched')
    expect(dated.identity).toBe('deepseek/deepseek-v4.1-flash-1017')
    // 相似但确实是另一个模型的名字不能被当成同一个。
    for (const modelId of ['claude-sonnet-4', 'gpt-4o-mini', 'qwen2.5-14b-instruct'])
      expect(index.resolve({ ...input, modelId }).status).toBe('unmatched')
  })

  test('采用推荐覆盖已有值，缺失字段保留保存值', () => {
    const model = {
      name: '自定义名字',
      contextWindow: 8_192,
      maxTokens: 4_096,
      reasoning: false,
      tools: true,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    const recommended = {
      name: '推荐名字',
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: true,
      tools: false,
      input: ['text' as const, 'image' as const],
      cost: { input: 3, output: 15 },
    }
    const merged = applyRecommendation(model, recommended)
    expect(merged).toMatchObject({
      name: '推荐名字',
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: true,
      tools: false,
      input: ['text', 'image'],
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
    })

  })

  test('没有推荐时原样返回', () => {
    const model = {
      name: 'x',
      contextWindow: 1,
      maxTokens: 1,
      reasoning: false,
      tools: true,
      input: [] as ('text' | 'image' | 'audio' | 'video')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    expect(applyRecommendation(model, undefined)).toBe(model)
    expect(applyRecommendation(model, {})).toBe(model)
  })

  test('canonical 冲突不猜测，供应商未确认不套价格，地址匹配可叠加差异', () => {
    const payload = catalog()
    const index = new ModelRecommendationIndex(payload)
    expect(index.resolve(input).recommended.cost).toBeUndefined()
    expect(
      index.resolve({ ...input, baseUrl: 'https://vendor.example/v1/' }).recommended.cost,
    ).toEqual({ input: 2, output: 3 })
    Object.assign(payload.models, { 'other/example': row(64000) })
    expect(
      new ModelRecommendationIndex(payload).resolve({ ...input, modelId: 'proxy/example' }).status,
    ).toBe('ambiguous')
  })

  test('缺少官方字段保持缺失，第三方同名条目不再投票补齐', () => {
    const payload = {
      models: { 'maker/example': { name: 'Example', reasoning: true } },
      providers: {
        a: { models: { example: { canonical_model_id: 'maker/example', ...row(128000) } } },
        b: { models: { example: { canonical_model_id: 'maker/example', limit: { context: 64000 } } } },
      },
    }
    const result = new ModelRecommendationIndex(payload).resolve(input).recommended
    expect(result.contextWindow).toBeUndefined()
    expect(result.maxTokens).toBeUndefined()
    expect(result.reasoning).toBe(true)
  })

  test('官方身份优先：普通网关前缀只在官方目录匹配裸名，不改真实 ID', () => {
    const index = new ModelRecommendationIndex(regression)
    for (const prefix of ['qwen', 'workbuddy', 'magpie', 'QWEN']) {
      const result = index.resolve({ ...input, modelId: `${prefix}/qwen3.8-max` })
      expect(result).toMatchObject({
        status: 'matched',
        identity: 'alibaba/qwen3.8-max',
        source: 'official',
      })
      expect(result.recommended).toMatchObject({
        contextWindow: 1000000,
        maxTokens: 131072,
      })
      // models.dev 未提供最大输入时保持缺失，不从上下文推导。
      expect(result.recommended.maxInputTokens).toBeUndefined()
    }
    // 目录里确有该供应商的完整条目时采用供应商规格。
    const hyper = index.resolve({ ...input, modelId: 'hyper/qwen3.8-max' })
    expect(hyper).toMatchObject({
      status: 'matched',
      identity: 'alibaba/qwen3.8-max-preview',
      source: 'provider',
    })
    expect(hyper.recommended.maxTokens).toBe(65536)
    expect(hyper.recommended.cost).toMatchObject({ input: 2, output: 6 })
  })

  test('日期版本、大小写、显式别名、推理后缀与目录冲突', () => {
    const index = new ModelRecommendationIndex(regression)
    expect(index.resolve({ ...input, modelId: 'qwen/deepseek-v4.1-flash' })).toMatchObject({
      status: 'matched',
      identity: 'deepseek/deepseek-v4.1-flash',
      source: 'official',
    })
    expect(index.resolve({ ...input, modelId: 'alibaba/qwen3.8-max(high)' }).identity).toBe(
      'alibaba/qwen3.8-max',
    )
    // 多段命名空间只取末段模型名。
    expect(index.resolve({ ...input, modelId: 'qwen/alibaba/qwen3.8-max' }).identity).toBe(
      'alibaba/qwen3.8-max',
    )
    expect(index.resolve({ ...input, modelId: 'ALIBABA/QWEN3.8-MAX' }).identity).toBe(
      'alibaba/qwen3.8-max',
    )
    // 目录不存在的日期版本不回退基础型号。
    expect(
      index.resolve({ ...input, modelId: 'qwen/deepseek-v4.1-flash-1018' }).status,
    ).toBe('unmatched')
    // 第三方条目的 canonical 指向别的身份，不能否决官方条目。
    expect(index.resolve({ ...input, modelId: 'qwen3.8-max-0902' }).identity).toBe(
      'alibaba/qwen3.8-max-0902',
    )
    expect(
      index.resolve({
        ...input,
        providerId: 'conflict',
        baseUrl: 'https://conflict.example/v1',
        modelId: 'qwen3.8-max-0902',
      }),
    ).toMatchObject({
      identity: 'alibaba/qwen3.8-max-0902',
      source: 'official',
    })
    expect(
      index.resolve({
        ...input,
        providerId: 'relay',
        baseUrl: 'https://relay.example/v1',
        modelId: 'qwen3.8-max-0902',
      }),
    ).toMatchObject({
      identity: 'alibaba/qwen3.8-max-0902',
      source: 'provider',
      recommended: { maxTokens: 32768 },
    })
    // 官方目录明确给出 limit.input 时原样保留。
    expect(index.resolve({ ...input, modelId: 'maker/example' }).recommended.maxInputTokens).toBe(
      120000,
    )
    // 官方目录本身对应多个身份时才是真歧义。
    const conflict = index.resolve({ ...input, modelId: 'shared-name' })
    expect(conflict.status).toBe('ambiguous')
    expect(conflict.candidates).toEqual(['maker/example', 'other/example'])
  })

  test('供应商身份或规范化端点匹配价格，未知网关使用原厂参考价', () => {
    const index = new ModelRecommendationIndex(regression)
    // 未知网关使用原厂供应商参考价，不继承任意第三方价格。
    const relay = index.resolve({
      ...input,
      providerId: 'relay',
      baseUrl: 'https://relay.example/v1/',
      modelId: 'qwen3.8-max',
    })
    expect(relay.source).toBe('official')
    expect(relay.recommended.cost).toMatchObject({ input: 2, output: 6 })
    expect(relay.priceSource).toEqual({ kind: 'reference', providerId: 'alibaba' })

    const bare = index.resolve({ ...input, modelId: 'alibaba/qwen3.8-max' })
    expect(bare.recommended.cost).toMatchObject({ input: 2, output: 6 })

    // 当前供应商身份被目录识别时叠加该供应商规格与价格。
    const officialProvider = index.resolve({
      ...input,
      providerId: 'alibaba',
      modelId: 'qwen3.8-max',
    })
    expect(officialProvider).toMatchObject({ source: 'provider' })
    expect(officialProvider.recommended.cost).toMatchObject({ input: 2, cacheWrite: 2.5 })
  })

  test('手动刷新写入共享缓存、重启读缓存、失败保留及未知格式拒绝覆盖', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pidex-recommendations-'))
    const path = join(directory, 'recommendations.json')
    const shared = join(directory, 'shared-model-catalog.json')
    try {
      let calls = 0
      const store = new ModelRecommendationStore(path, async () => {
        calls++
        return Response.json(catalog())
      })
      expect((await store.resolve(input)).status).toBe('no-cache')
      expect(calls).toBe(0)
      await store.refresh()
      expect(calls).toBe(1)
      // models.dev 只落到共享缓存，不再单独写第二份推荐文件。
      const before = await readFile(shared, 'utf8')
      expect(before).toContain('"owner":"pidex-model-catalog"')
      await expect(readFile(path, 'utf8')).rejects.toThrow()
      const restarted = new ModelRecommendationStore(path, response({ invalid: true }))
      expect((await restarted.resolve(input)).recommended.contextWindow).toBe(128000)
      await expect(restarted.refresh()).rejects.toThrow()
      expect(await readFile(shared, 'utf8')).toBe(before)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('旧推荐缓存只读兼容，未知 owner 文件原样保留', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pidex-recommendations-legacy-'))
    const path = join(directory, 'model-recommendations.json')
    const shared = join(directory, 'shared-model-catalog.json')
    try {
      const legacy = { owner: 'pidex', formatVersion: 1, updatedAt: 42, catalog: catalog() }
      await writeFile(path, JSON.stringify(legacy), 'utf8')
      const store = new ModelRecommendationStore(path, response(catalog()))
      expect((await store.resolve(input)).recommended.contextWindow).toBe(128000)
      expect(await store.version()).toBe(42)
      expect(await readFile(shared, 'utf8')).toContain('"owner":"pidex-model-catalog"')
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify(legacy))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }

    const fresh = await mkdtemp(join(tmpdir(), 'pidex-recommendations-foreign-'))
    const foreignShared = join(fresh, 'shared-model-catalog.json')
    try {
      await writeFile(foreignShared, '{"owner":"someone-else"}', 'utf8')
      await expect(
        new ModelRecommendationStore(
          join(fresh, 'model-recommendations.json'),
          response(catalog()),
        ).refresh(),
      ).rejects.toThrow()
      expect(await readFile(foreignShared, 'utf8')).toBe('{"owner":"someone-else"}')
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })
})


test('价格优先当前供应商，否则取原厂参考价并覆盖已有价格', () => {
  const payload = catalog()
  Object.assign(payload.providers, {
    maker: { models: { example: row(128000, {
      canonical_model_id: 'maker/example', cost: { input: 10, output: 20, cache_read: 1 },
    }) } },
  })
  const index = new ModelRecommendationIndex(payload)
  const reference = index.resolve(input)
  expect(reference.recommended.cost).toEqual({ input: 10, output: 20, cacheRead: 1 })
  expect(reference.priceSource).toEqual({ kind: 'reference', providerId: 'maker' })
  for (const request of [
    { ...input, providerId: 'vendor' },
    { ...input, baseUrl: 'https://vendor.example/v1/' },
    { ...input, modelId: 'vendor/example' },
  ]) {
    const result = index.resolve(request)
    expect(result.recommended.cost).toEqual({ input: 2, output: 3 })
    expect(result.priceSource).toEqual({ kind: 'provider', providerId: 'vendor' })
  }
  const model = {
    name: 'Example', contextWindow: 128000, maxTokens: 4000, reasoning: false,
    input: ['text'] as const, cost: { input: 99, output: 88, cacheRead: 77, cacheWrite: 66 },
  }
  expect(applyRecommendation(model, reference.recommended).cost)
    .toEqual({ input: 10, output: 20, cacheRead: 1, cacheWrite: 66 })
  const missingPrice = catalog()
  Object.assign(missingPrice.providers, structuredClone(payload.providers))
  delete (missingPrice.providers.vendor.models.example as Record<string, unknown>).cost
  expect(new ModelRecommendationIndex(missingPrice).resolve({ ...input, providerId: 'vendor' }))
    .toMatchObject({ priceSource: { kind: 'reference', providerId: 'maker' }, recommended: { cost: { input: 10, output: 20 } } })
  expect(new ModelRecommendationIndex(catalog()).resolve(input).recommended.cost).toBeUndefined()
})


test('推荐目录保留 1.5 亿上下文，不再按 1000 万丢弃', () => {
  const result = new ModelRecommendationIndex(catalog(150_000_000)).resolve(input)
  expect(result.recommended.contextWindow).toBe(150_000_000)
  expect(result.recommended.maxInputTokens).toBe(149_999_000)
})


test('已开启智能配置的未知模型保留原值，目录更新后采用新增推荐', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pidex-follow-model-'))
  let payload: unknown = { models: { 'maker/other': row(128000) }, providers: {} }
  const store = new ModelRecommendationStore(join(directory, 'recommendations.json'), async () => Response.json(payload))
  const saved = {
    name: 'Example', contextWindow: 64000, maxTokens: 8192, reasoning: false,
    input: ['text'] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    smartConfig: { pinned: [] },
  }
  try {
    await store.refresh()
    const missing = await store.resolve(input)
    expect(missing.status).toBe('unmatched')
    expect(applyRecommendation(saved, missing.recommended)).toEqual(saved)
    payload = catalog(256000)
    await store.refresh()
    const matched = await store.resolve(input)
    expect(matched.status).toBe('matched')
    expect(applyRecommendation(saved, matched.recommended)).toMatchObject({
      contextWindow: 256000, smartConfig: { pinned: [] },
    })
  } finally {
    store.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})


test('后台目录同步通知可在启动后注册，失败不通知且不重复启动定时器', async () => {
  const store = new ModelRecommendationStore()
  const refresh = spyOn(store, 'refresh').mockResolvedValue({ updatedAt: 1 })
  const interval = spyOn(globalThis, 'setInterval')
  let updates = 0
  try {
    store.startAutoRefresh()
    store.startAutoRefresh(() => { updates++ })
    await Promise.resolve()
    expect(updates).toBe(1)
    expect(interval).toHaveBeenCalledTimes(1)
    const tick = interval.mock.calls[0]![0] as () => void
    refresh.mockRejectedValueOnce(new Error('offline'))
    tick()
    await Promise.resolve()
    await Promise.resolve()
    expect(updates).toBe(1)
    tick()
    await Promise.resolve()
    expect(updates).toBe(2)
    await store.refresh()
    expect(updates).toBe(2)
  } finally {
    store.dispose()
    refresh.mockRestore()
    interval.mockRestore()
  }
})


test('模型明确思考档位保留原始值、顺序和非固定七档，不被规范化替换', () => {
  const payload = catalog()
  payload.models['maker/example'] = row(128000, { reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'adaptive'] }] })
  payload.providers = {} as typeof payload.providers
  expect(new ModelRecommendationIndex(payload).resolve(input).recommended.optionSpecs?.reasoningLevel?.values)
    .toEqual(['none', 'low', 'high', 'adaptive'])
})


test('v1 资料与三种推理控制保留；PDF 只在目录资料中，分项价格不参与基础计费', () => {
  const index = new ModelRecommendationIndex({
    models: { 'maker/example': row(400000, {
      description: 'Model description', family: 'example', release_date: '2026-01-01',
      modalities: { input: ['text', 'pdf', 'audio'], output: ['text'] },
      reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 8192 }],
      temperature: false, structured_output: true,
    }) },
    providers: { maker: { models: { example: {
      canonical_model_id: 'maker/example', status: 'deprecated',
      cost: { input: 0, output: 3, reasoning: 5, input_audio: 8, output_audio: 12,
        cache_read: 0.2, cache_write: 1,
        tiers: [{ tier: { type: 'context', size: 200000 }, input: 4, output: 6, cache_read: 0.4, cache_write: 2 }],
      },
    } } } },
  })
  const result = index.resolve({ ...input, providerId: 'maker' })
  expect(result.recommended.input).toEqual(['text', 'audio'])
  expect(result.recommended.reasoningLevels).toBeUndefined()
  expect(result.recommended.catalog).toMatchObject({
    description: 'Model description', temperature: false, structuredOutput: true,
    input: ['text', 'pdf', 'audio'], status: 'deprecated',
    reasoningOptions: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 8192 }],
    reasoningCost: 5, inputAudioCost: 8, outputAudioCost: 12,
  })
  expect(result.recommended.cost).toEqual({ input: 0, output: 3, cacheRead: 0.2, cacheWrite: 1,
    tiers: [{ inputTokensAbove: 200000, input: 4, output: 6, cacheRead: 0.4, cacheWrite: 2 }],
  })
})


test('目录输入为空或只有 PDF 时不返回空 input，仍保留原始目录模态', () => {
  for (const modalities of [[], ['pdf'], ['unsupported']]) {
    const index = new ModelRecommendationIndex({ models: { 'maker/example': row(128000, {
      modalities: { input: modalities, output: ['text'] },
    }) }, providers: {} })
    const recommended = index.resolve(input).recommended
    expect(recommended.input).toBeUndefined()
    expect(recommended.catalog?.input).toEqual(modalities)
  }
})


test('推荐过滤只移除 undefined，保留 false、零、空字符串与未提供的原配置', () => {
  const model = { name: 'saved', contextWindow: 32000, maxTokens: 8000, reasoning: true, tools: true,
    input: ['text' as const], cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 1 } }
  const result = applyRecommendation(model, { name: '', reasoning: false, tools: false,
    maxInputTokens: undefined, cost: { input: 0, output: undefined },
  })
  expect(result).toMatchObject({ name: '', reasoning: false, tools: false, contextWindow: 32000,
    cost: { input: 0, output: 3, cacheRead: 1, cacheWrite: 1 } })
  expect(Object.hasOwn(result, 'maxInputTokens')).toBe(false)
  expect(applyRecommendation(model, { cost: {} }).cost).toBe(model.cost)
})
