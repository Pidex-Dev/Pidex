import { useStore } from 'zustand/react'
import { createStore } from 'zustand/vanilla'

export type SettingsDialogState = {
  open: boolean
  destination: string
  activeTab: string
  opener: HTMLElement | null
  revision: number
}

const DEFAULT_SETTINGS_DESTINATION = '/settings/general'

const settingsDialogStore = createStore<SettingsDialogState>(() => ({
  open: false,
  destination: DEFAULT_SETTINGS_DESTINATION,
  activeTab: 'general',
  opener: null,
  revision: 0,
}))

type NavigationSubscriber = (destination: string) => void
const navigationSubscribers = new Set<NavigationSubscriber>()

export function isSettingsPath(pathname: string): boolean {
  const normalized = pathname.trim()
  if (normalized === '/settings' || normalized === '/settings/') return true
  if (!normalized.startsWith('/settings/')) return false
  return normalized !== '/settings/providers' && !normalized.startsWith('/settings/providers/')
}

export function normalizeSettingsDestination(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_SETTINGS_DESTINATION
  const url = new URL(trimmed, 'http://pidex.local')
  let pathname = url.pathname
  const params = new URLSearchParams(url.search)

  if (pathname === '/settings' || pathname === '/settings/') {
    pathname = DEFAULT_SETTINGS_DESTINATION
  } else if (pathname.startsWith('/settings/environment/')) {
    const projectId = pathname.slice('/settings/environment/'.length).replace(/\/+$/u, '')
    if (projectId && !params.has('projectId')) {
      params.set('projectId', decodeURIComponent(projectId))
    }
    pathname = '/settings/environments'
  } else if (
    pathname === '/settings/local-environment' ||
    pathname === '/settings/local-environment/'
  ) {
    pathname = '/settings/environments'
  } else if (pathname === '/settings/worktrees' && params.get('tab') === 'environments') {
    params.delete('tab')
    pathname = '/settings/environments'
  }

  const query = params.toString()
  return `${pathname}${query ? `?${query}` : ''}${url.hash}`
}

export function extractSettingsTab(destination: string): string {
  const pathname = destination.split(/[?#]/, 1)[0] ?? ''
  if (pathname.startsWith('/settings/environment/')) return 'environments'
  const match = /^\/settings\/([^/]+)/.exec(pathname)
  return match ? decodeURIComponent(match[1]!) : 'general'
}

export function openSettingsDialog(
  destination: string = DEFAULT_SETTINGS_DESTINATION,
  options?: { opener?: HTMLElement | null },
): void {
  const normalized = normalizeSettingsDestination(destination)
  const pathname = normalized.split(/[?#]/, 1)[0] ?? ''
  if (!isSettingsPath(pathname)) return
  const activeTab = extractSettingsTab(normalized)
  const current = settingsDialogStore.getState()
  const activeElement =
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  const opener = current.open ? current.opener : (options?.opener ?? activeElement)
  settingsDialogStore.setState({
    open: true,
    destination: normalized,
    activeTab,
    opener,
    revision: current.revision + 1,
  })
  if (current.open) {
    for (const subscriber of navigationSubscribers) {
      subscriber(normalized)
    }
  }
}

export function closeSettingsDialog(): void {
  const current = settingsDialogStore.getState()
  if (!current.open) return
  settingsDialogStore.setState({
    ...current,
    open: false,
  })
}

export function setSettingsDialogActiveTab(tab: string): void {
  const current = settingsDialogStore.getState()
  if (current.activeTab === tab) return
  settingsDialogStore.setState({
    ...current,
    activeTab: tab,
  })
}

export function subscribeSettingsDialogNavigation(listener: NavigationSubscriber): () => void {
  navigationSubscribers.add(listener)
  return () => {
    navigationSubscribers.delete(listener)
  }
}

export function getSettingsDialogSnapshot(): SettingsDialogState {
  return settingsDialogStore.getState()
}

export function resetSettingsDialogStateForTest(): void {
  settingsDialogStore.setState({
    open: false,
    destination: DEFAULT_SETTINGS_DESTINATION,
    activeTab: 'general',
    opener: null,
    revision: 0,
  })
  navigationSubscribers.clear()
}

export function useSettingsDialogState(): SettingsDialogState {
  return useStore(settingsDialogStore)
}

export function useSettingsDialogOpen(): boolean {
  return useStore(settingsDialogStore, (state) => state.open)
}

export function useSettingsDialogActiveTab(): string | null {
  return useStore(settingsDialogStore, (state) => (state.open ? state.activeTab : null))
}
