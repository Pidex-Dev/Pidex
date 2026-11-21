import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { IDisposable, IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty'
import { TerminalControlStripper } from '@pidex/shared'
import { AgentError } from '../../Domain'
import {
  boundedTimeout,
  killProcessTree,
  mergeProcessEnvironment,
  preferredShell,
  type ProcessResult,
} from './HostProcess'

const MAX_SESSIONS = 32
const MAX_BUFFER_BYTES = 1024 * 1024
const DEFAULT_EXEC_YIELD_MS = 10_000
const DEFAULT_STDIN_YIELD_MS = 5_000
const MIN_YIELD_MS = 50
const MAX_STDIN_YIELD_MS = 60_000
const PTY_COLS = 120
const PTY_ROWS = 40

export type ExecShellKind = 'powershell' | 'bash' | 'cmd'

export interface ResolvedExecShell {
  kind: ExecShellKind
  executable: string
  argsForCommand: (command: string, interactive: boolean) => string[]
  managedRuntimeCount: number
}

export interface UnifiedExecOptions {
  threadID: string
  command: string
  cwd: string
  shell?: ExecShellKind
  executable: string
  args: readonly string[]
  tty: boolean
  yieldTimeMs?: number
  timeoutMs?: number
  maxOutputTokens?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export interface UnifiedExecResult extends ProcessResult {
  output: string
  sessionId?: number
  running: boolean
  tty: boolean
  shell: ExecShellKind
  wallTimeMs: number
}

export interface WriteStdinOptions {
  threadID: string
  sessionId: number
  chars?: string
  yieldTimeMs?: number
  kill?: boolean
  maxOutputTokens?: number
  signal?: AbortSignal
}

type PtyRuntimeModule = {
  spawn: (
    file: string,
    args: string[] | string,
    options: IPtyForkOptions | IWindowsPtyForkOptions,
  ) => IPty
}

type PipeChild = ChildProcessByStdio<Writable, Readable, Readable>

interface ManagedSession {
  id: number
  threadID: string
  shell: ExecShellKind
  tty: boolean
  startedAt: number
  lastActivityAt: number
  terminating: boolean
  exited: boolean
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  timedOut: boolean
  truncated: boolean
  stdoutBuffer: string
  stderrBuffer: string
  combinedBuffer: string
  stdoutStripper: TerminalControlStripper
  stderrStripper: TerminalControlStripper
  totalBytes: number
  waiters: Set<() => void>
  timeoutTimer?: ReturnType<typeof setTimeout>
  dispose: () => void
  write: (chars: string) => void
  kill: () => void
}

let cachedPtyModule: PtyRuntimeModule | null | undefined

const resolveNodePtyPackageJson = (): string | null => {
  const execDir = dirname(process.execPath)
  const candidates = [
    resolve(execDir, 'node_modules', 'node-pty', 'package.json'),
    resolve(execDir, '..', 'app.asar.unpacked', 'node_modules', 'node-pty', 'package.json'),
    resolve(execDir, '..', 'desktop', 'electron', 'node_modules', 'node-pty', 'package.json'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  const resolvers = [
    createRequire(import.meta.url),
    createRequire(resolve(process.cwd(), 'package.json')),
  ]
  for (const resolver of resolvers) {
    try {
      const resolved = resolver.resolve('node-pty/package.json')
      if (existsSync(resolved)) return resolved
    } catch {
      continue
    }
  }
  const monorepoElectronPty = resolve(
    dirname(import.meta.dir),
    '..',
    '..',
    '..',
    'desktop',
    'electron',
    'node_modules',
    'node-pty',
    'package.json',
  )
  return existsSync(monorepoElectronPty) ? monorepoElectronPty : null
}

const loadNodePty = (): PtyRuntimeModule => {
  if (cachedPtyModule) return cachedPtyModule
  const packageJsonPath = resolveNodePtyPackageJson()
  if (!packageJsonPath) {
    throw new AgentError('PTY_UNAVAILABLE', '当前运行环境缺少 node-pty 原生终端模块', 503)
  }
  const loader = createRequire(packageJsonPath)
  const mod = loader('.') as PtyRuntimeModule
  if (!mod || typeof mod.spawn !== 'function') {
    throw new AgentError('PTY_UNAVAILABLE', 'node-pty 模块加载失败', 503)
  }
  cachedPtyModule = mod
  return mod
}

/** Normalizes requested shell name into a supported host shell kind. */
export const normalizeExecShellKind = (raw?: string): ExecShellKind => {
  if (raw === undefined || raw.trim() === '') {
    return process.platform === 'win32' ? 'powershell' : 'bash'
  }
  const normalized = raw.trim().toLowerCase()
  if (
    normalized === 'powershell' ||
    normalized === 'pwsh' ||
    normalized === 'pwsh.exe' ||
    normalized === 'powershell.exe'
  ) {
    return 'powershell'
  }
  if (
    normalized === 'bash' ||
    normalized === 'git-bash' ||
    normalized === 'bash.exe' ||
    normalized === 'sh'
  ) {
    return 'bash'
  }
  if (normalized === 'cmd' || normalized === 'cmd.exe') {
    if (process.platform !== 'win32') {
      throw new AgentError('INVALID_TOOL_INPUT', 'cmd 仅在 Windows 平台受支持', 400)
    }
    return 'cmd'
  }
  throw new AgentError(
    'INVALID_TOOL_INPUT',
    `不支持的 shell 类型：${raw}（可选 powershell、bash${process.platform === 'win32' ? '、cmd' : ''}）`,
    400,
  )
}

export type SystemBashResolver = (signal?: AbortSignal) => Promise<string | null>

let cachedSystemBash: { key: string; path: string } | null = null

const isRegularFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

const runCapture = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> =>
  new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise(null)
      return
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable, [...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolvePromise(null)
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      resolvePromise(value)
    }
    const stop = () => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish(null)
    }
    signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes <= 64 * 1024) chunks.push(chunk)
      else stop()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes <= 64 * 1024) chunks.push(chunk)
      else stop()
    })
    child.once('error', () => finish(null))
    child.once('close', (code) => {
      finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : null)
    })
  })

