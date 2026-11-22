import React, { useCallback, useContext, useEffect, useState, useRef } from 'react'
import { UNSAFE_NavigationContext } from 'react-router-dom'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { APP_ICON_SIZE } from '../../components/ui/IconTokens.js'
import { useWindowEvent } from '../../hooks/UseExternalSubscription.js'
import { useMountEffect } from '../../hooks/UseMountEffect.js'
import { CONFIG_UPDATED_EVENT, desktopClient } from '../../services/desktop-client/index.js'
import {
  useDesktopSettingsDraftActions,
  useDesktopSettingsDraftValue,
} from './UseDesktopSettings.js'
import type {
  DesktopConfigReadResult,
  DesktopConfigProfileListResult,
  DesktopModelProviderSummary,
  ModelProviderID,
} from '../../../shared/Types.js'
import { SettingsRow } from './SettingsRow.js'
import { SettingsSection } from './SettingsSection.js'
import { SettingsDropdown } from './SettingsDropdown.js'
import { createSettingsTargetId } from './SettingsRegistry.js'
import {
  SpecializedModelSelect,
  loadSpecializedModelProviders,
  refreshSpecializedProviderInList,
  type SpecializedModelKey,
} from './SpecializedModelSelect.js'
import { SettingsContentArea } from './SettingsContentArea.js'
import { Button } from '../../components/ui/Button.js'

const SPECIALIZED_MODEL_ROWS: ReadonlyArray<{
  key: SpecializedModelKey
  title: string
  description: string
}> = [
  {
    key: 'generationModel',
    title: '生成模型',
    description: '用于任务建议、会话标题生成与更新、输入预测和 Git 提交信息。',
  },
  {
    key: 'organizationModel',
    title: '整理模型',
    description: '用于记忆提取和任务上下文整理。',
  },
  {
    key: 'codingModel',
    title: '代码模型',
    description: '用于计划实施和 AI 代码审查。',
  },
  {
    key: 'securityModel',
    title: '安全模型（实验）',
    description: '用于 Shell 和工具权限自动审核。',
  },
]

type ConfigSettingsProps = {
  onError?: (message: string) => void
}

