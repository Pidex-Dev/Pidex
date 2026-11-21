import { AgentError } from '../Domain'
import type { ComputerUseService } from '../computer/ComputerUseService'
import type { McpConfigService } from '../mcp/McpConfigService'
import type { PluginManagementService } from '../plugin/PluginManagementService'
import type { ToolExecutor } from '../tool/ToolExecutor'
import { NODE_REPL_PLUGIN_ID, NODE_REPL_SERVER_NAME } from './Association'
import { nodeReplResetToolDefinition, nodeReplToolDefinition } from './Definition'
import { NodeReplService, defaultNodeReplServer } from './NodeReplService'

export const createNodeReplBootstrap = (deps: {
  plugins: PluginManagementService
  mcpConfigs: McpConfigService
  computer: ComputerUseService
  getToolExecutor: () => ToolExecutor
}) => {
  const nodeRepl = new NodeReplService((stop) => {
    const unsubscribe = deps.plugins.subscribe((pluginId) => {
      if (pluginId === NODE_REPL_PLUGIN_ID && !deps.plugins.isEnabled(NODE_REPL_PLUGIN_ID)) stop()
    })
    if (!deps.plugins.isEnabled(NODE_REPL_PLUGIN_ID)) stop()
    return unsubscribe
  })

  const nodeReplConfiguration = async (workspace?: string) =>
    (await deps.mcpConfigs.list(workspace)).servers.find(
      (item) => item.effective && item.server.name === NODE_REPL_SERVER_NAME,
    )?.server

  const mcpAdapter = {
    owns: (name: string) => name === NODE_REPL_SERVER_NAME,
    definitions: async (workspace?: string) => {
      const server = await nodeReplConfiguration(workspace)
      if (
        server &&
        (!server.enabled ||
          server.transport.type !== 'stdio' ||
          server.disabledTools?.includes('js') ||
          (server.enabledTools && !server.enabledTools.includes('js')))
      )
        return []
      const validateConfiguration = async () => {
        if (JSON.stringify(await nodeReplConfiguration(workspace)) !== JSON.stringify(server))
          throw new AgentError('MCP_CONFIG_CHANGED', 'node_repl 配置已变化，请开始新一轮任务', 409)
      }
      const shared = {
        plugins: deps.plugins,
        computer: deps.computer,
        service: nodeRepl,
        executor: deps.getToolExecutor(),
        validateConfiguration,
        ...(server ? { server } : {}),
      }
      // `js_reset` 只清空当前聊天的求值上下文，同样受该服务器自己的工具开关约束。
      const resetEnabled =
        !server ||
        (!server.disabledTools?.includes('js_reset') &&
          (!server.enabledTools || server.enabledTools.includes('js_reset')))
      return [
        nodeReplToolDefinition(shared),
        ...(resetEnabled ? [nodeReplResetToolDefinition(shared)] : []),
      ]
    },
  }

  const listStatus = async (workspace?: string) => {
    if (!deps.plugins.isEnabled(NODE_REPL_PLUGIN_ID)) return []
    const server = await nodeReplConfiguration(workspace)
    const connected = deps.computer.available() && server?.enabled !== false
    return [
      {
        name: NODE_REPL_SERVER_NAME,
        scope: server?.scope ?? ('user' as const),
        type: 'stdio' as const,
        state:
          server?.enabled === false
            ? ('disabled' as const)
            : connected
              ? ('connected' as const)
              : ('starting' as const),
        auth: { source: 'none' as const, canLogin: false, canLogout: false },
        toolCount: connected ? 1 : 0,
        resourceCount: 0,
        promptCount: 0,
        onDemand: true,
        managedBy: 'user' as const,
        pluginId: NODE_REPL_PLUGIN_ID,
      },
    ]
  }

  const fallbackServers = () =>
    deps.plugins.isEnabled(NODE_REPL_PLUGIN_ID) ? [defaultNodeReplServer()] : []

  return {
    nodeRepl,
    mcpAdapter,
    listStatus,
    fallbackServers,
  }
}
