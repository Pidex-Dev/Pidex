import { describe, expect, test } from 'bun:test'
import {
  resolveModelOptionSpecs,
  resolveModelOptionSpecsFrom,
} from '../src/provider/runtime/ModelOptionRules'
import type { OptionRule } from '../src/provider/runtime/CatalogV2'

describe('ModelOptionRules — 静态规则匹配与覆盖', () => {
  test('后匹配的通用层覆盖先匹配层（通用顺序）', () => {
    const rules: OptionRule[] = [
      {
        modelMatch: '.*',
        optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } },
      },
      {
        modelMatch: '.*glm-5.*',
        optionSpecs: {
          reasoningLevel: {
            values: ['low', 'high', 'max'],
            map: '{"reasoning_effort": reasoningLevel}',
          },
        },
      },
    ]
    const out = resolveModelOptionSpecsFrom(rules, {
      modelId: 'glm-5-air',
      api: 'openai-completions',
    })
    expect(out?.reasoningLevel).toEqual({
      values: ['low', 'high', 'max'],
      map: '{"reasoning_effort": reasoningLevel}',
    })
  })

  test('apiTypeMatch 使用协议别名，且 baseUrlMatch 必须命中', () => {
    const rules: OptionRule[] = [
      {
        modelMatch: 'glm-5\\.3-flash',
        apiTypeMatch: 'openai-chat-completions',
        baseUrlMatch: 'https://opencode\\.ai/zen/go/v1/?',
        optionSpecs: { maxOutputTokens: { max: 131072, map: '{"max_tokens": maxOutputTokens}' } },
      },
    ]
    expect(
      resolveModelOptionSpecsFrom(rules, {
        modelId: 'glm-5.3-flash',
        api: 'openai-completions',
        baseUrl: 'https://opencode.ai/zen/go/v1',
      })?.maxOutputTokens,
    ).toEqual({ max: 131072, map: '{"max_tokens": maxOutputTokens}' })
    expect(
      resolveModelOptionSpecsFrom(rules, {
        modelId: 'glm-5.3-flash',
        api: 'openai-completions',
        baseUrl: 'https://other.example/v1',
      }),
    ).toBeUndefined()
  })

  test('未命中任何规则返回 undefined（不做裸名模糊合并）', () => {
    const rules: OptionRule[] = [
      {
        modelMatch: 'glm-5',
        optionSpecs: { reasoningLevel: { values: ['low', 'high'] } },
      },
    ]
    expect(
      resolveModelOptionSpecsFrom(rules, { modelId: 'glm-5-air', api: 'openai-completions' }),
    ).toBeUndefined()
  })

  test('真实静态数据：已知模型能解析出思考 values', () => {
    const out = resolveModelOptionSpecs({ modelId: 'glm-5', api: 'openai-completions' })
    expect(out?.reasoningLevel?.values?.length).toBeGreaterThan(0)
  })
})
