import { describe, expect, test } from 'bun:test'
import type { DurableEventEnvelope, EventEnvelope } from '@pidex/agent-protocol'
import type { DecisionLedgerRecord, DecisionOutcomeRecord } from '@pidex/shared/decision'
import type { Thread, Turn } from '@pidex/shared/thread'
import {
  applyThreadEnvelopes,
  createCanonicalThreadState,
  mergeDecisionLedgerIntoState,
  selectDecisionLedgerEntries,
  selectDecisionNoticeEntries,
  selectVisibleTurnEntries,
  type CanonicalThreadPage,
} from '@pidex/session-view'

const permissionConfig = {
  sandboxMode: 'workspace-write',
  approvalPolicy: 'auto_review',
  approvalsReviewer: 'auto_review',
} as const

const thread: Thread = {
  id: 'thread-decision',
  title: '决策投影测试',
  projectID: null,
  gitBranch: null,
  settings: { taskMode: 'chat', permissionConfig },
  createdAt: 1,
  updatedAt: 1,
}

const turn: Turn = {
  id: 'turn-decision',
  threadId: thread.id,
  sourceInputID: 'input-decision',
  status: 'running',
  mode: 'chat',
  model: { providerID: 'openai', id: 'gpt-test' },
  permissionConfig,
  rootAgentId: 'agent-decision',
  mergedInputIDs: [],
  startedAt: 1,
  finishedAt: null,
  elapsedSeconds: 0,
  error: null,
}

const DIGEST = 'a'.repeat(64)

function historyPage(): CanonicalThreadPage {
  return {
    thread,
    subagents: [],
    turns: [
      {
        turn,
        inputs: [],
        messages: [],
        agents: [],
        items: [],
        approvals: [],
        attachments: [],
      },
    ],
    queue: { version: 0, pauseReason: null, turns: [], inputs: [] },
    olderCursor: null,
    hasOlder: false,
    streamPosition: { streamId: thread.id, sequence: 0 },
  }
}

function ledgerRecord(id: string, createdAt: number): DecisionLedgerRecord {
  return {
    id,
    threadId: thread.id,
    turnId: turn.id,
    specId: 'input.injection',
    specVersion: 1,
    mode: 'shadow',
    providerId: 'openai',
    outcome: { blocked: false },
    source: 'judge',
    answers: {
      injected: { type: 'boolean', probability: 0.9, judge: 'openai-main' },
    },
    latencyMs: 120,
    tiers: [{ judgeId: 'openai-main', asked: 1, kept: 1, latencyMs: 120 }],
    stateDigest: DIGEST,
    createdAt,
  }
}

function outcomeRecord(id: string, ledgerId: string, createdAt: number): DecisionOutcomeRecord {
  return {
    id,
    ledgerId,
    threadId: thread.id,
    kind: 'mark',
    verdict: 'correct',
    createdAt,
  }
}

function recordedEnvelope(
  sequence: number,
  record: DecisionLedgerRecord,
): DurableEventEnvelope<'decision/recorded'> {
  return {
    eventId: `decision-recorded-${sequence}`,
    streamId: thread.id,
    type: 'decision/recorded',
    version: 1,
    occurredAt: record.createdAt,
    threadId: thread.id,
    turnId: turn.id,
    durability: 'durable',
    sequence,
    payload: { threadId: thread.id, record },
  }
}

function outcomeEnvelope(
  sequence: number,
  outcome: DecisionOutcomeRecord,
): DurableEventEnvelope<'decision/outcomeRecorded'> {
  return {
    eventId: `decision-outcome-${sequence}`,
    streamId: thread.id,
    type: 'decision/outcomeRecorded',
    version: 1,
    occurredAt: outcome.createdAt,
    threadId: thread.id,
    turnId: turn.id,
    durability: 'durable',
    sequence,
    payload: { threadId: thread.id, outcome },
  }
}

