import { describe, expect, test } from 'bun:test'
import { DecisionEngine } from '../../src/decision/DecisionEngine'
import { Judge, type JudgeProvider, type ProviderResponse } from '../../src/decision/Judge'
import { MockJudgeProvider } from '../../src/decision/providers/MockJudgeProvider'
import {
  turnContinueSpec,
  turnCompletionSpec,
  type TurnContinueInput,
  type TurnCompletionInput,
} from '../../src/decision/specs'
import {
  evaluateTurnContinuation,
  evaluateTurnCompletion,
  isVerificationCall,
  MAX_CONTINUATIONS_PER_MESSAGE,
  MAX_COMPLETION_NUDGES_PER_TURN,
  type TurnContinuationInput,
} from '../../src/decision/integrations/TurnDecisionAdapter'

const engineWith = (provider: JudgeProvider, modes: Record<string, 'off' | 'shadow' | 'active'>) =>
  new DecisionEngine({ judge: new Judge({ provider }), modes })

const failing = (): JudgeProvider => ({
  id: 'failing',
  evaluate: async (): Promise<ProviderResponse> => {
    throw new Error('judge down')
  },
})

const bool = (probability: number) => ({ type: 'boolean' as const, probability })

const continueInput: TurnContinueInput = {
  userMessage: '修复登录失败的问题',
  finalMessage: '我已经定位到原因，接下来我会运行测试确认修复。',
}

const promisedAnswers = {
  promised: bool(0.95),
  asks_go_ahead: bool(0.1),
  work_requested: bool(0.9),
  beyond_request: bool(0.1),
  irreversible: bool(0.05),
}

describe('turn.continue', () => {
  test('承诺后续动作判 promised；已授权工作的许可请求判 go_ahead', async () => {
    const promised = engineWith(new MockJudgeProvider({ answers: promisedAnswers }), {
      'turn.continue': 'active',
    })
    expect((await promised.decide(turnContinueSpec, continueInput)).outcome).toBe('promised')
    const goAhead = engineWith(
      new MockJudgeProvider({
        answers: {
          ...promisedAnswers,
          promised: bool(0.1),
          asks_go_ahead: bool(0.95),
        },
      }),
      { 'turn.continue': 'active' },
    )
    expect(
      (
        await goAhead.decide(turnContinueSpec, {
          ...continueInput,
          finalMessage: '修复方案已就绪，要我直接应用吗？',
        })
      ).outcome,
    ).toBe('go_ahead')
  })

  test('不可逆或不确定下一步一律 end；超出用户请求的许可不续跑', async () => {
    const irreversible = engineWith(
      new MockJudgeProvider({
        answers: { ...promisedAnswers, irreversible: bool(0.9) },
      }),
      { 'turn.continue': 'active' },
    )
    expect((await irreversible.decide(turnContinueSpec, continueInput)).outcome).toBe('end')
    const unsureStep = engineWith(
      new MockJudgeProvider({
        answers: { ...promisedAnswers, irreversible: bool(0.5) },
      }),
      { 'turn.continue': 'active' },
    )
    expect((await unsureStep.decide(turnContinueSpec, continueInput)).outcome).toBe('end')
    const beyond = engineWith(
      new MockJudgeProvider({
        answers: {
          ...promisedAnswers,
          promised: bool(0.1),
          asks_go_ahead: bool(0.95),
          beyond_request: bool(0.9),
        },
      }),
      { 'turn.continue': 'active' },
    )
    expect((await beyond.decide(turnContinueSpec, continueInput)).outcome).toBe('end')
  })

  test('shadow 记录 judged 但返回 end；故障 fail-open 到 end', async () => {
    const shadow = engineWith(new MockJudgeProvider({ answers: promisedAnswers }), {
      'turn.continue': 'shadow',
    })
    const decision = await shadow.decide(turnContinueSpec, continueInput)
    expect(decision.outcome).toBe('end')
    expect(decision.judged).toBe('promised')
    const broken = engineWith(failing(), { 'turn.continue': 'active' })
    expect((await broken.decide(turnContinueSpec, continueInput)).outcome).toBe('end')
    expect(turnContinueSpec.fallback(continueInput)).toBe('end')
  })
})

const completionInput: TurnCompletionInput = {
  userMessage: '给 parser 增加空输入处理',
  finalMessage: '已完成修复，所有场景都已覆盖。',
  editedFiles: 2,
  ranVerificationAfterLastEdit: false,
}

