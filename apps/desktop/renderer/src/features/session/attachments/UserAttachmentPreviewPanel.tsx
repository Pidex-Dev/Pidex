import { AttachmentMediaPlayer } from './AttachmentMediaPlayer.js'
import { createPortal } from 'react-dom'
import { useMediaViewer } from './MediaViewerContext.js'
import { isMediaPreviewKind } from './AttachmentPreviewSupport.js'
import { APP_ICON_SIZE } from '../../../components/ui/IconTokens.js'
import { Copy, Download, Maximize2 } from 'lucide-react'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Button } from '../../../components/ui/Button.js'
import { Select } from '../../../components/ui/Select.js'

import { SegmentedControl } from '../../../components/ui/SegmentedControl.js'
import { desktopClient, desktopClipboard } from '../../../services/desktop-client/index.js'
import { resolveLanguageFromPath } from '../../syntax/index.js'
import type { UserAttachmentPreviewTab } from '../../layout/dock/RightDockState.js'
import { type LoadedUserAttachment, useUserAttachmentPreview } from './UseUserAttachmentPreview.js'

const FileEditor = lazy(() =>
  import('../../editor/FileEditor.js').then((module) => ({ default: module.FileEditor })),
)

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MIN_IMAGE_SCALE = 0.05
const MAX_IMAGE_SCALE = 8
const IMAGE_SCALE_STEP = 1.2

type Props = {
  tab: UserAttachmentPreviewTab
  fullscreen?: boolean
  imageToolbar?: HTMLElement | null
  imageComposer?: HTMLElement | null
}

export type FormattedAttachmentText = {
  text: string
  language: string
  markdown: boolean
  jsonInvalid: boolean
}

export function UserAttachmentPreviewPanel({
  tab,
  fullscreen,
  imageToolbar,
  imageComposer,
}: Props): React.ReactNode {
  if (tab.attachment.kind === 'directory') {
    return <DirectoryAttachmentPreview tab={tab} />
  }
  return (
    <UserAttachmentFilePreview
      key={tab.attachment.id}
      tab={tab}
      fullscreen={fullscreen}
      imageToolbar={imageToolbar}
      imageComposer={imageComposer}
    />
  )
}

function UserAttachmentFilePreview({
  tab,
  fullscreen,
  imageToolbar,
  imageComposer,
}: Props): React.ReactNode {
  const viewer = useMediaViewer()
  const state = useUserAttachmentPreview(tab)

  if (state.status === 'loading') {
    return <div className="right-dock-empty-state">正在读取附件…</div>
  }
  if (state.status === 'error') {
    return (
      <div className="right-dock-empty-state">
        <strong>{state.message}</strong>
        <Button color="secondary" onClick={state.retry}>
          重试
        </Button>
      </div>
    )
  }

  const { attachment, data, encoding } = state.value
  const isMedia = isMediaPreviewKind(attachment.kind)
  const openFullscreen = viewer && isMedia && !fullscreen ? () => viewer.open([tab], 0) : undefined
  if ((attachment.kind === 'video' || attachment.kind === 'audio') && encoding === 'base64') {
    return <PlayableAttachment value={state.value} />
  }
  const supported =
    attachment.kind === 'image'
      ? encoding === 'base64' && IMAGE_MEDIA_TYPES.has(attachment.mediaType)
      : encoding === 'utf8'
  if (!supported) {
    return (
      <div className="right-dock-empty-state">
        <strong>{attachment.name}</strong>
        <span>
          {attachment.mediaType} · {formatByteSize(attachment.sizeBytes)}
        </span>
        <span>不支持应用内预览，但仍会作为本地路径上下文提供给 Agent。</span>
      </div>
    )
  }

  return attachment.kind === 'image' ? (
    <ImageAttachmentPreview
      value={state.value}
      onFullscreen={openFullscreen}
      fullscreen={fullscreen}
      imageToolbar={imageToolbar}
      imageComposer={imageComposer}
    />
  ) : (
    <TextAttachmentPreview value={state.value} />
  )
}

type DirectoryEntry = {
  name: string
  relativePath: string
  kind: 'file' | 'directory'
}

