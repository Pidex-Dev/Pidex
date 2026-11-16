import { ThreadGoalService } from '../src/session/ThreadGoalService'
import { EventHub } from '../src/storage/events/EventHub'
import { ContextCompactionService } from '../src/context/ContextCompactionService'
import { afterEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { removeFixturePaths } from './FixtureCleanup'
import { AgentError } from '../src/Domain'
import { ToolExecutor, type ToolExecutorOptions } from '../src/tool/ToolExecutor'
import { lineChangeSummary, ToolRegistry, type ToolOrigin } from '../src/tool/ToolRegistry'
import { WorkspaceService } from '../src/workspace/WorkspaceService'
import { adaptToolDefinition } from '../src/orchestration/pi/PiToolAdapter'
import { AgentRuntimeService } from '../src/orchestration/AgentRuntimeService'
import { Effect } from 'effect'
import { AgentDatabase } from '../src/storage/database/AgentDatabase'
import { RuntimeCompositionRepository } from '../src/storage/repositories/RuntimeCompositionRepository'
import { ThreadService } from '../src/session/ThreadService'
import { PromptComposer } from '../src/prompt/PromptComposer'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  getInitialSystemMessage,
  type TranscriptContext,
} from '@earendil-works/pi-ai'

const temporary: string[] = []
afterEach(async () => removeFixturePaths(temporary.splice(0)))

const fixture = async (
  runtime: {
    authorizeShell?: ToolExecutorOptions['authorizeShell']
    validateConfigDocument?: ToolExecutorOptions['validateConfigDocument']
    hooks?: ToolExecutorOptions['hooks']
    logger?: ToolExecutorOptions['logger']
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-core-tools-'))
  temporary.push(root)
  const workspace = await WorkspaceService.open(root)
  const executor = new ToolExecutor(new ToolRegistry(), {
    dataDir: join(root, '.agent-data'),
    userConfigPath: join(root, 'config.json'),
    ...(runtime.validateConfigDocument
      ? { validateConfigDocument: runtime.validateConfigDocument }
      : {}),
    ...(runtime.hooks ? { hooks: runtime.hooks } : {}),
    ...(runtime.logger ? { logger: runtime.logger } : {}),
    authorizeShell:
      runtime.authorizeShell ?? (async () => ({ decision: 'allow', risk: 'low', reason: 'test' })),
  })
  const context = {
    threadID: 'thread',
    turnID: 'turn',
    taskMode: 'chat' as const,
    signal: new AbortController().signal,
    workspace,
  }
  return { root, workspace, executor, context }
}

const registerDeferredTool = (
  registry: ToolRegistry,
  sdkName: string,
  description: string,
  origin?: ToolOrigin,
) =>
  registry.register({
    sdkName,
    description,
    schema: z.object({}).strict(),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    capabilities: {
      filesystem: 'none',
      network: 'none',
      process: false,
      externalState: false,
      userInteraction: false,
    },
    allowedModes: ['chat', 'plan'],
    allowedProfiles: ['main', 'default', 'explorer', 'worker'],
    approvalStrategy: 'never-review',
    visibility: 'deferred',
    executionMode: 'parallel',
    ...(origin ? { origin } : {}),
    execute: async () => ({ ok: true }),
  })

const deferredToolExecutor = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-core-tools-'))
  temporary.push(root)
  const workspace = await WorkspaceService.open(root)
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry, {
    dataDir: join(root, '.agent-data'),
    authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: 'test' }),
  })
  return { root, workspace, registry, executor }
}

