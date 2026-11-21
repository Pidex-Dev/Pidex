import type { Model } from '@pidex/model-schema'
import type { SubagentRole } from '@pidex/shared/thread'
import type { DecisionOrigin } from '../DecisionEngine'
import type { DecisionService } from '../DecisionService'
import {
  reviewTriageSpec,
  swarmRoutingSpec,
  type ReviewFinding,
  type ReviewPriority,
  type SwarmRoutingOutcome,
} from '../specs/TeamworkSpecs'


export type ReviewTriageResult = {
  readonly priorities: readonly ReviewPriority[]
  readonly source: 'judge' | 'fallback'
}

// INVARIANT: Grades findings P0–P3 with change attribution; without a judge the reviewer's own severity stands.
export async function decideReviewTriage(
  decisions: DecisionService | null | undefined,
  input: { change: string; findings: readonly ReviewFinding[] },
  options: {
    signal?: AbortSignal | undefined
    cwd?: string | undefined
    origin?: DecisionOrigin | undefined
  } = {},
): Promise<ReviewTriageResult> {
  if (input.findings.length === 0) return { priorities: [], source: 'fallback' }
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return { ...reviewTriageSpec.fallback(input), source: 'fallback' }
  const decision = await engine.decide(reviewTriageSpec, input, {
    signal: options.signal,
    ...(options.origin ? { origin: options.origin } : {}),
  })
  return { priorities: decision.outcome.priorities, source: decision.source }
}

export type SwarmRoutingRequest = {
  readonly task: string
  // INVARIANT: The model the host already chose for this subagent; routing never replaces it.
  readonly modelRef: Model.Ref
  // INVARIANT: True when the spawner gave no explicit display role.
  readonly roleMissing: boolean
  // INVARIANT: Reasoning tiers the model supports, from the resolved Model.Info.
  readonly reasoningLevels: readonly string[]
}

export type SwarmSpawnRouting = {
  readonly role?: SubagentRole
  readonly model: Model.Ref
  readonly source: 'judge' | 'fallback'
}

// SAFETY: 只改写展示 role 与既有模型的 variant（推理档位）；permissionCeiling、
export async function routeSubagentSpawn(
  decisions: DecisionService | null | undefined,
  request: SwarmRoutingRequest,
  options: {
    signal?: AbortSignal | undefined
    cwd?: string | undefined
    origin?: DecisionOrigin | undefined
  } = {},
): Promise<SwarmSpawnRouting> {
  const unchanged: SwarmSpawnRouting = { model: request.modelRef, source: 'fallback' }
  const canPickTier = request.modelRef.variant === undefined && request.reasoningLevels.length >= 2
  if (!request.roleMissing && !canPickTier) return unchanged
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return unchanged
  const decision = await engine.decide(
    swarmRoutingSpec,
    {
      task: request.task,
      reasoningLevels: canPickTier ? request.reasoningLevels : [],
      pickRole: request.roleMissing,
    },
    {
      signal: options.signal,
      ...(options.origin ? { origin: options.origin } : {}),
    },
  )
  if (decision.source !== 'judge') return unchanged
  const outcome: SwarmRoutingOutcome = decision.outcome
  const tier =
    canPickTier && outcome.reasoningLevel && request.reasoningLevels.includes(outcome.reasoningLevel)
      ? outcome.reasoningLevel
      : null
  return {
    ...(request.roleMissing && outcome.role ? { role: outcome.role } : {}),
    model: tier
      ? ({ ...request.modelRef, variant: tier } as Model.Ref)
      : request.modelRef,
    source: 'judge',
  }
}