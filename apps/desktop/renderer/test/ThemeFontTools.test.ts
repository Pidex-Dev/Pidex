import { describe, expect, test } from 'bun:test'
import { findExternalFontById } from '@pidex/shared/desktop-external-fonts'

import {
  DEFAULT_CODE_FONT,
  DEFAULT_DARK_THEME,
  DEFAULT_DESKTOP_THEME_SETTINGS,
  DEFAULT_UI_FONT,
  getDesktopThemeForSelection,
  normalizeDesktopThemeSettings,
} from '../shared/Theme.js'
import { mergeChromeThemeSeed } from '../src/features/theme/CodeThemeSeed.js'
import {
  escapeCssString,
  extractWeightFromFace,
  fontFamilyWithFace,
  generateExternalFontFaceCss,
  generateThemeFontFaceCss,
  themeFontFaceAlias,
} from '../src/features/theme/ThemeFontFaces.js'
import {
  DEFAULT_WEIGHT_VALUE,
  SYSTEM_DEFAULT_FAMILY_VALUE,
  buildFamilyOptions,
  buildWeightOptions,
  faceForExternalWeight,
  fontPickerCurrentFamilyValue,
  selectedWeightValue,
} from '../src/features/settings/ThemeFontPickerModel.js'
import { deriveThemeVariables } from '../src/features/theme/ThemeVariables.js'

describe('theme font loading tool', () => {
  test('escapes CSS string special characters in alias sources', () => {
    expect(escapeCssString('plain')).toBe('plain')
    expect(escapeCssString('a"b\\c')).toBe('a\\"b\\\\c')
  })

  test('extracts weight axes accurately across named styles', () => {
    expect(
      extractWeightFromFace({ family: 'F', fullName: 'F Thin', postscriptName: 'F-Thin' }),
    ).toBe(100)
    expect(
      extractWeightFromFace({ family: 'F', fullName: 'F Light', postscriptName: 'F-Light' }),
    ).toBe(300)
    expect(
      extractWeightFromFace({ family: 'F', fullName: 'F Regular', postscriptName: 'F-Regular' }),
    ).toBe(400)
    expect(
      extractWeightFromFace({ family: 'F', fullName: 'F Medium', postscriptName: 'F-Medium' }),
    ).toBe(500)
    expect(
      extractWeightFromFace({ family: 'F', fullName: 'F SemiBold', postscriptName: 'F-SemiBold' }),
    ).toBe(600)
    expect(
      extractWeightFromFace({ family: 'F', fullName: 'F Bold', postscriptName: 'F-Bold' }),
    ).toBe(700)
    expect(
      extractWeightFromFace({ family: 'F', fullName: 'F Heavy', postscriptName: 'F-Heavy' }),
    ).toBe(900)
  })

  test('generates dynamic @font-face CSS with local sources and variation settings', () => {
    const face = {
      family: 'MiSans VF',
      fullName: 'MiSans VF Heavy',
      postscriptName: 'MiSans-VF-Heavy',
    }
    const css = generateThemeFontFaceCss('Pidex-Selected-Sans', face)
    expect(css).toContain('font-family: "Pidex-Selected-Sans"')
    expect(css).toContain('local("MiSans VF Heavy")')
    expect(css).toContain('local("MiSans-VF-Heavy")')
    expect(css).toContain('local("MiSans VF")')
    expect(css).toContain("font-variation-settings: 'wght' 900")
  })

  test('places the alias and face names before the fallback stack and falls back without a face', () => {
    const face = {
      family: 'JetBrains Mono',
      fullName: 'JetBrains Mono Regular',
      postscriptName: 'JetBrainsMono-Regular',
    }
    expect(fontFamilyWithFace(face, 'Inter, sans-serif', 'code')).toBe(
      '"Pidex-Selected-Mono", "JetBrains Mono Regular", "JetBrains Mono", Inter, sans-serif',
    )
    expect(fontFamilyWithFace(null, 'Inter, sans-serif')).toBe('Inter, sans-serif')
    expect(fontFamilyWithFace(undefined, 'Inter, sans-serif')).toBe('Inter, sans-serif')
  })

  test('deriveThemeVariables composes dynamic face aliases into font variables', () => {
    const variables = deriveThemeVariables({
      ...DEFAULT_DARK_THEME,
      theme: {
        ...DEFAULT_DARK_THEME.theme,
        fonts: {
          ui: 'Inter',
          uiFace: {
            family: 'Inter',
            fullName: 'Inter Bold',
            postscriptName: 'Inter-Bold',
          },
          code: 'CodeMono',
          codeFace: {
            family: 'CodeMono',
            fullName: 'CodeMono Regular',
            postscriptName: 'CodeMono-Regular',
          },
        },
      },
    })

    expect(variables['--cpx-sys-font-family-sans']).toBe(
      `"Pidex-Selected-Sans", "Inter Bold", "Inter", ${DEFAULT_UI_FONT}`,
    )
    expect(variables['--cpx-sys-font-family-mono']).toBe(
      `"Pidex-Selected-Mono", "CodeMono Regular", "CodeMono", ${DEFAULT_CODE_FONT}`,
    )
  })

  test('mergeChromeThemeSeed clears stale faces when a family changes', () => {
    const current = {
      ...DEFAULT_DARK_THEME.theme,
      fonts: {
        ui: 'JetBrains Mono',
        uiFace: {
          family: 'JetBrains Mono',
          fullName: 'JetBrains Mono Bold',
          postscriptName: 'JetBrainsMono-Bold',
        },
        code: null,
        codeFace: null,
      },
    }
    const merged = mergeChromeThemeSeed(current, {
      surface: current.surface,
      ink: current.ink,
      accent: current.accent,
      fonts: { ui: 'Inter', code: null },
    })

    expect(merged.fonts.ui).toBe('Inter')
    expect(merged.fonts.uiFace).toBeNull()
    expect(merged.fonts.codeFace).toBeNull()
  })

  test('mergeChromeThemeSeed keeps faces when the family is unchanged', () => {
    const uiFace = {
      family: 'Inter',
      fullName: 'Inter Bold',
      postscriptName: 'Inter-Bold',
    }
    const current = {
      ...DEFAULT_DARK_THEME.theme,
      fonts: {
        ui: 'Inter',
        uiFace,
        code: null,
        codeFace: null,
      },
    }
    const merged = mergeChromeThemeSeed(current, {
      surface: current.surface,
      ink: current.ink,
      accent: current.accent,
      fonts: { ui: 'Inter', code: 'CodeMono' },
    })

    expect(merged.fonts.uiFace).toEqual(uiFace)
    expect(merged.fonts.codeFace).toBeNull()
  })
})

