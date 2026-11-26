import { Button } from '../../../components/ui/Button.js'
import type { DesktopAttachmentUploadProgress } from '../../../../shared/Types.js'

export function AttachmentUploadProgress({
  progress,
  onCancel,
}: {
  progress: DesktopAttachmentUploadProgress
  onCancel?: () => void
}): React.ReactNode {
  const { fileName, deliveredBytes, totalBytes } = progress
  return (
    <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2 tw:type-1 tw:text-app-text-soft">
      <span className="tw:min-w-0 tw:truncate" title={fileName}>
        正在上传 {fileName}
      </span>
      <progress
        aria-label={'附件上传进度：' + fileName}
        className="tw:min-w-0 tw:flex-1"
        max={totalBytes}
        value={deliveredBytes}
      />
      {onCancel ? (
        <Button size="xs" type="button" onClick={onCancel}>
          取消上传
        </Button>
      ) : null}
    </div>
  )
}
