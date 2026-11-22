import { readdir, readFile } from 'node:fs/promises'
import { basename, join, posix, relative } from 'node:path'
import ts from 'typescript'

/**
 * Persisted ratchet manifest for static architectural contracts.
 */
export interface ArchContractManifest {
  /** Per-file baseline count of non-external deprecated brand references. */
  deprecatedBrandRatchet: Record<string, number>
  /** Per-file baseline count of raw useEffect calls/imports in renderer source. */
  useEffectRatchet: Record<string, number>
  /** Per-file baseline count of ordinary (non-exempt) comments. */
  commentRatchet: Record<string, number>
  /** Per-file baseline count of bare suppression comments and TODO/FIXME/HACK markers. */
  bannedCommentRatchet: Record<string, number>
}

/**
 * Category of an architectural contract violation.
 */
export type ContractViolationCategory =
  'boundary' | 'banned-pattern' | 'use-effect-ratchet' | 'comment-discipline'

/**
 * Single enforceable static contract violation with source coordinates.
 */
export interface ContractViolation {
  category: ContractViolationCategory
  rule: string
  file: string
  line: number
  column: number
  message: string
}

/**
 * Non-fatal ratchet shrink suggestion when current usage drops below baseline.
 */
export interface ContractNotice {
  category: 'banned-pattern' | 'use-effect-ratchet' | 'comment-discipline'
  file: string
  baseline: number
  actual: number
  message: string
}

/**
 * Aggregated static analysis report returned by {@link evaluateArchContracts}.
 */
export interface ArchContractReport {
  violations: ContractViolation[]
  notices: ContractNotice[]
  computedManifest: ArchContractManifest
  stats: {
    filesScanned: number
    useEffectFiles: number
    useEffectTotal: number
    commentFiles: number
    ordinaryCommentsTotal: number
    bannedCommentsTotal: number
  }
}

/**
 * Options for evaluating architectural contracts against a repository root.
 */
export interface EvaluateArchContractsOptions {
  rootDir: string
  manifest?: ArchContractManifest
}

interface ExtractedSpecifier {
  specifier: string
  pos: number
}

interface ExtractedComment {
  text: string
  pos: number
  end: number
  kind: ts.SyntaxKind.SingleLineCommentTrivia | ts.SyntaxKind.MultiLineCommentTrivia
}

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'release', '.git', '.tools'])
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const COMMENT_DISCIPLINE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

const NODE_BUILTIN_MODULES = new Set([
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
])

const V3_PROTOCOL_PATTERN =
  /(?:\bthread-rpc-v3\b|\brpc[-_]?v3\b|\bprotocol[-_]?v3\b|(?:\b|(?<=[a-z]))v3[-_]?(?:dispatcher|adapter|migration|protocol)\b)/i

const ALLOWED_EXTERNAL_BRAND_PATTERNS = [
  /codepilotx-dev\/Pidex(?:-Plugins)?/gi,
  /['"]codepilotx-dev['"]/gi,
  /auth-staging\.codepilotx\.top/gi,
  /codepilotx-auth-broker-staging/gi,
]

const DEPRECATED_BRAND_PATTERN = /codepilotx/gi

const SUPPRESSION_DIRECTIVE_PATTERN = /\b(?:oxlint|eslint)-disable(?:-next-line|-line)?\b/
const TODO_MARKER_PATTERN = /\b(?:TODO|FIXME|HACK)\b/

type SourceZone = 'electron' | 'renderer-src' | 'agent' | 'packages' | 'scripts' | 'other'
type TargetZone =
  | 'electron'
  | 'renderer-src'
  | 'renderer-shared'
  | 'desktop-other'
  | 'agent'
  | 'apps-other'
  | 'packages'
  | 'external'

function toPosixRelative(rootDir: string, fullPath: string): string {
  return relative(rootDir, fullPath).replaceAll('\\', '/')
}

function getExtension(filePath: string): string {
  const base = basename(filePath)
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  const ext = getExtension(filePath)
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    default:
      return ts.ScriptKind.TS
  }
}

function getLineAndCol(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
  const lc = sourceFile.getLineAndCharacterOfPosition(pos)
  return { line: lc.line + 1, column: lc.character + 1 }
}

