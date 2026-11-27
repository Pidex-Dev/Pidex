import type { ContextBudget } from '@pidex/shared/thread'
import type { ContextCompactionService } from '../../context/ContextCompactionService'
import type { AgentHarness } from '../harness/AgentHarness'
import type {
  AgentHarnessEvent,
  AgentHarnessResources,
  CompactResult,
  Session,
} from '../harness/Types'
import type { AgentTool, ThinkingLevel } from '../harness/AgentTypes'
import type { Model, Models } from '@earendil-works/pi-ai'
import type { ContextUsageBreakdownEntry, ToolResultBlock } from '@pidex/shared/thread'
import type {
  ModelRef,
  PermissionConfig,
  SubagentProfile,
  SubagentResult,
  SubagentStats,
  TaskMode,
} from '../../Domain'
import type { PromptBundle, PromptSection } from '../../prompt/Types'
import type { ToolExecutor } from '../../tool/ToolExecutor'
import type { ToolCatalog } from '../../tool/ToolRegistry'
import type { WorkspaceService } from '../../workspace/WorkspaceService'
import type { ExecutionPlanInput } from '../plan/ExecutionPlanInput'
import type { StructuredPlan } from '@pidex/shared/thread'
import type { ScheduleDraftSubmission } from '../plan/ScheduleDraft'
import type { RequestUserInput } from '../../session/QuestionInput'

export type HarnessRunResult =
  | { status: 'completed'; output: string; result?: SubagentResult; stats?: SubagentStats }
  | { status: 'paused'; output: string }

export type RuntimeCompactionTrigger = 'manual' | 'automatic' | 'reactive'

export interface HarnessRuntimeRequest {
  threadID: string
  turnID: string
  agentID: string
  sessionID: string
  profile?: SubagentProfile
  waitForModelNetwork?: boolean
  content: string
  /** Resume continuation prompt emitted instead of re-sending the initial turn bundle. */
  resumedContent?: string
  taskMode: TaskMode
  permissionConfig: PermissionConfig
  signal: AbortSignal
  workspace: WorkspaceService
  defaultCwd?: string
  model: Model<any>
  policyModel: ModelRef
  thinkingLevel?: ThinkingLevel
  maxContextTokens?: number | null
  collaborationMessages?: () => Array<{
    id: string
    kind: string
    message: string
    created_at: number
  }>
  exposedTools: readonly string[]
  promptSections: readonly PromptSection[]
  /** Authoritative pre-composed prompt bundle (frozen by the turn composition). */
  bundle?: PromptBundle
  attachments?: import('../../provider/runtime/MediaInput').RuntimeAttachment[]
  allowedTools?: readonly string[]
  delegationEnabled?: boolean
  collaborationEnabled?: boolean
  toolCatalog?: ToolCatalog
  /** Frozen deferred tool names from the persisted turn snapshot; the runtime may only bind these. */
  frozenDeferredToolNames?: readonly string[]
  onPromptComposed?: (bundle: PromptBundle) => void | Promise<void>
  /** 每次 provider 请求前上报按来源实测的上下文字符量；仅用于展示。 */
  onContextUsageMeasured?: (breakdown: readonly ContextUsageBreakdownEntry[]) => void
  onSkillDocumentRead?: (path: string, hash: string) => Promise<{ name: string } | undefined>
  preapprovedToolCalls?: ReadonlyMap<string, string | undefined>
  canAutoCompact?: () => boolean | Promise<boolean>
}

export interface HarnessDependencies {
  models: Models
  session: Session
  resources?: AgentHarnessResources
}

export interface HarnessFactory {
  resolve(request: HarnessRuntimeRequest): Promise<HarnessDependencies>
}

export interface RuntimeEventContext {
  threadID: string
  turnID: string
  agentID: string
}

export type AssistantMessagePlacement = 'process' | 'result'

/**
 * Base64-encoded artifact content produced by a tool result. The sink persists
 * the blob under a controlled store and only the artifact ID travels in items
 * and events.
 */
export type ToolArtifactInput = {
  artifactId: string
  name: string
  mimeType: string
  data: string
}

