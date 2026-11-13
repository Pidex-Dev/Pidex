export type DesktopExternalFontKind = 'ui' | 'code'

export type DesktopExternalFontWeightOption = {
  label: string
  weight: number
  sourceWeight?: number
}

export type DesktopExternalFontSpec = {
  id: string
  family: string
  displayName: string
  kind: DesktopExternalFontKind
  fontsourcePackage: string
  fontsourceVersion: string
  cssEntryFiles: readonly string[]
  sourceFamilyName: string
  isVariable: boolean
  weights: readonly DesktopExternalFontWeightOption[]
}

export const DESKTOP_EXTERNAL_FONTS: readonly DesktopExternalFontSpec[] = [
  {
    id: 'misans',
    family: 'MiSans',
    displayName: 'MiSans',
    kind: 'ui',
    fontsourcePackage: 'misans',
    fontsourceVersion: '4.1.0',
    cssEntryFiles: [
      'lib/Normal/MiSans-Regular.min.css',
      'lib/Normal/MiSans-Medium.min.css',
      'lib/Normal/MiSans-Demibold.min.css',
      'lib/Normal/MiSans-Bold.min.css',
    ],
    sourceFamilyName: 'MiSans',
    isVariable: false,
    weights: [
      { label: 'Regular', weight: 400, sourceWeight: 330 },
      { label: 'Medium', weight: 500, sourceWeight: 380 },
      { label: 'Demibold', weight: 600, sourceWeight: 450 },
      { label: 'Bold', weight: 700, sourceWeight: 630 },
    ],
  },
  {
    id: 'google-sans',
    family: 'Google Sans',
    displayName: 'Google Sans',
    kind: 'ui',
    fontsourcePackage: '@fontsource-variable/google-sans',
    fontsourceVersion: '5.3.2',
    cssEntryFiles: ['index.css'],
    sourceFamilyName: 'Google Sans Variable',
    isVariable: true,
    weights: [
      { label: 'Regular', weight: 400 },
      { label: 'Medium', weight: 500 },
      { label: 'SemiBold', weight: 600 },
      { label: 'Bold', weight: 700 },
    ],
  },
  {
    id: 'jetbrains-mono',
    family: 'JetBrains Mono',
    displayName: 'JetBrains Mono',
    kind: 'code',
    fontsourcePackage: '@fontsource-variable/jetbrains-mono',
    fontsourceVersion: '5.2.5',
    cssEntryFiles: ['index.css'],
    sourceFamilyName: 'JetBrains Mono Variable',
    isVariable: true,
    weights: [
      { label: 'Thin', weight: 100 },
      { label: 'ExtraLight', weight: 200 },
      { label: 'Light', weight: 300 },
      { label: 'Regular', weight: 400 },
      { label: 'Medium', weight: 500 },
      { label: 'SemiBold', weight: 600 },
      { label: 'Bold', weight: 700 },
      { label: 'ExtraBold', weight: 800 },
    ],
  },
  {
    id: 'google-sans-code',
    family: 'Google Sans Code',
    displayName: 'Google Sans Code',
    kind: 'code',
    fontsourcePackage: '@fontsource-variable/google-sans-code',
    fontsourceVersion: '5.3.2',
    cssEntryFiles: ['index.css'],
    sourceFamilyName: 'Google Sans Code Variable',
    isVariable: true,
    weights: [
      { label: 'Light', weight: 300 },
      { label: 'Regular', weight: 400 },
      { label: 'Medium', weight: 500 },
      { label: 'SemiBold', weight: 600 },
      { label: 'Bold', weight: 700 },
      { label: 'ExtraBold', weight: 800 },
    ],
  },
] as const

export type DesktopExternalFontStatus =
  | 'not-downloaded'
  | 'downloading'
  | 'downloaded'
  | 'error'

export type DesktopExternalFontState = {
  id: string
  family: string
  displayName: string
  kind: DesktopExternalFontKind
  status: DesktopExternalFontStatus
  error?: string | null
}

export type DesktopExternalFontDownloadResult =
  | {
      ok: true
      state: DesktopExternalFontState
      css: string
    }
  | {
      ok: false
      state: DesktopExternalFontState
      error: string
    }

export function findExternalFontById(id: string): DesktopExternalFontSpec | undefined {
  return DESKTOP_EXTERNAL_FONTS.find((font) => font.id === id)
}

export function findExternalFontByFamily(
  family: string | null | undefined,
): DesktopExternalFontSpec | undefined {
  if (!family) return undefined
  const normalized = family.trim().toLowerCase()
  return DESKTOP_EXTERNAL_FONTS.find((font) => font.family.toLowerCase() === normalized)
}

export function listExternalFontsForKind(
  kind: DesktopExternalFontKind,
): readonly DesktopExternalFontSpec[] {
  return DESKTOP_EXTERNAL_FONTS.filter((font) => font.kind === kind)
}
