import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FULL_ACCESS_PERMISSION_CONFIG, type PermissionConfig } from '@pidex/shared/thread'
import { removeFixturePaths } from './FixtureCleanup'
import {
  shellRuntimeDependencies,
  ToolExecutor,
  type ToolExecutionContext,
} from '../src/tool/ToolExecutor'
import type { ProcessResult } from '../src/tool/Shell/HostProcess'
import { ToolRegistry } from '../src/tool/ToolRegistry'
import { WorkspaceService } from '../src/workspace/WorkspaceService'
import { AgentLogger } from '../src/observability/AgentLogger'
import {
  isKnownSafeReadOnlyCommand,
  type ShellSecurityLevel,
} from '../src/security/ShellRiskClassifier'
import { findSystemGitBash, UnifiedExecManager } from '../src/tool/Shell/UnifiedExecManager'

const tempPaths: string[] = []
afterEach(async () => removeFixturePaths(tempPaths.splice(0)))

const workspaceWrite: PermissionConfig = {
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
}

const readOnly: PermissionConfig = {
  sandboxMode: 'read-only',
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
}

async function executionContext(
  root: string,
  permissionConfig: PermissionConfig = workspaceWrite,
  overrides: Partial<ToolExecutionContext> = {},
) {
  return {
    threadID: 'thread',
    turnID: 'turn',
    taskMode: 'chat' as const,
    signal: new AbortController().signal,
    workspace: await WorkspaceService.open(root),
    permissionConfig,
    ...overrides,
  }
}

const success = (stdout = 'ok'): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false,
})

