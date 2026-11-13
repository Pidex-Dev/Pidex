import { ipcMain } from 'electron'
import {
  DESKTOP_APPEARANCE_IPC_CHANNELS,
  type DesktopStartupThemeSeed,
} from '@pidex/shared/desktop-appearance-ipc'
import {
  type AppearanceSettingsStore,
  migrateAppearanceSettings,
  normalizeAppearanceSettings,
  type DesktopThemeSettingsV8,
} from '../settings/AppearanceSettingsStore.js'
import type { WindowAppearanceController } from '../windows/Appearance.js'
import { resolveStartupPageTheme } from '../windows/StartupPage.js'
import type { ExternalFontService } from '../settings/ExternalFontService.js'

export function registerAppearanceIpc(
  initialSettings: DesktopThemeSettingsV8,
  appearance: WindowAppearanceController,
  store: AppearanceSettingsStore,
  isMainWindowSender: (sender: Electron.WebContents) => boolean,
  externalFonts?: ExternalFontService,
): void {
  let settings = normalizeAppearanceSettings(initialSettings)
  ipcMain.on(DESKTOP_APPEARANCE_IPC_CHANNELS.getStartupThemeSeed, (event) => {
    if (!isMainWindowSender(event.sender)) {
      event.returnValue = null
      return
    }
    const resolved = resolveStartupPageTheme(settings, appearance.systemThemeVariant())
    const seed: DesktopStartupThemeSeed = {
      version: 1,
      variant: resolved.variant,
      surface: resolved.theme.surface,
      ink: resolved.theme.ink,
    }
    event.returnValue = seed
  })
  ipcMain.handle(DESKTOP_APPEARANCE_IPC_CHANNELS.getSettings, () => settings)
  ipcMain.handle(DESKTOP_APPEARANCE_IPC_CHANNELS.saveSettings, async (_event, value: unknown) => {
    const next = migrateAppearanceSettings(value)
    await store.save(next)
    settings = next
    appearance.updateSettings(next)
    appearance.broadcastAppearanceSettings(next)
  })
  ipcMain.handle(DESKTOP_APPEARANCE_IPC_CHANNELS.getSystemTheme, () =>
    appearance.systemThemeVariant(),
  )
  ipcMain.handle(DESKTOP_APPEARANCE_IPC_CHANNELS.canRestorePreviousAppearance, () =>
    store.canRestorePreviousAppearance(),
  )
  ipcMain.handle(DESKTOP_APPEARANCE_IPC_CHANNELS.restorePreviousAppearance, async () => {
    const restored = await store.restorePreviousAppearance()
    settings = restored
    appearance.updateSettings(restored)
    appearance.broadcastAppearanceSettings(restored)
    return restored
  })
  ipcMain.handle(DESKTOP_APPEARANCE_IPC_CHANNELS.applyNewDesignTheme, async () => {
    const next = await store.applyNewDesignTheme()
    settings = next
    appearance.updateSettings(next)
    appearance.broadcastAppearanceSettings(next)
    return next
  })
  ipcMain.handle(DESKTOP_APPEARANCE_IPC_CHANNELS.listExternalFonts, async (event) => {
    if (!isMainWindowSender(event.sender) || !externalFonts) return []
    return externalFonts.listStates()
  })
  ipcMain.handle(
    DESKTOP_APPEARANCE_IPC_CHANNELS.downloadExternalFont,
    async (event, fontId: unknown) => {
      if (!isMainWindowSender(event.sender) || !externalFonts || typeof fontId !== 'string') {
        return {
          ok: false,
          state: {
            id: typeof fontId === 'string' ? fontId : '',
            family: '',
            displayName: '',
            kind: 'ui',
            status: 'error',
            error: '无效的字体请求',
          },
          error: '无效的字体请求',
        }
      }
      return externalFonts.downloadFont(fontId)
    },
  )
  ipcMain.handle(
    DESKTOP_APPEARANCE_IPC_CHANNELS.getExternalFontCss,
    async (event, fontId: unknown) => {
      if (!isMainWindowSender(event.sender) || !externalFonts || typeof fontId !== 'string') {
        return null
      }
      return externalFonts.getFontCss(fontId)
    },
  )
  appearance.registerThemeBroadcast()
}
