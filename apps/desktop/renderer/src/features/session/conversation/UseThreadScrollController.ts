import React from 'react'
import type { VirtualizerHandle } from 'virtua'

import { usePrefersReducedMotion } from '../../../hooks/UsePrefersReducedMotion.js'

export const THREAD_BOTTOM_THRESHOLD_PX = 24
export const THREAD_BOTTOM_GEOMETRIC_TOLERANCE_PX = 1.5
export const LATEST_TURN_PLACEMENT_THRESHOLD_PX = 300

export type ThreadScrollMode = 'static' | 'prework_watch' | 'prework_follow' | 'user_follow'

type ScrollMetrics = {
  scrollOffset: number
  scrollSize: number
  viewportSize: number
}

type ScrollModeInput = {
  mode: ThreadScrollMode
  active: boolean
  atBottom: boolean
  userScrolledUp: boolean
  contentChanged: boolean
  explicitFollow?: boolean
}

export type ScrollModeDecision = {
  mode: ThreadScrollMode
  hasNewContent: boolean
}

export function distanceFromThreadBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollSize - metrics.viewportSize - metrics.scrollOffset)
}

export function canReturnToThreadBottom(hasMeasuredBottom: boolean, isAtBottom: boolean): boolean {
  return hasMeasuredBottom && !isAtBottom
}

export function scrollOffsetForThreadBottomDistance(
  metrics: Pick<ScrollMetrics, 'scrollSize' | 'viewportSize'>,
  distanceFromBottom: number,
): number {
  return Math.max(0, metrics.scrollSize - metrics.viewportSize - Math.max(0, distanceFromBottom))
}

export function clampThreadScrollOffset(
  metrics: Pick<ScrollMetrics, 'scrollSize' | 'viewportSize'>,
  scrollOffset: number,
): number {
  return Math.min(Math.max(0, metrics.scrollSize - metrics.viewportSize), Math.max(0, scrollOffset))
}

export function resolveThreadScrollMode({
  mode,
  active,
  atBottom,
  userScrolledUp,
  contentChanged,
  explicitFollow = false,
}: ScrollModeInput): ScrollModeDecision {
  if (!active) {
    return { mode: 'static', hasNewContent: false }
  }
  if (explicitFollow) {
    return { mode: 'user_follow', hasNewContent: false }
  }
  if (userScrolledUp && !atBottom) {
    return { mode: 'static', hasNewContent: contentChanged }
  }
  if (atBottom) {
    return {
      mode: mode === 'user_follow' ? 'user_follow' : 'prework_follow',
      hasNewContent: false,
    }
  }
  if (contentChanged && mode === 'static') {
    return { mode: 'static', hasNewContent: true }
  }
  return { mode, hasNewContent: false }
}

type UseThreadScrollControllerOptions = {
  active: boolean
  contentRevision?: unknown
  initialScrollOffset?: number
  itemCount: number
  layoutResizeActive?: boolean
  listRef: React.RefObject<VirtualizerHandle | null>
  onScroll?: (scrollTop: number) => void
  scrollRef: React.RefObject<HTMLElement | null>
  sessionKey?: string
}

export type SavedThreadScrollState = {
  distanceFromBottom: number
  mode: ThreadScrollMode
  scrollOffset: number
}

export type ThreadResizeAnchor = {
  fallbackScrollOffset: number
  turnId: string
  viewportOffset: number
}

export function scrollOffsetForThreadResizeAnchor({
  anchor,
  currentScrollOffset,
  currentViewportOffset,
  metrics,
}: {
  anchor: Pick<ThreadResizeAnchor, 'fallbackScrollOffset' | 'viewportOffset'>
  currentScrollOffset: number
  currentViewportOffset: number | null
  metrics: Pick<ScrollMetrics, 'scrollSize' | 'viewportSize'>
}): number {
  return clampThreadScrollOffset(
    metrics,
    currentViewportOffset === null
      ? anchor.fallbackScrollOffset
      : currentScrollOffset + currentViewportOffset - anchor.viewportOffset,
  )
}

export const THREAD_SCROLL_STATE_CACHE_CAPACITY = 4
export const THREAD_SCROLL_STATE_CACHE_TTL_MS = 10 * 60 * 1_000

export type ThreadScrollStateCache = {
  clear(): void
  delete(sessionKey: string): void
  get(sessionKey: string): SavedThreadScrollState | null
  set(sessionKey: string, state: SavedThreadScrollState): void
  size(): number
}

