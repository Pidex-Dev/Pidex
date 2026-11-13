import { isAbsolute, relative, resolve } from 'node:path'
import { AgentError } from '../../Domain'
import { nativeGrepWorkspace } from '../NativeWorkspaceSearch'
import { resolveManagedTool, runToolProcess } from '../ToolingRuntime'
import type { ToolContext } from '../ToolRegistry'

type RgEvent = {
  type?: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number | null
    submatches?: unknown[]
  }
}

export const searchPaths = async (context: ToolContext, value?: string) => {
  if (!value?.trim()) {
    return context.workspace.roots.map((root) => ({
      root,
      target: '.',
      nativeTarget: root === context.workspace.rootPath ? '.' : root,
    }))
  }
  const requested = value.trim()
  if (!isAbsolute(requested) && requested.split(/[\\/]+/).includes('..')) {
    throw new AgentError('WORKSPACE_PATH_DENIED', '搜索路径不得通过 .. 越出工作区', 403)
  }
  const canonical = await context.workspace.resolveDirectory(requested)
  const owner = context.workspace.rootForPath(canonical)
  if (!owner) {
    // resolveDirectory already checks full access or this call's approved paths.
    return [
      { root: canonical, target: '.', nativeTarget: context.workspace.displayPath(canonical) },
    ]
  }
  const child = relative(owner.path, canonical)
  return [
    {
      root: owner.path,
      target: child ? child.replaceAll('\\', '/') : '.',
      nativeTarget: context.workspace.displayPath(canonical),
    },
  ]
}

export const resolveRipgrep = async (context: ToolContext) => {
  const resolution = await (context.resolveTooling ?? resolveManagedTool)('ripgrep', {
    signal: context.signal,
  })
  if (!resolution.available && (resolution.code === 'TOOLING_ABORTED' || context.signal.aborted)) {
    throw new AgentError('RUN_ABORTED', '任务已停止', 499)
  }
  return resolution
}

export const ripgrep = async (
  context: ToolContext,
  executable: string,
  args: readonly string[],
  cwd = context.workspace.rootPath,
) => {
  const result = await (context.runToolProcess ?? runToolProcess)({
    executable,
    args,
    cwd,
    signal: context.signal,
    timeoutMs: 10_000,
    maxOutputBytes: 8 * 1024 * 1024,
  })
  if (result.exitCode !== 0 && result.exitCode !== 1)
    throw new AgentError(
      'WORKSPACE_SEARCH_FAILED',
      result.stderr || `ripgrep 退出码 ${result.exitCode}`,
      400,
    )
  return result
}

export const grepWorkspace = async (input: any, context: ToolContext) => {
  const targets = await searchPaths(context, input.path)
  const resolution = await resolveRipgrep(context)
  if (!resolution.available) {
    const results = await Promise.all(
      targets.map((target) =>
        nativeGrepWorkspace(
          { ...input, offset: 0, head_limit: 1_000 },
          context,
          target.nativeTarget,
        ),
      ),
    )
    const offset = input.offset ?? 0
    const limit = input.head_limit ?? 200
    if (input.output_mode === 'files_with_matches') {
      const files = results.flatMap((result) => ('files' in result ? result.files : []))
      return {
        files: files.slice(offset, offset + limit),
        truncated: results.some((result) => result.truncated) || files.length > offset + limit,
        engine: 'native-fallback' as const,
      }
    }
    if (input.output_mode === 'count') {
      const counts = results.flatMap((result) => ('counts' in result ? result.counts : []))
      return {
        counts: counts.slice(offset, offset + limit),
        truncated: results.some((result) => result.truncated) || counts.length > offset + limit,
        engine: 'native-fallback' as const,
      }
    }
    const matches = results.flatMap((result) => ('matches' in result ? result.matches : []))
    return {
      matches: matches.slice(offset, offset + limit),
      truncated: results.some((result) => result.truncated) || matches.length > offset + limit,
      engine: 'native-fallback' as const,
    }
  }
  const before = input['-B'] ?? input['-C'] ?? input.context ?? 0
  const after = input['-A'] ?? input['-C'] ?? input.context ?? 0
  const args = ['--json', '--color', 'never', '--no-messages', '--sort', 'path']
  if (input['-i']) args.push('--ignore-case')
  if (input.multiline) args.push('--multiline', '--multiline-dotall')
  if (before) args.push('--before-context', String(before))
  if (after) args.push('--after-context', String(after))
  if (input.glob) args.push('--glob', input.glob)
  if (input.type) args.push('--type', input.type)
  const matches: Array<{
    path: string
    line?: number
    text: string
    before?: string[]
    after?: string[]
  }> = []
  const counts = new Map<string, number>()
  const contexts = new Map<string, Map<number, string>>()
  const searches = await Promise.all(
    targets.map(async (target) => ({
      target,
      result: await ripgrep(
        context,
        resolution.path,
        [...args, '--', input.pattern, target.target],
        target.root,
      ),
    })),
  )
  for (const { target, result } of searches) {
    for (const raw of result.stdout.toString('utf8').split(/\r?\n/)) {
      if (!raw) continue
      let event: RgEvent
      try {
        event = JSON.parse(raw) as RgEvent
      } catch {
        throw new AgentError('WORKSPACE_SEARCH_INVALID_OUTPUT', 'ripgrep 返回了无法解析的输出', 502)
      }
      const rawPath = event.data?.path?.text
      const path = rawPath
        ? context.workspace.displayPath(
            isAbsolute(rawPath) ? resolve(rawPath) : resolve(target.root, rawPath),
          )
        : undefined
      const text = event.data?.lines?.text?.replace(/\r?\n$/, '')
      const line = event.data?.line_number ?? undefined
      if (!path || text === undefined || line === undefined) continue
      if (event.type === 'context') {
        const byLine = contexts.get(path) ?? new Map<number, string>()
        byLine.set(line, text)
        contexts.set(path, byLine)
      } else if (event.type === 'match') {
        const occurrences = Math.max(1, event.data?.submatches?.length ?? 1)
        counts.set(path, (counts.get(path) ?? 0) + occurrences)
        for (let index = 0; index < occurrences; index += 1)
          matches.push({
            path,
            ...(input['-n'] === false ? {} : { line }),
            text: text.slice(0, 8_000),
          })
      }
    }
  }
  for (const match of matches) {
    if (match.line === undefined) continue
    const byLine = contexts.get(match.path)
    const prior = Array.from({ length: before }, (_, index) =>
      byLine?.get(match.line! - before + index),
    ).filter((line): line is string => line !== undefined)
    const following = Array.from({ length: after }, (_, index) =>
      byLine?.get(match.line! + index + 1),
    ).filter((line): line is string => line !== undefined)
    if (prior.length) match.before = prior
    if (following.length) match.after = following
  }
  const offset = input.offset ?? 0
  const limit = input.head_limit ?? 200
  if (input.output_mode === 'files_with_matches') {
    const files = [...counts.keys()]
    return {
      files: files.slice(offset, offset + limit),
      truncated: files.length > offset + limit,
      engine: 'ripgrep' as const,
    }
  }
  if (input.output_mode === 'count') {
    const values = [...counts].map(([path, count]) => ({ path, count }))
    return {
      counts: values.slice(offset, offset + limit),
      truncated: values.length > offset + limit,
      engine: 'ripgrep' as const,
    }
  }
  return {
    matches: matches.slice(offset, offset + limit),
    truncated: matches.length > offset + limit,
    engine: 'ripgrep' as const,
  }
}
