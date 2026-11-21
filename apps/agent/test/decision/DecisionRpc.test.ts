import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { Capabilities } from '@pidex/agent-protocol'
import { EncryptedCredentialRepository } from '../../src/auth/EncryptedCredentialRepository'
import { isProviderCredentialIntegration } from '../../src/auth/ProviderCredentialRepository'
import { ConfigService } from '../../src/config/ConfigService'
import { DecisionService } from '../../src/decision/DecisionService'
import { decideInputPreflight } from '../../src/decision/integrations/InputDecisionAdapter'
import { inputPreflightSpec } from '../../src/decision/specs/InputSpecs'
import type { EventEnvelope } from '../../src/Domain'
import { AgentDatabase } from '../../src/storage/database/AgentDatabase'
import { RpcRouter, type RpcRouterDependencies } from '../../src/transport/rpc/RpcRouter'
import { removeFixturePaths } from '../FixtureCleanup'

const roots: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  await removeFixturePaths(roots.splice(0))
}, 30_000)

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidex-decision-rpc-'))
  roots.push(root)
  const db = new AgentDatabase(join(root, 'agent.sqlite'))
  const configPath = join(root, 'config.json')
  const config = new ConfigService(configPath)
  await config.initialize()
  let masterKey: string | null = null
  const credentials = new EncryptedCredentialRepository(db, {
    get: async () => masterKey,
    set: async (value) => {
      masterKey = value
    },
  })
  const publishedEvents: EventEnvelope[] = []
  const hub = {
    publish: (event: EventEnvelope) => {
      publishedEvents.push(event)
      return Effect.succeed(event)
    },
    subscribe: () => () => {},
  } as never
  const decisions = new DecisionService(db, config, hub, { credentials, config, db })
  const router = new RpcRouter({
    config,
    decisions,
    db,
    hub,
    threads: {} as never,
    history: {} as never,
    approvals: {} as never,
    questions: {} as never,
    subagents: {} as never,
    attachments: {} as never,
    artifacts: {} as never,
    localContextPaths: {} as never,
    projectSources: {} as never,
    providers: {} as never,
    piModels: {} as never,
    apiKeys: {} as never,
    modelHealth: {} as never,
    modelSync: {} as never,
    protocolDetection: {} as never,
    providerCredentials: {} as never,
    providerCredentialStore: {} as never,
    authSessions: {} as never,
    memory: {} as never,
    hooks: {} as never,
    review: {} as never,
    github: {} as never,
    git: {} as never,
    tooling: {} as never,
    pets: {} as never,
    releaseNotes: {} as never,
    usage: {} as never,
    turnPatches: {} as never,
    terminalContext: {} as never,
    terminalOutput: {} as never,
    localEnvironment: {} as never,
    worktrees: {} as never,
    handoff: {} as never,
    threadFork: {} as never,
    sideChats: {} as never,
    executionBindings: {} as never,
    worktreeRepository: {} as never,
    environmentDeltas: {} as never,
    speech: {} as never,
    threadExecutions: {} as never,
    sessionGroups: {} as never,
    threadGoals: {} as never,
    threadBookmarks: {} as never,
    threadPullRequests: {} as never,
    automation: {} as never,
  } as unknown as RpcRouterDependencies)
  cleanups.push(async () => {
    router.decisions.dispose()
    await config.dispose()
    db.close()
  })

  let id = 0
  let connectionId: string | null = null
  const call = (method: string, params: Record<string, unknown>) =>
    router.handle(
      { jsonrpc: '2.0', id: `test:${++id}`, method, params },
      { ...(connectionId ? { connectionId } : {}) },
    ) as Promise<{ result?: any; error?: { data?: { code?: string } } }>
  const initialize = async () => {
    const response = await call('initialize', {
      clientInfo: { name: 'test', version: '1.0.0', platform: 'win32' },
      protocols: ['thread-rpc-v4'],
      capabilities: [...Capabilities],
      interactionDelivery: 'active',
    })
    connectionId = response.result.connectionId
    await router.handle(
      { jsonrpc: '2.0', method: 'initialized', params: { protocol: 'thread-rpc-v4' } },
      { connectionId: connectionId! },
    )
  }
  await initialize()
  return { db, config, configPath, credentials, decisions, publishedEvents, call }
}

