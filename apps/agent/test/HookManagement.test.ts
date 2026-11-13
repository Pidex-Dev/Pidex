import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeFixturePaths } from './FixtureCleanup'
import { ConfigService } from '../src/config/ConfigService'
import { AgentDatabase } from '../src/storage/database/AgentDatabase'
import { HookService } from '../src/hooks/HookService'
import { createHostHookRunner } from '../src/hooks/HookHostRunner'
import { HooksManagement } from '../src/hooks/HooksManagementService'
import { HookSettingsRepository } from '../src/storage/repositories/HookSettingsRepository'
import type { PluginHookSource } from '../src/hooks/HookDiscovery'

const roots: string[] = []
afterEach(async () => removeFixturePaths(roots.splice(0)))

const fixture = async (options: { trusted?: boolean; plugins?: PluginHookSource[] } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-hook-management-'))
  roots.push(root)
  const dataRoot = join(root, 'data')
  const userHome = join(root, 'home')
  const userConfigFile = join(dataRoot, 'config.json')
  const userHooksFile = join(dataRoot, 'hooks.json')
  const projectRoot = join(root, 'project')
  await mkdir(dataRoot, { recursive: true })
  await mkdir(userHome, { recursive: true })
  await mkdir(join(projectRoot, '.pidex'), { recursive: true })
  await writeFile(userConfigFile, '{}\n', 'utf8')
  const trust = options.trusted === false ? null : 'trusted'
  const configService = new ConfigService(
    userConfigFile,
    {},
    {
      read: (path) => (path === projectRoot ? trust : null),
      write: () => undefined,
    },
  )
  await configService.initialize()
  const db = new AgentDatabase(join(root, 'agent.sqlite'))
  const settings = new HookSettingsRepository(db)
  const executed: string[] = []
  const pluginHookSources = async () => options.plugins ?? []
  const hooks = new HookService(
    db,
    {
      run: async (input) => {
        executed.push(input.command)
        return { output: JSON.stringify({ decision: 'continue' }) }
      },
    },
    (value) => value,
    undefined,
    configService,
    {
      dataRoot,
      userHome,
      settings,
      pluginHookSources,
    },
  )
  const management = new HooksManagement({
    configService,
    settings,
    userHooksFile,
    dataRoot,
    userHome,
    runs: hooks.runRepository,
    projectRoots: () => [projectRoot],
    pluginHookSources,
    scrub: (value) => value.replaceAll('hunter2', '<redacted>'),
  })
  return {
    root,
    dataRoot,
    userHome,
    projectRoot,
    userConfigFile,
    userHooksFile,
    configService,
    db,
    settings,
    hooks,
    management,
    executed,
    dispose: async () => {
      await configService.dispose()
      db.close()
    },
  }
}

