import { z } from 'zod'
import { AgentError } from '../../Domain'
import type { PluginManagementService } from '../../plugin/PluginManagementService'
import type { ToolDefinition } from '../ToolRegistry'
import {
  assertSelfManageWritable,
  buildSelfManageInspection,
  SELF_MANAGE_BASE,
  selfManageOperationId,
  toJsonObjectSchema,
} from './Shared'

const schema = z
  .object({
    action: z.enum(['list', 'details', 'install', 'uninstall', 'set_enabled']),
    pluginId: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    includeMarketplace: z.boolean().optional(),
    forceReload: z.boolean().optional(),
    expectedCatalogRevision: z.string().min(1).optional(),
  })
  .strict()

type Input = z.infer<typeof schema>

export const createPluginTool = (
  plugins: PluginManagementService,
): ToolDefinition<Input, unknown> => ({
  ...SELF_MANAGE_BASE,
  sdkName: 'pidex_plugin',
  name: 'pidex.plugin',
  description:
    'List local/marketplace plugins, inspect details, install, uninstall, or enable/disable Pidex plugins.',
  schema,
  inputSchema: toJsonObjectSchema(
    {
      action: {
        type: 'string',
        enum: ['list', 'details', 'install', 'uninstall', 'set_enabled'],
      },
      pluginId: { type: 'string' },
      enabled: { type: 'boolean' },
      includeMarketplace: { type: 'boolean' },
      forceReload: { type: 'boolean' },
      expectedCatalogRevision: { type: 'string' },
    },
    ['action'],
  ),
  inspectInput: (input, context) => {
    const readOnly = input.action === 'list' || input.action === 'details'
    if (!readOnly) assertSelfManageWritable(context)
    if (readOnly) {
      return buildSelfManageInspection({
        context,
        action: input.action,
        readOnly: true,
        externalWrite: false,
      })
    }
    return buildSelfManageInspection({
      context,
      action: input.action,
      readOnly: false,
      externalWrite: true,
      networkAccess: input.action === 'install',
      extraFingerprint: {
        pluginId: input.pluginId ?? null,
        enabled: input.enabled ?? null,
      },
    })
  },
  execute: async (input, context) => {
    if (input.action === 'list') {
      return input.includeMarketplace === false
        ? plugins.listLocal(context.workspace.rootPath, false)
        : plugins.list({
            workspace: context.workspace.rootPath,
            forceReload: input.forceReload,
          })
    }
    if (!input.pluginId) {
      throw new AgentError('INVALID_TOOL_INPUT', `${input.action} 操作必须提供 pluginId`, 400)
    }
    if (input.action === 'details') {
      return plugins.getDetails({
        pluginId: input.pluginId,
        workspace: context.workspace.rootPath,
      })
    }
    if (input.action === 'install') {
      const installed = await plugins.install({
        pluginId: input.pluginId,
        operationId: selfManageOperationId(context),
        ...(input.expectedCatalogRevision
          ? { expectedCatalogRevision: input.expectedCatalogRevision }
          : {}),
      })
      return {
        ...installed,
        note: '插件已安装；其贡献的新工具或能力将在下一轮对话中注入上下文。',
      }
    }
    if (input.action === 'uninstall') {
      return plugins.uninstall({
        pluginId: input.pluginId,
        operationId: selfManageOperationId(context),
      })
    }
    if (typeof input.enabled !== 'boolean') {
      throw new AgentError('INVALID_TOOL_INPUT', 'set_enabled 操作必须提供 enabled', 400)
    }
    const updated = await plugins.setEnabled({
      pluginId: input.pluginId,
      enabled: input.enabled,
      operationId: selfManageOperationId(context),
    })
    return {
      ...updated,
      note: '插件状态已更新；如果启用了提供新 MCP 工具的插件，新工具将在下一轮对话中可用。',
    }
  },
})
