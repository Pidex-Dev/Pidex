import type React from 'react'
import { RouterProvider } from 'react-router-dom'
import { router } from './Routes.js'
import { DesktopThemeProvider } from './features/theme/DesktopThemeProvider.js'
import { TooltipProvider } from './components/ui/Tooltip.js'
import { ButtonStyles } from './components/ui/Button.js'
import { AppContextMenu } from './components/ui/AppContextMenu.js'
import { EditCommandProvider } from './components/ui/EditCommandProvider.js'
import { Suspense, useState } from 'react'
import { useWindowEvent } from './hooks/UseExternalSubscription.js'
import { useEverOpened } from './hooks/UsePresenceRetention.js'
import { PageZoomCapsule } from './components/PageZoomCapsule.js'
import { PET_OVERLAY_HASH_PREFIX } from './startup/StartupSplashHandoff.js'
import { GlobalErrorModal } from './components/GlobalErrorModal.js'
import { fullErrorMessage } from './utils/Errors.js'

function isResizeObserverLoopError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return (
    message.includes('ResizeObserver loop completed with undelivered notifications.') ||
    message.includes('ResizeObserver loop limit exceeded')
  )
}

export function App(): React.ReactNode {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const errorModalMounted = useEverOpened(errorMessage !== null)
  const windowTarget = typeof window === 'undefined' ? null : window

  const showError = (error: unknown): void => {
    setErrorMessage(fullErrorMessage(error))
  }

  useWindowEvent(
    windowTarget,
    'error',
    (event) => {
      if (isResizeObserverLoopError(event.error) || isResizeObserverLoopError(event.message)) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      showError(event.error ?? event.message)
    },
    true,
  )

  useWindowEvent(
    windowTarget,
    'unhandledrejection',
    (event) => {
      if (isResizeObserverLoopError(event.reason)) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      showError(event.reason)
    },
    true,
  )

  useWindowEvent(windowTarget, 'desktop:error', (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null
    showError(detail)
  })

  return (
    <DesktopThemeProvider>
      <ButtonStyles />
      <TooltipProvider>
        <EditCommandProvider>
          <AppContextMenu
            actions={[]}
            layout="flex"
            size="md"
            trigger={
              <div className="app-global-context-menu-trigger">
                {errorModalMounted ? (
                  <Suspense fallback={null}>
                    <GlobalErrorModal
                      message={errorMessage}
                      onDismiss={() => setErrorMessage(null)}
                    />
                  </Suspense>
                ) : null}
                {window.location.hash.startsWith(PET_OVERLAY_HASH_PREFIX) ? null : (
                  <PageZoomCapsule />
                )}
                <RouterProvider router={router} />
              </div>
            }
          />
        </EditCommandProvider>
      </TooltipProvider>
    </DesktopThemeProvider>
  )
}
