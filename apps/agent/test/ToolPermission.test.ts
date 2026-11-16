import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeFixturePaths } from './FixtureCleanup'
import { ToolRegistry } from '../src/tool/ToolRegistry'
import { createToolExposurePlan } from '../src/tool/ToolExposurePlan'
import { ToolExecutor } from '../src/tool/ToolExecutor'
import { WorkspaceService } from '../src/workspace/WorkspaceService'

const paths: string[] = []
afterEach(async () => removeFixturePaths(paths.splice(0)))

describe('工作区工具', () => {
  test('Plan 暴露面固定为调查工具并与 Chat update_plan 分离', () => {
    const executor = new ToolExecutor(new ToolRegistry())
    const plan = executor.exposurePlan({
      taskMode: 'plan',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'auto_review',

      profile: 'main',
    })
    expect(plan.exposed).toContain('exec_command')
    expect(plan.exposed).toContain('write_stdin')
    expect(plan.exposed).toContain('Read')
    expect(plan.exposed).toContain('request_user_input')
    expect(plan.exposed).not.toContain('Write')
    expect(plan.exposed).not.toContain('Edit')
    expect(plan.exposed).not.toContain('apply_patch')
    expect(plan.exposed).not.toContain('view_image')
    expect(plan.exposed).not.toContain('request_permissions')
    expect(plan.exposed).not.toContain('update_plan')
    expect(plan.exposed).not.toContain('finalize_plan')

    const grill = executor.exposurePlan({
      taskMode: 'grill',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      profile: 'main',
    })
    expect(grill.exposed).toContain('exec_command')
    expect(grill.exposed).toContain('Read')
    expect(grill.exposed).not.toContain('Write')
    expect(grill.exposed).not.toContain('Edit')
    expect(grill.exposed).not.toContain('apply_patch')
    expect(grill.exposed).not.toContain('view_image')

    const chat = executor.exposurePlan({
      taskMode: 'chat',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'auto_review',

      profile: 'main',
    })
    expect(chat.exposed).toContain('update_plan')
    expect(chat.exposed).not.toContain('request_user_input')
    expect(
      executor.exposurePlan({
        taskMode: 'chat',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'auto_review',

        profile: 'main',
        defaultModeRequestUserInput: true,
      }).exposed,
    ).toContain('request_user_input')
    expect(
      executor.exposurePlan({
        taskMode: 'chat',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'auto_review',

        profile: 'worker',
      }).exposed,
    ).not.toContain('update_plan')
    expect(
      executor.exposurePlan({
        taskMode: 'chat',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'auto_review',

        profile: 'worker',
        defaultModeRequestUserInput: true,
      }).exposed,
    ).not.toContain('request_user_input')
  })

  test('普通模式直接应用补丁，Plan 和 Grill 即使完全访问也拒绝写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-workspace-'))
    paths.push(root)
    const file = join(root, 'source.txt')
    await writeFile(file, 'before', 'utf8')
    const workspace = await WorkspaceService.open(root)
    const tools = new ToolRegistry()
    const executor = new ToolExecutor(tools)
    const context = {
      threadID: 'thread',
      turnID: 'turn',
      taskMode: 'chat' as const,
      signal: new AbortController().signal,
      workspace,
    }

    const patch = await executor.execute(
      'Edit',
      {
        path: 'source.txt',
        edits: [{ oldText: 'before', newText: 'after' }],
      },
      context,
    )
    expect(patch).toMatchObject({ operation: 'edit', path: 'source.txt' })
    expect(await Bun.file(file).text()).toBe('after')
    for (const taskMode of ['plan', 'grill'] as const) {
      const readOnlyContext = {
        ...context,
        taskMode,
        permissionConfig: {
          sandboxMode: 'danger-full-access' as const,
          approvalPolicy: 'never' as const,
          approvalsReviewer: 'auto_review' as const,
        },
      }
      await expect(
        executor.execute(
          'Edit',
          {
            path: 'source.txt',
            edits: [{ oldText: 'after', newText: 'blocked' }],
          },
          readOnlyContext,
        ),
      ).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })
      expect(await Bun.file(file).text()).toBe('after')
      await expect(
        executor.execute('Write', { file_path: 'probe.txt', content: 'test' }, readOnlyContext),
      ).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })
      expect(await Bun.file(join(root, 'probe.txt')).exists()).toBe(false)
    }
  })

  test('拒绝工作区外路径并以 UTF-8 读取文件', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pidex-workspace-'))
    paths.push(parent)
    const root = join(parent, 'project')
    await mkdir(root)
    await Bun.write(join(parent, 'outside.txt'), 'outside')
    await Bun.write(join(root, 'utf8.txt'), '中文 UTF-8')
    const workspace = await WorkspaceService.open(root)

    await expect(workspace.read('../outside.txt')).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_DENIED',
    })
    expect(await workspace.read('utf8.txt')).toBe('中文 UTF-8')
  })

  test('ToolRegistry 直接注册 Read 并同时读取文本与图片路径，同时拒绝损坏图片', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-workspace-'))
    paths.push(root)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await writeFile(join(root, 'preview.png'), png)
    await writeFile(join(root, 'notes.txt'), 'plain text', 'utf8')
    await writeFile(join(root, 'broken.png'), 'not-a-png', 'utf8')
    const workspace = await WorkspaceService.open(root)
    const executor = new ToolExecutor(new ToolRegistry())
    const image = await executor.execute<{ kind: string; mimeType: string }>(
      'Read',
      { path: 'preview.png' },
      {
        threadID: 'thread',
        turnID: 'turn',
        taskMode: 'chat',
        signal: new AbortController().signal,
        workspace,
      },
    )
    expect(image).toMatchObject({ kind: 'image', mimeType: 'image/png' })
    const text = await executor.execute<{ content: string }>(
      'Read',
      { path: 'notes.txt' },
      {
        threadID: 'thread',
        turnID: 'turn',
        taskMode: 'chat',
        signal: new AbortController().signal,
        workspace,
      },
    )
    expect(text.content).toBe('plain text')
    await expect(
      executor.execute(
        'Read',
        { path: 'broken.png' },
        {
          threadID: 'thread',
          turnID: 'turn',
          taskMode: 'chat',
          signal: new AbortController().signal,
          workspace,
        },
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_UNREADABLE' })
  })

  test('Skill allowedTools 在执行器最终边界只能收紧工具', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-skill-tools-'))
    paths.push(root)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await writeFile(join(root, 'thumb.png'), png)
    const workspace = await WorkspaceService.open(root)
    const executor = new ToolExecutor(new ToolRegistry())
    const context = {
      threadID: 'thread',
      turnID: 'turn',
      taskMode: 'chat' as const,
      signal: new AbortController().signal,
      workspace,
      allowedTools: ['Read'],
    }
    await expect(
      executor.execute<{ kind: string }>('Read', { path: 'thumb.png' }, context),
    ).resolves.toMatchObject({ kind: 'image' })
    await expect(
      executor.execute('exec_command', { command: 'Get-Location' }, context),
    ).rejects.toMatchObject({ code: 'SKILL_TOOL_NOT_ALLOWED' })
  })

  test('拒绝通过符号链接逃离工作区', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pidex-workspace-'))
    paths.push(parent)
    const root = join(parent, 'project')
    const outside = join(parent, 'outside.txt')
    await mkdir(root)
    await writeFile(outside, 'secret', 'utf8')
    await symlink(outside, join(root, 'outside-link.txt'), 'file')
    const workspace = await WorkspaceService.open(root)

    await expect(workspace.read('outside-link.txt')).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_DENIED',
    })
  })

  test('统一执行器最低层拒绝 read-only Write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-workspace-'))
    paths.push(root)
    const workspace = await WorkspaceService.open(root)
    const executor = new ToolExecutor(new ToolRegistry())

    await expect(
      executor.execute(
        'Write',
        { file_path: 'blocked.txt', content: 'blocked' },
        {
          threadID: 'thread',
          turnID: 'turn',
          taskMode: 'chat',
          signal: new AbortController().signal,
          workspace,
          permissionConfig: {
            sandboxMode: 'read-only',
            approvalPolicy: 'never',
            approvalsReviewer: 'auto_review',
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })
  })

  test('Explorer 暴露 Shell 调查能力并保留只读任务与执行上限', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidex-explorer-'))
    paths.push(root)
    const workspace = await WorkspaceService.open(root)
    const registry = new ToolRegistry()
    const explorerTools = registry
      .list('chat', 'workspace-write', 'explorer')
      .map((tool) => tool.sdkName)
    expect(explorerTools).toContain('exec_command')
    expect(explorerTools).toContain('write_stdin')
    expect(explorerTools).toContain('Read')
    expect(explorerTools).not.toContain('Write')
    expect(explorerTools).not.toContain('Edit')
    expect(explorerTools).not.toContain('apply_patch')
    expect(explorerTools).not.toContain('view_image')
    const explorerPlan = createToolExposurePlan(registry, {
      taskMode: 'chat',
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      profile: 'explorer',
    })
    expect(explorerPlan.allows('request_permissions')).toBe(false)
    expect(explorerPlan.allows('spawn_agents')).toBe(true)
    const runs: string[] = []
    const executor = new ToolExecutor(registry, {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: '允许' }),
      runHost: async (command) => {
        runs.push(command)
        return {
          exitCode: 0,
          signal: null,
          stdout: 'ok',
          stderr: '',
          timedOut: false,
          truncated: false,
        }
      },
    })
    const context = {
      threadID: 'thread',
      turnID: 'turn',
      profile: 'explorer' as const,
      taskMode: 'chat' as const,
      signal: new AbortController().signal,
      workspace,
      permissionConfig: {
        sandboxMode: 'read-only' as const,
        approvalPolicy: 'never' as const,
        approvalsReviewer: 'auto_review' as const,
      },
    }
    await executor.execute('exec_command', { command: 'Get-ChildItem' }, context)
    expect(runs).toHaveLength(1)
    await expect(
      executor.execute('Write', { file_path: 'blocked.txt', content: 'blocked' }, context),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED_FOR_PROFILE' })
  })
})
