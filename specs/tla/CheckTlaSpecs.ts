import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SPEC_NAMES = ['RpcOutboxSseReplay', 'ApprovalInterruptRecovery'] as const

const DEFAULT_TLA_BINDINGS: Record<(typeof SPEC_NAMES)[number], readonly string[]> = {
  RpcOutboxSseReplay: [
    'apps/agent/src/storage/events/EventPublisher.ts',
    'apps/agent/src/storage/repositories/ExecutionRepository.ts',
    'apps/agent/src/transport/EventSubscriptionRegistry.ts',
  ],
  ApprovalInterruptRecovery: [
    'apps/agent/src/interaction/InteractionService.ts',
    'apps/agent/src/interaction/ResumeCheckpointResolver.ts',
    'apps/agent/src/permission/ApprovalService.ts',
    'apps/agent/src/permission/PermissionDecisionEngine.ts',
  ],
}

const NORMALIZATION_ID = 'ts-ast-no-comments-lf-sha256' as const

/** Result of parsing and validating a single TLA+ module and its TLC config. */
export interface SpecValidationResult {
  name: string
  tlaPath: string
  cfgPath: string
  moduleName: string
  specification: string
  invariants: string[]
  constants: string[]
  errors: string[]
}

/** Parsed fields extracted from a `.cfg` file. */
export interface ParsedTlaConfig {
  specification: string | null
  invariants: string[]
  constants: string[]
  errors: string[]
}

/** Binding entry mapping a single TLA+ specification to its normalized TS module hashes. */
export interface TlaBindingSpecEntry {
  files: Record<string, string>
}

/** Persisted manifest binding TLA+ specs to normalized SHA-256 digests of TS source modules. */
export interface TlaBindingManifest {
  version: 1
  normalization: typeof NORMALIZATION_ID
  specs: Record<string, TlaBindingSpecEntry>
}

/** Options controlling strict TLC enforcement and source binding verification. */
export interface TlaCheckOptions {
  requireTlc?: boolean
  updateBindings?: boolean
  manifestPath?: string
  skipTlc?: boolean
}

/** Result returned by {@link runTlaChecks}. */
export interface TlaCheckOutcome {
  ok: boolean
  tlcRan: boolean
  structuralErrors: string[]
  bindingErrors: string[]
}

const stripTlaComments = (source: string): { cleaned: string; commentErrors: string[] } => {
  const commentErrors: string[] = []
  let result = ''
  let depth = 0
  let i = 0
  while (i < source.length) {
    if (source[i] === '(' && source[i + 1] === '*') {
      depth += 1
      i += 2
      continue
    }
    if (source[i] === '*' && source[i + 1] === ')') {
      if (depth === 0) {
        commentErrors.push('Unmatched closing block comment "*)" in TLA+ module')
      } else {
        depth -= 1
      }
      i += 2
      continue
    }
    if (depth === 0) {
      if (source[i] === '\\' && source[i + 1] === '*') {
        while (i < source.length && source[i] !== '\n') i += 1
        continue
      }
      result += source[i]
    } else if (source[i] === '\n') {
      result += '\n'
    }
    i += 1
  }
  if (depth > 0) {
    commentErrors.push('Unclosed block comment "(*" in TLA+ module')
  }
  return { cleaned: result, commentErrors }
}

const parseDeclaredIdentifiers = (source: string, keywordRegex: RegExp): Set<string> => {
  const names = new Set<string>()
  const lines = source.split(/\r?\n/)
  let capturing = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      capturing = false
      continue
    }
    if (keywordRegex.test(line)) {
      capturing = true
      const rest = line.replace(keywordRegex, '')
      for (const token of rest.split(',')) {
        const trimmed = token.trim()
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) names.add(trimmed)
      }
      continue
    }
    if (capturing) {
      if (
        /^(CONSTANTS?|VARIABLES?|EXTENDS|LOCAL|INSTANCE|ASSUME|THEOREM|====|[A-Za-z_][A-Za-z0-9_]*\s*(?:\([^)]*\))?\s*==)/.test(
          line,
        )
      ) {
        capturing = false
      } else {
        for (const token of line.split(',')) {
          const trimmed = token.trim()
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) names.add(trimmed)
        }
      }
    }
  }
  return names
}