const V7_FONTS = {
  light: { ui: 'Inter', uiFace: null, code: 'JetBrains Mono', codeFace: null },
  dark: { ui: 'PrettySans', uiFace: null, code: 'Cascadia Code', codeFace: null },
}

/** A V7 document: fonts still live on each variant, none at the top level. */
function v7Document(mode: 'system' | 'light' | 'dark') {
  return {
    version: 7,
    mode,
    chromeThemes: {
      light: { ...DEFAULT_DESKTOP_THEME_SETTINGS.chromeThemes.light, fonts: { ...V7_FONTS.light } },
      dark: { ...DEFAULT_DESKTOP_THEME_SETTINGS.chromeThemes.dark, fonts: { ...V7_FONTS.dark } },
    },
    codeThemeIds: { light: 'codex-new-light', dark: 'codex-new-dark' },
    pointerCursorEnabled: false,
    reduceMotion: 'system',
    fontSmoothingEnabled: true,
    fontSizes: { ui: 14, code: 13 },
  }
}

describe('renderer V6 → V8 normalization', () => {
  test('preserves every V6 value and adds null faces', () => {
    const migrated = normalizeDesktopThemeSettings({
      version: 6,
      mode: 'dark',
      codeThemeIds: { light: 'github-light-default', dark: 'dracula' },
      chromeThemes: {
        light: {
          accent: '#abcdef',
          surface: '#fefefe',
          ink: '#111111',
          contrast: 42,
          fonts: { ui: 'Inter', code: 'JetBrains Mono' },
          semanticColors: {
            diffAdded: '#00a240',
            diffRemoved: '#ba2623',
            skill: '#924ff7',
          },
        },
        dark: {
          accent: '#339cff',
          surface: '#181818',
          ink: '#ffffff',
          contrast: 60,
          fonts: { ui: null, code: null },
          semanticColors: {
            diffAdded: '#40c977',
            diffRemoved: '#fa423e',
            skill: '#ad7bf9',
          },
        },
      },
      pointerCursorEnabled: true,
      reduceMotion: 'off',
      fontSmoothingEnabled: false,
      fontSizes: { ui: 15, code: 13 },
    })

    expect(migrated).toMatchObject({
      version: 8,
      mode: 'dark',
      codeThemeIds: { light: 'github-light-default', dark: 'dracula' },
      pointerCursorEnabled: true,
      reduceMotion: 'off',
      fontSmoothingEnabled: false,
      fontSizes: { ui: 15, code: 13 },
    })
    expect(migrated.chromeThemes.light).toMatchObject({
      accent: '#abcdef',
      surface: '#fefefe',
      ink: '#111111',
      contrast: 42,
    })
    // V7 stored fonts per variant; the mode's variant owns the shared value
    // and both variants keep mirroring it for variant-shaped readers.
    expect(migrated.fonts).toEqual({
      ui: 'Inter',
      uiFace: null,
      code: 'JetBrains Mono',
      codeFace: null,
    })
    for (const variant of ['light', 'dark'] as const) {
      expect(migrated.chromeThemes[variant].fonts).toEqual(migrated.fonts)
    }
  })

  test('keeps valid faces and drops invalid or oversized ones', () => {
    const normalized = normalizeDesktopThemeSettings({
      ...v7Document('light'),
      version: 7,
      chromeThemes: {
        light: {
          ...DEFAULT_DESKTOP_THEME_SETTINGS.chromeThemes.light,
          fonts: {
            ui: 'Inter',
            uiFace: {
              family: 'Inter',
              fullName: 'Inter Bold',
              postscriptName: 'Inter-Bold',
            },
            codeFace: {
              family: 'X'.repeat(201),
              fullName: 'Y',
              postscriptName: 'Z',
            },
          },
        },
        dark: DEFAULT_DESKTOP_THEME_SETTINGS.chromeThemes.dark,
      },
    })

    expect(normalized.fonts.uiFace).toEqual({
      family: 'Inter',
      fullName: 'Inter Bold',
      postscriptName: 'Inter-Bold',
    })
    expect(normalized.fonts.codeFace).toBeNull()
    // The configured light variant wins over the untouched default variant.
    expect(normalized.fonts.ui).toBe('Inter')
    expect(normalized.chromeThemes.dark.fonts).toEqual(normalized.fonts)
  })

  test('drops a face when it does not match the selected family', () => {
    const normalized = normalizeDesktopThemeSettings({
      ...v7Document('light'),
      version: 7,
      chromeThemes: {
        ...DEFAULT_DESKTOP_THEME_SETTINGS.chromeThemes,
        dark: {
          ...DEFAULT_DESKTOP_THEME_SETTINGS.chromeThemes.dark,
          fonts: {
            ui: 'Inter',
            uiFace: {
              family: 'JetBrains Mono',
              fullName: 'JetBrains Mono Bold',
              postscriptName: 'JetBrainsMono-Bold',
            },
          },
        },
      },
    })

    expect(normalized.fonts.ui).toBe('Inter')
    expect(normalized.fonts.uiFace).toBeNull()
  })
})