async function collectFiles(rootDir: string): Promise<string[]> {
  const collected: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue
        await walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        collected.push(join(dir, entry.name))
      }
    }
  }

  await walk(join(rootDir, 'apps'))
  await walk(join(rootDir, 'packages'))
  await walk(join(rootDir, 'scripts'))
  return collected
}

function classifySourceZone(relPath: string): SourceZone {
  if (relPath.startsWith('apps/desktop/electron/')) return 'electron'
  if (relPath.startsWith('apps/desktop/renderer/src/')) return 'renderer-src'
  if (relPath.startsWith('apps/agent/')) return 'agent'
  if (relPath.startsWith('packages/')) return 'packages'
  if (relPath.startsWith('scripts/')) return 'scripts'
  return 'other'
}

function classifyRepoTargetPath(repoPath: string): TargetZone {
  if (repoPath.startsWith('apps/desktop/electron/') || repoPath === 'apps/desktop/electron') {
    return 'electron'
  }
  if (
    repoPath.startsWith('apps/desktop/renderer/src/') ||
    repoPath === 'apps/desktop/renderer/src'
  ) {
    return 'renderer-src'
  }
  if (
    repoPath.startsWith('apps/desktop/renderer/shared/') ||
    repoPath === 'apps/desktop/renderer/shared'
  ) {
    return 'renderer-shared'
  }
  if (repoPath.startsWith('apps/desktop/')) return 'desktop-other'
  if (repoPath.startsWith('apps/agent/') || repoPath === 'apps/agent') return 'agent'
  if (repoPath.startsWith('apps/')) return 'apps-other'
  if (repoPath.startsWith('packages/')) return 'packages'
  return 'external'
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || NODE_BUILTIN_MODULES.has(specifier)
}

function isElectronModule(specifier: string): boolean {
  return specifier === 'electron' || specifier.startsWith('electron/')
}

function isReactModule(specifier: string): boolean {
  return (
    specifier === 'react' ||
    specifier.startsWith('react/') ||
    specifier === 'react-dom' ||
    specifier.startsWith('react-dom/')
  )
}

function resolveTargetZone(fromRelPath: string, specifier: string): TargetZone {
  if (specifier.startsWith('.')) {
    const resolved = posix.normalize(posix.join(posix.dirname(fromRelPath), specifier))
    return classifyRepoTargetPath(resolved)
  }
  if (specifier === '@pidex/agent' || specifier.startsWith('@pidex/agent/')) return 'agent'
  if (
    specifier === '@pidex/desktop' ||
    specifier === '@pidex/desktop-electron' ||
    specifier.startsWith('@pidex/desktop-electron/')
  ) {
    return 'electron'
  }
  if (specifier === '@pidex/renderer' || specifier.startsWith('@pidex/renderer/')) {
    return 'renderer-src'
  }
  if (specifier === '@pidex/auth-broker' || specifier.startsWith('@pidex/auth-broker/')) {
    return 'apps-other'
  }
  if (specifier.startsWith('apps/')) return classifyRepoTargetPath(specifier)
  if (specifier.includes('/apps/desktop/electron/')) return 'electron'
  if (specifier.includes('/apps/desktop/renderer/src/')) return 'renderer-src'
  if (specifier.includes('/apps/desktop/renderer/shared/')) return 'renderer-shared'
  if (specifier.includes('/apps/agent/')) return 'agent'
  if (specifier.includes('/apps/desktop/')) return 'desktop-other'
  if (specifier.includes('/apps/')) return 'apps-other'
  return 'external'
}

/**
 * Extracts all static, dynamic, CommonJS, and type-level module specifiers from a TS AST.
 */
