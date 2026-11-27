import type React from 'react'
import { Button } from '../ui/Button.js'
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/Dialog.js'
import type { ToastItem } from './ToastState.js'

export function ToastDetailsDialog({
  notice,
  onClose,
}: {
  notice: Pick<ToastItem, 'message' | 'details'> | null
  onClose: () => void
}): React.ReactNode {
  return (
    <Dialog
      open={notice !== null}
      size="large"
      contentProps={{ 'aria-describedby': undefined }}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogBody className="tw:grid tw:max-h-[calc(100vh-2rem)] tw:grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader
          title={
            <DialogTitle asChild>
              <h2 className="tw:m-0 tw:type-4 tw:weight-bold tw:text-app-text tw:break-words">
                {notice?.message}
              </h2>
            </DialogTitle>
          }
        />
        <div className="tw:min-h-0 tw:overflow-y-auto tw:whitespace-pre-wrap tw:wrap-anywhere tw:type-2 tw:text-app-text-soft">
          {notice?.details}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button color="secondary" size="medium">
              关闭
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogBody>
    </Dialog>
  )
}
