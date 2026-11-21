import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DecisionLedgerRecord, DecisionOutcomeRecord } from '@pidex/shared/decision'
import { AgentDatabase, SCHEMA_VERSION } from '../../src/storage/database/AgentDatabase'
import { removeFixturePaths } from '../FixtureCleanup'

const paths: string[] = []
afterEach(async () => removeFixturePaths(paths.splice(0)), 30_000)

const openDatabase = async (name: string) => {
  const root = await mkdtemp(join(tmpdir(), `pidex-${name}-`))
  paths.push(root)
  return { db: new AgentDatabase(join(root, 'agent.sqlite')), path: join(root, 'agent.sqlite') }
}

const ledgerRecord = (
  threadId: string,
  overrides: Partial<DecisionLedgerRecord> = {},
): DecisionLedgerRecord => ({
  id: 'decision:1',
  threadId,
  specId: 'tool.risk',
  specVersion: 1,
  mode: 'shadow',
  providerId: 'classifier',
  outcome: 'confirm',
  source: 'fallback',
  reason: 'shadow',
  judged: 'allow',
  answers: { requested: { type: 'boolean', probability: 0.9 } },
  latencyMs: 80,
  usage: { inputTokens: 120, outputTokens: 8, cachedInputTokens: 64 },
  stateDigest: 'a'.repeat(64),
  createdAt: 1_000,
  ...overrides,
})

const outcomeRecord = (
  ledgerId: string,
  threadId: string,
  overrides: Partial<DecisionOutcomeRecord> = {},
): DecisionOutcomeRecord => ({
  id: 'decision-outcome:1',
  ledgerId,
  threadId,
  kind: 'mark',
  verdict: 'correct',
  createdAt: 2_000,
  ...overrides,
})

const decisionEvents = (db: AgentDatabase, threadId: string) =>
  db.eventsAfter(0, threadId).filter((event) => event.method.startsWith('decision/'))