describe('Hook 主动发现与启停管理', () => {
  test('主动发现多兼容目录（.pidex / .claude / .codex / .agents）及 Claude Code 事件格式并聚合分组', async () => {
    const fixtureValue = await fixture()
    const { management, userHooksFile, userHome, projectRoot } = fixtureValue

    // ~/.pidex/hooks.json (Pidex native)
    await writeFile(
      userHooksFile,
      JSON.stringify({ hooks: [{ id: 'audit-user', event: 'pre_tool_use', command: 'echo user' }] }),
      'utf8',
    )
    // ~/.claude/settings.json (Claude Code nested event map)
    await mkdir(join(userHome, '.claude'), { recursive: true })
    await writeFile(
      join(userHome, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: 'node claude-start.js',
                  statusMessage: 'Loading claude session...',
                  timeout: 15,
                },
              ],
            },
          ],
        },
      }),
      'utf8',
    )
    // <workspace>/.codex/hooks/check.json
    await mkdir(join(projectRoot, '.codex', 'hooks'), { recursive: true })
    await writeFile(
      join(projectRoot, '.codex', 'hooks', 'check.json'),
      JSON.stringify({
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'node codex-prompt.js' }],
          },
        ],
      }),
      'utf8',
    )

    const result = await management.listSources(projectRoot)
    expect(result.groups.map((g) => g.id)).toEqual(['config:user', 'config:project'])

    const userGroup = result.groups[0]!
    expect(userGroup.displayName).toBe('用户配置')
    expect(userGroup.scopeLabel).toBe('所有项目')
    expect(userGroup.hooks.map((h) => [h.event, h.command, h.statusMessage, h.timeoutMs])).toEqual([
      ['pre_tool_use', 'echo user', undefined, undefined],
      ['session_start', 'node claude-start.js', 'Loading claude session...', 15_000],
    ])

    const projectGroup = result.groups[1]!
    expect(projectGroup.displayName).toBe('项目配置')
    expect(projectGroup.scopeLabel).toBe('project')
    expect(projectGroup.hooks.map((h) => [h.event, h.command])).toEqual([
      ['user_prompt_submit', 'node codex-prompt.js'],
    ])

    await fixtureValue.dispose()
  })

  test('发现已启用插件的钩子，并支持单条禁用与运行时过滤（不篡改原文件）', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pidex-plugin-hook-'))
    roots.push(temp)
    const pluginRoot = join(temp, 'ponytail')
    await mkdir(join(pluginRoot, 'hooks'), { recursive: true })
    const pluginHooksFile = join(pluginRoot, 'hooks', 'hooks.json')
    const originalText = JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node start.js',
                  statusMessage: 'Loading ponytail mode...',
                },
              ],
            },
          ],
          SubagentStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node subagent.js',
                  statusMessage: 'Loading ponytail subagent...',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )
    await writeFile(pluginHooksFile, originalText, 'utf8')

    const fixtureValue = await fixture({
      plugins: [
        {
          pluginId: 'ponytail',
          pluginName: 'Ponytail',
          pluginRoot,
          scope: 'user',
          hooksPaths: [pluginHooksFile],
        },
      ],
    })
    const { management, hooks, projectRoot, executed } = fixtureValue

    const initial = await management.listSources(projectRoot)
    const pluginGroup = initial.groups.find((g) => g.id === 'plugin:ponytail')
    expect(pluginGroup).toBeDefined()
    expect(pluginGroup?.kind).toBe('plugin')
    expect(pluginGroup?.hooks).toHaveLength(2)
    expect(pluginGroup?.hooks.every((h) => h.enabled)).toBe(true)

    const startHook = pluginGroup!.hooks.find((h) => h.event === 'session_start')!
    const updated = await management.setEnabled({
      identity: startHook.identity,
      enabled: false,
      operationId: 'op-disable-1',
    })
    expect(updated.enabled).toBe(false)

    // Idempotent replay with same operationId
    const replayed = await management.setEnabled({
      identity: startHook.identity,
      enabled: false,
      operationId: 'op-disable-1',
    })
    expect(replayed.generation).toBe(updated.generation)

    // Conflicting operationId is rejected
    await expect(
      management.setEnabled({
        identity: startHook.identity,
        enabled: true,
        operationId: 'op-disable-1',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    // Runtime HookService skips disabled hooks
    await hooks.loadWithPlugins({ projectRoot })
    await hooks.run('session_start', { workspace: projectRoot }, { workspaceRoot: projectRoot })
    expect(executed).toEqual([])

    // Original plugin hooks file was never modified
    const afterText = await Bun.file(pluginHooksFile).text()
    expect(afterText).toBe(originalText)

    await fixtureValue.dispose()
  })

  test('未信任项目仍标记 untrusted 诊断并在运行时要求信任确认', async () => {
    const fixtureValue = await fixture({ trusted: false })
    const { management, hooks, projectRoot } = fixtureValue
    await writeFile(
      join(projectRoot, '.pidex', 'hooks.json'),
      JSON.stringify({ hooks: [{ id: 'p1', event: 'pre_tool_use', command: 'echo p1' }] }),
      'utf8',
    )

    const listed = await management.listSources(projectRoot)
    const projectGroup = listed.groups.find((g) => g.id === 'config:project')
    expect(projectGroup?.untrusted).toBe(true)
    expect(projectGroup?.diagnostics.some((d) => d.code === 'CONFIG_PROJECT_UNTRUSTED')).toBe(true)

    await hooks.loadWithPlugins({ projectRoot })
    await expect(
      hooks.run('pre_tool_use', { workspace: projectRoot }, { workspaceRoot: projectRoot }),
    ).rejects.toMatchObject({ code: 'HOOK_TRUST_REQUIRED' })

    await fixtureValue.dispose()
  })

  test('插件 Hook 传递 pluginRoot、匹配管道符 matcher 并解析 hookSpecificOutput.additionalContext', async () => {
    const fixtureValue = await fixture()
    const pluginRoot = join(fixtureValue.dataRoot, 'plugins/installed/ponytail')
    await mkdir(join(pluginRoot, 'hooks'), { recursive: true })
    await writeFile(
      join(pluginRoot, 'hooks/claude-codex-hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume|clear|compact',
              hooks: [{ type: 'command', command: 'echo session' }],
            },
          ],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo prompt' }] }],
        },
      }),
      'utf8',
    )

    const seen: Array<{ pluginId: string | undefined; pluginRoot: string | undefined }> = []
    const hooks = new HookService(
      fixtureValue.db,
      {
        run: async (input) => {
          seen.push({ pluginId: input.pluginId, pluginRoot: input.pluginRoot })
          if (input.hookID.startsWith('session_start')) {
            return {
              output: JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'SessionStart',
                  additionalContext: 'PONYTAIL ACTIVE',
                },
              }),
            }
          }
          return { output: '{}' }
        },
      },
      undefined,
      undefined,
      fixtureValue.configService,
      {
        dataRoot: fixtureValue.dataRoot,
        userHome: fixtureValue.userHome,
        settings: fixtureValue.settings,
        pluginHookSources: async () => [
          {
            pluginId: 'ponytail',
            pluginName: 'Ponytail',
            pluginRoot,
            scope: 'user',
            hooksPaths: [join(pluginRoot, 'hooks/claude-codex-hooks.json')],
          },
        ],
      },
    )

    await hooks.loadWithPlugins({ projectRoot: fixtureValue.projectRoot })
    const startResults = await hooks.run(
      'session_start',
      { workspace: fixtureValue.projectRoot },
      { workspaceRoot: fixtureValue.projectRoot, matcherValue: 'startup' },
    )
    expect(startResults).toHaveLength(1)
    expect(startResults[0]?.result).toMatchObject({
      decision: 'continue',
      additionalContext: 'PONYTAIL ACTIVE',
    })

    const promptResults = await hooks.run(
      'user_prompt_submit',
      { workspace: fixtureValue.projectRoot, content: 'hi' },
      { workspaceRoot: fixtureValue.projectRoot },
    )
    expect(promptResults).toHaveLength(1)
    expect(promptResults[0]?.result.decision).toBe('continue')
    expect(seen).toHaveLength(2)
    expect(seen[0]?.pluginId).toBe('ponytail')
    expect(seen[0]?.pluginRoot).toBeTruthy()

    await fixtureValue.dispose()
  })

  test('宿主 HookRunner 直接执行工作区外插件命令、注入环境变量与 stdin，并正确处理退出码', async () => {
    const fixtureValue = await fixture()
    const outsidePluginRoot = await mkdtemp(join(tmpdir(), 'pidex-outside-plugin-'))
    roots.push(outsidePluginRoot)
    const scriptPath = join(outsidePluginRoot, 'activate.js')
    await writeFile(
      scriptPath,
      [
        "const fs = require('node:fs')",
        "const stdin = fs.readFileSync(0, 'utf8').trim()",
        'console.log(JSON.stringify({',
        '  hookSpecificOutput: {',
        "    hookEventName: 'SessionStart',",
        '    additionalContext: JSON.stringify({',
        '      stdin: JSON.parse(stdin),',
        '      pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,',
        '      pluginData: process.env.CLAUDE_PLUGIN_DATA,',
        '      projectDir: process.env.CLAUDE_PROJECT_DIR,',
        '    }),',
        '  },',
        '}))',
      ].join('\n'),
      'utf8',
    )
    const pluginHooksFile = join(outsidePluginRoot, 'hooks.json')
    await writeFile(
      pluginHooksFile,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node "${CLAUDE_PLUGIN_ROOT}/activate.js"',
                },
              ],
            },
          ],
        },
      }),
      'utf8',
    )

    const runner = createHostHookRunner({ dataDir: fixtureValue.dataRoot })
    const hooks = new HookService(
      fixtureValue.db,
      runner,
      (value) => value,
      undefined,
      fixtureValue.configService,
      {
        dataRoot: fixtureValue.dataRoot,
        userHome: fixtureValue.userHome,
        settings: fixtureValue.settings,
        pluginHookSources: async () => [
          {
            pluginId: 'ponytail',
            pluginName: 'Ponytail',
            pluginRoot: outsidePluginRoot,
            scope: 'user',
            hooksPaths: [pluginHooksFile],
          },
        ],
      },
    )

    try {
      await hooks.loadWithPlugins({ projectRoot: fixtureValue.projectRoot })
      const startResults = await hooks.run(
        'session_start',
        { workspace: fixtureValue.projectRoot, source: 'startup' },
        { workspaceRoot: fixtureValue.projectRoot, matcherValue: 'startup' },
      )
      expect(startResults).toHaveLength(1)
      const payload = JSON.parse(startResults[0]!.result.additionalContext!)
      expect(payload.stdin).toEqual({ workspace: fixtureValue.projectRoot, source: 'startup' })
      expect(payload.pluginRoot).toBe(outsidePluginRoot)
      expect(payload.pluginData).toBe(join(fixtureValue.dataRoot, 'plugins', 'data', 'ponytail'))
      expect(payload.projectDir).toBe(fixtureValue.projectRoot)

      const denyScript = join(outsidePluginRoot, 'deny.js')
      await writeFile(denyScript, "process.stderr.write('blocked by hook'); process.exit(2)\n", 'utf8')
      const denied = await runner.run({
        hookID: 'test-deny',
        command: `node "${denyScript}"`,
        timeoutMs: 5_000,
        evidence: '{}',
        workspaceRoot: fixtureValue.projectRoot,
      })
      expect(JSON.parse(denied.output)).toEqual({
        decision: 'deny',
        reason: 'blocked by hook',
      })

      const failScript = join(outsidePluginRoot, 'fail.js')
      await writeFile(failScript, "process.stderr.write('boom'); process.exit(1)\n", 'utf8')
      await expect(
        runner.run({
          hookID: 'test-fail',
          command: `node "${failScript}"`,
          timeoutMs: 5_000,
          evidence: '{}',
          workspaceRoot: fixtureValue.projectRoot,
        }),
      ).rejects.toThrow('boom')
    } finally {
      await fixtureValue.dispose()
    }
  })
})
