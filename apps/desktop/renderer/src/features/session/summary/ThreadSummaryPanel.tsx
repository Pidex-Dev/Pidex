import { formatReviewCount } from '../../review/diff/ReviewFormat.js'
import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Popover as Popover } from '../../../components/ui/floating/Popover.js'
import {
  ChevronDown,
  FileText,
  Folder,
  GitBranch,
  Ellipsis,
  Terminal,
  Globe,
  Image as ImageIcon,
  Link2,
  Package,
  Paperclip,
  Play,
  Plus,
  Plug,
  RefreshCcw,
  Search,
  Square,
  SquarePlus,
  X,
} from 'lucide-react'
import { APP_ICON_SIZE, APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'
import { cx } from '../../../utils/Cx.js'
import { SubagentAvatar } from '../subagents/SubagentAvatar.js'
import {
  formatElapsed,
  subagentAttentionLabel,
  subagentStatusLabel,
  useRunningClock,
} from '../subagents/SubagentStatusLabel.js'
import { BranchSelectPopover } from '../composer/BranchSelectPopover.js'
import type {
  ThreadSummaryArtifact,
  ThreadSummaryBrowserTab,
  ThreadSummarySourceEntry,
  ThreadSummaryViewModel,
} from './ThreadSummaryViewModel.js'
import {
  previewThreadSummaryAgents,
  previewThreadSummarySources,
  threadSummaryArtifactPreviewKind,
} from './ThreadSummaryViewModel.js'
import type { Attachment, LocalContextReference } from '@pidex/shared/thread'
import { Button } from '../../../components/ui/Button.js'
import { useDialogFocusRestore } from '../../../components/ui/UseDialogFocusRestore.js'
import { DisclosureContent } from '../../../components/ui/DisclosureContent.js'
import { Spinner } from '../../../components/ui/Spinner.js'
import { PopoverMenu } from '../../../components/ui/PopoverMenu.js'
import type { CommandMenuActionRegistration } from '../../search/CommandMenuActionStore.js'
import { PopoverItem } from '../../../components/ui/PopoverItem.js'

const SUMMARY_ROW_CLASS =
  'interactive-row interactive-row--nav thread-summary-row tw:w-full tw:min-w-0'

const SUMMARY_ROW_LABEL_CLASS =
  'tw:min-w-0 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap'

const SUMMARY_ROW_ICON_CLASS = 'tw:text-app-text'

import type { ThreadSummarySectionId } from './ThreadSummaryState.js'

export type { ThreadSummarySectionId } from './ThreadSummaryState.js'

type ThreadSummaryActions = {
  environmentChoices?: readonly CommandMenuActionRegistration[]
  workspaceActions?: readonly CommandMenuActionRegistration[]
  selectedActionId?: string
  onSelectAction?: (id: string) => void
  onActivateBrowserTab?: (tabId: string) => void
  onBranchSelect: (branch: string) => Promise<void>
  onCommitOrPush: () => void
  onCreateBranch: () => void
  onCreatePullRequest: () => void
  onCreateOutput?: () => void
  onGitOperation?: (operation: 'commit' | 'push') => void
  onOpenEnvironmentSettings?: () => void
  onAddEnvironmentAction?: () => void
  onOpenTerminal?: () => void
  onMoveToWorktree?: () => void
  onRetryGitDetection?: () => void
  pushEnabled?: boolean
  onGoalPause?: () => void | Promise<void>
  onGoalResume?: () => void | Promise<void>
  onOpenArtifact?: (artifact: ThreadSummaryArtifact) => void
  onOpenAttachment?: (attachment: Attachment) => void
  onOpenLocalContext?: (reference: LocalContextReference) => void
  onOpenReview: () => void
  onOpenSubagent?: (taskId: string) => void
  onOpenSubagentDirectory?: () => void
  onStopSubagent?: (taskId: string) => void | Promise<void>
  onOpenWorkspacePath: () => void
}

type ThreadSummaryPanelProps = ThreadSummaryActions & {
  changesLoading?: boolean
  branches: string[]
  collapsedSections: ReadonlySet<ThreadSummarySectionId>
  model: ThreadSummaryViewModel
  onToggleSection: (id: ThreadSummarySectionId) => void
}

const AGENT_STATUS_META_LABELS: Record<string, string> = {
  loading: '加载中',
  busy: '忙碌',
  suspended: '已挂起',
  error: '错误',
}

export function ThreadSummaryPopover({
  children,
  open,
  panel,
  onOpenChange,
}: {
  children: React.ReactElement
  open: boolean
  panel: React.ReactNode
  onOpenChange: (open: boolean) => void
}): React.ReactNode {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          asChild
          size="lg"
          align="end"
          aria-label="会话概览"
          collisionPadding={12}
          side="bottom"
          sideOffset={8}
        >
          <div className="thread-summary-popover tw:[--popover-width:16.25rem] tw:[--popover-max-height:min(680px,calc(100vh-80px))] tw:p-1">
            {panel}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export class ThreadSummaryErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean; retryKey: number }
> {
  state = { failed: false, retryKey: 0 }

  static getDerivedStateFromError(): Partial<{
    failed: boolean
    retryKey: number
  }> {
    return { failed: true }
  }

  retry = (): void => {
    this.setState((state) => ({
      failed: false,
      retryKey: state.retryKey + 1,
    }))
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <section
          aria-label="摘要加载失败"
          className={`thread-summary-error tw:w-full tw:grid tw:min-h-0 tw:place-content-center tw:justify-items-center tw:gap-2 tw:p-3 tw:text-center`}
          role="alert"
        >
          <strong>摘要暂时无法显示</strong>
          <span className="tw:text-app-text-meta tw:type-1">会话本身不受影响。</span>
          <button
            type="button"
            onClick={this.retry}
            className="tw:mt-2 tw:inline-flex tw:items-center tw:gap-1 tw:rounded-control tw:border tw:border-app-border-subtle tw:bg-app-raised tw:px-3 tw:py-2 tw:text-app-text tw:[font:inherit] tw:cursor-pointer tw:focus-visible:outline-1 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-app-focus"
          >
            <RefreshCcw size="var(--inline-icon-size, 1em)" />
            重试
          </button>
        </section>
      )
    }
    return <React.Fragment key={this.state.retryKey}>{this.props.children}</React.Fragment>
  }
}

