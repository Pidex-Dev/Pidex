import { z } from 'zod'
import { AgentError } from '../../Domain'
import type { ToolDefinition } from '../ToolRegistry'

const taskMessageSchema = z
  .object({ taskID: z.string().trim().min(1), message: z.string().trim().min(1) })
  .strict()
const taskSchema = z.object({ taskID: z.string().trim().min(1) }).strict()

export const SUBAGENT_ROLE_VALUES = [
  'frontend',
  'backend',
  'devops',
  'qa',
  'designer',
  'data',
  'docs',
  'product',
  'general',
] as const

export const AGENT_TOOL_DESCRIPTION = [
  'Launch a specialized subagent (or implicit conversation fork) to handle exploration, parallel investigation, or bounded multi-step tasks while keeping intermediate tool output out of your context.',
  '',
  'Available `subagent_type` values:',
  '- `explorer`: Fast read-only codebase specialist with exclusive access to `Glob` and `Grep` (plus `Read` and read-only `exec_command`). Use for searching across directories/repositories, locating implementations, or answering codebase questions without polluting main context.',
  '- `worker`: Single-level implementation subagent for bounded edits and verification within an explicit scope.',
  '- `default`: General-purpose fresh subagent.',
  '- Omit `subagent_type` (Chat mode only): Implicitly forks your current conversation context (sharing prompt cache) and runs asynchronously in the background; you will be notified when it completes. In Plan/Grill modes, omitting `subagent_type` defaults to `explorer`.',
  '',
  '## When to use',
  '- Reach for `Agent(subagent_type="explorer")` when answering requires searching across multiple directories/repositories, tracing unfamiliar code paths, or running broad `Glob`/`Grep` scans — delegate it so you keep the findings instead of raw search dumps.',
  '- Launch multiple `Agent` calls in parallel in a single response when investigating independent targets (e.g., comparing two directories or subsystems).',
  '- Once you delegate a search, wait for the result instead of duplicating the same search locally. For a single known file path, use `Read` directly.',
  '- Set `run_in_background: true` only when you want to continue non-overlapping local work immediately and be notified upon completion; otherwise omit it so results return directly.',
].join('\n')

export const agentInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe('A short (3-5 word) task title shown in the UI alongside the agent name.'),
    prompt: z
      .string()
      .trim()
      .min(1)
      .describe('Self-contained task instructions, scope, and expected evidence for the subagent.'),
    subagent_type: z
      .enum(['default', 'explorer', 'worker'])
      .optional()
      .describe(
        'Specialized subagent profile ("explorer", "worker", "default"). Omit in Chat mode to fork current context asynchronously; in Plan/Grill defaults to "explorer".',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Run asynchronously and receive completion notification instead of waiting.'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Optional agent name (e.g. "CodeScout", "Patcher"). If omitted, the host assigns a clean type/role name such as "General Purpose" or "Explorer".',
      ),
    role: z
      .enum(SUBAGENT_ROLE_VALUES)
      .optional()
      .describe('Optional visual avatar label only; grants no extra permissions.'),
    memoryKey: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Optional stable per-project named-memory key for non-explorer subagents.'),
  })
  .strict()

export const spawnAgentsInputSchema = z
  .object({
    agents: z
      .array(
        z
          .object({
            name: z
              .string()
              .trim()
              .min(1)
              .max(64)
              .optional()
              .describe('Optional agent name; if omitted, the host assigns a type/role name.'),
            title: z
              .string()
              .trim()
              .min(1)
              .max(120)
              .optional()
              .describe('Optional short (3-5 word) task title shown in the UI.'),
            profile: z.enum(['default', 'explorer', 'worker']),
            task: z.string().trim().min(1),
            // 仅用于视觉职能标识；不授予权限，也不改变 profile、模型、工具或工作区策略。
            role: z.enum(SUBAGENT_ROLE_VALUES).optional(),
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
  Agent: agentInputSchema,
  spawn_agents: spawnAgentsInputSchema,
  wait_agents: waitAgentsInputSchema,
  send_agent: sendAgentInputSchema,
  stop_agent: stopAgentInputSchema,
  followup_agent: followupAgentInputSchema,
  report_agent: reportAgentInputSchema,
  list_agents: listAgentsInputSchema,
}

const DEFERRED_CONTROL_TOOLS = new Set([
  'send_agent',
  'stop_agent',
  'followup_agent',
  'list_agents',
])

const DESCRIPTION_BY_NAME: Record<string, string> = {
  Agent: AGENT_TOOL_DESCRIPTION,
  send_agent:
    'Send supplemental instructions or a follow-up request to a previously spawned subagent by taskID. Running children continue at safe boundaries; finished children resume in a new turn.',
  stop_agent:
    'Stop a running subagent by taskID. Existing workspace modifications remain and require explicit review if needed.',
  followup_agent:
    'Queue follow-up work for a direct child by taskID without interrupting its active turn or pending approvals.',
  list_agents: 'List direct child subagents, current runs, and received progress reports.',
  report_agent:
    'Record progress or intermediate results for the direct parent without starting a parent turn.',
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
    description:
      DESCRIPTION_BY_NAME[name] ??
      `Subagent collaboration: ${name}. Only direct parent-child relationships are allowed; never expand permissions.`,
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
    visibility: DEFERRED_CONTROL_TOOLS.has(name) ? 'deferred' : 'internal',
    executionMode: name === 'Agent' ? 'parallel' : 'sequential',
    execute: async (input, context) => {
      if (!context.subagentLifecycle)
        throw new AgentError('TOOL_NOT_AVAILABLE', '当前执行没有子 Agent 协作入口', 409)
      return context.subagentLifecycle(name, input as Record<string, unknown>)
    },
  }),
)

export const subagentToolDefinitions = delegationToolDefinitions
