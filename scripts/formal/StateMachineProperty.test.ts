import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isReadOnlyTaskMode,
  matchPermissionPreset,
  type ApprovalPolicy,
  type ApprovalsReviewer,
  type PermissionConfig,
  type PermissionRuleEffect,
  type SandboxMode,
} from '@pidex/shared/thread'
import {
  AgentError,
  type EventEnvelope,
  type PermissionDecision,
  type SubmitMessage,
  type TaskMode,
  type ToolInvocation,
} from '../../apps/agent/src/Domain'
import { InteractionService } from '../../apps/agent/src/interaction/InteractionService'
import { ResumeCheckpointResolver } from '../../apps/agent/src/interaction/ResumeCheckpointResolver'
import { ApprovalService } from '../../apps/agent/src/permission/ApprovalService'
import { filePathProtection } from '../../apps/agent/src/permission/FilePathProtection'
import { PermissionDecisionEngine } from '../../apps/agent/src/permission/PermissionDecisionEngine'
import { QuestionService } from '../../apps/agent/src/session/QuestionService'
import { AgentDatabase } from '../../apps/agent/src/storage/database/AgentDatabase'
import type { EventHub } from '../../apps/agent/src/storage/events/EventHub'
import { globalEventSequence } from '../../apps/agent/src/storage/events/EventPublisher'
import { ToolRegistry, type ToolCatalogEntry } from '../../apps/agent/src/tool/ToolRegistry'
import { EventSubscriptionRegistry } from '../../apps/agent/src/transport/EventSubscriptionRegistry'

interface SeededRng {
  next(): number
  int(minInclusive: number, maxInclusive: number): number
  bool(probability?: number): boolean
  pick<T>(items: readonly T[]): T
}

const createSeededRng = (seed: number): SeededRng => {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int(minInclusive, maxInclusive) {
      return minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1))
    },
    bool(probability = 0.5) {
      return next() < probability
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)]!
    },
  }
}

const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']
const APPROVAL_REVIEWERS: readonly ApprovalsReviewer[] = ['auto_review']
const TASK_MODES: readonly TaskMode[] = ['chat', 'plan', 'grill']
const RISKS: ReadonlyArray<PermissionDecision['risk']> = ['low', 'medium', 'high', 'critical']
const RULE_EFFECTS: ReadonlyArray<PermissionRuleEffect | undefined> = [
  undefined,
  'allow',
  'ask',
  'deny',
]

const registry = new ToolRegistry()
const READ_TOOL = registry.get('Read')
const WRITE_TOOL = registry.get('Write')
const EDIT_TOOL = registry.get('Edit')
const SHELL_TOOL = registry.get('exec_command')
const REQUEST_PERMISSIONS_TOOL = registry.get('request_permissions')
const MCP_TOOL: ToolCatalogEntry = {
  ...READ_TOOL,
  sdkName: 'mcp_demo_action',
  capabilities: {
    filesystem: 'none',
    network: 'declared',
    process: false,
    externalState: true,
    userInteraction: false,
    readOnly: false,
  },
  allowedModes: ['chat', 'plan', 'grill'],
  approvalStrategy: 'policy',
  origin: {
    kind: 'mcp',
    serverName: 'demo-server',
    rawToolName: 'action',
    generation: 1,
  },
}
const ALL_TOOLS: readonly ToolCatalogEntry[] = [
  READ_TOOL,
  WRITE_TOOL,
  EDIT_TOOL,
  SHELL_TOOL,
  REQUEST_PERMISSIONS_TOOL,
  MCP_TOOL,
]

const randomApprovalPolicy = (rng: SeededRng, forcedPolicy?: ApprovalPolicy): ApprovalPolicy => {
  if (forcedPolicy !== undefined) return forcedPolicy
  return rng.bool(0.5) ? 'never' : 'auto_review'
}

const randomPermissionConfig = (
  rng: SeededRng,
  forcedPolicy?: ApprovalPolicy,
): PermissionConfig => ({
  sandboxMode: rng.pick(SANDBOX_MODES),
  approvalPolicy: randomApprovalPolicy(rng, forcedPolicy),
  approvalsReviewer: rng.pick(APPROVAL_REVIEWERS),
})

const randomInvocation = (
  rng: SeededRng,
  options: {
    forcedPolicy?: ApprovalPolicy
    forcedTaskMode?: TaskMode
    forcedTool?: ToolCatalogEntry
    forcedRuleEffect?: PermissionRuleEffect
    forcedDenyReason?: string
    protectedPath?: { canonical: string; display: string }
    allowComputerApp?: boolean
  } = {},
): { invocation: ToolInvocation; tool: ToolCatalogEntry } => {
  const tool = options.forcedTool ?? rng.pick(ALL_TOOLS)
  const taskMode = options.forcedTaskMode ?? rng.pick(TASK_MODES)
  const permissionConfig = randomPermissionConfig(rng, options.forcedPolicy)
  const ruleEffect =
    'forcedRuleEffect' in options ? options.forcedRuleEffect : rng.pick(RULE_EFFECTS)
  const readPaths = rng.bool(0.35) ? ['/workspace/a.txt'] : []
  const writePaths = rng.bool(0.3) ? ['/workspace/out.txt'] : []
  const networkDomains = rng.bool(0.3) ? ['example.com'] : []
  const hasAdditional = readPaths.length > 0 || writePaths.length > 0 || networkDomains.length > 0

  const input: Record<string, unknown> =
    tool.sdkName === 'exec_command'
      ? {
          command: 'Get-ChildItem',
          ...(hasAdditional
            ? { additionalPermissions: { readPaths, writePaths, networkDomains } }
            : {}),
        }
      : tool.sdkName === 'request_permissions'
        ? {
            scope: rng.pick(['tool-call', 'turn', 'session']),
            readPaths,
            writePaths,
            networkDomains,
            justification: 'property test',
          }
        : {
            file_path: options.protectedPath?.canonical ?? '/workspace/file.ts',
            ...(hasAdditional
              ? { additionalPermissions: { readPaths, writePaths, networkDomains } }
              : {}),
          }

  const protectedMeta = options.protectedPath
    ? filePathProtection(options.protectedPath.canonical, options.protectedPath.display)
    : null

  const invocation: ToolInvocation = {
    id: `call-${rng.int(1, 10000)}`,
    threadID: 'thread-prop',
    turnID: 'turn-prop',
    agentID: 'agent-prop',
    name: tool.sdkName,
    input,
    permissionConfig,
    taskMode,
    model: { providerID: 'openai', id: 'test' } as unknown as ToolInvocation['model'],
    toolPolicy: {
      sdkName: tool.sdkName,
      capabilities: tool.capabilities,
      allowedModes: tool.allowedModes,
      approvalStrategy: tool.approvalStrategy,
      ...(tool.origin ? { origin: tool.origin } : {}),
    },
    permissionFacts: {
      ...(options.forcedDenyReason ? { denyReason: options.forcedDenyReason } : {}),
      ...(ruleEffect ? { ruleEffect } : {}),
      risk: protectedMeta?.requiresApproval ? 'high' : rng.bool(0.7) ? rng.pick(RISKS) : undefined,
      ruleRequiresApproval: protectedMeta?.requiresApproval ? true : rng.bool(0.3),
      hookRequiresApproval: rng.bool(0.25),
      forcedApproval: rng.bool(0.25),
      destructive: rng.bool(0.25),
      externalWrite: rng.bool(0.25),
      externalCommand: rng.bool(0.25),
      networkAccess: rng.bool(0.25),
      skillScript: rng.bool(0.2),
    },
    ...(options.allowComputerApp !== false && rng.bool(0.2)
      ? {
          authorizationScope: {
            affectedPaths: [],
            fingerprint: 'fp-prop',
            ruleRequiresApproval: rng.bool(0.5),
            computerApp: { name: 'Finder', allowPersistentApproval: false },
          },
        }
      : {}),
  }

  return { invocation, tool }
}

