import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as Menubar from '@radix-ui/react-menubar'
import type { DesktopEditAction } from '@pidex/shared/desktop-edit-ipc'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Square,
  X,
} from 'lucide-react'
import {
  APP_ICON_SIZE,
  APP_ICON_STROKE_WIDTH,
  APP_ICON_SIZES,
} from '../../components/ui/IconTokens.js'
import { Button } from '../../components/ui/Button.js'
import { Tooltip } from '../../components/ui/Tooltip.js'
import { OverflowTitle } from '../../components/ui/OverflowTitle.js'
import { usePrefersReducedMotion } from '../../hooks/UsePrefersReducedMotion.js'
import { type PopoverSizingProps } from '../../components/ui/PopoverSizing.js'
import { cx } from '../../utils/Cx.js'
import { useFloatingFocusModality } from '../../utils/FloatingFocus.js'
import { useEditCommands } from '../../components/ui/EditCommandProvider.js'
import type { TitlebarSessionTabItem } from './tabs/TitlebarSessionTabsState.js'

export type FileMenuAction =
  | 'close'
  | 'newWindow'
  | 'newChat'
  | 'quickChat'
  | 'openFolder'
  | 'openSettings'
  | 'logOut'
  | 'exit'
  | 'stopBackendAndExit'

export type EditMenuAction = DesktopEditAction

export type ViewMenuAction =
  | 'toggleSidebar'
  | 'toggleBottomPanel'
  | 'toggleFileTree'
  | 'openBrowserTab'
  | 'reloadBrowserPage'
  | 'toggleSidePanel'
  | 'find'
  | 'previousChat'
  | 'nextChat'
  | 'back'
  | 'forward'
  | 'zoomIn'
  | 'zoomOut'
  | 'actualSize'
  | 'toggleFullScreen'

export type WindowMenuAction = 'minimize' | 'zoom' | 'close'

export type HelpMenuAction =
  | 'pidexDocumentation'
  | 'whatsNew'
  | 'automations'
  | 'localEnvironments'
  | 'worktrees'
  | 'skills'
  | 'modelContextProtocol'
  | 'troubleshooting'
  | 'sendFeedback'
  | 'startPerformanceTrace'
  | 'keyboardShortcuts'
  | 'aboutPidex'

type Props = {
  isFileActionEnabled: (action: FileMenuAction) => boolean
  isViewActionEnabled: (action: ViewMenuAction) => boolean
  isWindowActionEnabled: (action: WindowMenuAction) => boolean
  isHelpActionEnabled: (action: HelpMenuAction) => boolean
  sidebarCollapsed: boolean
  isMaximized: boolean
  canNavigateBack: boolean
  canNavigateForward: boolean
  sessionTabs?: readonly TitlebarSessionTabItem[]
  onSelectSessionTab?: (sessionId: string) => void
  onCloseSessionTab?: (sessionId: string) => void
  onSidebarBoundaryChange?: (width: number) => void
  onToggleSidebar: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
  onFileMenuAction: (action: FileMenuAction) => void
  onViewMenuAction: (action: ViewMenuAction) => void
  onWindowMenuAction: (action: WindowMenuAction) => void
  onHelpMenuAction: (action: HelpMenuAction, restoreFocusElement?: HTMLElement | null) => void
}

export type WindowControlsProps = {
  isMaximized: boolean
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}

type MenuItemProps = {
  children: React.ReactNode
  disabled?: boolean
  shortcut?: React.ReactNode
  onSelect: () => void
}

