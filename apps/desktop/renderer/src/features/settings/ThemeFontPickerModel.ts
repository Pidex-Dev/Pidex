import {
  findExternalFontByFamily,
  listExternalFontsForKind,
  type DesktopExternalFontKind,
  type DesktopExternalFontState,
  type DesktopExternalFontStatus,
} from '@pidex/shared/desktop-external-fonts'

/**
 * Pure model for the theme font picker. Exposes only "系统默认" and the
 * curated on-demand external fonts for the given kind ('ui' | 'code').
 */

export const SYSTEM_DEFAULT_FAMILY_VALUE = '__system_default_family__'

export type FontPickerOption = {
  value: string
  label: string
  disabled?: boolean
  externalStatus?: DesktopExternalFontStatus
}

export type FontPickerKind = DesktopExternalFontKind

export function fontPickerCurrentFamilyValue(
  family: string | null | undefined,
  kind?: FontPickerKind,
): string {
  const external = findExternalFontByFamily(family)
  if (!external) return SYSTEM_DEFAULT_FAMILY_VALUE
  if (kind && external.kind !== kind) return SYSTEM_DEFAULT_FAMILY_VALUE
  return external.family
}

export function buildFamilyOptions({
  kind,
  externalFonts = [],
}: {
  kind: FontPickerKind
  externalFonts?: readonly DesktopExternalFontState[]
}): FontPickerOption[] {
  const options: FontPickerOption[] = [{ value: SYSTEM_DEFAULT_FAMILY_VALUE, label: '系统默认' }]
  const stateById = new Map(externalFonts.map((item) => [item.id, item]))

  for (const spec of listExternalFontsForKind(kind)) {
    const state = stateById.get(spec.id)
    const status: DesktopExternalFontStatus = state?.status ?? 'not-downloaded'
    options.push({
      value: spec.family,
      label: spec.displayName,
      disabled: status === 'downloading',
      externalStatus: status,
    })
  }

  return options
}
