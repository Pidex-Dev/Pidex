import { afterEach, describe, expect, test } from 'bun:test'
import { FULL_ACCESS_PERMISSION_CONFIG } from '@pidex/shared/thread'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ConfigService } from '../src/config/ConfigService'
import { SqliteProjectTrustStore } from '../src/config/ProjectTrustStore'
import { HookService } from '../src/hooks/HookService'
import { createHooksManagement } from '../src/hooks/HooksManagementService'
import { McpConfigService } from '../src/mcp/McpConfigService'
import { McpConnectionManager } from '../src/mcp/McpConnectionManager'
import { McpRuntimeService } from '../src/mcp/McpRuntimeService'
import { PluginManagementService } from '../src/plugin/PluginManagementService'
import { SkillManagementService } from '../src/prompt/SkillManagementService'
import { SkillService } from '../src/prompt/SkillService'
import { AgentDatabase } from '../src/storage/database/AgentDatabase'
import { HookSettingsRepository } from '../src/storage/repositories/HookSettingsRepository'
import { McpSettingsRepository } from '../src/storage/repositories/McpSettingsRepository'
import { PluginSettingsRepository } from '../src/storage/repositories/PluginSettingsRepository'
import { SkillSettingsRepository } from '../src/storage/repositories/SkillSettingsRepository'
import { createSelfManageTools } from '../src/tool/SelfManage'
import { ToolExecutor } from '../src/tool/ToolExecutor'
import { ToolRegistry } from '../src/tool/ToolRegistry'
import { WorkspaceService } from '../src/workspace/WorkspaceService'
import { removeFixturePaths } from './FixtureCleanup'

const temporary: string[] = []
afterEach(async () => removeFixturePaths(temporary.splice(0)))

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-self-manage-'))
  temporary.push(root)
  const dataDir = join(root, 'data')
  const userHome = join(root, 'home')
  const rawWorkspaceDir = join(root, 'workspace')
  const builtinSkillsRoot = resolve(import.meta.dir, '..', 'resources', 'skills')
  const builtinPluginsRoot = resolve(import.meta.dir, '..', 'resources', 'plugins')
  await mkdir(dataDir, { recursive: true })
  await mkdir(userHome, { recursive: true })
  await mkdir(join(rawWorkspaceDir, '.pidex'), { recursive: true })
  await writeFile(join(rawWorkspaceDir, '.pidex', 'config.json'), '{}\n', 'utf8')
  const workspaceDir = await realpath(rawWorkspaceDir)

  const db = new AgentDatabase({
    historyPath: join(dataDir, 'history.db'),
    profilePath: join(dataDir, 'profile.db'),
  })
  const configService = new ConfigService(
    join(dataDir, 'config.json'),
    {},
    new SqliteProjectTrustStore(db),
  )
  await configService.initialize()
  await configService.trustUpdate(workspaceDir, 'trusted')

  const plugins = new PluginManagementService(new PluginSettingsRepository(db), {
    builtinPluginsRoot,
    dataRoot: dataDir,
    userHome,
  })
  const skillManagement = new SkillManagementService(
    new SkillSettingsRepository(db),
    {
      dataRoot: dataDir,
      userHome,
      builtinSkillsRoot,
    },
    configService,
    (workspace) => plugins.enabledSkillRoots(workspace),
  )
  const hookSettings = new HookSettingsRepository(db)
  const hooks = new HookService(
    db,
    { run: async () => ({ output: '' }) },
    (value) => value,
    async () => undefined,
    configService,
    {
      dataRoot: dataDir,
      userHome,
      settings: hookSettings,
    },
  )
  const hooksManagement = createHooksManagement(
    hooks,
    configService,
    hookSettings,
    join(dataDir, 'hooks.json'),
    db,
    { dataRoot: dataDir, userHome },
  )

  const registry = new ToolRegistry()
  const mcpConfigs = new McpConfigService(new McpSettingsRepository(db), configService)
  const mcpConnections = new McpConnectionManager(mcpConfigs, registry, undefined, async () => undefined)
  const mcp = new McpRuntimeService(mcpConfigs, mcpConnections)

  for (const tool of createSelfManageTools({
    configService,
    skillManagement,
    hooksManagement,
    mcp,
    plugins,
  })) {
    registry.register(tool)
  }

  let approvalCount = 0
  const executor = new ToolExecutor(registry, {
    dataDir,
    userConfigPath: configService.userConfigPath,
    authorizeShell: async () => {
      approvalCount++
      return { decision: 'allow', risk: 'low', reason: 'test-approved' }
    },
  })

  const workspace = await WorkspaceService.open(workspaceDir)
  const baseContext = {
    threadID: 'thread-1',
    turnID: 'turn-1',
    taskMode: 'chat' as const,
    signal: new AbortController().signal,
    workspace,
  }

  return {
    root,
    dataDir,
    userHome,
    workspaceDir,
    builtinSkillsRoot,
    db,
    configService,
    skillManagement,
    hooksManagement,
    mcp,
    plugins,
    registry,
    executor,
    baseContext,
    getApprovalCount: () => approvalCount,
    cleanup: async () => {
      await configService.dispose()
      db.close()
    },
  }
}

