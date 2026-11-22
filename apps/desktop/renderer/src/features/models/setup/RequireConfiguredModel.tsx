import { startupSurfaceReadyRef } from '../../../startup/StartupSplashHandoff.js'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '../../../components/ui/Button.js'
import { FullScreenWhaleLoading } from '../../../components/ui/FullScreenWhaleLoading.js'
import { useDialogFocusRestore } from '../../../components/ui/UseDialogFocusRestore.js'
import type { DesktopModelProviderSummary } from '../../../../shared/Types.js'
import { isExecutableDesktopProvider } from '../../../services/desktop-client/ProviderAdapters.js'
import type { ProviderConfigurationState } from '../../provider-management/Types.js'
import { providerManagementStore } from '../../provider-management/ProviderManagementStore.js'
import {
  useProviderManagementStore,
  useShallow,
} from '../../provider-management/UseProviderManagementStore.js'
import { useDesktopSettingsField } from '../../settings/UseDesktopSettings.js'

export type ModelSetupGateDecision = 'loading' | 'recovery' | 'setup' | 'workbench'

/**
 * 跨 Provider 判断是否存在可用任务模型：当前 Provider 已连接且有模型，
 * 或其他 Provider 已启用、可执行且认证可用。避免当前 Provider 不可用时误判为需要重新配置。
 */
export function hasUsableTaskModel(
  state: {
    apiKeyConfigured: boolean
    models: readonly string[]
  },
  providers: readonly DesktopModelProviderSummary[] = [],
): boolean {
  if (state.apiKeyConfigured === true && state.models.length > 0) return true
  return providers.some(
    (provider) => provider.apiKeyConfigured === true && isExecutableDesktopProvider(provider),
  )
}

export function resolveModelSetupGate(
  configuration: Pick<
    ProviderConfigurationState,
    'loaded' | 'configurationError' | 'currentProviderState' | 'providers'
  >,
  settings: {
    settingsLoaded: boolean
    firstUseSetupCompleted: 0 | 1 | undefined
  },
): ModelSetupGateDecision {
  if (!configuration.loaded || !settings.settingsLoaded) return 'loading'
  if (configuration.configurationError || !configuration.currentProviderState) return 'recovery'
  if (settings.firstUseSetupCompleted === 1) return 'workbench'
  return hasUsableTaskModel(configuration.currentProviderState, configuration.providers)
    ? 'workbench'
    : 'setup'
}

export function RequireConfiguredModel(): React.ReactNode {
  const location = useLocation()
  const navigate = useNavigate()
  const configuration = useProviderManagementStore(
    useShallow((state) => ({
      loaded: state.configuration.loaded,
      error: state.configuration.error,
      configurationError: state.configuration.configurationError,
      currentProviderState: state.configuration.currentProviderState,
      providers: state.configuration.providers,
    })),
  )
  const subscribedSettingsLoaded = useDesktopSettingsField((s) => s.settingsLoaded)
  const subscribedFirstUseSetupCompleted = useDesktopSettingsField((s) => s.firstUseSetupCompleted)
  const subscribedSaveFirstUseSetupCompleted = useDesktopSettingsField(
    (s) => s.saveFirstUseSetupCompleted,
  )
  const settings = useMemo(
    () => ({
      settingsLoaded: subscribedSettingsLoaded,
      firstUseSetupCompleted: subscribedFirstUseSetupCompleted,
      saveFirstUseSetupCompleted: subscribedSaveFirstUseSetupCompleted,
    }),
    [
      subscribedSettingsLoaded,
      subscribedFirstUseSetupCompleted,
      subscribedSaveFirstUseSetupCompleted,
    ],
  )
  const decision = resolveModelSetupGate(configuration, settings)
  const [setupDialogDismissed, setSetupDialogDismissed] = useState(false)
  const onProvidersRoute =
    location.pathname === '/providers' || location.pathname.startsWith('/providers/')

  useEffect(() => {
    if (decision !== 'setup' && setupDialogDismissed) {
      setSetupDialogDismissed(false)
    }
    if (
      !settings.settingsLoaded ||
      !configuration.loaded ||
      configuration.configurationError ||
      !configuration.currentProviderState
    ) {
      return
    }
    const usable = hasUsableTaskModel(configuration.currentProviderState, configuration.providers)
    if (usable && settings.firstUseSetupCompleted !== 1) {
      void Promise.resolve(settings.saveFirstUseSetupCompleted?.(1)).catch(() => undefined)
      return
    }
    if (!usable && settings.firstUseSetupCompleted === undefined) {
      void Promise.resolve(settings.saveFirstUseSetupCompleted?.(0)).catch(() => undefined)
    }
  }, [
    decision,
    setupDialogDismissed,
    settings.firstUseSetupCompleted,
    settings.saveFirstUseSetupCompleted,
    settings.settingsLoaded,
    configuration.configurationError,
    configuration.currentProviderState,
    configuration.providers,
    configuration.loaded,
  ])

  const handleDismissGuide = useCallback(() => {
    setSetupDialogDismissed(true)
    void Promise.resolve(settings.saveFirstUseSetupCompleted?.(1)).catch(() => undefined)
  }, [settings.saveFirstUseSetupCompleted])

  const handleGoToProviders = useCallback(() => {
    navigate('/providers')
  }, [navigate])

  if (decision === 'loading') {
    return (
      <SetupBootState
        label={resolveModelSetupLoadingLabel(configuration.loaded, settings.settingsLoaded)}
      />
    )
  }
  if (decision === 'recovery') {
    return (
      <SetupRecoveryState
        message={configuration.configurationError ?? configuration.error}
        onRetry={() => void providerManagementStore.refresh()}
      />
    )
  }
  return (
    <>
      <Outlet />
      {decision === 'setup' && !onProvidersRoute && !setupDialogDismissed ? (
        <ModelSetupGuideDialog
          open
          onDismiss={handleDismissGuide}
          onGoToProviders={handleGoToProviders}
        />
      ) : null}
    </>
  )
}