describe('turn.completion', () => {
  test('改动后未验证且宣告完成判 nudge；已验证或无改动判 done', async () => {
    const engine = engineWith(
      new MockJudgeProvider({
        answers: { claims_done: bool(0.95), needs_check: bool(0.9) },
      }),
      { 'turn.completion': 'active' },
    )
    expect((await engine.decide(turnCompletionSpec, completionInput)).outcome).toBe('nudge')
    expect(
      (
        await engine.decide(turnCompletionSpec, {
          ...completionInput,
          ranVerificationAfterLastEdit: true,
        })
      ).outcome,
    ).toBe('done')
    expect(
      (await engine.decide(turnCompletionSpec, { ...completionInput, editedFiles: 0 })).outcome,
    ).toBe('done')
  })

  test('未宣告完成或不需要运行验证判 done；fallback 为 done', async () => {
    const engine = engineWith(
      new MockJudgeProvider({
        answers: { claims_done: bool(0.1), needs_check: bool(0.9) },
      }),
      { 'turn.completion': 'active' },
    )
    expect((await engine.decide(turnCompletionSpec, completionInput)).outcome).toBe('done')
    const noCheck = engineWith(
      new MockJudgeProvider({
        answers: { claims_done: bool(0.95), needs_check: bool(0.1) },
      }),
      { 'turn.completion': 'active' },
    )
    expect((await noCheck.decide(turnCompletionSpec, completionInput)).outcome).toBe('done')
    expect(turnCompletionSpec.fallback(completionInput)).toBe('done')
  })
})

const turnInput = (overrides: Partial<TurnContinuationInput> = {}): TurnContinuationInput => ({
  threadId: 'thread-1',
  turnId: 'turn-1',
  userMessageId: 'msg-1',
  userMessage: '修复登录失败的问题',
  finalMessage: '接下来我会运行测试确认修复。',
  toolCalls: [],
  patches: [],
  goal: { active: false, settling: false },
  continuationsUsed: 0,
  completionNudgesUsed: 0,
  ...overrides,
})

describe('回合结束适配器', () => {
  test('无 DecisionService 时一律不触发，保持宿主现状', async () => {
    expect((await evaluateTurnContinuation(null, turnInput())).action).toBe('none')
    expect(
      (
        await evaluateTurnCompletion(
          null,
          turnInput({ patches: [{ path: 'a.ts', operation: 'update' }] }),
        )
      ).action,
    ).toBe('none')
  })

  test('本轮已调用工具、预算用尽、Goal 结算在即均不触发续跑', async () => {
    expect(
      (
        await evaluateTurnContinuation(
          null,
          turnInput({ toolCalls: [{ name: 'Read', input: {} }] }),
        )
      ).action,
    ).toBe('none')
    expect(
      (
        await evaluateTurnContinuation(
          null,
          turnInput({ continuationsUsed: MAX_CONTINUATIONS_PER_MESSAGE }),
        )
      ).action,
    ).toBe('none')
    expect(
      (await evaluateTurnContinuation(null, turnInput({ goal: { active: true, settling: true } })))
        .action,
    ).toBe('none')
  })

  test('验证提醒每轮最多 1 次；改动后已运行验证不提醒', async () => {
    const patches = [{ path: 'a.ts', operation: 'update' }]
    expect(
      (
        await evaluateTurnCompletion(
          null,
          turnInput({ patches, completionNudgesUsed: MAX_COMPLETION_NUDGES_PER_TURN }),
        )
      ).action,
    ).toBe('none')
    expect(
      (
        await evaluateTurnCompletion(
          null,
          turnInput({
            patches,
            toolCalls: [
              { name: 'Edit', input: {} },
              { name: 'exec_command', input: { command: 'bun run typecheck' } },
            ],
          }),
        )
      ).action,
    ).toBe('none')
    expect(
      (
        await evaluateTurnCompletion(
          null,
          turnInput({
            patches,
            toolCalls: [
              { name: 'exec_command', input: { command: 'bun test' } },
              { name: 'Edit', input: {} },
            ],
          }),
        )
      ).action,
    ).toBe('none')
  })

  test('验证命令识别只认宿主执行事实', () => {
    expect(isVerificationCall({ name: 'exec_command', input: { command: 'bun test' } })).toBe(true)
    expect(
      isVerificationCall({ name: 'exec_command', input: { command: 'bun run typecheck' } }),
    ).toBe(true)
    expect(isVerificationCall({ name: 'exec_command', input: { command: 'git push' } })).toBe(false)
    expect(isVerificationCall({ name: 'Write', input: { command: 'bun test' } })).toBe(false)
  })
})
