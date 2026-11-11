export const TITLEBAR_SESSION_TABS_STORAGE_KEY = 'pidex.desktop.titlebarSessionTabs.v1'

export type TitlebarSessionTabItem = {
  id: string
  title: string
  subtitle?: string | null
  active: boolean
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

export function readStoredTitlebarSessionTabIds(
  storage: Storage | null | undefined = defaultStorage(),
): string[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(TITLEBAR_SESSION_TABS_STORAGE_KEY)
    if (!raw) return []
    return normalizeTitlebarSessionTabIds(JSON.parse(raw))
  } catch {
    return []
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
