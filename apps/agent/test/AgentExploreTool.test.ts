import { afterEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import { DEFAULT_PERMISSION_CONFIG } from '@pidex/shared/thread'
import { AgentRuntimeService } from '../src/orchestration/AgentRuntimeService'
import type { AgentRuntimeRequest } from '../src/orchestration/AgentRuntimeTypes'
import { ContextCompactionService } from '../src/context/ContextCompactionService'
import { createPromptSections } from '../src/prompt/Sections'
import { ThreadBookmarkService } from '../src/session/ThreadBookmarkService'
import { ThreadService } from '../src/session/ThreadService'
import { SubagentService } from '../src/subagent/SubagentService'
import { AgentDatabase } from '../src/storage/database/AgentDatabase'
import { EventHub } from '../src/storage/events/EventHub'
import { SqlitePiSessionRepo } from '../src/storage/pi-session/SqlitePiSession'
import { ToolExecutor } from '../src/tool/ToolExecutor'
import { ToolRegistry } from '../src/tool/ToolRegistry'
import { ThreadProjection } from '../src/transport/ThreadProjection'
import { WorkspaceService } from '../src/workspace/WorkspaceService'
import type { AgentModelCatalog } from '../src/provider/AgentModelCatalog'

const tempDirs: string[] = []
const databases: AgentDatabase[] = []

const tempRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidex-agent-explore-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (databases.length) databases.pop()!.close()
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

const permission = {
  ...DEFAULT_PERMISSION_CONFIG,
  sandboxMode: 'workspace-write' as const,
  approvalPolicy: 'never' as const,
}

describe('Glob and Grep explorer-only tools', () => {
  test('Glob 和 Grep 仅向 explorer 开放，并在工作区内正确检索且跳过构建目录', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'src', 'feature'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'src', 'feature', 'viewer.ts'), 'export const ViewerKind = "image"\n')
    writeFileSync(join(root, 'src', 'feature', 'other.md'), '# Notes\nViewerKind mentioned\n')
    writeFileSync(
      join(root, 'node_modules', 'pkg', 'index.ts'),
      'export const ViewerKind = "ignored"\n',
    )

    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: 'test' }),
    })
    const workspace = await WorkspaceService.open(root)
    const explorerContext = {
      threadID: 'thread-1',
      turnID: 'turn-1',
      taskMode: 'chat' as const,
      profile: 'explorer' as const,
      signal: new AbortController().signal,
      workspace,
      permissionConfig: permission,
    }

    await expect(
      executor.execute('Glob', { pattern: '**/*.ts' }, { ...explorerContext, profile: 'main' }),
    ).rejects.toThrow()
    await expect(
      executor.execute(
        'Grep',
        { pattern: 'ViewerKind' },
        { ...explorerContext, profile: 'worker' },
      ),
    ).rejects.toThrow()

    const globResult = (await executor.execute(
      'Glob',
      { pattern: '**/*.ts' },
      explorerContext,
    )) as { filenames: string[]; numFiles: number }
    expect(globResult.filenames).toEqual(['src/feature/viewer.ts'])
    expect(globResult.numFiles).toBe(1)

    const grepFiles = (await executor.execute(
      'Grep',
      { pattern: 'ViewerKind', glob: '*.ts', output_mode: 'files_with_matches' },
      explorerContext,
    )) as { output: string; numResults: number }
    expect(grepFiles.output).toBe('src/feature/viewer.ts')
    expect(grepFiles.numResults).toBe(1)

    const grepContent = (await executor.execute(
      'Grep',
      { pattern: 'viewerkind', '-i': true, output_mode: 'content' },
      explorerContext,
    )) as { output: string }
    expect(grepContent.output).toContain('src/feature/viewer.ts:1:')
    expect(grepContent.output).not.toContain('node_modules')
  })
})

