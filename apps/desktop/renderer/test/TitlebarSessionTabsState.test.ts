import { describe, expect, test } from 'bun:test'
import {
  closeTitlebarSessionTab,
  normalizeTitlebarSessionTabIds,
  openTitlebarSessionTab,
  pruneTitlebarSessionTabs,
  readStoredTitlebarSessionTabIds,
  TITLEBAR_SESSION_TABS_STORAGE_KEY,
  writeStoredTitlebarSessionTabIds,
} from '../src/features/layout/tabs/TitlebarSessionTabsState.js'

describe('TitlebarSessionTabsState', () => {
  test('normalizeTitlebarSessionTabIds deduplicates, trims, and filters non-strings', () => {
    expect(normalizeTitlebarSessionTabIds(['s1', '  s2 ', 's1', '', 123, null])).toEqual([
      's1',
      's2',
    ])
    expect(normalizeTitlebarSessionTabIds(null)).toEqual([])
    expect(normalizeTitlebarSessionTabIds('not an array')).toEqual([])
  })

  test('reads and writes tabs to storage correctly', () => {
    const store = new Map<string, string>()
    const mockStorage: Storage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value)
      },
      removeItem: (key) => {
        store.delete(key)
      },
      clear: () => store.clear(),
      key: (i) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size
      },
    }

    expect(readStoredTitlebarSessionTabIds(mockStorage)).toEqual([])

    writeStoredTitlebarSessionTabIds(['session-1', 'session-2'], mockStorage)
    expect(store.get(TITLEBAR_SESSION_TABS_STORAGE_KEY)).toBe(
      JSON.stringify(['session-1', 'session-2']),
    )
    expect(readStoredTitlebarSessionTabIds(mockStorage)).toEqual(['session-1', 'session-2'])
  })

  test('openTitlebarSessionTab appends new session or keeps existing order', () => {
    expect(openTitlebarSessionTab(['s1', 's2'], 's3')).toEqual(['s1', 's2', 's3'])
    expect(openTitlebarSessionTab(['s1', 's2'], 's1')).toEqual(['s1', 's2'])
    expect(openTitlebarSessionTab(['s1', 's2'], '')).toEqual(['s1', 's2'])
  })

  test('closeTitlebarSessionTab handles closing inactive tab without navigation', () => {
    const result = closeTitlebarSessionTab(['s1', 's2', 's3'], 's2', 's1')
    expect(result.nextTabIds).toEqual(['s1', 's3'])
    expect(result.nextActiveSessionId).toBeUndefined()
  })

  test('closeTitlebarSessionTab handles closing active tab with adjacent fallback', () => {
    // Closing middle tab activates next tab
    const r1 = closeTitlebarSessionTab(['s1', 's2', 's3'], 's2', 's2')
    expect(r1.nextTabIds).toEqual(['s1', 's3'])
    expect(r1.nextActiveSessionId).toBe('s3')

    // Closing last tab activates preceding tab
    const r2 = closeTitlebarSessionTab(['s1', 's2', 's3'], 's3', 's3')
    expect(r2.nextTabIds).toEqual(['s1', 's2'])
    expect(r2.nextActiveSessionId).toBe('s2')

    // Closing sole tab falls back to null (new chat)
    const r3 = closeTitlebarSessionTab(['s1'], 's1', 's1')
    expect(r3.nextTabIds).toEqual([])
    expect(r3.nextActiveSessionId).toBeNull()
  })

  test('pruneTitlebarSessionTabs removes missing sessions while protecting active pending session', () => {
    const valid = new Set(['s1', 's3'])
    expect(pruneTitlebarSessionTabs(['s1', 's2', 's3'], valid)).toEqual(['s1', 's3'])
    expect(pruneTitlebarSessionTabs(['s1', 's2', 's3'], valid, 's2')).toEqual(['s1', 's2', 's3'])
  })
})
