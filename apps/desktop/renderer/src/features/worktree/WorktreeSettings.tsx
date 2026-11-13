import React from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, MessageSquarePlus, RefreshCw, Trash2 } from 'lucide-react'
import type { ManagedWorktree, RpcResult } from '@pidex/agent-protocol'
import { Button } from '../../components/ui/Button.js'
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog.js'
import { Tooltip } from '../../components/ui/Tooltip.js'
import { APP_ICON_SIZE } from '../../components/ui/IconTokens.js'
import { environmentDomainClient } from '../../services/desktop-client/EnvironmentDomainClient.js'
import { desktopClient } from '../../services/desktop-client/index.js'
import { SettingsContentArea } from '../settings/SettingsContentArea.js'
import { SettingsSection } from '../settings/SettingsSection.js'
import {
  useDesktopSettingsDraftActions,
  useDesktopSettingsDraftValue,
} from '../settings/UseDesktopSettings.js'
import type { DesktopWorkspace } from '../../../shared/Types.js'
import { WorktreePreferences } from './WorktreePreferences.js'

type Props = { onError: (message: string) => void; onNotice?: (message: string) => void }
type Mutation = { operation: RpcResult<'worktree/create'>['operation']; worktree: ManagedWorktree }
type MutationOutcome =
  { kind: 'mutation'; value: Mutation } | { kind: 'mutation-error'; error: unknown }

type WorktreeEntry = RpcResult<'worktree/settings/list'>['worktrees'][number]

