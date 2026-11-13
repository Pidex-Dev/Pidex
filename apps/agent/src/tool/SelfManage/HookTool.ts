import { z } from 'zod'
import { AgentError } from '../../Domain'
import { HOOK_EVENTS, type HookDefinition } from '../../hooks/HookDefinitions'
import type { HooksManagement } from '../../hooks/HooksManagementService'
import type { ToolDefinition } from '../ToolRegistry'
import {
  assertSelfManageWritable,
  buildSelfManageInspection,
  SELF_MANAGE_BASE,
  selfManageOperationId,
  toJsonObjectSchema,
} from './Shared'

const hookSchema = z
  .object({
    id: z.string().min(1),
    event: z.enum(HOOK_EVENTS as [typeof HOOK_EVENTS[number], ...typeof HOOK_EVENTS[number][]]),
    command: z.string().min(1),
    matcher: z.string().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    statusMessage: z.string().optional(),
  })
  .strict()

const schema = z
  .object({
    action: z.enum(['list', 'upsert', 'remove', 'set_enabled', 'list_runs']),
    scope: z.enum(['user', 'project']).optional(),
    hook: hookSchema.optional(),
    id: z.string().min(1).optional(),
    identity: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    hookId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict()

type Input = z.infer<typeof schema>

const resolveHookScope = (input: Input): 'user' | 'project' => input.scope ?? 'project'

export const createHookTool = (
  hooksManagement: HooksManagement,
): ToolDefinition<Input, unknown> => ({
  ...SELF_MANAGE_BASE,
  sdkName: 'pidex_hook',
  name: 'pidex.hook',
  description:
    'List, upsert, remove, enable/disable Pidex hooks, or inspect recent hook run logs.',
  schema,
  inputSchema: toJsonObjectSchema(
    {
      action: {
        type: 'string',
        enum: ['list', 'upsert', 'remove', 'set_enabled', 'list_runs'],
      },
      scope: { type: 'string', enum: ['user', 'project'] },
      hook: { type: 'object', additionalProperties: true },
      id: { type: 'string' },
      identity: { type: 'string' },
      enabled: { type: 'boolean' },
      hookId: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string' },
    },
    ['action'],
  ),
  inspectInput: (input, context) => {
    const readOnly = input.action === 'list' || input.action === 'list_runs'
    if (!readOnly) assertSelfManageWritable(context)
    if (readOnly) {
      return buildSelfManageInspection({
        context,
        action: input.action,
        readOnly: true,
        externalWrite: false,
      })
    }
    if (input.action === 'set_enabled') {
      const externalWrite = input.scope === 'user'
      return buildSelfManageInspection({
        context,
        action: input.action,
        readOnly: false,
        externalWrite,
        extraFingerprint: { identity: input.identity ?? null, enabled: input.enabled ?? null },
      })
    }
    const scope = resolveHookScope(input)
    const filePath = hooksManagement.resolveHooksFile(scope, context.workspace.rootPath)
    return buildSelfManageInspection({
      context,
      action: input.action,
      readOnly: false,
      affectedPaths: [filePath],
      externalWrite: scope === 'user',
      extraFingerprint: {
        scope,
        id: input.id ?? input.hook?.id ?? null,
        command: input.hook?.command ?? null,
      },
    })
  },
  execute: async (input, context) => {
    if (input.action === 'list') {
      return hooksManagement.listSources(context.workspace.rootPath)
    }
    if (input.action === 'list_runs') {
      return hooksManagement.listRuns({
        cwd: context.workspace.rootPath,
        ...(input.hookId ? { hookId: input.hookId } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      })
    }
    if (input.action === 'set_enabled') {
      if (!input.identity || typeof input.enabled !== 'boolean') {
        throw new AgentError('INVALID_TOOL_INPUT', 'set_enabled 操作必须提供 identity 和 enabled', 400)
      }
      return hooksManagement.setEnabled({
        identity: input.identity,
        enabled: input.enabled,
        operationId: selfManageOperationId(context),
      })
    }
    const scope = resolveHookScope(input)
    if (input.action === 'upsert') {
      if (!input.hook) throw new AgentError('INVALID_TOOL_INPUT', 'upsert 操作必须提供 hook', 400)
      return hooksManagement.upsertHook({
        scope,
        cwd: context.workspace.rootPath,
        hook: input.hook as HookDefinition,
      })
    }
    if (!input.id) throw new AgentError('INVALID_TOOL_INPUT', 'remove 操作必须提供 id', 400)
    return hooksManagement.removeHook({
      scope,
      cwd: context.workspace.rootPath,
      id: input.id,
    })
  },
})
