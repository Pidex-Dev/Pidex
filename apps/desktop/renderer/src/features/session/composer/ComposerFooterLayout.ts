import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/*
 * Space allocation for the composer footer (the toolbar row under the editor).
 * The footer is a named container (`composer-footer`); label/arrow collapse is
 * pure CSS there. Only the model region needs runtime numbers because its two
 * candidate states (full text vs. icon) cannot be measured from CSS alone: a
 * hidden measuring node renders both and the ResizeObserver below feeds their
 * real widths into `resolveComposerFooterFit`.
 */

/** 上下文圆环固定按 12px 槽位（size-3）绘制，无需运行时测量。 */
export const COMPOSER_FOOTER_RING_WIDTH = 12

export type ComposerFooterMetrics = {
  footerWidth: number
  leftWidth: number
  toolbarGap: number
  rightGap: number
  sendWidth: number
  modelTextWidth: number
  modelIconWidth: number
}

export type ComposerFooterFit = {
  modelMode: 'text' | 'icon' | 'hidden'
  showRing: boolean
}

type FitStage = { modelMode: ComposerFooterFit['modelMode']; ring: boolean }

const FIT_STAGES: readonly FitStage[] = [
  { modelMode: 'text', ring: true },
  { modelMode: 'icon', ring: true },
  { modelMode: 'icon', ring: false },
  { modelMode: 'hidden', ring: false },
]

function stageFits(metrics: ComposerFooterMetrics, stage: FitStage, hasRing: boolean): boolean {
  const parts: number[] = [metrics.sendWidth]
  if (stage.modelMode !== 'hidden')
    parts.push(stage.modelMode === 'text' ? metrics.modelTextWidth : metrics.modelIconWidth)
  if (hasRing && stage.ring) parts.push(COMPOSER_FOOTER_RING_WIDTH)
  const rightWidth =
    parts.reduce((sum, width) => sum + width, 0) + Math.max(0, parts.length - 1) * metrics.rightGap
  return metrics.leftWidth + metrics.toolbarGap + rightWidth <= metrics.footerWidth
}

/**
 * Returns the first stage that fits, falling back to the last one. When a
 * trigger holds an open popover or keyboard focus its current shape stays
 * mounted (overflow is only tolerated temporarily).
 * Stages whose ring flag differs are identical when the ring is absent.
 */
export function resolveComposerFooterFit(
  metrics: ComposerFooterMetrics | null,
  options: {
    hasRing: boolean
    holdModel: boolean
    holdRing: boolean
    heldModelMode?: 'text' | 'icon'
  },
): ComposerFooterFit {
  if (!metrics) return { modelMode: 'text', showRing: true }
  const heldModelMode = options.heldModelMode ?? 'icon'
  const modelStages = options.holdModel
    ? FIT_STAGES.map((stage) => ({ ...stage, modelMode: heldModelMode }))
    : FIT_STAGES
  const stages = modelStages.filter((stage) => !options.hasRing || !options.holdRing || stage.ring)
  const stage =
    stages.find((candidate) => stageFits(metrics, candidate, options.hasRing)) ??
    stages[stages.length - 1]!
  return { modelMode: stage.modelMode, showRing: stage.ring }
}

export type ComposerFooterNodeRefs = {
  footer: RefObject<HTMLElement | null>
  left: RefObject<HTMLElement | null>
  right: RefObject<HTMLElement | null>
  send: RefObject<HTMLElement | null>
  modelText: RefObject<HTMLElement | null>
  modelIcon: RefObject<HTMLElement | null>
}

export type ComposerFooterFitOptions = {
  hasRing: boolean
  holdModel: boolean
  holdRing: boolean
}

function sameFit(previous: ComposerFooterFit, next: ComposerFooterFit): boolean {
  return previous.modelMode === next.modelMode && previous.showRing === next.showRing
}

/**
 * One ResizeObserver over the footer's fixed nodes; publishes only discrete fit
 * state (`modelMode` / `showRing`) so continuous panel resize animations do not
 * re-render the composer tree on every frame.
 */
export function useComposerFooterFit(
  nodes: ComposerFooterNodeRefs,
  reflowKey: unknown,
  options: ComposerFooterFitOptions,
): ComposerFooterFit {
  const [fit, setFit] = useState<ComposerFooterFit>({ modelMode: 'text', showRing: true })
  const nodesRef = useRef(nodes)
  const metricsRef = useRef<ComposerFooterMetrics | null>(null)
  const optionsRef = useRef(options)
  const heldModelModeRef = useRef<'text' | 'icon'>('text')
  nodesRef.current = nodes
  optionsRef.current = options

  const commitFit = useCallback((nextMetrics: ComposerFooterMetrics | null): void => {
    const nextFit = resolveComposerFooterFit(nextMetrics, {
      ...optionsRef.current,
      heldModelMode: heldModelModeRef.current,
    })
    if (nextFit.modelMode !== 'hidden') heldModelModeRef.current = nextFit.modelMode
    setFit((previous) => (sameFit(previous, nextFit) ? previous : nextFit))
  }, [])

  useLayoutEffect(() => {
    commitFit(metricsRef.current)
  }, [commitFit, options.hasRing, options.holdModel, options.holdRing])

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const current = nodesRef.current
    if (!current.footer.current) return
    const widths = new Map<Element, number>()
    let cachedToolbarGap: number | null = null
    let cachedRightGap: number | null = null
    const measure = (entries: ResizeObserverEntry[]): void => {
      for (const entry of entries) {
        widths.set(
          entry.target,
          entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width,
        )
      }
      const footer = current.footer.current
      const left = current.left.current
      const right = current.right.current
      if (!footer || !left || !right) return
      const widthOf = (element: HTMLElement | null): number =>
        element ? (widths.get(element) ?? 0) : 0
      cachedToolbarGap ??= (parseFloat(getComputedStyle(footer).columnGap) || 0)
      cachedRightGap ??= (parseFloat(getComputedStyle(right).columnGap) || 0)
      const next: ComposerFooterMetrics = {
        footerWidth: widthOf(footer),
        leftWidth: widthOf(left),
        toolbarGap: cachedToolbarGap,
        rightGap: cachedRightGap,
        sendWidth: widthOf(current.send.current),
        modelTextWidth: widthOf(current.modelText.current),
        modelIconWidth: widthOf(current.modelIcon.current),
      }
      metricsRef.current = next
      commitFit(next)
    }
    // INVARIANT: ResizeObserver fires post-layout on initial observation and consumes entry snapshots without synchronous getBoundingClientRect calls.
    const observer = new ResizeObserver(measure)
    for (const ref of Object.values(current)) if (ref.current) observer.observe(ref.current)
    return () => {
      observer.disconnect()
    }
  }, [commitFit, reflowKey])

  return fit
}
