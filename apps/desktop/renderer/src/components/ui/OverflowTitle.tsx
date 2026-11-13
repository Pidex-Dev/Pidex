import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { cx } from '../../utils/Cx.js'

const TITLE_SCROLL_MIN_SECONDS = 4
const TITLE_SCROLL_PIXELS_PER_SECOND = 20
export type OverflowTitleVariant = 'sidebar' | 'composer' | 'menu' | 'tab'
type OverflowTitlePresentation = 'compact' | 'workspace-meta' | 'activity'
type MeasuredPresentation = Exclude<OverflowTitleVariant, 'menu'>

const ROOT_CLASS = 'tw:block tw:min-w-0 tw:overflow-hidden tw:whitespace-nowrap tw:text-app-text'
/* Menu labels inherit the row color, so they must never paint their own foreground. */
const MENU_ROOT_CLASS = 'tw:block tw:min-w-0 tw:overflow-hidden tw:whitespace-nowrap'
const TRACK_CLASS = 'tw:inline-flex tw:min-w-max tw:items-center tw:gap-1'
/* The model row constrains the name slot itself, so only the fills and the tight tracking are left. */
const COMPOSER_EXTRA_CLASS = 'tw:grow tw:shrink tw:basis-auto tw:tracking-[-0.01em]'
const SIDEBAR_PRESENTATION_CLASS: Record<OverflowTitlePresentation, string> = {
  compact: 'tw:grow tw:shrink tw:basis-auto tw:type-2 tw:weight-medium',
  'workspace-meta': 'tw:flex-none tw:type-2',
  activity: 'tw:flex-none tw:type-2',
}

function scrollSeconds(distance: number): string {
  return `${Math.max(
    TITLE_SCROLL_MIN_SECONDS,
    distance / TITLE_SCROLL_PIXELS_PER_SECOND,
  ).toFixed(2)}s`
}

function overflowStyle(
  variant: MeasuredPresentation,
  overflowDistance: number | null,
): React.CSSProperties | undefined {
  if (overflowDistance === null) return undefined
  const distance = `${overflowDistance}px`
  const duration = scrollSeconds(overflowDistance)
  if (variant === 'sidebar') {
    return {
      '--sidebar-title-scroll-distance': distance,
      '--sidebar-title-scroll-duration': duration,
    } as React.CSSProperties
  }
  if (variant === 'tab') {
    return {
      '--tab-title-scroll-distance': distance,
      '--tab-title-scroll-duration': duration,
    } as React.CSSProperties
  }
  return {
    '--composer-model-name-scroll-distance': distance,
    '--composer-model-name-scroll-duration': duration,
  } as React.CSSProperties
}

export function OverflowTitle({
  active = false,
  children,
  className,
  presentation = 'compact',
  reducedMotion = false,
  variant = 'sidebar',
}: {
  active?: boolean
  children: React.ReactNode
  className?: string
  presentation?: OverflowTitlePresentation
  reducedMotion?: boolean
  variant?: OverflowTitleVariant
}): React.ReactNode {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const trackRef = useRef<HTMLSpanElement>(null)
  const [overflowDistance, setOverflowDistance] = useState<number | null>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    const track = trackRef.current
    if (!viewport || !track) return

    const updateOverflowDistance = (): void => {
      const distance =
        viewport.clientWidth > 0
          ? Math.max(0, Math.ceil(track.scrollWidth - viewport.clientWidth))
          : 0
      const nextDistance = distance > 0 ? distance : null
      setOverflowDistance((current) => (current === nextDistance ? current : nextDistance))
    }

    if (typeof ResizeObserver === 'undefined') {
      updateOverflowDistance()
      return
    }

    const observer = new ResizeObserver(updateOverflowDistance)
    observer.observe(viewport)
    observer.observe(track)
    return () => observer.disconnect()
  }, [children, variant])

  if (variant === 'menu') {
    return (
      <span className={cx('menu-item-label', MENU_ROOT_CLASS, className)}>
        {children}
      </span>
    )
  }

  const scrolling = active && overflowDistance !== null && !reducedMotion
  const rootClassName =
    variant === 'sidebar'
      ? 'sidebar-session-title'
      : variant === 'tab'
        ? 'menubar-session-tab-title'
        : 'composer-model-name'
  return (
    <span
      aria-live={variant === 'sidebar' ? 'polite' : undefined}
      className={cx(
        rootClassName,
        variant === 'tab' ? MENU_ROOT_CLASS : ROOT_CLASS,
        variant === 'sidebar'
          ? SIDEBAR_PRESENTATION_CLASS[presentation]
          : variant === 'tab'
            ? 'tw:grow tw:shrink tw:basis-auto'
            : COMPOSER_EXTRA_CLASS,
        className,
      )}
      data-overflowing={overflowDistance !== null || undefined}
      data-scrolling={scrolling || undefined}
      ref={viewportRef}
      style={overflowStyle(variant, overflowDistance)}
    >
      <span
        className={cx(`${rootClassName}-track`, TRACK_CLASS)}
        data-scrolling={scrolling || undefined}
        ref={trackRef}
      >
        {children}
      </span>
    </span>
  )
}