function DirectoryAttachmentPreview({ tab }: Props): React.ReactNode {
  const [relativePath, setRelativePath] = useState('')
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const request =
      tab.source.storage === 'draft-path'
        ? desktopClient
            .listDraftComposerPath({
              grantId: tab.source.grantId,
              ...(relativePath ? { relativePath } : {}),
              limit: 200,
            })
            .then((result) =>
              result.entries.map((entry) => ({
                name: entry.name,
                relativePath: entry.relativePath,
                kind: entry.pathKind,
              })),
            )
        : tab.source.storage === 'thread-path'
          ? desktopClient
              .listLocalContextPath({
                threadId: tab.source.threadId,
                referenceId: tab.source.referenceId,
                ...(relativePath ? { relativePath } : {}),
                limit: 200,
              })
              .then((result) =>
                result.entries.map((entry) => ({
                  name: entry.name,
                  relativePath: entry.relativePath,
                  kind: entry.kind,
                })),
              )
          : Promise.resolve([])
    void request.then(
      (next) => {
        if (cancelled) return
        setEntries(next)
        setLoading(false)
      },
      () => {
        if (cancelled) return
        setError('目录读取失败，请重试。')
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [relativePath, tab])

  const openEntry = (entry: DirectoryEntry): void => {
    if (entry.kind === 'directory') {
      setRelativePath(entry.relativePath)
      return
    }
    const nextTab: UserAttachmentPreviewTab = {
      ...tab,
      attachment: { ...tab.attachment, kind: 'binary', name: entry.name },
      source:
        tab.source.storage === 'draft-path'
          ? { ...tab.source, relativePath: entry.relativePath }
          : tab.source.storage === 'thread-path'
            ? { ...tab.source, relativePath: entry.relativePath }
            : tab.source,
    }
    // Keep directory navigation state local while reusing the exact file preview adapter.
    setOpenedFile(nextTab)
  }
  const [openedFile, setOpenedFile] = useState<UserAttachmentPreviewTab | null>(null)
  if (openedFile) {
    return (
      <section style={panelStyle}>
        <Button color="secondary" onClick={() => setOpenedFile(null)}>
          返回目录
        </Button>
        <UserAttachmentFilePreview tab={openedFile} />
      </section>
    )
  }
  const parent = relativePath.split(/[\\/]/u).slice(0, -1).join('/')
  return (
    <section style={panelStyle}>
      <header className="file-breadcrumb-toolbar">
        <div className="file-breadcrumb-toolbar__path">
          <strong>{tab.attachment.name}</strong>
          <span>{relativePath || '目录根'}</span>
        </div>
        {relativePath ? (
          <Button color="secondary" onClick={() => setRelativePath(parent)}>
            返回上级
          </Button>
        ) : null}
      </header>
      {loading ? <div className="right-dock-empty-state">正在读取目录…</div> : null}
      {error ? <div className="right-dock-empty-state">{error}</div> : null}
      {!loading && !error ? (
        <div className="right-dock-file-preview-scroll-area">
          {entries.length ? (
            entries.map((entry) => (
              <button
                className="attachment-directory-entry"
                key={entry.relativePath}
                onClick={() => openEntry(entry)}
                type="button"
              >
                <span>{entry.kind === 'directory' ? '📁' : '📄'}</span>
                <span>{entry.name}</span>
              </button>
            ))
          ) : (
            <div className="right-dock-empty-state">目录为空</div>
          )}
        </div>
      ) : null}
    </section>
  )
}

function AttachmentToolbar({
  value,
  children,
}: {
  value: LoadedUserAttachment
  children: React.ReactNode
}): React.ReactNode {
  return (
    <header className="file-breadcrumb-toolbar">
      <div
        className="file-breadcrumb-toolbar__path"
        style={metadataStyle}
        title={value.attachment.name}
      >
        <strong style={metadataTextStyle}>{value.attachment.name}</strong>
        <span style={metadataTextStyle}>
          {value.attachment.mediaType} · {formatByteSize(value.attachment.sizeBytes)}
        </span>
      </div>
      <div className="file-breadcrumb-toolbar__actions">{children}</div>
    </header>
  )
}

function ImageAttachmentPreview({
  value,
  onFullscreen,
  fullscreen,
  imageToolbar,
  imageComposer,
}: {
  value: LoadedUserAttachment
  onFullscreen?: () => void
  fullscreen?: boolean
  imageToolbar?: HTMLElement | null
  imageComposer?: HTMLElement | null
}): React.ReactNode {
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [message, setMessage] = useState('')
  const { source, failed, setFailed } = useMediaObjectUrl(value)

  const fitImage = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport || naturalSize.width <= 0 || naturalSize.height <= 0) return
    const bounds = viewport.getBoundingClientRect()
    const top = imageToolbar
      ? Math.max(0, imageToolbar.getBoundingClientRect().bottom - bounds.top) + 12
      : 0
    const bottom = imageComposer
      ? Math.max(0, bounds.bottom - imageComposer.getBoundingClientRect().top) + 12
      : 0
    setScale(
      calculateImageContainScale(
        viewport.clientWidth,
        Math.max(1, viewport.clientHeight - top - bottom),
        naturalSize.width,
        naturalSize.height,
      ),
    )
    setPan({ x: 0, y: (top - bottom) / 2 })
  }, [naturalSize, imageToolbar, imageComposer])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof ResizeObserver === 'undefined') return
    fitImage()
    const fitBounds = () =>
      [
        viewport.clientWidth,
        viewport.clientHeight,
        imageToolbar?.getBoundingClientRect().bottom ?? 0,
        imageComposer?.getBoundingClientRect().top ?? 0,
      ].join(':')
    let previousBounds = fitBounds()
    const observer = new ResizeObserver(() => {
      const bounds = fitBounds()
      // 百分比变化只改变工具栏宽度，不应把用户缩放重置为适应窗口。
      if (bounds === previousBounds) return
      previousBounds = bounds
      fitImage()
    })
    observer.observe(viewport)
    if (imageToolbar) observer.observe(imageToolbar)
    if (imageComposer) observer.observe(imageComposer)
    return () => observer.disconnect()
  }, [fitImage, imageToolbar, imageComposer])

  useLayoutEffect(() => {
    setNaturalSize({ width: 0, height: 0 })
    setScale(1)
    setPan({ x: 0, y: 0 })
  }, [source])

  const changeScale = useCallback((factor: number) => {
    setScale((current) => clampImageScale(current * factor))
  }, [])

  const canPan = useCallback(() => {
    const viewport = viewportRef.current
    return (
      Boolean(viewport) &&
      (naturalSize.width * scale > (viewport?.clientWidth ?? 0) ||
        naturalSize.height * scale > (viewport?.clientHeight ?? 0))
    )
  }, [naturalSize, scale])

  const handlePointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!canPan()) return
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handlePointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setPan((current) => ({
      x: current.x + event.clientX - drag.x,
      y: current.y + event.clientY - drag.y,
    }))
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }
  const handlePointerEnd = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey) {
        if (event.deltaY) changeScale(event.deltaY < 0 ? IMAGE_SCALE_STEP : 1 / IMAGE_SCALE_STEP)
      } else {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
        setPan((current) => ({
          x: current.x - event.deltaX * unit,
          y: current.y - event.deltaY * unit,
        }))
      }
    }
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [changeScale])
  const handleDownload = () => {
    setMessage('')
    void saveOriginalAttachment(value).then(
      (result) => setMessage(`已保存为 ${result.fileName}`),
      () => setMessage('下载失败，请重试。'),
    )
  }

  const controls = (
    <>
      {onFullscreen ? (
        <Button
          isIconOnly
          size="toolbar"
          aria-label="全屏预览"
          title="全屏预览"
          onClick={onFullscreen}
        >
          <Maximize2 size={APP_ICON_SIZE} />
        </Button>
      ) : null}
      <Select
        ariaLabel="图片缩放"
        triggerClassName={
          fullscreen
            ? 'tw:rounded-control tw:h-7 tw:px-3 tw:bg-app-canvas tw:text-app-text'
            : undefined
        }
        size="sm"
        value={String(scale)}
        placeholder={Math.round(scale * 100) + '%'}
        options={[
          { value: 'fit', label: '适应窗口' },
          ...[25, 50, 100, 150, 200].map((percent) => ({
            value: String(percent / 100),
            label: percent + '%',
          })),
        ]}
        onValueChange={(next) => {
          if (next === 'fit') fitImage()
          else {
            setScale(Number(next))
            setPan({ x: 0, y: 0 })
          }
        }}
      />
      <Button
        isIconOnly
        variant="primary"
        className={fullscreen ? 'tw:bg-app-canvas tw:text-app-text' : undefined}
        onClick={handleDownload}
        shape="round"
        size={fullscreen ? 'lg' : 'toolbar'}
        title="下载"
      >
        <Download size={APP_ICON_SIZE} />
      </Button>
    </>
  )

  return (
    <section style={panelStyle}>
      {fullscreen ? (
        imageToolbar && createPortal(controls, imageToolbar)
      ) : (
        <AttachmentToolbar value={value}>{controls}</AttachmentToolbar>
      )}
      <div
        ref={viewportRef}
        style={
          fullscreen ? { ...imageViewportStyle, background: 'transparent' } : imageViewportStyle
        }
      >
        {failed ? (
          <p role="status">图片无法显示。</p>
        ) : (
          source && (
            <img
              onError={() => setFailed(true)}
              alt={value.attachment.name}
              draggable={false}
              onLoad={(event) => {
                const nextSize = {
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                }
                setNaturalSize(nextSize)
              }}
              onPointerCancel={handlePointerEnd}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              src={source}
              style={{
                ...imageStyle,
                flexShrink: 0,
                cursor: canPan() ? 'grab' : 'default',
                height: naturalSize.height > 0 ? naturalSize.height * scale : undefined,
                touchAction: canPan() ? 'none' : 'auto',
                transform: `translate(${pan.x}px, ${pan.y}px)`,
                width: naturalSize.width > 0 ? naturalSize.width * scale : undefined,
              }}
            />
          )
        )}
      </div>
      <div aria-live="polite" style={messageStyle}>
        {message}
      </div>
    </section>
  )
}

