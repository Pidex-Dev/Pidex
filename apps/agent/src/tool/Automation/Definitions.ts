import { FULL_ACCESS_PERMISSION_CONFIG } from '@pidex/shared/thread'
import { z } from 'zod'
import type { AutomationService } from '../../automation'
import { AgentError } from '../../Domain'
import type { ToolContext, ToolDefinition } from '../ToolRegistry'

const schedule = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('hourly'), intervalMinutes: z.number().int().positive() }).strict(),
  z.object({ mode: z.literal('daily'), time: z.string().regex(/^\d{2}:\d{2}$/) }).strict(),
  z.object({ mode: z.literal('weekdays'), time: z.string().regex(/^\d{2}:\d{2}$/) }).strict(),
  z
    .object({
      mode: z.literal('weekly'),
      weekdays: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).min(1),
      time: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .strict(),
  z.object({ mode: z.literal('custom'), rrule: z.string().trim().min(1) }).strict(),
])
const model = z
  .object({
    providerID: z.string().min(1),
    id: z.string().min(1),
    variant: z.string().min(1).optional(),
  })
  .strict()
const execution = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('local') }).strict(),
    z.object({ kind: z.literal('new-worktree'), branchName: z.string().trim().min(1) }).strict(),
  ])
  .nullable()
const definition = z
  .object({
    kind: z.enum(['standalone', 'thread']),
    name: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    projectId: z.string().nullable(),
    targetThreadId: z.string().nullable(),
    execution,
    model,
    reasoningEffort: z.string().nullable(),
    sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
    schedule,
    timeZone: z.string().min(1),
    notificationPolicy: z.enum(['all', 'failures', 'off']),
  })
  .strict()
const identity = (context: ToolContext) => {
  if (!context.invocation)
    throw new AgentError('PERMISSION_DENIED', '自动化工具缺少受信任的执行上下文', 403)
  return `automation-tool:${context.invocation.toolCallID}`
}
const base = {
  allowedProfiles: ['main'] as const,
  approvalStrategy: 'policy' as const,
  visibility: 'deferred' as const,
  executionMode: 'sequential' as const,
  allowedModes: ['chat'] as const,
}
const capabilities = (externalState: boolean) => ({
  filesystem: 'none' as const,
  network: 'none' as const,
  process: false,
  externalState,
  userInteraction: false,
})
const permissionConfig = (sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access') => ({
  ...FULL_ACCESS_PERMISSION_CONFIG,
  sandboxMode,
})

export const createAutomationDefinitions = (
  service: AutomationService,
): readonly ToolDefinition<any, any>[] => [
  {
    ...base,
    sdkName: 'automation_view',
    name: 'automation.view',
    capabilities: capabilities(false),
    schema: z.object({ automationId: z.string().optional() }).strict(),
    description:
      'List local automations or read one automation and its current revision. Read before updating or deleting.',
    inputSchema: {
      type: 'object',
      properties: { automationId: { type: 'string' } },
      additionalProperties: false,
    },
    execute: async (input) =>
      input.automationId
        ? { automation: service.read(input.automationId) }
        : { automations: service.list(), runs: service.listRuns({ limit: 50 }) },
  },
  {
    ...base,
    sdkName: 'automation_create',
    name: 'automation.create',
    capabilities: capabilities(true),
    schema: definition,
    description:
      'Create a scheduled local automation after the user confirms the task, frequency, execution location and unattended permissions.',
    inputSchema: { type: 'object', additionalProperties: true },
    execute: (input, context) =>
      service.create({
        ...input,
        permissionConfig: permissionConfig(input.sandboxMode),
        operationId: identity(context),
      }),
  },
  {
    ...base,
    sdkName: 'automation_update',
    name: 'automation.update',
    capabilities: capabilities(true),
    schema: definition
      .extend({ automationId: z.string(), expectedRevision: z.number().int().positive() })
      .strict(),
    description:
      'Update using the current revision returned by automation.view. On conflict, read again rather than overwriting newer changes.',
    inputSchema: { type: 'object', additionalProperties: true },
    execute: (input) => {
      const { automationId, expectedRevision, sandboxMode, ...value } = input
      return service.update(automationId, {
        ...value,
        expectedRevision,
        permissionConfig: permissionConfig(sandboxMode),
      })
    },
  },
  {
    ...base,
    sdkName: 'automation_delete',
    name: 'automation.delete',
    capabilities: capabilities(true),
    schema: z
      .object({ automationId: z.string(), expectedRevision: z.number().int().positive() })
      .strict(),
    description:
      'Soft-delete an automation and stop future runs. Existing turns and historical conversations are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        automationId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
      },
      required: ['automationId', 'expectedRevision'],
      additionalProperties: false,
    },
    execute: (input) => service.delete(input.automationId, input.expectedRevision),
  },
]
