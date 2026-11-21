import { APP_ICON_SIZE, APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'
import React from 'react'
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  PenLine,
  X,
} from 'lucide-react'
import type { DesktopPermissionRequest } from '../../../../shared/Types.js'
import { Button } from '../../../components/ui/Button.js'
import { RequestCard } from './RequestCard.js'
import { desktopClient } from '../../../services/desktop-client/index.js'
import { cx } from '../../../utils/Cx.js'
import { useApprovalCapability } from './UseQuestionSkipCapability.js'
import {
  CUSTOM_OPTION_ID,
  answerStateForConfirmation,
  buildAskUserQuestionUpdatedInput,
  findNextPendingQuestionIndex,
  firstUnansweredQuestionIndex,
  initialPlanQuestionState,
  initialQuestionState,
  nextQuestionIndex,
  parseAskUserQuestions,
  questionDrafts,
  questionKey,
  questionOptionId,
  selectQuestionOption,
  shouldDeferAskUserQuestionShortcutToTextEntry,
  type AskUserQuestion,
  type QuestionState,
} from './AskUserQuestionModel.js'

export {
  CUSTOM_OPTION_ID,
  answerForSelectedOption,
  areAllQuestionsAnswered,
  buildAskUserQuestionAnswers,
  buildAskUserQuestionUpdatedInput,
  canSubmitFromCurrentQuestion,
  enterQuestionAction,
  findNextPendingQuestionIndex,
  firstUnansweredQuestionIndex,
  footerControls,
  hasQuestionAnswer,
  initialQuestionState,
  initialPlanQuestionState,
  isQuestionComplete,
  nextOptionLabel,
  nextQuestionIndex,
  nextQuestionOptionId,
  parseAskUserQuestions,
  questionOptionIds,
  selectQuestionOption,
  shouldDeferAskUserQuestionShortcutToTextEntry,
  toggleMultiSelectOption,
  type AskUserQuestion,
  type AskUserQuestionOption,
  type EnterQuestionAction,
  type FooterControls,
  type QuestionState,
} from './AskUserQuestionModel.js'

export type AskUserQuestionApprovalProps = {
  request: DesktopPermissionRequest
  onSubmit: (updatedInput: Record<string, unknown>) => void | Promise<void>
  onReject: () => void | Promise<void>
  onInterrupt?: () => void | Promise<void>
  identity?: string
  disabledReason?: string
  supportsQuestionSkip?: boolean
  /**
   * 由所属 Turn 的 canonical 状态传入，而不是可能已改变的 Composer 草稿模式。
   * Chat、Plan、Grill 共用一套逐题显式确认的问答卡片。
   */
  taskMode?: 'chat' | 'plan' | 'grill'
}

export function AskUserQuestionApproval({
  request,
  ...props
}: AskUserQuestionApprovalProps): React.ReactNode {
  return (
    <QuestionAnswerForm
      {...props}
      requestId={request.requestId}
      input={request.input}
      questions={parseAskUserQuestions(request.input)}
    />
  )
}

export type QuestionAnswerFormProps = Omit<AskUserQuestionApprovalProps, 'request' | 'onSubmit'> & {
  onSubmit: (
    updatedInput: Record<string, unknown>,
    states: Readonly<Record<string, QuestionState>>,
  ) => void | Promise<void>
  requestId: string
  input?: Record<string, unknown>
  questions: AskUserQuestion[] | null
}

export function QuestionAnswerForm({ ...props }: QuestionAnswerFormProps): React.ReactNode {
  const key = `${String(props.input?.threadId ?? '')}:${props.requestId}:${String(props.input?.version ?? '')}`
  return <QuestionAnswerFormInstance key={key} {...props} draftKey={key} />
}

