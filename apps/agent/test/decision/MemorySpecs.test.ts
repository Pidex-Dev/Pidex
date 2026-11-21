import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DecisionAnswer } from '@pidex/shared/decision'
import { DecisionEngine } from '../../src/decision/DecisionEngine'
import { Judge } from '../../src/decision/Judge'
import { MockJudgeProvider } from '../../src/decision/providers/MockJudgeProvider'
import {
  memoryAppliedSpec,
  memoryCaptureSpec,
  memoryMergeSpec,
  memoryRecallSpec,
  memoryWorthSpec,
  type MemoryLesson,
} from '../../src/decision/specs/MemorySpecs'
import {
  decideMemoryRecall,
  memoryLessonsFromFiles,
  memoryLessonsFromInjection,
} from '../../src/decision/integrations/MemoryDecisionAdapter'
import { MemoryService } from '../../src/memory/MemoryService'
import { AgentDatabase } from '../../src/storage/database/AgentDatabase'
import { removeFixturePaths } from '../FixtureCleanup'

const roots: string[] = []
afterEach(async () => removeFixturePaths(roots.splice(0)), 30_000)

const engineWith = (
  answers: Record<string, DecisionAnswer>,
  modes: Record<string, 'off' | 'shadow' | 'active'>,
) =>
  new DecisionEngine({
    judge: new Judge({ provider: new MockJudgeProvider({ answers }) }),
    modes,
  })

const lessons: MemoryLesson[] = [
  { id: 'stack.md', trigger: 'When touching the build config', lesson: 'Use Bun 1.4.4' },
  { id: 'style.md', trigger: 'When writing renderer components', lesson: 'Reuse Button' },
]

describe('memory specs', () => {
  test('capture：纠正与长期偏好判别，fallback 一律 skip', async () => {
    const engine = engineWith(
      {
        correction: { type: 'boolean', probability: 0.95 },
        preference: { type: 'boolean', probability: 0.1 },
      },
      { 'memory.capture': 'active' },
    )
    const decision = await engine.decide(memoryCaptureSpec, {
      userMessage: '不对，应该用事务包起来',
      previousAssistantMessage: '我直接写了两次库',
    })
    expect(decision.outcome).toBe('correction')
    expect(memoryCaptureSpec.fallback({ userMessage: '', previousAssistantMessage: '' })).toBe(
      'skip',
    )
  })

  test('recall：仅高置信 yes 召回，动态题目按课题生成', async () => {
    const questions = memoryRecallSpec.questionsFor!({ userMessage: '改构建配置', lessons })
    expect(Object.keys(questions)).toEqual(['lesson_0', 'lesson_1'])
    const engine = engineWith(
      {
        lesson_0: { type: 'boolean', probability: 0.95 },
        lesson_1: { type: 'boolean', probability: 0.5 },
      },
      { 'memory.recall': 'active' },
    )
    const decision = await engine.decide(memoryRecallSpec, { userMessage: '改构建配置', lessons })
    expect(decision.outcome.apply).toEqual(['stack.md'])
    expect(memoryRecallSpec.fallback({ userMessage: '', lessons })).toEqual({ apply: [] })
  })

  test('worth：仅 reusable/one_off/already_known 被采纳，其余 unclear', async () => {
    const candidates = [
      { trigger: 't1', lesson: 'l1' },
      { trigger: 't2', lesson: 'l2' },
    ]
    const engine = engineWith(
      {
        worth_1: { type: 'choice', choice: 'reusable', probabilities: { reusable: 0.9 } },
        worth_2: { type: 'choice', choice: 'unclear' },
      },
      { 'memory.worth': 'active' },
    )
    const decision = await engine.decide(memoryWorthSpec, {
      lessons: candidates,
      projectInstructions: '',
    })
    expect(decision.outcome).toEqual(['reusable', 'unclear'])
    expect(memoryWorthSpec.fallback({ lessons: candidates, projectInstructions: '' })).toEqual([
      'unclear',
      'unclear',
    ])
  })

  test('merge：same/refines/contradicts 判定，fallback 全部 unrelated', async () => {
    const engine = engineWith(
      { merge_1: { type: 'choice', choice: 'contradicts', probabilities: { contradicts: 0.9 } } },
      { 'memory.merge': 'active' },
    )
    const decision = await engine.decide(memoryMergeSpec, {
      candidate: { trigger: '构建', lesson: '用 Bun' },
      existing: [lessons[0]!],
    })
    expect(decision.outcome).toEqual(['contradicts'])
    expect(
      memoryMergeSpec.fallback({ candidate: { trigger: '', lesson: '' }, existing: lessons }),
    ).toEqual(['unrelated', 'unrelated'])
  })

  test('applied：确信 yes/no 分别归类，不确定不入任何列表', async () => {
    const engine = engineWith(
      {
        applied_1: { type: 'boolean', probability: 0.95 },
        applied_2: { type: 'boolean', probability: 0.05 },
      },
      { 'memory.applied': 'active' },
    )
    const decision = await engine.decide(memoryAppliedSpec, { lessons, turnDigest: '本轮用了 Bun' })
    expect(decision.outcome).toEqual({ applied: ['stack.md'], notApplied: ['style.md'] })
    expect(memoryAppliedSpec.fallback({ lessons, turnDigest: '' })).toEqual({
      applied: [],
      notApplied: [],
    })
  })

  test('无引擎时 recall 适配器等价于无 Judge 行为', async () => {
    expect(await decideMemoryRecall(null, { userMessage: 'x', lessons })).toEqual({ apply: [] })
    expect(await decideMemoryRecall(undefined, { userMessage: 'x', lessons: [] })).toEqual({
      apply: [],
    })
  })

  test('课题映射：项目命名空间只收 project/reference 类型，注入课题按索引内容匹配', () => {
    const files = [
      { path: 'a.md', name: 'A', description: 'da', type: 'project' },
      { path: 'b.md', name: 'B', description: 'db', type: 'user' },
      { path: 'c.md', name: 'C', description: null, type: 'reference' },
    ]
    const project = memoryLessonsFromFiles(files, { kind: 'project', projectId: 'p' })
    expect(project.map((lesson) => lesson.id)).toEqual(['a.md', 'c.md'])
    const user = memoryLessonsFromFiles(files, { kind: 'user' })
    expect(user).toHaveLength(3)
    const matched = memoryLessonsFromInjection(
      {
        sections: [
          { namespace: 'project:p', label: '项目', content: '- a.md：A', truncated: false },
        ],
        ignored: false,
      },
      new Map([['project:p', project]]),
    )
    expect(matched.map((lesson) => lesson.id)).toEqual(['a.md'])
  })
})

