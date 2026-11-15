/**
 * AppDriver.ts — 声明式双层功能驱动 CLI（Agent RPC v4 内存闭环 / Desktop Playwright 调度）。
 *
 * CLI：
 *   bun scripts/feature-map/AppDriver.ts --list-features [--json]
 *   bun scripts/feature-map/AppDriver.ts --mode=agent --feature=thread-lifecycle [--json]
 *   bun scripts/feature-map/AppDriver.ts --mode=desktop --feature=plan-approval [--execute] [--json]
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_PERMISSION_CONFIG } from '@pidex/shared/thread'
import { errorMessageOf } from '@pidex/shared/errors'
import type { AgentDriverRuntimeHandle } from '../../apps/agent/scripts/AgentDriverHost.ts'
import { Capabilities, decodeEventEnvelope } from '../../packages/agent-protocol/src/index.ts'
import {
  FEATURE_MAP,
  findFeatureById,
  type DriverMode,
  type FeatureEntry,
  type FeatureScenario,
} from './FeatureMap.ts'
import { killProcessTree } from '../IntegrationTestRunner.ts'

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..')

/** 单个驱动步骤的执行记录。 */
export interface DriverStepResult {
  readonly name: string
  readonly ok: boolean
  readonly durationMs: number
  readonly detail?: string
}

/** 驱动执行的标准输出结果（--json 直接序列化此结构）。 */
export interface DriverRunResult {
  readonly ok: boolean
  readonly mode: 'list' | DriverMode
  readonly featureId: string | null
  readonly scenarioId?: string
  readonly steps: readonly DriverStepResult[]
  readonly durationMs: number
  readonly error?: string
  readonly features?: readonly FeatureEntry[]
  readonly command?: string
  readonly ready?: boolean
}

/** 解析后的 CLI 参数。 */
export interface ParsedDriverArgs {
  readonly listFeatures: boolean
  readonly mode?: DriverMode
  readonly featureId?: string
  readonly scenarioId?: string
  readonly json: boolean
  readonly execute: boolean
  readonly help: boolean
}

/** 解析 AppDriver CLI 参数，同时支持 `--key=value` 与 `--key value`。 */
export function parseDriverArgs(argv: readonly string[]): ParsedDriverArgs {
  let listFeatures = false
  let mode: DriverMode | undefined
  let featureId: string | undefined
  let scenarioId: string | undefined
  let json = false
  let execute = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token) continue
    if (token === '--list-features' || token === '--list') {
      listFeatures = true
    } else if (token === '--json') {
      json = true
    } else if (token === '--execute' || token === '--run') {
      execute = true
    } else if (token === '--dry-run') {
      execute = false
    } else if (token === '--help' || token === '-h') {
      help = true
    } else if (token.startsWith('--mode=')) {
      mode = parseModeValue(token.slice('--mode='.length))
    } else if (token === '--mode') {
      mode = parseModeValue(argv[++index])
    } else if (token.startsWith('--feature=')) {
      featureId = token.slice('--feature='.length).trim() || undefined
    } else if (token === '--feature') {
      featureId = argv[++index]?.trim() || undefined
    } else if (token.startsWith('--scenario=')) {
      scenarioId = token.slice('--scenario='.length).trim() || undefined
    } else if (token === '--scenario') {
      scenarioId = argv[++index]?.trim() || undefined
    } else {
      throw new Error(`未知参数：${token}`)
    }
  }

  return {
    listFeatures,
    ...(mode ? { mode } : {}),
    ...(featureId ? { featureId } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    json,
    execute,
    help,
  }
}

function parseModeValue(value: string | undefined): DriverMode {
  if (value === 'agent' || value === 'desktop') {
    return value
  }
  throw new Error(`无效的 --mode 值：${value ?? '(空)'}，仅支持 agent 或 desktop`)
}

function assertInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function runStep<T>(
  steps: DriverStepResult[],
  name: string,
  action: () => Promise<{ result: T; detail?: string }> | { result: T; detail?: string },
): Promise<T> {
  const startedAt = performance.now()
  try {
    const outcome = await action()
    steps.push({
      name,
      ok: true,
      durationMs: Math.round(performance.now() - startedAt),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    })
    return outcome.result
  } catch (cause) {
    steps.push({
      name,
      ok: false,
      durationMs: Math.round(performance.now() - startedAt),
      detail: errorMessageOf(cause),
    })
    throw cause
  }
}

