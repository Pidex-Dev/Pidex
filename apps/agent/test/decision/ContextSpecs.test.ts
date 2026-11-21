import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DecisionAnswer } from '@pidex/shared/decision'
import { DecisionEngine } from '../../src/decision/DecisionEngine'
import { Judge } from '../../src/decision/Judge'
import { MockJudgeProvider } from '../../src/decision/providers/MockJudgeProvider'
import {
  contextCompactSpec,
  contextForgetSpec,
  goalMetSpec,
} from '../../src/decision/specs/ContextSpecs'
import {
  FORGET_MIN_RESULT_CHARS,
  planContextCompaction,
  planContextForget,
} from '../../src/decision/integrations/ContextDecisionAdapter'
import { runGoalAuxiliaryCheck } from '../../src/session/GoalVerifier'
import { ConfigService } from '../../src/config/ConfigService'
import { DecisionService } from '../../src/decision/DecisionService'
import { CONTEXT_MANIFEST } from '../../src/decision/specs/ContextSpecs'
import { AgentDatabase } from '../../src/storage/database/AgentDatabase'
import { removeFixturePaths } from '../FixtureCleanup'
import type { ThreadGoal } from '@pidex/shared/thread'

const engineWith = (
  answers: Record<string, DecisionAnswer>,
  modes: Record<string, 'off' | 'shadow' | 'active'>,
) =>
  new DecisionEngine({
    judge: new Judge({ provider: new MockJudgeProvider({ answers }) }),
    modes,
  })

const bigText = 'x'.repeat(FORGET_MIN_RESULT_CHARS + 100)

const items = () => [
  { role: 'user', content: '修复登录超时', timestamp: 1 },
  {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'cat big.log' } },
    ],
    timestamp: 2,
  },
  {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'bash',
    content: [{ type: 'text', text: bigText }],
    isError: false,
    timestamp: 3,
  },
  { role: 'user', content: '继续', timestamp: 4 },
  { role: 'user', content: '再看看别的', timestamp: 5 },
  {
    role: 'toolResult',
    toolCallId: 'call-2',
    toolName: 'read',
    content: [{ type: 'text', text: 'short' }],
    isError: false,
    timestamp: 6,
  },
]

describe('context.forget / context.compact', () => {
  test('无 DecisionService 时计划保持原样', async () => {
    const forget = await planContextForget(null, { items: items() })
    expect(forget.shrunkToolCallIds).toEqual([])
    expect(forget.items).toEqual(items())
    const compact = await planContextCompaction(undefined, { items: items() })
    expect(compact.verdicts).toEqual([])
    expect(compact.items).toEqual(items())
    expect(
      contextForgetSpec.fallback({ goal: '', call: '', resultChars: 0, ageTurns: 0, since: [] }),
    ).toBe('keep')
  })

  test('active forget 只收缩陈旧大结果，占位符保留调用信息', async () => {
    const decisions = {
      ensureEngine: async () =>
        engineWith(
          { still_needed: { type: 'boolean', probability: 0.1 } },
          { 'context.forget': 'active' },
        ),
    } as unknown as DecisionService
    const plan = await planContextForget(decisions, { items: items() })
    expect(plan.shrunkToolCallIds).toEqual(['call-1'])
    const shrunk = plan.items[2] as { content: Array<{ text: string }> }
    expect(shrunk.content[0]!.text).toContain('bash')
    expect(shrunk.content[0]!.text.length).toBeLessThan(400)
    expect(plan.items[5]).toEqual(items()[5])
    expect(plan.items[0]).toEqual(items()[0])
  })

  test('shadow forget 记录判定但不改动 items', async () => {
    const decisions = {
      ensureEngine: async () =>
        engineWith(
          { still_needed: { type: 'boolean', probability: 0.1 } },
          { 'context.forget': 'shadow' },
        ),
    } as unknown as DecisionService
    const plan = await planContextForget(decisions, { items: items() })
    expect(plan.shrunkToolCallIds).toEqual([])
    expect(plan.items).toEqual(items())
  })

  test('active compact：低保留概率替换结果，错误结果永不收缩', async () => {
    const errorItems = items()
    ;(errorItems[2] as { isError: boolean }).isError = true
    const decisions = {
      ensureEngine: async () =>
        engineWith(
          {
            kind: { type: 'choice', choice: 'log', probabilities: { log: 0.9 } },
            result_needed: { type: 'boolean', probability: 0.1 },
            call_matters: { type: 'boolean', probability: 0.9 },
          },
          { 'context.compact': 'active' },
        ),
    } as unknown as DecisionService
    const kept = await planContextCompaction(decisions, { items: errorItems })
    expect(kept.droppedResultToolCallIds).toEqual([])
    expect(kept.verdicts[0]?.decision.kind).toBe('log')

    const plan = await planContextCompaction(decisions, { items: items() })
    expect(plan.droppedResultToolCallIds).toEqual(['call-1'])
    expect(plan.droppedToolCallIds).toEqual([])

    const dropDecisions = {
      ensureEngine: async () =>
        engineWith(
          {
            kind: { type: 'choice', choice: 'listing', probabilities: { listing: 0.9 } },
            result_needed: { type: 'boolean', probability: 0.05 },
            call_matters: { type: 'boolean', probability: 0.05 },
          },
          { 'context.compact': 'active' },
        ),
    } as unknown as DecisionService
    const dropped = await planContextCompaction(dropDecisions, { items: items() })
    expect(dropped.droppedToolCallIds).toEqual(['call-1'])
    expect(
      dropped.items.some((item) => (item as { toolCallId?: string }).toolCallId === 'call-1'),
    ).toBe(false)
    const assistant = dropped.items[1] as { content: Array<{ id?: string }> }
    expect(assistant.content.some((part) => part.id === 'call-1')).toBe(false)
  })

  test('fallback compact 判定全 null，不触发任何收缩', () => {
    expect(
      contextCompactSpec.fallback({
        goal: '',
        call: '',
        resultHead: '',
        resultChars: 0,
        isError: false,
        since: [],
      }),
    ).toEqual({ kind: null, keepResult: null, keepCall: null })
  })
})

