import { useCallback, useEffect, useEffectEvent, useSyncExternalStore } from 'react'

/**
 * Subscribes a React component to an external mutable store or event source
 * using `useSyncExternalStore`.
 *
 * Centralizing external subscriptions behind this primitive prevents manual
 * `useState` + `useEffect` subscription tearing, handles concurrent renders
 * safely, and defaults `getServerSnapshot` to `getSnapshot` so static server
 * rendering behaves consistently.
 */
export function useExternalSubscription<T>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot ?? getSnapshot)
}

/**
 * Subscribes to a DOM `EventTarget` event while storing the latest callback in
 * a ref so event listeners stay stable across renders without raw `useEffect`
 * boilerplate in components.
 */
export function useWindowEvent<K extends keyof WindowEventMap>(
  target: Window | null | undefined,
  eventName: K,
  handler: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void
export function useWindowEvent<K extends keyof DocumentEventMap>(
  target: Document | null | undefined,
  eventName: K,
  handler: (event: DocumentEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void
export function useWindowEvent<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | null | undefined,
  eventName: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void
export function useWindowEvent(
  target: EventTarget | null | undefined,
  eventName: string,
  handler: (event: Event) => void,
  options?: boolean | AddEventListenerOptions,
): void
export function useWindowEvent(
  target: EventTarget | null | undefined,
  eventName: string,
  handler: (event: never) => void,
  options?: boolean | AddEventListenerOptions,
): void {
  const onEvent = useEffectEvent((event: Event) => {
    handler(event as never)
  })

  const capture = typeof options === 'boolean' ? options : options?.capture
  const passive = typeof options === 'boolean' ? undefined : options?.passive
  const once = typeof options === 'boolean' ? undefined : options?.once
  const signal = typeof options === 'boolean' ? undefined : options?.signal

  // INVARIANT: Raw useEffect is encapsulated here solely to synchronize DOM EventTarget listener registration with mount/unmount and option changes.
  useEffect(() => {
    if (!target) return

    const listener = (event: Event): void => {
      onEvent(event)
    }

    const listenerOptions: boolean | AddEventListenerOptions | undefined =
      typeof capture === 'boolean' &&
      passive === undefined &&
      once === undefined &&
      signal === undefined
        ? capture
        : capture !== undefined ||
            passive !== undefined ||
            once !== undefined ||
            signal !== undefined
          ? {
              ...(capture !== undefined ? { capture } : {}),
              ...(passive !== undefined ? { passive } : {}),
              ...(once !== undefined ? { once } : {}),
              ...(signal !== undefined ? { signal } : {}),
            }
          : undefined

    target.addEventListener(eventName, listener, listenerOptions)
    return () => {
      target.removeEventListener(eventName, listener, listenerOptions)
    }
  }, [target, eventName, capture, passive, once, signal])
}

/**
 * Subscribes to a CSS media query via `useExternalSubscription` and returns
 * whether it currently matches, falling back to `defaultMatches` when
 * `window.matchMedia` is unavailable.
 */
export function useMediaQuery(query: string, defaultMatches = false): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {}
      }
      const mediaQueryList = window.matchMedia(query)
      if (typeof mediaQueryList.addEventListener === 'function') {
        mediaQueryList.addEventListener('change', onStoreChange)
        return () => {
          mediaQueryList.removeEventListener('change', onStoreChange)
        }
      }
      mediaQueryList.addListener(onStoreChange)
      return () => {
        mediaQueryList.removeListener(onStoreChange)
      }
    },
    [query],
  )

  const getSnapshot = useCallback((): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return defaultMatches
    }
    return window.matchMedia(query).matches
  }, [defaultMatches, query])

  const getServerSnapshot = useCallback((): boolean => defaultMatches, [defaultMatches])

  return useExternalSubscription(subscribe, getSnapshot, getServerSnapshot)
}
