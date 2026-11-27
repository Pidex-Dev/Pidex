import type React from 'react'
import { useRef } from 'react'
import { X } from 'lucide-react'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from './IconTokens.js'
import { Button } from './Button.js'
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './Dialog.js'
import { useDialogFocusRestore } from './UseDialogFocusRestore.js'

type ConfirmationInput = {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  maxLength?: number
}

type Props = {
  open: boolean
  title: string
  description?: React.ReactNode
  cancelLabel?: string
  actionLabel: string
  tone?: 'primary' | 'danger'
  actionDisabled?: boolean
  showCloseButton?: boolean
  suppression?: {
    checked: boolean
    label: string
    onCheckedChange: (checked: boolean) => void
  }
  onCancel: () => void
  onAction: () => void
}

/**
 * Codex Desktop confirmation alert dialog built on Radix AlertDialog with
 * frosted elevated surface, right-aligned actions, ghost cancel, and soft-red
 * destructive button styling.
 */
export function ConfirmationDialog({
  open,
  title,
  description,
  cancelLabel = '取消',
  actionLabel,
  tone = 'primary',
  actionDisabled = false,
  showCloseButton = true,
  suppression,
  onCancel,
  onAction,
}: Props): React.ReactNode {
  const { onCloseAutoFocus } = useDialogFocusRestore(open)

  function handleActionClick(event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault()
    onAction()
  }

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="ui-dialog-backdrop permission-modal-backdrop" />
        <AlertDialog.Content
          className="ui-dialog-surface ui-dialog-surface--centered ui-dialog-sized confirmation-dialog tw:grid tw:gap-3 tw:p-5 tw:text-app-text tw:outline-none"
          data-dialog-size="compact"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <header className="confirmation-dialog-header tw:flex tw:items-start tw:justify-between tw:gap-3">
            <AlertDialog.Title asChild>
              <h2 className="tw:m-0 tw:min-w-0 tw:flex-1 tw:text-app-text tw:type-4 tw:weight-bold tw:break-words tw:no-underline">
                {title}
              </h2>
            </AlertDialog.Title>
            {showCloseButton ? (
              <AlertDialog.Cancel asChild>
                <Button
                  isIconOnly
                  className="tw:shrink-0"
                  color="ghost"
                  size="toolbar"
                  title="关闭对话框"
                >
                  <X
                    aria-hidden="true"
                    className="tw:size-icon-sm"
                    size={APP_ICON_SIZE}
                    strokeWidth={APP_ICON_STROKE_WIDTH}
                  />
                </Button>
              </AlertDialog.Cancel>
            ) : null}
          </header>
          <AlertDialog.Description asChild>
            <div className="confirmation-dialog-description tw:m-0 tw:text-app-text-soft tw:type-2">
              {description ?? '请确认是否继续。'}
            </div>
          </AlertDialog.Description>
          {suppression ? (
            <label className="confirmation-dialog-suppression tw:flex tw:cursor-pointer tw:items-center tw:gap-2 tw:text-app-text-soft tw:type-1">
              <input
                checked={suppression.checked}
                type="checkbox"
                onChange={(event) => suppression.onCheckedChange(event.currentTarget.checked)}
              />
              <span>{suppression.label}</span>
            </label>
          ) : null}
          <div className="confirmation-dialog-actions tw:mt-2 tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-3">
            <AlertDialog.Cancel asChild>
              <Button color="ghost" size="medium">
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                color={tone === 'danger' ? 'dangerSubtle' : 'primary'}
                disabled={actionDisabled}
                onClick={handleActionClick}
                size="medium"
              >
                {actionLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

type InputDialogProps = Omit<Props, 'description' | 'tone' | 'suppression'> & {
  description: React.ReactNode
  input: ConfirmationInput
  allowEmpty?: boolean
}

/** Codex Desktop single-field input dialog built on the shared `Dialog` primitives. */
export function InputDialog({
  open,
  title,
  description,
  cancelLabel = '取消',
  actionLabel,
  input,
  allowEmpty = false,
  actionDisabled = false,
  showCloseButton = true,
  onCancel,
  onAction,
}: InputDialogProps): React.ReactNode {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const submitDisabled = isInputDialogSubmitDisabled(input.value, allowEmpty, actionDisabled)

  return (
    <Dialog
      open={open}
      showDialogClose={showCloseButton}
      size="compact"
      contentClassName="confirmation-dialog"
      contentProps={{
        onOpenAutoFocus: (event) => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        },
      }}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogBody
        as="form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!submitDisabled) onAction()
        }}
      >
        <DialogHeader
          reserveCloseSpace={showCloseButton}
          subtitle={
            <DialogDescription asChild>
              <p className="confirmation-dialog-description tw:m-0">{description}</p>
            </DialogDescription>
          }
          title={
            <DialogTitle asChild>
              <h2 className="tw:m-0 tw:type-4 tw:weight-bold tw:text-app-text tw:break-words">
                {title}
              </h2>
            </DialogTitle>
          }
        />
        <input
          aria-label={title}
          className="confirmation-dialog-input tw:w-full tw:rounded-3 tw:border tw:border-app-border tw:bg-app-canvas tw:px-3 tw:py-2 tw:text-app-text tw:type-2 tw:outline-none tw:transition-[border-color,box-shadow] tw:duration-[var(--cpx-sys-motion-enter)] tw:focus:border-app-accent tw:focus:ring-2 tw:focus:ring-app-accent"
          defaultValue={input.value}
          maxLength={input.maxLength}
          onInput={(event) => input.onChange(event.currentTarget.value)}
          placeholder={input.placeholder}
          ref={inputRef}
          type="text"
        />
        <DialogFooter className="confirmation-dialog-actions">
          <DialogClose asChild>
            <Button color="ghost" size="medium">
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button color="primary" disabled={submitDisabled} size="medium" type="submit">
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogBody>
    </Dialog>
  )
}

/** Determines whether an `InputDialog` submission should be disabled. */
export function isInputDialogSubmitDisabled(
  value: string,
  allowEmpty = false,
  actionDisabled = false,
): boolean {
  return actionDisabled || (!allowEmpty && value.trim().length === 0)
}