describe('Phase 4 Property-Based State Machine Tests', () => {
  const engine = new PermissionDecisionEngine()

  test('PermissionDecisionEngine: approvalPolicy === "never" without explicit ask rule never produces action === "review" (300 seeded runs)', () => {
    const rng = createSeededRng(0x51a7e001)
    for (let i = 0; i < 300; i += 1) {
      const { invocation, tool } = randomInvocation(rng, { forcedPolicy: 'never' })
      const resolved = engine.evaluate(invocation, tool)
      if (invocation.permissionFacts?.ruleEffect === 'ask') {
        expect(resolved.action).not.toBe('allow')
        continue
      }
      expect(resolved.action).not.toBe('review')
      expect(resolved.decision).not.toBe('ask')
    }
  })

  test('PermissionDecisionEngine: explicit deny, readOnly task mode mutations, and protected paths never produce action === "allow" (300 seeded runs each)', () => {
    const denyRng = createSeededRng(0x51a7e002)
    for (let i = 0; i < 300; i += 1) {
      const useDenyReason = denyRng.bool(0.5)
      const { invocation, tool } = randomInvocation(denyRng, {
        forcedRuleEffect: useDenyReason ? undefined : 'deny',
        forcedDenyReason: useDenyReason ? 'blocked by host rule' : undefined,
      })
      const isFullAccess =
        matchPermissionPreset(invocation.permissionConfig) === 'full-access' &&
        !isReadOnlyTaskMode(invocation.taskMode)
      if (isFullAccess && useDenyReason) continue
      const resolved = engine.evaluate(invocation, tool)
      expect(resolved.action).toBe('deny')
      expect(resolved.action).not.toBe('allow')
    }

    const readOnlyRng = createSeededRng(0x51a7e003)
    const readOnlyBlockedTools = [WRITE_TOOL, EDIT_TOOL, REQUEST_PERMISSIONS_TOOL] as const
    for (let i = 0; i < 300; i += 1) {
      const taskMode = readOnlyRng.pick(['plan', 'grill'] as const)
      const tool = readOnlyRng.pick(readOnlyBlockedTools)
      const { invocation } = randomInvocation(readOnlyRng, {
        forcedTaskMode: taskMode,
        forcedTool: tool,
      })
      const resolved = engine.evaluate(invocation, tool)
      expect(resolved.action).toBe('deny')
      expect(resolved.action).not.toBe('allow')
    }

    const protectedRng = createSeededRng(0x51a7e004)
    const protectedTargets = [
      { canonical: '/workspace/.env', display: '.env' },
      { canonical: '/workspace/.env.production', display: '.env.production' },
      { canonical: '/workspace/.git/config', display: '.git/config' },
      { canonical: '/workspace/.git/hooks/pre-commit', display: '.git/hooks/pre-commit' },
      { canonical: '/workspace/.pidex/config.json', display: '.pidex/config.json' },
      { canonical: '/users/me/.pidex/config.json', display: '@pidex/config.json' },
    ] as const
    for (let i = 0; i < 300; i += 1) {
      const target = protectedRng.pick(protectedTargets)
      expect(filePathProtection(target.canonical, target.display).requiresApproval).toBe(true)
      const nonAllowEffect = protectedRng.pick([undefined, 'ask', 'deny'] as const)
      const { invocation, tool } = randomInvocation(protectedRng, {
        forcedTool: protectedRng.pick([WRITE_TOOL, EDIT_TOOL]),
        protectedPath: target,
        forcedRuleEffect: nonAllowEffect,
        allowComputerApp: false,
      })
      const isFullAccess =
        matchPermissionPreset(invocation.permissionConfig) === 'full-access' &&
        !isReadOnlyTaskMode(invocation.taskMode)
      if (isFullAccess) continue
      const resolved = engine.evaluate(invocation, tool)
      expect(resolved.action).not.toBe('allow')
    }
  })

  test('PermissionDecisionEngine: forceHumanApproval never routes to auto_review (300 seeded runs)', () => {
    const rng = createSeededRng(0x51a7e005)
    let forcedCount = 0
    for (let i = 0; i < 300; i += 1) {
      const { invocation, tool } = randomInvocation(rng, { forcedPolicy: 'auto_review' })
      if (i % 3 === 0 && invocation.permissionFacts) {
        invocation.permissionConfig = {
          ...invocation.permissionConfig,
          sandboxMode: 'workspace-write',
          approvalsReviewer: 'auto_review',
        }
        invocation.permissionFacts = {
          ...invocation.permissionFacts,
          ruleEffect: rng.bool(0.5) ? 'ask' : undefined,
          hookRequiresApproval: rng.bool(0.5),
        }
      }
      const resolved = engine.evaluate(invocation, tool)
      if (resolved.action === 'review' && resolved.forceHumanApproval) {
        forcedCount += 1
        expect(resolved.forceHumanApproval).toBe(true)
      }
    }
    expect(forcedCount).toBeGreaterThan(0)
  })

  const tempDirs: string[] = []
  const openDbs: AgentDatabase[] = []

  afterEach(() => {
    for (const db of openDbs.splice(0)) db.close()
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const createTempRegistry = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pidex-formal-prop-'))
    tempDirs.push(dir)
    const db = new AgentDatabase(join(dir, 'history.sqlite'))
    openDbs.push(db)
    const registryInstance = new EventSubscriptionRegistry(db, {
      maxSubscriptions: 32,
      maxStreamsPerSubscription: 8,
    })
    return { db, registry: registryInstance }
  }

  const streamBounds = (db: AgentDatabase, streamId: string) => {
    const high = globalEventSequence(db)
    const row =
      streamId === 'global'
        ? (db.sqlite.query('SELECT MIN(id) AS low FROM events').get() as { low: number | null })
        : (db.sqlite
            .query('SELECT MIN(id) AS low FROM events WHERE thread_id = ?')
            .get(streamId) as {
            low: number | null
          })
    return {
      low: row.low === null ? null : Number(row.low),
      high,
    }
  }

  const expectAgentErrorCode = (fn: () => unknown, expectedCode: string) => {
    try {
      fn()
      throw new Error(`Expected AgentError(${expectedCode}) but succeeded`)
    } catch (error) {
      expect(error).toBeInstanceOf(AgentError)
      expect((error as AgentError).code).toBe(expectedCode)
    }
  }

  test('EventSubscriptionRegistry: randomized subscribe/ack/prune/replay preserves cursor bounds, monotonicity, and gap-free ordering (200 seeded runs)', () => {
    const rng = createSeededRng(0x51a7e006)
    let sharedDb: AgentDatabase | null = null

    for (let run = 0; run < 200; run += 1) {
      if (run % 25 === 0) {
        sharedDb = createTempRegistry().db
        expectAgentErrorCode(
          () =>
            new EventSubscriptionRegistry(sharedDb!).subscribe(`conn-empty-${run}`, {
              streams: [{ streamId: 'global', after: 1 }],
            }),
          'CURSOR_EXPIRED',
        )
      }
      const db = sharedDb!
      const subRegistry = new EventSubscriptionRegistry(db, {
        maxSubscriptions: 32,
        maxStreamsPerSubscription: 8,
      })
      const connectionId = `conn-prop-${run}`
      const activeSubs = new Map<string, { streamId: string; ack: number }>()
      const threadIds: string[] = []

      if (rng.bool(0.75)) {
        const thread = db.createThread(`prop-${run}`)
        threadIds.push(thread.id)
      }

      const steps = 12
      for (let step = 0; step < steps; step += 1) {
        const op = rng.int(0, 5)
        const candidateStreams = ['global', ...threadIds]
        const streamId = rng.pick(candidateStreams)
        const bounds = streamBounds(db, streamId)

        if (op === 0) {
          const targetThread = threadIds.length > 0 && rng.bool(0.6) ? rng.pick(threadIds) : null
          const beforeHigh = globalEventSequence(db)
          const inserted = db.insertEvent(targetThread, null, 'thread/updated', { run, step })
          expect(inserted.id).toBe(beforeHigh + 1)
        } else if (op === 1) {
          const globalBounds = streamBounds(db, 'global')
          if (globalBounds.low !== null && globalBounds.high > globalBounds.low) {
            const trimCutoff = rng.int(globalBounds.low, globalBounds.high - 1)
            db.sqlite.query('DELETE FROM events WHERE id <= ?').run(trimCutoff)
            const afterTrim = streamBounds(db, 'global')
            expect(afterTrim.low).toBeGreaterThan(trimCutoff)
            expect(afterTrim.high).toBe(globalBounds.high)
          }
        } else if (op === 2) {
          if (activeSubs.size >= 16) {
            const [firstId] = activeSubs.keys()
            if (firstId) {
              subRegistry.unsubscribe(connectionId, firstId)
              activeSubs.delete(firstId)
            }
          }
          const mode = rng.int(0, 3)
          if (mode === 0) {
            const sub = subRegistry.subscribe(connectionId, {
              streams: [{ streamId, after: 'latest' }],
            })
            expect(sub.highWatermarks[0]?.sequence).toBe(bounds.high)
            activeSubs.set(sub.subscriptionId, { streamId, ack: bounds.high })
          } else if (mode === 1) {
            const minValid = bounds.low === null ? 0 : bounds.low - 1
            const after = rng.int(minValid, bounds.high)
            const sub = subRegistry.subscribe(connectionId, {
              streams: [{ streamId, after }],
            })
            const stored = subRegistry.get(sub.subscriptionId, connectionId)!
            expect(stored.acknowledged.get(streamId)).toBe(after)
            activeSubs.set(sub.subscriptionId, { streamId, ack: after })
          } else if (mode === 2 && bounds.low !== null && bounds.low >= 1) {
            const expiredAfter = rng.int(-1, bounds.low - 2)
            expectAgentErrorCode(
              () =>
                subRegistry.subscribe(connectionId, {
                  streams: [{ streamId, after: expiredAfter }],
                }),
              'CURSOR_EXPIRED',
            )
          } else {
            const futureAfter = bounds.high + rng.int(1, 5)
            expectAgentErrorCode(
              () =>
                subRegistry.subscribe(connectionId, {
                  streams: [{ streamId, after: futureAfter }],
                }),
              'CURSOR_EXPIRED',
            )
          }
        } else if (op === 3 && activeSubs.size > 0) {
          const subIds = [...activeSubs.keys()]
          const subId = rng.pick(subIds)
          const subState = activeSubs.get(subId)!
          const high = globalEventSequence(db)
          if (rng.bool(0.75)) {
            const seq = rng.int(0, high)
            const res = subRegistry.ack(connectionId, {
              subscriptionId: subId,
              positions: [{ streamId: subState.streamId, sequence: seq }],
            })
            const nextAck = res.acknowledged[0]!.sequence
            expect(nextAck).toBe(Math.max(subState.ack, seq))
            expect(nextAck).toBeGreaterThanOrEqual(subState.ack)
            expect(nextAck).toBeLessThanOrEqual(high)
            subState.ack = nextAck
          } else {
            const invalidSeq = high + rng.int(1, 4)
            expectAgentErrorCode(
              () =>
                subRegistry.ack(connectionId, {
                  subscriptionId: subId,
                  positions: [{ streamId: subState.streamId, sequence: invalidSeq }],
                }),
              'CONFLICT',
            )
          }
        } else if (op === 4 && activeSubs.size > 0) {
          const subIds = [...activeSubs.keys()]
          const subId = rng.pick(subIds)
          const subRecord = subRegistry.get(subId, connectionId)!
          const [subStreamId] = subRecord.streams.keys()
          const subBounds = streamBounds(db, subStreamId!)
          if (subBounds.low !== null && subBounds.low >= 2 && rng.bool(0.5)) {
            const expired = rng.int(0, subBounds.low - 2)
            expectAgentErrorCode(
              () => subRegistry.validateLastEventID(subRecord, String(expired)),
              'CURSOR_EXPIRED',
            )
          } else if (rng.bool(0.5)) {
            const future = subBounds.high + rng.int(1, 4)
            expectAgentErrorCode(
              () => subRegistry.validateLastEventID(subRecord, String(future)),
              'CONFLICT',
            )
          }
        } else {
          const globalBounds = streamBounds(db, 'global')
          const minValid = globalBounds.low === null ? 0 : globalBounds.low - 1
          const after = rng.int(minValid, globalBounds.high)
          const replayed = db.eventsAfter(after)
          for (let idx = 0; idx < replayed.length; idx += 1) {
            expect(replayed[idx]!.id).toBeGreaterThan(after)
            expect(replayed[idx]!.id).toBeLessThanOrEqual(globalBounds.high)
            if (idx > 0) {
              expect(replayed[idx]!.id).toBe(replayed[idx - 1]!.id + 1)
            }
          }
          if (after < globalBounds.high && globalBounds.low !== null) {
            expect(replayed.length).toBe(globalBounds.high - after)
            expect(replayed[0]!.id).toBe(after + 1)
            expect(replayed.at(-1)!.id).toBe(globalBounds.high)
          } else {
            expect(replayed.length).toBe(0)
          }
        }
      }
    }
  })

  const createInteractionHarness = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pidex-formal-approval-'))
    tempDirs.push(dir)
    const db = new AgentDatabase(join(dir, 'history.sqlite'))
    openDbs.push(db)
    const publishedEvents: EventEnvelope[] = []
    const hub = {
      publish: (event: EventEnvelope) =>
        db.effect(() => {
          publishedEvents.push(event)
          return true
        }),
    } as unknown as EventHub
    const tools = new ToolRegistry()
    const approvals = new ApprovalService(db, hub, tools, null)
    const questions = new QuestionService(db, hub, false)
    const resolver = new ResumeCheckpointResolver(db, approvals)
    const resumedTurns: Array<{ threadID: string; turnID: string }> = []
    const stoppedTurns: Array<{ threadID: string; turnID: string }> = []
    const interactions = new InteractionService({
      db,
      hub,
      approvals,
      questions,
      subagents: {
        stop: async () => {},
        resumeTurn: async () => {},
      } as unknown as ConstructorParameters<typeof InteractionService>[0]['subagents'],
      threads: {
        resumeTurn: (threadID: string, turnID: string) => {
          resumedTurns.push({ threadID, turnID })
        },
        abortStoppedTurn: async (threadID: string, turnID: string) => {
          stoppedTurns.push({ threadID, turnID })
        },
        resumeHookTrust: () => {},
      } as unknown as ConstructorParameters<typeof InteractionService>[0]['threads'],
    })
    return {
      db,
      hub,
      tools,
      approvals,
      questions,
      resolver,
      interactions,
      resumedTurns,
      stoppedTurns,
    }
  }

  const startTurnInDb = (
    db: AgentDatabase,
    threadID: string,
    approvalPolicy: ApprovalPolicy = 'auto_review',
  ) => {
    const input: SubmitMessage = {
      content: 'formal state machine turn',
      model: { providerID: 'openai', id: 'test' } as unknown as SubmitMessage['model'],
      permissionConfig: {
        sandboxMode: 'workspace-write',
        approvalPolicy,
        approvalsReviewer: 'auto_review',
      },
      strategy: 'queue',
      taskMode: 'chat',
    }
    const turn = db.createTurn(threadID, input)
    db.claimTurnExecution(turn.turnID)
    return { turn, input }
  }

  test('InteractionService + ApprovalService + ResumeCheckpointResolver: randomized lifecycle preserves uniqueness, fingerprint binding, and interrupt safety (100 seeded runs)', async () => {
    const rng = createSeededRng(0x51a7e007)
    let shared: Awaited<ReturnType<typeof createInteractionHarness>> | null = null

    for (let run = 0; run < 100; run += 1) {
      if (run % 20 === 0) {
        shared = await createInteractionHarness()
      }
      const { db, approvals, questions, resolver, interactions } = shared!
      const thread = db.createThread(`approval-prop-${run}`)
      const policy = rng.pick(['never', 'auto_review'] as const)
      const { turn, input } = startTurnInDb(db, thread.id, policy)
      const toolCallID = `call-${run}-${rng.int(1, 99999)}`
      const fingerprint = `fp-${run}-${rng.int(1, 999)}`
      const useQuestion = rng.bool(0.25)

      if (useQuestion) {
        const questionID = await questions.checkpoint(thread.id, turn.turnID, turn.agentID, {
          kind: 'clarification',
          question: 'choose',
          options: ['A', 'B'],
          checkpoint: {
            state: JSON.stringify({ step: run }),
            interruption: { callId: toolCallID },
          },
        })
        const pendingBefore = interactions.listPending({ threadId: thread.id }).interactions
        expect(pendingBefore.filter((item) => item.turnId === turn.turnID)).toHaveLength(1)

        if (rng.bool(0.35)) {
          db.finalizeTurn({
            threadID: thread.id,
            turnID: turn.turnID,
            agentID: turn.agentID,
            status: 'interrupted',
          })
          expect(
            interactions
              .listPending({ threadId: thread.id })
              .interactions.filter((item) => item.turnId === turn.turnID),
          ).toHaveLength(0)
          expect(resolver.acquire(turn.turnID, 'main', `lease-q-int-${run}`)).toBeNull()
          await expect(
            interactions.respond({
              interactionId: questionID,
              operationId: `op-q-int-${run}`,
              expectedVersion: 2,
              response: { kind: 'question', status: 'ignored' },
            }),
          ).rejects.toThrow()
        } else {
          await expect(
            interactions.respond({
              interactionId: questionID,
              operationId: `op-q-badver-${run}`,
              expectedVersion: 99,
              response: { kind: 'question', status: 'ignored' },
            }),
          ).rejects.toThrow()
          expect(
            interactions
              .listPending({ threadId: thread.id })
              .interactions.filter((item) => item.turnId === turn.turnID),
          ).toHaveLength(1)

          await interactions.respond({
            interactionId: questionID,
            operationId: `op-q-ok-${run}`,
            expectedVersion: 2,
            response: { kind: 'question', status: 'ignored' },
          })
          const leaseID = `lease-q-${run}`
          const acquired = resolver.acquire(turn.turnID, 'main', leaseID)
          expect(acquired).not.toBeNull()
          expect(acquired!.checkpoint.kind).toBe('question')
          expect(resolver.acquire(turn.turnID, 'main', `${leaseID}-other`)).toBeNull()
          expect(resolver.complete(leaseID)).toBe(true)
          expect(resolver.acquire(turn.turnID, 'main', `${leaseID}-after`)).toBeNull()
        }
        continue
      }

      const ruleEffect = rng.pick([undefined, 'allow', 'deny', 'ask'] as const)
      const invocation: ToolInvocation = {
        id: toolCallID,
        threadID: thread.id,
        turnID: turn.turnID,
        agentID: turn.agentID,
        name: 'exec_command',
        input: { command: 'Get-ChildItem' },
        permissionConfig: input.permissionConfig,
        taskMode: 'chat',
        model: input.model,
        durableApproval: true,
        authorizationScope: {
          affectedPaths: [],
          fingerprint,
          ruleRequiresApproval: rng.bool(0.5),
        },
        permissionFacts: {
          ruleFactsLoaded: true,
          ...(ruleEffect ? { ruleEffect } : {}),
          risk: rng.pick(['low', 'medium', 'high'] as const),
          forcedApproval: rng.bool(0.3),
        },
      }

      const auth = await approvals.authorize(invocation, new AbortController().signal)
      if (policy === 'never' && ruleEffect !== 'ask') {
        expect(auth.decision).not.toBe('ask')
      }
      if (ruleEffect === 'ask') {
        expect(auth.decision).toBe('ask')
      }
      if (ruleEffect === 'deny') {
        expect(auth.decision).toBe('deny')
      }
      if (auth.decision !== 'ask') {
        expect(db.approvalCheckpointForToolCall(toolCallID)).toBeNull()
        expect(resolver.acquire(turn.turnID, 'main', `lease-none-${run}`)).toBeNull()
        continue
      }

      await approvals.attachRunState(toolCallID, JSON.stringify({ step: run }), {
        callId: toolCallID,
      })
      const stored = db.approvalCheckpointForToolCall(toolCallID)!
      expect(stored.status).toBe('pending')

      const pendingForTurn = interactions
        .listPending({ threadId: thread.id })
        .interactions.filter((item) => item.turnId === turn.turnID)
      expect(pendingForTurn.length).toBeLessThanOrEqual(1)
      expect(pendingForTurn).toHaveLength(1)

      await expect(
        interactions.respond({
          interactionId: stored.approvalID,
          operationId: `op-bad-ver-${run}`,
          expectedVersion: stored.version + 1,
          response: { kind: 'approval', decision: 'allow-once' },
        }),
      ).rejects.toThrow()
      expect(db.getApprovalCheckpoint(stored.approvalID)?.status).toBe('pending')

      await expect(
        interactions.respond({
          interactionId: stored.approvalID,
          operationId: `op-bad-remember-${run}`,
          expectedVersion: stored.version,
          response: {
            kind: 'approval',
            decision: 'allow-once',
            remember: { scope: 'tool', value: 'exec_command' },
          },
        }),
      ).rejects.toThrow()
      expect(db.getApprovalCheckpoint(stored.approvalID)?.status).toBe('pending')

      const action = rng.pick(['interrupt', 'cancel', 'stop', 'tamper', 'allow', 'deny'] as const)
      if (action === 'interrupt' || action === 'cancel') {
        if (action === 'interrupt') {
          db.finalizeTurn({
            threadID: thread.id,
            turnID: turn.turnID,
            agentID: turn.agentID,
            status: 'interrupted',
          })
        } else {
          approvals.cancelTurn(turn.turnID)
        }
        expect(db.getApprovalCheckpoint(stored.approvalID)?.status).toBe('cancelled')
        expect(
          interactions
            .listPending({ threadId: thread.id })
            .interactions.filter((item) => item.turnId === turn.turnID),
        ).toHaveLength(0)
        expect(resolver.acquire(turn.turnID, 'main', `lease-int-${run}`)).toBeNull()
        expect(approvals.claimResume(turn.turnID)).toBeNull()
        await expect(
          interactions.respond({
            interactionId: stored.approvalID,
            operationId: `op-after-int-${run}`,
            expectedVersion: stored.version,
            response: { kind: 'approval', decision: 'allow-once' },
          }),
        ).rejects.toThrow()
        continue
      }

      if (action === 'stop') {
        await interactions.respond({
          interactionId: stored.approvalID,
          operationId: `op-stop-${run}`,
          expectedVersion: stored.version,
          response: { kind: 'approval', decision: 'stop' },
        })
        expect(db.getApprovalCheckpoint(stored.approvalID)?.status).toBe('cancelled')
        expect(resolver.acquire(turn.turnID, 'main', `lease-stop-${run}`)).toBeNull()
        continue
      }

      if (action === 'tamper') {
        const tamperedPayload = {
          ...stored.payload,
          invocation: {
            ...stored.payload.invocation,
            authorizationScope: {
              affectedPaths: [],
              fingerprint: `${fingerprint}-tampered`,
              ruleRequiresApproval: true,
            },
          },
        }
        db.updateApprovalCheckpointPayload(stored.approvalID, tamperedPayload)
        await expect(
          interactions.respond({
            interactionId: stored.approvalID,
            operationId: `op-tamper-${run}`,
            expectedVersion: stored.version,
            response: { kind: 'approval', decision: 'allow-once' },
          }),
        ).rejects.toThrow()
        expect(db.getApprovalCheckpoint(stored.approvalID)?.status).toBe('cancelled')
        expect(resolver.acquire(turn.turnID, 'main', `lease-tamper-${run}`)).toBeNull()
        continue
      }

      const decision = action === 'allow' ? 'allow-once' : 'deny'
      const opID = `op-resolve-${run}`
      await interactions.respond({
        interactionId: stored.approvalID,
        operationId: opID,
        expectedVersion: stored.version,
        response: { kind: 'approval', decision },
      })

      await expect(
        interactions.respond({
          interactionId: stored.approvalID,
          operationId: opID,
          expectedVersion: stored.version,
          response: {
            kind: 'approval',
            decision: decision === 'allow-once' ? 'deny' : 'allow-once',
          },
        }),
      ).rejects.toThrow()

      await interactions.respond({
        interactionId: stored.approvalID,
        operationId: opID,
        expectedVersion: stored.version,
        response: { kind: 'approval', decision },
      })

      const leaseID = `lease-ok-${run}`
      const acquired = resolver.acquire(turn.turnID, 'main', leaseID)
      expect(acquired).not.toBeNull()
      expect(acquired!.checkpoint.kind).toBe('permission')
      if (acquired!.checkpoint.kind === 'permission') {
        expect(acquired!.checkpoint.authorizationFingerprint).toBe(fingerprint)
        expect(acquired!.checkpoint.decision).toBe(action)
        expect(acquired!.checkpoint.authorizationFingerprint).not.toBe(`${fingerprint}-mismatched`)
      }
      expect(resolver.acquire(turn.turnID, 'main', leaseID)).toEqual(acquired)
      expect(resolver.acquire(turn.turnID, 'main', `${leaseID}-other`)).toBeNull()

      if (rng.bool(0.35)) {
        const recovered = resolver.recoverInterruptedLeases(Date.now())
        expect(recovered.available).toContain(turn.turnID)
        const reacquired = resolver.acquire(turn.turnID, 'main', `${leaseID}-re`)
        expect(reacquired).not.toBeNull()
        expect(resolver.complete(`${leaseID}-re`)).toBe(true)
      } else {
        expect(resolver.complete(leaseID)).toBe(true)
        expect(resolver.acquire(turn.turnID, 'main', `${leaseID}-after`)).toBeNull()
      }
    }
  })

  test('TS Trace -> RpcOutboxSseReplay.tla invariant replay across every intermediate step (40 seeded traces)', () => {
    interface ProjectedOutboxState {
      lowWatermark: number
      highWatermark: number
      outbox: Set<number>
      publishedLog: number[]
      subActive: Record<string, boolean>
      startCursor: Record<string, number>
      subCursor: Record<string, number>
      ackCursor: Record<string, number>
      delivered: Record<string, number[]>
      lastAttemptCursor: Record<string, number>
      lastAttemptLow: Record<string, number>
      lastAttemptHigh: Record<string, number>
      lastAttemptResult: Record<string, 'NONE' | 'OK' | 'CURSOR_EXPIRED'>
    }

    const clients = ['c1', 'c2'] as const
    const cursorValid = (cursor: number, low: number, high: number) =>
      cursor <= high && (low === 0 || cursor >= low - 1)

    const assertRpcOutboxTlaInvariants = (
      state: ProjectedOutboxState,
      maxSeq: number,
      db: AgentDatabase,
      subRegistry: EventSubscriptionRegistry,
      subIds: Record<string, string | null>,
    ) => {
      expect(state.lowWatermark).toBeGreaterThanOrEqual(0)
      expect(state.lowWatermark).toBeLessThanOrEqual(maxSeq)
      expect(state.highWatermark).toBeGreaterThanOrEqual(0)
      expect(state.highWatermark).toBeLessThanOrEqual(maxSeq)
      expect(state.publishedLog.length).toBe(state.highWatermark)

      for (let i = 0; i < state.publishedLog.length; i += 1) {
        expect(state.publishedLog[i]).toBe(i + 1)
      }
      if (state.highWatermark === 0) {
        expect(state.lowWatermark).toBe(0)
        expect(state.outbox.size).toBe(0)
      } else {
        expect(state.lowWatermark).toBeGreaterThanOrEqual(1)
        expect(state.lowWatermark).toBeLessThanOrEqual(state.highWatermark)
        const expectedSize = state.highWatermark - state.lowWatermark + 1
        expect(state.outbox.size).toBe(expectedSize)
        for (let seq = state.lowWatermark; seq <= state.highWatermark; seq += 1) {
          expect(state.outbox.has(seq)).toBe(true)
        }
      }

      for (const c of clients) {
        const del = state.delivered[c]!
        const seen = new Set<number>()
        for (let i = 0; i < del.length; i += 1) {
          expect(del[i]).toBe(state.startCursor[c]! + i + 1)
          expect(seen.has(del[i]!)).toBe(false)
          seen.add(del[i]!)
          if (i > 0) expect(del[i]).toBe(del[i - 1]! + 1)
        }
        expect(state.subCursor[c]).toBe(state.startCursor[c]! + del.length)
        expect(state.ackCursor[c]).toBeLessThanOrEqual(state.highWatermark)

        const result = state.lastAttemptResult[c]!
        if (result === 'CURSOR_EXPIRED') {
          expect(
            cursorValid(
              state.lastAttemptCursor[c]!,
              state.lastAttemptLow[c]!,
              state.lastAttemptHigh[c]!,
            ),
          ).toBe(false)
        } else if (result === 'OK') {
          expect(
            cursorValid(
              state.lastAttemptCursor[c]!,
              state.lastAttemptLow[c]!,
              state.lastAttemptHigh[c]!,
            ),
          ).toBe(true)
        }

        const subId = subIds[c]
        if (state.subActive[c]) {
          expect(subId).not.toBeNull()
          const stored = subRegistry.get(subId!, `conn-${c}`)
          expect(stored).not.toBeNull()
          expect(stored!.acknowledged.get('global')).toBe(state.ackCursor[c])
          if (cursorValid(state.subCursor[c]!, state.lowWatermark, state.highWatermark)) {
            expect(() =>
              subRegistry.validateLastEventID(stored!, String(state.subCursor[c])),
            ).not.toThrow()
          } else {
            expectAgentErrorCode(
              () => subRegistry.validateLastEventID(stored!, String(state.subCursor[c])),
              'CURSOR_EXPIRED',
            )
          }
        } else if (subId) {
          expect(subRegistry.get(subId, `conn-${c}`)).toBeNull()
        }
      }

      if (state.highWatermark > 0) {
        const replayStart = state.lowWatermark - 1
        const retained = db.eventsAfter(replayStart)
        expect(retained.map((e) => e.id)).toEqual(
          Array.from(
            { length: state.highWatermark - state.lowWatermark + 1 },
            (_, idx) => state.lowWatermark + idx,
          ),
        )
      }
    }

    const rng = createSeededRng(0x51a7e008)
    const maxSteps = 20

    for (let trace = 0; trace < 40; trace += 1) {
      const { db, registry: subRegistry } = createTempRegistry()
      const publishedLog: number[] = []
      const subIds: Record<string, string | null> = { c1: null, c2: null }
      const state: ProjectedOutboxState = {
        lowWatermark: 0,
        highWatermark: 0,
        outbox: new Set(),
        publishedLog,
        subActive: { c1: false, c2: false },
        startCursor: { c1: 0, c2: 0 },
        subCursor: { c1: 0, c2: 0 },
        ackCursor: { c1: 0, c2: 0 },
        delivered: { c1: [], c2: [] },
        lastAttemptCursor: { c1: 0, c2: 0 },
        lastAttemptLow: { c1: 0, c2: 0 },
        lastAttemptHigh: { c1: 0, c2: 0 },
        lastAttemptResult: { c1: 'NONE', c2: 'NONE' },
      }

      const syncOutboxFromDb = () => {
        const rows = db.sqlite.query('SELECT id FROM events ORDER BY id').all() as Array<{
          id: number
        }>
        state.highWatermark = globalEventSequence(db)
        state.lowWatermark = rows.length === 0 ? 0 : rows[0]!.id
        state.outbox = new Set(rows.map((r) => r.id))
      }

      assertRpcOutboxTlaInvariants(state, maxSteps, db, subRegistry, subIds)

      for (let step = 0; step < maxSteps; step += 1) {
        const action = rng.int(0, 6)
        const c = rng.pick(clients)
        const connId = `conn-${c}`

        if (action === 0) {
          const inserted = db.insertEvent(null, null, 'thread/updated', { trace, step })
          publishedLog.push(inserted.id)
          syncOutboxFromDb()
        } else if (
          action === 1 &&
          state.lowWatermark > 0 &&
          state.lowWatermark < state.highWatermark
        ) {
          db.sqlite.query('DELETE FROM events WHERE id = ?').run(state.lowWatermark)
          syncOutboxFromDb()
        } else if (action === 2 && !state.subActive[c]) {
          const after = rng.int(0, state.highWatermark + 2)
          state.lastAttemptCursor[c] = after
          state.lastAttemptLow[c] = state.lowWatermark
          state.lastAttemptHigh[c] = state.highWatermark
          if (cursorValid(after, state.lowWatermark, state.highWatermark)) {
            const sub = subRegistry.subscribe(connId, { streams: [{ streamId: 'global', after }] })
            subIds[c] = sub.subscriptionId
            state.subActive[c] = true
            state.startCursor[c] = after
            state.subCursor[c] = after
            state.ackCursor[c] = after
            state.delivered[c] = []
            state.lastAttemptResult[c] = 'OK'
          } else {
            expectAgentErrorCode(
              () => subRegistry.subscribe(connId, { streams: [{ streamId: 'global', after }] }),
              'CURSOR_EXPIRED',
            )
            state.lastAttemptResult[c] = 'CURSOR_EXPIRED'
          }
        } else if (
          action === 3 &&
          state.subActive[c] &&
          state.subCursor[c]! < state.highWatermark &&
          state.outbox.has(state.subCursor[c]! + 1)
        ) {
          const nextEvents = db.eventsAfter(state.subCursor[c]!, undefined, 1)
          expect(nextEvents).toHaveLength(1)
          const nextSeq = nextEvents[0]!.id
          expect(nextSeq).toBe(state.subCursor[c]! + 1)
          state.subCursor[c] = nextSeq
          state.delivered[c]!.push(nextSeq)
        } else if (action === 4 && state.subActive[c]) {
          const seq = rng.int(state.ackCursor[c]!, state.highWatermark)
          const acked = subRegistry.ack(connId, {
            subscriptionId: subIds[c]!,
            positions: [{ streamId: 'global', sequence: seq }],
          })
          state.ackCursor[c] = acked.acknowledged[0]!.sequence
        } else if (action === 5) {
          const lastSeen = rng.int(0, state.highWatermark + 2)
          if (subIds[c]) {
            subRegistry.unsubscribe(connId, subIds[c]!)
            subIds[c] = null
          }
          state.lastAttemptCursor[c] = lastSeen
          state.lastAttemptLow[c] = state.lowWatermark
          state.lastAttemptHigh[c] = state.highWatermark
          if (cursorValid(lastSeen, state.lowWatermark, state.highWatermark)) {
            const sub = subRegistry.subscribe(connId, {
              streams: [{ streamId: 'global', after: lastSeen }],
            })
            const record = subRegistry.get(sub.subscriptionId, connId)!
            expect(() => subRegistry.validateLastEventID(record, String(lastSeen))).not.toThrow()
            subIds[c] = sub.subscriptionId
            state.subActive[c] = true
            state.startCursor[c] = lastSeen
            state.subCursor[c] = lastSeen
            state.ackCursor[c] = lastSeen
            state.delivered[c] = []
            state.lastAttemptResult[c] = 'OK'
            const catchup = db.eventsAfter(lastSeen)
            for (const ev of catchup) {
              state.subCursor[c] = ev.id
              state.delivered[c]!.push(ev.id)
            }
          } else {
            expectAgentErrorCode(
              () =>
                subRegistry.subscribe(connId, {
                  streams: [{ streamId: 'global', after: lastSeen }],
                }),
              'CURSOR_EXPIRED',
            )
            state.subActive[c] = false
            state.lastAttemptResult[c] = 'CURSOR_EXPIRED'
          }
        } else if (action === 6 && state.subActive[c]) {
          subRegistry.unsubscribe(connId, subIds[c]!)
          subIds[c] = null
          state.subActive[c] = false
        }

        assertRpcOutboxTlaInvariants(state, maxSteps, db, subRegistry, subIds)
      }
    }
  })

  test('TS Trace -> ApprovalInterruptRecovery.tla invariant replay across every intermediate step (60 seeded traces)', async () => {
    type TlaPolicy = 'never' | 'auto_review'
    type TlaPhase = 'idle' | 'evaluated' | 'waiting_approval' | 'resumed' | 'completed' | 'denied'
    type TlaDecision = 'none' | 'allow' | 'review' | 'deny'

    interface ProjectedApprovalState {
      parentPolicy: TlaPolicy
      subagentPolicy: TlaPolicy
      phase: TlaPhase
      decision: TlaDecision
      activePolicy: TlaPolicy
      hasDenyRule: boolean
      hasAskRule: boolean
      hasAllowRule: boolean
      needsApproval: boolean
      opFingerprint: string
      checkpointActive: boolean
      checkpointFingerprint: string
      resumedWithFingerprint: string
      resumeAccepted: boolean
    }

    const policyRank: Record<TlaPolicy, number> = {
      never: 0,
      auto_review: 1,
    }
    const policies: readonly TlaPolicy[] = ['never', 'auto_review']
    const fingerprints = ['fp1', 'fp2'] as const

    const assertApprovalTlaInvariants = (
      state: ProjectedApprovalState,
      db: AgentDatabase,
      interactions: InteractionService,
      resolver: ResumeCheckpointResolver,
      turnID: string | null,
      threadID: string,
    ) => {
      expect(policies).toContain(state.parentPolicy)
      expect(policies).toContain(state.subagentPolicy)
      expect(policyRank[state.subagentPolicy]).toBeLessThanOrEqual(policyRank[state.parentPolicy])

      if (state.activePolicy === 'never' && !state.hasAskRule) {
        expect(state.decision).not.toBe('review')
        expect(state.phase).not.toBe('waiting_approval')
      }
      if (state.phase !== 'idle' && state.hasDenyRule) {
        expect(state.decision).toBe('deny')
        expect(state.phase).toBe('denied')
      }
      if (state.resumeAccepted) {
        expect(state.resumedWithFingerprint).toBe(state.checkpointFingerprint)
        expect(state.checkpointFingerprint).not.toBe('none')
      }
      if (
        state.resumedWithFingerprint !== 'none' &&
        state.resumedWithFingerprint !== state.checkpointFingerprint
      ) {
        expect(state.phase).not.toBe('resumed')
        expect(state.resumeAccepted).toBe(false)
      }

      if (turnID) {
        const pending = interactions
          .listPending({ threadId: threadID })
          .interactions.filter((item) => item.turnId === turnID)
        if (state.phase === 'waiting_approval') {
          expect(pending).toHaveLength(1)
        } else {
          expect(pending).toHaveLength(0)
        }
        if (state.phase === 'denied') {
          const lease = resolver.acquire(turnID, 'main', `check-denied-${turnID}`)
          if (lease && lease.checkpoint.kind === 'permission') {
            expect(lease.checkpoint.decision).toBe('deny')
            resolver.complete(lease.leaseID)
          }
          expect(db.repositories.interactions.pendingApprovalIDs(threadID).length).toBe(0)
        }
      }
    }

    const rng = createSeededRng(0x51a7e009)
    let harness: Awaited<ReturnType<typeof createInteractionHarness>> | null = null

    for (let trace = 0; trace < 60; trace += 1) {
      if (trace % 15 === 0) {
        harness = await createInteractionHarness()
      }
      const { db, approvals, resolver, interactions } = harness!
      const thread = db.createThread(`tla-approval-trace-${trace}`)
      const parentPolicy = rng.pick(policies)
      const subagentCandidates = policies.filter((p) => policyRank[p] <= policyRank[parentPolicy])
      const state: ProjectedApprovalState = {
        parentPolicy,
        subagentPolicy: rng.pick(subagentCandidates),
        phase: 'idle',
        decision: 'none',
        activePolicy: parentPolicy,
        hasDenyRule: false,
        hasAskRule: false,
        hasAllowRule: false,
        needsApproval: false,
        opFingerprint: 'none',
        checkpointActive: false,
        checkpointFingerprint: 'none',
        resumedWithFingerprint: 'none',
        resumeAccepted: false,
      }

      let activeTurnID: string | null = null
      let activeToolCallID: string | null = null
      let activeApprovalID: string | null = null

      assertApprovalTlaInvariants(state, db, interactions, resolver, activeTurnID, thread.id)

      for (let round = 0; round < 3; round += 1) {
        if (rng.bool(0.5)) {
          const candidateSub = rng.pick(policies)
          if (policyRank[candidateSub] <= policyRank[state.parentPolicy]) {
            state.subagentPolicy = candidateSub
          }
          assertApprovalTlaInvariants(state, db, interactions, resolver, activeTurnID, thread.id)
        }

        const useSubagent = rng.bool(0.5)
        const effPolicy = useSubagent ? state.subagentPolicy : state.parentPolicy
        const denyFlag = rng.bool(0.25)
        const askFlag = !denyFlag && rng.bool(0.25)
        const allowFlag = !denyFlag && !askFlag && rng.bool(0.25)
        const needsRev = !allowFlag && rng.bool(0.6)
        const fp = rng.pick(fingerprints)

        const { turn, input } = startTurnInDb(db, thread.id, effPolicy)
        activeTurnID = turn.turnID
        activeToolCallID = `trace-${trace}-round-${round}-${rng.int(1, 9999)}`

        const invocation: ToolInvocation = {
          id: activeToolCallID,
          threadID: thread.id,
          turnID: turn.turnID,
          agentID: turn.agentID,
          name: 'exec_command',
          input: { command: 'Get-ChildItem' },
          permissionConfig: input.permissionConfig,
          taskMode: 'chat',
          model: input.model,
          durableApproval: true,
          authorizationScope: {
            affectedPaths: [],
            fingerprint: fp,
            ruleRequiresApproval: needsRev,
          },
          permissionFacts: {
            ruleFactsLoaded: true,
            ...(denyFlag
              ? { ruleEffect: 'deny' as const }
              : askFlag
                ? { ruleEffect: 'ask' as const }
                : allowFlag
                  ? { ruleEffect: 'allow' as const }
                  : {}),
            risk: needsRev ? 'high' : 'low',
            forcedApproval: needsRev,
          },
        }

        const auth = await approvals.authorize(invocation, new AbortController().signal)
        state.activePolicy = effPolicy
        state.hasDenyRule = denyFlag
        state.hasAskRule = askFlag
        state.hasAllowRule = allowFlag
        state.needsApproval = needsRev
        state.opFingerprint = fp
        state.checkpointActive = false
        state.checkpointFingerprint = 'none'
        state.resumedWithFingerprint = 'none'
        state.resumeAccepted = false

        if (auth.decision === 'deny') {
          state.decision = 'deny'
          state.phase = 'denied'
        } else if (auth.decision === 'allow') {
          state.decision = 'allow'
          state.phase = 'completed'
        } else {
          state.decision = 'review'
          state.phase = 'evaluated'
        }
        assertApprovalTlaInvariants(state, db, interactions, resolver, activeTurnID, thread.id)

        if (state.phase === 'evaluated') {
          await approvals.attachRunState(activeToolCallID, JSON.stringify({ trace, round }), {
            callId: activeToolCallID,
          })
          const stored = db.approvalCheckpointForToolCall(activeToolCallID)!
          activeApprovalID = stored.approvalID
          state.checkpointActive = true
          state.checkpointFingerprint = fp
          state.phase = 'waiting_approval'
          assertApprovalTlaInvariants(state, db, interactions, resolver, activeTurnID, thread.id)

          const candidateDecision = rng.pick(['allow', 'deny'] as const)
          const candidateFp = rng.pick(fingerprints)
          state.resumedWithFingerprint = candidateFp
          state.checkpointActive = false

          if (candidateFp !== state.checkpointFingerprint) {
            db.finalizeTurn({
              threadID: thread.id,
              turnID: turn.turnID,
              agentID: turn.agentID,
              status: 'interrupted',
            })
            expect(resolver.acquire(turn.turnID, 'main', `mismatch-${trace}-${round}`)).toBeNull()
            state.resumeAccepted = false
            state.decision = 'deny'
            state.phase = 'denied'
          } else {
            await interactions.respond({
              interactionId: activeApprovalID,
              operationId: `op-tla-${trace}-${round}`,
              expectedVersion: stored.version,
              response: {
                kind: 'approval',
                decision: candidateDecision === 'allow' ? 'allow-once' : 'deny',
              },
            })
            const lease = resolver.acquire(turn.turnID, 'main', `lease-tla-${trace}-${round}`)
            expect(lease).not.toBeNull()
            if (lease && lease.checkpoint.kind === 'permission') {
              expect(lease.checkpoint.authorizationFingerprint).toBe(candidateFp)
              expect(lease.checkpoint.decision).toBe(candidateDecision)
            }
            if (lease) resolver.complete(lease.leaseID)
            if (candidateDecision === 'allow') {
              state.resumeAccepted = true
              state.decision = 'allow'
              state.phase = 'resumed'
            } else {
              state.resumeAccepted = false
              state.decision = 'deny'
              state.phase = 'denied'
            }
          }
          assertApprovalTlaInvariants(state, db, interactions, resolver, activeTurnID, thread.id)
        }

        state.phase = 'idle'
        state.decision = 'none'
        state.activePolicy = state.parentPolicy
        state.hasDenyRule = false
        state.hasAskRule = false
        state.hasAllowRule = false
        state.needsApproval = false
        state.opFingerprint = 'none'
        state.checkpointActive = false
        state.checkpointFingerprint = 'none'
        state.resumedWithFingerprint = 'none'
        state.resumeAccepted = false
        activeTurnID = null
        activeToolCallID = null
        activeApprovalID = null
        assertApprovalTlaInvariants(state, db, interactions, resolver, activeTurnID, thread.id)
      }
    }
  })
})
