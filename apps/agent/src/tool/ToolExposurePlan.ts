import type { SubagentProfile, TaskMode } from '../Domain'
import { MAX_SUBAGENT_DEPTH, isReadOnlyTaskMode, type SandboxMode } from '@pidex/shared/thread'
import { type PermissionConfig } from '@pidex/shared/thread'
import type { ToolCatalog } from './ToolRegistry'
import { filterPoisonedTools } from '../decision/integrations/ToolDescriptionScreen'

export const LIFECYCLE_TOOLS = [
  // These Skill names remain bindable only for already persisted turn snapshots.
  'skill_list',
  'skill_read',
  'project_source_list',
  'project_source_read',
  'request_user_input',
  'request_permissions',
  'update_plan',
  'submit_plan',
  'submit_schedule_plan',
  'submit_task_schedule',
  'Agent',
  'spawn_agents',
  'wait_agents',
  'send_agent',
  'followup_agent',
  'report_agent',
  'list_agents',
  'stop_agent',
  'finalize_result',
  'update_goal',
] as const

export interface ToolExposureInput {
  taskMode: TaskMode
  sandboxMode: SandboxMode
  /**
   * Approval policy of the effective permission config. It decides whether the
   * model may even ask for temporary permissions, so exposure and execution
   * share one answer instead of advertising a tool every call would deny.
   */
  approvalPolicy: PermissionConfig['approvalPolicy']
  profile?: SubagentProfile
  hasSkillService?: boolean
  hasProjectSources?: boolean
  defaultModeRequestUserInput?: boolean
  delegationEnabled?: boolean
  collaborationEnabled?: boolean
  depth?: number
  allowedTools?: readonly string[]
  activeDeferredTools?: readonly string[]
  hasActiveGoal?: boolean
  /** 任务规划扩展表可用时，Plan 主 Agent 可以提交「任务计划 + 执行安排」草案。 */
  hasScheduleDrafts?: boolean
  hasTaskSchedules?: boolean
}

/**
 * `request_permissions` can only ever be answered when the policy permits
 * approvals: `never` forbids waiting.
 */
export const approvalAllowsPermissionRequests = (policy: PermissionConfig['approvalPolicy']) =>
  policy !== 'never'

export interface ToolExposurePlan {
  eager: readonly string[]
  deferred: readonly string[]
  exposed: readonly string[]
  allows(name: string): boolean
}

/** Single source of truth for prompt composition and runtime tool exposure. */
export function createToolExposurePlan(
  catalog: ToolCatalog,
  input: ToolExposureInput,
): ToolExposurePlan {
  const profile = input.profile ?? 'main'
  // Collaboration modes gate tools, not the user's file-access scope. Passing
  // the stored sandbox mode through keeps exposure, preview and execution on
  // the same policy; mutating tools are filtered by the mode rule instead.
  // SAFETY: 描述投毒命中的工具从暴露集剔除；无缓存结论时该过滤为空操作，行为与现状一致。
  const definitions = filterPoisonedTools(catalog.list(input.taskMode, input.sandboxMode, profile))
  const eager = definitions
    .filter((tool) => tool.visibility === 'eager')
    .map((tool) => tool.sdkName)
  const canDelegate =
    input.delegationEnabled !== false &&
    (input.collaborationEnabled !== false || profile === 'main')
  const canCollaborate = canDelegate && input.collaborationEnabled !== false
  const deferredControlAllowed = (name: string) => {
    if (name === 'send_agent' || name === 'stop_agent') return canDelegate
    if (name === 'followup_agent' || name === 'list_agents') return canCollaborate
    return true
  }
  const deferredCandidates = definitions
    .filter((tool) => tool.visibility === 'deferred' && deferredControlAllowed(tool.sdkName))
    .map((tool) => tool.sdkName)
  const lifecycle: string[] = []
  if (input.hasSkillService) lifecycle.push('skill_read')
  if (input.hasProjectSources) lifecycle.push('project_source_list', 'project_source_read')
  if (profile === 'main') {
    if (isReadOnlyTaskMode(input.taskMode) || input.defaultModeRequestUserInput)
      lifecycle.push('request_user_input')
    // Plan 主 Agent 以结构化 submit_plan 交付最终方案；<proposed_plan> 仅作兼容回退。
    if (input.taskMode === 'plan') lifecycle.push('submit_plan')
    // 需要按时间或上游事件安排的请求改用 submit_schedule_plan；两者都是独占单次调用。
    if (input.taskMode === 'plan' && input.hasScheduleDrafts) lifecycle.push('submit_schedule_plan')
    if (input.taskMode === 'plan' && input.hasTaskSchedules) lifecycle.push('submit_task_schedule')
    if (input.taskMode === 'chat') {
      // Chat 主 Agent 以普通文本收尾；Plan 的最终方案由 submit_plan 负责。
      // 权限申请工具只在审批策略真的能应答时暴露。
      if (approvalAllowsPermissionRequests(input.approvalPolicy))
        lifecycle.push('request_permissions')
      lifecycle.push('update_plan')
      if (input.hasActiveGoal) lifecycle.push('update_goal')
    }
  }

  if (canDelegate) {
    if (
      (profile === 'main' || profile === 'default') &&
      (input.depth ?? (profile === 'main' ? 0 : 1)) < MAX_SUBAGENT_DEPTH
    )
      lifecycle.push('Agent')
    if (profile !== 'main' && input.collaborationEnabled !== false) lifecycle.push('report_agent')
  }
  const allowlist = input.allowedTools ? new Set(input.allowedTools) : null
  const deferred = deferredCandidates.filter((name) => !allowlist || allowlist.has(name))
  const activeDeferred = new Set(input.activeDeferredTools ?? [])
  const contextuallyActiveDeferred = deferredCandidates.filter(
    (name) => activeDeferred.has(name) && (!allowlist || allowlist.has(name)),
  )
  const explicitlyAllowedDeferred = allowlist
    ? deferredCandidates.filter((name) => allowlist.has(name))
    : []
  const exposed = [
    ...new Set([
      ...eager,
      ...contextuallyActiveDeferred,
      ...explicitlyAllowedDeferred,
      ...lifecycle,
    ]),
  ].filter((name) => !allowlist || allowlist.has(name))
  const exposedSet = new Set(exposed)
  return {
    eager: eager.filter((name) => exposedSet.has(name)),
    deferred,
    exposed,
    allows: (name) => exposedSet.has(name),
  }
}
