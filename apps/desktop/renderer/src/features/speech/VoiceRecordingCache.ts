import { MAX_VOICE_RECENT_RECORDINGS } from '../../../shared/SettingsSchema.js'
import type { DesktopVoiceRecordingEntry } from '../../../shared/Types.js'
import { desktopClient } from '../../services/desktop-client/index.js'

const cachedAudioBlobs = new Map<string, Blob>()

export function cacheVoiceRecordingBlob(id: string, blob: Blob): void {
  if (!id) return
  if (cachedAudioBlobs.has(id)) {
    cachedAudioBlobs.delete(id)
  }
  cachedAudioBlobs.set(id, blob)
  while (cachedAudioBlobs.size > MAX_VOICE_RECENT_RECORDINGS) {
    const oldestKey = cachedAudioBlobs.keys().next().value
    if (oldestKey === undefined) break
    cachedAudioBlobs.delete(oldestKey)
  }
}

export function getCachedVoiceRecordingBlob(id: string): Blob | null {
  return cachedAudioBlobs.get(id) ?? null
}

export function removeCachedVoiceRecordingBlob(id: string): void {
  cachedAudioBlobs.delete(id)
}

export function clearCachedVoiceRecordingBlobs(): void {
  cachedAudioBlobs.clear()
}

export function prependVoiceRecording(
  list: readonly DesktopVoiceRecordingEntry[],
  entry: DesktopVoiceRecordingEntry,
): DesktopVoiceRecordingEntry[] {
  return [entry, ...list.filter((item) => item.id !== entry.id)].slice(0, MAX_VOICE_RECENT_RECORDINGS)
}

export async function appendVoiceRecordingToSettings(
  entry: DesktopVoiceRecordingEntry,
  blob?: Blob | null,
): Promise<void> {
  if (blob) {
    cacheVoiceRecordingBlob(entry.id, blob)
  }
  try {
    const settings = await desktopClient.getDesktopSettings()
    const nextRecordings = prependVoiceRecording(settings['desktop.voice.recentRecordings'], entry)
    await desktopClient.saveDesktopSettings({
      ...settings,
      'desktop.voice.recentRecordings': nextRecordings,
    })
  } catch {
    // Recording history persistence failure should never block dictation flow.
  }
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS'])

function normalizeKeyToken(key: string): string {
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  switch (key) {
    case 'ArrowUp':
      return 'Up'
    case 'ArrowDown':
      return 'Down'
    case 'ArrowLeft':
      return 'Left'
    case 'ArrowRight':
      return 'Right'
    default:
      return key
  }
}

export function formatShortcutFromKeyboardEvent(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'key'>,
): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    return null
  }
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  parts.push(normalizeKeyToken(event.key))
  return parts.join('+')
}

export function matchesVoiceShortcut(
  event: Pick<
    KeyboardEvent,
    'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'keyCode' | 'metaKey' | 'shiftKey'
  >,
  shortcut: string,
): boolean {
  if (event.isComposing || event.keyCode === 229) return false
  const trimmed = shortcut.trim()
  if (!trimmed || trimmed === '关闭') return false
  const tokens = trimmed.split('+').map((part) => part.trim()).filter(Boolean)
  if (tokens.length === 0) return false

  let expectCtrl = false
  let expectAlt = false
  let expectShift = false
  let expectMeta = false
  let expectedKey = ''

  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') expectCtrl = true
    else if (lower === 'alt' || lower === 'option') expectAlt = true
    else if (lower === 'shift') expectShift = true
    else if (lower === 'meta' || lower === 'cmd' || lower === 'super') expectMeta = true
    else expectedKey = normalizeKeyToken(token)
  }

  if (!expectedKey) return false
  return (
    event.ctrlKey === expectCtrl &&
    event.altKey === expectAlt &&
    event.shiftKey === expectShift &&
    Boolean(event.metaKey) === expectMeta &&
    normalizeKeyToken(event.key) === expectedKey
  )
}
