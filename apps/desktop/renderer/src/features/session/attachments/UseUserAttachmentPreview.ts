import { useCallback, useEffect, useRef, useState } from 'react'
import { desktopClient } from '../../../services/desktop-client/index.js'
import type { UserAttachmentPreviewTab } from '../../layout/dock/RightDockState.js'

import {
  isChunkedAttachmentKind,
  readAttachmentBase64Ranges,
} from '../../../services/desktop-client/AttachmentUploadSupport.js'
import { isMediaPreviewKind } from './AttachmentPreviewSupport.js'

export type LoadedUserAttachment = {
  attachment: UserAttachmentPreviewTab['attachment']
  data: string
  encoding: 'base64' | 'utf8' | null
}

export type UserAttachmentLoadState =
  | { status: 'loading' }
  | { status: 'ready'; value: LoadedUserAttachment }
  | { status: 'error'; message: string }

export function useUserAttachmentPreview(
  tab: UserAttachmentPreviewTab,
): UserAttachmentLoadState & { retry: () => void } {
  const [retryVersion, setRetryVersion] = useState(0)
  const [state, setState] = useState<UserAttachmentLoadState>(() =>
    tab.source.storage === 'draft'
      ? {
          status: 'ready',
          value: {
            attachment: tab.attachment,
            data: tab.source.data,
            encoding: tab.source.encoding,
          },
        }
      : { status: 'loading' },
  )
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation

    if (tab.source.storage === 'draft') {
      setState({
        status: 'ready',
        value: {
          attachment: tab.attachment,
          data: tab.source.data,
          encoding: tab.source.encoding,
        },
      })
      return
    }

    let cancelled = false
    const readAbort = new AbortController()
    setState({ status: 'loading' })
    const request =
      tab.source.storage === 'thread'
        ? loadThreadAttachment(tab, tab.source.attachmentId, readAbort.signal)
        : tab.source.storage === 'draft-path'
          ? loadDraftPathAttachment(tab, tab.source, readAbort.signal)
          : tab.source.storage === 'artifact'
            ? desktopClient
                .readArtifact(tab.source.threadId, tab.source.artifactId)
                .then((result) => {
                  const isImage = result.artifact.mimeType.toLowerCase().startsWith('image/')
                  return {
                    attachment: {
                      id: result.artifact.id,
                      kind: isImage ? 'image' : 'text',
                      name: result.artifact.name,
                      mediaType: result.artifact.mimeType,
                      sizeBytes: result.artifact.sizeBytes,
                    },
                    // 预览面板要求 image 走 base64、text 走 utf8；Artifact 读取固定返回 base64。
                    data: isImage ? result.data : decodeBase64Utf8(result.data),
                    encoding: isImage ? ('base64' as const) : ('utf8' as const),
                  }
                })
            : desktopClient
                .readLocalContextPath({
                  threadId: tab.source.threadId,
                  referenceId: tab.source.referenceId,
                  ...(tab.source.relativePath ? { relativePath: tab.source.relativePath } : {}),
                })
                .then((result) => ({
                  attachment: {
                    id: result.reference.id,
                    kind: result.preview === 'unsupported' ? 'binary' : result.preview,
                    name: result.relativePath?.split(/[\\/]/u).pop() ?? result.reference.name,
                    mediaType: result.mediaType ?? 'application/octet-stream',
                    sizeBytes: result.range?.total ?? 0,
                  },
                  data: result.data ?? '',
                  encoding: result.encoding,
                }))
    void request.then(
      (result) => {
        if (cancelled || generationRef.current !== generation) return
        setState({
          status: 'ready',
          value: {
            attachment: {
              id: result.attachment.id,
              kind:
                result.attachment.kind === 'text' ||
                result.attachment.kind === 'pdf' ||
                isMediaPreviewKind(result.attachment.kind)
                  ? result.attachment.kind
                  : 'binary',
              name: result.attachment.name,
              mediaType: result.attachment.mediaType,
              sizeBytes: result.attachment.sizeBytes,
            },
            data: result.data,
            encoding: result.encoding,
          },
        })
      },
      () => {
        if (cancelled || generationRef.current !== generation) return
        setState({ status: 'error', message: '附件读取失败，请重试。' })
      },
    )

    return () => {
      cancelled = true
      readAbort.abort()
    }
  }, [retryVersion, tab])

  const retry = useCallback(() => {
    setRetryVersion((version) => version + 1)
  }, [])

  return { ...state, retry }
}

async function loadThreadAttachment(
  { attachment }: UserAttachmentPreviewTab,
  attachmentId: string,
  signal: AbortSignal,
): Promise<LoadedUserAttachment> {
  if (!isChunkedAttachmentKind(attachment.kind) || attachment.sizeBytes === 0) {
    const result = await desktopClient.readAttachment(attachmentId)
    return {
      attachment: result.attachment,
      data: result.data,
      encoding: result.encoding,
    }
  }
  const data = await readAttachmentBase64Ranges(
    attachment.name,
    attachment.sizeBytes,
    async (offset, length) => {
      const result = await desktopClient.readAttachment(attachmentId, { offset, length })
      if (result.range.offset !== offset || result.range.total !== attachment.sizeBytes)
        throw new Error('附件内容发生变化')
      return result
    },
    signal,
  )
  return { attachment, data, encoding: 'base64' }
}

async function loadDraftPathAttachment(
  { attachment }: UserAttachmentPreviewTab,
  source: Extract<UserAttachmentPreviewTab['source'], { storage: 'draft-path' }>,
  signal: AbortSignal,
): Promise<LoadedUserAttachment> {
  const request = {
    grantId: source.grantId,
    ...(source.relativePath ? { relativePath: source.relativePath } : {}),
  }
  if (
    isChunkedAttachmentKind(attachment.kind) &&
    attachment.sizeBytes > 0 &&
    attachment.sizeBytes <= 20 * 1024 * 1024
  ) {
    const data = await readAttachmentBase64Ranges(
      attachment.name,
      attachment.sizeBytes,
      async (offset, length) => {
        const result = await desktopClient.readDraftComposerPath({
          ...request,
          range: { offset, length },
        })
        if (result.sizeBytes !== attachment.sizeBytes) throw new Error('附件内容发生变化')
        return result
      },
      signal,
    )
    return { attachment, data, encoding: 'base64' }
  }
  const result = await desktopClient.readDraftComposerPath(request)
  return {
    attachment: {
      id: attachment.id,
      kind: result.kind,
      name: result.name,
      mediaType: result.mediaType,
      sizeBytes: result.sizeBytes,
    },
    data: result.data ?? '',
    encoding: result.encoding ?? null,
  }
}

function decodeBase64Utf8(base64: string): string {
  try {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}
