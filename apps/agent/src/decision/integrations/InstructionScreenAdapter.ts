import { createHash } from 'node:crypto'
import type { DecisionPresentationNotice } from '@pidex/shared/decision'
import type { DecisionService } from '../DecisionService'
import type {
  InstructionDiscoveryResult,
  ProjectInstructionSource,
} from '../../prompt/InstructionDiscoveryService'
import {
  INSTRUCTION_SCREEN_THRESHOLD,
  instructionPlaceholder,
  instructionScreenSpec,
} from '../specs/InstructionScreen'
import { looksPoisoned } from '../specs/ToolDescription'
import { splitPassages } from '../specs/ToolInjection'

const MAX_CACHE_ENTRIES = 1_024
const PASSAGE_CHARS = 2_000
const MAX_PASSAGES = 24
const BODY_TIMEOUT_MS = 4_000
const CATALOG_TIMEOUT_MS = 15_000
const MAX_CATALOG_CHARS = 4_000

export type SkillCatalogVerdict = 'clean' | 'poisoned'

export type InstructionContentScreenResult = {
  readonly text: string
  readonly withheld: number
  readonly source: 'judge' | 'rules' | 'fallback'
  readonly ledgerId?: string | undefined
}

const catalogVerdicts = new Map<string, SkillCatalogVerdict>()
const catalogInFlight = new Map<string, Promise<void>>()
const bodyCache = new Map<string, InstructionContentScreenResult>()

/** Test hook: clears cached instruction and skill screening verdicts. */
export function resetInstructionScreenCache(): void {
  catalogVerdicts.clear()
  catalogInFlight.clear()
  bodyCache.clear()
}

const contentHash = (kind: string, content: string): string =>
  `${kind}:${createHash('sha256').update(content, 'utf8').digest('hex')}`

