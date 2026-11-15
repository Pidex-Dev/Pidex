import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hashNormalizedTsSource,
  runTlaChecks,
  updateBindingManifest,
  validateTlaSpecPair,
  verifyBindingManifest,
} from './CheckTlaSpecs'

const tempDirs: string[] = []
const savedEnv = {
  PIDEX_REQUIRE_TLC: process.env.PIDEX_REQUIRE_TLC,
  TLA2TOOLS_JAR: process.env.TLA2TOOLS_JAR,
}

afterEach(() => {
  if (savedEnv.PIDEX_REQUIRE_TLC === undefined) delete process.env.PIDEX_REQUIRE_TLC
  else process.env.PIDEX_REQUIRE_TLC = savedEnv.PIDEX_REQUIRE_TLC

  if (savedEnv.TLA2TOOLS_JAR === undefined) delete process.env.TLA2TOOLS_JAR
  else process.env.TLA2TOOLS_JAR = savedEnv.TLA2TOOLS_JAR

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const createMinimalTlaFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'pidex-tla-test-'))
  tempDirs.push(root)
  const specsDir = join(root, 'specs', 'tla')
  const srcDir = join(root, 'apps', 'agent', 'src')
  mkdirSync(specsDir, { recursive: true })
  mkdirSync(srcDir, { recursive: true })

  const writeSpecPair = (name: string) => {
    writeFileSync(
      join(specsDir, `${name}.tla`),
      [
        `---- MODULE ${name} ----`,
        'EXTENDS Naturals',
        'CONSTANTS MaxN',
        'VARIABLES x',
        'Init == x = 0',
        "Next == x < MaxN /\\ x' = x + 1",
        'Spec == Init /\\ [][Next]_x',
        'TypeOK == x \\in 0..MaxN',
        '====',
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(specsDir, `${name}.cfg`),
      ['SPECIFICATION Spec', 'CONSTANTS MaxN = 2', 'INVARIANTS TypeOK', ''].join('\n'),
      'utf8',
    )
  }

  writeSpecPair('RpcOutboxSseReplay')
  writeSpecPair('ApprovalInterruptRecovery')

  const fileA = 'apps/agent/src/OutboxA.ts'
  const fileB = 'apps/agent/src/ApprovalB.ts'
  writeFileSync(join(root, fileA), 'export const outboxStep = (n: number) => n + 1\n', 'utf8')
  writeFileSync(join(root, fileB), 'export const approvalStep = (ok: boolean) => !ok\n', 'utf8')

  const manifestPath = join(specsDir, 'tla-binding-manifest.json')
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        normalization: 'ts-ast-no-comments-lf-sha256',
        specs: {
          RpcOutboxSseReplay: {
            files: {
              [fileA]: hashNormalizedTsSource(readFileSync(join(root, fileA), 'utf8'), fileA),
            },
          },
          ApprovalInterruptRecovery: {
            files: {
              [fileB]: hashNormalizedTsSource(readFileSync(join(root, fileB), 'utf8'), fileB),
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return { root, specsDir, manifestPath, fileA, fileB }
}

describe('CheckTlaSpecs', () => {
  test('validateTlaSpecPair validates matching module, specification, invariants, and constants', () => {
    const { specsDir } = createMinimalTlaFixture()
    const valid = validateTlaSpecPair(
      'RpcOutboxSseReplay',
      join(specsDir, 'RpcOutboxSseReplay.tla'),
      join(specsDir, 'RpcOutboxSseReplay.cfg'),
    )
    expect(valid.errors).toEqual([])
    expect(valid.moduleName).toBe('RpcOutboxSseReplay')
    expect(valid.specification).toBe('Spec')
    expect(valid.invariants).toEqual(['TypeOK'])
    expect(valid.constants).toEqual(['MaxN'])

    writeFileSync(
      join(specsDir, 'BrokenSpec.tla'),
      '---- MODULE WrongName ----\nVARIABLES x\nSpec == TRUE\n====\n',
      'utf8',
    )
    writeFileSync(
      join(specsDir, 'BrokenSpec.cfg'),
      'SPECIFICATION Spec\nINVARIANTS MissingInv\n',
      'utf8',
    )
    const invalid = validateTlaSpecPair(
      'BrokenSpec',
      join(specsDir, 'BrokenSpec.tla'),
      join(specsDir, 'BrokenSpec.cfg'),
    )
    expect(invalid.errors.some((err) => err.includes('does not match filename stem'))).toBe(true)
    expect(invalid.errors.some((err) => err.includes('MissingInv'))).toBe(true)

    const missing = validateTlaSpecPair(
      'Missing',
      join(specsDir, 'Missing.tla'),
      join(specsDir, 'Missing.cfg'),
    )
    expect(missing.errors[0]).toContain('Missing TLA+ file')
  })

  test('PIDEX_REQUIRE_TLC=1 fails when tla2tools.jar is missing while default mode passes with notice', () => {
    const { root, specsDir } = createMinimalTlaFixture()
    delete process.env.TLA2TOOLS_JAR
    delete process.env.PIDEX_REQUIRE_TLC

    const relaxed = runTlaChecks(specsDir, root)
    expect(relaxed.ok).toBe(true)
    expect(relaxed.tlcRan).toBe(false)

    process.env.PIDEX_REQUIRE_TLC = '1'
    const strictViaEnv = runTlaChecks(specsDir, root)
    expect(strictViaEnv.ok).toBe(false)
    expect(strictViaEnv.tlcRan).toBe(false)

    delete process.env.PIDEX_REQUIRE_TLC
    const strictViaOption = runTlaChecks(specsDir, root, { requireTlc: true })
    expect(strictViaOption.ok).toBe(false)
    expect(strictViaOption.tlcRan).toBe(false)
  })

  test('source normalization hash is deterministic across CRLF, LF, and comment-only edits', () => {
    const lf = 'export function f(x: number): number {\n  return x + 1\n}\n'
    const crlf = lf.replace(/\n/g, '\r\n')
    const commented =
      '// leading note\nexport function f(x: number): number {\r\n  return x + 1 /* inline */\r\n}\r\n'
    const modified = 'export function f(x: number): number {\n  return x + 2\n}\n'

    const hLf = hashNormalizedTsSource(lf, 'sample.ts')
    const hCrlf = hashNormalizedTsSource(crlf, 'sample.ts')
    const hCommented = hashNormalizedTsSource(commented, 'sample.ts')
    const hModified = hashNormalizedTsSource(modified, 'sample.ts')

    expect(hCrlf).toBe(hLf)
    expect(hCommented).toBe(hLf)
    expect(hModified).not.toBe(hLf)
  })

  test('binding manifest passes on match, fails with clear diagnostic on TS drift, and updates cleanly with LF', () => {
    const { root, specsDir, manifestPath, fileA } = createMinimalTlaFixture()

    const initial = runTlaChecks(specsDir, root, { skipTlc: true })
    expect(initial.ok).toBe(true)
    expect(initial.bindingErrors).toEqual([])

    writeFileSync(join(root, fileA), 'export const outboxStep = (n: number) => n + 2\n', 'utf8')
    const drifted = runTlaChecks(specsDir, root, { skipTlc: true })
    expect(drifted.ok).toBe(false)
    expect(drifted.bindingErrors.length).toBe(1)
    expect(drifted.bindingErrors[0]).toContain('RpcOutboxSseReplay')
    expect(drifted.bindingErrors[0]).toContain(fileA)

    const updated = runTlaChecks(specsDir, root, { updateBindings: true, skipTlc: true })
    expect(updated.ok).toBe(true)
    const rawManifest = readFileSync(manifestPath, 'utf8')
    expect(rawManifest.includes('\r\n')).toBe(false)
    expect(rawManifest.endsWith('\n')).toBe(true)

    const verifiedAfterUpdate = verifyBindingManifest(manifestPath, root, [
      'RpcOutboxSseReplay',
      'ApprovalInterruptRecovery',
    ])
    expect(verifiedAfterUpdate.ok).toBe(true)

    const directUpdate = updateBindingManifest(manifestPath, root, [
      'RpcOutboxSseReplay',
      'ApprovalInterruptRecovery',
    ])
    expect(directUpdate.ok).toBe(true)
    expect(readFileSync(manifestPath, 'utf8')).toBe(rawManifest)
  })
})
