import React, { useEffect, useMemo, useState } from 'react'
import { FolderOpen, RefreshCw, Save, Sparkles, Trash2 } from 'lucide-react'
import { SearchInput } from '../../components/ui/SearchInput.js'
import { desktopClient } from '../../services/desktop-client/index.js'
import { APP_ICON_SIZE } from '../../components/ui/IconTokens.js'
import type {
  DesktopMemoryNamespace,
  DesktopMemorySettings,
  DesktopMemoryTask,
  DesktopMemoryUsageRecord,
  DesktopProjectMemory,
  DesktopProjectMemoryContent,
} from '../../../shared/Types.js'
import { SettingsContentArea } from './SettingsContentArea.js'
import { SettingsDropdown } from './SettingsDropdown.js'
import { SettingsRow } from './SettingsRow.js'
import { SettingsSection } from './SettingsSection.js'
import { ToggleSwitch } from '../../components/ui/ToggleSwitch.js'
import { useDesktopSettingsField } from './UseDesktopSettings.js'
import { Button } from '../../components/ui/Button.js'
import { Input } from '../../components/ui/Input.js'

const MEMORY_TYPES = ['all', 'user', 'feedback', 'project', 'reference'] as const
type MemoryTypeFilter = (typeof MEMORY_TYPES)[number]

const MEMORY_TYPE_OPTIONS = MEMORY_TYPES.map((type) => ({
  value: type,
  label: type === 'all' ? '全部类型' : type,
}))

type ScopeKind = 'user' | 'project' | 'agent'

type Props = {
  workspacePath: string | null
}

const formatTime = (value: number | null) =>
  value === null ? '—' : new Date(value).toLocaleString()

type MemoryDiagnostic = { path: string; code: string; message: string }

