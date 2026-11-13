import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  isReadOnlyTaskMode,
  type AdditionalPermissions,
  type PermissionGrantScope,
} from '@pidex/shared/thread'
import { AgentError, type TaskMode } from '../../Domain'
import type { PermissionGrantStore } from '../../permission/PermissionGrantStore'
import type { WorkspaceService } from '../../workspace/WorkspaceService'

export const canonicalPermissionPath = async (
  workspaceRoot: string,
  value: string,
  allowMissingLeaf: boolean,
): Promise<string> => {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value)
  if (!allowMissingLeaf) {
    return realpath(absolute).catch(() => {
      throw new AgentError('PERMISSION_PATH_NOT_FOUND', `申请读取的路径不存在：${value}`, 400)
    })
  }
  try {
    return await realpath(absolute)
  } catch {
    const parent = await realpath(dirname(absolute)).catch(() => {
      throw new AgentError(
        'PERMISSION_PATH_NOT_FOUND',
        `申请写入路径的父目录不存在：${value}`,
        400,
      )
    })
    return resolve(parent, absolute.slice(dirname(absolute).length + 1))
  }
}

export const normalizeAdditionalPermissions = async (
  input: Record<string, unknown>,
  workspaceRoot: string,
): Promise<AdditionalPermissions> => {
  const strings = (name: 'readPaths' | 'writePaths' | 'networkDomains') => {
    const value = input[name]
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new AgentError('INVALID_TOOL_INPUT', `${name} 必须是非空字符串数组`, 400)
    }
    return [...new Set(value.map((item) => String(item).trim()))]
  }
  const readPaths = await Promise.all(
    strings('readPaths').map((path) => canonicalPermissionPath(workspaceRoot, path, false)),
  )
  const writePaths = await Promise.all(
    strings('writePaths').map((path) => canonicalPermissionPath(workspaceRoot, path, true)),
  )
  const networkDomains = strings('networkDomains').map((domain) => {
    const normalized = domain.toLowerCase().replace(/\.$/, '')
    if (
      normalized === 'localhost' ||
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        normalized,
      )
    ) {
      return normalized
    }
    throw new AgentError('INVALID_TOOL_INPUT', `networkDomains 包含无效域名：${domain}`, 400)
  })
  return {
    ...(readPaths.length ? { readPaths } : {}),
    ...(writePaths.length ? { writePaths } : {}),
    ...(networkDomains.length ? { networkDomains } : {}),
  }
}

export const normalizePermissionRequest = async (
  input: Record<string, unknown>,
  workspace: WorkspaceService,
) => {
  const workspaceRoot = await realpath(workspace.rootPath)
  const permissions = await normalizeAdditionalPermissions(input, workspaceRoot)
  return {
    scope: input.scope,
    ...permissions,
    ...(typeof input.escalationToken === 'string'
      ? { escalationToken: input.escalationToken }
      : {}),
    justification: input.justification,
  }
}

export const executePermissionGrant = async (
  permissionGrants: PermissionGrantStore,
  input: {
    scope: unknown
    requestedPermissions: Record<string, unknown>
    grantedPermissions: Record<string, unknown>
  },
  context: {
    threadID: string
    turnID: string
    agentID?: string
    taskMode: TaskMode
    workspace: WorkspaceService
  },
) => {
  if (isReadOnlyTaskMode(context.taskMode)) {
    throw new AgentError('TOOL_NOT_ALLOWED_IN_MODE', 'Plan 与 Grill 模式禁止请求或提升权限', 403)
  }
  if (!['tool-call', 'turn', 'session'].includes(String(input.scope))) {
    throw new AgentError('INVALID_TOOL_INPUT', '权限 scope 无效', 400)
  }
  const workspaceRoot = await realpath(context.workspace.rootPath)
  const requested = await normalizeAdditionalPermissions(input.requestedPermissions, workspaceRoot)
  const granted = await normalizeAdditionalPermissions(input.grantedPermissions, workspaceRoot)
  const grant = permissionGrants.grant({
    threadID: context.threadID,
    turnID: context.turnID,
    agentID: context.agentID ?? context.turnID,
    scope: input.scope as PermissionGrantScope,
    requested,
    granted,
    workspaceRoot: context.workspace.rootPath,
  })
  return grant
    ? { granted: true, grantId: grant.id, scope: grant.scope, permissions: grant.permissions }
    : {
        granted: false,
        scope: input.scope,
        permissions: { readPaths: [], writePaths: [], networkDomains: [] },
      }
}