export function extractImportSpecifiers(sourceFile: ts.SourceFile): ExtractedSpecifier[] {
  const specifiers: ExtractedSpecifier[] = []

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push({
        specifier: node.moduleSpecifier.text,
        pos: node.moduleSpecifier.getStart(sourceFile),
      })
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push({
        specifier: node.moduleSpecifier.text,
        pos: node.moduleSpecifier.getStart(sourceFile),
      })
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push({
        specifier: node.moduleReference.expression.text,
        pos: node.moduleReference.expression.getStart(sourceFile),
      })
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const firstArg = node.arguments[0]
      if (ts.isStringLiteral(firstArg)) {
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        ) {
          specifiers.push({
            specifier: firstArg.text,
            pos: firstArg.getStart(sourceFile),
          })
        }
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push({
        specifier: node.argument.literal.text,
        pos: node.argument.literal.getStart(sourceFile),
      })
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

function isNodeModulesPuncture(specifier: string): boolean {
  const normalized = specifier.replaceAll('\\', '/')
  return normalized.startsWith('node_modules/') || normalized.includes('/node_modules/')
}

/**
 * Evaluates workspace & process boundary isolation rules for a single source file.
 */
export function checkBoundaryImports(
  relPath: string,
  sourceFile: ts.SourceFile,
): ContractViolation[] {
  const sourceZone = classifySourceZone(relPath)
  if (sourceZone === 'other') return []

  const violations: ContractViolation[] = []
  const imports = extractImportSpecifiers(sourceFile)

  for (const { specifier, pos } of imports) {
    const targetZone = resolveTargetZone(relPath, specifier)
    const { line, column } = getLineAndCol(sourceFile, pos)

    if (isNodeModulesPuncture(specifier)) {
      violations.push({
        category: 'boundary',
        rule: 'boundary/no-node-modules-puncture',
        file: relPath,
        line,
        column,
        message: `Direct node_modules path puncture ("${specifier}") is forbidden; expose a workspace helper or declared dependency instead.`,
      })
      continue
    }

    if (sourceZone === 'electron' && targetZone === 'renderer-src') {
      violations.push({
        category: 'boundary',
        rule: 'boundary/electron-no-renderer-src',
        file: relPath,
        line,
        column,
        message: `Electron must not import from apps/desktop/renderer/src ("${specifier}"); only apps/desktop/renderer/shared or @pidex/* packages are allowed.`,
      })
    } else if (sourceZone === 'renderer-src') {
      if (
        targetZone === 'electron' ||
        targetZone === 'agent' ||
        isNodeBuiltin(specifier) ||
        isElectronModule(specifier)
      ) {
        violations.push({
          category: 'boundary',
          rule: 'boundary/renderer-isolation',
          file: relPath,
          line,
          column,
          message: `Renderer source must not import "${specifier}" (Electron, Agent, and Node built-ins are forbidden).`,
        })
      }
    } else if (sourceZone === 'agent') {
      if (
        targetZone === 'electron' ||
        targetZone === 'renderer-src' ||
        targetZone === 'renderer-shared' ||
        targetZone === 'desktop-other' ||
        isElectronModule(specifier)
      ) {
        violations.push({
          category: 'boundary',
          rule: 'boundary/agent-no-desktop',
          file: relPath,
          line,
          column,
          message: `Agent must never import from apps/desktop/** or Electron ("${specifier}").`,
        })
      }
    } else if (sourceZone === 'packages') {
      if (
        targetZone === 'electron' ||
        targetZone === 'renderer-src' ||
        targetZone === 'renderer-shared' ||
        targetZone === 'desktop-other' ||
        targetZone === 'agent' ||
        targetZone === 'apps-other' ||
        isElectronModule(specifier) ||
        isReactModule(specifier)
      ) {
        violations.push({
          category: 'boundary',
          rule: 'boundary/packages-isolation',
          file: relPath,
          line,
          column,
          message: `Shared packages must never import apps/**, electron, react, or react-dom ("${specifier}").`,
        })
      }
    } else if (sourceZone === 'scripts' && targetZone === 'renderer-src') {
      violations.push({
        category: 'boundary',
        rule: 'boundary/scripts-no-renderer-src',
        file: relPath,
        line,
        column,
        message: `Scripts must not import browser renderer source ("${specifier}") directly; read source text or use shared contracts.`,
      })
    }
  }

  return violations
}

function isLocalStorageClearCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false
  if (node.expression.name.text !== 'clear') return false
  const target = node.expression.expression
  if (ts.isIdentifier(target) && target.text === 'localStorage') return true
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'localStorage') return true
  return false
}

function stripAllowedExternalBrandMatches(lineText: string): string {
  let scrubbed = lineText
  for (const pattern of ALLOWED_EXTERNAL_BRAND_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '')
  }
  return scrubbed
}