function MenuItem({ children, disabled, shortcut, onSelect }: MenuItemProps): React.ReactNode {
  return (
    <Menubar.Item
      className="menubar-item tw:outline-none"
      disabled={disabled}
      onSelect={(event) => {
        if (disabled) {
          event.preventDefault()
          return
        }
        onSelect()
      }}
    >
      <OverflowTitle className={cx('menubar-item-label', 'tw:min-w-0')} variant="menu">
        {children}
      </OverflowTitle>
      <span className="menubar-item-trailing tw:min-w-0 tw:justify-self-end">
        {shortcut ? (
          <span
            className={cx(
              'menubar-shortcut',
              disabled ? 'tw:text-app-text-disabled' : 'tw:text-app-text-meta',
              'tw:type-caption',
              'tw:whitespace-nowrap',
            )}
            data-menu-shortcut
          >
            {shortcut}
          </span>
        ) : null}
      </span>
    </Menubar.Item>
  )
}

function MenuSeparator(): React.ReactNode {
  return <Menubar.Separator className="menubar-separator popover-menu-separator" />
}

type AppMenuProps = {
  children: React.ReactNode
  contentClassName?: string
  label: string
  onRequestClose: () => void
  triggerRef?: React.Ref<HTMLButtonElement>
  value: AppMenuValue
} & PopoverSizingProps

type AppMenuValue = 'file' | 'edit' | 'view' | 'help'

const MENU_MNEMONICS: Record<string, AppMenuValue> = {
  f: 'file',
  e: 'edit',
  v: 'view',
  h: 'help',
}

function AppMenu({
  children,
  contentClassName = '',
  label,
  onRequestClose,
  triggerRef,
  value,
  size,
}: AppMenuProps): React.ReactNode {
  const focusModality = useFloatingFocusModality()
  return (
    <Menubar.Menu value={value}>
      <Menubar.Trigger
        asChild
        {...focusModality.triggerInteractionProps}
        onPointerDown={(event) => {
          focusModality.triggerInteractionProps.onPointerDown()
          if (
            event.currentTarget.dataset.state === 'open' &&
            event.button === 0 &&
            event.ctrlKey === false
          ) {
            event.preventDefault()
            onRequestClose()
          }
        }}
        ref={triggerRef}
      >
        <Button className="menubar-trigger" color="ghost" size="toolbar">
          {label}
        </Button>
      </Menubar.Trigger>
      <Menubar.Portal>
        <Menubar.Content
          data-popover-size={size}
          data-theme-component="dropdown-surface"
          align="start"
          className={cx(
            'popover-surface menubar-content popover-menu-list',
            // Radix 浮动层用 CSS 变量下发可用高度与变换原点，回退链无法用刻度表达。
            'tw:origin-[var(--radix-menubar-content-transform-origin,top_left)]',
            'tw:max-h-[min(calc(100vh_-_96px),var(--radix-menubar-content-available-height,calc(100vh_-_96px)))]',
            contentClassName,
          )}
          collisionPadding={6}
          data-edit-command-preserve-target
          onCloseAutoFocus={focusModality.suppressFocusRingOnClose}
          sideOffset={4}
        >
          {children}
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  )
}

