import type { DecisionService } from '../DecisionService'
import type { Decision } from '../DecisionEngine'
import {
  INJECTION_THRESHOLD,
  injectionPlaceholder,
  looksInjected,
  splitPassages,
  toolInjectionSpec,
} from '../specs/ToolInjection'
import {
  admissionPointer,
  splitChunks,
  toolAdmissionSpec,
  type ToolAdmissionOutcome,
} from '../specs/ToolAdmission'
import {
  foldTestLog,
  isTestLog,
  toolAdmissionTestLogSpec,
  type TestLogCandidate,
} from '../specs/ToolAdmissionTestLog'


const PASSAGE_CHARS = 2_000
const MAX_PASSAGES = 24
const CHUNK_CHARS = 4_000
const MAX_CHUNKS = 24
const MAX_CANDIDATES = 24

const FETCH_COMMAND = /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b/i

export function externalContentSource(
  name: string,
  input: Record<string, unknown>,
  isMcp = false,
): string | null {
  const normalized = name.toLowerCase()
  if (isMcp || normalized.startsWith('mcp__')) return name
  if (normalized.startsWith('web__') || normalized === 'web.run' || normalized.endsWith('.web.run'))
    return name
  if (
    normalized === 'browserread' ||
    normalized === 'browsernavigate' ||
    normalized === 'browseraction'
  )
    return name
  if (normalized.includes('fetch') || normalized.includes('websearch') || normalized.includes('web_search'))
    return name
  if (normalized === 'exec_command') {
    const command = input.command
    if (typeof command === 'string' && FETCH_COMMAND.test(command)) return name
  }
  return null
}

export type InjectionScreenResult = {
  readonly text: string
  readonly withheld: number
  readonly source: 'judge' | 'rules' | 'fallback'
  readonly ledgerId?: string | undefined
}

export async function screenExternalContent(
  decisions: DecisionService | null | undefined,
  input: {
    threadId: string
    turnId?: string | undefined
    source: string
    text: string
  },
  options: { signal?: AbortSignal | undefined; cwd?: string | undefined } = {},
): Promise<InjectionScreenResult> {
  const unchanged: InjectionScreenResult = {
    text: input.text,
    withheld: 0,
    source: 'fallback',
  }
  if (!input.text) return unchanged
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return unchanged
  const mode = engine.getMode(toolInjectionSpec.id)
  if (mode !== 'active') return unchanged
  const pieces = splitPassages(input.text, PASSAGE_CHARS).slice(0, MAX_PASSAGES)
  if (pieces.length === 0) return unchanged
  const tail = input.text.slice(pieces.join('').length)
  const evaluated = await engine.decideMany(
    toolInjectionSpec,
    pieces.map((passage) => ({ source: input.source, passage })),
    {
      signal: options.signal,
      origin: { threadId: input.threadId, ...(input.turnId ? { turnId: input.turnId } : {}) },
    },
  )
  if (mode !== 'active') return { ...unchanged, ledgerId: evaluated[0]?.ledgerId }
  let withheld = 0
  let judged = false
  const screened = pieces.map((passage, index) => {
    const outcome = evaluated[index]?.outcome ?? null
    if (evaluated[index]?.source === 'judge' && outcome !== null) judged = true
    const hit = (outcome !== null && outcome > INJECTION_THRESHOLD) || looksInjected(passage)
    if (!hit) return passage
    withheld += 1
    return `${injectionPlaceholder(passage.length)}\n`
  })
  if (withheld > 0 && decisions) {
    await decisions
      .presentNotice({
        id: crypto.randomUUID(),
        threadId: input.threadId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        specId: toolInjectionSpec.id,
        code: 'injection.withheld',
        params: { source: input.source, passages: withheld },
        message: `已拦截来自 ${input.source} 的 ${withheld} 段疑似提示词注入内容，原文未进入上下文。`,
        createdAt: Date.now(),
      })
      .catch(() => undefined)
  }
  return {
    text: screened.join('') + tail,
    withheld,
    source: judged ? 'judge' : withheld > 0 ? 'rules' : 'fallback',
    ledgerId: evaluated[0]?.ledgerId,
  }
}

// INVARIANT: Archives the full output and returns a read pointer line; null keeps the host's truncation.
export type OutputArchiver = (input: {
  threadId: string
  turnId?: string | undefined
  toolCallId?: string | undefined
  name: string
  text: string
}) => Promise<{ pointer: string } | null>

export type AdmissionResult = {
  readonly text: string
  readonly dropped: number
  readonly archived: boolean
  readonly source: 'judge' | 'rules' | 'fallback'
  readonly ledgerId?: string | undefined
}

