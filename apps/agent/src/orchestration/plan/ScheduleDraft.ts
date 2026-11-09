/**
 * submit_schedule_plan 的结构化提交契约：一次提交完整的「任务计划 + 执行安排」
 * 草案。模型可见参数、运行时校验与共享领域 schema 保持同一字段集合；持久化、
 * 版本确认与调度激活都由 SchedulePlanService 负责，本文件只做形状校验。
 */

import { Schema, SchemaIssue } from 'effect'
import {
  AutomationExecutionSchema,
  AutomationNotificationPolicySchema,
} from '@pidex/shared/automation'
import {
  ScheduleAcceptanceSchema,
  ScheduleConditionFallbackSchema,
  ScheduleConditionsSchema,
  ScheduleMissedRunPolicySchema,
  ScheduleTaskPlanSourceSchema,
  ScheduleTriggerSchema,
} from '@pidex/shared/schedule-draft'
import { StructuredPlanSchema } from '@pidex/shared/thread'
import { Type } from '@earendil-works/pi-ai'
import { AgentError } from '../../Domain'
import { structuredPlanParameters } from './StructuredPlan'

const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1))

export const scheduleDraftSubmissionSchema = Schema.Struct({
  name: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema,
  taskPlan: Schema.Struct({
    source: ScheduleTaskPlanSourceSchema,
    sourceRef: Schema.NullOr(NonEmptyStringSchema),
    structured: StructuredPlanSchema,
  }),
  trigger: ScheduleTriggerSchema,
  conditions: ScheduleConditionsSchema,
  conditionFallback: ScheduleConditionFallbackSchema,
  acceptance: ScheduleAcceptanceSchema,
  notificationPolicy: AutomationNotificationPolicySchema,
  missedRuns: ScheduleMissedRunPolicySchema,
  environment: Schema.NullOr(AutomationExecutionSchema),
})
export type ScheduleDraftSubmission = typeof scheduleDraftSubmissionSchema.Type

/** 共享领域 schema 的字段名，用于校验模型可见参数未遗漏或新增字段。 */
export const scheduleDraftDomainFields = Object.keys(scheduleDraftSubmissionSchema.fields).sort()

const decodeScheduleDraftSync = Schema.decodeUnknownSync(scheduleDraftSubmissionSchema, {
  onExcessProperty: 'error',
})

/**
 * 校验一次 submit_schedule_plan 提交。非法形状、空文本和额外字段都抛出模型
 * 可修正的安全错误；错误信息不回显字段值。
 */
export const parseScheduleDraft = (input: unknown): ScheduleDraftSubmission => {
  try {
    return decodeScheduleDraftSync(input) as ScheduleDraftSubmission
  } catch (error) {
    const details = Schema.isSchemaError(error)
      ? SchemaIssue.makeFormatterStandardSchemaV1({
          leafHook: (issue) =>
            issue._tag === 'MissingKey'
              ? '字段缺失'
              : issue._tag === 'UnexpectedKey'
                ? '未知字段'
                : '字段类型无效',
          checkHook: (issue) =>
            String(issue.filter.annotations?.expected ?? '字段为空或超出允许的长度/数量'),
        })(error.issue)
          .issues.map((issue) => {
            const path = (issue.path ?? [])
              .map((part) =>
                typeof part === 'number' || scheduleDraftDomainFields.includes(String(part))
                  ? String(part)
                  : '<unknown>',
              )
              .join('.')
            return `${path || 'scheduleDraft'}: ${issue.message}`
          })
          .join('；')
      : '字段缺失、为空或包含未知字段'
    throw new AgentError('INVALID_TOOL_INPUT', `任务规划草案参数无效：${details}`, 400)
  }
}

const timeZoneDescription = 'IANA 时区名，例如 Asia/Shanghai'

/**
 * submit_schedule_plan 的模型可见参数：只描述任务内容、触发、条件与验收，
 * 不开放项目、模型或权限字段——那些由宿主按当前聊天与设置填充。
 */
