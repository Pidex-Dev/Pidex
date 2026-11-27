import { useRef } from 'react'
import { Button } from '../../components/ui/Button.js'
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/Dialog.js'

type SessionGroupEditorDialogProps = {
  open: boolean
  mode: 'create' | 'edit'
  name: string
  description: string
  saving: boolean
  error?: string | null
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}

export function SessionGroupEditorDialog({
  open,
  mode,
  name,
  description,
  saving,
  error,
  onNameChange,
  onDescriptionChange,
  onCancel,
  onSubmit,
}: SessionGroupEditorDialogProps): React.ReactNode {
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const submitDisabled = saving || name.trim().length === 0
  const creating = mode === 'create'

  return (
    <Dialog
      closeDisabled={saving}
      contentClassName="confirmation-dialog"
      open={open}
      size="medium"
      contentProps={{
        onOpenAutoFocus: (event) => {
          event.preventDefault()
          nameInputRef.current?.focus()
          nameInputRef.current?.select()
        },
      }}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onCancel()
      }}
    >
      <DialogBody
        as="form"
        className="tw:gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (!submitDisabled) onSubmit()
        }}
      >
        <DialogHeader
          className="confirmation-dialog-header"
          subtitle={
            <DialogDescription asChild>
              <p className="tw:m-0">
                {creating ? '为相关任务建立一个共享上下文。' : '修改工作组的名称和说明。'}
              </p>
            </DialogDescription>
          }
          title={
            <DialogTitle asChild>
              <h2 className="tw:m-0 tw:type-4 tw:weight-bold tw:text-app-text">
                {creating ? '新建工作组' : '编辑工作组'}
              </h2>
            </DialogTitle>
          }
        />

        <label className="tw:type-2 tw:weight-medium tw:grid tw:gap-1 tw:text-app-text">
          名称
          <input
            className="tw:type-2 tw:weight-medium tw:w-full tw:rounded-3 tw:border tw:border-app-border tw:bg-app-canvas tw:px-3 tw:py-2 tw:text-app-text tw:outline-none tw:focus:border-app-accent tw:focus:ring-2 tw:focus:ring-app-accent"
            maxLength={120}
            onChange={(event) => onNameChange(event.currentTarget.value)}
            placeholder="例如：登录流程修复"
            ref={nameInputRef}
            value={name}
          />
        </label>
        <label className="tw:type-2 tw:weight-medium tw:grid tw:gap-1 tw:text-app-text">
          说明
          <textarea
            className="tw:type-2 tw:weight-medium tw:min-h-[6rem] tw:w-full tw:resize-y tw:rounded-3 tw:border tw:border-app-border tw:bg-app-canvas tw:px-3 tw:py-2 tw:text-app-text tw:outline-none tw:focus:border-app-accent tw:focus:ring-2 tw:focus:ring-app-accent"
            maxLength={4000}
            onChange={(event) => onDescriptionChange(event.currentTarget.value)}
            placeholder="说明这个工作组要共同解决的问题（可选）"
            value={description}
          />
        </label>

        {error ? (
          <p className="tw:type-1 tw:m-0 tw:text-app-danger" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter className="confirmation-dialog-actions">
          <DialogClose asChild disabled={saving}>
            <Button color="ghost" disabled={saving} size="medium">
              取消
            </Button>
          </DialogClose>
          <Button color="primary" disabled={submitDisabled} size="medium" type="submit">
            {saving ? '保存中…' : creating ? '新建' : '保存'}
          </Button>
        </DialogFooter>
      </DialogBody>
    </Dialog>
  )
}
