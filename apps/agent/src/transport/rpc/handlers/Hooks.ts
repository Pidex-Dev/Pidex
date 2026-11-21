import {
  HookListParamsSchema,
  HookRunsListParamsSchema,
  HookSetEnabledParamsSchema,
  type RpcMethod,
} from '@pidex/agent-protocol'
import { Schema } from 'effect'
import { AgentError } from '../../../Domain'
import type { RpcRouter } from '../RpcRouter'
import type { RpcRouterContext } from '../RequestContext'
import type { RpcHandlerGroup } from './Types'

const decodeList = Schema.decodeUnknownSync(HookListParamsSchema)
const decodeSetEnabled = Schema.decodeUnknownSync(HookSetEnabledParamsSchema)
const decodeRuns = Schema.decodeUnknownSync(HookRunsListParamsSchema)

const requireKnownWorkspace = (runtime: RpcRouter, cwd: string | undefined) => {
  if (!cwd) return
  const known = runtime.dependencies.db.listProjects().some((project) => {
    const root = project.rootPath
    const resolvedCwd = cwd.replaceAll('/', '\\').toLowerCase()
    const resolvedRoot = root.replaceAll('/', '\\').toLowerCase()
    return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}\\`)
  })
  if (!known) throw new AgentError('HOOK_SOURCE_INVALID', '项目不属于当前 Agent 已知工作区', 404)
}

const decodeParams = <T>(decode: (value: unknown) => T, raw: unknown, method: string): T => {
  try {
    return decode(raw ?? {})
  } catch {
    throw new AgentError('HOOK_INVALID', `${method} 参数无效`, 400)
  }
}

export const hookHandlers = {
  name: 'hooks',
  methods: ['hook/list', 'hook/setEnabled', 'hook/runs/list'],
  async handle(
    runtime: RpcRouter,
    method: RpcMethod,
    rawParams: unknown,
    _context: RpcRouterContext,
  ) {
    const hooks = runtime.dependencies.hooksManagement
    if (!hooks) throw new AgentError('INTERNAL_ERROR', 'Hook 管理服务未配置', 500)
    switch (method) {
      case 'hook/list': {
        const params = decodeParams(decodeList, rawParams, method)
        requireKnownWorkspace(runtime, params.cwd)
        return hooks.listSources(params.cwd)
      }
      case 'hook/setEnabled': {
        const params = decodeParams(decodeSetEnabled, rawParams, method)
        return hooks.setEnabled(params)
      }
      case 'hook/runs/list': {
        const params = decodeParams(decodeRuns, rawParams, method)
        requireKnownWorkspace(runtime, params.cwd)
        return hooks.listRuns(params)
      }
      default:
        return undefined
    }
  },
} as const satisfies RpcHandlerGroup
