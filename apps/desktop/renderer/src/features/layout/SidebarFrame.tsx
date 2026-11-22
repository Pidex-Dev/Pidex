import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot, History } from 'lucide-react'
import { APP_ICON_SIZE } from '../../components/ui/IconTokens.js'
import { animate, motion, useMotionValue, useMotionValueEvent } from 'motion/react'
import { usePrefersReducedMotion } from '../../hooks/UsePrefersReducedMotion.js'
import { layoutTween, motionTransition } from '../motion/MotionTransitions.js'
import { useSidebarResizeCollapseConfirm } from './UseSidebarResizeCollapseConfirm.js'
import { useLiveResizeValue } from './UseLiveResizeValue.js'
import {
  SIDEBAR_PREVIEW_ENTER_DURATION,
  SIDEBAR_PREVIEW_EXIT_DURATION,
  SIDEBAR_PREVIEW_SETTLE_DURATION,
  type SidebarShellController,
} from './SidebarShellState.js'
import { SIDEBAR_RAIL_WIDTH } from './sidebar/SidebarNavigation.js'
import { cx } from '../../utils/Cx.js'

export type SidebarContentKind = 'tasks'

export function getSidebarContentLabels(_contentKind: SidebarContentKind): {
  resize: string
  sidebar: string
} {
  const name = '任务侧栏'
  return {
    resize: `调整${name}宽度`,
    sidebar: name,
  }
}

type Props = {
  rail?: React.ReactNode
  children: React.ReactNode
  collapsed: boolean
  contentKind: SidebarContentKind
  maxWidth: number
  minWidth: number
  width: number
  defaultWidth: number
  onCollapse: () => void
  onSetWidth: (width: number) => void
  shell: SidebarShellController
}

