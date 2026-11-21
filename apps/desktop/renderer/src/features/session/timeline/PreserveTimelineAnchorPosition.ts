const TIMELINE_SCROLL_SELECTOR =
  '[data-component="thread-scroll-layout"], .thread-scroll-layout, [data-scroll-container]'
const TIMELINE_TURN_SELECTOR = '[data-turn-navigation-id], [data-component="conversation-turn"]'
const ANCHOR_PRESERVE_WINDOW_MS = 350

function findTimelineScrollContainer(anchor: HTMLElement): HTMLElement | null {
  const matched = anchor.closest<HTMLElement>(TIMELINE_SCROLL_SELECTOR)
  if (matched) return matched
  let parent = anchor.parentElement
  while (parent) {
    const overflowY = window.getComputedStyle(parent).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return parent
    parent = parent.parentElement
  }
  return null
}

/**
 * Keeps a clicked disclosure trigger pinned at its viewport Y offset while
 * height transitions settle, preventing timeline jumps on expand/collapse.
 */
export function preserveTimelineAnchorPosition(
  anchor: HTMLElement | null,
  windowMs = ANCHOR_PRESERVE_WINDOW_MS,
): () => void {
  if (!anchor || typeof window === 'undefined') return () => undefined
  const scroller = findTimelineScrollContainer(anchor)
  if (!scroller) return () => undefined

  const initialTop = anchor.getBoundingClientRect().top
  let frameId: number | null = null
  let disposed = false

  const adjust = (): void => {
    if (disposed || !anchor.isConnected) return
    const delta = anchor.getBoundingClientRect().top - initialTop
    if (Math.abs(delta) > 0.25) {
      scroller.scrollTop += delta
    }
  }

  const scheduleAdjust = (): void => {
    if (disposed || frameId !== null) return
    frameId = window.requestAnimationFrame(() => {
      frameId = null
      adjust()
    })
  }

  const turnRow = anchor.closest<HTMLElement>(TIMELINE_TURN_SELECTOR)
  let observer: ResizeObserver | null = null
  if (turnRow && typeof ResizeObserver !== 'undefined') {
    // INVARIANT: Route anchor adjustment through the rAF queue so ResizeObserver callbacks never force synchronous layout during disclosure transitions.
    observer = new ResizeObserver(() => scheduleAdjust())
    observer.observe(turnRow)
  }

  scheduleAdjust()

  const controller = new AbortController()
  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId)
      frameId = null
    }
    observer?.disconnect()
    window.clearTimeout(timer)
    controller.abort()
  }

  const timer = window.setTimeout(cleanup, windowMs)
  for (const eventName of ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const) {
    scroller.addEventListener(eventName, cleanup, { passive: true, signal: controller.signal })
  }

  return cleanup
}
