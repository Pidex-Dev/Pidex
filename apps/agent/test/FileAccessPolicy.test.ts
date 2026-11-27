import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DEFAULT_PERMISSION_CONFIG, FULL_ACCESS_PERMISSION_CONFIG } from '@pidex/shared/thread'
import type { ApprovalPolicy, PermissionConfig } from '@pidex/shared/thread'
import { removeFixturePaths } from './FixtureCleanup'
import { createLifecycleTools } from '../src/orchestration/execution/ProviderToolAdapter'
import { createToolExposurePlan } from '../src/tool/ToolExposurePlan'
import { ToolExecutor } from '../src/tool/ToolExecutor'
import { ToolCatalog, ToolRegistry } from '../src/tool/ToolRegistry'
import { WorkspaceService } from '../src/workspace/WorkspaceService'

const paths: string[] = []
afterEach(async () => removeFixturePaths(paths.splice(0)))

type ExecutionContext = Parameters<ToolExecutor['execute']>[2]

/** Fixture whose external directory deliberately contains a space. */
const fixture = async () => {
  const parent = await mkdtemp(join(tmpdir(), 'pidex-file-access-'))
  paths.push(parent)
  const root = join(parent, 'project')
  const outside = join(parent, 'outside dir')
  await mkdir(root)
  await mkdir(outside)
  const workspace = await WorkspaceService.open(root)
  // The approval service is audited instead of trusted: every test asserts the
  // recorded list, so an unexpected approval request fails the call even though
  // this reviewer would have allowed it.
  const approvals: string[] = []
  const executor = new ToolExecutor(new ToolRegistry(), {
    dataDir: join(parent, 'agent-data'),
    // Force the bounded native search so Glob/Grep stay deterministic here.
    resolveTooling: async () => ({
      available: false,
      code: 'TOOLING_UNAVAILABLE',
      reason: '测试固定使用原生搜索',
    }),
    authorizeShell: async (invocation) => {
      approvals.push(invocation.name)
      return { decision: 'allow', risk: 'critical', reason: '测试审批通过' }
    },
  })
  const context = (
    permissionConfig: PermissionConfig,
    overrides: Partial<ExecutionContext> = {},
  ): ExecutionContext => ({
    threadID: 'thread',
    turnID: 'turn',
    taskMode: 'chat',
    signal: new AbortController().signal,
    workspace,
    permissionConfig,
    ...overrides,
  })
  return { parent, root, outside, workspace, executor, approvals, context }
}

