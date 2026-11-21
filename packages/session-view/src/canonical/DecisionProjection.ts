import type {
  DecisionAnswers,
  DecisionLedgerRecord,
  DecisionOutcomeRecord,
  DecisionPresentationNotice,
  JudgeTierReport,
  JudgeUsage,
} from '@pidex/shared/decision'
import type { EventEnvelope } from '@pidex/agent-protocol'

type DecisionThreadEvent = Extract<
  EventEnvelope,
  { type: 'decision/notice' | 'decision/recorded' | 'decision/outcomeRecorded' }
>

/** Read-only timeline view entry projected from a durable `decision/notice` event. */
export interface DecisionNoticeViewEntry {
  id: string
  turnId: string | null
  specId: string
  code: string
  message: string
  createdAt: number
}

/** Read-only ledger view entry projected from `decision/recorded` + `decision/outcomeRecorded`. */
export interface DecisionLedgerViewEntry {
  id: string
  turnId: string | null
  specId: string
  specVersion: number
  mode: 'shadow' | 'active'
  providerId: string
  modelId: string | null
  source: 'judge' | 'fallback'
  reason: string | null
  answers: DecisionAnswers | null
  latencyMs: number | null
  usage: JudgeUsage | null
  tiers: readonly JudgeTierReport[]
  outcomes: readonly DecisionOutcomeRecord[]
  createdAt: number
}

export interface CanonicalDecisionState {
  noticesById: Map<string, DecisionNoticeViewEntry>
  ledgerById: Map<string, DecisionLedgerViewEntry>
  /**
   * Outcomes whose ledger record has not been projected yet (e.g. a paged read
   * returned outcomes for older records). They attach when the record arrives.
   */
  pendingOutcomesByLedgerId: Map<string, DecisionOutcomeRecord[]>
}

/** Creates the empty decision projection slice owned by a canonical thread state. */
export function createCanonicalDecisionState(): CanonicalDecisionState {
  return {
    noticesById: new Map(),
    ledgerById: new Map(),
    pendingOutcomesByLedgerId: new Map(),
  }
}

/** Shallow-copies the decision slice for a canonical state clone. */
export function cloneCanonicalDecisionState(state: CanonicalDecisionState): CanonicalDecisionState {
  return {
    noticesById: new Map(state.noticesById),
    ledgerById: new Map(state.ledgerById),
    pendingOutcomesByLedgerId: new Map(state.pendingOutcomesByLedgerId),
  }
}

/**
 * Projects one decision thread event into read-only view entries. Unknown or
 * unrelated envelopes leave the slice untouched, so older projections and
 * clients without `decision.engine.v1` stay forward compatible.
 */
export function applyDecisionEnvelope(
  state: CanonicalDecisionState,
  envelope: EventEnvelope,
): void {
  switch (envelope.type) {
    case 'decision/notice':
      upsertNotice(state, envelope)
      return
    case 'decision/recorded':
      upsertLedgerRecord(state, envelope)
      return
    case 'decision/outcomeRecorded':
      attachOutcome(state, envelope)
      return
    default:
      return
  }
}

/** Drops decision entries that belonged to removed turns after a history edit. */
export function pruneDecisionEntriesForTurns(
  state: CanonicalDecisionState,
  removedTurnIds: ReadonlySet<string>,
): void {
  for (const [id, notice] of state.noticesById) {
    if (notice.turnId && removedTurnIds.has(notice.turnId)) state.noticesById.delete(id)
  }
  for (const [id, record] of state.ledgerById) {
    if (record.turnId && removedTurnIds.has(record.turnId)) state.ledgerById.delete(id)
  }
}

/** Notices in chronological order, optionally restricted to one turn. */
export function selectDecisionNoticeEntries(
  state: CanonicalDecisionState,
  turnId?: string,
): DecisionNoticeViewEntry[] {
  return [...state.noticesById.values()]
    .filter((notice) => turnId === undefined || notice.turnId === turnId)
    .sort(compareDecisionCreated)
}

/** Ledger entries newest-first, optionally restricted to one turn or decision point. */
export function selectDecisionLedgerEntries(
  state: CanonicalDecisionState,
  filter?: { turnId?: string; specId?: string },
): DecisionLedgerViewEntry[] {
  return [...state.ledgerById.values()]
    .filter(
      (record) =>
        (filter?.turnId === undefined || record.turnId === filter.turnId) &&
        (filter?.specId === undefined || record.specId === filter.specId),
    )
    .sort((left, right) => compareDecisionCreated(right, left))
}

/**
 * Merges a `decision/listLedger` page into the projection slice. Existing
 * entries keep their projected outcomes when the page omits them, so a paged
 * read never drops outcomes that arrived through events.
 */
