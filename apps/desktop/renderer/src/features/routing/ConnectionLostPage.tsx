import type React from 'react'
import { useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Button } from '../../components/ui/Button.js'
import { FullScreenWhaleLoading } from '../../components/ui/FullScreenWhaleLoading.js'
import { useMountEffect } from '../../hooks/UseMountEffect.js'
import { desktopClient } from '../../services/desktop-client/index.js'
import { useStartupConnectionSnapshot } from '../../startup/StartupConnection.js'
import { startupSurfaceReadyRef } from '../../startup/StartupSplashHandoff.js'
import { WindowControls } from '../layout/MenuBar.js'

export const CONNECTION_LOST_ROUTE = '/connection-lost'
const DEFAULT_RETURN_TO = '/new'
const DEFAULT_RECONNECTING_LABEL = 'Agent 连接中断，正在重试…'

type ConnectionLostLocationState = {
  returnTo?: unknown
} | null

/** 解析断连前记录的回跳路径，防止跳回自身或无效目标。 */
export function resolveConnectionReturnTarget(state: unknown): string {
  if (!state || typeof state !== 'object') return DEFAULT_RETURN_TO
  const candidate = (state as ConnectionLostLocationState)?.returnTo
  if (typeof candidate !== 'string') return DEFAULT_RETURN_TO
  const trimmed = candidate.trim()
  if (!trimmed.startsWith('/')) return DEFAULT_RETURN_TO
  if (trimmed === CONNECTION_LOST_ROUTE || trimmed.startsWith(`${CONNECTION_LOST_ROUTE}?`)) {
    return DEFAULT_RETURN_TO
  }
  return trimmed
}

function resolveReconnectingLabel(label: string): string {
  const trimmed = label.trim()
  if (!trimmed || trimmed === '正在启动…') return DEFAULT_RECONNECTING_LABEL
  return trimmed
}

function resolveFailedHeading(label: string): string {
  const trimmed = label.trim()
  return trimmed || 'Agent 连接失败，请重试或查看日志'
}

export function RequireAgentConnection(): React.ReactNode {
  const connection = useStartupConnectionSnapshot()
  const location = useLocation()
  if (connection.state !== 'connected') {
    const returnTo = `${location.pathname}${location.search}${location.hash}`
    return <Navigate replace to={CONNECTION_LOST_ROUTE} state={{ returnTo }} />
  }
  return <Outlet />
}

export function ConnectionLostPage(): React.ReactNode {
  const connection = useStartupConnectionSnapshot()
  const location = useLocation()
  const [isMaximized, setIsMaximized] = useState(false)
  const [retryingGeneration, setRetryingGeneration] = useState<number | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)

  useMountEffect(() => {
    let mounted = true
    void desktopClient
      .isWindowMaximized()
      .then((value) => {
        if (mounted) setIsMaximized(value)
      })
      .catch(() => undefined)
    return () => {
      mounted = false
    }
  })

  if (connection.state === 'connected') {
    return <Navigate replace to={resolveConnectionReturnTarget(location.state)} />
  }

  const retrying = retryingGeneration === connection.generation && connection.state === 'failed'

  async function handleRetry(): Promise<void> {
    const bridge = window.DesktopBridge
    if (!bridge) {
      setRetryError('无法重试连接，请查看日志。')
      return
    }
    const generation = connection.generation
    setRetryingGeneration(generation)
    setRetryError(null)
    try {
      await bridge.retryStartup(generation)
    } catch {
      setRetryError('无法重试连接，请查看日志。')
    } finally {
      setRetryingGeneration((current) => (current === generation ? null : current))
    }
  }

  async function handleOpenLogs(): Promise<void> {
    const bridge = window.DesktopBridge
    if (!bridge) {
      setRetryError('无法打开日志目录。')
      return
    }
    try {
      await bridge.openLogDirectory()
    } catch {
      setRetryError('无法打开日志目录。')
    }
  }

  return (
    <div
      className="connection-lost-page tw:grid tw:h-screen tw:w-full tw:min-w-0 tw:grid-rows-[40px_minmax(0,1fr)] tw:overflow-hidden tw:bg-app-canvas tw:text-app-text"
      data-connection-state={connection.state}
      ref={startupSurfaceReadyRef}
    >
      <header className="connection-lost-titlebar tw:flex tw:h-chrome tw:[-webkit-app-region:drag] tw:min-w-0 tw:items-center tw:justify-between tw:border-b-[0.5px] tw:border-b-app-border-subtle tw:bg-app-titlebar">
        <span className="tw:ps-4 tw:text-app-text-soft tw:type-2 tw:weight-medium tw:tracking-[0.01em]">
          Pidex
        </span>
        <WindowControls
          isMaximized={isMaximized}
          onClose={() => void desktopClient.closeWindow()}
          onMinimize={() => void desktopClient.minimizeWindow()}
          onToggleMaximize={() => {
            void desktopClient.toggleWindowMaximized().then(setIsMaximized)
          }}
        />
      </header>

      <main className="tw:relative tw:flex tw:min-h-0 tw:w-full tw:min-w-0 tw:items-center tw:justify-center tw:overflow-auto tw:bg-app-canvas">
        {connection.state === 'failed' ? (
          <section
            className="tw:grid tw:w-full tw:min-w-0 tw:content-center tw:justify-items-center tw:gap-3 tw:p-5 tw:text-center"
            role="alert"
          >
            <span aria-hidden="true" className="tw:text-app-text-meta tw:type-7 tw:weight-bold">
              !
            </span>
            <h1 className="tw:m-0 tw:text-app-text tw:type-4 tw:weight-bold">
              {resolveFailedHeading(connection.label)}
            </h1>
            <p className="tw:m-0 tw:max-w-[440px] tw:text-app-text-soft tw:type-1">
              {retryError ?? '请尝试重新连接 Agent，或打开日志目录排查启动原因。'}
            </p>
            <div className="tw:mt-3 tw:flex tw:items-center tw:justify-center tw:gap-2">
              <Button color="primary" loading={retrying} onClick={() => void handleRetry()}>
                重试连接
              </Button>
              <Button color="secondary" onClick={() => void handleOpenLogs()}>
                打开日志
              </Button>
            </div>
          </section>
        ) : (
          <FullScreenWhaleLoading
            label={resolveReconnectingLabel(connection.label)}
            variant="contained"
          />
        )}
      </main>
    </div>
  )
}