function resolveFeatureAndScenario(
  mode: DriverMode,
  featureId?: string,
  scenarioId?: string,
): { feature: FeatureEntry; scenario?: FeatureScenario } {
  if (featureId) {
    const feature = findFeatureById(featureId)
    if (!feature) {
      throw new Error(`未找到功能域：${featureId}`)
    }
    if (scenarioId) {
      const scenario = feature.scenarios.find((item) => item.id === scenarioId)
      if (!scenario) {
        throw new Error(`功能域 ${featureId} 不包含场景 ${scenarioId}`)
      }
      if (scenario.mode !== mode) {
        throw new Error(`场景 ${scenarioId} 属于 ${scenario.mode} 模式，与 --mode=${mode} 不匹配`)
      }
      return { feature, scenario }
    }
    const modeScenario = feature.scenarios.find((item) => item.mode === mode)
    return modeScenario ? { feature, scenario: modeScenario } : { feature }
  }

  if (scenarioId) {
    for (const feature of FEATURE_MAP) {
      const scenario = feature.scenarios.find((item) => item.id === scenarioId)
      if (scenario) {
        if (scenario.mode !== mode) {
          throw new Error(`场景 ${scenarioId} 属于 ${scenario.mode} 模式，与 --mode=${mode} 不匹配`)
        }
        return { feature, scenario }
      }
    }
    throw new Error(`未找到场景：${scenarioId}`)
  }

  throw new Error('请指定 --feature=<id> 或 --scenario=<id>（可使用 --list-features 查看清单）')
}

type RpcCall = <T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>

