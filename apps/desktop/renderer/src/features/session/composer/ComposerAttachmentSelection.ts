import type { DesktopComposerAttachment, DesktopModelMetadata } from '../../../../shared/Types.js'

export async function selectDroppedComposerAttachments(
  files: FileList | readonly File[],
  pathForFile: (file: File) => string,
  grantPaths: (paths: string[]) => Promise<DesktopComposerAttachment[]>,
): Promise<DesktopComposerAttachment[]> {
  const paths: string[] = []
  const inlineMedia: { file: File; mediaType: string }[] = []
  for (const file of Array.from(files)) {
    const path = pathForFile(file)
    if (path) {
      paths.push(path)
      continue
    }
    const mediaType = getInlineMediaType(file)
    if (mediaType) inlineMedia.push({ file, mediaType })
  }
  const [pathAttachments, mediaAttachments] = await Promise.all([
    grantPaths(paths),
    Promise.all(
      inlineMedia.map(({ file, mediaType }) => readManagedMediaAttachment(file, mediaType)),
    ),
  ])
  return [...pathAttachments, ...mediaAttachments]
}

export function mergeComposerAttachments(
  current: readonly DesktopComposerAttachment[],
  incoming: readonly DesktopComposerAttachment[],
): { accepted: DesktopComposerAttachment[]; error: string | null } {
  const existingKeys = new Set(current.map(composerAttachmentKey))
  const unique = incoming.filter((attachment) => {
    const key = composerAttachmentKey(attachment)
    if (existingKeys.has(key)) return false
    existingKeys.add(key)
    return true
  })
  const available = Math.max(0, 8 - current.length)
  const accepted = unique.slice(0, available)
  let error: string | null = null
  if (unique.length > available) {
    error = '每条消息最多添加 8 个附件项。'
    if (available > 0) accepted.splice(-1, 1, errorAttachment('attachment-limit', error))
  }
  const managedBytes = [...current, ...accepted]
    .filter((attachment) => attachment.storage !== 'local-path')
    .reduce((total, attachment) => total + attachment.sizeBytes, 0)
  if (
    managedBytes > 25 * 1024 * 1024 &&
    accepted.length > 0 &&
    ![...current, ...accepted].some(isNativeFileAttachment)
  ) {
    error = '图片与托管附件总量不能超过 25 MiB。'
    accepted.splice(-1, 1, errorAttachment('attachment-size', error))
  }
  return { accepted, error: available === 0 ? error : null }
}

export function isNativeFileAttachment(attachment: DesktopComposerAttachment): boolean {
  return (
    attachment.storage !== 'local-path' &&
    (attachment.kind === 'pdf' || attachment.kind === 'video')
  )
}

export function canUseComposerPathReference(attachment: DesktopComposerAttachment): boolean {
  return (
    isNativeFileAttachment(attachment) &&
    attachment.pathKind === 'file' &&
    Boolean(attachment.localGrantId && attachment.path)
  )
}

export function asComposerPathReference(
  attachment: DesktopComposerAttachment,
): DesktopComposerAttachment {
  return {
    id: crypto.randomUUID(),
    kind: attachment.kind,
    name: attachment.name,
    path: attachment.path,
    pathKind: 'file',
    localGrantId: attachment.localGrantId,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    storage: 'local-path',
    status: 'ready',
  }
}

export function nativeFileAttachmentIncompatibility(
  attachment: DesktopComposerAttachment,
  model?: DesktopModelMetadata,
): string | null {
  if (!isNativeFileAttachment(attachment) || model?.modalities?.input?.includes(attachment.kind))
    return null
  const mediaName = attachment.kind === 'pdf' ? 'PDF' : '视频'
  return model
    ? (model.label ?? model.name ?? model.id) + ' 不支持 ' + mediaName + ' 附件'
    : '请选择支持 ' + mediaName + ' 附件的模型'
}

export function hasOversizeManagedAttachmentSet(attachments: DesktopComposerAttachment[]): boolean {
  return (
    attachments
      .filter((attachment) => attachment.storage !== 'local-path' && attachment.status === 'ready')
      .reduce((total, attachment) => total + attachment.sizeBytes, 0) >
    25 * 1024 * 1024
  )
}

function getInlineMediaType(file: File): string | null {
  if (file.type === 'application/pdf' || /^(image|audio|video)\//.test(file.type)) return file.type
  const extension = file.name.toLowerCase().split('.').pop()
  if (extension === 'pdf') return 'application/pdf'
  if (extension === 'mp4' || extension === 'webm') return 'video/' + extension
  return null
}

async function readManagedMediaAttachment(
  file: File,
  mediaType: string,
): Promise<DesktopComposerAttachment> {
  const kind = managedMediaKind(mediaType)
  const source = { name: file.name, size: file.size, mediaType }
  if (file.size === 0) return errorAttachment('attachment-empty', '附件为空。', source)
  if (kind === 'video' && mediaType !== 'video/mp4' && mediaType !== 'video/webm')
    return errorAttachment('attachment-format', '仅支持 MP4 和 WebM 视频文件。', source)
  if (file.size > (kind === 'image' ? 10 : 20) * 1024 * 1024) {
    return errorAttachment(
      'attachment-size',
      kind === 'image' ? '图片超过 10 MiB 限制。' : '附件超过 20 MiB 限制。',
      source,
    )
  }
  const dataUrl = await new Promise<string | null>((resolve) => {
    const reader = new FileReader()
    reader.onerror = () => resolve(null)
    reader.onabort = () => resolve(null)
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file.type === mediaType ? file : file.slice(0, file.size, mediaType))
  })
  const prefix = 'data:' + mediaType + ';base64,'
  if (!dataUrl?.startsWith(prefix))
    return errorAttachment('attachment-read', '附件读取失败，请重新添加。', source)
  return {
    id: crypto.randomUUID(),
    name:
      file.name ||
      (kind === 'image' ? 'clipboard-image.png' : kind === 'pdf' ? 'attachment.pdf' : 'media-file'),
    path: '',
    mediaType,
    sizeBytes: file.size,
    kind,
    status: 'ready',
    storage: 'managed',
    contentBase64: dataUrl.slice(prefix.length),
    ...(kind === 'image' ? { previewDataUrl: dataUrl } : {}),
  }
}

function managedMediaKind(mediaType: string): 'image' | 'audio' | 'video' | 'pdf' {
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType.startsWith('audio/')) return 'audio'
  if (mediaType.startsWith('video/')) return 'video'
  return 'image'
}

function composerAttachmentKey(attachment: DesktopComposerAttachment): string {
  if (attachment.path) return `path:${attachment.path.toLocaleLowerCase()}`
  return `id:${attachment.id}`
}

function errorAttachment(
  prefix: string,
  error: string,
  file?: { name: string; size: number; mediaType: string },
): DesktopComposerAttachment {
  return {
    id: `${prefix}:${crypto.randomUUID()}`,
    name: file?.name || '附件未添加',
    path: '',
    mediaType: file?.mediaType || 'application/octet-stream',
    sizeBytes: file?.size ?? 0,
    kind: file ? managedMediaKind(file.mediaType) : 'binary',
    status: 'error',
    ...(file ? { storage: 'managed' as const } : {}),
    error,
  }
}
