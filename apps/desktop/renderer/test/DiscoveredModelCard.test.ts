import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiscoveredModelRow } from '../src/features/models/provider-management/ProviderModelSyncPanel.js'
import { ModelRowItem } from '../src/features/models/provider-management/ProviderModelsSection.js'
import { ProviderModelListRow } from '../src/features/models/provider-management/ProviderModelListRow.js'
import {
  GENERIC_MODEL_CONTEXT_WINDOW,
  GENERIC_MODEL_MAX_TOKENS,
  resolveCandidateImportModel,
} from '../src/features/models/provider-management/ModelCandidateImport.js'
import {
  filterDiscoveredModels,
  resolveModelCapabilities,
  resolveModelContextWindow,
  resolveModelVendor,
} from '../src/features/models/provider-management/ModelSyncHelpers.js'
import {
  ModelCatalogDetails,
  modelPrice,
} from '../src/features/models/provider-management/ModelCatalogDetails.js'
import { describe, expect, it } from 'bun:test'
import type {
  DesktopModelProviderSummary,
  DesktopProviderModelDefinition,
} from '../shared/Types.js'

describe('DiscoveredModelCard helpers', () => {
  const mockProvider: DesktopModelProviderSummary = {
    providerID: 'custom-provider',
    kind: 'custom',
    displayName: 'My Custom Provider',
    defaultModels: [],
    apiKeyConfigured: true,
  }

  describe('resolveModelVendor', () => {
    it('ignores saved model groups when resolving vendor', () => {
      const model: DesktopProviderModelDefinition = {
        id: 'deepseek-v4-pro',
        group: 'Anthropic',
        api: 'openai-completions',
      }
      expect(resolveModelVendor(model, mockProvider)).toBe('DeepSeek')
    })

    it('resolves vendor from model id prefix with slash', () => {
      const model: DesktopProviderModelDefinition = {
        id: 'anthropic/claude-3-5-sonnet',
        api: 'openai-completions',
      }
      expect(resolveModelVendor(model, mockProvider)).toBe('Anthropic')
    })

    it('resolves vendor from known model naming patterns', () => {
      expect(
        resolveModelVendor({ id: 'DeepSeek-V4-Flash', api: 'openai-completions' }, mockProvider),
      ).toBe('DeepSeek')

      expect(
        resolveModelVendor({ id: 'Qwen3.8-27B', api: 'openai-completions' }, mockProvider),
      ).toBe('通义千问')

      expect(
        resolveModelVendor({ id: 'GLM-5.3-Flash', api: 'openai-completions' }, mockProvider),
      ).toBe('智谱 AI')

      expect(
        resolveModelVendor({ id: 'Gemma 4 31B', api: 'openai-completions' }, mockProvider),
      ).toBe('Google Gemma')

      expect(
        resolveModelVendor({ id: 'MiMo-V2.6-Flash', api: 'openai-completions' }, mockProvider),
      ).toBe('小米 (Xiaomi)')

      expect(
        resolveModelVendor({ id: 'MinerU2.5-Pro', api: 'openai-completions' }, mockProvider),
      ).toBe('MinerU')

      expect(
        resolveModelVendor({ id: 'MiniCPM-V-4.7-1B', api: 'openai-completions' }, mockProvider),
      ).toBe('面壁智能 (OpenBMB)')
    })

    it('falls back to provider displayName when vendor cannot be inferred', () => {
      const model: DesktopProviderModelDefinition = {
        id: 'Clef',
        api: 'openai-completions',
      }
      expect(resolveModelVendor(model, mockProvider)).toBe('My Custom Provider')
    })
  })

  describe('resolveModelCapabilities', () => {
    it('detects reasoning capability', () => {
      const model: DesktopProviderModelDefinition = {
        id: 'deepseek-r1',
        api: 'openai-completions',
      }
      const caps = resolveModelCapabilities(model)
      expect(caps.some((c) => c.key === 'reasoning')).toBe(true)
    })

    it('detects vision capability from name or input', () => {
      const modelWithName: DesktopProviderModelDefinition = {
        id: 'DeepSeek-V4-Flash-Vision-Exp',
        api: 'openai-completions',
      }
      expect(resolveModelCapabilities(modelWithName).some((c) => c.key === 'vision')).toBe(true)

      const modelWithInput: DesktopProviderModelDefinition = {
        id: 'custom-model',
        api: 'openai-completions',
        input: ['text', 'image'],
      }
      expect(resolveModelCapabilities(modelWithInput).some((c) => c.key === 'vision')).toBe(true)
    })

    it('detects audio capability', () => {
      const model: DesktopProviderModelDefinition = {
        id: 'OmniVoice',
        api: 'openai-completions',
      }
      expect(resolveModelCapabilities(model).some((c) => c.key === 'audio')).toBe(true)
    })

    it('detects embedding capability', () => {
      const model: DesktopProviderModelDefinition = {
        id: 'text-embedding-3-small',
        modelType: 'embedding',
        api: 'openai-completions',
      }
      const caps = resolveModelCapabilities(model)
      expect(caps.some((c) => c.key === 'embedding')).toBe(true)
      expect(caps.some((c) => c.key === 'tools')).toBe(false)
    })

    it('falls back to general chat when no specific capability matched', () => {
      const model: DesktopProviderModelDefinition = {
        id: 'simple-model',
        tools: false,
        api: 'openai-completions',
      }
      const caps = resolveModelCapabilities(model)
      expect(caps.some((c) => c.key === 'chat')).toBe(true)
    })
  })

  describe('resolveModelContextWindow', () => {
    it('uses explicit model contextWindow', () => {
      const model: DesktopProviderModelDefinition = {
        id: 'model-1',
        contextWindow: 65536,
        api: 'openai-completions',
      }
      expect(resolveModelContextWindow(model)).toBe(65536)
    })

    it('does not infer context length from the model id', () => {
      expect(resolveModelContextWindow({ id: 'model-128k', api: 'openai-completions' })).toBeNull()
      expect(resolveModelContextWindow({ id: 'model-1m', api: 'openai-completions' })).toBeNull()
    })

    it('does not fall back to a 32K placeholder', () => {
      const model: DesktopProviderModelDefinition = {
        id: 'unknown-context',
        api: 'openai-completions',
      }
      expect(resolveModelContextWindow(model)).toBeNull()
    })
  })
})

