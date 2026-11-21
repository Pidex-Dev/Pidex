import { stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { AgentError } from '../../Domain'
import type { ToolDefinition } from '../ToolRegistry'

const MAX_GLOB_RESULTS = 200
const MAX_SCAN_CANDIDATES = 1_000
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules'])

export const globInputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
  })
  .strict()

export type GlobInput = z.infer<typeof globInputSchema>

export interface GlobOutput {
  path: string
  filenames: string[]
  numFiles: number
  truncated: boolean
}

const shouldSkipIgnoredSegment = (relPath: string, pattern: string, baseDir: string) => {
  const parts = relPath.replaceAll('\\', '/').split('/')
  const dirParts = baseDir.replaceAll('\\', '/').split('/')
  for (const segment of IGNORED_SEGMENTS) {
    if (parts.includes(segment) && !pattern.includes(segment) && !dirParts.includes(segment))
      return true
  }
  return false
}

/** Explorer-only fast file pattern matcher backed by WorkspaceService directory checks. */
export const globDefinition: ToolDefinition<GlobInput, GlobOutput> = {
  sdkName: 'Glob',
  name: 'workspace.glob',
  description:
    'Fast file pattern matching using glob patterns (e.g. "**/*.ts", "src/**/*.tsx"). Returns matching file paths sorted by modification time. Directory path is validated against workspace read policy.',
  schema: globInputSchema,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files against (e.g. "**/*.ts", "apps/**/src/*.tsx").',
      },
      path: {
        type: 'string',
        description:
          'Optional directory to search in (relative to workspace or absolute where permitted). Defaults to workspace root.',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  capabilities: {
    filesystem: 'read',
    network: 'none',
    process: false,
    externalState: false,
    userInteraction: false,
    readOnly: true,
  },
  allowedModes: ['chat', 'plan'],
  allowedProfiles: ['explorer'],
  approvalStrategy: 'policy',
  visibility: 'eager',
  executionMode: 'parallel',
  progress: (input) => ({ message: `正在按模式检索文件 ${input.pattern}` }),
  execute: async (input, context) => {
    if (context.signal.aborted) throw new AgentError('RUN_ABORTED', '任务已停止', 499)
    const dir = await context.workspace.resolveDirectory(input.path ?? '.')
    const glob = new Bun.Glob(input.pattern)
    const matches: Array<{ rel: string; mtimeMs: number }> = []
    let truncated = false

    for await (const entry of glob.scan({ cwd: dir, onlyFiles: true, dot: false })) {
      if (context.signal.aborted) throw new AgentError('RUN_ABORTED', '任务已停止', 499)
      const rel = entry.replaceAll('\\', '/')
      if (shouldSkipIgnoredSegment(rel, input.pattern, dir)) continue
      if (matches.length >= MAX_SCAN_CANDIDATES) {
        truncated = true
        break
      }
      const full = resolve(dir, rel)
      const info = await stat(full).catch(() => null)
      matches.push({ rel, mtimeMs: info?.mtimeMs ?? 0 })
    }

    matches.sort((left, right) => right.mtimeMs - left.mtimeMs || left.rel.localeCompare(right.rel))
    if (matches.length > MAX_GLOB_RESULTS) truncated = true
    const filenames = matches
      .slice(0, MAX_GLOB_RESULTS)
      .map(({ rel }) =>
        context.workspace.containsPath(join(dir, rel))
          ? relative(context.workspace.rootPath, join(dir, rel)).replaceAll('\\', '/') || rel
          : join(dir, rel).replaceAll('\\', '/'),
      )

    return {
      path: context.workspace.displayPath(dir),
      filenames,
      numFiles: filenames.length,
      truncated,
    }
  },
  formatResult: (output) => ({
    content: JSON.stringify(output, null, 2),
    details: output,
    structuredContent: false,
  }),
}
