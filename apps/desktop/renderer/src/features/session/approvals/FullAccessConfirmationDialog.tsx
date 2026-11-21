import type React from 'react'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { AlertTriangle, Folder, Globe, Terminal } from 'lucide-react'
import { Button } from '../../../components/ui/Button.js'
import { APP_ICON_SIZES, APP_ICON_STROKE_WIDTH } from '../../../components/ui/IconTokens.js'
import { useDialogFocusRestore } from '../../../components/ui/UseDialogFocusRestore.js'

type Props = {
  open: boolean
  title?: string
  intro?: string
  cancelLabel?: string
  actionLabel?: string
  actionDisabled?: boolean
  error?: string
  onCancel: () => void
  onAction: () => void
}

const DEFAULT_INTRO =
  '允许 Agent 在无需权限审批的情况下，在本机访问文件、使用互联网、执行命令及调用工具和 MCP。这包括但不限于：'

type CapabilityItem = {
  id: string
  title: string
  detail: string
  icon: React.ReactNode
}

const CAPABILITY_ITEMS: readonly CapabilityItem[] = [
  {
    id: 'files',
    title: '文件和文件夹',
    detail: '读取、创建、修改或删除本机任意位置的文件（不再限于工作区）',
    icon: (
      <Folder
        aria-hidden="true"
        className="tw:size-icon-lg tw:shrink-0 tw:text-app-accent-fg"
        data-icon-kind="artwork"
        fill="currentColor"
        size={APP_ICON_SIZES.lg}
        strokeWidth={1.5}
      />
    ),
  },
  {
    id: 'terminal',
    title: '终端命令与工具',
    detail: '直接在本机宿主环境执行命令、安装软件以及调用工具和 MCP',
    icon: (
      <span
        aria-hidden="true"
        className="tw:inline-flex tw:size-icon-lg tw:shrink-0 tw:items-center tw:justify-center tw:rounded-2 tw:bg-app-text-meta tw:text-app-raised"
      >
        <Terminal
          aria-hidden="true"
          data-icon-kind="artwork"
          size={APP_ICON_SIZES.sm}
          strokeWidth={2.3}
        />
      </span>
    ),
  },
  {
    id: 'network',
    title: '互联网与已连接的应用',
    detail: '访问网站、发送数据并使用已启用的插件或外部服务',
    icon: (
      <Globe
        aria-hidden="true"
        className="tw:size-icon-lg tw:shrink-0 tw:text-app-info"
        data-icon-kind="artwork"
        size={APP_ICON_SIZES.lg}
        strokeWidth={1.8}
      />
    ),
  },
]

/** Inner alert-dialog content for full-access confirmation. */
export function FullAccessConfirmationContent({
  open,
  title = '启用 Full Access？',
  intro = DEFAULT_INTRO,
  cancelLabel = '取消',
  actionLabel = '确认',
  actionDisabled = false,
  error,
  onAction,
}: Omit<Props, 'onCancel'>): React.ReactNode {
  const { onCloseAutoFocus } = useDialogFocusRestore(open)

  function handleActionClick(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault()
    onAction()
  }

  return (
    <AlertDialog.Content
      className="ui-dialog-surface ui-dialog-surface--centered permission-modal full-access-confirmation-dialog tw:grid tw:w-[min(30rem,calc(100vw-var(--cpx-sys-space-8)))] tw:gap-4 tw:p-5 tw:text-app-text"
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <header className="full-access-confirmation-header tw:flex tw:items-center tw:gap-2">
        <AlertTriangle
          aria-hidden="true"
          className="tw:size-icon-lg tw:shrink-0 tw:text-app-text"
          size={APP_ICON_SIZES.lg}
          strokeWidth={APP_ICON_STROKE_WIDTH}
        />
        <AlertDialog.Title asChild>
          <h2 className="tw:m-0 tw:min-w-0 tw:flex-1 tw:text-app-text tw:type-4 tw:weight-bold tw:break-words">
            {title}
          </h2>
        </AlertDialog.Title>
      </header>
      <AlertDialog.Description asChild>
        <p className="full-access-confirmation-intro tw:m-0 tw:text-app-text-soft tw:type-2">
          {intro}
        </p>
      </AlertDialog.Description>
      <ul className="full-access-capability-list tw:m-0 tw:list-none tw:divide-y tw:divide-app-border-subtle tw:overflow-hidden tw:p-0">
        {CAPABILITY_ITEMS.map((item) => (
          <li
            key={item.id}
            className="full-access-capability-row tw:flex tw:items-center tw:gap-3 tw:px-4 tw:py-3"
          >
            {item.icon}
            <div className="tw:grid tw:min-w-0 tw:flex-1 tw:gap-1">
              <div className="tw:text-app-text tw:type-2 tw:weight-bold">{item.title}</div>
              <div className="tw:text-app-text-soft tw:type-1">{item.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      <p className="full-access-confirmation-risk tw:m-0 tw:text-app-text-soft tw:type-2">
        这会带来敏感数据丢失或泄露、提示注入等风险。你可以随时将其关闭。
      </p>
      {error ? (
        <p className="tw:m-0 tw:text-app-danger-fg tw:type-1" role="alert">
          {error}
        </p>
      ) : null}
      <div className="full-access-confirmation-actions tw:flex tw:items-center tw:justify-end tw:gap-2">
        <AlertDialog.Cancel asChild>
          <Button color="secondary" shape="pill" size="medium">
            {cancelLabel}
          </Button>
        </AlertDialog.Cancel>
        <AlertDialog.Action asChild>
          <Button
            color="dangerSubtle"
            disabled={actionDisabled}
            iconSize="sm"
            leftIcon={
              <AlertTriangle
                aria-hidden="true"
                size={APP_ICON_SIZES.sm}
                strokeWidth={APP_ICON_STROKE_WIDTH}
              />
            }
            shape="pill"
            size="medium"
            onClick={handleActionClick}
          >
            {actionLabel}
          </Button>
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  )
}

/** Confirmation dialog disclosing the full-access capability scope and host-execution risks. */
export function FullAccessConfirmationDialog({
  open,
  title,
  intro,
  cancelLabel,
  actionLabel,
  actionDisabled,
  error,
  onCancel,
  onAction,
}: Props): React.ReactNode {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="ui-dialog-backdrop permission-modal-backdrop" />
        <FullAccessConfirmationContent
          actionDisabled={actionDisabled}
          actionLabel={actionLabel}
          cancelLabel={cancelLabel}
          error={error}
          intro={intro}
          open={open}
          title={title}
          onAction={onAction}
        />
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