const whereWindowsExecutables = async (name: string, signal?: AbortSignal): Promise<string[]> => {
  const output = await runCapture('where.exe', [name], 5_000, signal)
  if (!output) return []
  return output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
}

/** Probes system-installed Git Bash / GNU bash on Windows without auto-downloading managed runtimes. */
export const findSystemGitBash: SystemBashResolver = async (signal) => {
  if (signal?.aborted) return null
  const override = process.env.PIDEX_GIT_BASH_PATH?.trim()
  const pathEnv = process.env.Path ?? process.env.PATH ?? ''
  const cacheKey = `${override ?? ''}\0${pathEnv}`
  if (cachedSystemBash && cachedSystemBash.key === cacheKey && existsSync(cachedSystemBash.path)) {
    return cachedSystemBash.path
  }

  const candidates: string[] = []
  if (override) {
    candidates.push(resolve(override))
  } else {
    for (const gitExe of await whereWindowsExecutables('git.exe', signal)) {
      candidates.push(join(dirname(dirname(gitExe)), 'bin', 'bash.exe'))
    }
    for (const programFiles of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (programFiles) candidates.push(join(programFiles, 'Git', 'bin', 'bash.exe'))
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'))
    }
    for (const bashExe of await whereWindowsExecutables('bash.exe', signal)) {
      candidates.push(bashExe)
    }
    for (const directory of pathEnv.split(';')) {
      if (directory) candidates.push(join(directory, 'bash.exe'))
    }
  }

  for (const candidate of [...new Set(candidates)]) {
    if (signal?.aborted) return null
    const normalized = candidate.replaceAll('/', '\\').toLowerCase()
    if (normalized.includes('\\windows\\system32\\bash.exe')) continue
    if (!(await isRegularFile(candidate))) continue
    const versionOutput = await runCapture(candidate, ['--version'], 8_000, signal)
    if (versionOutput && /GNU bash/i.test(versionOutput)) {
      cachedSystemBash = { key: cacheKey, path: candidate }
      return candidate
    }
  }
  return null
}

const resolvePowerShellExecShell = (): ResolvedExecShell => {
  if (process.platform === 'win32') {
    const ps = preferredShell()
    return {
      kind: 'powershell',
      executable: ps.exe,
      argsForCommand: (command, interactive) =>
        interactive ? ['-NoLogo', '-NoProfile', '-Command', command] : [...ps.args, command],
      managedRuntimeCount: 0,
    }
  }
  return {
    kind: 'powershell',
    executable: 'pwsh',
    argsForCommand: (command, interactive) =>
      interactive
        ? ['-NoLogo', '-NoProfile', '-Command', command]
        : ['-NoProfile', '-NonInteractive', '-Command', command],
    managedRuntimeCount: 0,
  }
}

