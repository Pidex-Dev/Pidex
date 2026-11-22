import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import React, { useCallback, useContext, useMemo, useRef, useState } from 'react'
import {
  Navigate,
  Route,
  Routes,
  UNSAFE_DataRouterContext,
  UNSAFE_DataRouterStateContext,
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
  UNSAFE_RouteContext,
  UNSAFE_createMemoryHistory,
  resolvePath,
  type NavigateOptions,
  type To,
} from 'react-router-dom'
import { Button } from '../../components/ui/Button.js'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from '../../components/ui/IconTokens.js'
import { useDialogFocusRestore } from '../../components/ui/UseDialogFocusRestore.js'
import { useExternalSubscription } from '../../hooks/UseExternalSubscription.js'
import { useMountEffect } from '../../hooks/UseMountEffect.js'
import type { DesktopInstalledSkill } from '../../../shared/Types.js'
import { useLocale } from '../i18n/LocaleProvider.js'
import {
  extractSettingsTab,
  isSettingsPath,
  normalizeSettingsDestination,
  setSettingsDialogActiveTab,
  subscribeSettingsDialogNavigation,
} from './SettingsDialogStore.js'
import { SettingsLayout } from './SettingsLayout.js'
import { SettingsNav } from './SettingsNav.js'

type Props = {
  open: boolean
  destination: string
  isRouteDeepLink?: boolean
  opener: HTMLElement | null
  workspacePath: string | null
  onUseSkill: (skill: DesktopInstalledSkill) => void
  onOpenJudgePanel?: () => void
  onClose: () => void
  onNavigateExternal: (to: To, options?: NavigateOptions) => void
}

const EMPTY_ROUTE_CONTEXT = {
  outlet: null,
  matches: [],
  isDataRoute: false,
}

