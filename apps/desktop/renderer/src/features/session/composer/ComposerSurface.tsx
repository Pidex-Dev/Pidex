import type React from 'react'
import { forwardRef } from 'react'
import { cx } from '../../../utils/Cx.js'

type ComposerFrameProps = {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

/*
 * Transparent placement frame for a composer or approval surface.
 * The child owns every visual surface property; this wrapper only owns width,
 * pointer-event restoration and the transition ref used by the shell.
 *
 * Nested surface widths are normalised with explicit descendant selectors (no
 * container context): the frame hosts no `@container` rules, and an inline-size
 * container here made Chromium re-match the whole composer subtree on every
 * streaming chunk's style recalc (~14ms measured). Named breakpoints on the
 * toolbar/utility bar (`composer-footer`/`composer-tray`) remain hosted there.
 */
const FRAME_CLASS = cx(
  'composer-frame tw:flex tw:min-w-0 tw:flex-col tw:gap-2 tw:bg-transparent tw:p-0 tw:pointer-events-auto tw:shadow-none',
  'tw:transition-[height] tw:duration-panel tw:ease-standard',
  'tw:[&>.composer-stack]:w-full tw:[&>.composer-stack]:max-w-none',
  'tw:[&>.composer-stack>.composer]:w-full tw:[&>.composer-stack>.composer]:max-w-none',
)

export const ComposerFrame = forwardRef<HTMLDivElement, ComposerFrameProps>(function ComposerFrame(
  { children, className, style },
  ref,
) {
  const hasCustomWidth =
    className?.includes('workflow-page__composer-inner') ||
    className?.includes('tw:w-') ||
    className?.includes('tw:w-[')
  return (
    <div
      ref={ref}
      className={cx(FRAME_CLASS, !hasCustomWidth && 'tw:w-full', className)}
      style={style}
    >
      {children}
    </div>
  )
})

// Temporary source-compatible alias for extension code that imports the old
// name. It remains a transparent frame and no longer renders a card surface.
export const ComposerSurface = ComposerFrame