function ModelSetupGuideDialog({
  open,
  onDismiss,
  onGoToProviders,
}: {
  open: boolean
  onDismiss: () => void
  onGoToProviders: () => void
}): React.ReactNode {
  const { onCloseAutoFocus } = useDialogFocusRestore(open)

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onDismiss()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ui-dialog-backdrop" />
        <Dialog.Content
          className="ui-dialog-surface ui-dialog-surface--centered tw:grid tw:w-[min(26rem,calc(100vw-2rem))] tw:gap-4 tw:p-5"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <header className="tw:flex tw:flex-col tw:gap-1">
            <Dialog.Title asChild>
              <h2 className="tw:type-5 tw:weight-bold tw:m-0 tw:text-app-text">先配置一个模型</h2>
            </Dialog.Title>
            <Dialog.Description asChild>
              <p className="tw:type-1 tw:m-0 tw:text-app-text-soft">
                配置模型后即可开始编写代码、分析项目或执行自动化任务。
              </p>
            </Dialog.Description>
          </header>
          <div className="tw:mt-2 tw:flex tw:items-center tw:justify-end tw:gap-3">
            <Dialog.Close asChild>
              <Button size="md" color="secondary">
                稍后
              </Button>
            </Dialog.Close>
            <Button size="md" color="primary" onClick={onGoToProviders}>
              前往供应商市场
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function resolveModelSetupLoadingLabel(
  providerLoaded: boolean,
  settingsLoaded: boolean,
): string {
  if (!providerLoaded) return '正在读取模型配置…'
  if (!settingsLoaded) return '正在读取桌面设置…'
  return '正在准备模型设置…'
}

export function SetupBootState({ label }: { label: string }): React.ReactNode {
  return <FullScreenWhaleLoading label={label} />
}

export function SetupRecoveryState({
  message,
  onRetry,
}: {
  message: string | null
  onRetry: () => void
}): React.ReactNode {
  return (
    <main
      className="tw:grid tw:h-screen tw:w-full tw:place-content-center tw:justify-items-center tw:gap-5 tw:bg-app-canvas tw:p-6 tw:text-center"
      ref={startupSurfaceReadyRef}
    >
      <div className="tw:max-w-md">
        <h1 className="tw:type-5 tw:weight-bold tw:m-0 tw:text-app-text">本地 Agent 暂时不可用</h1>
        <p className="tw:mt-2 tw:mb-0 tw:text-app-text-soft">
          {message || '无法读取供应商配置。请确认 Agent 已启动，然后重试。'}
        </p>
      </div>
      <Button color="secondary" onClick={onRetry}>
        重试
      </Button>
    </main>
  )
}
