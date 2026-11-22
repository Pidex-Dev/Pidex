import * as React from 'react'
import { useExternalSubscription } from '../../../hooks/UseExternalSubscription.js'
import {
  loadConversationUiState,
  patchConversationUiState,
  validateConversationUiState,
} from '../../layout/tabs/ConversationUiState.js'

/** Minimum container width where the overview switches from floating overlay to inline placement. */
export const THREAD_SUMMARY_INLINE_MIN_WIDTH = 1056

/** Minimum container width where the right gutter accommodates the overview without shifting the thread column. */
export const THREAD_SUMMARY_GUTTER_MIN_WIDTH = 1456

/** Storage key for the globally persisted collapsed overview sections. */
export const THREAD_SUMMARY_COLLAPSED_SECTIONS_STORAGE_KEY =
  'pidex.thread-summary.collapsed-sections.v1'

/** Canonical section identifiers rendered inside the thread summary panel. */
export const THREAD_SUMMARY_SECTION_IDS = [
  'environment',
  'goal',
  'agents',
  'browser',
  'sources',
  'artifacts',
] as const

/** Identifier of a collapsible section inside the thread summary panel. */
export type ThreadSummarySectionId = (typeof THREAD_SUMMARY_SECTION_IDS)[number]

/** Responsive placement mode for the thread summary panel. */
export type ThreadSummaryDisplayMode = 'overlay' | 'shift' | 'gutter'

const CONVERSATION_UI_STATE_STORAGE_PREFIX = 'conversation.ui-state.'
const THREAD_SUMMARY_DEFAULT_BOTTOM_INSET_PX = 16
const THREAD_SUMMARY_FOOTER_GAP_PX = 12
const VALID_SECTION_IDS = new Set<string>(THREAD_SUMMARY_SECTION_IDS)
const EMPTY_COLLAPSED_SECTIONS: ReadonlySet<ThreadSummarySectionId> = new Set()

const summaryOpenListeners = new Set<() => void>()
const summaryOpenCache = new Map<string, { raw: string | null; open: boolean }>()
let draftSummaryOpen = false

const collapsedSectionsListeners = new Set<() => void>()
let collapsedSectionsCache: {
  raw: string | null
  sections: ReadonlySet<ThreadSummarySectionId>
} = {
  raw: null,
  sections: EMPTY_COLLAPSED_SECTIONS,
}

function readLocalStorageItem(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocalStorageItem(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // INVARIANT: Storage failures leave the in-memory preference intact so the UI remains usable.
  }
}

function notifyListeners(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) listener()
}

function subscribeStorageBackedListeners(
  listeners: Set<() => void>,
  matchesKey: (key: string | null) => boolean,
): (onStoreChange: () => void) => () => void {
  return (onStoreChange) => {
    listeners.add(onStoreChange)
    const handleStorage = (event: StorageEvent): void => {
      if (matchesKey(event.key)) {
        onStoreChange()
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', handleStorage)
    }
    return () => {
      listeners.delete(onStoreChange)
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', handleStorage)
      }
    }
  }
}

const subscribeSummaryOpen = subscribeStorageBackedListeners(
  summaryOpenListeners,
  (key) => key === null || key.startsWith(CONVERSATION_UI_STATE_STORAGE_PREFIX),
)

const subscribeCollapsedSections = subscribeStorageBackedListeners(
  collapsedSectionsListeners,
  (key) => key === null || key === THREAD_SUMMARY_COLLAPSED_SECTIONS_STORAGE_KEY,
)

/** Resolves the summary placement mode from the conversation body width. */
export function resolveThreadSummaryDisplayMode(containerWidth: number): ThreadSummaryDisplayMode {
  if (containerWidth < THREAD_SUMMARY_INLINE_MIN_WIDTH) return 'overlay'
  if (containerWidth < THREAD_SUMMARY_GUTTER_MIN_WIDTH) return 'shift'
  return 'gutter'
}

/** Reads the persisted open state for a conversation's summary panel. */
export function readThreadSummaryOpen(sessionId: string | null | undefined): boolean {
  if (!sessionId) return draftSummaryOpen
  const raw = readLocalStorageItem(CONVERSATION_UI_STATE_STORAGE_PREFIX + sessionId)
  const cached = summaryOpenCache.get(sessionId)
  if (cached && cached.raw === raw) {
    return cached.open
  }
  const open = validateConversationUiState(loadConversationUiState(sessionId)).summaryOpen === true
  summaryOpenCache.set(sessionId, { raw, open })
  return open
}

/** Persists the open state for a conversation's summary panel and notifies subscribers. */
export function setThreadSummaryOpen(sessionId: string | null | undefined, open: boolean): void {
  if (!sessionId) {
    draftSummaryOpen = open
  } else {
    patchConversationUiState(sessionId, { summaryOpen: open })
    const raw = readLocalStorageItem(CONVERSATION_UI_STATE_STORAGE_PREFIX + sessionId)
    summaryOpenCache.set(sessionId, { raw, open })
  }
  notifyListeners(summaryOpenListeners)
}

