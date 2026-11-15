import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  evaluateArchContracts,
  formatArchContractReport,
  type ArchContractManifest,
} from './ArchContractsCore'

const EMPTY_MANIFEST: ArchContractManifest = {
  deprecatedBrandRatchet: {},
  useEffectRatchet: {},
  commentRatchet: {},
  bannedCommentRatchet: {},
}

const tempDirs: string[] = []

async function createFixtureRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pidex-arch-contracts-'))
  tempDirs.push(dir)
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf8')
  }
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe('ArchContractsCore boundary isolation', () => {
  test('allows compliant imports across workspaces', async () => {
    const rootDir = await createFixtureRepo({
      'apps/desktop/electron/src/main.ts': [
        "import type { DesktopSettings } from '../../renderer/shared/Types'",
        "import { PROTOCOL } from '@pidex/agent-protocol'",
        'export const ready = Boolean(PROTOCOL)',
      ].join('\n'),
      'apps/desktop/renderer/shared/Types.ts': 'export interface DesktopSettings { ok: boolean }\n',
      'apps/desktop/renderer/src/App.tsx': [
        "import { sharedHelper } from '@pidex/shared'",
        'export function App() { return sharedHelper() }',
      ].join('\n'),
      'apps/agent/src/index.ts': [
        "import { sharedHelper } from '@pidex/shared'",
        'export const ok = sharedHelper()',
      ].join('\n'),
      'packages/shared/src/index.ts': [
        "import { MODEL_ID } from '@pidex/model-schema'",
        'export function sharedHelper() { return MODEL_ID }',
      ].join('\n'),
    })

    const report = await evaluateArchContracts({ rootDir, manifest: EMPTY_MANIFEST })
    expect(report.violations).toEqual([])
  })

  test('fails when electron imports from renderer/src', async () => {
    const rootDir = await createFixtureRepo({
      'apps/desktop/electron/src/main.ts':
        "import { secret } from '../../renderer/src/App'\nexport const x = secret\n",
      'apps/desktop/electron/src/lazy.ts':
        "export async function load() { return import('../../renderer/src/App') }\n",
    })

    const report = await evaluateArchContracts({ rootDir, manifest: EMPTY_MANIFEST })
    expect(report.violations.map((v) => v.rule)).toEqual([
      'boundary/electron-no-renderer-src',
      'boundary/electron-no-renderer-src',
    ])
  })

  test('fails when renderer/src imports electron, agent, or node built-ins', async () => {
    const rootDir = await createFixtureRepo({
      'apps/desktop/renderer/src/Bad.ts': [
        "import { ipcRenderer } from 'electron'",
        "import { readFile } from 'node:fs/promises'",
        "import path from 'path'",
        "import { agentRun } from '../../../agent/src/Runner'",
        "import { mainWin } from '../../electron/src/main'",
        'export const bad = [ipcRenderer, readFile, path, agentRun, mainWin]',
      ].join('\n'),
    })

    const report = await evaluateArchContracts({ rootDir, manifest: EMPTY_MANIFEST })
    expect(report.violations).toHaveLength(5)
    expect(report.violations.every((v) => v.rule === 'boundary/renderer-isolation')).toBe(true)
  })

  test('fails when agent imports from apps/desktop', async () => {
    const rootDir = await createFixtureRepo({
      'apps/agent/src/Bad.ts': [
        "import { win } from '../../desktop/electron/src/main'",
        "import type { DesktopSettings } from '../../desktop/renderer/shared/Types'",
        'export const bad = win',
      ].join('\n'),
    })

    const report = await evaluateArchContracts({ rootDir, manifest: EMPTY_MANIFEST })
    expect(report.violations).toHaveLength(2)
    expect(report.violations.every((v) => v.rule === 'boundary/agent-no-desktop')).toBe(true)
  })

  test('fails when packages import apps/**, electron, react, or react-dom', async () => {
    const rootDir = await createFixtureRepo({
      'packages/shared/src/Bad.ts': [
        "import React from 'react'",
        "import { createPortal } from 'react-dom'",
        "import { app } from 'electron'",
        "import { agent } from '../../../apps/agent/src/index'",
        'export const bad = [React, createPortal, app, agent]',
      ].join('\n'),
    })

    const report = await evaluateArchContracts({ rootDir, manifest: EMPTY_MANIFEST })
    expect(report.violations).toHaveLength(4)
    expect(report.violations.every((v) => v.rule === 'boundary/packages-isolation')).toBe(true)
  })

  test('fails on node_modules path puncture and scripts importing renderer/src, while enforcing comment discipline in scripts', async () => {
    const rootDir = await createFixtureRepo({
      'scripts/feature-map/BadDriver.ts': [
        "import { Effect } from '../../apps/agent/node_modules/effect/dist/index.js'",
        "import { App } from '../../apps/desktop/renderer/src/App'",
        '// unapproved ordinary comment in scripts',
        'export const bad = [Effect, App]',
      ].join('\n'),
    })

    const report = await evaluateArchContracts({ rootDir, manifest: EMPTY_MANIFEST })
    expect(report.violations.map((v) => v.rule)).toEqual([
      'boundary/no-node-modules-puncture',
      'boundary/scripts-no-renderer-src',
      'comments/no-new-ordinary-comments',
    ])
  })
})