export function SettingsDialog({
  open,
  destination,
  isRouteDeepLink = false,
  opener,
  workspacePath,
  onUseSkill,
  onOpenJudgePanel,
  onClose,
  onNavigateExternal,
}: Props): React.ReactNode {
  const { t } = useLocale()
  const contentRef = useRef<HTMLDivElement>(null)
  const { onCloseAutoFocus } = useDialogFocusRestore(open, opener)
  const normalizedInitial = useMemo(
    () => normalizeSettingsDestination(destination),
    [destination],
  )

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ui-dialog-backdrop permission-modal-backdrop settings-dialog-backdrop" />
        <Dialog.Content
          ref={contentRef}
          aria-describedby="settings-dialog-description"
          className="ui-dialog-surface ui-dialog-surface--centered settings-dialog"
          tabIndex={-1}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={(event) => {
            if (event.defaultPrevented) return
            const target = event.target
            if (
              target instanceof Element &&
              target.closest('[data-settings-escape-guard], [data-shortcut-recording="true"]')
            ) {
              event.preventDefault()
            }
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus({ preventScroll: true })
          }}
        >
          <Dialog.Title className="tw:sr-only">{t('设置')}</Dialog.Title>
          <Dialog.Description className="tw:sr-only" id="settings-dialog-description">
            {t('配置应用偏好、权限、集成与编码环境')}
          </Dialog.Description>
          {open ? (
            <SettingsDialogInner
              key={isRouteDeepLink ? `route:${normalizedInitial}` : 'overlay'}
              initialDestination={normalizedInitial}
              onClose={onClose}
              onNavigateExternal={onNavigateExternal}
              onOpenJudgePanel={onOpenJudgePanel}
              onUseSkill={onUseSkill}
              workspacePath={workspacePath}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

type InnerProps = {
  initialDestination: string
  workspacePath: string | null
  onUseSkill: (skill: DesktopInstalledSkill) => void
  onOpenJudgePanel?: () => void
  onClose: () => void
  onNavigateExternal: (to: To, options?: NavigateOptions) => void
}

function SettingsDialogInner({
  initialDestination,
  workspacePath,
  onUseSkill,
  onOpenJudgePanel,
  onClose,
  onNavigateExternal,
}: InnerProps): React.ReactNode {
  const { t } = useLocale()
  const parentNavigationContext = useContext(UNSAFE_NavigationContext)
  const [history] = useState(() =>
    UNSAFE_createMemoryHistory({
      initialEntries: [initialDestination],
      v5Compat: true,
    }),
  )
  const snapshotRef = useRef({
    action: history.action,
    location: history.location,
  })

  useMountEffect(() => {
    setSettingsDialogActiveTab(extractSettingsTab(history.location.pathname))
  })

  const subscribeRouter = useCallback(
    (onStoreChange: () => void) => {
      const unlistenHistory = history.listen((update) => {
        snapshotRef.current = {
          action: update.action,
          location: update.location,
        }
        setSettingsDialogActiveTab(extractSettingsTab(update.location.pathname))
        onStoreChange()
      })
      const unlistenExternalOpen = subscribeSettingsDialogNavigation((nextDestination) => {
        const currentDestination = `${history.location.pathname}${history.location.search}${history.location.hash}`
        if (nextDestination !== currentDestination) {
          history.push(nextDestination)
        }
      })
      return () => {
        unlistenHistory()
        unlistenExternalOpen()
      }
    },
    [history],
  )

  const getRouterSnapshot = useCallback(() => snapshotRef.current, [])
  const routerState = useExternalSubscription(subscribeRouter, getRouterSnapshot)

  const navigateInDialog = useCallback(
    (to: To, state?: unknown, options?: { replace?: boolean }) => {
      const resolved = resolvePath(to, history.location.pathname)
      const rawTarget = `${resolved.pathname}${resolved.search}${resolved.hash}`
      if (!isSettingsPath(resolved.pathname)) {
        onClose()
        onNavigateExternal(rawTarget, {
          state,
          replace: options?.replace ?? false,
        })
        return
      }
      const normalizedTarget = normalizeSettingsDestination(rawTarget)
      const currentTarget = `${history.location.pathname}${history.location.search}${history.location.hash}`
      if (normalizedTarget === currentTarget) return
      if (options?.replace) {
        history.replace(normalizedTarget, state)
      } else {
        history.push(normalizedTarget, state)
      }
    },
    [history, onClose, onNavigateExternal],
  )

  const navigator = useMemo(
    () => ({
      createHref: (to: To) => history.createHref(to),
      go: (delta: number) => {
        if (delta < 0 && history.index === 0) {
          onClose()
          return
        }
        history.go(delta)
      },
      push: (to: To, state?: unknown) => navigateInDialog(to, state, { replace: false }),
      replace: (to: To, state?: unknown) => navigateInDialog(to, state, { replace: true }),
    }),
    [history, navigateInDialog, onClose],
  )

  const navigationContextValue = useMemo(
    () => ({
      ...parentNavigationContext,
      basename: '/',
      navigator,
      static: false,
    }),
    [navigator, parentNavigationContext],
  )

  const locationContextValue = useMemo(
    () => ({
      location: routerState.location,
      navigationType: routerState.action,
    }),
    [routerState],
  )

  const activeTab = useMemo(
    () => extractSettingsTab(routerState.location.pathname),
    [routerState.location.pathname],
  )

  const handleTabChange = useCallback(
    (tabId: string) => {
      navigateInDialog(`/settings/${encodeURIComponent(tabId)}`)
    },
    [navigateInDialog],
  )

  return (
    <UNSAFE_DataRouterContext.Provider value={null}>
      <UNSAFE_DataRouterStateContext.Provider value={null}>
        <UNSAFE_RouteContext.Provider value={EMPTY_ROUTE_CONTEXT}>
          <UNSAFE_NavigationContext.Provider value={navigationContextValue}>
            <UNSAFE_LocationContext.Provider value={locationContextValue}>
              <div className="settings-dialog-body tw:flex tw:h-full tw:min-h-0 tw:w-full tw:min-w-0">
                <aside className="settings-dialog-sidebar">
                  <SettingsNav
                    activeTab={activeTab}
                    workspacePath={workspacePath}
                    onTabChange={handleTabChange}
                  />
                </aside>
                <div className="settings-dialog-main">
                  <Dialog.Close asChild>
                    <Button
                      isIconOnly
                      aria-label={t('关闭设置')}
                      className="settings-dialog-close"
                      color="ghostSecondary"
                      size="toolbar"
                      title={t('关闭设置')}
                    >
                      <X size={APP_ICON_SIZE} strokeWidth={APP_ICON_STROKE_WIDTH} />
                    </Button>
                  </Dialog.Close>
                  <Routes>
                    <Route
                      path="/settings/environment/:projectId"
                      element={
                        <SettingsLayout
                          workspacePath={workspacePath}
                          onUseSkill={onUseSkill}
                          onOpenJudgePanel={onOpenJudgePanel}
                        />
                      }
                    />
                    <Route
                      path="/settings/:tab"
                      element={
                        <SettingsLayout
                          workspacePath={workspacePath}
                          onUseSkill={onUseSkill}
                          onOpenJudgePanel={onOpenJudgePanel}
                        />
                      }
                    />
                    <Route path="/settings" element={<Navigate replace to="/settings/general" />} />
                    <Route path="*" element={<Navigate replace to="/settings/general" />} />
                  </Routes>
                </div>
              </div>
            </UNSAFE_LocationContext.Provider>
          </UNSAFE_NavigationContext.Provider>
        </UNSAFE_RouteContext.Provider>
      </UNSAFE_DataRouterStateContext.Provider>
    </UNSAFE_DataRouterContext.Provider>
  )
}