describe('Agent tool sync parallel, fork, and explorer optimization', () => {
  const createRuntimeFixture = async (
    responses: Array<Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0][number]>,
  ) => {
    const root = tempRoot()
    const db = new AgentDatabase({
      historyPath: join(root, 'history.sqlite'),
      profilePath: join(root, 'profile.sqlite'),
    })
    databases.push(db)
    const hub = await Effect.runPromise(EventHub.make)
    const faux = fauxProvider({
      models: [{ id: 'explore-test', input: ['text'], contextWindow: 64_000 }],
    })
    faux.setResponses(responses)
    const models = createModels()
    models.setProvider(faux.provider)
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: 'test' }),
    })
    const runtime = new AgentRuntimeService({
      db,
      hub,
      models,
      toolExecutor: executor,
      contextCompaction: new ContextCompactionService(db),
    })
    const modelRef = { providerID: faux.getModel().provider, id: 'explore-test' } as never
    return { root, db, hub, faux, models, executor, runtime, modelRef }
  }

  test('同轮并发同步 Agent(explorer) 触发统一 waiting_subagents checkpoint，并在恢复后注入全部子结果', async () => {
    const { root, db, faux, runtime, modelRef } = await createRuntimeFixture([
      fauxAssistantMessage([
        fauxToolCall('Agent', {
          description: 'Explore module A',
          prompt: 'Map module A',
          subagent_type: 'explorer',
        }),
        fauxToolCall('Agent', {
          description: 'Explore module B',
          prompt: 'Map module B',
          subagent_type: 'explorer',
        }),
      ]),
      (context) => {
        const serialized = JSON.stringify(context.messages)
        expect(serialized).toContain('Module A summary')
        expect(serialized).toContain('Module B summary')
        return fauxAssistantMessage('Combined analysis ready.')
      },
    ])
    const workspace = await WorkspaceService.open(root)
    const thread = db.createThread()
    const turn = db.createTurn(thread.id, {
      content: 'Compare module A and B',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(turn.turnID)
    const sessionID = crypto.randomUUID()
    let counter = 0
    const pausedApprovals: any[] = []
    const delegation = {
      spawn: async (input: { agents: Array<{ profile: string; task: string }> }) => {
        counter += 1
        return {
          agents: input.agents.map((agent) => ({
            taskId: `task-${counter}`,
            runId: `run-${counter}`,
            childThreadId: `child-${counter}`,
            displayName: `Explorer ${counter}`,
            profile: agent.profile,
          })),
        }
      },
      isWaitSatisfied: async () => false,
      wait: async ({ runIDs }: { runIDs: string[] }) => ({
        mode: 'all',
        runs: runIDs.map((id) => ({
          id,
          taskId: id === 'run-1' ? 'task-1' : 'task-2',
          status: 'completed',
          result: {
            outcome: 'succeeded',
            summary: id === 'run-1' ? 'Module A summary' : 'Module B summary',
            findings: [],
            changedFiles: [],
            validation: [],
            risks: [],
            references: [],
          },
          error: null,
        })),
      }),
      send: async () => ({}),
      stop: async () => ({}),
    }

    const firstResult = await runtime.run({
      threadID: thread.id,
      turnID: turn.turnID,
      agentID: turn.agentID,
      sessionID,
      content: 'Compare module A and B',
      taskMode: 'chat',
      fallbackModel: modelRef,
      permissionConfig: permission,
      signal: new AbortController().signal,
      workspace,
      delegation,
      promptSections: createPromptSections({
        permissionInstructions: 'allow',
        mode: 'chat',
        profile: 'main',
        userMessage: 'Compare module A and B',
      }),
      resolveModel: async () => ({ ref: modelRef, model: faux.getModel() }),
      pause: async (approval) => {
        pausedApprovals.push(approval)
      },
    })

    expect(firstResult.status).toBe('paused')
    expect(pausedApprovals).toHaveLength(1)
    const approval = pausedApprovals[0]!
    expect(approval.kind).toBe('subagents')
    expect(approval.runIDs).toEqual(['run-1', 'run-2'])
    expect(Object.values(approval.checkpoint.interruption.toolCallRuns)).toEqual(['run-1', 'run-2'])

    const resumed = await runtime.run({
      threadID: thread.id,
      turnID: turn.turnID,
      agentID: turn.agentID,
      sessionID,
      content: 'Compare module A and B',
      taskMode: 'chat',
      fallbackModel: modelRef,
      permissionConfig: permission,
      signal: new AbortController().signal,
      workspace,
      delegation,
      resume: {
        state: approval.checkpoint.state,
        interruption: approval.checkpoint.interruption,
        toolCallID: approval.toolCallID,
        answer: null,
      },
      promptSections: createPromptSections({
        permissionInstructions: 'allow',
        mode: 'chat',
        profile: 'main',
        userMessage: 'Compare module A and B',
      }),
      resolveModel: async () => ({ ref: modelRef, model: faux.getModel() }),
      pause: async () => {},
    })

    expect(resumed).toEqual({ status: 'completed', output: 'Combined analysis ready.' })
  })

  test('Chat 模式省略 subagent_type 触发异步 Fork 并复用父指令与 cacheKey；Plan 模式省略则走 explorer', async () => {
    const { root, db, hub, faux, runtime, modelRef } = await createRuntimeFixture([
      fauxAssistantMessage([
        fauxToolCall('Agent', {
          description: 'Fork background audit',
          prompt: 'Audit recent changes in background',
        }),
      ]),
      fauxAssistantMessage('Started background audit.'),
      fauxAssistantMessage([
        fauxToolCall('Agent', {
          description: 'Plan mode explore',
          prompt: 'Find config loader',
        }),
      ]),
      fauxAssistantMessage('Done in plan mode.'),
    ])
    const workspace = await WorkspaceService.open(root)
    let mcpAcquires = 0
    const subagents = new SubagentService(
      db,
      hub,
      {
        resolve: async () => ({ ref: modelRef, model: faux.getModel() }),
        getModel: async () => faux.getModel(),
      } as unknown as AgentModelCatalog,
      { setAgentStatusHandler: () => {}, cancelTurn: () => {} } as never,
      { cancelTurn: () => {} } as never,
      {
        run: async () => ({ status: 'completed', output: 'fork child done' }),
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        clearTurnPermissionGrants: () => {},
      } as never,
      { listByBinding: async () => [] } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        acquire: async () => {
          mcpAcquires += 1
          return { catalog: new ToolRegistry(), serverInstructions: [], release: async () => {} }
        },
      } as never,
      undefined,
      undefined,
      false,
    )
    const pushedNotifications: Array<{ threadID: string; sourceTurnID: string; prompt: string }> =
      []
    subagents.setBackgroundNotifyHandler((threadID, sourceTurnID, prompt) => {
      pushedNotifications.push({ threadID, sourceTurnID, prompt })
    })

    const chatThread = db.createThread()
    const chatTurn = db.createTurn(chatThread.id, {
      content: 'Audit this repo',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(chatTurn.turnID)
    const chatSessionID = crypto.randomUUID()
    const spawnedSnapshots: any[] = []

    const chatResult = await runtime.run({
      threadID: chatThread.id,
      turnID: chatTurn.turnID,
      agentID: chatTurn.agentID,
      sessionID: chatSessionID,
      content: 'Audit this repo',
      taskMode: 'chat',
      fallbackModel: modelRef,
      permissionConfig: permission,
      signal: new AbortController().signal,
      workspace,
      delegation: {
        ...subagents.delegationFor({
          threadID: chatThread.id,
          turnID: chatTurn.turnID,
          agentID: chatTurn.agentID,
          taskMode: 'chat',
          model: modelRef,
          permissionConfig: permission,
          workspaceRoot: root,
        }),
        spawn: async (input, policy) => {
          spawnedSnapshots.push(input)
          return subagents
            .delegationFor({
              threadID: chatThread.id,
              turnID: chatTurn.turnID,
              agentID: chatTurn.agentID,
              taskMode: 'chat',
              model: modelRef,
              permissionConfig: permission,
              workspaceRoot: root,
            })
            .spawn(input, policy)
        },
      },
      promptSections: createPromptSections({
        permissionInstructions: 'allow',
        mode: 'chat',
        profile: 'main',
        userMessage: 'Audit this repo',
      }),
      resolveModel: async () => ({ ref: modelRef, model: faux.getModel() }),
      pause: async () => {
        throw new Error('Fork should run asynchronously without pausing')
      },
    })

    expect(chatResult.status).toBe('completed')
    expect(spawnedSnapshots).toHaveLength(1)
    const forkAgent = spawnedSnapshots[0]!.agents[0]!
    expect(forkAgent.profile).toBe('default')
    expect(forkAgent.fork).toBeDefined()
    expect(forkAgent.fork.placeholderMessages).toHaveLength(1)
    expect(forkAgent.fork.placeholderMessages[0].content[0].text).toBe(
      'Fork started — processing in background',
    )

    // Child Pi session was seeded with parent assistant message + placeholder toolResult
    const tasks = subagents.list(chatThread.id)
    expect(tasks).toHaveLength(1)
    const forkTask = tasks[0]!.task
    const forkContext = subagents.collaboration.forkContext(forkTask.id)
    expect(forkContext).not.toBeNull()
    expect(forkContext!.exposurePlan.exposed).toContain('Agent')
    const childSessionRow = db.sqlite
      .query('SELECT session_id FROM agent_executions WHERE thread_id = ?')
      .get(forkTask.childThreadId) as { session_id: string }
    const childSession = await new SqlitePiSessionRepo(db).openForThread(
      childSessionRow.session_id,
      forkTask.childThreadId,
    )
    const childEntries = await childSession.getEntries()
    expect(
      childEntries.some((entry) => entry.type === 'message' && entry.message.role === 'toolResult'),
    ).toBe(true)
    const deadline = Date.now() + 2000
    while (
      subagents.repository.task(forkTask.id)?.currentRun?.status !== 'completed' &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(subagents.repository.task(forkTask.id)?.currentRun?.status).toBe('completed')
    // Fork does not block parent completion in waiting-subagents, skips redundant mcp acquire,
    // and delivers a single sealed <task-notification> with indented [Subagent hand-back].
    expect(mcpAcquires).toBe(0)
    expect(subagents.collaboration.pending(chatThread.id)).toHaveLength(0)
    expect(pushedNotifications).toHaveLength(1)
    expect(pushedNotifications[0]!.threadID).toBe(chatThread.id)
    expect(pushedNotifications[0]!.sourceTurnID).toBe(chatTurn.turnID)
    expect(pushedNotifications[0]!.prompt).toContain('<task-notification')
    expect(pushedNotifications[0]!.prompt).toContain('[Subagent hand-back')
    expect(pushedNotifications[0]!.prompt).toContain('  fork child done')
    expect(pushedNotifications[0]!.prompt).toContain('[/Subagent hand-back]')
    // INVARIANT: 投递成功后行已 seal，claim 不再返回本批，通知不会重复投递。
    expect(subagents.collaboration.claimReadyBackgroundNotifications(chatThread.id)).toHaveLength(0)
    const forkNotificationStatus = db.sqlite
      .query('SELECT status FROM subagent_background_notifications WHERE task_id = ?')
      .get(forkTask.id) as { status: string } | null
    expect(forkNotificationStatus?.status).toBe('notified')

    // Plan mode omitting subagent_type defaults to explorer (no fork)
    const planThread = db.createThread()
    const planTurn = db.createTurn(planThread.id, {
      content: 'Plan config change',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'plan',
    })
    db.claimTurnExecution(planTurn.turnID)
    const planSpawned: any[] = []
    await runtime.run({
      threadID: planThread.id,
      turnID: planTurn.turnID,
      agentID: planTurn.agentID,
      sessionID: crypto.randomUUID(),
      content: 'Plan config change',
      taskMode: 'plan',
      fallbackModel: modelRef,
      permissionConfig: permission,
      signal: new AbortController().signal,
      workspace,
      delegation: {
        spawn: async (input) => {
          planSpawned.push(input)
          return {
            agents: [
              {
                taskId: 'plan-exp-1',
                runId: 'plan-run-1',
                childThreadId: 'plan-child-1',
                displayName: 'Explorer 1',
                profile: 'explorer',
              },
            ],
          }
        },
        isWaitSatisfied: async () => true,
        wait: async () => ({
          mode: 'all',
          runs: [
            {
              id: 'plan-run-1',
              taskId: 'plan-exp-1',
              status: 'completed',
              result: {
                outcome: 'succeeded',
                summary: 'Found config loader',
                findings: [],
                changedFiles: [],
                validation: [],
                risks: [],
                references: [],
              },
              error: null,
            },
          ],
        }),
        send: async () => ({}),
        stop: async () => ({}),
      },
      promptSections: createPromptSections({
        permissionInstructions: 'allow',
        mode: 'plan',
        profile: 'main',
        userMessage: 'Plan config change',
      }),
      resolveModel: async () => ({ ref: modelRef, model: faux.getModel() }),
      pause: async () => {},
    })
    expect(planSpawned).toHaveLength(1)
    expect(planSpawned[0]!.agents[0]!.profile).toBe('explorer')
    expect(planSpawned[0]!.agents[0]!.fork).toBeUndefined()
  })

  test('Explorer 精简注入跳过 AGENTS.md 与 skills.catalog，并保有 Glob/Grep 引导', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'AGENTS.md'), '# Repo Rules\nDO_NOT_INJECT_INTO_EXPLORER\n')
    mkdirSync(join(root, '.pidex', 'skills', 'demo-skill'), { recursive: true })
    writeFileSync(
      join(root, '.pidex', 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo skill for explorer injection test\n---\nDemo body\n',
    )
    const db = new AgentDatabase({
      historyPath: join(root, 'history.sqlite'),
      profilePath: join(root, 'profile.sqlite'),
    })
    databases.push(db)
    const hub = await Effect.runPromise(EventHub.make)
    const faux = fauxProvider({ models: [{ id: 'exp', input: ['text'], contextWindow: 64_000 }] })
    let capturedSystemPrompt = ''
    let capturedToolNames: string[] = []
    let capturedSectionIds: string[] = []
    const models = createModels()
    models.setProvider(faux.provider)
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: 'test' }),
    })
    const runtime = new AgentRuntimeService({
      db,
      hub,
      models,
      toolExecutor: executor,
      contextCompaction: new ContextCompactionService(db),
    })
    const modelRef = { providerID: faux.getModel().provider, id: 'exp' } as never
    const capturedRequests: any[] = []
    const subagents = new SubagentService(
      db,
      hub,
      {
        resolve: async () => ({ ref: modelRef, model: faux.getModel() }),
        getModel: async () => faux.getModel(),
      } as unknown as AgentModelCatalog,
      { setAgentStatusHandler: () => {}, cancelTurn: () => {} } as never,
      { cancelTurn: () => {} } as never,
      {
        run: async (req: AgentRuntimeRequest) => {
          capturedRequests.push(req)
          const plan = runtime.toolExposure({
            taskMode: req.taskMode,
            sandboxMode: req.permissionConfig.sandboxMode,
            approvalPolicy: req.permissionConfig.approvalPolicy,
            ...(req.profile ? { profile: req.profile } : {}),
          })
          capturedToolNames = [...plan.exposed]
          capturedSectionIds = (req.promptSections ?? []).map((s) => s.id)
          capturedSystemPrompt = (req.promptSections ?? []).map((s) => s.content).join('\n')
          return {
            status: 'completed',
            output: 'done',
            result: {
              outcome: 'succeeded',
              summary: 'done',
              findings: [],
              changedFiles: [],
              validation: [],
              risks: [],
              references: [],
            },
          }
        },
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        clearTurnPermissionGrants: () => {},
      } as never,
      { listByBinding: async () => [] } as never,
      undefined,
      { dataRoot: root, userHome: root },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    )
    const parentThread = db.createThread()
    const parentTurn = db.createTurn(parentThread.id, {
      content: 'Investigate',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(parentTurn.turnID)
    const spawned = await subagents.spawn(
      {
        threadID: parentThread.id,
        turnID: parentTurn.turnID,
        agentID: parentTurn.agentID,
        taskMode: 'chat',
        model: modelRef,
        permissionConfig: permission,
        workspaceRoot: root,
      },
      [{ profile: 'explorer', task: 'Find files' }],
    )
    const expTaskId = spawned.agents[0]!.taskId
    const start = Date.now()
    while (
      subagents.repository.task(expTaskId)?.currentRun?.status !== 'completed' &&
      Date.now() < start + 2000
    ) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(capturedRequests).toHaveLength(1)
    expect(capturedSystemPrompt).not.toContain('DO_NOT_INJECT_INTO_EXPLORER')
    expect(capturedToolNames).toContain('Glob')
    expect(capturedToolNames).toContain('Grep')
    // INVARIANT: explorer 跳过 skills catalog——工作区存在可发现的 Skill，但注入段与文本都不得包含它。
    expect(capturedSectionIds).not.toContain('skills.catalog')
    expect(capturedSystemPrompt).not.toContain('demo-skill')
    expect(capturedSystemPrompt).not.toContain('Skills provide task guidance')
  })

  test('ToolSearch 可按需激活 deferred send_agent 并通过统一执行链调用', async () => {
    const sentMessages: Array<{ taskID: string; message: string }> = []
    const { root, db, faux, runtime, modelRef } = await createRuntimeFixture([
      fauxAssistantMessage([fauxToolCall('ToolSearch', { query: 'select:send_agent' })]),
      fauxAssistantMessage([
        fauxToolCall('send_agent', { taskID: 'task-99', message: 'Check edge cases too' }),
      ]),
      fauxAssistantMessage('Forwarded follow-up to child.'),
    ])
    const workspace = await WorkspaceService.open(root)
    const thread = db.createThread()
    const turn = db.createTurn(thread.id, {
      content: 'Follow up with task-99',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(turn.turnID)

    const result = await runtime.run({
      threadID: thread.id,
      turnID: turn.turnID,
      agentID: turn.agentID,
      sessionID: crypto.randomUUID(),
      content: 'Follow up with task-99',
      taskMode: 'chat',
      fallbackModel: modelRef,
      permissionConfig: permission,
      signal: new AbortController().signal,
      workspace,
      collaborationEnabled: true,
      delegation: {
        spawn: async () => ({ agents: [] }),
        wait: async () => ({ mode: 'all', runs: [] }),
        isWaitSatisfied: async () => true,
        send: async (input) => {
          sentMessages.push({ taskID: input.taskID, message: input.message })
          return { accepted: true }
        },
        stop: async () => ({}),
      },
      promptSections: createPromptSections({
        permissionInstructions: 'allow',
        mode: 'chat',
        profile: 'main',
        userMessage: 'Follow up with task-99',
      }),
      resolveModel: async () => ({ ref: modelRef, model: faux.getModel() }),
      pause: async () => {},
    })

    expect(result).toEqual({ status: 'completed', output: 'Forwarded follow-up to child.' })
    expect(sentMessages).toEqual([{ taskID: 'task-99', message: 'Check edge cases too' }])
  })

  test('Glob/Grep 可检索 dist 与 build 等产物目录，仅默认跳过 .git 与 node_modules', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'dist', 'assets'), { recursive: true })
    mkdirSync(join(root, 'build'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(
      join(root, 'dist', 'assets', 'bundle.js'),
      'const attachmentViewer = "lightbox";\n',
    )
    writeFileSync(join(root, 'build', 'app.js'), 'const attachmentViewer = "build";\n')
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'const attachmentViewer = "nm";\n')
    const workspace = await WorkspaceService.open(root)
    const executor = new ToolExecutor(new ToolRegistry(), {
      dataDir: join(root, '.agent-data'),
      authorizeShell: async () => ({ decision: 'allow', risk: 'low', reason: 'test' }),
    })
    const context = {
      threadID: 't-glob-grep',
      turnID: 'turn-glob-grep',
      profile: 'explorer' as const,
      taskMode: 'chat' as const,
      signal: new AbortController().signal,
      workspace,
      permissionConfig: permission,
    }
    const globRes = (await executor.execute('Glob', { pattern: '**/*.js' }, context)) as {
      filenames: string[]
    }
    expect(globRes.filenames).toContain('dist/assets/bundle.js')
    expect(globRes.filenames).toContain('build/app.js')
    expect(globRes.filenames.some((file) => file.includes('node_modules'))).toBe(false)

    const nmExplicitGlob = (await executor.execute(
      'Glob',
      { pattern: '**/*.js', path: 'node_modules/pkg' },
      context,
    )) as { filenames: string[] }
    expect(
      nmExplicitGlob.filenames.some((file) => file.includes('node_modules/pkg/index.js')),
    ).toBe(true)

    const grepRes = (await executor.execute(
      'Grep',
      { pattern: 'attachmentViewer', output_mode: 'files_with_matches' },
      context,
    )) as { output: string }
    expect(grepRes.output).toContain('dist/assets/bundle.js')
    expect(grepRes.output).toContain('build/app.js')
    expect(grepRes.output).not.toContain('node_modules')
  })

  test('Fork 子代理调用 Agent（含显式 subagent_type）被宿主拒绝，且失败手交保留 [Subagent hand-back] 与 taskId', async () => {
    let sawForkErrorToolResult = ''
    let sawFailedHandbackText = ''
    const { root, db, faux, runtime, modelRef } = await createRuntimeFixture([
      fauxAssistantMessage([
        fauxToolCall('Agent', {
          description: 'Try nested explorer inside fork',
          prompt: 'Explore nested',
          subagent_type: 'explorer',
        }),
      ]),
      fauxAssistantMessage('Done directly inside fork.'),
      fauxAssistantMessage([
        fauxToolCall('Agent', {
          description: 'Failing sync explore',
          prompt: 'Inspect broken target',
          subagent_type: 'explorer',
        }),
      ]),
      fauxAssistantMessage('Handled child partial failure.'),
    ])
    const workspace = await WorkspaceService.open(root)
    const forkThread = db.createThread()
    const forkTurn = db.createTurn(forkThread.id, {
      content: 'Fork task',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(forkTurn.turnID)

    const parentBundle = createPromptSections({
      permissionInstructions: 'allow',
      mode: 'chat',
      profile: 'main',
      userMessage: 'Parent prompt',
    })
    const parentPlan = runtime.toolExposure({
      taskMode: 'chat',
      sandboxMode: permission.sandboxMode,
      approvalPolicy: permission.approvalPolicy,
      profile: 'main',
    })
    const forkSessionID = crypto.randomUUID()
    const forkResult = await runtime.run({
      threadID: forkThread.id,
      turnID: forkTurn.turnID,
      agentID: forkTurn.agentID,
      sessionID: forkSessionID,
      profile: 'default',
      depth: 1,
      isForkChild: true,
      forkContext: {
        bundle: {
          threadID: forkThread.id,
          mode: 'chat',
          profile: 'default',
          sections: parentBundle,
          exposedTools: parentPlan.exposed,
          deferredTools: parentPlan.deferred,
          stableSystemPrompt: 'frozen',
          dynamicSystemSuffix: '',
          promptHash: 'hash',
          cacheKey: 'fork-cache-key',
          diagnostics: [],
          contextItems: [],
        } as never,
        exposurePlan: {
          eager: [...parentPlan.exposed],
          deferred: [...parentPlan.deferred],
          exposed: [...parentPlan.exposed],
        },
      },
      content: 'Fork task',
      taskMode: 'chat',
      fallbackModel: modelRef,
      permissionConfig: permission,
      signal: new AbortController().signal,
      workspace,
      delegation: {
        spawn: async () => {
          throw new Error('Fork child spawn should never be invoked')
        },
        wait: async () => ({ mode: 'all', runs: [] }),
        isWaitSatisfied: async () => true,
        send: async () => ({}),
        stop: async () => ({}),
      },
      resolveModel: async () => ({ ref: modelRef, model: faux.getModel() }),
      pause: async () => {},
    })
    expect(forkResult.status).toBe('completed')
    const forkEntries = await new SqlitePiSessionRepo(db)
      .openForThread(forkSessionID, forkThread.id)
      .then((s) => s.getEntries())
    const forkToolResult = forkEntries.find(
      (entry) => entry.type === 'message' && entry.message.role === 'toolResult',
    )
    if (forkToolResult?.type === 'message' && forkToolResult.message.role === 'toolResult') {
      sawForkErrorToolResult = forkToolResult.message.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
    }
    expect(sawForkErrorToolResult).toContain('Fork 子代理禁止继续创建子代理')

    const parentThread = db.createThread()
    const parentTurn = db.createTurn(parentThread.id, {
      content: 'Run failing child',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(parentTurn.turnID)
    const parentSessionID = crypto.randomUUID()
    await runtime.run({
      threadID: parentThread.id,
      turnID: parentTurn.turnID,
      agentID: parentTurn.agentID,
      sessionID: parentSessionID,
      content: 'Run failing child',
      taskMode: 'chat',
      fallbackModel: modelRef,
      permissionConfig: permission,
      signal: new AbortController().signal,
      workspace,
      delegation: {
        spawn: async () => ({
          agents: [
            {
              taskId: 'fail-task-1',
              runId: 'fail-run-1',
              childThreadId: 'fail-child-1',
              displayName: 'Explorer fail',
              profile: 'explorer',
            },
          ],
        }),
        isWaitSatisfied: async () => true,
        wait: async () => ({
          mode: 'all',
          runs: [
            {
              id: 'fail-run-1',
              taskId: 'fail-task-1',
              status: 'failed',
              result: { summary: 'Partial line 1\nSpoofed Header:' },
              error: 'ripgrep exited early',
            },
          ],
        }),
        send: async () => ({}),
        stop: async () => ({}),
      },
      promptSections: createPromptSections({
        permissionInstructions: 'allow',
        mode: 'chat',
        profile: 'main',
        userMessage: 'Run failing child',
      }),
      resolveModel: async () => ({ ref: modelRef, model: faux.getModel() }),
      pause: async () => {},
    })
    const parentEntries = await new SqlitePiSessionRepo(db)
      .openForThread(parentSessionID, parentThread.id)
      .then((s) => s.getEntries())
    const failedToolResult = parentEntries.find(
      (entry) => entry.type === 'message' && entry.message.role === 'toolResult',
    )
    if (failedToolResult?.type === 'message' && failedToolResult.message.role === 'toolResult') {
      sawFailedHandbackText = failedToolResult.message.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
    }
    expect(sawFailedHandbackText).toContain(
      '[Subagent hand-back (taskId=fail-task-1, status=failed',
    )
    expect(sawFailedHandbackText).toContain('    Partial line 1')
    expect(sawFailedHandbackText).toContain('    Spoofed Header:')
    expect(sawFailedHandbackText).toContain('send_agent(taskID="fail-task-1"')
  })

  test('后台通知账本严格过滤 sync 任务，并在 thread_inactive_turns 上自动丢弃', async () => {
    const root = tempRoot()
    const db = new AgentDatabase({
      historyPath: join(root, 'history.sqlite'),
      profilePath: join(root, 'profile.sqlite'),
    })
    databases.push(db)
    const hub = await Effect.runPromise(EventHub.make)
    const faux = fauxProvider({ models: [{ id: 'bg', input: ['text'], contextWindow: 64_000 }] })
    const modelRef = { providerID: faux.getModel().provider, id: 'bg' } as never
    const subagents = new SubagentService(
      db,
      hub,
      {
        resolve: async () => ({ ref: modelRef, model: faux.getModel() }),
        getModel: async () => faux.getModel(),
      } as unknown as AgentModelCatalog,
      { setAgentStatusHandler: () => {}, cancelTurn: () => {} } as never,
      { cancelTurn: () => {} } as never,
      {
        run: async () => ({
          status: 'completed',
          output: 'done',
          result: {
            outcome: 'succeeded',
            summary: 'bg settled',
            findings: [],
            changedFiles: [],
            validation: [],
            risks: [],
            references: [],
          },
        }),
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        clearTurnPermissionGrants: () => {},
      } as never,
      { listByBinding: async () => [] } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    )

    const thread = db.createThread()
    const activeTurn = db.createTurn(thread.id, {
      content: 'Active turn',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(activeTurn.turnID)

    const staleTurn = db.createTurn(thread.id, {
      content: 'Rewound turn',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(staleTurn.turnID)

    const syncSpawned = await subagents.spawn(
      {
        threadID: thread.id,
        turnID: activeTurn.turnID,
        agentID: activeTurn.agentID,
        taskMode: 'chat',
        model: modelRef,
        permissionConfig: permission,
        workspaceRoot: root,
      },
      [{ profile: 'explorer', task: 'Sync task' }],
    )
    const staleBgSpawned = await subagents.spawn(
      {
        threadID: thread.id,
        turnID: staleTurn.turnID,
        agentID: staleTurn.agentID,
        taskMode: 'chat',
        model: modelRef,
        permissionConfig: permission,
        workspaceRoot: root,
      },
      [{ profile: 'explorer', task: 'Stale bg task', background: true }],
    )

    const deadline = Date.now() + 2000
    while (
      (subagents.repository.task(syncSpawned.agents[0]!.taskId)?.currentRun?.status !==
        'completed' ||
        subagents.repository.task(staleBgSpawned.agents[0]!.taskId)?.currentRun?.status !==
          'completed') &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20))
    }

    // Mark staleTurn inactive before claiming
    db.sqlite
      .query(
        'INSERT INTO thread_edits (operation_id, thread_id, request_hash, source_turn_id, source_input_id, input_id, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'op-edit-1',
        thread.id,
        'hash-1',
        staleTurn.turnID,
        staleTurn.inputID,
        staleTurn.inputID,
        staleTurn.turnID,
        Date.now(),
      )
    db.sqlite
      .query('INSERT INTO thread_inactive_turns (turn_id, operation_id) VALUES (?, ?)')
      .run(staleTurn.turnID, 'op-edit-1')

    expect(subagents.collaboration.pendingBackgroundNotifications(thread.id)).toBe(0)
    const claimed = subagents.collaboration.claimReadyBackgroundNotifications(thread.id)
    expect(claimed).toHaveLength(0)
    const statusRow = db.sqlite
      .query('SELECT status FROM subagent_background_notifications WHERE task_id = ?')
      .get(staleBgSpawned.agents[0]!.taskId) as { status: string } | null
    expect(statusRow?.status).toBe('discarded')
  })

  test('后台通知 handler 抛错保持 pending，重试经确定性 inputID 去重，且 error 中的 API key 已脱敏', async () => {
    const root = tempRoot()
    const db = new AgentDatabase({
      historyPath: join(root, 'history.sqlite'),
      profilePath: join(root, 'profile.sqlite'),
    })
    databases.push(db)
    const hub = await Effect.runPromise(EventHub.make)
    const faux = fauxProvider({
      models: [{ id: 'bg-retry', input: ['text'], contextWindow: 64_000 }],
    })
    const modelRef = { providerID: faux.getModel().provider, id: 'bg-retry' } as never
    const fakeApiKey = 'sk-fake0123456789abcdefXYZ'
    const subagents = new SubagentService(
      db,
      hub,
      {
        resolve: async () => ({ ref: modelRef, model: faux.getModel() }),
        getModel: async () => faux.getModel(),
      } as unknown as AgentModelCatalog,
      { setAgentStatusHandler: () => {}, cancelTurn: () => {} } as never,
      { cancelTurn: () => {} } as never,
      {
        run: async () => {
          throw new Error(`provider rejected api_key=${fakeApiKey}`)
        },
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        clearTurnPermissionGrants: () => {},
      } as never,
      { listByBinding: async () => [] } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    )

    const thread = db.createThread()
    const turn = db.createTurn(thread.id, {
      content: 'Background audit',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(turn.turnID)
    const spawned = await subagents.spawn(
      {
        threadID: thread.id,
        turnID: turn.turnID,
        agentID: turn.agentID,
        taskMode: 'chat',
        model: modelRef,
        permissionConfig: permission,
        workspaceRoot: root,
      },
      [{ profile: 'explorer', task: 'Failing bg task', background: true }],
    )
    const taskID = spawned.agents[0]!.taskId

    const deadline = Date.now() + 2000
    while (
      subagents.repository.task(taskID)?.currentRun?.status !== 'failed' &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(subagents.repository.task(taskID)?.currentRun?.status).toBe('failed')

    const notificationStatus = () =>
      (
        db.sqlite
          .query('SELECT status FROM subagent_background_notifications WHERE task_id = ?')
          .get(taskID) as { status: string } | null
      )?.status

    // INVARIANT: 无 handler 时 dispatch 提前返回，行保持 pending（未 seal）。
    expect(notificationStatus()).toBe('pending')

    const delivered: Array<{ prompt: string; inputID: string }> = []
    let attempts = 0
    subagents.setBackgroundNotifyHandler((_threadID, _sourceTurnID, prompt, inputID) => {
      attempts += 1
      if (attempts === 1) throw new Error('transient enqueue failure')
      delivered.push({ prompt, inputID })
    })

    const dispatch = (
      subagents as unknown as {
        dispatchBackgroundNotifications(threadID: string): Promise<void>
      }
    ).dispatchBackgroundNotifications.bind(subagents)

    await expect(dispatch(thread.id)).rejects.toThrow('transient enqueue failure')
    expect(notificationStatus()).toBe('pending')
    expect(delivered).toHaveLength(0)

    await dispatch(thread.id)
    expect(notificationStatus()).toBe('notified')
    expect(delivered).toHaveLength(1)
    expect(attempts).toBe(2)

    const expectedInputID = `subagent-notify:${turn.turnID}:${createHash('sha256')
      .update(taskID)
      .digest('hex')
      .slice(0, 16)}`
    expect(delivered[0]!.inputID).toBe(expectedInputID)
    expect(delivered[0]!.prompt).toContain('<task-notification')
    expect(delivered[0]!.prompt).toContain('status="failed"')
    expect(delivered[0]!.prompt).toContain('<redacted>')
    expect(delivered[0]!.prompt).not.toContain(fakeApiKey)

    // INVARIANT: seal 后 claim 为空，再次 dispatch 不产生重复通知。
    expect(subagents.collaboration.claimReadyBackgroundNotifications(thread.id)).toHaveLength(0)
    await dispatch(thread.id)
    expect(delivered).toHaveLength(1)
    expect(attempts).toBe(2)
  })

  test('后台通知经 ThreadService.enqueueFollowUp 落为恰一条 turn，重试命中 duplicate 不重复排队', async () => {
    const root = tempRoot()
    const db = new AgentDatabase({
      historyPath: join(root, 'history.sqlite'),
      profilePath: join(root, 'profile.sqlite'),
    })
    databases.push(db)
    const hub = await Effect.runPromise(EventHub.make)
    const faux = fauxProvider({
      models: [{ id: 'bg-int', input: ['text'], contextWindow: 64_000 }],
    })
    const modelRef = { providerID: faux.getModel().provider, id: 'bg-int' } as never
    const subagents = new SubagentService(
      db,
      hub,
      {
        resolve: async () => ({ ref: modelRef, model: faux.getModel() }),
        getModel: async () => faux.getModel(),
      } as unknown as AgentModelCatalog,
      { setAgentStatusHandler: () => {}, cancelTurn: () => {} } as never,
      { cancelTurn: () => {} } as never,
      {
        run: async () => ({
          status: 'completed',
          output: 'done',
          result: {
            outcome: 'succeeded',
            summary: 'integration bg settled',
            findings: [],
            changedFiles: [],
            validation: [],
            risks: [],
            references: [],
          },
        }),
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        clearTurnPermissionGrants: () => {},
      } as never,
      { listByBinding: async () => [] } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    )
    const workspace = await WorkspaceService.open(root)
    const threads = new ThreadService(
      db,
      hub,
      {
        resolve: async () => ({
          ref: modelRef,
          model: faux.getModel(),
          capabilities: { input: ['text'], tools: true },
        }),
      } as never,
      null as never,
      { setResumeHandler: () => {} } as never,
      { clearTurnPermissionGrants: () => {} } as never,
      subagents,
      { listByBinding: async () => [] } as never,
      { dataRoot: root, userHome: root },
      null as never,
      null as never,
      {
        resolve: async () => ({
          kind: 'projectless',
          projectID: null,
          workspaceRoot: root,
          cwd: root,
          runtimeWorkspaceRoots: [],
          instructionSources: [],
          outputDirectory: root,
          workspace,
        }),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    )
    // INVARIANT: 隔离真实模型执行——通知 turn 只验证 admission/排队，不驱动运行时。
    Object.defineProperty(db, 'startTurnExecution', {
      configurable: true,
      value: () => null,
    })

    const thread = db.createThread()
    const sourceTurn = db.createTurn(thread.id, {
      content: 'Running main turn',
      model: modelRef,
      permissionConfig: permission,
      strategy: 'queue',
      taskMode: 'chat',
    })
    db.claimTurnExecution(sourceTurn.turnID)
    const spawned = await subagents.spawn(
      {
        threadID: thread.id,
        turnID: sourceTurn.turnID,
        agentID: sourceTurn.agentID,
        taskMode: 'chat',
        model: modelRef,
        permissionConfig: permission,
        workspaceRoot: root,
      },
      [{ profile: 'explorer', task: 'Integration bg task', background: true }],
    )
    const taskID = spawned.agents[0]!.taskId

    const notificationInputID = `subagent-notify:${sourceTurn.turnID}:${createHash('sha256')
      .update(taskID)
      .digest('hex')
      .slice(0, 16)}`
    const deadline = Date.now() + 2000
    while (
      (
        db.sqlite
          .query('SELECT status FROM subagent_background_notifications WHERE task_id = ?')
          .get(taskID) as { status: string } | null
      )?.status !== 'notified' &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20))
    }

    const admission = db.inputAdmission(notificationInputID)
    expect(admission).not.toBeNull()
    expect(admission!.thread_id).toBe(thread.id)
    expect(admission!.content).toContain('<task-notification')
    expect(admission!.content).toContain('integration bg settled')
    const notifyTurns = db.sqlite
      .query("SELECT id FROM inputs WHERE id LIKE 'subagent-notify:%'")
      .all() as Array<{ id: string }>
    expect(notifyTurns).toHaveLength(1)
    expect(notifyTurns[0]!.id).toBe(notificationInputID)

    // INVARIANT: 同批重试命中 duplicateAdmission，返回 duplicate 且不新增 turn。
    const retry = await threads.enqueueFollowUp(
      thread.id,
      {
        content: admission!.content,
        model: modelRef,
        taskMode: 'chat',
        permissionConfig: permission,
        strategy: 'queue',
      },
      notificationInputID,
    )
    expect(retry.disposition).toBe('duplicate')
    expect(retry.inputID).toBe(notificationInputID)
    expect(
      (
        db.sqlite
          .query("SELECT COUNT(*) AS count FROM inputs WHERE id LIKE 'subagent-notify:%'")
          .get() as { count: number }
      ).count,
    ).toBe(1)

    expect(
      db.sqlite.query('SELECT id FROM messages WHERE id = ?').get(notificationInputID),
    ).toBeNull()
    expect(
      db.sqlite
        .query('SELECT preview, first_user_message, queue_version FROM threads WHERE id = ?')
        .get(thread.id),
    ).toEqual({
      preview: 'Running main turn',
      first_user_message: 'Running main turn',
      queue_version: 2,
    })
    expect(
      db.sqlite
        .query(
          "SELECT COUNT(*) AS count FROM events WHERE thread_id = ? AND method = 'queue/updated' AND turn_id <> ?",
        )
        .get(thread.id, sourceTurn.turnID),
    ).toEqual({ count: 0 })

    const projection = new ThreadProjection(db)
    const history = projection.historyPage(thread.id)
    expect(history?.queue.turns).toEqual([])
    expect(history?.queue.inputs).toEqual([])
    const snapshot = projection.snapshot(thread.id)
    expect(snapshot?.inputs.find((entry) => entry.id === notificationInputID)?.origin).toBe(
      'subagent-notification',
    )

    await expect(
      threads.updateQueue(thread.id, notificationInputID, '篡改内容', undefined, undefined, {
        operationID: 'op-update-notify',
      }),
    ).rejects.toMatchObject({ code: 'QUEUED_INPUT_NOT_FOUND' })
    await expect(
      threads.removeQueue(thread.id, notificationInputID, {
        operationID: 'op-remove-notify',
      }),
    ).rejects.toMatchObject({ code: 'QUEUED_INPUT_NOT_FOUND' })
    const bookmarks = new ThreadBookmarkService(db, hub)
    await expect(
      bookmarks.set({
        threadId: thread.id,
        inputId: notificationInputID,
        bookmarked: true,
        expectedVersion: 0,
        operationId: 'op-bookmark-notify',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
