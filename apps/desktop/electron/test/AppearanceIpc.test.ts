import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

test('外观保存只更新窗口，系统主题切换经 preload 通知渲染端', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
        import { mock } from 'bun:test'
        import assert from 'node:assert/strict'
        import { EventEmitter } from 'node:events'
        import { DEFAULT_APPEARANCE_SETTINGS } from '@pidex/shared/desktop-theme'
        import { DESKTOP_APPEARANCE_IPC_CHANNELS as channels } from '@pidex/shared/desktop-appearance-ipc'
        const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false })
        const app = new EventEmitter()
        const handlers = new Map()
        const sent = []
        const ipcRenderer = Object.assign(new EventEmitter(), {
          sendSync: () => null,
          invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
        })
        const liveWindow = {
          isDestroyed: () => false,
          webContents: {
            send(channel, value) {
              sent.push([channel, value])
              ipcRenderer.emit(channel, {}, value)
            },
          },
        }
        let bridge
        mock.module(require.resolve('electron'), () => ({
          nativeTheme, app, ipcRenderer, webUtils: {},
          BrowserWindow: { getAllWindows: () => [liveWindow, { isDestroyed: () => true }] },
          ipcMain: { on() {}, handle: (channel, handler) => handlers.set(channel, handler) },
          contextBridge: { exposeInMainWorld: (_, value) => { bridge = value } },
        }))
        globalThis.window = new EventTarget()
        await import('./src/preload.cts')
        const { WindowAppearanceController } = await import('./src/windows/Appearance.ts')
        const { registerAppearanceIpc } = await import('./src/ipc/RegisterAppearanceIpc.ts')
        const appearance = new WindowAppearanceController(DEFAULT_APPEARANCE_SETTINGS)
        const updated = []
        appearance.onThemeChange(theme => updated.push(theme.ink))
        let saved
        registerAppearanceIpc(DEFAULT_APPEARANCE_SETTINGS, appearance,
          { save: async value => { saved = value } }, () => true)
        const received = []
        const unsubscribe = bridge.onSystemThemeChange(variant => received.push(variant))
        await bridge.saveAppearanceSettings({ ...DEFAULT_APPEARANCE_SETTINGS, mode: 'system' })
        assert.equal(saved.mode, 'system')
        assert.deepEqual(updated, [saved.chromeThemes.light.ink])
        assert.deepEqual(sent, [])
        nativeTheme.shouldUseDarkColors = true
        nativeTheme.emit('updated')
        assert.deepEqual(sent, [[channels.systemThemeChanged, 'dark']])
        assert.deepEqual(updated, [saved.chromeThemes.light.ink, saved.chromeThemes.dark.ink])
        assert.deepEqual(received, ['dark'])
        unsubscribe()
        nativeTheme.shouldUseDarkColors = false
        nativeTheme.emit('updated')
        assert.deepEqual(received, ['dark'])
        app.emit('will-quit')
        assert.equal(nativeTheme.listenerCount('updated'), 0)
      `,
    ],
    { cwd: resolve(import.meta.dir, '..'), timeout: 5_000 },
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})
