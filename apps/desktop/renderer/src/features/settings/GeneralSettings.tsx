import { useMemo } from 'react'
import { desktopClient, loadDesktopTerminalClient } from '../../services/desktop-client/index.js'
import React, { useCallback, useEffect, useState } from 'react'
import { OpenTargetIcon } from '../../components/ui/OpenTargetIcon.js'
import { OPEN_TARGET_STORED_SENTINELS } from '../../services/desktop-client/OpenTargetSelection.js'
import { ToggleSwitch } from '../../components/ui/ToggleSwitch.js'
import { SettingsRow } from './SettingsRow.js'
import { SettingsSection } from './SettingsSection.js'
import { SettingsDropdown } from './SettingsDropdown.js'
import { SegmentedControl } from '../../components/ui/SegmentedControl.js'
import {
  useDesktopSettingsDraftActions,
  useDesktopSettingsDraftValue,
} from './UseDesktopSettings.js'
import { SettingsContentArea } from './SettingsContentArea.js'
import type {
  DesktopOpenTarget,
  DesktopReviewDelivery,
  DesktopReviewView,
} from '../../../shared/Types.js'
import type { DesktopTerminalProfile } from '@pidex/shared/desktop-terminal-ipc'
import { useLocale } from '../i18n/LocaleProvider.js'

const FALLBACK_OPEN_TARGETS: DesktopOpenTarget[] = [
  {
    id: 'file-explorer',
    label: 'File Explorer',
    kind: 'file-explorer',
  },
]

const LANGUAGE_OPTIONS = [
  { value: 'system', label: '跟随系统' },
  { value: 'zh-CN', label: '中文（中国）' },
  { value: 'en-US', label: 'English (US)' },
]

const REVIEW_OPTIONS: Array<{ value: DesktopReviewView; label: string }> = [
  { value: 'inline', label: '行内视图' },
  { value: 'split', label: '分离视图' },
]
const REVIEW_DELIVERY_OPTIONS: Array<{
  value: DesktopReviewDelivery
  label: string
}> = [
  { value: 'inline', label: '当前任务' },
  { value: 'detached', label: '独立任务' },
]

function renderOpenTargetIcon(target: DesktopOpenTarget): React.ReactNode {
  return (
    <OpenTargetIcon
      className="settings-open-target-icon tw:size-icon tw:shrink-0 tw:rounded-3 tw:object-contain"
      kind={target.kind}
      targetId={target.id}
    />
  )
}

