import type { Dialog, IpcMain, OpenDialogOptions } from 'electron'
import { DESKTOP_DATA_LOCATION_IPC_CHANNELS } from '@pidex/shared/desktop-data-location-ipc'
import type { DataLocationStore } from '../settings/DataLocationStore.js'
import type { WindowManager } from '../windows/WindowManager.js'

type DataLocationIpcDependencies = {
  store: DataLocationStore
  windows: Pick<WindowManager, 'startupSnapshot' | 'requireApplicationWindow'>
  ipc: Pick<IpcMain, 'handle'>
  dialog: Pick<Dialog, 'showOpenDialog'>
  installDirectory: string
  relaunch: () => void
}

export function registerDataLocationIpc(dependencies: DataLocationIpcDependencies): void {
  const { store, windows, installDirectory, relaunch, ipc: ipcMain, dialog } = dependencies
  ipcMain.handle(DESKTOP_DATA_LOCATION_IPC_CHANNELS.get, (event) => {
    windows.requireApplicationWindow(event.sender)
    return store.state()
  })
  ipcMain.handle(
    DESKTOP_DATA_LOCATION_IPC_CHANNELS.choose,
    async (event, workspaceRoots: unknown) => {
      const owner = windows.requireApplicationWindow(event.sender)
      const options: OpenDialogOptions = {
        title: '选择 Pidex 用户数据的父目录',
        properties: ['openDirectory', 'createDirectory'],
      }
      const result = await dialog.showOpenDialog(owner, options)
      const selected = result.canceled ? null : (result.filePaths[0] ?? null)
      if (!selected) return null
      const change = await store.schedule(
        selected,
        installDirectory,
        normalizeWorkspaceRoots(workspaceRoots),
      )
      setImmediate(relaunch)
      return change
    },
  )
  let recovering = false
  async function recover(sender: Electron.WebContents, restore: boolean): Promise<void> {
    windows.requireApplicationWindow(sender)
    const snapshot = windows.startupSnapshot
    if (snapshot.state !== 'failed' || snapshot.failureReason !== 'relocation' || recovering) {
      throw new Error('当前无法执行迁移恢复操作')
    }
    recovering = true
    try {
      if (restore) await store.restoreActive()
    } catch (error) {
      recovering = false
      throw error
    }
    setImmediate(relaunch)
  }
  ipcMain.handle(DESKTOP_DATA_LOCATION_IPC_CHANNELS.retry, (event) => recover(event.sender, false))
  ipcMain.handle(DESKTOP_DATA_LOCATION_IPC_CHANNELS.restore, (event) => recover(event.sender, true))
}

function normalizeWorkspaceRoots(value: unknown): string[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > 1_000 ||
    value.some((path) => typeof path !== 'string' || path.length > 32_768)
  ) {
    throw new Error('工作区路径列表无效')
  }
  return value
}
