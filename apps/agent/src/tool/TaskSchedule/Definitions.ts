import { z } from 'zod'
import { stat, readFile } from 'node:fs/promises'
import type { ToolDefinition } from '../ToolRegistry'
import type { TaskScheduleService } from '../../calendar/TaskScheduleService'
import { AgentError } from '../../Domain'
import { defaultTaskSchedule } from '@pidex/shared/task-schedule'
const capabilities = {
  filesystem: 'none',
  network: 'none',
  process: false,
  externalState: true,
  userInteraction: false,
} as const
const base = {
  allowedModes: ['chat'] as const,
  allowedProfiles: ['main'] as const,
  approvalStrategy: 'policy' as const,
  visibility: 'deferred' as const,
  executionMode: 'sequential' as const,
}

export function taskScheduleDefinitions(service: TaskScheduleService): ToolDefinition<any, any>[] {
  const task = z
    .object({
      name: z.string().trim().min(1).max(200),
      owner: z.enum(['human', 'agent']).optional(),
    })
    .strict()
  const arrangement = taskArrangementInput
  return [
    {
      ...base,
      sdkName: 'task_schedule_view',
      name: 'task_schedule.view',
      description:
        'Read tasks, conversation associations, run and acceptance states, pending reminders and schedule drafts. Inspect existing tasks and calendars before scheduling.',
      schema: z.object({}).strict(),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      capabilities: { ...capabilities, externalState: false, readOnly: true },
      allowedModes: ['chat', 'plan'],
      execute: async () => service.list(),
      formatResult: (value) => ({ content: JSON.stringify(value), details: value }),
    },
    {
      ...base,
      sdkName: 'task_schedule_create',
      name: 'task_schedule.create',
      description:
        'Create a task when requested by the user; only a name is required, not a plan or model selection. Creation does not execute it. Human acceptance defaults to enabled.',
      schema: task,
      inputSchema: z.toJSONSchema(task),
      capabilities,
      execute: async (input, context) => {
        if (!context.invocation) throw new AgentError('PERMISSION_DENIED', '缺少任务上下文', 403)
        return service.save({
          name: input.name,
          operationId: `${context.invocation.toolCallID}:create`,
          definition: { ...defaultTaskSchedule(input.name), owner: input.owner ?? 'agent' },
        })
      },
      formatResult: (value) => ({ content: JSON.stringify(value), details: value }),
    },
    {
      ...base,
      sdkName: 'task_schedule_propose',
      name: 'task_schedule.propose',
      description:
        'Save a batch scheduling draft without activating execution. Preserve existing arrangements by default; account for availability, priority, duration, deadlines and dependencies. Explain unschedulable tasks. The user confirms the draft on the automation page.',
      schema: arrangement,
      inputSchema: z.toJSONSchema(arrangement),
      capabilities,
      execute: async (input, context) => {
        if (!context.invocation) throw new AgentError('PERMISSION_DENIED', '缺少任务上下文', 403)
        return service.propose({
          ...input,
          operationId: `${context.invocation.toolCallID}:propose`,
        })
      },
      formatResult: (value) => ({
        content: JSON.stringify({ proposal: value, reviewUrl: '/automations' }),
        details: value,
      }),
    },
  ]
}

export const taskArrangementInput = z
  .object({
    items: z
      .array(
        z.union([
          z
            .object({
              taskId: z.string().min(1),
              expectedRevision: z.number().int().positive(),
              at: z.number().finite(),
              durationMinutes: z.number().int().positive().default(30),
            })
            .strict(),
          z
            .object({
              name: z.string().trim().min(1).max(200),
              owner: z.enum(['human', 'agent']),
              at: z.number().finite(),
              durationMinutes: z.number().int().positive().default(30),
            })
            .strict(),
        ]),
      )
      .max(100),
    unscheduled: z
      .array(
        z.union([
          z.object({ taskId: z.string().min(1), reason: z.string().min(1) }).strict(),
          z
            .object({
              name: z.string().trim().min(1).max(200),
              owner: z.enum(['human', 'agent']),
              reason: z.string().min(1),
            })
            .strict(),
        ]),
      )
      .default([]),
  })
  .strict()

const fileCheck = z
  .object({ file_path: z.string().min(1), section: z.string().min(1).optional() })
  .strict()
export const taskScheduleCheckDefinition: ToolDefinition<z.infer<typeof fileCheck>, boolean> = {
  ...base,
  sdkName: 'task_schedule_check',
  name: 'task_schedule.check',
  description: 'Check nonempty files or UTF-8 Markdown sections for automatic task acceptance.',
  schema: fileCheck,
  inputSchema: z.toJSONSchema(fileCheck),
  capabilities: { ...capabilities, filesystem: 'read', externalState: false },
  execute: async (input, context) => {
    const path = await context.workspace.resolveExistingPath(input.file_path)
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size === 0) return false
    if (!input.section) return true
    const content = await readFile(path, 'utf8')
    return content.split(/\r?\n/).some(
      (line) =>
        line
          .replace(/^\s*#{1,6}\s+/, '')
          .replace(/\s+#+\s*$/, '')
          .trim() === input.section?.trim() && /^\s*#{1,6}\s+/.test(line),
    )
  },
}
