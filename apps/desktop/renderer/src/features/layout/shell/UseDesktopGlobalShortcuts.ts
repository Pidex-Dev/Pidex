import { useCallback, useEffect, useMemo, type RefObject } from 'react'
import type { AppPage } from '../../routing/PageDefinitions.js'
import { isTerminalKeyboardTarget } from './UseIntegratedTerminalController.js'
import { resolveSidebarEscapeAction } from '../SidebarShellState.js'
import { canRunAppCommand, type AppCommandId } from './AppCommandAvailability.js'

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null
}

function hasOpenDialog(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') !== null
}

type UseDesktopGlobalShortcutsOptions = {
  currentPage: AppPage | null
  hasWorkspace: boolean
  browserAvailable: boolean
  browserOpen: boolean
  sideChatSupported: boolean
  commandMenuOpen: boolean
  setCommandMenuOpen: (open: boolean) => void
  commandMenuInputRef: RefObject<HTMLInputElement | null>
  toggleIntegratedTerminal: () => void
  handleOpenFilesDock: () => void
  handleOpenReview: () => void
  handleOpenSideChat: () => void
  setSidebarTimelineEnabled: (updater: (current: boolean) => boolean) => void
  navigateBack: () => void
  navigateForward: () => void
  isSettingsRoute: boolean
  sidebarShellMode: Parameters<typeof resolveSidebarEscapeAction>[0]['mode']
  handleSettingsBack: () => void
}

export function useDesktopGlobalShortcuts({
  currentPage,
  hasWorkspace,
  browserAvailable,
  browserOpen,
  sideChatSupported,
  commandMenuOpen,
  setCommandMenuOpen,
  commandMenuInputRef,
  toggleIntegratedTerminal,
  handleOpenFilesDock,
  handleOpenReview,
  handleOpenSideChat,
  setSidebarTimelineEnabled,
  navigateBack,
  navigateForward,
  isSettingsRoute,
  sidebarShellMode,
  handleSettingsBack,
}: UseDesktopGlobalShortcutsOptions): void {
  const appCommandContext = useMemo(
    () => ({
      page: currentPage,
      hasWorkspace,
      browserAvailable,
      browserOpen,
      sideChatSupported,
    }),
    [browserAvailable, browserOpen, currentPage, hasWorkspace, sideChatSupported],
  )
  const canRunCommand = useCallback(
    (command: AppCommandId) => canRunAppCommand(command, appCommandContext),
    [appCommandContext],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.metaKey || event.repeat) return
      const key = event.key.toLowerCase()
      const commandShortcutAllowed =
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        !event.altKey &&
        (commandMenuOpen || !hasOpenDialog())
      if (commandShortcutAllowed && !event.shiftKey && event.code === 'Backquote') {
        if (!canRunCommand('toggleTerminal')) return
        event.preventDefault()
        toggleIntegratedTerminal()
        return
      }
      if (
        isTerminalKeyboardTarget(event.target) &&
        !(
          commandShortcutAllowed &&
          ((!event.shiftKey && key === 'k') || (event.shiftKey && key === 'p'))
        )
      )
        return
      if (
        commandShortcutAllowed &&
        ((!event.shiftKey && key === 'k') || (event.shiftKey && key === 'p'))
      ) {
        event.preventDefault()
        if (commandMenuOpen) {
          commandMenuInputRef.current?.focus()
          commandMenuInputRef.current?.select()
        } else {
          setCommandMenuOpen(true)
        }
      } else if (
        commandShortcutAllowed &&
        !event.shiftKey &&
        key === 'p' &&
        canRunCommand('openFiles')
      ) {
        event.preventDefault()
        setCommandMenuOpen(false)
        handleOpenFilesDock()
      } else if (
        event.shiftKey &&
        !event.altKey &&
        key === 'g' &&
        canRunCommand('openReview')
      ) {
        event.preventDefault()
        handleOpenReview()
      } else if (
        !event.shiftKey &&
        event.altKey &&
        key === 's' &&
        canRunCommand('openSideChat')
      ) {
        event.preventDefault()
        handleOpenSideChat()
      } else if (
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        !hasOpenDialog() &&
        !event.shiftKey &&
        event.altKey &&
        key === 'u'
      ) {
        event.preventDefault()
        setSidebarTimelineEnabled((current) => !current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    canRunCommand,
    commandMenuInputRef,
    commandMenuOpen,
    handleOpenFilesDock,
    handleOpenReview,
    handleOpenSideChat,
    setCommandMenuOpen,
    setSidebarTimelineEnabled,
    toggleIntegratedTerminal,
  ])

  useEffect(() => {
    const preventMouseNavigationDefault = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault()
      event.stopPropagation()
    }
    const handleMouseNavigation = (event: MouseEvent): void => {
      preventMouseNavigationDefault(event)
      if (event.button === 3) {
        navigateBack()
      } else if (event.button === 4) {
        navigateForward()
      }
    }

    window.addEventListener('mousedown', preventMouseNavigationDefault, true)
    window.addEventListener('mouseup', handleMouseNavigation, true)
    window.addEventListener('auxclick', preventMouseNavigationDefault, true)
    return () => {
      window.removeEventListener('mousedown', preventMouseNavigationDefault, true)
      window.removeEventListener('mouseup', handleMouseNavigation, true)
      window.removeEventListener('auxclick', preventMouseNavigationDefault, true)
    }
  }, [navigateBack, navigateForward])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const action = resolveSidebarEscapeAction({
        defaultPrevented: event.defaultPrevented,
        isDialogOpen: hasOpenDialog(),
        isSettingsRoute,
        isTextEntry: isTextEntryTarget(event.target),
        mode: sidebarShellMode,
      })
      if (action === 'none') return
      event.preventDefault()
      handleSettingsBack()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSettingsBack, isSettingsRoute, sidebarShellMode])
}
