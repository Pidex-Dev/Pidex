import React from 'react'
import { AlertCircle, Check, LoaderCircle, RotateCcw, X } from 'lucide-react'
import {
  resolveSubagentDisplayParts,
  type Item,
  type SubagentRun,
  type SubagentTask,
  type ThreadSnapshot,
} from '@pidex/shared/thread'
import {
  createCanonicalThreadState,
  pageFromThreadSnapshot,
  selectRenderTurnEntries,
} from '@pidex/session-view'
import type { VirtualizerHandle } from 'virtua'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from '../../../components/ui/IconTokens.js'
import { Button } from '../../../components/ui/Button.js'

import { desktopClient } from '../../../services/desktop-client/index.js'
import {
  InlineApprovalCard,
  type InlineApprovalCardProps,
} from '../approvals/InlineApprovalCard.js'
import { PlanApprovalCard } from '../approvals/PlanApprovalCard.js'
import { selectCanonicalConversationAuxiliaryState } from '../conversation/CanonicalConversationSelectors.js'
import {
  CanonicalConversationTurn,
  useTimelineDisclosureState,
} from '../timeline/CanonicalThreadView.js'
import { SessionTimelineView } from '../timeline/SessionTimelineView.js'
import { normalizePatchActionError } from '../timeline/PatchActionError.js'
import {
  ConversationItemContext,
  useOptionalConversationItemContext,
} from '../timeline/ConversationItemContext.js'

export interface SubagentThreadCapabilities {
  canStop: boolean
  canRetry?: boolean
  canRespondToApprovals: boolean
  canRespondToQuestions: boolean
  canRespondToPlan?: boolean
  canApplyWorktree: boolean
  canDiscardWorktree: boolean
  canRestoreWorkspace: boolean
}

export interface SubagentThreadCallbacks {
  onPatchApplied?: () => Promise<void>
  onStop?: (task: SubagentTask, run: SubagentRun) => void
  onApplyWorktree?: (task: SubagentTask, run: SubagentRun) => void
  onDiscardWorktree?: (task: SubagentTask, run: SubagentRun) => void
  onRestoreWorkspace?: (task: SubagentTask, run: SubagentRun) => void
  onOpenSubagent?: (item: Extract<Item, { type: 'subagent' }>) => void
  onOpenPatchReview?: (path?: string) => void
  onRequestRespond?: InlineApprovalCardProps['onDecide']
  onInterrupt?: () => Promise<void>
}

export interface SubagentThreadPanelProps {
  task: SubagentTask
  run: SubagentRun
  snapshot: ThreadSnapshot
  capabilities: SubagentThreadCapabilities
  callbacks: SubagentThreadCallbacks
}

