import type {
  DecisionAnswer,
  DecisionPointManifest,
  DecisionQuestions,
  ScoreQuestion,
} from '@pidex/shared/decision'
import type { SubagentRole } from '@pidex/shared/thread'
import { defineDecision, type JsonValue } from '../DecisionSpec'
import { pickChoice, threeZone, type DecisionVerdict } from '../DecisionPolicy'
import { prEventTriageSpec } from './PrEventTriage'

export * from './PrEventTriage'

export type ReviewSeverity = 'must' | 'should' | 'nit'

export type ReviewFinding = {
  readonly text: string
  // INVARIANT: `file:line`, when the reviewer gave one.
  readonly where?: string | undefined
  readonly severity?: ReviewSeverity | undefined
}

export type ReviewTriageInput = {
  // INVARIANT: What the change under review is meant to do, in a sentence.
  readonly change: string
  readonly findings: readonly ReviewFinding[]
}

export type ReviewPriority = 'P0' | 'P1' | 'P2' | 'P3'

export type ReviewTriageOutcome = {
  // INVARIANT: One per finding, in the order of `findings`.
  readonly priorities: readonly ReviewPriority[]
}

const FINDING_LENGTH = 300
const CHANGE_LENGTH = 400

// INVARIANT: Question id of the defect reading for one finding.
export const reviewBugQuestion = (index: number) => `is_bug_${index}`
// INVARIANT: Question id of the change-attribution reading for one finding.
export const reviewScopeQuestion = (index: number) => `in_scope_${index}`

const verdictOf = (answer: DecisionAnswer | undefined): DecisionVerdict =>
  answer?.type === 'boolean' ? threeZone(answer) : 'unsure'

// INVARIANT: One finding's priority from the defect and attribution verdicts plus the reviewer's own word.
export function reviewPriorityOf(
  bug: DecisionVerdict,
  scope: DecisionVerdict,
  severity?: ReviewSeverity,
): ReviewPriority {
  if (bug === 'yes') {
    if (scope === 'yes') return severity === 'must' ? 'P0' : 'P1'
    return scope === 'no' ? 'P2' : 'P1'
  }
  if (bug === 'unsure') return severity === 'must' ? 'P1' : 'P2'
  return severity === 'must' ? 'P2' : 'P3'
}

// INVARIANT: Without a judge: the reviewer's own word, one step down since nobody confirmed it.
export function reviewPriorityBySeverity(severity?: ReviewSeverity): ReviewPriority {
  return severity === 'must' ? 'P1' : severity === 'nit' ? 'P3' : 'P2'
}

export const reviewTriageSpec = defineDecision({
  id: 'review.triage',
  version: 1,
  cacheImpact: 'none',
  latency: 'inline',
  capabilities: 'relate',
  questions: {} as DecisionQuestions,
  questionsFor(input: ReviewTriageInput): DecisionQuestions {
    return Object.fromEntries(
      input.findings.flatMap((_finding, index) => [
        [
          reviewBugQuestion(index),
          {
            type: 'boolean' as const,
            instructions: `Is \`finding_${index}\` a defect that changes how the program behaves?`,
          },
        ],
        [
          reviewScopeQuestion(index),
          {
            type: 'boolean' as const,
            instructions: `Is \`finding_${index}\` about the change in \`change\`?`,
          },
        ],
      ]),
    )
  },
  buildState(input: ReviewTriageInput): JsonValue {
    const state: Record<string, string> = { change: input.change.slice(0, CHANGE_LENGTH) }
    input.findings.forEach((finding, index) => {
      const where = finding.where ? `${finding.where}: ` : ''
      state[`finding_${index}`] = `${where}${finding.text}`.slice(0, FINDING_LENGTH)
    })
    return state
  },
  policy(answers, input): ReviewTriageOutcome {
    const map = answers as Record<string, DecisionAnswer>
    return {
      priorities: input.findings.map((finding, index) =>
        reviewPriorityOf(
          verdictOf(map[reviewBugQuestion(index)]),
          verdictOf(map[reviewScopeQuestion(index)]),
          finding.severity,
        ),
      ),
    }
  },
  fallback(input: ReviewTriageInput): ReviewTriageOutcome {
    return {
      priorities: input.findings.map((finding) => reviewPriorityBySeverity(finding.severity)),
    }
  },
})

// INVARIANT: Display roles a routed task may be given; roles grant nothing.
export const SWARM_ROLE_DESCRIPTIONS: Readonly<Record<SubagentRole, string>> = {
  frontend: 'UI, renderer, styling or client-side interaction work',
  backend: 'Server, service, storage or API work',
  devops: 'Build, packaging, deployment or CI work',
  qa: 'Testing, verification or reproduction work',
  designer: 'Visual design or layout exploration',
  data: 'Data processing, schemas or analysis work',
  docs: 'Documentation or writing work',
  product: 'Requirements, planning or product discussion',
  general: 'Anything else',
}

export type SwarmRoutingInput = {
  readonly task: string
  // INVARIANT: Reasoning tiers the chosen model actually supports; empty means no tier can change.
  readonly reasoningLevels: readonly string[]
  // INVARIANT: False when the role is already settled and must not be re-picked.
  readonly pickRole?: boolean | undefined
}