function isContractSelfDefinition(relPath: string): boolean {
  return (
    relPath === 'scripts/contracts/ArchContractsCore.ts' ||
    relPath === 'scripts/contracts/CheckArchContracts.test.ts'
  )
}

function checkBannedPatternsInCode(
  relPath: string,
  text: string,
  sourceFile: ts.SourceFile,
): {
  violations: ContractViolation[]
  deprecatedBrandCount: number
  deprecatedBrandLocations: Array<{ line: number; column: number }>
} {
  const violations: ContractViolation[] = []

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isLocalStorageClearCall(node)) {
      const { line, column } = getLineAndCol(sourceFile, node.getStart(sourceFile))
      violations.push({
        category: 'banned-pattern',
        rule: 'banned/no-localstorage-clear',
        file: relPath,
        line,
        column,
        message: 'localStorage.clear() is strictly forbidden; clear only scoped keys.',
      })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  if (isContractSelfDefinition(relPath)) {
    return {
      violations,
      deprecatedBrandCount: 0,
      deprecatedBrandLocations: [],
    }
  }

  const deprecatedBrandLocations: Array<{ line: number; column: number }> = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i]
    const v3Match = V3_PROTOCOL_PATTERN.exec(lineText)
    if (v3Match) {
      violations.push({
        category: 'banned-pattern',
        rule: 'banned/no-v3-protocol',
        file: relPath,
        line: i + 1,
        column: v3Match.index + 1,
        message: `Forbidden v3 protocol dispatcher/migration pattern "${v3Match[0]}" detected.`,
      })
    }

    const scrubbed = stripAllowedExternalBrandMatches(lineText)
    DEPRECATED_BRAND_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = DEPRECATED_BRAND_PATTERN.exec(scrubbed)) !== null) {
      deprecatedBrandLocations.push({ line: i + 1, column: match.index + 1 })
    }
  }

  return {
    violations,
    deprecatedBrandCount: deprecatedBrandLocations.length,
    deprecatedBrandLocations,
  }
}

function isRawUseEffectExempt(relPath: string): boolean {
  if (!relPath.startsWith('apps/desktop/renderer/src/')) return true
  if (
    relPath === 'apps/desktop/renderer/src/hooks/UseMountEffect.ts' ||
    relPath === 'apps/desktop/renderer/src/hooks/UseExternalSubscription.ts'
  ) {
    return true
  }
  const base = basename(relPath)
  if (base.includes('.test.') || base.includes('.spec.')) return true
  if (relPath.includes('/test/') || relPath.includes('/tests/')) return true
  return false
}

/**
 * Counts raw `useEffect` call expressions (and bare React `useEffect` imports) in a TS/TSX file.
 */
export function countRawUseEffect(sourceFile: ts.SourceFile): {
  count: number
  positions: number[]
} {
  const localUseEffectNames = new Set<string>(['useEffect'])
  let hasReactUseEffectImport = false
  let firstImportPos = -1
  const callPositions: number[] = []

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'react' &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const spec of node.importClause.namedBindings.elements) {
        const importedName = spec.propertyName ? spec.propertyName.text : spec.name.text
        if (importedName === 'useEffect') {
          hasReactUseEffectImport = true
          if (firstImportPos < 0) firstImportPos = spec.getStart(sourceFile)
          localUseEffectNames.add(spec.name.text)
        }
      }
    } else if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && localUseEffectNames.has(node.expression.text)) {
        callPositions.push(node.expression.getStart(sourceFile))
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'useEffect'
      ) {
        callPositions.push(node.expression.name.getStart(sourceFile))
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  if (callPositions.length > 0) {
    return { count: callPositions.length, positions: callPositions }
  }
  if (hasReactUseEffectImport && firstImportPos >= 0) {
    return { count: 1, positions: [firstImportPos] }
  }
  return { count: 0, positions: [] }
}