it('点击行展开详情且不触发添加，右侧按钮独立触发添加/移除且无左侧折叠箭头或拖拽添加', () => {
  expect(modelPrice(undefined)).toBe('未知')
  expect(modelPrice(0)).toBe('免费')
  let toggles = 0
  let expands = 0
  const wrapper = DiscoveredModelRow({
    model: {
      id: 'example',
      api: 'openai-completions',
      cost: { input: 0 },
      catalog: {
        input: ['text', 'pdf'],
        output: ['text'],
        priceSource: { kind: 'reference', providerId: 'maker' },
      },
    },
    provider: { providerID: 'gateway', kind: 'custom', defaultModels: [], apiKeyConfigured: true },
    isAdded: false,
    isToggling: false,
    expanded: true,
    onToggleModel: () => {
      toggles++
    },
    onToggleExpand: () => {
      expands++
    },
  }) as React.ReactElement<React.ComponentProps<typeof ProviderModelListRow>>
  const row = ProviderModelListRow(wrapper.props) as React.ReactElement<{
    draggable?: boolean
    children: [
      React.ReactElement<{
        children: [React.ReactElement, React.ReactElement, React.ReactElement]
      }>,
      React.ReactElement | null,
    ]
  }>
  expect(row.props.draggable).toBeUndefined()
  const [header] = row.props.children
  const [, expandBtn, actionTooltip] = header.props.children
  ;(expandBtn.props as { onClick: () => void }).onClick()
  expect(expands).toBe(1)
  expect(toggles).toBe(0)
  const actionBtn = (actionTooltip as React.ReactElement<{ children: React.ReactElement }>).props.children
  ;(actionBtn.props as { onClick: () => void }).onClick()
  expect(toggles).toBe(1)
  expect(expands).toBe(1)
  const html = renderToStaticMarkup(wrapper)
  expect(html).toContain('aria-expanded="true"')
  expect(html).toContain('aria-label="添加模型 example"')
  expect(html).not.toContain('draggable="true"')
  expect(html).not.toContain('role="checkbox"')
  expect(html).toContain('原厂参考价')
  expect(html).toContain('当前客户端暂未支持原生发送')
  expect(html).toContain('输出 未知')
  expect(html).toContain('128K')
  expect(html).toContain('8K')
})

