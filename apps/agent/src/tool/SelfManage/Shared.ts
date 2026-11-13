import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { AgentError } from '../../Domain'
import { fileAccessProfileFromV4 } from '../../permission/ExecutionPolicy'
import type { ToolContext, ToolInputInspection } from '../ToolRegistry'

export const SELF_MANAGE_BASE = {
  allowedProfiles: ['main'] as const,
  allowedModes: ['chat'] as const,
  approvalStrategy: 'policy' as const,
  visibility: 'deferred' as const,
  executionMode: 'sequential' as const,
  capabilities: {
    filesystem: 'workspace-write' as const,
    network: 'declared' as const,
    process: false,
    externalState: true,
    userInteraction: false,
  },
}

export const selfManageOperationId = (context: ToolContext, suffix?: string) => {
  if (!context.invocation) {
    throw new AgentError('PERMISSION_DENIED', '自管理工具缺少受信任的宿主执行上下文', 403)
  }
  return suffix
    ? `self-manage:${context.invocation.toolCallID}:${suffix}`
    : `self-manage:${context.invocation.toolCallID}`
}

export const assertSelfManageWritable = (context: ToolContext) => {
  const fileAccess = fileAccessProfileFromV4(context.permissionConfig.sandboxMode)
  if (fileAccess === 'read-only') {
    throw new AgentError('TOOL_NOT_ALLOWED_IN_SANDBOX', '只读沙箱模式禁止修改 Pidex 配置或组件', 403)
  }
}

export const isPathInsideWorkspace = (context: ToolContext, targetPath: string) =>
  context.workspace.containsPath(resolve(targetPath))

export const buildSelfManageInspection = (input: {
  context: ToolContext
  action: string
  readOnly: boolean
  affectedPaths?: string[]
  externalWrite: boolean
  networkAccess?: boolean
  extraFingerprint?: unknown
}): ToolInputInspection => {
  const operation: 'create' | 'update' | 'delete' =
    input.action === 'remove' || input.action === 'uninstall'
      ? 'delete'
      : input.action === 'create' || input.action === 'install'
        ? 'create'
        : 'update'
  const rawPaths =
    input.affectedPaths && input.affectedPaths.length > 0
      ? input.affectedPaths
      : [input.context.workspace.rootPath]
  const affectedPaths = rawPaths.map((item) => ({
    path: item,
    operation,
  }))
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        action: input.action,
        affectedPaths: input.affectedPaths ?? [],
        externalWrite: input.externalWrite,
        networkAccess: Boolean(input.networkAccess),
        extra: input.extraFingerprint ?? null,
      }),
    )
    .digest('hex')

  if (input.readOnly) {
    return {
      authorizationScope: {
        affectedPaths,
        fingerprint,
        ruleRequiresApproval: false,
      },
      permissionFacts: {
        risk: 'low',
        externalWrite: false,
        networkAccess: false,
      },
    }
  }

  return {
    authorizationScope: {
      affectedPaths,
      fingerprint,
      ruleRequiresApproval: input.externalWrite,
    },
    permissionFacts: {
      risk: input.externalWrite || input.networkAccess ? 'high' : 'low',
      externalWrite: input.externalWrite,
      networkAccess: Boolean(input.networkAccess),
      ...(input.affectedPaths?.length
        ? {
            ruleTargets: {
              writePaths: input.affectedPaths,
            },
          }
        : {}),
    },
  }
}

export const toJsonObjectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
})