export function mergeDecisionLedgerPage(
  state: CanonicalDecisionState,
  page: {
    records: readonly DecisionLedgerRecord[]
    outcomes: readonly DecisionOutcomeRecord[]
  },
): CanonicalDecisionState {
  const next = cloneCanonicalDecisionState(state)
  const outcomesByLedgerId = new Map<string, DecisionOutcomeRecord[]>()
  for (const outcome of page.outcomes) {
    const bucket = outcomesByLedgerId.get(outcome.ledgerId)
    if (bucket) bucket.push(outcome)
    else outcomesByLedgerId.set(outcome.ledgerId, [outcome])
  }
  for (const record of page.records) {
    const previous = next.ledgerById.get(record.id)
    const entry = ledgerViewFromRecord(record)
    const merged = mergeOutcomes(previous?.outcomes ?? [], [
      ...(outcomesByLedgerId.get(record.id) ?? []),
      ...(next.pendingOutcomesByLedgerId.get(record.id) ?? []),
    ])
    next.ledgerById.set(record.id, { ...entry, outcomes: merged })
    next.pendingOutcomesByLedgerId.delete(record.id)
  }
  for (const outcome of page.outcomes) {
    if (next.ledgerById.has(outcome.ledgerId)) continue
    const pending = next.pendingOutcomesByLedgerId.get(outcome.ledgerId) ?? []
    next.pendingOutcomesByLedgerId.set(
      outcome.ledgerId,
      mergeOutcomes(pending, [outcome]) as DecisionOutcomeRecord[],
    )
  }
  return next
}

function upsertNotice(
  state: CanonicalDecisionState,
  envelope: Extract<DecisionThreadEvent, { type: 'decision/notice' }>,
): void {
  const notice: DecisionPresentationNotice = envelope.payload.notice
  state.noticesById.set(notice.id, {
    id: notice.id,
    turnId: notice.turnId ?? envelope.turnId ?? null,
    specId: notice.specId,
    code: notice.code,
    message: notice.message,
    createdAt: notice.createdAt,
  })
}

function upsertLedgerRecord(
  state: CanonicalDecisionState,
  envelope: Extract<DecisionThreadEvent, { type: 'decision/recorded' }>,
): void {
  const record = envelope.payload.record
  const previous = state.ledgerById.get(record.id)
  const entry = ledgerViewFromRecord(record)
  const pending = state.pendingOutcomesByLedgerId.get(record.id) ?? []
  state.ledgerById.set(record.id, {
    ...entry,
    turnId: entry.turnId ?? envelope.turnId ?? null,
    outcomes: mergeOutcomes(previous?.outcomes ?? [], pending),
  })
  state.pendingOutcomesByLedgerId.delete(record.id)
}

function attachOutcome(
  state: CanonicalDecisionState,
  envelope: Extract<DecisionThreadEvent, { type: 'decision/outcomeRecorded' }>,
): void {
  attachOutcomeToEntry(state, envelope.payload.outcome)
}

function attachOutcomeToEntry(
  state: CanonicalDecisionState,
  outcome: DecisionOutcomeRecord,
): void {
  const entry = state.ledgerById.get(outcome.ledgerId)
  if (!entry) {
    const pending = state.pendingOutcomesByLedgerId.get(outcome.ledgerId) ?? []
    state.pendingOutcomesByLedgerId.set(
      outcome.ledgerId,
      mergeOutcomes(pending, [outcome]) as DecisionOutcomeRecord[],
    )
    return
  }
  state.ledgerById.set(outcome.ledgerId, {
    ...entry,
    outcomes: mergeOutcomes(entry.outcomes, [outcome]),
  })
}

function ledgerViewFromRecord(record: DecisionLedgerRecord): DecisionLedgerViewEntry {
  return {
    id: record.id,
    turnId: record.turnId ?? null,
    specId: record.specId,
    specVersion: record.specVersion,
    mode: record.mode,
    providerId: record.providerId,
    modelId: record.modelId ?? null,
    source: record.source,
    reason: record.reason ?? null,
    answers: record.answers ?? null,
    latencyMs: record.latencyMs ?? null,
    usage: record.usage ?? null,
    tiers: record.tiers ?? [],
    outcomes: [],
    createdAt: record.createdAt,
  }
}

function mergeOutcomes(
  previous: readonly DecisionOutcomeRecord[],
  incoming: readonly DecisionOutcomeRecord[],
): readonly DecisionOutcomeRecord[] {
  const byId = new Map(previous.map((outcome) => [outcome.id, outcome]))
  for (const outcome of incoming) byId.set(outcome.id, outcome)
  return [...byId.values()].sort(compareDecisionCreated)
}

function compareDecisionCreated(
  left: { id: string; createdAt: number },
  right: { id: string; createdAt: number },
): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}