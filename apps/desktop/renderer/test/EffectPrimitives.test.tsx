import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { desktopClient } from '../src/services/desktop-client/index.js'
import {
  useExternalSubscription,
  useMediaQuery,
  useWindowEvent,
} from '../src/hooks/UseExternalSubscription.js'
import { useMountEffect } from '../src/hooks/UseMountEffect.js'
import {
  useSettingsCapabilityState,
  type SettingsCapabilityState,
} from '../src/features/settings/UseSettingsSectionVisibility.js'

type FakeElement = {
  nodeType: number
  tagName: string
  nodeName: string
  namespaceURI: string
  ownerDocument: FakeDocument
  parentNode: FakeElement | null
  childNodes: FakeElement[]
  style: Record<string, string>
  appendChild(child: FakeElement): FakeElement
  insertBefore(child: FakeElement): FakeElement
  removeChild(child: FakeElement): FakeElement
  setAttribute(): void
  removeAttribute(): void
  addEventListener(): void
  removeEventListener(): void
}

type FakeDocument = {
  nodeType: number
  defaultView: FakeWindow
  activeElement: null
  addEventListener(): void
  removeEventListener(): void
  createElement(tag: string): FakeElement
  createTextNode(text: string): Record<string, unknown>
  createComment(text: string): Record<string, unknown>
}

type FakeWindow = EventTarget & {
  HTMLIFrameElement: () => void
  document?: FakeDocument
  matchMedia?: (query: string) => MediaQueryList
}

function installDomHarness(): {
  container: HTMLElement
  windowTarget: FakeWindow
  cleanup: () => void
} {
  const win = new EventTarget() as FakeWindow
  win.HTMLIFrameElement = function HTMLIFrameElement() {}

  const createNode = (tag: string, ownerDocument: FakeDocument): FakeElement => {
    const node: FakeElement = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      ownerDocument,
      parentNode: null,
      childNodes: [],
      style: {},
      appendChild(child) {
        child.parentNode = node
        node.childNodes.push(child)
        return child
      },
      insertBefore(child) {
        child.parentNode = node
        node.childNodes.push(child)
        return child
      },
      removeChild(child) {
        node.childNodes = node.childNodes.filter((item) => item !== child)
        child.parentNode = null
        return child
      },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      removeEventListener() {},
    }
    return node
  }

  const doc: FakeDocument = {
    nodeType: 9,
    defaultView: win,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      return createNode(tag, doc)
    },
    createTextNode(text) {
      return { nodeType: 3, nodeValue: text, data: text, ownerDocument: doc, parentNode: null }
    },
    createComment(text) {
      return { nodeType: 8, nodeValue: text, data: text, ownerDocument: doc, parentNode: null }
    },
  }
  win.document = doc

  const prevAct = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
  const prevDocDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const prevWinDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true })

  return {
    container: doc.createElement('div') as unknown as HTMLElement,
    windowTarget: win,
    cleanup: () => {
      if (prevAct === undefined) {
        delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
      } else {
        ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevAct
      }
      if (prevDocDescriptor) {
        Object.defineProperty(globalThis, 'document', prevDocDescriptor)
      } else {
        delete (globalThis as Record<string, unknown>).document
      }
      if (prevWinDescriptor) {
        Object.defineProperty(globalThis, 'window', prevWinDescriptor)
      } else {
        delete (globalThis as Record<string, unknown>).window
      }
    },
  }
}

