import { createContext, useContext } from 'react'
import type { UserAttachmentPreviewTab } from '../../layout/dock/RightDockState.js'

export const MediaViewerContext = createContext<{
  open: (items: readonly UserAttachmentPreviewTab[], index: number) => void
} | null>(null)

export function useMediaViewer() {
  return useContext(MediaViewerContext)
}

export const MediaViewerComposerTargetContext = createContext<HTMLElement | null>(null)
