import { z } from 'zod'
import { AgentError } from '../../Domain'
import type { SessionGroupService } from '../../session-group/SessionGroupService'
import type { ToolDefinition } from '../ToolRegistry'

const schema = z.object({}).strict()

type WorkgroupReadOutput = NonNullable<ReturnType<SessionGroupService['readForThread']>>

export const createWorkgroupReadDefinition = (
  service: SessionGroupService,
): ToolDefinition<z.infer<typeof schema>, WorkgroupReadOutput> => ({
  sdkName: 'workgroup_read',
  name: 'workgroup_read',
  description:
    'Read member conversations, effective shared entries and recent progress of this conversation workgroup. Use member IDs with read_thread to page through full histories, including requirements and results from before joining. Read-only; does not change data.',
  schema,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  capabilities: {
    filesystem: 'none',
    network: 'none',
    process: false,
    externalState: false,
    userInteraction: false,
    readOnly: true,
  },
  allowedModes: ['chat', 'plan'],
  allowedProfiles: ['main', 'default', 'explorer', 'worker'],
  approvalStrategy: 'never-review',
  visibility: 'eager',
  executionMode: 'parallel',
  execute: async (_input, context) => {
    if (!context.invocation)
      throw new AgentError('PERMISSION_DENIED', '当前上下文不能读取工作组', 403)
    const view = service.readForThread(context.invocation.threadID)
    if (!view) throw new AgentError('SESSION_GROUP_NOT_FOUND', '当前会话不属于任何工作组', 404)
    return view
  },
})