/** Resolves host executable and argument builder for the selected shell without wrapper indirection. */
export async function resolveExecShell(
  requestedShell: string | undefined,
  signal: AbortSignal,
  resolveSystemBash: SystemBashResolver = findSystemGitBash,
): Promise<ResolvedExecShell> {
  const kind = normalizeExecShellKind(requestedShell)
  if (kind === 'bash') {
    if (process.platform === 'win32') {
      const bashExecutable = await resolveSystemBash(signal)
      if (bashExecutable) {
        return {
          kind: 'bash',
          executable: bashExecutable,
          argsForCommand: (command) => ['-lc', command],
          managedRuntimeCount: 0,
        }
      }
      // INVARIANT: 找不到本机 Git Bash 时必须静默回退到 Windows 默认 PowerShell，不阻塞命令执行。
      return resolvePowerShellExecShell()
    }
    return {
      kind: 'bash',
      executable: existsSync('/bin/bash') ? '/bin/bash' : 'bash',
      argsForCommand: (command) => ['-lc', command],
      managedRuntimeCount: 0,
    }
  }
  if (kind === 'cmd') {
    const comspec = process.env.ComSpec?.trim() || 'cmd.exe'
    return {
      kind: 'cmd',
      executable: comspec,
      argsForCommand: (command) => ['/d', '/c', command],
      managedRuntimeCount: 0,
    }
  }
  return resolvePowerShellExecShell()
}

