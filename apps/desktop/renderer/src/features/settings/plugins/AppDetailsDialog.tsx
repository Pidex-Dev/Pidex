import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, ChevronRight, Copy, MoreHorizontal, Sparkles, Store, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AppSummary, AppToolDescriptor } from '@pidex/agent-protocol'
import { errorMessageOr as errorMessageOf } from '@pidex/shared/errors'
import { Button } from '../../../components/ui/Button.js'
import { PopoverItem } from '../../../components/ui/PopoverItem.js'
import { PopoverMenu } from '../../../components/ui/PopoverMenu.js'
import { ToggleSwitch } from '../../../components/ui/ToggleSwitch.js'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from '../../../components/ui/IconTokens.js'
import { PluginIcon } from '../../plugins/PluginIcon.js'
import type { PluginIconName } from '../../plugins/PluginCatalog.js'
import { desktopClipboard } from '../../../services/desktop-client/index.js'
import { useLastNonNull } from '../../../hooks/UsePresenceRetention.js'

export type AppDetailsDialogProps = {
  app: AppSummary | null
  open: boolean
  busy?: boolean
  restoreFocusElement?: HTMLElement | null
  onOpenChange: (open: boolean) => void
  onToggleEnabled?: (app: AppSummary, enabled: boolean) => Promise<void> | void
  onTryApp?: (app: AppSummary) => void
  onViewPlugin?: (pluginId: string) => void
  onError: (message: string) => void
  onNotice?: (message: string) => void
}

export function resolveAppIconName(app: Pick<AppSummary, 'id' | 'iconName'>): PluginIconName {
  const candidate = app.iconName ?? app.id
  if (
    candidate === 'computer-use' ||
    candidate === 'browser' ||
    candidate === 'github' ||
    candidate === 'pets' ||
    candidate === 'chrome' ||
    candidate === 'task-planning'
  ) {
    return candidate
  }
  return 'plugin'
}

