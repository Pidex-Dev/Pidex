import { randomUUID } from 'node:crypto'
import { ATTACHMENT_UPLOAD_CHUNK_BYTES, type RpcParams } from '@pidex/agent-protocol'
import { AgentError } from '../Domain'
import {
  ATTACHMENT_LIMITS,
  type AttachmentRecord,
  type AttachmentService,
  normalizeAttachmentMimeType,
  validateAttachmentName,
} from './AttachmentService'

type UploadSpec = RpcParams<'attachment/upload/begin'>
type Upload = UploadSpec & {
  owner: string
  offset: number
  data?: Uint8Array
  committing?: Promise<AttachmentRecord>
  closed?: true
  attachment?: AttachmentRecord
}

export class AttachmentUploads {
  private readonly uploads = new Map<string, Upload>()

  constructor(private readonly attachments: AttachmentService) {}

  begin(owner: string, spec: UploadSpec) {
    validateAttachmentName(spec.name)
    const mediaType = normalizeAttachmentMimeType(spec.kind, spec.mediaType)
    if (spec.size > ATTACHMENT_LIMITS.maxMediaBytes)
      throw new AgentError('ATTACHMENT_LIMIT', '附件超过 20 MiB 单文件上限', 413)
    const active = [...this.uploads.values()].filter((upload) => !upload.attachment)
    const mine = active.filter((upload) => upload.owner === owner)
    if (
      mine.length >= ATTACHMENT_LIMITS.maxCount ||
      mine.reduce((sum, upload) => sum + upload.size, spec.size) > ATTACHMENT_LIMITS.maxTotalBytes
    ) {
      throw new AgentError('ATTACHMENT_LIMIT', '暂存附件超过数量或 25 MiB 总量上限', 413)
    }
    if (
      active.reduce((sum, upload) => sum + upload.size, spec.size) >
      4 * ATTACHMENT_LIMITS.maxTotalBytes
    )
      throw new AgentError('RATE_LIMITED', '附件暂存繁忙，请重试', 429)
    const uploadId = randomUUID()
    this.uploads.set(uploadId, { ...spec, mediaType, owner, offset: 0 })
    return { uploadId }
  }

  chunk(owner: string, { uploadId, offset, data }: RpcParams<'attachment/upload/chunk'>) {
    const upload = this.require(owner, uploadId)
    if (upload.committing || upload.attachment || offset !== upload.offset) {
      throw new AgentError('CONFLICT', '附件上传位置或状态已变化', 409)
    }
    const bytes = Buffer.from(data, 'base64')
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > ATTACHMENT_UPLOAD_CHUNK_BYTES ||
      bytes.toString('base64') !== data
    ) {
      throw new AgentError('ATTACHMENT_FORMAT_INVALID', '附件分块无效', 400)
    }
    if (offset + bytes.byteLength > upload.size) {
      throw new AgentError('ATTACHMENT_LIMIT', '附件分块超过声明大小', 413)
    }
    upload.data ??= new Uint8Array(upload.size)
    upload.data.set(bytes, offset)
    upload.offset += bytes.byteLength
    return { offset: upload.offset }
  }

  async commit(owner: string, uploadId: string) {
    const upload = this.require(owner, uploadId)
    if (upload.attachment) return upload.attachment
    if (upload.committing) return upload.committing
    if (upload.offset !== upload.size || !upload.data) {
      throw new AgentError('CONFLICT', '附件尚未上传完整', 409)
    }
    upload.committing = this.attachments
      .store([
        { kind: upload.kind, name: upload.name, mimeType: upload.mediaType, data: upload.data },
      ])
      .then(([attachment]) => {
        if (!attachment) throw new AgentError('INTERNAL_ERROR', '附件存储失败', 500)
        upload.attachment = attachment
        return attachment
      })
      .catch((error) => {
        this.uploads.delete(uploadId)
        throw error
      })
      .finally(() => {
        delete upload.data
        delete upload.committing
        if (upload.closed) this.uploads.delete(uploadId)
      })
    return upload.committing
  }

  abort(owner: string, uploadId: string) {
    const upload = this.uploads.get(uploadId)
    if (upload?.owner === owner && !upload.committing && !upload.attachment)
      this.uploads.delete(uploadId)
    return {}
  }

  close(owner: string) {
    for (const [uploadId, upload] of this.uploads) {
      if (upload.owner !== owner) continue
      if (upload.committing) upload.closed = true
      else this.uploads.delete(uploadId)
    }
  }

  private require(owner: string, uploadId: string) {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.owner !== owner) {
      throw new AgentError('ATTACHMENT_NOT_FOUND', '附件上传已过期或不存在', 404)
    }
    return upload
  }
}