function isCommentDisciplineTarget(relPath: string): boolean {
  const ext = getExtension(relPath)
  if (!COMMENT_DISCIPLINE_EXTENSIONS.has(ext)) return false
  const base = basename(relPath)
  if (base.includes('.test.') || base.includes('.spec.')) return false
  const segments = relPath.split('/')
  if (segments.some((seg) => EXCLUDED_DIRS.has(seg))) return false
  if (relPath.startsWith('apps/') && segments.includes('scripts')) return false
  return true
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  const modifiers = ts.getModifiers(node)
  return Boolean(modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword))
}

function isPrivateOrProtected(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  const modifiers = ts.getModifiers(node)
  return Boolean(
    modifiers?.some(
      (mod) =>
        mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword,
    ),
  )
}

function collectExportedJsDocPositions(sourceFile: ts.SourceFile, text: string): Set<string> {
  const allowedKeys = new Set<string>()

  function recordLeadingJsDocs(node: ts.Node): void {
    const leading = ts.getLeadingCommentRanges(text, node.pos)
    if (!leading) return
    for (const range of leading) {
      const slice = text.slice(range.pos, range.end)
      if (slice.startsWith('/**') && !slice.startsWith('/***')) {
        allowedKeys.add(`${range.pos}:${range.end}`)
      }
    }
  }

  function visitExportedContainerMembers(container: ts.Node): void {
    if (ts.isInterfaceDeclaration(container)) {
      for (const member of container.members) {
        recordLeadingJsDocs(member)
      }
    } else if (ts.isClassDeclaration(container)) {
      for (const member of container.members) {
        if (!isPrivateOrProtected(member)) {
          recordLeadingJsDocs(member)
        }
      }
    } else if (ts.isTypeAliasDeclaration(container) && ts.isTypeLiteralNode(container.type)) {
      for (const member of container.type.members) {
        recordLeadingJsDocs(member)
      }
    }
  }

  for (const stmt of sourceFile.statements) {
    const isExported =
      hasExportModifier(stmt) || ts.isExportAssignment(stmt) || ts.isExportDeclaration(stmt)
    if (!isExported) continue
    recordLeadingJsDocs(stmt)
    visitExportedContainerMembers(stmt)
  }

  return allowedKeys
}

function extractAllComments(sourceFile: ts.SourceFile, text: string): ExtractedComment[] {
  const seen = new Set<string>()
  const comments: ExtractedComment[] = []

  function addRanges(ranges: ts.CommentRange[] | undefined): void {
    if (!ranges) return
    for (const range of ranges) {
      const key = `${range.pos}:${range.end}`
      if (seen.has(key)) continue
      seen.add(key)
      comments.push({
        text: text.slice(range.pos, range.end),
        pos: range.pos,
        end: range.end,
        kind: range.kind,
      })
    }
  }

  function walkNode(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.JsxText) return
    addRanges(ts.getLeadingCommentRanges(text, node.pos))
    addRanges(ts.getTrailingCommentRanges(text, node.end))
    for (const child of node.getChildren(sourceFile)) {
      walkNode(child)
    }
  }

  walkNode(sourceFile)
  comments.sort((a, b) => a.pos - b.pos)
  return comments
}

function isBareSuppressionOrMarker(commentText: string): string | null {
  const stripped = commentText.replace(/\*\/\s*$/, '')
  if (/@ts-ignore\b/.test(stripped)) {
    return 'bare @ts-ignore suppression is forbidden'
  }
  if (/@ts-nocheck\b/.test(stripped)) {
    return 'bare @ts-nocheck suppression is forbidden'
  }
  const expectErrorMatch = /@ts-expect-error\b(.*)$/m.exec(stripped)
  if (expectErrorMatch && expectErrorMatch[1].trim().length === 0) {
    return 'bare @ts-expect-error without reason text is forbidden'
  }
  const disableMatch = SUPPRESSION_DIRECTIVE_PATTERN.exec(stripped)
  if (disableMatch) {
    const afterDirective = stripped.slice(disableMatch.index + disableMatch[0].length)
    if (!/--\s*\S/.test(afterDirective)) {
      return `bare ${disableMatch[0]} suppression without "-- reason" is forbidden`
    }
  }
  const todoMatch = TODO_MARKER_PATTERN.exec(stripped)
  if (todoMatch) {
    return `${todoMatch[0]} comment marker is forbidden`
  }
  return null
}