function noticeEnvelope(sequence: number): DurableEventEnvelope<'decision/notice'> {
  return {
    eventId: `decision-notice-${sequence}`,
    streamId: thread.id,
    type: 'decision/notice',
    version: 1,
    occurredAt: 300 + sequence,
    threadId: thread.id,
    turnId: turn.id,
    durability: 'durable',
    sequence,
    payload: {
      threadId: thread.id,
      notice: {
        id: `notice-${sequence}`,
        threadId: thread.id,
        turnId: turn.id,
        specId: 'input.injection',
        code: 'input.injection.blocked',
        params: {},
        message: '已拦截外部注入内容',
        createdAt: 300 + sequence,
      },
    },
  }
}

describe('decision canonical projection', () => {
  test('projects decision/notice into the visible turn entry', () => {
    const state = createCanonicalThreadState(historyPage())
    const next = applyThreadEnvelopes(state, [noticeEnvelope(1)])
    const notices = selectDecisionNoticeEntries(next.decisions)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      id: 'notice-1',
      turnId: turn.id,
      code: 'input.injection.blocked',
      message: '已拦截外部注入内容',
    })
    const entries = selectVisibleTurnEntries(next)
    expect(entries[0]?.decisionNotices.map((notice) => notice.id)).toEqual(['notice-1'])
  })

  test('projects decision/recorded and attaches later outcomes', () => {
    const state = createCanonicalThreadState(historyPage())
    const next = applyThreadEnvelopes(state, [
      recordedEnvelope(1, ledgerRecord('ledger-1', 100)),
      outcomeEnvelope(2, outcomeRecord('outcome-1', 'ledger-1', 200)),
    ])
    const records = selectDecisionLedgerEntries(next.decisions)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: 'ledger-1',
      specId: 'input.injection',
      mode: 'shadow',
      source: 'judge',
      latencyMs: 120,
    })
    expect(records[0]?.answers?.injected).toMatchObject({ type: 'boolean', probability: 0.9 })
    expect(records[0]?.outcomes.map((outcome) => outcome.id)).toEqual(['outcome-1'])
  })

  test('buffers outcomes that arrive before their ledger record', () => {
    const state = createCanonicalThreadState(historyPage())
    const next = applyThreadEnvelopes(state, [
      outcomeEnvelope(1, outcomeRecord('outcome-early', 'ledger-late', 100)),
      recordedEnvelope(2, ledgerRecord('ledger-late', 200)),
    ])
    const records = selectDecisionLedgerEntries(next.decisions)
    expect(records[0]?.outcomes.map((outcome) => outcome.id)).toEqual(['outcome-early'])
  })

  test('merges a listLedger page without dropping event outcomes or duplicating records', () => {
    const state = createCanonicalThreadState(historyPage())
    const withEvents = applyThreadEnvelopes(state, [
      recordedEnvelope(1, ledgerRecord('ledger-1', 100)),
      outcomeEnvelope(2, outcomeRecord('outcome-1', 'ledger-1', 200)),
    ])
    const merged = mergeDecisionLedgerIntoState(withEvents, {
      records: [ledgerRecord('ledger-1', 100), ledgerRecord('ledger-2', 50)],
      outcomes: [outcomeRecord('outcome-1', 'ledger-1', 200)],
    })
    const records = selectDecisionLedgerEntries(merged.decisions)
    expect(records.map((record) => record.id)).toEqual(['ledger-1', 'ledger-2'])
    expect(records[0]?.outcomes.map((outcome) => outcome.id)).toEqual(['outcome-1'])
    expect(merged.stream.appliedSequence).toBe(withEvents.stream.appliedSequence)
  })

  test('prunes decision entries when their turn is removed by a history edit', () => {
    const state = createCanonicalThreadState(historyPage())
    const withDecision = applyThreadEnvelopes(state, [
      recordedEnvelope(1, ledgerRecord('ledger-1', 100)),
      noticeEnvelope(2),
    ])
    const edit: EventEnvelope = {
      eventId: 'history-edit-3',
      streamId: thread.id,
      type: 'thread/history/edited',
      version: 1,
      occurredAt: 400,
      threadId: thread.id,
      turnId: null,
      durability: 'durable',
      sequence: 3,
      payload: { removedTurnIds: [turn.id], historyRevision: 2 },
    }
    const next = applyThreadEnvelopes(withDecision, [edit])
    expect(selectDecisionNoticeEntries(next.decisions)).toHaveLength(0)
    expect(selectDecisionLedgerEntries(next.decisions)).toHaveLength(0)
  })
})