export function SubagentThreadPanel({
  task,
  run,
  snapshot,
  capabilities,
  callbacks,
}: SubagentThreadPanelProps): React.ReactNode {
  const { agentName, taskTitle } = resolveSubagentDisplayParts({
    displayName: task.displayName,
    title: task.title,
    profile: task.profile,
    role: task.role,
    task: task.task,
  })
  const identityLabel =
    taskTitle && taskTitle !== agentName ? `${agentName} · ${taskTitle}` : agentName
  const itemContext = useOptionalConversationItemContext()
  const readOnlyItemContext = React.useMemo(
    () => ({
      ...itemContext,
      canEditUserMessage: false,
      onForkFromMessage: undefined,
      workspacePath: task.workspace.rootPath,
    }),
    [itemContext, task.workspace.rootPath],
  )
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const listRef = React.useRef<VirtualizerHandle | null>(null)
  const disclosureState = useTimelineDisclosureState(task.childThreadId)
  const canonicalState = React.useMemo(
    () => createCanonicalThreadState(pageFromThreadSnapshot(snapshot)),
    [snapshot],
  )
  const canonicalTurns = React.useMemo(
    () => selectRenderTurnEntries(canonicalState, { type: 'subagent', runId: run.id }),
    [canonicalState, run.id],
  )
  const pendingRequests = React.useMemo(
    () => selectCanonicalConversationAuxiliaryState(canonicalState).pendingPermissions,
    [canonicalState],
  )
  const pendingRequest = pendingRequests[0]
  const canRespond =
    Boolean(callbacks.onRequestRespond) &&
    isActiveRun(run) &&
    (pendingRequest?.toolName === 'AskUserQuestion'
      ? capabilities.canRespondToQuestions
      : capabilities.canRespondToApprovals)
  const viewBlocked = pendingRequests.length > 0
  const blocked = isBlockedRun(run) || viewBlocked
  const canStop = capabilities.canStop && Boolean(callbacks.onStop) && isActiveRun(run)
  const hasWorkspaceActions =
    (capabilities.canApplyWorktree && Boolean(callbacks.onApplyWorktree)) ||
    (capabilities.canDiscardWorktree && Boolean(callbacks.onDiscardWorktree)) ||
    (capabilities.canRestoreWorkspace && Boolean(callbacks.onRestoreWorkspace))
  const statusNotices = [
    task.waitingForDescendants ? '等待后代结算' : null,
    task.queuedFollowups ? `${task.queuedFollowups} 条后续任务已接纳` : null,
  ].filter((notice): notice is string => notice !== null)
  const scrollStorageKey = `pidex.subagent.scroll.${task.childThreadId}`
  const initialScrollOffset = React.useMemo(() => {
    try {
      const stored = Number(window.sessionStorage.getItem(scrollStorageKey) ?? 0)
      return Number.isFinite(stored) ? stored : 0
    } catch {
      return 0
    }
  }, [scrollStorageKey])
  const persistScroll = React.useCallback(
    (scrollTop: number): void => {
      try {
        window.sessionStorage.setItem(scrollStorageKey, String(scrollTop))
      } catch {
        // Session storage can be unavailable; scrolling remains functional.
      }
    },
    [scrollStorageKey],
  )
  const renderTurn = React.useCallback(
    (turn: (typeof canonicalTurns)[number]) => (
      <div
        className="session-turn-row canonical-turn-row tw:mx-auto tw:w-full tw:min-w-0"
        data-component="conversation-turn"
        key={turn.id}
      >
        <CanonicalConversationTurn
          disclosureState={disclosureState}
          entry={turn}
          onApplyPatch={async (itemId, action, expectedVersion) => {
            try {
              await desktopClient.applyThreadPatch({
                threadId: task.childThreadId,
                itemId,
                action,
                expectedVersion,
              })
              await callbacks.onPatchApplied?.()
            } catch (error) {
              throw normalizePatchActionError(error, action)
            }
          }}
          onOpenPatchReview={callbacks.onOpenPatchReview}
          onOpenPlanInRightDock={() => undefined}
          onOpenSubagent={(taskId) => {
            const item = snapshot.items.find(
              (candidate): candidate is Extract<Item, { type: 'subagent' }> =>
                candidate.type === 'subagent' && candidate.subagentTaskId === taskId,
            )
            if (item) callbacks.onOpenSubagent?.(item)
          }}
          dockedPlanItemId={null}
          readThreadPatchDiff={desktopClient.readThreadPatchDiff}
          threadId={task.childThreadId}
        />
      </div>
    ),
    [callbacks, disclosureState, snapshot.items, task.childThreadId],
  )

  return (
    <section
      aria-label={`${identityLabel} 子智能体线程`}
      className="subagent-thread-panel tw:grid tw:w-full tw:h-full tw:min-h-0 tw:min-w-0 tw:grid-rows-[minmax(0,1fr)] tw:bg-app-canvas tw:text-app-text tw:[container-type:inline-size]"
      data-blocked={blocked || undefined}
      data-status={run.status}
    >
      <div
        ref={scrollRef}
        className="subagent-thread-panel__scroll-region thread-scroll-layout tw:min-h-0 tw:overflow-auto tw:[scrollbar-gutter:stable]"
      >
        <div className="subagent-thread-panel__transcript tw:mx-auto tw:grid tw:w-[min(760px,calc(100%-28px))] tw:min-w-0 tw:gap-4 tw:px-0 tw:pt-5 tw:pb-6">
          {hasWorkspaceActions ? (
            <div className="subagent-thread-panel__workspace-actions tw:flex tw:items-center tw:justify-end tw:gap-1 tw:[overflow-anchor:none]">
              {capabilities.canApplyWorktree && callbacks.onApplyWorktree ? (
                <Button
                  isIconOnly
                  aria-label="应用子智能体变更"
                  color="ghostSecondary"
                  size="toolbar"
                  title="应用子智能体变更"
                  onClick={() => callbacks.onApplyWorktree?.(task, run)}
                >
                  <Check
                    className="tw:size-icon-md"
                    size={APP_ICON_SIZE}
                    strokeWidth={APP_ICON_STROKE_WIDTH}
                  />
                </Button>
              ) : null}
              {capabilities.canDiscardWorktree && callbacks.onDiscardWorktree ? (
                <Button
                  isIconOnly
                  aria-label="丢弃子智能体工作树"
                  color="danger"
                  size="toolbar"
                  title="丢弃子智能体工作树"
                  onClick={() => callbacks.onDiscardWorktree?.(task, run)}
                >
                  <X
                    className="tw:size-icon-md"
                    size={APP_ICON_SIZE}
                    strokeWidth={APP_ICON_STROKE_WIDTH}
                  />
                </Button>
              ) : null}
              {capabilities.canRestoreWorkspace && callbacks.onRestoreWorkspace ? (
                <Button
                  isIconOnly
                  aria-label="恢复子智能体共享变更"
                  color="ghostSecondary"
                  size="toolbar"
                  title="恢复共享变更"
                  onClick={() => callbacks.onRestoreWorkspace?.(task, run)}
                >
                  <RotateCcw
                    className="tw:size-icon-md"
                    size={APP_ICON_SIZE}
                    strokeWidth={APP_ICON_STROKE_WIDTH}
                  />
                </Button>
              ) : null}
            </div>
          ) : null}
          {statusNotices.length > 0 ? (
            <div
              className="tw:text-app-text-meta tw:type-1 tw:[overflow-anchor:none]"
              role="status"
            >
              {statusNotices.join(' · ')}
            </div>
          ) : null}
          {run.queueReason ? (
            <div
              className="subagent-thread-panel__notice tw:flex tw:items-center tw:gap-2 tw:rounded-4 tw:px-3 tw:py-2 tw:bg-app-editor tw:text-app-text-meta tw:type-1 tw:[overflow-anchor:none]"
              role="status"
            >
              <LoaderCircle className="tw:size-icon-md tw:animate-spin" size={APP_ICON_SIZE} />
              {queueReasonLabel(run.queueReason)}
            </div>
          ) : null}

          {canonicalTurns.length > 0 ? (
            <ConversationItemContext.Provider value={readOnlyItemContext}>
              <div className="subagent-thread-panel__timeline tw:grid tw:gap-4">
                {typeof document === 'undefined' ? (
                  canonicalTurns.map(renderTurn)
                ) : (
                  <SessionTimelineView
                    count={canonicalTurns.length}
                    initialScrollOffset={initialScrollOffset}
                    items={canonicalTurns}
                    listRef={listRef}
                    onScroll={persistScroll}
                    renderItem={renderTurn}
                    scrollRef={scrollRef}
                    scrollToBottom={isActiveRun(run)}
                    sessionKey={task.childThreadId}
                  />
                )}
              </div>
            </ConversationItemContext.Provider>
          ) : (
            <div
              className="subagent-thread-panel__empty tw:py-6 tw:text-center tw:text-app-text-meta tw:type-2 tw:[overflow-anchor:none]"
              role="status"
            >
              {run.status === 'queued' || run.status === 'preparing'
                ? '等待开始执行'
                : '暂无运行记录'}
            </div>
          )}

          {pendingRequest ? (
            <div className="tw:[overflow-anchor:none]">
              <InlineApprovalCard
                key={pendingRequest.requestId}
                request={pendingRequest}
                identity={identityLabel}
                workspacePath={task.workspace.rootPath}
                disabledReason={
                  canRespond ? undefined : '此子智能体当前不可操作，请通过父任务继续。'
                }
                onDecide={
                  callbacks.onRequestRespond ??
                  (() => Promise.reject(new Error('此子智能体当前不可操作。')))
                }
                onInterrupt={canStop ? callbacks.onInterrupt : undefined}
              />
            </div>
          ) : snapshot.pendingPlanApproval ? (
            <div className="tw:[overflow-anchor:none]">
              <PlanApprovalCard
                approval={snapshot.pendingPlanApproval}
                identity={identityLabel}
                disabledReason="此子智能体没有计划续跑入口，请返回父任务处理。"
                onRespond={() => Promise.reject(new Error('此子智能体不支持计划操作。'))}
              />
            </div>
          ) : null}

          {blocked ? (
            <div className="tw:[overflow-anchor:none]">
              <BlockedNotice run={run} viewBlocked={viewBlocked} />
            </div>
          ) : null}
          {run.error ? (
            <div
              className="subagent-thread-panel__error tw:flex tw:items-center tw:gap-2 tw:rounded-4 tw:border tw:border-app-danger-border tw:bg-app-danger-subtle tw:px-3 tw:py-2 tw:text-app-danger-fg tw:type-1 tw:[overflow-anchor:none]"
              role="alert"
            >
              <AlertCircle size="var(--inline-icon-size, 1em)" />
              <span>{run.error}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function BlockedNotice({
  run,
  viewBlocked,
}: {
  run: SubagentRun
  viewBlocked: boolean
}): React.ReactNode {
  const label =
    run.status === 'waiting-permission'
      ? '等待审批后继续'
      : run.status === 'waiting-question'
        ? '等待回答后继续'
        : viewBlocked
          ? '此子智能体正在等待你的操作'
          : '此子智能体已阻塞'
  return (
    <div
      className="subagent-thread-panel__blocked tw:flex tw:items-center tw:gap-2 tw:rounded-4 tw:border tw:border-app-warning-border tw:bg-app-warning-subtle tw:px-3 tw:py-2 tw:text-app-warning-fg tw:type-1"
      role="status"
    >
      <AlertCircle size="var(--inline-icon-size, 1em)" />
      <span>{label}</span>
    </div>
  )
}

function queueReasonLabel(reason: NonNullable<SubagentRun['queueReason']>): string {
  if (reason === 'parent-limit') return '等待同一父智能体释放并发名额'
  if (reason === 'global-limit') return '等待全局并发名额'
  return '等待共享工作区写入锁'
}

function isBlockedRun(run: SubagentRun): boolean {
  return (
    run.status === 'waiting-permission' ||
    run.status === 'waiting-question' ||
    run.result?.outcome === 'blocked'
  )
}

function isActiveRun(run: SubagentRun): boolean {
  return (
    isActiveRunStatus(run.status) ||
    run.status === 'waiting-permission' ||
    run.status === 'waiting-question'
  )
}

function isActiveRunStatus(status: SubagentRun['status']): boolean {
  return (
    status === 'queued' || status === 'preparing' || status === 'running' || status === 'steering'
  )
}
