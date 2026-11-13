import type { ProtocolCapability } from '@pidex/agent-protocol'
import { normalizeDesktopStoredSettings } from '../../../shared/SettingsSchema.js'
import {
  isNewerDesktopThemeSettingsVersion,
  normalizeDesktopThemeSettings,
} from '../../../shared/Theme.js'
import type { DesktopApi, DesktopStoredSettings } from '../../../shared/Types.js'
import type { createAgentRpcClient } from '../AgentRpcClient.js'
import type { DesktopClient, DesktopClientEnvironment } from './Types.js'

type ConfigSettingsApiMethod =
  | 'readConfig'
  | 'writeConfigBatch'
  | 'listConfigProfiles'
  | 'selectConfigProfile'
  | 'getDesktopSettings'
  | 'getThemeSettings'
  | 'saveThemeSettings'
  | 'canRestorePreviousAppearance'
  | 'restorePreviousAppearance'
  | 'applyNewDesignTheme'
  | 'saveDesktopSettings'

type ConfigSettingsApi = Pick<DesktopClient, ConfigSettingsApiMethod>

type Dependencies = {
  environment: DesktopClientEnvironment
  mockClient: Pick<DesktopApi, ConfigSettingsApiMethod>
  requireAgentCapability: (
    name: Extract<ProtocolCapability, 'config.manage.v1' | 'config.profiles.v1'>,
  ) => void
  rpc: Pick<ReturnType<typeof createAgentRpcClient>, 'call'>
  withAgentOrMock: <T>(
    agentOperation: () => Promise<T>,
    mockOperation: () => Promise<T>,
  ) => Promise<T>
}

