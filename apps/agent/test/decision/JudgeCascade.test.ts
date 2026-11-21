import { describe, expect, test } from 'bun:test'
import type { DecisionQuestions } from '@pidex/shared/decision'
import { JudgeError } from '../../src/decision/DecisionErrors'
import { Judge, type JudgeProvider } from '../../src/decision/Judge'
import { CascadeJudge } from '../../src/decision/JudgeCascade'
import { MockJudgeProvider } from '../../src/decision/providers/MockJudgeProvider'

const questions: DecisionQuestions = {
  classify: { type: 'boolean', instructions: 'classify this' },
  rate: { type: 'score', instructions: 'rate this', criteria: ['low', 'high'] },
}

const scripted = (id: string, probability: number): Judge =>
  new Judge({
    provider: new MockJudgeProvider({
      id,
      answers: {
        classify: { type: 'boolean', probability },
        rate: { type: 'score', score: 1 },
      },
    }),
  })

const failing = (id: string, kind: JudgeError['kind']): Judge =>
  new Judge({
    provider: {
      id,
      evaluate: async () => {
        throw new JudgeError(kind, 'down')
      },
    } satisfies JudgeProvider,
  })

describe('CascadeJudge', () => {
  test('能力过滤：不被信任的题跳过该层，全部不信任时给中性答案', async () => {
    const cascade = new CascadeJudge([
      { judge: scripted('fast', 0.95), profile: { capabilities: { rate: false } } },
    ])
    const result = await cascade.evaluate({ state: {}, questions })
    expect(result.answers.classify).toMatchObject({
      type: 'boolean',
      probability: 0.95,
      judge: 'fast',
    })
    expect(result.answers.rate).toMatchObject({ judge: 'untrusted' })
    expect(result.tiers?.[0]).toMatchObject({ judgeId: 'fast', asked: 1, kept: 1 })
  })

  test('不确定答案升级到下一层，确定答案保留', async () => {
    const cascade = new CascadeJudge([
      { judge: scripted('fast', 0.5) },
      { judge: scripted('deep', 0.95) },
    ])
    const result = await cascade.evaluate({ state: {}, questions })
    expect(result.answers.classify).toMatchObject({ probability: 0.95, judge: 'deep' })
    expect(result.tiers?.map((tier) => [tier.judgeId, tier.asked, tier.kept])).toEqual([
      ['fast', 2, 1],
      ['deep', 1, 1],
    ])
    expect(result.usage.inputTokens).toBeDefined()
  })

  test('后续层全部失败时保留前层的不确定答案', async () => {
    const cascade = new CascadeJudge([
      { judge: scripted('fast', 0.5) },
      { judge: failing('deep', 'server') },
    ])
    const result = await cascade.evaluate({ state: {}, questions })
    expect(result.answers.classify).toMatchObject({ probability: 0.5, judge: 'fast' })
    expect(result.tiers?.[1]).toMatchObject({ judgeId: 'deep', error: 'server' })
  })

  test('所有层失败时抛出最有信息量的错误，瞬时错误优先于持久错误', async () => {
    const cascade = new CascadeJudge([
      { judge: failing('fast', 'timeout') },
      { judge: failing('deep', 'auth') },
    ])
    await expect(cascade.evaluate({ state: {}, questions })).rejects.toMatchObject({
      kind: 'timeout',
    })
  })

  test('多层统计合并 usage 与 requests', async () => {
    const cascade = new CascadeJudge([
      { judge: scripted('fast', 0.5) },
      { judge: scripted('deep', 0.9) },
    ])
    const result = await cascade.evaluate({ state: {}, questions })
    expect(result.requests).toBe(2)
    expect(result.providerId).toBe('cascade(fast>deep)')
    expect(result.tiers).toHaveLength(2)
  })
})
