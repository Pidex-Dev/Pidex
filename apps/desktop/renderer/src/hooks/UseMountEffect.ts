import { useEffect } from 'react'

/**
 * Runs a setup/cleanup effect strictly once on component mount and cleans up
 * on unmount.
 *
 * Raw `useEffect` is encapsulated inside this primitive so feature and UI
 * components cannot omit reactive dependencies by accident or mix mount
 * initialization with prop-driven re-synchronization.
 */
export function useMountEffect(effect: () => void | (() => void)): void {
  // INVARIANT: Mount effects intentionally run once with an empty dependency list; reactive updates belong in event handlers or subscription primitives.
  useEffect(effect, [])
}