describe('controlled React effect primitives', () => {
  let harness: ReturnType<typeof installDomHarness>
  let root: Root

  beforeEach(() => {
    harness = installDomHarness()
    root = createRoot(harness.container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    harness.cleanup()
  })

  test('useMountEffect runs setup once on mount, skips re-renders, and cleans up on unmount', async () => {
    const lifecycle: string[] = []
    let triggerUpdate: ((next: number) => void) | null = null

    function MountProbe({ label }: { label: string }) {
      const [count, setCount] = useState(0)
      useMountEffect(() => {
        triggerUpdate = setCount
        lifecycle.push(`mount:${label}`)
        return () => {
          lifecycle.push(`unmount:${label}`)
        }
      })
      return (
        <span>
          {label}:{count}
        </span>
      )
    }

    await act(async () => {
      root.render(<MountProbe label="first" />)
    })
    expect(lifecycle).toEqual(['mount:first'])

    await act(async () => {
      triggerUpdate?.(1)
    })
    await act(async () => {
      root.render(<MountProbe label="second" />)
    })
    expect(lifecycle).toEqual(['mount:first'])

    await act(async () => {
      root.unmount()
    })
    expect(lifecycle).toEqual(['mount:first', 'unmount:first'])
  })

  test('useMountEffect supports void setup without returning a cleanup function', async () => {
    let calls = 0
    function VoidMountProbe({ step }: { step: number }) {
      useMountEffect(() => {
        calls += 1
      })
      return <span>{step}</span>
    }

    await act(async () => {
      root.render(<VoidMountProbe step={1} />)
    })
    await act(async () => {
      root.render(<VoidMountProbe step={2} />)
    })
    await act(async () => {
      root.unmount()
    })

    expect(calls).toBe(1)
  })

  test('useExternalSubscription subscribes, re-renders on store updates, and unsubscribes', async () => {
    let value = 'initial'
    const listeners = new Set<() => void>()
    let subscribes = 0
    let unsubscribes = 0
    const observed: string[] = []

    const subscribe = (listener: () => void): (() => void) => {
      subscribes += 1
      listeners.add(listener)
      return () => {
        unsubscribes += 1
        listeners.delete(listener)
      }
    }
    const getSnapshot = () => value
    const setStoreValue = (next: string) => {
      value = next
      for (const listener of listeners) listener()
    }

    function StoreProbe() {
      const current = useExternalSubscription(subscribe, getSnapshot)
      observed.push(current)
      return <span>{current}</span>
    }

    await act(async () => {
      root.render(<StoreProbe />)
    })
    expect(observed).toEqual(['initial'])
    expect(subscribes).toBe(1)
    expect(unsubscribes).toBe(0)

    await act(async () => {
      setStoreValue('updated')
    })
    expect(observed).toEqual(['initial', 'updated'])
    expect(subscribes).toBe(1)

    await act(async () => {
      root.unmount()
    })
    expect(unsubscribes).toBe(1)
    expect(listeners.size).toBe(0)
  })

  test('useExternalSubscription supports server rendering with explicit or default server snapshot', () => {
    let clientValue = 'client'
    const subscribe = () => () => {}

    function DefaultServerProbe() {
      return <span>{useExternalSubscription(subscribe, () => clientValue)}</span>
    }
    function ExplicitServerProbe() {
      return (
        <span>
          {useExternalSubscription(
            subscribe,
            () => clientValue,
            () => 'server',
          )}
        </span>
      )
    }

    expect(renderToStaticMarkup(<DefaultServerProbe />)).toBe('<span>client</span>')
    expect(renderToStaticMarkup(<ExplicitServerProbe />)).toBe('<span>server</span>')
  })

  test('useWindowEvent attaches once, invokes the latest handler, respects options, and cleans up', async () => {
    const target = new EventTarget()
    let addCount = 0
    let removeCount = 0
    const addOptions: unknown[] = []
    const removeOptions: unknown[] = []
    const originalAdd = target.addEventListener.bind(target)
    const originalRemove = target.removeEventListener.bind(target)
    target.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => {
      addCount += 1
      addOptions.push(options)
      originalAdd(type, listener, options)
    }) as typeof target.addEventListener
    target.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) => {
      removeCount += 1
      removeOptions.push(options)
      originalRemove(type, listener, options)
    }) as typeof target.removeEventListener

    const handled: string[] = []

    function EventProbe({ label }: { label: string }) {
      useWindowEvent(
        target,
        'ping',
        (event) => {
          const detail = event instanceof CustomEvent ? String(event.detail) : 'plain'
          handled.push(`${label}:${detail}`)
        },
        { capture: true, passive: true },
      )
      useWindowEvent(null, 'ignored', () => {
        handled.push('should-not-run')
      })
      return <span>{label}</span>
    }

    await act(async () => {
      root.render(<EventProbe label="v1" />)
    })
    expect(addCount).toBe(1)
    expect(addOptions).toEqual([{ capture: true, passive: true }])

    await act(async () => {
      target.dispatchEvent(new CustomEvent('ping', { detail: 'a' }))
    })
    expect(handled).toEqual(['v1:a'])

    await act(async () => {
      root.render(<EventProbe label="v2" />)
    })
    expect(addCount).toBe(1)
    expect(removeCount).toBe(0)

    await act(async () => {
      target.dispatchEvent(new CustomEvent('ping', { detail: 'b' }))
    })
    expect(handled).toEqual(['v1:a', 'v2:b'])

    await act(async () => {
      root.unmount()
    })
    expect(removeCount).toBe(1)
    expect(removeOptions).toEqual([{ capture: true, passive: true }])

    target.dispatchEvent(new CustomEvent('ping', { detail: 'after-unmount' }))
    expect(handled).toEqual(['v1:a', 'v2:b'])
  })

  test('useWindowEvent forwards AbortSignal options and stops delivering once aborted', async () => {
    const target = new EventTarget()
    const controller = new AbortController()
    const received: string[] = []

    function SignalProbe() {
      useWindowEvent(
        target,
        'ping',
        (event) => {
          received.push((event as CustomEvent<string>).detail)
        },
        { signal: controller.signal },
      )
      return null
    }

    await act(async () => {
      root.render(<SignalProbe />)
    })

    target.dispatchEvent(new CustomEvent('ping', { detail: 'before' }))
    controller.abort()
    target.dispatchEvent(new CustomEvent('ping', { detail: 'after' }))

    expect(received).toEqual(['before'])
  })

  test('useMediaQuery tracks media query changes and falls back cleanly when matchMedia is absent', async () => {
    const queryListeners = new Map<string, Set<() => void>>()
    const queryMatches = new Map<string, boolean>([
      ['(prefers-reduced-motion: reduce)', false],
      ['(min-width: 900px)', true],
    ])

    harness.windowTarget.matchMedia = (query: string): MediaQueryList => {
      let listeners = queryListeners.get(query)
      if (!listeners) {
        listeners = new Set()
        queryListeners.set(query, listeners)
      }
      return {
        media: query,
        get matches() {
          return queryMatches.get(query) ?? false
        },
        onchange: null,
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          if (typeof listener === 'function') listeners.add(listener as () => void)
        },
        removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          if (typeof listener === 'function') listeners.delete(listener as () => void)
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      } as unknown as MediaQueryList
    }

    const observed: boolean[] = []
    function MediaProbe({ query }: { query: string }) {
      const matches = useMediaQuery(query)
      observed.push(matches)
      return <span>{String(matches)}</span>
    }

    await act(async () => {
      root.render(<MediaProbe query="(prefers-reduced-motion: reduce)" />)
    })
    expect(observed).toEqual([false])

    await act(async () => {
      queryMatches.set('(prefers-reduced-motion: reduce)', true)
      for (const listener of queryListeners.get('(prefers-reduced-motion: reduce)') ?? []) {
        listener()
      }
    })
    expect(observed).toEqual([false, true])

    await act(async () => {
      root.render(<MediaProbe query="(min-width: 900px)" />)
    })
    expect(observed.at(-1)).toBe(true)

    delete harness.windowTarget.matchMedia
    function FallbackProbe() {
      return <span>{String(useMediaQuery('(prefers-reduced-motion: reduce)', true))}</span>
    }
    expect(renderToStaticMarkup(<FallbackProbe />)).toBe('<span>true</span>')
  })

  test('useSettingsCapabilityState shares one runtime capability fetch via useExternalSubscription', async () => {
    let resolveCapabilities!: (value: readonly string[]) => void
    const spy = spyOn(desktopClient, 'getRuntimeCapabilities').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapabilities = resolve
        }) as ReturnType<typeof desktopClient.getRuntimeCapabilities>,
    )

    const snapshotsA: SettingsCapabilityState[] = []
    const snapshotsB: SettingsCapabilityState[] = []

    function ConsumerA() {
      snapshotsA.push(useSettingsCapabilityState())
      return null
    }
    function ConsumerB() {
      snapshotsB.push(useSettingsCapabilityState())
      return null
    }

    try {
      await act(async () => {
        root.render(
          <>
            <ConsumerA />
            <ConsumerB />
          </>,
        )
      })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(snapshotsA.at(-1)).toEqual({ status: 'unknown', capabilities: null })
      expect(snapshotsB.at(-1)).toEqual({ status: 'unknown', capabilities: null })

      await act(async () => {
        resolveCapabilities(['speech.transcription.v1'])
      })

      expect(snapshotsA.at(-1)?.status).toBe('ready')
      expect(snapshotsB.at(-1)?.status).toBe('ready')
      expect(snapshotsA.at(-1)?.capabilities?.has('speech.transcription.v1')).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