async function runAgentScenarioFlow(
  featureId: string,
  call: RpcCall,
  runtimeApp: AgentDriverRuntimeHandle['app'],
  connectionId: string,
  fixtureModel: { provider: string; id: string },
  steps: DriverStepResult[],
): Promise<void> {
  switch (featureId) {
    case 'rpc-protocol': {
      const sub = await runStep(steps, 'event/subscribe', async () => {
        const result = await call<{ subscriptionId: string }>('event/subscribe', { streams: [] })
        assertInvariant(typeof result.subscriptionId === 'string', '缺少 subscriptionId')
        return { result, detail: `subscriptionId=${result.subscriptionId}` }
      })
      await runStep(steps, 'event/ack', async () => {
        const result = await call<{ acknowledged: unknown[] }>('event/ack', {
          subscriptionId: sub.subscriptionId,
          positions: [],
        })
        return { result, detail: `acknowledged=${result.acknowledged.length}` }
      })
      await runStep(steps, 'event/unsubscribe', async () => {
        const result = await call('event/unsubscribe', { subscriptionId: sub.subscriptionId })
        return { result }
      })
      await runStep(steps, 'system/shrinkMemory', async () => {
        const result = await call<{ success: boolean }>('system/shrinkMemory', { reason: 'manual' })
        return { result, detail: `success=${String(result.success)}` }
      })
      return
    }

    case 'thread-lifecycle': {
      const project = await runStep(steps, 'project/create', async () => {
        const result = await call<{ project: { id: string; name: string } }>('project/create', {
          primaryPath: REPOSITORY_ROOT,
          operationId: crypto.randomUUID(),
        })
        assertInvariant(typeof result.project?.id === 'string', 'project/create 未返回 project.id')
        return { result: result.project, detail: `projectId=${result.project.id}` }
      })

      const created = await runStep(steps, 'thread/create', async () => {
        const result = await call<{ snapshot: { thread: { id: string; title: string } } }>(
          'thread/create',
          {
            workspace: { kind: 'project', projectId: project.id },
            title: 'AppDriver 会话生命周期验证',
            operationId: crypto.randomUUID(),
          },
        )
        assertInvariant(
          typeof result.snapshot?.thread?.id === 'string',
          'thread/create 未返回 thread.id',
        )
        return { result, detail: `threadId=${result.snapshot.thread.id}` }
      })
      const threadId = created.snapshot.thread.id

      await runStep(steps, 'thread/list', async () => {
        const result = await call<{ threads: Array<{ id: string }> }>('thread/list', {
          projectId: project.id,
        })
        assertInvariant(
          result.threads.some((item) => item.id === threadId),
          'thread/list 未包含新建会话',
        )
        return { result, detail: `count=${result.threads.length}` }
      })

      const readSnapshot = await runStep(steps, 'thread/read', async () => {
        const result = await call<{ snapshot: { thread: { id: string; version?: number } } }>(
          'thread/read',
          { threadId },
        )
        assertInvariant(result.snapshot?.thread?.id === threadId, 'thread/read ID 不匹配')
        return { result, detail: `threadId=${threadId}` }
      })

      await runStep(steps, 'thread/history/read', async () => {
        const result = await call<{ thread: { id: string } }>('thread/history/read', { threadId })
        assertInvariant(result.thread?.id === threadId, 'thread/history/read ID 不匹配')
        return { result }
      })

      await runStep(steps, 'thread/update', async () => {
        const version =
          typeof readSnapshot.snapshot.thread.version === 'number'
            ? readSnapshot.snapshot.thread.version
            : 1
        const result = await call<{ thread: { title: string } }>('thread/update', {
          threadId,
          patch: { title: 'AppDriver 更新后标题' },
          expectedVersion: version,
          operationId: crypto.randomUUID(),
        })
        assertInvariant(result.thread?.title === 'AppDriver 更新后标题', 'thread/update 标题未更新')
        return { result, detail: `title=${result.thread.title}` }
      })

      await runStep(steps, 'thread/goal', async () => {
        await call('thread/goal/set', {
          threadId,
          objective: '验证声明式驱动器闭环',
          expectedVersion: null,
          operationId: crypto.randomUUID(),
        })
        const fetched = await call<{ goal: { objective: string; version: number } | null }>(
          'thread/goal/get',
          { threadId },
        )
        assertInvariant(
          fetched.goal?.objective === '验证声明式驱动器闭环',
          'thread/goal/get 返回内容不匹配',
        )
        await call('thread/goal/clear', {
          threadId,
          expectedVersion: fetched.goal.version,
          operationId: crypto.randomUUID(),
        })
        return { result: fetched }
      })

      await runStep(steps, 'thread/bookmarks', async () => {
        const list = await call<{ inputIds: unknown[] }>('thread/bookmarks/list', { threadId })
        return { result: list, detail: `count=${list.inputIds.length}` }
      })
      return
    }

    case 'plan-approval': {
      await runStep(steps, 'provider/update (enable faux model)', async () => {
        const result = await call('provider/update', {
          providerId: fixtureModel.provider,
          definition: {
            kind: 'builtin',
            id: fixtureModel.provider,
            enabled: true,
            allowModels: [fixtureModel.id],
            denyModels: [],
            models: [{ id: fixtureModel.id, enabled: true }],
          },
          operationId: crypto.randomUUID(),
        })
        return { result, detail: `${fixtureModel.provider}/${fixtureModel.id}` }
      })
      const project = await runStep(steps, 'project/create', async () => {
        const result = await call<{ project: { id: string } }>('project/create', {
          primaryPath: REPOSITORY_ROOT,
          operationId: crypto.randomUUID(),
        })
        return { result: result.project, detail: `projectId=${result.project.id}` }
      })
      const created = await runStep(steps, 'thread/create', async () => {
        const result = await call<{ snapshot: { thread: { id: string } } }>('thread/create', {
          workspace: { kind: 'project', projectId: project.id },
          operationId: crypto.randomUUID(),
        })
        return { result, detail: `threadId=${result.snapshot.thread.id}` }
      })
      const threadId = created.snapshot.thread.id
      const subscription = await runStep(steps, 'event/subscribe', async () => {
        const result = await call<{ subscriptionId: string }>('event/subscribe', {
          streams: [{ streamId: threadId, after: 'latest' }],
        })
        return { result, detail: `subscriptionId=${result.subscriptionId}` }
      })

      const eventTypes: string[] = []
      let completed = false
      const sseController = new AbortController()
      const readSse = (async () => {
        const response = await runtimeApp.request(
          `http://agent.local/rpc/events?subscriptionId=${encodeURIComponent(subscription.subscriptionId)}&connectionId=${encodeURIComponent(connectionId)}`,
          { signal: sseController.signal },
        )
        if (!response.ok || !response.body) {
          throw new Error(`SSE 连接失败：${response.status}`)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffered = ''
        try {
          while (!completed) {
            const next = await reader.read()
            if (next.done) break
            buffered += decoder.decode(next.value, { stream: true })
            const frames = buffered.split(/\r?\n\r?\n/)
            buffered = frames.pop() ?? ''
            for (const frame of frames) {
              const data = frame
                .split(/\r?\n/)
                .find((line) => line.startsWith('data:'))
                ?.slice(5)
                .trim()
              if (!data) continue
              const message = JSON.parse(data) as { method?: string; params?: { event?: unknown } }
              const rawEnvelope =
                message.method === 'event/next' &&
                message.params?.event &&
                typeof message.params.event === 'object'
                  ? (message.params.event as { type?: string })
                  : null
              if (!rawEnvelope?.type) continue
              if (rawEnvelope.type === 'plan/delta') {
                decodeEventEnvelope(rawEnvelope)
              }
              eventTypes.push(rawEnvelope.type)
              if (rawEnvelope.type === 'turn/completed') {
                completed = true
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined)
        }
      })()

      const { PLAN_SMOKE_TITLE } = await import('../../apps/agent/scripts/PlanSmokeFixture.ts')
      try {
        await runStep(steps, 'turn/start (plan)', async () => {
          const result = await call<{ turnId: string }>('turn/start', {
            threadId,
            inputId: crypto.randomUUID(),
            content: '请输出 Plan 流程自动化测试方案。',
            model: { providerID: fixtureModel.provider, id: fixtureModel.id },
            permissionConfig: DEFAULT_PERMISSION_CONFIG,
            taskMode: 'plan',
          })
          const deadline = Date.now() + 15_000
          while (!completed && Date.now() < deadline) {
            await Bun.sleep(20)
          }
          assertInvariant(completed, 'Plan turn 未在 15 秒内完成')
          await call('event/unsubscribe', { subscriptionId: subscription.subscriptionId })
          await readSse
          assertInvariant(eventTypes.includes('plan/delta'), '缺少 plan/delta 事件')
          return { result, detail: `turnId=${result.turnId}, title=${PLAN_SMOKE_TITLE}` }
        })
      } catch (cause) {
        sseController.abort()
        await call('event/unsubscribe', { subscriptionId: subscription.subscriptionId }).catch(
          () => undefined,
        )
        await readSse.catch(() => undefined)
        throw cause
      }

      await runStep(steps, 'planApproval/read & interaction/listPending', async () => {
        const approval = await call<{ approval: unknown }>('planApproval/read', { threadId })
        const pending = await call<{ interactions: unknown[] }>('interaction/listPending', {
          threadId,
        })
        assertInvariant(pending.interactions.length === 0, 'Plan turn 不应产生待处理 interaction')
        return {
          result: { approval, pending },
          detail: `pendingInteractions=${pending.interactions.length}`,
        }
      })
      return
    }

    case 'projects-workspace': {
      const project = await runStep(steps, 'project/create', async () => {
        const result = await call<{ project: { id: string; folders: Array<{ id: string }> } }>(
          'project/create',
          { primaryPath: REPOSITORY_ROOT, operationId: crypto.randomUUID() },
        )
        return { result: result.project, detail: `projectId=${result.project.id}` }
      })
      await runStep(steps, 'project/list & project/open', async () => {
        const listed = await call<{ projects: Array<{ id: string }> }>('project/list', {})
        assertInvariant(
          listed.projects.some((item) => item.id === project.id),
          'project/list 缺少新建项目',
        )
        const opened = await call('project/open', {
          projectId: project.id,
          operationId: crypto.randomUUID(),
        })
        return { result: opened }
      })
      await runStep(steps, 'project/context/read & project/trust/read', async () => {
        const context = await call('project/context/read', { projectId: project.id })
        const trust = await call('project/trust/read', { projectId: project.id })
        return { result: { context, trust } }
      })
      const folderId = project.folders[0]?.id
      if (folderId) {
        await runStep(steps, 'workspace/file/list', async () => {
          const files = await call<{ entries: unknown[] }>('workspace/file/list', {
            projectId: project.id,
            folderId,
            path: 'scripts/feature-map',
          })
          return { result: files, detail: `entries=${files.entries.length}` }
        })
      }
      return
    }

    case 'review-concurrency': {
      const project = await runStep(steps, 'project/create', async () => {
        const result = await call<{ project: { id: string } }>('project/create', {
          primaryPath: REPOSITORY_ROOT,
          operationId: crypto.randomUUID(),
        })
        return { result: result.project, detail: `projectId=${result.project.id}` }
      })
      await runStep(steps, 'review/summary', async () => {
        const summary = await call<{ snapshot: { files: unknown[] } }>('review/summary', {
          projectId: project.id,
          source: { kind: 'uncommitted' },
        })
        return { result: summary, detail: `files=${summary.snapshot.files.length}` }
      })
      await runStep(steps, 'review/branches & review/status', async () => {
        const branches = await call('review/branches', { projectId: project.id })
        const status = await call('review/status', { projectId: project.id })
        return { result: { branches, status } }
      })
      return
    }

    case 'worktree-git': {
      const project = await runStep(steps, 'project/create', async () => {
        const result = await call<{ project: { id: string } }>('project/create', {
          primaryPath: REPOSITORY_ROOT,
          operationId: crypto.randomUUID(),
        })
        return { result: result.project, detail: `projectId=${result.project.id}` }
      })
      await runStep(
        steps,
        'worktree/settings/list & worktree/list & worktree/eligibility',
        async () => {
          const settings = await call<{ worktrees: unknown[] }>('worktree/settings/list', {
            projectId: project.id,
          })
          const listed = await call<{ worktrees: unknown[] }>('worktree/list', {
            projectId: project.id,
          })
          const eligibility = await call('worktree/eligibility', { projectId: project.id })
          return {
            result: { settings, listed, eligibility },
            detail: `worktrees=${listed.worktrees.length}`,
          }
        },
      )
      return
    }

    case 'github-pull-requests': {
      await runStep(steps, 'github/auth/status & github/watch/list', async () => {
        const auth = await call('github/auth/status', {})
        const watches = await call<{ watches: unknown[] }>('github/watch/list', {})
        return { result: { auth, watches }, detail: `watches=${watches.watches.length}` }
      })
      return
    }

    case 'models-catalog': {
      await runStep(steps, 'provider/update', async () => {
        const result = await call('provider/update', {
          providerId: fixtureModel.provider,
          definition: {
            kind: 'builtin',
            id: fixtureModel.provider,
            enabled: true,
            allowModels: [fixtureModel.id],
            denyModels: [],
            models: [{ id: fixtureModel.id, enabled: true }],
          },
          operationId: crypto.randomUUID(),
        })
        return { result, detail: `${fixtureModel.provider}/${fixtureModel.id}` }
      })
      await runStep(steps, 'provider/list & model/list', async () => {
        const providers = await call<{ providers: Array<{ id: string }> }>('provider/list', {})
        assertInvariant(
          providers.providers.some((provider) => provider.id === fixtureModel.provider),
          `未找到测试 Provider：${fixtureModel.provider}`,
        )
        const catalog = await call<{
          providers: Array<{ id: string; models: Array<{ id: string }> }>
        }>('model/list', {
          providerId: fixtureModel.provider,
        })
        const listedModels = catalog.providers.flatMap((provider) => provider.models)
        assertInvariant(listedModels.length > 0, 'model/list 返回空目录')
        return {
          result: { providers, catalog },
          detail: `providers=${providers.providers.length}, models=${listedModels.length}`,
        }
      })
      await runStep(steps, 'model/setDefault', async () => {
        const result = await call('model/setDefault', {
          model: { providerID: fixtureModel.provider, id: fixtureModel.id },
          operationId: crypto.randomUUID(),
        })
        return { result, detail: `${fixtureModel.provider}/${fixtureModel.id}` }
      })
      return
    }

    case 'settings-config': {
      await runStep(steps, 'config/read & config/profile/list', async () => {
        const config = await call('config/read', {})
        const profiles = await call('config/profile/list', {})
        return { result: { config, profiles } }
      })
      await runStep(steps, 'memory/list & storage/summary & release-notes/list', async () => {
        const memories = await call('memory/list', {})
        const storage = await call('storage/summary', {})
        const releaseNotes = await call('release-notes/list', {})
        return { result: { memories, storage, releaseNotes } }
      })
      return
    }

    case 'local-environment': {
      const project = await runStep(steps, 'project/create', async () => {
        const result = await call<{ project: { id: string } }>('project/create', {
          primaryPath: REPOSITORY_ROOT,
          operationId: crypto.randomUUID(),
        })
        return { result: result.project, detail: `projectId=${result.project.id}` }
      })
      const thread = await runStep(steps, 'thread/create', async () => {
        const result = await call<{ snapshot: { thread: { id: string } } }>('thread/create', {
          workspace: { kind: 'project', projectId: project.id },
          operationId: crypto.randomUUID(),
        })
        return { result: result.snapshot.thread, detail: `threadId=${result.snapshot.thread.id}` }
      })
      await runStep(steps, 'local-environment/project/list & read & action/list', async () => {
        const envs = await call<{ environments: unknown[] }>('local-environment/project/list', {
          projectId: project.id,
        })
        const envRead = await call('local-environment/read', { threadId: thread.id })
        const actions = await call<{ actions: unknown[] }>('local-environment/action/list', {
          threadId: thread.id,
        })
        return {
          result: { envs, envRead, actions },
          detail: `environments=${envs.environments.length}, actions=${actions.actions.length}`,
        }
      })
      return
    }

    case 'workflows-session-groups': {
      await runStep(steps, 'workflow/list & session-group/list', async () => {
        const workflows = await call<{ workflows: unknown[] }>('workflow/list', {})
        const groups = await call<{ groups: unknown[] }>('session-group/list', {})
        return {
          result: { workflows, groups },
          detail: `workflows=${workflows.workflows.length}, groups=${groups.groups.length}`,
        }
      })
      return
    }

    case 'automation-schedule': {
      await runStep(
        steps,
        'automation/list & automation/run/list & task-schedule/list',
        async () => {
          const automations = await call<{ automations: unknown[] }>('automation/list', {})
          const runs = await call<{ runs: unknown[] }>('automation/run/list', {})
          const schedules = await call('task-schedule/list', {})
          return {
            result: { automations, runs, schedules },
            detail: `automations=${automations.automations.length}, runs=${runs.runs.length}`,
          }
        },
      )
      return
    }

    case 'browser-computer': {
      await runStep(steps, 'browser/list & browser/preferences/get & computer/state', async () => {
        const tabs = await call<{ tabs: unknown[] }>('browser/list', {})
        const prefs = await call('browser/preferences/get', {})
        const computer = await call('computer/state', {})
        return { result: { tabs, prefs, computer }, detail: `tabs=${tabs.tabs.length}` }
      })
      return
    }

    case 'plugins-skills-mcp': {
      await runStep(
        steps,
        'plugin/list & skill/list & mcp/list & hook/list & tooling/list',
        async () => {
          const plugins = await call('plugin/list', {})
          const skills = await call('skill/list', {})
          const mcps = await call('mcp/list', {})
          const hooks = await call('hook/list', {})
          const tooling = await call('tooling/list', {})
          return { result: { plugins, skills, mcps, hooks, tooling } }
        },
      )
      return
    }

    case 'pet-companion': {
      await runStep(steps, 'pet/list & pet/catalog/list', async () => {
        const pets = await call<{ pets: unknown[] }>('pet/list', {})
        const catalog = await call('pet/catalog/list', {})
        return { result: { pets, catalog }, detail: `pets=${pets.pets.length}` }
      })
      return
    }

    default:
      throw new Error(`功能域 ${featureId} 尚未注册 Agent RPC 驱动流程`)
  }
}

async function runAgentMode(
  feature: FeatureEntry,
  scenario: FeatureScenario | undefined,
): Promise<DriverRunResult> {
  const startedAt = performance.now()
  const steps: DriverStepResult[] = []
  const dataDir = await mkdtemp(join(tmpdir(), 'pidex-app-driver-'))
  const priorDataDir = process.env.PIDEX_DATA_DIR
  const priorDesktopManaged = process.env.PIDEX_DESKTOP_MANAGED
  const priorOpenAiApiKey = process.env.OPENAI_API_KEY
  process.env.PIDEX_DATA_DIR = dataDir
  process.env.PIDEX_DESKTOP_MANAGED = '1'
  process.env.OPENAI_API_KEY = 'pidex-app-driver-not-a-real-key'

  let runtime: AgentDriverRuntimeHandle | undefined

  try {
    runtime = await runStep(steps, 'agent/bootstrap', async () => {
      const { bootAgentDriverRuntime } = await import('../../apps/agent/scripts/AgentDriverHost.ts')
      const booted = await bootAgentDriverRuntime()
      return { result: booted, detail: 'isolated tmpdir' }
    })

    let requestSequence = 0
    let connectionId = ''
    const call: RpcCall = async <T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      const response = await runtime!.app.request('http://agent.local/rpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(connectionId ? { 'x-pidex-connection-id': connectionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `driver:${++requestSequence}`,
          method,
          params,
        }),
      })
      const payload = (await response.json()) as { result?: T; error?: unknown }
      if (payload.error) {
        throw new Error(`${method}: ${JSON.stringify(payload.error)}`)
      }
      return payload.result as T
    }

    const initialized = await runStep(steps, 'initialize', async () => {
      const result = await call<{ protocol: string; connectionId: string }>('initialize', {
        clientInfo: {
          name: 'pidex-app-driver',
          version: '1.0.0',
          platform: process.platform,
        },
        protocols: ['thread-rpc-v4'],
        capabilities: [...Capabilities],
        interactionDelivery: 'active',
      })
      assertInvariant(result.protocol === 'thread-rpc-v4', `非预期协议：${result.protocol}`)
      return { result, detail: `protocol=${result.protocol}` }
    })
    connectionId = initialized.connectionId

    await runStep(steps, 'initialized', async () => {
      const response = await runtime!.app.request('http://agent.local/rpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pidex-connection-id': connectionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialized',
          params: { protocol: 'thread-rpc-v4' },
        }),
      })
      assertInvariant(response.ok, `initialized 返回异常状态：${response.status}`)
      return { result: undefined }
    })

    await runAgentScenarioFlow(feature.id, call, runtime.app, connectionId, runtime.model, steps)

    await runStep(steps, 'shutdown', async () => {
      const result = await call<{ ok: boolean }>('shutdown', { operationId: crypto.randomUUID() })
      assertInvariant(result.ok === true, 'shutdown 未返回 ok=true')
      return { result }
    })

    return {
      ok: true,
      mode: 'agent',
      featureId: feature.id,
      ...(scenario ? { scenarioId: scenario.id } : {}),
      steps,
      durationMs: Math.round(performance.now() - startedAt),
    }
  } catch (cause) {
    return {
      ok: false,
      mode: 'agent',
      featureId: feature.id,
      ...(scenario ? { scenarioId: scenario.id } : {}),
      steps,
      durationMs: Math.round(performance.now() - startedAt),
      error: errorMessageOf(cause),
    }
  } finally {
    // INVARIANT: Each cleanup step is isolated so a dispose failure never leaks DB handles, env overrides, or temp dirs.
    try {
      await runtime?.dispose()
    } catch {}
    try {
      runtime?.db.close()
    } catch {}
    if (priorDataDir === undefined) delete process.env.PIDEX_DATA_DIR
    else process.env.PIDEX_DATA_DIR = priorDataDir
    if (priorDesktopManaged === undefined) delete process.env.PIDEX_DESKTOP_MANAGED
    else process.env.PIDEX_DESKTOP_MANAGED = priorDesktopManaged
    if (priorOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = priorOpenAiApiKey
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 桌面端可调度命令的分类。 */
export type DesktopCommandKind =
  'electron-smoke' | 'e2e-script' | 'renderer-browser' | 'renderer-visual'

/** 桌面端显式命令分发规格，杜绝任意 shell 拼接。 */
export interface DesktopCommandSpec {
  readonly kind: DesktopCommandKind
  readonly args: readonly string[]
  readonly timeoutMs: number
}

const DESKTOP_FEATURE_VISUAL_IDS = [
  'thread-lifecycle',
  'projects-workspace',
  'worktree-git',
  'github-pull-requests',
  'models-catalog',
  'local-environment',
  'workflows-session-groups',
  'automation-schedule',
  'browser-computer',
  'plugins-skills-mcp',
  'pet-companion',
] as const

function rendererBrowserEntry(fileName: string): [string, DesktopCommandSpec] {
  const relativePath = `apps/desktop/renderer/test/${fileName}`
  return [
    `bun ${relativePath}`,
    {
      kind: 'renderer-browser',
      args: [relativePath],
      timeoutMs: 90_000,
    },
  ]
}

function rendererVisualEntry(specFile: string, grepPattern?: string): [string, DesktopCommandSpec] {
  const command = grepPattern
    ? `bun run --cwd apps/desktop/renderer test:visual -- ${specFile} --grep=${grepPattern}`
    : `bun run --cwd apps/desktop/renderer test:visual -- ${specFile}`
  const args = grepPattern
    ? [
        'run',
        '--cwd',
        'apps/desktop/renderer',
        'test:visual',
        '--',
        specFile,
        `--grep=${grepPattern}`,
      ]
    : ['run', '--cwd', 'apps/desktop/renderer', 'test:visual', '--', specFile]
  return [
    command,
    {
      kind: 'renderer-visual',
      args,
      timeoutMs: 120_000,
    },
  ]
}

/** 桌面端允许执行的显式命令白名单，键与 FeatureMap.ts 中 desktop scenario.command 一一对应。 */
export const DESKTOP_COMMAND_MAP: Readonly<Record<string, DesktopCommandSpec>> = Object.freeze({
  'bun run test:desktop:smoke': {
    kind: 'electron-smoke',
    args: ['run', '--cwd', 'apps/desktop/electron', 'test:smoke'],
    timeoutMs: 120_000,
  },
  'bun run test:plan': {
    kind: 'e2e-script',
    args: ['scripts/TestPlanFlow.ts'],
    timeoutMs: 120_000,
  },
  'bun run test:review-concurrency': {
    kind: 'e2e-script',
    args: ['scripts/TestReviewConcurrency.ts'],
    timeoutMs: 120_000,
  },
  ...Object.fromEntries([
    rendererVisualEntry('appearance-mode.behavior.visual.ts'),
    rendererBrowserEntry('QueueRemove.browser.ts'),
    rendererBrowserEntry('ConversationForkNavigation.browser.ts'),
    rendererBrowserEntry('ProviderManagementSubscription.browser.ts'),
    rendererBrowserEntry('PetSettingsSubscription.browser.ts'),
    ...DESKTOP_FEATURE_VISUAL_IDS.map((featureId) =>
      rendererVisualEntry('DesktopFeatures.visual.ts', `@feature:${featureId}`),
    ),
  ]),
})

async function executeDesktopCommand(
  spec: DesktopCommandSpec,
  scenarioId: string,
  steps: DriverStepResult[],
): Promise<void> {
  const activeChildren = new Set<ChildProcess>()
  const onSignal = () => {
    for (const child of [...activeChildren]) {
      killProcessTree(child)
    }
    activeChildren.clear()
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    await runStep(steps, `desktop/dispatch:${scenarioId}`, async () => {
      const child = spawn(process.execPath, [...spec.args], {
        cwd: REPOSITORY_ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      activeChildren.add(child)
      // INVARIANT: Always drain stdout/stderr into bounded buffers so Windows OS pipe buffers never deadlock the child process.
      const maxTailBytes = 8192
      let stdoutTail = ''
      let stderrTail = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child)
      }, spec.timeoutMs)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdoutTail = (stdoutTail + chunk).slice(-maxTailBytes)
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-maxTailBytes)
      })
      const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
        child.once('error', rejectExit)
        child.once('exit', resolveExit)
      }).finally(() => {
        clearTimeout(timer)
        activeChildren.delete(child)
      })
      const failureTail = stderrTail.trim() || stdoutTail.trim()
      assertInvariant(
        !timedOut,
        `桌面场景超时（>${spec.timeoutMs}ms）：${spec.args.join(' ')}${failureTail ? ` | ${failureTail}` : ''}`,
      )
      assertInvariant(
        exitCode === 0,
        `桌面场景退出码异常：${exitCode ?? 'signal'}${failureTail ? ` | ${failureTail}` : ''}`,
      )
      return { result: exitCode, detail: `[${spec.kind}] bun ${spec.args.join(' ')}` }
    })
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}

