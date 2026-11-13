import {
  findExternalFontByFamily,
  listExternalFontsForKind,
  type DesktopExternalFontKind,
  type DesktopExternalFontSpec,
  type DesktopExternalFontState,
  type DesktopExternalFontStatus,
} from '@pidex/shared/desktop-external-fonts'
import type { DesktopThemeFontFace } from '../../../shared/Types.js'

/**
 * Pure model for the theme font picker. Exposes only "系统默认" and the
 * curated on-demand external fonts for the given kind ('ui' | 'code'),
 * along with per-font weight options.
 */

export const SYSTEM_DEFAULT_FAMILY_VALUE = '__system_default_family__'
export const DEFAULT_WEIGHT_VALUE = '400'

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

export function buildWeightOptions(
  spec: DesktopExternalFontSpec | undefined,
): FontPickerOption[] {
  if (!spec) return [{ value: DEFAULT_WEIGHT_VALUE, label: 'Regular' }]
  return spec.weights.map((option) => ({
    value: String(option.weight),
    label: option.label,
  }))
}

export function selectedWeightValue(
  spec: DesktopExternalFontSpec | undefined,
  face: DesktopThemeFontFace | null | undefined,
): string {
  if (!spec) return DEFAULT_WEIGHT_VALUE
  if (!face || face.family.trim().toLowerCase() !== spec.family.toLowerCase()) {
    return DEFAULT_WEIGHT_VALUE
  }
  const text = `${face.fullName} ${face.postscriptName}`.toLowerCase()
  const byLongestLabel = [...spec.weights].sort((a, b) => b.label.length - a.label.length)
  const matched = byLongestLabel.find(
    (option) =>
      text.includes(option.label.toLowerCase()) ||
      text.includes(String(option.weight)),
  )
  return matched ? String(matched.weight) : DEFAULT_WEIGHT_VALUE
}

export function faceForExternalWeight(
  spec: DesktopExternalFontSpec,
  weightValue: string,
): DesktopThemeFontFace | null {
  const numeric = Number.parseInt(weightValue, 10)
  const option = spec.weights.find((item) => item.weight === numeric)
  if (!option || option.weight === 400) {
    return null
  }
  const compactFamily = spec.family.replace(/\s+/g, '')
  const compactLabel = option.label.replace(/\s+/g, '')
  return {
    family: spec.family,
    fullName: `${spec.family} ${option.label}`,
    postscriptName: `${compactFamily}-${compactLabel}`,
  }
}