export function ConfigSettings({ onError }: ConfigSettingsProps = {}): React.ReactNode {
  const navigationContext = useContext(UNSAFE_NavigationContext)
  const navigator = navigationContext?.navigator
  const draftActions = useDesktopSettingsDraftActions()
  const lastActiveWorkspacePath = useDesktopSettingsDraftValue('lastActiveWorkspacePath')
  const generationModel = useDesktopSettingsDraftValue('generationModel')
  const organizationModel = useDesktopSettingsDraftValue('organizationModel')
  const codingModel = useDesktopSettingsDraftValue('codingModel')
  const securityModel = useDesktopSettingsDraftValue('securityModel')
  const specializedModelValues: Record<SpecializedModelKey, string> = {
    generationModel,
    organizationModel,
    codingModel,
    securityModel,
  }

  const [providers, setProviders] = useState<DesktopModelProviderSummary[]>([])
  const mountedRef = useRef(true)
  const [promptPreview, setPromptPreview] = useState<string | null>(null)
  const [configRead, setConfigRead] = useState<DesktopConfigReadResult | null>(null)
  const [configLayer, setConfigLayer] = useState<'user' | 'profile' | 'project'>('user')
  const [configProfiles, setConfigProfiles] = useState<DesktopConfigProfileListResult | null>(null)
  const configCwd = lastActiveWorkspacePath || undefined
  const reportError = (error: unknown) => {
    onError?.(error instanceof Error ? error.message : String(error))
  }

  const reloadProviders = useCallback(async () => {
    try {
      const next = await loadSpecializedModelProviders()
      if (mountedRef.current) setProviders(next)
    } catch {
      if (mountedRef.current) setProviders([])
    }
  }, [])

  useMountEffect(() => {
    mountedRef.current = true
    void reloadProviders()
    return () => {
      mountedRef.current = false
    }
  })

  useWindowEvent(
    typeof window === 'undefined' ? null : window,
    'desktop:model-provider-changed',
    () => {
      void reloadProviders()
    },
  )

  const handleProviderOpen = useCallback(
    (providerID: ModelProviderID) => {
      void refreshSpecializedProviderInList(providers, providerID)
        .then((next) => {
          if (mountedRef.current && next) setProviders(next)
        })
        .catch(() => {})
    },
    [providers],
  )

  const readConfigState = async () => {
    const read = await desktopClient.readConfig({
      includeLayers: true,
      ...(configCwd ? { cwd: configCwd } : {}),
    })
    const profiles = await desktopClient.listConfigProfiles().catch(() => null)
    return { read, profiles }
  }

  const reloadConfig = async () => {
    const { read, profiles } = await readConfigState()
    setConfigRead(read)
    setConfigProfiles(profiles)
    if (configLayer === 'project' && !read.layers?.some((layer) => layer.kind === 'project')) {
      setConfigLayer('user')
    }
    if (configLayer === 'profile' && !read.layers?.some((layer) => layer.kind === 'profile')) {
      setConfigLayer('user')
    }
  }

  useEffect(() => {
    let mounted = true
    void readConfigState()
      .then(({ read, profiles }) => {
        if (mounted) {
          setConfigRead(read)
          setConfigProfiles(profiles)
        }
      })
      .catch(() => {
        if (mounted) {
          setConfigRead(null)
        }
      })
    return () => {
      mounted = false
    }
  }, [configCwd])

  useEffect(() => {
    const refresh = () => void reloadConfig().catch(() => undefined)
    window.addEventListener(CONFIG_UPDATED_EVENT, refresh)
    return () => window.removeEventListener(CONFIG_UPDATED_EVENT, refresh)
  })

  const selectedConfigLayer = configRead?.layers?.find((layer) => layer.kind === configLayer)

  return (
    <>
      <SettingsContentArea
        className=""
        innerProps={{ id: createSettingsTargetId('config') }}
      >
          <div className="settings-page-header tw:mt-0 tw:mx-0 tw:mb-6 tw:grid tw:gap-2">
            <h2 className="settings-page-title tw:m-0 tw:type-6 tw:weight-bold tw:text-app-text">
              配置
            </h2>
            <p className="settings-page-desc tw:m-0 tw:max-w-[68ch] tw:text-app-text-soft tw:type-1">
              管理专用模型、配置 Profile、配置文件与提示词诊断。
            </p>
          </div>

          <SettingsSection
            title="专用模型"
            description="按用途为辅助能力指定专用模型；未指定时默认跟随当前会话模型。"
          >
            {SPECIALIZED_MODEL_ROWS.map((item) => (
              <SettingsRow
                key={item.key}
                id={createSettingsTargetId('config', item.title)}
                title={item.title}
                description={item.description}
                control={
                  <SpecializedModelSelect
                    value={specializedModelValues[item.key]}
                    specializedModelKey={item.key}
                    providers={providers}
                    onProviderOpen={handleProviderOpen}
                    onOpenModelSettings={navigator ? () => navigator.push('/providers') : undefined}
                    onChange={(nextValue) => {
                      draftActions.setValue(item.key, nextValue)
                      draftActions.autoSave()
                    }}
                  />
                }
              />
            ))}
          </SettingsSection>

          <SettingsSection>
            <SettingsSection.Header
              title="配置文件与 Profile"
              description="选择配置 Profile、配置层并打开对应的配置文件。"
            />
            <div className="config-settings-source-toolbar tw:mb-3 tw:flex tw:min-w-0 tw:items-center tw:justify-between tw:gap-3 tw:max-[600px]:flex-col tw:max-[600px]:items-start">
              <div className="config-settings-source-controls tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:max-[600px]:w-full tw:max-[600px]:flex-wrap">
                <SettingsDropdown
                  size="sm"
                  ariaLabel="活动 Profile"
                  disabled={!configProfiles}
                  value={configRead?.profileState.selectedProfile ?? ''}
                  options={[
                    { value: '', label: '基础配置' },
                    ...(configProfiles?.profiles ?? []).map((profile) => ({
                      value: profile.id,
                      label: profile.displayName,
                      detail: profile.valid ? profile.description : '配置无效',
                      disabled: !profile.valid,
                    })),
                  ]}
                  onChange={(value) => {
                    void desktopClient
                      .selectConfigProfile(value || null)
                      .then(() => reloadConfig())
                      .catch(reportError)
                  }}
                />
                <SettingsDropdown
                  size="sm"
                  ariaLabel="配置层"
                  value={configLayer}
                  options={[
                    { value: 'user', label: '用户配置' },
                    ...(configRead?.layers?.some((layer) => layer.kind === 'profile')
                      ? [{ value: 'profile', label: '活动 Profile' }]
                      : []),
                    ...(configRead?.layers?.some((layer) => layer.kind === 'project')
                      ? [{ value: 'project', label: '项目配置' }]
                      : []),
                  ]}
                  onChange={(value) => setConfigLayer(value as 'user' | 'profile' | 'project')}
                />
              </div>
              <div className="config-settings-source-actions tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:max-[600px]:w-full tw:max-[600px]:flex-wrap">
                <Button
                  color="secondary"
                  type="button"
                  disabled={!configProfiles?.profilesDirectory}
                  onClick={() => {
                    if (configProfiles?.profilesDirectory) {
                      void desktopClient.openPathWithDefaultTarget(configProfiles.profilesDirectory)
                    }
                  }}
                >
                  <ExternalLink className="tw:size-icon-md" size={APP_ICON_SIZE} />
                  打开 Profiles 目录
                </Button>
                <Button
                  color="secondary"
                  type="button"
                  disabled={!selectedConfigLayer?.filePath}
                  onClick={() => {
                    if (selectedConfigLayer?.filePath) {
                      void desktopClient.openPathWithDefaultTarget(selectedConfigLayer.filePath)
                    }
                  }}
                >
                  <ExternalLink className="tw:size-icon-md" size={APP_ICON_SIZE} />
                  打开配置文件
                </Button>
              </div>
            </div>
            {configRead?.profileState.restartRequired ? (
              <SettingsSection.Content>
                <SettingsRow
                  title="Profile 等待重启"
                  description="关闭并重新打开 Pidex 后，新的 Profile 才会生效；当前进行中的任务不会被切换。"
                  control={<span className="settings-row-status">待重启</span>}
                />
              </SettingsSection.Content>
            ) : null}
          </SettingsSection>

          <SettingsSection title="诊断">
            {configRead?.diagnostics.map((diagnostic) => (
              <SettingsRow
                key={`${diagnostic.scope}:${diagnostic.code}`}
                title={diagnostic.code}
                description={
                  <span>
                    <AlertTriangle className="tw:size-icon-md" size={APP_ICON_SIZE} />{' '}
                    {diagnostic.message}
                  </span>
                }
              />
            ))}
            <SettingsRow
              title="完整提示词诊断"
              description="仅在你主动请求时读取当前任务的 system/developer/contextual-user sections、来源、hash、token 估算和缓存分类；内容不会写入日志或遥测。"
              control={
                <Button
                  color="secondary"
                  type="button"
                  onClick={() =>
                    void (async () => {
                      try {
                        const sessionId = await desktopClient.getActiveSessionId()
                        if (!sessionId) throw new Error('当前没有活动任务')
                        const preview = await desktopClient.getSessionPromptPreview(sessionId)
                        setPromptPreview(JSON.stringify(preview, null, 2))
                      } catch (error) {
                        reportError(error)
                      }
                    })()
                  }
                >
                  预览当前任务提示词
                </Button>
              }
            />
            {promptPreview ? (
              <div
                aria-label="当前任务完整提示词"
                className="config-settings-prompt-preview tw:max-h-[min(32rem,60vh)] tw:overflow-auto tw:border-t-[0.5px] tw:border-t-app-border tw:p-4"
                role="region"
              >
                <pre className="settings-code-block tw:m-0 tw:min-w-max tw:whitespace-pre tw:text-app-text-soft tw:type-code">
                  {promptPreview}
                </pre>
              </div>
            ) : null}
          </SettingsSection>
      </SettingsContentArea>
    </>
  )
}
