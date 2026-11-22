// INVARIANT: the availability check reads dialog rects and Element.focus() flushes a dirty tree synchronously in Chromium, so both land on the second post-layout rAF; environments without rAF (tests) fall back to synchronous execution.
export function focusComposerIfAvailable(
  editor: HTMLElement,
  focus: () => void,
  returnFrom?: Element | null,
): void {
  if (typeof requestAnimationFrame !== 'function') {
    focusWhenAvailable(editor, focus, returnFrom)
    return
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      focusWhenAvailable(editor, focus, returnFrom)
    })
  })
}

function focusWhenAvailable(
  editor: HTMLElement,
  focus: () => void,
  returnFrom?: Element | null,
): void {
  const document = editor.ownerDocument
  const active = document.activeElement
  if (
    !editor.isConnected ||
    !document.hasFocus() ||
    editor.closest('[inert], [hidden]') ||
    (active !== document.body && !editor.contains(active) && active !== returnFrom)
  )
    return
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')
  if ([...dialogs].some((dialog) => !dialog.contains(editor) && dialog.getClientRects().length > 0))
    return
  focus()
}