function isAllowedUnlimitedComment(
  comment: ExtractedComment,
  line: number,
  exportedJsDocKeys: Set<string>,
): boolean {
  const raw = comment.text
  if (/^\/\/\/\s*<reference\b/i.test(raw)) return true
  if (
    line <= 15 &&
    (/\bCopyright\b/i.test(raw) ||
      /SPDX-License-Identifier:/i.test(raw) ||
      /Licensed under/i.test(raw))
  ) {
    return true
  }
  if (/^\/\/\s*(?:INVARIANT|SAFETY):\s*\S/.test(raw)) return true
  if (exportedJsDocKeys.has(`${comment.pos}:${comment.end}`)) return true
  return false
}

/**
 * Classifies all comments in a single TypeScript source file into allowed, ordinary, and banned buckets.
 */
export function classifyFileComments(
  sourceFile: ts.SourceFile,
  text: string,
): {
  ordinaryComments: Array<{ line: number; column: number; text: string }>
  bannedComments: Array<{ line: number; column: number; reason: string }>
} {
  const exportedJsDocKeys = collectExportedJsDocPositions(sourceFile, text)
  const allComments = extractAllComments(sourceFile, text)
  const ordinaryComments: Array<{ line: number; column: number; text: string }> = []
  const bannedComments: Array<{ line: number; column: number; reason: string }> = []

  for (const comment of allComments) {
    const { line, column } = getLineAndCol(sourceFile, comment.pos)
    const bannedReason = isBareSuppressionOrMarker(comment.text)
    if (bannedReason) {
      bannedComments.push({ line, column, reason: bannedReason })
      continue
    }
    if (isAllowedUnlimitedComment(comment, line, exportedJsDocKeys)) {
      continue
    }
    ordinaryComments.push({ line, column, text: comment.text })
  }

  return { ordinaryComments, bannedComments }
}

/**
 * Runs all Phase 1 static architectural checks across `apps/` and `packages/`.
 */
