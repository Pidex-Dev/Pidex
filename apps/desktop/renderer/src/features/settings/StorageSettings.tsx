import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import type { StorageSummaryResult } from '@pidex/agent-protocol'
import type { DesktopUserDataStorageSummary } from '@pidex/shared/desktop-shell-ipc'
import { errorMessageOf } from '@pidex/shared/errors'
import { desktopClient } from '../../services/desktop-client/index.js'
import { Button } from '../../components/ui/Button.js'
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog.js'
import { SettingsContentArea } from './SettingsContentArea.js'
import { SettingsSection } from './SettingsSection.js'
import { SettingsRow } from './SettingsRow.js'
import { createSettingsTargetId } from './SettingsRegistry.js'
import { formatStorageBytes } from './StorageFormatting.js'
import { OldChatsCleanupDialog } from './OldChatsCleanupDialog.js'

type Props = {
  onError: (message: string) => void
  onNotice?: (message: string) => void
}

type CategorySegment = {
  key: string
  label: string
  bytes: number
  color: string
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const parent = normalize(parentPath)
  const child = normalize(childPath)
  return child === parent || child.startsWith(`${parent}/`)
}

const STORAGE_SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000

type DownloadedResourceEntry = {
  id: string
  name: string
  category: 'speech' | 'tooling' | 'font' | 'runtime'
  description: string
  path: string
  sizeBytes: number
  source: 'agent' | 'userdata'
}

type CachedStorageSummary = {
  summary: StorageSummaryResult
  userDataSummary: DesktopUserDataStorageSummary
  resources: DownloadedResourceEntry[]
  fetchedAt: number
}

let cachedStorageSummary: CachedStorageSummary | null = null
let inflightStorageSummary: Promise<CachedStorageSummary> | null = null

function getValidCachedStorageSummary(): CachedStorageSummary | null {
  if (!cachedStorageSummary) return null
  if (Date.now() - cachedStorageSummary.fetchedAt >= STORAGE_SUMMARY_CACHE_TTL_MS) {
    return null
  }
  return cachedStorageSummary
}

async function fetchStorageSummaryWithCache(forceRefresh: boolean): Promise<CachedStorageSummary> {
  if (!forceRefresh) {
    const cached = getValidCachedStorageSummary()
    if (cached) return cached
    if (inflightStorageSummary) return inflightStorageSummary
  }

  const request = Promise.all([
    desktopClient.getStorageSummary(),
    desktopClient.getUserDataStorageSummary(),
    desktopClient.listAgentDownloadedResources(),
    desktopClient.listUserDataDownloadedResources(),
  ])
    .then(([summary, userDataSummary, agentResources, userDataResources]) => {
      const resources: DownloadedResourceEntry[] = [
        ...agentResources.items.map((item) => ({ ...item, source: 'agent' as const })),
        ...userDataResources.map((item) => ({ ...item, source: 'userdata' as const })),
      ].sort((a, b) => b.sizeBytes - a.sizeBytes)

      const next: CachedStorageSummary = {
        summary,
        userDataSummary,
        resources,
        fetchedAt: Date.now(),
      }
      cachedStorageSummary = next
      return next
    })
    .finally(() => {
      if (inflightStorageSummary === request) {
        inflightStorageSummary = null
      }
    })

  inflightStorageSummary = request
  return request
}

