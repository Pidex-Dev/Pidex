import { describe, expect, test } from 'bun:test'
import { AgentError } from '../src/Domain'
import { ModelSpecRepairService } from '../src/provider/pi/ModelSpecRepairService'
import type { ConfigService } from '../src/config/ConfigService'
import type { PiModelService } from '../src/provider/pi/PiModelService'

const recommendation = {
  status: 'matched' as const,
  source: 'official' as const,
  identity: 'maker/example',
  recommended: { contextWindow: 128_000, maxInputTokens: 100_000, maxTokens: 16_000 },
  updatedAt: 42,
}

const model = (overrides: Record<string, unknown> = {}) => ({
  id: 'example',
  name: 'Example',
  api: 'openai-completions',
  contextWindow: 32_768,
  maxTokens: 8_192,
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  headers: {},
  ...overrides,
})

const setup = (options: {
  readonly models: Record<string, unknown>
  readonly configVersion?: string
  readonly recommended?: Record<string, unknown>
  readonly updatedAt?: number
} = { models: {} }) => {
  const writes: Parameters<ConfigService['batchWrite']>[0][] = []
  const config = {
    read: async () => ({
      layers: [{ kind: 'user', version: options.configVersion ?? 'version-1' }],
    }),
    batchWrite: async (input: Parameters<ConfigService['batchWrite']>[0]) => {
      writes.push(structuredClone(input))
      return {}
    },
  } as unknown as ConfigService
  const recommended = options.recommended ?? recommendation.recommended
  const piModels = {
    catalogConfig: async () => ({
      providers: {
        gateway: {
          kind: 'custom',
          baseUrl: 'https://gateway.example/v1',
          endpoints: {},
          models: options.models,
        },
      },
    }),
    previewRecommendation: async () => ({
      ...recommendation,
      recommended,
      ...(options.updatedAt !== undefined ? { updatedAt: options.updatedAt } : {}),
    }),
  } as unknown as PiModelService
  return {
    service: new ModelSpecRepairService(piModels, config),
    writes,
  }
}

describe('ModelSpecRepairService', () => {
  test('预览只扫描 32K 模型，按字段给出建议与默认选择', async () => {
    const { service } = setup({
      models: {
        unpinned: model({ smartConfig: { pinned: [] } }),
        pinned: model({
          id: 'pinned',
          maxInputTokens: 50_000,
          maxTokens: 32_000,
          smartConfig: { pinned: ['contextWindow', 'maxInputTokens'] },
        }),
        legacy: model({ id: 'legacy' }),
        unknown: model({ id: 'unknown' }),
        healthy: model({ id: 'healthy', contextWindow: 128_000 }),
      },
    })
    const result = await service.preview('gateway')
    expect(result.configVersion).toBe('version-1')
    expect(result.catalogUpdatedAt).toBe(42)
    expect(result.items.map((item) => String(item.modelId))).toEqual([
      'example',
      'pinned',
      'legacy',
      'unknown',
    ])

    const unpinned = result.items[0]!
    expect(unpinned.match).toMatchObject({
      status: 'official',
      identity: 'maker/example',
      updatedAt: 42,
    })
    expect(unpinned.fields.map((field) => field.field)).toEqual([
      'contextWindow',
      'maxTokens',
      'maxInputTokens',
    ])
    expect(unpinned.fields.every((field) => field.defaultSelected)).toBe(true)

    const pinned = result.items[1]!
    expect(pinned.fields).toEqual([
      expect.objectContaining({
        field: 'contextWindow',
        current: 32_768,
        suggested: 128_000,
        pinned: false,
        defaultSelected: false,
      }),
      expect.objectContaining({
        field: 'maxTokens',
        current: 32_000,
        pinned: false,
        defaultSelected: false,
      }),
      expect.objectContaining({
        field: 'maxInputTokens',
        current: 50_000,
        pinned: false,
        defaultSelected: false,
      }),
    ])
    // 未启用智能配置的历史模型不自动勾选。
    expect(result.items[2]!.fields.every((field) => !field.defaultSelected)).toBe(true)
  })

  test('推荐仍是 32K 时标记无须修复', async () => {
    const { service } = setup({
      models: { placeholder: model({ smartConfig: { pinned: [] } }) },
      recommended: { contextWindow: 32_768, maxTokens: 32_768 },
    })
    const result = await service.preview('gateway')
    expect(result.items[0]!.fields).toEqual([
      expect.objectContaining({ field: 'contextWindow', noRepair: true, defaultSelected: false }),
      expect.objectContaining({ field: 'maxTokens', noRepair: true, defaultSelected: false }),
    ])
  })

  test('应用只写选中字段，保持智能配置与固定状态', async () => {
    const { service, writes } = setup({
      models: {
        pinned: model({
          maxInputTokens: 50_000,
          smartConfig: { pinned: ['contextWindow'] },
        }),
      },
    })
    const result = await service.apply({
      providerId: 'gateway',
      expectedConfigVersion: 'version-1',
      expectedCatalogUpdatedAt: 42,
      selections: [
        {
          modelId: 'pinned',
          fields: ['contextWindow', 'maxInputTokens', 'maxTokens'],
        },
      ],
    })
    expect(result).toEqual({ providerId: 'gateway', updatedModels: 1, updatedFields: 3 })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      target: { kind: 'user' },
      expectedVersion: 'version-1',
      edits: [
        {
          keyPath: ['model_providers', 'gateway', 'models', 'pinned', 'context_window'],
          value: 128_000,
        },
        {
          keyPath: ['model_providers', 'gateway', 'models', 'pinned', 'max_input_tokens'],
          value: 100_000,
        },
        {
          keyPath: ['model_providers', 'gateway', 'models', 'pinned', 'max_tokens'],
          value: 16_000,
        },
      ],
    })
    // 未选中的模型不会被写入。
    expect(
      writes[0]!.edits.every((edit) => edit.keyPath.includes('pinned')),
    ).toBe(true)
  })

  test('配置或推荐目录在预览后变化时拒绝按旧结果覆盖', async () => {
    const staleConfig = setup({
      models: { example: model() },
      configVersion: 'version-2',
    })
    await expect(
      staleConfig.service.apply({
        providerId: 'gateway',
        expectedConfigVersion: 'version-1',
        selections: [{ modelId: 'example', fields: ['contextWindow'] }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(staleConfig.writes).toEqual([])

    const staleCatalog = setup({
      models: { example: model() },
      updatedAt: 43,
    })
    await expect(
      staleCatalog.service.apply({
        providerId: 'gateway',
        expectedConfigVersion: 'version-1',
        expectedCatalogUpdatedAt: 42,
        selections: [{ modelId: 'example', fields: ['contextWindow'] }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(staleCatalog.writes).toEqual([])
  })

  test('未知 Provider 或没有可写字段时不写入', async () => {
    const { service, writes } = setup({
      models: { example: model() },
      recommended: { contextWindow: 32_768 },
    })
    await expect(service.preview('missing')).rejects.toBeInstanceOf(AgentError)
    const result = await service.apply({
      providerId: 'gateway',
      expectedConfigVersion: 'version-1',
      expectedCatalogUpdatedAt: 42,
      selections: [{ modelId: 'example', fields: ['contextWindow'] }],
    })
    expect(result).toEqual({ providerId: 'gateway', updatedModels: 0, updatedFields: 0 })
    expect(writes).toEqual([])
  })
})
