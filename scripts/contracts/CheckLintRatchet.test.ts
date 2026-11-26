import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  evaluateLintRatchet,
  formatLintRatchetReport,
  parseOxlintJsonOutput,
  sortRuleBudgets,
  type LintDiagnostic,
  type LintRatchetManifest,
} from './CheckLintRatchet'

function makeDiagnostic(overrides: Partial<LintDiagnostic> = {}): LintDiagnostic {
  return {
    message: 'Sample diagnostic message',
    code: 'eslint(no-unused-vars)',
    severity: 'warning',
    filename: 'apps/agent/src/Example.ts',
    labels: [{ span: { line: 12, column: 7 } }],
    ...overrides,
  }
}

describe('CheckLintRatchet', () => {
  test('parseOxlintJsonOutput extracts diagnostics even with leading banner text', () => {
    const raw = [
      'Running oxlint...',
      JSON.stringify({
        diagnostics: [makeDiagnostic({ code: 'import(no-duplicates)' })],
      }),
    ].join('\n')

    const parsed = parseOxlintJsonOutput(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.code).toBe('import(no-duplicates)')
  })

  test('fails immediately when any error-severity diagnostic is present', () => {
    const manifest: LintRatchetManifest = {
      ruleBudgets: {
        'eslint(no-unused-vars)': 2,
      },
    }
    const diagnostics: LintDiagnostic[] = [
      makeDiagnostic({
        code: 'react(rules-of-hooks)',
        severity: 'error',
        filename: 'apps/desktop/renderer/src/Broken.tsx',
        message: 'Hook called conditionally',
        labels: [{ span: { line: 42, column: 5 } }],
      }),
      makeDiagnostic({ code: 'eslint(no-unused-vars)', severity: 'warning' }),
    ]

    const report = evaluateLintRatchet(diagnostics, manifest)
    expect(report.errorCount).toBe(1)
    expect(report.warningCount).toBe(1)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({
      kind: 'error-diagnostic',
      code: 'react(rules-of-hooks)',
      file: 'apps/desktop/renderer/src/Broken.tsx',
      line: 42,
      column: 5,
    })

    const formatted = formatLintRatchetReport(report)
    expect(formatted).toContain('[FAIL] [error] react(rules-of-hooks)')
    expect(formatted).toContain('apps/desktop/renderer/src/Broken.tsx:42:5')
  })

  test('fails on single-rule regression even when total warnings shrink via another rule', () => {
    const manifest: LintRatchetManifest = {
      ruleBudgets: {
        'import(no-duplicates)': 10,
        'eslint(no-unused-vars)': 2,
      },
    }
    const diagnostics: LintDiagnostic[] = [
      makeDiagnostic({ code: 'import(no-duplicates)' }),
      makeDiagnostic({ code: 'eslint(no-unused-vars)' }),
      makeDiagnostic({ code: 'eslint(no-unused-vars)' }),
      makeDiagnostic({ code: 'eslint(no-unused-vars)' }),
    ]

    const report = evaluateLintRatchet(diagnostics, manifest)
    expect(report.warningCount).toBe(4)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({
      kind: 'budget-exceeded',
      code: 'eslint(no-unused-vars)',
      budget: 2,
      actual: 3,
    })
    expect(report.notices).toHaveLength(1)
    expect(report.notices[0]).toMatchObject({
      code: 'import(no-duplicates)',
      budget: 10,
      actual: 1,
    })

    const formatted = formatLintRatchetReport(report)
    expect(formatted).toContain('[SHRINK]')
    expect(formatted).toContain('10 -> 1 (-9)')
    expect(formatted).toContain('[FAIL]')
    expect(formatted).toContain('observed 3 > budget 2 (+1)')
  })

  test('passes and emits shrink notices when rule counts drop or clear to zero', () => {
    const manifest: LintRatchetManifest = {
      ruleBudgets: {
        'eslint(no-unused-vars)': 5,
        'import(no-duplicates)': 3,
      },
    }
    const diagnostics: LintDiagnostic[] = [
      makeDiagnostic({ code: 'eslint(no-unused-vars)' }),
      makeDiagnostic({ code: 'eslint(no-unused-vars)' }),
    ]

    const report = evaluateLintRatchet(diagnostics, manifest)
    expect(report.violations).toEqual([])
    expect(report.notices).toHaveLength(2)
    expect(report.notices).toEqual([
      {
        code: 'eslint(no-unused-vars)',
        budget: 5,
        actual: 2,
        message:
          'Warning count for "eslint(no-unused-vars)" shrank: 5 -> 2 (-3); run --update-ratchets to tighten budget.',
      },
      {
        code: 'import(no-duplicates)',
        budget: 3,
        actual: 0,
        message:
          'Warning count for "import(no-duplicates)" cleared: 3 -> 0 (-3); run --update-ratchets to tighten budget.',
      },
    ])

    const formatted = formatLintRatchetReport(report)
    expect(formatted).toContain('[SHRINK]')
    expect(formatted).not.toContain('[FAIL]')
  })

  test('fails when an unexpected warning rule not present in manifest appears', () => {
    const manifest: LintRatchetManifest = {
      ruleBudgets: {
        'eslint(no-unused-vars)': 2,
      },
    }
    const diagnostics: LintDiagnostic[] = [
      makeDiagnostic({ code: 'eslint(no-unused-vars)' }),
      makeDiagnostic({ code: 'react(jsx-key)' }),
      makeDiagnostic({ code: 'react(jsx-key)' }),
    ]

    const report = evaluateLintRatchet(diagnostics, manifest)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({
      kind: 'unexpected-rule',
      code: 'react(jsx-key)',
      actual: 2,
    })

    const formatted = formatLintRatchetReport(report)
    expect(formatted).toContain('[FAIL] Unexpected oxlint warning rule "react(jsx-key)"')
  })

  test('sortRuleBudgets orders keys deterministically and drops zero counts', () => {
    expect(
      sortRuleBudgets({
        'react(refs)': 4,
        'eslint(no-unused-vars)': 0,
        'import(no-duplicates)': 2,
      }),
    ).toEqual({
      'import(no-duplicates)': 2,
      'react(refs)': 4,
    })
  })

  test('oxlint pidex-models/preserve-configured-models flags catalog-only model regressions as errors', async () => {
    const repoRoot = resolve(import.meta.dir, '../..')
    const pluginPath = resolve(import.meta.dir, 'ModelSelectorLintPlugin.mjs')
    const dir = await mkdtemp(join(tmpdir(), 'pidex-model-selector-lint-'))
    try {
      const files: Record<string, string> = {
        '.oxlintrc.json': JSON.stringify({
          jsPlugins: [pluginPath],
          rules: {
            'pidex-models/preserve-configured-models': 'error',
          },
        }),
        'apps/agent/src/provider/pi/PiBuiltinProviderOverrides.ts': [
          'export function withPiBuiltinProviderOverrides(source: any, config: any, catalog?: any) {',
          '  const configuredExtraIds = catalog ? [] : [...Object.keys(config.models), ...config.allowModels]',
          '  const changedApi = (model: any) => {',
          '    if (catalog) return false',
          '    return Boolean(model)',
          '  }',
          '  return { source, configuredExtraIds, changedApi }',
          '}',
        ].join('\n'),
        'apps/agent/src/provider/pi/PiModelService.ts': [
          'export class PiModelService {',
          '  directoryBaseProviders = new Map<string, any>()',
          '  async models(providerID: string) {',
          '    return this.directoryBaseProviders.get(providerID)?.getModels() ?? []',
          '  }',
          '}',
        ].join('\n'),
        'apps/desktop/renderer/src/features/layout/UseModelProviderController.ts': [
          'export function useModelProviderController(client: any, provider: any) {',
          '  return client.discoverProviderModels({ providerId: provider.providerID })',
          '}',
        ].join('\n'),
      }
      for (const [rel, content] of Object.entries(files)) {
        const target = join(dir, rel)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
      }
      const result = spawnSync(
        'bun',
        [
          'x',
          'oxlint',
          '--config',
          join(dir, '.oxlintrc.json'),
          join(dir, 'apps'),
          '--format=json',
        ],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      )
      expect(result.status).not.toBe(0)
      const diagnostics = parseOxlintJsonOutput(result.stdout ?? '')
      const ruleDiagnostics = diagnostics.filter(
        (d) => d.code === 'pidex-models(preserve-configured-models)' && d.severity === 'error',
      )
      expect(ruleDiagnostics).toHaveLength(4)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
