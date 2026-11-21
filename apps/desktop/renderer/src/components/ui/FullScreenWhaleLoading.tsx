import { reportStartupLoading, startupSplashActive } from '../../startup/StartupSplashHandoff.js'
import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { swapStatusText } from '../../startup/StatusTextSwap.js'

export type FullScreenWhaleLoadingProps = {
  label: string
  variant?: 'fullscreen' | 'contained'
  showLabel?: boolean
}

/**
 * 唯一的 Renderer 品牌加载组件：与 index.html 静态启动遮罩共用
 * `.full-screen-whale-loader` DOM/CSS 契约（56px 主标、2200ms 扫光）。
 * - `variant="fullscreen"`：整窗 fixed 覆盖（用于启动开屏与 Setup 页面）
 * - `variant="contained"`：会话主区域与工作区面板容器化居中加载（不遮挡侧边栏与标签栏）
 * 默认仅保留品牌图标与扫光动效，不展示可见提示文字，同时通过 `aria-label` 与
 * `data-loading-label` 保留无障碍与诊断语义。
 */
export function FullScreenWhaleLoading({
  label,
  variant = 'fullscreen',
  showLabel = false,
}: FullScreenWhaleLoadingProps): React.ReactNode {
  const statusRef = useRef<HTMLSpanElement | null>(null)
  const latestLabelRef = useRef(label)
  const [displayedLabel, setDisplayedLabel] = useState(label)

  latestLabelRef.current = label

  useEffect(() => {
    if (!showLabel || displayedLabel === label) return
    const element = statusRef.current
    if (!element) return
    swapStatusText(element, label, () => {
      setDisplayedLabel(latestLabelRef.current)
    })
  }, [displayedLabel, label, showLabel])

  const isContained = variant === 'contained'
  const coveredByStartup = !isContained && startupSplashActive()
  useLayoutEffect(() => {
    if (coveredByStartup) return reportStartupLoading(label)
  }, [coveredByStartup, label])
  if (coveredByStartup) return null
  const rootClassName = isContained
    ? 'full-screen-whale-loader full-screen-whale-loader--contained'
    : 'full-screen-whale-loader'
  const RootTag = isContained ? 'div' : 'main'

  return (
    <RootTag
      className={rootClassName}
      data-full-screen-loading={!isContained ? 'true' : undefined}
      data-loading-variant={variant}
      data-loading-label={label}
      role="status"
      aria-label={showLabel ? undefined : label}
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
    >
      <div className="full-screen-whale-loader__content">
        <div className="full-screen-whale-loader__logo" aria-hidden="true">
          <img className="full-screen-whale-loader__base" src="/pidex-mark-green.svg" alt="" />
          <div className="full-screen-whale-loader__overlay" />
        </div>
        {showLabel ? (
          <div className="full-screen-whale-loader__status-viewport">
            <span ref={statusRef}>{displayedLabel}</span>
          </div>
        ) : null}
      </div>
    </RootTag>
  )
}
