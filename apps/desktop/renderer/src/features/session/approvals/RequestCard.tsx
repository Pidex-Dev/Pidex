import React from 'react'

import { cx } from '../../../utils/Cx.js'

export type RequestCardProps = {
  title: React.ReactNode
  identity?: string
  disabledReason?: string
  disabled?: boolean
  navigation?: React.ReactNode
  description?: React.ReactNode
  details?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  error?: string | null
  variant: 'question' | 'plan' | 'permission' | 'permission-grant'
}

/*
 * The three workflow-composer-card modifier classes stay static strings: they
 * are semantic query anchors for `markdown.css`, the approval card variants and
 * the browser harnesses, so no variant may be assembled at runtime.
 */
const WORKFLOW_CARD_CLASS: Record<RequestCardProps['variant'], string> = {
  question: 'workflow-composer-card-question',
  plan: 'workflow-composer-card-plan',
  permission: 'workflow-composer-card-permission',
  'permission-grant': 'workflow-composer-card-permission',
}

/*
 * Approval navigation buttons share one geometry contract: a borderless icon
 * row that dims while disabled and keeps the pointer cursor neutral.
 */
export const ASK_USER_QUESTION_NAV_BUTTON_CLASS =
  'ask-user-question-nav-button ask-user-question-close-btn'

export const ASK_USER_QUESTION_PAGINATION_NAV_BUTTON_CLASS = 'ask-user-question-nav-btn'

export function RequestCard({
  title,
  identity,
  disabledReason,
  disabled,
  navigation,
  description,
  details,
  actions,
  children,
  error,
  variant,
}: RequestCardProps): React.ReactNode {
  return (
    <section
      className={cx(
        'inline-approval-card workflow-composer-card request-card',
        WORKFLOW_CARD_CLASS[variant],
        // Card shell: composer-width card, 16px radius, unified outer padding,
        // subtle edge, panel fill and shared enter animation anchored at the bottom edge.
        'tw:mb-3 tw:flex tw:w-full tw:max-w-composer tw:flex-col tw:px-4 tw:py-3 tw:weight-medium tw:origin-bottom tw:animate-[workflow-card-in_var(--cpx-sys-motion-enter)_var(--cpx-sys-ease-standard)] tw:rounded-prominent tw:border tw:border-app-border-subtle tw:bg-app-panel tw:text-app-text tw:shadow-none',
      )}
      data-variant={variant}
    >
      <header className="request-card-header tw:flex tw:items-center tw:justify-between tw:gap-3 tw:pb-2">
        <div className="request-card-heading tw:grid tw:min-w-0 tw:gap-1">
          {identity ? (
            <p className="request-card-identity tw:m-0 tw:text-app-text-soft tw:type-1">
              {identity}
            </p>
          ) : null}
          <h3 className="tw:m-0 tw:type-2 tw:weight-bold tw:tracking-[-0.01em] tw:wrap-anywhere">
            {title}
          </h3>
        </div>
        {navigation}
      </header>
      {disabledReason ? (
        <p
          className="request-card-disabled-reason tw:m-0 tw:pb-2 tw:text-app-text-soft tw:type-1"
          role="status"
        >
          {disabledReason}
        </p>
      ) : null}
      <fieldset className="request-card-content" disabled={disabled || Boolean(disabledReason)}>
        {description}
        {children}
        {details}
        {actions}
      </fieldset>
      {error ? (
        <p
          className="ask-user-question-error tw:mt-2 tw:mb-0 tw:px-3 tw:py-2 tw:border tw:border-app-danger-border tw:rounded-4 tw:bg-app-danger-subtle tw:text-app-danger-fg tw:type-1"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </section>
  )
}

export function RequestMarker({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <span
      className="request-card-marker tw:inline-flex tw:size-6 tw:shrink-0 tw:self-center tw:items-center tw:justify-center tw:rounded-full tw:border tw:border-app-border-subtle tw:bg-app-editor tw:text-app-text-soft tw:type-1"
      aria-hidden="true"
    >
      {children}
    </span>
  )
}
