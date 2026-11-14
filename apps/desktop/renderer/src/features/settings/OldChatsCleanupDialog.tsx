import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, X } from 'lucide-react'
import type { OldChatStorageItem, OldChatsScope } from '@pidex/agent-protocol'
import { desktopClient } from '../../services/desktop-client/index.js'
import { canonicalThreadCache } from '../session/state/CanonicalThreadCache.js'
import { Button } from '../../components/ui/Button.js'
import { Select } from '../../components/ui/Select.js'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from '../../components/ui/IconTokens.js'
import { useDialogFocusRestore } from '../../components/ui/UseDialogFocusRestore.js'
import { errorMessageOf } from '@pidex/shared/errors'
import { formatStorageBytes } from './StorageFormatting.js'

type Props = {
  open: boolean
  onClose: () => void
  onDeleted: (summary: {
    deletedCount: number
    reclaimedBytes: number
  }) => void
  onError: (message: string) => void
}

type AgeFilterValue = '90' | '30' | '7' | 'all'

const AGE_OPTIONS: Array<{ value: AgeFilterValue; label: string }> = [
  { value: '90', label: '早于 90 天前' },
  { value: '30', label: '早于 30 天前' },
  { value: '7', label: '早于 7 天前' },
  { value: 'all', label: '全部时间' },
]

const SCOPE_OPTIONS: Array<{ value: OldChatsScope; label: string }> = [
  { value: 'archived', label: '已归档的聊天' },
  { value: 'all', label: '所有聊天' },
  { value: 'unarchived', label: '未归档的聊天' },
]

const PAGE_SIZE = 20

