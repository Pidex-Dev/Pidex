import { z } from 'zod'
import { AgentError } from '../../Domain'
import type { ToolDefinition } from '../ToolRegistry'

const taskMessageSchema = z
  .object({ taskID: z.string().trim().min(1), message: z.string().trim().min(1) })
  .strict()
const taskSchema = z.object({ taskID: z.string().trim().min(1) }).strict()

export const spawnAgentsInputSchema = z
  .object({
    agents: z
      .array(
        z
          .object({
            name: z.string().optional(),
            profile: z.enum(['default', 'explorer', 'worker']),
            task: z.string().trim().min(1),
            // 仅用于视觉职能标识；不授予权限，也不改变 profile、模型、工具或工作区策略。
            role: z
              .enum([
                'frontend',
                'backend',
                'devops',
                'qa',
                'designer',
                'data',
                'docs',
                'product',
                'general',
              ])
              .optional(),
            workspaceMode: z.enum(['shared', 'worktree']).optional(),
            // 可选、稳定的命名记忆身份；仅限当前项目，宿主统一小写并校验格式。
            memoryKey: z.string().min(1).max(64).optional(),
            model: z
              .object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict()

export const waitAgentsInputSchema = z
  .object({
    runIDs: z.array(z.string().min(1)).min(1),
    mode: z.enum(['all', 'any']).default('all'),
  })
  .strict()

export const sendAgentInputSchema = taskMessageSchema
export const stopAgentInputSchema = taskSchema
export const followupAgentInputSchema = taskMessageSchema
export const reportAgentInputSchema = z.object({ message: z.string().trim().min(1) }).strict()
export const listAgentsInputSchema = z.object({}).strict()

const schemas = {
  spawn_agents: spawnAgentsInputSchema,
  wait_agents: waitAgentsInputSchema,
  send_agent: sendAgentInputSchema,
  stop_agent: stopAgentInputSchema,
  followup_agent: followupAgentInputSchema,
  report_agent: reportAgentInputSchema,
  list_agents: listAgentsInputSchema,
}

export const delegationToolDefinitions: ToolDefinition[] = Object.entries(schemas).map(
  ([name, schema]) => ({
    sdkName: name,
    name,
    schema,
    prepareArguments: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('taskId' in raw)) return raw
      const { taskId, ...rest } = raw as Record<string, unknown>
      return { ...rest, taskID: rest.taskID ?? taskId }
    },
    inputSchema: z.toJSONSchema(schema),
    description: `Subagent collaboration: ${name}. Only direct parent-child relationships are allowed; never expand permissions.`,
    capabilities: {
      filesystem: 'none',
      network: 'none',
      process: false,
      externalState: false,
      userInteraction: false,
    },
    allowedModes: ['chat', 'plan'],
    allowedProfiles:
      name === 'report_agent'
        ? ['default', 'explorer', 'worker']
        : ['main', 'default', 'explorer', 'worker'],
    approvalStrategy: 'never-review',
    visibility: 'internal',
    executionMode: 'sequential',
    execute: async (input, context) => {
      if (!context.subagentLifecycle)
        throw new AgentError('TOOL_NOT_AVAILABLE', '当前执行没有子 Agent 协作入口', 409)
      return context.subagentLifecycle(name, input as Record<string, unknown>)
    },
  }),
)

export const subagentToolDefinitions = delegationToolDefinitions
