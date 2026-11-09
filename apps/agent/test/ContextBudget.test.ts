import { describe, expect, test } from 'bun:test'
import { fauxAssistantMessage, fauxProvider, type Context } from '@earendil-works/pi-ai'
import { contextBudget, RequestContextUsage } from '../src/context/ContextBudget'

const model = fauxProvider({
  models: [{ id: 'budget', contextWindow: 200_000, maxTokens: 64_000 }],
}).getModel()

describe('request context budget', () => {
  test('reserves the configured output, SDK headroom and a smaller explicit input limit', () => {
    expect(contextBudget(model)).toMatchObject({
      outputReserveTokens: 64_000,
      inputBudgetTokens: 131_904,
      triggerTokens: 131_904,
      targetTokens: 110_000,
    })
    expect(contextBudget({ ...model, maxInputTokens: 90_000 })).toMatchObject({
      inputBudgetTokens: 90_000,
      triggerTokens: 90_000,
      targetTokens: 89_999,
    })
    // 官方最大输出等于上下文时，输出预留按半窗截断，仍为输入留出空间。
    expect(contextBudget({ ...model, maxTokens: 200_000 })).toMatchObject({
      outputReserveTokens: 97_952,
      inputBudgetTokens: 97_952,
      triggerTokens: 97_952,
      targetTokens: 97_951,
    })
    // 显式无效规格仍报清晰配置错误。
    expect(() => contextBudget({ ...model, maxTokens: 0 })).toThrow('模型输入与输出额度')
    expect(() => contextBudget({ ...model, maxTokens: -1 })).toThrow('模型输入与输出额度')
    expect(() => contextBudget({ ...model, maxInputTokens: 0 })).toThrow('模型输入与输出额度')
  })

  test('output reserve is capped at half the available window, input never goes negative', () => {
    const hugeOutput = fauxProvider({
      models: [{ id: 'huge', contextWindow: 200_000, maxTokens: 10_000_000 }],
    }).getModel()
    expect(contextBudget(hugeOutput)).toMatchObject({
      outputReserveTokens: 97_952,
      inputBudgetTokens: 97_952,
    })
    // 用户降低有效窗口后，预算不超过新窗口。
    expect(contextBudget(hugeOutput, 64_000)).toMatchObject({
      outputReserveTokens: 29_952,
      inputBudgetTokens: 29_952,
      triggerTokens: 29_952,
    })
  })

  test('calculates effective window budget with maxContextTokens and preserves headroom for large maxTokens', () => {
    const millionModel = fauxProvider({
      models: [{ id: 'large', contextWindow: 1_000_000, maxTokens: 8_192 }],
    }).getModel()

    expect(contextBudget(millionModel)).toMatchObject({
      contextWindowTokens: 1_000_000,
      inputBudgetTokens: 987_712,
      triggerTokens: 800_000,
      targetTokens: 550_000,
    })

    expect(contextBudget(millionModel, 500_000)).toMatchObject({
      contextWindowTokens: 1_000_000,
      outputReserveTokens: 8_192,
      inputBudgetTokens: 487_712,
      triggerTokens: 400_000,
      targetTokens: 275_000,
    })

    const largeOutputModel = fauxProvider({
      models: [{ id: 'large-output', contextWindow: 1_000_000, maxTokens: 128_000 }],
    }).getModel()

    expect(() => contextBudget(largeOutputModel, 128_000)).not.toThrow()
    expect(contextBudget(largeOutputModel, 128_000)).toMatchObject({
      contextWindowTokens: 1_000_000,
      outputReserveTokens: 61_952,
      inputBudgetTokens: 61_952,
      triggerTokens: 61_952,
      targetTokens: 61_951,
    })

    expect(() => contextBudget(largeOutputModel, 200_000)).not.toThrow()
    expect(contextBudget(largeOutputModel, 200_000)).toMatchObject({
      contextWindowTokens: 1_000_000,
      outputReserveTokens: 97_952,
      inputBudgetTokens: 97_952,
      triggerTokens: 97_952,
      targetTokens: 97_951,
    })
  })

  test('anchors real cache-inclusive usage, estimates new tool results and invalidates changed requests', () => {
    const usage = new RequestContextUsage()
    const request: Context = {
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    }
    const identity = usage.identity(model, request, 'session:boundary')
    const response = fauxAssistantMessage('tool request')
    response.usage = {
      ...response.usage,
      input: 100,
      cacheRead: 900,
      cacheWrite: 10,
      output: 20,
      totalTokens: 1030,
    }
    const anchor = usage.measured(request, identity, response)!
    const next: Context = {
      ...request,
      messages: [
        ...request.messages,
        response,
        {
          role: 'toolResult',
          toolCallId: 'tool',
          toolName: 'read',
          content: [{ type: 'text', text: 'x'.repeat(4000) }],
          isError: false,
          timestamp: 2,
        },
      ],
    }
    expect(usage.estimate(next, identity)).toBe(2030)
    expect(JSON.stringify(anchor)).not.toContain('tool request')
    const restored = new RequestContextUsage(anchor)
    expect(restored.estimate(next, identity)).toBe(2030)
    expect(
      restored.estimate(
        next,
        restored.identity({ ...model, id: 'other-model' }, next, 'session:boundary'),
      ),
    ).not.toBe(2030)
    expect(
      restored.estimate(next, restored.identity(model, next, 'session:new-boundary')),
    ).not.toBe(2030)
    expect(
      usage.measured(next, identity, fauxAssistantMessage([], { stopReason: 'error' })),
    ).toBeNull()
    expect(usage.estimate(next, identity)).toBe(2030)
    const changed = { ...next, messages: next.messages.slice(1) }
    expect(usage.estimate(changed, identity)).not.toBe(2030)
  })

  test('media size does not count base64 as text', () => {
    const usage = new RequestContextUsage()
    const context: Context = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: 'x'.repeat(1_000_000), mimeType: 'image/png' }],
          timestamp: 1,
        },
      ],
    }
    expect(usage.estimate(context, '')).toBeLessThan(2000)
  })
})
