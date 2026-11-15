import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const MANIFEST_PATH = join(import.meta.dir, 'lint-ratchet-manifest.json')
const OXLINT_ARGS = [
  'x',
  'oxlint',
  '--config',
  '.oxlintrc.json',
  'apps',
  'packages',
  'scripts',
  '--format=json',
]

/** Source span coordinates emitted inside an oxlint diagnostic label. */
export interface LintDiagnosticSpan {
  line?: number
  column?: number
  offset?: number
  length?: number
}

/** Label attachment on an oxlint diagnostic. */
export interface LintDiagnosticLabel {
  label?: string
  span?: LintDiagnosticSpan
}

/** Single diagnostic item emitted by `oxlint --format=json`. */
export interface LintDiagnostic {
  message: string
  code: string
  severity: string
  filename?: string
  url?: string
  help?: string
  labels?: LintDiagnosticLabel[]
}

/** Persisted per-rule warning budget manifest for oxlint ratcheting. */
export interface LintRatchetManifest {
  /** Maximum allowed warning count per oxlint rule code. */
  ruleBudgets: Record<string, number>
}

/** Category of a lint ratchet check failure. */
export type LintRatchetViolationKind = 'error-diagnostic' | 'unexpected-rule' | 'budget-exceeded'

/** Single failing condition detected during lint ratchet evaluation. */
export interface LintRatchetViolation {
  kind: LintRatchetViolationKind
  code: string
  message: string
  file?: string
  line?: number
  column?: number
  budget?: number
  actual?: number
}

/** Non-fatal ratchet shrink notice when rule warnings drop below budget. */
export interface LintRatchetNotice {
  code: string
  budget: number
  actual: number
  message: string
}

/** Aggregated evaluation output from {@link evaluateLintRatchet}. */
export interface LintRatchetReport {
  violations: LintRatchetViolation[]
  notices: LintRatchetNotice[]
  errorCount: number
  warningCount: number
  observedWarningCounts: Record<string, number>
  computedManifest: LintRatchetManifest
}

/** Sorts a rule-count map lexicographically and omits non-positive entries. */
export function sortRuleBudgets(record: Record<string, number>): Record<string, number> {
  const sorted: Record<string, number> = {}
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      sorted[key] = value
    }
  }
  return sorted
}

/** Parses JSON diagnostics from `oxlint --format=json` stdout. */
export function parseOxlintJsonOutput(stdout: string): LintDiagnostic[] {
  const jsonStart = stdout.indexOf('{')
  if (jsonStart < 0) {
    throw new Error('oxlint output did not contain a JSON payload.')
  }
  const parsed = JSON.parse(stdout.slice(jsonStart)) as { diagnostics?: unknown }
  if (!Array.isArray(parsed.diagnostics)) {
    throw new Error('oxlint JSON payload is missing a diagnostics array.')
  }
  return parsed.diagnostics as LintDiagnostic[]
}

/** Evaluates parsed oxlint diagnostics against an optional per-rule ratchet manifest. */
export function evaluateLintRatchet(
  diagnostics: readonly LintDiagnostic[],
  manifest?: LintRatchetManifest,
): LintRatchetReport {
  const violations: LintRatchetViolation[] = []
  const notices: LintRatchetNotice[] = []
  const rawWarningCounts: Record<string, number> = {}
  let errorCount = 0
  let warningCount = 0

  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') {
      errorCount += 1
      const firstSpan = diagnostic.labels?.[0]?.span
      violations.push({
        kind: 'error-diagnostic',
        code: diagnostic.code,
        message: diagnostic.message,
        file: diagnostic.filename,
        line: firstSpan?.line,
        column: firstSpan?.column,
      })
      continue
    }

    if (diagnostic.severity === 'warning') {
      warningCount += 1
      rawWarningCounts[diagnostic.code] = (rawWarningCounts[diagnostic.code] ?? 0) + 1
    }
  }

  const observedWarningCounts = sortRuleBudgets(rawWarningCounts)
  const computedManifest: LintRatchetManifest = {
    ruleBudgets: observedWarningCounts,
  }

  if (manifest) {
    const normalizedBudgets = manifest.ruleBudgets ?? {}
    for (const [code, actual] of Object.entries(observedWarningCounts)) {
      if (!(code in normalizedBudgets)) {
        violations.push({
          kind: 'unexpected-rule',
          code,
          actual,
          message: `Unexpected oxlint warning rule "${code}" (observed ${actual}) is not budgeted in lint-ratchet-manifest.json.`,
        })
        continue
      }

      const budget = normalizedBudgets[code] ?? 0
      if (actual > budget) {
        const delta = actual - budget
        violations.push({
          kind: 'budget-exceeded',
          code,
          budget,
          actual,
          message: `Warning count for "${code}" exceeded ratchet budget: observed ${actual} > budget ${budget} (+${delta}).`,
        })
      } else if (actual < budget) {
        const reduction = budget - actual
        notices.push({
          code,
          budget,
          actual,
          message: `Warning count for "${code}" shrank: ${budget} -> ${actual} (-${reduction}); run --update-ratchets to tighten budget.`,
        })
      }
    }

    for (const [code, budget] of Object.entries(normalizedBudgets).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (budget > 0 && !(code in observedWarningCounts)) {
        notices.push({
          code,
          budget,
          actual: 0,
          message: `Warning count for "${code}" cleared: ${budget} -> 0 (-${budget}); run --update-ratchets to tighten budget.`,
        })
      }
    }
  }

  return {
    violations,
    notices,
    errorCount,
    warningCount,
    observedWarningCounts,
    computedManifest,
  }
}

