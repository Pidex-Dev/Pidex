import * as React from 'react'

/** Agent 全部结束后延迟自动折叠该分区的等待时间。 */
export const THREAD_SUMMARY_AGENTS_AUTO_COLLAPSE_DELAY_MS = 30_000

export type ThreadSummaryAgentsCollapseDecision = 'idle' | 'reset-override' | 'schedule-collapse'

/**
 * Agent 分区自动折叠决策：有活动 Agent 时清除手动覆盖；全部结束后若用户没有
 * 手动操作过该分区，则安排延迟折叠。手动折叠选择始终优先。
 */
export function resolveThreadSummaryAgentsAutoCollapse(input: {
  activeCount: number
  manualOverride: boolean
  totalCount: number
}): ThreadSummaryAgentsCollapseDecision {
  if (input.totalCount === 0) return 'idle'
  if (input.activeCount > 0) return 'reset-override'
  if (input.manualOverride) return 'idle'
  return 'schedule-collapse'
}

// The former 300px panel switched at 1096px. The current panel needs 40px less.
export const THREAD_SUMMARY_INLINE_MIN_WIDTH = 1056

export function useThreadSummaryController(containerRef: React.RefObject<HTMLElement | null>) {
  const [isPopoverOpen, setPopoverOpen] = React.useState(false)
  const [isInline, setInline] = React.useState(false)

  React.useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = () =>
      setInline(container.getBoundingClientRect().width >= THREAD_SUMMARY_INLINE_MIN_WIDTH)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef])

  return { isInline, isPopoverOpen, setPopoverOpen }
}