const capByTokens = (
  text: string,
  maxOutputTokens?: number,
): { text: string; truncated: boolean } => {
  if (maxOutputTokens === undefined || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    return { text, truncated: false }
  }
  const maxChars = Math.max(256, Math.floor(maxOutputTokens) * 4)
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars)}\n...[output truncated at ${maxOutputTokens} tokens]`,
    truncated: true,
  }
}

const boundedYieldTime = (requested: number | undefined, fallback: number, maxAllowed: number) => {
  if (requested === undefined || !Number.isFinite(requested)) return Math.min(fallback, maxAllowed)
  return Math.max(MIN_YIELD_MS, Math.min(Math.floor(requested), maxAllowed))
}

const buildEnvRecord = (additions?: NodeJS.ProcessEnv): Record<string, string> => {
  const merged = mergeProcessEnvironment(process.env, additions)
  const record: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string') record[key] = value
  }
  return record
}

/** Manages one-shot commands and stateful interactive ConPTY/pipe shell sessions per agent runtime. */
export class UnifiedExecManager {
  private nextSessionId = 1
  private readonly sessions = new Map<number, ManagedSession>()

  get sessionCount(): number {
    return this.sessions.size
  }

  /** Starts a command either until completion or until `yieldTimeMs` elapses, keeping live PTY/pipe sessions keyed by `sessionId`. */
  async exec(options: UnifiedExecOptions): Promise<UnifiedExecResult> {
    if (options.signal?.aborted) throw new AgentError('RUN_ABORTED', '任务已停止', 499)
    const timeoutMs = boundedTimeout(options.timeoutMs)
    const waitForExitOnly = !options.tty && options.yieldTimeMs === undefined
    const yieldWindowMs = waitForExitOnly
      ? timeoutMs
      : boundedYieldTime(options.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, timeoutMs)

    this.pruneExitedSessions()
    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictOldestSession()
    }

    const sessionId = this.nextSessionId++
    const session = options.tty
      ? this.spawnPtySession(sessionId, options, timeoutMs)
      : this.spawnPipeSession(sessionId, options, timeoutMs)
    this.sessions.set(sessionId, session)

    const onAbort = () => {
      session.kill()
      this.notifyWaiters(session)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.waitForOutputWindow(session, yieldWindowMs, options.signal)
      if (options.signal?.aborted) {
        this.deleteSession(sessionId)
        throw new AgentError('RUN_ABORTED', '任务已停止', 499)
      }
      return this.drainResult(session, options.maxOutputTokens)
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Sends characters to an existing session or polls newly buffered output until exit or `yieldTimeMs`. */
  async writeStdin(options: WriteStdinOptions): Promise<UnifiedExecResult> {
    if (options.signal?.aborted) throw new AgentError('RUN_ABORTED', '任务已停止', 499)
    const session = this.sessions.get(options.sessionId)
    if (!session || session.threadID !== options.threadID) {
      throw new AgentError('EXEC_SESSION_NOT_FOUND', `未找到会话 ID：${options.sessionId}`, 404)
    }

    const yieldWindowMs = boundedYieldTime(
      options.yieldTimeMs,
      DEFAULT_STDIN_YIELD_MS,
      MAX_STDIN_YIELD_MS,
    )
    session.lastActivityAt = Date.now()
    if (options.kill) {
      session.kill()
    } else if (options.chars && options.chars.length > 0 && !session.exited) {
      session.write(options.chars)
    }

    const onAbort = () => {
      this.notifyWaiters(session)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.waitForOutputWindow(session, yieldWindowMs, options.signal)
      if (options.signal?.aborted) throw new AgentError('RUN_ABORTED', '任务已停止', 499)
      return this.drainResult(session, options.maxOutputTokens)
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Kills and removes every active session owned by a deleted or aborted thread. */
  closeThreadSessions(threadID: string): void {
    for (const [id, session] of this.sessions) {
      if (session.threadID === threadID) {
        this.deleteSession(id)
      }
    }
  }

  /** Terminates all managed shell sessions during Agent shutdown. */
  dispose(): void {
    for (const id of [...this.sessions.keys()]) {
      this.deleteSession(id)
    }
  }

  private spawnPtySession(
    id: number,
    options: UnifiedExecOptions,
    timeoutMs: number,
  ): ManagedSession {
    const pty = loadNodePty()
    const env = buildEnvRecord(options.env)
    const forkOptions: IWindowsPtyForkOptions = {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: options.cwd,
      env,
      useConpty: true,
      useConptyDll: false,
    }
    const ptyProcess = pty.spawn(options.executable, [...options.args], forkOptions)
    const session: ManagedSession = {
      id,
      threadID: options.threadID,
      shell: options.shell ?? 'powershell',
      tty: true,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      terminating: false,
      exited: false,
      exitCode: null,
      exitSignal: null,
      timedOut: false,
      truncated: false,
      stdoutBuffer: '',
      stderrBuffer: '',
      combinedBuffer: '',
      stdoutStripper: new TerminalControlStripper(),
      stderrStripper: new TerminalControlStripper(),
      totalBytes: 0,
      waiters: new Set(),
      dispose: () => {
        if (session.timeoutTimer) clearTimeout(session.timeoutTimer)
        dataDisposable.dispose()
        exitDisposable.dispose()
        if (!session.exited) session.kill()
      },
      write: (chars) => {
        if (session.exited) return
        // INVARIANT: Windows ConPTY treats CR (\r) as Enter while models emit LF (\n) or CRLF.
        const payload = process.platform === 'win32' ? chars.replace(/\r?\n/g, '\r') : chars
        ptyProcess.write(payload)
      },
      kill: () => {
        if (session.exited || session.terminating) return
        session.terminating = true
        try {
          ptyProcess.kill()
        } catch {
          if (process.platform === 'win32' && ptyProcess.pid) {
            killProcessTree({
              pid: ptyProcess.pid,
              kill: () => true,
            })
          }
        }
        session.exited = true
        if (session.timeoutTimer) clearTimeout(session.timeoutTimer)
        this.notifyWaiters(session)
      },
    }

    const dataDisposable: IDisposable = ptyProcess.onData((chunk) => {
      this.appendOutput(session, 'stdout', Buffer.from(chunk, 'utf8'))
    })
    const exitDisposable: IDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
      session.exited = true
      session.exitCode = exitCode
      session.exitSignal = typeof signal === 'number' ? null : (signal ?? null)
      if (session.timeoutTimer) clearTimeout(session.timeoutTimer)
      this.notifyWaiters(session)
    })
    session.timeoutTimer = setTimeout(() => {
      if (!session.exited) {
        session.timedOut = true
        session.kill()
      }
    }, timeoutMs)
    return session
  }

  private spawnPipeSession(
    id: number,
    options: UnifiedExecOptions,
    timeoutMs: number,
  ): ManagedSession {
    const child: PipeChild = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: mergeProcessEnvironment(process.env, options.env),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.on('error', () => undefined)
    if (options.yieldTimeMs === undefined) {
      child.stdin.end()
    }
    const session: ManagedSession = {
      id,
      threadID: options.threadID,
      shell: options.shell ?? 'powershell',
      tty: false,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      terminating: false,
      exited: false,
      exitCode: null,
      exitSignal: null,
      timedOut: false,
      truncated: false,
      stdoutBuffer: '',
      stderrBuffer: '',
      combinedBuffer: '',
      stdoutStripper: new TerminalControlStripper(),
      stderrStripper: new TerminalControlStripper(),
      totalBytes: 0,
      waiters: new Set(),
      dispose: () => {
        if (session.timeoutTimer) clearTimeout(session.timeoutTimer)
        if (!session.exited) session.kill()
      },
      write: (chars) => {
        if (!session.exited && !child.stdin.destroyed) {
          child.stdin.write(chars, 'utf8')
        }
      },
      kill: () => {
        if (session.exited || session.terminating) return
        session.terminating = true
        killProcessTree(child)
      },
    }

    child.stdout.on('data', (chunk: Buffer) => this.appendOutput(session, 'stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => this.appendOutput(session, 'stderr', chunk))
    child.once('error', (cause) => {
      this.appendOutput(session, 'stderr', Buffer.from(`${cause.message}\n`, 'utf8'))
      session.exited = true
      session.exitCode = session.exitCode ?? 1
      if (session.timeoutTimer) clearTimeout(session.timeoutTimer)
      this.notifyWaiters(session)
    })
    child.once('close', (code, signal) => {
      session.exited = true
      session.exitCode = code
      session.exitSignal = signal
      if (session.timeoutTimer) clearTimeout(session.timeoutTimer)
      this.notifyWaiters(session)
    })
    session.timeoutTimer = setTimeout(() => {
      if (!session.exited) {
        session.timedOut = true
        session.kill()
      }
    }, timeoutMs)
    return session
  }

  private appendOutput(session: ManagedSession, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    session.lastActivityAt = Date.now()
    if (session.totalBytes >= MAX_BUFFER_BYTES) {
      session.truncated = true
      return
    }
    const remaining = MAX_BUFFER_BYTES - session.totalBytes
    const accepted = chunk.subarray(0, remaining)
    if (accepted.byteLength < chunk.byteLength) session.truncated = true
    session.totalBytes += accepted.byteLength
    const decoded = accepted.toString('utf8')
    const sanitized = (stream === 'stdout' ? session.stdoutStripper : session.stderrStripper).write(
      decoded,
    )
    if (stream === 'stdout') session.stdoutBuffer += sanitized
    else session.stderrBuffer += sanitized
    session.combinedBuffer += sanitized
  }

  private async waitForOutputWindow(
    session: ManagedSession,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (session.exited || signal?.aborted) return
    await new Promise<void>((resolveWait) => {
      const done = () => {
        clearTimeout(timer)
        session.waiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolveWait()
      }
      const timer = setTimeout(done, waitMs)
      session.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  private drainResult(session: ManagedSession, maxOutputTokens?: number): UnifiedExecResult {
    const stdout = session.stdoutBuffer
    const stderr = session.stderrBuffer
    const capped = capByTokens(session.combinedBuffer, maxOutputTokens)
    session.stdoutBuffer = ''
    session.stderrBuffer = ''
    session.combinedBuffer = ''
    session.totalBytes = 0
    const running = !session.exited
    const result: UnifiedExecResult = {
      exitCode: session.exitCode,
      signal: session.exitSignal,
      stdout,
      stderr,
      output: capped.text,
      timedOut: session.timedOut,
      truncated: session.truncated || capped.truncated,
      running,
      tty: session.tty,
      shell: session.shell,
      wallTimeMs: Date.now() - session.startedAt,
      ...(running ? { sessionId: session.id } : {}),
    }
    if (!running) {
      this.deleteSession(session.id)
    }
    return result
  }

  private notifyWaiters(session: ManagedSession): void {
    for (const waiter of [...session.waiters]) waiter()
  }

  private deleteSession(id: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.dispose()
  }

  private pruneExitedSessions(): void {
    for (const [id, session] of this.sessions) {
      if (session.exited && session.combinedBuffer.length === 0) {
        this.deleteSession(id)
      }
    }
  }

  private evictOldestSession(): void {
    let oldest: ManagedSession | undefined
    for (const session of this.sessions.values()) {
      if (!oldest || session.lastActivityAt < oldest.lastActivityAt) oldest = session
    }
    if (oldest) this.deleteSession(oldest.id)
  }
}

export const defaultUnifiedExecManager = new UnifiedExecManager()