export function WorktreeSettings({ onError, onNotice }: Props): React.ReactNode {
  const navigate = useNavigate()
  const client = React.useMemo(() => environmentDomainClient(), [])
  const draftActions = useDesktopSettingsDraftActions()
  const gitConfirmDeleteWorktree = useDesktopSettingsDraftValue('gitConfirmDeleteWorktree')

  const [entries, setEntries] = React.useState<readonly WorktreeEntry[]>([])
  const [projects, setProjects] = React.useState<readonly DesktopWorkspace[]>([])
  const [busy, setBusy] = React.useState(false)
  const [operation, setOperation] = React.useState<Mutation['operation'] | null>(null)
  const [output, setOutput] = React.useState('')

  // 待删除工作树状态与确认弹窗
  const [deletingTarget, setDeletingTarget] = React.useState<{ id: string; path: string } | null>(
    null,
  )
  const [dontAskAgain, setDontAskAgain] = React.useState(false)

  // 仓库折叠状态，key 为 projectId
  const [collapsedGroups, setCollapsedGroups] = React.useState<Record<string, boolean>>({})
  // 展开关联聊天的卡片集合，key 为 worktreeId
  const [expandedThreads, setExpandedThreads] = React.useState<Record<string, boolean>>({})

  const mutationActive = React.useRef(false)

  React.useEffect(() => {
    void desktopClient
      .listProjects()
      .then(setProjects)
      .catch((cause) => onError(message(cause)))
  }, [onError])

  const refresh = React.useCallback(async () => {
    const result = await client.listWorktreeSettings(undefined)
    setEntries(result.worktrees)
  }, [client])

  React.useEffect(() => {
    void refresh().catch((cause) => onError(message(cause)))
  }, [onError, refresh])

  const track = async (operationId: string, mutationPromise: Promise<Mutation>) => {
    setOutput('')
    let cursor = 0
    let current: Mutation['operation'] | null = null
    const mutationOutcome: Promise<MutationOutcome> = mutationPromise.then(
      (value) => ({ kind: 'mutation', value }),
      (error) => ({ kind: 'mutation-error', error }),
    )
    let mutationPending = true
    while (!current || current.status === 'pending' || current.status === 'running') {
      const statusOutcome = client.worktreeOperationStatus(operationId, cursor).then(
        (value) => ({ kind: 'status' as const, value }),
        (error) => ({ kind: 'status-error' as const, error }),
      )
      const outcome = mutationPending
        ? await Promise.race([mutationOutcome, statusOutcome])
        : await statusOutcome
      if (outcome.kind === 'mutation-error') throw outcome.error
      if (outcome.kind === 'mutation') {
        mutationPending = false
        current = outcome.value.operation
        setOperation(current)
        if (current.status !== 'pending' && current.status !== 'running') break
        continue
      }
      if (outcome.kind === 'status') {
        current = outcome.value.operation
        cursor = outcome.value.output.cursor
        setOperation(current)
        if (outcome.value.output.data)
          setOutput((previous) => `${previous}${outcome.value.output.data}`.slice(-65_536))
      } else if (current) throw outcome.error
      const settled = mutationPending
        ? await Promise.race([
            mutationOutcome,
            new Promise<{ kind: 'retry' }>((resolve) =>
              setTimeout(() => resolve({ kind: 'retry' }), 100),
            ),
          ])
        : { kind: 'retry' as const }
      if (settled.kind === 'mutation-error') throw settled.error
      if (settled.kind === 'mutation') {
        mutationPending = false
        current = settled.value.operation
        setOperation(current)
        if (current.status !== 'pending' && current.status !== 'running') break
      }
    }
    if (mutationPending) {
      const settled = await mutationOutcome
      if (settled.kind === 'mutation-error') throw settled.error
      current = settled.value.operation
      setOperation(current)
    }
    try {
      const finalStatus = await client.worktreeOperationStatus(operationId, cursor)
      current = finalStatus.operation
      setOperation(current)
      if (finalStatus.output.data)
        setOutput((previous) => `${previous}${finalStatus.output.data}`.slice(-65_536))
    } catch {
      // Mutation result remains authoritative when volatile output tail is unavailable.
    }
    await refresh()
    if (current.status === 'failed') throw new Error(current.errorCode ?? 'Worktree 操作失败')
    onNotice?.(
      current.warnings.length
        ? `Worktree 操作已完成；${current.warnings.join('；')}`
        : 'Worktree 操作已完成。',
    )
  }

  const mutate = async (action: (operationId: string) => Promise<Mutation>) => {
    if (mutationActive.current) return
    mutationActive.current = true
    setBusy(true)
    const operationId = crypto.randomUUID()
    try {
      await track(operationId, action(operationId))
    } catch (cause) {
      onError(message(cause))
    } finally {
      mutationActive.current = false
      setBusy(false)
      await refresh().catch((cause) => onError(message(cause)))
    }
  }

  const handleDeleteRequest = (entry: WorktreeEntry) => {
    if (gitConfirmDeleteWorktree) {
      setDeletingTarget({ id: entry.worktree.id, path: entry.path })
      setDontAskAgain(false)
    } else {
      void mutate((operationId) => client.deleteWorktreeFromSettings(entry.worktree.id, operationId))
    }
  }

  const confirmDelete = () => {
    const target = deletingTarget
    setDeletingTarget(null)
    if (!target) return

    if (dontAskAgain) {
      draftActions.setValue('gitConfirmDeleteWorktree', false)
      void draftActions.saveFields(['gitConfirmDeleteWorktree']).catch(() => {})
    }

    void mutate((operationId) => client.deleteWorktreeFromSettings(target.id, operationId))
  }

  // 过滤掉已彻底清理(cleaned)的工作树
  const activeEntries = entries.filter((entry) => entry.worktree.status !== 'cleaned')

  // 按 projectId 分组
  const groupedProjects = React.useMemo(() => {
    const groups = new Map<string, WorktreeEntry[]>()
    for (const entry of activeEntries) {
      const key = entry.worktree.projectId || '__unknown__'
      const list = groups.get(key)
      if (list) list.push(entry)
      else groups.set(key, [entry])
    }
    return Array.from(groups.entries())
  }, [activeEntries])

  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }))
  }

  const toggleThreads = (worktreeId: string) => {
    setExpandedThreads((prev) => ({ ...prev, [worktreeId]: !prev[worktreeId] }))
  }

  return (
    <SettingsContentArea>
      <div className="settings-content-inner tw:w-full tw:min-w-0 tw:mx-auto tw:p-5 tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-5)*2)]">
        <h2 className="tw:m-0 tw:mb-6 tw:type-title-xl tw:text-app-text">Worktrees</h2>

        {/* 顶部偏好设置卡片 */}
        <WorktreePreferences onError={onError} />

        {/* 托管的工作树区域 */}
        <div className="tw:mt-8">
          <div className="tw:flex tw:items-center tw:justify-between tw:mb-3">
            <h3 className="settings-section-title tw:m-0 tw:text-app-text tw:type-row-title">
              托管的工作树
            </h3>
            <Tooltip content="刷新工作树列表" side="top">
              <Button
                isIconOnly
                color="ghostSecondary"
                size="toolbar"
                disabled={busy}
                aria-label="刷新工作树列表"
                onClick={() => void refresh().catch((cause) => onError(message(cause)))}
              >
                <RefreshCw size={APP_ICON_SIZE} className={busy ? 'tw:animate-spin' : ''} />
              </Button>
            </Tooltip>
          </div>

          <div className="tw:grid tw:gap-3">
            {groupedProjects.length ? (
              groupedProjects.map(([groupKey, groupEntries]) => {
                const project = projects.find((p) => p.projectId === groupKey)
                const groupName =
                  groupKey === '__unknown__'
                    ? '未知代码仓库'
                    : project?.name || groupKey || '未知代码仓库'
                const isCollapsed = collapsedGroups[groupKey] === true

                return (
                  <section
                    key={groupKey}
                    className="tw:overflow-hidden tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel/60"
                  >
                    <button
                      type="button"
                      className="tw:flex tw:w-full tw:items-center tw:justify-between tw:px-3 tw:py-2 tw:text-left tw:bg-transparent tw:border-none tw:cursor-pointer tw:hover:bg-app-hover/40 tw:transition-colors"
                      onClick={() => toggleGroup(groupKey)}
                    >
                      <span className="tw:type-row-title tw:text-app-text">
                        {groupName}
                      </span>
                      <span className="tw:flex tw:items-center tw:gap-1.5 tw:type-caption tw:text-app-text-soft">
                        {groupEntries.length} 个工作树
                        {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                      </span>
                    </button>

                    {!isCollapsed ? (
                      <div className="tw:border-t tw:border-app-border-subtle">
                        {groupEntries.map((entry, index) => {
                          const { worktree, path, conversations } = entry
                          const hasSingleChat = conversations.length === 1
                          const singleConversation = hasSingleChat ? conversations[0] : undefined
                          const title = hasSingleChat
                            ? singleConversation?.title || '无标题聊天'
                            : worktree.branchName || 'Detached worktree'
                          const isThreadsOpen = expandedThreads[worktree.id] === true

                          return (
                            <div
                              key={worktree.id}
                              className={`tw:flex tw:items-center tw:justify-between tw:gap-3 tw:px-3 tw:py-2 ${
                                index > 0 ? 'tw:border-t tw:border-app-border-subtle' : ''
                              }`}
                            >
                              <div className="tw:min-w-0 tw:flex-1 tw:grid tw:gap-1">
                                <div className="tw:flex tw:items-center tw:gap-2 tw:flex-wrap">
                                  {singleConversation ? (
                                    <a
                                      className="tw:min-w-0 tw:max-w-full tw:type-row-title tw:text-app-text tw:truncate tw:no-underline tw:cursor-pointer tw:rounded-sm tw:transition-colors tw:hover:text-app-accent-fg tw:hover:underline tw:focus-visible:outline-app-focus"
                                      href={'/threads/' + encodeURIComponent(singleConversation.id)}
                                      onClick={(event) => {
                                        event.preventDefault()
                                        navigate(
                                          '/threads/' + encodeURIComponent(singleConversation.id),
                                        )
                                      }}
                                    >
                                      {title}
                                    </a>
                                  ) : (
                                    <strong className="tw:type-row-title tw:text-app-text tw:truncate">
                                      {title}
                                    </strong>
                                  )}
                                  {!hasSingleChat && conversations.length > 0 ? (
                                    <button
                                      type="button"
                                      className="tw:inline-flex tw:items-center tw:gap-1 tw:type-caption tw:text-app-text-soft tw:bg-transparent tw:hover:text-app-text tw:p-0 tw:border-none tw:cursor-pointer tw:transition-colors"
                                      onClick={() => toggleThreads(worktree.id)}
                                    >
                                      {conversations.length} 个关联聊天
                                      <ChevronDown
                                        size={14}
                                        className={`tw:transition-transform tw:duration-150 ${
                                          isThreadsOpen ? 'tw:rotate-180' : ''
                                        }`}
                                      />
                                    </button>
                                  ) : null}
                                </div>

                                <p className="tw:m-0 tw:type-caption tw:text-app-text-meta tw:font-mono tw:truncate">
                                  {path}
                                </p>

                                {worktree.status === 'restore-conflict' ? (
                                  <p className="tw:m-0 tw:type-caption tw:text-app-danger">
                                    恢复冲突，已保留工作树和快照，请手动处理
                                  </p>
                                ) : null}

                                {/* 展开的关联聊天列表 */}
                                {isThreadsOpen && conversations.length > 0 ? (
                                  <div className="tw:grid tw:gap-1 tw:mt-1.5 tw:pt-2 tw:border-t tw:border-app-border-subtle/50">
                                    {conversations.map((thread) => (
                                      <a
                                        key={thread.id}
                                        className="tw:type-caption tw:text-app-text-soft tw:truncate tw:rounded-item tw:px-2 tw:py-1 tw:hover:bg-app-hover tw:hover:text-app-text tw:focus-visible:outline-app-focus"
                                        href={'/threads/' + thread.id}
                                        onClick={(event) => {
                                          event.preventDefault()
                                          navigate('/threads/' + thread.id)
                                        }}
                                      >
                                        {thread.title || '无标题聊天'}
                                        {thread.archived ? ' · 已归档' : ''}
                                        {thread.pinned ? ' · 已置顶' : ''}
                                      </a>
                                    ))}
                                  </div>
                                ) : null}
                              </div>

                              <div className="tw:flex tw:items-center tw:gap-1.5 tw:shrink-0">
                                <Tooltip content="在此工作树中新建聊天" side="top">
                                  <Button
                                    isIconOnly
                                    color="ghostSecondary"
                                    size="toolbar"
                                    disabled={
                                      busy ||
                                      !['ready', 'ready-with-setup-error'].includes(worktree.status)
                                    }
                                    aria-label="在此工作树中新建聊天"
                                    onClick={() => {
                                      if (mutationActive.current) return
                                      mutationActive.current = true
                                      setBusy(true)
                                      void client
                                        .newChatInWorktree(worktree.id)
                                        .then(({ threadId }) =>
                                          navigate('/threads/' + encodeURIComponent(threadId)),
                                        )
                                        .catch((cause) => onError(message(cause)))
                                        .finally(() => {
                                          mutationActive.current = false
                                          setBusy(false)
                                        })
                                    }}
                                  >
                                    <MessageSquarePlus size={APP_ICON_SIZE} />
                                  </Button>
                                </Tooltip>
                                <Tooltip content="删除工作树" side="top">
                                  <Button
                                    isIconOnly
                                    color="ghostSecondary"
                                    size="toolbar"
                                    className="tw:hover:text-app-danger"
                                    disabled={
                                      busy ||
                                      worktree.pinned ||
                                      conversations.some((thread) => thread.active || thread.pinned)
                                    }
                                    aria-label="删除工作树"
                                    onClick={() => handleDeleteRequest(entry)}
                                  >
                                    <Trash2 size={APP_ICON_SIZE} />
                                  </Button>
                                </Tooltip>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : null}
                  </section>
                )
              })
            ) : (
              <p className="settings-empty-copy tw:text-app-text-soft tw:py-4">
                暂无托管工作树。
              </p>
            )}
          </div>
        </div>

        {/* 操作输出 */}
        {operation ? (
          <div className="tw:mt-8">
            <SettingsSection
              title="操作进度"
              description={`${operation.kind} · ${operation.step} · ${operation.status}`}
            >
              {operation.warnings.length ? (
                <ul
                  className="tw:type-caption tw:grid tw:gap-1 tw:px-3 tw:pt-3 tw:text-app-text-soft"
                  role="status"
                >
                  {operation.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              <pre className="tw:type-code tw:max-h-64 tw:overflow-auto tw:whitespace-pre-wrap tw:p-3">
                {output || '等待输出…'}
              </pre>
            </SettingsSection>
          </div>
        ) : null}

        {/* 删除工作树确认对话框（对齐设计截图 2） */}
        <ConfirmationDialog
          open={deletingTarget !== null}
          title="要删除此工作树吗？"
          description={
            <div className="tw:grid tw:gap-3">
              <p className="tw:m-0 tw:text-app-text-soft tw:type-body-sm">
                此工作树中有尚未提交的更改，删除后可能会丢失。删除工作树会移除其中的文件，并归档以其作为工作空间的聊天。
              </p>
              <pre className="tw:m-0 tw:rounded-control tw:bg-app-control tw:p-2.5 tw:font-mono tw:type-caption tw:text-app-text tw:break-all tw:whitespace-pre-wrap">
                {deletingTarget?.path}
              </pre>
            </div>
          }
          actionLabel="删除工作树"
          tone="danger"
          actionDisabled={busy}
          suppression={{
            checked: dontAskAgain,
            label: '不再询问',
            onCheckedChange: setDontAskAgain,
          }}
          onCancel={() => {
            if (!busy) setDeletingTarget(null)
          }}
          onAction={confirmDelete}
        />
      </div>
    </SettingsContentArea>
  )
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Worktree 操作失败。'
}
