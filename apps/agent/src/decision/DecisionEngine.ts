import { randomUUID } from 'node:crypto'
import type {
  DecisionAnswer,
  DecisionCapability,
  DecisionLedgerRecord,
  DecisionMode,
  DecisionQuestions,
  JudgeErrorKind,
  JudgeInput,
  JudgeTierReport,
  JudgeUsage,
  JudgeWarning,
} from '@pidex/shared/decision'
import { isJudgeError, judgeErrorKindOf } from './DecisionErrors'
import { environmentSecrets, redactForJudge } from './DecisionRedaction'
import { ABSTAIN, digestOf, type AnswersFor, type DecisionSpec, type JsonValue } from './DecisionSpec'
import type { JudgeLike } from './Judge'

// INVARIANT: batches up to this size record each item's answers in the ledger.
const MAX_BATCH_ANSWERS = 8

export interface Decision<Out> {
  readonly specId: string
  readonly mode: DecisionMode
  readonly outcome: Out
  readonly source: 'judge' | 'fallback'
  readonly reason?: string | undefined
  readonly judged?: Out | undefined
  readonly answers?: Readonly<Record<string, DecisionAnswer>> | undefined
  readonly latencyMs?: number | undefined
  readonly usage?: JudgeUsage | undefined
  readonly warnings?: readonly JudgeWarning[] | undefined
  readonly tiers?: readonly JudgeTierReport[] | undefined
  readonly ledgerId?: string | undefined
}

export interface EngineStats {
  calls: number
  failures: number
  abstentions: number
  inputTokens: number
  probes: number
  probeInputTokens: number
  lastError?: { kind: string; message: string; at: string }
}

export interface DecisionOrigin {
  threadId?: string | undefined
  turnId?: string | undefined
}

export interface DecisionLedgerSink {
  append(record: DecisionLedgerRecord): void | Promise<void>
}

export interface DecisionEngineErrorInfo {
  readonly specId: string
  readonly providerId: string
  readonly kind: JudgeErrorKind
  readonly status?: number | undefined
  readonly endpoint?: string | undefined
  readonly message: string
}

export interface DecisionEngineOptions {
  judge: JudgeLike
  ledger?: DecisionLedgerSink | undefined
  defaultMode?: DecisionMode | undefined
  modes?: Readonly<Record<string, DecisionMode>> | undefined
  builtInModes?: Readonly<Record<string, DecisionMode>> | undefined
  recordState?: boolean | undefined
  origin?: (() => DecisionOrigin | undefined) | undefined
  knownSecrets?: (() => readonly string[]) | undefined
  onError?: ((info: DecisionEngineErrorInfo) => void) | undefined
}

interface Evaluation<Out> {
  judged?: Out | undefined
  answers?: Readonly<Record<string, DecisionAnswer>> | undefined
  latencyMs?: number | undefined
  usage?: JudgeUsage | undefined
  modelId?: string | undefined
  warnings?: readonly JudgeWarning[] | undefined
  tiers?: readonly JudgeTierReport[] | undefined
  failure?: string | undefined
  request?: { state: JsonValue; questions: JsonValue } | undefined
}

export class DecisionEngine {
  readonly stats: EngineStats = {
    calls: 0,
    failures: 0,
    abstentions: 0,
    inputTokens: 0,
    probes: 0,
    probeInputTokens: 0,
  }
  lastUsedAt = 0
  private judge: JudgeLike
  private readonly routed = new Map<string, JudgeLike>()
  private readonly ledger: DecisionLedgerSink | undefined
  private defaultMode: DecisionMode
  private readonly modes: Map<string, DecisionMode>
  private readonly builtInModes: Readonly<Record<string, DecisionMode>>
  private readonly recordState: boolean
  private readonly origin: (() => DecisionOrigin | undefined) | undefined
  private readonly knownSecrets: () => readonly string[]
  private readonly onError: ((info: DecisionEngineErrorInfo) => void) | undefined