function QuestionAnswerFormInstance({
  requestId,
  input = {},
  questions,
  onSubmit,
  onReject,
  onInterrupt,
  identity,
  disabledReason,
  supportsQuestionSkip = false,
  taskMode = 'chat',
  draftKey,
}: QuestionAnswerFormProps & { draftKey: string }): React.ReactNode {
  const isStructured = taskMode === 'plan' || taskMode === 'grill'
  const [questionStates, setQuestionStates] = React.useState<Record<string, QuestionState>>(
    () => questionDrafts.get(draftKey)?.states ?? {},
  )
  const [currentQuestionIndex, setCurrentQuestionIndex] = React.useState(
    () => questionDrafts.get(draftKey)?.index ?? 0,
  )
  const [isSummary, setIsSummary] = React.useState(
    () => Boolean(questionDrafts.get(draftKey)?.isSummary) && (questions?.length ?? 0) > 1,
  )
  const [error, setError] = React.useState<string | null>(null)
  const customInputRef = React.useRef<HTMLTextAreaElement | null>(null)
  const approvalRef = React.useRef<HTMLDivElement | null>(null)
  const focusFirstOptionRef = React.useRef(false)
  const advanceTimerRef = React.useRef<number | null>(null)
  const submittedRef = React.useRef(false)
  const mountedRef = React.useRef(true)
  const pauseAttemptedRef = React.useRef(false)
  const supportsPause = useApprovalCapability(
    requestId,
    !isStructured,
    'interaction.questionPause.v1',
  )
  const [busy, setBusy] = React.useState(false)
  const disabled = busy || Boolean(disabledReason)
  const questionCount = questions?.length ?? 0

  const draftFor = React.useCallback(
    (question: AskUserQuestion): QuestionState =>
      questionStates[questionKey(question)] ?? initialQuestionState(question),
    [questionStates],
  )

  const clearAdvanceTimer = React.useCallback((): void => {
    if (advanceTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(advanceTimerRef.current)
      advanceTimerRef.current = null
    }
  }, [])

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearAdvanceTimer()
    }
  }, [clearAdvanceTimer])

  React.useEffect(() => {
    if (!submittedRef.current) {
      questionDrafts.set(draftKey, {
        states: questionStates,
        index: currentQuestionIndex,
        isSummary,
      })
    }
  }, [draftKey, questionStates, currentQuestionIndex, isSummary])

  React.useEffect(() => {
    setCurrentQuestionIndex((current) =>
      questionCount > 0 ? Math.min(current, questionCount - 1) : 0,
    )
    if (questionCount <= 1) setIsSummary(false)
  }, [questionCount])

  React.useLayoutEffect(() => {
    if (!focusFirstOptionRef.current) return
    focusFirstOptionRef.current = false
    approvalRef.current
      ?.querySelector<HTMLButtonElement>('button[role="radio"], button[role="checkbox"]')
      ?.focus()
  }, [currentQuestionIndex, isSummary])

  React.useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    const frame = window.requestAnimationFrame(() => {
      if (
        isTextEntryTarget(document.activeElement) ||
        document.activeElement?.closest('[role="dialog"], [role="menu"]')
      )
        return
      approvalRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [requestId])

  React.useEffect(() => {
    if (!questions || disabled || typeof window === 'undefined') return
    function handleKeyDown(event: KeyboardEvent): void {
      if (!(event.target instanceof Node) || !approvalRef.current?.contains(event.target)) return
      if (event.isComposing || event.keyCode === 229 || event.repeat || submittedRef.current) return
      if ((event.target as HTMLElement).closest('[role="dialog"], [role="menu"]')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        // INVARIANT: 访谈类问题只退出当前编辑焦点；结束等待必须点击关闭/停止按钮。
        if (isStructured) blurCurrentFocus()
        else void reject()
        return
      }
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('button:not([role="radio"]):not([role="checkbox"])')
      )
        return
      if (shouldDeferAskUserQuestionShortcutToTextEntry(event.key, isTextEntryTarget(event.target)))
        return
      if (event.key === 'ArrowLeft') {
        if (isSummary && questionCount > 1) {
          event.preventDefault()
          exitSummaryToQuestion(questionCount - 1)
        } else if (!isSummary && questionCount > 1 && currentQuestionIndex > 0) {
          event.preventDefault()
          goToQuestion(-1)
        }
        return
      }
      if (event.key === 'ArrowRight') {
        if (!isSummary && questionCount > 1 && currentQuestionIndex < questionCount - 1) {
          event.preventDefault()
          goToQuestion(1)
        }
        return
      }
      if (isSummary) {
        if (event.key === 'Enter') {
          event.preventDefault()
          submitAnswers()
        }
        return
      }
      const currentQuestion = questions[currentQuestionIndex] ?? questions[0]
      if (!currentQuestion) return
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        movePlanFocus(event.key === 'ArrowUp' ? -1 : 1)
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && /^[1-9]$/u.test(event.key)) {
        const optionIndex = Number(event.key) - 1
        const option = currentQuestion.options[optionIndex]
        if (option) {
          event.preventDefault()
          handleOptionClick(currentQuestion, questionOptionId(option))
        }
      } else if (event.key === 'Enter') {
        event.preventDefault()
        confirmOrAdvanceFromPill(currentQuestion)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentQuestionIndex,
    isSummary,
    onReject,
    questionCount,
    questionStates,
    questions,
    disabled,
    isStructured,
  ])

  if (!questions || questions.length === 0) {
    return (
      <div
        ref={approvalRef}
        className="ask-user-question-approval tw:flex tw:w-full tw:flex-col tw:gap-3 tw:outline-none"
        tabIndex={-1}
      >
        <p className="ask-user-question-error tw:mx-3 tw:my-0 tw:px-3 tw:py-2 tw:border tw:border-app-danger-border tw:rounded-4 tw:bg-app-danger-subtle tw:text-app-danger-fg tw:type-1">
          无法解析 AskUserQuestion 的选项，请拒绝后让 Pidex 重新提问。
        </p>
        <div className="inline-approval-footer inline-approval-footer-split tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:justify-between">
          <span className="inline-approval-footer-spacer tw:flex-none" aria-hidden="true" />
          <Button color="danger" disabled={disabled} onClick={() => void reject()}>
            拒绝
            <CornerDownLeft className="tw:size-icon-md" size={APP_ICON_SIZE} />
          </Button>
        </div>
      </div>
    )
  }

  function updateQuestion(
    questionText: string,
    updater: (current: QuestionState) => QuestionState,
  ): void {
    if (supportsPause && !pauseAttemptedRef.current && typeof input.version === 'number') {
      pauseAttemptedRef.current = true
      void desktopClient
        .pauseQuestion(requestId.replace(/^question:/u, ''), input.version)
        .catch(() => {
          pauseAttemptedRef.current = false
        })
    }
    setQuestionStates((current) => {
      const question = questions?.find((item) => questionKey(item) === questionText)
      const previous = question
        ? (current[questionText] ?? initialQuestionState(question))
        : initialPlanQuestionState()
      return {
        ...current,
        [questionText]: updater(previous),
      }
    })
    setError(null)
  }

  function advanceAfterAction(statesSnapshot: Record<string, QuestionState>): void {
    if (!questions || submittedRef.current) return
    const nextPending = findNextPendingQuestionIndex(
      questions,
      statesSnapshot,
      currentQuestionIndex,
    )
    if (nextPending !== -1) {
      setIsSummary(false)
      setCurrentQuestionIndex(nextPending)
      setError(null)
    } else if (questionCount > 1) {
      setIsSummary(true)
      setError(null)
    }
  }

  function submitAnswers(override?: { question: AskUserQuestion; state: QuestionState }): void {
    if (!questions || submittedRef.current || disabledReason) return
    clearAdvanceTimer()
    const drafts = override
      ? { ...questionStates, [questionKey(override.question)]: override.state }
      : questionStates
    const effectiveStates = Object.fromEntries(
      questions.map((question) => {
        const draft = drafts[questionKey(question)] ?? draftFor(question)
        return [questionKey(question), draft.skipped ? draft : answerStateForConfirmation(draft)]
      }),
    )
    const firstUnanswered = firstUnansweredQuestionIndex(questions, effectiveStates)
    if (firstUnanswered !== -1) {
      setIsSummary(false)
      setCurrentQuestionIndex(firstUnanswered)
      // INVARIANT: 先聚焦再设置错误，避免 onFocus 触发 updateQuestion 时把错误提示清空。
      customInputRef.current?.focus()
      setError('请回答必答问题后再提交。')
      return
    }
    questionDrafts.set(draftKey, { states: drafts, index: currentQuestionIndex, isSummary })
    submittedRef.current = true
    setBusy(true)
    try {
      const submission = Promise.resolve(
        onSubmit(
          buildAskUserQuestionUpdatedInput(input, questions, effectiveStates),
          effectiveStates,
        ),
      )
      void submission
        .then(() => {
          questionDrafts.delete(draftKey)
        })
        .catch(() => {
          if (mountedRef.current) setError('提交回答失败，请重试。')
          submittedRef.current = false
        })
        .finally(() => {
          if (mountedRef.current) setBusy(false)
        })
    } catch {
      submittedRef.current = false
      setBusy(false)
      setError('提交回答失败，请重试。')
    }
  }

  function confirmOrAdvanceFromPill(question: AskUserQuestion): void {
    if (submittedRef.current || disabledReason) return
    clearAdvanceTimer()
    const draft = draftFor(question)
    const blankState = initialQuestionState(question)
    const confirmedState = answerStateForConfirmation(draft.skipped ? blankState : draft)
    if (!confirmedState.answered) {
      customInputRef.current?.focus()
      setError('请输入回答后再继续。')
      return
    }
    const qKey = questionKey(question)
    const nextStates = { ...questionStates, [qKey]: confirmedState }
    updateQuestion(qKey, () => confirmedState)
    if (questionCount <= 1) {
      submitAnswers({ question, state: confirmedState })
      return
    }
    advanceAfterAction(nextStates)
  }

  function skipCurrentQuestion(question: AskUserQuestion): void {
    if (submittedRef.current || disabledReason || !supportsQuestionSkip) return
    clearAdvanceTimer()
    const state: QuestionState = { selected: [], custom: '', answered: false, skipped: true }
    const qKey = questionKey(question)
    const nextStates = { ...questionStates, [qKey]: state }
    updateQuestion(qKey, () => state)
    if (questionCount <= 1) {
      submitAnswers({ question, state })
      return
    }
    focusFirstOptionRef.current = true
    advanceAfterAction(nextStates)
  }

  function movePlanFocus(delta: -1 | 1): void {
    const container = approvalRef.current
    if (!container) return
    const targets = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button[role="radio"], button[role="checkbox"], textarea',
      ),
    ).filter((element) => !(element as HTMLButtonElement).disabled)
    if (targets.length === 0) return
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const index = active ? targets.indexOf(active) : -1
    const next =
      index < 0
        ? delta > 0
          ? 0
          : targets.length - 1
        : (index + delta + targets.length) % targets.length
    targets[next]?.focus()
  }

  function blurCurrentFocus(): void {
    const active = document.activeElement
    if (active instanceof HTMLElement && approvalRef.current?.contains(active)) active.blur()
  }

  function goToQuestion(delta: -1 | 1): void {
    if (submittedRef.current) return
    clearAdvanceTimer()
    setIsSummary(false)
    setCurrentQuestionIndex((current) => nextQuestionIndex(current, delta, questionCount))
    setError(null)
  }

  function exitSummaryToQuestion(index: number): void {
    if (submittedRef.current) return
    clearAdvanceTimer()
    setIsSummary(false)
    setCurrentQuestionIndex(Math.max(0, Math.min(questionCount - 1, index)))
    setError(null)
  }

  function resetAllQuestions(): void {
    if (!questions || submittedRef.current || disabledReason) return
    clearAdvanceTimer()
    const blankStates = Object.fromEntries(
      questions.map((question) => [
        questionKey(question),
        { selected: [], custom: '', answered: false, skipped: false },
      ]),
    )
    setQuestionStates(blankStates)
    setIsSummary(false)
    setCurrentQuestionIndex(0)
    setError(null)
  }

  function handleOptionClick(question: AskUserQuestion, optionId: string): void {
    if (submittedRef.current || disabledReason) return
    clearAdvanceTimer()
    const current = draftFor(question)
    const nextState: QuestionState = {
      ...selectQuestionOption(current, optionId, question.multiSelect, 'toggle'),
      touched: true,
      skipped: false,
    }
    const qKey = questionKey(question)
    const nextStates = { ...questionStates, [qKey]: nextState }
    updateQuestion(qKey, () => nextState)
    if (!question.multiSelect && questionCount > 1 && typeof window !== 'undefined') {
      advanceTimerRef.current = window.setTimeout(() => {
        advanceTimerRef.current = null
        advanceAfterAction(nextStates)
      }, 150)
    }
  }

  async function interrupt(): Promise<void> {
    if (!onInterrupt || submittedRef.current || disabledReason) return
    clearAdvanceTimer()
    submittedRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onInterrupt()
      questionDrafts.delete(draftKey)
    } catch {
      setError('中断对话失败，请重试。')
      submittedRef.current = false
      setBusy(false)
    }
  }

  async function reject(): Promise<void> {
    if (submittedRef.current || disabledReason) return
    clearAdvanceTimer()
    submittedRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onReject()
      questionDrafts.delete(draftKey)
    } catch {
      setError('操作失败，请重试。')
      submittedRef.current = false
      setBusy(false)
    }
  }

  const currentQuestion = questions[currentQuestionIndex] ?? questions[0]
  const state = draftFor(currentQuestion)
  const isLastQuestion = currentQuestionIndex === questionCount - 1
  const planHasChoices = currentQuestion.options.length > 0
  const hasCustomOrSelection = Boolean(state.custom.trim()) || state.selected.length > 0
  const cardTitle = isSummary ? '已收集全部确认，是否提交？' : currentQuestion.question

  return (
    <div
      ref={approvalRef}
      className="ask-user-question-approval tw:flex tw:w-full tw:flex-col tw:gap-3 tw:outline-none"
      tabIndex={-1}
    >
      <RequestCard
        variant="question"
        title={cardTitle}
        identity={identity}
        disabledReason={disabledReason}
        error={error}
        navigation={
          <div className="ask-user-question-navigation tw:flex tw:shrink-0 tw:items-center tw:gap-1 tw:text-app-text-soft tw:type-1">
            {questionCount > 1 ? (
              <div
                className="ask-user-question-pagination tw:inline-flex tw:items-center tw:gap-1 tw:whitespace-nowrap"
                role="group"
                aria-label="问题导航"
              >
                <button
                  type="button"
                  className="ask-user-question-nav-btn"
                  aria-label="上一题"
                  title="上一题 (←)"
                  disabled={disabled || (!isSummary && currentQuestionIndex === 0)}
                  onClick={() => {
                    if (isSummary) {
                      exitSummaryToQuestion(questionCount - 1)
                      return
                    }
                    goToQuestion(-1)
                  }}
                >
                  <ChevronLeft className="tw:size-icon-sm" size={APP_ICON_SIZES.sm} />
                </button>
                <span className="ask-user-question-counter tw:tabular-nums" aria-live="polite">
                  {isSummary ? questionCount : currentQuestionIndex + 1} of {questionCount}
                </span>
                <button
                  type="button"
                  className="ask-user-question-nav-btn"
                  aria-label="下一题"
                  title="下一题 (→)"
                  disabled={disabled || isSummary || currentQuestionIndex >= questionCount - 1}
                  onClick={() => goToQuestion(1)}
                >
                  <ChevronRight className="tw:size-icon-sm" size={APP_ICON_SIZES.sm} />
                </button>
              </div>
            ) : null}
            {isStructured ? (
              <button
                type="button"
                className="ask-user-question-nav-btn ask-user-question-close-btn"
                aria-label="停止本轮"
                title="停止本轮"
                disabled={disabled || !onInterrupt}
                onClick={() => void interrupt()}
              >
                <X className="tw:size-icon-sm" size={APP_ICON_SIZES.sm} />
              </button>
            ) : (
              <button
                type="button"
                className="ask-user-question-nav-btn ask-user-question-close-btn"
                aria-label="关闭"
                title="关闭"
                disabled={disabled}
                onClick={() => void reject()}
              >
                <X className="tw:size-icon-sm" size={APP_ICON_SIZES.sm} />
              </button>
            )}
          </div>
        }
      >
        {isSummary && questionCount > 1 ? (
          <div key="summary" className="ask-user-question-stage tw:flex tw:flex-col tw:gap-2">
            <div className="ask-user-question-summary-list tw:flex tw:flex-col tw:gap-1">
              {questions.map((question, index) => {
                const summaryAnswer = formatSummaryAnswer(question, draftFor(question))
                return (
                  <button
                    key={questionKey(question)}
                    type="button"
                    disabled={disabled}
                    className="ask-user-question-summary-row"
                    onClick={() => exitSummaryToQuestion(index)}
                  >
                    <span className="tw:min-w-0 tw:flex-1">
                      <span className="ask-user-question-summary-q tw:block tw:type-1 tw:text-app-text-soft">
                        {index + 1}. {question.question}
                      </span>
                      <span
                        className={cx(
                          'ask-user-question-summary-a tw:block tw:type-2 tw:wrap-anywhere',
                          summaryAnswer.isMuted
                            ? 'tw:weight-regular tw:text-app-text-meta'
                            : 'tw:weight-medium tw:text-app-text',
                        )}
                      >
                        {summaryAnswer.text}
                      </span>
                    </span>
                    <span className="ask-user-question-summary-edit tw:shrink-0 tw:type-1 tw:text-app-text-soft">
                      修改
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="ask-user-question-summary-footer tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-2 tw:pt-1">
              <span className="tw:type-1 tw:text-app-text-meta">点击任意项可返回修改</span>
              <div className="tw:flex tw:items-center tw:gap-2">
                <Button
                  type="button"
                  shape="pill"
                  size="sm"
                  color="secondary"
                  disabled={disabled}
                  onClick={resetAllQuestions}
                >
                  重置
                </Button>
                <Button
                  type="button"
                  shape="pill"
                  size="sm"
                  color="primary"
                  disabled={disabled}
                  loading={busy}
                  loadingText="提交中…"
                  onClick={() => submitAnswers()}
                >
                  确认提交
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div
            key={currentQuestionIndex}
            className="ask-user-question-stage tw:flex tw:flex-col tw:gap-1"
          >
            {planHasChoices ? (
              <div
                className="ask-user-question-options tw:flex tw:flex-col tw:gap-1"
                role={currentQuestion.multiSelect ? 'group' : 'radiogroup'}
                aria-label={currentQuestion.question}
              >
                {currentQuestion.options.map((option, index) => {
                  const optionId = questionOptionId(option)
                  const selected = state.selected.includes(optionId)
                  return (
                    <button
                      key={optionId}
                      type="button"
                      role={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={selected}
                      disabled={disabled}
                      className={cx('ask-user-question-option-row', selected && 'is-selected')}
                      onClick={() => handleOptionClick(currentQuestion, optionId)}
                    >
                      <span
                        className="request-card-marker ask-user-question-option-num"
                        aria-hidden="true"
                      >
                        {index + 1}
                      </span>
                      <span className="ask-user-question-option-inline tw:flex tw:min-w-0 tw:flex-1 tw:flex-col tw:gap-1">
                        <span className="ask-user-question-option-head tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                          <span className="ask-user-question-option-title tw:type-2 tw:weight-medium tw:text-app-text tw:wrap-anywhere">
                            {option.label}
                          </span>
                          {option.recommended ? (
                            <span className="ask-user-question-recommendation">推荐</span>
                          ) : null}
                        </span>
                        {option.description ? (
                          <span className="ask-user-question-option-desc tw:type-1 tw:weight-regular tw:text-app-text-soft tw:whitespace-normal tw:wrap-anywhere">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                      {currentQuestion.multiSelect ? (
                        <span
                          className={cx(
                            'ask-user-question-checkbox tw:inline-flex tw:size-4 tw:shrink-0 tw:items-center tw:justify-center tw:rounded-3 tw:border tw:text-app-canvas',
                            selected
                              ? 'tw:border-app-text tw:bg-app-text'
                              : 'tw:border-app-border tw:bg-transparent',
                          )}
                          aria-hidden="true"
                        >
                          {selected ? (
                            <Check className="tw:size-icon-sm" size={APP_ICON_SIZES.sm} />
                          ) : null}
                        </span>
                      ) : (
                        <ArrowRight
                          className="ask-user-question-row-arrow tw:size-icon-sm tw:shrink-0"
                          size={APP_ICON_SIZES.sm}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  )
                })}
              </div>
            ) : null}
            <div
              className={cx('ask-user-question-pill-row', planHasChoices ? 'tw:mt-1' : undefined)}
            >
              <span className="request-card-marker ask-user-question-pill-badge" aria-hidden="true">
                <PenLine className="tw:size-icon-xs" size={APP_ICON_SIZES.sm} />
              </span>
              <textarea
                ref={customInputRef}
                className="ask-user-question-custom-input tw:block tw:w-full tw:min-w-0 tw:flex-1 tw:field-sizing-content tw:min-h-[1.5em] tw:max-h-[120px] tw:resize-none tw:overflow-y-auto tw:border-0 tw:bg-transparent tw:p-0 tw:text-app-text tw:type-2 tw:weight-regular tw:wrap-anywhere tw:outline-none tw:placeholder:text-app-text-meta"
                aria-label="自定义回答"
                placeholder={planHasChoices ? '否，并告诉助手应该如何做得不同' : '输入你的回答'}
                rows={1}
                disabled={disabled}
                value={state.custom}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  if (event.shiftKey && !event.ctrlKey && !event.metaKey) return
                  if (event.altKey) return
                  if (
                    event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229 ||
                    event.repeat
                  )
                    return
                  event.preventDefault()
                  if (state.custom.trim()) confirmOrAdvanceFromPill(currentQuestion)
                }}
                onFocus={() => {
                  // INVARIANT: 聚焦只是焦点，清除选择只由真实输入触发。
                  updateQuestion(questionKey(currentQuestion), (current) => ({
                    ...current,
                    focused: CUSTOM_OPTION_ID,
                    skipped: false,
                  }))
                }}
                onChange={(event) => {
                  clearAdvanceTimer()
                  const custom = event.target.value
                  updateQuestion(questionKey(currentQuestion), (current) => ({
                    ...current,
                    custom,
                    focused: CUSTOM_OPTION_ID,
                    selected: currentQuestion.multiSelect ? current.selected : [],
                    answered:
                      Boolean(custom.trim()) ||
                      (currentQuestion.multiSelect && current.selected.length > 0),
                    skipped: false,
                  }))
                }}
              />
              <div className="ask-user-question-pill-actions tw:flex tw:shrink-0 tw:items-center tw:gap-1">
                {hasCustomOrSelection ? (
                  <Button
                    type="button"
                    shape="pill"
                    size="sm"
                    color="primary"
                    disabled={disabled}
                    loading={busy}
                    loadingText="提交中…"
                    onClick={() => confirmOrAdvanceFromPill(currentQuestion)}
                  >
                    {questionCount > 1 && !isLastQuestion ? '下一题' : '提交'}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    shape="pill"
                    size="sm"
                    color="secondary"
                    aria-label="跳过当前问题"
                    title={
                      supportsQuestionSkip
                        ? '跳过只是暂定假设，不是已确认决策'
                        : '当前 Agent 尚未提供逐题跳过能力，请升级并重启 Agent。'
                    }
                    disabled={disabled || !supportsQuestionSkip}
                    onClick={() => skipCurrentQuestion(currentQuestion)}
                  >
                    跳过
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </RequestCard>
    </div>
  )
}

function formatSummaryAnswer(
  question: AskUserQuestion,
  state: QuestionState,
): { text: string; isMuted: boolean } {
  if (state.skipped) return { text: '已跳过', isMuted: true }
  const parts = [
    ...state.selected.map(
      (id) => question.options.find((option) => questionOptionId(option) === id)?.label ?? id,
    ),
    ...(state.custom.trim() ? [state.custom.trim()] : []),
  ]
  if (parts.length > 0) return { text: parts.join(', '), isMuted: false }
  return { text: '未选择', isMuted: true }
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}