/** Parses a `.cfg` file into its SPECIFICATION, INVARIANT(S), and CONSTANT(S) declarations. */
export const parseTlaConfig = (cfgSource: string): ParsedTlaConfig => {
  const errors: string[] = []
  let specification: string | null = null
  const invariants: string[] = []
  const constants: string[] = []
  type Section = 'none' | 'specification' | 'invariants' | 'constants'
  let section: Section = 'none'

  for (const rawLine of cfgSource.split(/\r?\n/)) {
    const commentFree = rawLine.replace(/\\\*.*$/, '').trim()
    if (!commentFree) continue

    const specMatch = /^SPECIFICATION\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(commentFree)
    if (specMatch) {
      if (specification !== null) errors.push('Duplicate SPECIFICATION directive in .cfg')
      specification = specMatch[1]!
      section = 'specification'
      continue
    }
    if (/^SPECIFICATION\b/.test(commentFree)) {
      errors.push(`Invalid SPECIFICATION directive: "${commentFree}"`)
      section = 'specification'
      continue
    }

    if (/^INVARIANTS?\b/.test(commentFree)) {
      section = 'invariants'
      const rest = commentFree.replace(/^INVARIANTS?\b/, '').trim()
      if (rest) {
        for (const token of rest.split(/\s+/)) {
          if (token) invariants.push(token)
        }
      }
      continue
    }

    if (/^CONSTANTS?\b/.test(commentFree)) {
      section = 'constants'
      const rest = commentFree.replace(/^CONSTANTS?\b/, '').trim()
      if (rest) {
        const assignMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|<-)/.exec(rest)
        if (assignMatch) constants.push(assignMatch[1]!)
      }
      continue
    }

    if (
      /^(INIT|NEXT|PROPERTIES?|PROPERTY|SYMMETRY|CONSTRAINT|ACTION_CONSTRAINT|VIEW|CHECK_DEADLOCK)\b/.test(
        commentFree,
      )
    ) {
      section = 'none'
      continue
    }

    if (section === 'invariants') {
      for (const token of commentFree.split(/\s+/)) {
        if (token) invariants.push(token)
      }
      continue
    }

    if (section === 'constants') {
      const assignMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|<-)/.exec(commentFree)
      if (assignMatch) {
        constants.push(assignMatch[1]!)
      } else {
        errors.push(`Invalid CONSTANT entry in .cfg: "${commentFree}"`)
      }
    }
  }

  return { specification, invariants, constants, errors }
}

/** Validates structural consistency between a `.tla` module and its `.cfg` file. */
export const validateTlaSpecPair = (
  name: string,
  tlaPath: string,
  cfgPath: string,
): SpecValidationResult => {
  const errors: string[] = []
  if (!existsSync(tlaPath)) {
    return {
      name,
      tlaPath,
      cfgPath,
      moduleName: '',
      specification: '',
      invariants: [],
      constants: [],
      errors: [`Missing TLA+ file: ${tlaPath}`],
    }
  }
  if (!existsSync(cfgPath)) {
    return {
      name,
      tlaPath,
      cfgPath,
      moduleName: '',
      specification: '',
      invariants: [],
      constants: [],
      errors: [`Missing TLC config file: ${cfgPath}`],
    }
  }

  const rawTla = readFileSync(tlaPath, 'utf8')
  const rawCfg = readFileSync(cfgPath, 'utf8')
  const { cleaned, commentErrors } = stripTlaComments(rawTla)
  errors.push(...commentErrors)

  const moduleMatches = [
    ...cleaned.matchAll(/^\s*-{4,}\s*MODULE\s+([A-Za-z_][A-Za-z0-9_]*)\s*-{4,}\s*$/gm),
  ]
  const footerMatches = [...cleaned.matchAll(/^\s*={4,}\s*$/gm)]

  let moduleName = ''
  if (moduleMatches.length !== 1) {
    errors.push(`Expected exactly 1 MODULE header, found ${moduleMatches.length}`)
  } else {
    moduleName = moduleMatches[0]![1]!
    if (moduleName !== name) {
      errors.push(`MODULE name "${moduleName}" does not match filename stem "${name}"`)
    }
  }

  if (footerMatches.length !== 1) {
    errors.push(`Expected exactly 1 "====" footer, found ${footerMatches.length}`)
  } else if (moduleMatches.length === 1) {
    const headerIndex = moduleMatches[0]!.index ?? 0
    const footerIndex = footerMatches[0]!.index ?? 0
    if (footerIndex <= headerIndex) {
      errors.push('Module footer "====" appears before MODULE header')
    }
  }

  const definitions = new Set<string>()
  for (const match of cleaned.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*\([^)]*\))?\s*==/gm)) {
    definitions.add(match[1]!)
  }
  const declaredConstants = parseDeclaredIdentifiers(cleaned, /^CONSTANTS?\b/)

  const parsedCfg = parseTlaConfig(rawCfg)
  errors.push(...parsedCfg.errors)

  if (!parsedCfg.specification) {
    errors.push('Missing SPECIFICATION directive in .cfg')
  } else if (!definitions.has(parsedCfg.specification)) {
    errors.push(`SPECIFICATION "${parsedCfg.specification}" is not defined in ${name}.tla`)
  }

  if (parsedCfg.invariants.length === 0) {
    errors.push('No INVARIANT / INVARIANTS declared in .cfg')
  } else {
    for (const invariant of parsedCfg.invariants) {
      if (!definitions.has(invariant)) {
        errors.push(`INVARIANT "${invariant}" declared in .cfg is not defined in ${name}.tla`)
      }
    }
  }

  for (const constantName of parsedCfg.constants) {
    if (!declaredConstants.has(constantName)) {
      errors.push(`CONSTANT "${constantName}" in .cfg is not declared in ${name}.tla`)
    }
  }

  return {
    name,
    tlaPath,
    cfgPath,
    moduleName,
    specification: parsedCfg.specification ?? '',
    invariants: parsedCfg.invariants,
    constants: parsedCfg.constants,
    errors,
  }
}

