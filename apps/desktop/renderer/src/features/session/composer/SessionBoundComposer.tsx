import type React from 'react'
import { useContext } from 'react'
import { createPortal } from 'react-dom'
import { MediaViewerComposerTargetContext } from '../attachments/MediaViewerContext.js'
import { useSessionDisplayField } from '../state/SessionDisplayStore.js'
import type { SessionInputBinding } from '../state/UseSessionState.js'
import { DesktopComposer, type DesktopComposerProps } from './DesktopComposer.js'

export type SessionBoundComposerProps = Omit<DesktopComposerProps, 'input'> & {
  inputBinding: SessionInputBinding
  previewComposer?: boolean
}

export function SessionBoundComposer({
  inputBinding,
  previewComposer = false,
  ...props
}: SessionBoundComposerProps): React.ReactNode {
  const input = useSessionDisplayField(inputBinding.store, (state) => state.input)
  const target = useContext(MediaViewerComposerTargetContext)
  const composer = <DesktopComposer {...props} input={input} onInputChange={inputBinding.replace} />
  return previewComposer && target ? createPortal(composer, target) : composer
}
