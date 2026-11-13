import * as Dialog from '@radix-ui/react-dialog'
import { Copy, FolderOpen, Lightbulb, MoreHorizontal, Sparkles, Trash2, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { DesktopInstalledSkill } from '../../../../shared/Types.js'
import { Button } from '../../../components/ui/Button.js'
import { ConfirmationDialog } from '../../../components/ui/ConfirmationDialog.js'
import { PopoverItem } from '../../../components/ui/PopoverItem.js'
import { PopoverMenu } from '../../../components/ui/PopoverMenu.js'
import { ToggleSwitch } from '../../../components/ui/ToggleSwitch.js'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from '../../../components/ui/IconTokens.js'
import { readRuntimeSkill, setRuntimeSkillEnabled } from './SkillClientAdapter.js'
import { useLastNonNull } from '../../../hooks/UsePresenceRetention.js'
import {
  BuiltinSkillIcon,
  getBuiltinSkillPresentation,
  isBuiltinSkill,
} from '../../plugins/BuiltinSkillPresentation.js'
import { desktopClient, desktopClipboard } from '../../../services/desktop-client/index.js'
import { MarkdownMessage } from '../../markdown/MarkdownMessage.js'
import { errorMessageOr as errorMessageOf } from '@pidex/shared/errors'

export type SkillDetailsDialogProps = {
  workspacePath: string | null
  skill: DesktopInstalledSkill | null
  open: boolean
  restoreFocusElement?: HTMLElement | null
  onOpenChange: (open: boolean) => void
  onOpenSkill?: (skill: DesktopInstalledSkill) => void
  onUseSkill: (skill: DesktopInstalledSkill) => void
  onToggleEnabled?: (skill: DesktopInstalledSkill, enabled: boolean) => Promise<void> | void
  onUninstall?: (skill: DesktopInstalledSkill) => Promise<void> | void
  onError: (message: string) => void
  onNotice?: (message: string) => void
}

export function SkillDetailsDialog({
  workspacePath,
  skill: currentSkill,
  open,
  restoreFocusElement,
  onOpenChange,
  onOpenSkill,
  onUseSkill,
  onToggleEnabled,
  onUninstall,
  onError,
  onNotice,
}: SkillDetailsDialogProps): React.ReactNode {
  const retainedSkill = useLastNonNull(currentSkill)
  const skill = open ? currentSkill : retainedSkill
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const onErrorRef = useRef(onError)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [uninstallBusy, setUninstallBusy] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [toggleBusy, setToggleBusy] = useState(false)
  const [enabled, setEnabled] = useState(skill?.enabled ?? false)

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    if (skill) {
      setEnabled(skill.enabled)
    }
  }, [skill?.enabled])

  useEffect(() => {
    if (!open || !skill) return
    let cancelled = false
    setLoading(true)
    setContent('')
    setError(null)
    readRuntimeSkill(workspacePath, skill.path)
      .then((result) => {
        if (!cancelled) setContent(result.content)
      })
      .catch((readError) => {
        if (cancelled) return
        const message = errorMessageOf(readError, '技能详情读取失败。')
        setError(message)
        onErrorRef.current(message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, skill, workspacePath])

  if (!skill) return null
  const presentation = getBuiltinSkillPresentation(skill)
  const builtin =
    isBuiltinSkill(skill) ||
    skill.path.startsWith('builtin://') ||
    skill.scope === 'system' ||
    skill.source === 'system'
  const canUninstall = !builtin

  const handleToggle = async (nextEnabled: boolean) => {
    setToggleBusy(true)
    try {
      if (onToggleEnabled) {
        await onToggleEnabled(skill, nextEnabled)
      } else {
        await setRuntimeSkillEnabled(skill.path, nextEnabled)
      }
      setEnabled(nextEnabled)
      onNotice?.(nextEnabled ? `已启用技能 “${skill.name}”。` : `已禁用技能 “${skill.name}”。`)
    } catch (err) {
      onErrorRef.current(errorMessageOf(err, '切换技能状态失败。'))
    } finally {
      setToggleBusy(false)
    }
  }

  const handleConfirmUninstall = async () => {
    setUninstallBusy(true)
    try {
      if (onUninstall) {
        await onUninstall(skill)
      } else if (skill.path.startsWith('plugin://')) {
        const match = skill.path.match(/^plugin:\/\/([^/]+)/)
        if (match?.[1]) {
          await desktopClient.uninstallPlugin(match[1])
        }
      }
      setConfirmUninstall(false)
      onNotice?.(`已成功卸载技能 “${skill.name}”。`)
      onOpenChange(false)
    } catch (err) {
      onErrorRef.current(errorMessageOf(err, '卸载技能失败。'))
    } finally {
      setUninstallBusy(false)
    }
  }

  const handleOpenPath = () => {
    setMoreOpen(false)
    if (onOpenSkill) {
      onOpenSkill(skill)
    } else {
      void desktopClient.openPathWithDefaultTarget(skill.path).catch((openErr) => {
        onErrorRef.current(errorMessageOf(openErr, '无法打开技能文件。'))
      })
    }
  }

  const handleCopyPath = () => {
    setMoreOpen(false)
    void desktopClipboard.writeText(skill.path)
    onNotice?.('已复制技能路径到剪贴板。')
  }

  const handleUse = () => {
    onUseSkill(skill)
    onOpenChange(false)
  }

  const iconNode = presentation ? (
    <BuiltinSkillIcon className="" size={18} skill={skill} />
  ) : (
    <Lightbulb size={20} strokeWidth={APP_ICON_STROKE_WIDTH} />
  )

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="ui-dialog-backdrop permission-modal-backdrop" />
          <Dialog.Content
            className="ui-dialog-surface ui-dialog-surface--centered settings-management-dialog tw:flex tw:flex-col tw:overflow-hidden tw:p-6 tw:rounded-2xl tw:w-[min(640px,calc(100vw-32px))] tw:max-h-[85vh] tw:border tw:border-app-border-subtle tw:bg-app-panel tw:text-app-text tw:shadow-2xl"
            onCloseAutoFocus={(event) => {
              if (!restoreFocusElement?.isConnected) return
              event.preventDefault()
              restoreFocusElement.focus()
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              closeRef.current?.focus()
            }}
          >
            {/* 顶部栏：左侧图标，右侧开关、更多、关闭 */}
            <div className="tw:flex tw:items-center tw:justify-between tw:shrink-0">
              <span
                aria-hidden="true"
                className="tw:flex tw:size-10 tw:shrink-0 tw:items-center tw:justify-center tw:rounded-full tw:border tw:border-app-border-subtle tw:bg-app-canvas/80 tw:text-app-text-soft"
              >
                {iconNode}
              </span>
              <div className="tw:flex tw:items-center tw:gap-3">
                <ToggleSwitch
                  ariaLabel={`启用 ${skill.name} 技能`}
                  checked={enabled}
                  disabled={toggleBusy}
                  onChange={(checked) => void handleToggle(checked)}
                />
                <PopoverMenu
                  open={moreOpen}
                  onOpenChange={setMoreOpen}
                  trigger={
                    <Button
                      isIconOnly
                      color="ghostSecondary"
                      size="toolbar"
                      title="更多选项"
                    >
                      <MoreHorizontal
                        aria-hidden="true"
                        size={APP_ICON_SIZE}
                        strokeWidth={APP_ICON_STROKE_WIDTH}
                      />
                    </Button>
                  }
                >
                  {!builtin ? (
                    <PopoverItem
                      icon={<FolderOpen size={14} />}
                      onClick={handleOpenPath}
                    >
                      在资源管理器中显示
                    </PopoverItem>
                  ) : null}
                  <PopoverItem
                    icon={<Copy size={14} />}
                    onClick={handleCopyPath}
                  >
                    复制文件路径
                  </PopoverItem>
                </PopoverMenu>
                <Dialog.Close asChild>
                  <Button
                    isIconOnly
                    color="ghostSecondary"
                    ref={closeRef}
                    size="toolbar"
                    title="关闭弹层"
                  >
                    <X
                      aria-hidden="true"
                      size={APP_ICON_SIZE}
                      strokeWidth={APP_ICON_STROKE_WIDTH}
                    />
                  </Button>
                </Dialog.Close>
              </div>
            </div>

            {/* 中间：标题和类型 */}
            <div className="tw:mt-4 tw:flex tw:items-baseline tw:gap-2.5 tw:min-w-0 tw:shrink-0">
              <Dialog.Title className="tw:m-0 tw:type-page-title tw:text-app-text tw:truncate">
                {skill.name}
              </Dialog.Title>
              <span className="tw:type-body-lg tw:text-app-text-soft tw:shrink-0">
                Skill
              </span>
            </div>

            {/* 下方：描述 */}
            <Dialog.Description className="tw:mt-1.5 tw:mb-0 tw:type-body-sm tw:text-app-text-soft tw:shrink-0 tw:line-clamp-3">
              {skill.description || skill.shortDescription || '未提供技能说明。'}
            </Dialog.Description>

            {/* 再下方：正文（暗色背景圆角卡片，渲染 Markdown） */}
            <div className="tw:mt-4 tw:min-h-0 tw:w-full tw:max-w-full tw:flex-1 tw:overflow-y-auto tw:overflow-x-hidden tw:rounded-xl tw:border tw:border-app-border-subtle tw:bg-app-canvas tw:p-4 tw:type-body-sm">
              {loading ? (
                <p className="tw:type-body-sm tw:m-0 tw:text-app-text-soft" role="status">
                  正在读取技能内容…
                </p>
              ) : error ? (
                <div
                  className="tw:type-body-sm tw:border tw:border-app-danger tw:bg-app-panel tw:p-3 tw:text-app-danger tw:rounded-container"
                  role="alert"
                >
                  {error}
                </div>
              ) : (
                <MarkdownMessage allowWideBlocks={false} text={content} />
              )}
            </div>

            {/* 最下方：卸载和立即试用 */}
            <footer className="tw:mt-4 tw:flex tw:items-center tw:justify-between tw:shrink-0 tw:pt-1">
              {canUninstall ? (
                <Button
                  color="danger"
                  shape="pill"
                  size="md"
                  disabled={uninstallBusy}
                  onClick={() => setConfirmUninstall(true)}
                >
                  <Trash2
                    aria-hidden="true"
                    size={APP_ICON_SIZE}
                    strokeWidth={APP_ICON_STROKE_WIDTH}
                  />
                  卸载
                </Button>
              ) : (
                <div />
              )}
              <Button
                color="primary"
                shape="pill"
                size="md"
                disabled={!enabled}
                onClick={handleUse}
              >
                <Sparkles
                  aria-hidden="true"
                  size={APP_ICON_SIZE}
                  strokeWidth={APP_ICON_STROKE_WIDTH}
                />
                立即试用
              </Button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmationDialog
        actionLabel="卸载"
        actionDisabled={uninstallBusy}
        tone="danger"
        description={`确定要卸载技能 “${skill.name}” 吗？此操作不可逆。`}
        onAction={() => void handleConfirmUninstall()}
        onCancel={() => setConfirmUninstall(false)}
        open={confirmUninstall}
        title={`卸载 ${skill.name}？`}
      />
    </>
  )
}
