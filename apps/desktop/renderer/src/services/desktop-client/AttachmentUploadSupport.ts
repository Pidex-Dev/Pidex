import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  type RpcParams,
  type RpcResult,
} from '@pidex/agent-protocol'
import type {
  DesktopComposerPathPreview,
  DesktopComposerPathReadInput,
} from '@pidex/shared/desktop-attachment-ipc'
import type { DesktopComposerAttachment, DesktopUserMessageInput } from '../../../shared/Types.js'

const MAX_ATTACHMENTS_PER_MESSAGE = 8
export const BASE64_ATTACHMENT_CHUNK_BYTES =
  ATTACHMENT_UPLOAD_CHUNK_BYTES - (ATTACHMENT_UPLOAD_CHUNK_BYTES % 3)

type LegacyUpload = RpcParams<'attachment/import'>['uploads'][number]
type ReadAttachment = (
  attachmentId: string,
  range?: RpcParams<'attachment/read'>['range'],
) => Promise<RpcResult<'attachment/read'>>
type ReadGrant = (request: DesktopComposerPathReadInput) => Promise<DesktopComposerPathPreview>
type MediaAttachmentKind = 'pdf' | 'video'

type ChunkedUpload = {
  kind: MediaAttachmentKind
  name: string
  mediaType: string
  size: number
  readChunk: (offset: number) => Promise<string> | string
}

type PreparedUpload = { key: string; upload: LegacyUpload | ChunkedUpload }

type ChunkedUploadTransport = {
  begin: (
    input: RpcParams<'attachment/upload/begin'>,
  ) => Promise<RpcResult<'attachment/upload/begin'>>
  chunk: (
    input: RpcParams<'attachment/upload/chunk'>,
  ) => Promise<RpcResult<'attachment/upload/chunk'>>
  commit: (
    input: RpcParams<'attachment/upload/commit'>,
  ) => Promise<RpcResult<'attachment/upload/commit'>>
  abort: (input: RpcParams<'attachment/upload/abort'>) => Promise<unknown>
}

const initialRange = { offset: 0, length: BASE64_ATTACHMENT_CHUNK_BYTES }

export function isChunkedAttachmentKind(kind: string): kind is MediaAttachmentKind {
  return kind === 'pdf' || kind === 'video'
}

export async function buildAgentAttachmentUploads(
  input: DesktopUserMessageInput,
  readAttachment: ReadAttachment,
  options?: {
    chunked: boolean
    readGrant?: ReadGrant
    reusing?: ReadonlyMap<string, string>
  },
): Promise<{ order: string[]; prepared: PreparedUpload[] }> {
  const retainedAttachmentIds = [...new Set((input.retainedAttachmentIds ?? []).filter(Boolean))]
  const seenDraftAttachmentIds = new Set<string>()
  const draftAttachments = (input.attachments ?? []).filter((attachment) => {
    if (attachment.storage === 'local-path') return false
    if (retainedAttachmentIds.includes(attachment.id) || seenDraftAttachmentIds.has(attachment.id))
      return false
    seenDraftAttachmentIds.add(attachment.id)
    return true
  })
  const retainedContextReferenceIds = new Set(
    (input.retainedContextReferenceIds ?? []).filter(Boolean),
  )
  const localPathCount = new Set(
    (input.attachments ?? [])
      .filter((attachment) => attachment.storage === 'local-path')
      .map((attachment) => attachment.path.toLocaleLowerCase()),
  ).size
  if (
    retainedAttachmentIds.length +
      retainedContextReferenceIds.size +
      draftAttachments.length +
      localPathCount >
    MAX_ATTACHMENTS_PER_MESSAGE
  ) {
    throw new Error('每次最多发送 ' + MAX_ATTACHMENTS_PER_MESSAGE + ' 个附件。')
  }

  const retainedOrder = retainedAttachmentIds.map((id) => 'retained:' + id)
  const draftOrder = draftAttachments.map((attachment) => 'draft:' + attachment.id)
  const retainedUploads = await Promise.all(
    retainedAttachmentIds.flatMap((attachmentId, index) => {
      const key = retainedOrder[index]!
      if (options?.reusing?.has(key)) return []
      return [
        prepareRetained(attachmentId, readAttachment, options?.chunked ?? false).then((upload) => ({
          key,
          upload,
        })),
      ]
    }),
  )
  const draftUploads = await Promise.all(
    draftAttachments.flatMap((attachment, index) => {
      const key = draftOrder[index]!
      if (options?.reusing?.has(key)) return []
      return [
        prepareDraft(attachment, options?.chunked ?? false, options?.readGrant).then((upload) => ({
          key,
          upload,
        })),
      ]
    }),
  )
  return {
    order: [...retainedOrder, ...draftOrder],
    prepared: [...retainedUploads, ...draftUploads],
  }
}