describe('统一 Shell 宿主执行门', () => {
  test('只识别命令起始位置的 Node.js 与 Python 运行时', () => {
    expect(
      shellRuntimeDependencies(
        'node app.js && npm test; npx tsc | python script.py\npip install x & python3 -V',
      ),
    ).toEqual(['nodejs', 'python'])
    expect(shellRuntimeDependencies('corepack enable; python3 -V; pip3 -V')).toEqual([
      'nodejs',
      'python',
    ])
    expect(shellRuntimeDependencies("Write-Output 'npm python'; echo node; bun run test")).toEqual(
      [],
    )
    expect(shellRuntimeDependencies('C:\\custom\\node.exe app.js; ./python script.py')).toEqual([])
  })

  test('三种权限配置都在统一门禁后直接调用宿主 runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-host-shell-'))
    tempPaths.push(root)
    const executed: string[] = []
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'critical', reason: '允许' }),
      runHost: async (command) => {
        executed.push(command)
        return success()
      },
    })

    for (const [index, permissionConfig] of [
      readOnly,
      workspaceWrite,
      FULL_ACCESS_PERMISSION_CONFIG,
    ].entries()) {
      await executor.execute(
        'exec_command',
        { command: `Write-Output ${index}` },
        await executionContext(root, permissionConfig),
      )
    }

    expect(executed).toHaveLength(3)
  })

  test('Shell 只解析实际需要的运行时并注入受控 PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-host-shell-'))
    tempPaths.push(root)
    const requested: string[][] = []
    let receivedEnv: NodeJS.ProcessEnv | undefined
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: '允许' }),
      resolveToolingEnvironment: async (required) => {
        requested.push([...required])
        return {
          pathEntries: required.map((id) => `C:\\managed\\${id}`),
          resolutions: new Map(
            required.map((id) => [
              id,
              {
                available: true as const,
                path: `C:\\managed\\${id}\\runtime.exe`,
                source: 'managed' as const,
                version: 'test',
              },
            ]),
          ),
        }
      },
      runHost: async (_command, _cwd, _timeout, _signal, env) => {
        receivedEnv = env
        return success()
      },
    })

    await executor.execute('exec_command', { command: 'npm test' }, await executionContext(root))
    expect(requested).toEqual([['nodejs']])
    expect(Object.values(receivedEnv ?? {}).join(';')).toContain('C:\\managed\\nodejs')
  })

  test('Windows shell="bash" 在审批后按需探测本机 Git Bash 且不包 PowerShell 壳', async () => {
    if (process.platform !== 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'pidex-host-shell-'))
    tempPaths.push(root)
    let resolutions = 0
    let command = ''
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: '允许' }),
      resolveSystemBash: async () => {
        resolutions += 1
        return 'C:\\Program Files\\Git\\bin\\bash.exe'
      },
      runHost: async (value) => {
        command = value
        return success()
      },
    })

    await executor.execute(
      'exec_command',
      { command: 'pwd', shell: 'bash' },
      await executionContext(root),
    )
    expect(resolutions).toBe(1)
    expect(command).toContain('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(command).not.toContain('powershell')
  })

  test('Windows shell="bash" 未探测到本机 Git Bash 时静默回退到 PowerShell', async () => {
    if (process.platform !== 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'pidex-host-shell-'))
    tempPaths.push(root)
    let resolutions = 0
    let command = ''
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: '允许' }),
      resolveSystemBash: async () => {
        resolutions += 1
        return null
      },
      runHost: async (value) => {
        command = value
        return success()
      },
    })

    await executor.execute(
      'exec_command',
      { command: 'Get-Location', shell: 'bash' },
      await executionContext(root),
    )
    expect(resolutions).toBe(1)
    expect(command).toBe('Get-Location')
  })

  test('findSystemGitBash 尊重 PIDEX_GIT_BASH_PATH 且拒绝 WSL System32 stub', async () => {
    if (process.platform !== 'win32') return
    const previous = process.env.PIDEX_GIT_BASH_PATH
    try {
      process.env.PIDEX_GIT_BASH_PATH = 'C:\\Windows\\System32\\bash.exe'
      expect(await findSystemGitBash()).toBeNull()
    } finally {
      process.env.PIDEX_GIT_BASH_PATH = previous
    }
  })

  test('审批或项目 Hook 拒绝时宿主进程绝不启动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-host-shell-'))
    tempPaths.push(root)
    let runs = 0
    const deniedByApproval = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'deny', risk: 'critical', reason: '拒绝' }),
      runHost: async () => {
        runs += 1
        return success()
      },
    })
    await expect(
      deniedByApproval.execute(
        'exec_command',
        {
          command: 'Write-Output blocked',
          additionalPermissions: { networkDomains: ['example.com'] },
        },
        await executionContext(root),
      ),
    ).rejects.toMatchObject({ code: 'SHELL_PERMISSION_DENIED' })

    const deniedByHook = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: '允许' }),
      hooks: {
        run: async (event) =>
          event === 'pre_tool_use' ? [{ result: { decision: 'deny', reason: 'blocked' } }] : [],
      },
      runHost: async () => {
        runs += 1
        return success()
      },
    })
    await expect(
      deniedByHook.execute(
        'exec_command',
        { command: 'Write-Output blocked' },
        await executionContext(root),
      ),
    ).rejects.toMatchObject({ code: 'HOOK_DENIED' })
    expect(runs).toBe(0)
  })

  test('Shell 风险审批标记和安全级别热切换作用于同一执行器', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-host-shell-'))
    tempPaths.push(root)
    let securityLevel: ShellSecurityLevel = 'balanced'
    let receivedRuleApproval = false
    let runs = 0
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      resolveShellSecurityLevel: () => securityLevel,
      authorizeShell: async (invocation) => {
        receivedRuleApproval = invocation.permissionFacts?.ruleRequiresApproval === true
        return { decision: 'allow', risk: 'high', reason: '允许' }
      },
      runHost: async () => {
        runs += 1
        return success()
      },
    })

    await executor.execute(
      'exec_command',
      { command: 'winget uninstall fixture' },
      await executionContext(root),
    )
    expect(receivedRuleApproval).toBe(true)
    expect(runs).toBe(1)

    securityLevel = 'strict'
    await expect(
      executor.execute(
        'exec_command',
        { command: 'winget uninstall fixture' },
        await executionContext(root),
      ),
    ).resolves.toBeDefined()
    expect(receivedRuleApproval).toBe(true)
    expect(runs).toBe(2)
  })

  test('Pi 预审批恢复后不重复执行项目 Hook', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-host-shell-'))
    tempPaths.push(root)
    let preHooks = 0
    let runs = 0
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'critical', reason: '允许' }),
      hooks: {
        run: async (event) => {
          if (event === 'pre_tool_use') preHooks += 1
          return []
        },
      },
      runHost: async () => {
        runs += 1
        return success()
      },
    })
    const context = await executionContext(root)
    const toolCallID = 'tool-call'
    await executor.previewApproval(
      'exec_command',
      { command: 'Write-Output once' },
      context,
      toolCallID,
    )
    await executor.execute(
      'exec_command',
      { command: 'Write-Output once' },
      { ...context, toolCallID, approvedToolCallID: toolCallID },
    )
    expect(preHooks).toBe(1)
    expect(runs).toBe(1)
  })

  test('计划与 Grill 模式通过统一权限链执行安全调查命令', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-host-shell-'))
    tempPaths.push(root)
    const executed: string[] = []
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: '允许' }),
      runHost: async (command) => {
        executed.push(command)
        return success()
      },
    })
    for (const [index, taskMode] of (['plan', 'grill'] as const).entries()) {
      const plan = executor.exposurePlan({
        taskMode,
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        profile: 'main',
      })
      expect(plan.exposed).toContain('exec_command')
      expect(plan.exposed).toContain('write_stdin')
      expect(plan.exposed).toContain('Read')
      expect(plan.exposed).not.toContain('Grep')
      expect(plan.exposed).not.toContain('view_image')
      // 测试与构建命令作为调查进入同一执行链，不实际运行项目脚本。
      await executor.execute(
        'exec_command',
        { command: index === 0 ? 'bun run typecheck' : 'bun test' },
        {
          ...(await executionContext(root, FULL_ACCESS_PERMISSION_CONFIG)),
          taskMode,
        },
      )
    }
    expect(executed).toHaveLength(2)
  })

  test('计划模式的完全访问仍不能跳过 Hook 拒绝或 never 策略', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-host-shell-'))
    tempPaths.push(root)
    let runs = 0
    const denied = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: '允许' }),
      hooks: {
        run: async (event) =>
          event === 'pre_tool_use' ? [{ result: { decision: 'deny', reason: 'blocked' } }] : [],
      },
      runHost: async () => {
        runs += 1
        return success()
      },
    })
    await expect(
      denied.execute(
        'exec_command',
        { command: 'Get-ChildItem' },
        await executionContext(root, FULL_ACCESS_PERMISSION_CONFIG, { taskMode: 'plan' }),
      ),
    ).rejects.toMatchObject({ code: 'HOOK_DENIED' })
    expect(runs).toBe(0)

    const asked = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: '允许' }),
      hooks: {
        run: async (event) =>
          event === 'pre_tool_use' ? [{ result: { decision: 'ask', reason: 'review' } }] : [],
      },
      runHost: async () => {
        runs += 1
        return success()
      },
    })
    await expect(
      asked.execute(
        'exec_command',
        { command: 'Get-ChildItem' },
        await executionContext(root, FULL_ACCESS_PERMISSION_CONFIG, { taskMode: 'grill' }),
      ),
    ).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })
    expect(runs).toBe(0)
  })

  test('计划模式的 Hook 改写会重新判权，不能借完全访问执行危险命令', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-shell-rewrite-'))
    tempPaths.push(root)
    let runs = 0
    let rewrite: Record<string, unknown> | undefined
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: 'test' }),
      hooks: {
        run: async (event) =>
          event === 'pre_tool_use' && rewrite
            ? [{ result: { decision: 'continue', narrowedInput: rewrite } }]
            : [],
      },
      runHost: async () => {
        runs += 1
        return success()
      },
    })
    rewrite = { command: 'winget uninstall fixture' }
    await expect(
      executor.execute(
        'exec_command',
        { command: 'bun test' },
        await executionContext(root, FULL_ACCESS_PERMISSION_CONFIG, { taskMode: 'plan' }),
      ),
    ).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })
    expect(runs).toBe(0)
  })

  test('旧 sandbox escalation token 明确返回不支持且无副作用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-host-shell-'))
    tempPaths.push(root)
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'high', reason: '允许' }),
      runHost: async () => success(),
    })

    await expect(
      executor.execute(
        'request_permissions',
        {
          scope: 'tool-call',
          escalationToken: '11111111-1111-4111-8111-111111111111',
          justification: 'legacy',
        },
        await executionContext(root),
      ),
    ).rejects.toMatchObject({ code: 'SANDBOX_ESCALATION_UNAVAILABLE' })
  })

  test('分阶段日志包含诊断元数据但不记录命令和输出正文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-host-shell-log-'))
    tempPaths.push(root)
    const logger = new AgentLogger(join(root, 'logs'), {
      detailMode: 'development',
    })
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      logger,
      authorizeShell: async () => ({ decision: 'allow', risk: 'critical', reason: '允许' }),
      runHost: async () => success('sensitive-output'),
    })

    await executor.execute(
      'exec_command',
      { command: 'Write-Output sensitive-command' },
      await executionContext(root),
    )
    const log = await readFile(join(root, 'logs', 'agent.jsonl'), 'utf8')
    expect(log).toContain('shell.preflight.completed')
    expect(log).toContain('shell.execution.started')
    expect(log).toContain('shell.execution.completed')
    expect(log).toContain('"backend":"host-hook"')
    expect(log).toContain('"commandBytes":')
    expect(log).toContain('"stdoutBytes":')
    expect(log).not.toContain('sensitive-command')
    expect(log).not.toContain('sensitive-output')
  })

  test('isKnownSafeReadOnlyCommand 仅放行单阶段安全只读命令并拒绝组合与写操作', () => {
    expect(isKnownSafeReadOnlyCommand('Get-Content package.json')).toBe(true)
    expect(isKnownSafeReadOnlyCommand('Select-String -Path src\\*.ts -Pattern foo')).toBe(true)
    expect(isKnownSafeReadOnlyCommand('git status')).toBe(true)
    expect(isKnownSafeReadOnlyCommand('git diff --stat')).toBe(true)
    expect(isKnownSafeReadOnlyCommand('ls -la')).toBe(true)

    expect(isKnownSafeReadOnlyCommand('Get-Content a.txt | Select-String foo')).toBe(false)
    expect(isKnownSafeReadOnlyCommand('git status && rm -rf tmp')).toBe(false)
    expect(isKnownSafeReadOnlyCommand('Get-Content a.txt > out.txt')).toBe(false)
    expect(isKnownSafeReadOnlyCommand('git checkout main')).toBe(false)
    expect(isKnownSafeReadOnlyCommand('Remove-Item a.txt')).toBe(false)
    expect(isKnownSafeReadOnlyCommand('pwsh -Command "rm -rf ."')).toBe(false)
  })

  test('UnifiedExecManager 支持 ConPTY/管道会话续写并在关闭会话后拒绝孤儿续写', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-unified-exec-'))
    tempPaths.push(root)
    const manager = new UnifiedExecManager()
    try {
      const started = await manager.exec({
        threadID: 'thread-pty',
        command: 'interactive-pty',
        cwd: root,
        shell: process.platform === 'win32' ? 'cmd' : 'bash',
        executable: process.platform === 'win32' ? 'cmd.exe' : 'sh',
        args: process.platform === 'win32' ? ['/Q'] : [],
        tty: true,
        yieldTimeMs: 400,
      })
      expect(started.running).toBe(true)
      expect(started.tty).toBe(true)
      expect(started.sessionId).toBeGreaterThan(0)

      const interacted = await manager.writeStdin({
        threadID: 'thread-pty',
        sessionId: started.sessionId!,
        chars: 'echo ECHO_HELLO_PTY\n',
        yieldTimeMs: 800,
      })
      expect(interacted.output).toContain('ECHO_HELLO_PTY')

      let exited = await manager.writeStdin({
        threadID: 'thread-pty',
        sessionId: started.sessionId!,
        chars: 'exit\n',
        yieldTimeMs: 800,
      })
      for (let retry = 0; retry < 3 && exited.running; retry += 1) {
        exited = await manager.writeStdin({
          threadID: 'thread-pty',
          sessionId: started.sessionId!,
          yieldTimeMs: 400,
        })
      }
      expect(exited.running).toBe(false)
      expect(manager.sessionCount).toBe(0)

      const piped = await manager.exec({
        threadID: 'thread-pipe',
        command: 'piped-repl',
        cwd: root,
        shell: 'bash',
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        tty: false,
        yieldTimeMs: 80,
      })
      expect(piped.running).toBe(true)
      expect(piped.tty).toBe(false)
      manager.closeThreadSessions('thread-pipe')
      expect(manager.sessionCount).toBe(0)
      await expect(
        manager.writeStdin({ threadID: 'thread-pipe', sessionId: piped.sessionId!, chars: 'x\n' }),
      ).rejects.toMatchObject({ code: 'EXEC_SESSION_NOT_FOUND' })
    } finally {
      manager.dispose()
    }
  }, 15_000)

  test('write_stdin 审批预检返回允许且不触发实际写入或读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-write-stdin-preview-'))
    tempPaths.push(root)
    let writeCalls = 0
    const unifiedExec = {
      exec: async () => success(),
      writeStdin: async () => {
        writeCalls += 1
        return {
          ...success('after-stdin'),
          sessionId: 1,
          running: true,
          tty: true,
        }
      },
      closeThreadSessions: () => undefined,
      dispose: () => undefined,
    } as unknown as UnifiedExecManager
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: 'allow' }),
      unifiedExec,
    })
    const context = await executionContext(root)
    const preview = await executor.previewApproval(
      'write_stdin',
      { session_id: 1, chars: 'echo hi\n' },
      context,
      'write-stdin-preview-1',
    )
    expect(preview).toMatchObject({ decision: 'allow' })
    expect(writeCalls).toBe(0)

    const actual = await executor.execute(
      'write_stdin',
      { session_id: 1, chars: 'echo hi\n' },
      context,
    )
    expect(actual).toMatchObject({ stdout: 'after-stdin', sessionId: 1 })
    expect(writeCalls).toBe(1)
  })
})