/** Formats a human-readable report for a {@link LintRatchetReport}. */
export function formatLintRatchetReport(report: LintRatchetReport): string {
  const ruleCount = Object.keys(report.observedWarningCounts).length
  const lines: string[] = [
    `Lint ratchet checked: ${report.errorCount} error(s), ${report.warningCount} warning(s) across ${ruleCount} rule(s).`,
  ]

  for (const notice of report.notices) {
    lines.push(`[SHRINK] ${notice.message}`)
  }

  for (const violation of report.violations) {
    if (violation.kind === 'error-diagnostic') {
      const location = violation.file
        ? violation.line !== undefined
          ? `${violation.file}:${violation.line}:${violation.column ?? 1}`
          : violation.file
        : '<unknown>'
      lines.push(`[FAIL] [error] ${violation.code} at ${location}: ${violation.message}`)
    } else {
      lines.push(`[FAIL] ${violation.message}`)
    }
  }

  return lines.join('\n')
}

async function readManifest(path: string): Promise<LintRatchetManifest> {
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as Partial<LintRatchetManifest>
  const ruleBudgets: Record<string, number> = {}
  if (parsed.ruleBudgets && typeof parsed.ruleBudgets === 'object') {
    for (const [key, value] of Object.entries(parsed.ruleBudgets)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        ruleBudgets[key] = value
      }
    }
  }
  return { ruleBudgets }
}

function runOxlintDiagnostics(rootDir: string): {
  status: number | null
  diagnostics: LintDiagnostic[]
} {
  const result = spawnSync('bun', OXLINT_ARGS, {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  if (result.error) {
    throw result.error
  }

  const stdout = result.stdout ?? ''
  if (!stdout.includes('{')) {
    const stderr = (result.stderr ?? '').trim()
    throw new Error(
      `oxlint failed with exit status ${result.status ?? 'unknown'} without JSON output.${stderr ? ` stderr: ${stderr}` : ''}`,
    )
  }

  return {
    status: result.status,
    diagnostics: parseOxlintJsonOutput(stdout),
  }
}

function tightenManifest(
  current: LintRatchetManifest,
  observedWarningCounts: Record<string, number>,
): LintRatchetManifest {
  const tightened: Record<string, number> = {}
  for (const code of Object.keys(current.ruleBudgets)) {
    const observed = observedWarningCounts[code] ?? 0
    if (observed > 0) {
      tightened[code] = Math.min(current.ruleBudgets[code] ?? 0, observed)
    }
  }
  return { ruleBudgets: sortRuleBudgets(tightened) }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const updateRatchets = args.has('--update-ratchets')
  const initBaseline = args.has('--init-baseline')

  const { status, diagnostics } = runOxlintDiagnostics(REPO_ROOT)

  if (initBaseline) {
    const report = evaluateLintRatchet(diagnostics)
    if (report.errorCount > 0 || (status !== 0 && report.errorCount === 0)) {
      console.error(formatLintRatchetReport(report))
      console.error('Refusing to initialize lint ratchet baseline while oxlint errors exist.')
      process.exit(1)
    }
    await writeFile(MANIFEST_PATH, `${JSON.stringify(report.computedManifest, null, 2)}\n`, 'utf8')
    console.log(`Initialized ${MANIFEST_PATH}`)
    console.log(formatLintRatchetReport(report))
    return
  }

  let manifest: LintRatchetManifest
  try {
    manifest = await readManifest(MANIFEST_PATH)
  } catch (error) {
    console.error(
      `Failed to read lint ratchet manifest at ${MANIFEST_PATH}. Run with --init-baseline first.`,
    )
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const report = evaluateLintRatchet(diagnostics, manifest)
  const output = formatLintRatchetReport(report)

  if (report.violations.length > 0) {
    console.error(output)
    if (updateRatchets) {
      console.error(
        'Refusing to update lint ratchets while error diagnostics or budget regressions exist.',
      )
    }
    process.exit(1)
  }

  if (status !== 0) {
    console.error(output)
    console.error(`oxlint exited with status ${status} despite zero parsed error diagnostics.`)
    process.exit(1)
  }

  if (updateRatchets) {
    const tightened = tightenManifest(manifest, report.observedWarningCounts)
    await writeFile(MANIFEST_PATH, `${JSON.stringify(tightened, null, 2)}\n`, 'utf8')
    console.log(`Updated ${MANIFEST_PATH}`)
  }

  console.log(output)
}

if (import.meta.main) {
  await main()
}
