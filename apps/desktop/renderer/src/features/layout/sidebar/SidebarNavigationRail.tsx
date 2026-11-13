import { useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Ellipsis, Home, Pin, PinOff } from 'lucide-react'
import { Button } from '../../../components/ui/Button.js'
import { Tooltip } from '../../../components/ui/Tooltip.js'
import { ScrollArea } from '../../../components/ui/ScrollArea.js'
import { Popover } from '../../../components/ui/floating/Popover.js'
import { AppContextMenu } from '../../../components/ui/AppContextMenu.js'
import { APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'
import { SkeletonBlock, SkeletonRegion } from '../../../components/ui/Skeleton.js'
import { useDesktopSettingsField } from '../../settings/UseDesktopSettings.js'
import { useLocale } from '../../i18n/LocaleProvider.js'
import { useEverOpened } from '../../../hooks/UsePresenceRetention.js'
import { newSessionPath } from '../../session/NewSessionSurface.js'
import { canShowSidebarTooltip, type SidebarShellController } from '../SidebarShellState.js'
import { SidebarFooter } from './SidebarFooter.js'
import { getSidebarTopNavItems, type SidebarCapabilityState } from './SidebarTopNav.js'
import type { SidebarPane } from './SidebarNavigation.js'
import {
  pageIdForNavView,
  resolveAppPage,
  sidebarRailDestinations,
  type SidebarRailDestinationId,
} from '../../routing/PageDefinitions.js'
import { SidebarRow } from '../../../components/ui/SidebarRow.js'
import { setSidebarDestinationHidden } from './SidebarCustomization.js'

type Props = {
  shell: SidebarShellController
  activePane: SidebarPane | null
  capabilityState: SidebarCapabilityState
  onOpenWhatsNew: (restoreFocusElement: HTMLElement | null) => void
  onReport: (message: string) => void
}

export type { SidebarRailDestinationId } from '../../routing/PageDefinitions.js'

const RAIL_DESTINATIONS = sidebarRailDestinations()
const RAIL_DESTINATION_PANES = new Map<SidebarRailDestinationId, SidebarPane | null>(
  RAIL_DESTINATIONS.map((destination) => [destination.id, destination.pane]),
)
const OTHER_RAIL_DESTINATION_IDS = new Set<SidebarRailDestinationId>(
  RAIL_DESTINATIONS.filter((destination) => destination.group === 'other').map(
    (destination) => destination.id,
  ),
)

/** 载入中的入口骨架布局：与真实导航轨上、下两组入口数量对齐。 */
const RAIL_SKELETON_GROUP_COUNTS = [3, 3] as const

export function SidebarNavigationRail(props: Props): ReactNode {
  const settingsLoaded = useDesktopSettingsField((settings) => settings.settingsLoaded)
  const initiallyReady = useEverOpened(settingsLoaded && props.capabilityState.status !== 'unknown')
  const { t } = useLocale()
  return (
    <nav
      className="sidebar-navigation-rail tw:flex tw:h-full tw:flex-col tw:items-center tw:justify-center tw:py-2"
      aria-label={t('应用导航')}
    >
      {initiallyReady ? (
        <SidebarNavigationRailBody {...props} />
      ) : (
        <SkeletonRegion
          className="tw:flex tw:w-full tw:flex-col tw:items-center tw:gap-2 tw:pt-1"
          label="正在加载侧栏导航"
          shimmer
        >
          {RAIL_SKELETON_GROUP_COUNTS.map((count, groupIndex) => (
            <div className="tw:flex tw:flex-col tw:items-center tw:gap-2" key={groupIndex}>
              {Array.from({ length: count }, (_, index) => (
                <SkeletonBlock
                  className="tw:size-[var(--sidebar-icon-button-size)] tw:rounded-3"
                  key={index}
                />
              ))}
            </div>
          ))}
        </SkeletonRegion>
      )}
    </nav>
  )
}

/** 就绪后的导航轨内容：入口能力过滤、固定与更多分组、底部页脚。 */
export function SidebarNavigationRailBody({
  shell,
  activePane,
  capabilityState,
  onOpenWhatsNew,
  onReport,
}: Props): ReactNode {
  const sidebarProductMode = useDesktopSettingsField((settings) => settings.sidebarProductMode)
  const sidebarTimelineEnabled = useDesktopSettingsField(
    (settings) => settings.sidebarTimelineEnabled,
  )
  const sidebarCustomization = useDesktopSettingsField((settings) => settings.sidebarCustomization)
  const setSidebarCustomization = useDesktopSettingsField(
    (settings) => settings.setSidebarCustomization,
  )
  const { t } = useLocale()
  const navigate = useNavigate()
  const location = useLocation()
  const [tooltipId, setTooltipId] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreTriggerRef = useRef<HTMLButtonElement>(null)
  const lastChatPath = useRef(newSessionPath(sidebarProductMode))
  const currentPageId = resolveAppPage(location.pathname)?.id ?? null
  // 首页按钮回到最近停留的聊天页，仅在工作区页面记录。
  if (currentPageId === 'home' || currentPageId === 'chat')
    lastChatPath.current = `${location.pathname}${location.search}`
  const items = getSidebarTopNavItems({
    showProjects: false,
    surface: sidebarProductMode,
    capabilityState,
  })
  const destinationItems = items.filter((item) => item.view !== 'new')
  const itemByDestinationId = new Map<SidebarRailDestinationId, (typeof destinationItems)[number]>()
  for (const item of destinationItems) {
    if (RAIL_DESTINATION_PANES.has(item.view as SidebarRailDestinationId)) {
      itemByDestinationId.set(item.view as SidebarRailDestinationId, item)
    }
  }
  const hiddenDestinationIds = new Set(
    sidebarCustomization.hiddenDestinationIds.filter(
      (id): id is SidebarRailDestinationId => typeof id === 'string',
    ),
  )
  const orderedDestinationIds = [
    ...sidebarCustomization.destinationOrder,
    ...RAIL_DESTINATION_PANES.keys(),
  ].filter(
    (id, index, list): id is SidebarRailDestinationId =>
      RAIL_DESTINATION_PANES.has(id as SidebarRailDestinationId) && list.indexOf(id) === index,
  )
  const directItems = orderedDestinationIds
    .filter((id) => !hiddenDestinationIds.has(id))
    .flatMap((id) => {
      const item = itemByDestinationId.get(id)
      return item ? [item] : []
    })
  const moreItems = orderedDestinationIds.flatMap((id) => {
    const item = itemByDestinationId.get(id)
    return item ? [item] : []
  })
  const fixedItems = directItems.filter(
    (item) => !OTHER_RAIL_DESTINATION_IDS.has(item.view as SidebarRailDestinationId),
  )
  const otherItems = directItems.filter((item) =>
    OTHER_RAIL_DESTINATION_IDS.has(item.view as SidebarRailDestinationId),
  )

  const toggleDestination = (id: SidebarRailDestinationId, fromRail = false) => {
    const hidden = !hiddenDestinationIds.has(id)
    setSidebarCustomization((current) => setSidebarDestinationHidden(current, id, hidden))
    setTooltipId(null)
    if (hidden && fromRail) requestAnimationFrame(() => moreTriggerRef.current?.focus())
  }
  const destinationActions = (id: SidebarRailDestinationId, fromRail = false) => [
    {
      kind: 'item' as const,
      label: t(hiddenDestinationIds.has(id) ? '固定到侧栏' : '取消固定，收进更多'),
      icon: hiddenDestinationIds.has(id) ? (
        <Pin className="tw:size-icon-md" size={APP_ICON_SIZES.md} />
      ) : (
        <PinOff className="tw:size-icon-md" size={APP_ICON_SIZES.md} />
      ),
      onSelect: () => toggleDestination(id, fromRail),
    },
  ]

  const button = (
    id: string,
    label: string,
    icon: ReactNode,
    onClick: () => void,
    pane?: SidebarPane | null,
    selected = false,
  ): ReactNode => (
    <Tooltip
      content={t(label)}
      side="right"
      key={id}
      open={
        tooltipId === id &&
        !moreOpen &&
        canShowSidebarTooltip(shell.mode, shell.mode === 'collapsed' && pane != null)
      }
      onOpenChange={(open) =>
        setTooltipId((current) => (open ? id : current === id ? null : current))
      }
    >
      <Button
        isIconOnly
        iconSize="md"
        title={t(label)}
        nativeTitle={false}
        aria-label={t(label)}
        aria-current={selected ? 'page' : undefined}
        aria-controls={pane ? 'desktop-sidebar-pane' : undefined}
        active={selected}
        data-position="sidebar"
        className="tw:flex-none"
        variant="ghost"
        size="md"
        onClick={() => {
          setTooltipId(null)
          shell.closePreview()
          onClick()
        }}
        onPointerEnter={pane ? (event) => shell.onRailItemEnter(pane, event) : undefined}
        onPointerLeave={(event) => {
          setTooltipId((current) => (current === id ? null : current))
          if (pane) shell.onRailItemLeave(event)
        }}
      >
        {icon}
      </Button>
    </Tooltip>
  )

  const destinationButton = (item: (typeof directItems)[number]): ReactNode => {
    const pane = RAIL_DESTINATION_PANES.get(item.view as SidebarRailDestinationId) ?? null
    // 有面板的入口按面板选中；工作组没有面板，回落到页面定义解析当前路径。
    const selected = pane
      ? activePane === pane
      : currentPageId === pageIdForNavView(item.view)
    return (
      <AppContextMenu
        key={item.view}
        layout="grid"
        includeEditActions={false}
        actions={destinationActions(item.view as SidebarRailDestinationId, true)}
        trigger={
          <span className="tw:flex">
            {button(
              item.view,
              item.label,
              item.icon,
              () => {
                navigate(item.path)
              },
              pane,
              selected,
            )}
          </span>
        }
      />
    )
  }

  return (
    <>
      <ScrollArea
        className="sidebar-rail-destinations tw:w-full tw:min-h-0 tw:flex-1 tw:mb-3"
        contentClassName="tw:flex tw:flex-col tw:items-center tw:gap-1"
      >
        <div className="tw:flex tw:flex-col tw:items-center tw:gap-2">
          {button(
            'home',
            '首页',
            <Home className="tw:size-icon-md" size={APP_ICON_SIZES.md} />,
            () => {
              navigate(lastChatPath.current)
            },
            sidebarTimelineEnabled ? 'activity' : 'chats',
            activePane === 'chats' || activePane === 'activity',
          )}
          {fixedItems.map(destinationButton)}
          {moreItems.length > 0 ? (
            <Popover.Root open={moreOpen} onOpenChange={setMoreOpen}>
              <Popover.Trigger asChild>
                <Button
                  isIconOnly
                  iconSize="md"
                  ref={moreTriggerRef}
                  title={t('更多')}
                  nativeTitle={false}
                  aria-label={t('更多')}
                  active={moreOpen}
                  data-position="sidebar"
                  className="tw:flex-none"
                  variant="ghost"
                  size="md"
                >
                  <Ellipsis className="tw:size-icon-md" size={APP_ICON_SIZES.md} />
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  asChild
                  side="right"
                  align="start"
                  size="sm"
                  aria-label={t('更多')}
                  className="tw:p-1"
                >
                  <div className="desktop-sidebar tw:flex tw:flex-col tw:sidebar-row-gap">
                    {moreItems.map((item) => {
                      const id = item.view as SidebarRailDestinationId
                      const pinned = !hiddenDestinationIds.has(id)
                      const pinLabel = t(pinned ? '取消固定' : '固定到侧栏')
                      return (
                        <AppContextMenu
                          key={id}
                          layout="grid"
                          includeEditActions={false}
                          actions={destinationActions(id)}
                          trigger={
                            <SidebarRow
                              tabIndex={-1}
                              layout="grid"
                              leading={item.icon}
                              active={currentPageId === pageIdForNavView(item.view)}
                              className="tw:group tw:[&>.sidebar-row-trailing]:w-auto tw:has-[:focus-visible]:bg-app-hover"
                              onClick={() => {
                                setMoreOpen(false)
                                navigate(item.path)
                                shell.closePreview()
                              }}
                              trailing={
                                <Tooltip content={pinLabel}>
                                  <Button
                                    isIconOnly
                                    variant="text"
                                    size="compact"
                                    iconSize="md"
                                    nativeTitle={false}
                                    aria-label={`${pinLabel}: ${t(item.label)}`}
                                    className={`tw:shrink-0 ${pinned ? '' : 'tw:opacity-0 tw:group-hover:opacity-100 tw:group-has-[:focus-visible]:opacity-100'}`}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      toggleDestination(id)
                                    }}
                                  >
                                    <Pin
                                      className="tw:size-icon-md tw:rotate-45"
                                      size={APP_ICON_SIZES.md}
                                      fill={pinned ? 'currentColor' : 'none'}
                                    />
                                  </Button>
                                </Tooltip>
                              }
                            >
                              <button
                                type="button"
                                className="tw:flex tw:w-full tw:min-w-0 tw:items-center tw:gap-2 tw:bg-transparent tw:py-1 tw:text-left tw:text-inherit tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-app-accent tw:rounded-3"
                              >
                                <span className="tw:min-w-0 tw:truncate">{t(item.label)}</span>
                              </button>
                            </SidebarRow>
                          }
                        />
                      )
                    })}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          ) : null}
        </div>
        {otherItems.length > 0 ? (
          <>
            <div role="separator" className="tw:my-1 tw:w-5 tw:border-t tw:border-app-border" />
            <div
              role="group"
              aria-label={t('其他入口')}
              className="tw:flex tw:flex-col tw:items-center tw:gap-2"
            >
              {otherItems.map(destinationButton)}
            </div>
          </>
        ) : null}
      </ScrollArea>
      <div className="sidebar-rail-bottom tw:flex tw:w-full tw:flex-col tw:items-center tw:gap-1">
        <SidebarFooter
          compact
          onNavigate={shell.closePreview}
          onOpenWhatsNew={onOpenWhatsNew}
          onReport={onReport}
        />
      </div>
    </>
  )
}
