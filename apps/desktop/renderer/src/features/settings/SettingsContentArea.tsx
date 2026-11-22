import type React from 'react'
import { ScrollArea } from '../../components/ui/ScrollArea.js'
import { cx } from '../../utils/Cx.js'

export type SettingsContentAreaProps = {
  children: React.ReactNode
  className?: string
  innerClassName?: string
  innerProps?: React.HTMLAttributes<HTMLDivElement>
  bare?: boolean
}

const SETTINGS_CONTENT_INNER_BASE_CLASS =
  'tw:@container tw:w-full tw:min-w-0 tw:mx-auto tw:p-5 tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-5)*2)]'

// INVARIANT: 设置页内层基准统一承载 24px（`--cpx-sys-space-5`）内边距，并将 border-box 最大宽度设为 `calc(var(--page-content-max-width) + var(--cpx-sys-space-5) * 2)`，使内部正文净宽与会话/一级页面的 `--page-content-max-width`（默认 1009px / 窄 768px / 宽 1250px）严格对齐。
export const SETTINGS_CONTENT_INNER_CLASS = `settings-content-inner ${SETTINGS_CONTENT_INNER_BASE_CLASS}`

export function SettingsContentArea({
  children,
  className = '',
  innerClassName = '',
  innerProps,
  bare = false,
}: SettingsContentAreaProps): React.ReactNode {
  const hasExplicitInnerClass = /\bsettings-content-inner\b/.test(innerClassName)
  return (
    <ScrollArea
      className={cx(
        'settings-content-scroll-area tw:min-h-0 tw:w-full tw:min-w-0 tw:flex-1 tw:overflow-x-hidden tw:overscroll-contain tw:bg-app-canvas',
        className,
      )}
      contentClassName="settings-content-scroll-content tw:min-h-full"
    >
      {bare ? (
        children
      ) : (
        <div
          {...innerProps}
          className={cx(
            hasExplicitInnerClass
              ? SETTINGS_CONTENT_INNER_BASE_CLASS
              : SETTINGS_CONTENT_INNER_CLASS,
            innerClassName,
          )}
        >
          {children}
        </div>
      )}
    </ScrollArea>
  )
}
