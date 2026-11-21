import type {
  DecisionAnswer,
  DecisionPointManifest,
  DecisionQuestions,
} from '@pidex/shared/decision'
import { defineDecision, type JsonValue } from '../DecisionSpec'
import { pickChoice, threeZone } from '../DecisionPolicy'

/**
 * Memory-plane decision points over the file-backed memory store. The judge
 * only judges; writing memory stays with the existing MemoryService runner and
 * its credential and source filters. Nothing here treats stored or external
 * content as user authorization.
 */

/** One stored memory topic; `trigger` is when it applies, `lesson` the line injected. */
export type MemoryLesson = {
  readonly id: string
  readonly trigger: string
  readonly lesson: string
}

export type MemoryLessonText = {
  readonly trigger: string
  readonly lesson: string
}

/** How a lesson reads in a judge's state: the situation, then what to do. */
export function describeMemoryLesson(lesson: MemoryLessonText): string {
  return `When: ${lesson.trigger.slice(0, 200)}\nDo: ${lesson.lesson.slice(0, 300)}`
}

const choiceOf = (answer: DecisionAnswer | undefined) =>
  answer?.type === 'choice' ? pickChoice(answer) : undefined
const verdictOf = (answer: DecisionAnswer | undefined) =>
  answer?.type === 'boolean' ? threeZone(answer) : ('unsure' as const)

export type MemoryCaptureInput = {
  readonly userMessage: string
  readonly previousAssistantMessage: string
}

export type MemoryCaptureOutcome = 'correction' | 'preference' | 'skip'

/** Write-side screen: is this user message a correction or a standing preference worth keeping? */
// SAFETY: user_message 仅取宿主记录的真实用户发言；判定只提示提取，写入仍走 MemoryService 的来源与凭据过滤。
export const memoryCaptureSpec = defineDecision({
  id: 'memory.capture',
  version: 1,
  cacheImpact: 'none',
  latency: 'background',
  questions: {
    correction: {
      type: 'boolean',
      instructions: 'Does `user_message` correct a mistake the assistant made?',
    },
    preference: {
      type: 'boolean',
      instructions: 'Does `user_message` state a rule to follow from now on?',
    },
  },
  buildState(input: MemoryCaptureInput): JsonValue {
    return {
      user_message: input.userMessage,
      previous_assistant_message: input.previousAssistantMessage,
    }
  },
  policy(answers): MemoryCaptureOutcome {
    if (threeZone(answers.correction) === 'yes') return 'correction'
    return threeZone(answers.preference) === 'yes' ? 'preference' : 'skip'
  },
  fallback(): MemoryCaptureOutcome {
    return 'skip'
  },
})

export type MemoryRecallInput = {
  readonly userMessage: string
  readonly lessons: readonly MemoryLesson[]
}

export type MemoryRecallOutcome = { readonly apply: readonly string[] }

/** Question id of one lesson inside a dynamic recall request. */
export function memoryRecallQuestionId(index: number): string {
  return `lesson_${index}`
}

/** Read side: which stored topics apply to this message? Only a confident yes injects one. */
export const memoryRecallSpec = defineDecision({
  id: 'memory.recall',
  version: 1,
  cacheImpact: 'append-only',
  latency: 'inline',
  capabilities: 'relate',
  questions: {} as DecisionQuestions,
  questionsFor(input: MemoryRecallInput): DecisionQuestions {
    return Object.fromEntries(
      input.lessons.map((lesson, index) => [
        memoryRecallQuestionId(index),
        {
          type: 'boolean' as const,
          instructions: `Does this situation match \`user_message\`? ${lesson.trigger.slice(0, 200)}`,
        },
      ]),
    )
  },
  buildState(input: MemoryRecallInput): JsonValue {
    return { user_message: input.userMessage }
  },
  policy(answers, input): MemoryRecallOutcome {
    const apply: string[] = []
    input.lessons.forEach((lesson, index) => {
      if (
        verdictOf((answers as Record<string, DecisionAnswer>)[memoryRecallQuestionId(index)]) ===
        'yes'
      )
        apply.push(lesson.id)
    })
    return { apply }
  },
  fallback(): MemoryRecallOutcome {
    return { apply: [] }
  },
})

/** `lesson_1`, `lesson_2`, …: a candidate or lesson inside a batched state. */
export function memoryLessonField(index: number): string {
  return `lesson_${index + 1}`
}