export function AppDetailsDialog({
  app: currentApp,
  open,
  busy = false,
  restoreFocusElement,
  onOpenChange,
  onToggleEnabled,
  onTryApp,
  onViewPlugin,
  onError,
  onNotice,
}: AppDetailsDialogProps): React.ReactNode {
  const retainedApp = useLastNonNull(currentApp)
  const app = open ? currentApp : retainedApp
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const onErrorRef = useRef(onError)

  const [moreOpen, setMoreOpen] = useState(false)
  const [toggleBusy, setToggleBusy] = useState(false)
  const [enabled, setEnabled] = useState(app?.enabled ?? false)
  const [writeExpanded, setWriteExpanded] = useState(true)
  const [readExpanded, setReadExpanded] = useState(true)

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    if (app) {
      setEnabled(app.enabled)
    }
  }, [app])

  useEffect(() => {
    if (open) {
      setWriteExpanded(true)
      setReadExpanded(true)
    }
  }, [open, app?.id])

  if (!app) return null

  const writeTools = app.tools.filter((tool) => tool.mode === 'write')
  const readTools = app.tools.filter((tool) => tool.mode === 'read')

  const handleToggle = async (nextEnabled: boolean) => {
    setToggleBusy(true)
    try {
      if (onToggleEnabled) {
        await onToggleEnabled(app, nextEnabled)
      }
      setEnabled(nextEnabled)
      onNotice?.(nextEnabled ? `已启用应用 “${app.name}”。` : `已禁用应用 “${app.name}”。`)
    } catch (err) {
      onErrorRef.current(errorMessageOf(err, '切换应用状态失败。'))
    } finally {
      setToggleBusy(false)
    }
  }

  const handleCopyId = () => {
    setMoreOpen(false)
    void desktopClipboard.writeText(app.id)
    onNotice?.('已复制应用 ID 到剪贴板。')
  }

  const handleViewPlugin = () => {
    if (!app.pluginId) return
    setMoreOpen(false)
    onOpenChange(false)
    onViewPlugin?.(app.pluginId)
  }

  const handleTry = () => {
    if (onTryApp) {
      onTryApp(app)
      onOpenChange(false)
    }
  }

  return (
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
              <PluginIcon name={resolveAppIconName(app)} />
            </span>
            <div className="tw:flex tw:items-center tw:gap-3">
              <ToggleSwitch
                ariaLabel={`启用 ${app.name} 应用`}
                checked={enabled}
                disabled={toggleBusy || busy}
                onChange={(checked) => void handleToggle(checked)}
              />
              <PopoverMenu
                open={moreOpen}
                onOpenChange={setMoreOpen}
                trigger={
                  <Button isIconOnly color="ghostSecondary" size="toolbar" title="更多选项">
                    <MoreHorizontal
                      aria-hidden="true"
                      size={APP_ICON_SIZE}
                      strokeWidth={APP_ICON_STROKE_WIDTH}
                    />
                  </Button>
                }
              >
                {app.pluginId && onViewPlugin ? (
                  <PopoverItem icon={<Store size={14} />} onClick={handleViewPlugin}>
                    查看关联插件
                  </PopoverItem>
                ) : null}
                <PopoverItem icon={<Copy size={14} />} onClick={handleCopyId}>
                  复制应用 ID
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

          {/* 标题和类型 */}
          <div className="tw:mt-4 tw:flex tw:items-baseline tw:gap-2.5 tw:min-w-0 tw:shrink-0">
            <Dialog.Title className="tw:m-0 tw:type-page-title tw:text-app-text tw:truncate">
              {app.name}
            </Dialog.Title>
            <span className="tw:type-section-title tw:text-app-text-soft tw:shrink-0">
              App
            </span>
          </div>

          {/* 描述与工具计数 */}
          <Dialog.Description className="tw:mt-1.5 tw:mb-0 tw:type-body-sm tw:text-app-text-soft tw:shrink-0">
            {app.description || '未提供应用说明。'}
          </Dialog.Description>
          <p className="tw:mt-2 tw:mb-0 tw:type-body-sm tw:text-app-text-meta tw:shrink-0">
            {app.name} 应用包含 {app.tools.length} 个工具 ({writeTools.length} write,{' '}
            {readTools.length} read)
          </p>

          {/* Write / Read 工具方法折叠列表 */}
          <div className="tw:mt-4 tw:min-h-0 tw:w-full tw:max-w-full tw:flex-1 tw:overflow-y-auto tw:overflow-x-hidden tw:rounded-xl tw:border tw:border-app-border-subtle tw:bg-app-canvas tw:divide-y tw:divide-app-border-subtle">
            {app.tools.length === 0 ? (
              <div className="tw:p-5 tw:type-body-sm tw:text-app-text-soft tw:text-center">
                该应用暂未声明公开工具方法。
              </div>
            ) : (
              <>
                {writeTools.length > 0 ? (
                  <ToolModeSection
                    title="Write"
                    tools={writeTools}
                    expanded={writeExpanded}
                    onToggle={() => setWriteExpanded((current) => !current)}
                  />
                ) : null}
                {readTools.length > 0 ? (
                  <ToolModeSection
                    title="Read"
                    tools={readTools}
                    expanded={readExpanded}
                    onToggle={() => setReadExpanded((current) => !current)}
                  />
                ) : null}
              </>
            )}
          </div>

          {/* 底部栏 */}
          <footer className="tw:mt-4 tw:flex tw:items-center tw:justify-between tw:shrink-0 tw:pt-1">
            <div className="tw:type-caption tw:text-app-text-meta">
              {app.auth?.required
                ? app.auth.connected
                  ? '账号已授权连接'
                  : '部分工具需要授权账号'
                : '由 Pidex 宿主提供'}
            </div>
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
  )
}

function ToolModeSection({
  title,
  tools,
  expanded,
  onToggle,
}: {
  title: 'Write' | 'Read'
  tools: readonly AppToolDescriptor[]
  expanded: boolean
  onToggle: () => void
}): React.ReactNode {
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="tw:w-full tw:border-0 tw:bg-transparent tw:px-4 tw:py-3 tw:flex tw:items-center tw:justify-between tw:gap-3 tw:text-left tw:cursor-pointer tw:hover:bg-app-panel-hover tw:transition-colors tw:focus-visible:outline-2 tw:focus-visible:outline-offset-[-2px] tw:focus-visible:outline-app-focus"
      >
        <span className="tw:flex tw:items-center tw:gap-2 tw:type-row-title tw:text-app-text">
          <span>{title}</span>
          <span className="tw:type-body-sm tw:text-app-text-meta">
            {tools.length}
          </span>
        </span>
        {expanded ? (
          <ChevronDown size={16} className="tw:text-app-text-meta tw:shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight
            size={16}
            className="tw:text-app-text-meta tw:shrink-0"
            aria-hidden="true"
          />
        )}
      </button>
      {expanded ? (
        <div className="tw:px-4 tw:pb-3 tw:grid tw:gap-3">
          {tools.map((tool) => (
            <div
              key={tool.name}
              className="tw:grid tw:grid-cols-[minmax(140px,180px)_1fr] tw:items-start tw:gap-4 tw:max-[520px]:grid-cols-1 tw:max-[520px]:gap-1"
            >
              <code className="tw:font-mono tw:type-caption tw:text-app-text tw:pt-0.5 tw:break-all">
                {tool.name}
              </code>
              <span className="tw:type-body-sm tw:text-app-text-soft">
                {tool.description}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
