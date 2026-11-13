import type { DiscoveredHook, HookEventName, HookSourceGroup } from '@pidex/agent-protocol'

export const HOOK_EVENT_META: Record<
  HookEventName,
  { title: string; subtitle: string }
> = {
  session_start: { title: 'SessionStart', subtitle: '当新会话开始时' },
  session_resume: { title: 'SessionResume', subtitle: '当恢复已有会话时' },
  user_prompt_submit: { title: 'UserPromptSubmit', subtitle: '当用户提交提示时' },
  subagent_start: { title: '子智能体启动', subtitle: '子智能体启动时' },
  subagent_stop: { title: '子智能体结束', subtitle: '子智能体结束时' },
  pre_tool_use: { title: 'PreToolUse', subtitle: '每次工具调用前' },
  permission_request: { title: 'PermissionRequest', subtitle: '需要审批权限时' },
  post_tool_use: { title: 'PostToolUse', subtitle: '工具调用成功后' },
  post_tool_error: { title: 'PostToolUseFailure', subtitle: '工具调用失败后' },
  pre_compact: { title: 'PreCompact', subtitle: '上下文压缩前' },
  stop: { title: 'Stop', subtitle: '轮次完成时' },
}

export const HOOK_EVENT_ORDER: readonly HookEventName[] = [
  'session_start',
  'session_resume',
  'user_prompt_submit',
  'subagent_start',
  'subagent_stop',
  'pre_tool_use',
  'permission_request',
  'post_tool_use',
  'post_tool_error',
  'pre_compact',
  'stop',
]

export type HookEventSection = {
  event: HookEventName
  title: string
  subtitle: string
  items: Array<{
    hook: DiscoveredHook
    displayLabel: string
  }>
}

export function splitHookGroups(groups: readonly HookSourceGroup[]): {
  configGroups: HookSourceGroup[]
  pluginGroups: HookSourceGroup[]
} {
  const configGroups: HookSourceGroup[] = []
  const pluginGroups: HookSourceGroup[] = []
  for (const group of groups) {
    if (group.kind === 'plugin') pluginGroups.push(group)
    else configGroups.push(group)
  }
  return { configGroups, pluginGroups }
}

export function groupHooksByEvent(hooks: readonly DiscoveredHook[]): HookEventSection[] {
  const byEvent = new Map<HookEventName, DiscoveredHook[]>()
  for (const hook of hooks) {
    const bucket = byEvent.get(hook.event)
    if (bucket) bucket.push(hook)
    else byEvent.set(hook.event, [hook])
  }
  const sections: HookEventSection[] = []
  for (const event of HOOK_EVENT_ORDER) {
    const list = byEvent.get(event)
    if (!list || list.length === 0) continue
    const meta = HOOK_EVENT_META[event]
    sections.push({
      event,
      title: meta.title,
      subtitle: meta.subtitle,
      items: list.map((hook, index) => ({
        hook,
        displayLabel: `${index + 1} - ${hook.statusMessage || hook.command}`,
      })),
    })
  }
  return sections
}

export function hookCountLabel(count: number): string {
  return `${count} 个钩子`
}

export type HookErrorCode =
  | 'HOOK_SOURCE_INVALID'
  | 'HOOK_INVALID'
  | 'CONFLICT'
  | 'PATH_DENIED'
  | 'CURSOR_EXPIRED'
  | 'INTERNAL_ERROR'

const HOOK_ERROR_CODES = new Set<string>([
  'HOOK_SOURCE_INVALID',
  'HOOK_INVALID',
  'CONFLICT',
  'PATH_DENIED',
  'CURSOR_EXPIRED',
  'INTERNAL_ERROR',
])

export function hookErrorCodeOf(error: unknown): HookErrorCode | null {
  if (!error || typeof error !== 'object') return null
  const value = error as { code?: unknown; errorCode?: unknown; data?: { code?: unknown } }
  const code =
    typeof value.errorCode === 'string'
      ? value.errorCode
      : typeof value.code === 'string'
        ? value.code
        : typeof value.data?.code === 'string'
          ? value.data.code
          : null
  return code && HOOK_ERROR_CODES.has(code) ? (code as HookErrorCode) : null
}

export function hookErrorMessage(error: unknown, fallback = '操作失败，请稍后重试。'): string {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : ''
  switch (hookErrorCodeOf(error)) {
    case 'CONFLICT':
      return 'Hook 状态请求冲突，请刷新后重试。'
    case 'HOOK_INVALID':
      return message || 'Hook 配置无效。'
    case 'HOOK_SOURCE_INVALID':
      return message || 'Hook 来源不可用。'
    default:
      return message || fallback
  }
}

export function isWorkspaceScopeError(error: unknown): boolean {
  if (hookErrorCodeOf(error) !== 'HOOK_SOURCE_INVALID') return false
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : ''
  return message.includes('工作区') || message.includes('项目')
}