export type MemoryWorthInput = {
  readonly lessons: readonly MemoryLessonText[]
  /** The project's own instructions (AGENTS.md and the like), for `already_known`. */
  readonly projectInstructions: string
}

export type MemoryWorthVerdict = 'reusable' | 'one_off' | 'already_known' | 'unclear'

const WORTH_CRITERIA: Readonly<Record<MemoryWorthVerdict, string>> = {
  reusable:
    'Will help again in later work: a trap and the way around it, a rule for working here, or a fact about the project that is not obvious',
  one_off: 'Only about the task at hand, or a passing detail',
  already_known:
    'What any coding agent does without being told, or what `project_instructions` already says',
  unclear: 'Cannot tell',
}

/** Is a candidate lesson worth keeping? Only `reusable` should be stored. */
export const memoryWorthSpec = defineDecision({
  id: 'memory.worth',
  version: 1,
  cacheImpact: 'none',
  latency: 'inline',
  capabilities: 'relate',
  questions: {} as DecisionQuestions,
  questionsFor(input: MemoryWorthInput): DecisionQuestions {
    return Object.fromEntries(
      input.lessons.map((_, index) => [
        `worth_${index + 1}`,
        {
          type: 'choice' as const,
          instructions: `What is \`${memoryLessonField(index)}\` to a coding agent that works in this project later?`,
          criteria: { ...WORTH_CRITERIA },
        },
      ]),
    )
  },
  buildState(input: MemoryWorthInput): JsonValue {
    const state: Record<string, string> = {}
    input.lessons.forEach((lesson, index) => {
      state[memoryLessonField(index)] = describeMemoryLesson(lesson)
    })
    state.project_instructions = input.projectInstructions.trim() || '(none)'
    return state
  },
  policy(answers, input): readonly MemoryWorthVerdict[] {
    return input.lessons.map((_, index) => {
      const picked = choiceOf((answers as Record<string, DecisionAnswer>)[`worth_${index + 1}`])
      return picked === 'reusable' || picked === 'one_off' || picked === 'already_known'
        ? picked
        : 'unclear'
    })
  },
  fallback(input: MemoryWorthInput): readonly MemoryWorthVerdict[] {
    return input.lessons.map(() => 'unclear' as const)
  },
})

export type MemoryMergeInput = {
  readonly candidate: MemoryLessonText
  /** The stored lessons most like the candidate, by shared words. */
  readonly existing: readonly MemoryLesson[]
}

export type MemoryMergeVerdict = 'same' | 'refines' | 'contradicts' | 'unrelated'

const MERGE_CRITERIA: Readonly<Record<MemoryMergeVerdict | 'unclear', string>> = {
  same: 'The same lesson as `candidate`, in other words, or it already says everything `candidate` says',
  refines: '`candidate` covers the same ground and says it more precisely or more specifically',
  contradicts: 'It and `candidate` cannot both hold: following one breaks the other',
  unrelated: 'About something else',
  unclear: 'Cannot tell',
}

/** Before a lesson is written: how each similar stored lesson relates to the candidate. */
export const memoryMergeSpec = defineDecision({
  id: 'memory.merge',
  version: 1,
  cacheImpact: 'none',
  latency: 'inline',
  capabilities: 'relate',
  questions: {} as DecisionQuestions,
  questionsFor(input: MemoryMergeInput): DecisionQuestions {
    return Object.fromEntries(
      input.existing.map((_, index) => [
        `merge_${index + 1}`,
        {
          type: 'choice' as const,
          instructions: `Compared with \`candidate\`, what is \`existing_${index + 1}\`?`,
          criteria: { ...MERGE_CRITERIA },
        },
      ]),
    )
  },
  buildState(input: MemoryMergeInput): JsonValue {
    const state: Record<string, string> = { candidate: describeMemoryLesson(input.candidate) }
    input.existing.forEach((lesson, index) => {
      state[`existing_${index + 1}`] = describeMemoryLesson(lesson)
    })
    return state
  },
  policy(answers, input): readonly MemoryMergeVerdict[] {
    return input.existing.map((_, index) => {
      const picked = choiceOf((answers as Record<string, DecisionAnswer>)[`merge_${index + 1}`])
      return picked === 'same' || picked === 'refines' || picked === 'contradicts'
        ? picked
        : 'unrelated'
    })
  },
  fallback(input: MemoryMergeInput): readonly MemoryMergeVerdict[] {
    return input.existing.map(() => 'unrelated' as const)
  },
})

