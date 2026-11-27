import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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

  test('project lint rejects retired startup paths and desktop regressions', async () => {
    const repoRoot = resolve(import.meta.dir, '../..')
    const dir = await mkdtemp(join(tmpdir(), 'pidex-startup-lint-'))
    try {
      const config = JSON.parse(await readFile(join(repoRoot, '.oxlintrc.json'), 'utf8'))
      config.jsPlugins = config.jsPlugins.map((path: string) => resolve(repoRoot, path))
      await writeFile(join(dir, '.oxlintrc.json'), JSON.stringify(config))
      const fixtures = {
        'apps/desktop/renderer/src/features/settings/ArchivedConversationsSettings.tsx': [
          'export const remove = (client, id) => client.disposeSession(id)',
          'export const guarded = (client, id) => client.deleteArchivedSession(id)',
        ],
        'apps/desktop/renderer/src/services/desktop-client/AgentSessionClient.ts': [
          'export const sessions = { deleteArchivedSession: id => rpc.call("thread/delete", id) }',
          'export const fallback = { importUserMemory: lazyMock("exportUserMemory") }',
        ],
        'apps/desktop/renderer/shared/Types.ts': [
          'export type DesktopApi = {',
          '  getRuntimeStatus(): void',
          '  startCopilotLogin: () => void',
          '  openDevTools(): void',
          '  onUiCommand(callback: Function): void',
          '  onSessionStoreChange(callback: Function): void',
          '}',
        ],
        'apps/desktop/renderer/src/services/desktop-client/LazyBrowserMockClient.ts': [
          'export const subscriptions = new Set(["onWorkflowEvent", "onSessionStoreChange"])',
        ],
        'apps/desktop/electron/src/windows/Appearance.ts': [
          'export function notify(contents, theme) {',
          '  contents.send("appearance:settings:changed", theme)',
          '  contents.send("appearance:system-theme:changed", theme)',
          '  contents.openDevTools()',
          '}',
        ],
        'apps/agent/src/transport/rpc/handlers/Thread.ts': [
          'export function dispatch(method, id, history) { switch (method) {',
          'case "thread/deleteArchived": return history.remove(id)',
          'case "thread/delete": return history.remove(id)',
          '} }',
        ],
        'apps/agent/src/session/ThreadHistoryService.ts': [
          'export class History { remove(id, scope) {',
          '  const item = this.getListItem(id)',
          '  if (scope === "archived" && (item?.archivedAt ?? 0) <= 0) return null',
          '  return this.db.transaction(() => this.db.query("DELETE FROM threads WHERE id = ?").run(id))',
          '} }',
        ],
        'apps/desktop/electron/src/settings/AppearanceSettingsStore.ts': [
          'export class Store {',
          '  #filePath = "appearance-settings.json"',
          '  reset() { return rm(this.#filePath) }',
          '  async save(value) { await this.#writeAtomically(value) }',
          '  #writeAtomically(value) { return persist(value) }',
          '  async #assertExistingVersionWritable() { try { JSON.parse(await readFile(this.#filePath)) }',
          '    catch (error) { if (!isMissingFileError(error) && !(error instanceof SyntaxError)) throw error } }',
          '}',
        ],
        'apps/desktop/renderer/src/features/speech/VoiceRecordingCache.ts': [
          'export function formatShortcutFromKeyboardEvent(event) { return event.key }',
          'export function matchesVoiceShortcut(event, binding) { return event.key === binding }',
          'function isTypingCharacter(event) { return event.key.length === 1 && !event.shiftKey }',
        ],
        'apps/desktop/electron/src/terminal/ShellProfileService.ts': [
          'export function findGitBash(env) { return findOnPath("bash.exe", env) }',
        ],
        'apps/desktop/renderer/src/features/automation/CalendarFixture.tsx': [
          'export const day = new Intl.DateTimeFormat("zh-CN")',
          'export const relative = Intl.RelativeTimeFormat()',
          'export const local = new Date().toLocaleString()',
          'export const configured = locale => new Intl.DateTimeFormat(locale)',
          'export const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone',
        ],
        'apps/agent/src/provider/ProviderError.ts': [
          'export const fromText = cause => /HTTP (\\d{3})/.exec(cause.message)',
          'export const implicit = cause => providerFailureCategory(cause)',
          'export const structured = cause => providerHttpErrorStatus(cause, "response")',
        ],
        'apps/agent/src/provider/ModelHealthService.ts': [
          'export const limited = message => /rate.limit|429/i.test(message)',
          'export function status(message, source) {',
          '  if (source === "sdk-message") return /HTTP (\\d{3})/.exec(message)',
          '  return /HTTP (\\d{3})/.exec(message)',
          '}',
        ],
        'apps/agent/src/provider/runtime/ProviderConfigMigration.ts': [
          'export const migrateBuiltin = (raw, key) => {',
          '  unsupportedKeys(raw, BUILTIN_PROVIDER_CONFIG_KEYS)',
          '  unsupportedKeys(raw, BUILTIN_ALLOWED)',
          '  return key !== "enabled"',
          '}',
        ],
        'apps/agent/src/project/ProjectSourceService.ts': [
          'export class ProjectSourceService { removeAll() {} remove() {} }',
        ],
        'apps/agent/src/storage/repositories/ProjectRepository.ts': [
          'export class ProjectRepositoryDatabase {',
          '  removeProjectRecord() {}',
          '  requireProjectForRemoval() {}',
          '}',
        ],
        'apps/agent/src/storage/repositories/ExecutionRepository.ts': [
          'export class ExecutionRepositoryDatabase { takeGuideMailbox() {} guideMailbox() {} }',
        ],
        'apps/agent/src/provider/runtime/ModelService.ts': [
          'export class ModelService { discoverModels() {} discoverBuiltinModels() {} }',
        ],
        'apps/desktop/electron/src/settings/DataLocationStore.ts': [
          'export function load(error, value) {',
          '  if (isMissingFileError(error)) return {version: 1, activeDataDir: null}',
          '  if (value.version !== 1) return {version: 1, activeDataDir: null}',
          '  try { return read(value) } catch { return {version: 1, activeDataDir: null} }',
          '}',
        ],
        'apps/desktop/renderer/src/main.tsx': [
          'export const retry = bridge => bridge.retryStartup(1)',
        ],
        'apps/desktop/renderer/src/features/routing/ConnectionLostPage.tsx': [
          'export const retry = bridge => bridge.retryDataLocation()',
          'export const restore = bridge => bridge.restoreDataLocation()',
        ],
        'apps/desktop/renderer/src/features/workspace/UseWorkspaceState.ts': [
          'export const start = client => {',
          '  client.getAuthStatus()',
          '  return setInterval(() => client.getRuntimeStatus(), 5000)',
          '}',
        ],
        'apps/desktop/renderer/shared/IpcChannels.ts': ['export {}'],
        'apps/desktop/renderer/shared/DesktopBridgeArgs.ts': ['export {}'],
        'apps/desktop/renderer/shared/CurrentBridge.ts': [
          'export const channel = "desktop:settings-change"',
          'export const genericChannel = method => `desktop:${method}`',
          'export const undefinedMarker = "__desktopBrowserDebugUndefined"',
        ],
      }
      for (const [path, lines] of Object.entries(fixtures)) {
        const file = join(dir, path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, lines.join('\n'))
      }
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, 'node_modules/oxlint/bin/oxlint'), '--format=json', 'apps'],
        { cwd: dir, encoding: 'utf8' },
      )
      expect(result.status).toBe(1)
      const errors = parseOxlintJsonOutput(result.stdout).filter(
        (item) => item.severity === 'error',
      )
      expect(
        errors
          .map((item) => [item.code, basename(item.filename ?? ''), item.labels?.[0]?.span?.line])
          .sort(),
      ).toEqual(
        [
          ['pidex-regressions(guard-archived-deletion)', 'ArchivedConversationsSettings.tsx', 1],
          ['pidex-regressions(guard-archived-deletion)', 'AgentSessionClient.ts', 1],
          ['pidex-compat(no-retired-desktop-member)', 'AgentSessionClient.ts', 2],
          ['pidex-compat(no-retired-desktop-member)', 'AgentSessionClient.ts', 2],
          ['pidex-compat(no-retired-desktop-member)', 'Types.ts', 2],
          ['pidex-compat(no-retired-desktop-member)', 'Types.ts', 3],
          ['pidex-compat(no-retired-desktop-member)', 'Types.ts', 4],
          ['pidex-compat(no-retired-desktop-member)', 'Types.ts', 5],
          ['pidex-compat(no-retired-desktop-member)', 'LazyBrowserMockClient.ts', 1],
          ['pidex-compat(no-retired-appearance-channel)', 'Appearance.ts', 2],
          ['pidex-regressions(guard-archived-deletion)', 'Thread.ts', 2],
          ['pidex-regressions(guard-archived-deletion)', 'ThreadHistoryService.ts', 1],
          ['pidex-regressions(preserve-corrupt-appearance)', 'AppearanceSettingsStore.ts', 3],
          ['pidex-regressions(preserve-corrupt-appearance)', 'AppearanceSettingsStore.ts', 4],
          ['pidex-regressions(preserve-corrupt-appearance)', 'AppearanceSettingsStore.ts', 6],
          ['pidex-regressions(preserve-typing-shortcuts)', 'VoiceRecordingCache.ts', 1],
          ['pidex-regressions(preserve-typing-shortcuts)', 'VoiceRecordingCache.ts', 2],
          ['pidex-regressions(preserve-typing-shortcuts)', 'VoiceRecordingCache.ts', 3],
          ['pidex-regressions(discover-user-git-bash)', 'ShellProfileService.ts', 1],
          ['pidex-regressions(use-interface-date-locale)', 'CalendarFixture.tsx', 1],
          ['pidex-regressions(use-interface-date-locale)', 'CalendarFixture.tsx', 2],
          ['pidex-regressions(use-interface-date-locale)', 'CalendarFixture.tsx', 3],
          ['pidex-regressions(use-response-status)', 'ProviderError.ts', 1],
          ['pidex-regressions(use-response-status)', 'ProviderError.ts', 2],
          ['pidex-regressions(use-response-status)', 'ModelHealthService.ts', 1],
          ['pidex-regressions(use-response-status)', 'ModelHealthService.ts', 4],
          ['pidex-compat(builtin-migration-schema)', 'ProviderConfigMigration.ts', 3],
          ['pidex-compat(no-retired-agent-entry)', 'ProjectSourceService.ts', 1],
          ['pidex-compat(no-retired-agent-entry)', 'ProjectRepository.ts', 2],
          ['pidex-compat(no-retired-agent-entry)', 'ProjectRepository.ts', 3],
          ['pidex-compat(no-retired-agent-entry)', 'ExecutionRepository.ts', 1],
          ['pidex-compat(no-retired-agent-entry)', 'ModelService.ts', 1],
          ['pidex-compat(builtin-migration-schema)', 'ProviderConfigMigration.ts', 4],
          ['pidex-compat(data-location-default-on-enoent)', 'DataLocationStore.ts', 3],
          ['pidex-compat(data-location-default-on-enoent)', 'DataLocationStore.ts', 4],
          ['eslint(no-restricted-properties)', 'UseWorkspaceState.ts', 2],
          ['eslint(no-restricted-properties)', 'main.tsx', 1],
          ['eslint(no-restricted-properties)', 'ConnectionLostPage.tsx', 1],
          ['eslint(no-restricted-properties)', 'ConnectionLostPage.tsx', 2],
          ['eslint(no-restricted-properties)', 'UseWorkspaceState.ts', 3],
          ['pidex-compat(no-retired-desktop-bridge)', 'IpcChannels.ts', 1],
          ['pidex-compat(no-retired-desktop-bridge)', 'DesktopBridgeArgs.ts', 1],
          ['pidex-compat(no-retired-desktop-bridge)', 'CurrentBridge.ts', 2],
          ['pidex-compat(no-retired-desktop-bridge)', 'CurrentBridge.ts', 3],
        ].sort(),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
        'apps/agent/src/provider/runtime/BuiltinProviderOverrides.ts': [
          'export function withBuiltinProviderOverrides(source: any, config: any, catalog?: any) {',
          '  const configuredExtraIds = catalog ? [] : [...Object.keys(config.models), ...config.allowModels]',
          '  const changedApi = (model: any) => {',
          '    if (catalog) return false',
          '    return Boolean(model)',
          '  }',
          '  return { source, configuredExtraIds, changedApi }',
          '}',
        ].join('\n'),
        'apps/agent/src/provider/runtime/ModelService.ts': [
          'export class ModelService {',
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
