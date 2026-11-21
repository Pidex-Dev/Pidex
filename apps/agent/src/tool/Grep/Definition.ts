import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { AgentError } from '../../Domain'
import type { ToolDefinition } from '../ToolRegistry'

const MAX_GREP_BYTES = 24_000
const MAX_FALLBACK_FILES = 2_000
const MAX_FALLBACK_FILE_BYTES = 1_000_000
const DEFAULT_HEAD_LIMIT = 100
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules'])

export const grepInputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    output_mode: z.enum(['content', 'files_with_matches', 'count']).default('files_with_matches'),
    '-i': z.boolean().optional(),
    '-n': z.boolean().optional(),
    '-C': z.number().int().min(0).max(20).optional(),
    '-A': z.number().int().min(0).max(20).optional(),
    '-B': z.number().int().min(0).max(20).optional(),
    context: z.number().int().min(0).max(20).optional(),
    head_limit: z.number().int().min(1).max(500).default(DEFAULT_HEAD_LIMIT),
    offset: z.number().int().min(0).default(0),
    multiline: z.boolean().optional(),
  })
  .strict()

export type GrepInput = z.infer<typeof grepInputSchema>

export interface GrepOutput {
  mode: 'content' | 'files_with_matches' | 'count'
  path: string
  output: string
  numResults: number
  truncated: boolean
}

const formatDisplayTarget = (
  filePath: string,
  searchTarget: string,
  workspaceRoot: string,
  insideWorkspace: boolean,
) => {
  const resolved = isAbsolute(filePath) ? filePath : resolve(searchTarget, filePath)
  const rel = insideWorkspace
    ? relative(workspaceRoot, resolved)
    : relative(searchTarget, resolved) || resolved
  return (rel || resolved).replaceAll('\\', '/')
}

const buildRipgrepArgs = (input: GrepInput, target: string) => {
  const args = ['--no-heading', '--color', 'never']
  if (input.output_mode === 'files_with_matches') args.push('--files-with-matches')
  else if (input.output_mode === 'count') args.push('--count')
  else {
    if (input['-n'] !== false) args.push('-n')
    const ctx = input.context ?? input['-C']
    if (ctx !== undefined) args.push('-C', String(ctx))
    else {
      if (input['-B'] !== undefined) args.push('-B', String(input['-B']))
      if (input['-A'] !== undefined) args.push('-A', String(input['-A']))
    }
  }
  if (input['-i']) args.push('-i')
  if (input.multiline) args.push('-U', '--multiline-dotall')
  const targetSegments = target.replaceAll('\\', '/').split('/')
  for (const dir of IGNORED_DIRECTORIES) {
    if (!input.glob?.includes(dir) && !targetSegments.includes(dir))
      args.push('--glob', `!${dir}/**`)
  }
  if (input.glob) args.push('--glob', input.glob)
  args.push('--', input.pattern, target)
  return args
}