test('Shell 恢复审批核对精确指纹；Hook 改写后重新验证 schema 并重新审批风险', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-shell-recheck-'))
  tempPaths.push(root)
  const context = await executionContext(root)
  let runs = 0
  let rewrite: Record<string, unknown> | undefined
  const executor = new ToolExecutor(new ToolRegistry(), {
    dataDir: join(root, '.agent-data'),
    authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: 'test' }),
    hooks: {
      run: async (event) =>
        event === 'pre_tool_use' && rewrite
          ? [{ result: { decision: 'continue', narrowedInput: rewrite } }]
          : [],
    },
    runHost: async () => {
      runs += 1
      return success()
    },
  })
  const preview = await executor.previewApproval(
    'exec_command',
    { command: 'Write-Output original' },
    context,
    'exact-call',
  )
  await expect(
    executor.execute(
      'exec_command',
      { command: 'Write-Output changed' },
      {
        ...context,
        toolCallID: 'exact-call',
        approvedToolCallID: 'exact-call',
        approvedAuthorizationFingerprint: preview.authorizationFingerprint!,
      },
    ),
  ).rejects.toThrow('作用范围已变化')
  rewrite = { __ruleRequiresApproval: false }
  await expect(
    executor.execute('exec_command', { command: 'Write-Output ok' }, context),
  ).rejects.toThrow()
  rewrite = { command: 'Remove-Item -Recurse -Force C:\\Windows' }
  await expect(
    executor.execute('exec_command', { command: 'Write-Output ok' }, context),
  ).resolves.toBeDefined()
  expect(runs).toBe(1)
})