export function SidebarFrame({
  rail,
  children,
  collapsed,
  contentKind,
  maxWidth,
  minWidth,
  width,
  defaultWidth,
  onCollapse,
  onSetWidth,
  shell,
}: Props): React.ReactNode {
  const railWidth = SIDEBAR_RAIL_WIDTH
  const sidebarRef = useRef<HTMLElement>(null)
  const reducedMotion = usePrefersReducedMotion()
  const labels = getSidebarContentLabels(contentKind)
  const docked = shell.dockedVisible
  const dockedRef = useRef(docked)
  useLayoutEffect(() => {
    dockedRef.current = docked
  }, [docked])
  const {
    liveSize: liveWidth,
    liveSizePixels: liveWidthPixels,
    previewSize: previewWidth,
  } = useLiveResizeValue(width)
  const handleResetWidth = useCallback((): void => {
    onSetWidth(defaultWidth)
  }, [defaultWidth, onSetWidth])

  const {
    handleLostPointerCapture,
    handlePointerCancel,
    handlePointerMove,
    handlePointerUp,
    handleResizeKey,
    resizing,
    startResize,
  } = useSidebarResizeCollapseConfirm({
    collapsed: shell.mode === 'collapsed' && collapsed,
    maxWidth,
    minWidth,
    width,
    collapseBehavior: {
      kind: 'threshold',
      threshold: minWidth / 2,
    },
    onCollapse,
    onResetSize: handleResetWidth,
    onResizePreview: previewWidth,
    onSetWidth,
  })

  const floating = shell.mode === 'preview'
  const hidden = shell.mode === 'collapsed'
  const [modeTransition, setModeTransition] = useState({ mode: shell.mode, duration: 0.3 })
  let duration = modeTransition.duration
  if (modeTransition.mode !== shell.mode) {
    const previousMode = modeTransition.mode
    duration =
      shell.mode === 'preview'
        ? SIDEBAR_PREVIEW_ENTER_DURATION
        : previousMode === 'preview' && shell.mode === 'docked'
          ? SIDEBAR_PREVIEW_SETTLE_DURATION
          : previousMode === 'preview' && shell.mode === 'collapsed'
            ? SIDEBAR_PREVIEW_EXIT_DURATION
            : 0.3
    setModeTransition({ mode: shell.mode, duration })
  }
  const transition = useMemo(() => ({ ...layoutTween, duration }), [duration])
  const allocatedWidth = useMotionValue(docked ? width : railWidth)
  const allocatedWidthAnimationRef = useRef<ReturnType<typeof animate> | null>(null)
  const previousHiddenRef = useRef(hidden)

  useMotionValueEvent(liveWidth, 'change', (nextWidth) => {
    if (!dockedRef.current) return
    allocatedWidthAnimationRef.current?.stop()
    allocatedWidthAnimationRef.current = null
    allocatedWidth.set(nextWidth)
    document
      .querySelector<HTMLElement>('.app-shell')
      ?.style.setProperty('--sidebar-w', `${nextWidth}px`)
  })

  useEffect(() => {
    const animation = animate(
      allocatedWidth,
      docked ? liveWidth.get() : railWidth,
      motionTransition(reducedMotion, transition),
    )
    allocatedWidthAnimationRef.current = animation
    return () => {
      animation.stop()
      if (allocatedWidthAnimationRef.current === animation) {
        allocatedWidthAnimationRef.current = null
      }
    }
  }, [allocatedWidth, docked, liveWidth, reducedMotion, transition, railWidth])

  const { onFloatingResizeChange } = shell
  useEffect(() => {
    const active = floating && resizing
    onFloatingResizeChange(active)
    return () => {
      if (active) onFloatingResizeChange(false)
    }
  }, [floating, resizing, onFloatingResizeChange])

  useLayoutEffect(() => {
    const wasHidden = previousHiddenRef.current
    previousHiddenRef.current = hidden
    if (!hidden || wasHidden) return

    const activeElement = document.activeElement
    if (!(activeElement instanceof HTMLElement) || !sidebarRef.current?.contains(activeElement))
      return
    document
      .querySelector<HTMLElement>('[data-app-shell-sidebar-trigger]')
      ?.focus({ preventScroll: true })
  }, [hidden])

  return (
    <>
      {rail ? (
        <div
          className="desktop-sidebar-rail-slot tw:hidden tw:w-[var(--sidebar-rail-width)]"
          aria-hidden="true"
          data-sidebar-layout="modern"
          style={{ '--sidebar-rail-width': `${railWidth}px` } as React.CSSProperties}
        >
          {rail}
        </div>
      ) : null}
      <motion.aside
        id="desktop-sidebar-pane"
        ref={sidebarRef}
        onPointerEnter={floating ? shell.onPreviewPanelEnter : undefined}
        onPointerLeave={floating ? shell.onPreviewPanelLeave : undefined}
        aria-label={labels.sidebar}
        aria-hidden={hidden || undefined}
        className={cx(
          'desktop-sidebar tw:flex-none tw:flex-col tw:overflow-hidden tw:select-none tw:type-2 tw:text-app-text tw:antialiased tw:[text-rendering:optimizeLegibility]',
          !hidden && 'tw:flex',
          floating
            ? 'is-floating tw:absolute tw:top-2 tw:bottom-2 tw:left-2 tw:z-[calc(var(--cpx-sys-z-composer)+1)] tw:w-[calc(var(--sidebar-current-width)-var(--sidebar-rail-width)-16px)]'
            : cx(
                'tw:relative tw:h-full tw:z-dock tw:border-r tw:border-app-border-subtle tw:w-[calc(var(--sidebar-current-width)-var(--sidebar-rail-width))]',
                docked ? 'is-docked tw:bg-app-main' : 'tw:bg-app-sidebar',
              ),
          `is-${shell.mode}`,
          hidden ? 'is-collapsed tw:pointer-events-none tw:hidden' : undefined,
          resizing ? 'is-resizing' : undefined,
        )}
        animate={
          hidden
            ? {
                opacity: 0,
                x: -8,
                transitionEnd: { visibility: 'hidden' },
              }
            : {
                opacity: 1,
                visibility: 'visible',
                x: 0,
              }
        }
        data-sidebar-content={contentKind}
        data-sidebar-layout="modern"
        data-sidebar-pane={shell.pane ?? undefined}
        initial={hidden ? { opacity: 0, visibility: 'hidden', x: -8 } : false}
        inert={hidden ? true : undefined}
        style={
          {
            '--sidebar-current-width': liveWidthPixels,
            '--sidebar-rail-width': `${railWidth}px`,
          } as unknown as React.CSSProperties
        }
        transition={motionTransition(reducedMotion, transition)}
      >
        {children}

        {shell.mode === 'docked' || shell.mode === 'preview' ? (
          <div
            aria-label={labels.resize}
            aria-orientation="vertical"
            aria-valuemax={maxWidth}
            aria-valuemin={minWidth}
            aria-valuenow={width}
            className="sidebar-resizer tw:absolute tw:inset-y-0 tw:right-0 tw:z-local tw:w-1 tw:touch-none tw:focus-visible:outline-none"
            onDoubleClick={handleResetWidth}
            onKeyDown={handleResizeKey}
            onLostPointerCapture={handleLostPointerCapture}
            onPointerCancel={handlePointerCancel}
            onPointerDown={startResize}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            role="separator"
            tabIndex={0}
          />
        ) : null}
        <div className="sidebar-brand-floating tw:hidden tw:shrink-0 tw:text-app-text-meta">
          <Bot className="tw:size-icon-md" size={APP_ICON_SIZE} />
        </div>
        <History
          className="tw:size-icon-md sidebar-history-watermark tw:hidden tw:shrink-0 tw:text-app-text-meta"
          size={APP_ICON_SIZE}
        />
      </motion.aside>
    </>
  )
}