export function GeneralSettings() {
  const { t } = useLocale()
  const subscribedDraftActions = useDesktopSettingsDraftActions()
  const subscribedLanguage = useDesktopSettingsDraftValue('language')
  const subscribedNotifications = useDesktopSettingsDraftValue('notifications')
  const contextUsageView = useDesktopSettingsDraftValue('contextUsageView')
  const subscribedShowContextUsage = useDesktopSettingsDraftValue('showContextUsage')
  const subscribedDefaultOpenTargetId = useDesktopSettingsDraftValue('defaultOpenTargetId')
  const subscribedTerminalProfileId = useDesktopSettingsDraftValue('terminalProfileId')
  const subscribedReviewView = useDesktopSettingsDraftValue('reviewView')
  const subscribedReviewDelivery = useDesktopSettingsDraftValue('reviewDelivery')
  const subscribedComposerPredictions = useDesktopSettingsDraftValue('desktop.composer_predictions')
  const subscribedDefaultModeRequestUserInput = useDesktopSettingsDraftValue(
    'defaultModeRequestUserInput',
  )
  const { draft } = useMemo(
    () => ({
      draft: {
        ...subscribedDraftActions,
        values: {
          language: subscribedLanguage,
          notifications: subscribedNotifications,
          showContextUsage: subscribedShowContextUsage,
          defaultOpenTargetId: subscribedDefaultOpenTargetId,
          terminalProfileId: subscribedTerminalProfileId,
          reviewView: subscribedReviewView,
          reviewDelivery: subscribedReviewDelivery,
          'desktop.composer_predictions': subscribedComposerPredictions,
          defaultModeRequestUserInput: subscribedDefaultModeRequestUserInput,
        },
      },
    }),
    [
      subscribedDraftActions,
      subscribedLanguage,
      subscribedNotifications,
      subscribedShowContextUsage,
      subscribedDefaultOpenTargetId,
      subscribedTerminalProfileId,
      subscribedReviewView,
      subscribedReviewDelivery,
      subscribedComposerPredictions,
      subscribedDefaultModeRequestUserInput,
    ],
  )
  const {
    showContextUsage,
    defaultOpenTargetId,
    terminalProfileId,
    reviewView,
    reviewDelivery,
    'desktop.composer_predictions': composerPredictions,
    defaultModeRequestUserInput,
    notifications,
  } = draft.values

  const [openTargets, setOpenTargets] = useState<DesktopOpenTarget[]>(FALLBACK_OPEN_TARGETS)
  const [openTargetsLoaded, setOpenTargetsLoaded] = useState(false)
  const [terminalProfiles, setTerminalProfiles] = useState<readonly DesktopTerminalProfile[]>([])
  const [terminalProfilesLoaded, setTerminalProfilesLoaded] = useState(false)
  const language = draft.values.language
  const setLanguage = useCallback(
    (value: string) => {
      if (value !== 'system' && value !== 'zh-CN' && value !== 'en-US') return
      draft.setValue('language', value)
      draft.autoSave()
    },
    [draft],
  )
  const setCompletionNotification = useCallback(
    (value: 'always' | 'unfocused' | 'never') => {
      draft.setValue('notifications', {
        ...draft.values.notifications,
        completion: value,
      })
      draft.autoSave()
    },
    [draft],
  )
  const setPermissionNotifications = useCallback(
    (value: boolean) => {
      draft.setValue('notifications', {
        ...draft.values.notifications,
        permissions: value,
      })
      draft.autoSave()
    },
    [draft],
  )
  const setQuestionNotifications = useCallback(
    (value: boolean) => {
      draft.setValue('notifications', {
        ...draft.values.notifications,
        questions: value,
      })
      draft.autoSave()
    },
    [draft],
  )
  const setErrorNotifications = useCallback(
    (value: boolean) => {
      draft.setValue('notifications', {
        ...draft.values.notifications,
        errors: value,
      })
      draft.autoSave()
    },
    [draft],
  )
  const setShowContextUsage = useCallback(
    (value: boolean) => {
      draft.setValue('showContextUsage', value)
      draft.autoSave()
    },
    [draft],
  )
  const setDefaultOpenTargetId = useCallback(
    (value: string) => {
      draft.setValue('defaultOpenTargetId', value)
      draft.autoSave()
    },
    [draft],
  )
  const setTerminalProfileId = useCallback(
    (value: string) => {
      draft.setValue('terminalProfileId', value === 'auto' ? null : value)
      draft.autoSave()
    },
    [draft],
  )
  const setReviewView = useCallback(
    (value: DesktopReviewView) => {
      draft.setValue('reviewView', value)
      draft.autoSave()
    },
    [draft],
  )
  const setReviewDelivery = useCallback(
    (value: DesktopReviewDelivery) => {
      draft.setValue('reviewDelivery', value)
      draft.autoSave()
    },
    [draft],
  )
  const setComposerPredictions = useCallback(
    (value: boolean) => {
      draft.setValue('desktop.composer_predictions', value)
      draft.autoSave()
    },
    [draft],
  )
  const setDefaultModeRequestUserInput = useCallback(
    (value: boolean) => {
      draft.setValue('defaultModeRequestUserInput', value)
      draft.autoSave()
    },
    [draft],
  )

  useEffect(() => {
    let mounted = true
    void desktopClient
      .listOpenTargets()
      .then((targets) => {
        if (!mounted) return
        const nextTargets = targets.length ? targets : FALLBACK_OPEN_TARGETS
        setOpenTargets(nextTargets)
        setOpenTargetsLoaded(true)
      })
      .catch(() => {
        if (mounted) {
          setOpenTargets(FALLBACK_OPEN_TARGETS)
          setOpenTargetsLoaded(true)
        }
      })
    return () => {
      mounted = false
    }
  }, [defaultOpenTargetId, setDefaultOpenTargetId])

  useEffect(() => {
    let mounted = true
    void loadDesktopTerminalClient()
      .then((client) => client.listTerminalProfiles())
      .then((profiles) => {
        if (!mounted) return
        setTerminalProfiles(profiles)
        setTerminalProfilesLoaded(true)
      })
      .catch(() => {
        if (!mounted) return
        setTerminalProfiles([])
        setTerminalProfilesLoaded(true)
      })
    return () => {
      mounted = false
    }
  }, [])

  const displayedOpenTargets =
    !openTargetsLoaded &&
    !openTargets.some((target) => target.id === defaultOpenTargetId) &&
    !(OPEN_TARGET_STORED_SENTINELS as readonly string[]).includes(defaultOpenTargetId)
      ? [
          ...openTargets,
          {
            id: defaultOpenTargetId,
            label: 'Loading...',
            kind: 'editor' as const,
          },
        ]
      : openTargets

  const openTargetOptions = displayedOpenTargets.map((target) => ({
    value: target.id,
    label: target.label,
    icon: renderOpenTargetIcon(target),
  }))
  const terminalProfileOptions = [
    { value: 'auto', label: '自动检测' },
    ...terminalProfiles.map((profile) => ({
      value: profile.id,
      label: profile.isDefault ? `${profile.label}（默认）` : profile.label,
      disabled: !profile.available,
    })),
    ...(terminalProfileId && !terminalProfiles.some((profile) => profile.id === terminalProfileId)
      ? [
          {
            value: terminalProfileId,
            label: terminalProfilesLoaded ? '已保存的 Shell（当前不可用）' : '正在加载…',
            disabled: true,
          },
        ]
      : []),
  ]
  return (
    <SettingsContentArea className="">
        <div className="settings-page-header tw:mt-0 tw:mx-0 tw:mb-6 tw:grid tw:gap-2">
          <h2 className="settings-page-title tw:m-0 tw:type-6 tw:weight-bold tw:text-app-text">
            常规
          </h2>
        </div>

        <SettingsSection title="常规">
          <SettingsRow
            title="默认打开目标"
            description="默认打开文件和文件夹的位置"
            control={
              <SettingsDropdown
                size="sm"
                value={defaultOpenTargetId}
                options={openTargetOptions}
                onChange={setDefaultOpenTargetId}
                ariaLabel="默认打开目标"
              />
            }
          />
          <SettingsRow
            title="集成终端 Shell"
            description="选择要在集成终端中打开的 Shell。"
            control={
              <SettingsDropdown
                size="sm"
                value={terminalProfileId ?? 'auto'}
                options={terminalProfileOptions}
                onChange={setTerminalProfileId}
                ariaLabel="集成终端 Shell"
              />
            }
          />
          <SettingsRow
            title={t('语言')}
            description={t('应用 UI 语言')}
            control={
              <SettingsDropdown
                size="md"
                value={language}
                options={LANGUAGE_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))}
                onChange={setLanguage}
                ariaLabel={t('语言')}
                searchable
                searchPlaceholder={t('搜索语言')}
              />
            }
          />
          <SettingsRow
            title="允许普通模式提问"
            description="开启后，主 Agent 可在普通模式中通过结构化问题卡向你提问。计划模式始终允许。"
            autoSave
            control={(aria) => (
              <ToggleSwitch
                checked={defaultModeRequestUserInput}
                onChange={setDefaultModeRequestUserInput}
                ariaLabelledby={aria.labelledby}
                ariaDescribedby={aria.describedby}
              />
            )}
          />
          <SettingsRow
            title="代码审查"
            description="审阅侧栏中 diff 的展示方式：行内视图（叠加显示）或分离视图（左右对照）"
            autoSave
            control={
              <SegmentedControl
                value={reviewView}
                options={REVIEW_OPTIONS}
                onChange={setReviewView}
              />
            }
          />
          <SettingsRow
            title="AI 审查结果"
            description="在当前任务继续审查，或为每次 AI Review 创建独立任务"
            autoSave
            control={
              <SegmentedControl
                value={reviewDelivery}
                options={REVIEW_DELIVERY_OPTIONS}
                onChange={setReviewDelivery}
              />
            }
          />
        </SettingsSection>

        <SettingsSection
          title="输入预测"
          description="根据当前对话预测下一条消息，以灰色文字显示在输入框内。"
        >
          <SettingsRow
            title="消息输入预测"
            description="启用后，每次回复完成后会调用模型生成一条灰字建议，按 Tab 接受、Esc 忽略。该功能会产生额外的模型调用和费用。"
            autoSave
            control={(aria) => (
              <ToggleSwitch
                checked={composerPredictions}
                onChange={(checked) => {
                  setComposerPredictions(checked)
                }}
                ariaLabelledby={aria.labelledby}
                ariaDescribedby={aria.describedby}
              />
            )}
          />
        </SettingsSection>

        <SettingsSection title="通知">
          <SettingsRow
            title="轮次完成通知"
            description="设置 Pidex 完成任务时是否显示系统通知"
            control={
              <SettingsDropdown
                size="md"
                value={notifications.completion}
                options={[
                  { value: 'always', label: '总是' },
                  { value: 'unfocused', label: '仅当应用失焦时' },
                  { value: 'never', label: '从不' },
                ]}
                onChange={setCompletionNotification}
                ariaLabel="轮次完成通知"
              />
            }
          />
          <SettingsRow
            title="启用权限通知"
            description="在需要额外权限时显示系统通知"
            control={(aria) => (
              <ToggleSwitch
                checked={notifications.permissions}
                onChange={setPermissionNotifications}
                ariaLabelledby={aria.labelledby}
                ariaDescribedby={aria.describedby}
              />
            )}
          />
          <SettingsRow
            title="启用问题通知"
            description="需要输入才能继续时显示系统通知"
            control={(aria) => (
              <ToggleSwitch
                checked={notifications.questions}
                onChange={setQuestionNotifications}
                ariaLabelledby={aria.labelledby}
                ariaDescribedby={aria.describedby}
              />
            )}
          />
          <SettingsRow
            title="启用任务错误通知"
            description="任务执行失败时显示系统通知"
            control={(aria) => (
              <ToggleSwitch
                checked={notifications.errors}
                onChange={setErrorNotifications}
                ariaLabelledby={aria.labelledby}
                ariaDescribedby={aria.describedby}
              />
            )}
          />
        </SettingsSection>

        <SettingsSection title="对话框底部栏">
          <SettingsRow
            title="显示上下文窗口使用量"
            description="在对话框底部栏显示上下文窗口使用量"
            autoSave
            control={(aria) => (
              <ToggleSwitch
                checked={showContextUsage}
                onChange={setShowContextUsage}
                ariaLabelledby={aria.labelledby}
                ariaDescribedby={aria.describedby}
              />
            )}
          />
          <SettingsRow
            title="上下文用量展示方式"
            description="选择用量浮层中的图形样式"
            autoSave
            control={() => (
              <SegmentedControl
                value={contextUsageView}
                ariaLabel="上下文用量展示方式"
                options={[
                  { value: 'bar', label: '分段条' },
                  { value: 'field', label: '点阵' },
                ]}
                onChange={(value) => {
                  draft.setValue('contextUsageView', value)
                  draft.autoSave()
                }}
              />
            )}
          />
        </SettingsSection>
    </SettingsContentArea>
  )
}