it('左侧已配置模型行共用同款展开详情与能力徽章，且点击行不误触编辑', () => {
  let expands = 0
  let edits = 0
  let removes = 0
  const wrapper = ModelRowItem({
    modelId: 'example',
    model: {
      id: 'example',
      name: 'Example Pro',
      api: 'openai-completions',
      reasoning: true,
      cost: { input: 2, output: 8 },
    },
    disabled: false,
    enabled: false,
    expanded: true,
    onToggleExpand: () => {
      expands++
    },
    onTest: () => {},
    onEdit: () => {
      edits++
    },
    onRemove: () => {
      removes++
    },
    editingDisabled: false,
  }) as React.ReactElement<React.ComponentProps<typeof ProviderModelListRow>>
  const row = ProviderModelListRow(wrapper.props) as React.ReactElement<{
    children: [
      React.ReactElement<{
        children: [React.ReactElement, React.ReactElement, React.ReactElement]
      }>,
      React.ReactElement | null,
    ]
  }>
  const [header] = row.props.children
  const [, expandBtn, actionGroup] = header.props.children
  ;(expandBtn.props as { onClick: () => void }).onClick()
  expect(expands).toBe(1)
  expect(edits).toBe(0)
  const actionTooltips = (
    actionGroup as React.ReactElement<{
      children: [null | React.ReactElement, React.ReactElement, React.ReactElement, React.ReactElement]
    }>
  ).props.children
  const editBtn = (actionTooltips[2] as React.ReactElement<{ children: React.ReactElement }>).props
    .children
  ;(editBtn.props as { onClick: () => void }).onClick()
  expect(edits).toBe(1)
  const removeBtn = (actionTooltips[3] as React.ReactElement<{ children: React.ReactElement }>)
    .props.children
  ;(removeBtn.props as { onClick: () => void }).onClick()
  expect(removes).toBe(1)
  const html = renderToStaticMarkup(wrapper)
  expect(html).toContain('model-center-model-row')
  expect(html).toContain('aria-expanded="true"')
  expect(html).toContain('aria-label="编辑模型 example"')
  expect(html).toContain('aria-label="移除模型 example"')
  expect(html).toContain('已停用')
  expect(html).toContain('未知 / 未知')
  expect(html).toContain('输入 $2 / 输出 $8')
})

it('未匹配或缺失规格候选保留已知字段并补齐通用默认参数', () => {
  const partial = resolveCandidateImportModel({
    id: 'auto/dfmodel',
    api: 'openai-completions',
    contextWindow: 1_000_000,
    reasoning: true,
  })
  expect(partial.contextWindow).toBe(1_000_000)
  expect(partial.maxTokens).toBe(GENERIC_MODEL_MAX_TOKENS)
  expect(partial.reasoning).toBe(true)
  expect(partial.tools).toBe(true)
  expect(partial.input).toEqual(['text'])

  const bare = resolveCandidateImportModel({
    id: 'embed-model',
    modelType: 'embedding',
    api: 'openai-completions',
  })
  expect(bare.contextWindow).toBe(GENERIC_MODEL_CONTEXT_WINDOW)
  expect(bare.maxTokens).toBe(GENERIC_MODEL_MAX_TOKENS)
  expect(bare.tools).toBe(false)
})

it('支持状态与能力组合筛选', () => {
  const provider: DesktopModelProviderSummary = {
    providerID: 'gateway',
    kind: 'custom',
    displayName: 'Gateway',
    defaultModels: [],
    apiKeyConfigured: true,
  }
  const models: DesktopProviderModelDefinition[] = [
    { id: 'deepseek-r1', api: 'openai-completions', reasoning: true },
    { id: 'qwen-vl', api: 'openai-completions', input: ['text', 'image'] },
    { id: 'glm-5', api: 'openai-completions', reasoning: true, input: ['text', 'image'] },
  ]
  const filtered = filterDiscoveredModels(models, {
    query: '',
    statusFilter: 'unadded',
    capabilityFilters: new Set(['reasoning', 'vision']),
    addedIds: new Set(['deepseek-r1']),
    provider,
    modelMetadata: {},
  })
  expect(filtered.map((m) => m.id)).toEqual(['glm-5'])
})

it('模型资料只渲染安全链接，独立音频单价明确标注估算限制', () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelCatalogDetails, {
      model: {
        id: 'example',
        api: 'openai-completions',
        catalog: {
          inputAudioCost: 5,
          links: [{ url: 'javascript:alert(1)', label: 'unsafe' }],
        },
      },
    }),
  )
  expect(html).not.toContain('href="javascript:')
  expect(html).toContain('未作为额外分项加入当前费用估算')
})