describe('SelfManageTools', () => {
  test('权限门禁：只读免审、工作区内免审、工作区外弹窗、Full Access 全免审', async () => {
    const fx = await createFixture()
    try {
      await fx.executor.previewApproval(
        'pidex_config',
        { action: 'read' },
        fx.baseContext,
        'tc-read',
      )
      expect(fx.getApprovalCount()).toBe(0)

      await fx.executor.previewApproval(
        'pidex_skill',
        { action: 'create', name: 'local-check', description: 'check', body: 'run tests' },
        fx.baseContext,
        'tc-skill-proj',
      )
      expect(fx.getApprovalCount()).toBe(0)

      await fx.executor.previewApproval(
        'pidex_skill',
        { action: 'create', scope: 'user', name: 'global-check', description: 'check', body: 'run' },
        fx.baseContext,
        'tc-skill-user',
      )
      expect(fx.getApprovalCount()).toBe(1)

      await fx.executor.previewApproval(
        'pidex_skill',
        { action: 'create', scope: 'user', name: 'global-check', description: 'check', body: 'run' },
        { ...fx.baseContext, permissionConfig: FULL_ACCESS_PERMISSION_CONFIG },
        'tc-skill-full',
      )
      expect(fx.getApprovalCount()).toBe(1)

      await fx.executor.previewApproval(
        'pidex_hook',
        {
          action: 'upsert',
          hook: { id: 'fmt', event: 'post_tool_use', command: 'echo ok' },
        },
        fx.baseContext,
        'tc-hook-proj',
      )
      expect(fx.getApprovalCount()).toBe(1)

      await fx.executor.previewApproval(
        'pidex_hook',
        {
          action: 'upsert',
          scope: 'user',
          hook: { id: 'fmt', event: 'post_tool_use', command: 'echo ok' },
        },
        fx.baseContext,
        'tc-hook-user',
      )
      expect(fx.getApprovalCount()).toBe(2)
    } finally {
      await fx.cleanup()
    }
  })

  test('pidex_config 支持读取、修改全局设置与列出 Profile', async () => {
    const fx = await createFixture()
    try {
      await fx.executor.execute(
        'pidex_config',
        {
          action: 'set',
          scope: 'user',
          keyPath: ['desktop', 'appearance', 'mode'],
          value: 'dark',
        },
        { ...fx.baseContext, toolCallID: 'tc-cfg-set' },
      )
      expect(fx.getApprovalCount()).toBe(1)

      const readRes = (await fx.executor.execute(
        'pidex_config',
        { action: 'read' },
        { ...fx.baseContext, toolCallID: 'tc-cfg-read' },
      )) as { config: { desktop?: { appearance?: { mode?: string } } } }
      expect(readRes.config.desktop?.appearance?.mode).toBe('dark')

      const profiles = (await fx.executor.execute(
        'pidex_config',
        { action: 'list_profiles' },
        { ...fx.baseContext, toolCallID: 'tc-cfg-prof' },
      )) as { profiles: unknown[] }
      expect(Array.isArray(profiles.profiles)).toBe(true)
    } finally {
      await fx.cleanup()
    }
  })

  test('pidex_skill 支持项目内自然语言生成、读取、本地安装、启停与移除', async () => {
    const fx = await createFixture()
    try {
      const created = (await fx.executor.execute(
        'pidex_skill',
        {
          action: 'create',
          name: 'release-check',
          description: 'Release checklist',
          body: '1. Run tests\n2. Check changelog',
        },
        { ...fx.baseContext, toolCallID: 'tc-sk-create' },
      )) as { path: string; skill: { name: string; enabled: boolean } }
      expect(created.skill.name).toBe('release-check')
      expect(created.skill.enabled).toBe(true)
      expect(fx.getApprovalCount()).toBe(0)

      const readRes = (await fx.executor.execute(
        'pidex_skill',
        { action: 'read', path: created.path },
        { ...fx.baseContext, toolCallID: 'tc-sk-read' },
      )) as { content: string }
      expect(readRes.content).toContain('Release checklist')

      const toggled = (await fx.executor.execute(
        'pidex_skill',
        { action: 'set_enabled', path: created.path, enabled: false },
        { ...fx.baseContext, toolCallID: 'tc-sk-toggle' },
      )) as { result: { skill: { enabled: boolean } } }
      expect(toggled.result.skill.enabled).toBe(false)

      const externalSkillDir = join(fx.root, 'ext-skill')
      await mkdir(externalSkillDir, { recursive: true })
      await writeFile(
        join(externalSkillDir, 'SKILL.md'),
        '---\nname: ext-demo\ndescription: "External demo"\n---\n\nHello\n',
        'utf8',
      )
      const installed = (await fx.executor.execute(
        'pidex_skill',
        {
          action: 'install',
          source: { kind: 'local', path: externalSkillDir },
        },
        { ...fx.baseContext, toolCallID: 'tc-sk-install' },
      )) as { skill: { name: string } }
      expect(installed.skill.name).toBe('ext-demo')

      const removed = (await fx.executor.execute(
        'pidex_skill',
        { action: 'remove', name: 'ext-demo' },
        { ...fx.baseContext, toolCallID: 'tc-sk-remove' },
      )) as { removed: string }
      expect(removed.removed).toBe('ext-demo')

      // Removing a disabled skill must clear its disabled state so recreating it starts enabled.
      const removedDisabled = (await fx.executor.execute(
        'pidex_skill',
        { action: 'remove', name: 'release-check' },
        { ...fx.baseContext, toolCallID: 'tc-sk-remove-disabled' },
      )) as { removed: string }
      expect(removedDisabled.removed).toBe('release-check')

      const recreated = (await fx.executor.execute(
        'pidex_skill',
        {
          action: 'create',
          name: 'release-check',
          description: 'Release checklist v2',
          body: '1. Recreated',
        },
        { ...fx.baseContext, toolCallID: 'tc-sk-recreate' },
      )) as { skill: { enabled: boolean } }
      expect(recreated.skill.enabled).toBe(true)
    } finally {
      await fx.cleanup()
    }
  })

  test('pidex_hook 支持项目内写入、列表、启停、运行日志查询与移除', async () => {
    const fx = await createFixture()
    try {
      const upserted = (await fx.executor.execute(
        'pidex_hook',
        {
          action: 'upsert',
          hook: {
            id: 'lint-check',
            event: 'post_tool_use',
            matcher: 'Write|Edit',
            command: 'Write-Output "{}"',
          },
        },
        { ...fx.baseContext, toolCallID: 'tc-hk-upsert' },
      )) as { action: string; filePath: string; groups: Array<{ hooks: Array<{ id: string; identity: string }> }> }
      expect(upserted.action).toBe('created')
      expect(fx.getApprovalCount()).toBe(0)

      const hooksFileText = await readFile(join(fx.workspaceDir, '.pidex', 'hooks.json'), 'utf8')
      expect(JSON.parse(hooksFileText).hooks).toHaveLength(1)

      const identity = upserted.groups.flatMap((g) => g.hooks).find((h) => h.id === 'lint-check')?.identity
      expect(identity).toBeTruthy()

      const toggled = (await fx.executor.execute(
        'pidex_hook',
        { action: 'set_enabled', identity: identity!, enabled: false },
        { ...fx.baseContext, toolCallID: 'tc-hk-toggle' },
      )) as { enabled: boolean }
      expect(toggled.enabled).toBe(false)

      const runs = (await fx.executor.execute(
        'pidex_hook',
        { action: 'list_runs', limit: 10 },
        { ...fx.baseContext, toolCallID: 'tc-hk-runs' },
      )) as { runs: unknown[] }
      expect(Array.isArray(runs.runs)).toBe(true)

      const removed = (await fx.executor.execute(
        'pidex_hook',
        { action: 'remove', id: 'lint-check' },
        { ...fx.baseContext, toolCallID: 'tc-hk-remove' },
      )) as { removed: string }
      expect(removed.removed).toBe('lint-check')
    } finally {
      await fx.cleanup()
    }
  })

  test('pidex_mcp 与 pidex_plugin 支持查询与启停配置', async () => {
    const fx = await createFixture()
    try {
      const savedMcp = (await fx.executor.execute(
        'pidex_mcp',
        {
          action: 'save',
          server: {
            name: 'local_echo',
            enabled: true,
            transport: { type: 'stdio', command: 'echo', args: ['hi'] },
          },
        },
        { ...fx.baseContext, toolCallID: 'tc-mcp-save' },
      )) as { servers: Array<{ server: { name: string } }> }
      expect(savedMcp.servers.some((s) => s.server.name === 'local_echo')).toBe(true)
      expect(fx.getApprovalCount()).toBe(0)

      const mcpList = (await fx.executor.execute(
        'pidex_mcp',
        { action: 'list' },
        { ...fx.baseContext, toolCallID: 'tc-mcp-list' },
      )) as { servers: Array<{ server: { name: string } }> }
      expect(mcpList.servers.some((s) => s.server.name === 'local_echo')).toBe(true)

      await fx.executor.execute(
        'pidex_mcp',
        { action: 'remove', name: 'local_echo' },
        { ...fx.baseContext, toolCallID: 'tc-mcp-remove' },
      )

      const pluginList = (await fx.executor.execute(
        'pidex_plugin',
        { action: 'list', includeMarketplace: false },
        { ...fx.baseContext, toolCallID: 'tc-plg-list' },
      )) as { plugins: Array<{ id: string }> }
      expect(Array.isArray(pluginList.plugins)).toBe(true)
    } finally {
      await fx.cleanup()
    }
  })

  test('内置 pidex-self-manage Skill 可被 SkillService 正常扫描加载', async () => {
    const fx = await createFixture()
    try {
      const service = new SkillService({ builtinSkillsRoot: fx.builtinSkillsRoot })
      const catalog = await service.scan({
        workspaceRoot: fx.workspaceDir,
        dataRoot: fx.dataDir,
        userHome: fx.userHome,
        builtinSkillsRoot: fx.builtinSkillsRoot,
      })
      const skill = catalog.skills.find((item) => item.name === 'pidex-self-manage')
      expect(skill).toBeDefined()
      const loaded = await service.read('pidex-self-manage')
      expect(loaded.body).toContain('pidex_config')
      expect(loaded.body).toContain('pidex_skill')
      expect(loaded.body).toContain('pidex_hook')
    } finally {
      await fx.cleanup()
    }
  })
})
