import { z } from 'zod'
import type { ToolDefinition } from '../ToolRegistry'

export const requestPermissionsInputSchema = z
  .object({
    scope: z.enum(['tool-call', 'turn', 'session']),
    readPaths: z.array(z.string()).optional(),
    writePaths: z.array(z.string()).optional(),
    networkDomains: z.array(z.string()).optional(),
    escalationToken: z.string().uuid().optional(),
    justification: z.string().min(1),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      !input.escalationToken &&
      !input.readPaths?.length &&
      !input.writePaths?.length &&
      !input.networkDomains?.length
    ) {
      context.addIssue({
        code: 'custom',
        message: '至少需要申请一项路径、网络或 sandbox escalation 权限',
      })
    }
  })

export type RequestPermissionsInput = z.infer<typeof requestPermissionsInputSchema>

/**
 * Canonical contract of the permission-request tool. The Pi lifecycle adapter
 * binds this same description and argument schema, so the model always sees the
 * scope enum, the required justification and the requestable path fields.
 */
export const requestPermissionsDefinition: ToolDefinition<
  RequestPermissionsInput,
  RequestPermissionsInput & { granted: true }
> = {
  sdkName: 'request_permissions',
  name: 'request_permissions',
  description: [
    'Request temporary permissions for the next tool call, current turn or running session, and wait for the user or reviewer decision.',
    'Call ordinary file, write and network tools directly; the host applies current policy and grants. Use this tool only when an actual tool explicitly requires temporary permission. Grants cannot override protected paths, Plan or explicit read-only roots. Unavailable under never approval policy.',
    'Each request requires justification and at least one readPaths, writePaths or networkDomains entry. Do not call without a requestable permission.',
  ].join('\n'),
  schema: requestPermissionsInputSchema,
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        enum: ['tool-call', 'turn', 'session'],
        description: 'Grant lifetime: the next tool call, current turn or running session.',
      },
      readPaths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Absolute paths requiring additional read access. Full access does not require a separate request for outside-workspace files.',
      },
      writePaths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Absolute paths requiring additional write access. Full access does not require a separate request for outside-workspace files.',
      },
      networkDomains: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Domains the shell needs to access, such as npmjs.org. Full access does not require a network permission request.',
      },
      escalationToken: { type: 'string', format: 'uuid' },
      justification: {
        type: 'string',
        description: 'Required explanation to the user of why the task needs these permissions.',
      },
    },
    additionalProperties: false,
    required: ['scope', 'justification'],
  },
  capabilities: {
    filesystem: 'none',
    network: 'none',
    process: false,
    externalState: false,
    userInteraction: true,
    readOnly: false,
  },
  allowedModes: ['chat', 'plan'],
  allowedProfiles: ['main', 'default', 'explorer', 'worker'],
  approvalStrategy: 'always-review',
  visibility: 'internal',
  executionMode: 'sequential',
  execute: async (input) => ({ granted: true, ...input }),
}
