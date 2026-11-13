import { useMemo, useState, type ReactNode } from 'react'
import { SettingsRow } from '../settings/SettingsRow.js'
import { SettingsSection } from '../settings/SettingsSection.js'
import {
  isSettingsSaveShortcut,
  useDesktopSettingsDraftActions,
  useDesktopSettingsDraftValue,
  useDesktopSettingsDraftDirty,
  useDesktopSettingsDraftSaving,
} from '../settings/UseDesktopSettings.js'
import { Input } from '../../components/ui/Input.js'
import { ToggleSwitch } from '../../components/ui/ToggleSwitch.js'
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog.js'
import { InfoTooltip } from '../../components/ui/InfoTooltip.js'

export function WorktreePreferences({
  onError,
}: {
  onError: (message: string) => void
}): ReactNode {
  const subscribedDraftActions = useDesktopSettingsDraftActions()
  const subscribedWorktreeRoot = useDesktopSettingsDraftValue('worktreeRoot')
  const subscribedWorktreeFetchUpstream = useDesktopSettingsDraftValue('worktreeFetchUpstream')
  const subscribedGitAutoDeleteWorktree = useDesktopSettingsDraftValue('gitAutoDeleteWorktree')
  const subscribedGitAutoDeleteWorktreeLimit = useDesktopSettingsDraftValue(
    'gitAutoDeleteWorktreeLimit',
  )
  const subscribedGitConfirmDeleteWorktree = useDesktopSettingsDraftValue('gitConfirmDeleteWorktree')
  const subscribedDraftDirty = useDesktopSettingsDraftDirty()
  const subscribedDraftSaving = useDesktopSettingsDraftSaving()

  const { draft } = useMemo(
    () => ({
      draft: {
        ...subscribedDraftActions,
        values: {
          worktreeRoot: subscribedWorktreeRoot,
          worktreeFetchUpstream: subscribedWorktreeFetchUpstream,
          gitAutoDeleteWorktree: subscribedGitAutoDeleteWorktree,
          gitAutoDeleteWorktreeLimit: subscribedGitAutoDeleteWorktreeLimit,
          gitConfirmDeleteWorktree: subscribedGitConfirmDeleteWorktree,
        },
        dirty: subscribedDraftDirty,
        saving: subscribedDraftSaving,
      },
    }),
    [
      subscribedDraftActions,
      subscribedWorktreeRoot,
      subscribedWorktreeFetchUpstream,
      subscribedGitAutoDeleteWorktree,
      subscribedGitAutoDeleteWorktreeLimit,
      subscribedGitConfirmDeleteWorktree,
      subscribedDraftDirty,
      subscribedDraftSaving,
    ],
  )

  const {
    worktreeRoot,
    worktreeFetchUpstream,
    gitAutoDeleteWorktree,
    gitAutoDeleteWorktreeLimit,
    gitConfirmDeleteWorktree,
  } = draft.values

  const [confirmDisable, setConfirmDisable] = useState(false)
  const [limit, setLimit] = useState<string | null>(null)

  const save = async (keys: Parameters<typeof draft.saveFields>[0]) => {
    try {
      await draft.saveFields(keys)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '保存工作树设置失败')
    }
  }

  const saveLimit = () => {
    if (limit === null) return
    const value = Number(limit.trim())
    setLimit(null)
    if (!limit.trim() || !Number.isFinite(value)) return
    draft.setValue('gitAutoDeleteWorktreeLimit', Math.max(1, Math.min(100, Math.trunc(value))))
    void save(['gitAutoDeleteWorktreeLimit'])
  }

  return (
    <div
      onKeyDown={(event) => {
        if (isSettingsSaveShortcut(event)) {
          event.preventDefault()
          saveLimit()
          void save(['worktreeRoot'])
        }
      }}
    >
      <SettingsSection title="创建与清理">
        <SettingsRow
          title="工作树根目录"
          description="留空以使用默认位置"
          control={
            <Input
              aria-label="工作树根目录"
              className="tw:w-80 tw:max-w-full"
              value={worktreeRoot}
              placeholder="留空以使用默认位置"
              onChange={(event) => draft.setValue('worktreeRoot', event.target.value)}
              onBlur={() => void save(['worktreeRoot'])}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void save(['worktreeRoot'])
              }}
            />
          }
        />
        <SettingsRow
          title="创建工作树前始终获取上游更新"
          control={
            <ToggleSwitch
              checked={worktreeFetchUpstream}
              ariaLabel="创建工作树前始终获取上游更新"
              onChange={(value) => {
                draft.setValue('worktreeFetchUpstream', value)
                void save(['worktreeFetchUpstream'])
              }}
            />
          }
        />
        <SettingsRow
          title="自动删除旧工作树"
          description={
            <span className="tw:inline-flex tw:items-center tw:gap-1">
              先保存一份恢复快照
              <InfoTooltip
                content="工作树在自动删除前会自动创建恢复快照，防止本地修改丢失。"
                side="top"
              />
            </span>
          }
          control={
            <ToggleSwitch
              checked={gitAutoDeleteWorktree}
              ariaLabel="自动删除旧工作树"
              onChange={(value) => {
                if (!value) setConfirmDisable(true)
                else {
                  draft.setValue('gitAutoDeleteWorktree', true)
                  void save(['gitAutoDeleteWorktree'])
                }
              }}
            />
          }
        />
        <SettingsRow
          title="保留的工作树数量"
          description="较旧的工作树会自动删除。已置顶或进行中的聊天所用的工作树会保留。"
          control={
            <Input
              aria-label="保留的工作树数量"
              type="number"
              className="tw:w-20 tw:text-center"
              min={1}
              max={100}
              step={1}
              disabled={!gitAutoDeleteWorktree}
              value={limit ?? gitAutoDeleteWorktreeLimit}
              onChange={(event) => setLimit(event.target.value)}
              onBlur={saveLimit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveLimit()
              }}
            />
          }
        />
        <SettingsRow
          title="删除工作树前询问"
          control={
            <ToggleSwitch
              checked={gitConfirmDeleteWorktree}
              ariaLabel="删除工作树前询问"
              onChange={(value) => {
                draft.setValue('gitConfirmDeleteWorktree', value)
                void save(['gitConfirmDeleteWorktree'])
              }}
            />
          }
        />
      </SettingsSection>
      <ConfirmationDialog
        open={confirmDisable}
        title="关闭自动删除工作树？"
        description="旧工作树将持续占用磁盘空间，需要你自行管理。"
        actionLabel="关闭自动删除"
        onCancel={() => setConfirmDisable(false)}
        onAction={() => {
          draft.setValue('gitAutoDeleteWorktree', false)
          setConfirmDisable(false)
          void save(['gitAutoDeleteWorktree'])
        }}
      />
    </div>
  )
}
