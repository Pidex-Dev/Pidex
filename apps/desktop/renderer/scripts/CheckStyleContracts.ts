import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import postcss, {
  type AtRule as PostcssAtRule,
  type Container as PostcssContainer,
  type Document as PostcssDocument,
  type Rule as PostcssRule,
} from 'postcss'
import selectorParser from 'postcss-selector-parser'
import ts from 'typescript'
import { selectorBlock, transitionProperties } from './StyleAnimationContracts.js'

type FeatureTokenException = {
  file: string
  property: string
  value?: string
  localProperty?: string
  reason: string
}

type FeatureTokenContract = {
  roots: string[]
  scriptRoots: string[]
  componentGeometryExceptions: FeatureTokenException[]
  inlineStyleExceptions: FeatureTokenException[]
  tailwindArbitraryExceptions: FeatureTokenException[]
  tailwindTypographyExceptions: FeatureTokenException[]
  literalTypographyExceptions: FeatureTokenException[]
  literalRadiusExceptions: FeatureTokenException[]
  literalMotionExceptions: FeatureTokenException[]
  literalShadowExceptions: FeatureTokenException[]
  literalZIndexExceptions: FeatureTokenException[]
  literalSpacingExceptions: FeatureTokenException[]
}

type FeatureTokenCategory =
  | 'componentGeometry'
  | 'inlineStyle'
  | 'tailwindArbitrary'
  | 'tailwindTypography'
  | 'literalTypography'
  | 'literalRadius'
  | 'literalMotion'
  | 'literalShadow'
  | 'literalZIndex'
  | 'literalSpacing'

type FeatureTokenRegistryEntry = {
  reason: string
  used: boolean
}

type CssTailwindCollisionException = {
  file: string
  cssClass?: string
  twClass?: string
  category?: string
  reason: string
}

type StyleContractManifest = {
  styleEntrypoint: string
  styleEntrypointImporter: string
  /**
   * SCSS entrypoints that are still loaded directly while surfaces migrate to
   * the Tailwind entrypoint. Their graph joins the single-entry graph and they
   * may declare the shared cascade order. Drop an entry once it stops importing
   * SCSS.
   */
  legacyScssEntrypoints?: string[]
  cascadeLayerOrder: string[]
  directStyleImportAllowlist: string[]
  lazyStyleEntrypoints: Record<string, 'vendor' | 'features'>
  componentStyleEntrypoints?: Record<string, string | string[]>
  customPropertyReferenceAllowlist: string[]
  forbiddenCustomPropertyPatterns: string[]
  importantDeclarationAllowlist: Record<string, number>
  dataThemeSelectorAllowlist: Record<string, number>
  literalLineHeightAllowlist: Record<string, number>
  tailwindLeadingAllowlist: Record<string, number>
  deadSelectorAllowlist?: string[]
  multiFileClassAllowlist?: Record<string, string[]>
  cssTailwindCollisionAllowlist?: Record<string, number>
  cssTailwindCollisionExceptions?: CssTailwindCollisionException[]
  featureColorContract: {
    roots: string[]
    componentTokenExceptions: Array<{ file: string; token: string; reason: string }>
    literalColorExceptions: Array<{ file: string; value: string; reason: string }>
    colorMixExceptions: Array<{ file: string; localProperty: string; reason: string }>
  }
  featureTokenContract: FeatureTokenContract
  interactionContract: {
    interactiveRowAllowedFiles: string[]
  }
}

const workspaceRoot = resolve(import.meta.dir, '..')
const sourceRoot = join(workspaceRoot, 'src')
const manifestPath = join(workspaceRoot, 'style-contracts.json')
const styleExtensions = new Set(['.css', '.scss'])
const scriptExtensions = new Set(['.ts', '.tsx'])

function workspacePath(path: string): string {
  return relative(workspaceRoot, path).replaceAll('\\', '/')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? listFiles(path) : Promise.resolve([path])
    }),
  )
  return files.flat()
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function resolveStyleReference(fromFile: string, reference: string): Promise<string | null> {
  const base = resolve(dirname(fromFile), reference)
  const extension = extname(base)
  const candidates = extension
    ? [base]
    : [
        `${base}.scss`,
        `${base}.css`,
        join(dirname(base), `_${base.split(/[\\/]/).at(-1)}.scss`),
        join(base, 'index.scss'),
        join(base, '_index.scss'),
      ]

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate
  }
  return null
}

async function collectEntryGraph(entrypoint: string): Promise<Set<string>> {
  const visited = new Set<string>()

  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return
    visited.add(file)
    const source = await readFile(file, 'utf8')
    const referencePatterns = [
      /@(use|forward)\s+['"]([^'"]+)['"]/g,
      /meta\.load-css\(\s*['"]([^'"]+)['"]/g,
      // Native CSS imports, including the layer()/prefix() forms used by Tailwind.
      /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g,
    ]
    for (const pattern of referencePatterns) {
      for (const match of source.matchAll(pattern)) {
        const reference = match[2] ?? match[1]
        const resolved = await resolveStyleReference(file, reference)
        if (resolved) await visit(resolved)
      }
    }
  }

  await visit(entrypoint)
  return visited
}

/*
 * Static styles authored in TSX (`String.raw` blocks) are read with the style
 * patterns; the script patterns still apply to the surrounding component code.
 */