describe('renderer V7 → V8 shared fonts', () => {
  test('the mode variant owns the shared fonts and both variants keep mirroring them', () => {
    expect(normalizeDesktopThemeSettings(v7Document('light')).fonts).toEqual(V7_FONTS.light)
    expect(normalizeDesktopThemeSettings(v7Document('dark')).fonts).toEqual(V7_FONTS.dark)
  })

  test('system mode keeps one font set for both variants instead of the default variant', () => {
    const settings = normalizeDesktopThemeSettings(v7Document('system'))

    expect(settings.fonts).toEqual(V7_FONTS.light)
    expect(settings.chromeThemes.light.fonts).toEqual(settings.fonts)
    expect(settings.chromeThemes.dark.fonts).toEqual(settings.fonts)
  })

  test('system mode ignores the untouched default variant', () => {
    const document = v7Document('system')
    document.chromeThemes.light.fonts = { ui: null, uiFace: null, code: null, codeFace: null }

    expect(normalizeDesktopThemeSettings(document).fonts).toEqual(V7_FONTS.dark)
  })

  test('both variants resolve the same fonts while colors stay variant-specific', () => {
    const settings = normalizeDesktopThemeSettings({
      ...DEFAULT_DESKTOP_THEME_SETTINGS,
      fonts: { ui: 'Inter', uiFace: null, code: 'CodeMono', codeFace: null },
    })

    for (const variant of ['light', 'dark'] as const) {
      expect(getDesktopThemeForSelection(settings, variant).theme.fonts).toEqual(settings.fonts)
    }
    expect(getDesktopThemeForSelection(settings, 'light').theme.surface).not.toBe(
      getDesktopThemeForSelection(settings, 'dark').theme.surface,
    )
  })
})