export function createThreadScrollStateCache(
  options: {
    capacity?: number
    now?: () => number
    ttlMs?: number
  } = {},
): ThreadScrollStateCache {
  const capacity = Math.max(1, Math.floor(options.capacity ?? THREAD_SCROLL_STATE_CACHE_CAPACITY))
  const now = options.now ?? Date.now
  const ttlMs = Math.max(0, options.ttlMs ?? THREAD_SCROLL_STATE_CACHE_TTL_MS)
  const entries = new Map<
    string,
    {
      lastAccessAt: number
      state: SavedThreadScrollState
    }
  >()

  function removeExpired(timestamp: number): void {
    for (const [sessionKey, entry] of entries) {
      if (timestamp - entry.lastAccessAt >= ttlMs) entries.delete(sessionKey)
    }
  }

  return {
    clear(): void {
      entries.clear()
    },
    delete(sessionKey: string): void {
      entries.delete(sessionKey)
    },
    get(sessionKey: string): SavedThreadScrollState | null {
      const timestamp = now()
      const entry = entries.get(sessionKey)
      if (!entry) {
        removeExpired(timestamp)
        return null
      }
      if (timestamp - entry.lastAccessAt >= ttlMs) {
        entries.delete(sessionKey)
        return null
      }
      entry.lastAccessAt = timestamp
      entries.delete(sessionKey)
      entries.set(sessionKey, entry)
      return entry.state
    },
    set(sessionKey: string, state: SavedThreadScrollState): void {
      const timestamp = now()
      removeExpired(timestamp)
      entries.delete(sessionKey)
      entries.set(sessionKey, { lastAccessAt: timestamp, state })
      while (entries.size > capacity) {
        const oldestSessionKey = entries.keys().next().value
        if (oldestSessionKey === undefined) break
        entries.delete(oldestSessionKey)
      }
    },
    size(): number {
      removeExpired(now())
      return entries.size
    },
  }
}

const savedThreadScrollStates = createThreadScrollStateCache()

export function forgetThreadScrollState(sessionKey: string): void {
  savedThreadScrollStates.delete(sessionKey)
}

type ThreadScrollController = {
  pauseFollowing: () => void
  beginProgrammaticScroll: (smooth: boolean) => boolean
  bottomSentinelRef: (node: HTMLDivElement | null) => void
  handleScroll: (scrollTop: number) => void
  canReturnToBottom: boolean
  hasNewContent: boolean
  isAtBottom: boolean
  mode: ThreadScrollMode
  returnToBottom: () => void
}

export function isProgrammaticScrollActive(now: number, programmaticScrollUntil: number): boolean {
  return now <= programmaticScrollUntil
}

export function resolveThreadAtBottomDuringExplicitReturn({
  actualAtBottom,
  explicitReturnInProgress,
  now,
  programmaticScrollUntil,
}: {
  actualAtBottom: boolean
  explicitReturnInProgress: boolean
  now: number
  programmaticScrollUntil: number
}): boolean {
  return (
    actualAtBottom ||
    (explicitReturnInProgress && isProgrammaticScrollActive(now, programmaticScrollUntil))
  )
}

export function scrollVirtualizerToThreadBottom(
  handle: VirtualizerHandle | null,
  targetIndex: number,
  smooth: boolean,
  footerOffset = 0,
): boolean {
  if (!handle || targetIndex < 0) return false
  try {
    handle.scrollToIndex(targetIndex, {
      align: 'end',
      offset: normalizeThreadFooterOffset(footerOffset),
      smooth,
    })
    return true
  } catch {
    // The target turn can briefly be unavailable while virtua applies new data.
    // A later resize/count observation will request the bottom again.
    return false
  }
}

export function normalizeThreadFooterOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function readThreadFooterOffset(scrollElement: HTMLElement | null): number {
  if (!scrollElement || typeof getComputedStyle === 'undefined') return 0
  const value = Number.parseFloat(
    getComputedStyle(scrollElement).getPropertyValue('--thread-scroll-footer-height'),
  )
  return normalizeThreadFooterOffset(value)
}

function readMetrics(
  handle: VirtualizerHandle | null,
  scrollElement?: HTMLElement | null,
): ScrollMetrics | null {
  if (scrollElement) {
    return {
      scrollOffset: scrollElement.scrollTop,
      scrollSize: scrollElement.scrollHeight,
      viewportSize: scrollElement.clientHeight,
    }
  }
  if (!handle) return null
  return {
    scrollOffset: handle.scrollOffset,
    scrollSize: handle.scrollSize,
    viewportSize: handle.viewportSize,
  }
}

