import { z } from 'zod'
import { AgentError } from '../../Domain'
import type { SkillManagementService } from '../../prompt/SkillManagementService'
import type { ToolContext, ToolDefinition } from '../ToolRegistry'
import {
  assertSelfManageWritable,
  buildSelfManageInspection,
  isPathInsideWorkspace,
  SELF_MANAGE_BASE,
  selfManageOperationId,
  toJsonObjectSchema,
} from './Shared'

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), path: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('git'),
      url: z.string().min(1),
      ref: z.string().min(1).optional(),
      subpath: z.string().min(1).optional(),
    })
    .strict(),
])

const schema = z
  .object({
    action: z.enum(['list', 'read', 'create', 'install', 'set_enabled', 'remove']),
    scope: z.enum(['user', 'project']).optional(),
    path: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    body: z.string().optional(),
    content: z.string().optional(),
    source: sourceSchema.optional(),
    enabled: z.boolean().optional(),
    overwrite: z.boolean().optional(),
  })
  .strict()

type Input = z.infer<typeof schema>

const resolveSkillScope = (input: Input): 'user' | 'project' => input.scope ?? 'project'

export const createSkillTool = (
  skillManagement: SkillManagementService,
): ToolDefinition<Input, unknown> => ({
  ...SELF_MANAGE_BASE,
  sdkName: 'pidex_skill',
  name: 'pidex.skill',
  description:
    'List, read, create, install (local or git), enable/disable, or remove Pidex skills.',
  schema,
  inputSchema: toJsonObjectSchema(
    {
      action: {
        type: 'string',
        enum: ['list', 'read', 'create', 'install', 'set_enabled', 'remove'],
      },
      scope: { type: 'string', enum: ['user', 'project'] },
      path: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      body: { type: 'string' },
      content: { type: 'string' },
      source: {
        type: 'object',
        additionalProperties: true,
      },
      enabled: { type: 'boolean' },
      overwrite: { type: 'boolean' },
    },
    ['action'],
  ),
  inspectInput: (input, context) => {
    const readOnly = input.action === 'list' || input.action === 'read'
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
      const targetPath = input.path ?? ''
      const inside = targetPath ? isPathInsideWorkspace(context, targetPath) : false
      return buildSelfManageInspection({
        context,
        action: input.action,
        readOnly: false,
        ...(targetPath ? { affectedPaths: [targetPath] } : {}),
        externalWrite: !inside,
        extraFingerprint: { path: targetPath, enabled: input.enabled },
      })
    }

    const scope = resolveSkillScope(input)
    const target =
      input.name && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(input.name.trim())
        ? skillManagement.resolveSkillTargetDir(scope, input.name.trim(), context.workspace.rootPath)
        : null
    const externalWrite = scope === 'user'
    const networkAccess = input.action === 'install' && input.source?.kind === 'git'

    return buildSelfManageInspection({
      context,
      action: input.action,
      readOnly: false,
      ...(target ? { affectedPaths: [target.dir] } : {}),
      externalWrite,
      networkAccess,
      extraFingerprint: {
        scope,
        name: input.name ?? null,
        source: input.source ?? null,
      },
    })
  },
  execute: async (input, context) => {
    if (input.action === 'list') {
      return skillManagement.list({ workspace: context.workspace.rootPath, forceReload: true })
    }
    if (input.action === 'read') {
      if (!input.path) throw new AgentError('INVALID_TOOL_INPUT', 'read 操作必须提供 path', 400)
      return skillManagement.read({
        workspace: context.workspace.rootPath,
        path: input.path,
      })
    }
    if (input.action === 'set_enabled') {
      if (!input.path || typeof input.enabled !== 'boolean') {
        throw new AgentError('INVALID_TOOL_INPUT', 'set_enabled 操作必须提供 path 和 enabled', 400)
      }
      await skillManagement.list({ workspace: context.workspace.rootPath, forceReload: true })
      return skillManagement.setEnabled({
        path: input.path,
        enabled: input.enabled,
        operationId: selfManageOperationId(context),
      })
    }
    const scope = resolveSkillScope(input)
    if (input.action === 'create') {
      if (!input.name) throw new AgentError('INVALID_TOOL_INPUT', 'create 操作必须提供 name', 400)
      return skillManagement.saveSkill({
        scope,
        workspace: context.workspace.rootPath,
        name: input.name,
        description: input.description,
        body: input.body,
        content: input.content,
        overwrite: input.overwrite,
      })
    }
    if (input.action === 'install') {
      if (!input.source) throw new AgentError('INVALID_TOOL_INPUT', 'install 操作必须提供 source', 400)
      return skillManagement.installSkill({
        scope,
        workspace: context.workspace.rootPath,
        source: input.source,
        name: input.name,
        overwrite: input.overwrite,
      })
    }
    if (!input.name) throw new AgentError('INVALID_TOOL_INPUT', 'remove 操作必须提供 name', 400)
    return skillManagement.removeSkill({
      scope,
      workspace: context.workspace.rootPath,
      name: input.name,
    })
  },
})
