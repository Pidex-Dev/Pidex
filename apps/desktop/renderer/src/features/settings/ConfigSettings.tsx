import { useMemo } from 'react'
import React, { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { APP_ICON_SIZE } from '../../components/ui/IconTokens.js'
import { CONFIG_UPDATED_EVENT, desktopClient } from '../../services/desktop-client/index.js'
import {
  useDesktopSettingsField,
  useDesktopSettingsDraftActions,
  useDesktopSettingsDraftValue,
  useDesktopSettingsDraftDirty,
  useDesktopSettingsDraftSaving,
} from './UseDesktopSettings.js'
import type {
  DesktopConfigReadResult,
  DesktopConfigProfileListResult,
} from '../../../shared/Types.js'
import { SettingsRow } from './SettingsRow.js'
import { SettingsSection } from './SettingsSection.js'
import { SettingsDropdown } from './SettingsDropdown.js'
import { SpecializedModelSelect } from './SpecializedModelSelect.js'
import { SettingsContentArea } from './SettingsContentArea.js'
import { Button } from '../../components/ui/Button.js'

export function ConfigSettings(): React.ReactNode {
  const subscribedModel = useDesktopSettingsField((s) => s.model)
  const settings = useMemo(() => ({ model: subscribedModel }), [subscribedModel])
  const subscribedDraftActions = useDesktopSettingsDraftActions()
  const subscribedLastActiveWorkspacePath = useDesktopSettingsDraftValue('lastActiveWorkspacePath')
  const subscribedGenerationModel = useDesktopSettingsDraftValue('generationModel')
  const subscribedOrganizationModel = useDesktopSettingsDraftValue('organizationModel')
  const subscribedCodingModel = useDesktopSettingsDraftValue('codingModel')
  const subscribedDraftDirty = useDesktopSettingsDraftDirty()
  const subscribedDraftSaving = useDesktopSettingsDraftSaving()
  const draft = useMemo(
    () => ({
      ...subscribedDraftActions,
      values: {
        lastActiveWorkspacePath: subscribedLastActiveWorkspacePath,
        generationModel: subscribedGenerationModel,
        organizationModel: subscribedOrganizationModel,
        codingModel: subscribedCodingModel,
      },
      dirty: subscribedDraftDirty,
      saving: subscribedDraftSaving,
    }),
    [
      subscribedDraftActions,
      subscribedLastActiveWorkspacePath,
      subscribedGenerationModel,
      subscribedOrganizationModel,
      subscribedCodingModel,
      subscribedDraftDirty,
      subscribedDraftSaving,
    ],
  )
  const [promptPreview, setPromptPreview] = useState<string | null>(null)
  const [configRead, setConfigRead] = useState<DesktopConfigReadResult | null>(null)
  const [configLayer, setConfigLayer] = useState<'user' | 'profile' | 'project'>('user')
  const [configProfiles, setConfigProfiles] = useState<DesktopConfigProfileListResult | null>(null)
  const configCwd = draft.values.lastActiveWorkspacePath || undefined

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
      <SettingsContentArea className="">
        <div className="settings-content-inner tw:@container tw:w-full tw:min-w-0 tw:mx-auto tw:p-5 tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-6)*2)]">
          <div className="settings-page-header tw:mt-0 tw:mx-0 tw:mb-6 tw:grid tw:gap-2">
            <h2 className="settings-page-title tw:m-0 tw:type-6 tw:weight-bold tw:text-app-text">
              配置
            </h2>
            <p className="settings-page-desc tw:m-0 tw:max-w-[68ch] tw:text-app-text-soft tw:type-1">
              配置审批策略和命令执行范围。
            </p>
          </div>

          <SettingsSection>
            <SettingsSection.Header
              title="智能体默认设置"
              description="选择配置 Profile、配置层并打开对应的配置文件；权限设置已移至「权限」页。"
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
                      .catch((error) =>
                        window.alert(error instanceof Error ? error.message : String(error)),
                      )
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
                  description="关闭所有 Pidex 桌面端和 CLI/TUI 后重新打开，新的 Profile 才会应用；当前任务不会被切换。"
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
                        window.alert(error instanceof Error ? error.message : String(error))
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

          <SettingsSection
            title="专用模型"
            description="按用途为辅助能力选择模型；留空时使用上面的会话主模型。"
          >
            <SettingsRow
              title="生成模型"
              description="用于任务建议和会话标题生成与更新。"
              control={
                <SpecializedModelSelect
                  value={draft.values.generationModel}
                  mainModel={settings.model}
                  specializedModelKey="generationModel"
                  onChange={(v) => {
                    draft.setValue('generationModel', v)
                    draft.autoSave()
                  }}
                />
              }
            />
            <SettingsRow
              title="整理模型"
              description="用于记忆提取和任务上下文整理。"
              control={
                <SpecializedModelSelect
                  value={draft.values.organizationModel}
                  mainModel={settings.model}
                  specializedModelKey="organizationModel"
                  onChange={(v) => {
                    draft.setValue('organizationModel', v)
                    draft.autoSave()
                  }}
                />
              }
            />
            <SettingsRow
              title="代码模型"
              description="用于计划实施和 AI 代码审查。"
              control={
                <SpecializedModelSelect
                  value={draft.values.codingModel}
                  mainModel={settings.model}
                  specializedModelKey="codingModel"
                  onChange={(v) => {
                    draft.setValue('codingModel', v)
                    draft.autoSave()
                  }}
                />
              }
            />
          </SettingsSection>
        </div>
      </SettingsContentArea>
    </>
  )
}