export const scheduleDraftParameters = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 200,
      pattern: '\\S',
      description: 'Task name used as a one-line calendar and notification summary',
    }),
    prompt: Type.String({
      minLength: 1,
      maxLength: 4000,
      pattern: '\\S',
      description: 'Execution prompt describing what to do on each run',
    }),
    taskPlan: Type.Object(
      {
        source: Type.Union(
          [Type.Literal('current-plan-item'), Type.Literal('pasted-text'), Type.Literal('file')],
          {
            description:
              'Plan source: current plan item, user-pasted text or a user-specified file. Preserve an explicit user-provided plan.',
          },
        ),
        sourceRef: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
          description: 'Plan item ID or file path; null for pasted content',
        }),
        structured: structuredPlanParameters,
      },
      { additionalProperties: false, description: 'Task plan content stored as a fixed snapshot' },
    ),
    trigger: Type.Union(
      [
        Type.Object(
          {
            kind: Type.Literal('once'),
            at: Type.Number({ description: 'One-time execution timestamp in milliseconds' }),
            timeZone: Type.String({ minLength: 1, description: timeZoneDescription }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            kind: Type.Literal('recurring'),
            schedule: Type.Unsafe<Record<string, unknown>>({
              type: 'object',
              additionalProperties: true,
              description:
                '周期规则：{mode:"hourly",intervalMinutes} / {mode:"daily"|"weekdays",time:"HH:MM"} / {mode:"weekly",weekdays,time} / {mode:"custom",rrule}',
            }),
            timeZone: Type.String({ minLength: 1, description: timeZoneDescription }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            kind: Type.Literal('task-succeeded'),
            taskId: Type.String({ minLength: 1, description: 'Upstream task ID' }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            kind: Type.Literal('acceptance-passed'),
            taskId: Type.String({ minLength: 1, description: 'Upstream task ID' }),
          },
          { additionalProperties: false },
        ),
      ],
      {
        description:
          'Trigger: one-time timestamp, recurring rule or internal event (upstream execution success or acceptance)',
      },
    ),
    conditions: Type.Object(
      {
        dependsOn: Type.Array(Type.String({ minLength: 1 }), {
          description: 'Confirmed task dependencies; use an empty array when absent',
        }),
        requireEnvironment: Type.Boolean({
          description: 'Whether the execution environment must be available',
        }),
        notBefore: Type.Union([Type.Number(), Type.Null()], {
          description: 'Earliest execution timestamp; null when unconstrained',
        }),
        deadline: Type.Union([Type.Number(), Type.Null()], {
          description: 'Deadline timestamp; null when unconstrained',
        }),
      },
      { additionalProperties: false },
    ),
    conditionFallback: Type.Union([Type.Literal('skip'), Type.Literal('wait')], {
      description: 'When conditions are unmet: skip this occurrence or wait and recheck',
    }),
    acceptance: Type.Union(
      [
        Type.Object({ kind: Type.Literal('manual') }, { additionalProperties: false }),
        Type.Object(
          {
            kind: Type.Literal('automatic'),
            checks: Type.Array(
              Type.Unsafe<Record<string, unknown>>({
                type: 'object',
                additionalProperties: true,
                description:
                  'Host-verifiable checks:{kind:"file-exists",path} / {kind:"document-section",path,section} / {kind:"command-exit-code",command,expectedExitCode}',
              }),
              { minItems: 1, maxItems: 20 },
            ),
          },
          { additionalProperties: false },
        ),
      ],
      {
        description:
          'Acceptance method. Use automatic only for host-verifiable criteria; appearance, experience and subjective quality require manual acceptance.',
      },
    ),
    notificationPolicy: Type.Union(
      [Type.Literal('all'), Type.Literal('failures'), Type.Literal('off')],
      { description: 'Notification policy' },
    ),
    missedRuns: Type.Union([Type.Literal('catch-up'), Type.Literal('skip')], {
      description: 'When execution was missed while the app was closed: catch up once or skip',
    }),
    environment: Type.Union(
      [
        Type.Object({ kind: Type.Literal('local') }, { additionalProperties: false }),
        Type.Object(
          {
            kind: Type.Literal('new-worktree'),
            branchName: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ],
      { description: 'Execution environment; null uses the default local workspace' },
    ),
  },
  {
    description:
      'Complete task plan and execution draft. Submit all content together. Success saves a reviewable draft only, without scheduling or execution.',
    additionalProperties: false,
  },
)
