import React, { useMemo, useState } from 'react'
import { Check, RefreshCw, Scale, X } from 'lucide-react'
import type { DecisionAnswer, DecisionOutcomeRecord } from '@pidex/shared/decision'
import {
  selectDecisionLedgerEntries,
  type DecisionLedgerViewEntry,
} from '@pidex/session-view'
import { Button } from '../../../components/ui/Button.js'
import { ScrollArea } from '../../../components/ui/ScrollArea.js'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from '../../../components/ui/IconTokens.js'
import { desktopClient } from '../../../services/desktop-client/index.js'
import { decisionErrorMessage } from '../../settings/DecisionSettingsModel.js'
import {
  WorkbenchPanelEmpty,
  WorkbenchPanelUnavailable,
} from '../panels/WorkbenchPanelStates.js'
import { useCanonicalThreadConversation } from '../../session/timeline/UseCanonicalThreadConversation.js'

/**
 * Judge workbench panel: live decision ledger of one thread projected by
 * `session-view`, with correct/wrong outcome marking through
 * `decision/markOutcome`.
 */
export function RightDockJudgePanel({
  threadId,
}: {
  threadId: string | null
}): React.ReactNode {
  const supported = useMemo(() => desktopClient.supportsDecisionEngine(), [])
  const conversation = useCanonicalThreadConversation(threadId)
  const [marking, setMarking] = useState<ReadonlySet<string>>(() => new Set())
  const [markError, setMarkError] = useState('')
  const records = useMemo(
    () => (conversation.state ? selectDecisionLedgerEntries(conversation.state.decisions) : []),
    [conversation.state],
  )

  const markOutcome = async (record: DecisionLedgerViewEntry, verdict: 'correct' | 'wrong') => {
    if (!threadId || marking.has(record.id)) return
    setMarking((current) => new Set(current).add(record.id))
    setMarkError('')
    try {
      await desktopClient.markDecisionOutcome({ ledgerId: record.id, threadId, verdict })
    } catch (error) {
      setMarkError(decisionErrorMessage(error, '决策纠偏提交失败。'))
    } finally {
      setMarking((current) => {
        const next = new Set(current)
        next.delete(record.id)
        return next
      })
    }
  }

  if (!supported) {
    return (
      <WorkbenchPanelUnavailable
        title="决策引擎不可用"
        description="当前 Agent 运行时未声明 decision.engine.v1。"
      />
    )
  }
  if (!threadId) {
    return <WorkbenchPanelEmpty title="Judge" description="请先打开一个会话，再查看决策记录。" />
  }

  return (
    <div
      aria-label="决策记录"
      className="tw:flex tw:h-full tw:min-h-0 tw:min-w-0 tw:flex-1 tw:flex-col tw:bg-app-dock"
    >
      <div className="tw:flex tw:shrink-0 tw:items-center tw:justify-between tw:gap-2 tw:border-b tw:border-app-border-subtle tw:px-4 tw:py-2">
        <span className="tw:type-1 tw:text-app-text-meta">
          {records.length > 0 ? `${records.length} 条决策记录` : '决策账本'}
        </span>
        <Button
          isIconOnly
          color="ghostSecondary"
          size="toolbar"
          type="button"
          disabled={conversation.loading}
          title="刷新决策记录"
          aria-label="刷新决策记录"
          onClick={() => void conversation.reload()}
        >
          <RefreshCw
            aria-hidden="true"
            size={APP_ICON_SIZE}
            strokeWidth={APP_ICON_STROKE_WIDTH}
            className={`tw:size-icon-md ${conversation.loading ? 'tw:animate-spin' : ''}`}
          />
        </Button>
      </div>
      {markError ? (
        <div
          role="alert"
          className="tw:shrink-0 tw:border-b tw:border-app-danger-border tw:bg-app-danger-subtle tw:px-4 tw:py-2 tw:type-1 tw:text-app-danger"
        >
          {markError}
        </div>
      ) : null}
      <ScrollArea
        aria-label="当前会话决策记录"
        className="tw:min-h-0 tw:min-w-0 tw:flex-1"
        contentClassName="tw:grid tw:min-w-0 tw:gap-2 tw:p-3"
      >
        {records.length === 0 ? (
          <div className="tw:grid tw:justify-items-center tw:gap-2 tw:px-4 tw:py-8 tw:text-center tw:text-app-text-soft">
            <Scale
              aria-hidden="true"
              size={APP_ICON_SIZE}
              strokeWidth={APP_ICON_STROKE_WIDTH}
              className="tw:size-icon-lg tw:text-app-text-meta"
            />
            <span className="tw:type-2 tw:weight-medium tw:text-app-text">暂无决策记录</span>
            <span className="tw:type-1">
              在「设置 → 决策」中把决策点切到影子或生效模式后，这里会实时展示 Judge 判定。
            </span>
          </div>
        ) : (
          records.map((record) => (
            <DecisionLedgerCard
              key={record.id}
              record={record}
              busy={marking.has(record.id)}
              onMark={(verdict) => void markOutcome(record, verdict)}
            />
          ))
        )}
      </ScrollArea>
    </div>
  )
}

