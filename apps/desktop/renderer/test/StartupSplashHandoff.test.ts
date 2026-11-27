import { afterEach, describe, expect, test } from 'bun:test'
import { createStartupShell, SPLASH_STALL_MS } from '../src/startup/StartupSplashHandoff.js'
import { startupRecoveryActions } from '../src/startup/StartupConnection.js'

const originalWindow = globalThis.window
const originalDocument = globalThis.document

afterEach(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
})

function fixture() {
  const timers = new Map<number, { callback: () => void; ms: number }>()
  const frames: Array<() => void> = []
  const label = { textContent: '正在启动…' }
  const actions = { hidden: true }
  const detail = { textContent: '' }
  const reload = {
    textContent: '',
    onclick: null as ((event: Pick<Event, 'preventDefault'>) => Promise<void>) | null,
  }
  const restore = { ...reload, hidden: true }
  const elements: Record<string, unknown> = {
    'startup-actions': actions,
    'startup-detail': detail,
    'startup-reload': reload,
    'startup-restore': restore,
  }
  let removed = 0
  let nextTimer = 0
  globalThis.document = {
    documentElement: { dataset: { reduceMotion: 'on' } },
    getElementById: (id: string) => elements[id] ?? null,
  } as unknown as Document
  globalThis.window = {
    setTimeout: (callback: () => void, ms: number) => {
      timers.set(++nextTimer, { callback, ms })
      return nextTimer
    },
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: () => void) => {
      frames.push(callback)
      return frames.length
    },
    matchMedia: () => ({ matches: true }),
  } as unknown as Window & typeof globalThis
  const splash = {
    querySelector: () => label,
    remove: () => removed++,
    removeAttribute: () => {},
    setAttribute: () => {},
    classList: { add: () => {} },
  } as unknown as HTMLElement
  const shell = createStartupShell(splash)
  return {
    shell,
    actions,
    label,
    detail,
    reload,
    restore,
    removed: () => removed,
    flush: () => frames.splice(0).forEach((callback) => callback()),
    stall: () =>
      [...timers.values()]
        .filter((timer) => timer.ms === SPLASH_STALL_MS)
        .forEach((timer) => timer.callback()),
  }
}

describe('单次启动交接', () => {
  test('迁址恢复失败可以重试；切回普通断线时只重试当前连接', async () => {
    const f = fixture()
    const calls: string[] = []
    let failRestore = true
    Object.assign(window, {
      DesktopBridge: {
        retryDataLocation: async () => {
          calls.push('retry relocation')
        },
        restoreDataLocation: async () => {
          calls.push('restore')
          if (failRestore) throw new Error('fixture')
        },
        retryStartup: async (generation: number) => {
          calls.push(`connection ${generation}`)
        },
      },
    })
    const failed = { state: 'failed', generation: 3, revision: 7, label: '失败' } as const
    const relocation = startupRecoveryActions({ ...failed, failureReason: 'relocation' })
    const click = (link: typeof f.reload) => link.onclick!({ preventDefault() {} })
    f.shell.fail(failed.label, relocation)
    expect(f.reload.textContent).toBe('重试迁移')
    expect(f.restore.hidden).toBe(false)
    expect(f.restore.textContent).toBe('恢复原位置并重启')
    await click(f.restore)
    expect(f.detail.textContent).toContain('无法恢复原数据位置')
    failRestore = false
    await click(f.restore)
    f.shell.fail(failed.label, relocation)
    await click(f.reload)
    f.shell.label('正在连接')
    expect(f.restore.hidden).toBe(true)
    f.shell.fail(failed.label, startupRecoveryActions(failed))
    expect(f.reload.textContent).toBe('重试连接')
    expect(f.restore.onclick).toBeNull()
    await click(f.reload)
    expect(calls).toEqual(['restore', 'restore', 'retry relocation', 'connection 3'])
  })
  test('首屏已提交仍需等待阻塞加载结束，下一帧只退出一次', () => {
    const f = fixture()
    const release = f.shell.loading('正在读取模型配置…')
    f.shell.ready()
    f.flush()
    expect(f.removed()).toBe(0)
    release()
    f.flush()
    f.shell.ready()
    f.flush()
    expect(f.removed()).toBe(1)
  })
  test('20 秒只显示恢复入口，不撤掉加载页', () => {
    const f = fixture()
    f.stall()
    expect(f.actions.hidden).toBe(false)
    expect(f.detail.textContent).toContain('继续等待')
    expect(f.removed()).toBe(0)
  })
  test('资源失败留在启动壳，错误页提交后正常交接', () => {
    const f = fixture()
    const viewport = { hidden: true }
    ;(f.label as { parentElement?: { hidden: boolean } }).parentElement = viewport
    const release = f.shell.loading('正在读取模型配置…')
    expect(viewport.hidden).toBe(true)
    expect(f.label.textContent).toBe('正在读取模型配置…')
    release()
    f.shell.fail('界面模块加载失败')
    expect(viewport.hidden).toBe(false)
    expect(f.label.textContent).toBe('界面模块加载失败')
    expect(f.actions.hidden).toBe(false)
    expect(f.removed()).toBe(0)
    f.shell.ready()
    f.flush()
    expect(f.removed()).toBe(1)
  })
})
