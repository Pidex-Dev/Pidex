import { app, dialog, ipcMain, shell, type OpenDialogOptions, type WebContents } from 'electron'
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  DESKTOP_SETTINGS_IPC_CHANNELS,
  type DesktopSettingsPayload,
} from '@pidex/shared/desktop-settings-ipc'
import {
  DESKTOP_EDIT_ACTIONS,
  DESKTOP_EDIT_IPC_CHANNELS,
  type DesktopEditAction,
} from '@pidex/shared/desktop-edit-ipc'
import { DESKTOP_UPDATE_IPC_CHANNELS } from '@pidex/shared/desktop-update-ipc'
import {
  DESKTOP_ATTACHMENT_IPC_CHANNELS,
  type DesktopAttachmentSaveInput,
  type DesktopComposerPathListInput,
  type DesktopComposerPathReadInput,
} from '@pidex/shared/desktop-attachment-ipc'
import {
  DESKTOP_WINDOW_IPC_CHANNELS,
  isDesktopPageZoomAction,
  normalizeDesktopOpenWindowInput,
} from '@pidex/shared/desktop-window-ipc'
import { DESKTOP_WORKSPACE_IPC_CHANNELS } from '@pidex/shared/desktop-workspace-ipc'
import { DESKTOP_SHELL_IPC_CHANNELS, type DesktopUserDataDownloadedResource } from '@pidex/shared/desktop-shell-ipc'
import {
  DESKTOP_CLIPBOARD_IPC_CHANNELS,
  requireDesktopClipboardRichTextInput,
  requireDesktopClipboardTextInput,
} from '@pidex/shared/desktop-clipboard-ipc'
import { DESKTOP_STARTUP_IPC_CHANNELS } from '@pidex/shared/desktop-startup-ipc'
import type { DesktopClipboardService } from '../clipboard/DesktopClipboardService.js'
import type { DesktopLogger } from '../logging/DesktopLogger.js'
import { isSafeExternalUrl } from '../security/Navigation.js'
import {
  normalizeDesktopSettingsPayload,
  requireApiKeyMaterial,
} from '../settings/DesktopSettingsContract.js'
import type { SidecarSupervisor } from '../sidecar/Supervisor.js'
import type { WindowManager } from '../windows/WindowManager.js'
import type { DesktopAutoUpdater } from '../update/DesktopAutoUpdater.js'
import type { ExternalOpenTargetService } from './ExternalOpenTargets.js'
import type { ExternalFontService } from '../settings/ExternalFontService.js'
import type { AttachmentDownloadService } from './AttachmentDownloadService.js'
import type { ComposerPathGrantService } from './ComposerPathGrantService.js'

interface DesktopIpcDependencies {
  windows: WindowManager
  logger: DesktopLogger
  externalOpenTargets: ExternalOpenTargetService
  updater: DesktopAutoUpdater
  attachmentDownloads: AttachmentDownloadService
  composerPathGrants: ComposerPathGrantService
  clipboardService: DesktopClipboardService
  externalFonts?: ExternalFontService
  getSupervisor: () => SidecarSupervisor | undefined
  getLogDirectory: () => string
  quitDuringStartup: () => void
  retryStartup: (generation: number) => Promise<void>
  stopBackendAndExit: () => Promise<void>
  broadcastDesktopSettingsChanged: (settings: DesktopSettingsPayload) => void
  isDesktopRendererSender: (sender: WebContents) => boolean
}