/**
 * Strips comments and formatting whitespace while normalizing line endings to LF so
 * source hashes are deterministic across Windows CRLF and Linux LF checkouts.
 */
export const normalizeTsSourceForBinding = (source: string, fileName = 'module.ts'): string => {
  const lfSource = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const sourceFile = ts.createSourceFile(fileName, lfSource, ts.ScriptTarget.Latest, true)
  return ts
    .createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
    .printFile(sourceFile)
}

/** Computes the deterministic SHA-256 hex digest of normalized TypeScript source. */
export const hashNormalizedTsSource = (source: string, fileName = 'module.ts'): string =>
  createHash('sha256').update(normalizeTsSourceForBinding(source, fileName), 'utf8').digest('hex')

const readBindingManifest = (
  manifestPath: string,
): { manifest: TlaBindingManifest | null; errors: string[] } => {
  if (!existsSync(manifestPath)) {
    return { manifest: null, errors: [`Missing TLA+ binding manifest: ${manifestPath}`] }
  }
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<TlaBindingManifest>
    if (
      parsed.version !== 1 ||
      parsed.normalization !== NORMALIZATION_ID ||
      !parsed.specs ||
      typeof parsed.specs !== 'object'
    ) {
      return {
        manifest: null,
        errors: [`Invalid TLA+ binding manifest format at ${manifestPath}`],
      }
    }
    return { manifest: parsed as TlaBindingManifest, errors: [] }
  } catch (error) {
    return {
      manifest: null,
      errors: [
        `Failed to parse TLA+ binding manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }
}

/** Verifies every spec in `tla-binding-manifest.json` against normalized TS source hashes. */
export const verifyBindingManifest = (
  manifestPath: string,
  repoRoot: string,
  specNames: readonly string[] = SPEC_NAMES,
): { ok: boolean; errors: string[]; fileCount: number } => {
  const { manifest, errors } = readBindingManifest(manifestPath)
  if (!manifest) return { ok: false, errors, fileCount: 0 }

  let fileCount = 0
  for (const specName of specNames) {
    const entry = manifest.specs[specName]
    if (!entry || !entry.files || typeof entry.files !== 'object') {
      errors.push(`Missing binding entry for spec "${specName}" in ${manifestPath}`)
      continue
    }
    const paths = Object.keys(entry.files).sort((a, b) => a.localeCompare(b))
    if (paths.length === 0) {
      errors.push(`Spec "${specName}" has no bound TS files in ${manifestPath}`)
      continue
    }
    for (const relPath of paths) {
      fileCount += 1
      const expectedHash = entry.files[relPath]
      const absPath = resolve(repoRoot, relPath)
      if (!existsSync(absPath)) {
        errors.push(`Missing bound TS file for ${specName}: ${relPath}`)
        continue
      }
      const actualHash = hashNormalizedTsSource(readFileSync(absPath, 'utf8'), relPath)
      if (actualHash !== expectedHash) {
        errors.push(
          `Source drift detected for ${specName} -> ${relPath} (expected ${String(expectedHash).slice(0, 12)}, got ${actualHash.slice(0, 12)})`,
        )
      }
    }
  }

  return { ok: errors.length === 0, errors, fileCount }
}

/** Recomputes normalized SHA-256 hashes for all bound TS files and writes the manifest in LF UTF-8. */
export const updateBindingManifest = (
  manifestPath: string,
  repoRoot: string,
  specNames: readonly string[] = SPEC_NAMES,
): { ok: boolean; errors: string[]; manifest: TlaBindingManifest } => {
  const existing = readBindingManifest(manifestPath).manifest
  const errors: string[] = []
  const specs: Record<string, TlaBindingSpecEntry> = {}

  for (const specName of specNames) {
    const existingFiles = existing?.specs[specName]?.files
    const candidatePaths = existingFiles
      ? Object.keys(existingFiles)
      : [...(DEFAULT_TLA_BINDINGS[specName as (typeof SPEC_NAMES)[number]] ?? [])]
    const sortedPaths = [...new Set(candidatePaths.map((p) => p.replaceAll('\\', '/')))].sort(
      (a, b) => a.localeCompare(b),
    )
    if (sortedPaths.length === 0) {
      errors.push(`Spec "${specName}" has no bound TS files to update`)
      continue
    }
    const files: Record<string, string> = {}
    for (const relPath of sortedPaths) {
      const absPath = resolve(repoRoot, relPath)
      if (!existsSync(absPath)) {
        errors.push(`Missing bound TS file for ${specName}: ${relPath}`)
        continue
      }
      files[relPath] = hashNormalizedTsSource(readFileSync(absPath, 'utf8'), relPath)
    }
    specs[specName] = { files }
  }

  const manifest: TlaBindingManifest = {
    version: 1,
    normalization: NORMALIZATION_ID,
    specs,
  }
  if (errors.length === 0) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
  return { ok: errors.length === 0, errors, manifest }
}

const resolveTla2ToolsJar = (repoRoot: string): string | null => {
  const envJar = process.env.TLA2TOOLS_JAR?.trim()
  if (envJar) {
    const resolvedEnv = resolve(repoRoot, envJar)
    return existsSync(resolvedEnv) ? resolvedEnv : null
  }
  const localJar = join(repoRoot, '.tools', 'tla2tools.jar')
  return existsSync(localJar) ? localJar : null
}

const isJavaAvailable = (): boolean => {
  try {
    execFileSync('java', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Runs structural checks on all TLA+ specs, verifies TLA+ <-> TS source bindings,
 * and invokes TLC when `tla2tools.jar` + Java exist (or fails when TLC is required).
 */
export const runTlaChecks = (
  specsDir: string,
  repoRoot: string,
  options: TlaCheckOptions = {},
): TlaCheckOutcome => {
  const results = SPEC_NAMES.map((name) =>
    validateTlaSpecPair(name, join(specsDir, `${name}.tla`), join(specsDir, `${name}.cfg`)),
  )

  const structuralErrors: string[] = []
  for (const result of results) {
    if (result.errors.length > 0) {
      structuralErrors.push(...result.errors.map((err) => `${result.name}: ${err}`))
      console.error(`[FAIL] ${result.name}:`)
      for (const error of result.errors) {
        console.error(`  - ${error}`)
      }
    } else {
      console.log(
        `[PASS] ${result.name}: MODULE=${result.moduleName}, SPECIFICATION=${result.specification}, INVARIANTS=[${result.invariants.join(', ')}]`,
      )
    }
  }

  if (structuralErrors.length > 0) {
    return { ok: false, tlcRan: false, structuralErrors, bindingErrors: [] }
  }

  const manifestPath = options.manifestPath ?? join(specsDir, 'tla-binding-manifest.json')
  if (options.updateBindings) {
    const updated = updateBindingManifest(manifestPath, repoRoot, SPEC_NAMES)
    if (!updated.ok) {
      console.error('[FAIL] Failed to update TLA+ <-> TS binding manifest:')
      for (const error of updated.errors) {
        console.error(`  - ${error}`)
      }
      return {
        ok: false,
        tlcRan: false,
        structuralErrors,
        bindingErrors: updated.errors,
      }
    }
    console.log(`[PASS] Updated TLA+ <-> TS binding manifest: ${manifestPath}`)
  } else {
    const binding = verifyBindingManifest(manifestPath, repoRoot, SPEC_NAMES)
    if (!binding.ok) {
      console.error('[FAIL] TLA+ <-> TS source binding drift detected:')
      for (const error of binding.errors) {
        console.error(`  - ${error}`)
      }
      console.error(
        '[ACTION] Review the paired .tla specification(s) and scripts/formal/StateMachineProperty.test.ts to confirm invariants hold, then run:',
      )
      console.error('  bun run formal:check -- --update-bindings')
      console.error('  bun run test:governance')
      return {
        ok: false,
        tlcRan: false,
        structuralErrors,
        bindingErrors: binding.errors,
      }
    }
    console.log(
      `[PASS] Binding manifest verified (${binding.fileCount} TS module(s) across ${SPEC_NAMES.length} spec(s)).`,
    )
  }

  if (options.skipTlc) {
    return { ok: true, tlcRan: false, structuralErrors, bindingErrors: [] }
  }

  const requireTlc = options.requireTlc ?? process.env.PIDEX_REQUIRE_TLC === '1'
  const jarPath = resolveTla2ToolsJar(repoRoot)
  if (!jarPath) {
    if (requireTlc) {
      console.error(
        '[FAIL] TLC is required (PIDEX_REQUIRE_TLC=1 / --require-tlc), but tla2tools.jar was not found (checked TLA2TOOLS_JAR and .tools/tla2tools.jar).',
      )
      return { ok: false, tlcRan: false, structuralErrors, bindingErrors: [] }
    }
    console.log(
      '[NOTICE] tla2tools.jar not found (checked TLA2TOOLS_JAR and .tools/tla2tools.jar). Skipping TLC model checking; structural validation passed.',
    )
    console.log(
      '[NOTICE] To run full TLC model checking, download tla2tools.jar to .tools/tla2tools.jar or set TLA2TOOLS_JAR=/path/to/tla2tools.jar and re-run `bun specs/tla/CheckTlaSpecs.ts`.',
    )
    return { ok: true, tlcRan: false, structuralErrors, bindingErrors: [] }
  }

  if (!isJavaAvailable()) {
    if (requireTlc) {
      console.error(
        `[FAIL] TLC is required (PIDEX_REQUIRE_TLC=1 / --require-tlc), but "java" executable is not available in PATH (jar=${jarPath}).`,
      )
      return { ok: false, tlcRan: false, structuralErrors, bindingErrors: [] }
    }
    console.log(
      `[NOTICE] Found tla2tools.jar at ${jarPath}, but "java" executable is not available in PATH. Skipping TLC model checking; structural validation passed.`,
    )
    return { ok: true, tlcRan: false, structuralErrors, bindingErrors: [] }
  }

  const workDir = mkdtempSync(join(tmpdir(), 'pidex-tlc-'))
  try {
    for (const result of results) {
      const tlaFile = `${result.name}.tla`
      const cfgFile = `${result.name}.cfg`
      copyFileSync(result.tlaPath, join(workDir, tlaFile))
      copyFileSync(result.cfgPath, join(workDir, cfgFile))
      console.log(`[TLC] Checking ${result.name} using ${jarPath}...`)
      execFileSync(
        'java',
        ['-XX:+UseParallelGC', '-cp', jarPath, 'tlc2.TLC', '-cleanup', '-config', cfgFile, tlaFile],
        { cwd: workDir, stdio: 'inherit' },
      )
      console.log(`[TLC PASS] ${result.name}`)
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }

  return { ok: true, tlcRan: true, structuralErrors, bindingErrors: [] }
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2))
  const specsDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(specsDir, '..', '..')
  const outcome = runTlaChecks(specsDir, repoRoot, {
    ...(args.has('--require-tlc') ? { requireTlc: true } : {}),
    ...(args.has('--update-bindings') ? { updateBindings: true } : {}),
  })
  process.exit(outcome.ok ? 0 : 1)
}
