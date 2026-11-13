import { CONFIG_UPDATED_EVENT, desktopClient } from '../../services/desktop-client/index.js'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DesktopThemeMode,
  DesktopThemeSettings,
  DesktopThemeVariant,
} from '../../../shared/Types.js'
import {
  getCodeThemeSelectionForVariant,
  getDesktopThemeForSelection,
  getDesktopThemeIdForVariant,
  normalizeDesktopThemeSettings,
} from '../../../shared/Theme.js'
import { deriveThemeVariables } from './ThemeVariables.js'
import { applyThemeFontFaceStyles } from './ThemeFontFaces.js'
import { ensureExternalFontLoaded } from './ThemeExternalFonts.js'
import { findExternalFontByFamily } from '@pidex/shared/desktop-external-fonts'
import {
  resolveStartupThemeSettings,
  withStartupThemeSeed,
} from '../../startup/StartupThemeSeed.js'
import {
  DesktopThemeContext,
  type DesktopThemeContextValue,
  type DesktopThemeDraft,
} from './ThemeContext.js'

const SETTINGS_THEME_VARIABLES = [
  '--cpx-sys-font-family-sans',
  '--cpx-sys-font-family-mono',
  '--cpx-sys-font-size-ui',
  '--cpx-sys-font-size-code',
  '--cpx-sys-font-size-xs',
  '--cpx-sys-font-size-sm',
  '--cpx-sys-font-size-md',
  '--cpx-sys-font-size-lg',
  '--cpx-sys-font-size-xl',
  '--cpx-sys-font-size-2xl',
  '--cpx-sys-font-size-3xl',
  '--cpx-sys-font-size-4xl',
  '--cpx-sys-font-family-mono',
  '--cpx-sys-font-family-sans',
]

