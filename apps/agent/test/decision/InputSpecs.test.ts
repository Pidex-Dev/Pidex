import { describe, expect, test, beforeEach } from 'bun:test'
import type { DecisionAnswer } from '@pidex/shared/decision'
import { DecisionEngine } from '../../src/decision/DecisionEngine'
import { Judge } from '../../src/decision/Judge'
import { MockJudgeProvider } from '../../src/decision/providers/MockJudgeProvider'
import {
  applyTaskFrameChange,
  chatByRule,
  clearTaskFrame,
  inputInterjectionSpec,
  inputPreflightSpec,
  resetTaskFrames,
  taskFrameOf,
  taskFrameSpec,
} from '../../src/decision/specs/InputSpecs'
import {
  currentTaskFrame,
  decideInputPreflight,
  decideInterjectionDelivery,
} from '../../src/decision/integrations/InputDecisionAdapter'

const engineWith = (
  answers: Record<string, DecisionAnswer>,
  modes: Record<string, 'off' | 'shadow' | 'active'>,
) =>
  new DecisionEngine({
    judge: new Judge({ provider: new MockJudgeProvider({ answers }) }),
    modes,
  })

const choice = (option: string, probability = 0.9): DecisionAnswer => ({
  type: 'choice',
  choice: option,
  probabilities: { [option]: probability },
})

describe('input.preflight', () => {
  test('问候语按规则判为 chat，无 Judge 时也走轻量档位', async () => {
    expect(chatByRule('你好', false)).toBe(true)
    expect(chatByRule('再试一下', true)).toBe(false)
    const fallback = inputPreflightSpec.fallback({ userMessage: 'thanks!', recentTurns: [] })
    expect(fallback.turnType).toBe('chat')
    expect(fallback.gear).toBe('chat')
    const technical = inputPreflightSpec.fallback({
      userMessage: '修复 ContextManager 的 bug',
      recentTurns: [],
    })
    expect(technical.gear).toBe('standard')
    expect(technical.turnType).toBe('unknown')
  })

  test('active 模式按判定输出档位与复杂度', async () => {
    const engine = engineWith(
      {
        turn_type: choice('research'),
        task_complexity: { type: 'score', score: 3 },
        reasoning_depth: { type: 'score', score: 3 },
        tool_complexity: { type: 'score', score: 2 },
        needs_files_changed: { type: 'boolean', probability: 0.9 },
      },
      { 'input.preflight': 'active' },
    )
    const decision = await engine.decide(inputPreflightSpec, {
      userMessage: '调研整个仓库的存储架构',
      recentTurns: [],
    })
    expect(decision.outcome.turnType).toBe('research')
    expect(decision.outcome.gear).toBe('heavy')
    expect(decision.outcome.complexity.task).toBe(3)
    expect(decision.outcome.sideQuestion).toBe('no')
  })

  test('全部不确定时 ABSTAIN 回退 fallback', async () => {
    const engine = new DecisionEngine({
      judge: new Judge({ provider: new MockJudgeProvider({ defaultProbability: 0.5 }) }),
      modes: { 'input.preflight': 'active' },
    })
    const decision = await engine.decide(inputPreflightSpec, {
      userMessage: 'fix the login timeout bug',
      recentTurns: ['上一轮在修登录'],
      sessionHasWork: true,
    })
    expect(decision.source).toBe('fallback')
    expect(decision.reason).toBe('abstain')
  })
})

describe('task.frame', () => {
  beforeEach(() => resetTaskFrames())

  test('constraint 与 correction 概率合并后判定，无分布时按字面选择', async () => {
    const engine = engineWith(
      {
        change: {
          type: 'choice',
          choice: 'hard_constraint',
          probabilities: { hard_constraint: 0.35, correction: 0.35, no_change: 0.3 },
        },
      },
      { 'task.frame': 'active' },
    )
    const decision = await engine.decide(taskFrameSpec, {
      userMessage: '保留方案，但不要动数据库',
      frame: { goal: '重构存储层', constraints: [] },
      recentTurns: [],
    })
    expect(decision.outcome).toBe('hard_constraint')
    expect(taskFrameSpec.fallback({ userMessage: 'x', frame: null, recentTurns: [] })).toBe(
      'no_change',
    )
  })

  test('框架仅存内存：hard_constraint 只收窄，no_change 不改动，重启即失', () => {
    applyTaskFrameChange('t1', 'new_task', '实现导出功能')
    applyTaskFrameChange('t1', 'hard_constraint', '不要修改 Schema')
    applyTaskFrameChange('t1', 'correction', '不要用轮询')
    const frame = taskFrameOf('t1')!
    expect(frame.goal).toBe('实现导出功能')
    expect(frame.constraints).toEqual(['不要修改 Schema', '不要用轮询'])
    applyTaskFrameChange('t1', 'no_change', '好的')
    expect(taskFrameOf('t1')).toEqual(frame)
    applyTaskFrameChange('t1', 'subgoal', '先写测试')
    expect(taskFrameOf('t1')!.currentSubgoal).toBe('先写测试')
    expect(taskFrameOf('t1')!.constraints).toHaveLength(2)
    clearTaskFrame('t1')
    expect(currentTaskFrame('t1')).toBeNull()
    resetTaskFrames()
    expect(taskFrameOf('t1')).toBeNull()
  })

  test('适配器：无 DecisionService 时行为与现状一致；active 判定更新框架', async () => {
    const plain = await decideInputPreflight(null, {
      messageText: '你好',
      thread: { threadId: 't2', running: false },
    })
    expect(plain.source).toBe('fallback')
    expect(plain.outcome.gear).toBe('chat')
    expect(currentTaskFrame('t2')).toBeNull()
  })
})

describe('input.interjection', () => {
  test('高置信 correction 判 steer，addition 与不确定判 followUp', async () => {
    const steer = engineWith(
      { kind: choice('correction', 0.9) },
      { 'input.interjection': 'active' },
    )
    expect(
      (
        await steer.decide(inputInterjectionSpec, {
          userMessage: '停，方向错了',
          goal: '修复登录',
          currentAction: '正在改写测试',
        })
      ).outcome,
    ).toBe('steer')
    const addition = engineWith(
      { kind: choice('addition', 0.9) },
      { 'input.interjection': 'active' },
    )
    expect(
      (
        await addition.decide(inputInterjectionSpec, {
          userMessage: '之后顺便更新文档',
          goal: '修复登录',
          currentAction: '正在改写测试',
        })
      ).outcome,
    ).toBe('followUp')
    const unsure = engineWith(
      { kind: choice('correction', 0.5) },
      { 'input.interjection': 'active' },
    )
    expect(
      (
        await unsure.decide(inputInterjectionSpec, {
          userMessage: '嗯？',
          goal: '修复登录',
          currentAction: '正在改写测试',
        })
      ).outcome,
    ).toBe('followUp')
    expect(inputInterjectionSpec.fallback({ userMessage: '', goal: '', currentAction: '' })).toBe(
      'followUp',
    )
  })

  test('适配器：非运行中或无引擎时保持用户选择的投递方式', async () => {
    const idle = await decideInterjectionDelivery(null, {
      messageText: '停',
      thread: { threadId: 't3', running: false },
      requestedDelivery: 'steer',
    })
    expect(idle).toEqual({ delivery: 'steer', source: 'fallback' })
    const running = await decideInterjectionDelivery(undefined, {
      messageText: '停',
      thread: { threadId: 't3', running: true },
      requestedDelivery: 'followUp',
    })
    expect(running).toEqual({ delivery: 'followUp', source: 'fallback' })
  })
})