describe('decision RPC', () => {
  test('getConfig 默认空配置，updateConfig 局部写入并保留未知键，operationId 幂等重放', async () => {
    const { call, config } = await fixture()
    const initial = await call('decision/getConfig', {})
    expect(initial.result?.config).toEqual({
      tiers: [],
      judges: {},
      modes: {},
      routes: {},
      features: {},
      recordState: false,
    })
    expect(initial.result?.effectiveProviders).toEqual([])

    const params = {
      scope: 'user',
      patch: [{ keyPath: ['modes', 'tool.risk'], value: 'shadow' }],
      operationId: 'operation:decision-1',
    }
    const updated = await call('decision/updateConfig', params)
    expect(updated.result?.config.modes).toEqual({ 'tool.risk': 'shadow' })
    expect(typeof updated.result?.version).toBe('string')
    const replay = await call('decision/updateConfig', params)
    expect(replay.result).toEqual(updated.result)
    const conflict = await call('decision/updateConfig', {
      ...params,
      patch: [{ keyPath: ['modes', 'tool.risk'], value: 'active' }],
    })
    expect(conflict.error?.data?.code).toBe('OPERATION_ID_CONFLICT')

    const reread = await call('decision/getConfig', {})
    expect(reread.result?.config.modes).toEqual({ 'tool.risk': 'shadow' })
    const raw = await config.read()
    expect((raw.config.decision as Record<string, unknown>).modes).toEqual({
      'tool.risk': 'shadow',
    })
  })

  test('updateConfig 拒绝无效补丁且不落盘', async () => {
    const { call } = await fixture()
    const invalid = await call('decision/updateConfig', {
      scope: 'user',
      patch: [{ keyPath: ['modes', 'tool.risk'], value: 'sometimes' }],
      operationId: 'operation:decision-invalid',
    })
    expect(invalid.error?.data?.code).toBe('CONFIG_VALIDATION_ERROR')
    const reread = await call('decision/getConfig', {})
    expect(reread.result?.config.modes).toEqual({})
  })

  test('updateConfig 支持用 null 删除已配置的 Judge 与单点路由', async () => {
    const { call } = await fixture()
    const added = await call('decision/updateConfig', {
      scope: 'user',
      patch: [
        {
          keyPath: ['judges', 'qwen'],
          value: {
            type: 'systemone',
            providerId: 'magpie',
            model: 'qwen-token-plan/decision-model-preview',
          },
        },
        { keyPath: ['tiers'], value: ['qwen'] },
        { keyPath: ['routes', 'tool.risk'], value: ['qwen'] },
      ],
      operationId: 'operation:decision-add-for-delete',
    })
    expect(added.result?.config.judges.qwen?.providerId).toBe('magpie')
    expect(added.result?.config.routes['tool.risk']).toEqual(['qwen'])

    const removed = await call('decision/updateConfig', {
      scope: 'user',
      patch: [
        { keyPath: ['judges', 'qwen'], value: null },
        { keyPath: ['tiers'], value: [] },
        { keyPath: ['routes', 'tool.risk'], value: null },
      ],
      operationId: 'operation:decision-remove',
    })
    expect(removed.error).toBeUndefined()
    expect(removed.result?.config.judges).toEqual({})
    expect(removed.result?.config.tiers).toEqual([])
    expect(removed.result?.config.routes).toEqual({})

    const reread = await call('decision/getConfig', {})
    expect(reread.result?.config.judges).toEqual({})
    expect(reread.result?.config.routes).toEqual({})
  })

  test('listLedger 返回会话记录，markOutcome 幂等且拒绝跨会话标注', async () => {
    const { db, call } = await fixture()
    const thread = db.createThread('决策会话')
    const other = db.createThread('其他会话')
    db.repositories.decisionLedger.appendRecord({
      id: 'decision:1',
      threadId: thread.id,
      specId: 'tool.risk',
      specVersion: 1,
      mode: 'shadow',
      providerId: 'classifier',
      outcome: 'confirm',
      source: 'fallback',
      stateDigest: 'a'.repeat(64),
      createdAt: 1,
    })
    const listed = await call('decision/listLedger', { threadId: thread.id })
    expect(listed.result?.records.map((record: { id: string }) => record.id)).toEqual([
      'decision:1',
    ])
    expect(listed.result?.outcomes).toEqual([])

    const markParams = {
      ledgerId: 'decision:1',
      threadId: thread.id,
      verdict: 'correct',
      operationId: 'operation:mark-1',
    }
    const marked = await call('decision/markOutcome', markParams)
    expect(marked.result?.outcome.verdict).toBe('correct')
    const replay = await call('decision/markOutcome', markParams)
    expect(replay.result).toEqual(marked.result)
    const crossThread = await call('decision/markOutcome', {
      ...markParams,
      threadId: other.id,
      operationId: 'operation:mark-2',
    })
    expect(crossThread.error?.data?.code).toBe('INVALID_REQUEST')
    const missingThread = await call('decision/listLedger', { threadId: 'thread:missing' })
    expect(missingThread.error?.data?.code).toBe('THREAD_NOT_FOUND')
  })

  test('probe 在未配置 Judge 时报告 auth，不泄露凭据', async () => {
    const { call } = await fixture()
    const probed = await call('decision/probe', {})
    expect(probed.result).toEqual({
      ok: false,
      providerId: 'none',
      latencyMs: 0,
      errorKind: 'auth',
    })
  })

  test('probe 失败时返回脱敏后的 httpStatus、endpoint 与 errorMessage', async () => {
    const { call } = await fixture()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Unsupported route for Bearer sk-live-secret on C:\\Users\\alice\\secret.txt',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch

    try {
      await call('decision/updateConfig', {
        scope: 'user',
        patch: [
          {
            keyPath: ['judges', 'local-s1'],
            value: {
              type: 'systemone',
              baseUrl: 'http://127.0.0.1:3425/v1',
              model: 'decision-model-preview',
            },
          },
        ],
        operationId: 'operation:decision-probe-400',
      })
      const probed = await call('decision/probe', { judgeName: 'local-s1' })
      expect(probed.error).toBeUndefined()
      expect(probed.result).toMatchObject({
        ok: false,
        errorKind: 'bad_request',
        httpStatus: 400,
        endpoint: 'http://127.0.0.1:3425/v1/systemone',
        errorMessage: 'Unsupported route for [REDACTED] on [PATH]',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('setJudgeApiKey 加密入库、不泄露明文、探活可用，且删除 Judge 自动清理凭据', async () => {
    const { call, configPath, credentials } = await fixture()
    const secret = 'sk-qwen-decision-secret-9876'
    const setParams = {
      judgeName: 'qwen-decision',
      apiKey: secret,
      operationId: 'operation:decision-key-1',
    }
    const savedKey = await call('decision/setJudgeApiKey', setParams)
    expect(savedKey.error).toBeUndefined()
    expect(savedKey.result?.judgeName).toBe('qwen-decision')
    expect(savedKey.result?.apiKeyMasked).toBe('••••9876')
    expect(typeof savedKey.result?.credentialId).toBe('string')

    const replay = await call('decision/setJudgeApiKey', setParams)
    expect(replay.result).toEqual(savedKey.result)
    const conflict = await call('decision/setJudgeApiKey', {
      ...setParams,
      apiKey: 'sk-different-secret-0000',
    })
    expect(conflict.error?.data?.code).toBe('OPERATION_ID_CONFLICT')

    expect(isProviderCredentialIntegration('decision.qwen-decision')).toBe(false)
    expect(credentials.listProviderCredentials()).toEqual([])

    const credentialId = savedKey.result.credentialId as string
    const updated = await call('decision/updateConfig', {
      scope: 'user',
      patch: [
        {
          keyPath: ['judges', 'qwen-decision'],
          value: {
            type: 'systemone',
            baseUrl: 'https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1',
            model: 'decision-model-preview',
            credentialId,
          },
        },
        { keyPath: ['tiers'], value: ['qwen-decision'] },
      ],
      operationId: 'operation:decision-bind-key',
    })
    expect(updated.error).toBeUndefined()

    const rawConfig = await readFile(configPath, 'utf8')
    expect(rawConfig).not.toContain(secret)
    expect(rawConfig).toContain(credentialId)

    const view = await call('decision/getConfig', {})
    expect(view.result?.effectiveProviders).toEqual([
      {
        name: 'qwen-decision',
        type: 'systemone',
        providerId: 'systemone',
        modelId: 'decision-model-preview',
        apiKeyMasked: '••••9876',
      },
    ])

    let seenAuth = ''
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get('Authorization') ?? ''
      return new Response(
        JSON.stringify({
          model: 'decision-model-preview',
          answers: { ready: { noul: 0.98, confidence: 0.99 } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    try {
      const probed = await call('decision/probe', { judgeName: 'qwen-decision' })
      expect(probed.error).toBeUndefined()
      expect(probed.result?.ok).toBe(true)
      expect(seenAuth).toBe(`Bearer ${secret}`)
    } finally {
      globalThis.fetch = originalFetch
    }

    const removed = await call('decision/updateConfig', {
      scope: 'user',
      patch: [
        { keyPath: ['judges', 'qwen-decision'], value: null },
        { keyPath: ['tiers'], value: [] },
      ],
      operationId: 'operation:decision-delete-cleanup',
    })
    expect(removed.error).toBeUndefined()
    expect(credentials.listApiKeys('decision.qwen-decision')).toEqual([])
  })

  test('读取含历史 apiKeyEnv 字段的配置文件时自动忽略未知键不报错', async () => {
    const { call, configPath } = await fixture()
    await writeFile(
      configPath,
      JSON.stringify({
        decision: {
          judges: {
            legacy: {
              type: 'systemone',
              model: 'decision-model-preview',
              apiKeyEnv: 'SHOULD_BE_STRIPPED',
            },
          },
        },
      }),
      'utf8',
    )
    const view = await call('decision/getConfig', {})
    expect(view.error).toBeUndefined()
    expect(view.result?.config.judges.legacy).toEqual({
      type: 'systemone',
      model: 'decision-model-preview',
    })
  })

  test('显式 origin 与 runWithOrigin 绑定会话并实时推送事件，markOutcome 不重复落库事件', async () => {
    const { db, decisions, publishedEvents, call } = await fixture()
    const thread = db.createThread('Decision origin test')
    await call('decision/updateConfig', {
      scope: 'user',
      patch: [
        { keyPath: ['judges', 'local-mock'], value: { type: 'mock' } },
        { keyPath: ['tiers'], value: ['local-mock'] },
        { keyPath: ['modes', 'input.preflight'], value: 'shadow' },
        { keyPath: ['modes', 'task.frame'], value: 'shadow' },
      ],
      operationId: 'operation:decision-origin-setup',
    })

    await decideInputPreflight(decisions, {
      messageText: '总结 guardianLabPolicy',
      thread: { threadId: thread.id, running: false },
    })

    const engine = await decisions.ensureEngine()
    expect(engine).not.toBeNull()
    const scoped = await decisions.runWithOrigin(
      { threadId: thread.id, turnId: 'turn-origin-1' },
      () =>
        engine!.decide(inputPreflightSpec, {
          userMessage: '执行 git status',
          recentTurns: [],
        }),
    )
    expect(scoped.ledgerId).toBeDefined()

    const listed = await call('decision/listLedger', { threadId: thread.id })
    expect(listed.error).toBeUndefined()
    expect(listed.result.records.length).toBeGreaterThanOrEqual(3)
    expect(
      listed.result.records.every((record: { threadId?: string }) => record.threadId === thread.id),
    ).toBe(true)
    expect(
      listed.result.records.some(
        (record: { id: string; turnId?: string }) =>
          record.id === scoped.ledgerId && record.turnId === 'turn-origin-1',
      ),
    ).toBe(true)

    const liveRecorded = publishedEvents.filter(
      (event) => event.method === 'decision/recorded' && event.threadId === thread.id,
    )
    expect(liveRecorded.length).toBe(listed.result.records.length)

    const marked = await call('decision/markOutcome', {
      ledgerId: scoped.ledgerId,
      threadId: thread.id,
      verdict: 'correct',
      operationId: 'operation:decision-origin-mark',
    })
    expect(marked.error).toBeUndefined()

    const liveOutcomes = publishedEvents.filter(
      (event) => event.method === 'decision/outcomeRecorded' && event.threadId === thread.id,
    )
    expect(liveOutcomes).toHaveLength(1)
    const storedOutcomeEvents = db.sqlite
      .query(
        "SELECT COUNT(*) AS count FROM events WHERE thread_id = ? AND method = 'decision/outcomeRecorded'",
      )
      .get(thread.id) as { count: number }
    expect(storedOutcomeEvents.count).toBe(1)
  })
})