function parseCollapsedSections(raw: string | null): ReadonlySet<ThreadSummarySectionId> {
  if (!raw) return EMPTY_COLLAPSED_SECTIONS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return EMPTY_COLLAPSED_SECTIONS
    const next = new Set<ThreadSummarySectionId>()
    for (const entry of parsed) {
      if (typeof entry === 'string' && VALID_SECTION_IDS.has(entry)) {
        next.add(entry as ThreadSummarySectionId)
      }
    }
    return next.size > 0 ? next : EMPTY_COLLAPSED_SECTIONS
  } catch {
    return EMPTY_COLLAPSED_SECTIONS
  }
}

/** Reads the globally persisted collapsed summary section set. */
export function readThreadSummaryCollapsedSections(): ReadonlySet<ThreadSummarySectionId> {
  const raw = readLocalStorageItem(THREAD_SUMMARY_COLLAPSED_SECTIONS_STORAGE_KEY)
  if (collapsedSectionsCache.raw === raw) {
    return collapsedSectionsCache.sections
  }
  const sections = parseCollapsedSections(raw)
  collapsedSectionsCache = { raw, sections }
  return sections
}

/** Toggles a summary section's global collapsed state and persists it to localStorage. */
export function toggleThreadSummarySection(id: ThreadSummarySectionId): void {
  const next = new Set(readThreadSummaryCollapsedSections())
  if (next.has(id)) next.delete(id)
  else next.add(id)
  const ordered = THREAD_SUMMARY_SECTION_IDS.filter((sectionId) => next.has(sectionId))
  const serialized = JSON.stringify(ordered)
  writeLocalStorageItem(THREAD_SUMMARY_COLLAPSED_SECTIONS_STORAGE_KEY, serialized)
  const raw = readLocalStorageItem(THREAD_SUMMARY_COLLAPSED_SECTIONS_STORAGE_KEY)
  collapsedSectionsCache = {
    raw,
    sections: ordered.length > 0 ? new Set(ordered) : EMPTY_COLLAPSED_SECTIONS,
  }
  notifyListeners(collapsedSectionsListeners)
}

/** Subscribes a component to the globally persisted collapsed summary sections. */
export function useThreadSummaryCollapsedSections(): readonly [
  ReadonlySet<ThreadSummarySectionId>,
  (id: ThreadSummarySectionId) => void,
] {
  const collapsedSections = useExternalSubscription(
    subscribeCollapsedSections,
    readThreadSummaryCollapsedSections,
  )
  return [collapsedSections, toggleThreadSummarySection] as const
}

/** Coordinates responsive summary placement, footer clearance, and per-session open persistence. */
export function useThreadSummaryController(
  containerRef: React.RefObject<HTMLElement | null>,
  sessionId: string | null | undefined,
  footerRef?: React.RefObject<HTMLElement | null>,
  hasFooter = false,
): {
  displayMode: ThreadSummaryDisplayMode
  isInline: boolean
  isOpen: boolean
  setOpen: (open: boolean) => void
} {
  const [displayMode, setDisplayMode] = React.useState<ThreadSummaryDisplayMode>('overlay')

  const getOpenSnapshot = React.useCallback(() => readThreadSummaryOpen(sessionId), [sessionId])
  const isOpen = useExternalSubscription(subscribeSummaryOpen, getOpenSnapshot)
  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      setThreadSummaryOpen(sessionId, nextOpen)
    },
    [sessionId],
  )

  React.useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const footer = footerRef?.current ?? null
    // INVARIANT: Placement values come from post-layout ResizeObserver entry snapshots and skip unchanged CSS variable writes so observer iterations never dirty or force layout.
    let lastClearance: number | null = null
    let containerWidth = 0
    let footerHeight = 0
    const update = (): void => {
      React.startTransition(() => {
        setDisplayMode(resolveThreadSummaryDisplayMode(containerWidth))
      })
      const clearance =
        footerHeight > 0
          ? footerHeight + THREAD_SUMMARY_FOOTER_GAP_PX
          : THREAD_SUMMARY_DEFAULT_BOTTOM_INSET_PX
      if (clearance !== lastClearance) {
        lastClearance = clearance
        container.style.setProperty('--thread-summary-footer-clearance', `${clearance}px`)
      }
    }
    let frameId: number | null = null
    const scheduleUpdate = (): void => {
      if (frameId !== null) return
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        update()
      })
    }
    if (typeof ResizeObserver === 'undefined') {
      containerWidth = container.getBoundingClientRect().width
      footerHeight = footer ? Math.ceil(footer.getBoundingClientRect().height) : 0
      update()
      return
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === container) containerWidth = entry.contentRect.width
        else
          footerHeight = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height)
      }
      scheduleUpdate()
    })
    observer.observe(container)
    if (footer) observer.observe(footer)
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId)
      observer.disconnect()
    }
  }, [containerRef, footerRef, hasFooter])

  return {
    displayMode,
    isInline: displayMode !== 'overlay',
    isOpen,
    setOpen,
  }
}
