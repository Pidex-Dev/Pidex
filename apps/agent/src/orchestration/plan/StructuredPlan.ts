/**
 * Plan 模式最终方案的结构化提交契约。模型可见的 submit_plan 参数 schema、
 * 运行时校验与共享领域 schema 保持同一字段集合；Markdown 由共享格式化函数
 * 确定性派生，不是第二真源。
 */

import { Schema, SchemaIssue } from 'effect'
import {
  StructuredPlanSchema,
  type StructuredPlan,
  STRUCTURED_PLAN_MAX_TITLE_LENGTH,
  STRUCTURED_PLAN_MAX_TEXT_LENGTH,
  STRUCTURED_PLAN_MAX_GROUPS,
  STRUCTURED_PLAN_MAX_GROUP_ITEMS,
  STRUCTURED_PLAN_MAX_LIST_ITEMS,
} from '@pidex/shared/thread'
import { Type } from '@earendil-works/pi-ai'
import { AgentError } from '../../Domain'

/** 共享领域 schema 的字段名，用于校验模型可见参数未遗漏或新增字段。 */
export const structuredPlanDomainFields = Object.keys(StructuredPlanSchema.fields).sort()

const decodeStructuredPlanSync = Schema.decodeUnknownSync(StructuredPlanSchema, {
  onExcessProperty: 'error',
})

/**
 * 校验一次 submit_plan 提交。非法形状、空文本和额外字段都抛出模型可修正的
 * 安全错误；错误信息不回显字段值。
 */
export const parseStructuredPlan = (input: unknown): StructuredPlan => {
  try {
    return decodeStructuredPlanSync(input) as StructuredPlan
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
                typeof part === 'number' ||
                [...structuredPlanDomainFields, 'area', 'items'].includes(String(part))
                  ? String(part)
                  : '<unknown>',
              )
              .join('.')
            return `${path || 'plan'}: ${issue.message}`
          })
          .join('；')
      : '字段缺失、为空或包含未知字段'
    throw new AgentError('INVALID_TOOL_INPUT', `结构化计划参数无效：${details}`, 400)
  }
}

/**
 * submit_plan 的模型可见参数：只描述内容章节，不开放组件名、样式或任意
 * Renderer props。
 */
export const structuredPlanParameters = Type.Object(
  {
    title: Type.String({
      minLength: 1,
      maxLength: STRUCTURED_PLAN_MAX_TITLE_LENGTH,
      pattern: '\\S',
      description: 'Plan title describing its intended outcome in one sentence',
    }),
    summary: Type.String({
      minLength: 1,
      maxLength: STRUCTURED_PLAN_MAX_TEXT_LENGTH,
      pattern: '\\S',
      description: 'Plan summary describing objective, scope and key trade-offs',
    }),
    changes: Type.Array(
      Type.Object(
        {
          area: Type.String({
            minLength: 1,
            maxLength: STRUCTURED_PLAN_MAX_TITLE_LENGTH,
            pattern: '\\S',
            description: 'Module or domain affected by the implementation',
          }),
          items: Type.Array(
            Type.String({
              minLength: 1,
              maxLength: STRUCTURED_PLAN_MAX_TEXT_LENGTH,
              pattern: '\\S',
              description: 'One concrete change in this area',
            }),
            {
              minItems: 1,
              maxItems: STRUCTURED_PLAN_MAX_GROUP_ITEMS,
              description: 'Changes in this area, at least one',
            },
          ),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: STRUCTURED_PLAN_MAX_GROUPS,
        description: 'Implementation changes grouped by area, at least one group',
      },
    ),
    interfaceChanges: Type.Array(
      Type.String({
        minLength: 1,
        maxLength: STRUCTURED_PLAN_MAX_TEXT_LENGTH,
        pattern: '\\S',
        description: 'Changes to interfaces, protocols, data or behavior contracts',
      }),
      {
        maxItems: STRUCTURED_PLAN_MAX_LIST_ITEMS,
        description: 'Interface changes; use an empty array when absent',
      },
    ),
    tests: Type.Array(
      Type.String({
        minLength: 1,
        maxLength: STRUCTURED_PLAN_MAX_TEXT_LENGTH,
        pattern: '\\S',
        description: 'Planned verification or test',
      }),
      {
        maxItems: STRUCTURED_PLAN_MAX_LIST_ITEMS,
        description: 'Tests and verification; use an empty array when absent',
      },
    ),
    assumptions: Type.Array(
      Type.String({
        minLength: 1,
        maxLength: STRUCTURED_PLAN_MAX_TEXT_LENGTH,
        pattern: '\\S',
        description: 'Explicit assumption or boundary the user needs to know',
      }),
      {
        maxItems: STRUCTURED_PLAN_MAX_LIST_ITEMS,
        description: 'Explicit assumptions; use an empty array when absent',
      },
    ),
  },
  {
    description:
      'Final Plan-mode proposal. Provide every field, using empty arrays for absent lists. Successful submission ends this turn.',
    additionalProperties: false,
  },
)