function collectCustomPropertyDefinitions(source: string, isStyle: boolean): Set<string> {
  const definitions = new Set<string>()
  const patterns = isStyle
    ? [/(--[\w-]+)\s*:/g]
    : [
        /setProperty\(\s*['"](--[\w-]+)['"]/g,
        /['"](--[\w-]+)['"]\s*\??\s*:/g,
        /\[\s*['"](--[\w-]+)['"]\s*\]\s*=/g,
        /(--[\w-]+)\s*:/g,
      ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) definitions.add(match[1])
  }
  return definitions
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as StyleContractManifest
const allFiles = await listFiles(sourceRoot)
const styleFiles = allFiles.filter((file) => styleExtensions.has(extname(file)))
const scriptFiles = allFiles.filter((file) => scriptExtensions.has(extname(file)))
const errors: string[] = []

function requireReason(reason: string, descriptor: string): void {
  if (reason.trim().length < 16)
    errors.push(`feature color exception needs a concrete reason: ${descriptor}`)
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

const featureColorFiles = new Set<string>()
for (const root of manifest.featureColorContract.roots) {
  const absoluteRoot = resolve(workspaceRoot, root)
  if (!absoluteRoot.startsWith(sourceRoot) || !(await isDirectory(absoluteRoot))) {
    errors.push(`feature color root must be an existing source directory: ${root}`)
    continue
  }
  for (const file of styleFiles) {
    if (file.startsWith(`${absoluteRoot}\\`) || file.startsWith(`${absoluteRoot}/`)) {
      featureColorFiles.add(file)
    }
  }
}

const componentExceptions = new Map<string, { reason: string; used: boolean }>()
for (const exception of manifest.featureColorContract.componentTokenExceptions) {
  const key = `${exception.file} -> ${exception.token}`
  requireReason(exception.reason, key)
  if (componentExceptions.has(key))
    errors.push(`duplicate feature component-token exception: ${key}`)
  componentExceptions.set(key, { reason: exception.reason, used: false })
}
const literalExceptions = new Map<string, { reason: string; used: boolean }>()
for (const exception of manifest.featureColorContract.literalColorExceptions) {
  const key = `${exception.file} -> ${exception.value.toLowerCase()}`
  requireReason(exception.reason, key)
  if (literalExceptions.has(key)) errors.push(`duplicate feature literal-color exception: ${key}`)
  literalExceptions.set(key, { reason: exception.reason, used: false })
}
const mixExceptions = new Map<string, { reason: string; used: boolean }>()
for (const exception of manifest.featureColorContract.colorMixExceptions) {
  const key = `${exception.file} -> ${exception.localProperty}`
  requireReason(exception.reason, key)
  if (!exception.localProperty.startsWith('--'))
    errors.push(`color-mix exception must name a local custom property: ${key}`)
  if (mixExceptions.has(key)) errors.push(`duplicate feature color-mix exception: ${key}`)
  mixExceptions.set(key, { reason: exception.reason, used: false })
}

const colorComponentToken =
  /--cpx-comp-[\w-]*(?:bg|fg|fill|color|border|edge|scrim|shadow)(?:-[\w-]+)?\b/g
const literalColor = /(?<![\w-])#[\da-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\([^;{}]+?\)/g
for (const file of featureColorFiles) {
  const source = await readFile(file, 'utf8')
  const path = workspacePath(file)
  for (const match of source.matchAll(colorComponentToken)) {
    const key = `${path} -> ${match[0]}`
    const exception = componentExceptions.get(key)
    if (exception) exception.used = true
    else
      errors.push(
        `feature styles must use system semantic colors, not ${match[0]}: ${path}:${lineNumberAt(source, match.index)}`,
      )
  }
  for (const match of source.matchAll(literalColor)) {
    const value = match[0].toLowerCase()
    const key = `${path} -> ${value}`
    const exception = literalExceptions.get(key)
    if (exception) exception.used = true
    else
      errors.push(
        `feature styles must not use literal color ${match[0]}: ${path}:${lineNumberAt(source, match.index)}`,
      )
  }
  for (const call of collectFunctionCalls(source, 'color-mix')) {
    const systemTokens = [...call.value.matchAll(/--cpx-sys-color-[\w-]+/g)].map(
      (match) => match[0],
    )
    const localTokens = [...call.value.matchAll(/--(?!cpx-(?:sys|comp)-)[\w-]+/g)].map(
      (match) => match[0],
    )
    if (new Set(systemTokens).size < 2 && localTokens.length === 0) continue
    const matchingException = localTokens
      .map((token) => mixExceptions.get(`${path} -> ${token}`))
      .find(Boolean)
    if (matchingException) matchingException.used = true
    else
      errors.push(
        `feature color-mix must not combine multiple semantic/local colors: ${path}:${lineNumberAt(source, call.offset)}`,
      )
  }
}
for (const [key, exception] of componentExceptions) {
  if (!exception.used) errors.push(`stale feature component-token exception: ${key}`)
}
for (const [key, exception] of literalExceptions) {
  if (!exception.used) errors.push(`stale feature literal-color exception: ${key}`)
}
for (const [key, exception] of mixExceptions) {
  if (!exception.used) errors.push(`stale feature color-mix exception: ${key}`)
}

/*
 * Non-color feature token exceptions. Each category's registry is built from
 * the manifest and validated once; scan rules consume exact identities through
 * markFeatureTokenUsed so only a full category/file/property(/value/localProperty)
 * match counts as used. Unconsumed entries are reported before the final error
 * judgment below.
 */
const featureTokenCategoryPairs: ReadonlyArray<
  readonly [FeatureTokenCategory, FeatureTokenException[]]
> = [
  ['componentGeometry', manifest.featureTokenContract.componentGeometryExceptions],
  ['inlineStyle', manifest.featureTokenContract.inlineStyleExceptions],
  ['tailwindArbitrary', manifest.featureTokenContract.tailwindArbitraryExceptions],
  ['tailwindTypography', manifest.featureTokenContract.tailwindTypographyExceptions],
  ['literalTypography', manifest.featureTokenContract.literalTypographyExceptions],
  ['literalRadius', manifest.featureTokenContract.literalRadiusExceptions],
  ['literalMotion', manifest.featureTokenContract.literalMotionExceptions],
  ['literalShadow', manifest.featureTokenContract.literalShadowExceptions],
  ['literalZIndex', manifest.featureTokenContract.literalZIndexExceptions],
  ['literalSpacing', manifest.featureTokenContract.literalSpacingExceptions],
]

function normalizeFeatureTokenFile(file: string): string {
  return file
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
}

function featureTokenKey(
  category: FeatureTokenCategory,
  file: string,
  property: string,
  value?: string,
  localProperty?: string,
): string {
  const parts = [category, normalizeFeatureTokenFile(file), property]
  if (value !== undefined) parts.push(`value=${value}`)
  if (localProperty !== undefined) parts.push(`localProperty=${localProperty}`)
  return parts.join(' -> ')
}

function requireFeatureTokenReason(reason: string, descriptor: string): void {
  if (reason.trim().length < 16) {
    errors.push(`feature token exception needs a concrete reason: ${descriptor}`)
  }
}

const featureTokenRegistry = new Map<FeatureTokenCategory, Map<string, FeatureTokenRegistryEntry>>()
for (const [category, exceptions] of featureTokenCategoryPairs) {
  const categoryRegistry = new Map<string, FeatureTokenRegistryEntry>()
  for (const exception of exceptions) {
    const file = normalizeFeatureTokenFile(exception.file)
    const property = exception.property.trim()
    const value = exception.value?.trim()
    const localProperty = exception.localProperty?.trim()
    const key = featureTokenKey(category, file, property, value, localProperty)
    requireFeatureTokenReason(exception.reason, key)
    if (file.length === 0) errors.push(`feature token exception file must not be empty: ${key}`)
    if (property.length === 0)
      errors.push(`feature token exception property must not be empty: ${key}`)
    if (value !== undefined && value.length === 0) {
      errors.push(`feature token exception value must not be empty: ${key}`)
    }
    if (localProperty !== undefined && localProperty.length === 0) {
      errors.push(`feature token exception localProperty must not be empty: ${key}`)
    }
    if (categoryRegistry.has(key)) errors.push(`duplicate feature token exception: ${key}`)
    categoryRegistry.set(key, { reason: exception.reason, used: false })
  }
  featureTokenRegistry.set(category, categoryRegistry)
}

function markFeatureTokenUsed(
  category: FeatureTokenCategory,
  file: string,
  property: string,
  value?: string,
  localProperty?: string,
): boolean {
  const key = featureTokenKey(category, file, property, value, localProperty)
  const entry = featureTokenRegistry.get(category)?.get(key)
  if (entry) entry.used = true
  return entry !== undefined
}

/*
 * Non-color feature token scan input. The collected file sets and the reusable
 * source/block/script helpers below only establish data and machinery for the
 * upcoming rules; nothing here emits a new violation, so the existing failure
 * set stays unchanged.
 */
function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

const featureTokenStyleFiles = new Set<string>()
for (const root of manifest.featureTokenContract.roots) {
  const absoluteRoot = resolve(workspaceRoot, root)
  if (!isPathInside(sourceRoot, absoluteRoot) || !(await isDirectory(absoluteRoot))) {
    errors.push(`feature token root must be an existing source directory: ${root}`)
    continue
  }
  for (const file of styleFiles) {
    if (isPathInside(absoluteRoot, file)) featureTokenStyleFiles.add(file)
  }
}

const featureTokenScriptFiles = new Set<string>()
for (const root of manifest.featureTokenContract.scriptRoots) {
  const absoluteRoot = resolve(workspaceRoot, root)
  if (!isPathInside(sourceRoot, absoluteRoot) || !(await isDirectory(absoluteRoot))) {
    errors.push(`feature token script root must be an existing source directory: ${root}`)
    continue
  }
  for (const file of scriptFiles) {
    if (isPathInside(absoluteRoot, file)) featureTokenScriptFiles.add(file)
  }
}

/*
 * Interaction ownership: action buttons, compact rows and feature-owned
 * clickable surfaces must not share each other's visual contracts.
 */
const interactiveRowAllowedFiles = new Set(
  manifest.interactionContract.interactiveRowAllowedFiles.map(normalizeFeatureTokenFile),
)
for (const file of [...styleFiles, ...scriptFiles]) {
  const source = await readFile(file, 'utf8')
  const path = workspacePath(file)
  if (/interactive-row--(?:adaptive|composer|toolbar)\b/.test(source)) {
    errors.push(`legacy interactive-row escape modifier is forbidden: ${path}`)
  }
}
for (const file of featureTokenStyleFiles) {
  const source = await readFile(file, 'utf8')
  const path = workspacePath(file)
  if (/\.ui-button\b/.test(source)) {
    errors.push(`feature styles must not target .ui-button: ${path}`)
  }
  if (/\.icon-button\b/.test(source)) {
    errors.push(`feature styles must not target .icon-button: ${path}`)
  }
  if (/\[data-position=['"]?sidebar/.test(source)) {
    errors.push(
      `feature styles must not restyle the shared sidebar button preset; use data-position="sidebar": ${path}`,
    )
  }
}
for (const file of featureTokenScriptFiles) {
  const source = await readFile(file, 'utf8')
  const path = workspacePath(file)
  const usesInteractiveRow = /\binteractive-row(?:--[\w-]+)?\b/.test(source)
  if (usesInteractiveRow && !interactiveRowAllowedFiles.has(path)) {
    errors.push(
      `interactive-row is not allowed outside the reviewed menu/nav/summary files: ${path}`,
    )
  }
  if (/<Button\b(?![^>]*\bisIconOnly)[^>]*\baria-(?:pressed|selected)\s*=/s.test(source)) {
    errors.push(`Button must not represent persistent pressed/selected state: ${path}`)
  }
  if (
    /PopoverRadioGroup/.test(source) &&
    /trigger=\{?\s*<Button\b(?![^>]*\bisIconOnly)/s.test(source)
  ) {
    errors.push(`Popover radio-group trigger must not use Button: ${path}`)
  }
}
for (const file of interactiveRowAllowedFiles) {
  const absoluteFile = resolve(workspaceRoot, file)
  const source = (await isFile(absoluteFile)) ? await readFile(absoluteFile, 'utf8') : undefined
  if (source === undefined || !/\binteractive-row(?:--[\w-]+)?\b/.test(source)) {
    errors.push(`stale interactive-row allowed file: ${file}`)
  }
}

type CssDeclaration = {
  property: string
  value: string
  offset: number
}

function maskComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment: string) => ' '.repeat(comment.length))
    .replace(
      /(^|[ \t;{}])\/\/[^\r\n]*/gm,
      (match: string, prefix: string) => `${prefix}${' '.repeat(match.length - prefix.length)}`,
    )
}

function splitDeclarationSegments(body: string): Array<{ segment: string; offset: number }> {
  const parts: Array<{ segment: string; offset: number }> = []
  let start = 0
  let braceDepth = 0
  let depth = 0
  let quote: string | null = null
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (quote !== null) {
      if (character === quote && body[index - 1] !== '\\') quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '{') braceDepth += 1
    else if (character === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1)
    else if (character === ';' && braceDepth === 0 && depth === 0) {
      parts.push({ segment: body.slice(start, index), offset: start })
      start = index + 1
    }
  }
  parts.push({ segment: body.slice(start), offset: start })
  return parts
}

function extractDeclaration(
  masked: string,
  start: number,
  end: number,
  declarations: CssDeclaration[],
): void {
  const segment = masked.slice(start, end)
  const propertyMatch = segment.match(/^\s*((-{1,2}|[a-z_])[-a-z0-9_]*)\s*:/)
  if (!propertyMatch) return
  declarations.push({
    property: propertyMatch[1],
    value: segment.slice(propertyMatch[0].length).trim(),
    offset: start + propertyMatch[0].indexOf(propertyMatch[1]),
  })
}

function collectDeclarationsFromBody(
  masked: string,
  bodyStart: number,
  bodyEnd: number,
  declarations: CssDeclaration[],
): void {
  let segmentStart = bodyStart
  let braceDepth = 0
  let depth = 0
  let quote: string | null = null
  let inNestedBlock = false
  for (let index = bodyStart; index < bodyEnd; index += 1) {
    const character = masked[index]
    if (quote !== null) {
      if (character === quote && masked[index - 1] !== '\\') quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1)
    else if (character === '{' && depth === 0) {
      if (braceDepth === 0) inNestedBlock = true
      braceDepth += 1
    } else if (character === '}' && depth === 0) {
      braceDepth = Math.max(0, braceDepth - 1)
      if (inNestedBlock && braceDepth === 0) {
        segmentStart = index + 1
        inNestedBlock = false
      }
    } else if (character === ';' && braceDepth === 0 && depth === 0) {
      extractDeclaration(masked, segmentStart, index, declarations)
      segmentStart = index + 1
    }
  }
  extractDeclaration(masked, segmentStart, bodyEnd, declarations)
}

function extractCssDeclarations(source: string): CssDeclaration[] {
  const masked = maskComments(source)
  const declarations: CssDeclaration[] = []
  const blockStarts: number[] = []
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index]
    if (character === '"' || character === "'") {
      const quote = character
      index += 1
      while (index < masked.length) {
        if (masked[index] === quote && masked[index - 1] !== '\\') break
        index += 1
      }
      continue
    }
    if (character === '{') blockStarts.push(index + 1)
    else if (character === '}' && blockStarts.length > 0) {
      const bodyStart = blockStarts.pop()
      if (bodyStart === undefined) continue
      collectDeclarationsFromBody(masked, bodyStart, index, declarations)
    }
  }
  return declarations.sort((a, b) => a.offset - b.offset)
}

type RuleBlock = {
  selector: string
  start: number
  bodyStart: number
  bodyEnd: number
  depth: number
}

function collectRuleBlocks(source: string): RuleBlock[] {
  const masked = maskComments(source)
  const blocks: RuleBlock[] = []
  const stack: Array<{ selector: string; start: number; bodyStart: number; depth: number }> = []
  let regionStart = 0
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index]
    if (character === '"' || character === "'") {
      const quote = character
      index += 1
      while (index < masked.length) {
        if (masked[index] === quote && masked[index - 1] !== '\\') break
        index += 1
      }
      continue
    }
    if (character === '{') {
      const chunks = splitDeclarationSegments(masked.slice(regionStart, index))
      const lastChunk = chunks[chunks.length - 1]
      stack.push({
        selector: lastChunk.segment.trim(),
        start: regionStart + lastChunk.offset,
        bodyStart: index + 1,
        depth: stack.length,
      })
      regionStart = index + 1
    } else if (character === '}') {
      const open = stack.pop()
      if (open) {
        blocks.push({ ...open, bodyEnd: index })
        regionStart = index + 1
      }
    }
  }
  return blocks
}

function nearestRuleBlock(source: string, offset: number): RuleBlock | null {
  let nearest: RuleBlock | null = null
  for (const block of collectRuleBlocks(source)) {
    if (offset < block.bodyStart || offset >= block.bodyEnd) continue
    if (nearest === null || block.bodyEnd - block.bodyStart < nearest.bodyEnd - nearest.bodyStart) {
      nearest = block
    }
  }
  return nearest
}

function groupDeclarationsByBlock(
  blocks: RuleBlock[],
  declarations: CssDeclaration[],
): Map<number, CssDeclaration[]> {
  const byBlock = new Map<number, CssDeclaration[]>()
  for (const declaration of declarations) {
    let nearest: RuleBlock | null = null
    for (const block of blocks) {
      if (declaration.offset < block.bodyStart || declaration.offset >= block.bodyEnd) continue
      if (
        nearest === null ||
        block.bodyEnd - block.bodyStart < nearest.bodyEnd - nearest.bodyStart
      ) {
        nearest = block
      }
    }
    if (nearest === null) continue
    const list = byBlock.get(nearest.bodyStart)
    if (list) list.push(declaration)
    else byBlock.set(nearest.bodyStart, [declaration])
  }
  return byBlock
}

function isInsideKeyframes(source: string, offset: number): boolean {
  for (const block of collectRuleBlocks(source)) {
    if (
      offset >= block.bodyStart &&
      offset < block.bodyEnd &&
      /^@(?:-\w+-)?keyframes\b/i.test(block.selector.trim())
    ) {
      return true
    }
  }
  return false
}

function ruleBlockEstablishesStackingContext(
  source: string,
  declarations: CssDeclaration[],
  block: RuleBlock,
): boolean {
  for (const declaration of declarations) {
    const nearest = nearestRuleBlock(source, declaration.offset)
    if (nearest === null || nearest.bodyStart !== block.bodyStart) continue
    const value = declaration.value.trim()
    if (declaration.property === 'isolation' && /^isolate$/i.test(value)) return true
    if (declaration.property === 'position' && /^(?:relative|absolute|fixed|sticky)$/i.test(value))
      return true
    if (
      (declaration.property === 'transform' ||
        declaration.property === 'filter' ||
        declaration.property === 'backdrop-filter') &&
      !/^none$/i.test(value)
    ) {
      return true
    }
    if (declaration.property === 'opacity' && /^-?\d*\.?\d+$/.test(value)) {
      const opacity = Number(value)
      if (opacity >= 0 && opacity < 1) return true
    }
    if (declaration.property === 'contain') {
      const parts = value.split(/[\s,]+/).filter(Boolean)
      if (parts.some((part) => /^(?:paint|layout)$/i.test(part))) return true
    }
    if (declaration.property === 'will-change') {
      const parts = value.split(/[\s,]+/).filter(Boolean)
      if (parts.some((part) => /^(?:transform|opacity|filter)$/i.test(part))) return true
    }
  }
  return false
}

function createLineIndex(source: string): (offset: number) => number {
  const lineStarts: number[] = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1)
  }
  return (offset) => {
    let low = 0
    let high = lineStarts.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (lineStarts[mid] <= offset) low = mid + 1
      else high = mid
    }
    return low
  }
}

type ScriptSource = {
  source: string
  path: string
  lineNumberAt: (offset: number) => number
}

async function readScriptSource(file: string): Promise<ScriptSource> {
  const source = await readFile(file, 'utf8')
  return { source, path: workspacePath(file), lineNumberAt: createLineIndex(source) }
}

const featureTokenStyleDeclarations = new Map<string, CssDeclaration[]>()
for (const file of featureTokenStyleFiles) {
  featureTokenStyleDeclarations.set(file, extractCssDeclarations(await readFile(file, 'utf8')))
}

/*
 * Non-color feature token scan rules. Each rule walks declaration values and
 * consumes exact exceptions through markFeatureTokenUsed so only the precise
 * category/file/property/(value or localProperty) identity counts as used.
 * Component color/visual tokens (bg/fg/fill/color/border/edge/scrim/shadow)
 * are governed by the color contract and never count as geometry.
 */
const colorComponentTokenName =
  /--cpx-comp-[\w-]*(?:bg|fg|fill|color|border|edge|scrim|shadow|ansi)(?:-[\w-]+)?/
const componentGeometryToken = /--cpx-comp-[\w-]+/g
const bareTypographyLength = /(?<![\w-])-?\d+(?:\.\d+)?(?:px|rem|em|%)/
const bareUnitlessLineHeight = /(?<![\w-])-?\d+(?:\.\d+)?(?![\w.%])/
const radiusBareLength = /(?<![\w-])-?(?:\d*[1-9]\d*(?:\.\d+)?|\d+\.\d+)(?:px|rem|em|%)/
const radiusProperties = new Set([
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
])
const motionProperties = new Set([
  'transition',
  'transition-duration',
  'transition-timing-function',
  'animation',
  'animation-duration',
  'animation-timing-function',
])
const motionBareTime = /(?<![\w-])-?\d*\.?\d+(ms|s)\b/g
const motionTimingFunction = /(?<![\w-])(?:cubic-bezier|steps)\(/
const motionEasingKeyword = /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear)(?![\w-])/
const motionVarReference = /var\(\s*--cpx-sys-(?:motion|ease)-[\w-]+\s*(?:,\s*[^()]*)?\)/g
const shadowResetKeyword = /^(?:none|inherit|initial|unset|revert)$/i
const systemShadowVarReference =
  /^var\(\s*--cpx-sys-(?:shadow-[\w-]+|focus-ring(?:-[\w-]+)?)\s*(?:,\s*[^()]*)?\)$/i
