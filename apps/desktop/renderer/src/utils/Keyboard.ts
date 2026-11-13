import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** Returns true when a keydown event occurs during an active IME composition. */
export function isImeComposing(event: ReactKeyboardEvent | KeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  return Boolean(native.isComposing || native.keyCode === 229)
}