export async function admitToolOutput(
  decisions: DecisionService | null | undefined,
  input: {
    threadId: string
    turnId?: string | undefined
    toolCallId?: string | undefined
    name: string
    call: string
    // INVARIANT: The host-recorded user request; never model claims.
    goal: string
    intent: string
    text: string
    minLength: number
  },
  archive: OutputArchiver | null | undefined,
  options: { signal?: AbortSignal | undefined; cwd?: string | undefined } = {},
): Promise<AdmissionResult> {
  const unchanged: AdmissionResult = {
    text: input.text,
    dropped: 0,
    archived: false,
    source: 'fallback',
  }
  if (input.text.length < input.minLength) return unchanged
  const engine = await decisions?.ensureEngine(options.cwd).catch(() => null)
  if (!engine) return unchanged
  const testLog = isTestLog(input.call, input.text)
  const spec = testLog ? toolAdmissionTestLogSpec : toolAdmissionSpec
  const mode = engine.getMode(spec.id)
  if (mode === 'off') return unchanged

  if (testLog) {
    const fold = foldTestLog(input.text)
    const candidates = fold.candidates.slice(0, MAX_CANDIDATES)
    let omit = new Set<string>()
    let ledgerId: string | undefined
    let judged = false
    if (candidates.length > 0 && input.goal.trim()) {
      const decision = await engine.decide(
        toolAdmissionTestLogSpec,
        {
          call: input.call,
          goal: input.goal,
          intent: input.intent,
          run: fold.run,
          candidates,
        },
        {
          signal: options.signal,
          origin: { threadId: input.threadId, ...(input.turnId ? { turnId: input.turnId } : {}) },
        },
      )
      ledgerId = decision.ledgerId
      judged = decision.source === 'judge'
      if (mode === 'active') omit = new Set(decision.outcome.omit)
    }
    const folded = new Set(fold.duplicates)
    if (mode !== 'active' || (folded.size === 0 && omit.size === 0)) {
      return { ...unchanged, ledgerId, source: judged ? 'judge' : 'fallback' }
    }
    const stored = await archive?.({
      threadId: input.threadId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      name: input.name,
      text: input.text,
    }).catch(() => null)
    if (!stored) return { ...unchanged, ledgerId }
    const text =
      fold.units
        .map((unit) =>
          omit.has(unit.id)
            ? `${admissionPointer(unit.text.length)}\n`
            : fold.rendered[unit.id]!,
        )
        .join('') + `\n${stored.pointer}`
    return {
      text,
      dropped: folded.size + omit.size,
      archived: true,
      source: judged ? 'judge' : 'rules',
      ledgerId,
    }
  }

  const chunks = splitChunks(input.text, CHUNK_CHARS).slice(0, MAX_CHUNKS)
  const tail = input.text.slice(chunks.join('').length)
  const evaluated = await engine.decideMany(
    toolAdmissionSpec,
    chunks.map((chunk) => ({ call: input.call, chunk })),
    {
      signal: options.signal,
      origin: { threadId: input.threadId, ...(input.turnId ? { turnId: input.turnId } : {}) },
    },
  )
  const ledgerId = evaluated[0]?.ledgerId
  if (mode !== 'active') return { ...unchanged, ledgerId }
  const drops = evaluated.map(
    (decision) => decision.source === 'judge' && (decision.outcome as ToolAdmissionOutcome).drop,
  )
  if (!drops.some(Boolean)) return { ...unchanged, ledgerId }
  const stored = await archive?.({
    threadId: input.threadId,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    name: input.name,
    text: input.text,
  }).catch(() => null)
  // SAFETY: nothing leaves the context without an archived full copy and a read pointer.
  if (!stored) return { ...unchanged, ledgerId }
  const text =
    chunks
      .map((chunk, index) => (drops[index] ? `${admissionPointer(chunk.length)}\n` : chunk))
      .join('') +
    tail +
    `\n${stored.pointer}`
  return {
    text,
    dropped: drops.filter(Boolean).length,
    archived: true,
    source: 'judge',
    ledgerId,
  }
}

// INVARIANT: The candidates a test-log fold offers the judge; exported for prompt-side consumers.
export type { TestLogCandidate }

// INVARIANT: A constraint verdict the executor may act on: only narrowing, bound to the invocation it judged.
export type ConstraintDenial = {
  readonly reason: string
  readonly broken: readonly number[]
}

export const constraintDenialOf = (
  decision: Decision<{ readonly broken: readonly number[] }> | null,
  constraints: readonly string[],
): ConstraintDenial | null => {
  if (!decision || decision.mode !== 'active' || decision.source !== 'judge') return null
  const broken = decision.outcome.broken
  if (broken.length === 0) return null
  const sentences = broken
    .map((index) => constraints[index])
    .filter((sentence): sentence is string => Boolean(sentence))
  return {
    reason: `该调用违反用户在本会话中确认的限制：${sentences.join('；')}`,
    broken,
  }
}