const systemZIndexVarReference = /^var\(\s*--cpx-sys-z-[\w-]+\s*(?:,\s*[^()]*)?\)$/i
const zIndexKeyword = /^(?:inherit|initial|unset|revert|auto)$/i

const spacingProperties = new Set([
  'padding',
  'padding-block',
  'padding-block-start',
  'padding-block-end',
  'padding-inline',
  'padding-inline-start',
  'padding-inline-end',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-block',
  'margin-block-start',
  'margin-block-end',
  'margin-inline',
  'margin-inline-start',
  'margin-inline-end',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'gap',
  'row-gap',
  'column-gap',
])
const systemSpacingVarReference = /^--cpx-sys-(?:space|layout)-[\w-]+$/
const spacingBareLength =
  /(?<![\w-])(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em|%|vw|vh|vmin|vmax|ch|ex)\b/g
const localCustomPropertyName = /^--[\w-]+$/

function analyzeSpacingValue(value: string): {
  hasBareLength: boolean
  localVarReferences: string[]
} {
  const masked = value.split('')
  const localVarReferences: string[] = []
  for (const call of collectFunctionCalls(value, 'var')) {
    const name = call.value.match(/^\s*var\s*\(\s*(--[\w-]+)/)?.[1]
    if (name === undefined) continue
    if (!systemSpacingVarReference.test(name)) localVarReferences.push(name)
    for (let index = call.offset; index < call.offset + call.value.length; index += 1)
      masked[index] = ' '
  }
  for (const call of collectFunctionCalls(value, 'env')) {
    for (let index = call.offset; index < call.offset + call.value.length; index += 1)
      masked[index] = ' '
  }
  let hasBareLength = false
  for (const match of masked.join('').matchAll(spacingBareLength)) {
    if (Number(match[1]) !== 0) {
      hasBareLength = true
      break
    }
  }
  return { hasBareLength, localVarReferences: [...new Set(localVarReferences)] }
}

function splitTopLevelList(value: string, delimiter: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quote: string | null = null
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote !== null) {
      if (character === quote && value[index - 1] !== '\\') quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1)
    else if (character === delimiter && depth === 0) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

for (const [file, declarations] of featureTokenStyleDeclarations) {
  const source = await readFile(file, 'utf8')
  const path = workspacePath(file)
  const fileBlocks = collectRuleBlocks(source)
  const fileBlockDeclarations = groupDeclarationsByBlock(fileBlocks, declarations)
  const fileLocalCustomProperties = new Set(
    declarations
      .filter((candidate) => localCustomPropertyName.test(candidate.property))
      .map((candidate) => candidate.property),
  )
  for (const declaration of declarations) {
    for (const token of declaration.value.matchAll(componentGeometryToken)) {
      if (colorComponentTokenName.test(token[0])) continue
      const used = markFeatureTokenUsed(
        'componentGeometry',
        path,
        declaration.property,
        undefined,
        token[0],
      )
      if (!used) {
        errors.push(
          `feature styles must not use component geometry ${token[0]}: ${path}:${lineNumberAt(source, declaration.offset)}`,
        )
      }
    }
    if (declaration.property === 'font-size' || declaration.property === 'line-height') {
      const hasBareLength = bareTypographyLength.test(declaration.value)
      const hasBareLineHeight =
        declaration.property === 'line-height' && bareUnitlessLineHeight.test(declaration.value)
      if (!hasBareLength && !hasBareLineHeight) continue
      const used = markFeatureTokenUsed(
        'literalTypography',
        path,
        declaration.property,
        declaration.value,
      )
      if (!used) {
        errors.push(
          `feature styles must not use literal typography ${declaration.value}: ${path}:${lineNumberAt(source, declaration.offset)}`,
        )
      }
    }
    if (radiusProperties.has(declaration.property) && radiusBareLength.test(declaration.value)) {
      const used = markFeatureTokenUsed(
        'literalRadius',
        path,
        declaration.property,
        declaration.value,
      )
      if (!used) {
        errors.push(
          `feature styles must not use literal radius ${declaration.value}: ${path}:${lineNumberAt(source, declaration.offset)}`,
        )
      }
    }
    if (motionProperties.has(declaration.property)) {
      const maskedMotion = declaration.value.replace(motionVarReference, '')
      let hasLiteralMotion = false
      for (const time of maskedMotion.matchAll(motionBareTime)) {
        if (Number(time[1]) !== 0) {
          hasLiteralMotion = true
          break
        }
      }
      if (!hasLiteralMotion) hasLiteralMotion = motionTimingFunction.test(maskedMotion)
      if (!hasLiteralMotion) hasLiteralMotion = motionEasingKeyword.test(maskedMotion)
      if (hasLiteralMotion) {
        const used = markFeatureTokenUsed(
          'literalMotion',
          path,
          declaration.property,
          declaration.value,
        )
        if (!used) {
          errors.push(
            `feature styles must not use literal motion ${declaration.value}: ${path}:${lineNumberAt(source, declaration.offset)}`,
          )
        }
      }
    }
    if (declaration.property === 'box-shadow' || declaration.property === 'text-shadow') {
      if (shadowResetKeyword.test(declaration.value.trim())) continue
      const layers = splitTopLevelList(declaration.value, ',')
      const usesGovernedShadow = layers.every((layer) => {
        const value = layer.trim()
        if (systemShadowVarReference.test(value)) return true
        const localName = value.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*[^()]*)?\)$/)?.[1]
        return localName !== undefined && fileLocalCustomProperties.has(localName)
      })
      if (usesGovernedShadow) continue
      const used = markFeatureTokenUsed(
        'literalShadow',
        path,
        declaration.property,
        declaration.value,
      )
      if (!used) {
        errors.push(
          `feature styles must not use literal shadow ${declaration.value}: ${path}:${lineNumberAt(source, declaration.offset)}`,
        )
      }
    }
    if (
      (declaration.property === 'filter' || declaration.property === 'backdrop-filter') &&
      /drop-shadow\s*\(/i.test(declaration.value)
    ) {
      if (shadowResetKeyword.test(declaration.value.trim())) continue
      const dropShadows = collectFunctionCalls(declaration.value, 'drop-shadow')
      const hasLiteralDropShadow = dropShadows.some((call) => {
        const argument = call.value.slice('drop-shadow'.length + 1, -1).trim()
        if (shadowResetKeyword.test(argument)) return false
        return !systemShadowVarReference.test(argument)
      })
      if (!hasLiteralDropShadow) continue
      const used = markFeatureTokenUsed(
        'literalShadow',
        path,
        declaration.property,
        declaration.value,
      )
      if (!used) {
        errors.push(
          `feature styles must not use literal shadow ${declaration.value}: ${path}:${lineNumberAt(source, declaration.offset)}`,
        )
      }
    }
    if (declaration.property === 'z-index') {
      const value = declaration.value.trim()
      if (systemZIndexVarReference.test(value) || zIndexKeyword.test(value)) continue
      const isBareIntegerInRange =
        /^-?\d+$/.test(value) && Number(value) >= -1 && Number(value) <= 5
      let hasStackingContext = false
      if (isBareIntegerInRange) {
        const block = nearestRuleBlock(source, declaration.offset)
        hasStackingContext =
          block !== null &&
          !block.selector.trim().startsWith('@') &&
          !isInsideKeyframes(source, declaration.offset) &&
          ruleBlockEstablishesStackingContext(source, declarations, block)
      }
      if (hasStackingContext) continue
      const used = markFeatureTokenUsed(
        'literalZIndex',
        path,
        declaration.property,
        declaration.value,
      )
      if (!used) {
        errors.push(
          `feature styles must not use literal z-index ${declaration.value}: ${path}:${lineNumberAt(source, declaration.offset)}`,
        )
      }
    }
    if (spacingProperties.has(declaration.property)) {
      const analysis = analyzeSpacingValue(declaration.value)
      const scope = new Set<string>()
      for (const block of fileBlocks) {
        if (declaration.offset < block.bodyStart || declaration.offset >= block.bodyEnd) continue
        if (block.selector.trim().startsWith('@')) continue
        for (const scopedDeclaration of fileBlockDeclarations.get(block.bodyStart) ?? []) {
          if (localCustomPropertyName.test(scopedDeclaration.property)) {
            scope.add(scopedDeclaration.property)
          }
        }
      }
      const hasUnscopedLocalVar = analysis.localVarReferences.some(
        (name) => !scope.has(name) && !fileLocalCustomProperties.has(name),
      )
      if (!analysis.hasBareLength && !hasUnscopedLocalVar) continue
      const used = markFeatureTokenUsed(
        'literalSpacing',
        path,
        declaration.property,
        declaration.value,
      )
      if (!used) {
        errors.push(
          `feature styles must not use literal spacing ${declaration.value}: ${path}:${lineNumberAt(source, declaration.offset)}`,
        )
      }
    }
  }
}

const featureTokenScriptSources = new Map<string, ScriptSource>()
for (const file of featureTokenScriptFiles) {
  featureTokenScriptSources.set(file, await readScriptSource(file))
}

function lineNumberAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

function collectFunctionCalls(
  source: string,
  name: string,
): Array<{ value: string; offset: number }> {
  const calls: Array<{ value: string; offset: number }> = []
  const startPattern = new RegExp(`${escapeRegExp(name)}\\(`, 'g')
  for (const start of source.matchAll(startPattern)) {
    let depth = 0
    let end = start.index
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1
      if (source[end] === ')') {
        depth -= 1
        if (depth === 0) {
          end += 1
          break
        }
      }
    }
    if (depth === 0) calls.push({ value: source.slice(start.index, end), offset: start.index })
  }
  return calls
}

/*
 * Inline style rule: TSX feature/components must not carry literal non-color
 * values through JSX style objects. Direct object literals, same-file variable
 * references, object spreads and conditional branches are followed when their
 * values are statically resolvable.
 * Semantic var(--cpx-sys-*) references, zero lengths and reset keywords are
 * allowed; any other focused literal must be pinned by an exact
 * inlineStyle file+property+value exception.
 */
const inlineStyleFocusProperties = new Set([
  'fontSize',
  'lineHeight',
  'borderRadius',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'transition',
  'transitionDuration',
  'transitionTimingFunction',
  'animation',
  'animationDuration',
  'animationTimingFunction',
  'boxShadow',
  'textShadow',
  'filter',
  'backdropFilter',
  'zIndex',
  'padding',
  'paddingBlock',
  'paddingBlockStart',
  'paddingBlockEnd',
  'paddingInline',
  'paddingInlineStart',
  'paddingInlineEnd',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'margin',
  'marginBlock',
  'marginBlockStart',
  'marginBlockEnd',
  'marginInline',
  'marginInlineStart',
  'marginInlineEnd',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'gap',
  'rowGap',
  'columnGap',
])

function isAllowedInlineStyleValue(value: string): boolean {
  if (/var\(\s*--cpx-sys-/i.test(value)) return true
  if (/^0(?:\.0+)?(?:px|rem|em|ms|s|%)?$/i.test(value)) return true
  return /^(?:none|auto|inherit|initial|unset|revert)$/i.test(value)
}

function unwrapInlineStyleExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function inlineStylePropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return undefined
}

function inlineStyleStaticValue(expression: ts.Expression): string | undefined {
  const current = unwrapInlineStyleExpression(expression)
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text.trim()
  }
  if (ts.isNumericLiteral(current)) return current.text
  if (
    ts.isPrefixUnaryExpression(current) &&
    current.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(current.operand)
  ) {
    return `-${current.operand.text}`
  }
  return undefined
}

for (const file of featureTokenScriptFiles) {
  const script = featureTokenScriptSources.get(file)
  if (!script) continue
  const { source, path } = script
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    extname(path).toLowerCase() === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const variableInitializers = new Map<string, ts.Expression>()
  const collectVariables = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variableInitializers.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, collectVariables)
  }
  collectVariables(sourceFile)

  const scanStyleExpression = (expression: ts.Expression, visited: Set<ts.Node>): void => {
    const current = unwrapInlineStyleExpression(expression)
    if (visited.has(current)) return
    visited.add(current)

    if (ts.isIdentifier(current)) {
      const initializer = variableInitializers.get(current.text)
      if (initializer) scanStyleExpression(initializer, visited)
      return
    }
    if (ts.isConditionalExpression(current)) {
      scanStyleExpression(current.whenTrue, visited)
      scanStyleExpression(current.whenFalse, visited)
      return
    }
    if (!ts.isObjectLiteralExpression(current)) return

    for (const member of current.properties) {
      if (ts.isSpreadAssignment(member)) {
        scanStyleExpression(member.expression, visited)
        continue
      }
      if (!ts.isPropertyAssignment(member)) continue
      const property = inlineStylePropertyName(member.name)
      if (!property || !inlineStyleFocusProperties.has(property)) continue
      const value = inlineStyleStaticValue(member.initializer)
      if (value === undefined || isAllowedInlineStyleValue(value)) continue
      const used = markFeatureTokenUsed('inlineStyle', path, property, value)
      if (!used) {
        const line = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1
        errors.push(
          `feature TSX must not use literal inline style ${property}: ${value}: ${path}:${line}`,
        )
      }
    }
  }

  const visitJsxStyles = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'style' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      scanStyleExpression(node.initializer.expression, new Set())
    }
    ts.forEachChild(node, visitJsxStyles)
  }
  visitJsxStyles(sourceFile)
}

/*
 * Prefix rule: every utility class must carry the `tw:` prefix. Tailwind is
 * configured with `prefix(tw)`, so an unprefixed utility is not an error to
 * Tailwind — it is simply never generated, and the style silently disappears.
 * Only variant/utility-shaped tokens on a class-list line are reported, which
 * keeps JSX attributes (xlink:href) and object literals (files:parent) out.
 */