const runRipgrep = async (
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ status: 'ok' | 'empty'; stdout: string } | { status: 'missing' }> => {
  if (signal.aborted) throw new AgentError('RUN_ABORTED', '任务已停止', 499)
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(['rg', ...args], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') return { status: 'missing' }
    throw new AgentError('GREP_FAILED', error instanceof Error ? error.message : String(error), 500)
  }
  const onAbort = () => {
    try {
      child.kill()
    } catch {}
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      child.stdout && typeof child.stdout !== 'number'
        ? new Response(child.stdout).text()
        : Promise.resolve(''),
      child.stderr && typeof child.stderr !== 'number'
        ? new Response(child.stderr).text()
        : Promise.resolve(''),
      child.exited,
    ])
    if (signal.aborted) throw new AgentError('RUN_ABORTED', '任务已停止', 499)
    if (exitCode === 0) return { status: 'ok', stdout: stdoutText }
    if (exitCode === 1) return { status: 'empty', stdout: '' }
    throw new AgentError('GREP_FAILED', stderrText.trim() || `rg 退出码 ${exitCode}`, 400)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const collectFilesFallback = async (
  root: string,
  globPattern: string | undefined,
  signal: AbortSignal,
): Promise<string[]> => {
  const stats = await lstat(root)
  if (stats.isFile()) return [root]
  const glob = globPattern ? new Bun.Glob(globPattern) : null
  const files: string[] = []
  const walk = async (dir: string) => {
    if (files.length >= MAX_FALLBACK_FILES) return
    if (signal.aborted) throw new AgentError('RUN_ABORTED', '任务已停止', 499)
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_FALLBACK_FILES) break
      if (entry.isSymbolicLink()) continue
      // INVARIANT: tree walks mirror rg defaults and skip hidden entries; explicitly targeted dotfiles/dotdirs are admitted by lstat(root) above.
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) && !globPattern?.includes(entry.name)) continue
        await walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        const full = join(dir, entry.name)
        const rel = relative(root, full).replaceAll('\\', '/')
        if (!glob || glob.match(rel) || glob.match(entry.name)) files.push(full)
      }
    }
  }
  await walk(root)
  return files
}

const runFallbackSearch = async (
  input: GrepInput,
  target: string,
  signal: AbortSignal,
): Promise<string[]> => {
  const flags = `${input['-i'] ? 'i' : ''}${input.multiline ? 'ms' : ''}`
  let regex: RegExp
  try {
    regex = new RegExp(input.pattern, flags)
  } catch (error) {
    throw new AgentError(
      'INVALID_TOOL_INPUT',
      `无效正则表达式: ${error instanceof Error ? error.message : String(error)}`,
      400,
    )
  }
  const files = await collectFilesFallback(target, input.glob, signal)
  const linesOut: string[] = []
  const showLineNumbers = input['-n'] !== false
  for (const file of files) {
    if (signal.aborted) throw new AgentError('RUN_ABORTED', '任务已停止', 499)
    const info = await lstat(file).catch(() => null)
    if (!info || info.size > MAX_FALLBACK_FILE_BYTES) continue
    const raw = await readFile(file).catch(() => null)
    if (!raw || raw.includes(0)) continue
    const text = raw.toString('utf8')
    if (input.multiline) {
      if (!regex.test(text)) continue
      if (input.output_mode === 'files_with_matches') {
        linesOut.push(file)
      } else if (input.output_mode === 'count') {
        const matches = text.match(new RegExp(input.pattern, `${flags}g`))
        linesOut.push(`${file}:${matches?.length ?? 1}`)
      } else {
        const fileLines = text.split(/\r?\n/)
        fileLines.forEach((line, index) => {
          if (regex.test(line))
            linesOut.push(showLineNumbers ? `${file}:${index + 1}:${line}` : `${file}:${line}`)
        })
      }
      continue
    }
    const fileLines = text.split(/\r?\n/)
    let matchCount = 0
    for (let index = 0; index < fileLines.length; index += 1) {
      const line = fileLines[index]!
      if (!regex.test(line)) continue
      matchCount += 1
      if (input.output_mode === 'files_with_matches') {
        linesOut.push(file)
        break
      }
      if (input.output_mode === 'content') {
        linesOut.push(showLineNumbers ? `${file}:${index + 1}:${line}` : `${file}:${line}`)
      }
    }
    if (input.output_mode === 'count' && matchCount > 0) {
      linesOut.push(`${file}:${matchCount}`)
    }
  }
  return linesOut
}

const sliceBoundedLines = (lines: string[], offset: number, limit: number) => {
  const sliced = lines.slice(offset, offset + limit)
  const kept: string[] = []
  let bytes = 0
  let truncated = lines.length > offset + limit
  for (const line of sliced) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + lineBytes > MAX_GREP_BYTES) {
      truncated = true
      break
    }
    kept.push(line)
    bytes += lineBytes
  }
  return { kept, truncated }
}