export function DesktopThemeProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const [startupSettings] = useState(() => resolveStartupThemeSettings(window.location.href))
  const [settings, setSettings] = useState<DesktopThemeSettings>(startupSettings)
  const [draftSettings, setDraftSettings] = useState<DesktopThemeSettings>(startupSettings)
  const draftSettingsRef = useRef(draftSettings)
  draftSettingsRef.current = draftSettings
  const committedSettingsRef = useRef(settings)
  committedSettingsRef.current = settings
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingSavesRef = useRef(0)
  const [draftSaving, setDraftSaving] = useState(false)
  const [systemVariant, setSystemVariant] = useState<DesktopThemeVariant>(getSystemThemeVariant)
  const [systemReduceMotion, setSystemReduceMotion] = useState(getSystemReduceMotion)

  useEffect(() => {
    let mounted = true
    const syncThemeSettings = (event?: Event) => {
      if (event instanceof CustomEvent) {
        const detail = event.detail as { changedKeyPaths?: unknown } | undefined
        const changedKeyPaths = detail?.changedKeyPaths
        const touchesAppearance =
          !Array.isArray(changedKeyPaths) ||
          changedKeyPaths.length === 0 ||
          changedKeyPaths.some(
            (path) =>
              Array.isArray(path) &&
              path[0] === 'desktop' &&
              (path.length === 1 || path[1] === 'appearance'),
          )
        if (!touchesAppearance) return
      }
      if (pendingSavesRef.current > 0) return
      void desktopClient
        .getThemeSettings()
        .then((next) => {
          if (!mounted || pendingSavesRef.current > 0) return
          const normalized = normalizeDesktopThemeSettings(next)
          const hasUnsavedDraft = !desktopThemeSettingsEqual(
            draftSettingsRef.current,
            committedSettingsRef.current,
          )
          committedSettingsRef.current = normalized
          setSettings(normalized)
          if (!hasUnsavedDraft) {
            draftSettingsRef.current = normalized
            setDraftSettings(normalized)
          }
        })
        .catch(() => undefined)
    }

    syncThemeSettings()
    window.addEventListener(CONFIG_UPDATED_EVENT, syncThemeSettings)
    return () => {
      mounted = false
      window.removeEventListener(CONFIG_UPDATED_EVENT, syncThemeSettings)
    }
  }, [])

  useEffect(() => {
    const bridge = window.DesktopBridge
    let cancelled = false
    if (bridge?.getSystemTheme && bridge.onSystemThemeChange) {
      void bridge.getSystemTheme().then((theme) => {
        if (!cancelled) setSystemVariant(theme)
      })
      const unsubscribe = bridge.onSystemThemeChange(setSystemVariant)
      return () => {
        cancelled = true
        unsubscribe()
      }
    }

    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (): void => {
      setSystemVariant(query.matches ? 'dark' : 'light')
    }
    handleChange()
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handleChange = (): void => {
      setSystemReduceMotion(query.matches)
    }
    handleChange()
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  const draftResolvedVariant = draftSettings.mode === 'system' ? systemVariant : draftSettings.mode
  const reducedMotion =
    draftSettings.reduceMotion === 'system'
      ? systemReduceMotion
      : draftSettings.reduceMotion === 'on'
  const draftDirty = !desktopThemeSettingsEqual(draftSettings, settings)
  const activeTheme = useMemo(
    () => getDesktopThemeForSelection(draftSettings, draftResolvedVariant),
    [draftResolvedVariant, draftSettings],
  )

  useEffect(() => {
    if (!window.DesktopBridge) return
    const committedVariant = settings.mode === 'system' ? systemVariant : settings.mode
    const committedTheme = settings.chromeThemes[committedVariant]
    const nextUrl = withStartupThemeSeed(window.location.href, {
      version: 1,
      variant: committedVariant,
      surface: committedTheme.surface,
      ink: committedTheme.ink,
    })
    window.history.replaceState(window.history.state, '', relativeApplicationUrl(nextUrl))
  }, [settings, systemVariant])

  useEffect(() => {
    applyDesktopTheme(draftSettings, draftResolvedVariant, reducedMotion)
  }, [draftResolvedVariant, draftSettings, reducedMotion])

  useEffect(() => {
    // Inject dynamic @font-face rules that bind local font sources and
    // font-variation-settings ('wght') to dedicated application font aliases.
    const config = getDesktopThemeForSelection(draftSettings, draftResolvedVariant)
    const uiFace = config.theme.fonts.uiFace ?? null
    const codeFace = config.theme.fonts.codeFace ?? null
    applyThemeFontFaceStyles(uiFace, codeFace)
  }, [draftResolvedVariant, draftSettings])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.DesktopBridge?.getExternalFontCss) return
    let cancelled = false
    const uiExternal = findExternalFontByFamily(draftSettings.fonts.ui)
    const codeExternal = findExternalFontByFamily(draftSettings.fonts.code)
    if (!uiExternal && !codeExternal) return

    void (async () => {
      const [uiLoaded, codeLoaded] = await Promise.all([
        uiExternal ? ensureExternalFontLoaded(uiExternal.id) : Promise.resolve(true),
        codeExternal ? ensureExternalFontLoaded(codeExternal.id) : Promise.resolve(true),
      ])
      if (cancelled) return
      const missingUi = Boolean(uiExternal && !uiLoaded)
      const missingCode = Boolean(codeExternal && !codeLoaded)
      if (!missingUi && !missingCode) return

      const current = draftSettingsRef.current
      const nextFonts = {
        ...current.fonts,
        ...(missingUi && current.fonts.ui === uiExternal?.family
          ? { ui: null, uiFace: null }
          : {}),
        ...(missingCode && current.fonts.code === codeExternal?.family
          ? { code: null, codeFace: null }
          : {}),
      }
      const nextSettings = normalizeDesktopThemeSettings({ ...current, fonts: nextFonts })
      if (!desktopThemeSettingsEqual(current, nextSettings)) {
        draftSettingsRef.current = nextSettings
        setDraftSettings(nextSettings)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [draftSettings.fonts.code, draftSettings.fonts.ui])

  const persistSettings = useCallback(
    async (nextSettings: DesktopThemeSettings): Promise<DesktopThemeSettings> => {
      const normalized = normalizeDesktopThemeSettings(nextSettings)
      pendingSavesRef.current += 1
      setDraftSaving(true)
      const operation = saveQueueRef.current.then(async () => {
        await desktopClient.saveThemeSettings(normalized)
        committedSettingsRef.current = normalized
        setSettings(normalized)
      })
      saveQueueRef.current = operation.catch(() => undefined)
      try {
        await operation
        return normalized
      } catch (error) {
        if (desktopThemeSettingsEqual(draftSettingsRef.current, normalized)) {
          const rollback = committedSettingsRef.current
          draftSettingsRef.current = rollback
          setDraftSettings(rollback)
        }
        throw error
      } finally {
        pendingSavesRef.current -= 1
        if (pendingSavesRef.current === 0) setDraftSaving(false)
      }
    },
    [],
  )

  const saveSettings = useCallback(
    async (nextSettings: DesktopThemeSettings): Promise<void> => {
      const normalized = normalizeDesktopThemeSettings(nextSettings)
      draftSettingsRef.current = normalized
      setDraftSettings(normalized)
      await persistSettings(normalized)
    },
    [persistSettings],
  )

  const setMode = useCallback(
    async (mode: DesktopThemeMode): Promise<void> => {
      await saveSettings({ ...draftSettingsRef.current, mode })
    },
    [saveSettings],
  )

  const setDraftMode = useCallback((mode: DesktopThemeMode): void => {
    const normalized = normalizeDesktopThemeSettings({
      ...draftSettingsRef.current,
      mode,
    })
    draftSettingsRef.current = normalized
    setDraftSettings(normalized)
  }, [])

  const setDraftSettingsValue = useCallback((nextSettings: DesktopThemeSettings): void => {
    const normalized = normalizeDesktopThemeSettings(nextSettings)
    draftSettingsRef.current = normalized
    setDraftSettings(normalized)
  }, [])

  const saveDraft = useCallback(async (): Promise<DesktopThemeSettings> => {
    return persistSettings(draftSettingsRef.current)
  }, [persistSettings])

  const resetDraft = useCallback((): void => {
    const committed = committedSettingsRef.current
    draftSettingsRef.current = committed
    setDraftSettings(committed)
  }, [])

  const updateAndAutoSave = useCallback(
    async (updater: (current: DesktopThemeSettings) => DesktopThemeSettings): Promise<void> => {
      const normalized = normalizeDesktopThemeSettings(updater(draftSettingsRef.current))
      draftSettingsRef.current = normalized
      setDraftSettings(normalized)
      await persistSettings(normalized)
    },
    [persistSettings],
  )

  const saveDraftRef = useRef(saveDraft)
  saveDraftRef.current = saveDraft
  const autoSave = useCallback(
    (nextSettings?: DesktopThemeSettings) => {
      if (nextSettings) {
        const normalized = normalizeDesktopThemeSettings(nextSettings)
        draftSettingsRef.current = normalized
        setDraftSettings(normalized)
        void persistSettings(normalized).catch(() => undefined)
        return
      }
      setTimeout(() => {
        void saveDraftRef.current().catch(() => undefined)
      }, 0)
    },
    [persistSettings],
  )

  const draft = useMemo<DesktopThemeDraft>(
    () => ({
      settings: draftSettings,
      resolvedVariant: draftResolvedVariant,
      dirty: draftDirty,
      saving: draftSaving,
      setSettings: setDraftSettingsValue,
      setMode: setDraftMode,
      save: saveDraft,
      reset: resetDraft,
      autoSave,
      updateAndAutoSave,
    }),
    [
      autoSave,
      draftDirty,
      draftResolvedVariant,
      draftSaving,
      draftSettings,
      resetDraft,
      saveDraft,
      setDraftMode,
      setDraftSettingsValue,
      updateAndAutoSave,
    ],
  )

  const canRestorePreviousAppearance = useCallback(async (): Promise<boolean> => {
    return desktopClient.canRestorePreviousAppearance()
  }, [])

  const restorePreviousAppearance = useCallback(async (): Promise<void> => {
    const restored = await desktopClient.restorePreviousAppearance()
    const normalized = normalizeDesktopThemeSettings(restored)
    committedSettingsRef.current = normalized
    draftSettingsRef.current = normalized
    setSettings(normalized)
    setDraftSettings(normalized)
  }, [])

  const applyNewDesignTheme = useCallback(async (): Promise<void> => {
    const applied = await desktopClient.applyNewDesignTheme()
    const normalized = normalizeDesktopThemeSettings(applied)
    committedSettingsRef.current = normalized
    draftSettingsRef.current = normalized
    setSettings(normalized)
    setDraftSettings(normalized)
  }, [])

  const value = useMemo<DesktopThemeContextValue>(
    () => ({
      settings,
      resolvedVariant: draftResolvedVariant,
      activeTheme,
      codeThemeId: getCodeThemeSelectionForVariant(draftSettings, draftResolvedVariant),
      reducedMotion,
      draft,
      setMode,
      saveSettings,
      canRestorePreviousAppearance,
      restorePreviousAppearance,
      applyNewDesignTheme,
    }),
    [
      activeTheme,
      applyNewDesignTheme,
      canRestorePreviousAppearance,
      draft,
      draftResolvedVariant,
      draftSettings,
      reducedMotion,
      restorePreviousAppearance,
      saveSettings,
      setMode,
      settings,
    ],
  )

  return <DesktopThemeContext.Provider value={value}>{children}</DesktopThemeContext.Provider>
}

function applyDesktopTheme(
  settings: DesktopThemeSettings,
  variant: DesktopThemeVariant,
  reduceMotion: boolean,
): void {
  const root = document.documentElement
  root.dataset.theme = variant
  root.dataset.themeId = getDesktopThemeIdForVariant(settings, variant)
  root.dataset.windowType = window.DesktopBridge ? 'electron' : 'browser-mock'
  root.dataset.os = 'windows'
  root.classList.toggle('light-theme', variant === 'light')
  root.classList.toggle('dark-theme', variant === 'dark')
  root.classList.toggle('electron-light', variant === 'light')
  root.classList.toggle('electron-dark', variant === 'dark')
  root.dataset.pointerCursor = settings.pointerCursorEnabled ? 'on' : 'off'
  root.dataset.reduceMotion = reduceMotion ? 'on' : 'off'
  root.style.setProperty('color-scheme', variant)
  root.style.setProperty(
    '-webkit-font-smoothing',
    settings.fontSmoothingEnabled ? 'antialiased' : 'auto',
  )

  for (const variable of SETTINGS_THEME_VARIABLES) {
    root.style.removeProperty(variable)
  }

  const config = getDesktopThemeForSelection(settings, variant)
  root.dataset.codeThemeId = getCodeThemeSelectionForVariant(settings, variant)
  for (const [name, value] of Object.entries(deriveThemeVariables(config))) {
    root.style.setProperty(name, value)
  }

  const uiFontSize = clamp(settings.fontSizes.ui, 11, 16)
  const codeFontSize = clamp(settings.fontSizes.code, 8, 24)
  const scale = {
    xs: 12,
    sm: 13,
    md: 14,
    lg: 16,
    xl: 18,
    '2xl': 20,
    '3xl': 24,
    '4xl': 28,
  }

  root.style.setProperty('--cpx-sys-font-size-ui', `${uiFontSize}px`)
  root.style.setProperty('--cpx-sys-font-size-code', `${codeFontSize}px`)
  for (const [name, base] of Object.entries(scale)) {
    root.style.setProperty(
      `--cpx-sys-font-size-${name}`,
      `${Math.round((base * uiFontSize) / 14)}px`,
    )
  }
}

function relativeApplicationUrl(url: string): string {
  const parsed = new URL(url)
  return parsed.pathname + parsed.search + parsed.hash
}

function getSystemThemeVariant(): DesktopThemeVariant {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getSystemReduceMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function desktopThemeSettingsEqual(
  left: DesktopThemeSettings,
  right: DesktopThemeSettings,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
