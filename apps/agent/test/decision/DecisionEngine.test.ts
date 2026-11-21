import { describe, expect, test } from 'bun:test'
import type { DecisionLedgerRecord } from '@pidex/shared/decision'
import { DecisionEngine } from '../../src/decision/DecisionEngine'
import { JudgeError } from '../../src/decision/DecisionErrors'
import { ABSTAIN, defineDecision, digestOf } from '../../src/decision/DecisionSpec'
import { threeZone } from '../../src/decision/DecisionPolicy'
import { Judge, type JudgeProvider, type ProviderResponse } from '../../src/decision/Judge'
import { MockJudgeProvider } from '../../src/decision/providers/MockJudgeProvider'

const spec = defineDecision({
  id: 'test.boolean',
  version: 1,
  questions: { requested: { type: 'boolean', instructions: 'Was this requested?' } },
  capabilities: 'classify',
  cacheImpact: 'none',
  latency: 'inline',
  buildState: (input: { text: string }) => ({ text: input.text }),
  policy: (answers) => {
    const verdict = threeZone(answers.requested)
    return verdict === 'unsure' ? ABSTAIN : verdict === 'yes' ? 'allow' : 'confirm'
  },
  fallback: () => 'confirm',
})

const memoryLedger = () => {
  const records: DecisionLedgerRecord[] = []
  return { records, append: (record: DecisionLedgerRecord) => void records.push(record) }
}

const failingProvider = (kind: JudgeError['kind'], id = 'failing'): JudgeProvider => ({
  id,
  evaluate: async () => {
    throw new JudgeError(kind, 'judge failed')
  },
})