export type MemoryAppliedInput = {
  /** The lessons brought into the turn. */
  readonly lessons: readonly MemoryLesson[]
  readonly turnDigest: string
}

/** Ids the judge is sure about, either way; an unsure lesson is in neither list. */
export type MemoryAppliedOutcome = {
  readonly applied: readonly string[]
  readonly notApplied: readonly string[]
}

/** End of turn: did the agent do what each injected lesson says? */
export const memoryAppliedSpec = defineDecision({
  id: 'memory.applied',
  version: 1,
  cacheImpact: 'none',
  latency: 'background',
  capabilities: 'relate',
  questions: {} as DecisionQuestions,
  questionsFor(input: MemoryAppliedInput): DecisionQuestions {
    return Object.fromEntries(
      input.lessons.map((_, index) => [
        `applied_${index + 1}`,
        {
          type: 'boolean' as const,
          instructions: `Judging by \`turn_digest\`, did the assistant do what \`${memoryLessonField(index)}\` says?`,
        },
      ]),
    )
  },
  buildState(input: MemoryAppliedInput): JsonValue {
    const state: Record<string, string> = {}
    input.lessons.forEach((lesson, index) => {
      state[memoryLessonField(index)] = describeMemoryLesson(lesson)
    })
    state.turn_digest = input.turnDigest
    return state
  },
  policy(answers, input): MemoryAppliedOutcome {
    const applied: string[] = []
    const notApplied: string[] = []
    input.lessons.forEach((lesson, index) => {
      const verdict = verdictOf((answers as Record<string, DecisionAnswer>)[`applied_${index + 1}`])
      if (verdict === 'yes') applied.push(lesson.id)
      else if (verdict === 'no') notApplied.push(lesson.id)
    })
    return { applied, notApplied }
  },
  fallback(): MemoryAppliedOutcome {
    return { applied: [], notApplied: [] }
  },
})

/** Registration entries for the memory plane; semantically part of the context group. */
export const MEMORY_MANIFEST: readonly DecisionPointManifest[] = [
  {
    id: 'memory.capture',
    group: 'context',
    title: 'Memory capture screen',
    titleZh: '记忆捕获判别',
    summary: 'Screens user messages for corrections or standing preferences worth extracting.',
    summaryZh: '判别用户消息是否为值得提取的纠正或长期偏好。',
    defaultMode: 'shadow',
    feature: 'decision.memory',
  },
  {
    id: 'memory.recall',
    group: 'context',
    title: 'Memory recall',
    titleZh: '记忆召回',
    summary: 'Picks which stored memory topics apply to the current message.',
    summaryZh: '判别哪些已存记忆主题与当前消息相关。',
    defaultMode: 'shadow',
    feature: 'decision.memory',
  },
  {
    id: 'memory.worth',
    group: 'context',
    title: 'Memory worth',
    titleZh: '记忆价值判别',
    summary: 'Rates candidate lessons: reusable, one-off or already known.',
    summaryZh: '评估候选记忆：可复用、一次性或已知内容。',
    defaultMode: 'shadow',
    feature: 'decision.memory',
  },
  {
    id: 'memory.merge',
    group: 'context',
    title: 'Memory merge',
    titleZh: '记忆合并判别',
    summary:
      'Compares a candidate lesson with similar stored ones: same, refines, contradicts or unrelated.',
    summaryZh: '将候选记忆与相似已存记忆比对：相同、细化、矛盾或无关。',
    defaultMode: 'shadow',
    feature: 'decision.memory',
  },
  {
    id: 'memory.applied',
    group: 'context',
    title: 'Memory applied',
    titleZh: '记忆应用核验',
    summary: 'At turn end, checks whether injected lessons were followed.',
    summaryZh: '回合结束时核验注入的记忆是否被遵循。',
    defaultMode: 'shadow',
    feature: 'decision.memory',
  },
]

export const MEMORY_SPECS = {
  'memory.capture': memoryCaptureSpec,
  'memory.recall': memoryRecallSpec,
  'memory.worth': memoryWorthSpec,
  'memory.merge': memoryMergeSpec,
  'memory.applied': memoryAppliedSpec,
} as const