function useMediaObjectUrl(value: LoadedUserAttachment) {
  const [source, setSource] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
    let url: string
    try {
      const bytes = Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0))
      url = URL.createObjectURL(new Blob([bytes], { type: value.attachment.mediaType }))
    } catch {
      setSource(null)
      setFailed(true)
      return
    }
    setSource(url)
    return () => URL.revokeObjectURL(url)
  }, [value.data, value.attachment.mediaType])
  return { source, failed, setFailed }
}

function PlayableAttachment({ value }: { value: LoadedUserAttachment }): React.ReactNode {
  const { source, failed, setFailed } = useMediaObjectUrl(value)
  if (failed)
    return (
      <div className="right-dock-empty-state" role="status">
        当前编码无法播放。
      </div>
    )
  if (!source)
    return (
      <div className="right-dock-empty-state" role="status">
        正在读取媒体…
      </div>
    )
  return (
    <AttachmentMediaPlayer
      key={source}
      kind={value.attachment.kind === 'video' ? 'video' : 'audio'}
      name={value.attachment.name}
      source={source}
      onError={() => setFailed(true)}
    />
  )
}

function TextAttachmentPreview({ value }: { value: LoadedUserAttachment }): React.ReactNode {
  const formatted = useMemo(
    () => formatAttachmentText(value.data, value.attachment.name, value.attachment.mediaType),
    [value],
  )
  const [markdownSource, setMarkdownSource] = useState(false)
  const [message, setMessage] = useState('')
  const visibleText = formatted.text

  useEffect(() => {
    setMarkdownSource(false)
    setMessage('')
  }, [value.attachment.id, value.data])

  return (
    <section style={panelStyle}>
      <AttachmentToolbar value={value}>
        {formatted.markdown ? (
          <SegmentedControl
            ariaLabel="Markdown 查看模式"
            className="file-breadcrumb-toolbar__view-mode"
            onChange={(nextValue) => setMarkdownSource(nextValue === 'source')}
            options={[
              { value: 'preview', label: '预览' },
              { value: 'source', label: '源码' },
            ]}
            overflowMode="fit"
            value={markdownSource ? 'source' : 'preview'}
          />
        ) : null}
        <Button
          isIconOnly
          color="ghostSecondary"
          onClick={() => {
            setMessage('')
            void desktopClipboard.writeText(visibleText).then(
              () => setMessage('已复制。'),
              () => setMessage('复制失败。'),
            )
          }}
          size="toolbar"
          title="复制"
        >
          <Copy size={APP_ICON_SIZE} />
        </Button>
        <Button
          isIconOnly
          color="ghostSecondary"
          onClick={() => {
            setMessage('')
            void saveOriginalAttachment(value).then(
              (result) => setMessage(`已保存为 ${result.fileName}`),
              () => setMessage('下载失败，请重试。'),
            )
          }}
          size="toolbar"
          title="下载"
        >
          <Download size={APP_ICON_SIZE} />
        </Button>
      </AttachmentToolbar>
      {formatted.jsonInvalid ? <div style={noticeStyle}>JSON 无法格式化，已显示原文。</div> : null}
      <div style={editorFrameStyle}>
        <Suspense fallback={<div className="right-dock-empty-state">正在加载文件预览…</div>}>
          <FileEditor
            ariaLabel={`${value.attachment.name} 附件预览`}
            language={formatted.language}
            onChange={() => {}}
            path={value.attachment.name}
            presentation={formatted.markdown && !markdownSource ? 'markdown-rich' : 'source'}
            readonly
            value={visibleText}
          />
        </Suspense>
      </div>
      <div aria-live="polite" style={messageStyle}>
        {message}
      </div>
    </section>
  )
}