export type SwarmRoutingOutcome = {
  // INVARIANT: A tier id from `reasoningLevels`, or null to keep the session default.
  readonly reasoningLevel: string | null
  // INVARIANT: The display role that fits, or null to keep the default.
  readonly role: SubagentRole | null
}

const ROUTING_SCORES = {
  difficulty: {
    type: 'score',
    instructions: 'How hard is `task`?',
    criteria: [
      'Mechanical, no judgment needed',
      'Routine engineering',
      'Needs careful design',
      'Hard even for an expert',
    ],
  },
  reasoning: {
    type: 'score',
    instructions: 'How much reasoning does `task` need?',
    criteria: ['Almost none', 'Some', 'A lot', 'Deep multi-step reasoning'],
  },
} satisfies Record<string, ScoreQuestion>

// INVARIANT: Reasoning rated at or above this maps to the high tier; above 1.1 to medium.
export const SWARM_HIGH_REASONING_FROM = 2.4
export const SWARM_MEDIUM_REASONING_FROM = 1.1

const TIER_BANDS: Readonly<Record<string, number>> = {
  off: 0,
  minimal: 0,
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 2,
  max: 2,
}

export function pickReasoningLevel(depth: number, levels: readonly string[]): string | null {
  const known = levels
    .filter((level) => Object.hasOwn(TIER_BANDS, level))
    .map((level) => ({ level, band: TIER_BANDS[level]! }))
    .sort((left, right) => left.band - right.band)
  if (known.length < 2) return null
  const desired =
    depth >= SWARM_HIGH_REASONING_FROM ? 2 : depth >= SWARM_MEDIUM_REASONING_FROM ? 1 : 0
  const exact = known.find((entry) => entry.band === desired)
  if (exact) return exact.level
  const lower = [...known].reverse().find((entry) => entry.band < desired)
  if (lower) return lower.level
  const higher = known.find((entry) => entry.band > desired)
  return higher ? higher.level : null
}

// INVARIANT: swarm.routing 只选展示角色与既有模型的推理档位，绝不改变
export const swarmRoutingSpec = defineDecision({
  id: 'swarm.routing',
  version: 1,
  cacheImpact: 'none',
  latency: 'inline',
  capabilities: { role: 'classify', difficulty: 'rate', reasoning: 'rate' },
  questions: ROUTING_SCORES as DecisionQuestions,
  questionsFor(input: SwarmRoutingInput): DecisionQuestions {
    const scores = input.reasoningLevels.length >= 2 ? ROUTING_SCORES : {}
    if (input.pickRole === false) return scores as DecisionQuestions
    return {
      role: {
        type: 'choice',
        instructions: 'What kind of work is `task`?',
        criteria: { ...SWARM_ROLE_DESCRIPTIONS, other: 'None of these' },
      },
      ...scores,
    } as DecisionQuestions
  },
  buildState(input: SwarmRoutingInput): JsonValue {
    return { task: input.task }
  },
  policy(answers, input): SwarmRoutingOutcome {
    const map = answers as Record<string, DecisionAnswer>
    const depth = map.reasoning?.type === 'score' ? map.reasoning.score : null
    const roleAnswer = map.role
    const role =
      roleAnswer?.type === 'choice'
        ? ((pickChoice(roleAnswer, { minProbability: 0.5 }) as SubagentRole | undefined) ?? null)
        : null
    return {
      reasoningLevel: depth === null ? null : pickReasoningLevel(depth, input.reasoningLevels),
      role,
    }
  },
  fallback(): SwarmRoutingOutcome {
    return { reasoningLevel: null, role: null }
  },
})

// INVARIANT: Registration entries for the teamwork plane.
export const TEAMWORK_MANIFEST: readonly DecisionPointManifest[] = [
  {
    id: 'review.triage',
    group: 'teamwork',
    title: 'Review triage',
    titleZh: '评审分级',
    summary:
      'Grades review findings P0–P3 by behavior impact and attribution to the change under review.',
    summaryZh: '按行为影响与改动归因为评审意见补充 P0–P3 分级。',
    defaultMode: 'shadow',
    feature: 'decision.teamwork',
  },
  {
    id: 'swarm.routing',
    group: 'teamwork',
    title: 'Subagent routing',
    titleZh: '子 Agent 路由',
    summary:
      'Picks a display role and reasoning tier for delegated tasks without an explicit role or tier; never widens permissions.',
    summaryZh: '为未显式指定角色/档位的子 Agent 任务挑选展示角色与推理档位；绝不放宽权限。',
    defaultMode: 'shadow',
    feature: 'decision.teamwork',
  },
  {
    id: 'pr.event_triage',
    group: 'teamwork',
    title: 'PR watch event triage',
    titleZh: 'PR 监控唤醒分流',
    summary:
      'Triages watched PR updates into actionable code fixes, human-decision pauses, or non-actionable noise before waking a full repair turn.',
    summaryZh:
      '在唤醒 PR 自动修复回合前，将审查与 CI 变更分流为可执行修复、需人工介入（暂停监控）或噪声跳过。',
    defaultMode: 'shadow',
    feature: 'decision.teamwork',
  },
]

export const TEAMWORK_SPECS = {
  'review.triage': reviewTriageSpec,
  'swarm.routing': swarmRoutingSpec,
  'pr.event_triage': prEventTriageSpec,
} as const
