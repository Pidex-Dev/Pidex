import {
  DESKTOP_EXTERNAL_FONTS,
  type DesktopExternalFontDownloadResult,
  type DesktopExternalFontState,
} from '@pidex/shared/desktop-external-fonts'

const EXTERNAL_FONT_STYLE_PREFIX = 'cpx-external-font-'

let cachedStates: DesktopExternalFontState[] | null = null
let pendingStatesPromise: Promise<DesktopExternalFontState[]> | null = null
const loadedCssFontIds = new Set<string>()
const loadingCssPromises = new Map<string, Promise<boolean>>()

function defaultNotDownloadedStates(): DesktopExternalFontState[] {
  return DESKTOP_EXTERNAL_FONTS.map((font) => ({
    id: font.id,
    family: font.family,
    displayName: font.displayName,
    kind: font.kind,
    status: 'not-downloaded',
  }))
}

export async function listExternalFonts(forceRefresh = false): Promise<DesktopExternalFontState[]> {
  if (typeof window === 'undefined') {
    return defaultNotDownloadedStates()
  }
  const bridge = window.DesktopBridge
  if (!bridge?.listExternalFonts) {
    return defaultNotDownloadedStates()
  }
  if (!forceRefresh && cachedStates) {
    return cachedStates
  }
  if (!forceRefresh && pendingStatesPromise) {
    return pendingStatesPromise
  }
  const task = bridge
    .listExternalFonts()
    .then((states) => {
      cachedStates = states
      return states
    })
    .catch(() => defaultNotDownloadedStates())
    .finally(() => {
      if (pendingStatesPromise === task) {
        pendingStatesPromise = null
      }
    })
  pendingStatesPromise = task
  return task
}

export async function downloadExternalFont(
  fontId: string,
): Promise<DesktopExternalFontDownloadResult> {
  const bridge = typeof window !== 'undefined' ? window.DesktopBridge : undefined
  if (!bridge?.downloadExternalFont) {
    return {
      ok: false,
      state: {
        id: fontId,
        family: fontId,
        displayName: fontId,
        kind: 'ui',
        status: 'error',
        error: '当前环境不支持外部字体下载',
      },
      error: '当前环境不支持外部字体下载',
    }
  }

  const result = await bridge.downloadExternalFont(fontId)
  if (result.ok) {
    applyExternalFontCss(fontId, result.css)
  }
  if (cachedStates) {
    cachedStates = cachedStates.map((item) => (item.id === fontId ? result.state : item))
  }
  return result
}

export async function ensureExternalFontLoaded(fontId: string): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (loadedCssFontIds.has(fontId) && document.getElementById(`${EXTERNAL_FONT_STYLE_PREFIX}${fontId}`)) {
    return true
  }

  const existing = loadingCssPromises.get(fontId)
  if (existing) return existing

  const bridge = window.DesktopBridge
  if (!bridge?.getExternalFontCss) return false

  const task = bridge
    .getExternalFontCss(fontId)
    .then((css) => {
      if (!css) {
        applyExternalFontCss(fontId, null)
        if (cachedStates) {
          cachedStates = cachedStates.map((item) =>
            item.id === fontId ? { ...item, status: 'not-downloaded', error: null } : item,
          )
        }
        return false
      }
      applyExternalFontCss(fontId, css)
      return true
    })
    .catch(() => false)
    .finally(() => {
      loadingCssPromises.delete(fontId)
    })

  loadingCssPromises.set(fontId, task)
  return task
}

export function applyExternalFontCss(fontId: string, css: string | null): void {
  if (typeof document === 'undefined') return
  const styleId = `${EXTERNAL_FONT_STYLE_PREFIX}${fontId}`
  let styleEl = document.getElementById(styleId) as HTMLStyleElement | null

  if (!css) {
    loadedCssFontIds.delete(fontId)
    styleEl?.remove()
    return
  }

  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = styleId
    document.head.appendChild(styleEl)
  }
  if (styleEl.textContent !== css) {
    styleEl.textContent = css
  }
  loadedCssFontIds.add(fontId)
}

export function resetExternalFontsCache(): void {
  cachedStates = null
  pendingStatesPromise = null
  loadedCssFontIds.clear()
  loadingCssPromises.clear()
}
