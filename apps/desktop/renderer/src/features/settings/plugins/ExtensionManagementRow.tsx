import type React from 'react'
import { ChevronRight } from 'lucide-react'

type Props = {
  title: string
  description: React.ReactNode
  icon: React.ReactNode
  metadata?: React.ReactNode
  actions?: React.ReactNode
  dimmed?: boolean
  showChevron?: boolean
  onActivate?: (trigger: HTMLElement) => void
}

export function ExtensionManagementRow({
  title,
  description,
  icon,
  metadata,
  actions,
  dimmed = false,
  showChevron = false,
  onActivate,
}: Props): React.ReactNode {
  const rowContent = (
    <>
      <span
        aria-hidden="true"
        className="settings-management-row-icon tw:inline-flex tw:size-6 tw:items-center tw:justify-center tw:overflow-hidden tw:rounded-3 tw:bg-app-editor tw:text-app-text-soft"
      >
        {icon}
      </span>
      <span className="settings-management-row-copy tw:grid tw:min-w-0 tw:gap-1">
        <strong className="settings-management-row-title tw:m-0 tw:min-w-0 tw:truncate tw:text-app-text tw:type-2 tw:weight-medium">
          {title}
        </strong>
        <span className="settings-management-row-description tw:min-w-0 tw:truncate tw:text-app-text-soft tw:type-1">
          {description}
        </span>
      </span>
      {metadata ? (
        <span className="settings-management-row-meta tw:min-w-0 tw:text-app-text-soft tw:type-1">
          {metadata}
        </span>
      ) : null}
    </>
  )

  return (
    <article
      className="extensions-settings-row settings-management-row tw:min-w-0 tw:items-center tw:text-app-text tw:hover:bg-app-hover tw:data-[current=true]:bg-app-selected tw:data-[dimmed=true]:opacity-60"
      data-dimmed={dimmed || undefined}
    >
      {onActivate ? (
        <button
          className="settings-management-row-main tw:min-h-[calc(var(--cpx-sys-space-6)+var(--cpx-sys-space-4))] tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-3 tw:border-0 tw:bg-transparent tw:px-3 tw:py-2 tw:text-left tw:text-inherit"
          onClick={(event) => onActivate(event.currentTarget)}
          type="button"
        >
          {rowContent}
        </button>
      ) : (
        <div className="settings-management-row-main tw:min-h-[calc(var(--cpx-sys-space-6)+var(--cpx-sys-space-4))] tw:min-w-0 tw:items-center tw:gap-3 tw:border-0 tw:bg-transparent tw:px-3 tw:py-2 tw:text-left tw:text-inherit">
          {rowContent}
        </div>
      )}
      {actions || showChevron ? (
        <span className="settings-management-row-actions tw:flex tw:items-center tw:gap-2">
          {actions}
          {showChevron ? (
            <ChevronRight
              size={16}
              className="tw:size-icon-md tw:text-app-text-meta tw:shrink-0 tw:ml-1"
              aria-hidden="true"
            />
          ) : null}
        </span>
      ) : null}
    </article>
  )
}