const unprefixedUtilityPattern =
  /(?:^|[\s"'`(])((?:hover|focus|focus-visible|focus-within|active|disabled|enabled|checked|indeterminate|selected|open|closed|data-|aria-|has-|group-|peer-|not-|placeholder|file|first|last|odd|even|motion-reduce|motion-safe|sm|md|lg|xl|max-|min-)[\w-]*(?:\[[^\]\n]*\])?:[\w[\]-]+)/gm
const allowedUnprefixedUtility = /^(?:https?:|data:|file:|xlink:|xml:|urn:|aria-[a-z]+:)/
function isClassListLine(line: string): boolean {
  return /className|tw:|cx\(|joinClassNames/.test(line)
}
for (const file of scriptFiles) {
  const source = await readFile(file, 'utf8')
  const path = workspacePath(file)
  if (!source.includes('tw:')) continue
  for (const match of source.matchAll(unprefixedUtilityPattern)) {
    const token = match[1]
    const index = (match.index ?? 0) + match[0].length - token.length
    if (source.slice(Math.max(0, index - 3), index) === 'tw:') continue
    if (allowedUnprefixedUtility.test(token)) continue
    const lineStart = source.lastIndexOf('\n', index) + 1
    const lineEnd = source.indexOf('\n', index)
    if (!isClassListLine(source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd)))
      continue
    errors.push(
      `Tailwind utility is missing the tw: prefix: ${path}:${lineNumberAt(source, index)} (${token})`,
    )
  }
}

/*
 * Typography role rule: a `type-*` role declares the whole `font:` shorthand and
 * Tailwind emits `type-weight-*` before the roles, so combining them in one
 * class list silently drops the weight. Elements either use a role that already
 * carries the weight, a bare weight utility, or `styles/role-weight.css`.
 */
const roleWithWeightPattern =
  /tw:type-(?!weight-)[a-z-]+[\s\S]{0,200}?tw:type-weight-|tw:type-weight-[a-z-]+[\s\S]{0,200}?tw:type-(?!weight-)[a-z-]+/g
for (const file of scriptFiles) {
  const source = await readFile(file, 'utf8')
  const path = workspacePath(file)
  for (const match of source.matchAll(roleWithWeightPattern)) {
    // Only one class list: a newline usually separates different attributes.
    if (match[0].includes('\n')) continue
    errors.push(
      `tw:type-* cannot be combined with tw:type-weight-* (the role font shorthand wins): ${path}:${lineNumberAt(source, match.index)}`,
    )
  }
}

/*
 * Tailwind arbitrary non-color rule: feature TSX must not carry literal
 * non-color values through Tailwind arbitrary classes (typography, radius,
 * motion, shadow, z-index, spacing), including optional variant prefixes
 * such as hover:p-[6px]. Semantic var(--cpx-sys-*) references inside the
 * bracket are allowed; any other matched class must be pinned by an exact
 * tailwindArbitrary file+className+complete-class exception.
 */
const tailwindArbitraryPattern =
  /((?:[\w-]+:)*?)((?:text|leading|rounded(?:-[a-z]{1,2})?|duration|ease|shadow|z|px|py|pt|pr|pb|pl|ps|pe|p|mx|my|mt|mr|mb|ml|ms|me|m|gap-x|gap-y|gap)-\[[^\]]+\])/g
for (const file of featureTokenScriptFiles) {
  const script = featureTokenScriptSources.get(file)
  if (!script) continue
  const { source, path, lineNumberAt } = script
  for (const match of source.matchAll(tailwindArbitraryPattern)) {
    const fullClass = `${match[1]}${match[2]}`
    const bracketContent = match[2].slice(match[2].indexOf('[') + 1, -1)
    if (/var\(\s*--cpx-sys-/.test(bracketContent)) continue
    const used = markFeatureTokenUsed('tailwindArbitrary', path, 'className', fullClass)
    if (!used) {
      errors.push(
        `feature TSX must not use literal Tailwind arbitrary ${fullClass}: ${path}:${lineNumberAt(match.index)}`,
      )
    }
  }
}

/*
 * Typography responsibility rule: feature TSX uses semantic `tw:type-*` roles
 * instead of generic Tailwind size/weight utilities that can override feature
 * styles independently of the component's content role.
 */
const tailwindTypographyPattern =
  /tw:(?:text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl)|font-(?:normal|medium|semibold|bold)|font-\[[^\]]+\])/g
for (const file of featureTokenScriptFiles) {
  const script = featureTokenScriptSources.get(file)
  if (!script) continue
  const { source, path, lineNumberAt } = script
  for (const match of source.matchAll(tailwindTypographyPattern)) {
    const className = match[0]
    const used = markFeatureTokenUsed('tailwindTypography', path, 'className', className)
    if (!used) {
      errors.push(
        `feature TSX must use a semantic typography role instead of ${className}: ${path}:${lineNumberAt(match.index)}`,
      )
    }
  }
}

/*
 * Decimal spacing utility rule: UI components must use the integer Radix 9-step
 * spacing scale (1..9) and never decimal spacing utilities (0.5, 1.5, 2.5, 3.5).
 */
const tailwindDecimalSpacingPattern =
  /\btw:(?:[a-z-]+:)*(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y|w|h|min-w|min-h|max-w|max-h|size)-\d+\.\d+\b/g
for (const file of featureTokenScriptFiles) {
  const script = featureTokenScriptSources.get(file)
  if (!script || !script.path.startsWith('src/components/')) continue
  const { source, path, lineNumberAt } = script
  for (const match of source.matchAll(tailwindDecimalSpacingPattern)) {
    errors.push(
      `component TSX must not use decimal spacing utility ${match[0]}: ${path}:${lineNumberAt(match.index)}`,
    )
  }
}

const entrypoint = resolve(workspaceRoot, manifest.styleEntrypoint)
if (!(await isFile(entrypoint)) || !styleExtensions.has(extname(entrypoint))) {
  errors.push(
    `styleEntrypoint must point to one existing CSS/SCSS file: ${manifest.styleEntrypoint}`,
  )
}

const entrypointSource = await readFile(entrypoint, 'utf8')
const declaredLayerOrder = entrypointSource
  .match(/@layer\s+([^;]+);/)?.[1]
  .split(',')
  .map((layer) => layer.trim())
if (
  !declaredLayerOrder ||
  declaredLayerOrder.length !== manifest.cascadeLayerOrder.length ||
  declaredLayerOrder.some((layer, index) => layer !== manifest.cascadeLayerOrder[index])
) {
  errors.push(`cascade layer order must be: ${manifest.cascadeLayerOrder.join(', ')}`)
}

const legacyScssEntrypoints = (manifest.legacyScssEntrypoints ?? []).map((path) =>
  resolve(workspaceRoot, path),
)

/*
 * A layer counts as loaded when it is either a `@layer name { }` block or an
 * `@import ... layer(name)` modifier. The Tailwind entrypoint loads the theme
 * and utility layers through imports, so both forms must be recognised across
 * the entrypoint and any legacy SCSS entrypoint that shares the cascade order.
 */
const loadedLayers = new Set<string>()
/*
 * Layer blocks live in the imported stylesheets (the entrypoint only declares
 * the order) plus `layer()` modifiers on the imports, so the scan walks the
 * whole entry graph instead of reading the entrypoint alone.
 */