/** Explorer-only structured content search built on ripgrep with pure-JS fallback. */
export const grepDefinition: ToolDefinition<GrepInput, GrepOutput> = {
  sdkName: 'Grep',
  name: 'workspace.grep',
  description: [
    'Content search built on ripgrep. Prefer this over rg/grep via exec_command.',
    '- Full regex syntax (escape literal braces like `interface\\{\\}`).',
    '- Filter with `glob` (e.g. "**/*.tsx").',
    '- `output_mode`: "files_with_matches" (paths only, default), "content" (matching lines), or "count".',
    '- Supports `offset` and `head_limit` pagination.',
  ].join('\n'),
  schema: grepInputSchema,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression pattern to search for.' },
      path: {
        type: 'string',
        description: 'File or directory to search in. Defaults to workspace root.',
      },
      glob: { type: 'string', description: 'Optional glob filter (e.g. "*.ts", "**/*.tsx").' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        default: 'files_with_matches',
      },
      '-i': { type: 'boolean', description: 'Case insensitive search.' },
      '-n': { type: 'boolean', description: 'Show line numbers in content mode (default true).' },
      '-C': {
        type: 'integer',
        minimum: 0,
        maximum: 20,
        description: 'Context lines around match.',
      },
      '-A': { type: 'integer', minimum: 0, maximum: 20, description: 'Lines after match.' },
      '-B': { type: 'integer', minimum: 0, maximum: 20, description: 'Lines before match.' },
      context: { type: 'integer', minimum: 0, maximum: 20, description: 'Alias for -C.' },
      head_limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        default: DEFAULT_HEAD_LIMIT,
        description: 'Maximum output lines/entries returned.',
      },
      offset: { type: 'integer', minimum: 0, default: 0, description: 'Skip first N entries.' },
      multiline: { type: 'boolean', description: 'Enable multiline matching.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  capabilities: {
    filesystem: 'read',
    network: 'none',
    process: true,
    externalState: false,
    userInteraction: false,
    readOnly: true,
  },
  allowedModes: ['chat', 'plan'],
  allowedProfiles: ['explorer'],
  approvalStrategy: 'policy',
  visibility: 'eager',
  executionMode: 'parallel',
  progress: (input) => ({ message: `正在检索内容 ${input.pattern}` }),
  execute: async (input, context) => {
    const target = await context.workspace.resolveExistingPath(input.path ?? '.')
    const targetStat = await lstat(target)
    const insideWorkspace = context.workspace.containsPath(target)
    const cwd = targetStat.isDirectory() ? target : context.workspace.rootPath
    const rg = await runRipgrep(buildRipgrepArgs(input, target), cwd, context.signal)
    const rawLines =
      rg.status === 'missing'
        ? await runFallbackSearch(input, target, context.signal)
        : rg.stdout
            .split(/\r?\n/)
            .map((line) => line.trimEnd())
            .filter(Boolean)

    const normalized = rawLines.map((line) => {
      if (input.output_mode === 'files_with_matches') {
        return formatDisplayTarget(line, target, context.workspace.rootPath, insideWorkspace)
      }
      const match = /^((?:[A-Za-z]:)?[^:\r\n]+):(\d+(?:[:-].*)?)$/.exec(line)
      if (!match) return line
      const display = formatDisplayTarget(
        match[1]!,
        target,
        context.workspace.rootPath,
        insideWorkspace,
      )
      return `${display}:${match[2]}`
    })

    const { kept, truncated } = sliceBoundedLines(
      normalized,
      input.offset ?? 0,
      input.head_limit ?? DEFAULT_HEAD_LIMIT,
    )
    return {
      mode: input.output_mode ?? 'files_with_matches',
      path: context.workspace.displayPath(target),
      output: kept.join('\n'),
      numResults: kept.length,
      truncated,
    }
  },
  formatResult: (output) => ({
    content: output.output || '(no matches)',
    details: output,
    structuredContent: false,
  }),
}
