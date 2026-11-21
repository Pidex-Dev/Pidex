import { forwardRef } from 'react'
import type React from 'react'

export const Toast = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { appearance?: 'action'; surface?: 'panel' | 'subtle' }
>(function Toast(
  { className = '', appearance, surface = 'panel', ...props },
  ref,
): React.ReactNode {
  const bgClass = surface === 'subtle' ? 'tw:bg-app-control' : 'tw:bg-app-panel'
  const shadowClass = surface === 'subtle' ? 'tw:shadow-sm' : 'tw:shadow-lg'
  return (
    <div
      {...props}
      ref={ref}
      className={`tw:inline-flex tw:items-center tw:gap-2 tw:rounded-[var(--cpx-sys-radius-5)] tw:border tw:border-app-border-subtle ${bgClass} tw:px-3 tw:py-2 tw:type-2 tw:text-app-text ${shadowClass} tw:[-webkit-app-region:no-drag] ${appearance === 'action' ? 'tw:min-h-[var(--cpx-sys-space-8)]' : 'tw:min-h-[var(--cpx-sys-space-7)]'} ${className}`}
    />
  )
})

export function ToastDivider({ className = '' }: { className?: string } = {}): React.ReactNode {
  return (
    <span
      aria-hidden="true"
      className={`tw:mx-1 tw:h-4 tw:w-px tw:shrink-0 tw:bg-app-border-subtle ${className}`}
    />
  )
}
