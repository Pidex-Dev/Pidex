import { describe, expect, test } from 'bun:test'
import type { Model } from '@pidex/model-schema'
import type { DecisionAnswer } from '@pidex/shared/decision'
import { DecisionEngine } from '../../src/decision/DecisionEngine'
import { Judge } from '../../src/decision/Judge'
import { MockJudgeProvider } from '../../src/decision/providers/MockJudgeProvider'
import {
  pickReasoningLevel,
  reviewPriorityBySeverity,
  reviewPriorityOf,
  reviewTriageSpec,
  swarmRoutingSpec,
} from '../../src/decision/specs/TeamworkSpecs'
import {
  decideReviewTriage,
  routeSubagentSpawn,
} from '../../src/decision/integrations/TeamworkDecisionAdapter'
import type { DecisionService } from '../../src/decision/DecisionService'

const engineWith = (
  answers: Record<string, DecisionAnswer>,
  modes: Record<string, 'off' | 'shadow' | 'active'>,
) =>
  new DecisionEngine({
    judge: new Judge({ provider: new MockJudgeProvider({ answers }) }),
    modes,
  })

const ref = { providerID: 'openai', id: 'gpt-test' } as unknown as Model.Ref

describe('review.triage', () => {
  test('分级矩阵：行为缺陷 + 归因 + 评审 severity', () => {
    expect(reviewPriorityOf('yes', 'yes', 'must')).toBe('P0')
    expect(reviewPriorityOf('yes', 'yes', 'should')).toBe('P1')
    expect(reviewPriorityOf('yes', 'no')).toBe('P2')
    expect(reviewPriorityOf('yes', 'unsure')).toBe('P1')
    expect(reviewPriorityOf('unsure', 'yes', 'must')).toBe('P1')
    expect(reviewPriorityOf('no', 'yes', 'must')).toBe('P2')
    expect(reviewPriorityOf('no', 'yes', 'nit')).toBe('P3')
    expect(reviewPriorityBySeverity('must')).toBe('P1')
    expect(reviewPriorityBySeverity(undefined)).toBe('P2')
    expect(reviewPriorityBySeverity('nit')).toBe('P3')
  })

  test('active 判定按题目归因；fallback 用评审自己的 severity', async () => {
    const findings = [
      { text: '空指针崩溃', where: 'a.ts:10', severity: 'must' as const },
      { text: '命名可以更清楚', severity: 'nit' as const },
    ]
    const engine = engineWith(
      {
        is_bug_0: { type: 'boolean', probability: 0.95 },
        in_scope_0: { type: 'boolean', probability: 0.95 },
        is_bug_1: { type: 'boolean', probability: 0.05 },
        in_scope_1: { type: 'boolean', probability: 0.9 },
      },
      { 'review.triage': 'active' },
    )
    const decision = await engine.decide(reviewTriageSpec, { change: '重构登录', findings })
    expect(decision.outcome.priorities).toEqual(['P0', 'P3'])
    const fallback = reviewTriageSpec.fallback({ change: '重构登录', findings })
    expect(fallback.priorities).toEqual(['P1', 'P3'])
    const none = await decideReviewTriage(null, { change: 'x', findings: [] })
    expect(none).toEqual({ priorities: [], source: 'fallback' })
  })
})

describe('swarm.routing', () => {
  test('推理档位映射只落在模型支持的档位上', () => {
    expect(pickReasoningLevel(3, ['low', 'medium', 'high'])).toBe('high')
    expect(pickReasoningLevel(2.0, ['low', 'medium', 'high'])).toBe('medium')
    expect(pickReasoningLevel(0, ['low', 'medium', 'high'])).toBe('low')
    expect(pickReasoningLevel(3, ['medium'])).toBeNull()
    expect(pickReasoningLevel(3, [])).toBeNull()
    expect(pickReasoningLevel(2.5, ['low', 'high'])).toBe('high')
  })

  test('questionsFor：角色已定则不问角色，无档位阶梯则不问评分', () => {
    const full = swarmRoutingSpec.questionsFor!({
      task: 'x',
      reasoningLevels: ['low', 'high'],
      pickRole: true,
    })
    expect(Object.keys(full).sort()).toEqual(['difficulty', 'reasoning', 'role'])
    const noRole = swarmRoutingSpec.questionsFor!({
      task: 'x',
      reasoningLevels: ['low', 'high'],
      pickRole: false,
    })
    expect(Object.keys(noRole).sort()).toEqual(['difficulty', 'reasoning'])
    const noTiers = swarmRoutingSpec.questionsFor!({ task: 'x', reasoningLevels: [], pickRole: true })
    expect(Object.keys(noTiers)).toEqual(['role'])
    expect(swarmRoutingSpec.fallback({ task: '', reasoningLevels: [] })).toEqual({
      reasoningLevel: null,
      role: null,
    })
  })

  test('active 判定挑选角色与推理档位', async () => {
    const engine = engineWith(
      {
        role: { type: 'choice', choice: 'qa', probabilities: { qa: 0.9 } },
        difficulty: { type: 'score', score: 1 },
        reasoning: { type: 'score', score: 2.6 },
      },
      { 'swarm.routing': 'active' },
    )
    const decision = await engine.decide(swarmRoutingSpec, {
      task: '为登录模块补全测试',
      reasoningLevels: ['low', 'medium', 'high'],
      pickRole: true,
    })
    expect(decision.outcome).toEqual({ reasoningLevel: 'high', role: 'qa' })
  })

  test('spawn 适配器：无引擎/显式角色与档位/shadow 一律保持宿主输入', async () => {
    const request = {
      task: '补测试',
      modelRef: ref,
      roleMissing: true,
      reasoningLevels: ['low', 'medium', 'high'],
    }
    const noService = await routeSubagentSpawn(null, request)
    expect(noService).toEqual({ model: ref, source: 'fallback' })

    const explicit = await routeSubagentSpawn({} as DecisionService, {
      ...request,
      roleMissing: false,
      modelRef: { ...ref, variant: 'high' } as Model.Ref,
      reasoningLevels: [],
    })
    expect(explicit.source).toBe('fallback')

    const shadow = {
      ensureEngine: async () =>
        engineWith(
          {
            role: { type: 'choice', choice: 'qa', probabilities: { qa: 0.9 } },
            reasoning: { type: 'score', score: 3 },
            difficulty: { type: 'score', score: 1 },
          },
          { 'swarm.routing': 'shadow' },
        ),
    } as unknown as DecisionService
    const shadowed = await routeSubagentSpawn(shadow, request)
    expect(shadowed).toEqual({ model: ref, source: 'fallback' })

    const active = {
      ensureEngine: async () =>
        engineWith(
          {
            role: { type: 'choice', choice: 'qa', probabilities: { qa: 0.9 } },
            reasoning: { type: 'score', score: 3 },
            difficulty: { type: 'score', score: 1 },
          },
          { 'swarm.routing': 'active' },
        ),
    } as unknown as DecisionService
    const routed = await routeSubagentSpawn(active, request)
    expect(routed.source).toBe('judge')
    expect(routed.role).toBe('qa')
    expect(String(routed.model.variant)).toBe('high')
    expect(routed.model.providerID).toBe(ref.providerID)
    expect(routed.model.id).toBe(ref.id)

    const settledRole = await routeSubagentSpawn(active, { ...request, roleMissing: false })
    expect(settledRole.role).toBeUndefined()
    expect(String(settledRole.model.variant)).toBe('high')
  })
})