import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AppListResultSchema } from '@pidex/agent-protocol'
import { Schema } from 'effect'
import { AppManagementService } from '../src/plugin/AppManagementService'
import { PluginManagementService } from '../src/plugin/PluginManagementService'
import { PluginSettingsRepository } from '../src/storage/repositories/PluginSettingsRepository'
import type { RpcRouter } from '../src/transport/rpc/RpcRouter'
import { pluginHandlers } from '../src/transport/rpc/handlers/Plugins'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const temporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-app-test-'))
  roots.push(root)
  return root
}

const settingsDatabase = () => {
  const values = new Map<string, unknown>()
  return {
    profileSqlite: {
      transaction<T>(work: () => T) {
        return work
      },
    },
    getSetting<T>(key: string) {
      return (values.get(key) as T | undefined) ?? null
    },
    setSetting(key: string, value: unknown) {
      values.set(key, value)
    },
  }
}

describe('AppManagementService', () => {
  test('lists built-in apps with read/write tool breakdowns and resolves bundled computer-use .app.json', async () => {
    const dataRoot = await temporaryRoot()
    const builtinPluginsRoot = resolve(import.meta.dir, '..', 'resources', 'plugins')
    const settings = new PluginSettingsRepository(settingsDatabase())
    const plugins = new PluginManagementService(settings, { builtinPluginsRoot, dataRoot })
    const apps = new AppManagementService(settings, plugins, (provider) => provider === 'github')
    plugins.setAppResolver((ref) => apps.resolveUsedApp(ref))

    const result = Schema.decodeUnknownSync(AppListResultSchema)(await apps.list())
    expect(result.apps.map((app) => app.id)).toEqual(['computer-use', 'pets', 'browser', 'github'])

    const computerUse = result.apps.find((app) => app.id === 'computer-use')!
    expect(computerUse.pluginId).toBe('computer-use')
    expect(computerUse.tools.filter((tool) => tool.mode === 'read')).toHaveLength(2)
    expect(computerUse.tools.filter((tool) => tool.mode === 'write')).toHaveLength(3)

    const github = result.apps.find((app) => app.id === 'github')!
    expect(github.auth).toEqual({ required: true, connected: true, provider: 'github' })

    const { details } = await plugins.getDetails({ pluginId: 'computer-use' })
    expect(details.apps).toHaveLength(1)
    expect(details.apps?.[0]).toMatchObject({
      id: 'computer-use',
      name: 'Computer Use',
      description: '发现已运行的 Windows 应用与窗口，读取界面和截图，并执行鼠标与键盘操作。',
      developerName: 'Pidex',
      iconName: 'computer-use',
      required: true,
      installed: true,
      enabled: true,
    })
    expect(details.apps?.[0]?.tools?.length).toBe(5)
  })

  test('persists app enablement idempotently and merges plugin-declared .app.json connectors', async () => {
    const root = await temporaryRoot()
    const pluginRoot = join(root, 'builtin', 'figma-workflow')
    await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true })
    await writeFile(
      join(pluginRoot, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'figma-workflow',
        version: '1.0.0',
        description: 'Figma workflow',
        author: { name: 'Pidex' },
        apps: './.app.json',
        interface: {
          displayName: 'Figma Workflow',
          shortDescription: 'Design handoff workflow',
          developerName: 'Pidex',
          category: 'Design',
        },
      }),
    )
    await writeFile(
      join(pluginRoot, '.app.json'),
      JSON.stringify({
        apps: {
          figma: {
            id: 'figma-connector',
            name: 'Figma',
            description: 'Read Figma frames and tokens.',
            required: false,
          },
        },
      }),
    )
    await writeFile(
      join(pluginRoot, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'figma-workflow',
        version: '1.0.0',
        description: 'Figma workflow',
        author: { name: 'Pidex' },
        apps: './.app.json',
        interface: {
          displayName: 'Figma Workflow',
          shortDescription: 'Design handoff workflow',
          developerName: 'Pidex',
          category: 'Design',
        },
      }),
    )

    const db = settingsDatabase()
    const settings = new PluginSettingsRepository(db)
    const plugins = new PluginManagementService(settings, {
      builtinPluginsRoot: join(root, 'builtin'),
      dataRoot: join(root, 'data'),
    })
    const apps = new AppManagementService(settings, plugins)

    // Installed-by-default only applies when .cpx-plugin sets INSTALLED_BY_DEFAULT, so add it.
    await mkdir(join(pluginRoot, '.cpx-plugin'), { recursive: true })
    await writeFile(
      join(pluginRoot, '.cpx-plugin', 'plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        installation: 'INSTALLED_BY_DEFAULT',
        capabilities: [],
      }),
    )

    const initial = await apps.list()
    expect(initial.apps.some((app) => app.id === 'figma-connector' && app.source === 'plugin')).toBe(
      true,
    )

    const first = await apps.setEnabled({
      appId: 'pets',
      enabled: false,
      operationId: 'op-pets-disable',
    })
    expect(first.app.enabled).toBe(false)
    expect(apps.isEnabled('pets')).toBe(false)

    const replay = await apps.setEnabled({
      appId: 'pets',
      enabled: false,
      operationId: 'op-pets-disable',
    })
    expect(replay.generation).toBe(first.generation)

    const router = { dependencies: { apps, plugins } } as unknown as RpcRouter
    const rpcListed = (await pluginHandlers.handle(router, 'app/list', {}, {} as never)) as {
      apps: Array<{ id: string; enabled: boolean }>
    }
    expect(rpcListed.apps.find((app) => app.id === 'pets')?.enabled).toBe(false)

    const usedComputerUse = await apps.resolveUsedApp({ id: 'computer-use' })
    expect(usedComputerUse.tools?.length).toBe(5)
    expect(usedComputerUse.tools?.filter((tool) => tool.mode === 'write').length).toBe(3)
    expect(usedComputerUse.tools?.filter((tool) => tool.mode === 'read').length).toBe(2)
  })
})