describe('ArchContractsCore banned patterns', () => {
  test('fails on localStorage.clear() and window.localStorage.clear(), passes on removeItem', async () => {
    const rootDir = await createFixtureRepo({
      'apps/desktop/renderer/src/BadStorage.ts': [
        'export function nuke() {',
        '  localStorage.clear()',
        '  window.localStorage.clear()',
        '}',
      ].join('\n'),
      'apps/desktop/renderer/src/GoodStorage.ts': [
        'export function clearScoped() {',
        "  localStorage.removeItem('pidex.theme')",
        '}',
      ].join('\n'),
    })

    const report = await evaluateArchContracts({ rootDir, manifest: EMPTY_MANIFEST })
    expect(report.violations).toHaveLength(2)
    expect(report.violations.every((v) => v.rule === 'banned/no-localstorage-clear')).toBe(true)
  })

  test('fails on deprecated codepilotx brand or v3 protocol patterns while allowing external URLs and memory.v3', async () => {
    const rootDir = await createFixtureRepo({
      'apps/agent/src/BadBrand.ts': [
        "export const scheme = 'codepilotx://open'",
        "export const envKey = 'CODEPILOTX_HOME'",
        "export const proto = 'thread-rpc-v3'",
        'export function createV3Dispatcher() { return null }',
      ].join('\n'),
      'apps/agent/src/Allowed.ts': [
        "export const repo = 'codepilotx-dev/Pidex'",
        "export const broker = 'https://auth-staging.codepilotx.top'",
        "export const cap = 'memory.v3'",
      ].join('\n'),
      'apps/desktop/electron/package.json': JSON.stringify({
        name: '@pidex/desktop-electron',
        build: { publish: { owner: 'codepilotx-dev', repo: 'Pidex' } },
      }),
    })

    const report = await evaluateArchContracts({ rootDir, manifest: EMPTY_MANIFEST })
    expect(report.violations.map((v) => v.rule)).toEqual([
      'banned/no-v3-protocol',
      'banned/no-v3-protocol',
      'banned/no-deprecated-brand',
      'banned/no-deprecated-brand',
    ])
  })
})

describe('ArchContractsCore useEffect ratchet', () => {
  test('enforces baseline, flags increases, emits shrink notice, and exempts allowed hooks/tests', async () => {
    const rootDir = await createFixtureRepo({
      'apps/desktop/renderer/src/components/AtLimit.tsx': [
        "import { useEffect } from 'react'",
        'export function AtLimit() {',
        '  useEffect(() => {}, [])',
        '  return null',
        '}',
      ].join('\n'),
      'apps/desktop/renderer/src/components/Shrunk.tsx':
        'export function Shrunk() { return null }\n',
      'apps/desktop/renderer/src/components/OverLimit.tsx': [
        "import React from 'react'",
        'export function OverLimit() {',
        '  React.useEffect(() => {}, [])',
        '  React.useEffect(() => {}, [])',
        '  return null',
        '}',
      ].join('\n'),
      'apps/desktop/renderer/src/hooks/UseMountEffect.ts': [
        "import { useEffect } from 'react'",
        'export function useMountEffect(fn: () => void) { useEffect(fn, []) }',
      ].join('\n'),
      'apps/desktop/renderer/src/hooks/UseExternalSubscription.ts': [
        "import { useEffect } from 'react'",
        'export function useExternalSubscription(fn: () => void) { useEffect(fn, []) }',
      ].join('\n'),
      'apps/desktop/renderer/src/test/Helper.test.tsx': [
        "import { useEffect } from 'react'",
        'export function TestHarness() { useEffect(() => {}, []) }',
      ].join('\n'),
    })

    const manifest: ArchContractManifest = {
      ...EMPTY_MANIFEST,
      useEffectRatchet: {
        'apps/desktop/renderer/src/components/AtLimit.tsx': 1,
        'apps/desktop/renderer/src/components/Shrunk.tsx': 2,
        'apps/desktop/renderer/src/components/OverLimit.tsx': 1,
      },
    }

    const report = await evaluateArchContracts({ rootDir, manifest })
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({
      rule: 'ratchet/no-new-use-effect',
      file: 'apps/desktop/renderer/src/components/OverLimit.tsx',
      line: 4,
    })
    expect(report.notices).toHaveLength(1)
    expect(report.notices[0]).toMatchObject({
      category: 'use-effect-ratchet',
      file: 'apps/desktop/renderer/src/components/Shrunk.tsx',
      baseline: 2,
      actual: 0,
    })
  })
})