describe('MemoryService 可选注入', () => {
  const document = (name: string, body: string) =>
    [
      '---',
      `name: ${name}`,
      'description: 构建相关约束',
      'type: project',
      '---',
      '',
      body,
      '',
    ].join('\n')

  const fixture = async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-memory-decision-'))
    roots.push(root)
    const db = new AgentDatabase(join(root, 'agent.sqlite'))
    const memory = new MemoryService(db, {
      enabled: true,
      rootDirectory: join(root, 'memories'),
    })
    return { root, db, memory }
  }

  test('未注入时注入行为与现状一致；忽略记忆语义不受影响', async () => {
    const { db, memory } = await fixture()
    try {
      await memory.write({
        namespace: { kind: 'project', projectId: 'p1' },
        path: 'stack.md',
        content: document('Stack', '统一使用 Bun 1.4.4'),
      })
      const injection = await memory.inject({
        projectId: 'p1',
        userMessage: '改构建配置',
        threadId: 't1',
        turnId: null,
      })
      expect(injection.sections.length).toBeGreaterThan(0)
      const ignored = await memory.inject({
        projectId: 'p1',
        userMessage: '忽略你的记忆',
        threadId: 't1',
        turnId: null,
      })
      expect(ignored).toEqual({ sections: [], ignored: true })
      await memory.observeTurnApplied({ threadId: 't1', turnId: 'turn-1' })
    } finally {
      memory.dispose()
      db.close()
    }
  })

  test('注入后 recall 观察不改内容；shadow 模式不改变任何行为', async () => {
    const { db, memory } = await fixture()
    const seen: string[] = []
    const engine = engineWith(
      { lesson_0: { type: 'boolean', probability: 0.95 } },
      { 'memory.recall': 'shadow' },
    )
    const decisions = {
      ensureEngine: async () => {
        seen.push('engine')
        return engine
      },
    } as never
    try {
      await memory.write({
        namespace: { kind: 'project', projectId: 'p1' },
        path: 'stack.md',
        content: document('Stack', '统一使用 Bun 1.4.4'),
      })
      memory.attachDecisions(decisions)
      const injection = await memory.inject({
        projectId: 'p1',
        userMessage: '改构建配置',
        threadId: 't1',
        turnId: null,
      })
      expect(injection.sections.length).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(seen.length).toBeGreaterThan(0)
      const again = await memory.inject({
        projectId: 'p1',
        userMessage: '改构建配置',
        threadId: 't1',
        turnId: null,
      })
      expect(again.sections).toEqual(injection.sections)
    } finally {
      memory.dispose()
      db.close()
    }
  })
})
