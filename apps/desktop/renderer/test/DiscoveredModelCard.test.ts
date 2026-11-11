import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiscoveredModelCard } from '../src/features/models/provider-management/ProviderModelsSection.js'
import { ModelCatalogDetails, modelPrice } from '../src/features/models/provider-management/ModelCatalogDetails.js'
import { describe, expect, it } from 'bun:test'
import type {
  DesktopModelProviderSummary,
  DesktopProviderModelDefinition,
} from '../shared/Types.js'
import {
  resolveModelCapabilities,
  resolveModelContextWindow,
  resolveModelVendor,
} from '../src/features/models/provider-management/ProviderModelsSection.js'

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
      expect(
        resolveModelContextWindow({ id: 'model-128k', api: 'openai-completions' }),
      ).toBeNull()
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


it('摘要价格区分未知与免费，展开按钮与添加按钮互不触发', () => {
  expect(modelPrice(undefined)).toBe('未知')
  expect(modelPrice(0)).toBe('免费')
  let toggles = 0
  let expands = 0
  const card = DiscoveredModelCard({
    model: { id: 'example', api: 'openai-completions', cost: { input: 0 },
      catalog: { input: ['text', 'pdf'], output: ['text'], priceSource: { kind: 'reference', providerId: 'maker' } } },
    provider: { providerID: 'gateway', kind: 'custom', defaultModels: [], apiKeyConfigured: true },
    isSelected: false, isToggling: false, expanded: true,
    onToggle: () => { toggles++ }, onExpand: () => { expands++ },
  }) as React.ReactElement<{ children: React.ReactElement[] }>
  const [selection, disclosure] = card.props.children
  ;(disclosure!.props as { onClick: () => void }).onClick()
  expect(expands).toBe(1)
  expect(toggles).toBe(0)
  ;(selection!.props as { onClick: () => void }).onClick()
  expect(toggles).toBe(1)
  const html = renderToStaticMarkup(card)
  expect(html).toContain('aria-expanded="true"')
  expect(html).toContain('原厂参考价')
  expect(html).toContain('当前客户端暂未支持原生发送')
  expect(html).toContain('输出 未知')
  expect(html.match(/role="checkbox"/g)).toHaveLength(1)
})

it('模型资料只渲染安全链接，独立音频单价明确标注估算限制', () => {
  const html = renderToStaticMarkup(React.createElement(ModelCatalogDetails, { model: {
    id: 'example', api: 'openai-completions', catalog: {
      inputAudioCost: 5, links: [{ url: 'javascript:alert(1)', label: 'unsafe' }],
    },
  } }))
  expect(html).not.toContain('href="javascript:')
  expect(html).toContain('未作为额外分项加入当前费用估算')
})
