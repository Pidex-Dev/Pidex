import React, { useMemo, useState } from 'react'
import {
  useDesktopSettingsDraftActions,
  useDesktopSettingsDraftDirty,
  useDesktopSettingsDraftSaving,
  useDesktopSettingsDraftValue,
} from './UseDesktopSettings.js'
import {
  permissionConfigForSelection,
  permissionPresetViewForConfig,
} from './PermissionPresetView.js'
import type { DesktopPermissionMode, DesktopShellSecurityLevel } from '../../../shared/Types.js'
import { SettingsContentArea } from './SettingsContentArea.js'
import { SettingsDropdown } from './SettingsDropdown.js'
import { createSettingsTargetId } from './SettingsRegistry.js'
import { SettingsRow } from './SettingsRow.js'
import { SettingsSection } from './SettingsSection.js'
import { FullAccessConfirmationDialog } from '../session/approvals/FullAccessConfirmationDialog.js'
import { ApprovalRulesPanel } from '../session/approvals/ApprovalManagement.js'

type PermissionsSettingsProps = {
  workspacePath?: string | null
}

/** Consolidated settings page for permission presets, shell safety and approval rules. */
export function PermissionsSettings({
  workspacePath = null,
}: PermissionsSettingsProps = {}): React.ReactNode {
  const subscribedDraftActions = useDesktopSettingsDraftActions()
  const subscribedPermissionConfig = useDesktopSettingsDraftValue('permissionConfig')
  const subscribedShellSecurityLevel = useDesktopSettingsDraftValue('shellSecurityLevel')
  const subscribedLastActiveWorkspacePath = useDesktopSettingsDraftValue('lastActiveWorkspacePath')
  const subscribedDraftDirty = useDesktopSettingsDraftDirty()
  const subscribedDraftSaving = useDesktopSettingsDraftSaving()
  const draft = useMemo(
    () => ({
      ...subscribedDraftActions,
      values: {
        permissionConfig: subscribedPermissionConfig,
        shellSecurityLevel: subscribedShellSecurityLevel,
        lastActiveWorkspacePath: subscribedLastActiveWorkspacePath,
      },
      dirty: subscribedDraftDirty,
      saving: subscribedDraftSaving,
    }),
    [
      subscribedDraftActions,
      subscribedPermissionConfig,
      subscribedShellSecurityLevel,
      subscribedLastActiveWorkspacePath,
      subscribedDraftDirty,
      subscribedDraftSaving,
    ],
  )
  const [pendingFullAccess, setPendingFullAccess] = useState(false)
  const permissionView = permissionPresetViewForConfig(draft.values.permissionConfig)
  const effectiveWorkspacePath = workspacePath?.trim()
    ? workspacePath.trim()
    : draft.values.lastActiveWorkspacePath || null

  const applyPermissionPreset = (selection: DesktopPermissionMode): void => {
    draft.setValue('permissionConfig', permissionConfigForSelection(selection))
    draft.autoSave()
  }

  return (
    <>
      <SettingsContentArea className="" innerProps={{ id: createSettingsTargetId('permissions') }}>
        <div className="settings-page-header tw:mt-0 tw:mx-0 tw:mb-6 tw:grid tw:gap-2">
          <h2 className="settings-page-title tw:m-0 tw:type-6 tw:weight-bold tw:text-app-text">
            权限
          </h2>
          <p className="settings-page-description tw:m-0 tw:text-app-text-soft tw:type-2">
            统一管理权限预设、审批规则与 Shell 安全级别。
          </p>
        </div>

        <SettingsSection title="权限模式">
          <SettingsRow
            id={createSettingsTargetId('permissions', '权限预设')}
            title="权限预设"
            description={
              <>
                当前为「{permissionView.label}」：{permissionView.detail}
                {permissionView.unavailableReason ? (
                  <>
                    <br />
                    {permissionView.unavailableReason}
                  </>
                ) : null}
              </>
            }
            control={
              <SettingsDropdown
                size="md"
                ariaLabel="权限预设"
                value={permissionView.selection}
                options={permissionView.options.map((option) => ({
                  value: option.value,
                  label: option.label,
                  detail: option.detail,
                  disabled: option.disabled,
                }))}
                onChange={(value) => {
                  const mode = value as DesktopPermissionMode
                  if (mode === 'full-access' && permissionView.selection !== 'full-access') {
                    setPendingFullAccess(true)
                    return
                  }
                  applyPermissionPreset(mode)
                }}
              />
            }
          />
          <SettingsRow
            id={createSettingsTargetId('permissions', '权限说明')}
            title="权限说明"
            description="「帮我批准」下工作区外访问、联网和风险操作由 Guardian 审查，高风险仍由你确认；「完全访问」直接执行常规操作，但命中审批规则时仍会按规则拦截或弹出人工确认。宿主 Shell 始终在本机执行，Pidex 不提供 OS 沙箱或网络隔离。"
          />
        </SettingsSection>

        <SettingsSection title="Shell 安全">
          <SettingsRow
            id={createSettingsTargetId('permissions', 'Shell 安全级别')}
            title="Shell 安全级别"
            description="调整宿主 Shell 的静态风险处理，不改变文件或网络权限范围；「完全访问」下常规命令直接放行，但仍受审批规则约束。"
            control={
              <SettingsDropdown
                size="md"
                ariaLabel="Shell 安全级别"
                value={draft.values.shellSecurityLevel}
                options={[
                  {
                    value: 'strict',
                    label: '严格',
                    detail: '更多高风险特征直接拒绝，适合陌生仓库',
                  },
                  {
                    value: 'balanced',
                    label: '平衡',
                    detail: '灾难级行为拒绝，可疑项转审批（推荐）',
                  },
                  {
                    value: 'relaxed',
                    label: '宽松',
                    detail: '保留不可绕过底线，其余高风险尽量转审批',
                  },
                ]}
                onChange={(value) => {
                  draft.setValue('shellSecurityLevel', value as DesktopShellSecurityLevel)
                  draft.autoSave()
                }}
              />
            }
          />
        </SettingsSection>

        <div id={createSettingsTargetId('permissions', '审批规则')}>
          <SettingsSection
            title="审批规则"
            description="管理全局（用户）和当前工作区（项目）规则。规则优先级：拒绝优先于询问，询问优先于允许；命中拒绝或询问规则时，即使处于「完全访问」也会生效。"
          >
            <ApprovalRulesPanel workspacePath={effectiveWorkspacePath} />
          </SettingsSection>
        </div>
      </SettingsContentArea>
      <FullAccessConfirmationDialog
        actionLabel="确认"
        open={pendingFullAccess}
        title="启用「完全访问」预设？"
        onAction={() => {
          setPendingFullAccess(false)
          applyPermissionPreset('full-access')
        }}
        onCancel={() => {
          setPendingFullAccess(false)
        }}
      />
    </>
  )
}