export function formatAttachmentText(
  rawText: string,
  name: string,
  mediaType: string,
): FormattedAttachmentText {
  const normalizedMediaType = mediaType.toLowerCase().split(';', 1)[0]?.trim()
  const markdown =
    normalizedMediaType === 'text/markdown' || /\.(?:md|markdown|mdown|mkd)$/i.test(name)
  const json =
    normalizedMediaType === 'application/json' ||
    normalizedMediaType === 'application/ld+json' ||
    /\.json$/i.test(name)
  if (json) {
    try {
      return {
        text: JSON.stringify(JSON.parse(rawText), null, 2),
        language: 'json',
        markdown: false,
        jsonInvalid: false,
      }
    } catch {
      return {
        text: rawText,
        language: 'json',
        markdown: false,
        jsonInvalid: true,
      }
    }
  }
  return {
    text: rawText,
    language: markdown ? 'markdown' : resolveLanguageFromPath(name),
    markdown,
    jsonInvalid: false,
  }
}

export function calculateImageContainScale(
  viewportWidth: number,
  viewportHeight: number,
  imageWidth: number,
  imageHeight: number,
): number {
  if (viewportWidth <= 0 || viewportHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) return 1
  return clampImageScale(Math.min(1, viewportWidth / imageWidth, viewportHeight / imageHeight))
}

