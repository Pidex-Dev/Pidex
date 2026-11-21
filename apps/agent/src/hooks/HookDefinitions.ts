export type HookEvent =
  | 'session_start'
  | 'session_resume'
  | 'user_prompt_submit'
  | 'pre_tool_use'
  | 'permission_request'
  | 'post_tool_use'
  | 'post_tool_error'
  | 'pre_compact'
  | 'stop'
  | 'subagent_start'
  | 'subagent_stop'

export type HookDefinition = {
  id: string
  event: HookEvent
  command: string
  matcher?: string
  timeoutMs?: number
  statusMessage?: string
  pluginId?: string
  pluginRoot?: string
}

export type HookDecision = 'continue' | 'ask' | 'deny'

export type HookResult = {
  decision: HookDecision
  reason?: string
  suggestions?: string[]
  narrowedInput?: Record<string, unknown>
  additionalContext?: string
}

export type HookDiagnostic = {
  severity: 'warning' | 'error'
  code: string
  message: string
}

export const HOOK_EVENTS: readonly HookEvent[] = [
  'session_start',
  'session_resume',
  'user_prompt_submit',
  'pre_tool_use',
  'permission_request',
  'post_tool_use',
  'post_tool_error',
  'pre_compact',
  'stop',
  'subagent_start',
  'subagent_stop',
]

const EVENTS = new Set<HookEvent>(HOOK_EVENTS)

/** Host-side ceiling for any single Hook configuration document. */
export const MAX_HOOK_CONFIG_BYTES = 256 * 1024
export const MAX_HOOK_TIMEOUT_MS = 60_000

/**
 * Invalid Hook configuration. `code` stays in the union declared by the
 * `hook/*` RPC methods so the transport can expose the message safely.
 */
export class HookConfigError extends Error {
  constructor(
    readonly code:
      | 'HOOK_INVALID'
      | 'HOOK_DUPLICATE_ID'
      | 'HOOK_SOURCE_INVALID'
      | 'CONFLICT'
      | 'CONFIG_VERSION_CONFLICT'
      | 'CONFIG_PROJECT_UNTRUSTED',
    message: string,
  ) {
    super(message)
    this.name = 'HookConfigError'
  }
}

export const parseHookDefinition = (value: unknown, label: string): HookDefinition => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HookConfigError('HOOK_INVALID', `${label} 无效`)
  const hook = value as Record<string, unknown>
  if (typeof hook.id !== 'string' || !hook.id.trim())
    throw new HookConfigError('HOOK_INVALID', `${label} 缺少 id`)
  if (typeof hook.event !== 'string' || !EVENTS.has(hook.event as HookEvent))
    throw new HookConfigError('HOOK_INVALID', `Hook ${hook.id} event 无效`)
  if (typeof hook.command !== 'string' || !hook.command.trim())
    throw new HookConfigError('HOOK_INVALID', `Hook ${hook.id} 缺少 command`)
  if (
    hook.timeoutMs !== undefined &&
    (typeof hook.timeoutMs !== 'number' ||
      !Number.isFinite(hook.timeoutMs) ||
      hook.timeoutMs <= 0 ||
      hook.timeoutMs > MAX_HOOK_TIMEOUT_MS)
  )
    throw new HookConfigError(
      'HOOK_INVALID',
      `Hook ${hook.id} timeoutMs 必须在 1..${MAX_HOOK_TIMEOUT_MS}`,
    )
  if (hook.matcher !== undefined && typeof hook.matcher !== 'string')
    throw new HookConfigError('HOOK_INVALID', `Hook ${hook.id} matcher 无效`)
  if (hook.statusMessage !== undefined && typeof hook.statusMessage !== 'string')
    throw new HookConfigError('HOOK_INVALID', `Hook ${hook.id} statusMessage 无效`)
  return {
    id: hook.id,
    event: hook.event as HookEvent,
    command: hook.command,
    ...(typeof hook.matcher === 'string' ? { matcher: hook.matcher } : {}),
    ...(typeof hook.timeoutMs === 'number' ? { timeoutMs: hook.timeoutMs } : {}),
    ...(typeof hook.statusMessage === 'string' && hook.statusMessage.trim()
      ? { statusMessage: hook.statusMessage.trim() }
      : {}),
  }
}

export const parseHookDefinitions = (hooks: unknown, source: string): HookDefinition[] => {
  if (!Array.isArray(hooks))
    throw new HookConfigError('HOOK_INVALID', `Hook 配置必须包含 hooks 数组: ${source}`)
  return hooks.map((value, index) => parseHookDefinition(value, `Hook #${index + 1}`))
}

/** Duplicate ids in one source are ambiguous for edit/delete, never merged. */
export const duplicateHookIds = (hooks: readonly HookDefinition[]): string[] => {
  const counts = new Map<string, number>()
  for (const hook of hooks) counts.set(hook.id, (counts.get(hook.id) ?? 0) + 1)
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id)
}
