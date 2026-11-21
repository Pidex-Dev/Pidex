import { describe, expect, test } from 'bun:test'
import { DecisionPointManifestSchema } from '@pidex/shared/decision'
import { Schema } from 'effect'
import {
  CONTEXT_MANIFEST,
  INPUT_CONTEXT_MEMORY_TEAMWORK_MANIFEST,
  INPUT_CONTEXT_MEMORY_TEAMWORK_SPECS,
  INPUT_MANIFEST,
  MEMORY_MANIFEST,
  TEAMWORK_MANIFEST,
} from '../../src/decision/specs'
import { decideInputPreflight } from '../../src/decision/integrations/InputDecisionAdapter'
import { resetTaskFrames } from '../../src/decision/specs/InputSpecs'

describe('Phase 3 注册清单与规格一致性', () => {
  test('14 个决策点全部注册，manifest 通过共享 Schema 校验且默认 shadow', () => {
    const ids = Object.keys(INPUT_CONTEXT_MEMORY_TEAMWORK_SPECS).sort()
    expect(ids).toEqual(
      [
        'context.compact',
        'context.forget',
        'goal.met',
        'input.interjection',
        'input.preflight',
        'memory.applied',
        'memory.capture',
        'memory.merge',
        'memory.recall',
        'memory.worth',
        'pr.event_triage',
        'review.triage',
        'swarm.routing',
        'task.frame',
      ].sort(),
    )
    expect(INPUT_CONTEXT_MEMORY_TEAMWORK_MANIFEST).toHaveLength(ids.length)
    expect(INPUT_CONTEXT_MEMORY_TEAMWORK_MANIFEST).toEqual([
      ...INPUT_MANIFEST,
      ...CONTEXT_MANIFEST,
      ...MEMORY_MANIFEST,
      ...TEAMWORK_MANIFEST,
    ])
    const decode = Schema.decodeUnknownSync(DecisionPointManifestSchema)
    for (const entry of INPUT_CONTEXT_MEMORY_TEAMWORK_MANIFEST) {
      expect(() => decode(entry)).not.toThrow()
      expect(entry.defaultMode).toBe('shadow')
      expect(entry.titleZh.length).toBeGreaterThan(0)
      expect(entry.summaryZh.length).toBeGreaterThan(0)
      expect(ids).toContain(entry.id)
    }
    const groups = new Set(INPUT_CONTEXT_MEMORY_TEAMWORK_MANIFEST.map((entry) => entry.group))
    expect([...groups].sort()).toEqual(['context', 'input', 'teamwork'])
  })

  test('每个 spec 的 id 与注册键一致，版本为正整数', () => {
    for (const [id, spec] of Object.entries(INPUT_CONTEXT_MEMORY_TEAMWORK_SPECS)) {
      expect(spec.id).toBe(id)
      expect(Number.isInteger(spec.version) && spec.version >= 1).toBe(true)
    }
  })

  test('latency 契约：preflight/interjection inline，task.frame parallel，compact/applied background', () => {
    expect(INPUT_CONTEXT_MEMORY_TEAMWORK_SPECS['input.preflight'].latency).toBe('inline')
    expect(INPUT_CONTEXT_MEMORY_TEAMWORK_SPECS['input.interjection'].latency).toBe('inline')
    expect(INPUT_CONTEXT_MEMORY_TEAMWORK_SPECS['task.frame'].latency).toBe('parallel')
    expect(INPUT_CONTEXT_MEMORY_TEAMWORK_SPECS['context.compact'].latency).toBe('background')
    expect(INPUT_CONTEXT_MEMORY_TEAMWORK_SPECS['memory.applied'].latency).toBe('background')
    expect(INPUT_CONTEXT_MEMORY_TEAMWORK_SPECS['context.forget'].cacheImpact).toBe('prefix-mutating')
  })

  test('无 DecisionService 时所有入口适配器等价于无 Judge 行为', async () => {
    resetTaskFrames()
    const preflight = await decideInputPreflight(undefined, {
      messageText: '你好',
      thread: { threadId: 'phase3-null', running: false },
    })
    expect(preflight.source).toBe('fallback')
    expect(preflight.outcome.gear).toBe('chat')
  })
})