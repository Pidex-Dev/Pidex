import { describe, expect, test } from 'bun:test'
import type { DecisionQuestions } from '@pidex/shared/decision'
import { JudgeError } from '../../src/decision/DecisionErrors'
import {
  decisionsEndpoint,
  isOpenAIAddress,
  OpenAIDecisionsJudgeProvider,
} from '../../src/decision/providers/OpenAIDecisionsJudgeProvider'

const questions: DecisionQuestions = {
  requested: {
    type: 'boolean',
    instructions: 'Was this requested?',
    criteria: { true: 'the user asked for it', false: 'the model invented it' },
  },
  kind: {
    type: 'choice',
    instructions: 'pick',
    criteria: { needed: null, unrelated: 'off topic', unclear: null },
  },
  risk: { type: 'score', instructions: 'rate', criteria: ['low', 'high'] },
}

const okBody = {
  model: 'gpt-6-luna',
  answers: [
    { name: 'requested', type: 'predicate', probability: 0.9 },
    {
      name: 'kind',
      type: 'choice',
      choice: 'needed',
      probabilities: [{ value: 'needed', probability: 0.8 }],
    },
    {
      name: 'risk',
      type: 'score',
      score: 0.5,
      probabilities: [
        { value: 0, probability: 0.5 },
        { value: 1, probability: 0.5 },
      ],
    },
  ],
  usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } },
}

const captureFetch = (body: unknown, status = 200) => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('OpenAIDecisionsJudgeProvider', () => {
  test('boolean→predicate、choice→choice、score→score 请求映射与用量解析', async () => {
    const { calls, impl } = captureFetch(okBody)
    const provider = new OpenAIDecisionsJudgeProvider({ apiKey: 'test-key', fetch: impl })
    const result = await provider.evaluate({ state: { command: 'ls' }, questions })
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      model: string
      input: string
      questions: Array<Record<string, unknown>>
    }
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/decisions')
    expect(body.model).toBe('gpt-6-luna')
    expect(body.questions[0]).toMatchObject({ type: 'predicate', name: 'requested' })
    expect(String(body.questions[0]?.instructions)).toContain('True means: the user asked for it')
    expect(body.questions[1]).toMatchObject({
      type: 'choice',
      choices: [
        { value: 'needed' },
        { value: 'unrelated', description: 'off topic' },
        { value: 'unclear' },
      ],
    })
    expect(body.questions[2]).toMatchObject({
      type: 'score',
      levels: [{ label: 'low' }, { label: 'high' }],
    })
    expect(result.answers.requested).toMatchObject({ type: 'boolean', probability: 0.9 })
    expect(result.answers.kind).toMatchObject({ type: 'choice', choice: 'needed' })
    expect(result.answers.risk).toMatchObject({ type: 'score', score: 0.5 })
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 40,
    })
  })

  test('超过 400 题在发送前拒绝', async () => {
    const many: DecisionQuestions = Object.fromEntries(
      Array.from({ length: 401 }, (_, index) => [
        `q${index}`,
        { type: 'boolean', instructions: 'x' },
      ]),
    )
    const { calls, impl } = captureFetch(okBody)
    const provider = new OpenAIDecisionsJudgeProvider({ apiKey: 'test-key', fetch: impl })
    await expect(provider.evaluate({ state: {}, questions: many })).rejects.toMatchObject({
      kind: 'bad_request',
    })
    expect(calls).toHaveLength(0)
  })

  test('拒答与缺失答案判为 invalid_response', async () => {
    const refusal = {
      answers: [
        { name: 'requested', type: 'refusal' },
        { name: 'kind', type: 'choice', choice: 'needed' },
        { name: 'risk', type: 'score', score: 0 },
      ],
    }
    const provider = new OpenAIDecisionsJudgeProvider({
      apiKey: 'test-key',
      fetch: captureFetch(refusal).impl,
    })
    await expect(provider.evaluate({ state: {}, questions })).rejects.toMatchObject({
      kind: 'invalid_response',
    })
  })

  test('401 判为 auth，错误消息不包含 API Key', async () => {
    const key = '{{API_KEY_yqj7jx7p}}'
    const { impl } = captureFetch({ error: { message: `bad key ${key}` } }, 401)
    const provider = new OpenAIDecisionsJudgeProvider({ apiKey: key, fetch: impl })
    try {
      await provider.evaluate({ state: {}, questions })
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(JudgeError)
      expect((error as JudgeError).kind).toBe('auth')
      expect((error as JudgeError).message).not.toContain(key)
    }
  })

  test('自定义 baseUrl 不回退共享 openai 凭据，端点拼接正确', async () => {
    expect(isOpenAIAddress(undefined)).toBe(true)
    expect(isOpenAIAddress('https://api.openai.com/v1')).toBe(true)
    expect(isOpenAIAddress('https://relay.example.com/v1')).toBe(false)
    expect(decisionsEndpoint('https://relay.example.com')).toBe(
      'https://relay.example.com/v1/decisions',
    )
    expect(decisionsEndpoint('https://relay.example.com/v1')).toBe(
      'https://relay.example.com/v1/decisions',
    )
    expect(decisionsEndpoint('https://relay.example.com/v1/decisions')).toBe(
      'https://relay.example.com/v1/decisions',
    )

    let sharedReads = 0
    const provider = new OpenAIDecisionsJudgeProvider({
      baseUrl: 'https://relay.example.com/v1',
      apiKey: async () => {
        sharedReads += 1
        return undefined
      },
      fetch: captureFetch(okBody).impl,
    })
    await expect(provider.evaluate({ state: {}, questions })).rejects.toMatchObject({
      kind: 'auth',
    })
    expect(sharedReads).toBe(1)
  })
})