export type ToolCompletionMetadata = {
  stopReason?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/**
 * Persistence is deliberately outside the provider adapter. The eventual Agent integration
 * must implement savePoint/settled with AgentDatabase transactions and publish only
 * after the transaction commits.
 */
export interface RuntimeEventSink {
  modelRecovery?(
    context: RuntimeEventContext,
    input: {
      state: import('@pidex/shared/thread').ModelRecoveryState | null
      discardedItemIDs: readonly string[]
      usage?: import('@earendil-works/pi-ai').Usage
    },
  ): void | Promise<void>
  visualizationPreview?(
    context: RuntimeEventContext,
    preview: import('@pidex/shared/visualization').VisualizationPreview,
  ): void | Promise<void>
  event?(context: RuntimeEventContext, event: AgentHarnessEvent): void | Promise<void>
  assistantMessageStarted?(
    context: RuntimeEventContext,
    input: {
      textItemID: string
      reasoningItemID: string
      placement: AssistantMessagePlacement
      phase?: import('@pidex/shared/thread').MessagePhase
    },
  ): void | Promise<void>
  assistantMessageCompleted?(
    context: RuntimeEventContext,
    input: {
      textItemID: string
      reasoningItemID: string
      planItemID: string
      placement: AssistantMessagePlacement
      phase?: import('@pidex/shared/thread').MessagePhase
      content: unknown
      text?: string
      plan?: string | null
      provider: string
      api: string
      model: string
      /** Final assistant message entry in the private session tree. */
      sessionEntryID?: string
      usage: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        reasoning: number
      }
      /** Safe completion metadata projected from the provider response. */
      completion?: ToolCompletionMetadata
    },
  ): void | Promise<void>
  assistantMessagePhaseChanged?(
    context: RuntimeEventContext,
    input: { itemID: string; phase: import('@pidex/shared/thread').MessagePhase; text: string },
  ): void | Promise<void>
  textDelta?(
    context: RuntimeEventContext,
    input: { itemID: string; delta: string },
  ): void | Promise<void>
  planStarted?(context: RuntimeEventContext, input: { itemID: string }): void | Promise<void>
  planDelta?(
    context: RuntimeEventContext,
    input: { itemID: string; delta: string },
  ): void | Promise<void>
  reasoningStarted?(
    context: RuntimeEventContext,
    input: { itemID: string },
  ): void | Promise<void>
  reasoningDelta?(
    context: RuntimeEventContext,
    input: { itemID: string; delta: string },
  ): void | Promise<void>
  toolStarted?(
    context: RuntimeEventContext,
    input: { toolCallID: string; tool: string; input: unknown },
  ): void | Promise<void>
  toolUpdated?(
    context: RuntimeEventContext,
    input: { toolCallID: string; tool: string; update: unknown },
  ): void | Promise<void>
  toolFinished?(
    context: RuntimeEventContext,
    input: {
      toolCallID: string
      tool: string
      result: string
      details: unknown
      isError: boolean
      resultBlocks?: ToolResultBlock[]
      artifactInputs?: ToolArtifactInput[]
    },
  ): void | Promise<void>
  queueUpdated?(
    context: RuntimeEventContext,
    input: { steer: number; followUp: number; nextTurn: number },
  ): void | Promise<void>
  queueConsumed?(
    context: RuntimeEventContext,
    input: { delivery: 'steer' | 'follow-up' | 'next-turn'; inputIDs: string[] },
  ): void | Promise<void>
  compacted?(
    context: RuntimeEventContext,
    input: {
      entryID: string
      summary: string
      firstKeptEntryID: string | null
      tokensBefore: number
      beforeCount: number
      trigger: RuntimeCompactionTrigger
      promptText: string
      budget?: ContextBudget
    },
  ): void | Promise<void>
  savePoint?(
    context: RuntimeEventContext,
    input: { hadPendingMutations: boolean },
  ): void | Promise<void>
  settled?(context: RuntimeEventContext, input: { nextTurnCount: number }): void | Promise<void>
  aborted?(context: RuntimeEventContext): void | Promise<void>
}

export interface ProviderToolAdapterOptions {
  executor: ToolExecutor
  request: HarnessRuntimeRequest
  callbacks?: LifecycleCallbacks
}

