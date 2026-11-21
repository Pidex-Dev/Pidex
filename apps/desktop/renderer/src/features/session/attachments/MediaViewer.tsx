import * as Dialog from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, PanelRight, X } from 'lucide-react'
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Button } from '../../../components/ui/Button.js'
import { useDialogFocusRestore } from '../../../components/ui/UseDialogFocusRestore.js'
import type { UserAttachmentPreviewTab } from '../../layout/dock/RightDockState.js'
import { MediaViewerContext, MediaViewerComposerTargetContext } from './MediaViewerContext.js'

const Preview = lazy(() =>
  import('./UserAttachmentPreviewPanel.js').then(({ UserAttachmentPreviewPanel }) => ({
    default: UserAttachmentPreviewPanel,
  })),
)

export function MediaViewerHost({
  children,
  onOpenInDock,
  sessionId,
}: {
  children: ReactNode
  sessionId: string | null
  onOpenInDock: (tab: UserAttachmentPreviewTab) => void
}): ReactNode {
  const [gallery, setGallery] = useState<{
    items: readonly UserAttachmentPreviewTab[]
    index: number
  } | null>(null)
  useEffect(() => setGallery(null), [sessionId])
  const controller = useMemo(
    () => ({
      open: (items: readonly UserAttachmentPreviewTab[], index: number) =>
        setGallery({ items, index }),
    }),
    [],
  )
  const tab = gallery?.items[gallery.index]
  const image = tab?.attachment.kind === 'image'
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  const [composerTarget, setComposerTarget] = useState<HTMLDivElement | null>(null)
  const { onCloseAutoFocus } = useDialogFocusRestore(Boolean(tab))
  const step = (delta: number) =>
    setGallery((current) => {
      if (!current || !current.items[current.index + delta]) return current
      return { ...current, index: current.index + delta }
    })

  return (
    <MediaViewerContext.Provider value={controller}>
      <MediaViewerComposerTargetContext.Provider value={image ? composerTarget : null}>
        {children}
      </MediaViewerComposerTargetContext.Provider>
      <Dialog.Root
        open={Boolean(tab)}
        onOpenChange={(open) => {
          if (!open) setGallery(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay
            className="ui-dialog-backdrop tw:fixed tw:inset-0 tw:z-modal tw:backdrop-blur-[10px]"
            style={{ background: '#000000a6' }}
          />
          <Dialog.Content
            className="tw:fixed tw:inset-0 tw:z-modal tw:flex tw:flex-col tw:text-app-text tw:outline-none"
            aria-describedby={undefined}
            onCloseAutoFocus={onCloseAutoFocus}
            onEscapeKeyDown={(event) => {
              if (document.fullscreenElement) event.preventDefault()
            }}
            onKeyDown={(event) => {
              if (
                event.defaultPrevented ||
                (event.target instanceof Element &&
                  event.target.closest('[data-attachment-media-player]')) ||
                !(event.target instanceof Node) ||
                !event.currentTarget.contains(event.target)
              )
                return
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault()
                step(event.key === 'ArrowLeft' ? -1 : 1)
              }
            }}
          >
            {tab && gallery ? (
              <>
                <Dialog.Title className="tw:sr-only">{tab.attachment.name}</Dialog.Title>
                <div
                  className="tw:absolute tw:top-2 tw:z-20 tw:flex tw:items-center tw:gap-1"
                  style={{
                    right:
                      'max(var(--cpx-sys-space-3), calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + var(--cpx-sys-space-3)))',
                  }}
                >
                  {image ? (
                    <div
                      ref={setToolbar}
                      className="tw:flex tw:shrink-0 tw:items-center tw:gap-1"
                    />
                  ) : null}
                  <Button
                    variant="primary"
                    className="tw:bg-app-canvas tw:text-app-text"
                    shape="round"
                    size="lg"
                    aria-label="在侧面板中打开"
                    title="在侧面板中打开"
                    onClick={() => {
                      onOpenInDock(tab)
                      setGallery(null)
                    }}
                  >
                    <PanelRight />
                    在侧面板中打开
                  </Button>
                  <Dialog.Close asChild>
                    <Button
                      isIconOnly
                      variant="primary"
                      className="tw:bg-app-canvas tw:text-app-text"
                      shape="round"
                      size="lg"
                      aria-label="关闭预览"
                    >
                      <X />
                    </Button>
                  </Dialog.Close>
                </div>
                <div className="tw:absolute tw:inset-0 tw:z-0 tw:flex tw:min-h-0 tw:flex-col tw:overflow-hidden">
                  {gallery.items.length > 1 ? (
                    <>
                      <Button
                        isIconOnly
                        shape="round"
                        size="lg"
                        aria-label="上一项"
                        className="tw:absolute tw:left-2 tw:top-1/2 tw:z-10 tw:-translate-y-1/2 tw:bg-app-canvas"
                        disabled={gallery.index === 0}
                        onClick={() => step(-1)}
                      >
                        <ChevronLeft />
                      </Button>
                      <Button
                        isIconOnly
                        shape="round"
                        size="lg"
                        aria-label="下一项"
                        className="tw:absolute tw:right-2 tw:top-1/2 tw:z-10 tw:-translate-y-1/2 tw:bg-app-canvas"
                        disabled={gallery.index === gallery.items.length - 1}
                        onClick={() => step(1)}
                      >
                        <ChevronRight />
                      </Button>
                    </>
                  ) : null}
                  <Suspense fallback={<div role="status">正在读取附件…</div>}>
                    <Preview
                      key={tab.attachment.id}
                      tab={tab}
                      fullscreen
                      imageToolbar={toolbar}
                      imageComposer={composerTarget}
                    />
                  </Suspense>
                </div>
                {image ? (
                  <div className="tw:pointer-events-none tw:absolute tw:inset-x-0 tw:bottom-4 tw:z-20 tw:flex tw:justify-center tw:px-4">
                    <div
                      ref={setComposerTarget}
                      className="tw:pointer-events-auto tw:w-full tw:max-w-[var(--cpx-sys-layout-conversation-max-width)]"
                      style={
                        { '--cpx-sys-layout-conversation-max-width': '48rem' } as CSSProperties
                      }
                    />
                  </div>
                ) : null}
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </MediaViewerContext.Provider>
  )
}
