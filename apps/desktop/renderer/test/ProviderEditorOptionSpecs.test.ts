import { describe, expect, test } from 'bun:test'
import type { DesktopProviderModelDefinition } from '../shared/Types.js'
import {
  editableModel,
  resolveDiscoveryChatApi,
  normalizeEditableModel,
  parseReasoningLevelValues,
} from '../src/features/models/provider-management/ProviderEditorForm.js'

function definition(
  overrides: Partial<DesktopProviderModelDefinition> = {},
): DesktopProviderModelDefinition {
  return {
    id: 'example-model',
    api: 'openai-completions',
    name: 'Example',
    enabled: true,
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as unknown as DesktopProviderModelDefinition
}

describe('parseReasoningLevelValues', () => {
  test('按行/逗号拆分，保留顺序并去重、丢弃空项', () => {
    expect(parseReasoningLevelValues('none\nlow, high\n\n low \nmax,')).toEqual([
      'none',
      'low',
      'high',
      'max',
    ])
    expect(parseReasoningLevelValues('')).toEqual([])
    expect(parseReasoningLevelValues('  \n  ')).toEqual([])
  })
})

describe('ProviderEditor optionSpecs 往返', () => {
  test('editableModel 将 optionSpecs 展平到可编辑字段', () => {
    const editable = editableModel(
      definition({
        optionSpecs: {
          reasoningLevel: {
            values: ['none', 'low', 'high', 'max'],
            map: '{"reasoning_effort": reasoningLevel}',
          },
          maxOutputTokens: { max: 64_000, map: '{"max_tokens": maxOutputTokens}' },
        },
      }),
    )
    expect(editable.reasoningLevelValues).toBe('none\nlow\nhigh\nmax')
    expect(editable.reasoningLevelMap).toBe('{"reasoning_effort": reasoningLevel}')
    expect(editable.maxOutputTokensMax).toBe(64_000)
    expect(editable.maxOutputTokensMap).toBe('{"max_tokens": maxOutputTokens}')
  })

  test('normalizeEditableModel 回写驼峰 optionSpecs，去重保序并省略空字段', () => {
    const editable = editableModel(definition())
    const normalized = normalizeEditableModel({
      ...editable,
      reasoningLevelValues: 'none\nlow\nhigh\nlow\nmax',
      reasoningLevelMap: '{"reasoning_effort": reasoningLevel}',
      maxOutputTokensMax: 32_000,
      maxOutputTokensMap: '',
    })
    expect(normalized).not.toBeInstanceOf(Error)
    const optionSpecs = (normalized as DesktopProviderModelDefinition).optionSpecs
    expect(optionSpecs).toEqual({
      reasoningLevel: {
        values: ['none', 'low', 'high', 'max'],
        map: '{"reasoning_effort": reasoningLevel}',
      },
      maxOutputTokens: { max: 32_000 },
    })
  })

  test('全部为空时不写入 optionSpecs', () => {
    const editable = editableModel(definition())
    const normalized = normalizeEditableModel({
      ...editable,
      reasoningLevelValues: '',
      reasoningLevelMap: '',
      maxOutputTokensMax: 0,
      maxOutputTokensMap: '',
    })
    expect(normalized).not.toBeInstanceOf(Error)
    expect((normalized as DesktopProviderModelDefinition).optionSpecs).toBeUndefined()
  })

  test('Max Output Tokens 越界不再静默钳制，而是返回可见校验错误', () => {
    const editable = editableModel(definition())
    const overLimit = normalizeEditableModel({ ...editable, maxOutputTokensMax: Number.MAX_SAFE_INTEGER + 1 })
    expect(overLimit).toBeInstanceOf(Error)
    expect((overLimit as Error).message).toContain('整数范围')
    const nonInteger = normalizeEditableModel({ ...editable, maxOutputTokensMax: 1.5 })
    expect(nonInteger).toBeInstanceOf(Error)
    expect((nonInteger as Error).message).toContain('正整数')
  })
})


test('上下文支持 1,048,576 和 1.5 亿，仍拒绝无法精确表示的整数', () => {
  for (const contextWindow of [1_048_576, 150_000_000]) {
    const normalized = normalizeEditableModel(editableModel(definition({ contextWindow })))
    expect(normalized).not.toBeInstanceOf(Error)
    expect((normalized as DesktopProviderModelDefinition).contextWindow).toBe(contextWindow)
  }
  expect(normalizeEditableModel(editableModel(definition({ contextWindow: Number.MAX_SAFE_INTEGER + 1 })))).toBeInstanceOf(Error)
})


test('模型发现复用聊天协议筛选，跳过非聊天和不支持的协议', () => {
  expect(resolveDiscoveryChatApi([])).toBe('openai-completions')
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']) {
    expect(resolveDiscoveryChatApi([
      { api: 'openai-responses', modelType: 'embedding' },
      { api: 'unknown-api', modelType: 'chat' },
      { api, modelType: 'chat' },
      { api: 'openai-completions' },
    ])).toBe(api)
  }
  expect(resolveDiscoveryChatApi([{ api: 'unknown-api' }, { api: 'openai-responses', modelType: 'rerank' }]))
    .toBe('openai-completions')
  expect(resolveDiscoveryChatApi([{ api: 'anthropic-messages' }, { api: 'openai-responses' }]))
    .toBe('anthropic-messages')
})