export async function evaluateArchContracts(
  options: EvaluateArchContractsOptions,
): Promise<ArchContractReport> {
  const { rootDir, manifest } = options
  const files = await collectFiles(rootDir)

  const violations: ContractViolation[] = []
  const notices: ContractNotice[] = []

  const computedManifest: ArchContractManifest = {
    deprecatedBrandRatchet: {},
    useEffectRatchet: {},
    commentRatchet: {},
    bannedCommentRatchet: {},
  }

  let filesScanned = 0
  let useEffectFiles = 0
  let useEffectTotal = 0
  let commentFiles = 0
  let ordinaryCommentsTotal = 0
  let bannedCommentsTotal = 0

  for (const fullPath of files) {
    const relPath = toPosixRelative(rootDir, fullPath)
    const base = basename(relPath)
    const ext = getExtension(relPath)

    if (base === 'package.json') {
      filesScanned += 1
      const text = await readFile(fullPath, 'utf8')
      const lines = text.split(/\r?\n/)
      const brandLocs: Array<{ line: number; column: number }> = []
      for (let i = 0; i < lines.length; i += 1) {
        const scrubbed = stripAllowedExternalBrandMatches(lines[i])
        DEPRECATED_BRAND_PATTERN.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = DEPRECATED_BRAND_PATTERN.exec(scrubbed)) !== null) {
          brandLocs.push({ line: i + 1, column: match.index + 1 })
        }
      }
      if (brandLocs.length > 0) {
        computedManifest.deprecatedBrandRatchet[relPath] = brandLocs.length
      }
      if (manifest) {
        const baseline = manifest.deprecatedBrandRatchet[relPath] ?? 0
        if (brandLocs.length > baseline) {
          for (const loc of brandLocs.slice(baseline)) {
            violations.push({
              category: 'banned-pattern',
              rule: 'banned/no-deprecated-brand',
              file: relPath,
              line: loc.line,
              column: loc.column,
              message: `Deprecated "codepilotx" brand identifier is forbidden (actual ${brandLocs.length} > baseline ${baseline}).`,
            })
          }
        } else if (brandLocs.length > 0 && brandLocs.length < baseline) {
          notices.push({
            category: 'banned-pattern',
            file: relPath,
            baseline,
            actual: brandLocs.length,
            message: `Deprecated brand count decreased (${baseline} -> ${brandLocs.length}); run --update-baseline to tighten ratchet.`,
          })
        }
      }
      continue
    }

    if (!CODE_EXTENSIONS.has(ext)) continue

    filesScanned += 1
    const text = await readFile(fullPath, 'utf8')
    const sourceFile = ts.createSourceFile(
      relPath,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(relPath),
    )

    violations.push(...checkBoundaryImports(relPath, sourceFile))

    const bannedResult = checkBannedPatternsInCode(relPath, text, sourceFile)
    violations.push(...bannedResult.violations)

    if (bannedResult.deprecatedBrandCount > 0) {
      computedManifest.deprecatedBrandRatchet[relPath] = bannedResult.deprecatedBrandCount
    }
    if (manifest) {
      const brandBaseline = manifest.deprecatedBrandRatchet[relPath] ?? 0
      if (bannedResult.deprecatedBrandCount > brandBaseline) {
        for (const loc of bannedResult.deprecatedBrandLocations.slice(brandBaseline)) {
          violations.push({
            category: 'banned-pattern',
            rule: 'banned/no-deprecated-brand',
            file: relPath,
            line: loc.line,
            column: loc.column,
            message: `Deprecated "codepilotx" brand identifier is forbidden (actual ${bannedResult.deprecatedBrandCount} > baseline ${brandBaseline}).`,
          })
        }
      } else if (
        bannedResult.deprecatedBrandCount > 0 &&
        bannedResult.deprecatedBrandCount < brandBaseline
      ) {
        notices.push({
          category: 'banned-pattern',
          file: relPath,
          baseline: brandBaseline,
          actual: bannedResult.deprecatedBrandCount,
          message: `Deprecated brand count decreased (${brandBaseline} -> ${bannedResult.deprecatedBrandCount}); run --update-baseline to tighten ratchet.`,
        })
      }
    }

    if (!isRawUseEffectExempt(relPath)) {
      const effectUsage = countRawUseEffect(sourceFile)
      if (effectUsage.count > 0) {
        useEffectFiles += 1
        useEffectTotal += effectUsage.count
        computedManifest.useEffectRatchet[relPath] = effectUsage.count
      }
      if (manifest) {
        const baseline = manifest.useEffectRatchet[relPath] ?? 0
        if (effectUsage.count > baseline) {
          const excessPos = effectUsage.positions[baseline] ?? effectUsage.positions[0] ?? 0
          const { line, column } = getLineAndCol(sourceFile, excessPos)
          violations.push({
            category: 'use-effect-ratchet',
            rule: 'ratchet/no-new-use-effect',
            file: relPath,
            line,
            column,
            message: `Raw useEffect count (${effectUsage.count}) exceeds ratchet baseline (${baseline}). Use UseMountEffect, UseExternalSubscription, or derived state instead.`,
          })
        } else if (effectUsage.count > 0 && effectUsage.count < baseline) {
          notices.push({
            category: 'use-effect-ratchet',
            file: relPath,
            baseline,
            actual: effectUsage.count,
            message: `Raw useEffect count decreased (${baseline} -> ${effectUsage.count}); run --update-baseline to tighten ratchet.`,
          })
        }
      }
    }

    if (isCommentDisciplineTarget(relPath)) {
      const { ordinaryComments, bannedComments } = classifyFileComments(sourceFile, text)
      if (ordinaryComments.length > 0) {
        commentFiles += 1
        ordinaryCommentsTotal += ordinaryComments.length
        computedManifest.commentRatchet[relPath] = ordinaryComments.length
      }
      if (bannedComments.length > 0) {
        bannedCommentsTotal += bannedComments.length
        computedManifest.bannedCommentRatchet[relPath] = bannedComments.length
      }

      if (manifest) {
        const bannedBaseline = manifest.bannedCommentRatchet[relPath] ?? 0
        if (bannedComments.length > bannedBaseline) {
          for (const item of bannedComments.slice(bannedBaseline)) {
            violations.push({
              category: 'comment-discipline',
              rule: 'comments/no-bare-suppression-or-todo',
              file: relPath,
              line: item.line,
              column: item.column,
              message: `${item.reason} (actual ${bannedComments.length} > baseline ${bannedBaseline}).`,
            })
          }
        } else if (bannedComments.length > 0 && bannedComments.length < bannedBaseline) {
          notices.push({
            category: 'comment-discipline',
            file: relPath,
            baseline: bannedBaseline,
            actual: bannedComments.length,
            message: `Banned suppression/TODO count decreased (${bannedBaseline} -> ${bannedComments.length}); run --update-baseline to tighten ratchet.`,
          })
        }

        const ordinaryBaseline = manifest.commentRatchet[relPath] ?? 0
        if (ordinaryComments.length > ordinaryBaseline) {
          const firstExcess = ordinaryComments[ordinaryBaseline] ?? ordinaryComments[0]
          violations.push({
            category: 'comment-discipline',
            rule: 'comments/no-new-ordinary-comments',
            file: relPath,
            line: firstExcess.line,
            column: firstExcess.column,
            message: `Ordinary comment count (${ordinaryComments.length}) exceeds ratchet baseline (${ordinaryBaseline}). Only JSDoc on exported APIs or // INVARIANT: / // SAFETY: comments are allowed.`,
          })
        } else if (ordinaryComments.length > 0 && ordinaryComments.length < ordinaryBaseline) {
          notices.push({
            category: 'comment-discipline',
            file: relPath,
            baseline: ordinaryBaseline,
            actual: ordinaryComments.length,
            message: `Ordinary comment count decreased (${ordinaryBaseline} -> ${ordinaryComments.length}); run --update-baseline to tighten ratchet.`,
          })
        }
      }
    }
  }

  if (manifest) {
    // INVARIANT: Files deleted or cleaned to zero should also surface shrink notices so baselines tighten monotonically.
    const checkRemovedKeys = (
      category: ContractNotice['category'],
      baselineMap: Record<string, number>,
      actualMap: Record<string, number>,
      label: string,
    ) => {
      for (const [file, baseline] of Object.entries(baselineMap)) {
        if (baseline > 0 && !(file in actualMap)) {
          notices.push({
            category,
            file,
            baseline,
            actual: 0,
            message: `${label} cleared (${baseline} -> 0); run --update-baseline to tighten ratchet.`,
          })
        }
      }
    }
    checkRemovedKeys(
      'banned-pattern',
      manifest.deprecatedBrandRatchet,
      computedManifest.deprecatedBrandRatchet,
      'Deprecated brand count',
    )
    checkRemovedKeys(
      'use-effect-ratchet',
      manifest.useEffectRatchet,
      computedManifest.useEffectRatchet,
      'Raw useEffect count',
    )
    checkRemovedKeys(
      'comment-discipline',
      manifest.commentRatchet,
      computedManifest.commentRatchet,
      'Ordinary comment count',
    )
    checkRemovedKeys(
      'comment-discipline',
      manifest.bannedCommentRatchet,
      computedManifest.bannedCommentRatchet,
      'Banned suppression/TODO count',
    )
  }

  return {
    violations,
    notices,
    computedManifest,
    stats: {
      filesScanned,
      useEffectFiles,
      useEffectTotal,
      commentFiles,
      ordinaryCommentsTotal,
      bannedCommentsTotal,
    },
  }
}

/**
 * Formats an {@link ArchContractReport} into human-readable CLI output with `file:line:col` diagnostics.
 */
export function formatArchContractReport(report: ArchContractReport): string {
  const lines: string[] = []
  for (const v of report.violations) {
    lines.push(`${v.file}:${v.line}:${v.column} error [${v.rule}] ${v.message}`)
  }
  for (const n of report.notices) {
    lines.push(`${n.file}:1:1 warn [ratchet-shrinkable] ${n.message}`)
  }
  lines.push(
    `Arch contracts: ${report.stats.filesScanned} files scanned, ${report.violations.length} error(s), ${report.notices.length} shrink notice(s) ` +
      `(useEffect: ${report.stats.useEffectTotal} across ${report.stats.useEffectFiles} files; ` +
      `ordinary comments: ${report.stats.ordinaryCommentsTotal} across ${report.stats.commentFiles} files; ` +
      `banned comments: ${report.stats.bannedCommentsTotal}).`,
  )
  return lines.join('\n')
}