export function OldChatsCleanupDialog({
  open,
  onClose,
  onDeleted,
  onError,
}: Props): React.ReactNode {
  const { onCloseAutoFocus } = useDialogFocusRestore(open)
  const [ageFilter, setAgeFilter] = useState<AgeFilterValue>('90')
  const [scope, setScope] = useState<OldChatsScope>('archived')
  const [items, setItems] = useState<readonly OldChatStorageItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const olderThanDays = ageFilter === 'all' ? null : Number(ageFilter)

  const loadInitial = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setLocalError(null)
    try {
      const result = await desktopClient.listOldChatsForStorage({
        olderThanDays,
        scope,
        limit: PAGE_SIZE,
        offset: 0,
      })
      if (requestId !== requestIdRef.current) return
      setItems(result.items)
      setHasMore(result.hasMore)
      setTotalCount(result.totalCount)
      setSelectedIds(new Set(result.items.map((item) => item.threadId)))
    } catch (cause) {
      if (requestId !== requestIdRef.current) return
      setLocalError(errorMessageOf(cause))
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false)
      }
    }
  }, [olderThanDays, scope])

  useEffect(() => {
    if (!open) return
    void loadInitial()
  }, [open, loadInitial])

  async function handleLoadMore() {
    if (loadingMore || !hasMore) return
    const requestId = requestIdRef.current
    setLoadingMore(true)
    setLocalError(null)
    try {
      const result = await desktopClient.listOldChatsForStorage({
        olderThanDays,
        scope,
        limit: PAGE_SIZE,
        offset: items.length,
      })
      if (requestId !== requestIdRef.current) return
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.threadId))
        const appended = result.items.filter((item) => !seen.has(item.threadId))
        return [...prev, ...appended]
      })
      setHasMore(result.hasMore)
      setTotalCount(result.totalCount)
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (const item of result.items) {
          next.add(item.threadId)
        }
        return next
      })
    } catch (cause) {
      if (requestId !== requestIdRef.current) return
      setLocalError(errorMessageOf(cause))
    } finally {
      if (requestId === requestIdRef.current) {
        setLoadingMore(false)
      }
    }
  }

  function toggleSelection(threadId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(threadId)) next.delete(threadId)
      else next.add(threadId)
      return next
    })
  }

  const selectionSummary = useMemo(() => {
    let chatCount = 0
    let subagentCount = 0
    for (const item of items) {
      if (selectedIds.has(item.threadId)) {
        chatCount += 1
        subagentCount += item.subagentCount
      }
    }
    return { chatCount, subagentCount }
  }, [items, selectedIds])

  async function handleDeleteSelected() {
    if (deleting || selectionSummary.chatCount === 0) return
    setDeleting(true)
    setLocalError(null)
    try {
      const targetIds = items
        .filter((item) => selectedIds.has(item.threadId))
        .map((item) => item.threadId)
      const result = await desktopClient.deleteOldChatsForStorage(targetIds)
      for (const id of result.deletedIds) {
        canonicalThreadCache.invalidate(id)
      }
      if (result.failed.length > 0) {
        const firstReason = result.failed[0]?.reason ?? '部分对话正在运行中'
        setLocalError(
          `已删除 ${result.deletedIds.length} 个对话，${result.failed.length} 个删除失败：${firstReason}`,
        )
      }
      if (result.deletedIds.length > 0) {
        onDeleted({
          deletedCount: result.deletedIds.length,
          reclaimedBytes: result.reclaimedBytes,
        })
      }
      if (result.failed.length === 0) {
        onClose()
      } else {
        await loadInitial()
      }
    } catch (cause) {
      const msg = errorMessageOf(cause)
      setLocalError(msg)
      onError(msg)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !deleting) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ui-dialog-backdrop permission-modal-backdrop" />
        <Dialog.Content
          className="ui-dialog-surface ui-dialog-surface--centered permission-modal tw:flex tw:max-h-[82vh] tw:w-[min(36rem,calc(100vw-2rem))] tw:flex-col tw:gap-4 tw:p-5"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <header className="tw:flex tw:items-start tw:justify-between tw:gap-3">
            <div className="tw:min-w-0 tw:flex-1">
              <Dialog.Title asChild>
                <h2 className="tw:m-0 tw:text-app-text tw:type-4 tw:weight-bold">查看旧聊天</h2>
              </Dialog.Title>
              <Dialog.Description asChild>
                <p className="tw:mt-1 tw:mb-0 tw:text-app-text-soft tw:type-1">
                  聊天记录大小包含子智能体记录的大小。删除聊天及其子智能体后将无法恢复。
                </p>
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                isIconOnly
                className="tw:shrink-0"
                color="ghostSecondary"
                disabled={deleting}
                size="toolbar"
                title="关闭"
              >
                <X size={APP_ICON_SIZE} strokeWidth={APP_ICON_STROKE_WIDTH} />
              </Button>
            </Dialog.Close>
          </header>

          <div className="tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-surface-2 tw:divide-y tw:divide-app-border-subtle">
            <div className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:px-3 tw:py-2">
              <span className="tw:text-app-text tw:type-2 tw:weight-medium">上次更新时间</span>
              <Select<AgeFilterValue>
                ariaLabel="上次更新时间"
                disabled={deleting}
                options={AGE_OPTIONS}
                value={ageFilter}
                onValueChange={setAgeFilter}
              />
            </div>
            <div className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:px-3 tw:py-2">
              <span className="tw:text-app-text tw:type-2 tw:weight-medium">包含</span>
              <Select<OldChatsScope>
                ariaLabel="包含范围"
                disabled={deleting}
                options={SCOPE_OPTIONS}
                value={scope}
                onValueChange={setScope}
              />
            </div>
          </div>

          {localError ? (
            <div className="tw:rounded-control tw:border tw:border-app-danger/40 tw:bg-app-danger/10 tw:px-3 tw:py-2 tw:text-app-danger tw:type-1">
              {localError}
            </div>
          ) : null}

          <div className="tw:min-h-[12rem] tw:flex-1 tw:overflow-y-auto tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel">
            {loading ? (
              <div className="tw:flex tw:h-40 tw:items-center tw:justify-center tw:text-app-text-soft tw:type-2">
                正在扫描聊天记录…
              </div>
            ) : items.length === 0 ? (
              <div className="tw:flex tw:h-40 tw:items-center tw:justify-center tw:px-4 tw:text-center tw:text-app-text-soft tw:type-2">
                当前筛选条件下没有可清理的聊天记录
              </div>
            ) : (
              <div className="tw:divide-y tw:divide-app-border-subtle">
                {items.map((item) => {
                  const checked = selectedIds.has(item.threadId)
                  return (
                    <button
                      key={item.threadId}
                      type="button"
                      disabled={deleting}
                      onClick={() => toggleSelection(item.threadId)}
                      className="tw:flex tw:w-full tw:cursor-pointer tw:items-center tw:justify-between tw:gap-3 tw:border-0 tw:bg-transparent tw:px-3 tw:py-2.5 tw:text-left tw:transition-colors tw:hover:bg-app-hover tw:disabled:cursor-not-allowed tw:disabled:opacity-60"
                    >
                      <span className="tw:min-w-0 tw:flex-1 tw:truncate tw:text-app-text tw:type-2">
                        {item.title}
                      </span>
                      <span className="tw:flex tw:shrink-0 tw:items-center tw:gap-2.5">
                        <span className="tw:text-app-text-soft tw:type-1 tw:tabular-nums">
                          聊天记录大小：{formatStorageBytes(item.estimatedBytes)}
                        </span>
                        <span
                          aria-hidden="true"
                          className={
                            checked
                              ? 'tw:inline-flex tw:size-4 tw:items-center tw:justify-center tw:rounded-full tw:bg-app-accent tw:text-app-on-accent'
                              : 'tw:inline-flex tw:size-4 tw:items-center tw:justify-center tw:rounded-full tw:border tw:border-app-border-strong tw:bg-transparent'
                          }
                        >
                          {checked ? <Check size={11} strokeWidth={2.5} /> : null}
                        </span>
                      </span>
                    </button>
                  )
                })}
                {hasMore ? (
                  <div className="tw:px-3 tw:py-2">
                    <Button
                      color="ghostSecondary"
                      disabled={loadingMore || deleting}
                      size="sm"
                      onClick={() => void handleLoadMore()}
                    >
                      {loadingMore
                        ? '正在加载…'
                        : `显示更多聊天（还有 ${Math.max(0, totalCount - items.length)} 条）`}
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <footer className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3">
            <div className="tw:text-app-text-soft tw:type-1 tw:tabular-nums">
              已选聊天：{selectionSummary.chatCount} · 子智能体：{selectionSummary.subagentCount}
            </div>
            <div className="tw:flex tw:items-center tw:gap-2">
              <Button color="secondary" disabled={deleting} onClick={onClose}>
                取消
              </Button>
              <Button
                color="dangerSolid"
                disabled={deleting || selectionSummary.chatCount === 0}
                loading={deleting}
                onClick={() => void handleDeleteSelected()}
              >
                {deleting ? '删除中…' : '删除所选项'}
              </Button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