export function StorageSettings({ onError, onNotice }: Props): React.ReactNode {
  const navigate = useNavigate()
  const initialCache = getValidCachedStorageSummary()
  const [summary, setSummary] = useState<StorageSummaryResult | null>(
    () => initialCache?.summary ?? null,
  )
  const [userDataSummary, setUserDataSummary] = useState<DesktopUserDataStorageSummary | null>(
    () => initialCache?.userDataSummary ?? null,
  )
  const [resources, setResources] = useState<DownloadedResourceEntry[]>(
    () => initialCache?.resources ?? [],
  )
  const [loading, setLoading] = useState(() => !initialCache)
  const [refreshing, setRefreshing] = useState(false)
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const [oldChatsOpen, setOldChatsOpen] = useState(false)
  const [deletingResource, setDeletingResource] = useState<DownloadedResourceEntry | null>(null)
  const [deletingResourceBusy, setDeletingResourceBusy] = useState(false)

  const loadSummary = useCallback(
    async (forceRefresh = false) => {
      if (!forceRefresh) {
        const cached = getValidCachedStorageSummary()
        if (cached) {
          setSummary(cached.summary)
          setUserDataSummary(cached.userDataSummary)
          setResources(cached.resources)
          setLoading(false)
          setRefreshing(false)
          return
        }
      }
      if (forceRefresh) setRefreshing(true)
      else setLoading(true)
      try {
        const result = await fetchStorageSummaryWithCache(forceRefresh)
        setSummary(result.summary)
        setUserDataSummary(result.userDataSummary)
        setResources(result.resources)
      } catch (cause) {
        onError(errorMessageOf(cause))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [onError],
  )

  useEffect(() => {
    void loadSummary(false)
  }, [loadSummary])

  const segments = useMemo<CategorySegment[]>(() => {
    const chatBytes = summary?.breakdown.chatBytes ?? 0
    const worktreeBytes = summary?.breakdown.worktreeBytes ?? 0
    const artifactsBytes = summary?.breakdown.artifactsBytes ?? 0
    const userDataAlreadyCounted =
      summary && userDataSummary
        ? isPathInside(summary.dataDir, userDataSummary.userDataDir)
        : false
    const extraUserDataBytes = userDataAlreadyCounted ? 0 : (userDataSummary?.totalBytes ?? 0)
    const otherBytes = (summary?.breakdown.otherBytes ?? 0) + extraUserDataBytes
    return [
      { key: 'chat', label: '聊天数据', bytes: chatBytes, color: '#f5b800' },
      { key: 'worktree', label: '工作树', bytes: worktreeBytes, color: '#22c55e' },
      { key: 'artifacts', label: '产物与媒体', bytes: artifactsBytes, color: '#2563eb' },
      { key: 'other', label: '运行环境与其他', bytes: otherBytes, color: '#9ca3af' },
    ]
  }, [summary, userDataSummary])

  const totalBytes = useMemo(
    () => segments.reduce((sum, segment) => sum + segment.bytes, 0),
    [segments],
  )

  async function handleBrowseDirectory(targetPath: string) {
    try {
      await desktopClient.openStorageDirectory(targetPath)
    } catch (cause) {
      onError(errorMessageOf(cause))
    }
  }

  async function handleConfirmDeleteResource() {
    if (!deletingResource || deletingResourceBusy) return
    setDeletingResourceBusy(true)
    const target = deletingResource
    try {
      const result =
        target.source === 'agent'
          ? await desktopClient.deleteAgentDownloadedResource(target.id)
          : await desktopClient.deleteUserDataDownloadedResource(target.id)
      const reclaimedText =
        result.reclaimedBytes > 0
          ? `，已释放 ${formatStorageBytes(result.reclaimedBytes)} 空间`
          : ''
      onNotice?.(`已删除「${target.name}」${reclaimedText}。`)
      setDeletingResource(null)
      await loadSummary(true)
    } catch (cause) {
      onError(errorMessageOf(cause))
    } finally {
      setDeletingResourceBusy(false)
    }
  }

  return (
    <SettingsContentArea>
      <div
        className="settings-content-inner tw:@container tw:w-full tw:min-w-0 tw:mx-auto tw:p-5 tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-6)*2)]"
        id={createSettingsTargetId('storage')}
      >
        <header className="tw:mb-6">
          <h2 className="tw:m-0 tw:type-6 tw:weight-bold tw:text-app-text">存储空间</h2>
        </header>

        <section
          className="tw:min-w-0 tw:mb-6"
          id={createSettingsTargetId('storage', '存储总览')}
        >
          <SettingsSection.Header
            title="此设备"
            description="管理存储在此电脑上的聊天、工作树和本地数据"
          />

          <div className="tw:mb-3 tw:flex tw:items-center tw:justify-between tw:gap-4">
            <span className="tw:text-app-text tw:type-3 tw:weight-semibold tw:tabular-nums">
              {loading && !summary
                ? '正在计算存储占用…'
                : `Pidex 占用 ${formatStorageBytes(totalBytes)}`}
            </span>
            <Button
              color="secondary"
              disabled={refreshing}
              leftIcon={
                <RefreshCw
                  size={14}
                  className={refreshing ? 'tw:animate-spin' : undefined}
                />
              }
              size="sm"
              onClick={() => void loadSummary(true)}
            >
              {refreshing ? '刷新中…' : '刷新'}
            </Button>
          </div>

          <div
            aria-label="存储空间分类占比"
            className="tw:mb-3 tw:flex tw:w-full tw:overflow-hidden tw:rounded-full tw:border tw:border-app-border-subtle tw:bg-app-surface-2"
            role="img"
            style={{ height: 14 }}
          >
            {totalBytes > 0 ? (
              segments.map((segment) => {
                if (segment.bytes <= 0) return null
                const percent = (segment.bytes / totalBytes) * 100
                return (
                  <div
                    key={segment.key}
                    className="tw:h-full tw:transition-[width] tw:duration-300"
                    style={{
                      width: `${Math.max(percent, 0.8)}%`,
                      backgroundColor: segment.color,
                    }}
                    title={`${segment.label}：${formatStorageBytes(segment.bytes)}`}
                  />
                )
              })
            ) : (
              <div className="tw:h-full tw:w-full" />
            )}
          </div>

          <div className="tw:mb-3 tw:flex tw:flex-wrap tw:items-start tw:gap-x-6 tw:gap-y-2">
            {segments.map((segment) => (
              <div key={segment.key} className="tw:flex tw:flex-col tw:gap-0.5">
                <div className="tw:flex tw:items-center tw:gap-1.5 tw:text-app-text-soft tw:type-1">
                  <span
                    aria-hidden="true"
                    className="tw:inline-block tw:shrink-0 tw:rounded-full"
                    style={{
                      width: 8,
                      height: 8,
                      backgroundColor: segment.color,
                    }}
                  />
                  <span>{segment.label}</span>
                </div>
                <span className="tw:pl-3.5 tw:text-app-text tw:type-2 tw:weight-medium tw:tabular-nums">
                  {loading && !summary ? '—' : formatStorageBytes(segment.bytes)}
                </span>
              </div>
            ))}
          </div>

          <div className="tw:mt-2">
            <button
              aria-expanded={detailsExpanded}
              className="tw:inline-flex tw:cursor-pointer tw:items-center tw:gap-1.5 tw:border-0 tw:bg-transparent tw:p-0 tw:text-app-text-soft tw:type-1 tw:hover:text-app-text"
              type="button"
              onClick={() => setDetailsExpanded((prev) => !prev)}
            >
              {detailsExpanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
              <span>聊天存储占用明细</span>
            </button>

            {detailsExpanded && summary ? (
              <div className="tw:mt-2.5 tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:divide-y tw:divide-app-border-subtle">
                <SettingsRow
                  size="compact"
                  title="对话与消息记录（含子智能体）"
                  control={
                    <span className="tw:text-app-text-soft tw:type-1 tw:tabular-nums">
                      {formatStorageBytes(summary.chatDetails.messagesBytes)}
                    </span>
                  }
                />
                <SettingsRow
                  size="compact"
                  title="附件与图片"
                  control={
                    <span className="tw:text-app-text-soft tw:type-1 tw:tabular-nums">
                      {formatStorageBytes(summary.chatDetails.attachmentsBytes)}
                    </span>
                  }
                />
                <SettingsRow
                  size="compact"
                  title="已归档对话估算"
                  control={
                    <span className="tw:text-app-text-soft tw:type-1 tw:tabular-nums">
                      {formatStorageBytes(summary.chatDetails.archivedBytes)}
                    </span>
                  }
                />
                <SettingsRow
                  size="compact"
                  title="SQLite 索引与 WAL 空间"
                  control={
                    <span className="tw:text-app-text-soft tw:type-1 tw:tabular-nums">
                      {formatStorageBytes(summary.chatDetails.sqliteOverheadBytes)}
                    </span>
                  }
                />
              </div>
            ) : null}
          </div>
        </section>

        <div className="tw:flex tw:flex-col tw:gap-4">
          <div>
            <SettingsSection title="各文件夹的存储用量">
              <div className="tw:divide-y tw:divide-app-border-subtle">
                <SettingsRow
                  id={createSettingsTargetId('storage', '应用数据文件夹')}
                  title="应用数据文件夹"
                  description={summary?.dataDir ?? '加载中…'}
                  control={
                    <div className="tw:flex tw:items-center tw:gap-3">
                      <span className="tw:text-app-text-soft tw:type-1 tw:tabular-nums">
                        {summary ? formatStorageBytes(summary.folders.dataDirBytes) : '—'}
                      </span>
                      <Button
                        color="secondary"
                        disabled={!summary?.dataDir}
                        size="sm"
                        onClick={() =>
                          summary?.dataDir && void handleBrowseDirectory(summary.dataDir)
                        }
                      >
                        浏览
                      </Button>
                    </div>
                  }
                />
                <SettingsRow
                  id={createSettingsTargetId('storage', '应用缓存与运行时')}
                  title="应用缓存与运行时"
                  description={userDataSummary?.userDataDir ?? '加载中…'}
                  control={
                    <div className="tw:flex tw:items-center tw:gap-3">
                      <span className="tw:text-app-text-soft tw:type-1 tw:tabular-nums">
                        {userDataSummary ? formatStorageBytes(userDataSummary.totalBytes) : '—'}
                      </span>
                      <Button
                        color="secondary"
                        disabled={!userDataSummary?.userDataDir}
                        size="sm"
                        onClick={() =>
                          userDataSummary?.userDataDir &&
                          void handleBrowseDirectory(userDataSummary.userDataDir)
                        }
                      >
                        浏览
                      </Button>
                    </div>
                  }
                />
                {summary?.configuredWorktreeRoot &&
                summary.folders.customWorktreeRootBytes !== null ? (
                  <SettingsRow
                    id={createSettingsTargetId('storage', '自定义工作树根目录')}
                    title="自定义工作树根目录"
                    description={summary.configuredWorktreeRoot}
                    control={
                      <div className="tw:flex tw:items-center tw:gap-3">
                        <span className="tw:text-app-text-soft tw:type-1 tw:tabular-nums">
                          {formatStorageBytes(summary.folders.customWorktreeRootBytes)}
                        </span>
                        <Button
                          color="secondary"
                          size="sm"
                          onClick={() =>
                            summary.configuredWorktreeRoot &&
                            void handleBrowseDirectory(summary.configuredWorktreeRoot)
                          }
                        >
                          浏览
                        </Button>
                      </div>
                    }
                  />
                ) : null}
              </div>
            </SettingsSection>
          </div>

          <div>
            <SettingsSection>
              <SettingsRow
                id={createSettingsTargetId('storage', '清理旧聊天')}
                title="清理旧聊天"
                description="永久删除前，请先查看聊天及其子智能体"
                control={
                  <Button color="secondary" size="sm" onClick={() => setOldChatsOpen(true)}>
                    查看
                  </Button>
                }
              />
            </SettingsSection>
          </div>

          <div>
            <SettingsSection>
              <div className="tw:divide-y tw:divide-app-border-subtle">
                <SettingsRow
                  id={createSettingsTargetId('storage', '管理工作树')}
                  title="管理工作树"
                  description="查看工作副本，并选择要保留的旧工作树数量"
                  control={
                    <Button
                      color="secondary"
                      size="sm"
                      onClick={() => navigate('/settings/worktrees')}
                    >
                      管理
                    </Button>
                  }
                />
                <SettingsRow
                  id={createSettingsTargetId('storage', '已归档的聊天')}
                  title="已归档的聊天"
                  description="恢复或删除单个已归档的聊天"
                  control={
                    <Button
                      color="secondary"
                      size="sm"
                      onClick={() => navigate('/settings/archived')}
                    >
                      管理
                    </Button>
                  }
                />
              </div>
            </SettingsSection>
          </div>

          <div>
            <SettingsSection
              title="已下载的资源"
              description="管理离线语音模型、外部字体与内置运行时等已下载组件"
            >
              {loading && !summary ? (
                <div className="tw:px-3 tw:py-4 tw:text-app-text-soft tw:type-1">
                  正在扫描已下载的资源…
                </div>
              ) : resources.length === 0 ? (
                <div className="tw:px-3 tw:py-4 tw:text-app-text-soft tw:type-1">
                  暂无已下载的离线资源
                </div>
              ) : (
                <div className="tw:divide-y tw:divide-app-border-subtle">
                  {resources.map((resource) => (
                    <SettingsRow
                      key={resource.id}
                      title={resource.name}
                      description={
                        <span className="tw:block tw:truncate" title={resource.path}>
                          {resource.path}
                        </span>
                      }
                      control={
                        <div className="tw:flex tw:items-center tw:gap-2">
                          <span className="tw:mr-1 tw:text-app-text-soft tw:type-1 tw:tabular-nums">
                            {formatStorageBytes(resource.sizeBytes)}
                          </span>
                          <Button
                            color="secondary"
                            size="sm"
                            onClick={() => void handleBrowseDirectory(resource.path)}
                          >
                            浏览
                          </Button>
                          <Button
                            color="danger"
                            size="sm"
                            onClick={() => setDeletingResource(resource)}
                          >
                            删除
                          </Button>
                        </div>
                      }
                    />
                  ))}
                </div>
              )}
            </SettingsSection>
          </div>
        </div>

        <ConfirmationDialog
          open={deletingResource !== null}
          title="删除已下载的资源"
          description={
            deletingResource
              ? `确定要删除「${deletingResource.name}」（约 ${formatStorageBytes(deletingResource.sizeBytes)}）吗？删除后如需使用可随时在对应设置页重新下载。`
              : ''
          }
          actionLabel={deletingResourceBusy ? '删除中…' : '删除'}
          actionDisabled={deletingResourceBusy}
          tone="danger"
          onCancel={() => {
            if (!deletingResourceBusy) setDeletingResource(null)
          }}
          onAction={() => void handleConfirmDeleteResource()}
        />

        <OldChatsCleanupDialog
          open={oldChatsOpen}
          onClose={() => setOldChatsOpen(false)}
          onDeleted={({ deletedCount, reclaimedBytes }) => {
            const reclaimedText =
              reclaimedBytes > 0 ? `，已回收 ${formatStorageBytes(reclaimedBytes)} 磁盘空间` : ''
            onNotice?.(`已永久删除 ${deletedCount} 个旧聊天${reclaimedText}。`)
            void loadSummary(true)
          }}
          onError={onError}
        />
      </div>
    </SettingsContentArea>
  )
}
