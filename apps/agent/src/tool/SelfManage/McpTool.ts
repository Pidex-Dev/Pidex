import { join } from 'node:path'
import type { McpScope, McpServerDeclaration } from '@pidex/agent-protocol'
import { z } from 'zod'
import { AgentError } from '../../Domain'
import type { McpRuntimeService } from '../../mcp/McpRuntimeService'
import type { ToolDefinition } from '../ToolRegistry'
import {
  assertSelfManageWritable,
  buildSelfManageInspection,
  SELF_MANAGE_BASE,
  selfManageOperationId,
  toJsonObjectSchema,
} from './Shared'

const stdioSchema = z
  .object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    envFromHost: z.record(z.string(), z.string()).optional(),
  })
  .strict()

const httpSchema = z
  .object({
    type: z.literal('http'),
    url: z.string().min(1),
    auth: z.enum(['oauth', 'none']).optional(),
    scopes: z.array(z.string()).optional(),
    oauthResource: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    headerFromEnv: z.record(z.string(), z.string()).optional(),
    bearerTokenEnvVar: z.string().min(1).optional(),
  })
  .strict()

const serverSchema = z
  .object({
    name: z.string().min(1),
    scope: z.enum(['user', 'local', 'project']).optional(),
    enabled: z.boolean().default(true),
    transport: z.discriminatedUnion('type', [stdioSchema, httpSchema]),
    diagnosticContext: z.boolean().optional(),
    startupTimeoutMs: z.number().int().min(100).max(600_000).optional(),
    toolTimeoutMs: z.number().int().min(100).max(600_000).optional(),
    required: z.boolean().optional(),
    enabledTools: z.array(z.string()).optional(),
    disabledTools: z.array(z.string()).optional(),
    defaultToolsApprovalMode: z.enum(['auto', 'prompt', 'writes', 'approve']).optional(),
  })
  .strict()

const schema = z
  .object({
    action: z.enum(['list', 'status', 'save', 'remove', 'set_enabled', 'reload']),
    scope: z.enum(['user', 'local', 'project']).optional(),
    name: z.string().min(1).optional(),
    originalName: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    server: serverSchema.optional(),
  })
  .strict()

type Input = z.infer<typeof schema>

const normalizeMcpScope = (scope?: 'user' | 'local' | 'project'): McpScope =>
  scope === 'user' ? 'user' : 'local'

export const createMcpTool = (mcp: McpRuntimeService): ToolDefinition<Input, unknown> => ({
  ...SELF_MANAGE_BASE,
  sdkName: 'pidex_mcp',
  name: 'pidex.mcp',
  description:
    'List, check status, save, remove, enable/disable, or reload MCP servers for Pidex.',
  schema,
  inputSchema: toJsonObjectSchema(
    {
      action: {
        type: 'string',
        enum: ['list', 'status', 'save', 'remove', 'set_enabled', 'reload'],
      },
      scope: { type: 'string', enum: ['user', 'local', 'project'] },
      name: { type: 'string' },
      originalName: { type: 'string' },
      enabled: { type: 'boolean' },
      server: { type: 'object', additionalProperties: true },
    },
    ['action'],
  ),
  inspectInput: (input, context) => {
    const readOnly = input.action === 'list' || input.action === 'status'
    if (!readOnly) assertSelfManageWritable(context)
    if (readOnly) {
      return buildSelfManageInspection({
        context,
        action: input.action,
        readOnly: true,
        externalWrite: false,
      })
    }
    if (input.action === 'reload') {
      return buildSelfManageInspection({
        context,
        action: input.action,
        readOnly: false,
        externalWrite: false,
      })
    }
    const scope = normalizeMcpScope(input.server?.scope ?? input.scope)
    const externalWrite = scope === 'user'
    const affectedPaths =
      scope === 'local' ? [join(context.workspace.rootPath, '.pidex', 'config.json')] : []
    return buildSelfManageInspection({
      context,
      action: input.action,
      readOnly: false,
      affectedPaths,
      externalWrite,
      extraFingerprint: {
        scope,
        name: input.name ?? input.server?.name ?? null,
        enabled: input.enabled ?? input.server?.enabled ?? null,
      },
    })
  },
  execute: async (input, context) => {
    if (input.action === 'list') {
      return mcp.list({ workspace: context.workspace.rootPath })
    }
    if (input.action === 'status') {
      return mcp.status({ workspace: context.workspace.rootPath })
    }
    if (input.action === 'reload') {
      return mcp.reload({
        workspace: context.workspace.rootPath,
        operationId: selfManageOperationId(context),
      })
    }
    if (input.action === 'save') {
      if (!input.server) throw new AgentError('INVALID_TOOL_INPUT', 'save 操作必须提供 server', 400)
      const scope = normalizeMcpScope(input.server.scope ?? input.scope)
      const declaration: McpServerDeclaration = {
        ...input.server,
        scope,
      } as McpServerDeclaration
      const saved = await mcp.save({
        workspace: context.workspace.rootPath,
        ...(input.originalName ? { originalName: input.originalName } : {}),
        server: declaration,
        operationId: selfManageOperationId(context, 'save'),
      })
      const reloaded = await mcp.reload({
        workspace: context.workspace.rootPath,
        operationId: selfManageOperationId(context, 'reload'),
      })
      return {
        ...saved,
        reloaded,
        note: 'MCP 配置已保存并重载连接；新增或变更的 MCP 工具将在下一轮对话中可用。',
      }
    }
    const scope = normalizeMcpScope(input.scope)
    if (!input.name) throw new AgentError('INVALID_TOOL_INPUT', `${input.action} 操作必须提供 name`, 400)
    if (input.action === 'remove') {
      const removed = await mcp.remove({
        workspace: context.workspace.rootPath,
        scope,
        name: input.name,
        operationId: selfManageOperationId(context, 'remove'),
      })
      const reloaded = await mcp.reload({
        workspace: context.workspace.rootPath,
        operationId: selfManageOperationId(context, 'reload'),
      })
      return { ...removed, reloaded }
    }
    if (typeof input.enabled !== 'boolean') {
      throw new AgentError('INVALID_TOOL_INPUT', 'set_enabled 操作必须提供 enabled', 400)
    }
    const updated = await mcp.setEnabled({
      workspace: context.workspace.rootPath,
      scope,
      name: input.name,
      enabled: input.enabled,
      operationId: selfManageOperationId(context, 'toggle'),
    })
    const reloaded = await mcp.reload({
      workspace: context.workspace.rootPath,
      operationId: selfManageOperationId(context, 'reload'),
    })
    return { ...updated, reloaded }
  },
})