export interface LifecycleCallbacks {
  skillList?(
    input: Record<string, unknown>,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  skillRead?(
    input: Record<string, unknown>,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  projectSourceList?(
    input: Record<string, unknown>,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  projectSourceRead?(
    input: { sourceId: string; offset?: number; length?: number },
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<{
    source: { id: string; name: string; kind: 'text' | 'image' }
    data: Uint8Array
    mediaType: string
    range: { offset: number; length: number; total: number }
  }>
  requestUserInput?(
    input: RequestUserInput & { question?: string; options?: string[] },
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  requestPermissions?(
    input: Record<string, unknown>,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  updatePlan?(input: ExecutionPlanInput, toolCallID: string, signal?: AbortSignal): Promise<unknown>
  updateGoal?(
    input: { status: 'complete' | 'blocked'; blocker?: string | undefined },
    toolCallID: string,
    signal?: AbortSignal,
    identity?: { goalId: string; revision: number },
  ): Promise<unknown>
  submitPlan?(input: StructuredPlan, toolCallID: string, signal?: AbortSignal): Promise<unknown>
  submitSchedulePlan?(
    input: ScheduleDraftSubmission,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  submitTaskSchedule?(
    input: import('zod').infer<
      typeof import('../../tool/TaskSchedule/Definitions').taskArrangementInput
    >,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  agent?(input: Record<string, unknown>, toolCallID: string, signal?: AbortSignal): Promise<unknown>
  spawnAgents?(
    input: Record<string, unknown>,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  waitAgents?(
    input: Record<string, unknown>,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  sendAgent?(
    input: Record<string, unknown>,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  followupAgent?(
    input: Record<string, unknown>,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  reportAgent?(
    input: Record<string, unknown>,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  listAgents?(
    input: Record<string, unknown>,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  stopAgent?(
    input: Record<string, unknown>,
    toolCallID: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  finalizeResult?(input: SubagentResult, toolCallID: string): Promise<unknown>
}

export interface HarnessRuntimeOptions {
  harnessFactory: HarnessFactory
  toolExecutor: ToolExecutor
  readMediaAttachment?: import('../../provider/runtime/MediaInput').ReadMediaAttachment
  eventSink?: RuntimeEventSink
  activated?(threadID: string, active: ActiveHarness): void
  onRuntimeReady?(): void | Promise<void>
  hasCommittedToolResult?: (toolCallID: string) => boolean
  lifecycle?: LifecycleCallbacks
  beforeToolCall?: (
    request: HarnessRuntimeRequest,
    input: {
      toolCallID: string
      tool: string
      input: Record<string, unknown>
      messageToolCallCount: number
    },
  ) => Promise<{ block?: boolean; reason?: string; pause?: boolean } | undefined>
  compaction?: {
    lifecycle?: ContextCompactionService
    shouldAutoCompact(threadID: string): boolean | Promise<boolean>
    recordFailure(threadID: string, trigger: RuntimeCompactionTrigger): void | Promise<void>
  }
  goalBudget?: GoalBudgetLifecycle
  contextDecisions?: {
    forget?(
      threadID: string,
      items: readonly unknown[],
      signal?: AbortSignal,
    ): Promise<readonly unknown[]>
    compact?(
      threadID: string,
      items: readonly unknown[],
      signal?: AbortSignal,
    ): Promise<readonly unknown[]>
  }
}

export type GoalBudgetStatus = {
  revision?: number
  goal: import('@pidex/shared/thread').ThreadGoal
  tokensUsed: number
  remaining: number | null
  reserve: number
  isConvergence: boolean
}

export type GoalAdmissionDecision =
  | { allowed: true; budgetStatus?: GoalBudgetStatus; wrapup?: boolean; maxTokens?: number }
  | {
      allowed: false
      reason: 'budget_exhausted' | 'estimated_exceeds_budget'
      budgetStatus: GoalBudgetStatus
    }

export type GoalObjectiveRevision = {
  goal: import('@pidex/shared/thread').ThreadGoal
  /** Control generation this objective belongs to. */
  revision: number
  /** Objective revision the model has already consumed. */
  acknowledged: number
  objectiveRevision?: number
}

export type GoalBudgetChange = {
  goalId: string
  revision: number
  budgetRevision: number
  acknowledged: number
  previousBudget: number | null
  budget: number | null
  tokensUsed: number
}

export interface GoalBudgetLifecycle {
  getBudgetStatus(threadID: string): GoalBudgetStatus | null
  budgetChange?(threadID: string): GoalBudgetChange | null
  acknowledgeBudget?(request: HarnessRuntimeRequest, change: GoalBudgetChange): void | Promise<void>
  checkAdmission(
    threadID: string,
    estimatedInputTokens: number,
    profile?: SubagentProfile,
    estimatedOutputTokens?: number,
    wrapupInputTokens?: number,
  ): GoalAdmissionDecision
  handleAdmissionDenied(
    request: HarnessRuntimeRequest,
    decision: Extract<GoalAdmissionDecision, { allowed: false }>,
    estimatedInputTokens: number,
  ): Promise<void>
  /**
   * Pending objective change to inject, or null when the model already consumed
   * the current revision. Read before every model request so an edit made
   * mid-turn reaches the next request.
   */
  pendingObjectiveUpdate?(threadID: string): GoalObjectiveRevision | null
  /** Confirms consumption only after the request succeeded and was accepted. */
  acknowledgeObjective?(
    threadID: string,
    revision: number,
    objectiveRevision: number,
    goalId?: string,
  ): void
  finishWrapup?(threadID: string, status: GoalBudgetStatus): Promise<void>
}

export interface ActiveHarness {
  harness: AgentHarness
  unsubscribe: () => void
  compact(trigger: RuntimeCompactionTrigger, instructions?: string): Promise<CompactResult>
}

export type ExecutionTool = AgentTool<any, unknown>