describe('decision ledger storage', () => {
  test('74 → 75 迁移幂等建表并保留既有数据', async () => {
    const { db, path } = await openDatabase('decision-migration')
    const thread = db.createThread('决策线程')
    db.repositories.decisionLedger.appendRecord(ledgerRecord(thread.id))
    db.sqlite.exec(
      'DROP TABLE decision_outcomes; DROP TABLE decision_ledger; DROP TABLE decision_operations',
    )
    db.sqlite.exec('PRAGMA user_version = 74')
    db.close()

    const reopened = new AgentDatabase(path)
    expect(reopened.sqlite.query('PRAGMA user_version').get()).toEqual({
      user_version: SCHEMA_VERSION,
    })
    expect(reopened.repositories.decisionLedger.available()).toBe(true)
    expect(reopened.sqlite.query('SELECT title FROM threads WHERE id = ?').get(thread.id)).toEqual({
      title: '决策线程',
    })
    reopened.repositories.decisionLedger.appendRecord(ledgerRecord(thread.id, { id: 'decision:2' }))
    expect(
      reopened.repositories.decisionLedger.listByThread({ threadId: thread.id }).records,
    ).toHaveLength(1)
    reopened.close()
  })

  test('appendRecord 与 outbox 事件同事务提交，失败时一起回滚', async () => {
    const { db } = await openDatabase('decision-outbox')
    const thread = db.createThread('决策线程')
    const repository = db.repositories.decisionLedger

    repository.appendRecord(ledgerRecord(thread.id))
    const events = decisionEvents(db, thread.id)
    expect(events).toHaveLength(1)
    const recorded = events[0]!
    expect(recorded.method).toBe('decision/recorded')
    expect((recorded.params as { record: DecisionLedgerRecord }).record.id).toBe('decision:1')

    expect(() =>
      db.transaction(() => {
        repository.appendRecord(ledgerRecord(thread.id, { id: 'decision:rollback' }))
        throw new Error('rollback')
      }),
    ).toThrow('rollback')
    expect(repository.getRecord('decision:rollback')).toBeNull()
    expect(decisionEvents(db, thread.id)).toHaveLength(1)
    db.close()
  })

  test('listByThread 返回记录与关联 outcomes，并按游标分页', async () => {
    const { db } = await openDatabase('decision-list')
    const thread = db.createThread('决策线程')
    const other = db.createThread('其他线程')
    const repository = db.repositories.decisionLedger
    repository.appendRecord(ledgerRecord(thread.id, { id: 'decision:a', createdAt: 1_000 }))
    repository.appendRecord(
      ledgerRecord(thread.id, {
        id: 'decision:b',
        createdAt: 2_000,
        turnId: 'turn:1',
        specId: 'tool.approval',
      }),
    )
    repository.appendRecord(ledgerRecord(other.id, { id: 'decision:c', createdAt: 3_000 }))
    repository.appendOutcome(outcomeRecord('decision:b', thread.id))

    const all = repository.listByThread({ threadId: thread.id })
    expect(all.records.map((record) => record.id)).toEqual(['decision:b', 'decision:a'])
    expect(all.records[0]?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 8,
      cachedInputTokens: 64,
    })
    expect(all.outcomes.map((outcome) => outcome.ledgerId)).toEqual(['decision:b'])
    expect(all.nextCursor).toBeUndefined()

    const firstPage = repository.listByThread({ threadId: thread.id, limit: 1 })
    expect(firstPage.records.map((record) => record.id)).toEqual(['decision:b'])
    expect(firstPage.nextCursor).toBe('decision:b|2000')
    expect(firstPage.nextCursor).toBeDefined()
    const secondPage = repository.listByThread({
      threadId: thread.id,
      limit: 1,
      cursor: firstPage.nextCursor!,
    })
    expect(secondPage.records.map((record) => record.id)).toEqual(['decision:a'])
    expect(secondPage.nextCursor).toBeUndefined()

    const filtered = repository.listByThread({
      threadId: thread.id,
      specId: 'tool.approval',
      turnId: 'turn:1',
    })
    expect(filtered.records.map((record) => record.id)).toEqual(['decision:b'])
    db.close()
  })

  test('mutation 操作日志按 operationId 幂等重放，参数不一致时判为冲突', async () => {
    const { db } = await openDatabase('decision-operations')
    const repository = db.repositories.decisionLedger
    const request = { ledgerId: 'decision:1', verdict: 'correct' }
    expect(repository.completedOperation('operation:1', 'decision/markOutcome', request)).toBeNull()
    repository.recordOperation('operation:1', 'decision/markOutcome', request, { ok: true })
    expect(repository.completedOperation('operation:1', 'decision/markOutcome', request)).toEqual({
      matches: true,
      result: { ok: true },
    })
    expect(
      repository.completedOperation('operation:1', 'decision/markOutcome', { verdict: 'wrong' })
        ?.matches,
    ).toBe(false)
    db.close()
  })

  test('appendOutcome 发布事件，删除线程级联清理账本与结果', async () => {
    const { db } = await openDatabase('decision-cascade')
    const thread = db.createThread('决策线程')
    const repository = db.repositories.decisionLedger
    repository.appendRecord(ledgerRecord(thread.id))
    repository.appendOutcome(outcomeRecord('decision:1', thread.id))
    const events = decisionEvents(db, thread.id)
    expect(events.map((event) => event.method)).toEqual([
      'decision/recorded',
      'decision/outcomeRecorded',
    ])

    db.sqlite.query('DELETE FROM threads WHERE id = ?').run(thread.id)
    expect(repository.getRecord('decision:1')).toBeNull()
    expect(repository.listByThread({ threadId: thread.id })).toEqual({ records: [], outcomes: [] })
    expect(db.sqlite.query('SELECT COUNT(*) AS count FROM decision_outcomes').get()).toEqual({
      count: 0,
    })
    db.close()
  })
})
