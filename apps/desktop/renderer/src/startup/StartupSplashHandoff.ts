import { swapStatusText } from './StatusTextSwap.js'
import type { StartupRecoveryAction } from './StartupConnection.js'

export const SPLASH_FADE_MS = 200
export const SPLASH_STALL_MS = 20_000
export const PET_OVERLAY_HASH_PREFIX = '#/pet-overlay'

let shell: ReturnType<typeof createStartupShell> | undefined

export function createStartupShell(splash: HTMLElement) {
  let finished = false
  let ready = false
  let frame: number | undefined
  const loading = new Set<symbol>()
  const label = splash.querySelector<HTMLElement>('.full-screen-whale-loader__status')
  const actions = document.getElementById('startup-actions')
  const reload = document.getElementById('startup-reload')
  const restore = document.getElementById('startup-restore')
  const detail = document.getElementById('startup-detail')
  let recovery: readonly StartupRecoveryAction[] = []
  let pending: StartupRecoveryAction | undefined
  function bindRecovery(link: HTMLElement | null, action?: StartupRecoveryAction) {
    if (!link) return
    link.textContent = action?.label ?? '重新加载'
    link.onclick = async (event) => {
      event.preventDefault()
      if (pending || finished) return
      if (!action) {
        window.location.reload()
        return
      }
      pending = action
      if (detail) detail.textContent = ''
      try {
        await action.run(window.DesktopBridge!)
      } catch {
        if (pending === action && detail) detail.textContent = action.errorMessage
      } finally {
        if (pending === action) pending = undefined
      }
    }
  }
  function setRecovery(next: readonly StartupRecoveryAction[]) {
    recovery = next
    pending = undefined
    bindRecovery(reload, next[0])
    if (restore) {
      restore.hidden = !next[1]
      if (next[1]) bindRecovery(restore, next[1])
      else restore.onclick = null
    }
    if (detail) detail.textContent = ''
  }
  setRecovery([])
  const stalled = window.setTimeout(() => {
    if (finished) return
    if (actions) actions.hidden = false
    if (detail) detail.textContent = '启动时间较长，可以继续等待或重新加载。'
  }, SPLASH_STALL_MS)
  const finishIfReady = () => {
    if (!ready || finished || loading.size || frame !== undefined) return
    frame = window.requestAnimationFrame(() => {
      frame = undefined
      if (!ready || finished || loading.size) return
      finished = true
      window.clearTimeout(stalled)
      splash.removeAttribute('aria-busy')
      const reduced = document.documentElement.dataset.reduceMotion
      if (
        reduced === 'on' ||
        (reduced !== 'off' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      ) {
        splash.remove()
      } else {
        splash.classList.add('full-screen-whale-loader--exiting')
        window.setTimeout(() => splash.remove(), SPLASH_FADE_MS + 40)
      }
      console.info('desktop.startup-surface-committed')
    })
  }
  const syncStatusText = (text: string) => {
    splash.setAttribute('aria-label', text)
    if (!label) return
    if (label.parentElement?.hidden) {
      if (label.textContent !== text) label.textContent = text
      return
    }
    swapStatusText(label, text)
  }
  return {
    active: () => !finished,
    label(text: string) {
      if (finished) return
      if (recovery.length) setRecovery([])
      syncStatusText(text)
    },
    fail(text: string, recoveryActions: readonly StartupRecoveryAction[] = []) {
      if (finished) return
      setRecovery(recoveryActions)
      window.clearTimeout(stalled)
      if (label?.parentElement) label.parentElement.hidden = false
      syncStatusText(text)
      splash.setAttribute('role', 'alert')
      if (actions) actions.hidden = false
    },
    ready() {
      ready = true
      finishIfReady()
    },
    loading(text: string) {
      const token = Symbol()
      loading.add(token)
      if (!finished) syncStatusText(text)
      return () => {
        loading.delete(token)
        finishIfReady()
      }
    },
  }
}

export function installStartupSplashHandoff(): void {
  const splash = document.getElementById('startup-splash')
  if (!splash || shell) return
  if (window.location.hash.startsWith(PET_OVERLAY_HASH_PREFIX)) {
    splash.remove()
    return
  }
  shell = createStartupShell(splash)
  document.getElementById('startup-logs')?.addEventListener('click', (event) => {
    event.preventDefault()
    void window.DesktopBridge?.openLogDirectory().catch(() => {})
  })
}

export const startupSplashActive = (): boolean => shell?.active() ?? false
export const reportStartupLoading = (label: string): (() => void) =>
  shell?.loading(label) ?? (() => {})
export function reportStartupLabel(label: string): void {
  shell?.label(label)
}
export function reportStartupFailure(
  label: string,
  actions?: readonly StartupRecoveryAction[],
): void {
  shell?.fail(label, actions)
}
export const reportStartupReady = (): void => shell?.ready()
export const startupSurfaceReadyRef = (element: HTMLElement | null): void => {
  if (element) reportStartupReady()
}