export function ThreadSummaryPanel({
  changesLoading = false,
  workspaceActions = [],
  environmentChoices = [],
  selectedActionId,
  onSelectAction,
  branches,
  collapsedSections,
  model,
  onActivateBrowserTab,
  onBranchSelect,
  onCommitOrPush,
  onCreateBranch,
  onCreateOutput,
  onGitOperation,
  onOpenEnvironmentSettings,
  onAddEnvironmentAction,
  onOpenTerminal,
  onMoveToWorktree,
  onRetryGitDetection,
  pushEnabled = false,
  onGoalPause,
  onGoalResume,
  onOpenArtifact,
  onOpenAttachment,
  onOpenLocalContext,
  onOpenReview,
  onOpenSubagent,
  onOpenSubagentDirectory,
  onStopSubagent,
  onToggleSection,
}: ThreadSummaryPanelProps): React.ReactNode {
  const selectedAction =
    workspaceActions.find((action) => action.id === selectedActionId) ?? workspaceActions[0]
  const [environmentChoicesOpen, setEnvironmentChoicesOpen] = React.useState(false)
  const [branchPopoverOpen, setBranchPopoverOpen] = React.useState(false)
  const [gitMenuOpen, setGitMenuOpen] = React.useState(false)
  const [environmentMenuOpen, setEnvironmentMenuOpen] = React.useState(false)
  const [branchSearch, setBranchSearch] = React.useState('')
  const [sourcesPanelOpen, setSourcesPanelOpen] = React.useState(false)
  const [showAllArtifacts, setShowAllArtifacts] = React.useState(false)
  const [stoppingAgentIds, setStoppingAgentIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const sourcePreview = previewThreadSummarySources(model.sources)
  const agentPreview = previewThreadSummaryAgents(model.agents)
  const runningAgentsCount = model.agents.filter((agent) => agent.state !== 'finished').length
  const now = useRunningClock(runningAgentsCount > 0)
  const handleStopAgent = React.useCallback(
    async (taskId: string): Promise<void> => {
      if (!onStopSubagent) return
      setStoppingAgentIds((prev) => new Set(prev).add(taskId))
      try {
        await onStopSubagent(taskId)
      } finally {
        setStoppingAgentIds((prev) => {
          const next = new Set(prev)
          next.delete(taskId)
          return next
        })
      }
    },
    [onStopSubagent],
  )
  const artifactPreview = {
    items: model.artifacts.slice(0, showAllArtifacts ? model.artifacts.length : 6),
    totalCount: model.artifacts.length,
  }
  const changes = model.changes ?? {
    additions: 0,
    deletions: 0,
    fileCount: 0,
  }
  const environment = model.environment

  const isSectionExpanded = (id: ThreadSummarySectionId): boolean => !collapsedSections.has(id)
  const toggleSection = (id: ThreadSummarySectionId): void => onToggleSection(id)

  return (
    <aside
      className={`tw:w-full tw:flex tw:min-h-0 tw:flex-col tw:gap-1 tw:overflow-x-hidden tw:overflow-y-auto tw:[scrollbar-width:thin]`}
      aria-label="会话概览"
    >
      {model.gitDetection === 'error' ? (
        <div
          className="tw:flex tw:items-center tw:gap-2 tw:px-3 tw:py-0 tw:text-app-text-meta tw:type-1"
          role="status"
        >
          <>
            <span>仓库检测失败</span>
            <Button
              variant="text"
              size="sm"
              onClick={onRetryGitDetection}
              disabled={!onRetryGitDetection}
            >
              重试
            </Button>
          </>
        </div>
      ) : null}
      {environment &&
      (environment.isGitRepository ||
        workspaceActions.length > 0 ||
        environmentChoices.length > 0) ? (
        <ThreadSummarySection
          collapsedSummary={null}
          expanded={isSectionExpanded('environment')}
          first
          id="environment"
          title={environment.workspaceName ?? '本地仓库'}
          meta={
            <div className="tw:flex tw:items-center tw:gap-1">
              <PopoverMenu
                open={environmentMenuOpen}
                onOpenChange={setEnvironmentMenuOpen}
                side="left"
                align="start"
                size="md"
                trigger={
                  <button
                    type="button"
                    aria-label="操作"
                    title="操作"
                    className="tw:inline-flex tw:size-5 tw:items-center tw:justify-center tw:rounded-3 tw:border-0 tw:bg-transparent tw:text-app-text-meta tw:cursor-pointer tw:hover:bg-app-hover tw:focus-visible:outline-2 tw:focus-visible:outline-app-focus"
                  >
                    <Ellipsis className="tw:size-icon-md" aria-hidden="true" size={APP_ICON_SIZE} />
                  </button>
                }
              >
                <div className="tw:px-2 tw:py-1 tw:type-1 tw:text-app-text-meta">操作</div>
                {workspaceActions.map((action) => (
                  <PopoverItem
                    key={action.id}
                    icon={<Play className="tw:size-icon-md" size={APP_ICON_SIZE} />}
                    selected={action.id === selectedAction?.id}
                    withCheck
                    disabled={action.availability !== 'available'}
                    onClick={() => onSelectAction?.(action.id)}
                  >
                    {action.label}
                  </PopoverItem>
                ))}
                <PopoverItem
                  icon={<Plus className="tw:size-icon-md" size={APP_ICON_SIZE} />}
                  disabled={!onOpenEnvironmentSettings}
                  onClick={onAddEnvironmentAction ?? onOpenEnvironmentSettings}
                >
                  添加操作
                </PopoverItem>
                <div className="tw:my-1 tw:border-t tw:border-app-border-subtle" />
                <PopoverItem
                  icon={<Plus className="tw:size-icon-md" size={APP_ICON_SIZE} />}
                  disabled={!onOpenEnvironmentSettings}
                  onClick={() => setEnvironmentChoicesOpen((value) => !value)}
                  keepOpen
                  withArrow
                  arrowDirection={environmentChoicesOpen ? 'up' : 'down'}
                >
                  更改环境
                </PopoverItem>
                {environmentChoicesOpen ? (
                  <>
                    {environmentChoices.map((choice) => (
                      <PopoverItem
                        key={choice.id}
                        selected={choice.selected}
                        withCheck
                        disabled={choice.availability !== 'available'}
                        onClick={() => void choice.execute()}
                      >
                        {choice.label}
                      </PopoverItem>
                    ))}
                    {!environmentChoices.length ? (
                      <div className="tw:px-2 tw:py-1 tw:type-1 tw:text-app-text-meta">
                        暂无环境
                      </div>
                    ) : null}
                    <PopoverItem onClick={onOpenEnvironmentSettings}>环境设置</PopoverItem>
                  </>
                ) : null}
                <PopoverItem
                  icon={<Terminal className="tw:size-icon-md" size={APP_ICON_SIZE} />}
                  disabled={!onOpenTerminal}
                  onClick={onOpenTerminal}
                >
                  打开终端
                </PopoverItem>
                <div className="tw:my-1 tw:border-t tw:border-app-border-subtle" />
                <PopoverItem disabled={!onMoveToWorktree} onClick={onMoveToWorktree}>
                  移动到工作树
                </PopoverItem>
              </PopoverMenu>
              <Button
                isIconOnly
                color="ghostSecondary"
                size="toolbar"
                title={selectedAction ? `运行 ${selectedAction.label}` : '添加启动操作'}
                aria-label={selectedAction ? `运行 ${selectedAction.label}` : '运行脚本'}
                disabled={!selectedAction || selectedAction.availability !== 'available'}
                onClick={() => void selectedAction?.execute()}
              >
                <Play className="tw:size-icon-md" size={APP_ICON_SIZE} />
              </Button>
            </div>
          }
          onToggle={toggleSection}
        >
          {environment.isGitRepository ? (
            <div className="tw:group tw:relative tw:min-w-0">
              <button
                className={SUMMARY_ROW_CLASS}
                title="打开分支变更审查"
                type="button"
                onClick={onOpenReview}
              >
                <SquarePlus
                  className={SUMMARY_ROW_ICON_CLASS}
                  aria-hidden="true"
                  size="var(--inline-icon-size, 1em)"
                />
                <span className={SUMMARY_ROW_LABEL_CLASS}>变更</span>
                <span
                  className={`tw:inline-flex tw:items-center tw:justify-end ${gitMenuOpen || branchPopoverOpen ? 'tw:invisible' : 'tw:group-hover:invisible tw:group-has-[:focus-visible]:invisible'}`}
                >
                  {changesLoading && !model.changes ? (
                    <Spinner label="正在加载变更统计" className="tw:text-app-text-meta" />
                  ) : model.changes && (changes.additions > 0 || changes.deletions > 0) ? (
                    <small className="thread-summary-change-summary tw:inline-flex tw:items-center tw:justify-end tw:gap-2 tw:whitespace-nowrap tw:text-app-text-meta tw:type-1">
                      <span className="thread-summary-diff tw:inline-flex tw:gap-1 tw:type-1 tw:tabular-nums">
                        <strong className="tw:text-app-success tw:weight-regular">
                          +{formatReviewCount(changes.additions)}
                        </strong>
                        <em className="tw:text-app-danger tw:not-italic">
                          -{formatReviewCount(changes.deletions)}
                        </em>
                      </span>
                    </small>
                  ) : null}
                </span>
              </button>
              <div
                className={`tw:absolute tw:right-0 tw:top-0 tw:bottom-0 tw:flex tw:items-center ${gitMenuOpen || branchPopoverOpen ? 'tw:opacity-100' : 'tw:opacity-0 tw:group-hover:opacity-100 tw:group-has-[:focus-visible]:opacity-100'}`}
              >
                <PopoverMenu
                  open={gitMenuOpen}
                  onOpenChange={setGitMenuOpen}
                  side="left"
                  align="start"
                  size="sm"
                  trigger={
                    <button
                      type="button"
                      aria-label="Git 操作"
                      title="Git 操作"
                      className="tw:inline-flex tw:size-6 tw:items-center tw:justify-center tw:rounded-3 tw:border-0 tw:bg-transparent tw:text-app-text tw:cursor-pointer tw:focus-visible:outline-2 tw:focus-visible:outline-app-focus"
                    >
                      <GitBranch
                        className="tw:size-icon-md"
                        aria-hidden="true"
                        size={APP_ICON_SIZE}
                      />
                    </button>
                  }
                >
                  <PopoverItem
                    disabled={!environment.changedFileCount}
                    onClick={() => (onGitOperation ? onGitOperation('commit') : onCommitOrPush())}
                  >
                    提交
                  </PopoverItem>
                  <PopoverItem
                    disabled={!pushEnabled}
                    onClick={() => (onGitOperation ? onGitOperation('push') : onCommitOrPush())}
                  >
                    推送
                  </PopoverItem>
                  <PopoverItem onClick={onCreateBranch}>创建分支</PopoverItem>
                  <PopoverItem onClick={() => setBranchPopoverOpen(true)}>切换分支</PopoverItem>
                </PopoverMenu>
              </div>
              {environment.isGitRepository ? (
                <>
                  <BranchSelectPopover
                    align="start"
                    branchSearch={branchSearch}
                    branches={branches}
                    className="popover-thread-summary-branch"
                    currentBranchDetail={`未提交：${environment.changedFileCount} 个文件`}
                    currentBranchName={environment.branchName ?? ''}
                    open={branchPopoverOpen}
                    side="left"
                    sideOffset={8}
                    size="sm"
                    onBranchSearchChange={setBranchSearch}
                    onBranchSelect={onBranchSelect}
                    onCreateBranch={onCreateBranch}
                    onOpenChange={setBranchPopoverOpen}
                    trigger={
                      <button
                        className="tw:absolute tw:right-0 tw:top-0 tw:size-6 tw:pointer-events-none tw:opacity-0"
                        tabIndex={-1}
                        data-state={branchPopoverOpen ? 'open' : 'closed'}
                        title={environment.branchName ?? '未检测到 Git 分支'}
                        type="button"
                      >
                        <GitBranch
                          className={SUMMARY_ROW_ICON_CLASS}
                          aria-hidden="true"
                          size="var(--inline-icon-size, 1em)"
                        />
                        <span className={SUMMARY_ROW_LABEL_CLASS}>
                          {environment.branchName ?? '未检测到 Git 分支'}
                        </span>
                        <ChevronDown aria-hidden="true" size="var(--inline-icon-size, 1em)" />
                      </button>
                    }
                  />
                </>
              ) : null}
            </div>
          ) : null}
        </ThreadSummarySection>
      ) : null}

      {model.agents.length ? (
        <ThreadSummarySection
          collapsedSummary={
            <span className="tw:inline-flex tw:items-center tw:gap-1">
              <span className="tw:inline-flex tw:items-center">
                {agentPreview.items.map((agent, index) => (
                  <SubagentAvatar
                    key={agent.id}
                    role={agent.role}
                    size="sm"
                    className={cx('tw:ring-1 tw:ring-app-raised', index > 0 && 'tw:-ms-1')}
                  />
                ))}
              </span>
              {agentPreview.remainingCount > 0 ? (
                <span className="tw:type-1 tw:tabular-nums tw:text-app-text-meta">
                  +{agentPreview.remainingCount}
                </span>
              ) : null}
            </span>
          }
          expanded={isSectionExpanded('agents')}
          id="agents"
          meta={
            <span className="tw:type-1 tw:tabular-nums tw:text-app-text-meta">
              {runningAgentsCount > 0 ? `${runningAgentsCount} 运行` : `${model.agents.length}`}
            </span>
          }
          title="智能体"
          onToggle={toggleSection}
        >
          <div className="tw:flex tw:min-w-0 tw:flex-col tw:gap-1">
            {model.agents.map((agent) => {
              const titleText = agent.taskTitle || agent.agentName
              const attention = subagentAttentionLabel(agent.status)
              const timeOrStatus =
                agent.state !== 'finished'
                  ? (attention ?? `已运行 ${formatElapsed(agent.startedAt, now)}`)
                  : subagentStatusLabel(agent.status)
              const metaText = !agent.taskTitle
                ? timeOrStatus
                : agent.state === 'finished'
                  ? `${agent.agentName} ${timeOrStatus}`
                  : `${timeOrStatus} · ${agent.agentName}`
              const openTarget = onOpenSubagent
                ? () => onOpenSubagent(agent.id)
                : onOpenSubagentDirectory
              return (
                <div
                  className="tw:flex tw:min-w-0 tw:items-center tw:justify-between tw:gap-1"
                  key={agent.id}
                >
                  <button
                    className="interactive-row interactive-row--nav tw:min-w-0 tw:flex-1"
                    title={agent.taskTitle ? `${agent.agentName} · ${agent.taskTitle}` : agent.agentName}
                    type="button"
                    onClick={openTarget}
                  >
                    <SubagentAvatar role={agent.role} size="sm" />
                    <span className="tw:flex tw:min-w-0 tw:flex-1 tw:flex-col tw:gap-0.5">
                      <span className="tw:min-w-0 tw:truncate tw:text-app-text tw:type-2">
                        {titleText}
                      </span>
                      <span className="tw:min-w-0 tw:truncate tw:text-app-text-meta tw:type-1 tw:tabular-nums">
                        {metaText}
                      </span>
                    </span>
                  </button>
                  {agent.stoppable && onStopSubagent ? (
                    <Button
                      aria-label={`停止 ${titleText}`}
                      color="ghostSecondary"
                      disabled={stoppingAgentIds.has(agent.id)}
                      leftIcon={
                        <Square
                          aria-hidden="true"
                          className="tw:size-2.5 tw:fill-current"
                          size={APP_ICON_SIZES.sm}
                        />
                      }
                      size="xs"
                      onClick={() => void handleStopAgent(agent.id)}
                    >
                      停止
                    </Button>
                  ) : null}
                </div>
              )
            })}
          </div>
        </ThreadSummarySection>
      ) : null}

      {model.browserTabs.length ? (
        <ThreadSummarySection
          expanded={isSectionExpanded('browser')}
          id="browser"
          title="浏览器"
          onToggle={toggleSection}
        >
          {model.browserTabs.map((tab) => (
            <BrowserTabRow key={tab.tabId} tab={tab} onActivate={onActivateBrowserTab} />
          ))}
        </ThreadSummarySection>
      ) : null}

      {artifactPreview.items.length || model.gitDetection === 'non-git' ? (
        <ThreadSummarySection
          expanded={isSectionExpanded('artifacts')}
          id="artifacts"
          title="输出内容"
          meta={
            onCreateOutput ? (
              <button
                aria-label="创建文件或站点"
                className="tw:inline-flex tw:size-5 tw:items-center tw:justify-center tw:rounded-3 tw:border-0 tw:bg-transparent tw:p-0 tw:text-app-text-meta tw:cursor-pointer tw:hover:text-app-text tw:focus-visible:outline-2 tw:focus-visible:outline-app-focus"
                type="button"
                onClick={onCreateOutput}
              >
                <Plus className="tw:size-icon-md" aria-hidden="true" size={APP_ICON_SIZE} />
              </button>
            ) : null
          }
          onToggle={toggleSection}
        >
          {!artifactPreview.items.length ? (
            <button
              className={SUMMARY_ROW_CLASS}
              data-tone="meta"
              type="button"
              disabled={!onCreateOutput}
              onClick={onCreateOutput}
            >
              <span aria-hidden="true" />
              <span className={SUMMARY_ROW_LABEL_CLASS}>创建文件或站点</span>
            </button>
          ) : null}
          {artifactPreview.items.map((artifact) => (
            <ArtifactRow key={artifact.artifactId} artifact={artifact} onOpen={onOpenArtifact} />
          ))}
          {!showAllArtifacts && artifactPreview.totalCount > artifactPreview.items.length ? (
            <button
              className={SUMMARY_ROW_CLASS}
              data-tone="meta"
              type="button"
              onClick={() => setShowAllArtifacts(true)}
            >
              <ChevronDown aria-hidden="true" size="var(--inline-icon-size, 1em)" />
              <span className={SUMMARY_ROW_LABEL_CLASS}>
                查看全部 {artifactPreview.totalCount} 个产物
              </span>
            </button>
          ) : null}
        </ThreadSummarySection>
      ) : null}

      {sourcePreview.items.length ? (
        <ThreadSummarySection
          expanded={isSectionExpanded('sources')}
          id="sources"
          title="来源"
          onToggle={toggleSection}
        >
          {sourcePreview.items.map((source) => (
            <ThreadSummarySourceRow
              key={source.identity}
              source={source}
              onOpenAttachment={onOpenAttachment}
              onOpenLocalContext={onOpenLocalContext}
            />
          ))}
          {sourcePreview.totalCount > sourcePreview.items.length ? (
            <button
              aria-haspopup="dialog"
              className={`${SUMMARY_ROW_CLASS} thread-summary-source-toggle tw:[&>svg:first-child]:text-app-text-meta tw:hover:[&>svg:first-child]:text-app-text tw:focus-visible:[&>svg:first-child]:text-app-text`}
              data-tone="meta"
              type="button"
              onClick={() => setSourcesPanelOpen(true)}
            >
              <Link2 aria-hidden="true" size="var(--inline-icon-size, 1em)" />
              <span className={SUMMARY_ROW_LABEL_CLASS}>
                查看全部 {sourcePreview.totalCount} 条来源
              </span>
            </button>
          ) : null}
        </ThreadSummarySection>
      ) : null}

      <ThreadSummarySourcesPanel
        open={sourcesPanelOpen}
        sources={model.sources}
        onOpenAttachment={onOpenAttachment}
        onOpenLocalContext={onOpenLocalContext}
        onOpenChange={setSourcesPanelOpen}
      />
    </aside>
  )
}

function BrowserTabRow({
  tab,
  onActivate,
}: {
  tab: ThreadSummaryBrowserTab
  onActivate?: (tabId: string) => void
}): React.ReactNode {
  const stateLabel = AGENT_STATUS_META_LABELS[tab.state]
  return (
    <button
      className={SUMMARY_ROW_CLASS}
      title={tab.state === 'error' ? '该标签页加载出错' : tab.title}
      type="button"
      onClick={() => onActivate?.(tab.tabId)}
    >
      <Globe
        className={SUMMARY_ROW_ICON_CLASS}
        aria-hidden="true"
        size="var(--inline-icon-size, 1em)"
      />
      <span className={SUMMARY_ROW_LABEL_CLASS}>{tab.title}</span>
      <small className="tw:flex tw:items-center tw:gap-1 tw:whitespace-nowrap tw:text-app-text-meta tw:type-1">
        {tab.domain ? <span>{tab.domain}</span> : null}
        {stateLabel ? (
          <span
            className={cx(
              tab.state === 'error' && 'tw:text-app-danger',
              tab.state === 'suspended' && 'tw:text-app-warning',
            )}
          >
            {stateLabel}
          </span>
        ) : null}
      </small>
    </button>
  )
}

function ThreadSummarySourceRow({
  source,
  onOpenAttachment,
  onOpenLocalContext,
}: {
  source: ThreadSummarySourceEntry
  onOpenAttachment?: (attachment: Attachment) => void
  onOpenLocalContext?: (reference: LocalContextReference) => void
}): React.ReactNode {
  if (source.kind === 'attachment') {
    const Icon = source.attachment.kind === 'image' ? ImageIcon : Paperclip
    return (
      <button
        className={SUMMARY_ROW_CLASS}
        title={source.attachment.kind === 'image' ? '预览图片附件' : source.label}
        type="button"
        onClick={() => onOpenAttachment?.(source.attachment)}
      >
        <Icon
          className={SUMMARY_ROW_ICON_CLASS}
          aria-hidden="true"
          size="var(--inline-icon-size, 1em)"
        />
        <span className={SUMMARY_ROW_LABEL_CLASS}>{source.label}</span>
      </button>
    )
  }
  if (source.kind === 'reference') {
    const Icon = source.reference.kind === 'directory' ? Folder : FileText
    return (
      <button
        className={SUMMARY_ROW_CLASS}
        title={source.reference.status === 'missing' ? '引用的路径已不存在' : source.label}
        type="button"
        onClick={() => onOpenLocalContext?.(source.reference)}
      >
        <Icon
          className={SUMMARY_ROW_ICON_CLASS}
          aria-hidden="true"
          size="var(--inline-icon-size, 1em)"
        />
        <span className={SUMMARY_ROW_LABEL_CLASS}>{source.label}</span>
      </button>
    )
  }
  if (source.kind === 'link') {
    return (
      <a
        className={SUMMARY_ROW_CLASS}
        href={source.url}
        rel="noreferrer"
        target="_blank"
        title={source.url}
      >
        <Link2
          className={SUMMARY_ROW_ICON_CLASS}
          aria-hidden="true"
          size="var(--inline-icon-size, 1em)"
        />
        <span className={SUMMARY_ROW_LABEL_CLASS}>{source.label}</span>
      </a>
    )
  }
  const Icon = source.toolKind === 'web-search' ? Search : Plug
  return (
    <div
      className="thread-summary-static-row thread-summary-source-static tw:grid tw:w-full tw:min-w-0 tw:grid-cols-[16px_minmax(0,1fr)] tw:items-center tw:gap-2 tw:px-2 tw:text-app-text tw:type-2"
      title={source.source ?? source.label}
    >
      <Icon
        className={SUMMARY_ROW_ICON_CLASS}
        aria-hidden="true"
        size="var(--inline-icon-size, 1em)"
      />
      <span className={SUMMARY_ROW_LABEL_CLASS}>{source.label}</span>
    </div>
  )
}

function ArtifactRow({
  artifact,
  onOpen,
}: {
  artifact: ThreadSummaryArtifact
  onOpen?: (artifact: ThreadSummaryArtifact) => void
}): React.ReactNode {
  const previewable = threadSummaryArtifactPreviewKind(artifact.mimeType) !== 'binary'
  const meta = [
    artifact.mimeType,
    artifact.sizeBytes !== null ? formatByteSize(artifact.sizeBytes) : null,
    previewable ? null : '不支持预览',
  ]
    .filter(Boolean)
    .join(' · ')
  const row = (
    <>
      {artifact.previewKind === 'image' ? (
        <ImageIcon
          className={SUMMARY_ROW_ICON_CLASS}
          aria-hidden="true"
          size="var(--inline-icon-size, 1em)"
        />
      ) : (
        <Package
          className={SUMMARY_ROW_ICON_CLASS}
          aria-hidden="true"
          size="var(--inline-icon-size, 1em)"
        />
      )}
      <span className={SUMMARY_ROW_LABEL_CLASS}>{artifact.name}</span>
      <small
        className={cx(
          'tw:whitespace-nowrap tw:type-1',
          previewable ? 'tw:text-app-text-meta' : 'tw:text-app-text-disabled',
        )}
      >
        {meta}
      </small>
    </>
  )
  if (!previewable || !onOpen) {
    return (
      <div
        className="thread-summary-static-row tw:grid tw:w-full tw:min-w-0 tw:grid-cols-[16px_minmax(0,1fr)_max-content] tw:items-center tw:gap-2 tw:px-2 tw:text-app-text tw:type-2"
        title={`${artifact.name}：${meta}`}
      >
        {row}
      </div>
    )
  }
  return (
    <button
      className={SUMMARY_ROW_CLASS}
      title={`预览 ${artifact.name}`}
      type="button"
      onClick={() => onOpen(artifact)}
    >
      {row}
    </button>
  )
}

function ThreadSummarySourcesPanel({
  open,
  sources,
  onOpenAttachment,
  onOpenLocalContext,
  onOpenChange,
}: {
  open: boolean
  sources: ThreadSummaryViewModel['sources']
  onOpenAttachment?: (attachment: Attachment) => void
  onOpenLocalContext?: (reference: LocalContextReference) => void
  onOpenChange: (open: boolean) => void
}): React.ReactNode {
  const { onCloseAutoFocus } = useDialogFocusRestore(open)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-dialog-backdrop thread-summary-sources-overlay tw:fixed tw:inset-0 tw:z-modal" />
        <Dialog.Content
          className="ui-dialog-surface ui-dialog-surface--side-right thread-summary-sources-panel tw:fixed tw:top-3 tw:right-3 tw:bottom-3 tw:flex tw:w-[min(360px,calc(100vw-24px))] tw:flex-col tw:gap-3 tw:p-4 tw:text-app-text tw:outline-none"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <header className="tw:flex tw:items-center tw:justify-between tw:gap-3">
            <div className="tw:flex tw:min-w-0 tw:items-baseline tw:gap-2">
              <Dialog.Title className="tw:m-0 tw:type-2 tw:weight-medium">来源</Dialog.Title>
              <span className="tw:text-app-text-meta tw:type-1">{sources.length}</span>
            </div>
            <Dialog.Close asChild>
              <Button isIconOnly color="ghostSecondary" size="toolbar" title="关闭来源面板">
                <X className="tw:size-icon-md" aria-hidden="true" size={APP_ICON_SIZE} />
              </Button>
            </Dialog.Close>
          </header>
          <Dialog.Description className="tw:m-0 tw:text-app-text-meta tw:type-1">
            当前会话中已识别的附件、文件与网页来源。
          </Dialog.Description>
          <div
            className="thread-summary-sources-panel__list tw:grid tw:grid-cols-1 tw:min-h-0 tw:content-start tw:gap-1 tw:overflow-y-auto"
            role="list"
          >
            {sources.map((source) => (
              <ThreadSummarySourceRow
                key={source.identity}
                source={source}
                onOpenAttachment={onOpenAttachment}
                onOpenLocalContext={onOpenLocalContext}
              />
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ThreadSummarySection({
  children,
  collapsedSummary,
  expanded,
  first = false,
  id,
  meta,
  title,
  onToggle,
}: {
  children: React.ReactNode
  collapsedSummary?: React.ReactNode
  expanded: boolean
  first?: boolean
  id: ThreadSummarySectionId
  meta?: React.ReactNode
  title: string
  onToggle: (id: ThreadSummarySectionId) => void
}): React.ReactNode {
  const headingId = React.useId()
  const contentId = React.useId()
  return (
    <section
      aria-labelledby={headingId}
      className={
        first
          ? 'thread-summary-section thread-summary-section--first tw:relative tw:z-0 tw:flex tw:min-w-0 tw:flex-col tw:gap-1 tw:pb-2 tw:last:pb-0'
          : 'thread-summary-section tw:relative tw:z-0 tw:flex tw:min-w-0 tw:flex-col tw:pb-2 tw:last:pb-0'
      }
    >
      <header className="tw:sticky tw:top-0 tw:z-local tw:flex tw:h-6 tw:w-full tw:min-w-0 tw:items-center tw:justify-between tw:gap-2 tw:bg-transparent tw:px-2 tw:py-0 tw:text-app-text-soft tw:type-2 tw:weight-medium">
        <h2 className="tw:m-0 tw:text-inherit tw:[font:inherit]">
          <button
            aria-controls={contentId}
            aria-expanded={expanded}
            className="thread-summary-section__toggle tw:inline-flex tw:min-w-0 tw:items-center tw:gap-2 tw:rounded-3 tw:border-0 tw:bg-transparent tw:text-left tw:text-inherit tw:[font:inherit] tw:cursor-pointer tw:outline-none tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-app-focus"
            type="button"
            onClick={() => onToggle(id)}
          >
            <span
              className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap"
              id={headingId}
            >
              {title}
            </span>
            {!expanded ? collapsedSummary : null}
            <ChevronDown aria-hidden="true" size="var(--inline-icon-size, 1em)" />
          </button>
        </h2>
        <span className="thread-summary-section__actions tw:flex tw:min-w-0 tw:flex-1 tw:items-center tw:justify-end">
          {expanded || id === 'environment' ? meta : null}
        </span>
      </header>
      <DisclosureContent
        className="thread-summary-section__content tw:relative tw:z-0"
        contentClassName="thread-summary-section__rows tw:grid tw:grid-cols-1 tw:min-h-0 tw:gap-0 tw:overflow-hidden"
        expanded={expanded}
        id={contentId}
      >
        {children}
      </DisclosureContent>
    </section>
  )
}

function formatByteSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = sizeBytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
