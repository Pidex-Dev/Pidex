/**
 * FeatureMap.test.ts — 验证声明式 Feature Map 覆盖率门禁与双层 AppDriver CLI 端到端行为。
 */

import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { DESKTOP_COMMAND_MAP } from './AppDriver.ts'
import { extractRoutePathsFromSource, verifyFeatureMapCoverage } from './CheckFeatureMap.ts'
import { FEATURE_MAP, type FeatureEntry } from './FeatureMap.ts'

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..')
const APP_DRIVER_PATH = resolve(import.meta.dir, 'AppDriver.ts')
const CLI_TEST_TIMEOUT_MS = 30_000

async function runDriverCli(args: readonly string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const proc = Bun.spawn([process.execPath, APP_DRIVER_PATH, ...args], {
    cwd: REPOSITORY_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe('FeatureMap coverage verification', () => {
  it('真实仓库下 100% 覆盖公开 RPC 方法与桌面端路由', () => {
    const report = verifyFeatureMapCoverage()
    expect(report.ok).toBe(true)
    expect(report.featureCount).toBe(FEATURE_MAP.length)
    expect(report.rpcMethodCount).toBeGreaterThan(300)
    expect(report.routeCount).toBeGreaterThan(15)
    expect(report.missingRpcMethods).toEqual([])
    expect(report.staleRpcMethods).toEqual([])
    expect(report.duplicateRpcMethods).toEqual([])
    expect(report.missingRoutes).toEqual([])
    expect(report.staleRoutes).toEqual([])
    expect(report.duplicateRoutes).toEqual([])
    expect(report.duplicateFeatureIds).toEqual([])
    expect(report.invalidFeatureIds).toEqual([])
    expect(report.invalidExemptions).toEqual([])
    expect(report.missingDesktopFeatures).toEqual([])
    expect(report.unmappedDesktopScenarios).toEqual([])
  })

  it('仅从 createHashRouter AST 提取 path 字面量', () => {
    const sampleSource = `
      const unrelated = { path: 'ignored-outside-router' }
      export const router = createHashRouter([
        { path: '/setup', element: <div /> },
        { path: '/', children: [{ index: true }, { path: 'new' }, { path: 'threads/:threadId' }] },
      ])
    `
    expect(extractRoutePathsFromSource(sampleSource)).toEqual([
      '/setup',
      '/',
      'new',
      'threads/:threadId',
    ])
  })

  it('缺少 createHashRouter 时抛出明确错误', () => {
    expect(() => extractRoutePathsFromSource('export const x = 1')).toThrow('createHashRouter')
  })

  it('检测到未映射与过期的 RPC 方法时失败', () => {
    const syntheticFeatures: FeatureEntry[] = [
      {
        id: 'alpha-feature',
        title: 'Alpha',
        rpcMethods: ['rpc/a', 'rpc/stale'],
        routes: ['new'],
        scenarios: [],
      },
    ]
    const report = verifyFeatureMapCoverage({
      features: syntheticFeatures,
      exemptRpcMethods: [],
      exemptRoutes: [],
      actualRpcMethods: ['rpc/a', 'rpc/missing'],
      actualRoutes: ['new'],
    })
    expect(report.ok).toBe(false)
    expect(report.missingRpcMethods).toEqual(['rpc/missing'])
    expect(report.staleRpcMethods).toEqual(['rpc/stale'])
  })

  it('检测到未映射与过期的路由时失败', () => {
    const syntheticFeatures: FeatureEntry[] = [
      {
        id: 'alpha-feature',
        title: 'Alpha',
        rpcMethods: ['rpc/a'],
        routes: ['stale-route'],
        scenarios: [],
      },
    ]
    const report = verifyFeatureMapCoverage({
      features: syntheticFeatures,
      exemptRpcMethods: [],
      exemptRoutes: [],
      actualRpcMethods: ['rpc/a'],
      actualRoutes: ['new', 'missing-route'],
    })
    expect(report.ok).toBe(false)
    expect(report.missingRoutes).toEqual(['new', 'missing-route'])
    expect(report.staleRoutes).toEqual(['stale-route'])
  })

  it('检测到重复映射、非法 feature ID 与空豁免理由时失败', () => {
    const syntheticFeatures: FeatureEntry[] = [
      {
        id: 'InvalidFeatureId',
        title: 'One',
        rpcMethods: ['rpc/a'],
        routes: ['new'],
        scenarios: [],
      },
      {
        id: 'InvalidFeatureId',
        title: 'Two',
        rpcMethods: ['rpc/a'],
        routes: ['new'],
        scenarios: [],
      },
    ]
    const report = verifyFeatureMapCoverage({
      features: syntheticFeatures,
      exemptRpcMethods: [{ target: 'rpc/b', reason: '   ' }],
      exemptRoutes: [],
      actualRpcMethods: ['rpc/a', 'rpc/b'],
      actualRoutes: ['new'],
    })
    expect(report.ok).toBe(false)
    expect(report.duplicateRpcMethods).toEqual(['rpc/a'])
    expect(report.duplicateRoutes).toEqual(['new'])
    expect(report.duplicateFeatureIds).toEqual(['InvalidFeatureId'])
    expect(report.invalidFeatureIds).toEqual(['InvalidFeatureId'])
    expect(report.invalidExemptions).toEqual(['rpc:rpc/b'])
  })

  it('检测到缺少 desktop 场景或未注册桌面命令时失败', () => {
    const syntheticFeatures: FeatureEntry[] = [
      {
        id: 'missing-desktop',
        title: 'MissingDesktop',
        rpcMethods: ['rpc/a'],
        routes: ['new'],
        scenarios: [],
      },
      {
        id: 'unmapped-desktop',
        title: 'UnmappedDesktop',
        rpcMethods: [],
        routes: [],
        scenarios: [
          {
            id: 'unmapped-scenario',
            mode: 'desktop',
            description: 'Unmapped desktop command',
            command: 'bun run nonexistent-command',
          },
        ],
      },
    ]
    const report = verifyFeatureMapCoverage({
      features: syntheticFeatures,
      exemptRpcMethods: [],
      exemptRoutes: [],
      actualRpcMethods: ['rpc/a'],
      actualRoutes: ['new'],
      registeredDesktopCommands: new Set(['bun run valid-command']),
    })
    expect(report.ok).toBe(false)
    expect(report.missingDesktopFeatures).toEqual(['missing-desktop'])
    expect(report.unmappedDesktopScenarios).toEqual([
      'unmapped-desktop/unmapped-scenario:bun run nonexistent-command',
    ])
  })
})

describe('AppDriver CLI', () => {
  it(
    '--list-features --json 输出合法机器可读特征清单',
    async () => {
      const { exitCode, stdout } = await runDriverCli(['--list-features', '--json'])
      expect(exitCode).toBe(0)
      const parsed = JSON.parse(stdout) as {
        ok: boolean
        mode: string
        featureId: string | null
        features: FeatureEntry[]
        steps: Array<{ name: string; ok: boolean }>
        durationMs: number
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.mode).toBe('list')
      expect(parsed.featureId).toBeNull()
      expect(parsed.features.length).toBe(FEATURE_MAP.length)
      expect(parsed.steps[0]?.ok).toBe(true)
      expect(typeof parsed.durationMs).toBe('number')
    },
    CLI_TEST_TIMEOUT_MS,
  )

  it(
    '--mode=agent --feature=thread-lifecycle --json 在隔离目录完成 RPC v4 闭环',
    async () => {
      const { exitCode, stdout } = await runDriverCli([
        '--mode=agent',
        '--feature=thread-lifecycle',
        '--json',
      ])
      expect(exitCode).toBe(0)
      const parsed = JSON.parse(stdout) as {
        ok: boolean
        mode: string
        featureId: string
        scenarioId: string
        steps: Array<{ name: string; ok: boolean }>
        durationMs: number
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.mode).toBe('agent')
      expect(parsed.featureId).toBe('thread-lifecycle')
      expect(parsed.scenarioId).toBe('thread-crud-and-goals')
      expect(typeof parsed.durationMs).toBe('number')
      const stepNames = parsed.steps.map((step) => step.name)
      for (const requiredStep of [
        'agent/bootstrap',
        'initialize',
        'initialized',
        'project/create',
        'thread/create',
        'thread/list',
        'thread/read',
        'thread/history/read',
        'thread/update',
        'thread/goal',
        'thread/bookmarks',
        'shutdown',
      ]) {
        expect(stepNames).toContain(requiredStep)
      }
      expect(parsed.steps.every((step) => step.ok)).toBe(true)
    },
    CLI_TEST_TIMEOUT_MS,
  )

  it(
    '--mode=desktop --feature=plan-approval --json 返回场景命令与就绪状态',
    async () => {
      const { exitCode, stdout } = await runDriverCli([
        '--mode=desktop',
        '--feature=plan-approval',
        '--json',
      ])
      expect(exitCode).toBe(0)
      const parsed = JSON.parse(stdout) as {
        ok: boolean
        mode: string
        featureId: string
        command: string
        steps: Array<{ name: string; ok: boolean }>
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.mode).toBe('desktop')
      expect(parsed.featureId).toBe('plan-approval')
      expect(parsed.command).toBe('bun run test:plan')
      expect(parsed.steps.some((step) => step.name === 'desktop/readiness')).toBe(true)
    },
    CLI_TEST_TIMEOUT_MS,
  )

  it(
    '--mode=desktop --list --json 列出全部功能域的可执行 desktop 场景',
    async () => {
      const { exitCode, stdout } = await runDriverCli(['--mode=desktop', '--list', '--json'])
      expect(exitCode).toBe(0)
      const parsed = JSON.parse(stdout) as {
        ok: boolean
        mode: string
        features: FeatureEntry[]
        steps: Array<{ name: string; ok: boolean; detail?: string }>
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.mode).toBe('list')
      expect(parsed.features.length).toBe(15)
      for (const feature of parsed.features) {
        expect(feature.scenarios.length).toBeGreaterThanOrEqual(1)
        for (const scenario of feature.scenarios) {
          expect(scenario.mode).toBe('desktop')
          expect(scenario.command).toBeDefined()
          expect(DESKTOP_COMMAND_MAP[scenario.command!]).toBeDefined()
        }
      }
    },
    CLI_TEST_TIMEOUT_MS,
  )

  it(
    '每个功能域首个 desktop 场景均可解析为合法命令规格',
    async () => {
      for (const feature of FEATURE_MAP) {
        const { exitCode, stdout } = await runDriverCli([
          '--mode=desktop',
          `--feature=${feature.id}`,
          '--json',
        ])
        expect(exitCode).toBe(0)
        const parsed = JSON.parse(stdout) as {
          ok: boolean
          featureId: string
          scenarioId: string
          command: string
          steps: Array<{ name: string; ok: boolean }>
        }
        expect(parsed.ok).toBe(true)
        expect(parsed.featureId).toBe(feature.id)
        expect(DESKTOP_COMMAND_MAP[parsed.command]).toBeDefined()
        expect(
          parsed.steps.some((step) => step.name === 'desktop/scenario-resolved' && step.ok),
        ).toBe(true)
      }
    },
    CLI_TEST_TIMEOUT_MS,
  )
})
