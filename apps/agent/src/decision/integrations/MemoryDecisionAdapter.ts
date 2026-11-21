import type { DecisionService } from '../DecisionService'
import type { MemoryInjection } from '../../memory/MemoryService'
import type { MemoryNamespace } from '../../memory/MemoryFiles'
import {
  memoryAppliedSpec,
  memoryCaptureSpec,
  memoryMergeSpec,
  memoryRecallSpec,
  memoryWorthSpec,
  type MemoryAppliedOutcome,
  type MemoryCaptureOutcome,
  type MemoryLesson,
  type MemoryLessonText,
  type MemoryMergeVerdict,
  type MemoryRecallOutcome,
  type MemoryWorthVerdict,
} from '../specs/MemorySpecs'

/**
 * Memory-plane adapters for MemoryService. All inputs are host-recorded facts
 * or already-scrubbed stored memory; nothing here writes memory or treats
 * stored content as user authorization. Without a DecisionService or engine
 * every function returns the no-judge result.
 */

/** Cap on lessons judged per request so a large index cannot flood the judge. */
export const MEMORY_JUDGE_MAX_LESSONS = 16

/** Maps listed memory files to judge lessons; only project namespaces carry project facts. */
export function memoryLessonsFromFiles(
  files: readonly {
    path: string
    name: string | null
    description: string | null
    type: string | null
  }[],
  namespace: MemoryNamespace,
): MemoryLesson[] {
  return files
    .filter((file) => namespace.kind !== 'project' || file.type === 'project' || file.type === 'reference')
    .slice(0, MEMORY_JUDGE_MAX_LESSONS)
    .map((file) => ({
      id: file.path,
      trigger: (file.description ?? file.name ?? file.path).slice(0, 200),
      lesson: (file.name ?? file.path).slice(0, 300),
    }))
}

/**
 * Recall over the index sections about to be injected. The outcome is advisory
 * relevance metadata for the ledger and future consumers; injection itself is
 * unchanged, so nothing a user asked to ignore can come back through here.
 */
export async function decideMemoryRecall(
  decisions: DecisionService | null | undefined,
  input: {
    userMessage: string
    lessons: readonly MemoryLesson[]
    cwd?: string | undefined
    threadId?: string | undefined
    turnId?: string | undefined
  },
): Promise<MemoryRecallOutcome> {
  const lessons = input.lessons.slice(0, MEMORY_JUDGE_MAX_LESSONS)
  if (lessons.length === 0) return { apply: [] }
  const engine = await decisions?.ensureEngine(input.cwd).catch(() => null)
  if (!engine) return memoryRecallSpec.fallback({ userMessage: input.userMessage, lessons })
  const origin =
    input.threadId || input.turnId ? { threadId: input.threadId, turnId: input.turnId } : undefined
  const decision = await engine.decide(
    memoryRecallSpec,
    { userMessage: input.userMessage, lessons },
    ...(origin ? [{ origin }] : []),
  )
  return decision.outcome
}

/** Write-side screen over host-recorded user text; the extract runner still owns all writes. */
export async function decideMemoryCapture(
  decisions: DecisionService | null | undefined,
  input: {
    userMessage: string
    previousAssistantMessage: string
    cwd?: string | undefined
    threadId?: string | undefined
    turnId?: string | undefined
  },
): Promise<MemoryCaptureOutcome> {
  const engine = await decisions?.ensureEngine(input.cwd).catch(() => null)
  if (!engine) return memoryCaptureSpec.fallback(input)
  const origin =
    input.threadId || input.turnId ? { threadId: input.threadId, turnId: input.turnId } : undefined
  const decision = await engine.decide(
    memoryCaptureSpec,
    {
      userMessage: input.userMessage,
      previousAssistantMessage: input.previousAssistantMessage,
    },
    ...(origin ? [{ origin }] : []),
  )
  return decision.outcome
}

/** Rates candidate lessons; only `reusable` verdicts should ever be stored by a caller. */
export async function decideMemoryWorth(
  decisions: DecisionService | null | undefined,
  input: {
    lessons: readonly MemoryLessonText[]
    projectInstructions: string
    cwd?: string | undefined
    threadId?: string | undefined
    turnId?: string | undefined
  },
): Promise<readonly MemoryWorthVerdict[]> {
  const lessons = input.lessons.slice(0, MEMORY_JUDGE_MAX_LESSONS)
  if (lessons.length === 0) return []
  const engine = await decisions?.ensureEngine(input.cwd).catch(() => null)
  if (!engine) return memoryWorthSpec.fallback({ ...input, lessons })
  const origin =
    input.threadId || input.turnId ? { threadId: input.threadId, turnId: input.turnId } : undefined
  const decision = await engine.decide(
    memoryWorthSpec,
    {
      lessons,
      projectInstructions: input.projectInstructions,
    },
    ...(origin ? [{ origin }] : []),
  )
  return decision.outcome
}

/** Compares a candidate against similar stored lessons before a write or organize pass. */
export async function decideMemoryMerge(
  decisions: DecisionService | null | undefined,
  input: {
    candidate: MemoryLessonText
    existing: readonly MemoryLesson[]
    cwd?: string | undefined
    threadId?: string | undefined
    turnId?: string | undefined
  },
): Promise<readonly MemoryMergeVerdict[]> {
  const existing = input.existing.slice(0, MEMORY_JUDGE_MAX_LESSONS)
  if (existing.length === 0) return []
  const engine = await decisions?.ensureEngine(input.cwd).catch(() => null)
  if (!engine) return memoryMergeSpec.fallback({ ...input, existing })
  const origin =
    input.threadId || input.turnId ? { threadId: input.threadId, turnId: input.turnId } : undefined
  const decision = await engine.decide(
    memoryMergeSpec,
    { candidate: input.candidate, existing },
    ...(origin ? [{ origin }] : []),
  )
  return decision.outcome
}

/** End-of-turn check over lessons injected into the turn; empty when none were injected. */
export async function decideMemoryApplied(
  decisions: DecisionService | null | undefined,
  input: {
    lessons: readonly MemoryLesson[]
    turnDigest: string
    cwd?: string | undefined
    threadId?: string | undefined
    turnId?: string | undefined
  },
): Promise<MemoryAppliedOutcome> {
  const lessons = input.lessons.slice(0, MEMORY_JUDGE_MAX_LESSONS)
  if (lessons.length === 0) return { applied: [], notApplied: [] }
  const engine = await decisions?.ensureEngine(input.cwd).catch(() => null)
  if (!engine) return memoryAppliedSpec.fallback(input)
  const origin =
    input.threadId || input.turnId ? { threadId: input.threadId, turnId: input.turnId } : undefined
  const decision = await engine.decide(
    memoryAppliedSpec,
    { lessons, turnDigest: input.turnDigest },
    ...(origin ? [{ origin }] : []),
  )
  return decision.outcome
}

/** Lessons for the topics an injection actually carried, for the applied check. */
export function memoryLessonsFromInjection(
  injection: MemoryInjection,
  lessonsByNamespace: ReadonlyMap<string, readonly MemoryLesson[]>,
): MemoryLesson[] {
  const lessons: MemoryLesson[] = []
  for (const section of injection.sections) {
    for (const lesson of lessonsByNamespace.get(section.namespace) ?? []) {
      if (section.content.includes(lesson.id)) lessons.push(lesson)
    }
  }
  return lessons.slice(0, MEMORY_JUDGE_MAX_LESSONS)
}