async function runDesktopMode(
  feature: FeatureEntry,
  scenario: FeatureScenario | undefined,
  execute: boolean,
): Promise<DriverRunResult> {
  const startedAt = performance.now()
  const steps: DriverStepResult[] = []

  if (!scenario) {
    return {
      ok: false,
      mode: 'desktop',
      featureId: feature.id,
      steps,
      durationMs: Math.round(performance.now() - startedAt),
      error: `功能域 ${feature.id} 未定义 desktop 模式场景`,
    }
  }

  const electronPackageExists = existsSync(
    resolve(REPOSITORY_ROOT, 'apps/desktop/electron/package.json'),
  )
  const rendererPackageExists = existsSync(
    resolve(REPOSITORY_ROOT, 'apps/desktop/renderer/package.json'),
  )
  const rendererBuilt = existsSync(resolve(REPOSITORY_ROOT, 'dist/renderer/index.html'))
  const electronBuilt = existsSync(resolve(REPOSITORY_ROOT, 'apps/desktop/electron/dist/main.js'))
  const spec = scenario.command ? DESKTOP_COMMAND_MAP[scenario.command] : undefined
  const ready =
    spec?.kind === 'electron-smoke'
      ? electronPackageExists && rendererBuilt && electronBuilt
      : electronPackageExists && rendererPackageExists

  steps.push({
    name: 'desktop/readiness',
    ok: electronPackageExists && rendererPackageExists,
    durationMs: 0,
    detail: `electronPackage=${String(electronPackageExists)}, rendererPackage=${String(rendererPackageExists)}, rendererBuilt=${String(rendererBuilt)}, electronBuilt=${String(electronBuilt)}`,
  })

  if (!execute) {
    steps.push({
      name: 'desktop/scenario-resolved',
      ok: spec !== undefined,
      durationMs: 0,
      detail: spec
        ? `[${spec.kind}] ${scenario.command}`
        : `未注册桌面命令：${scenario.command ?? '(无)'}`,
    })
    return {
      ok: electronPackageExists && rendererPackageExists && spec !== undefined,
      mode: 'desktop',
      featureId: feature.id,
      scenarioId: scenario.id,
      ...(scenario.command ? { command: scenario.command } : {}),
      ready,
      steps,
      durationMs: Math.round(performance.now() - startedAt),
      ...(spec === undefined
        ? { error: `桌面场景 ${scenario.id} 未注册可执行命令映射：${scenario.command ?? '(无)'}` }
        : {}),
    }
  }

  if (!spec) {
    return {
      ok: false,
      mode: 'desktop',
      featureId: feature.id,
      scenarioId: scenario.id,
      ...(scenario.command ? { command: scenario.command } : {}),
      steps,
      durationMs: Math.round(performance.now() - startedAt),
      error: `桌面场景 ${scenario.id} 没有可执行命令映射：${scenario.command ?? '(无)'}`,
    }
  }

  try {
    await executeDesktopCommand(spec, scenario.id, steps)

    return {
      ok: true,
      mode: 'desktop',
      featureId: feature.id,
      scenarioId: scenario.id,
      ...(scenario.command ? { command: scenario.command } : {}),
      ready: true,
      steps,
      durationMs: Math.round(performance.now() - startedAt),
    }
  } catch (cause) {
    return {
      ok: false,
      mode: 'desktop',
      featureId: feature.id,
      scenarioId: scenario.id,
      ...(scenario.command ? { command: scenario.command } : {}),
      steps,
      durationMs: Math.round(performance.now() - startedAt),
      error: errorMessageOf(cause),
    }
  }
}