function DecisionLedgerCard({
  record,
  busy,
  onMark,
}: {
  record: DecisionLedgerViewEntry
  busy: boolean
  onMark: (verdict: 'correct' | 'wrong') => void
}): React.ReactNode {
  const latestMark = latestMarkOutcome(record.outcomes)
  return (
    <article className="tw:grid tw:min-w-0 tw:gap-2 tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:p-3">
      <header className="tw:flex tw:min-w-0 tw:items-center tw:justify-between tw:gap-2">
        <span className="tw:truncate tw:type-2 tw:weight-medium tw:text-app-text" title={record.specId}>
          {record.specId}
        </span>
        <span className="tw:flex tw:shrink-0 tw:items-center tw:gap-1 tw:type-1 tw:text-app-text-meta">
          <span
            className={`tw:rounded-full tw:px-2 tw:py-0.5 tw:weight-medium ${
              record.mode === 'active'
                ? 'tw:bg-app-accent-subtle tw:text-app-accent-fg'
                : 'tw:bg-app-hover tw:text-app-text-soft'
            }`}
          >
            {record.mode === 'active' ? '生效' : '影子'}
          </span>
          <span>{record.source === 'judge' ? 'Judge' : '回退'}</span>
        </span>
      </header>
      <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-x-3 tw:gap-y-1 tw:type-1 tw:text-app-text-soft">
        <span className="tw:tabular-nums">{formatDecisionTime(record.createdAt)}</span>
        <span>
          {record.providerId}
          {record.modelId ? ` · ${record.modelId}` : ''}
        </span>
        {record.latencyMs !== null ? (
          <span className="tw:tabular-nums">{record.latencyMs}ms</span>
        ) : null}
      </div>
      {record.reason ? (
        <p className="tw:m-0 tw:type-1 tw:text-app-text-soft tw:wrap-anywhere">{record.reason}</p>
      ) : null}
      {record.answers ? (
        <div className="tw:grid tw:gap-1.5">
          {Object.entries(record.answers).map(([questionId, answer]) => (
            <DecisionAnswerRow key={questionId} questionId={questionId} answer={answer} />
          ))}
        </div>
      ) : null}
      {record.tiers.length > 0 ? (
        <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-1 tw:type-1 tw:text-app-text-meta">
          <span>级联：</span>
          {record.tiers.map((tier) => (
            <span
              key={tier.judgeId}
              className="tw:rounded-3 tw:bg-app-hover tw:px-1.5 tw:py-0.5 tw:tabular-nums"
              title={tier.error ? `错误：${tier.error}` : undefined}
            >
              {tier.judgeId} {tier.kept}/{tier.asked}
              {tier.latencyMs !== undefined ? ` · ${tier.latencyMs}ms` : ''}
              {tier.error ? ' · 失败' : ''}
            </span>
          ))}
        </div>
      ) : null}
      {record.outcomes.length > 0 ? (
        <div className="tw:grid tw:gap-1 tw:type-1">
          {record.outcomes.map((outcome) => (
            <div key={outcome.id} className="tw:flex tw:items-center tw:gap-2 tw:text-app-text-soft">
              <span className="tw:shrink-0 tw:text-app-text-meta">
                {outcomeKindLabel(outcome)}
              </span>
              <span className={outcomeVerdictClass(outcome.verdict)}>{outcome.verdict}</span>
              {outcome.note ? (
                <span className="tw:min-w-0 tw:truncate" title={outcome.note}>
                  {outcome.note}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <footer className="tw:flex tw:items-center tw:gap-2">
        <Button
          color="secondary"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => onMark('correct')}
        >
          <Check aria-hidden="true" size={14} />
          判对了
        </Button>
        <Button
          color="secondary"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => onMark('wrong')}
        >
          <X aria-hidden="true" size={14} />
          判错了
        </Button>
        {latestMark ? (
          <span className="tw:type-1 tw:text-app-text-meta">
            已标记：
            <span className={outcomeVerdictClass(latestMark.verdict)}>
              {latestMark.verdict === 'correct' ? '判对了' : '判错了'}
            </span>
          </span>
        ) : null}
      </footer>
    </article>
  )
}

function DecisionAnswerRow({
  questionId,
  answer,
}: {
  questionId: string
  answer: DecisionAnswer
}): React.ReactNode {
  const distribution = answerDistribution(answer)
  return (
    <div className="tw:grid tw:min-w-0 tw:gap-1">
      <div className="tw:flex tw:min-w-0 tw:items-baseline tw:justify-between tw:gap-2 tw:type-1">
        <span className="tw:truncate tw:weight-medium tw:text-app-text" title={questionId}>
          {questionId}
        </span>
        <span className="tw:shrink-0 tw:text-app-text-soft tw:tabular-nums">
          {answerSummary(answer)}
          {answer.confidence !== undefined ? ` · ${formatPercent(answer.confidence)}` : ''}
          {answer.judge ? ` · ${answer.judge}` : ''}
        </span>
      </div>
      {distribution.length > 0 ? (
        <div className="tw:grid tw:gap-0.5">
          {distribution.map(([label, probability]) => (
            <div
              key={label}
              className="tw:grid tw:grid-cols-[minmax(0,7rem)_minmax(0,1fr)_3rem] tw:items-center tw:gap-2 tw:type-1 tw:text-app-text-meta"
            >
              <span className="tw:truncate" title={label}>
                {label}
              </span>
              <span className="tw:h-1.5 tw:min-w-0 tw:overflow-hidden tw:rounded-full tw:bg-app-hover">
                <span
                  className="tw:block tw:h-full tw:rounded-full tw:bg-app-accent"
                  style={{ width: `${Math.round(probability * 100)}%` }}
                />
              </span>
              <span className="tw:text-right tw:tabular-nums">{formatPercent(probability)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function answerDistribution(answer: DecisionAnswer): Array<[string, number]> {
  if (answer.type === 'boolean') {
    return [
      ['是', answer.probability],
      ['否', 1 - answer.probability],
    ]
  }
  if (!answer.probabilities) return []
  return Object.entries(answer.probabilities).sort((left, right) => right[1] - left[1])
}

function answerSummary(answer: DecisionAnswer): string {
  if (answer.type === 'boolean') return answer.probability >= 0.5 ? '是' : '否'
  if (answer.type === 'choice') return answer.choice
  return `评分 ${answer.score}`
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatDecisionTime(createdAt: number): string {
  const date = new Date(createdAt)
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('zh-CN', { hour12: false })
    : ''
}

function latestMarkOutcome(
  outcomes: readonly DecisionOutcomeRecord[],
): DecisionOutcomeRecord | null {
  return outcomes.filter((outcome) => outcome.kind === 'mark').at(-1) ?? null
}

function outcomeKindLabel(outcome: DecisionOutcomeRecord): string {
  if (outcome.kind === 'permission') return '审批'
  if (outcome.kind === 'nudge') return '跟进'
  return '纠偏'
}

function outcomeVerdictClass(verdict: string): string {
  if (verdict === 'correct' || verdict === 'allow' || verdict === 'approved') {
    return 'tw:text-app-success tw:weight-medium'
  }
  if (verdict === 'wrong' || verdict === 'deny' || verdict === 'denied') {
    return 'tw:text-app-danger tw:weight-medium'
  }
  return 'tw:text-app-text'
}