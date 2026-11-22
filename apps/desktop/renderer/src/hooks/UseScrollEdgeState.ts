import { useEffect, useState } from 'react'
import type React from 'react'

export type ScrollEdgeState = {
  atStart: boolean
  atEnd: boolean
  scrollable: boolean
}

export const SCROLL_EDGE_EPSILON = 1

export type ScrollEdgeOptions = {
  contentRef?: React.RefObject<HTMLElement | null>
  version?: unknown
  axis?: 'x' | 'y'
}

/**
 * 滚动容器边界判定：内容不可滚动时顶部/底部都视为"已到边界"，
 * 可滚动时以 epsilon 容差吸收浮点取整差异，避免边界状态闪烁。
 */
export function resolveScrollEdgeState(
  metrics:
    | { scrollTop: number; scrollHeight: number; clientHeight: number }
    | { scrollLeft: number; scrollWidth: number; clientWidth: number },
  epsilon = SCROLL_EDGE_EPSILON,
): ScrollEdgeState {
  const horizontal = 'scrollLeft' in metrics
  const position = horizontal ? metrics.scrollLeft : metrics.scrollTop
  const maxScroll = Math.max(
    0,
    horizontal
      ? metrics.scrollWidth - metrics.clientWidth
      : metrics.scrollHeight - metrics.clientHeight,
  )
  const scrollable = maxScroll > epsilon
  return {
    atStart: !scrollable || position <= epsilon,
    atEnd: !scrollable || position >= maxScroll - epsilon,
    scrollable,
  }
}

/**
 * 共享滚动边界状态：用 passive scroll listener + 单个 rAF 合并读取，
 * 并由 ResizeObserver 同时观察滚动视口与内容尺寸，内容版本依赖只负责
 * 数据替换后的兜底重测；只有边界布尔值真正变化时才提交 React 状态，
 * 滚动过程中不会逐帧重渲染。
 */
export function useScrollEdgeState(
  containerRef: React.RefObject<HTMLElement | null>,
  options: ScrollEdgeOptions = {},
): ScrollEdgeState {
  const { contentRef, version, axis = 'y' } = options
  const [state, setState] = useState<ScrollEdgeState>({
    atStart: true,
    atEnd: true,
    scrollable: false,
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let frameId: number | null = null
    let disposed = false

    // INVARIANT: Scroll extent comes from post-layout ResizeObserver entry snapshots and passive scroll events so rAF measure callbacks never force layout via scrollHeight/clientHeight reads.
    const extentRef = { viewport: 0, content: 0, offset: 0 }

    const measure = (): void => {
      const next = resolveScrollEdgeState(
        axis === 'x'
          ? {
              scrollLeft: extentRef.offset,
              scrollWidth: extentRef.content,
              clientWidth: extentRef.viewport,
            }
          : {
              scrollTop: extentRef.offset,
              scrollHeight: extentRef.content,
              clientHeight: extentRef.viewport,
            },
      )
      setState((current) =>
        current.atStart === next.atStart &&
        current.atEnd === next.atEnd &&
        current.scrollable === next.scrollable
          ? current
          : next,
      )
    }
    const scheduleMeasure = (): void => {
      if (frameId !== null) return
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        if (!disposed) measure()
      })
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const inlineSize = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
        const blockSize = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
        if (entry.target === container) {
          if (axis === 'x') extentRef.viewport = inlineSize
          else extentRef.viewport = blockSize
        } else {
          if (axis === 'x') extentRef.content = inlineSize
          else extentRef.content = blockSize
        }
      }
      scheduleMeasure()
    })
    observer.observe(container)
    const content = contentRef?.current ?? (container.firstElementChild as HTMLElement | null)
    if (content && content !== container) observer.observe(content)
    const handleScroll = (): void => {
      extentRef.offset = axis === 'x' ? container.scrollLeft : container.scrollTop
      scheduleMeasure()
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      disposed = true
      if (frameId !== null) window.cancelAnimationFrame(frameId)
      observer.disconnect()
      container.removeEventListener('scroll', handleScroll)
    }
  }, [containerRef, contentRef, version, axis])

  return state
}