export function createAgentConfigSettingsApi({
  environment,
  mockClient,
  requireAgentCapability,
  rpc,
  withAgentOrMock,
}: Dependencies): ConfigSettingsApi {
  const pendingDesktopSettingsSaves = new Map<string, Promise<DesktopStoredSettings>>()
  let desktopSettingsSaveTail: Promise<void> = Promise.resolve()

  function queueDesktopSettingsSave(
    settings: DesktopStoredSettings,
  ): Promise<DesktopStoredSettings> {
    const normalized = normalizeDesktopStoredSettings(settings)
    const fingerprint = JSON.stringify(normalized)
    const pending = pendingDesktopSettingsSaves.get(fingerprint)
    if (pending) return pending

    const operation = desktopSettingsSaveTail
      .catch(() => undefined)
      .then(async () => {
        const saver = environment.window?.DesktopBridge?.saveDesktopSettings
        if (!saver) return mockClient.saveDesktopSettings(normalized)
        const saved = normalizeDesktopStoredSettings(await saver(normalized))
        await mockClient.saveDesktopSettings(saved)
        return saved
      })
    desktopSettingsSaveTail = operation.then(
      () => undefined,
      () => undefined,
    )
    pendingDesktopSettingsSaves.set(fingerprint, operation)
    const clearPending = () => {
      if (pendingDesktopSettingsSaves.get(fingerprint) === operation) {
        pendingDesktopSettingsSaves.delete(fingerprint)
      }
    }
    void operation.then(clearPending, clearPending)
    return operation
  }

  return {
    readConfig: (params) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('config.manage.v1')
          return rpc.call('config/read', params ?? {})
        },
        () => mockClient.readConfig(params),
      ),
    writeConfigBatch: (params) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('config.manage.v1')
          return rpc.call('config/batchWrite', params)
        },
        () => mockClient.writeConfigBatch(params),
      ),
    listConfigProfiles: () =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('config.profiles.v1')
          return rpc.call('config/profile/list', {})
        },
        () => mockClient.listConfigProfiles(),
      ),
    selectConfigProfile: (profileId) =>
      withAgentOrMock(
        async () => {
          requireAgentCapability('config.profiles.v1')
          return rpc.call('config/profile/select', { profileId })
        },
        () => mockClient.selectConfigProfile(profileId),
      ),
    getDesktopSettings: async () => {
      const getter = environment.window?.DesktopBridge?.getDesktopSettings
      return getter
        ? normalizeDesktopStoredSettings(await getter())
        : mockClient.getDesktopSettings()
    },
    getThemeSettings: async () => {
      try {
        requireAgentCapability('config.manage.v1')
        const result = await rpc.call('config/read', {})
        const desktop =
          result.config.desktop &&
          typeof result.config.desktop === 'object' &&
          !Array.isArray(result.config.desktop)
            ? (result.config.desktop as Record<string, unknown>)
            : {}
        if (isNewerDesktopThemeSettingsVersion(desktop.appearance)) {
          throw new Error('外观设置版本高于当前客户端支持版本，已拒绝降级读取。')
        }
        if (
          desktop.appearance &&
          typeof desktop.appearance === 'object' &&
          !Array.isArray(desktop.appearance)
        ) {
          return normalizeDesktopThemeSettings(desktop.appearance)
        }
      } catch {
        // The initial Electron value remains the upgrade fallback until Agent migration completes.
      }
      const getter = environment.window?.DesktopBridge?.getAppearanceSettings
      return getter ? getter().then(normalizeDesktopThemeSettings) : mockClient.getThemeSettings()
    },
    saveThemeSettings: async (settings) => {
      const normalized = normalizeDesktopThemeSettings(settings)
      try {
        requireAgentCapability('config.manage.v1')
        const current = await rpc.call('config/read', { includeLayers: true })
        const currentDesktop =
          current.config.desktop &&
          typeof current.config.desktop === 'object' &&
          !Array.isArray(current.config.desktop)
            ? (current.config.desktop as Record<string, unknown>)
            : null
        if (isNewerDesktopThemeSettingsVersion(currentDesktop?.appearance)) {
          throw new Error('外观设置版本高于当前客户端支持版本，已拒绝降级保存。')
        }
        const version = current.layers?.find((layer) => layer.kind === 'user')?.version
        const flatten = (
          value: Record<string, unknown>,
          prefix: string[],
        ): Array<{ keyPath: string[]; value: never }> =>
          Object.entries(value).flatMap(([key, child]) =>
            child && typeof child === 'object' && !Array.isArray(child)
              ? flatten(child as Record<string, unknown>, [...prefix, key])
              : [{ keyPath: [...prefix, key], value: child as never }],
          )
        await rpc.call('config/batchWrite', {
          edits: flatten(normalized as unknown as Record<string, unknown>, [
            'desktop',
            'appearance',
          ]),
          ...(version ? { expectedVersion: version } : {}),
        })
      } catch (error) {
        if (
          environment.window?.DesktopBridge &&
          (!error ||
            typeof error !== 'object' ||
            !('code' in error) ||
            error.code !== 'AGENT_OPERATION_UNSUPPORTED')
        ) {
          throw error
        }
      }
      const saver = environment.window?.DesktopBridge?.saveAppearanceSettings
      if (saver) {
        await saver(normalized)
        await mockClient.saveThemeSettings(normalized)
        return
      }
      await mockClient.saveThemeSettings(normalized)
    },
    canRestorePreviousAppearance: async () => {
      const checker = environment.window?.DesktopBridge?.canRestorePreviousAppearance
      if (checker) {
        return checker()
      }
      return mockClient.canRestorePreviousAppearance()
    },
    restorePreviousAppearance: async () => {
      const restorer = environment.window?.DesktopBridge?.restorePreviousAppearance
      if (restorer) {
        const restored = await restorer()
        const normalized = normalizeDesktopThemeSettings(restored)
        await mockClient.saveThemeSettings(normalized)
        return normalized
      }
      return mockClient.restorePreviousAppearance()
    },
    applyNewDesignTheme: async () => {
      const applier = environment.window?.DesktopBridge?.applyNewDesignTheme
      if (applier) {
        const applied = await applier()
        const normalized = normalizeDesktopThemeSettings(applied)
        await mockClient.saveThemeSettings(normalized)
        return normalized
      }
      return mockClient.applyNewDesignTheme()
    },
    saveDesktopSettings: queueDesktopSettingsSave,
  }
}
