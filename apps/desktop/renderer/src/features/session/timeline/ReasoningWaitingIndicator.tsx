import React from 'react'
import { LoaderCircle } from 'lucide-react'
import type { Item } from '@pidex/shared/thread'
import { APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'
import { useMountEffect } from '../../../hooks/UseMountEffect.js'
import { usePrefersReducedMotion } from '../../../hooks/UsePrefersReducedMotion.js'
import { useLiveItemTail } from '../state/UseLiveItemTail.js'

export function ReasoningWaitingIndicator({
  delayMs = 0,
  item,
  label = '正在思考',
  threadId,
}: {
  delayMs?: number
  item?: Item
  label?: string
  threadId?: string
}): React.ReactNode {
  const reasoning = item?.type === 'reasoning' && item.status === 'streaming' ? item : undefined
  const tail = useLiveItemTail(threadId, reasoning?.id ?? '')
  const reducedMotion = usePrefersReducedMotion()
  const shimmerId = React.useId()
  const [revealed, setRevealed] = React.useState(delayMs <= 0)

  useMountEffect(() => {
    if (delayMs <= 0) return
    const timer = window.setTimeout(() => setRevealed(true), delayMs)
    return () => window.clearTimeout(timer)
  })

  if (!revealed) return null
  if (reasoning && (reasoning.text + tail).trim()) return null
  return (
    <div className="canonical-turn__thinking" role="status" aria-live="polite">
      {reducedMotion ? (
        <LoaderCircle
          size={APP_ICON_SIZES.sm}
          className="tw:size-icon-sm canonical-spin"
          aria-hidden="true"
        />
      ) : null}
      <span className="reasoning-node__label" data-active="true">
        {label}
        {!reducedMotion ? (
          <svg className="reasoning-node__shimmer" aria-hidden="true" width="100%" height="100%">
            <defs>
              <mask id={`${shimmerId}-mask`}>
                <text
                  x="0"
                  y="50%"
                  dy=".35em"
                  textLength="100%"
                  lengthAdjust="spacingAndGlyphs"
                  fill="white"
                >
                  {label}
                </text>
              </mask>
              <linearGradient id={`${shimmerId}-gradient`}>
                <stop offset="0" stopColor="currentColor" stopOpacity="0" />
                <stop offset=".5" stopColor="currentColor" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g mask={`url(#${shimmerId}-mask)`}>
              <rect
                className="reasoning-node__sweep"
                width="100%"
                height="100%"
                fill={`url(#${shimmerId}-gradient)`}
              />
            </g>
          </svg>
        ) : null}
      </span>
    </div>
  )
}