describe('external fonts in ThemeFontPickerModel', () => {
  test('lists only curated external fonts by kind with download status', () => {
    const uiOptions = buildFamilyOptions({
      kind: 'ui',
      externalFonts: [
        {
          id: 'misans',
          family: 'MiSans',
          displayName: 'MiSans',
          kind: 'ui',
          status: 'downloaded',
        },
        {
          id: 'google-sans',
          family: 'Google Sans',
          displayName: 'Google Sans',
          kind: 'ui',
          status: 'not-downloaded',
        },
        {
          id: 'jetbrains-mono',
          family: 'JetBrains Mono',
          displayName: 'JetBrains Mono',
          kind: 'code',
          status: 'not-downloaded',
        },
        {
          id: 'google-sans-code',
          family: 'Google Sans Code',
          displayName: 'Google Sans Code',
          kind: 'code',
          status: 'downloaded',
        },
      ],
    })

    expect(uiOptions).toEqual([
      { value: '__system_default_family__', label: '系统默认' },
      {
        value: 'MiSans',
        label: 'MiSans',
        disabled: false,
        externalStatus: 'downloaded',
      },
      {
        value: 'Google Sans',
        label: 'Google Sans',
        disabled: false,
        externalStatus: 'not-downloaded',
      },
    ])

    const codeOptions = buildFamilyOptions({ kind: 'code' })
    expect(codeOptions).toEqual([
      { value: '__system_default_family__', label: '系统默认' },
      {
        value: 'JetBrains Mono',
        label: 'JetBrains Mono',
        disabled: false,
        externalStatus: 'not-downloaded',
      },
      {
        value: 'Google Sans Code',
        label: 'Google Sans Code',
        disabled: false,
        externalStatus: 'not-downloaded',
      },
    ])
  })

  test('falls back legacy non-catalog fonts to system default', () => {
    expect(fontPickerCurrentFamilyValue('Arial', 'ui')).toBe(SYSTEM_DEFAULT_FAMILY_VALUE)
    expect(fontPickerCurrentFamilyValue('Google Sans', 'ui')).toBe('Google Sans')
    expect(fontPickerCurrentFamilyValue('Google Sans', 'code')).toBe(SYSTEM_DEFAULT_FAMILY_VALUE)

    const vars = deriveThemeVariables({
      ...DEFAULT_DARK_THEME,
      theme: {
        ...DEFAULT_DARK_THEME.theme,
        fonts: { ui: 'Arial', uiFace: null, code: 'Consolas', codeFace: null },
      },
    })
    expect(vars['--cpx-sys-font-family-sans']).toBe(DEFAULT_UI_FONT)
    expect(vars['--cpx-sys-font-family-mono']).toBe(DEFAULT_CODE_FONT)
  })

  test('supports per-font weight options and generates external weight alias CSS', () => {
    const jbSpec = findExternalFontById('jetbrains-mono')!
    const weightOptions = buildWeightOptions(jbSpec)
    expect(weightOptions.map((o) => o.label)).toContain('ExtraBold')
    expect(selectedWeightValue(jbSpec, null)).toBe(DEFAULT_WEIGHT_VALUE)

    const extraBoldFace = faceForExternalWeight(jbSpec, '800')
    expect(extraBoldFace).toEqual({
      family: 'JetBrains Mono',
      fullName: 'JetBrains Mono ExtraBold',
      postscriptName: 'JetBrainsMono-ExtraBold',
    })
    expect(selectedWeightValue(jbSpec, extraBoldFace)).toBe('800')
    expect(faceForExternalWeight(jbSpec, '400')).toBeNull()

    const jbAliasCss = generateExternalFontFaceCss(
      'Pidex-Selected-Mono',
      jbSpec,
      `@font-face { font-family: 'JetBrains Mono'; font-weight: 100 800; src: url(data:font/woff2;base64,AAA); }`,
      extraBoldFace!,
    )
    expect(jbAliasCss).toContain('font-family: "Pidex-Selected-Mono"')
    expect(jbAliasCss).toContain("font-variation-settings: 'wght' 800;")

    const miSpec = findExternalFontById('misans')!
    const miMediumFace = faceForExternalWeight(miSpec, '500')!
    const miAliasCss = generateExternalFontFaceCss(
      'Pidex-Selected-Sans',
      miSpec,
      `@font-face{font-family: 'MiSans';font-weight:330;src:url(data:font/woff2;base64,R);}
@font-face{font-family: 'MiSans';font-weight:380;src:url(data:font/woff2;base64,M);}`,
      miMediumFace,
    )
    expect(miAliasCss).toContain('font-family: "Pidex-Selected-Sans"')
    expect(miAliasCss).toContain('font-weight: 100 900')
    expect(miAliasCss).toContain('base64,M')
    expect(miAliasCss).not.toContain('base64,R')
  })
})