describe('完全访问权限下的文件工具', () => {
  test('直接读取、创建并编辑工作区外文件，且不触发任何审批', async () => {
    const { outside, executor, approvals, context } = await fixture()
    const external = join(outside, 'plan.md')
    const externalImg = join(outside, 'diagram.png')
    await writeFile(external, 'external plan\n', 'utf8')
    await writeFile(externalImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const externalDoc = await executor.execute<{ content: string; path: string }>(
      'Read',
      { path: external },
      context(FULL_ACCESS_PERMISSION_CONFIG),
    )
    expect(externalDoc.content).toBe('external plan\n')
    expect(isAbsolute(externalDoc.path)).toBe(true)

    const image = await executor.execute<{ path: string; kind: string }>(
      'Read',
      { path: externalImg },
      context(FULL_ACCESS_PERMISSION_CONFIG),
    )
    expect(image.kind).toBe('image')
    expect(isAbsolute(image.path)).toBe(true)
    expect(image.path.endsWith('diagram.png')).toBe(true)

    const created = join(outside, 'nested dir', 'created by agent.txt')
    await mkdir(join(outside, 'nested dir'))
    await executor.execute(
      'Write',
      { file_path: created, content: 'created\n' },
      context(FULL_ACCESS_PERMISSION_CONFIG),
    )
    expect(await readFile(created, 'utf8')).toBe('created\n')

    await executor.execute(
      'Edit',
      { path: external, edits: [{ oldText: 'external plan', newText: 'edited plan' }] },
      context(FULL_ACCESS_PERMISSION_CONFIG),
    )
    expect(await readFile(external, 'utf8')).toBe('edited plan\n')
    expect(approvals).toEqual([])
  })

  test('完全访问与 never 策略下 Read 可读取工作区外文本与图片而不触发审批', async () => {
    const { outside, executor, approvals, context } = await fixture()
    const externalText = join(outside, 'notes.md')
    const externalImage = join(outside, 'diagram.png')
    await writeFile(externalText, 'outside notes\n', 'utf8')
    await writeFile(externalImage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const fullAccessImage = await executor.execute<{ path: string; kind: string }>(
      'Read',
      { path: externalImage },
      context(FULL_ACCESS_PERMISSION_CONFIG),
    )
    expect(fullAccessImage.kind).toBe('image')
    expect(fullAccessImage.path.endsWith('diagram.png')).toBe(true)

    const neverWorkspaceWriteText = await executor.execute<{ content: string }>(
      'Read',
      { path: externalText },
      context({ ...DEFAULT_PERMISSION_CONFIG, approvalPolicy: 'never' }),
    )
    expect(neverWorkspaceWriteText.content).toBe('outside notes\n')

    const neverPlanText = await executor.execute<{ content: string }>(
      'Read',
      { path: externalText },
      context({ ...DEFAULT_PERMISSION_CONFIG, approvalPolicy: 'never' }, { taskMode: 'plan' }),
    )
    expect(neverPlanText.content).toBe('outside notes\n')
    expect(approvals).toEqual([])
  })

  test('默认允许外部低风险读取，外部写入先审批，只读配置仍拒绝写入', async () => {
    const { outside, executor, approvals, context } = await fixture()
    const externalImg = join(outside, 'plan.png')
    await writeFile(externalImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await expect(
      executor.execute('Read', { path: externalImg }, context(DEFAULT_PERMISSION_CONFIG)),
    ).resolves.toMatchObject({ kind: 'image' })
    expect(approvals).toEqual([])
    const target = join(outside, 'approved.txt')
    await executor.execute(
      'Write',
      { file_path: target, content: 'approved\n' },
      context(DEFAULT_PERMISSION_CONFIG),
    )
    expect(approvals).toEqual(['Write'])
    expect(await readFile(target, 'utf8')).toBe('approved\n')
    await expect(
      executor.execute(
        'Write',
        { file_path: join(outside, 'blocked.txt'), content: 'blocked' },
        context({ ...DEFAULT_PERMISSION_CONFIG, sandboxMode: 'read-only' }),
      ),
    ).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })
    expect(await Bun.file(join(outside, 'blocked.txt')).exists()).toBe(false)
  })

  test('默认模式可以读取只读本地上下文但不能写入', async () => {
    const { outside, workspace, executor, context } = await fixture()
    const referenceText = join(outside, 'reference.txt')
    const referenceImage = join(outside, 'reference.png')
    await writeFile(referenceText, 'read only\n', 'utf8')
    await writeFile(referenceImage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    workspace.grantReadOnlyPaths([
      { path: referenceText, kind: 'file' },
      { path: referenceImage, kind: 'file' },
    ])

    const read = await executor.execute<{ kind: string }>(
      'Read',
      { path: referenceImage },
      context(DEFAULT_PERMISSION_CONFIG),
    )
    expect(read.kind).toBe('image')
    await expect(
      executor.execute(
        'Write',
        { file_path: referenceText, content: 'changed\n' },
        context(DEFAULT_PERMISSION_CONFIG),
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_READONLY' })
    expect(await readFile(referenceText, 'utf8')).toBe('read only\n')
  })

  test('Plan 模式在完全访问权限下仍然禁止写文件', async () => {
    const { root, executor, context } = await fixture()
    await writeFile(join(root, 'target.txt'), 'before\n', 'utf8')

    await expect(
      executor.execute(
        'Write',
        { file_path: 'target.txt', content: 'after\n' },
        context(FULL_ACCESS_PERMISSION_CONFIG, { taskMode: 'plan' }),
      ),
    ).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })
    expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('before\n')
  })

  test('完全访问权限仍保留显式只读目录约束', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pidex-file-access-root-'))
    paths.push(parent)
    const primary = join(parent, 'primary')
    const locked = join(parent, 'locked')
    await mkdir(primary)
    await mkdir(locked)
    await writeFile(join(locked, 'locked.txt'), 'locked\n', 'utf8')
    const lockedPng = join(locked, 'locked.png')
    await writeFile(lockedPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const workspace = await WorkspaceService.openRoots({
      primaryRoot: primary,
      roots: [
        { path: primary, role: 'primary' },
        { path: locked, role: 'secondary', writable: false },
      ],
    })
    const executor = new ToolExecutor(new ToolRegistry())
    const context: ExecutionContext = {
      threadID: 'thread',
      turnID: 'turn',
      taskMode: 'chat',
      signal: new AbortController().signal,
      workspace,
      permissionConfig: FULL_ACCESS_PERMISSION_CONFIG,
    }

    expect(
      (await executor.execute<{ kind: string }>('Read', { path: lockedPng }, context)).kind,
    ).toBe('image')
    await expect(
      executor.execute(
        'Write',
        { file_path: join(locked, 'locked.txt'), content: 'changed\n' },
        context,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_READONLY' })
    expect(await readFile(join(locked, 'locked.txt'), 'utf8')).toBe('locked\n')
  })

  test('并发调用不会把完全访问传给默认模式的外部写入', async () => {
    const { outside, workspace, executor, approvals, context } = await fixture()
    await Promise.all([
      executor.execute(
        'Write',
        { file_path: join(outside, 'full.txt'), content: 'full' },
        context(FULL_ACCESS_PERMISSION_CONFIG),
      ),
      executor.execute(
        'Write',
        { file_path: join(outside, 'approved.txt'), content: 'approved' },
        context(DEFAULT_PERMISSION_CONFIG),
      ),
    ])
    expect(approvals).toEqual(['Write'])
    expect(workspace.fileAccess).toBe('workspace-write')
    await executor.execute(
      'Write',
      { file_path: join(outside, 'later.txt'), content: 'later' },
      context(DEFAULT_PERMISSION_CONFIG),
    )
    expect(approvals).toEqual(['Write', 'Write'])
  })

  test('默认读取链接按宿主真实目标访问外部低风险文件', async () => {
    const { root, outside, executor, context } = await fixture()
    const external = join(outside, 'secret.png')
    await writeFile(external, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await symlink(external, join(root, 'linked.png'), 'file')

    await expect(
      executor.execute('Read', { path: 'linked.png' }, context(DEFAULT_PERMISSION_CONFIG)),
    ).resolves.toMatchObject({ kind: 'image' })
  })
})

describe('权限申请工具的暴露与审批', () => {
  const exposure = (approvalPolicy: ApprovalPolicy) =>
    createToolExposurePlan(new ToolCatalog(), {
      taskMode: 'chat',
      sandboxMode: 'danger-full-access',
      approvalPolicy,
      profile: 'main',
    })

  test('never 时不暴露权限申请工具', () => {
    expect(exposure('never').allows('request_permissions')).toBe(false)
    expect(exposure('auto_review').allows('request_permissions')).toBe(true)
    // 进度工具不受审批策略影响，主 Agent 不再暴露结构化收尾工具。
    expect(exposure('never').allows('update_plan')).toBe(true)
    expect(exposure('never').allows('finalize_result')).toBe(false)
  })

  test('Pi 生命周期工具按统一暴露结果注册，并复用注册表参数约束', () => {
    const callbacks = { requestPermissions: async () => ({ granted: true }) }
    expect(
      createLifecycleTools(callbacks, {
        exposedTools: [],
        taskMode: 'chat',
      } as never).map((tool) => tool.name),
    ).not.toContain('request_permissions')

    const [tool] = createLifecycleTools(callbacks, {
      exposedTools: ['request_permissions'],
      taskMode: 'chat',
    } as never)
    expect(tool?.name).toBe('request_permissions')
    expect(tool?.description).toContain('Unavailable under never approval policy')
    const parameters = JSON.stringify(tool?.parameters)
    expect(parameters).toContain('"enum":["tool-call","turn","session"]')
    expect(parameters).toContain('"required":["scope","justification"]')
    expect(parameters).toContain('"readPaths"')
    expect(parameters).toContain('"networkDomains"')
  })

  test('禁止审批的权限申请在执行端仍被拒绝，允许时进入既有审批流程', async () => {
    const { root, outside, executor, approvals, context } = await fixture()
    const request = {
      scope: 'turn',
      readPaths: [root],
      justification: '需要读取工作区外的计划文件',
    }
    const deniedWriteRequest = {
      scope: 'turn',
      writePaths: [outside],
      justification: '需要写入工作区外文件',
    }

    await expect(
      executor.execute('request_permissions', request, context(FULL_ACCESS_PERMISSION_CONFIG)),
    ).resolves.toMatchObject({ granted: true })
    await expect(
      executor.execute(
        'request_permissions',
        deniedWriteRequest,
        context({
          sandboxMode: 'workspace-write',
          approvalPolicy: 'never',
          approvalsReviewer: 'auto_review',
        }),
      ),
    ).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })
    expect(approvals).toEqual([])

    const decision = await executor.execute<{ decision: string }>(
      'request_permissions',
      request,
      context(DEFAULT_PERMISSION_CONFIG, { authorizationOnly: true }),
    )
    expect(decision.decision).toBe('allow')
    expect(approvals).toEqual([])
  })
})

describe('真实路径的配置与敏感文件保护', () => {
  for (const tool of ['Write', 'Edit'] as const) {
    test(`${tool} 通过绝对路径写用户配置仍执行校验并保持原文件`, async () => {
      const { parent, outside, context } = await fixture()
      const target = join(outside, 'config.json')
      await writeFile(target, 'before\n', 'utf8')
      const scopes: string[] = []
      const executor = new ToolExecutor(new ToolRegistry(), {
        dataDir: join(parent, 'validation-data'),
        userConfigPath: target,
        authorizeShell: async () => {
          throw new Error('不应到达审批')
        },
        validateConfigDocument: (_text, scope) => {
          scopes.push(scope)
          throw new Error('配置校验拒绝')
        },
      })
      const ctx = context(FULL_ACCESS_PERMISSION_CONFIG)
      const input =
        tool === 'Write'
          ? { file_path: target, content: 'after\n' }
          : { path: target, edits: [{ oldText: 'before', newText: 'after' }] }
      await expect(executor.execute(tool, input, ctx)).rejects.toThrow('配置校验拒绝')
      expect(scopes).toEqual(['user'])
      expect(await readFile(target, 'utf8')).toBe('before\n')
    })
  }

  test('完全访问可通过真实目录链接写配置和 Git hooks，不跳过内容校验', async () => {
    const { root, outside, executor, approvals, context } = await fixture()
    const configDir = join(outside, '.pidex')
    const hooksDir = join(outside, '.git', 'hooks')
    await mkdir(configDir)
    await mkdir(hooksDir, { recursive: true })
    await symlink(configDir, join(root, 'config-link'), 'junction')
    await symlink(hooksDir, join(root, 'hooks-link'), 'junction')
    for (const target of [
      join(root, 'config-link', 'config.json'),
      join(root, 'hooks-link', 'pre-commit'),
    ]) {
      await expect(
        executor.execute(
          'Write',
          { file_path: target, content: 'blocked' },
          context(FULL_ACCESS_PERMISSION_CONFIG),
        ),
      ).resolves.toBeDefined()
      expect(await readFile(target, 'utf8')).toBe('blocked')
    }
    expect(approvals).toEqual([])
  })

  test('完全访问允许外部环境文件与示例文件写入', async () => {
    const { outside, executor, context } = await fixture()
    for (const name of ['.env', '.env.example']) {
      const target = join(outside, name)
      await executor.execute(
        'Write',
        { file_path: target, content: 'example\n' },
        context(FULL_ACCESS_PERMISSION_CONFIG),
      )
      expect(await readFile(target, 'utf8')).toBe('example\n')
    }
  })
})
