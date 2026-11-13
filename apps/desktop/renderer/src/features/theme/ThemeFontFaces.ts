import {
  findExternalFontByFamily,
  type DesktopExternalFontSpec,
  type DesktopExternalFontWeightOption,
} from '@pidex/shared/desktop-external-fonts'
import type { DesktopThemeFontFace } from '../../../shared/Types.js'
import { getLoadedExternalFontCss } from './ThemeExternalFonts.js'

/**
 * Theme font-face loading tool. A selected local face is registered under a
 * unique alias so the CSS family list can put the alias before the original
 * family; when the face cannot be loaded, CSS falls back to the family
 * automatically without affecting application startup.
 */

export function escapeCssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function extractWeightFromFace(face: DesktopThemeFontFace): number {
  const text = `${face.fullName} ${face.postscriptName}`.toLowerCase()
  if (/\b(black|heavy)\b/.test(text)) return 900
  if (/\b(extra\s*bold|ultra\s*bold|extrabold|ultrabold)\b/.test(text)) return 800
  if (/\bbold\b/.test(text)) return 700
  if (/\b(semi\s*bold|demi\s*bold|semibold|demibold)\b/.test(text)) return 600
  if (/\bmedium\b/.test(text)) return 500
  if (/\b(regular|normal)\b/.test(text)) return 400
  if (/\blight\b/.test(text)) return 300
  if (/\b(extra\s*light|ultra\s*light|extralight|ultralight)\b/.test(text)) return 200
  if (/\bthin\b/.test(text)) return 100
  return 400
}

export function themeFontFaceAlias(face: DesktopThemeFontFace, kind: 'ui' | 'code' = 'ui'): string {
  return kind === 'code' ? 'Pidex-Selected-Mono' : 'Pidex-Selected-Sans'
}

export function generateThemeFontFaceCss(alias: string, face: DesktopThemeFontFace): string {
  const weight = extractWeightFromFace(face)
  const isItalic = /\bitalic\b/i.test(`${face.fullName} ${face.postscriptName}`)
  const sourceNames = [face.fullName, face.postscriptName, face.family].filter(Boolean)
  const uniqueNames = [...new Set(sourceNames)]
  const src = uniqueNames.map((name) => `local("${escapeCssString(name)}")`).join(', ')

  return `@font-face {
  font-family: "${escapeCssString(alias)}";
  src: ${src};${isItalic ? '\n  font-style: italic;' : ''}
  font-variation-settings: 'wght' ${weight};
}`
}

export function resolveExternalWeightOption(
  spec: DesktopExternalFontSpec,
  face: DesktopThemeFontFace,
): DesktopExternalFontWeightOption {
  const weight = extractWeightFromFace(face)
  const byWeight = spec.weights.find((item) => item.weight === weight)
  if (byWeight) return byWeight
  const text = `${face.fullName} ${face.postscriptName}`.toLowerCase()
  const byLongestLabel = [...spec.weights].sort((a, b) => b.label.length - a.label.length)
  const byLabel = byLongestLabel.find((item) => text.includes(item.label.toLowerCase()))
  return byLabel ?? spec.weights.find((item) => item.weight === 400) ?? spec.weights[0]!
}

export function generateExternalFontFaceCss(
  alias: string,
  spec: DesktopExternalFontSpec,
  rawCss: string,
  face: DesktopThemeFontFace,
): string {
  const selected = resolveExternalWeightOption(spec, face)
  const escapedAlias = escapeCssString(alias)
  const escapedFamily = spec.family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const familyPattern = new RegExp(`font-family:\\s*['"]?${escapedFamily}['"]?`, 'g')

  if (spec.isVariable) {
    return rawCss
      .replace(familyPattern, `font-family: "${escapedAlias}"`)
      .replace(/(@font-face\s*\{[^}]*)(})/g, `$1\n  font-variation-settings: 'wght' ${selected.weight};\n$2`)
  }

  const targetSourceWeight = selected.sourceWeight ?? selected.weight
  const weightPattern = new RegExp(`font-weight:\\s*${targetSourceWeight}\\b`)
  const blocks: string[] = []
  for (const match of rawCss.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    const block = match[0]
    if (!weightPattern.test(block)) continue
    blocks.push(
      block
        .replace(familyPattern, `font-family: "${escapedAlias}"`)
        .replace(weightPattern, 'font-weight: 100 900'),
    )
  }
  return blocks.join('\n')
}

export const THEME_FONT_FACES_STYLE_ID = 'cpx-theme-font-faces'

function buildFaceCssBlock(alias: string, face: DesktopThemeFontFace): string | null {
  const external = findExternalFontByFamily(face.family)
  if (external) {
    const loadedCss = getLoadedExternalFontCss(external.id)
    if (!loadedCss) return null
    return generateExternalFontFaceCss(alias, external, loadedCss, face)
  }
  return generateThemeFontFaceCss(alias, face)
}

export function applyThemeFontFaceStyles(
  uiFace: DesktopThemeFontFace | null | undefined,
  codeFace: DesktopThemeFontFace | null | undefined,
): void {
  if (typeof document === 'undefined') return

  let styleEl = document.getElementById(THEME_FONT_FACES_STYLE_ID) as HTMLStyleElement | null
  const cssBlocks: string[] = []

  if (uiFace) {
    const block = buildFaceCssBlock('Pidex-Selected-Sans', uiFace)
    if (block) cssBlocks.push(block)
  }
  if (codeFace) {
    const block = buildFaceCssBlock('Pidex-Selected-Mono', codeFace)
    if (block) cssBlocks.push(block)
  }

  const css = cssBlocks.join('\n\n').trim()

  if (!css) {
    if (styleEl) styleEl.remove()
    return
  }

  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = THEME_FONT_FACES_STYLE_ID
    document.head.appendChild(styleEl)
  }

  if (styleEl.textContent !== css) {
    styleEl.textContent = css
  }
}

/**
 * CSS font-family value. Places the registered dynamic alias and the full face name
 * before the fallback font stack. Returns the plain fallback when no face is selected.
 */
export function fontFamilyWithFace(
  face: DesktopThemeFontFace | null | undefined,
  fallback: string,
  kind: 'ui' | 'code' = 'ui',
): string {
  if (!face) return fallback
  const alias = themeFontFaceAlias(face, kind)
  const escapedName = escapeCssString(face.fullName)
  const escapedFamily = escapeCssString(face.family)
  return `"${alias}", "${escapedName}", "${escapedFamily}", ${fallback}`
}
