import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { DESKTOP_DATA_LOCATION_IPC_CHANNELS } from '@pidex/shared/desktop-data-location-ipc'
import type { DesktopStartupSnapshot } from '@pidex/shared/desktop-startup-ipc'
import { registerDataLocationIpc } from '../src/ipc/RegisterDataLocationIpc'
import { DataLocationBootstrapError, DataLocationStore } from '../src/settings/DataLocationStore'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pidex-data-location-'))
  roots.push(root)
  return root
}

describe('Electron data location store', () => {
  test.each(['retry', 'restore'] as const)('通过 %s IPC 重启后使用相应数据位置', async (action) => {
    const root = await temporaryRoot()
    const source = join(root, 'source', '.pidex')
    const store = new DataLocationStore(root, source, null)
    const installDirectory = join(root, 'install')
    const change = await store.schedule(join(root, 'destination'), installDirectory)
    const snapshot: DesktopStartupSnapshot = {
      state: 'failed',
      label: '失败',
      generation: 1,
      revision: 2,
    }
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
    let restarts = 0
    registerDataLocationIpc({
      store,
      installDirectory,
      ipc: {
        handle: (channel, handler) => {
          handlers.set(channel, handler)
        },
      },
      dialog: {
        showOpenDialog: () => {
          throw new Error('unexpected dialog')
        },
      },
      windows: { startupSnapshot: snapshot, requireApplicationWindow: () => ({}) as BrowserWindow },
      relaunch: () => {
        restarts++
      },
    })
    const invoke = (method: 'retry' | 'restore') =>
      handlers.get(DESKTOP_DATA_LOCATION_IPC_CHANNELS[method])!({} as IpcMainInvokeEvent)
    await expect(invoke(action)).rejects.toThrow('当前无法执行')
    snapshot.failureReason = 'relocation'
    await invoke(action)
    await expect(invoke(action === 'retry' ? 'restore' : 'retry')).rejects.toThrow('当前无法执行')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(restarts).toBe(1)
    const launch = await new DataLocationStore(root, source, null).launch()
    expect(launch.dataDir).toBe(action === 'retry' ? change.targetDataDir : source)
    expect(launch.relocation !== null).toBe(action === 'retry')
  })
  test('schedules a parent/.pidex relocation and promotes it after ready', async () => {
    const root = await temporaryRoot()
    const userData = join(root, 'app-data')
    const current = join(root, 'current', '.pidex')
    const parent = join(root, 'selected')
    await Promise.all([mkdir(current, { recursive: true }), mkdir(parent, { recursive: true })])
    const store = new DataLocationStore(userData, current, null)

    const change = await store.schedule(parent, join(root, 'install'))
    expect(change.targetDataDir).toBe(join(parent, '.pidex'))
    const { relocation } = await store.launch()
    expect(relocation).toMatchObject({
      sourceDataDir: current,
      targetDataDir: join(parent, '.pidex'),
    })

    await expect(store.promotePending('different-operation')).rejects.toThrow('已更改')
    await store.promotePending(relocation!.operationId)
    expect(await store.state()).toMatchObject({
      currentDataDir: join(parent, '.pidex'),
      pendingDataDir: null,
      controlSource: 'bootstrap',
    })
  })

  test('disables relocation when the environment controls the root', async () => {
    const root = await temporaryRoot()
    const file = join(root, 'data-location.json')
    const source = JSON.stringify({ version: 2, activeDataDir: join(root, 'future') })
    await writeFile(file, source)
    const environment = join(root, 'environment')
    const store = new DataLocationStore(root, join(root, 'default'), environment)
    expect(await store.launch()).toEqual({ dataDir: environment, relocation: null })
    expect(await store.state()).toMatchObject({
      currentDataDir: environment,
      pendingDataDir: null,
      controlSource: 'env',
      isEnvControlled: true,
    })
    await expect(store.schedule(join(root, 'selected'), join(root, 'install'))).rejects.toThrow(
      'PIDEX_DATA_DIR',
    )
    await store.promotePending('ignored')
    await store.restoreActive()
    expect(await readFile(file, 'utf8')).toBe(source)
  })

  test.each([
    ['future version', '{"version":2,"activeDataDir":null,"future":true}'],
    ['malformed JSON', '{'],
    ['invalid active directory', '{"version":1,"activeDataDir":42}'],
    ['invalid pending relocation', '{"version":1,"activeDataDir":null,"pending":{}}'],
  ])('preserves the locator and refuses to select a root for %s', async (_, source) => {
    const root = await temporaryRoot()
    const file = join(root, 'data-location.json')
    const defaultRoot = join(root, 'default')
    const store = new DataLocationStore(root, defaultRoot, null)
    expect(await store.launch()).toEqual({ dataDir: defaultRoot, relocation: null })
    await writeFile(file, source)
    await expect(store.launch()).rejects.toThrow(DataLocationBootstrapError)
    await expect(store.state()).rejects.toThrow(DataLocationBootstrapError)
    await expect(store.schedule(join(root, 'selected'), join(root, 'install'))).rejects.toThrow(
      DataLocationBootstrapError,
    )
    await expect(store.promotePending('ignored')).rejects.toThrow(DataLocationBootstrapError)
    await expect(store.restoreActive()).rejects.toThrow(DataLocationBootstrapError)
    expect(await readFile(file, 'utf8')).toBe(source)
  })

  test('reports a locator read failure without launching the default root', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'data-location.json'))
    const store = new DataLocationStore(root, join(root, 'default'), null)
    await expect(store.launch()).rejects.toThrow('无法读取 data-location.json')
  })

  test('rejects a target that overlaps a registered workspace', async () => {
    const root = await temporaryRoot()
    const parent = join(root, 'projects')
    const workspace = join(parent, 'repository')
    await mkdir(workspace, { recursive: true })
    const store = new DataLocationStore(
      join(root, 'app-data'),
      join(root, 'current', '.pidex'),
      null,
    )

    await expect(store.schedule(parent, join(root, 'install'), [parent])).rejects.toThrow(
      '已注册工作区',
    )
  })

  test('rejects invalid, non-empty, and installation-owned targets', async () => {
    const root = await temporaryRoot()
    const current = join(root, 'current', '.pidex')
    const store = new DataLocationStore(join(root, 'app-data'), current, null)
    await mkdir(current, { recursive: true })

    await expect(store.schedule(current, join(root, 'install'))).rejects.toThrow('父目录')

    const nonEmptyParent = join(root, 'non-empty')
    const nonEmptyTarget = join(nonEmptyParent, '.pidex')
    await mkdir(nonEmptyTarget, { recursive: true })
    await writeFile(join(nonEmptyTarget, 'unexpected.txt'), 'occupied', 'utf8')
    await expect(store.schedule(nonEmptyParent, join(root, 'install'))).rejects.toThrow('必须为空')

    const installDirectory = join(root, 'install')
    await mkdir(installDirectory, { recursive: true })
    await expect(store.schedule(installDirectory, installDirectory)).rejects.toThrow('安装目录')

    if (process.platform === 'win32') {
      await expect(store.schedule('\\\\server\\share', installDirectory)).rejects.toThrow(
        '本地绝对路径',
      )
    }
  })

  test('keeps the pending relocation for retry and can restore the source', async () => {
    const root = await temporaryRoot()
    const current = join(root, 'current', '.pidex')
    const selectedParent = join(root, 'selected')
    await Promise.all([
      mkdir(current, { recursive: true }),
      mkdir(selectedParent, { recursive: true }),
    ])
    const store = new DataLocationStore(join(root, 'app-data'), current, null)

    await store.schedule(selectedParent, join(root, 'install'))
    expect((await store.launch()).relocation).not.toBeNull()

    await store.restoreActive()
    expect(await store.launch()).toEqual({
      dataDir: current,
      relocation: null,
    })
  })
})
