import * as Dialog from '@radix-ui/react-dialog'
import { Copy, MoreHorizontal, Sparkles, Store, Trash2, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui/Button.js'
import { ConfirmationDialog } from '../../../components/ui/ConfirmationDialog.js'
import { PopoverItem } from '../../../components/ui/PopoverItem.js'
import { PopoverMenu } from '../../../components/ui/PopoverMenu.js'
import { ToggleSwitch } from '../../../components/ui/ToggleSwitch.js'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from '../../../components/ui/IconTokens.js'
import { PluginIcon } from '../../plugins/PluginIcon.js'
import type { PluginCatalogItem } from '../../plugins/PluginCatalog.js'
import { usePluginDetails } from '../../plugins/UsePluginDetails.js'
import { desktopClipboard } from '../../../services/desktop-client/index.js'
import { MarkdownMessage } from '../../markdown/MarkdownMessage.js'
import { useLastNonNull } from '../../../hooks/UsePresenceRetention.js'
import { errorMessageOr as errorMessageOf } from '@pidex/shared/errors'

export type AppDetailsDialogProps = {
  workspacePath: string | null
  item: PluginCatalogItem | null
  open: boolean
  busy?: boolean
  restoreFocusElement?: HTMLElement | null
  onOpenChange: (open: boolean) => void
  onToggleEnabled?: (item: PluginCatalogItem, enabled: boolean) => Promise<void> | void
  onUninstall?: (item: PluginCatalogItem) => Promise<void>
  onTryApp?: (item: PluginCatalogItem) => void
  onViewMarketDetails?: (item: PluginCatalogItem) => void
  onError: (message: string) => void
  onNotice?: (message: string) => void
}

export function AppDetailsDialog({
  workspacePath,
  item: currentItem,
  open,
  busy = false,
  restoreFocusElement,
  onOpenChange,
  onToggleEnabled,
  onUninstall,
  onTryApp,
  onViewMarketDetails,
  onError,
  onNotice,
}: AppDetailsDialogProps): React.ReactNode {
  const retainedItem = useLastNonNull(currentItem)
  const item = open ? currentItem : retainedItem
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const onErrorRef = useRef(onError)
  const { details, error: detailsError } = usePluginDetails(open ? item : null, workspacePath)

  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [uninstallBusy, setUninstallBusy] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [toggleBusy, setToggleBusy] = useState(false)
  const [enabled, setEnabled] = useState(item?.status === 'enabled')

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    if (item) {
      setEnabled(item.status === 'enabled')
    }
  }, [item?.status])

  if (!item) return null

  const handleToggle = async (nextEnabled: boolean) => {
    setToggleBusy(true)
    try {
      if (onToggleEnabled) {
        await onToggleEnabled(item, nextEnabled)
      }
      setEnabled(nextEnabled)
      onNotice?.(nextEnabled ? `已启用应用 “${item.name}”。` : `已禁用应用 “${item.name}”。`)
    } catch (err) {
      onErrorRef.current(errorMessageOf(err, '切换应用状态失败。'))
    } finally {
      setToggleBusy(false)
    }
  }

  const handleConfirmUninstall = async () => {
    setUninstallBusy(true)
    try {
      if (onUninstall) {
        await onUninstall(item)
      }
      setConfirmUninstall(false)
      onNotice?.(`已成功卸载应用 “${item.name}”。`)
      onOpenChange(false)
    } catch (err) {
      onErrorRef.current(errorMessageOf(err, '卸载应用失败。'))
    } finally {
      setUninstallBusy(false)
    }
  }

  const handleCopyId = () => {
    setMoreOpen(false)
    void desktopClipboard.writeText(item.id)
    onNotice?.('已复制应用 ID 到剪贴板。')
  }

  const handleViewMarket = () => {
    setMoreOpen(false)
    onViewMarketDetails?.(item)
  }

  const handleTry = () => {
    if (onTryApp) {
      onTryApp(item)
      onOpenChange(false)
    }
  }

  // Construct Markdown body for the app
  const markdownSections: string[] = []
  if (details?.longDescription && details.longDescription.trim() !== item.description.trim()) {
    markdownSections.push(details.longDescription.trim())
  } else if (item.description) {
    markdownSections.push(item.description.trim())
  }

  if (details?.defaultPrompts && details.defaultPrompts.length > 0) {
    const promptList = details.defaultPrompts.map((p) => `- ${p.trim()}`).join('\n')
    markdownSections.push(`### 示例提示词\n\n${promptList}`)
  }

  const skills = details?.skills ?? (item.skills ?? []).map((id) => ({ id, name: id, description: '' }))
  if (skills.length > 0) {
    const skillList = skills
      .map((s) => `- **${s.name}**${s.description ? `：${s.description}` : ''}`)
      .join('\n')
    markdownSections.push(`### 包含的技能\n\n${skillList}`)
  }

  if (details?.components && details.components.length > 0) {
    const compList = details.components
      .map((c) => `- **${c.name}**${c.description ? `：${c.description}` : ''}`)
      .join('\n')
    markdownSections.push(`### 包含的组件与服务\n\n${compList}`)
  }

  const bodyContent = markdownSections.join('\n\n')
  const canUninstall = item.canUninstall !== false

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="ui-dialog-backdrop permission-modal-backdrop" />
          <Dialog.Content
            className="ui-dialog-surface ui-dialog-surface--centered settings-management-dialog tw:flex tw:flex-col tw:overflow-hidden tw:p-6 tw:rounded-2xl tw:w-[min(640px,calc(100vw-32px))] tw:max-h-[85vh] tw:border tw:border-app-border-subtle tw:bg-app-panel tw:text-app-text tw:shadow-2xl"
            onCloseAutoFocus={(event) => {
              if (!restoreFocusElement?.isConnected) return
              event.preventDefault()
              restoreFocusElement.focus()
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              closeRef.current?.focus()
            }}
          >
            {/* 顶部栏：左侧图标，右侧开关、更多、关闭 */}
            <div className="tw:flex tw:items-center tw:justify-between tw:shrink-0">
              <span
                aria-hidden="true"
                className="tw:flex tw:size-10 tw:shrink-0 tw:items-center tw:justify-center tw:rounded-full tw:border tw:border-app-border-subtle tw:bg-app-canvas/80 tw:text-app-text-soft tw:overflow-hidden"
              >
                <PluginIcon
                  plugin={{ ...item, workspacePath }}
                  logoDarkSource={item.logoDarkSource}
                  logoSource={item.logoSource}
                  name={item.iconName}
                />
              </span>
              <div className="tw:flex tw:items-center tw:gap-3">
                <ToggleSwitch
                  ariaLabel={`启用 ${item.name} 应用`}
                  checked={enabled}
                  disabled={toggleBusy || busy}
                  onChange={(checked) => void handleToggle(checked)}
                />
                <PopoverMenu
                  open={moreOpen}
                  onOpenChange={setMoreOpen}
                  trigger={
                    <Button
                      isIconOnly
                      color="ghostSecondary"
                      size="toolbar"
                      title="更多选项"
                    >
                      <MoreHorizontal
                        aria-hidden="true"
                        size={APP_ICON_SIZE}
                        strokeWidth={APP_ICON_STROKE_WIDTH}
                      />
                    </Button>
                  }
                >
                  {onViewMarketDetails ? (
                    <PopoverItem
                      icon={<Store size={14} />}
                      onClick={handleViewMarket}
                    >
                      在插件市场查看
                    </PopoverItem>
                  ) : null}
                  <PopoverItem
                    icon={<Copy size={14} />}
                    onClick={handleCopyId}
                  >
                    复制插件 ID
                  </PopoverItem>
                </PopoverMenu>
                <Dialog.Close asChild>
                  <Button
                    isIconOnly
                    color="ghostSecondary"
                    ref={closeRef}
                    size="toolbar"
                    title="关闭弹层"
                  >
                    <X
                      aria-hidden="true"
                      size={APP_ICON_SIZE}
                      strokeWidth={APP_ICON_STROKE_WIDTH}
                    />
                  </Button>
                </Dialog.Close>
              </div>
            </div>

            {/* 中间：标题和类型 */}
            <div className="tw:mt-4 tw:flex tw:items-baseline tw:gap-2.5 tw:min-w-0 tw:shrink-0">
              <Dialog.Title className="tw:m-0 tw:text-2xl tw:font-semibold tw:text-app-text tw:truncate">
                {item.name}
              </Dialog.Title>
              <span className="tw:text-lg tw:font-normal tw:text-app-text-soft tw:shrink-0">
                App
              </span>
            </div>

            {/* 下方：描述 */}
            <Dialog.Description className="tw:mt-1.5 tw:mb-0 tw:type-body-sm tw:text-app-text-soft tw:leading-relaxed tw:shrink-0 tw:line-clamp-3">
              {item.description || '未提供应用说明。'}
            </Dialog.Description>

            {/* 再下方：正文（暗色背景圆角卡片，渲染 Markdown） */}
            <div className="tw:mt-4 tw:min-h-0 tw:w-full tw:max-w-full tw:flex-1 tw:overflow-y-auto tw:overflow-x-hidden tw:rounded-xl tw:border tw:border-app-border-subtle tw:bg-app-canvas tw:p-4 tw:type-body-sm">
              {detailsError ? (
                <div
                  className="tw:type-body-sm tw:border tw:border-app-danger tw:bg-app-panel tw:p-3 tw:text-app-danger tw:rounded-container"
                  role="alert"
                >
                  {detailsError}
                </div>
              ) : (
                <MarkdownMessage allowWideBlocks={false} text={bodyContent} />
              )}
            </div>

            {/* 最下方：卸载和立即试用 */}
            <footer className="tw:mt-4 tw:flex tw:items-center tw:justify-between tw:shrink-0 tw:pt-1">
              {canUninstall ? (
                <Button
                  color="danger"
                  shape="pill"
                  size="md"
                  disabled={uninstallBusy || busy}
                  onClick={() => setConfirmUninstall(true)}
                >
                  <Trash2
                    aria-hidden="true"
                    size={APP_ICON_SIZE}
                    strokeWidth={APP_ICON_STROKE_WIDTH}
                  />
                  卸载
                </Button>
              ) : (
                <div />
              )}
              <Button
                color="primary"
                shape="pill"
                size="md"
                disabled={!enabled || busy}
                onClick={handleTry}
              >
                <Sparkles
                  aria-hidden="true"
                  size={APP_ICON_SIZE}
                  strokeWidth={APP_ICON_STROKE_WIDTH}
                />
                立即试用
              </Button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmationDialog
        actionLabel="卸载"
        actionDisabled={uninstallBusy || busy}
        tone="danger"
        description={`确定要卸载应用 “${item.name}” 吗？此操作不可逆。`}
        onAction={() => void handleConfirmUninstall()}
        onCancel={() => setConfirmUninstall(false)}
        open={confirmUninstall}
        title={`卸载 ${item.name}？`}
      />
    </>
  )
}
