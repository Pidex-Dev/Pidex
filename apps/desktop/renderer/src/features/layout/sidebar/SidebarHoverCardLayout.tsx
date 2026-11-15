import type React from 'react'
import { cx } from '../../../utils/Cx.js'

type ContainerProps = React.HTMLAttributes<HTMLDivElement>

export function SidebarHoverCardFrame({ className, ...props }: ContainerProps): React.ReactNode {
  return (
    <div
      {...props}
      className={cx('sidebar-hover-card-layout tw:grid tw:min-w-0 tw:gap-1', className)}
    />
  )
}

export function SidebarHoverCardHeader({ className, ...props }: ContainerProps): React.ReactNode {
  return (
    <div
      {...props}
      className={cx(
        'sidebar-hover-card-header tw:grid tw:min-w-0 tw:items-center tw:gap-x-2 tw:type-2',
        className,
      )}
    />
  )
}

export function SidebarHoverCardRow({ className, ...props }: ContainerProps): React.ReactNode {
  return (
    <div
      {...props}
      className={cx(
        'sidebar-hover-card-row tw:grid tw:min-w-0 tw:items-center tw:gap-x-2 tw:type-2 tw:grid-cols-[var(--sidebar-hover-leading-width)_minmax(0,1fr)]',
        className,
      )}
    />
  )
}