/** 运行双层 AppDriver，返回结构化执行结果。 */
export async function runAppDriver(argv: readonly string[]): Promise<DriverRunResult> {
  const startedAt = performance.now()
  let parsed: ParsedDriverArgs
  try {
    parsed = parseDriverArgs(argv)
  } catch (cause) {
    return {
      ok: false,
      mode: 'list',
      featureId: null,
      steps: [],
      durationMs: Math.round(performance.now() - startedAt),
      error: errorMessageOf(cause),
    }
  }

  if (parsed.listFeatures || parsed.help) {
    const listedFeatures = parsed.mode
      ? FEATURE_MAP.map((feature) => ({
          ...feature,
          scenarios: feature.scenarios.filter((scenario) => scenario.mode === parsed.mode),
        }))
      : FEATURE_MAP
    return {
      ok: true,
      mode: 'list',
      featureId: null,
      features: listedFeatures,
      steps: [
        {
          name: 'feature-map/list',
          ok: true,
          durationMs: Math.round(performance.now() - startedAt),
          detail: parsed.mode
            ? `mode=${parsed.mode}, features=${listedFeatures.length}`
            : `features=${listedFeatures.length}`,
        },
      ],
      durationMs: Math.round(performance.now() - startedAt),
    }
  }

  const mode = parsed.mode
  if (!mode) {
    return {
      ok: false,
      mode: 'list',
      featureId: parsed.featureId ?? null,
      steps: [],
      durationMs: Math.round(performance.now() - startedAt),
      error: '请指定 --list-features 或 --mode=<agent|desktop>',
    }
  }

  try {
    const { feature, scenario } = resolveFeatureAndScenario(
      mode,
      parsed.featureId,
      parsed.scenarioId,
    )
    if (mode === 'agent') {
      return await runAgentMode(feature, scenario)
    }
    return await runDesktopMode(feature, scenario, parsed.execute)
  } catch (cause) {
    return {
      ok: false,
      mode,
      featureId: parsed.featureId ?? null,
      ...(parsed.scenarioId ? { scenarioId: parsed.scenarioId } : {}),
      steps: [],
      durationMs: Math.round(performance.now() - startedAt),
      error: errorMessageOf(cause),
    }
  }
}