describe('DecisionEngine', () => {
  test('off 模式不调用 Judge，直接返回 fallback 且不写账本', async () => {
    let calls = 0
    const provider: JudgeProvider = {
      id: 'counting',
      evaluate: async () => {
        calls += 1
        return { answers: { requested: { type: 'boolean', probability: 0.99 } } }
      },
    }
    const ledger = memoryLedger()
    const engine = new DecisionEngine({
      judge: new Judge({ provider }),
      ledger,
      defaultMode: 'off',
    })
    const decision = await engine.decide(spec, { text: 'rm -rf' })
    expect(decision.outcome).toBe('confirm')
    expect(decision.source).toBe('fallback')
    expect(decision.reason).toBe('off')
    expect(calls).toBe(0)
    expect(ledger.records).toHaveLength(0)
  })

  test('shadow 模式记录 judged 但仍返回 fallback', async () => {
    const ledger = memoryLedger()
    const engine = new DecisionEngine({
      judge: new Judge({
        provider: new MockJudgeProvider({
          answers: { requested: { type: 'boolean', probability: 0.95 } },
        }),
      }),
      ledger,
      modes: { 'test.boolean': 'shadow' },
    })
    const decision = await engine.decide(spec, { text: 'ls' })
    expect(decision.outcome).toBe('confirm')
    expect(decision.judged).toBe('allow')
    expect(decision.source).toBe('fallback')
    expect(decision.reason).toBe('shadow')
    expect(ledger.records).toHaveLength(1)
    expect(ledger.records[0]?.mode).toBe('shadow')
    expect(ledger.records[0]?.judged).toBe('allow')
    expect(ledger.records[0]?.state).toBeUndefined()
    expect(ledger.records[0]?.stateDigest).toBe(digestOf({ text: 'ls' }))
  })

  test('active 模式采纳 judged；actsInShadow 在 shadow 下也采纳', async () => {
    const judge = new Judge({
      provider: new MockJudgeProvider({
        answers: { requested: { type: 'boolean', probability: 0.95 } },
      }),
    })
    const active = new DecisionEngine({ judge, modes: { 'test.boolean': 'active' } })
    expect((await active.decide(spec, { text: 'ls' })).outcome).toBe('allow')

    const shadowSpec = defineDecision({ ...spec, id: 'test.shadow-acts', actsInShadow: true })
    const shadow = new DecisionEngine({ judge, modes: { 'test.shadow-acts': 'shadow' } })
    const decision = await shadow.decide(shadowSpec, { text: 'ls' })
    expect(decision.outcome).toBe('allow')
    expect(decision.source).toBe('judge')
  })

  test('超时与异常一律 fail-open 到 fallback，并记录错误原因', async () => {
    const hanging: JudgeProvider = {
      id: 'hanging',
      evaluate: () => new Promise<ProviderResponse>(() => {}),
    }
    const ledger = memoryLedger()
    const engine = new DecisionEngine({
      judge: new Judge({ provider: hanging, timeoutMs: 30 }),
      ledger,
      modes: { 'test.boolean': 'active' },
    })
    const decision = await engine.decide(spec, { text: 'ls' })
    expect(decision.outcome).toBe('confirm')
    expect(decision.reason).toBe('error:timeout')
    expect(engine.stats.failures).toBe(1)
    expect(ledger.records[0]?.reason).toBe('error:timeout')

    const broken = new DecisionEngine({
      judge: new Judge({ provider: failingProvider('server') }),
      modes: { 'test.boolean': 'active' },
    })
    expect((await broken.decide(spec, { text: 'ls' })).reason).toBe('error:server')
  })

  test('ABSTAIN 回退 fallback 并计入 abstentions', async () => {
    const ledger = memoryLedger()
    const engine = new DecisionEngine({
      judge: new Judge({ provider: new MockJudgeProvider({ defaultProbability: 0.5 }) }),
      ledger,
      modes: { 'test.boolean': 'active' },
    })
    const decision = await engine.decide(spec, { text: 'ls' })
    expect(decision.outcome).toBe('confirm')
    expect(decision.reason).toBe('abstain')
    expect(engine.stats.abstentions).toBe(1)
  })

  test('recordState 开启时落盘脱敏后的 state/questions，凭据不外泄', async () => {
    const ledger = memoryLedger()
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    const engine = new DecisionEngine({
      judge: new Judge({ provider: new MockJudgeProvider() }),
      ledger,
      modes: { 'test.boolean': 'active' },
      recordState: true,
      knownSecrets: () => [secret],
    })
    await engine.decide(spec, { text: `run with ${secret} and apiKey=abcdef123456` })
    const record = ledger.records[0]!
    expect(JSON.stringify(record.state)).not.toContain(secret)
    expect(JSON.stringify(record.state)).not.toContain('abcdef123456')
    expect(record.state).toBeDefined()
    expect(record.questions).toBeDefined()
  })

  test('decideMany 保持顺序并合并为一条批处理账本记录', async () => {
    const ledger = memoryLedger()
    const engine = new DecisionEngine({
      judge: new Judge({
        provider: new MockJudgeProvider({
          answers: { requested: { type: 'boolean', probability: 0.95 } },
        }),
      }),
      ledger,
      modes: { 'test.boolean': 'active' },
    })
    const inputs = [{ text: 'a' }, { text: 'b' }, { text: 'c' }]
    const decisions = await engine.decideMany(spec, inputs)
    expect(decisions.map((decision) => decision.outcome)).toEqual(['allow', 'allow', 'allow'])
    expect(ledger.records).toHaveLength(1)
    expect(ledger.records[0]?.batch?.size).toBe(3)
    expect(ledger.records[0]?.outcome).toEqual(['allow', 'allow', 'allow'])
    expect(new Set(decisions.map((decision) => decision.ledgerId)).size).toBe(1)
  })

  test('显式配置模式优先；未配置点回落 manifest 默认，再回落引擎默认', async () => {
    const judge = new Judge({
      provider: new MockJudgeProvider({
        answers: { requested: { type: 'boolean', probability: 0.95 } },
      }),
    })
    const engine = new DecisionEngine({
      judge,
      defaultMode: 'off',
      builtInModes: { 'test.boolean': 'active', 'test.other': 'shadow' },
      modes: { 'test.other': 'active' },
    })
    expect(engine.getMode('test.boolean')).toBe('active')
    expect(engine.getMode('test.other')).toBe('active')
    expect(engine.getMode('test.unknown')).toBe('off')
    expect((await engine.decide(spec, { text: 'ls' })).outcome).toBe('allow')
  })

  test('defineDecision 校验版本、逃逸选项与 score 层级', () => {
    expect(() => defineDecision({ ...spec, id: 'bad.version', version: 0 })).toThrow()
    expect(() =>
      defineDecision({
        ...spec,
        id: 'bad.choice',
        questions: {
          pick: { type: 'choice', instructions: 'pick', criteria: { a: null, b: null } },
        },
        policy: () => 'confirm',
      }),
    ).toThrow(/escape option/)
    expect(() =>
      defineDecision({
        ...spec,
        id: 'bad.score',
        questions: { level: { type: 'score', instructions: 'rate', criteria: ['only'] } },
        policy: () => 'confirm',
      }),
    ).toThrow()
  })
})