const layerSources = new Set<string>([entrypoint, ...legacyScssEntrypoints])
for (const graphFile of await collectEntryGraph(entrypoint)) layerSources.add(graphFile)
// Lazy entrypoints are imported by their feature, not by the main entry, and the
// vendor layer is only loaded from one of them.
for (const lazyPath of Object.keys(manifest.lazyStyleEntrypoints)) {
  const lazyFile = resolve(workspaceRoot, lazyPath)
  if (await isFile(lazyFile)) layerSources.add(lazyFile)
}
for (const componentPath of Object.keys(manifest.componentStyleEntrypoints ?? {})) {
  const componentFile = resolve(workspaceRoot, componentPath)
  if (await isFile(componentFile)) layerSources.add(componentFile)
}
for (const styleFile of layerSources) {
  const source = await readFile(styleFile, 'utf8')
  for (const match of source.matchAll(/@layer\s+([\w-]+)\s*\{/g)) loadedLayers.add(match[1])
  for (const match of source.matchAll(/@import\s+[^;]*\blayer\(\s*([\w-]+)\s*\)/g))
    loadedLayers.add(match[1])
}
for (const layer of manifest.cascadeLayerOrder) {
  if (!loadedLayers.has(layer)) errors.push(`cascade layer has no explicit block: ${layer}`)
}

const entryGraph = await collectEntryGraph(entrypoint)
const allowedDirectImports = new Set(manifest.directStyleImportAllowlist)
const observedDirectImports = new Set<string>()
const directStyleTargets = new Set<string>()
const observedEntrypointImporters = new Set<string>()

for (const scriptFile of scriptFiles) {
  const source = await readFile(scriptFile, 'utf8')
  for (const match of source.matchAll(
    /import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+\.(?:css|scss))['"]/g,
  )) {
    const target = await resolveStyleReference(scriptFile, match[1])
    if (!target) {
      errors.push(`${workspacePath(scriptFile)} imports a missing style file: ${match[1]}`)
      continue
    }
    if (target === entrypoint) {
      observedEntrypointImporters.add(workspacePath(scriptFile))
      continue
    }

    const descriptor = `${workspacePath(scriptFile)} -> ${workspacePath(target)}`
    observedDirectImports.add(descriptor)
    directStyleTargets.add(target)
    if (!allowedDirectImports.has(descriptor)) {
      errors.push(`direct style import is not allowlisted: ${descriptor}`)
    }
  }
}

if (
  observedEntrypointImporters.size !== 1 ||
  !observedEntrypointImporters.has(manifest.styleEntrypointImporter)
) {
  errors.push(
    `style entrypoint must be imported only by ${manifest.styleEntrypointImporter}; observed: ${[...observedEntrypointImporters].sort().join(', ') || 'none'}`,
  )
}

for (const descriptor of allowedDirectImports) {
  if (!observedDirectImports.has(descriptor)) {
    errors.push(`stale directStyleImportAllowlist entry: ${descriptor}`)
  }
}

const lazyStyleEntrypoints = new Map(
  Object.entries(manifest.lazyStyleEntrypoints).map(([path, layer]) => [
    resolve(workspaceRoot, path),
    layer,
  ]),
)
const legacyEntrypointSet = new Set(legacyScssEntrypoints)
for (const [lazyEntrypoint, expectedLayer] of lazyStyleEntrypoints) {
  if (!directStyleTargets.has(lazyEntrypoint)) {
    errors.push(`lazy style entrypoint must be directly imported: ${workspacePath(lazyEntrypoint)}`)
    continue
  }
  const source = await readFile(lazyEntrypoint, 'utf8')
  const layers = [
    ...new Set(
      [
        ...source.matchAll(/@layer\s+([\w-]+)\s*\{/g),
        ...source.matchAll(/@import\s+[^;]*\blayer\(\s*([\w-]+)\s*\)/g),
      ].map((match) => match[1]),
    ),
  ]
  if (layers.length !== 1 || layers[0] !== expectedLayer) {
    errors.push(
      `lazy style entrypoint ${workspacePath(lazyEntrypoint)} must declare only @layer ${expectedLayer}`,
    )
  }
}
const componentStyleEntrypoints = new Map(
  Object.entries(manifest.componentStyleEntrypoints ?? {}).map(([path, layer]) => [
    resolve(workspaceRoot, path),
    Array.isArray(layer) ? layer : [layer],
  ]),
)
for (const [componentEntrypoint, expectedLayers] of componentStyleEntrypoints) {
  if (!directStyleTargets.has(componentEntrypoint)) {
    errors.push(
      `component style entrypoint must be directly imported: ${workspacePath(componentEntrypoint)}`,
    )
    continue
  }
  const source = await readFile(componentEntrypoint, 'utf8')
  const layers = [
    ...new Set(
      [
        ...source.matchAll(/@layer\s+([\w-]+)\s*\{/g),
        ...source.matchAll(/@import\s+[^;]*\blayer\(\s*([\w-]+)\s*\)/g),
      ].map((match) => match[1]),
    ),
  ]
  for (const layer of layers) {
    if (!expectedLayers.includes(layer)) {
      errors.push(
        `component style entrypoint ${workspacePath(componentEntrypoint)} declares unexpected @layer ${layer}; allowed: ${expectedLayers.join(', ')}`,
      )
    }
  }
  if (layers.length === 0) {
    errors.push(
      `component style entrypoint ${workspacePath(componentEntrypoint)} must declare at least one @layer (${expectedLayers.join(', ')})`,
    )
  }
}
for (const directStyleTarget of directStyleTargets) {
  if (
    directStyleTarget === entrypoint ||
    lazyStyleEntrypoints.has(directStyleTarget) ||
    legacyEntrypointSet.has(directStyleTarget) ||
    componentStyleEntrypoints.has(directStyleTarget)
  ) {
    continue
  }
  errors.push(
    `direct style target must be a declared lazy, component or legacy entrypoint: ${workspacePath(directStyleTarget)}`,
  )
}
for (const legacyEntrypoint of legacyScssEntrypoints) {
  if (!directStyleTargets.has(legacyEntrypoint)) {
    errors.push(
      `legacy SCSS entrypoint must be directly imported: ${workspacePath(legacyEntrypoint)}`,
    )
  }
}

const completeStyleGraph = new Set(entryGraph)
for (const lazyEntrypoint of lazyStyleEntrypoints.keys()) {
  for (const styleFile of await collectEntryGraph(lazyEntrypoint)) {
    completeStyleGraph.add(styleFile)
  }
}
for (const legacyEntrypoint of legacyScssEntrypoints) {
  for (const styleFile of await collectEntryGraph(legacyEntrypoint)) {
    completeStyleGraph.add(styleFile)
  }
}
for (const componentEntrypoint of componentStyleEntrypoints.keys()) {
  for (const styleFile of await collectEntryGraph(componentEntrypoint)) {
    completeStyleGraph.add(styleFile)
  }
}

for (const styleFile of styleFiles) {
  if (!completeStyleGraph.has(styleFile) && !directStyleTargets.has(styleFile)) {
    errors.push(`style file is outside the single-entry graph: ${workspacePath(styleFile)}`)
  }
}

const customPropertyReferences = new Set<string>()
const customPropertyDefinitions = new Set<string>()
for (const file of [...styleFiles, ...scriptFiles]) {
  const source = await readFile(file, 'utf8')
  const isStyle = styleExtensions.has(extname(file))
  for (const match of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
    customPropertyReferences.add(match[1])
  }
  for (const definition of collectCustomPropertyDefinitions(source, isStyle)) {
    customPropertyDefinitions.add(definition)
  }
}

const allowedCustomPropertyReferences = new Set(manifest.customPropertyReferenceAllowlist)
const forbiddenCustomPropertyPatterns = manifest.forbiddenCustomPropertyPatterns.map(
  (pattern) => new RegExp(pattern),
)
for (const definition of customPropertyDefinitions) {
  if (forbiddenCustomPropertyPatterns.some((pattern) => pattern.test(definition))) {
    errors.push(`forbidden legacy custom property definition: ${definition}`)
  }
}
const customPropertyReferenceSources = new Map<string, string[]>()
for (const file of [...styleFiles, ...scriptFiles]) {
  const source = await readFile(file, 'utf8')
  for (const match of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
    const sources = customPropertyReferenceSources.get(match[1]) ?? []
    sources.push(workspacePath(file))
    customPropertyReferenceSources.set(match[1], sources)
  }
}
for (const reference of customPropertyReferences) {
  if (
    !customPropertyDefinitions.has(reference) &&
    !allowedCustomPropertyReferences.has(reference)
  ) {
    errors.push(
      `undefined custom property reference: ${reference} (${[...new Set(customPropertyReferenceSources.get(reference) ?? [])].join(', ')})`,
    )
  }
}
for (const reference of allowedCustomPropertyReferences) {
  if (customPropertyDefinitions.has(reference) || !customPropertyReferences.has(reference)) {
    errors.push(`stale customPropertyReferenceAllowlist entry: ${reference}`)
  }
}

const observedDataThemeSelectors: Record<string, number> = {}
const observedImportantDeclarations: Record<string, number> = {}
for (const styleFile of styleFiles) {
  const source = await readFile(styleFile, 'utf8')
  const importantCount = [...source.matchAll(/!important\b/g)].length
  if (importantCount > 0) observedImportantDeclarations[workspacePath(styleFile)] = importantCount
  const count = [...source.matchAll(/\[data-theme(?=[\s=\]])/g)].length
  if (count > 0) observedDataThemeSelectors[workspacePath(styleFile)] = count
}

const importantFiles = new Set([
  ...Object.keys(manifest.importantDeclarationAllowlist),
  ...Object.keys(observedImportantDeclarations),
])
for (const file of importantFiles) {
  const expected = manifest.importantDeclarationAllowlist[file] ?? 0
  const observed = observedImportantDeclarations[file] ?? 0
  if (expected !== observed) {
    errors.push(
      `!important declaration count changed in ${file}: expected ${expected}, observed ${observed}`,
    )
  }
}

const dataThemeFiles = new Set([
  ...Object.keys(manifest.dataThemeSelectorAllowlist),
  ...Object.keys(observedDataThemeSelectors),
])
for (const file of dataThemeFiles) {
  const expected = manifest.dataThemeSelectorAllowlist[file] ?? 0
  const observed = observedDataThemeSelectors[file] ?? 0
  if (expected !== observed) {
    errors.push(
      `data-theme selector count changed in ${file}: expected ${expected}, observed ${observed}`,
    )
  }
}

/*
 * Line-height governance: content roles must use the semantic --type-line-*
 * tokens (or var/calc/max/min/clamp), while fixed desktop chrome (buttons,
 * badges, review diff, control profiles) keeps its geometry through the
 * per-file literal allowlist. TSX must not add ad-hoc tw:leading-* values;
 * new typography roles belong in the Tailwind theme instead.
 */
const semanticLineHeightValue = /^(?:var\(|calc\(|max\(|min\(|clamp\(|inherit)/
const observedLiteralLineHeights: Record<string, number> = {}
const literalLineHeightValues: Record<string, Set<string>> = {}
for (const styleFile of styleFiles) {
  const source = await readFile(styleFile, 'utf8')
  const declarations = [
    ...source.matchAll(/(?<!-)line-height\s*:\s*([^;{}]+);/g).map((match) => match[1]),
    ...source.matchAll(/--[\w-]+-line-height\s*:\s*([^;{}]+);/g).map((match) => match[1]),
  ].map((value) => value.trim())
  const literals = declarations.filter((value) => !semanticLineHeightValue.test(value))
  if (literals.length === 0) continue
  const filePath = workspacePath(styleFile)
  observedLiteralLineHeights[filePath] = literals.length
  literalLineHeightValues[filePath] = new Set(literals)
}

const literalLineHeightFiles = new Set([
  ...Object.keys(manifest.literalLineHeightAllowlist),
  ...Object.keys(observedLiteralLineHeights),
])
for (const file of literalLineHeightFiles) {
  const expected = manifest.literalLineHeightAllowlist[file] ?? 0
  const observed = observedLiteralLineHeights[file] ?? 0
  if (expected !== observed) {
    const values = [...(literalLineHeightValues[file] ?? [])].sort().join(', ')
    errors.push(
      `literal line-height count changed in ${file}: expected ${expected}, observed ${observed}${values ? ` (${values})` : ''}`,
    )
  }
}

const observedTailwindLeading: Record<string, number> = {}
for (const scriptFile of scriptFiles) {
  const source = await readFile(scriptFile, 'utf8')
  const count = [...source.matchAll(/tw:leading-/g)].length
  if (count > 0) observedTailwindLeading[workspacePath(scriptFile)] = count
}
const tailwindLeadingFiles = new Set([
  ...Object.keys(manifest.tailwindLeadingAllowlist),
  ...Object.keys(observedTailwindLeading),
])
for (const file of tailwindLeadingFiles) {
  const expected = manifest.tailwindLeadingAllowlist[file] ?? 0
  const observed = observedTailwindLeading[file] ?? 0
  if (expected !== observed) {
    errors.push(`tw:leading-* count changed in ${file}: expected ${expected}, observed ${observed}`)
  }
}

/*
 * Font shorthand must not smuggle a line-height through the `/` segment; use
 * semantic line-height tokens instead. `font: inherit` resets stay valid.
 */
for (const styleFile of styleFiles) {
  const source = await readFile(styleFile, 'utf8')
  for (const match of source.matchAll(/font\s*:\s*[^;{}]*\/[^;{}]*;/g)) {
    errors.push(
      `font shorthand with '/' line-height in ${workspacePath(styleFile)}: declare font-family, font-size and line-height separately`,
    )
  }
}

/*
 * Animation implementation contracts: continuous animations must stay on the
 * compositor/transform path. Guards the progress bars and the scroll edge-fade
 * frames against regressing to per-frame repaints (background-position sweeps),
 * layout-thrash transitions (width), persistent will-change promotion, scroll
 * timelines or dynamic mask keyframes. Sweep keyframes are scanned wherever
 * they live, so moving a shimmer into a utility or a component file keeps the
 * same guarantee.
 */
/** Yield every `@keyframes <name> { ... }` body found in one stylesheet. */
function* keyframeBodies(source: string): Generator<string> {
  for (const match of source.matchAll(/@keyframes\s+[\w-]+\s*\{/g)) {
    let depth = 0
    let end = match.index ?? 0
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1
      else if (source[end] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    yield source.slice(match.index, end + 1)
  }
}

for (const styleFile of styleFiles) {
  const source = await readFile(styleFile, 'utf8')
  const path = workspacePath(styleFile)
  if (/background-attachment\s*:\s*fixed/.test(source)) {
    errors.push(`shimmer must not use background-attachment: fixed repaint sweeps: ${path}`)
  }
  for (const block of keyframeBodies(source)) {
    if (/background-position/.test(block)) {
      errors.push(
        `keyframes must not animate background-position; use a transform translateX sweep: ${path}`,
      )
      break
    }
  }
}

/*
 * Compositor contracts are checked wherever the selector now lives — a feature
 * stylesheet, a primitives residue file, or a Tailwind class list in TSX — so
 * moving a rule during the migration cannot quietly retire its guarantee.
 */
const allSources: Array<{ path: string; text: string }> = []
for (const styleFile of styleFiles) {
  allSources.push({ path: workspacePath(styleFile), text: await readFile(styleFile, 'utf8') })
}
for (const [scriptFile, script] of featureTokenScriptSources) {
  allSources.push({ path: workspacePath(scriptFile), text: script.source })
}

/** Selector occurrences with a window around them, for declaration queries. */
function selectorWindows(selector: string): Array<{ path: string; window: string }> {
  const hits: Array<{ path: string; window: string }> = []
  for (const { path, text } of allSources) {
    let index = text.indexOf(selector)
    while (index !== -1) {
      hits.push({ path, window: text.slice(Math.max(0, index - 40), index + 240) })
      index = text.indexOf(selector, index + selector.length)
    }
  }
  return hits
}

for (const [selector, label] of [
  ['.sidebar-session-list-extra', 'sidebar session list'],
  ['.canonical-turn-activity__content', 'canonical activity content'],
] as const) {
  const sites = selectorWindows(selector)
  if (sites.length === 0) {
    errors.push(`animation contract selector is gone from every source: ${selector}`)
    continue
  }
  for (const site of sites) {
    if (/will-change\s*[:=]/.test(site.window) || /will-change-/.test(site.window)) {
      errors.push(`${label} must not carry persistent will-change: ${selector} (${site.path})`)
    }
  }
}

for (const site of selectorWindows('.composer-status-bar-fill')) {
  if (!site.path.endsWith('.scss') && !site.path.endsWith('.css')) continue
  const block = selectorBlock(site.window, '.composer-status-bar-fill')
  if (!block) continue
  const properties = transitionProperties(block)
  if (properties.length === 0 || properties.some((property) => property !== 'transform')) {
    errors.push(`${'.composer-status-bar-fill'} must transition only transform (compositor)`)
  }
}

/*
 * Scroll fade masks and scroll-driven animation timelines are banned everywhere
 * rather than in one named file: the same rules may live in a stylesheet, a
 * primitives residue file or a Tailwind utility, and moving them must not quietly
 * drop the guarantee.
 */
const allStyleAndFeatureSources: Array<{ path: string; text: string }> = []
for (const styleFile of styleFiles) {
  allStyleAndFeatureSources.push({
    path: workspacePath(styleFile),
    text: await readFile(styleFile, 'utf8'),
  })
}
for (const [scriptFile, script] of featureTokenScriptSources) {
  allStyleAndFeatureSources.push({ path: workspacePath(scriptFile), text: script.source })
}

for (const { path, text } of allStyleAndFeatureSources) {
  if (/animation-timeline/.test(text)) {
    errors.push(`${path} must not use animation-timeline scroll masks`)
  }
  if (/@property\s+--(?:canonical-process|execution-plan)/.test(text)) {
    errors.push(`${path} must not re-add scroll fade @property variables`)
  }
  if (/@keyframes\s+(?:canonical-process-edge-fade|execution-plan-edge-fade)\b/.test(text)) {
    errors.push(`${path} must not re-add scroll fade mask keyframes`)
  }
}

for (const [category, registry] of featureTokenRegistry) {
  for (const [key, entry] of registry) {
    if (!entry.used) errors.push(`stale feature token exception: ${key}`)
  }
}

/*
 * Stage 4 static style-governance gates:
 * 1. Dead CSS selector detection ([dead-css-selector])
 * 2. Multi-file CSS class definition ratchet ([multi-file-class])
 * 3. Same-element CSS vs Tailwind (`tw:*`) property-category collision ([css-tw-collision])
 */
type CssPropertyCategory =
  | 'display'
  | 'position'
  | 'width'
  | 'min-width'
  | 'max-width'
  | 'height'
  | 'min-height'
  | 'max-height'
  | 'padding-top'
  | 'padding-right'
  | 'padding-bottom'
  | 'padding-left'
  | 'margin-top'
  | 'margin-right'
  | 'margin-bottom'
  | 'margin-left'
  | 'gap'
  | 'row-gap'
  | 'column-gap'
  | 'flex-direction'
  | 'flex-grow'
  | 'flex-shrink'
  | 'flex-basis'
  | 'align-items'
  | 'align-self'
  | 'align-content'
  | 'justify-content'
  | 'justify-items'
  | 'justify-self'
  | 'grid-template-columns'
  | 'grid-template-rows'
  | 'grid-column'
  | 'grid-row'
  | 'order'
  | 'font-family'
  | 'font-size'
  | 'line-height'
  | 'letter-spacing'
  | 'font-weight'
  | 'text-align'
  | 'white-space'
  | 'word-break'
  | 'overflow-wrap'
  | 'text-overflow'
  | 'font-variant-numeric'
  | 'text-decoration'
  | 'text-transform'
  | 'color'
  | 'background'
  | 'border-top'
  | 'border-right'
  | 'border-bottom'
  | 'border-left'
  | 'radius'
  | 'overflow-x'
  | 'overflow-y'
  | 'overscroll-behavior'
  | 'z-index'
  | 'opacity'
  | 'transition'
  | 'cursor'
  | 'pointer-events'
  | 'user-select'
  | 'touch-action'
  | 'resize'
  | 'appearance'

type CssSelectorRuleProfile = {
  requiredClasses: string[]
  excludedClasses: string[]
  pseudoStates: Set<string>
  categories: Set<CssPropertyCategory>
}

type CssTailwindCollisionRecord = {
  file: string
  line: number
  cssClass: string
  twClass: string
  category: CssPropertyCategory
}

const vendorClassPattern =
  /^(?:ProseMirror(?:-|$)|cm-|xterm(?:-|$)|katex(?:-|$)|hljs(?:-|$)|language-|lucide(?:-|$))/
const pureStateClasses = new Set([
  'active',
  'selected',
  'open',
  'disabled',
  'checked',
  'danger',
  'dragging',
  'resizing',
  'loading',
  'error',
  'empty',
  'hidden',
  'visible',
  'compact',
  'rich',
  'expanded',
  'collapsed',
  'focused',
  'highlighted',
  'pressed',
])
const statePseudoClasses = new Set([
  'hover',
  'focus',
  'focus-visible',
  'focus-within',
  'active',
  'disabled',
  'checked',
])
const pseudoElementPattern =
  /^::|^:(?:before|after|first-line|first-letter|marker|placeholder|selection)$/i
const classTokenHelperNames = new Set(['cx', 'joinClassNames', 'clsx', 'cn'])

function isPureStateClass(className: string): boolean {
  return pureStateClasses.has(className) || /^(?:is|has)-[a-z0-9-]+$/.test(className)
}

function isRuleInsideAtRule(rule: PostcssRule, namePattern: RegExp, paramToken?: string): boolean {
  let current: PostcssContainer | PostcssDocument | undefined = rule.parent
  while (current) {
    if (current.type === 'atrule') {
      const atRule = current as PostcssAtRule
      if (namePattern.test(atRule.name)) {
        if (paramToken === undefined) return true
        const params = atRule.params
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean)
        if (params.includes(paramToken)) return true
      }
    }
    current = current.parent
  }
  return false
}

function resolveEffectiveSelector(rule: PostcssRule): string {
  let parentRule: PostcssRule | null = null
  let current: PostcssContainer | PostcssDocument | undefined = rule.parent
  while (current) {
    if (current.type === 'rule') {
      parentRule = current as PostcssRule
      break
    }
    current = current.parent
  }
  if (!parentRule) return rule.selector
  const parentSelector = resolveEffectiveSelector(parentRule)
  if (rule.selector.includes('&')) {
    return rule.selector.replace(/&/g, `:is(${parentSelector})`)
  }
  return `:is(${parentSelector}) ${rule.selector}`
}

function collectClassesFromSubjectNodes(
  nodes: selectorParser.Node[],
  classes: Set<string>,
  pseudoStates: Set<string>,
): void {
  for (const node of nodes) {
    if (node.type === 'class') {
      classes.add(node.value)
    } else if (node.type === 'pseudo') {
      const pseudoName = node.value.replace(/^:+/, '').toLowerCase()
      if (statePseudoClasses.has(pseudoName)) pseudoStates.add(pseudoName)
      if ((node.value === ':is' || node.value === ':where') && node.nodes) {
        for (const innerSelector of node.nodes) {
          collectClassesFromSubjectNodes(innerSelector.nodes, classes, pseudoStates)
        }
      }
    }
  }
}

type SubjectVariant = {
  requiredClasses: string[]
  excludedClasses: string[]
  pseudoStates: Set<string>
}

function mergeSubjectVariants(left: SubjectVariant[], right: SubjectVariant[]): SubjectVariant[] {
  const merged: SubjectVariant[] = []
  for (const a of left) {
    for (const b of right) {
      merged.push({
        requiredClasses: [...new Set([...a.requiredClasses, ...b.requiredClasses])],
        excludedClasses: [...new Set([...a.excludedClasses, ...b.excludedClasses])],
        pseudoStates: new Set([...a.pseudoStates, ...b.pseudoStates]),
      })
    }
  }
  return merged
}

function expandSubjectNodeVariants(nodes: selectorParser.Node[]): SubjectVariant[] {
  let variants: SubjectVariant[] = [
    { requiredClasses: [], excludedClasses: [], pseudoStates: new Set() },
  ]
  for (const node of nodes) {
    if (node.type === 'class') {
      variants = variants.map((variant) => ({
        ...variant,
        requiredClasses: variant.requiredClasses.includes(node.value)
          ? variant.requiredClasses
          : [...variant.requiredClasses, node.value],
      }))
    } else if (node.type === 'pseudo') {
      const pseudoName = node.value.replace(/^:+/, '').toLowerCase()
      if (statePseudoClasses.has(pseudoName)) {
        for (const variant of variants) variant.pseudoStates.add(pseudoName)
      }
      if (pseudoName === 'has') {
        for (const variant of variants) variant.pseudoStates.add('has-state')
      }
      if ((node.value === ':is' || node.value === ':where') && node.nodes) {
        const innerVariants: SubjectVariant[] = []
        for (const innerSelector of node.nodes) {
          innerVariants.push(...expandSubjectNodeVariants(innerSelector.nodes))
        }
        if (innerVariants.length > 0) {
          variants = mergeSubjectVariants(variants, innerVariants)
        }
      } else if (node.value === ':not' && node.nodes) {
        const excluded = new Set<string>()
        for (const innerSelector of node.nodes) {
          const hasCombinator = innerSelector.nodes.some((child) => child.type === 'combinator')
          if (hasCombinator) continue
          for (const child of innerSelector.nodes) {
            if (child.type === 'class') excluded.add(child.value)
          }
        }
        if (excluded.size > 0) {
          variants = variants.map((variant) => ({
            ...variant,
            excludedClasses: [...new Set([...variant.excludedClasses, ...excluded])],
          }))
        }
      }
    }
  }
  return variants
}

function selectorNodesContainHas(nodes: selectorParser.Node[]): boolean {
  for (const node of nodes) {
    if (node.type === 'pseudo') {
      if (node.value.toLowerCase() === ':has') return true
      if (node.nodes?.some((inner) => selectorNodesContainHas(inner.nodes))) return true
    }
  }
  return false
}

function extractSelectorSubjectRules(selectorText: string): SubjectVariant[] {
  let ast: selectorParser.Root
  try {
    ast = selectorParser().astSync(selectorText)
  } catch {
    return []
  }
  const results: SubjectVariant[] = []
  for (const selector of ast.nodes) {
    let subjectStart = 0
    for (let index = selector.nodes.length - 1; index >= 0; index -= 1) {
      if (selector.nodes[index].type === 'combinator') {
        subjectStart = index + 1
        break
      }
    }
    const ancestorNodes = selector.nodes.slice(0, subjectStart)
    const subjectNodes = selector.nodes.slice(subjectStart)
    if (
      subjectNodes.some((node) => node.type === 'pseudo' && pseudoElementPattern.test(node.value))
    ) {
      continue
    }
    const ancestorHasState = selectorNodesContainHas(ancestorNodes)
    for (const variant of expandSubjectNodeVariants(subjectNodes)) {
      if (variant.requiredClasses.length === 0) continue
      if (ancestorHasState) variant.pseudoStates.add('has-state')
      results.push(variant)
    }
  }
  return results
}

function extractSelectorClasses(
  selectorText: string,
  mode: 'all' | 'subject-all' | 'subject-element-only',
): { classes: Set<string>; pseudoStates: Set<string> } {
  const classes = new Set<string>()
  const pseudoStates = new Set<string>()
  let ast: selectorParser.Root
  try {
    ast = selectorParser().astSync(selectorText)
  } catch {
    return { classes, pseudoStates }
  }
  if (mode === 'all') {
    ast.walkClasses((node) => {
      classes.add(node.value)
    })
    return { classes, pseudoStates }
  }
  for (const selector of ast.nodes) {
    let subjectStart = 0
    for (let index = selector.nodes.length - 1; index >= 0; index -= 1) {
      if (selector.nodes[index].type === 'combinator') {
        subjectStart = index + 1
        break
      }
    }
    const subjectNodes = selector.nodes.slice(subjectStart)
    if (
      mode === 'subject-element-only' &&
      subjectNodes.some((node) => node.type === 'pseudo' && pseudoElementPattern.test(node.value))
    ) {
      continue
    }
    collectClassesFromSubjectNodes(subjectNodes, classes, pseudoStates)
  }
  return { classes, pseudoStates }
}

function cssPropertyToCategories(property: string): CssPropertyCategory[] {
  const prop = property.toLowerCase()
  if (prop.startsWith('--')) return []
  if (prop === 'display') return ['display']
  if (
    prop === 'position' ||
    prop === 'inset' ||
    prop === 'inset-block' ||
    prop === 'inset-block-start' ||
    prop === 'inset-block-end' ||
    prop === 'inset-inline' ||
    prop === 'inset-inline-start' ||
    prop === 'inset-inline-end' ||
    prop === 'top' ||
    prop === 'right' ||
    prop === 'bottom' ||
    prop === 'left'
  ) {
    return ['position']
  }
  if (prop === 'width' || prop === 'inline-size') return ['width']
  if (prop === 'min-width' || prop === 'min-inline-size') return ['min-width']
  if (prop === 'max-width' || prop === 'max-inline-size') return ['max-width']
  if (prop === 'height' || prop === 'block-size') return ['height']
  if (prop === 'min-height' || prop === 'min-block-size') return ['min-height']
  if (prop === 'max-height' || prop === 'max-block-size') return ['max-height']
  if (prop === 'padding') return ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']
  if (prop === 'padding-block') return ['padding-top', 'padding-bottom']
  if (prop === 'padding-inline') return ['padding-left', 'padding-right']
  if (prop === 'padding-top' || prop === 'padding-block-start') return ['padding-top']
  if (prop === 'padding-bottom' || prop === 'padding-block-end') return ['padding-bottom']
  if (prop === 'padding-left' || prop === 'padding-inline-start') return ['padding-left']
  if (prop === 'padding-right' || prop === 'padding-inline-end') return ['padding-right']
  if (prop === 'margin') return ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']
  if (prop === 'margin-block') return ['margin-top', 'margin-bottom']
  if (prop === 'margin-inline') return ['margin-left', 'margin-right']
  if (prop === 'margin-top' || prop === 'margin-block-start') return ['margin-top']
  if (prop === 'margin-bottom' || prop === 'margin-block-end') return ['margin-bottom']
  if (prop === 'margin-left' || prop === 'margin-inline-start') return ['margin-left']
  if (prop === 'margin-right' || prop === 'margin-inline-end') return ['margin-right']
  if (prop === 'gap') return ['row-gap', 'column-gap']
  if (prop === 'row-gap') return ['row-gap']
  if (prop === 'column-gap') return ['column-gap']
  if (prop === 'flex') return ['flex-grow', 'flex-shrink', 'flex-basis']
  if (prop === 'flex-direction') return ['flex-direction']
  if (prop === 'flex-grow') return ['flex-grow']
  if (prop === 'flex-shrink') return ['flex-shrink']
  if (prop === 'flex-basis') return ['flex-basis']
  if (prop === 'align-items') return ['align-items']
  if (prop === 'align-self') return ['align-self']
  if (prop === 'align-content') return ['align-content']
  if (prop === 'justify-content') return ['justify-content']
  if (prop === 'justify-items') return ['justify-items']
  if (prop === 'justify-self') return ['justify-self']
  if (prop === 'place-items') return ['align-items', 'justify-items']
  if (prop === 'place-content') return ['align-content', 'justify-content']
  if (prop === 'place-self') return ['align-self', 'justify-self']
  if (prop === 'grid-template-columns') return ['grid-template-columns']
  if (prop === 'grid-template-rows') return ['grid-template-rows']
  if (prop === 'grid-column') return ['grid-column']
  if (prop === 'grid-row') return ['grid-row']
  if (prop === 'order') return ['order']
  if (prop === 'font') return ['font-family', 'font-size', 'line-height', 'font-weight']
  if (prop === 'font-family') return ['font-family']
  if (prop === 'font-size') return ['font-size']
  if (prop === 'line-height') return ['line-height']
  if (prop === 'letter-spacing') return ['letter-spacing']
  if (prop === 'font-weight') return ['font-weight']
  if (prop === 'text-align') return ['text-align']
  if (prop === 'white-space') return ['white-space']
  if (prop === 'word-break') return ['word-break']
  if (prop === 'overflow-wrap') return ['overflow-wrap']
  if (prop === 'text-overflow') return ['text-overflow']
  if (prop === 'font-variant-numeric') return ['font-variant-numeric']
  if (prop === 'text-decoration' || prop.startsWith('text-decoration-')) return ['text-decoration']
  if (prop === 'text-transform') return ['text-transform']
  if (prop === 'color') return ['color']
  if (prop === 'background' || prop.startsWith('background-')) return ['background']
  if (prop.includes('radius')) return ['radius']
  if (prop === 'border') return ['border-top', 'border-right', 'border-bottom', 'border-left']
  if (prop === 'border-block') return ['border-top', 'border-bottom']
  if (prop === 'border-inline') return ['border-left', 'border-right']
  if (prop.startsWith('border-top')) return ['border-top']
  if (prop.startsWith('border-right')) return ['border-right']
  if (prop.startsWith('border-bottom')) return ['border-bottom']
  if (prop.startsWith('border-left')) return ['border-left']
  if (prop === 'border-color' || prop === 'border-width' || prop === 'border-style') {
    return ['border-top', 'border-right', 'border-bottom', 'border-left']
  }
  if (prop === 'overflow') return ['overflow-x', 'overflow-y']
  if (prop === 'overflow-x' || prop === 'overflow-inline') return ['overflow-x']
  if (prop === 'overflow-y' || prop === 'overflow-block') return ['overflow-y']
  if (prop.startsWith('overscroll-behavior')) return ['overscroll-behavior']
  if (prop === 'z-index') return ['z-index']
  if (prop === 'opacity') return ['opacity']
  if (prop.startsWith('transition') || prop.startsWith('animation')) return ['transition']
  if (prop === 'cursor') return ['cursor']
  if (prop === 'pointer-events') return ['pointer-events']
  if (prop === 'user-select' || prop === '-webkit-user-select') return ['user-select']
  if (prop === 'touch-action') return ['touch-action']
  if (prop === 'resize') return ['resize']
  if (prop === 'appearance') return ['appearance']
  return []
}

function splitTopLevelColons(input: string): string[] {
  const parts: string[] = []
  let start = 0
  let bracketDepth = 0
  let parenDepth = 0
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index]
    if (ch === '[') bracketDepth += 1
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (ch === '(') parenDepth += 1
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)
    else if (ch === ':' && bracketDepth === 0 && parenDepth === 0) {
      parts.push(input.slice(start, index))
      start = index + 1
    }
  }
  parts.push(input.slice(start))
  return parts
}

const typographyTextUtilityPattern =
  /^text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|[1-9]|code|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/

function tailwindUtilityCategories(utilityToken: string): CssPropertyCategory[] {
  const utility = utilityToken.replace(/^!/, '').replace(/^-/, '')
  if (
    /^(?:block|inline-block|inline|flex|inline-flex|grid|inline-grid|inline-table|table|table-caption|table-cell|table-column|table-column-group|table-footer-group|table-header-group|table-row-group|table-row|flow-root|contents|list-item|hidden)$/.test(
      utility,
    )
  ) {
    return ['display']
  }
  if (
    /^(?:static|fixed|absolute|relative|sticky|inset-|top-|right-|bottom-|left-|start-|end-)/.test(
      utility,
    )
  ) {
    return ['position']
  }
  if (/^size-/.test(utility)) return ['width', 'height']
  if (/^w-/.test(utility)) return ['width']
  if (/^min-w-/.test(utility)) return ['min-width']
  if (/^max-w-/.test(utility)) return ['max-width']
  if (/^h-/.test(utility)) return ['height']
  if (/^min-h-/.test(utility)) return ['min-height']
  if (/^max-h-/.test(utility)) return ['max-height']
  if (/^p-/.test(utility)) return ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']
  if (/^px-/.test(utility)) return ['padding-left', 'padding-right']
  if (/^py-/.test(utility)) return ['padding-top', 'padding-bottom']
  if (/^(?:pt)-/.test(utility)) return ['padding-top']
  if (/^(?:pr|pe)-/.test(utility)) return ['padding-right']
  if (/^(?:pb)-/.test(utility)) return ['padding-bottom']
  if (/^(?:pl|ps)-/.test(utility)) return ['padding-left']
  if (/^m-/.test(utility)) return ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']
  if (/^mx-/.test(utility)) return ['margin-left', 'margin-right']
  if (/^my-/.test(utility)) return ['margin-top', 'margin-bottom']
  if (/^mt-/.test(utility)) return ['margin-top']
  if (/^(?:mr|me)-/.test(utility)) return ['margin-right']
  if (/^mb-/.test(utility)) return ['margin-bottom']
  if (/^(?:ml|ms)-/.test(utility)) return ['margin-left']
  if (/^gap-x-/.test(utility)) return ['column-gap']
  if (/^gap-y-/.test(utility)) return ['row-gap']
  if (/^gap-/.test(utility)) return ['row-gap', 'column-gap']
  if (/^flex-(?:row|col)(?:-reverse)?$/.test(utility)) return ['flex-direction']
  if (utility === 'flex-1' || utility === 'flex-auto') {
    return ['flex-grow', 'flex-shrink', 'flex-basis']
  }
  if (utility === 'flex-none' || utility === 'flex-initial') {
    return ['flex-grow', 'flex-shrink']
  }
  if (/^grow(?:$|-)/.test(utility)) return ['flex-grow']
  if (/^shrink(?:$|-)/.test(utility)) return ['flex-shrink']
  if (/^basis-/.test(utility)) return ['flex-basis']
  if (/^items-/.test(utility)) return ['align-items']
  if (/^self-/.test(utility)) return ['align-self']
  if (/^content-/.test(utility)) return ['align-content']
  if (/^justify-items-/.test(utility)) return ['justify-items']
  if (/^justify-self-/.test(utility)) return ['justify-self']
  if (/^justify-/.test(utility)) return ['justify-content']
  if (/^place-items-/.test(utility)) return ['align-items', 'justify-items']
  if (/^place-content-/.test(utility)) return ['align-content', 'justify-content']
  if (/^grid-cols-/.test(utility)) return ['grid-template-columns']
  if (/^grid-rows-/.test(utility)) return ['grid-template-rows']
  if (/^col-/.test(utility)) return ['grid-column']
  if (/^row-/.test(utility)) return ['grid-row']
  if (/^order-/.test(utility)) return ['order']
  if (/^type-/.test(utility)) return ['font-family', 'font-size', 'line-height', 'letter-spacing']
  if (/^weight-/.test(utility)) return ['font-weight']
  if (utility === 'font-sans' || utility === 'font-mono' || utility === 'font-serif') {
    return ['font-family']
  }
  if (
    /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/.test(utility)
  ) {
    return ['font-weight']
  }
  if (/^text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|[1-9]|code)$/.test(utility)) {
    return ['font-size', 'line-height']
  }
  if (/^text-(?:left|center|right|justify|start|end)$/.test(utility)) return ['text-align']
  if (utility === 'text-ellipsis' || utility === 'text-clip') return ['text-overflow']
  if (utility === 'truncate') return ['overflow-x', 'overflow-y', 'text-overflow', 'white-space']
  if (/^leading-/.test(utility)) return ['line-height']
  if (/^tracking-/.test(utility)) return ['letter-spacing']
  if (/^whitespace-/.test(utility)) return ['white-space']
  if (/^break-/.test(utility)) return ['word-break', 'overflow-wrap']
  if (utility === 'wrap-anywhere' || utility === 'wrap-break-word') return ['overflow-wrap']
  if (utility === 'tabular-nums') return ['font-variant-numeric']
  if (/^(?:underline|overline|line-through|no-underline)$/.test(utility)) return ['text-decoration']
  if (/^(?:uppercase|lowercase|capitalize|normal-case)$/.test(utility)) return ['text-transform']
  if (utility.startsWith('text-[')) {
    const bracket = utility.slice(6, -1)
    if (/^(?:length:|[\d.]+(?:px|rem|em|%))|--cpx-sys-font-size-/.test(bracket)) {
      return ['font-size']
    }
    return ['color']
  }
  if (utility.startsWith('text-')) return ['color']
  if (utility.startsWith('bg-')) return ['background']
  if (utility === 'rounded' || utility.startsWith('rounded-')) return ['radius']
  if (utility.startsWith('border-t')) return ['border-top']
  if (utility.startsWith('border-r') || utility.startsWith('border-e')) return ['border-right']
  if (utility.startsWith('border-b')) return ['border-bottom']
  if (utility.startsWith('border-l') || utility.startsWith('border-s')) return ['border-left']
  if (
    utility === 'border' ||
    (utility.startsWith('border-') && !utility.startsWith('border-spacing'))
  ) {
    return ['border-top', 'border-right', 'border-bottom', 'border-left']
  }
  if (utility.startsWith('overflow-x-')) return ['overflow-x']
  if (utility.startsWith('overflow-y-')) return ['overflow-y']
  if (utility.startsWith('overflow-')) return ['overflow-x', 'overflow-y']
  if (utility.startsWith('overscroll-')) return ['overscroll-behavior']
  if (utility.startsWith('z-')) return ['z-index']
  if (utility.startsWith('opacity-')) return ['opacity']
  if (
    utility === 'transition' ||
    /^(?:transition-|duration-|ease-|delay-|animate-)/.test(utility)
  ) {
    return ['transition']
  }
  if (/^cursor-/.test(utility)) return ['cursor']
  if (/^pointer-events-/.test(utility)) return ['pointer-events']
  if (/^select-/.test(utility)) return ['user-select']
  if (/^touch-/.test(utility)) return ['touch-action']
  if (/^resize(?:$|-)/.test(utility)) return ['resize']
  if (/^appearance-/.test(utility)) return ['appearance']
  return []
}

function parseTailwindToken(
  rawToken: string,
): { stateVariant: string | null; categories: CssPropertyCategory[] } | null {
  if (!rawToken.startsWith('tw:')) return null
  const segments = splitTopLevelColons(rawToken.slice(3))
  const utility = segments[segments.length - 1]
  if (!utility) return null
  const variants = segments.slice(0, -1)
  if (variants.length === 0) {
    const categories = tailwindUtilityCategories(utility)
    return categories.length > 0 ? { stateVariant: null, categories } : null
  }
  if (variants.length === 1 && statePseudoClasses.has(variants[0])) {
    const categories = tailwindUtilityCategories(utility)
    return categories.length > 0 ? { stateVariant: variants[0], categories } : null
  }
  return null
}

function splitClassWhitespace(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean)
}

function combineTokenBranches(left: string[][], right: string[][]): string[][] {
  const maxBranches = 16
  if (left.length * right.length <= maxBranches) {
    const combined: string[][] = []
    for (const leftBranch of left) {
      for (const rightBranch of right) {
        combined.push([...leftBranch, ...rightBranch])
      }
    }
    return combined
  }
  const mergedLeft = [...new Set(left.flat())]
  const mergedRight = [...new Set(right.flat())]
  return [[...mergedLeft, ...mergedRight]]
}

function collectClassBranches(
  expression: ts.Expression,
  variableInitializers: Map<string, ts.Expression>,
  visited: Set<ts.Node>,
): string[][] {
  const current = unwrapInlineStyleExpression(expression)
  if (visited.has(current)) return [[]]
  const nextVisited = new Set(visited)
  nextVisited.add(current)

  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return [splitClassWhitespace(current.text)]
  }
  if (ts.isIdentifier(current)) {
    const initializer = variableInitializers.get(current.text)
    return initializer ? collectClassBranches(initializer, variableInitializers, nextVisited) : [[]]
  }
  if (ts.isConditionalExpression(current)) {
    return [
      ...collectClassBranches(current.whenTrue, variableInitializers, nextVisited),
      ...collectClassBranches(current.whenFalse, variableInitializers, nextVisited),
    ]
  }
  if (ts.isBinaryExpression(current)) {
    const kind = current.operatorToken.kind
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return collectClassBranches(current.right, variableInitializers, nextVisited)
    }
    if (kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) {
      return [
        ...collectClassBranches(current.left, variableInitializers, nextVisited),
        ...collectClassBranches(current.right, variableInitializers, nextVisited),
      ]
    }
    if (kind === ts.SyntaxKind.PlusToken) {
      return combineTokenBranches(
        collectClassBranches(current.left, variableInitializers, nextVisited),
        collectClassBranches(current.right, variableInitializers, nextVisited),
      )
    }
    return [[]]
  }
  if (ts.isTemplateExpression(current)) {
    let branches: string[][] = [splitClassWhitespace(current.head.text)]
    for (const span of current.templateSpans) {
      const exprBranches = collectClassBranches(span.expression, variableInitializers, nextVisited)
      branches = combineTokenBranches(branches, exprBranches)
      branches = combineTokenBranches(branches, [splitClassWhitespace(span.literal.text)])
    }
    return branches
  }
  if (ts.isArrayLiteralExpression(current)) {
    let branches: string[][] = [[]]
    for (const element of current.elements) {
      if (ts.isSpreadElement(element)) continue
      branches = combineTokenBranches(
        branches,
        collectClassBranches(element, variableInitializers, nextVisited),
      )
    }
    return branches
  }
  if (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    classTokenHelperNames.has(current.expression.text)
  ) {
    let branches: string[][] = [[]]
    for (const arg of current.arguments) {
      if (ts.isSpreadElement(arg)) continue
      branches = combineTokenBranches(
        branches,
        collectClassBranches(arg, variableInitializers, nextVisited),
      )
    }
    return branches
  }
  return [[]]
}

const stage4CssFiles = styleFiles.filter(
  (file) =>
    extname(file) === '.css' &&
    file !== entrypoint &&
    workspacePath(file) !== 'src/styles/tailwind.css',
)

const definedCssClassLocations = new Map<string, Set<string>>()
const multiFileClassTargets = new Map<string, Set<string>>()
const classCssProfiles = new Map<string, CssSelectorRuleProfile[]>()

for (const file of stage4CssFiles) {
  const source = await readFile(file, 'utf8')
  const path = workspacePath(file)
  let root: ReturnType<typeof postcss.parse>
  try {
    root = postcss.parse(source, { from: file })
  } catch (error) {
    errors.push(
      `[style-contracts] CSS parse error in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
    continue
  }
  root.walkRules((rule) => {
    if (isRuleInsideAtRule(rule, /^(?:-\w+-)?keyframes$/i)) return
    const effectiveSelector = resolveEffectiveSelector(rule)
    const line = rule.source?.start?.line ?? 1
    const location = `${path}:${line}`

    const allSelector = extractSelectorClasses(effectiveSelector, 'all')
    for (const className of allSelector.classes) {
      const locations = definedCssClassLocations.get(className) ?? new Set<string>()
      locations.add(location)
      definedCssClassLocations.set(className, locations)
    }

    const hasDeclaration = rule.nodes?.some((node) => node.type === 'decl') ?? false
    if (!hasDeclaration) return

    const subjectAll = extractSelectorClasses(effectiveSelector, 'subject-all')
    for (const className of subjectAll.classes) {
      const files = multiFileClassTargets.get(className) ?? new Set<string>()
      files.add(path)
      multiFileClassTargets.set(className, files)
    }

    if (isRuleInsideAtRule(rule, /^layer$/i, 'overrides')) return
    if (isRuleInsideAtRule(rule, /^media$/i, '(forced-colors:')) return
    let inForcedColors = false
    let ancestor: PostcssContainer | PostcssDocument | undefined = rule.parent
    while (ancestor) {
      if (
        ancestor.type === 'atrule' &&
        /^media$/i.test((ancestor as PostcssAtRule).name) &&
        /forced-colors\s*:/i.test((ancestor as PostcssAtRule).params)
      ) {
        inForcedColors = true
        break
      }
      ancestor = ancestor.parent
    }
    if (inForcedColors) return

    const categories = new Set<CssPropertyCategory>()
    rule.each((node) => {
      if (node.type !== 'decl') return
      for (const category of cssPropertyToCategories(node.prop)) categories.add(category)
    })
    if (categories.size === 0) return

    for (const variant of extractSelectorSubjectRules(effectiveSelector)) {
      for (const className of variant.requiredClasses) {
        if (isPureStateClass(className)) continue
        const entries = classCssProfiles.get(className) ?? []
        entries.push({
          requiredClasses: variant.requiredClasses,
          excludedClasses: variant.excludedClasses,
          pseudoStates: variant.pseudoStates,
          categories,
        })
        classCssProfiles.set(className, entries)
      }
    }
  })
}

const scriptAsts = new Map<string, { sourceFile: ts.SourceFile; path: string }>()
const referencedScriptTokens = new Set<string>()
const dynamicModifierPrefixes = new Set<string>()
const dynamicTemplateSuffixes = new Set<string>()

function collectStringTextTokens(text: string): void {
  for (const match of text.matchAll(/[A-Za-z_][\w-]*/g)) {
    referencedScriptTokens.add(match[0])
  }
  const trailingPrefix = text.match(/([A-Za-z_][\w-]*--)$/)
  if (trailingPrefix) dynamicModifierPrefixes.add(trailingPrefix[1])
}

for (const file of scriptFiles) {
  const source = await readFile(file, 'utf8')
  const path = workspacePath(file)
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    extname(path).toLowerCase() === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  scriptAsts.set(file, { sourceFile, path })

  const collectReferences = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      collectStringTextTokens(node.text)
    } else if (ts.isTemplateHead(node)) {
      collectStringTextTokens(node.text)
    } else if (ts.isTemplateMiddle(node)) {
      collectStringTextTokens(node.text)
      const suffixMatch = node.text.match(/^(-[A-Za-z0-9_-]+)/)
      if (suffixMatch) dynamicTemplateSuffixes.add(suffixMatch[1])
    } else if (ts.isTemplateTail(node)) {
      collectStringTextTokens(node.text)
      const suffixMatch = node.text.match(/^(-[A-Za-z0-9_-]+)/)
      if (suffixMatch) dynamicTemplateSuffixes.add(suffixMatch[1])
    }
    ts.forEachChild(node, collectReferences)
  }
  collectReferences(sourceFile)
}

function isClassReferencedInScripts(className: string): boolean {
  if (referencedScriptTokens.has(className)) return true
  const bemIndex = className.indexOf('--')
  if (bemIndex > 0) {
    const prefix = className.slice(0, bemIndex + 2)
    if (dynamicModifierPrefixes.has(prefix)) return true
  }
  for (const suffix of dynamicTemplateSuffixes) {
    if (className.endsWith(suffix) && className.length > suffix.length) {
      const stem = className.slice(0, -suffix.length)
      if (referencedScriptTokens.has(stem)) return true
    }
  }
  return false
}

// Gate 1: Dead CSS selector check
const deadSelectorAllowlistConfigured = manifest.deadSelectorAllowlist !== undefined
const deadSelectorAllowlist = new Set(manifest.deadSelectorAllowlist ?? [])
let deadSelectorCount = 0
for (const [className, locations] of [...definedCssClassLocations.entries()].sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  if (isClassReferencedInScripts(className)) continue
  if (deadSelectorAllowlist.has(className)) continue
  if (vendorClassPattern.test(className)) continue
  deadSelectorCount += 1
  errors.push(
    `[dead-css-selector] .${className} is never referenced in src/**/*.{ts,tsx} (${[...locations].sort().join(', ')})`,
  )
}
if (deadSelectorAllowlistConfigured) {
  for (const allowedClass of [...deadSelectorAllowlist].sort()) {
    if (!definedCssClassLocations.has(allowedClass) || isClassReferencedInScripts(allowedClass)) {
      errors.push(`[dead-css-selector] stale deadSelectorAllowlist entry: ${allowedClass}`)
    }
  }
}

// Gate 2: Multi-file CSS class definition ratchet
const multiFileAllowlistConfigured = manifest.multiFileClassAllowlist !== undefined
const multiFileAllowlist = manifest.multiFileClassAllowlist ?? {}
let multiFileClassCount = 0
for (const [className, fileSet] of [...multiFileClassTargets.entries()].sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  if (fileSet.size <= 1) continue
  if (isPureStateClass(className) || vendorClassPattern.test(className)) continue
  multiFileClassCount += 1
  const observedFiles = [...fileSet].sort()
  const allowedEntries = multiFileAllowlist[className]
  if (allowedEntries !== undefined) {
    const allowedSet = new Set(allowedEntries.map(normalizeFeatureTokenFile))
    for (const file of observedFiles) {
      if (!allowedSet.has(file)) {
        errors.push(
          `[multi-file-class] .${className} is targeted with declarations in non-allowlisted CSS file ${file} (allowlisted: ${[...allowedSet].sort().join(', ')})`,
        )
      }
    }
    for (const allowedFile of [...allowedSet].sort()) {
      if (!fileSet.has(allowedFile)) {
        errors.push(
          `[multi-file-class] stale multiFileClassAllowlist file for .${className}: ${allowedFile}`,
        )
      }
    }
  } else {
    errors.push(
      `[multi-file-class] .${className} is targeted with declarations across ${observedFiles.length} CSS files: ${observedFiles.join(', ')}`,
    )
  }
}
if (multiFileAllowlistConfigured) {
  for (const className of Object.keys(multiFileAllowlist).sort()) {
    const observed = multiFileClassTargets.get(className)
    if (!observed || observed.size <= 1) {
      errors.push(`[multi-file-class] stale multiFileClassAllowlist entry: ${className}`)
    }
  }
}

// Gate 3: Same-element CSS vs Tailwind (tw:*) property-category collision check
const observedCollisions: CssTailwindCollisionRecord[] = []
const seenCollisionKeys = new Set<string>()

function recordBranchCollisions(path: string, line: number, branches: string[][]): void {
  for (const branch of branches) {
    const branchSet = new Set(branch)
    const cssClasses = branch.filter(
      (token) => !token.startsWith('tw:') && classCssProfiles.has(token),
    )
    const twTokens = branch.filter((token) => token.startsWith('tw:'))
    if (cssClasses.length === 0 || twTokens.length === 0) continue

    for (const cssClass of cssClasses) {
      const ruleProfiles = classCssProfiles.get(cssClass)
      if (!ruleProfiles) continue
      for (const rule of ruleProfiles) {
        if (!rule.requiredClasses.every((requiredClass) => branchSet.has(requiredClass))) continue
        if (rule.excludedClasses.some((excludedClass) => branchSet.has(excludedClass))) continue
        for (const twClass of twTokens) {
          const parsed = parseTailwindToken(twClass)
          if (!parsed) continue
          const matchesState =
            parsed.stateVariant === null
              ? rule.pseudoStates.size === 0
              : rule.pseudoStates.has(parsed.stateVariant)
          if (!matchesState) continue
          for (const category of parsed.categories) {
            if (!rule.categories.has(category)) continue
            const key = `${path}:${line}:${cssClass}:${twClass}:${category}`
            if (seenCollisionKeys.has(key)) continue
            seenCollisionKeys.add(key)
            observedCollisions.push({ file: path, line, cssClass, twClass, category })
          }
        }
      }
    }
  }
}

for (const { sourceFile, path } of scriptAsts.values()) {
  if (!sourceFile.text.includes('tw:')) continue
  const variableInitializers = new Map<string, ts.Expression>()
  const collectVariableInitializers = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variableInitializers.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, collectVariableInitializers)
  }
  collectVariableInitializers(sourceFile)

  const coveredNodes = new Set<ts.Node>()
  const markSubtreeCovered = (node: ts.Node): void => {
    coveredNodes.add(node)
    ts.forEachChild(node, markSubtreeCovered)
  }

  const visitClassExpressions = (node: ts.Node): void => {
    if (coveredNodes.has(node)) return

    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      /className$/i.test(node.name.text) &&
      node.initializer
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      if (ts.isStringLiteral(node.initializer)) {
        recordBranchCollisions(path, line, [splitClassWhitespace(node.initializer.text)])
        markSubtreeCovered(node.initializer)
        return
      }
      if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        const branches = collectClassBranches(
          node.initializer.expression,
          variableInitializers,
          new Set(),
        )
        recordBranchCollisions(path, line, branches)
        markSubtreeCovered(node.initializer)
        return
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      classTokenHelperNames.has(node.expression.text)
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const branches = collectClassBranches(node, variableInitializers, new Set())
      recordBranchCollisions(path, line, branches)
      markSubtreeCovered(node)
      return
    }

    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.includes('tw:')
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      recordBranchCollisions(path, line, [splitClassWhitespace(node.text)])
      coveredNodes.add(node)
      return
    }

    if (ts.isTemplateExpression(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const branches = collectClassBranches(node, variableInitializers, new Set())
      if (branches.some((branch) => branch.some((token) => token.startsWith('tw:')))) {
        recordBranchCollisions(path, line, branches)
        markSubtreeCovered(node)
        return
      }
    }

    ts.forEachChild(node, visitClassExpressions)
  }
  visitClassExpressions(sourceFile)
}

const collisionExceptions = (manifest.cssTailwindCollisionExceptions ?? []).map((exception) => {
  const normalizedFile = normalizeFeatureTokenFile(exception.file)
  const descriptor = `${normalizedFile} -> ${exception.cssClass ?? '*'} vs ${exception.twClass ?? '*'}`
  if (exception.reason.trim().length < 16) {
    errors.push(`[css-tw-collision] exception needs a concrete reason: ${descriptor}`)
  }
  return {
    file: normalizedFile,
    cssClass: exception.cssClass?.trim(),
    twClass: exception.twClass?.trim(),
    category: exception.category?.trim(),
    descriptor,
    used: false,
  }
})

const unexemptedCollisions: CssTailwindCollisionRecord[] = []
for (const collision of observedCollisions) {
  const matched = collisionExceptions.find(
    (exception) =>
      exception.file === collision.file &&
      (exception.cssClass === undefined || exception.cssClass === collision.cssClass) &&
      (exception.twClass === undefined || exception.twClass === collision.twClass) &&
      (exception.category === undefined || exception.category === collision.category),
  )
  if (matched) {
    matched.used = true
  } else {
    unexemptedCollisions.push(collision)
  }
}

for (const exception of collisionExceptions) {
  if (!exception.used) {
    errors.push(
      `[css-tw-collision] stale cssTailwindCollisionExceptions entry: ${exception.descriptor}`,
    )
  }
}

if (manifest.cssTailwindCollisionAllowlist !== undefined) {
  const observedCounts: Record<string, number> = {}
  for (const collision of unexemptedCollisions) {
    observedCounts[collision.file] = (observedCounts[collision.file] ?? 0) + 1
  }
  const allCollisionFiles = new Set([
    ...Object.keys(manifest.cssTailwindCollisionAllowlist).map(normalizeFeatureTokenFile),
    ...Object.keys(observedCounts),
  ])
  for (const file of [...allCollisionFiles].sort()) {
    const expected = manifest.cssTailwindCollisionAllowlist[file] ?? 0
    const observed = observedCounts[file] ?? 0
    if (observed > expected) {
      const fileHits = unexemptedCollisions.filter((hit) => hit.file === file)
      for (const hit of fileHits) {
        errors.push(
          `[css-tw-collision] ${hit.file}:${hit.line} ${hit.cssClass} conflicts with ${hit.twClass} on "${hit.category}"`,
        )
      }
      errors.push(
        `[css-tw-collision] collision count exceeded in ${file}: expected ${expected}, observed ${observed}`,
      )
    } else if (observed < expected) {
      errors.push(
        `[css-tw-collision] stale cssTailwindCollisionAllowlist count in ${file}: expected ${expected}, observed ${observed}`,
      )
    }
  }
} else {
  for (const hit of unexemptedCollisions) {
    errors.push(
      `[css-tw-collision] ${hit.file}:${hit.line} ${hit.cssClass} conflicts with ${hit.twClass} on "${hit.category}"`,
    )
  }
}

if (errors.length > 0) {
  console.error('[style-contracts] failed')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(
  `[style-contracts] ok: ${styleFiles.length} style files, ${customPropertyReferences.size} custom property references, ${Object.values(observedImportantDeclarations).reduce((sum, count) => sum + count, 0)} allowlisted !important declarations, ${Object.values(observedDataThemeSelectors).reduce((sum, count) => sum + count, 0)} data-theme selectors, ${Object.values(observedLiteralLineHeights).reduce((sum, count) => sum + count, 0)} allowlisted literal line-heights, ${Object.values(observedTailwindLeading).reduce((sum, count) => sum + count, 0)} allowlisted tw:leading-*, ${featureTokenStyleDeclarations.size} feature style files scanned, ${featureTokenScriptSources.size} feature script files scanned, ${deadSelectorCount} dead selectors, ${multiFileClassCount} multi-file classes, ${unexemptedCollisions.length} css-tw collisions`,
)
