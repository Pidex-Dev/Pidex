export const TITLEBAR_SESSION_TABS_STORAGE_KEY = 'pidex.desktop.titlebarSessionTabs.v1'

export type TitlebarSessionTabItem = {
  id: string
  title: string
  subtitle?: string | null
  active: boolean
}

export type StoredTitlebarSessionTabSnapshot = {
  id: string
  title?: string
  subtitle?: string | null
}

function defaultStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function normalizeTitlebarSessionTabIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function normalizeTitlebarSessionTabSnapshots(
  value: unknown,
): StoredTitlebarSessionTabSnapshot[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: StoredTitlebarSessionTabSnapshot[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const id = item.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      result.push({ id })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const record = item as { id?: unknown; title?: unknown; subtitle?: unknown }
    if (typeof record.id !== 'string') continue
    const id = record.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const snapshot: StoredTitlebarSessionTabSnapshot = { id }
    if (typeof record.title === 'string') {
      const title = record.title.trim()
      if (title) snapshot.title = title
    }
    if (typeof record.subtitle === 'string') {
      const subtitle = record.subtitle.trim()
      snapshot.subtitle = subtitle || null
    } else if (record.subtitle === null) {
      snapshot.subtitle = null
    }
    result.push(snapshot)
  }
  return result
}

export function readStoredTitlebarSessionTabSnapshots(
  storage: Storage | null | undefined = defaultStorage(),
): StoredTitlebarSessionTabSnapshot[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(TITLEBAR_SESSION_TABS_STORAGE_KEY)
    if (!raw) return []
    return normalizeTitlebarSessionTabSnapshots(JSON.parse(raw))
  } catch {
    return []
  }
}

export function readStoredTitlebarSessionTabIds(
  storage: Storage | null | undefined = defaultStorage(),
): string[] {
  return readStoredTitlebarSessionTabSnapshots(storage).map((tab) => tab.id)
}

export function writeStoredTitlebarSessionTabSnapshots(
  tabs: readonly StoredTitlebarSessionTabSnapshot[],
  storage: Storage | null | undefined = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(
      TITLEBAR_SESSION_TABS_STORAGE_KEY,
      JSON.stringify(normalizeTitlebarSessionTabSnapshots(tabs)),
    )
  } catch {
    /* localStorage full or disabled; keep in-memory state. */
  }
}

export function writeStoredTitlebarSessionTabIds(
  tabIds: readonly string[],
  storage: Storage | null | undefined = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(
      TITLEBAR_SESSION_TABS_STORAGE_KEY,
      JSON.stringify(normalizeTitlebarSessionTabIds(tabIds)),
    )
  } catch {
    /* localStorage full or disabled; keep in-memory state. */
  }
}

export function mergeTitlebarSessionTabIdsFromSettings(
  localIds: readonly string[],
  settingsIds: readonly string[],
  activeRoutedSessionId?: string | null,
): {
  nextIds: string[]
  shouldWriteBackToSettings: boolean
} {
  const normalizedSettings = normalizeTitlebarSessionTabIds(settingsIds)
  const normalizedLocal = normalizeTitlebarSessionTabIds(localIds)
  if (normalizedSettings.length > 0) {
    const nextIds = activeRoutedSessionId
      ? openTitlebarSessionTab(normalizedSettings, activeRoutedSessionId)
      : normalizedSettings
    return {
      nextIds,
      shouldWriteBackToSettings: nextIds.length !== normalizedSettings.length,
    }
  }
  if (normalizedLocal.length > 0) {
    const nextIds = activeRoutedSessionId
      ? openTitlebarSessionTab(normalizedLocal, activeRoutedSessionId)
      : normalizedLocal
    return {
      nextIds,
      shouldWriteBackToSettings: true,
    }
  }
  const nextIds = activeRoutedSessionId ? openTitlebarSessionTab([], activeRoutedSessionId) : []
  return {
    nextIds,
    shouldWriteBackToSettings: nextIds.length > 0,
  }
}

export function openTitlebarSessionTab(
  tabIds: readonly string[],
  sessionId: string,
): string[] {
  const normalized = sessionId.trim()
  if (!normalized) return [...tabIds]
  if (tabIds.includes(normalized)) return [...tabIds]
  return [...tabIds, normalized]
}

export function closeTitlebarSessionTab(
  tabIds: readonly string[],
  closingSessionId: string,
  activeSessionId: string | null,
): {
  nextTabIds: string[]
  /**
   * `undefined` 表示关闭的是非激活标签，不需要切换路由；
   * `string` 表示切换到相邻会话标签；
   * `null` 表示最后一个标签已关闭，应当导航回 `/new`。
   */
  nextActiveSessionId: string | null | undefined
} {
  const index = tabIds.indexOf(closingSessionId)
  if (index === -1) {
    return {
      nextTabIds: [...tabIds],
      nextActiveSessionId: undefined,
    }
  }
  const nextTabIds = tabIds.filter((id) => id !== closingSessionId)
  if (closingSessionId !== activeSessionId) {
    return {
      nextTabIds,
      nextActiveSessionId: undefined,
    }
  }
  if (nextTabIds.length === 0) {
    return {
      nextTabIds,
      nextActiveSessionId: null,
    }
  }
  const nextIndex = Math.min(index, nextTabIds.length - 1)
  return {
    nextTabIds,
    nextActiveSessionId: nextTabIds[nextIndex] ?? null,
  }
}

export function pruneTitlebarSessionTabs(
  tabIds: readonly string[],
  validSessionIds: ReadonlySet<string>,
  activePendingSessionId?: string | null,
): string[] {
  const next = tabIds.filter(
    (id) => validSessionIds.has(id) || (activePendingSessionId != null && id === activePendingSessionId),
  )
  if (next.length === tabIds.length && next.every((id, index) => id === tabIds[index])) {
    return tabIds as string[]
  }
  return next
}