describe('goal.met 辅助判别', () => {
  const goal = { objective: '所有测试通过', status: 'active' } as unknown as ThreadGoal

  test('宿主事实优先：未交付项或未验证改动一律 continue', async () => {
    const engine = engineWith(
      {
        achieved: { type: 'boolean', probability: 0.99 },
        needs_user: { type: 'boolean', probability: 0.01 },
      },
      { 'goal.met': 'active' },
    )
    const blocked = await engine.decide(goalMetSpec, {
      goal: '所有测试通过',
      finalMessage: '全部完成了',
      openItems: 1,
      unverified: false,
    })
    expect(blocked.outcome).toBe('continue')
    const unverified = await engine.decide(goalMetSpec, {
      goal: '所有测试通过',
      finalMessage: '全部完成了',
      openItems: 0,
      unverified: true,
    })
    expect(unverified.outcome).toBe('continue')
    const met = await engine.decide(goalMetSpec, {
      goal: '所有测试通过',
      finalMessage: '全部完成了',
      openItems: 0,
      unverified: false,
    })
    expect(met.outcome).toBe('met')
    expect(
      goalMetSpec.fallback({ goal: '', finalMessage: '', openItems: 0, unverified: false }),
    ).toBe('unjudged')
    expect(
      goalMetSpec.fallback({ goal: '', finalMessage: '', openItems: 2, unverified: false }),
    ).toBe('continue')
  })

  test('未注入或未启用快速预判且结构化核验可用时不调用 Judge', async () => {
    const none = await runGoalAuxiliaryCheck(null, {
      goal,
      finalMessage: '完成了',
      openItems: 0,
      unverified: false,
    })
    expect(none).toEqual({ outcome: 'unjudged', source: 'fallback', enabled: false })

    const roots: string[] = []
    const root = await mkdtemp(join(tmpdir(), 'pidex-goal-aux-'))
    roots.push(root)
    const db = new AgentDatabase(join(root, 'agent.sqlite'))
    const config = new ConfigService(join(root, 'config.json'))
    await config.initialize()
    const decisions = new DecisionService(db, config, {} as never)
    decisions.registerManifest(CONTEXT_MANIFEST)
    try {
      const disabled = await runGoalAuxiliaryCheck(decisions, {
        goal,
        finalMessage: '完成了',
        openItems: 0,
        unverified: false,
      })
      expect(disabled.source).toBe('fallback')
      expect(disabled.enabled).toBe(false)

      await config.batchWrite({
        edits: [
          {
            keyPath: ['decision'],
            value: {
              tiers: ['mock'],
              judges: { mock: { type: 'mock' } },
              modes: { 'goal.met': 'active' },
              routes: {},
              features: { 'goal.met': { fastPrecheck: true } },
              recordState: false,
            } as never,
            mergeStrategy: 'replace',
          },
        ],
        target: { kind: 'user' },
      })
      const enabled = await runGoalAuxiliaryCheck(decisions, {
        goal,
        finalMessage: '完成了',
        openItems: 1,
        unverified: false,
      })
      expect(enabled.enabled).toBe(true)
      expect(enabled.outcome).toBe('continue')
    } finally {
      decisions.dispose()
      await config.dispose()
      db.close()
      await removeFixturePaths(roots)
    }
  })
})

describe('集成面：ContextManager / ContextCompactionService 可选注入', () => {
  test('未注入 DecisionService 时 planForget / planCompaction 保持现状', async () => {
    const roots: string[] = []
    const root = await mkdtemp(join(tmpdir(), 'pidex-context-decision-'))
    roots.push(root)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, '.keep'), '')
    const db = new AgentDatabase(join(root, 'agent.sqlite'))
    try {
      const { ContextManager } = await import('../../src/context/ContextManager')
      const { ContextCompactionService } =
        await import('../../src/context/ContextCompactionService')
      const context = new ContextManager(db)
      const compaction = new ContextCompactionService(db, context)
      const forget = await context.planForget({ threadID: 't', items: items() })
      expect(forget.items).toEqual(items())
      const plan = await compaction.planCompaction({ threadID: 't', items: items() })
      expect(plan.verdicts).toEqual([])
      expect(plan.items).toEqual(items())
    } finally {
      db.close()
      await removeFixturePaths(roots)
    }
  })
})