describe('ArchContractsCore comment discipline', () => {
  test('allows JSDoc on exported APIs, INVARIANT, SAFETY, reference headers, and JSX URLs', async () => {
    const rootDir = await createFixtureRepo({
      'packages/shared/src/Clean.tsx': [
        '/// <reference types="node" />',
        '/* Copyright (c) 2026 Pidex */',
        '',
        '/** Exported constant documentation. */',
        'export const VERSION = 1',
        '',
        '/** Exported interface documentation. */',
        'export interface Config {',
        '  /** Exported field documentation. */',
        '  name: string',
        '}',
        '',
        '/** Exported type documentation. */',
        'export type Mode = "fast" | "safe"',
        '',
        '/** Exported class documentation. */',
        'export class Runner {',
        '  /** Public method documentation. */',
        '  run() {}',
        '}',
        '',
        '/** Exported function documentation. */',
        'export function Component() {',
        '  // INVARIANT: input must remain immutable during render.',
        '  // SAFETY: bounds checked by caller.',
        '  return <div>https://example.com // not a comment</div>',
        '}',
      ].join('\n'),
      'apps/agent/scripts/BuildHelper.ts': '// ordinary script comment\n// TODO: script note\n',
      'apps/agent/test/Sample.test.ts': '// test comment\n// @ts-ignore\n',
    })

    const report = await evaluateArchContracts({ rootDir, manifest: EMPTY_MANIFEST })
    expect(report.violations).toEqual([])
  })

  test('fails on new ordinary comments, non-exported JSDoc, bare suppressions, and TODO/FIXME/HACK', async () => {
    const rootDir = await createFixtureRepo({
      'apps/agent/src/BadComments.ts': [
        '// ordinary narration comment',
        '/** JSDoc on non-exported helper should be ratcheted */',
        'function internal() {}',
        '// @ts-ignore',
        '// @ts-nocheck',
        '// @ts-expect-error',
        '// oxlint-disable-next-line react/rules-of-hooks',
        '// eslint-disable-next-line react-hooks/exhaustive-deps',
        '// TODO: remove later',
        'export const value = internal()',
      ].join('\n'),
    })

    const report = await evaluateArchContracts({ rootDir, manifest: EMPTY_MANIFEST })
    const rules = report.violations.map((v) => v.rule)
    expect(rules.filter((r) => r === 'comments/no-bare-suppression-or-todo')).toHaveLength(6)
    expect(rules.filter((r) => r === 'comments/no-new-ordinary-comments')).toHaveLength(1)
    expect(formatArchContractReport(report)).toContain('apps/agent/src/BadComments.ts:')
  })

  test('does not classify reasoned @ts-expect-error or reasoned disable as bare suppression', async () => {
    const rootDir = await createFixtureRepo({
      'apps/agent/src/Reasoned.ts': [
        '// @ts-expect-error intentional type test',
        '// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount only',
        'export const ok = true',
      ].join('\n'),
    })

    const manifest: ArchContractManifest = {
      ...EMPTY_MANIFEST,
      commentRatchet: {
        'apps/agent/src/Reasoned.ts': 2,
      },
    }

    const report = await evaluateArchContracts({ rootDir, manifest })
    expect(report.violations).toEqual([])
  })
})