export function MemorySettings({ workspacePath }: Props): React.ReactNode {
  const subscribedEnableMemory = useDesktopSettingsField((state) => state.draft.values.enableMemory)
  const subscribedSetValue = useDesktopSettingsField((state) => state.draft.setValue)
  const subscribedAutoSave = useDesktopSettingsField((state) => state.draft.autoSave)
  const normalizedWorkspacePath = workspacePath?.trim() ?? ''
  const hasWorkspace = normalizedWorkspacePath.length > 0
  const bridgeWorkspacePath = hasWorkspace ? normalizedWorkspacePath : null

  const [scopeKind, setScopeKind] = useState<ScopeKind>('user')
  const [agentKey, setAgentKey] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [settings, setSettings] = useState<DesktopMemorySettings | null>(null)
  const [memories, setMemories] = useState<DesktopProjectMemory[]>([])
  const [diagnostics, setDiagnostics] = useState<MemoryDiagnostic[]>([])
  const [usage, setUsage] = useState<DesktopMemoryUsageRecord[]>([])
  const [tasks, setTasks] = useState<DesktopMemoryTask[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedMemory, setSelectedMemory] = useState<DesktopProjectMemoryContent | null>(null)
  const [draftContent, setDraftContent] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<MemoryTypeFilter>('all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const namespace = useMemo<DesktopMemoryNamespace | null>(() => {
    if (scopeKind === 'user') return { kind: 'user' }
    if (!projectId) return null
    if (scopeKind === 'project') return { kind: 'project', projectId }
    const key = agentKey.trim()
    return key ? { kind: 'agent', projectId, memoryKey: key } : null
  }, [scopeKind, projectId, agentKey])

  const filteredMemories = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return memories.filter((memory) => {
      if (typeFilter !== 'all' && memory.type !== typeFilter) return false
      if (!normalizedQuery) return true
      return (
        memory.relativePath.toLowerCase().includes(normalizedQuery) ||
        (memory.description ?? '').toLowerCase().includes(normalizedQuery)
      )
    })
  }, [memories, query, typeFilter])

  // Project identity comes from the Agent (it resolves the workspace to a
  // project); the renderer never derives a memory namespace from a path.
  useEffect(() => {
    setProjectId(null)
    if (!hasWorkspace) return
    let cancelled = false
    void desktopClient
      .listProjectMemories(normalizedWorkspacePath)
      .then((listing) => {
        if (!cancelled && listing.namespace.kind !== 'user')
          setProjectId(listing.namespace.projectId)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [hasWorkspace, normalizedWorkspacePath])

  const refresh = async (): Promise<void> => {
    if (!namespace) return
    setBusy(true)
    setError(null)
    try {
      const [listing, usageRecords, taskState, memorySettings] = await Promise.all([
        desktopClient.listProjectMemories(bridgeWorkspacePath, namespace),
        desktopClient.listMemoryUsage(bridgeWorkspacePath, namespace),
        desktopClient.listMemoryTasks(bridgeWorkspacePath, namespace),
        desktopClient.readMemorySettings(bridgeWorkspacePath, namespace),
      ])
      setMemories(listing.memories)
      setDiagnostics([...listing.diagnostics])
      setUsage(usageRecords)
      setTasks(taskState.tasks)
      setSettings(memorySettings)
      if (selectedPath) {
        const stillExists = listing.memories.some((memory) => memory.relativePath === selectedPath)
        if (!stillExists) {
          setSelectedPath(null)
          setSelectedMemory(null)
          setDraftContent(null)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
    // Refresh closes over selection state and is re-run per namespace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace === null ? '' : JSON.stringify(namespace), bridgeWorkspacePath])

  const openMemory = async (relativePath: string): Promise<void> => {
    if (!namespace) return
    setSelectedPath(relativePath)
    setBusy(true)
    setError(null)
    try {
      setSelectedMemory(
        await desktopClient.readProjectMemory(bridgeWorkspacePath, relativePath, namespace),
      )
      setDraftContent(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const saveSelected = async (): Promise<void> => {
    if (!namespace || !selectedMemory || draftContent === null) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const saved = await desktopClient.saveProjectMemory({
        workspacePath: normalizedWorkspacePath,
        relativePath: selectedMemory.relativePath,
        content: draftContent,
        expectedRevision: selectedMemory.revision,
        namespace,
      })
      setSelectedMemory({ ...selectedMemory, ...saved, content: draftContent })
      setDraftContent(null)
      await refresh()
    } catch (err) {
      // A conflict keeps the user's draft so nothing typed is lost.
      setError(err instanceof Error ? err.message : String(err))
      setNotice('保存失败：草稿已保留，请重新读取后对比再保存。')
    } finally {
      setBusy(false)
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (!namespace || !selectedMemory) return
    if (!window.confirm(`删除记忆 ${selectedMemory.relativePath}？`)) return
    setBusy(true)
    setError(null)
    try {
      await desktopClient.deleteProjectMemory({
        workspacePath: normalizedWorkspacePath,
        relativePath: selectedMemory.relativePath,
        expectedRevision: selectedMemory.revision,
        namespace,
      })
      setSelectedPath(null)
      setSelectedMemory(null)
      setDraftContent(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const resetMemories = async (): Promise<void> => {
    if (!namespace) return
    if (!window.confirm('删除此范围内由 Pidex 管理的记忆文件？未知文件会保留。')) return
    setBusy(true)
    setError(null)
    try {
      await desktopClient.resetProjectMemory({
        workspacePath: normalizedWorkspacePath,
        namespace,
      })
      setSelectedPath(null)
      setSelectedMemory(null)
      setDraftContent(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const organize = async (): Promise<void> => {
    if (!namespace) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await desktopClient.organizeMemory({
        workspacePath: bridgeWorkspacePath,
        namespace,
      })
      setNotice(result.queued ? '整理任务已排队，前台任务结束后执行。' : '没有可执行的整理任务。')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleAutoOrganize = async (enabled: boolean): Promise<void> => {
    if (!namespace) return
    setBusy(true)
    try {
      setSettings(
        await desktopClient.saveMemorySettings({
          workspacePath: bridgeWorkspacePath,
          namespace,
          autoOrganize: enabled,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const scopeOptions = [
    { value: 'user', label: '用户记忆' },
    ...(hasWorkspace
      ? [
          { value: 'project', label: '当前项目' },
          { value: 'agent', label: '命名 Agent' },
        ]
      : []),
  ]

  return (
    <SettingsContentArea className="memory-settings-page">
      <div className="settings-content-inner tw:@container tw:w-full tw:min-w-0 tw:mx-auto tw:p-5 tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-5)*2)]">
        <div className="settings-page-header tw:mt-0 tw:mx-0 tw:mb-8 tw:grid tw:gap-2">
          <h2 className="settings-page-title tw:m-0 tw:type-page-title tw:text-app-text">记忆</h2>
          <p className="settings-page-desc tw:m-0 tw:max-w-[68ch] tw:text-app-text-soft tw:type-body-sm">
            Markdown 文件是唯一正文来源。模型维护索引、按需读取正文，后台负责增量提取与低频整理。
          </p>
        </div>

        <SettingsSection title="记忆状态">
          <SettingsRow
            title="启用记忆"
            description="新会话会注入索引，并在相关时读取正文"
            autoSave
            control={
              <ToggleSwitch
                ariaLabel="启用记忆"
                checked={subscribedEnableMemory}
                onChange={(value) => {
                  subscribedSetValue('enableMemory', value)
                  subscribedAutoSave()
                }}
              />
            }
          />
          <SettingsRow
            title="范围"
            description="用户、当前项目与命名 Agent 是三个独立命名空间"
            control={
              <SettingsDropdown
                ariaLabel="记忆范围"
                options={scopeOptions}
                showSelectedIndicator
                triggerClassName="memory-settings-filter tw:w-auto tw:min-w-0 tw:px-2 tw:py-1"
                value={scopeKind}
                size="sm"
                onChange={(value) => setScopeKind(value as ScopeKind)}
              />
            }
          />
          {scopeKind === 'agent' ? (
            <SettingsRow
              title="Agent 名称"
              description="1–64 位 ASCII 字母、数字、下划线或连字符；同一项目内复用"
              control={
                <Input
                  aria-label="命名 Agent memoryKey"
                  value={agentKey}
                  onChange={(event) => setAgentKey(event.target.value)}
                  placeholder="reviewer"
                />
              }
            />
          ) : null}
          <SettingsRow
            title="记忆目录"
            description={settings?.memoryDir || '未配置'}
            control={
              <Button
                color="secondary"
                disabled={busy || !settings?.memoryDir}
                onClick={() => {
                  const directory = settings?.memoryDir
                  if (!directory) return
                  void desktopClient
                    .openPathWithDefaultTarget(directory)
                    .catch((err: unknown) =>
                      setError(err instanceof Error ? err.message : String(err)),
                    )
                }}
                type="button"
              >
                <FolderOpen size={APP_ICON_SIZE} />
                打开目录
              </Button>
            }
          />
          <SettingsRow
            title="自动整理"
            description="空闲且距上次成功整理满 24 小时、累计 5 个聊天后最多每天一次"
            control={
              <ToggleSwitch
                ariaLabel="自动整理"
                checked={settings?.autoOrganize ?? true}
                onChange={(value) => void toggleAutoOrganize(value)}
              />
            }
          />
        </SettingsSection>

        <SettingsSection
          title="记忆文件"
          actions={
            <div className="settings-inline-actions tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2 tw:max-[900px]:justify-start">
              <Button
                color="secondary"
                disabled={busy || !namespace}
                onClick={() => void refresh()}
                type="button"
              >
                <RefreshCw size={APP_ICON_SIZE} />
                刷新
              </Button>
              <Button
                color="secondary"
                disabled={busy || !namespace}
                onClick={() => void organize()}
                type="button"
              >
                <Sparkles size={APP_ICON_SIZE} />
                立即整理
              </Button>
              <Button
                color="danger"
                disabled={busy || !namespace}
                onClick={() => void resetMemories()}
                type="button"
              >
                重置此范围
              </Button>
            </div>
          }
        >
          {!namespace ? (
            <div className="settings-empty-state tw:m-0 tw:p-5 tw:text-app-text-soft tw:type-body-sm">
              {hasWorkspace
                ? '正在解析当前项目，或为命名 Agent 填写名称。'
                : '无项目时仍可管理用户记忆；请切换到「用户记忆」范围。'}
            </div>
          ) : (
            <>
              <div className="memory-settings-toolbar tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:px-3 tw:pt-3">
                <SearchInput
                  aria-label="搜索记忆文件"
                  className="memory-settings-search tw:max-w-80 tw:min-w-40 tw:flex-1"
                  value={query}
                  onChange={setQuery}
                  placeholder="搜索文件名或描述"
                />
                <SettingsDropdown
                  ariaLabel="记忆类型"
                  options={MEMORY_TYPE_OPTIONS}
                  showSelectedIndicator
                  triggerClassName="memory-settings-filter tw:w-auto tw:min-w-0 tw:px-2 tw:py-1"
                  value={typeFilter}
                  size="sm"
                  onChange={(value) => setTypeFilter(value as MemoryTypeFilter)}
                />
                <span className="memory-settings-count tw:ml-auto tw:text-app-text-soft tw:type-caption tw:whitespace-nowrap">
                  {filteredMemories.length} 个文件
                </span>
              </div>
              {error ? <p className="settings-row-error">{error}</p> : null}
              {notice ? (
                <p className="settings-row-description tw:m-0 tw:px-3 tw:text-app-text-soft tw:type-body-sm">
                  {notice}
                </p>
              ) : null}
              {diagnostics.length > 0 ? (
                <div className="settings-row-description tw:grid tw:gap-1 tw:px-3 tw:text-app-text-soft tw:type-body-sm">
                  {diagnostics.map((item) => (
                    <span key={`${item.path}-${item.code}`}>
                      {item.path}：{item.message}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="memory-settings-grid tw:grid tw:min-h-120 tw:grid-cols-[minmax(260px,1fr)_minmax(380px,1.6fr)] tw:gap-3 tw:p-3">
                <div className="memory-settings-panel tw:flex tw:min-h-0 tw:flex-col tw:overflow-hidden tw:rounded-lg tw:border tw:border-app-border tw:bg-app-panel tw:shadow-none">
                  <div className="memory-settings-panel-header tw:flex tw:shrink-0 tw:items-center tw:gap-2 tw:border-b tw:border-b-app-border tw:bg-app-raised tw:px-3 tw:py-2 tw:text-app-text-soft tw:type-row-title tw:select-none">
                    <span>记忆列表</span>
                  </div>
                  <div className="memory-settings-list-scroll-area tw:min-h-0 tw:flex-1 tw:overflow-x-hidden tw:overflow-y-auto">
                    <div className="memory-settings-list-scroll-content tw:min-w-0">
                      {filteredMemories.map((memory) => (
                        <button
                          key={memory.relativePath}
                          className={
                            selectedPath === memory.relativePath
                              ? 'memory-settings-item active tw:border-b-app-border-strong tw:bg-app-selected'
                              : 'memory-settings-item tw:hover:bg-app-hover'
                          }
                          onClick={() => void openMemory(memory.relativePath)}
                          type="button"
                        >
                          <span className="memory-settings-item-name tw:truncate tw:text-app-text tw:type-row-title">
                            {memory.relativePath}
                          </span>
                          <span className="memory-settings-item-meta tw:flex tw:min-w-0 tw:items-center tw:gap-2">
                            <span className="memory-settings-item-type tw:inline-flex tw:shrink-0 tw:items-center tw:rounded-full tw:bg-app-hover tw:px-2 tw:py-1 tw:text-app-text-meta tw:type-caption">
                              {memory.type ?? 'unknown'}
                            </span>
                            <span className="memory-settings-item-desc tw:min-w-0 tw:truncate tw:text-app-text-soft tw:type-body-sm">
                              {memory.description ?? '无描述'}
                            </span>
                            {memory.indexed === false ? (
                              <span className="tw:shrink-0 tw:text-app-text-meta tw:type-caption">
                                未索引
                              </span>
                            ) : null}
                          </span>
                        </button>
                      ))}
                      {filteredMemories.length === 0 ? (
                        <div className="settings-empty-state tw:m-0 tw:p-5 tw:text-app-text-soft tw:type-body-sm">
                          暂无记忆文件
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="memory-settings-panel tw:flex tw:min-h-0 tw:flex-col tw:overflow-hidden tw:rounded-lg tw:border tw:border-app-border tw:bg-app-panel tw:shadow-none">
                  <div className="memory-settings-panel-header memory-settings-panel-header-editor tw:flex tw:flex-wrap tw:shrink-0 tw:items-center tw:gap-2 tw:border-b tw:border-b-app-border tw:bg-app-raised tw:px-3 tw:py-2 tw:text-app-text-soft tw:type-row-title tw:select-none">
                    <span className="memory-settings-editor-title tw:min-w-0 tw:flex-1 tw:truncate tw:text-app-text tw:type-row-title">
                      {selectedMemory ? selectedMemory.relativePath : '内容编辑'}
                    </span>
                    {selectedMemory ? (
                      <div className="memory-settings-editor-actions tw:flex tw:shrink-0 tw:items-center tw:gap-2">
                        <Button
                          color="primary"
                          disabled={busy || draftContent === null}
                          onClick={() => void saveSelected()}
                          type="button"
                        >
                          <Save size={APP_ICON_SIZE} />
                          保存
                        </Button>
                        <Button
                          color="danger"
                          disabled={busy}
                          onClick={() => void deleteSelected()}
                          type="button"
                        >
                          <Trash2 size={APP_ICON_SIZE} />
                          删除
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="memory-settings-editor-scroll-area tw:min-h-0 tw:flex-1 tw:overflow-hidden">
                    <div className="memory-settings-editor-scroll-content tw:flex tw:min-w-0 tw:h-full tw:flex-col">
                      {selectedMemory ? (
                        <textarea
                          className="settings-textarea memory-settings-editor-textarea tw:block tw:w-full tw:min-h-80 tw:flex-1 tw:resize-y tw:box-border tw:rounded-md tw:border tw:border-app-border-subtle tw:bg-app-canvas tw:p-3 tw:text-app-text tw:type-code tw:m-0 tw:outline-none tw:focus:border-app-accent-border"
                          value={draftContent ?? selectedMemory.content}
                          onChange={(event) => setDraftContent(event.target.value)}
                        />
                      ) : (
                        <div className="settings-empty-state tw:m-0 tw:p-5 tw:text-app-text-soft tw:type-body-sm">
                          选择一个记忆文件查看内容
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </SettingsSection>

        <SettingsSection title="后台任务">
          {tasks.length === 0 ? (
            <div className="settings-empty-state tw:m-0 tw:p-5 tw:text-app-text-soft tw:type-body-sm">
              暂无任务记录
            </div>
          ) : (
            <div className="memory-recall-list-scroll-content tw:min-w-0">
              {tasks.map((task) => (
                <article
                  className="memory-recall-item tw:grid tw:gap-1 tw:border-b tw:border-b-app-border tw:px-4 tw:py-3 tw:last:border-b-0"
                  key={task.id}
                >
                  <span className="memory-recall-time tw:text-app-text tw:type-label">
                    {task.kind === 'organize' ? '整理' : '提取'} · {task.status} · {task.trigger}
                  </span>
                  <span className="memory-recall-files tw:truncate tw:text-app-text-soft tw:type-caption">
                    {formatTime(task.finishedAt ?? task.startedAt ?? task.createdAt)}
                    {task.error ? ` · ${task.error}` : ''}
                  </span>
                </article>
              ))}
            </div>
          )}
        </SettingsSection>

        <SettingsSection title="使用时间线">
          <div className="memory-recall-list-scroll-area tw:max-h-90 tw:min-h-0 tw:overflow-x-hidden tw:overflow-y-auto">
            <div className="memory-recall-list-scroll-content tw:min-w-0">
              {usage.length === 0 ? (
                <div className="settings-empty-state tw:m-0 tw:p-5 tw:text-app-text-soft tw:type-body-sm">
                  暂无使用记录
                </div>
              ) : (
                usage.map((record) => (
                  <article
                    className="memory-recall-item tw:grid tw:gap-1 tw:border-b tw:border-b-app-border tw:px-4 tw:py-3 tw:last:border-b-0"
                    key={record.id}
                  >
                    <span className="memory-recall-time tw:text-app-text tw:type-label">
                      {formatTime(record.createdAt)} ·{' '}
                      {record.kind === 'index' ? '索引注入' : '正文读取'}
                    </span>
                    <span className="memory-recall-files tw:truncate tw:text-app-text-soft tw:type-caption">
                      {record.relativePath ?? '—'} · {record.bytes} 字节
                      {record.truncated ? ' (截断)' : ''}
                      {record.threadId ? ` · 会话 ${record.threadId}` : ''}
                    </span>
                  </article>
                ))
              )}
            </div>
          </div>
        </SettingsSection>
      </div>
    </SettingsContentArea>
  )
}
