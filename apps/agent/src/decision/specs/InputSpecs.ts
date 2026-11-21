import type { DecisionPointManifest } from '@pidex/shared/decision'
import { ABSTAIN, defineDecision, type JsonValue } from '../DecisionSpec'
import { pickChoice, threeZone, type DecisionVerdict } from '../DecisionPolicy'


// INVARIANT: The thread's lightweight task frame; host-maintained, never model-authored.
export type TaskFrame = {
  readonly goal: string
  readonly constraints: readonly string[]
  readonly currentSubgoal?: string | undefined
}

export type InputPreflightInput = {
  readonly userMessage: string
  // INVARIANT: Short digests of the most recent turns, oldest first.
  readonly recentTurns: readonly string[]
  readonly taskFrame?: TaskFrame | undefined
  // INVARIANT: What the agent is doing right now, when the message arrives mid-run.
  readonly currentAction?: string | undefined
  // INVARIANT: True once this session has used a tool: a terse message is then more likely steering than chat.
  readonly sessionHasWork?: boolean | undefined
}

export type TurnType =
  | 'chat'
  | 'chat_question'
  | 'quick_lookup'
  | 'single_edit'
  | 'multi_step_task'
  | 'research'
  | 'design_discussion'

export type InputGear = 'chat' | 'light' | 'standard' | 'heavy'

export type InputPreflightOutcome = {
  readonly turnType: TurnType | 'unknown'
  readonly gear: InputGear
  readonly sideQuestion: DecisionVerdict
  readonly needsClarification: DecisionVerdict
  readonly needsFilesChanged: DecisionVerdict
  readonly needsMemory: DecisionVerdict
  readonly swarmWorthy: DecisionVerdict
  readonly planFirst: DecisionVerdict
  // INVARIANT: Raw rubric positions; see the score questions for the levels.
  readonly complexity: { readonly task: number; readonly reasoning: number; readonly tools: number }
}

const UNKNOWN_PREFLIGHT: InputPreflightOutcome = {
  turnType: 'unknown',
  gear: 'standard',
  sideQuestion: 'unsure',
  needsClarification: 'unsure',
  needsFilesChanged: 'unsure',
  needsMemory: 'unsure',
  swarmWorthy: 'unsure',
  planFirst: 'unsure',
  complexity: { task: 1.5, reasoning: 1.5, tools: 1.5 },
}

const SOCIAL =
  /^\s*(hi|hello|hey|yo|thanks|thank you|thx|ok|okay|good (morning|evening|night)|bye|你好|您好|嗨|哈喽|在吗|早上好|晚上好|晚安|谢谢|多谢|辛苦了|好的|再见|拜拜)[\s!！。.,，~～?？]*$/i