const rememberLru = <V>(cache: Map<string, V>, key: string, value: V): void => {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export type ScreenableSkillSummary = {
  readonly name: string
  readonly description: string
  readonly origin: string
  readonly path?: string | undefined
}

export type ScreenableLoadedSkill = {
  readonly origin: string
  readonly path: string
  readonly body: string
  readonly content: string
}

/**
 * Trust boundary: only workspace Skills and third-party plugin Skills are screened.
 * Builtin and user-global Skills are trusted so user-authored rules are never blocked.
 */
export function isUntrustedSkill(skill: Pick<ScreenableSkillSummary, 'origin' | 'path'>): boolean {
  if (skill.origin === 'builtin') return false
  if (skill.origin === 'workspace') return true
  if (skill.path?.startsWith('plugin://')) return true
  return false
}

const catalogPassageOf = (skill: Pick<ScreenableSkillSummary, 'name' | 'description'>): string =>
  `${skill.name}\n${skill.description.slice(0, MAX_CATALOG_CHARS)}`

/**
 * Screens untrusted Skill catalog metadata synchronously against the static
 * poisoning floor and schedules background Judge screening keyed by SHA-256.
 * Poisoned entries are omitted from the returned catalog; trusted Skills stay intact.
 */
export function screenSkillCatalog<T extends ScreenableSkillSummary>(
  decisions: DecisionService | null | undefined,
  skills: readonly T[],
  options: {
    threadId?: string | undefined
    cwd?: string | undefined
  } = {},
): T[] {
  if (!decisions || skills.length === 0) return [...skills]
  const untrusted = skills.filter(isUntrustedSkill)
  if (untrusted.length === 0) return [...skills]

  // SAFETY: static poisoning floor applies synchronously without depending on judge availability.
  for (const skill of untrusted) {
    const passage = catalogPassageOf(skill)
    const key = contentHash('skill-catalog', `${skill.name}\0${passage}`)
    if (!catalogVerdicts.has(key) && looksPoisoned(passage)) {
      rememberLru(catalogVerdicts, key, 'poisoned')
    }
  }

  void (async () => {
    const engine = await decisions.ensureEngine(options.cwd).catch(() => null)
    if (!engine) return
    const mode = engine.getMode(instructionScreenSpec.id)
    if (mode === 'off') return
    const pending = untrusted.filter((skill) => {
      const key = contentHash('skill-catalog', `${skill.name}\0${catalogPassageOf(skill)}`)
      return !catalogVerdicts.has(key) && !catalogInFlight.has(key)
    })
    if (pending.length === 0) return
    const keys = pending.map((skill) =>
      contentHash('skill-catalog', `${skill.name}\0${catalogPassageOf(skill)}`),
    )
    const run = (async () => {
      const evaluated = await engine.decideMany(
        instructionScreenSpec,
        pending.map((skill) => ({
          kind: 'skill-catalog' as const,
          source: skill.path ?? skill.name,
          passage: catalogPassageOf(skill),
        })),
        {
          signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
          ...(options.threadId ? { origin: { threadId: options.threadId } } : {}),
        },
      )
      const poisoned: string[] = []
      pending.forEach((skill, index) => {
        const key = keys[index]!
        const decision = evaluated[index]
        const probability = decision?.outcome ?? null
        const hit =
          decision?.mode === 'active' &&
          decision.source === 'judge' &&
          probability !== null &&
          probability > INSTRUCTION_SCREEN_THRESHOLD
        if (hit) {
          rememberLru(catalogVerdicts, key, 'poisoned')
          poisoned.push(skill.name)
        } else if (decision?.source === 'judge' && probability !== null) {
          rememberLru(catalogVerdicts, key, 'clean')
        }
      })
      if (poisoned.length > 0 && options.threadId) {
        const notice: DecisionPresentationNotice = {
          id: crypto.randomUUID(),
          threadId: options.threadId,
          specId: instructionScreenSpec.id,
          code: 'instruction.skillCatalogPoisoned',
          params: { skills: poisoned },
          message: `已拦截 ${poisoned.length} 个描述夹带越权或注入指令的外部 Skill（${poisoned.join(', ')}）。`,
          createdAt: Date.now(),
        }
        await decisions.presentNotice(notice).catch(() => undefined)
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        for (const key of keys) catalogInFlight.delete(key)
      })
    for (const key of keys) catalogInFlight.set(key, run)
  })().catch(() => undefined)

  return skills.filter((skill) => {
    if (!isUntrustedSkill(skill)) return true
    const key = contentHash('skill-catalog', `${skill.name}\0${catalogPassageOf(skill)}`)
    return catalogVerdicts.get(key) !== 'poisoned'
  })
}

const applyStaticFloor = (text: string): { text: string; withheld: number } => {
  const pieces = splitPassages(text, PASSAGE_CHARS).slice(0, MAX_PASSAGES)
  if (pieces.length === 0) return { text, withheld: 0 }
  const tail = text.slice(pieces.join('').length)
  let withheld = 0
  const screened = pieces.map((passage) => {
    if (!looksPoisoned(passage)) return passage
    withheld += 1
    return `${instructionPlaceholder(passage.length)}\n`
  })
  return {
    text: withheld > 0 ? screened.join('') + tail : text,
    withheld,
  }
}

/**
 * Screens untrusted repository instruction or Skill body text synchronously on
 * first read with SHA-256 caching and a bounded fail-open timeout.
 */
export async function screenInstructionContent(
  decisions: DecisionService | null | undefined,
  input: {
    kind: 'project-instruction' | 'skill-body'
    source: string
    text: string
    threadId?: string | undefined
    turnId?: string | undefined
  },
  options: {
    signal?: AbortSignal | undefined
    cwd?: string | undefined
    timeoutMs?: number | undefined
  } = {},
): Promise<InstructionContentScreenResult> {
  const unchanged: InstructionContentScreenResult = {
    text: input.text,
    withheld: 0,
    source: 'fallback',
  }
  if (!decisions || !input.text) return unchanged

  const engine = await decisions.ensureEngine(options.cwd).catch(() => null)
  if (!engine) {
    const floor = applyStaticFloor(input.text)
    if (floor.withheld === 0) return unchanged
    return { text: floor.text, withheld: floor.withheld, source: 'rules' }
  }
  const mode = engine.getMode(instructionScreenSpec.id)
  if (mode === 'off') return unchanged

  const key = contentHash(`${input.kind}:${mode}`, input.text)
  const cached = bodyCache.get(key)
  if (cached) return cached

  const pieces = splitPassages(input.text, PASSAGE_CHARS).slice(0, MAX_PASSAGES)
  if (pieces.length === 0) return unchanged
  const tail = input.text.slice(pieces.join('').length)

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? BODY_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal

  const evaluated = await engine
    .decideMany(
      instructionScreenSpec,
      pieces.map((passage) => ({
        kind: input.kind,
        source: input.source,
        passage,
      })),
      {
        signal,
        ...(input.threadId
          ? {
              origin: {
                threadId: input.threadId,
                ...(input.turnId ? { turnId: input.turnId } : {}),
              },
            }
          : {}),
      },
    )
    .catch(() => [])

  if (mode !== 'active') {
    const shadowResult: InstructionContentScreenResult = {
      ...unchanged,
      ledgerId: evaluated[0]?.ledgerId,
    }
    return shadowResult
  }

  let withheld = 0
  let judged = false
  const screened = pieces.map((passage, index) => {
    const outcome = evaluated[index]?.outcome ?? null
    if (evaluated[index]?.source === 'judge' && outcome !== null) judged = true
    const hit =
      (outcome !== null && outcome > INSTRUCTION_SCREEN_THRESHOLD) || looksPoisoned(passage)
    if (!hit) return passage
    withheld += 1
    return `${instructionPlaceholder(passage.length)}\n`
  })

  const result: InstructionContentScreenResult = {
    text: withheld > 0 ? screened.join('') + tail : input.text,
    withheld,
    source: judged ? 'judge' : withheld > 0 ? 'rules' : 'fallback',
    ledgerId: evaluated[0]?.ledgerId,
  }
  if (judged || withheld > 0) {
    rememberLru(bodyCache, key, result)
  }

  if (withheld > 0 && input.threadId) {
    await decisions
      .presentNotice({
        id: crypto.randomUUID(),
        threadId: input.threadId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        specId: instructionScreenSpec.id,
        code: 'instruction.withheld',
        params: { kind: input.kind, source: input.source, passages: withheld },
        message: `已拦截来自 ${input.source} 的 ${withheld} 段疑似越权或注入指令，其余合法规范已保留。`,
        createdAt: Date.now(),
      })
      .catch(() => undefined)
  }

  return result
}

/** Screens discovered repository instruction files (`AGENTS.md` / `CLAUDE.md`) in order. */
export async function screenProjectInstructions<
  T extends Pick<InstructionDiscoveryResult, 'sources'>,
>(
  decisions: DecisionService | null | undefined,
  discovered: T,
  options: {
    threadId?: string | undefined
    turnId?: string | undefined
    cwd?: string | undefined
    signal?: AbortSignal | undefined
  } = {},
): Promise<T> {
  if (!decisions || discovered.sources.length === 0) return discovered
  const sources: ProjectInstructionSource[] = []
  let changed = false
  for (const source of discovered.sources) {
    const screened = await screenInstructionContent(
      decisions,
      {
        kind: 'project-instruction',
        source: source.path,
        text: source.content,
        threadId: options.threadId,
        turnId: options.turnId,
      },
      { signal: options.signal, cwd: options.cwd },
    )
    if (screened.withheld > 0) {
      changed = true
      sources.push({ ...source, content: screened.text })
    } else {
      sources.push(source)
    }
  }
  return changed ? { ...discovered, sources } : discovered
}

/** Screens a loaded Skill body when the Skill comes from an untrusted source (workspace/plugin). */
export async function screenLoadedSkill<T extends ScreenableLoadedSkill>(
  decisions: DecisionService | null | undefined,
  skill: T,
  options: {
    threadId?: string | undefined
    turnId?: string | undefined
    cwd?: string | undefined
    signal?: AbortSignal | undefined
  } = {},
): Promise<T> {
  if (!decisions || !isUntrustedSkill(skill)) return skill
  const screenedBody = await screenInstructionContent(
    decisions,
    {
      kind: 'skill-body',
      source: skill.path,
      text: skill.body,
      threadId: options.threadId,
      turnId: options.turnId,
    },
    { signal: options.signal, cwd: options.cwd },
  )
  if (screenedBody.withheld === 0) return skill
  const screenedContent = skill.content.includes(skill.body)
    ? skill.content.replace(skill.body, screenedBody.text)
    : screenedBody.text
  return {
    ...skill,
    body: screenedBody.text,
    content: screenedContent,
  }
}