  constructor(options: DecisionEngineOptions) {
    this.judge = options.judge
    this.ledger = options.ledger
    this.defaultMode = options.defaultMode ?? 'off'
    this.modes = new Map(Object.entries(options.modes ?? {}))
    this.builtInModes = options.builtInModes ?? {}
    this.recordState = options.recordState ?? false
    this.origin = options.origin
    this.knownSecrets = options.knownSecrets ?? (() => environmentSecrets())
    this.onError = options.onError
  }

  get providerId(): string {
    return this.judge.id
  }

  // INVARIANT: One trivial question straight to the judge; not a decision, so no ledger row.
  async probe(signal?: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startedAt = performance.now()
    this.stats.probes += 1
    this.lastUsedAt = Date.now()
    try {
      const result = await this.judge.evaluate({
        state: { text: 'ping' },
        questions: { ready: { type: 'boolean', instructions: 'Is `text` the word ping?' } },
        signal,
      })
      this.stats.probeInputTokens += result.usage.inputTokens ?? 0
      return { ok: true, latencyMs: Math.round(performance.now() - startedAt) }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - startedAt),
        error: judgeErrorKindOf(error),
      }
    } finally {
      this.lastUsedAt = Date.now()
    }
  }

  setJudgeFor(specId: string, judge: JudgeLike | undefined): void {
    if (judge) this.routed.set(specId, judge)
    else this.routed.delete(specId)
  }

  judgeFor(specId: string): JudgeLike {
    return this.routed.get(specId) ?? this.judge
  }

  setJudge(judge: JudgeLike): void {
    this.judge = judge
  }

  getMode(specId: string): DecisionMode {
    const mode = this.modes.get(specId)
    // INVARIANT: an explicit config mode always holds; only an unset point falls
    if (mode !== undefined) return mode
    return this.builtInModes[specId] ?? this.defaultMode
  }

  setMode(specId: string, mode: DecisionMode): void {
    this.modes.set(specId, mode)
  }

  setDefaultMode(mode: DecisionMode): void {
    this.defaultMode = mode
  }

  private async evaluate<In, const Qs extends DecisionQuestions, Out extends JsonValue>(
    spec: DecisionSpec<In, Qs, Out>,
    input: In,
    state: JudgeInput,
    signal: AbortSignal | undefined,
  ): Promise<Evaluation<Out>> {
    const questions = spec.questionsFor ? spec.questionsFor(input) : spec.questions
    if (Object.keys(questions).length === 0) return { failure: 'abstain' }
    const declared = spec.capabilities
    const capabilities =
      typeof declared === 'string'
        ? Object.fromEntries(Object.keys(questions).map((id) => [id, declared]))
        : (declared as Record<string, DecisionCapability> | undefined)

    this.stats.calls += 1
    const shared = !this.routed.has(spec.id)
    if (shared) this.lastUsedAt = Date.now()
    let request: Evaluation<Out>['request']
    try {
      const known = this.knownSecrets()
      const sent = redactForJudge(state, known)
      const asked = redactForJudge(questions, known)
      if (this.recordState)
        request = { state: sent as JsonValue, questions: asked as unknown as JsonValue }
      const result = await this.judgeFor(spec.id).evaluate({
        state: sent,
        questions: asked,
        signal,
        capabilities,
      })
      this.stats.inputTokens += result.usage.inputTokens ?? 0
      const evaluation: Evaluation<Out> = {
        answers: result.answers,
        latencyMs: result.latencyMs,
        usage: result.usage,
        modelId: result.modelId,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
        tiers: result.tiers,
        request,
      }
      const verdict = spec.policy(result.answers as AnswersFor<Qs>, input)
      if (verdict === ABSTAIN) {
        this.stats.abstentions += 1
        evaluation.failure = 'abstain'
      } else {
        evaluation.judged = verdict
      }
      return evaluation
    } catch (error) {
      const kind = judgeErrorKindOf(error)
      const message = error instanceof Error ? error.message : String(error)
      this.stats.failures += 1
      this.stats.lastError = { kind, message, at: new Date().toISOString() }
      this.onError?.({
        specId: spec.id,
        providerId: this.judgeFor(spec.id).id,
        kind,
        ...(isJudgeError(error) && error.status !== undefined ? { status: error.status } : {}),
        ...(isJudgeError(error) && error.endpoint ? { endpoint: error.endpoint } : {}),
        message,
      })
      return { failure: `error:${kind}`, request }
    } finally {
      if (shared) this.lastUsedAt = Date.now()
    }
  }

  private applies(spec: { readonly actsInShadow?: boolean | undefined }, mode: DecisionMode): boolean {
    return mode === 'active' || (mode === 'shadow' && spec.actsInShadow === true)
  }

  private asked(): DecisionOrigin | undefined {
    try {
      return this.origin?.()
    } catch {
      return undefined
    }
  }

  private resolveOrigin(explicit?: DecisionOrigin): DecisionOrigin | undefined {
    const ambient = this.asked()
    if (!explicit) return ambient
    if (!ambient) return explicit
    return {
      threadId: explicit.threadId ?? ambient.threadId,
      turnId: explicit.turnId ?? ambient.turnId,
    }
  }

  private async record(record: DecisionLedgerRecord): Promise<void> {
    try {
      await this.ledger?.append(record)
    } catch {
      // SAFETY: a broken ledger must not change what the agent does.
    }
  }

  async decide<In, const Qs extends DecisionQuestions, Out extends JsonValue>(
    spec: DecisionSpec<In, Qs, Out>,
    input: In,
    options: { signal?: AbortSignal | undefined; origin?: DecisionOrigin | undefined } = {},
  ): Promise<Decision<Out>> {
    const mode = this.getMode(spec.id)
    const fallback = spec.fallback(input)
    if (mode === 'off')
      return { specId: spec.id, mode, outcome: fallback, source: 'fallback', reason: 'off' }

    const origin = this.resolveOrigin(options.origin)
    const state = spec.buildState(input)
    const evaluation = await this.evaluate(spec, input, state, options.signal)
    const { judged } = evaluation
    const useJudged = this.applies(spec, mode) && judged !== undefined
    const outcome = useJudged && judged !== undefined ? judged : fallback
    const reason = useJudged ? undefined : (evaluation.failure ?? 'shadow')
    const source = useJudged ? 'judge' : 'fallback'

    const record: DecisionLedgerRecord = {
      id: randomUUID(),
      ...(origin?.threadId ? { threadId: origin.threadId } : {}),
      ...(origin?.turnId ? { turnId: origin.turnId } : {}),
      specId: spec.id,
      specVersion: spec.version,
      mode,
      providerId: this.judgeFor(spec.id).id,
      ...(evaluation.modelId ? { modelId: evaluation.modelId } : {}),
      outcome,
      source,
      ...(reason ? { reason } : {}),
      ...(judged !== undefined ? { judged } : {}),
      ...(evaluation.answers ? { answers: evaluation.answers } : {}),
      ...(evaluation.latencyMs !== undefined ? { latencyMs: evaluation.latencyMs } : {}),
      ...(evaluation.usage ? { usage: evaluation.usage } : {}),
      ...(evaluation.warnings ? { warnings: evaluation.warnings } : {}),
      ...(evaluation.tiers ? { tiers: evaluation.tiers } : {}),
      stateDigest: digestOf(state),
      ...(evaluation.request ? { state: evaluation.request.state, questions: evaluation.request.questions } : {}),
      createdAt: Date.now(),
    }
    await this.record(record)

    return {
      specId: spec.id,
      mode,
      outcome,
      source,
      reason,
      judged,
      answers: evaluation.answers,
      latencyMs: evaluation.latencyMs,
      usage: evaluation.usage,
      warnings: evaluation.warnings,
      tiers: evaluation.tiers,
      ledgerId: record.id,
    }
  }

  async decideMany<In, const Qs extends DecisionQuestions, Out extends JsonValue>(
    spec: DecisionSpec<In, Qs, Out>,
    inputs: readonly In[],
    options: {
      signal?: AbortSignal | undefined
      concurrency?: number | undefined
      origin?: DecisionOrigin | undefined
    } = {},
  ): Promise<Decision<Out>[]> {
    const mode = this.getMode(spec.id)
    if (mode === 'off' || inputs.length === 0) {
      return inputs.map((input) => ({
        specId: spec.id,
        mode,
        outcome: spec.fallback(input),
        source: 'fallback' as const,
        reason: 'off',
      }))
    }

    const origin = this.resolveOrigin(options.origin)
    const startedAt = performance.now()
    const evaluations: Evaluation<Out>[] = new Array(inputs.length)
    const states = inputs.map((input) => spec.buildState(input))
    let next = 0
    const worker = async () => {
      while (next < inputs.length) {
        const index = next++
        evaluations[index] = await this.evaluate(spec, inputs[index]!, states[index]!, options.signal)
      }
    }
    const asked = options.concurrency ?? 4
    const concurrency = Number.isFinite(asked) ? Math.max(1, Math.floor(asked)) : 4
    const workers = Math.min(concurrency, inputs.length)
    await Promise.all(Array.from({ length: workers }, worker))

    const ledgerId = randomUUID()
    const decisions = inputs.map((input, index): Decision<Out> => {
      const evaluation = evaluations[index]!
      const useJudged = this.applies(spec, mode) && evaluation.judged !== undefined
      return {
        specId: spec.id,
        mode,
        outcome: useJudged && evaluation.judged !== undefined ? evaluation.judged : spec.fallback(input),
        source: useJudged ? 'judge' : 'fallback',
        reason: useJudged ? undefined : (evaluation.failure ?? 'shadow'),
        judged: evaluation.judged,
        answers: evaluation.answers,
        latencyMs: evaluation.latencyMs,
        usage: evaluation.usage,
        warnings: evaluation.warnings,
        ledgerId,
      }
    })

    const inputTokens = evaluations.reduce((sum, evaluation) => sum + (evaluation.usage?.inputTokens ?? 0), 0)
    const outputTokens = evaluations.reduce((sum, evaluation) => sum + (evaluation.usage?.outputTokens ?? 0), 0)
    const requests =
      this.recordState && inputs.length <= MAX_BATCH_ANSWERS
        ? evaluations.map((evaluation) => evaluation.request ?? null)
        : undefined
    const failures = evaluations.filter((evaluation) => evaluation.failure?.startsWith('error:')).length
    await this.record({
      id: ledgerId,
      ...(origin?.threadId ? { threadId: origin.threadId } : {}),
      ...(origin?.turnId ? { turnId: origin.turnId } : {}),
      specId: spec.id,
      specVersion: spec.version,
      mode,
      providerId: this.judgeFor(spec.id).id,
      ...(evaluations.find((evaluation) => evaluation.modelId)?.modelId
        ? { modelId: evaluations.find((evaluation) => evaluation.modelId)!.modelId! }
        : {}),
      outcome: decisions.map((decision) => decision.outcome),
      source: decisions.some((decision) => decision.source === 'judge') ? 'judge' : 'fallback',
      ...(mode === 'shadow' && !spec.actsInShadow
        ? { reason: 'shadow' }
        : failures === inputs.length
          ? { reason: 'error:all' }
          : {}),
      judged: evaluations.map((evaluation) => evaluation.judged ?? null),
      latencyMs: Math.round(performance.now() - startedAt),
      usage: { inputTokens, outputTokens },
      ...(requests
        ? {
            state: requests.map((request) => request?.state ?? null),
            questions: requests.map((request) => request?.questions ?? null),
          }
        : {}),
      batch: {
        size: inputs.length,
        failures,
        ...(inputs.length <= MAX_BATCH_ANSWERS
          ? {
              answers: evaluations.map((evaluation) => evaluation.answers ?? null),
              digests: states.map(digestOf),
            }
          : {}),
      },
      stateDigest: digestOf(states),
      createdAt: Date.now(),
    })
    return decisions
  }
}