const TECHNICAL =
  /[`{}<>=;$\\]|[\w-]+\.[a-z]{1,5}\b|[\w.-]*\/[\w.-]+|\b\w+_\w+|\b(code|file|folder|directory|function|method|class|variable|module|package|library|framework|bug|error|exception|crash|stack|trace|log|test|build|compile|lint|deploy|release|commit|branch|merge|rebase|diff|repo|repository|git|npm|pip|yarn|docker|api|endpoint|server|client|database|sql|query|schema|script|config|cli|terminal|shell|regex|json|yaml|http|url|refactor|implement|debug|fix|rename|install|dependency|import|type|interface|async|thread|cache|token|prompt|model|agent|skill|tool|browser|delegate)s?\b|代码|文件|目录|函数|方法|变量|模块|依赖|报错|错误|异常|崩溃|日志|测试|编译|构建|部署|发布|提交|分支|合并|仓库|接口|服务|数据库|脚本|配置|终端|命令|重构|实现|调试|修复|改名|重命名|安装|缓存|项目|架构|这里|这个|上面|刚才|继续|再试|运行|跑一下/i

const CAMEL_CASE = /\b[a-z]+[A-Z][a-zA-Z]*\b/

// INVARIANT: Rules before the judge: greetings are chat, and an untraceable message before any work is chat too.
export function chatByRule(message: string, sessionHasWork: boolean): boolean {
  const text = message.trim()
  if (!text || text.length > 400) return false
  if (SOCIAL.test(text)) return true
  return !sessionHasWork && !TECHNICAL.test(text) && !CAMEL_CASE.test(text)
}

function gearFor(turnType: TurnType | 'unknown', filesChanged: DecisionVerdict, peak: number): InputGear {
  if (turnType === 'unknown') return 'standard'
  if (turnType === 'chat') return filesChanged === 'yes' ? 'standard' : 'chat'
  const conversational = turnType === 'chat_question' || turnType === 'design_discussion'
  if (conversational && filesChanged === 'no') return 'chat'
  if (turnType === 'quick_lookup') return peak <= 1.2 ? 'light' : 'standard'
  if (peak >= 2.5 || turnType === 'research') return 'heavy'
  return 'standard'
}

// INVARIANT: One batched classification per user message, before the main model runs.
export const inputPreflightSpec = defineDecision({
  id: 'input.preflight',
  version: 1,
  cacheImpact: 'append-only',
  latency: 'inline',
  capabilities: { is_side_question: 'relate', needs_clarification: 'meta', swarm_worthy: 'meta' },
  questions: {
    turn_type: {
      type: 'choice',
      instructions: 'What does `user_message` ask for?',
      criteria: {
        chat: 'Small talk or a general question that is not about code',
        chat_question: 'An explanation of a concept',
        quick_lookup: 'Finding where something is in the code',
        single_edit: 'One small code change',
        multi_step_task: 'A larger task with several steps',
        research: 'A broad survey or investigation',
        design_discussion: 'A discussion of options and trade-offs',
        other: 'Something else',
      },
    },
    is_side_question: {
      type: 'boolean',
      instructions: 'Is `user_message` unrelated to the task in `task_frame`?',
    },
    needs_clarification: {
      type: 'boolean',
      instructions: 'Is `user_message` too vague to act on?',
    },
    needs_files_changed: {
      type: 'boolean',
      instructions: 'Does `user_message` request a code change?',
    },
    needs_memory: {
      type: 'boolean',
      instructions: 'Would notes from past sessions in this project help with `user_message`?',
    },
    swarm_worthy: {
      type: 'boolean',
      instructions: 'Does `user_message` describe several independent tasks?',
    },
    plan_first: {
      type: 'boolean',
      instructions: 'Does `user_message` ask for a large or risky change?',
    },
    task_complexity: {
      type: 'score',
      instructions: 'What is the scope of `user_message`?',
      criteria: ['A question', 'One place in the code', 'Several places in the code', 'The whole codebase'],
    },
    reasoning_depth: {
      type: 'score',
      instructions: 'How much careful reasoning does `user_message` require?',
      criteria: [
        'Recall or lookup',
        'Straightforward explanation',
        'Non-obvious analysis',
        'Deep multi-factor reasoning',
      ],
    },
    tool_complexity: {
      type: 'score',
      instructions: 'How much tool use does `user_message` require?',
      criteria: [
        'None',
        'One or two read-only calls',
        'Several calls including edits',
        'Many calls with build or test cycles',
      ],
    },
  },
  buildState(input: InputPreflightInput): JsonValue {
    return {
      user_message: input.userMessage,
      current_action: input.currentAction ?? null,
      task_frame: input.taskFrame
        ? {
            goal: input.taskFrame.goal,
            constraints: input.taskFrame.constraints,
            current_subgoal: input.taskFrame.currentSubgoal ?? null,
          }
        : null,
      recent_turns: input.recentTurns,
    }
  },
  policy(answers, input): InputPreflightOutcome | typeof ABSTAIN {
    const ruledChat = chatByRule(input.userMessage, input.sessionHasWork === true)
    const turnType = (pickChoice(answers.turn_type) as TurnType | undefined) ?? (ruledChat ? 'chat' : 'unknown')
    const needsFilesChanged = threeZone(answers.needs_files_changed)
    const hasMainLine = input.taskFrame !== undefined || input.recentTurns.length > 0
    const verdicts = {
      sideQuestion: hasMainLine ? threeZone(answers.is_side_question) : ('no' as const),
      needsClarification: threeZone(answers.needs_clarification),
      needsFilesChanged,
      needsMemory: threeZone(answers.needs_memory),
      swarmWorthy: threeZone(answers.swarm_worthy),
      planFirst: threeZone(answers.plan_first),
    }
    if (turnType === 'unknown' && Object.values(verdicts).every((verdict) => verdict === 'unsure'))
      return ABSTAIN
    const complexity = {
      task: answers.task_complexity.score,
      reasoning: answers.reasoning_depth.score,
      tools: answers.tool_complexity.score,
    }
    const peak = Math.max(complexity.task, complexity.reasoning, complexity.tools)
    return { turnType, gear: gearFor(turnType, needsFilesChanged, peak), ...verdicts, complexity }
  },
  fallback(input: InputPreflightInput): InputPreflightOutcome {
    if (!chatByRule(input.userMessage, input.sessionHasWork === true)) return UNKNOWN_PREFLIGHT
    return { ...UNKNOWN_PREFLIGHT, turnType: 'chat', gear: 'chat', needsFilesChanged: 'no', planFirst: 'no' }
  },
})

export type TaskFrameChange = 'new_task' | 'hard_constraint' | 'correction' | 'subgoal' | 'unclear'

export type TaskFrameOutcome = TaskFrameChange | 'no_change'

export type TaskFrameInput = {
  readonly userMessage: string
  // INVARIANT: The frame as it stands before this message; null when the thread has none.
  readonly frame: TaskFrame | null
  readonly recentTurns: readonly string[]
}

const FRAME_SURE = 0.6
const FRAME_CHANGED = 0.7

export const taskFrameSpec = defineDecision({
  id: 'task.frame',
  version: 1,
  cacheImpact: 'append-only',
  latency: 'parallel',
  capabilities: 'relate',
  allowChoicesWithoutEscape: true,
  questions: {
    change: {
      type: 'choice',
      instructions: 'What does `user_message` change in `task_frame`?',
      criteria: {
        new_task: 'It starts a different task',
        hard_constraint: 'It adds a rule the work must follow',
        correction: 'It says the current approach is wrong',
        subgoal: 'It moves on to the next step of the same task',
        no_change: 'Nothing: it is chat, a question or a go-ahead',
      },
    },
  },
  buildState(input: TaskFrameInput): JsonValue {
    return {
      user_message: input.userMessage,
      task_frame: input.frame
        ? {
            goal: input.frame.goal,
            constraints: input.frame.constraints,
            current_subgoal: input.frame.currentSubgoal ?? null,
          }
        : null,
      recent_turns: input.recentTurns,
    }
  },
  policy(answers): TaskFrameOutcome {
    const { choice, probabilities } = answers.change
    const asOutcome = (option: string): TaskFrameOutcome =>
      option === 'new_task' || option === 'hard_constraint' || option === 'correction' || option === 'subgoal'
        ? option
        : 'no_change'
    if (!probabilities) return asOutcome(choice)
    const p = (option: string) => probabilities[option] ?? 0
    const limiting = p('hard_constraint') + p('correction')
    const kinds: [TaskFrameOutcome, number][] = [
      ['new_task', p('new_task')],
      [p('correction') > p('hard_constraint') ? 'correction' : 'hard_constraint', limiting],
      ['subgoal', p('subgoal')],
    ]
    const [kind, weight] = kinds.reduce((best, each) => (each[1] > best[1] ? each : best))
    if (weight >= FRAME_SURE) return kind
    const changed = kinds.reduce((sum, each) => sum + each[1], 0)
    return changed >= FRAME_CHANGED ? 'unclear' : 'no_change'
  },
  fallback(): TaskFrameOutcome {
    return 'no_change'
  },
})

// INVARIANT: Thread frames live only in memory; a restart loses them by design.
// SAFETY: 线程框架仅存内存 Map，上限 MAX_TRACKED_FRAMES 条（LRU 淘汰），重启即失；
const MAX_TRACKED_FRAMES = 512
const MAX_FRAME_CONSTRAINTS = 32
const FRAME_TEXT_LIMIT = 500
const frames = new Map<string, TaskFrame>()

// INVARIANT: The current frame of a thread, or null when none has been established.
export function taskFrameOf(threadId: string): TaskFrame | null {
  const frame = frames.get(threadId)
  if (!frame) return null
  frames.delete(threadId)
  frames.set(threadId, frame)
  return frame
}

// INVARIANT: Drops a thread's frame; used when a thread is deleted or reset.
export function clearTaskFrame(threadId: string): void {
  frames.delete(threadId)
}

// INVARIANT: Test hook: forgets every tracked frame.
export function resetTaskFrames(): void {
  frames.clear()
}

const trimmed = (text: string) => text.trim().slice(0, FRAME_TEXT_LIMIT)

// INVARIANT: hard_constraint 与 correction 只追加约束、绝不放宽或删除既有约束；
export function applyTaskFrameChange(
  threadId: string,
  change: TaskFrameOutcome,
  userMessage: string,
): TaskFrame {
  const current = frames.get(threadId) ?? { goal: '', constraints: [] }
  const text = trimmed(userMessage)
  let next: TaskFrame = current
  if (change === 'new_task') {
    next = { goal: text, constraints: current.constraints }
  } else if (change === 'hard_constraint' || change === 'correction') {
    const constraints =
      current.constraints.length >= MAX_FRAME_CONSTRAINTS || !text
        ? current.constraints
        : [...current.constraints, text]
    next = { ...current, constraints }
  } else if (change === 'subgoal') {
    next = { ...current, currentSubgoal: text || current.currentSubgoal }
  }
  frames.delete(threadId)
  frames.set(threadId, next)
  while (frames.size > MAX_TRACKED_FRAMES) {
    const oldest = frames.keys().next().value
    if (oldest === undefined) break
    frames.delete(oldest)
  }
  return next
}

export type InterjectionInput = {
  readonly userMessage: string
  readonly goal: string
  readonly currentAction: string
}

// INVARIANT: `steer` injects into the running turn now; `followUp` waits for the turn to end.
export type InterjectionOutcome = 'steer' | 'followUp'

// INVARIANT: The host's default delivery stands unless the judge is sure of a correction or an addition.
export const INTERJECTION_BUDGET_MS = 1_500

// INVARIANT: A message typed while the agent is working: inject now or queue for the turn's end.
export const inputInterjectionSpec = defineDecision({
  id: 'input.interjection',
  version: 1,
  cacheImpact: 'append-only',
  latency: 'inline',
  capabilities: 'relate',
  questions: {
    kind: {
      type: 'choice',
      instructions: 'What is `user_message`, given that the agent is busy with `current_action`?',
      criteria: {
        correction: 'It says the agent is doing something wrong or should stop',
        addition: 'It adds more work to do after the current work',
        other: 'Something else, or it is unclear',
      },
    },
  },
  buildState(input: InterjectionInput): JsonValue {
    return { user_message: input.userMessage, current_action: input.currentAction, goal: input.goal }
  },
  policy(answers): InterjectionOutcome {
    const kind = pickChoice(answers.kind, { minProbability: 0.7 })
    return kind === 'correction' ? 'steer' : 'followUp'
  },
  fallback(): InterjectionOutcome {
    return 'followUp'
  },
})

// INVARIANT: Registration entries for the input plane; the orchestrator wires the hooks.
export const INPUT_MANIFEST: readonly DecisionPointManifest[] = [
  {
    id: 'input.preflight',
    group: 'input',
    title: 'Input preflight',
    titleZh: '输入预检',
    summary: 'Classifies each user message: turn type, gear, complexity and thinking depth.',
    summaryZh: '对每条用户消息分类：回合类型、装备档位、复杂度与思考深度。',
    defaultMode: 'shadow',
    feature: 'decision.input',
  },
  {
    id: 'task.frame',
    group: 'input',
    title: 'Task frame',
    titleZh: '任务框架',
    summary: 'Detects new tasks, hard constraints, corrections and subgoals; feeds tool approval and constraint checks.',
    summaryZh: '判别新任务、硬约束、纠正与子目标，维护线程任务框架供工具审批与约束判别使用。',
    defaultMode: 'shadow',
    feature: 'decision.input',
  },
  {
    id: 'input.interjection',
    group: 'input',
    title: 'Interjection routing',
    titleZh: '插话路由',
    summary: 'Routes a message typed mid-run: inject into the running turn or wait for it to end.',
    summaryZh: '运行中收到用户插话时，判别立即注入本轮还是等待本轮结束。',
    defaultMode: 'shadow',
    feature: 'decision.input',
  },
]

export const INPUT_SPECS = {
  'input.preflight': inputPreflightSpec,
  'task.frame': taskFrameSpec,
  'input.interjection': inputInterjectionSpec,
} as const