export function clampImageScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, scale))
}

function saveOriginalAttachment(value: LoadedUserAttachment) {
  return desktopClient.saveAttachmentToDownloads({
    kind: value.attachment.kind === 'image' ? 'image' : 'text',
    name: value.attachment.name,
    mediaType: value.attachment.mediaType,
    encoding: value.encoding ?? 'utf8',
    data: value.data,
  })
}

function formatByteSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

const panelStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flex: '1 1 auto',
  width: '100%',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  flexDirection: 'column',
  overflow: 'hidden',
}
const metadataStyle: CSSProperties = { gap: 'var(--cpx-sys-space-2)' }
const metadataTextStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const imageViewportStyle: CSSProperties = {
  display: 'flex',
  minHeight: 0,
  flex: '1 1 auto',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--cpx-comp-modal-preformat-bg)',
  overflow: 'hidden',
}
const imageStyle: CSSProperties = {
  maxWidth: 'none',
  maxHeight: 'none',
  userSelect: 'none',
}
const editorFrameStyle: CSSProperties = {
  minHeight: 0,
  flex: '1 1 auto',
  overflow: 'hidden',
}
const noticeStyle: CSSProperties = {
  padding: '6px var(--cpx-sys-space-3)',
  borderBottom: '1px solid var(--cpx-sys-color-border-subtle)',
  color: 'var(--cpx-sys-color-fg-tertiary)',
  fontSize: 'var(--cpx-sys-font-size-1)',
}
const messageStyle: CSSProperties = {
  position: 'absolute',
  right: 'var(--cpx-sys-space-3)',
  bottom: 'var(--cpx-sys-space-3)',
  color: 'var(--cpx-sys-color-fg-tertiary)',
  fontSize: 'var(--cpx-sys-font-size-1)',
  pointerEvents: 'none',
}