function readThreadResizeAnchor(viewport: HTMLElement | null): ThreadResizeAnchor | null {
  if (!viewport) return null
  const viewportRect = viewport.getBoundingClientRect()
  const rows = viewport.querySelectorAll<HTMLElement>('[data-turn-navigation-id]')
  for (const row of rows) {
    const turnId = row.getAttribute('data-turn-navigation-id')
    if (!turnId) continue
    const rowRect = row.getBoundingClientRect()
    if (rowRect.bottom <= viewportRect.top || rowRect.top >= viewportRect.bottom) {
      continue
    }
    return {
      fallbackScrollOffset: viewport.scrollTop,
      turnId,
      viewportOffset: rowRect.top - viewportRect.top,
    }
  }
  return null
}

function findThreadTurnRow(viewport: HTMLElement, turnId: string): HTMLElement | null {
  for (const row of viewport.querySelectorAll<HTMLElement>('[data-turn-navigation-id]')) {
    if (row.getAttribute('data-turn-navigation-id') === turnId) return row
  }
  return null
}

export function useThreadScrollController({
  active,
  contentRevision,
  initialScrollOffset = 0,
  itemCount,
  layoutResizeActive = false,
  listRef,
  onScroll,
  scrollRef,
  sessionKey,
}: UseThreadScrollControllerOptions): ThreadScrollController {
  const reducedMotion = usePrefersReducedMotion()
  const [mode, setModeState] = React.useState<ThreadScrollMode>('static')
  const [hasNewContent, setHasNewContent] = React.useState(false)
  const [hasMeasuredBottom, setHasMeasuredBottom] = React.useState(false)
  const [isAtBottom, setIsAtBottom] = React.useState(false)
  const [bottomSentinel, setBottomSentinel] = React.useState<HTMLDivElement | null>(null)
  const modeRef = React.useRef<ThreadScrollMode>('static')
  const activeRef = React.useRef(active)
  const atBottomRef = React.useRef(false)
  const previousActiveRef = React.useRef(active)
  const previousCountRef = React.useRef(itemCount)
  const itemCountRef = React.useRef(itemCount)
  const previousOffsetRef = React.useRef(0)
  const previousScrollSizeRef = React.useRef(0)
  const previousDistanceFromBottomRef = React.useRef(0)
  const previousContentInlineSizeRef = React.useRef(0)
  const observedItemCountRef = React.useRef(itemCount)
  const contentRevisionRef = React.useRef(contentRevision)
  const observedContentRevisionRef = React.useRef(contentRevision)
  const contentResizeFrameRef = React.useRef<number | null>(null)
  const pendingContentSizeRef = React.useRef<{
    blockSize: number
    inlineSize: number
  } | null>(null)
  const contentReflowActiveUntilRef = React.useRef(0)
  const programmaticScrollUntilRef = React.useRef(0)
  const explicitReturnInProgressRef = React.useRef(false)
  const pendingExplicitReturnRef = React.useRef(false)
  const scrollFrameRef = React.useRef<number | null>(null)
  const sessionKeyRef = React.useRef(sessionKey)
  const layoutResizeActiveRef = React.useRef(layoutResizeActive)
  const resizeAnchorRef = React.useRef<ThreadResizeAnchor | null>(null)
  const viewportSizeRef = React.useRef({ width: 0, height: 0 })
  const scrollSizeRef = React.useRef(0)
  const footerHeightRef = React.useRef(0)
  const pendingRestoreRef = React.useRef<number | null>(null)
  const switchedToFollowSessionRef = React.useRef(false)

  // INVARIANT: Consume post-layout ResizeObserver height snapshots for viewport and inner scroll content so rAF and IntersectionObserver callbacks do not force layout via scrollHeight/clientHeight.
  const readCachedOrLiveMetrics = React.useCallback(
    (scrollOffsetOverride?: number): ScrollMetrics | null => {
      const viewport = scrollRef.current
      const viewportHeight = viewportSizeRef.current.height
      const scrollSize = scrollSizeRef.current
      if (viewport && viewportHeight > 0 && scrollSize > 0) {
        return {
          scrollOffset: scrollOffsetOverride ?? previousOffsetRef.current,
          scrollSize: Math.max(scrollSize, viewportHeight),
          viewportSize: viewportHeight,
        }
      }
      return readMetrics(listRef.current, viewport)
    },
    [listRef, scrollRef],
  )

  activeRef.current = active
  itemCountRef.current = itemCount
  contentRevisionRef.current = contentRevision
  layoutResizeActiveRef.current = layoutResizeActive

  const setMode = React.useCallback((nextMode: ThreadScrollMode): void => {
    modeRef.current = nextMode
    setModeState(nextMode)
  }, [])

  const updateAtBottom = React.useCallback((nextAtBottom: boolean): void => {
    setHasMeasuredBottom(true)
    atBottomRef.current = nextAtBottom
    setIsAtBottom((current) => (current === nextAtBottom ? current : nextAtBottom))
  }, [])

  const resetBottomMeasurement = React.useCallback((): void => {
    atBottomRef.current = false
    setHasMeasuredBottom(false)
    setIsAtBottom(false)
  }, [])

  const beginProgrammaticScroll = React.useCallback(
    (smooth: boolean): boolean => {
      const useSmoothScroll = smooth && !reducedMotion
      programmaticScrollUntilRef.current = Date.now() + (useSmoothScroll ? 500 : 140)
      return useSmoothScroll
    },
    [reducedMotion],
  )

  const pauseFollowing = React.useCallback(() => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
    pendingExplicitReturnRef.current = false
    programmaticScrollUntilRef.current = 0
    explicitReturnInProgressRef.current = false
    setMode('static')
  }, [setMode])

  const scrollToEnd = React.useCallback(
    (smooth: boolean, explicitReturn = false): void => {
      if (!explicitReturn && pendingExplicitReturnRef.current && scrollFrameRef.current !== null) {
        return
      }
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
      }
      pendingExplicitReturnRef.current = explicitReturn
      scrollFrameRef.current = requestAnimationFrame(() => {
        // INVARIANT: the follow body reads live scrollHeight when the RO cache is cold; the second post-layout rAF keeps that read off a dirty tree in Chromium.
        scrollFrameRef.current = requestAnimationFrame(() => {
          scrollFrameRef.current = null
          pendingExplicitReturnRef.current = false
          const handle = listRef.current
          if (!handle) {
            explicitReturnInProgressRef.current = false
            return
          }
          const viewport = scrollRef.current
          const cachedMetrics = readCachedOrLiveMetrics()
          const currentScrollTop = cachedMetrics
            ? cachedMetrics.scrollOffset
            : (viewport?.scrollTop ?? 0)
          if (
            viewport &&
            !explicitReturn &&
            ((modeRef.current === 'static' && !atBottomRef.current) ||
              currentScrollTop < previousOffsetRef.current - 2)
          ) {
            explicitReturnInProgressRef.current = false
            return
          }
          const targetIndex = itemCountRef.current - 1
          if (!viewport && targetIndex >= 0) {
            const useSmoothScroll = beginProgrammaticScroll(smooth)
            explicitReturnInProgressRef.current = explicitReturn
            if (
              !scrollVirtualizerToThreadBottom(
                handle,
                targetIndex,
                useSmoothScroll,
                footerHeightRef.current > 0
                  ? footerHeightRef.current
                  : readThreadFooterOffset(scrollRef.current),
              )
            ) {
              explicitReturnInProgressRef.current = false
            }
          }
          if (viewport) {
            const maxScroll = cachedMetrics
              ? Math.max(0, cachedMetrics.scrollSize - cachedMetrics.viewportSize)
              : Math.max(0, viewport.scrollHeight - viewport.clientHeight)
            if (Math.abs(currentScrollTop - maxScroll) > 1) {
              const useSmoothScroll = smooth && !reducedMotion
              if (useSmoothScroll) {
                beginProgrammaticScroll(true)
                explicitReturnInProgressRef.current = explicitReturn
              } else {
                programmaticScrollUntilRef.current = 0
                explicitReturnInProgressRef.current = false
                previousOffsetRef.current = maxScroll
              }
              viewport.scrollTo({
                top: maxScroll,
                behavior: useSmoothScroll ? 'smooth' : 'instant',
              })
            } else {
              explicitReturnInProgressRef.current = false
            }
          }
        })
      })
    },
    [beginProgrammaticScroll, listRef, readCachedOrLiveMetrics, reducedMotion, scrollRef],
  )

  const applyDecision = React.useCallback(
    (decision: ScrollModeDecision): void => {
      setMode(decision.mode)
      setHasNewContent(decision.hasNewContent)
    },
    [setMode],
  )

  const restoreResizeAnchor = React.useCallback((): void => {
    const viewport = scrollRef.current
    const anchor = resizeAnchorRef.current
    const metrics = readMetrics(listRef.current, viewport)
    if (!viewport || !anchor || !metrics) return

    const row = findThreadTurnRow(viewport, anchor.turnId)
    const viewportTop = viewport.getBoundingClientRect().top
    const currentViewportOffset = row ? row.getBoundingClientRect().top - viewportTop : null
    const targetOffset = scrollOffsetForThreadResizeAnchor({
      anchor,
      currentScrollOffset: metrics.scrollOffset,
      currentViewportOffset,
      metrics,
    })
    if (Math.abs(targetOffset - metrics.scrollOffset) <= 0.5) return

    programmaticScrollUntilRef.current = Date.now() + 140
    previousOffsetRef.current = targetOffset
    viewport.scrollTop = targetOffset
  }, [listRef, scrollRef])

  React.useLayoutEffect(() => {
    if (layoutResizeActive) {
      const metrics = readMetrics(listRef.current, scrollRef.current)
      const shouldFollow =
        modeRef.current === 'prework_follow' ||
        modeRef.current === 'user_follow' ||
        atBottomRef.current ||
        (metrics !== null && distanceFromThreadBottom(metrics) <= THREAD_BOTTOM_THRESHOLD_PX)
      if (shouldFollow) {
        resizeAnchorRef.current = null
      } else {
        resizeAnchorRef.current ??= readThreadResizeAnchor(scrollRef.current)
      }
      return
    }
    if (!resizeAnchorRef.current) return
    let settleFrame: number | null = requestAnimationFrame(() => {
      settleFrame = requestAnimationFrame(() => {
        settleFrame = null
        restoreResizeAnchor()
        resizeAnchorRef.current = null
      })
    })
    return () => {
      if (settleFrame !== null) cancelAnimationFrame(settleFrame)
    }
  }, [layoutResizeActive, listRef, restoreResizeAnchor, scrollRef])

  const handleScroll = React.useCallback(
    (scrollTop: number): void => {
      if (pendingRestoreRef.current !== null) return
      onScroll?.(scrollTop)
      const metrics = readCachedOrLiveMetrics(scrollTop)
      if (!metrics) return

      const distance = distanceFromThreadBottom({
        ...metrics,
        scrollOffset: scrollTop,
      })
      const actualAtBottom = distance <= THREAD_BOTTOM_THRESHOLD_PX
      const atBottom = resolveThreadAtBottomDuringExplicitReturn({
        actualAtBottom,
        explicitReturnInProgress: explicitReturnInProgressRef.current,
        now: Date.now(),
        programmaticScrollUntil: programmaticScrollUntilRef.current,
      })
      if (actualAtBottom || !atBottom) {
        explicitReturnInProgressRef.current = false
        if (actualAtBottom) {
          programmaticScrollUntilRef.current = 0
        }
      }
      const previousOffset = previousOffsetRef.current
      const programmaticScrollActive = isProgrammaticScrollActive(
        Date.now(),
        programmaticScrollUntilRef.current,
      )
      const userScrolledUp = scrollTop < previousOffset - 2 && !programmaticScrollActive
      if (userScrolledUp && !atBottom && scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
        pendingExplicitReturnRef.current = false
        explicitReturnInProgressRef.current = false
      }

      previousOffsetRef.current = scrollTop
      previousDistanceFromBottomRef.current = distance
      updateAtBottom(atBottom)
      const decision = resolveThreadScrollMode({
        mode: modeRef.current,
        active: activeRef.current,
        atBottom,
        userScrolledUp,
        contentChanged: userScrolledUp,
      })
      applyDecision(decision)
      const currentSessionKey = sessionKeyRef.current
      if (currentSessionKey) {
        savedThreadScrollStates.set(currentSessionKey, {
          distanceFromBottom: distance,
          mode: decision.mode,
          scrollOffset: scrollTop,
        })
      }
    },
    [applyDecision, onScroll, readCachedOrLiveMetrics, updateAtBottom],
  )

  const handleContentResize = React.useCallback(
    (entry: ResizeObserverEntry): void => {
      pendingContentSizeRef.current = {
        blockSize: entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height,
        inlineSize: entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width,
      }
      if (contentResizeFrameRef.current !== null) return
      contentResizeFrameRef.current = requestAnimationFrame(() => {
        contentResizeFrameRef.current = null
        const observedSize = pendingContentSizeRef.current
        pendingContentSizeRef.current = null
        const metrics = readCachedOrLiveMetrics()
        if (!observedSize || !metrics || pendingRestoreRef.current !== null) return

        const now = performance.now()
        const previousInlineSize = previousContentInlineSizeRef.current
        const inlineSizeChanged =
          previousInlineSize > 0 && Math.abs(observedSize.inlineSize - previousInlineSize) > 0.5
        previousContentInlineSizeRef.current = observedSize.inlineSize

        const itemCountChanged = observedItemCountRef.current !== itemCountRef.current
        observedItemCountRef.current = itemCountRef.current
        const contentRevisionChanged =
          observedContentRevisionRef.current !== contentRevisionRef.current
        observedContentRevisionRef.current = contentRevisionRef.current
        const contentChanged = itemCountChanged || contentRevisionChanged
        if (inlineSizeChanged || layoutResizeActiveRef.current) {
          contentReflowActiveUntilRef.current = now + 100
        }
        const widthReflow = !contentChanged && now <= contentReflowActiveUntilRef.current

        const previousSize = previousScrollSizeRef.current
        previousScrollSizeRef.current = metrics.scrollSize
        if (previousSize === 0) {
          previousDistanceFromBottomRef.current = distanceFromThreadBottom(metrics)
          return
        }

        if (widthReflow) {
          const shouldFollow =
            modeRef.current === 'prework_follow' ||
            modeRef.current === 'user_follow' ||
            atBottomRef.current ||
            distanceFromThreadBottom(metrics) <= THREAD_BOTTOM_THRESHOLD_PX
          if (shouldFollow) resizeAnchorRef.current = null
          if (
            !shouldFollow &&
            (layoutResizeActiveRef.current || resizeAnchorRef.current !== null)
          ) {
            if (layoutResizeActiveRef.current) {
              resizeAnchorRef.current ??= readThreadResizeAnchor(scrollRef.current)
            }
            restoreResizeAnchor()
            const anchoredMetrics = readMetrics(listRef.current, scrollRef.current)
            if (anchoredMetrics) {
              previousDistanceFromBottomRef.current = distanceFromThreadBottom(anchoredMetrics)
            }
            return
          }
          const distance = shouldFollow ? 0 : previousDistanceFromBottomRef.current
          const targetOffset = scrollOffsetForThreadBottomDistance(metrics, distance)
          if (Math.abs(targetOffset - metrics.scrollOffset) > 0.5) {
            programmaticScrollUntilRef.current = Date.now() + 140
            previousOffsetRef.current = targetOffset
            if (scrollRef.current) scrollRef.current.scrollTop = targetOffset
            else listRef.current?.scrollTo(targetOffset)
          }
          previousDistanceFromBottomRef.current = distance
          const currentSessionKey = sessionKeyRef.current
          if (currentSessionKey) {
            savedThreadScrollStates.set(currentSessionKey, {
              distanceFromBottom: distance,
              mode: modeRef.current,
              scrollOffset: targetOffset,
            })
          }
          return
        }

        if (metrics.scrollSize <= previousSize + 0.5) {
          previousDistanceFromBottomRef.current = distanceFromThreadBottom(metrics)
          return
        }

        const shouldFollow =
          activeRef.current &&
          (modeRef.current === 'prework_follow' ||
            modeRef.current === 'user_follow' ||
            atBottomRef.current)
        if (shouldFollow) {
          previousDistanceFromBottomRef.current = 0
          setHasNewContent(false)
          const distance = distanceFromThreadBottom(metrics)
          const withinTolerance = distance <= THREAD_BOTTOM_GEOMETRIC_TOLERANCE_PX
          if (metrics.scrollOffset === 0 || !withinTolerance) {
            scrollToEnd(false)
          }
          return
        }
        const distance = distanceFromThreadBottom(metrics)
        previousDistanceFromBottomRef.current = distance
        if (activeRef.current) setHasNewContent(true)
        const currentSessionKey = sessionKeyRef.current
        if (currentSessionKey) {
          savedThreadScrollStates.set(currentSessionKey, {
            distanceFromBottom: distance,
            mode: modeRef.current,
            scrollOffset: metrics.scrollOffset,
          })
        }
      })
    },
    [listRef, readCachedOrLiveMetrics, restoreResizeAnchor, scrollRef, scrollToEnd],
  )

  const returnToBottom = React.useCallback((): void => {
    applyDecision(
      resolveThreadScrollMode({
        mode: modeRef.current,
        active: activeRef.current,
        atBottom: true,
        userScrolledUp: false,
        contentChanged: false,
        explicitFollow: true,
      }),
    )
    scrollToEnd(true, true)
  }, [applyDecision, scrollToEnd])

  React.useLayoutEffect(() => {
    sessionKeyRef.current = sessionKey
    resizeAnchorRef.current = null
    const savedState = sessionKey ? savedThreadScrollStates.get(sessionKey) : null
    const restoredOffset = savedState?.scrollOffset ?? initialScrollOffset
    pendingRestoreRef.current = restoredOffset > 0 ? restoredOffset : null
    const preserveHistoricalPosition = savedState
      ? savedState.distanceFromBottom > THREAD_BOTTOM_THRESHOLD_PX
      : initialScrollOffset > 0

    setMode('static')
    setHasNewContent(false)
    explicitReturnInProgressRef.current = false
    previousActiveRef.current = preserveHistoricalPosition ? activeRef.current : false
    switchedToFollowSessionRef.current = !preserveHistoricalPosition && activeRef.current
    viewportSizeRef.current = { width: 0, height: 0 }
    scrollSizeRef.current = 0
    footerHeightRef.current = 0
    const metrics =
      typeof ResizeObserver === 'undefined' ? readMetrics(listRef.current, scrollRef.current) : null
    previousCountRef.current = itemCountRef.current
    previousOffsetRef.current = restoredOffset
    previousScrollSizeRef.current = metrics?.scrollSize ?? 0
    previousDistanceFromBottomRef.current = metrics
      ? distanceFromThreadBottom({ ...metrics, scrollOffset: restoredOffset })
      : (savedState?.distanceFromBottom ?? 0)
    resetBottomMeasurement()
  }, [initialScrollOffset, listRef, scrollRef, sessionKey, setMode, resetBottomMeasurement])

  React.useLayoutEffect(() => {
    const restoredOffset = pendingRestoreRef.current
    if (restoredOffset !== null && itemCount > 0) {
      programmaticScrollUntilRef.current = Date.now() + 180
      let settleFrame: number | null = null
      const frame = requestAnimationFrame(() => {
        previousOffsetRef.current = restoredOffset
        if (scrollRef.current) {
          scrollRef.current.scrollTop = restoredOffset
          settleFrame = requestAnimationFrame(() => {
            settleFrame = null
            if (scrollRef.current) {
              scrollRef.current.scrollTop = restoredOffset
            }
            pendingRestoreRef.current = null
          })
        } else {
          listRef.current?.scrollTo(restoredOffset)
          pendingRestoreRef.current = null
        }
      })
      return () => {
        cancelAnimationFrame(frame)
        if (settleFrame !== null) cancelAnimationFrame(settleFrame)
      }
    }
  }, [itemCount, listRef, scrollRef, sessionKey])

  React.useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport || typeof ResizeObserver === 'undefined') return
    const inner = viewport.firstElementChild as HTMLElement | null
    let observedFooter = viewport.querySelector<HTMLElement>('.thread-scroll-layout__footer')
    let footerHeight = footerHeightRef.current

    const handleGeometryResize = (entries: ResizeObserverEntry[]): void => {
      const previous = viewportSizeRef.current
      let nextWidth = previous.width
      let nextHeight = previous.height
      let nextFooterHeight = footerHeight
      let scrollSizeChanged = false
      for (const entry of entries) {
        if (entry.target === viewport) {
          nextWidth = Math.round(entry.contentRect.width)
          nextHeight = Math.round(entry.contentRect.height)
        } else if (entry.target === inner) {
          const nextScrollSize = Math.round(
            entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height,
          )
          if (nextScrollSize !== scrollSizeRef.current) {
            scrollSizeRef.current = nextScrollSize
            scrollSizeChanged = true
          }
        } else if (entry.target === observedFooter) {
          nextFooterHeight = Math.round(
            entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height,
          )
        }
      }
      const viewportChanged = previous.width !== nextWidth || previous.height !== nextHeight
      const footerChanged = nextFooterHeight !== footerHeight
      if (!viewportChanged && !footerChanged && !scrollSizeChanged) return
      viewportSizeRef.current = { width: nextWidth, height: nextHeight }
      footerHeight = nextFooterHeight
      footerHeightRef.current = nextFooterHeight
      if (!viewportChanged && !footerChanged) return
      if (
        atBottomRef.current ||
        (activeRef.current &&
          (modeRef.current === 'prework_follow' || modeRef.current === 'user_follow'))
      ) {
        scrollToEnd(false)
        return
      }
      if (pendingRestoreRef.current !== null) return
      const metrics = readCachedOrLiveMetrics()
      if (!metrics) return
      const distance = distanceFromThreadBottom(metrics)
      previousDistanceFromBottomRef.current = distance
      updateAtBottom(distance <= THREAD_BOTTOM_THRESHOLD_PX)
    }

    const observer = new ResizeObserver(handleGeometryResize)
    observer.observe(viewport)
    if (inner) observer.observe(inner)
    if (observedFooter) observer.observe(observedFooter)

    const footerPresenceObserver =
      inner && typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            const nextFooter = viewport.querySelector<HTMLElement>('.thread-scroll-layout__footer')
            if (nextFooter === observedFooter) return
            if (observedFooter) observer.unobserve(observedFooter)
            observedFooter = nextFooter
            if (observedFooter) {
              observer.observe(observedFooter)
            } else {
              footerHeight = 0
              footerHeightRef.current = 0
            }
          })
        : null
    if (inner) footerPresenceObserver?.observe(inner, { childList: true })

    return () => {
      footerPresenceObserver?.disconnect()
      observer.disconnect()
    }
  }, [listRef, readCachedOrLiveMetrics, scrollRef, scrollToEnd, sessionKey, updateAtBottom])

  React.useEffect(() => {
    const wasActive = previousActiveRef.current
    previousActiveRef.current = active
    if (!active) {
      setMode('static')
      setHasNewContent(false)
      return
    }
    if (wasActive) return

    if (switchedToFollowSessionRef.current) {
      switchedToFollowSessionRef.current = false
      setMode('prework_follow')
      setHasNewContent(false)
      scrollToEnd(false)
      return
    }

    setMode('prework_watch')
    const frame = requestAnimationFrame(() => {
      const handle = listRef.current
      const metrics = readCachedOrLiveMetrics()
      if (!handle || !metrics) return
      const atBottom = distanceFromThreadBottom(metrics) <= THREAD_BOTTOM_THRESHOLD_PX
      setMode('prework_follow')
      setHasNewContent(false)
      if (atBottom) {
        scrollToEnd(false)
        return
      }

      try {
        if (itemCount > 0) {
          const latestTurnIndex = itemCount - 1
          const latestTurnOffset = handle.getItemOffset(latestTurnIndex)
          const latestTurnDistance = latestTurnOffset - metrics.scrollOffset
          programmaticScrollUntilRef.current = Date.now() + 180
          if (latestTurnDistance > LATEST_TURN_PLACEMENT_THRESHOLD_PX) {
            if (scrollRef.current) {
              previousOffsetRef.current = latestTurnOffset
              scrollRef.current.scrollTop = latestTurnOffset
            } else {
              handle.scrollToIndex(latestTurnIndex, { align: 'start' })
            }
            return
          }
        }
      } catch {
        // The virtualizer can still be measuring the new row; bottom anchoring
        // is the safe fallback and the ResizeObserver will correct it again.
      }
      if (activeRef.current) {
        scrollToEnd(false)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [active, itemCount, listRef, readCachedOrLiveMetrics, scrollRef, scrollToEnd, sessionKey, setMode])

  React.useEffect(() => {
    if (itemCount <= previousCountRef.current) {
      previousCountRef.current = itemCount
      return
    }
    previousCountRef.current = itemCount
    if (modeRef.current === 'prework_follow' || modeRef.current === 'user_follow') {
      scrollToEnd(false)
    } else if (activeRef.current) {
      setHasNewContent(true)
    }
  }, [itemCount, scrollToEnd])

  React.useEffect(() => {
    const content = scrollRef.current?.querySelector<HTMLElement>('.session-timeline-virtualizer')
    if (!content || typeof ResizeObserver === 'undefined') return
    previousContentInlineSizeRef.current = 0
    observedItemCountRef.current = itemCountRef.current
    observedContentRevisionRef.current = contentRevisionRef.current
    const observer = new ResizeObserver(([entry]) => {
      if (entry) handleContentResize(entry)
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      if (contentResizeFrameRef.current !== null) {
        cancelAnimationFrame(contentResizeFrameRef.current)
        contentResizeFrameRef.current = null
      }
      pendingContentSizeRef.current = null
    }
  }, [handleContentResize, listRef, scrollRef, sessionKey])

  React.useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport || !bottomSentinel || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = Boolean(entry?.isIntersecting)
        const metrics = readCachedOrLiveMetrics()
        const actualAtBottom =
          metrics !== null
            ? distanceFromThreadBottom(metrics) <= THREAD_BOTTOM_THRESHOLD_PX
            : visible
        const atBottom = resolveThreadAtBottomDuringExplicitReturn({
          actualAtBottom,
          explicitReturnInProgress: explicitReturnInProgressRef.current,
          now: Date.now(),
          programmaticScrollUntil: programmaticScrollUntilRef.current,
        })
        if (actualAtBottom || !atBottom) {
          explicitReturnInProgressRef.current = false
          if (actualAtBottom) {
            programmaticScrollUntilRef.current = 0
          }
        }
        updateAtBottom(atBottom)
      },
      { root: viewport, threshold: 0.01 },
    )
    observer.observe(bottomSentinel)
    return () => {
      observer.disconnect()
    }
  }, [bottomSentinel, listRef, readCachedOrLiveMetrics, scrollRef, sessionKey, updateAtBottom])

  React.useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
      }
    },
    [],
  )

  return {
    pauseFollowing,
    beginProgrammaticScroll,
    bottomSentinelRef: setBottomSentinel,
    canReturnToBottom: canReturnToThreadBottom(hasMeasuredBottom, isAtBottom),
    handleScroll,
    hasNewContent,
    isAtBottom,
    mode,
    returnToBottom,
  }
}
