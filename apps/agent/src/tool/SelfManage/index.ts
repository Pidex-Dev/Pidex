import type { ConfigService } from '../../config/ConfigService'
import type { HooksManagement } from '../../hooks/HooksManagementService'
import type { McpRuntimeService } from '../../mcp/McpRuntimeService'
import type { PluginManagementService } from '../../plugin/PluginManagementService'
import type { SkillManagementService } from '../../prompt/SkillManagementService'
import type { ToolDefinition } from '../ToolRegistry'
import { createConfigTool } from './ConfigTool'
import { createHookTool } from './HookTool'
import { createMcpTool } from './McpTool'
import { createPluginTool } from './PluginTool'
import { createSkillTool } from './SkillTool'

export interface SelfManageToolDeps {
  configService: ConfigService
  skillManagement: SkillManagementService
  hooksManagement: HooksManagement
  mcp: McpRuntimeService
  plugins: PluginManagementService
}

export const createSelfManageTools = (
  deps: SelfManageToolDeps,
): readonly ToolDefinition<any, any>[] => [
  createConfigTool(deps.configService),
  createSkillTool(deps.skillManagement),
  createHookTool(deps.hooksManagement),
  createMcpTool(deps.mcp),
  createPluginTool(deps.plugins),
]
