import React from 'react'
import type { PlanApproval } from '@pidex/shared/thread'
import { ArrowRight, PenLine } from 'lucide-react'
import { APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'
import { Button } from '../../../components/ui/Button.js'
import { cx } from '../../../utils/Cx.js'
import { RequestCard } from './RequestCard.js'
import type { OpenPlanInDockRequest } from '../workflow/WorkflowPlanCard.js'

export type PlanApprovalResponse =
  | { action: 'implement' }
  | { action: 'implementFresh' }
  | { action: 'feedback'; feedback: string }
  | { action: 'close' }

export type PlanApprovalCardProps = {
  approval: PlanApproval
  identity?: string
  disabledReason?: string
  onRespond: (response: PlanApprovalResponse) => Promise<void>
  onOpenPlan?: (plan: OpenPlanInDockRequest) => void
  freshAvailable?: boolean
}

const FEEDBACK_PLACEHOLDER = '否，请告知 Pidex 如何调整'

/**
 * 计划审阅卡片：复用确认卡片的统一视觉结构，提供实施确认选项、自定义调整意见与忽略动作。
 */
export function PlanApprovalCard({
  approval,
  identity,
  disabledReason,
  onRespond,
}: PlanApprovalCardProps): React.ReactNode {
  const [implementSelected, setImplementSelected] = React.useState(true)
  const [feedback, setFeedback] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<PlanApprovalResponse['action'] | null>(null)
  const cardRef = React.useRef<HTMLDivElement | null>(null)
  const feedbackRef = React.useRef<HTMLTextAreaElement | null>(null)
  const disabled = busy !== null || Boolean(disabledReason)
  const trimmedFeedback = feedback.trim()
  const isCustomFeedback = trimmedFeedback.length > 0
  const selected = !isCustomFeedback && implementSelected

  React.useEffect(() => {
    setBusy(null)
    setError(null)
    setImplementSelected(true)
    setFeedback('')
  }, [approval.id, approval.version])

  async function act(build: () => PlanApprovalResponse): Promise<void> {
    if (disabled) return
    const response = build()
    setBusy(response.action)
    setError(null)
    try {
      await onRespond(response)
    } catch {
      setError('操作失败，请重试。')
      setBusy(null)
    }
  }

  function submitSelectionOrFeedback(): void {
    if (isCustomFeedback) {
      void act(() => ({ action: 'feedback', feedback: trimmedFeedback }))
      return
    }
    void act(() => ({ action: 'implement' }))
  }

  function handleOptionClick(): void {
    if (disabled) return
    if (selected) {
      void act(() => ({ action: 'implement' }))
      return
    }
    setImplementSelected(true)
    setFeedback('')
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return
    if (
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      event.repeat
    ) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      void act(() => ({ action: 'close' }))
      return
    }
    if (event.target instanceof HTMLTextAreaElement) return
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === '1') {
      event.preventDefault()
      handleOptionClick()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      submitSelectionOrFeedback()
    }
  }

  return (
    <div
      ref={cardRef}
      className="plan-approval-card tw:w-full tw:outline-none"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <RequestCard
        variant="plan"
        title="实施此计划？"
        identity={identity}
        disabledReason={disabledReason}
        error={error}
      >
        <div className="ask-user-question-stage tw:flex tw:flex-col tw:gap-1">
          <div
            className="ask-user-question-options tw:flex tw:flex-col tw:gap-1"
            role="radiogroup"
            aria-label="实施此计划？"
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              className={cx('ask-user-question-option-row', selected && 'is-selected')}
              onClick={handleOptionClick}
            >
              <span
                className="request-card-marker ask-user-question-option-num"
                aria-hidden="true"
              >
                1
              </span>
              <span className="ask-user-question-option-inline tw:flex tw:min-w-0 tw:flex-1 tw:flex-col tw:gap-1">
                <span className="ask-user-question-option-head tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                  <span className="ask-user-question-option-title tw:type-2 tw:weight-medium tw:text-app-text tw:wrap-anywhere">
                    是，实施此计划
                  </span>
                </span>
              </span>
              <ArrowRight
                className="ask-user-question-row-arrow tw:size-icon-sm tw:shrink-0"
                size={APP_ICON_SIZES.sm}
                aria-hidden="true"
              />
            </button>
          </div>
          <div className="ask-user-question-pill-row tw:mt-1">
            <span className="request-card-marker ask-user-question-pill-badge" aria-hidden="true">
              <PenLine className="tw:size-icon-xs" size={APP_ICON_SIZES.sm} />
            </span>
            <textarea
              ref={feedbackRef}
              className="ask-user-question-custom-input tw:block tw:w-full tw:min-w-0 tw:flex-1 tw:field-sizing-content tw:min-h-[1.5em] tw:max-h-[120px] tw:resize-none tw:overflow-y-auto tw:border-0 tw:bg-transparent tw:p-0 tw:text-app-text tw:type-2 tw:weight-regular tw:wrap-anywhere tw:outline-none tw:placeholder:text-app-text-meta"
              aria-label="调整计划意见"
              placeholder={FEEDBACK_PLACEHOLDER}
              rows={1}
              disabled={disabled}
              value={feedback}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                if (event.shiftKey && !event.ctrlKey && !event.metaKey) return
                if (event.altKey) return
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229 ||
                  event.repeat
                ) {
                  return
                }
                event.preventDefault()
                if (feedback.trim()) submitSelectionOrFeedback()
              }}
              onChange={(event) => setFeedback(event.target.value)}
            />
            <div className="ask-user-question-pill-actions tw:flex tw:shrink-0 tw:items-center tw:gap-1">
              <Button
                type="button"
                shape="pill"
                size="sm"
                color="secondary"
                disabled={disabled}
                loading={busy === 'close'}
                loadingText="忽略中…"
                onClick={() => void act(() => ({ action: 'close' }))}
              >
                忽略
              </Button>
              <Button
                type="button"
                shape="pill"
                size="sm"
                color="primary"
                disabled={disabled}
                loading={busy === 'implement' || busy === 'feedback'}
                loadingText="提交中…"
                onClick={submitSelectionOrFeedback}
              >
                提交
              </Button>
            </div>
          </div>
        </div>
      </RequestCard>
    </div>
  )
}