export function MenuBar({
  isFileActionEnabled,
  isViewActionEnabled,
  isWindowActionEnabled,
  isHelpActionEnabled,
  sidebarCollapsed,
  isMaximized,
  canNavigateBack,
  canNavigateForward,
  sessionTabs = [],
  onSelectSessionTab,
  onCloseSessionTab,
  onSidebarBoundaryChange,
  onToggleSidebar,
  onMinimize,
  onToggleMaximize,
  onClose,
  onFileMenuAction,
  onViewMenuAction,
  onWindowMenuAction,
  onHelpMenuAction,
}: Props): React.ReactNode {
  const { activeCapabilities: editMenuCapabilities, perform: performEditCommand } =
    useEditCommands()
  const helpMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const menuTriggerRefs = useRef<Partial<Record<AppMenuValue, HTMLButtonElement | null>>>({})
  const menuBarFocusedRef = useRef(false)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const ignoreStaleCloseRef = useRef(false)
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const tabsTrackRef = useRef<HTMLDivElement | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const [activeScrollTabId, setActiveScrollTabId] = useState<string | null>(null)
  const [openMenu, setOpenMenu] = useState<AppMenuValue | ''>('')

  const handleTabsWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const track = event.currentTarget
    if (track.scrollWidth <= track.clientWidth) return
    if (Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
      track.scrollLeft += event.deltaY
      event.preventDefault()
    }
  }, [])

  useEffect(() => {
    const activeTab = sessionTabs.find((t) => t.active)
    if (!activeTab) return
    tabButtonRefs.current.get(activeTab.id)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: reducedMotion ? 'auto' : 'smooth',
    })
  }, [reducedMotion, sessionTabs])

  useLayoutEffect(() => {
    const lastButton = helpMenuTriggerRef.current
    const menuBar = lastButton?.closest('.app-menubar')
    if (!lastButton || !menuBar || !onSidebarBoundaryChange) return
    const update = (): void => {
      onSidebarBoundaryChange(
        Math.floor(lastButton.getBoundingClientRect().right - menuBar.getBoundingClientRect().left),
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(menuBar)
    observer.observe(lastButton.closest('.menubar-root')!)
    return () => observer.disconnect()
  }, [onSidebarBoundaryChange])


  function closeMenu(): void {
    ignoreStaleCloseRef.current = false
    setOpenMenu('')
  }

  function handleMenuValueChange(value: string): void {
    // react-menubar@1.1.18 reports a stale close in the same event turn
    // after switching the controlled Root to another Menu.
    if (!value && ignoreStaleCloseRef.current) return
    ignoreStaleCloseRef.current = Boolean(value)
    setOpenMenu(value as AppMenuValue | '')
    if (value) queueMicrotask(() => (ignoreStaleCloseRef.current = false))
  }

  function rememberFocusSource(): void {
    if (menuBarFocusedRef.current) return
    const active = document.activeElement
    restoreFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null
  }

  function focusMenuBar(): void {
    rememberFocusSource()
    menuBarFocusedRef.current = true
    menuTriggerRefs.current.file?.focus({ preventScroll: true })
  }

  function openMenuByMnemonic(value: AppMenuValue): void {
    rememberFocusSource()
    menuBarFocusedRef.current = true
    setOpenMenu(value)
    menuTriggerRefs.current[value]?.focus({ preventScroll: true })
  }

  function restoreMenuBarFocus(): void {
    const target = restoreFocusRef.current
    menuBarFocusedRef.current = false
    restoreFocusRef.current = null
    if (target && target.isConnected) {
      target.focus({ preventScroll: true })
    } else {
      menuTriggerRefs.current.file?.blur()
    }
  }

  function handleMenuBarKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' && openMenu === '' && menuBarFocusedRef.current) {
      event.preventDefault()
      restoreMenuBarFocus()
    }
  }

  function handleMenuBarBlur(event: React.FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    menuBarFocusedRef.current = false
    restoreFocusRef.current = null
  }

  useEffect(() => {
    // Windows 桌面菜单行为：Alt/F10 聚焦菜单栏，Alt+F/E/V/H 直接打开对应菜单。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey) return
      if (event.key === 'F10') {
        event.preventDefault()
        focusMenuBar()
        return
      }
      if (event.key === 'Alt') {
        focusMenuBar()
        return
      }
      const mnemonic = MENU_MNEMONICS[event.key.toLocaleLowerCase()]
      if (mnemonic && (event.altKey || menuBarFocusedRef.current)) {
        event.preventDefault()
        event.stopPropagation()
        openMenuByMnemonic(mnemonic)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="app-menubar tw:h-full tw:w-full tw:bg-app-titlebar tw:select-none"
      data-edit-command-preserve-target
      onBlur={handleMenuBarBlur}
      onKeyDown={handleMenuBarKeyDown}
    >
      <div className="menubar-titlebar tw:flex tw:h-chrome tw:w-full tw:items-center tw:justify-between tw:gap-2 tw:pl-3">
        <div className="menubar-left tw:flex tw:min-w-0 tw:items-center tw:gap-1 tw:overflow-visible">
          <Tooltip content="后退" shortcut="Ctrl+[" side="bottom">
            <Button
              isIconOnly
              disabled={!canNavigateBack}
              color="ghost"
              onClick={() => onViewMenuAction('back')}
              size="toolbar"
              title="后退"
            >
              <ChevronLeft size={APP_ICON_SIZE} strokeWidth={APP_ICON_STROKE_WIDTH} />
            </Button>
          </Tooltip>
          <Tooltip content="前进" shortcut="Ctrl+]" side="bottom">
            <Button
              isIconOnly
              disabled={!canNavigateForward}
              color="ghost"
              onClick={() => onViewMenuAction('forward')}
              size="toolbar"
              title="前进"
            >
              <ChevronRight size={APP_ICON_SIZES.sm} strokeWidth={APP_ICON_STROKE_WIDTH} />
            </Button>
          </Tooltip>
          <Tooltip
            content={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            shortcut="Ctrl+B"
            side="bottom"
          >
            <Button
              isIconOnly
              data-app-shell-sidebar-trigger
              onClick={onToggleSidebar}
              color="ghost"
              size="toolbar"
              title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen size={APP_ICON_SIZE} strokeWidth={APP_ICON_STROKE_WIDTH} />
              ) : (
                <PanelLeftClose size={APP_ICON_SIZE} strokeWidth={APP_ICON_STROKE_WIDTH} />
              )}
            </Button>
          </Tooltip>

          <Menubar.Root
            aria-label="应用菜单"
            className="menubar-root tw:flex tw:min-w-0 tw:flex-none tw:items-center tw:outline-none tw:select-none"
            loop
            onValueChange={handleMenuValueChange}
            value={openMenu}
          >
            <AppMenu
              label="文件"
              onRequestClose={closeMenu}
              triggerRef={(ref) => {
                menuTriggerRefs.current.file = ref
              }}
              value="file"
              size="md"
            >
              <MenuItem
                disabled={!isFileActionEnabled('close')}
                shortcut="Ctrl+W"
                onSelect={() => onFileMenuAction('close')}
              >
                关闭
              </MenuItem>
              <MenuItem
                disabled={!isFileActionEnabled('newWindow')}
                shortcut="Ctrl+Shift+N"
                onSelect={() => onFileMenuAction('newWindow')}
              >
                新建窗口
              </MenuItem>
              <MenuItem
                disabled={!isFileActionEnabled('newChat')}
                shortcut="Ctrl+N"
                onSelect={() => onFileMenuAction('newChat')}
              >
                新建聊天
              </MenuItem>
              <MenuItem
                disabled={!isFileActionEnabled('quickChat')}
                shortcut="Alt+Ctrl+N"
                onSelect={() => onFileMenuAction('quickChat')}
              >
                快速聊天
              </MenuItem>
              <MenuItem
                disabled={!isFileActionEnabled('openFolder')}
                shortcut="Ctrl+O"
                onSelect={() => onFileMenuAction('openFolder')}
              >
                打开文件夹...
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!isFileActionEnabled('openSettings')}
                shortcut="Ctrl+逗号"
                onSelect={() => onFileMenuAction('openSettings')}
              >
                设置...
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!isFileActionEnabled('exit')}
                onSelect={() => onFileMenuAction('exit')}
              >
                退出桌面端（后台继续运行）
              </MenuItem>
              <MenuItem
                disabled={!isFileActionEnabled('stopBackendAndExit')}
                onSelect={() => onFileMenuAction('stopBackendAndExit')}
              >
                停止后端并退出
              </MenuItem>
            </AppMenu>

            <AppMenu
              label="编辑"
              onRequestClose={closeMenu}
              triggerRef={(ref) => {
                menuTriggerRefs.current.edit = ref
              }}
              value="edit"
              size="md"
            >
              <MenuItem
                disabled={!editMenuCapabilities.undo}
                shortcut="Ctrl+Z"
                onSelect={() => void performEditCommand('undo')}
              >
                撤销
              </MenuItem>
              <MenuItem
                disabled={!editMenuCapabilities.redo}
                shortcut="Ctrl+Y"
                onSelect={() => void performEditCommand('redo')}
              >
                重做
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!editMenuCapabilities.cut}
                shortcut="Ctrl+X"
                onSelect={() => void performEditCommand('cut')}
              >
                剪切
              </MenuItem>
              <MenuItem
                disabled={!editMenuCapabilities.copy}
                shortcut="Ctrl+C"
                onSelect={() => void performEditCommand('copy')}
              >
                复制
              </MenuItem>
              <MenuItem
                disabled={!editMenuCapabilities.paste}
                shortcut="Ctrl+V"
                onSelect={() => void performEditCommand('paste')}
              >
                粘贴
              </MenuItem>
              <MenuItem
                disabled={!editMenuCapabilities.delete}
                shortcut="Delete"
                onSelect={() => void performEditCommand('delete')}
              >
                删除
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!editMenuCapabilities.selectAll}
                shortcut="Ctrl+A"
                onSelect={() => void performEditCommand('selectAll')}
              >
                全选
              </MenuItem>
            </AppMenu>

            <AppMenu
              label="视图"
              onRequestClose={closeMenu}
              triggerRef={(ref) => {
                menuTriggerRefs.current.view = ref
              }}
              value="view"
              size="md"
            >
              <MenuItem
                disabled={!isViewActionEnabled('toggleSidebar')}
                shortcut="Ctrl+B"
                onSelect={() => onViewMenuAction('toggleSidebar')}
              >
                切换侧边栏
              </MenuItem>
              <MenuItem
                disabled={!isViewActionEnabled('toggleSidePanel')}
                shortcut="Ctrl+Shift+B"
                onSelect={() => onViewMenuAction('toggleSidePanel')}
              >
                切换右侧工作区标签页
              </MenuItem>
              <MenuItem
                disabled={!isViewActionEnabled('toggleBottomPanel')}
                onSelect={() => onViewMenuAction('toggleBottomPanel')}
              >
                切换底部面板
              </MenuItem>
              <MenuItem
                disabled={!isViewActionEnabled('toggleFileTree')}
                shortcut="Ctrl+Shift+E"
                onSelect={() => onViewMenuAction('toggleFileTree')}
              >
                切换文件树
              </MenuItem>
              <MenuItem
                disabled={!isViewActionEnabled('openBrowserTab')}
                shortcut="Ctrl+T"
                onSelect={() => onViewMenuAction('openBrowserTab')}
              >
                打开浏览器标签
              </MenuItem>
              <MenuItem
                disabled={!isViewActionEnabled('reloadBrowserPage')}
                shortcut="Ctrl+R"
                onSelect={() => onViewMenuAction('reloadBrowserPage')}
              >
                重新加载浏览器
              </MenuItem>
              <MenuItem
                disabled={!isViewActionEnabled('find')}
                shortcut="Ctrl+F"
                onSelect={() => onViewMenuAction('find')}
              >
                查找
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!isViewActionEnabled('previousChat')}
                shortcut="Ctrl+Shift+["
                onSelect={() => onViewMenuAction('previousChat')}
              >
                上一个聊天
              </MenuItem>
              <MenuItem
                disabled={!isViewActionEnabled('nextChat')}
                shortcut="Ctrl+Shift+]"
                onSelect={() => onViewMenuAction('nextChat')}
              >
                下一个聊天
              </MenuItem>
              <MenuItem
                disabled={!isViewActionEnabled('back')}
                shortcut="Ctrl+["
                onSelect={() => onViewMenuAction('back')}
              >
                后退
              </MenuItem>
              <MenuItem
                disabled={!isViewActionEnabled('forward')}
                shortcut="Ctrl+]"
                onSelect={() => onViewMenuAction('forward')}
              >
                前进
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!isViewActionEnabled('zoomIn')}
                shortcut="Ctrl+Shift+="
                onSelect={() => onViewMenuAction('zoomIn')}
              >
                放大
              </MenuItem>
              <MenuItem
                disabled={!isViewActionEnabled('zoomOut')}
                shortcut="Ctrl+-"
                onSelect={() => onViewMenuAction('zoomOut')}
              >
                缩小
              </MenuItem>
              <MenuItem
                disabled={!isViewActionEnabled('actualSize')}
                shortcut="Ctrl+0"
                onSelect={() => onViewMenuAction('actualSize')}
              >
                实际大小
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!isViewActionEnabled('toggleFullScreen')}
                shortcut="F11"
                onSelect={() => onViewMenuAction('toggleFullScreen')}
              >
                切换全屏
              </MenuItem>
              <MenuItem
                disabled={!isWindowActionEnabled('minimize')}
                shortcut="Ctrl+M"
                onSelect={() => onWindowMenuAction('minimize')}
              >
                最小化
              </MenuItem>
              <MenuItem
                disabled={!isWindowActionEnabled('zoom')}
                onSelect={() => onWindowMenuAction('zoom')}
              >
                缩放
              </MenuItem>
              <MenuItem
                disabled={!isWindowActionEnabled('close')}
                shortcut="Ctrl+W"
                onSelect={() => onWindowMenuAction('close')}
              >
                关闭
              </MenuItem>
            </AppMenu>

            <AppMenu
              contentClassName="menubar-content-help"
              label="帮助"
              onRequestClose={closeMenu}
              triggerRef={(ref) => {
                helpMenuTriggerRef.current = ref
                menuTriggerRefs.current.help = ref
              }}
              value="help"
              size="md"
            >
              <MenuItem
                disabled={!isHelpActionEnabled('pidexDocumentation')}
                onSelect={() => onHelpMenuAction('pidexDocumentation')}
              >
                Pidex 文档
              </MenuItem>
              <MenuItem
                disabled={!isHelpActionEnabled('whatsNew')}
                onSelect={() => onHelpMenuAction('whatsNew', helpMenuTriggerRef.current)}
              >
                新特性
              </MenuItem>
              <MenuItem
                disabled={!isHelpActionEnabled('automations')}
                onSelect={() => onHelpMenuAction('automations')}
              >
                自动化
              </MenuItem>
              <MenuItem
                disabled={!isHelpActionEnabled('localEnvironments')}
                onSelect={() => onHelpMenuAction('localEnvironments')}
              >
                本地环境
              </MenuItem>
              <MenuItem
                disabled={!isHelpActionEnabled('worktrees')}
                onSelect={() => onHelpMenuAction('worktrees')}
              >
                工作树
              </MenuItem>
              <MenuItem
                disabled={!isHelpActionEnabled('skills')}
                onSelect={() => onHelpMenuAction('skills')}
              >
                技能
              </MenuItem>
              <MenuItem
                disabled={!isHelpActionEnabled('modelContextProtocol')}
                onSelect={() => onHelpMenuAction('modelContextProtocol')}
              >
                模型上下文协议
              </MenuItem>
              <MenuItem
                disabled={!isHelpActionEnabled('troubleshooting')}
                onSelect={() => onHelpMenuAction('troubleshooting')}
              >
                故障排查
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!isHelpActionEnabled('sendFeedback')}
                onSelect={() => onHelpMenuAction('sendFeedback')}
              >
                发送反馈
              </MenuItem>
              <MenuItem
                disabled={!isHelpActionEnabled('startPerformanceTrace')}
                onSelect={() => onHelpMenuAction('startPerformanceTrace')}
              >
                启动性能追踪
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!isHelpActionEnabled('keyboardShortcuts')}
                shortcut="Ctrl+Shift+/"
                onSelect={() => onHelpMenuAction('keyboardShortcuts')}
              >
                键盘快捷键
              </MenuItem>
              <MenuItem
                disabled={!isHelpActionEnabled('aboutPidex')}
                onSelect={() => onHelpMenuAction('aboutPidex')}
              >
                关于 Pidex
              </MenuItem>
            </AppMenu>
          </Menubar.Root>
        </div>

        {sessionTabs.length > 0 ? (
          <div
            aria-label="会话标签页"
            className="menubar-session-tabs tw:flex tw:h-chrome tw:min-w-0 tw:flex-1 tw:items-center tw:overflow-hidden tw:mr-3"
            role="tablist"
          >
            <div
              className="menubar-session-tabs-track tw:flex tw:h-full tw:w-full tw:items-center tw:gap-1.5 tw:overflow-x-auto tw:px-1"
              onWheel={handleTabsWheel}
              ref={tabsTrackRef}
            >
              {sessionTabs.map((tab, index) => {
                const active = tab.active
                const isHoveredOrFocused = activeScrollTabId === tab.id
                const fullTooltip = tab.subtitle ? `${tab.title} (${tab.subtitle})` : tab.title
                const showSubtitle = tab.subtitle && (sessionTabs.length <= 3 || active)
                return (
                  <div
                    className={cx(
                      'menubar-session-tab tw:group tw:relative tw:flex tw:h-7 tw:items-center tw:gap-1 tw:overflow-hidden tw:rounded-md tw:border tw:transition-colors',
                      active
                        ? 'tw:flex-[1.5_1_0%] tw:min-w-12 tw:max-w-64 tw:border-transparent tw:bg-app-selected tw:px-2 tw:text-app-text'
                        : 'tw:flex-1 tw:min-w-8 tw:max-w-56 tw:border-app-border-subtle tw:bg-transparent tw:px-1.5 tw:text-app-text-meta tw:hover:border-app-border tw:hover:bg-app-hover tw:hover:text-app-text',
                    )}
                    key={tab.id}
                    onMouseEnter={() => setActiveScrollTabId(tab.id)}
                    onMouseLeave={() =>
                      setActiveScrollTabId((current) => (current === tab.id ? null : current))
                    }
                  >
                    <button
                      aria-selected={active}
                      className="tw:flex tw:h-full tw:min-w-0 tw:flex-1 tw:items-center tw:gap-1.5 tw:border-0 tw:bg-transparent tw:p-0 tw:text-left tw:text-inherit tw:outline-none tw:type-control"
                      onBlur={() =>
                        setActiveScrollTabId((current) => (current === tab.id ? null : current))
                      }
                      onClick={() => onSelectSessionTab?.(tab.id)}
                      onFocus={() => setActiveScrollTabId(tab.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowLeft') {
                          event.preventDefault()
                          const prev = sessionTabs[(index - 1 + sessionTabs.length) % sessionTabs.length]
                          if (prev) {
                            onSelectSessionTab?.(prev.id)
                            tabButtonRefs.current.get(prev.id)?.focus()
                          }
                        } else if (event.key === 'ArrowRight') {
                          event.preventDefault()
                          const next = sessionTabs[(index + 1) % sessionTabs.length]
                          if (next) {
                            onSelectSessionTab?.(next.id)
                            tabButtonRefs.current.get(next.id)?.focus()
                          }
                        } else if (event.key === 'Delete') {
                          event.preventDefault()
                          onCloseSessionTab?.(tab.id)
                        }
                      }}
                      onMouseDown={(event) => {
                        if (event.button === 1) event.preventDefault()
                      }}
                      onAuxClick={(event) => {
                        if (event.button === 1) {
                          event.preventDefault()
                          event.stopPropagation()
                          onCloseSessionTab?.(tab.id)
                        }
                      }}
                      ref={(element) => {
                        if (element) tabButtonRefs.current.set(tab.id, element)
                        else tabButtonRefs.current.delete(tab.id)
                      }}
                      role="tab"
                      tabIndex={active ? 0 : -1}
                      title={fullTooltip}
                      type="button"
                    >
                      <div className="tw:min-w-0 tw:flex-1 tw:overflow-hidden">
                        <OverflowTitle
                          active={isHoveredOrFocused}
                          reducedMotion={reducedMotion}
                          variant="tab"
                        >
                          {tab.title}
                        </OverflowTitle>
                      </div>
                      {showSubtitle ? (
                        <span
                          className={cx(
                            'tw:min-w-0 tw:max-w-24 tw:shrink tw:truncate tw:type-caption',
                            active ? 'tw:text-app-text-meta' : 'tw:text-app-text-disabled',
                          )}
                        >
                          {tab.subtitle}
                        </span>
                      ) : null}
                    </button>
                    <div
                      className={cx(
                        'tw:flex tw:h-5 tw:flex-shrink-0 tw:items-center tw:justify-center tw:transition-all',
                        active
                          ? 'tw:w-5 tw:opacity-100'
                          : 'tw:w-0 tw:overflow-hidden tw:opacity-0 tw:group-hover:w-5 tw:group-hover:opacity-100 tw:group-focus-within:w-5 tw:group-focus-within:opacity-100',
                      )}
                    >
                      <Button
                        className={cx(
                          'tw:transition-opacity tw:duration-feedback tw:ease-standard',
                          active
                            ? 'tw:pointer-events-auto tw:opacity-100'
                            : 'tw:pointer-events-none tw:opacity-0 tw:group-hover:pointer-events-auto tw:group-hover:opacity-100 tw:group-has-[:focus-visible]:pointer-events-auto tw:group-has-[:focus-visible]:opacity-100',
                        )}
                        isIconOnly
                        onClick={(event) => {
                          event.stopPropagation()
                          onCloseSessionTab?.(tab.id)
                        }}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                        }}
                        shape="pill"
                        size="iconSm"
                        title={`关闭 ${tab.title}`}
                        variant="text"
                      >
                        <X size={12} strokeWidth={APP_ICON_STROKE_WIDTH} />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        <WindowControls
          isMaximized={isMaximized}
          onClose={onClose}
          onMinimize={onMinimize}
          onToggleMaximize={onToggleMaximize}
        />
      </div>
    </div>
  )
}

export function WindowControls({
  isMaximized,
  onMinimize,
  onToggleMaximize,
  onClose,
}: WindowControlsProps): React.ReactNode {
  const controlClassName =
    'window-control-button tw:flex tw:h-full tw:w-[46px] tw:items-center tw:justify-center tw:text-app-text-meta tw:[&_svg]:size-3'
  return (
    <div
      aria-hidden="true"
      className="window-controls-host tw:flex tw:h-full tw:w-[138px] tw:shrink-0 tw:items-center tw:justify-end tw:pointer-events-none"
    >
      <div className="window-controls tw:hidden tw:h-full tw:items-center tw:gap-1">
        <button
          aria-label="最小化"
          className={cx(controlClassName, 'tw:hover:bg-app-hover')}
          onClick={onMinimize}
          title="最小化"
          type="button"
        >
          <Minus size={APP_ICON_SIZE} strokeWidth={APP_ICON_STROKE_WIDTH} />
        </button>
        <button
          aria-label={isMaximized ? '还原' : '最大化'}
          className={cx(controlClassName, 'tw:hover:bg-app-hover')}
          onClick={onToggleMaximize}
          title={isMaximized ? '还原' : '最大化'}
          type="button"
        >
          {isMaximized ? (
            <Copy
              className="window-restore-icon tw:-scale-x-100"
              size={APP_ICON_SIZE}
              strokeWidth={APP_ICON_STROKE_WIDTH}
            />
          ) : (
            <Square size={APP_ICON_SIZE} strokeWidth={APP_ICON_STROKE_WIDTH} />
          )}
        </button>
        <button
          aria-label="关闭"
          className={cx(controlClassName, 'close tw:hover:bg-app-danger tw:hover:text-app-text')}
          onClick={onClose}
          title="关闭"
          type="button"
        >
          <X size={APP_ICON_SIZES.sm} strokeWidth={APP_ICON_STROKE_WIDTH} />
        </button>
      </div>
    </div>
  )
}
