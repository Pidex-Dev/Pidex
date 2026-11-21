/**
 * CheckFeatureMap.ts — 验证声明式 Feature Map 对公开 RPC v4 方法与桌面端路由的 100% 覆盖率。
 *
 * CLI：
 *   bun scripts/feature-map/CheckFeatureMap.ts [--json]
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { RpcMethods } from '../../packages/agent-protocol/src/index.ts'
import { DESKTOP_COMMAND_MAP } from './AppDriver.ts'
import {
  EXEMPT_ROUTES,
  EXEMPT_RPC_METHODS,
  FEATURE_MAP,
  type FeatureEntry,
  type FeatureExemption,
} from './FeatureMap.ts'

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..')
const DEFAULT_ROUTES_PATH = resolve(REPOSITORY_ROOT, 'apps/desktop/renderer/src/Routes.tsx')
const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 覆盖率验证的可选覆盖输入，便于单元测试注入合成数据。 */
export interface VerifyFeatureMapInput {
  readonly features?: readonly FeatureEntry[]
  readonly exemptRpcMethods?: readonly FeatureExemption[]
  readonly exemptRoutes?: readonly FeatureExemption[]
  readonly actualRpcMethods?: readonly string[]
  readonly actualRoutes?: readonly string[]
  readonly registeredDesktopCommands?: ReadonlySet<string>
}

/** Feature Map 覆盖率与一致性检查结果。 */
export interface FeatureMapCoverageReport {
  readonly ok: boolean
  readonly featureCount: number
  readonly rpcMethodCount: number
  readonly routeCount: number
  readonly missingRpcMethods: readonly string[]
  readonly staleRpcMethods: readonly string[]
  readonly duplicateRpcMethods: readonly string[]
  readonly missingRoutes: readonly string[]
  readonly staleRoutes: readonly string[]
  readonly duplicateRoutes: readonly string[]
  readonly duplicateFeatureIds: readonly string[]
  readonly invalidFeatureIds: readonly string[]
  readonly invalidExemptions: readonly string[]
  readonly missingDesktopFeatures: readonly string[]
  readonly unmappedDesktopScenarios: readonly string[]
}

/** 使用 TypeScript AST 从 Routes.tsx 源码中提取 createHashRouter 的全部 path 字面量。 */
export function extractRoutePathsFromSource(sourceText: string, fileName = 'Routes.tsx'): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const paths: string[] = []
  let routerCallFound = false

  function collectPathsInRouter(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      readPropertyName(node.name) === 'path' &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      paths.push(node.initializer.text)
    }
    ts.forEachChild(node, collectPathsInRouter)
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createHashRouter'
    ) {
      routerCallFound = true
      for (const arg of node.arguments) {
        collectPathsInRouter(arg)
      }
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  if (!routerCallFound) {
    throw new Error(`未在 ${fileName} 中找到 createHashRouter(...) 路由定义`)
  }
  return paths
}

function readPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text
  }
  return undefined
}

/** 读取仓库中真实的 PublicRpcMethod 名称列表。 */
export function extractActualRpcMethods(): string[] {
  return Object.keys(RpcMethods)
}

/** 读取并解析仓库 Routes.tsx 中声明的全部路由 path 字面量。 */
export function extractActualRoutes(routesFilePath = DEFAULT_ROUTES_PATH): string[] {
  const sourceText = readFileSync(routesFilePath, 'utf8')
  return extractRoutePathsFromSource(sourceText, routesFilePath)
}

interface DimensionDiff {
  readonly missing: readonly string[]
  readonly stale: readonly string[]
  readonly duplicates: readonly string[]
  readonly invalidExemptions: readonly string[]
}

function evaluateDimensionCoverage(
  actualItems: readonly string[],
  featureItemsList: ReadonlyArray<readonly string[]>,
  exemptions: readonly FeatureExemption[],
  dimensionLabel: string,
): DimensionDiff {
  const actualSet = new Set(actualItems)
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  const stale = new Set<string>()
  const invalidExemptions: string[] = []

  for (const items of featureItemsList) {
    for (const item of items) {
      if (seen.has(item)) {
        duplicates.add(item)
      }
      seen.add(item)
      if (!actualSet.has(item)) {
        stale.add(item)
      }
    }
  }

  for (const exemption of exemptions) {
    if (!exemption.reason.trim()) {
      invalidExemptions.push(`${dimensionLabel}:${exemption.target}`)
    }
    if (seen.has(exemption.target)) {
      duplicates.add(exemption.target)
    }
    seen.add(exemption.target)
    if (!actualSet.has(exemption.target)) {
      stale.add(exemption.target)
    }
  }

  const missing = actualItems.filter((item) => !seen.has(item))

  return {
    missing,
    stale: [...stale],
    duplicates: [...duplicates],
    invalidExemptions,
  }
}

