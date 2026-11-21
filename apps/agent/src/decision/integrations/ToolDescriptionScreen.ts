import { createHash } from 'node:crypto'
import type { DecisionPresentationNotice } from '@pidex/shared/decision'
import type { DecisionService } from '../DecisionService'
import {
  DESCRIPTION_THRESHOLD,
  looksPoisoned,
  toolDescriptionSpec,
} from '../specs/ToolDescription'


const MAX_CACHE_ENTRIES = 2_048
const SCREEN_TIMEOUT_MS = 15_000
const MAX_DESCRIPTION_CHARS = 6_000

export type DescriptionVerdict = 'clean' | 'poisoned'

const verdicts = new Map<string, DescriptionVerdict>()
const inFlight = new Map<string, Promise<void>>()

// INVARIANT: Test hook: forgets every cached verdict.
export function resetDescriptionVerdicts(): void {
  verdicts.clear()
  inFlight.clear()
}

const cacheKey = (name: string, description: string): string =>
  `${name}:${createHash('sha256').update(description).digest('hex')}`

// INVARIANT: The cached verdict for this exact name + description, or null when unknown.
export function descriptionVerdictOf(name: string, description: string): DescriptionVerdict | null {
  return verdicts.get(cacheKey(name, description)) ?? null
}

const remember = (key: string, verdict: DescriptionVerdict): void => {
  verdicts.delete(key)
  verdicts.set(key, verdict)
  while (verdicts.size > MAX_CACHE_ENTRIES) {
    const oldest = verdicts.keys().next().value
    if (oldest === undefined) break
    verdicts.delete(oldest)
  }
}

export type DescriptionScreenTool = {
  readonly name: string
  readonly description: string
}

export function screenToolDescriptions(
  decisions: DecisionService | null | undefined,
  input: {
    server: string
    tools: readonly DescriptionScreenTool[]
    threadId?: string | undefined
    cwd?: string | undefined
  },
): void {
  if (!decisions || input.tools.length === 0) return
  // SAFETY: 静态投毒地板不依赖 judge 可用性；只要挂了 DecisionService 就同步落缓存，judge 结论稍后补充。
  for (const tool of input.tools) {
    const key = cacheKey(tool.name, tool.description)
    if (!verdicts.has(key) && looksPoisoned(tool.description)) remember(key, 'poisoned')
  }
  void (async () => {
    const engine = await decisions.ensureEngine(input.cwd).catch(() => null)
    if (!engine) return
    const mode = engine.getMode(toolDescriptionSpec.id)
    if (mode === 'off') return
    const pending = input.tools.filter((tool) => {
      const key = cacheKey(tool.name, tool.description)
      return !verdicts.has(key) && !inFlight.has(key)
    })
    if (pending.length === 0) return
    const keys = pending.map((tool) => cacheKey(tool.name, tool.description))
    const run = (async () => {
      const decision = await engine.decide(
        toolDescriptionSpec,
        {
          server: input.server,
          passages: pending.map((tool) =>
            `${tool.name}\n${tool.description.slice(0, MAX_DESCRIPTION_CHARS)}`,
          ),
        },
        {
          signal: AbortSignal.timeout(SCREEN_TIMEOUT_MS),
          ...(input.threadId ? { origin: { threadId: input.threadId } } : {}),
        },
      )
      const outcomes = decision.outcome
      const poisoned: string[] = []
      pending.forEach((tool, index) => {
        const key = keys[index]!
        const probability = outcomes[index] ?? null
        const hit =
          decision.mode === 'active' &&
          decision.source === 'judge' &&
          probability !== null &&
          probability > DESCRIPTION_THRESHOLD
        if (hit) {
          remember(key, 'poisoned')
          poisoned.push(tool.name)
        } else if (decision.source === 'judge' && probability !== null) {
          remember(key, 'clean')
        }
      })
      if (poisoned.length > 0 && input.threadId) {
        const notice: DecisionPresentationNotice = {
          id: crypto.randomUUID(),
          threadId: input.threadId,
          specId: toolDescriptionSpec.id,
          code: 'description.poisoned',
          params: { server: input.server, tools: poisoned },
          message: `MCP server ${input.server} 的 ${poisoned.length} 个工具描述夹带越权指令，已从可用工具中剔除。`,
          createdAt: Date.now(),
        }
        await decisions.presentNotice(notice).catch(() => undefined)
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        for (const key of keys) inFlight.delete(key)
      })
    for (const key of keys) inFlight.set(key, run)
  })().catch(() => undefined)
}

// INVARIANT: Filters an exposure name list against cached poisoned verdicts. Unknown tools stay.
export function filterPoisonedTools<T extends { sdkName: string; description?: unknown }>(
  definitions: readonly T[],
): T[] {
  return definitions.filter((tool) => {
    if (typeof tool.description !== 'string') return true
    return verdicts.get(cacheKey(tool.sdkName, tool.description)) !== 'poisoned'
  })
}

// INVARIANT: Whether a call to this exact name + description must be refused.
export function toolCallPoisoned(name: string, description: string): boolean {
  return verdicts.get(cacheKey(name, description)) === 'poisoned'
}