function formatHumanResult(result: DriverRunResult): string {
  if (result.mode === 'list' && result.features) {
    const lines = [`已注册功能域 (${result.features.length})：`]
    for (const feature of result.features) {
      const scenarioSummary = feature.scenarios
        .map((scenario) => `${scenario.mode}:${scenario.id}`)
        .join(', ')
      lines.push(
        `- ${feature.id} | RPC=${feature.rpcMethods.length} | Routes=${feature.routes.length} | ${feature.title} [${scenarioSummary}]`,
      )
    }
    return lines.join('\n')
  }

  const lines = [
    `[app-driver] mode=${result.mode} feature=${result.featureId ?? '(none)'} ok=${String(result.ok)} durationMs=${result.durationMs}`,
  ]
  for (const step of result.steps) {
    lines.push(
      `  ${step.ok ? 'PASS' : 'FAIL'} ${step.name} (${step.durationMs}ms)${step.detail ? ` - ${step.detail}` : ''}`,
    )
  }
  if (result.command) {
    lines.push(`  command: ${result.command}`)
  }
  if (result.error) {
    lines.push(`  error: ${result.error}`)
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const jsonOutput = argv.includes('--json')
  const result = await runAppDriver(argv)
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatHumanResult(result)}\n`)
  }
  if (!result.ok) {
    process.exitCode = 1
  }
}