async function prepareRetained(
  attachmentId: string,
  readAttachment: ReadAttachment,
  chunked: boolean,
): Promise<LegacyUpload | ChunkedUpload> {
  const first = await readAttachment(attachmentId, chunked ? initialRange : undefined)
  const { attachment } = first
  if (isChunkedAttachmentKind(attachment.kind) && chunked) {
    return {
      kind: attachment.kind,
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: first.range.total,
      readChunk: async (offset) => {
        const length = Math.min(BASE64_ATTACHMENT_CHUNK_BYTES, first.range.total - offset)
        const result = offset === 0 ? first : await readAttachment(attachmentId, { offset, length })
        if (result.range.offset !== offset || result.range.total !== first.range.total)
          throw new Error('附件 ' + attachment.name + ' 的内容发生变化，请重试。')
        return requireBase64(result, length, attachment.name)
      },
    }
  }
  if (attachment.kind === 'pdf') throw new Error('当前 Agent 不支持 PDF 附件，请升级 Agent。')
  const result = first.range.length < first.range.total ? await readAttachment(attachmentId) : first
  if (attachment.kind === 'image' || attachment.kind === 'audio' || attachment.kind === 'video') {
    if (result.encoding !== 'base64' || !result.data)
      throw new Error('附件 ' + attachment.name + ' 缺少内容。')
    return {
      kind: attachment.kind,
      name: attachment.name,
      mediaType: attachment.mediaType,
      data: result.data,
      encoding: 'base64',
    }
  }
  return {
    kind: 'text',
    name: attachment.name,
    mediaType: attachment.mediaType || 'text/plain',
    data: result.data,
    encoding: result.encoding,
  }
}

async function prepareDraft(
  attachment: DesktopComposerAttachment,
  chunked: boolean,
  readGrant: ReadGrant | undefined,
): Promise<LegacyUpload | ChunkedUpload> {
  if (attachment.status !== 'ready')
    throw new Error(attachment.error ?? '附件 ' + attachment.name + ' 尚未准备完成。')
  const { kind, name, mediaType, sizeBytes, localGrantId } = attachment
  const data =
    attachment.contentBase64 ?? attachment.previewDataUrl?.replace(/^data:[^;]+;base64,/, '')
  if (isChunkedAttachmentKind(kind) && chunked) {
    return {
      kind,
      name,
      mediaType,
      size: sizeBytes,
      readChunk: async (offset) => {
        const length = Math.min(BASE64_ATTACHMENT_CHUNK_BYTES, sizeBytes - offset)
        if (localGrantId && readGrant) {
          const preview = await readGrant({ grantId: localGrantId, range: { offset, length } })
          if (
            preview.sizeBytes !== sizeBytes ||
            preview.kind !== kind ||
            preview.mediaType !== mediaType
          )
            throw new Error('附件 ' + name + ' 已更改，请重新添加。')
          return requireBase64(preview, length, name)
        }
        const encodedOffset = (offset / 3) * 4
        return requireBase64(
          {
            encoding: 'base64',
            data: data?.slice(encodedOffset, encodedOffset + Math.ceil(length / 3) * 4),
          },
          length,
          name,
        )
      },
    }
  }
  if (kind === 'pdf') throw new Error('当前 Agent 不支持 PDF 附件，请升级 Agent。')
  if (kind === 'image' || kind === 'audio' || kind === 'video') {
    const fallback =
      !data && localGrantId && readGrant ? await readGrant({ grantId: localGrantId }) : null
    const content = data ?? (fallback?.encoding === 'base64' ? fallback.data : undefined)
    if (!content) throw new Error('附件 ' + name + ' 缺少内容。')
    return { kind, name, mediaType, data: content, encoding: 'base64' }
  }
  if (typeof attachment.textContent !== 'string' || attachment.truncated)
    throw new Error('附件 ' + name + ' 不是完整的 UTF-8 文本或受支持的媒体。')
  return {
    kind: 'text',
    name,
    mediaType: mediaType || 'text/plain',
    data: attachment.textContent,
    encoding: 'utf8',
  }
}

export async function uploadAgentAttachmentChunks(
  { kind, name, mediaType, size, readChunk }: ChunkedUpload,
  transport: ChunkedUploadTransport,
  transfer?: DesktopUserMessageInput['attachmentTransfer'],
): Promise<string> {
  transfer?.signal.throwIfAborted()
  transfer?.onProgress({ fileName: name, deliveredBytes: 0, totalBytes: size })
  let uploadId: string | undefined
  try {
    const begun = await transport.begin({ kind, name, mediaType, size })
    uploadId = begun.uploadId
    for (let offset = 0; offset < size;) {
      transfer?.signal.throwIfAborted()
      const data = await readChunk(offset)
      transfer?.signal.throwIfAborted()
      const result = await transport.chunk({ uploadId, offset, data })
      const next = offset + base64ByteLength(data)
      if (result.offset !== next) throw new Error('附件 ' + name + ' 的上传进度无效。')
      offset = next
      transfer?.onProgress({ fileName: name, deliveredBytes: offset, totalBytes: size })
    }
    transfer?.signal.throwIfAborted()
    const result = await transport.commit({ uploadId })
    return result.attachment.id
  } catch (cause) {
    if (uploadId) await transport.abort({ uploadId }).catch(() => undefined)
    const reason = cause instanceof Error ? cause.message : '上传失败'
    throw new Error('附件 ' + name + '：' + reason, { cause })
  }
}

export async function readAttachmentBase64Ranges(
  name: string,
  size: number,
  readChunk: (offset: number, length: number) => Promise<{ encoding?: string; data?: string }>,
  signal: AbortSignal,
): Promise<string> {
  const chunks: string[] = []
  for (let offset = 0; offset < size; offset += BASE64_ATTACHMENT_CHUNK_BYTES) {
    signal.throwIfAborted()
    const length = Math.min(BASE64_ATTACHMENT_CHUNK_BYTES, size - offset)
    chunks.push(requireBase64(await readChunk(offset, length), length, name))
  }
  return chunks.join('')
}

function requireBase64(
  value: { encoding?: string; data?: string },
  length: number,
  name: string,
): string {
  if (value.encoding !== 'base64' || !value.data || base64ByteLength(value.data) !== length)
    throw new Error('附件 ' + name + ' 内容不完整，请重新添加。')
  return value.data
}

function base64ByteLength(data: string): number {
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
}