describe('核心工具面', () => {
  test('配置文件写入强制审批并按用户/项目作用域预校验', async () => {
    const reviewed: Array<Record<string, unknown>> = []
    const validated: Array<{ text: string; scope: 'user' | 'project' }> = []
    const { root, executor, context } = await fixture({
      authorizeShell: async (invocation) => {
        reviewed.push({ ...invocation.permissionFacts })
        return { decision: 'allow', risk: 'medium', reason: 'approved' }
      },
      validateConfigDocument: (text, scope) => validated.push({ text, scope }),
    })
    await writeFile(join(root, 'config.json'), '{\n  "model": "old"\n}\n', 'utf8')

    const userAuthorization = await executor.execute<{ decision: string }>(
      'Write',
      { file_path: '@pidex/config.json', content: '{\n  "model": "new"\n}\n' },
      {
        ...context,
        authorizationOnly: true,
        permissionConfig: {
          sandboxMode: 'workspace-write',
          approvalPolicy: 'auto_review',
          approvalsReviewer: 'auto_review',
        },
      },
    )
    expect(userAuthorization.decision).toBe('allow')
    expect(reviewed.at(-1)?.ruleRequiresApproval).toBe(true)
    expect(validated.at(-1)).toEqual({
      text: '{\n  "model": "new"\n}\n',
      scope: 'user',
    })

    await executor.execute<{ decision: string }>(
      'Write',
      { file_path: '.pidex/config.json', content: '{\n  "model": "project"\n}\n' },
      {
        ...context,
        authorizationOnly: true,
        permissionConfig: {
          sandboxMode: 'workspace-write',
          approvalPolicy: 'auto_review',
          approvalsReviewer: 'auto_review',
        },
      },
    )
    expect(validated.at(-1)?.scope).toBe('project')
    await expect(
      executor.execute(
        'Write',
        { file_path: '@pidex/config.json', content: '{\n  "model": "blocked"\n}\n' },
        {
          ...context,
          authorizationOnly: true,
          permissionConfig: {
            sandboxMode: 'workspace-write',
            approvalPolicy: 'never',
            approvalsReviewer: 'auto_review',
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })

    await writeFile(
      join(root, 'config.json'),
      '{\r\n  "model": "old",\r\n  "reasoning": "high"\r\n}\r\n',
      'utf8',
    )
    await executor.execute(
      'Edit',
      {
        path: '@pidex/config.json',
        edits: [
          {
            oldText: '  "model": "old",\n  "reasoning": "high"',
            newText: '  "model": "new",\n  "reasoning": "medium"',
          },
        ],
      },
      {
        ...context,
        authorizationOnly: true,
        permissionConfig: {
          sandboxMode: 'workspace-write',
          approvalPolicy: 'auto_review',
          approvalsReviewer: 'auto_review',
        },
      },
    )
    expect(validated.at(-1)).toEqual({
      text: '{\r\n  "model": "new",\r\n  "reasoning": "medium"\r\n}\r\n',
      scope: 'user',
    })

    await executor.execute(
      'Write',
      {
        file_path: '@pidex/config.json',
        content: '{\r\n  "model": "written",\r\n  "reasoning": "high"\r\n}\r\n',
      },
      {
        ...context,
        authorizationOnly: true,
        permissionConfig: {
          sandboxMode: 'workspace-write',
          approvalPolicy: 'auto_review',
          approvalsReviewer: 'auto_review',
        },
      },
    )
    expect(validated.at(-1)).toEqual({
      text: '{\r\n  "model": "written",\r\n  "reasoning": "high"\r\n}\r\n',
      scope: 'user',
    })
  })

  test('只暴露规范名称，并用同一计划收紧 Skill allowlist', async () => {
    const { executor, context } = await fixture()
    const plan = executor.exposurePlan({
      taskMode: 'chat',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'auto_review',
      profile: 'main',
      allowedTools: ['Read', 'workspace_search'],
    })
    expect(plan.exposed).toEqual(['Read'])
    expect(executor.definition('workspace.read').sdkName).toBe('Read')
    const properties = (name: string) =>
      Object.keys(executor.definition(name).inputSchema.properties as Record<string, unknown>)
    const property = (name: string, key: string) =>
      (
        executor.definition(name).inputSchema.properties as Record<string, { description?: string }>
      )[key]
    expect(properties('Read')).toEqual(['file_path', 'offset', 'limit'])
    expect(properties('Write')).toEqual(['file_path', 'content'])
    expect(properties('Edit')).toEqual(['path', 'edits'])
    expect(properties('exec_command')).toEqual([
      'command',
      'cwd',
      'shell',
      'tty',
      'yield_time_ms',
      'max_output_tokens',
      'timeout',
      'description',
      'additionalPermissions',
    ])
    expect(properties('write_stdin')).toEqual([
      'session_id',
      'chars',
      'yield_time_ms',
      'kill',
      'max_output_tokens',
    ])
    expect(properties('ToolSearch')).toEqual(['query', 'max_results', 'offset'])
    expect(property('Read', 'file_path')?.description).toContain('PDF')
    expect(property('Write', 'file_path')?.description).toContain('Target file path.')
    expect(executor.definition('Write').description).toContain('Create or fully overwrite')
    expect(property('Edit', 'path')?.description).toContain('Existing file path')
    for (const removed of [
      'apply_patch',
      'view_image',
      'Glob',
      'Grep',
      'PowerShell',
      'Bash',
      'workspace_read',
      'shell',
    ]) {
      expect(() => executor.definition(removed)).toThrow()
    }
    const defaultPlan = executor.exposurePlan({
      taskMode: 'chat',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'auto_review',
      profile: 'main',
    })
    expect(defaultPlan.eager).toContain('Read')
    expect(defaultPlan.eager).toContain('Write')
    expect(defaultPlan.eager).toContain('Edit')
    expect(defaultPlan.eager).toContain('exec_command')
    expect(defaultPlan.eager).toContain('write_stdin')
    expect(defaultPlan.eager).not.toContain('apply_patch')
    expect(defaultPlan.eager).not.toContain('view_image')
    expect(defaultPlan.deferred).not.toContain('Edit')
    expect(defaultPlan.deferred).not.toContain('Write')
    expect(defaultPlan.exposed).toContain('spawn_agents')
    const sideChatPlan = executor.exposurePlan({
      taskMode: 'chat',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'auto_review',
      profile: 'main',
      delegationEnabled: false,
    })
    expect(sideChatPlan.exposed).not.toContain('spawn_agents')
    expect(sideChatPlan.exposed).not.toContain('wait_agents')
    expect(sideChatPlan.exposed).not.toContain('send_agent')
    expect(sideChatPlan.exposed).not.toContain('stop_agent')
    const editSkillPlan = executor.exposurePlan({
      taskMode: 'chat',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'auto_review',
      profile: 'main',
      allowedTools: ['Edit'],
    })
    expect(editSkillPlan.exposed).toContain('Edit')
    expect(editSkillPlan.exposed).not.toContain('Write')
    await expect(
      executor.execute(
        'Edit',
        {
          file_path: 'legacy.txt',
          old_string: 'old',
          new_string: 'new',
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT' })
  })

  test('ToolSearch 返回延迟注册表激活提示，进度由定义回调统一上报', async () => {
    const { executor, context } = await fixture()
    const registry = new ToolRegistry()
    registry.register({
      sdkName: 'deferred_example',
      description: '延迟示例工具',
      schema: z.object({}).strict(),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      capabilities: {
        filesystem: 'none',
        network: 'none',
        process: false,
        externalState: false,
        userInteraction: false,
      },
      allowedModes: ['chat', 'plan'],
      allowedProfiles: ['main', 'default', 'explorer', 'worker'],
      approvalStrategy: 'never-review',
      visibility: 'deferred',
      executionMode: 'parallel',
      execute: async () => ({ ok: true }),
    })
    registry.register({
      sdkName: 'new_deferred_example',
      description: '组合冻结后新增的延迟工具',
      schema: z.object({}).strict(),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      capabilities: {
        filesystem: 'none',
        network: 'none',
        process: false,
        externalState: false,
        userInteraction: false,
      },
      allowedModes: ['chat', 'plan'],
      allowedProfiles: ['main', 'default', 'explorer', 'worker'],
      approvalStrategy: 'never-review',
      visibility: 'deferred',
      executionMode: 'parallel',
      execute: async () => ({ ok: true }),
    })
    const searchable = new ToolExecutor(registry)
    const frozenContext = { ...context, frozenDeferredToolNames: ['deferred_example'] }
    const result = await searchable.execute<any>(
      'ToolSearch',
      { query: 'select:deferred_example' },
      frozenContext,
    )
    expect(result.addedToolNames).toEqual(['deferred_example'])
    await expect(
      searchable.execute('ToolSearch', { query: 'select:new_deferred_example' }, frozenContext),
    ).rejects.toMatchObject({ code: 'DEFERRED_TOOL_NOT_FOUND' })

    // 普通搜索命中即激活，浏览与分页只覆盖冻结后的延迟信封。
    const searched = await searchable.execute<any>('ToolSearch', { query: '示例' }, frozenContext)
    expect(searched.addedToolNames).toEqual(['deferred_example'])
    expect(searched.total).toBe(1)
    const browsed = await searchable.execute<any>('ToolSearch', { query: '*' }, frozenContext)
    expect(browsed.addedToolNames).toEqual(['deferred_example'])
    expect(
      await searchable.execute<any>('ToolSearch', { query: '*', offset: 1 }, frozenContext),
    ).toMatchObject({ tools: [], total: 1, offset: 1, addedToolNames: [] })
    // 同一个注册表：冻结信封只暴露冻结项，未冻结的实时范围不参与本轮激活。
    await expect(
      searchable.execute<any>('ToolSearch', { query: 'select:new_deferred_example' }, context),
    ).resolves.toMatchObject({ addedToolNames: ['new_deferred_example'] })

    const progress: unknown[] = []
    await writeFile(
      join(context.workspace.rootPath, 'progress.png'),
      Buffer.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
        0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 96, 0, 0, 0, 2, 0, 1,
        226, 33, 188, 51, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
      ]),
    )
    await executor.execute(
      'Read',
      { file_path: 'progress.png' },
      { ...context, onProgress: (item) => progress.push(item) },
    )
    expect(progress).toEqual([{ message: '正在读取 progress.png' }])
  })

  test('能力目录把延迟工具名称、描述与 MCP 来源写入冻结提示词', async () => {
    const { registry, executor } = await deferredToolExecutor()
    registerDeferredTool(registry, 'browser.open', '打开并操作浏览器页面')
    registerDeferredTool(registry, 'mcp_report', '生成 MCP 报告', {
      kind: 'mcp',
      serverName: 'demo-server',
      rawToolName: 'report',
      generation: 1,
    })
    const runtime = new AgentRuntimeService({
      db: {} as never,
      hub: {} as never,
      models: {} as never,
      toolExecutor: executor,
      contextCompaction: {} as never,
    })
    const input = {
      taskMode: 'chat' as const,
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'auto_review' as const,
      profile: 'main' as const,
    }
    const section = runtime.capabilityCatalog(input)
    expect(section.id).toBe('capabilities.catalog')
    expect(section.content).toContain('- browser.open: 打开并操作浏览器页面')
    expect(section.content).toContain('- mcp_report: 生成 MCP 报告 [mcp:demo-server]')
    const bundle = new PromptComposer().compose({
      threadID: 'thread',
      mode: 'chat',
      profile: 'main',
      exposedTools: ['Read'],
      sections: [section],
    })
    expect(bundle.instructions).toContain('mcp_report')
    expect(bundle.instructions).toContain('offset')
    // 受限范围不能被搜索或目录扩大：allowlist 收紧后目录只保留允许发现的工具。
    expect(
      runtime.capabilityCatalog({ ...input, allowedTools: ['browser.open'] }).content,
    ).not.toContain('mcp_report')
  })

  test('真实运行时冻结能力目录、激活搜索结果，预览使用工作区 MCP 且恢复不扩大范围', async () => {
    const { root, workspace, executor } = await deferredToolExecutor()
    const registry = new ToolRegistry()
    registerDeferredTool(registry, 'mcp_report', '生成 MCP 报告', {
      kind: 'mcp',
      serverName: 'demo-server',
      rawToolName: 'report',
      generation: 1,
    })
    const db = new AgentDatabase({
      historyPath: join(root, 'history.sqlite'),
      profilePath: join(root, 'profile.sqlite'),
    })
    const faux = fauxProvider({ models: [{ id: 'test', input: ['text'], contextWindow: 64_000 }] })
    const models = createModels()
    models.setProvider(faux.provider)
    const permissionConfig = {
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'auto_review' as const,
      approvalsReviewer: 'auto_review' as const,
    }
    const model = { providerID: faux.getModel().provider, id: 'test' } as never
    const thread = db.createThread()
    const turn = db.createTurn(thread.id, {
      content: 'find',
      model,
      permissionConfig,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(turn.turnID)
    const runtime = new AgentRuntimeService({
      db,
      models,
      toolExecutor: executor,
      hub: { publish: () => Effect.succeed(undefined) } as never,
      contextCompaction: new ContextCompactionService(db),
    })
    const request = {
      threadID: thread.id,
      turnID: turn.turnID,
      agentID: turn.agentID,
      sessionID: crypto.randomUUID(),
      content: 'find',
      taskMode: 'chat' as const,
      fallbackModel: model,
      permissionConfig,
      signal: new AbortController().signal,
      workspace,
      toolCatalog: registry,
      promptSections: [],
      resolveModel: async () => ({ ref: model, model: faux.getModel() }),
      pause: async () => {
        throw new Error('unexpected pause')
      },
    }
    const prompts: string[] = []
    const capture = (context: TranscriptContext) => {
      const system = getInitialSystemMessage(context.messages)
      prompts.push(
        typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content),
      )
      return fauxAssistantMessage('done')
    }
    let deferredResult: TranscriptContext['messages'][number] | undefined
    faux.setResponses([
      (context: TranscriptContext) => {
        capture(context)
        return fauxAssistantMessage(fauxToolCall('ToolSearch', { query: 'report' }), {
          stopReason: 'toolUse',
        })
      },
      (context: TranscriptContext) => {
        expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain('mcp_report')
        return fauxAssistantMessage(fauxToolCall('mcp_report', {}), { stopReason: 'toolUse' })
      },
      (context: TranscriptContext) => {
        deferredResult = context.messages.at(-1)
        return capture(context)
      },
    ])
    try {
      let previewReads = 0
      const threads = new ThreadService(
        db,
        {} as never,
        {} as never,
        {} as never,
        { setResumeHandler: () => undefined } as never,
        runtime,
        { setParentResumeHandler: () => undefined } as never,
        {} as never,
        { dataRoot: root, userHome: root },
        {
          inject: async () => ({ sections: [], ignored: false }),
          defaultScopes: () => [{ kind: 'user' }],
          enqueueExtract: () => null,
        } as never,
        {} as never,
        {
          resolve: async () => ({
            kind: 'projectless',
            workspaceRoot: root,
            cwd: root,
            outputDirectory: root,
          }),
        } as never,
        undefined,
        undefined,
        {
          previewCatalog: async (cwd: string) => {
            expect(cwd).toBe(root)
            previewReads++
            return {
              catalog: registry,
              serverInstructions: [],
            }
          },
        } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      )
      const settingsBeforePreview = db.getThreadPromptSettings(thread.id)
      const preview = await threads.promptPreview(thread.id)
      expect(db.getThreadPromptSettings(thread.id)).toEqual(settingsBeforePreview)
      const previewCatalog = preview.sections.find(
        (section) => section.id === 'capabilities.catalog',
      )!
      expect(previewCatalog.content).toContain('mcp_report')
      expect(previewReads).toBe(1)
      expect(preview.previewKind).toBe('estimated')
      await runtime.run(request)
      expect(deferredResult).toMatchObject({ role: 'toolResult', isError: false })
      expect(prompts[0]).toContain('mcp_report')
      expect(prompts[0]).toContain('[mcp:demo-server]')
      const repository = new RuntimeCompositionRepository(db)
      const frozen = repository.get(turn.turnID)!.snapshot
      expect(frozen.prompt.instructions).toContain(previewCatalog.content)
      expect(frozen.tools.deferred).toContain('mcp_report')
      const frozenPreview = await threads.promptPreview(thread.id)
      expect(frozenPreview.previewKind).toBe('frozen')
      if (frozenPreview.previewKind !== 'frozen') throw new Error('expected frozen preview')
      expect(frozenPreview.turnId).toBe(turn.turnID)
      expect(frozenPreview.compositionId).toBe(frozen.identity.id)
      expect(frozenPreview.instructions).toBe(frozen.prompt.instructions)
      expect(frozenPreview.baseHash).toBe(frozen.prompt.baseHash)
      expect(frozenPreview.sections).toEqual([])
      expect(previewReads).toBe(1)
      expect(repository.latestForThread(thread.id)?.turnID).toBe(turn.turnID)

      registerDeferredTool(registry, 'new_live_tool', '新工具')
      faux.setResponses([capture])
      await runtime.run({ ...request, resume: { state: '', interruption: null, answer: null } })
      expect(prompts.at(-1)).not.toContain('new_live_tool')
      expect(repository.get(turn.turnID)!.snapshot.identity.hash).toBe(frozen.identity.hash)
      db.updateTurnStatus(turn.turnID, 'completed')
      expect((await threads.promptPreview(thread.id)).previewKind).toBe('frozen')
      db.sqlite
        .query("UPDATE runtime_composition_plans SET snapshot_hash = 'invalid' WHERE turn_id = ?")
        .run(turn.turnID)
      await expect(threads.promptPreview(thread.id)).rejects.toMatchObject({
        code: 'RUNTIME_COMPOSITION_UNAVAILABLE',
      })
      expect(previewReads).toBe(1)
      const goals = new ThreadGoalService(db, await Effect.runPromise(EventHub.make))
      await goals.set({
        threadId: thread.id,
        objective: 'preview goal',
        expectedVersion: null,
        operationId: 'preview-goal',
      })
      db.saveThreadPromptSettings(thread.id, {
        engine: 'prompt-engine-v2',
        version: 2,
        settings: { appendSystemPrompt: 'APPEND_PREFERENCE', defaultModeRequestUserInput: true },
      })
      const next = db.createTurn(thread.id, {
        content: 'next',
        model,
        permissionConfig,
        strategy: 'queue',
        taskMode: 'chat',
      })
      db.claimTurnExecution(next.turnID)
      const estimated = await threads.promptPreview(thread.id)
      expect(estimated.previewKind).toBe('estimated')
      expect(estimated.instructions).toContain('A goal is attached to this thread')
      expect(estimated.instructions).toContain('APPEND_PREFERENCE')
      expect(previewReads).toBe(2)
    } finally {
      await runtime.dispose()
      db.close()
    }
  })
  test('Pi 工具适配器归一化批量 Edit 与 Read 路径参数', async () => {
    const { executor } = await fixture()
    const options = { executor, request: {} as never }
    const edit = adaptToolDefinition(executor.definition('Edit'), options)
    expect(
      edit.prepareArguments?.({
        path: 'source.txt',
        edits: JSON.stringify([{ oldText: 'before', newText: 'after' }]),
      }),
    ).toEqual({
      path: 'source.txt',
      edits: [{ oldText: 'before', newText: 'after' }],
    })

    const read = adaptToolDefinition(executor.definition('Read'), options)
    expect(read.prepareArguments?.({ path: 'notes.txt', limit: 20 })).toEqual({
      file_path: 'notes.txt',
      limit: 20,
    })
  })

  test('Write 和 Edit 无需预读即可写入，但在并发冲突时拒绝陈旧修订', async () => {
    const { root, workspace, executor, context } = await fixture()
    const path = join(root, 'source.txt')
    await writeFile(path, 'before', 'utf8')
    const saveEditorFile = workspace.saveEditorFile.bind(workspace)
    workspace.saveEditorFile = async (targetPath, content, expectedRevision) => {
      await writeFile(path, 'changed elsewhere', 'utf8')
      return saveEditorFile(targetPath, content, expectedRevision)
    }
    await expect(
      executor.execute('Write', { file_path: 'source.txt', content: 'overwrite' }, context),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_STALE' })
    await expect(
      executor.execute(
        'Edit',
        {
          path: 'source.txt',
          edits: [{ oldText: 'changed elsewhere', newText: 'edited' }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_STALE' })
  })

  test('Edit 基于同一原文原子应用多项编辑', async () => {
    const { root, executor, context } = await fixture()
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const path = join(root, 'batch.txt')
    await writeFile(path, Buffer.concat([bom, Buffer.from('first middle last', 'utf8')]))
    await executor.execute(
      'Edit',
      {
        path: 'batch.txt',
        edits: [
          { oldText: 'first', newText: '1' },
          { oldText: 'last', newText: '3' },
        ],
      },
      context,
    )
    expect(
      await Bun.file(path)
        .arrayBuffer()
        .then((value) => Buffer.from(value)),
    ).toEqual(Buffer.concat([bom, Buffer.from('1 middle 3', 'utf8')]))
  })

  test('Write 和 Edit 返回准确的逐行增删统计及安全 Pi 摘要', async () => {
    const { root, executor, context } = await fixture()
    await writeFile(join(root, 'source.txt'), 'first\nbefore\nlast\n', 'utf8')
    const write = await executor.execute<{
      additions: number
      deletions: number
    }>(
      'Write',
      {
        file_path: 'source.txt',
        content: 'first\nafter\nnext\nlast\n',
      },
      context,
    )
    expect(write).toMatchObject({ additions: 2, deletions: 1 })

    const edit = await executor.execute<{
      additions: number
      deletions: number
    }>(
      'Edit',
      {
        path: 'source.txt',
        edits: [{ oldText: 'after\nnext', newText: 'done' }],
      },
      context,
    )
    expect(edit).toMatchObject({ additions: 1, deletions: 2 })
    expect(lineChangeSummary('same\n', 'same\n')).toEqual({ additions: 0, deletions: 0 })

    const formatted = executor.definition('Edit').formatResult?.(
      {
        operation: 'edit',
        path: 'source.txt',
        additions: 1,
        deletions: 2,
        beforeSha256: 'before-secret',
        afterSha256: 'after-secret',
      },
      {} as never,
    )
    expect(formatted).toEqual({
      content: '已编辑 source.txt（+1 -2）',
      details: {
        operation: 'edit',
        path: 'source.txt',
        additions: 1,
        deletions: 2,
      },
    })
  })

  test('Edit 在上下文不唯一或编辑范围重叠时保持文件不变', async () => {
    const { root, executor, context } = await fixture()
    const ambiguousPath = join(root, 'ambiguous.txt')
    await writeFile(ambiguousPath, 'same middle same', 'utf8')
    await expect(
      executor.execute(
        'Edit',
        {
          path: 'ambiguous.txt',
          edits: [{ oldText: 'same', newText: 'next' }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'PATCH_CONTEXT_AMBIGUOUS' })
    expect(await Bun.file(ambiguousPath).text()).toBe('same middle same')

    const overlapPath = join(root, 'overlap.txt')
    await writeFile(overlapPath, 'abcdef', 'utf8')
    await expect(
      executor.execute(
        'Edit',
        {
          path: 'overlap.txt',
          edits: [
            { oldText: 'abc', newText: 'left' },
            { oldText: 'bcd', newText: 'right' },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'PATCH_OVERLAPPING_HUNKS' })
    expect(await Bun.file(overlapPath).text()).toBe('abcdef')
  })

  test('Edit 将 LF 上下文应用到 CRLF 文件并保持原换行', async () => {
    const { root, executor, context } = await fixture()
    const path = join(root, 'crlf.txt')
    await writeFile(path, 'first\r\nalpha\r\nbeta\r\n--\r\nsecond\r\nalpha\r\nbeta\r\n', 'utf8')
    await executor.execute(
      'Edit',
      {
        path: 'crlf.txt',
        edits: [
          { oldText: 'first\nalpha\nbeta', newText: 'first\ngamma\ndelta' },
          { oldText: 'second\nalpha\nbeta', newText: 'second\ngamma\ndelta' },
        ],
      },
      context,
    )
    expect(await Bun.file(path).text()).toBe(
      'first\r\ngamma\r\ndelta\r\n--\r\nsecond\r\ngamma\r\ndelta\r\n',
    )
  })

  test('Edit 不会把裸 LF 精确命中到 CRLF 的中间位置', async () => {
    const { root, executor, context } = await fixture()
    const path = join(root, 'crlf-boundary.txt')
    await writeFile(path, 'a\r\nb\r\n', 'utf8')
    await executor.execute(
      'Edit',
      { path: 'crlf-boundary.txt', edits: [{ oldText: '\nb', newText: '\nc' }] },
      context,
    )
    expect(await Bun.file(path).text()).toBe('a\r\nc\r\n')
  })

  test('Edit 使用同一文件的绝对和相对路径均可连续修改', async () => {
    const { root, executor, context } = await fixture()
    const path = join(root, 'source.txt')
    await writeFile(path, 'before', 'utf8')
    await executor.execute(
      'Edit',
      {
        path,
        edits: [{ oldText: 'before', newText: 'middle' }],
      },
      context,
    )
    await executor.execute(
      'Edit',
      {
        path: 'source.txt',
        edits: [{ oldText: 'middle', newText: 'after' }],
      },
      context,
    )
    expect(await Bun.file(path).text()).toBe('after')
  })

  test('Write 自动创建缺失父目录，写入受保护的 .git/hooks 目标触发高风险审批且 authorizationOnly 不落盘', async () => {
    const reviewed: any[] = []
    const { root, executor, context } = await fixture({
      authorizeShell: async (invocation) => {
        reviewed.push(invocation)
        return { decision: 'allow', risk: 'high', reason: 'approved' }
      },
    })
    const written = await executor.execute<any>(
      'Write',
      { file_path: 'src/core/writer.ts', content: 'export const written = 1\n' },
      context,
    )
    expect(written).toMatchObject({
      operation: 'write',
      mutation: 'create',
      path: 'src/core/writer.ts',
    })
    expect(await Bun.file(join(root, 'src/core/writer.ts')).text()).toBe(
      'export const written = 1\n',
    )

    await mkdir(join(root, '.git', 'hooks'), { recursive: true })
    const decision = await executor.execute<any>(
      'Write',
      { file_path: '.git/hooks/pre-commit', content: 'hook\n' },
      {
        ...context,
        authorizationOnly: true,
        permissionConfig: {
          sandboxMode: 'workspace-write',
          approvalPolicy: 'auto_review',
          approvalsReviewer: 'auto_review',
        },
      },
    )
    expect(decision).toMatchObject({
      decision: 'allow',
      authorizationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(reviewed.at(-1)?.permissionFacts).toMatchObject({
      risk: 'high',
      ruleRequiresApproval: true,
    })
    expect(await Bun.file(join(root, '.git', 'hooks', 'pre-commit')).exists()).toBe(false)
  })

  test('exec_command schema 禁止旧后台/沙箱绕过字段，且不暴露已移除搜索与读文件工具', async () => {
    const { executor, context } = await fixture()
    await expect(
      executor.execute('exec_command', { command: 'Get-Date', run_in_background: true }, context),
    ).rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT' })
    await expect(
      executor.execute(
        'exec_command',
        { command: 'pwd', shell: 'bash', dangerouslyDisableSandbox: true },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT' })
    await expect(
      executor.execute('Glob', { pattern: '*.ts' }, context),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' })
    await expect(
      executor.execute('Grep', { pattern: 'needle' }, context),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' })
    await expect(
      executor.execute('apply_patch', { patch: '*** Begin Patch\n*** End Patch' }, context),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' })
    await expect(
      executor.execute('view_image', { path: 'sample.png' }, context),
    ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' })
  })

  test('commitEditorMutations 在审批预检后磁盘变更时拒绝删除且不破坏原文件', async () => {
    const { root, context } = await fixture()
    await writeFile(join(root, 'old.txt'), 'one\n', 'utf8')
    const inspection = await context.workspace.inspectMutationPath('old.txt', 'existing-file')
    if (inspection.expectation !== 'existing-file') throw new Error('expected existing-file')
    await writeFile(join(root, 'old.txt'), 'changed elsewhere\n', 'utf8')
    await expect(
      context.workspace.commitEditorMutations([
        { operation: 'delete', path: 'old.txt', expectedRevision: inspection.revision },
      ]),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_STALE' })
    expect(await Bun.file(join(root, 'old.txt')).text()).toBe('changed elsewhere\n')
  })

  test('文件修改失败日志记录安全阶段和统计且不包含路径或正文', async () => {
    const warnings: Array<{ event: string; fields: Record<string, unknown> }> = []
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      error: () => undefined,
      warn: (event: string, fields: Record<string, unknown>) => warnings.push({ event, fields }),
    } as unknown as NonNullable<ToolExecutorOptions['logger']>
    const hooks = {
      run: async (event: string) => {
        if (event.startsWith('post_tool_')) throw new Error('post hook secret')
        return []
      },
    } as unknown as NonNullable<ToolExecutorOptions['hooks']>
    const { root, executor, context } = await fixture({ logger, hooks })

    await expect(
      executor.execute(
        'Write',
        {
          file_path: 'C:\\Users\\Alice\\private.txt',
          content: 7,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT' })

    await expect(
      executor.execute(
        'Write',
        {
          file_path: 'denied.txt',
          content: 'authorization-secret',
        },
        {
          ...context,
          permissionConfig: {
            sandboxMode: 'read-only',
            approvalPolicy: 'never',
            approvalsReviewer: 'auto_review',
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })

    await writeFile(join(root, 'existing.txt'), 'old', 'utf8')
    await expect(
      executor.execute(
        'Edit',
        {
          path: 'existing.txt',
          edits: [{ oldText: 'execute-secret', newText: 'updated' }],
        },
        context,
      ),
    ).rejects.toBeInstanceOf(AgentError)

    await executor.execute(
      'Write',
      {
        file_path: 'created.txt',
        content: 'post-hook-secret',
      },
      context,
    )

    const fileFailures = warnings.filter(({ event }) => event === 'file-tool.execution.failed')
    const phases = fileFailures.map(({ fields }) => (fields.details as { phase: string }).phase)
    expect(phases).toContain('normalize')
    expect(phases).toContain('authorization')
    expect(phases).toContain('execute')
    expect(phases).toContain('post-hook')
    const serialized = JSON.stringify(fileFailures)
    expect(serialized).not.toContain('Alice')
    expect(serialized).not.toContain('authorization-secret')
    expect(serialized).not.toContain('execute-secret')
    expect(serialized).not.toContain('post-hook-secret')
    expect(serialized).not.toContain('post hook secret')
    expect(serialized).toContain('[outside-workspace]')
    expect(serialized).toContain('"inputBytes":')
  })

  test('Read 支持文本、图片、PDF、音频、视频与二进制文件并脱敏审计与拒绝损坏图片', async () => {
    const { executor, context, root } = await fixture()
    const pngBytes = Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
      0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 96, 0, 0, 0, 2, 0, 1, 226,
      33, 188, 51, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ])
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n', 'utf8')
    const mp3Bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00])
    const mp4Bytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32])
    const binBytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x10, 0x20])

    await writeFile(join(root, 'sample.png'), pngBytes)
    await writeFile(join(root, 'broken.png'), 'not-a-png', 'utf8')
    await writeFile(join(root, 'notes.txt'), 'line-1\nline-2\nline-3', 'utf8')
    await writeFile(join(root, 'doc.pdf'), pdfBytes)
    await writeFile(join(root, 'audio.mp3'), mp3Bytes)
    await writeFile(join(root, 'clip.mp4'), mp4Bytes)
    await writeFile(join(root, 'blob.bin'), binBytes)

    let skillReadCount = 0
    const imageResult = await executor.execute<any>(
      'Read',
      { file_path: 'sample.png' },
      {
        ...context,
        onSkillDocumentRead: async () => {
          skillReadCount += 1
          return undefined
        },
      },
    )
    expect(skillReadCount).toBe(0)
    expect(imageResult).toMatchObject({
      kind: 'image',
      path: 'sample.png',
      mimeType: 'image/png',
      sizeBytes: pngBytes.byteLength,
      base64: pngBytes.toString('base64'),
    })

    const definition = executor.definition('Read')
    expect(definition.auditResult?.(imageResult)).toEqual({
      kind: 'image',
      path: 'sample.png',
      mimeType: 'image/png',
      sizeBytes: pngBytes.byteLength,
    })
    expect(definition.formatResult?.(imageResult, context as never)).toEqual({
      content: JSON.stringify(
        {
          path: 'sample.png',
          kind: 'image',
          mimeType: 'image/png',
          sizeBytes: pngBytes.byteLength,
        },
        null,
        2,
      ),
      details: {
        path: 'sample.png',
        kind: 'image',
        mimeType: 'image/png',
        sizeBytes: pngBytes.byteLength,
      },
      images: [{ type: 'image', data: pngBytes.toString('base64'), mimeType: 'image/png' }],
      structuredContent: false,
    })

    const textResult = await executor.execute<any>(
      'Read',
      { path: 'notes.txt', offset: 1, limit: 1 },
      context,
    )
    expect(textResult).toMatchObject({
      path: 'notes.txt',
      content: 'line-2',
      offset: 1,
      lineCount: 3,
      truncated: true,
    })

    const pdfResult = await executor.execute<any>('Read', { file_path: 'doc.pdf' }, context)
    expect(pdfResult).toMatchObject({
      kind: 'pdf',
      path: 'doc.pdf',
      mimeType: 'application/pdf',
      pageCount: 1,
      encoding: 'base64',
      truncated: false,
      base64: pdfBytes.toString('base64'),
    })
    expect(definition.auditResult?.(pdfResult)).not.toHaveProperty('base64')

    expect(await executor.execute<any>('Read', { file_path: 'audio.mp3' }, context)).toMatchObject({
      kind: 'audio',
      mimeType: 'audio/mpeg',
      encoding: 'base64',
    })
    expect(await executor.execute<any>('Read', { file_path: 'clip.mp4' }, context)).toMatchObject({
      kind: 'video',
      mimeType: 'video/mp4',
      encoding: 'base64',
    })
    expect(await executor.execute<any>('Read', { file_path: 'blob.bin' }, context)).toMatchObject({
      kind: 'binary',
      mimeType: 'application/octet-stream',
      encoding: 'base64',
      base64: binBytes.toString('base64'),
    })

    await expect(
      executor.execute('Read', { file_path: 'broken.png' }, context),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_UNREADABLE' })

    await expect(
      executor.execute(
        'Edit',
        { path: 'sample.png', edits: [{ oldText: 'PNG', newText: 'JPG' }] },
        context,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_UNREADABLE' })

    const outsideDir = await mkdtemp(join(tmpdir(), 'pidex-outside-img-'))
    temporary.push(outsideDir)
    const outsidePng = join(outsideDir, 'outside.png')
    await writeFile(outsidePng, pngBytes)
    await expect(context.workspace.readImageFile(outsidePng)).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_DENIED',
    })
    await expect(
      executor.execute('Read', { file_path: '../outside.png' }, context),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_DENIED' })
    const outsideResult = await executor.execute<any>('Read', { file_path: outsidePng }, context)
    expect(outsideResult).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: pngBytes.byteLength,
    })
  })
})