export function registerDesktopIpc(dependencies: DesktopIpcDependencies): void {
  const {
    windows,
    logger,
    externalOpenTargets,
    updater,
    attachmentDownloads,
    composerPathGrants,
    clipboardService,
    getSupervisor,
    getLogDirectory,
    quitDuringStartup,
    broadcastDesktopSettingsChanged,
    isDesktopRendererSender,
  } = dependencies

  ipcMain.handle(
    DESKTOP_ATTACHMENT_IPC_CHANNELS.saveToDownloads,
    async (event, input: DesktopAttachmentSaveInput) => {
      requireMainWindowSender(event, windows)
      return attachmentDownloads.save(input)
    },
  )

  ipcMain.handle(DESKTOP_STARTUP_IPC_CHANNELS.snapshot, (event) => {
    requireMainWindowSender(event, windows)
    return windows.startupSnapshot
  })
  ipcMain.handle(DESKTOP_STARTUP_IPC_CHANNELS.retry, (event, generation: unknown) => {
    requireMainWindowSender(event, windows)
    if (!Number.isSafeInteger(generation) || Number(generation) < 0) throw new Error('启动代次无效')
    return dependencies.retryStartup(Number(generation))
  })

  const grantOwnersWithCleanup = new Set<number>()
  const retainGrantOwner = (sender: WebContents): void => {
    if (grantOwnersWithCleanup.has(sender.id)) return
    grantOwnersWithCleanup.add(sender.id)
    sender.once('destroyed', () => {
      grantOwnersWithCleanup.delete(sender.id)
      composerPathGrants.clearOwner(sender.id)
    })
  }
  ipcMain.handle(DESKTOP_ATTACHMENT_IPC_CHANNELS.chooseComposerFiles, async (event) => {
    const ownerWindow = requireMainWindowSender(event, windows)
    const options: OpenDialogOptions = {
      title: 'Files and folders',
      properties: ['openFile', 'multiSelections'],
    }
    const result = await dialog.showOpenDialog(ownerWindow, options)
    if (result.canceled) return []
    retainGrantOwner(event.sender)
    return composerPathGrants.grantPaths(event.sender.id, result.filePaths)
  })
  ipcMain.handle(
    DESKTOP_ATTACHMENT_IPC_CHANNELS.grantComposerPaths,
    async (event, paths: unknown) => {
      requireMainWindowSender(event, windows)
      retainGrantOwner(event.sender)
      return composerPathGrants.grantPaths(event.sender.id, paths)
    },
  )
  ipcMain.handle(
    DESKTOP_ATTACHMENT_IPC_CHANNELS.readComposerPathGrant,
    async (event, input: DesktopComposerPathReadInput) => {
      requireMainWindowSender(event, windows)
      return composerPathGrants.read(event.sender.id, input)
    },
  )
  ipcMain.handle(
    DESKTOP_ATTACHMENT_IPC_CHANNELS.listComposerPathGrant,
    async (event, input: DesktopComposerPathListInput) => {
      requireMainWindowSender(event, windows)
      return composerPathGrants.list(event.sender.id, input)
    },
  )

  ipcMain.handle(DESKTOP_WINDOW_IPC_CHANNELS.openWindow, (event, input: unknown) => {
    requireMainWindowSender(event, windows)
    const normalized = normalizeDesktopOpenWindowInput(input)
    if (!normalized) throw new Error('窗口参数无效')
    windows.openWindow(normalized)
  })
  ipcMain.handle(DESKTOP_WINDOW_IPC_CHANNELS.minimize, (event) => {
    requireMainWindowSender(event, windows).minimize()
  })
  ipcMain.handle(DESKTOP_WINDOW_IPC_CHANNELS.toggleMaximize, (event) => {
    const target = requireMainWindowSender(event, windows)
    if (target.isMaximized()) target.unmaximize()
    else target.maximize()
    return target.isMaximized()
  })
  ipcMain.handle(DESKTOP_WINDOW_IPC_CHANNELS.close, (event) => {
    requireMainWindowSender(event, windows).close()
  })
  ipcMain.handle(DESKTOP_WINDOW_IPC_CHANNELS.isMaximized, (event) => {
    return requireMainWindowSender(event, windows).isMaximized()
  })
  ipcMain.handle(DESKTOP_WINDOW_IPC_CHANNELS.getPageZoom, (event) => {
    requireMainWindowSender(event, windows)
    return windows.getPageZoom()
  })
  ipcMain.handle(DESKTOP_WINDOW_IPC_CHANNELS.changePageZoom, (event, action: unknown) => {
    requireMainWindowSender(event, windows)
    if (!isDesktopPageZoomAction(action)) {
      throw new Error('页面缩放命令无效')
    }
    return windows.changePageZoom(action)
  })
  ipcMain.handle(DESKTOP_UPDATE_IPC_CHANNELS.check, async (event) => {
    requireMainWindowSender(event, windows)
    await updater.checkForUpdates()
  })
  ipcMain.handle(DESKTOP_UPDATE_IPC_CHANNELS.download, async (event) => {
    requireMainWindowSender(event, windows)
    await updater.downloadUpdate()
  })
  ipcMain.handle(DESKTOP_UPDATE_IPC_CHANNELS.quitAndInstall, async (event) => {
    requireMainWindowSender(event, windows)
    await updater.quitAndInstall()
  })
  ipcMain.handle(DESKTOP_EDIT_IPC_CHANNELS.perform, (event, action: unknown) => {
    requireMainWindowSender(event, windows)
    if (!isDesktopEditAction(action)) {
      throw new Error('编辑命令无效')
    }
    performDesktopEditAction(event.sender, action)
  })
  ipcMain.handle(DESKTOP_SETTINGS_IPC_CHANNELS.get, async (event) => {
    requireDesktopRendererSender(event, isDesktopRendererSender)
    const supervisor = requireSupervisor(getSupervisor())
    const response = await supervisor.request('/api/config/desktop-projection')
    return normalizeDesktopSettingsPayload(await response.json())
  })
  ipcMain.handle(DESKTOP_SETTINGS_IPC_CHANNELS.save, async (event, settings: unknown) => {
    requireMainWindowSender(event, windows)
    const supervisor = requireSupervisor(getSupervisor())
    const normalizedSettings = normalizeDesktopSettingsPayload(settings)
    const response = await supervisor.request('/api/config/desktop-projection', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalizedSettings),
    })
    const saved = normalizeDesktopSettingsPayload(await response.json())
    broadcastDesktopSettingsChanged(saved)
    return saved
  })
  ipcMain.handle(DESKTOP_CLIPBOARD_IPC_CHANNELS.writeText, (event, input: unknown) => {
    requireMainWindowSender(event, windows)
    const { text } = requireDesktopClipboardTextInput(input)
    clipboardService.writeText(text)
  })
  ipcMain.handle(DESKTOP_CLIPBOARD_IPC_CHANNELS.writeRichText, (event, input: unknown) => {
    requireMainWindowSender(event, windows)
    clipboardService.writeRichText(requireDesktopClipboardRichTextInput(input))
  })
  ipcMain.handle(
    DESKTOP_CLIPBOARD_IPC_CHANNELS.copyProviderApiKey,
    async (event, credentialId: unknown) => {
      requireMainWindowSender(event, windows)
      const supervisor = requireSupervisor(getSupervisor())
      if (
        typeof credentialId !== 'string' ||
        credentialId.length < 1 ||
        credentialId.length > 200 ||
        !/^[A-Za-z0-9._:-]+$/.test(credentialId)
      ) {
        throw new Error('API Key 凭据 ID 无效')
      }
      const response = await supervisor.request(
        `/api/desktop/api-keys/${encodeURIComponent(credentialId)}/copy-material`,
        { method: 'POST' },
      )
      const payload = (await response.json()) as { key?: unknown }
      const material = requireApiKeyMaterial(payload.key)
      return clipboardService.writeSensitiveText(material)
    },
  )
  ipcMain.handle(DESKTOP_SHELL_IPC_CHANNELS.openExternal, async (event, url: unknown) => {
    requireMainWindowSender(event, windows)
    if (typeof url !== 'string' || !isSafeExternalUrl(url)) {
      throw new Error('拒绝打开不安全的外部链接')
    }
    await shell.openExternal(url)
  })
  ipcMain.handle(
    DESKTOP_SHELL_IPC_CHANNELS.listExternalOpenTargets,
    async (event, targetPath: unknown) => {
      requireMainWindowSender(event, windows)
      if (typeof targetPath !== 'string') throw new Error('路径参数无效')
      return externalOpenTargets.listTargets(targetPath)
    },
  )
  ipcMain.handle(
    DESKTOP_SHELL_IPC_CHANNELS.openPathWithTarget,
    async (event, targetPath: unknown, targetId: unknown) => {
      requireMainWindowSender(event, windows)
      if (typeof targetPath !== 'string' || typeof targetId !== 'string') {
        throw new Error('外部打开参数无效')
      }
      await externalOpenTargets.openPathWithTarget(targetPath, targetId)
    },
  )
  ipcMain.handle(DESKTOP_SHELL_IPC_CHANNELS.revealPathInFolder, (event, targetPath: unknown) => {
    requireMainWindowSender(event, windows)
    if (typeof targetPath !== 'string') throw new Error('路径参数无效')
    externalOpenTargets.revealPathInFolder(targetPath)
  })
  ipcMain.handle(DESKTOP_SHELL_IPC_CHANNELS.openDirectory, async (event, targetPath: unknown) => {
    requireMainWindowSender(event, windows)
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      throw new Error('目录路径无效')
    }
    const resolved = resolve(targetPath.trim())
    const info = await stat(resolved).catch(() => null)
    if (!info || !info.isDirectory()) {
      throw new Error('目标目录不存在')
    }
    const openError = await shell.openPath(resolved)
    if (openError) {
      throw new Error(`无法打开目录：${openError}`)
    }
  })
  ipcMain.handle(DESKTOP_SHELL_IPC_CHANNELS.getUserDataStorageSummary, async (event) => {
    requireMainWindowSender(event, windows)
    const userDataDir = resolve(app.getPath('userData'))
    const runtimesDir = join(userDataDir, 'runtimes')
    const [totalBytes, runtimesBytes] = await Promise.all([
      computeDirectorySize(userDataDir),
      computeDirectorySize(runtimesDir),
    ])
    return {
      userDataDir,
      totalBytes,
      runtimesBytes,
      otherBytes: Math.max(0, totalBytes - runtimesBytes),
    }
  })
  ipcMain.handle(
    DESKTOP_SHELL_IPC_CHANNELS.listUserDataDownloadedResources,
    async (event): Promise<DesktopUserDataDownloadedResource[]> => {
      requireMainWindowSender(event, windows)
      const resources: DesktopUserDataDownloadedResource[] = []
      const userDataDir = resolve(app.getPath('userData'))

      if (dependencies.externalFonts) {
        const fontStates = await dependencies.externalFonts.listStates()
        for (const font of fontStates) {
          if (font.status !== 'downloaded') continue
          const fontDir = dependencies.externalFonts.getFontDirectory(font.id)
          if (!fontDir) continue
          const sizeBytes = await computeDirectorySize(fontDir)
          resources.push({
            id: `font:${font.id}`,
            name: `${font.displayName} 字体`,
            category: 'font',
            description: `${font.family} · ${font.kind === 'code' ? '代码字体' : '界面字体'}`,
            path: fontDir,
            sizeBytes,
          })
        }
      }

      const cuaRoot = join(userDataDir, 'runtimes', 'cua')
      const cuaSize = await computeDirectorySize(cuaRoot)
      if (cuaSize > 0) {
        resources.push({
          id: 'runtime:cua',
          name: 'Computer Use 本地运行时',
          category: 'runtime',
          description: '用于桌面屏幕操控的本地 CUA 执行器',
          path: cuaRoot,
          sizeBytes: cuaSize,
        })
      }

      return resources
    },
  )
  ipcMain.handle(
    DESKTOP_SHELL_IPC_CHANNELS.deleteUserDataDownloadedResource,
    async (event, resourceId: unknown) => {
      requireMainWindowSender(event, windows)
      if (typeof resourceId !== 'string' || !resourceId.trim()) {
        throw new Error('资源标识无效')
      }
      const userDataDir = resolve(app.getPath('userData'))
      if (resourceId.startsWith('font:')) {
        if (!dependencies.externalFonts) {
          throw new Error('字体管理服务不可用')
        }
        const fontId = resourceId.slice('font:'.length)
        const fontDir = dependencies.externalFonts.getFontDirectory(fontId)
        if (!fontDir) {
          throw new Error('未找到指定的字体资源')
        }
        const beforeBytes = await computeDirectorySize(fontDir)
        await dependencies.externalFonts.removeFont(fontId)
        return { resourceId, reclaimedBytes: beforeBytes }
      }
      if (resourceId === 'runtime:cua') {
        const cuaRoot = join(userDataDir, 'runtimes', 'cua')
        const beforeBytes = await computeDirectorySize(cuaRoot)
        await rm(cuaRoot, { recursive: true, force: true })
        return { resourceId, reclaimedBytes: beforeBytes }
      }
      throw new Error(`未知资源：${resourceId}`)
    },
  )
  ipcMain.handle(DESKTOP_STARTUP_IPC_CHANNELS.openLogs, async (event) => {
    requireMainWindowSender(event, windows)
    const directory = getLogDirectory()
    const openError = await shell.openPath(directory)
    if (openError) {
      logger.error('desktop.open-log-directory-failed', {
        reason: 'shell-open-failed',
      })
      throw new Error(`无法打开日志目录：${openError}`)
    }
    logger.info('desktop.log-directory-opened')
    return directory
  })
  ipcMain.handle(DESKTOP_STARTUP_IPC_CHANNELS.quit, (event) => {
    requireMainWindowSender(event, windows)
    quitDuringStartup()
  })
  ipcMain.handle(DESKTOP_STARTUP_IPC_CHANNELS.stopBackendAndExit, async (event) => {
    requireMainWindowSender(event, windows)
    await dependencies.stopBackendAndExit()
  })
  ipcMain.handle(DESKTOP_WORKSPACE_IPC_CHANNELS.pickDirectory, async (event) => {
    const ownerWindow = requireMainWindowSender(event, windows)
    const options: OpenDialogOptions = {
      title: '选择项目目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = await dialog.showOpenDialog(ownerWindow, options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(DESKTOP_WORKSPACE_IPC_CHANNELS.pickDirectories, async (event) => {
    const ownerWindow = requireMainWindowSender(event, windows)
    const result = await dialog.showOpenDialog(ownerWindow, {
      title: '选择项目源文件夹',
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })
}

function isDesktopEditAction(value: unknown): value is DesktopEditAction {
  return typeof value === 'string' && (DESKTOP_EDIT_ACTIONS as readonly string[]).includes(value)
}

function performDesktopEditAction(sender: WebContents, action: DesktopEditAction): void {
  switch (action) {
    case 'undo':
      sender.undo()
      return
    case 'redo':
      sender.redo()
      return
    case 'cut':
      sender.cut()
      return
    case 'copy':
      sender.copy()
      return
    case 'paste':
      sender.paste()
      return
    case 'delete':
      sender.delete()
      return
    case 'selectAll':
      sender.selectAll()
  }
}

function requireDesktopRendererSender(
  event: Electron.IpcMainInvokeEvent,
  isAllowed: (sender: WebContents) => boolean,
): void {
  if (!isAllowed(event.sender)) throw new Error('IPC 调用来源无效')
}

function requireMainWindowSender(
  event: Electron.IpcMainInvokeEvent,
  windows: WindowManager,
): Electron.BrowserWindow {
  return windows.requireApplicationWindow(event.sender)
}

function requireSupervisor(supervisor: SidecarSupervisor | undefined): SidecarSupervisor {
  if (!supervisor) throw new Error('Agent 尚未初始化')
  return supervisor
}

async function computeDirectorySize(rootDir: string): Promise<number> {
  const rootStat = await lstat(rootDir).catch(() => null)
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return 0

  let total = 0
  const stack: string[] = [rootDir]
  while (stack.length > 0) {
    const current = stack.pop()!
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null)
    if (!entries) continue
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile()) {
        const fileStat = await lstat(fullPath).catch(() => null)
        if (fileStat && fileStat.isFile()) {
          total += fileStat.size
        }
      }
    }
  }
  return total
}