/** 验证 Feature Map 对 RPC 方法与桌面端路由的覆盖率、唯一性与有效性。 */
export function verifyFeatureMapCoverage(
  input: VerifyFeatureMapInput = {},
): FeatureMapCoverageReport {
  const features = input.features ?? FEATURE_MAP
  const exemptRpcMethods = input.exemptRpcMethods ?? EXEMPT_RPC_METHODS
  const exemptRoutes = input.exemptRoutes ?? EXEMPT_ROUTES
  const actualRpcMethods = input.actualRpcMethods ?? extractActualRpcMethods()
  const actualRoutes = input.actualRoutes ?? extractActualRoutes()
  const registeredDesktopCommands =
    input.registeredDesktopCommands ?? new Set(Object.keys(DESKTOP_COMMAND_MAP))

  const seenFeatureIds = new Set<string>()
  const duplicateFeatureIds = new Set<string>()
  const invalidFeatureIds = new Set<string>()
  const missingDesktopFeatures: string[] = []
  const unmappedDesktopScenarios: string[] = []

  for (const feature of features) {
    if (seenFeatureIds.has(feature.id)) {
      duplicateFeatureIds.add(feature.id)
    }
    seenFeatureIds.add(feature.id)
    if (!KEBAB_CASE_PATTERN.test(feature.id)) {
      invalidFeatureIds.add(feature.id)
    }
    const desktopScenarios = feature.scenarios.filter((scenario) => scenario.mode === 'desktop')
    if (desktopScenarios.length === 0) {
      missingDesktopFeatures.push(feature.id)
      continue
    }
    for (const scenario of desktopScenarios) {
      if (!scenario.command || !registeredDesktopCommands.has(scenario.command)) {
        unmappedDesktopScenarios.push(
          `${feature.id}/${scenario.id}:${scenario.command ?? '(missing command)'}`,
        )
      }
    }
  }

  const rpcDiff = evaluateDimensionCoverage(
    actualRpcMethods,
    features.map((feature) => feature.rpcMethods),
    exemptRpcMethods,
    'rpc',
  )
  const routeDiff = evaluateDimensionCoverage(
    actualRoutes,
    features.map((feature) => feature.routes),
    exemptRoutes,
    'route',
  )

  const invalidExemptions = [...rpcDiff.invalidExemptions, ...routeDiff.invalidExemptions]
  const ok =
    rpcDiff.missing.length === 0 &&
    rpcDiff.stale.length === 0 &&
    rpcDiff.duplicates.length === 0 &&
    routeDiff.missing.length === 0 &&
    routeDiff.stale.length === 0 &&
    routeDiff.duplicates.length === 0 &&
    duplicateFeatureIds.size === 0 &&
    invalidFeatureIds.size === 0 &&
    invalidExemptions.length === 0 &&
    missingDesktopFeatures.length === 0 &&
    unmappedDesktopScenarios.length === 0

  return {
    ok,
    featureCount: features.length,
    rpcMethodCount: actualRpcMethods.length,
    routeCount: actualRoutes.length,
    missingRpcMethods: rpcDiff.missing,
    staleRpcMethods: rpcDiff.stale,
    duplicateRpcMethods: rpcDiff.duplicates,
    missingRoutes: routeDiff.missing,
    staleRoutes: routeDiff.stale,
    duplicateRoutes: routeDiff.duplicates,
    duplicateFeatureIds: [...duplicateFeatureIds],
    invalidFeatureIds: [...invalidFeatureIds],
    invalidExemptions,
    missingDesktopFeatures,
    unmappedDesktopScenarios,
  }
}

function formatReport(report: FeatureMapCoverageReport): string {
  const lines = [
    `[feature-map] 覆盖率检查${report.ok ? '通过' : '失败'}：${report.featureCount} 个功能域，${report.rpcMethodCount} 个公开 RPC 方法，${report.routeCount} 条路由`,
  ]
  const sections: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['未映射的 RPC 方法', report.missingRpcMethods],
    ['已过期的 RPC 方法', report.staleRpcMethods],
    ['重复映射的 RPC 方法', report.duplicateRpcMethods],
    ['未映射的路由', report.missingRoutes],
    ['已过期的路由', report.staleRoutes],
    ['重复映射的路由', report.duplicateRoutes],
    ['重复的 feature ID', report.duplicateFeatureIds],
    ['非 kebab-case 的 feature ID', report.invalidFeatureIds],
    ['缺少豁免原因的条目', report.invalidExemptions],
    ['缺少 desktop 场景的 feature', report.missingDesktopFeatures],
    ['未注册可执行命令的 desktop 场景', report.unmappedDesktopScenarios],
  ]
  for (const [label, items] of sections) {
    if (items.length > 0) {
      lines.push(`- ${label} (${items.length}): ${items.join(', ')}`)
    }
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const jsonOutput = process.argv.includes('--json')
  const report = verifyFeatureMapCoverage()
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatReport(report)}\n`)
  }
  if (!report.ok) {
    process.exitCode = 1
  }
}
