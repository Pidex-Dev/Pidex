import { fixtureV2, fixtureV2Fetch, respondV2 } from './fixtures/CatalogV2Fixture'
import { Schema } from 'effect'
import { ProviderModelDefinitionSchema } from '@pidex/agent-protocol'
import { describe, expect, spyOn, test } from 'bun:test'
import { Model, Provider, type Credential } from '@pidex/model-schema'
import { Effect } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EncryptedCredentialRepository } from '../src/auth/EncryptedCredentialRepository'
import { ProviderDirectoryStore } from '../src/provider/pi/ProviderDirectoryStore'
import { normalizeContext } from '@earendil-works/pi-ai'
import { ModelRecommendationStore } from '../src/provider/pi/ModelRecommendationStore'
import { compileOptionSpecs, applyModelOptionMap } from '../src/provider/pi/PiModelOptionMapping'
import { ModelSyncService } from '../src/provider/ModelSyncService'
import type { ConfigService } from '../src/config/ConfigService'
import {
  EncryptedCredentialStore,
  PiModelService,
  resetUnconfiguredBuiltinProvider,
  seedBuiltinProviderCatalogModels,
  type PiModelCatalogConfig,
} from '../src/provider/pi'

test('catalog refresh identifies failed providers without logging upstream secrets', async () => {
  const logs: unknown[] = []
  const service = new PiModelService(repository().adapter, {
    logger: {
      warn: (event, fields) => {
        logs.push({ event, ...fields })
      },
    },
  })
  const refresh = spyOn(service.pi, 'refresh').mockResolvedValue({
    aborted: false,
    errors: new Map([
      ['openai', new Error('Model discovery failed with HTTP 401 private-secret')],
      ['google', new Error('fetch failed private-secret')],
      ['custom', new Error('Model discovery returned an invalid OpenAI catalog')],
    ]),
  })
  try {
    await expect(service.refresh(true, 'google')).rejects.toMatchObject({
      refreshFailures: [
        { providerId: 'openai', code: 'PROVIDER_AUTH_FAILED', retryable: false, httpStatus: 401 },
        { providerId: 'google', code: 'PROVIDER_CONNECTION_FAILED', retryable: true },
        { providerId: 'custom', code: 'PROVIDER_UNAVAILABLE', retryable: false },
      ],
    })
    expect(logs).toHaveLength(3)
    expect(JSON.stringify(logs)).not.toContain('private-secret')
    expect(logs[0]).toMatchObject({ provider: 'openai', category: 'authentication' })
  } finally {
    refresh.mockRestore()
    await service.dispose()
  }
})

test('scoped catalog refresh never requests other providers and directory reload stays offline', async () => {
  const service = new PiModelService(repository().adapter)
  const refresh = spyOn(service.pi, 'refresh').mockImplementation(async (options) => ({
    aborted: false,
    errors: new Map(
      options?.providers?.includes('xiaomi-token-plan-cn')
        ? [['xiaomi-token-plan-cn', new Error('Model discovery failed with HTTP 401')]]
        : [],
    ),
  }))
  try {
    await service.refresh(true, 'google')
    expect(refresh).toHaveBeenLastCalledWith({
      allowNetwork: true,
      force: true,
      providers: ['google'],
    })
    await service.reload()
    expect(refresh).toHaveBeenLastCalledWith({ allowNetwork: false })
    await expect(service.refresh(true, 'missing-provider')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(refresh).toHaveBeenCalledTimes(2)
  } finally {
    refresh.mockRestore()
    await service.dispose()
  }
})

test('directory refresh downloads manifest and changed payloads without requesting provider models and preserves data on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pidex-provider-directory-'))
  const path = join(directory, 'catalog.json')
  let failed = false
  const requests: string[] = []
  const directoryStore = new ProviderDirectoryStore(path, async (url, init) => {
    requests.push(String(url))
    expect(init?.headers).toBeUndefined()
    if (failed) return Response.json({ invalid: true })
    return respondV2(
      url,
      fixtureV2({
        models: { example: { name: 'Example' } },
        providers: {
          google: {
            name: 'Google updated',
            marketVisible: true,
            models: {
              example: {
                name: 'Example',
                pi_api: 'google-generative-ai',
                base_url: 'https://generativelanguage.googleapis.com/v1beta',
                limit: { context: 32768, output: 8192 },
                modalities: { input: ['text'], output: ['text'] },
                reasoning: false,
              },
            },
          },
          'directory-only': { name: 'New directory supplier', marketVisible: true, models: {} },
          'hidden-extra': { name: 'Hidden Extra', marketVisible: false, models: {} },
          local: { name: 'Upstream local name', marketVisible: true, models: {} },
        },
      }),
    )
  })
  const config = {
    schemaVersion: 2,
    providers: {
      local: {
        kind: 'custom',
        name: 'My supplier',
        enabled: true,
        auth: 'none',
        base_url: 'https://local.example/v1',
        models: {},
      },
    },
  }
  const service = new PiModelService(repository().adapter, { config, directory: directoryStore })
  const refresh = spyOn(service.pi, 'refresh').mockImplementation(async (options) => {
    expect(options?.allowNetwork).toBe(false)
    return { aborted: false, errors: new Map() }
  })
  try {
    await service.refreshDirectory()
    const providers = await service.list()
    expect(providers.find((p) => p.id === 'google')?.name).toBe('Google updated')
    expect(
      (await service.models(Provider.ID.make('google'))).some((model) => model.id === 'example'),
    ).toBe(false)
    expect(providers.find((p) => p.id === 'local')?.name).toBe('My supplier')
    expect(providers.find((p) => p.id === 'directory-only')).toMatchObject({
      name: 'New directory supplier',
      availability: { status: 'unavailable', reason: 'missing-api' },
    })
    expect(providers.some((p) => p.id === 'hidden-extra')).toBe(false)
    expect(service.pi.getProviders().some((p) => p.id === 'directory-only')).toBe(false)
    expect(
      (await new ProviderDirectoryStore(path).providers()).some((p) => p.id === 'directory-only'),
    ).toBe(true)
    failed = true
    const revision = service.catalogRevision()
    await expect(service.refreshDirectory()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    expect(await service.list()).toEqual(providers)
    expect(service.catalogRevision()).toBe(revision)
    expect(requests).toEqual([
      'https://models.codepilotx.top/v2/manifest.json',
      'https://models.codepilotx.top/v2/providers.json',
      'https://models.codepilotx.top/v2/models.json',
      'https://models.codepilotx.top/v2/manifest.json',
    ])
  } finally {
    refresh.mockRestore()
    await service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('directory aliases deduplicate without hiding manual providers and compatible suppliers execute through Pi', async () => {
  const hits: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      hits.push(new URL(request.url).pathname)
      expect(request.headers.get('authorization')).toBe('Bearer directory-test-key')
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({
          id: 'chat-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'm',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      return new Response(`${chunk({ content: 'OK' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const baseUrl = `${server.url}v1`
  const directory = new ProviderDirectoryStore(
    undefined,
    fixtureV2Fetch(() => ({
      models: { m: { name: 'm' } },
      providers: {
        'vendor-a': {
          name: 'Vendor A',
          api: baseUrl,
          npm: '@ai-sdk/openai-compatible',
          marketVisible: true,
          models: {
            m: {
              name: 'Pi m',
              pi_api: 'openai-completions',
              base_url: baseUrl,
              limit: { context: 32768, output: 8192 },
              modalities: { input: ['text'], output: ['text'] },
              reasoning: false,
            },
          },
        },
        'vendor-b': {
          name: 'Same vendor with another name',
          api: `${baseUrl}/`,
          npm: '@ai-sdk/openai-compatible',
          marketVisible: true,
          models: {
            m: {
              name: 'Pi m',
              pi_api: 'openai-completions',
              base_url: `${baseUrl}/`,
              limit: { context: 32768, output: 8192 },
              modalities: { input: ['text'], output: ['text'] },
              reasoning: false,
            },
          },
        },
        separate: {
          name: 'Different product',
          api: `${baseUrl}/coding`,
          npm: '@ai-sdk/openai-compatible',
          marketVisible: true,
          models: {
            m: {
              name: 'Pi m',
              pi_api: 'openai-completions',
              base_url: `${baseUrl}/coding`,
              limit: { context: 32768, output: 8192 },
              modalities: { input: ['text'], output: ['text'] },
              reasoning: false,
            },
          },
        },
        unknown: {
          name: 'Choose protocol',
          api: baseUrl,
          npm: 'unsupported-sdk',
          marketVisible: true,
          models: {},
        },
        manual: {
          name: 'Upstream name',
          api: baseUrl,
          npm: '@ai-sdk/openai-compatible',
          marketVisible: true,
          models: {},
        },
      },
    })),
  )
  const fake = repository([
    {
      id: 'cred_vendor-a',
      integrationID: 'vendor-a',
      methodID: null,
      label: 'default',
      value: { type: 'key', key: 'directory-test-key' },
    },
  ])
  const config: { schemaVersion: number; providers: Record<string, unknown> } = {
    schemaVersion: 2,
    providers: {
      manual: {
        kind: 'custom',
        name: 'My manual provider',
        base_url: baseUrl,
        auth: 'none',
        models: {},
      },
    },
  }
  const service = new PiModelService(fake.adapter, { directory, config, env: {} })
  try {
    await service.refreshDirectory()
    expect(hits).toEqual([])
    const providers = await service.list()
    expect(providers.some((p) => p.id === 'vendor-a')).toBe(true)
    expect(providers.some((p) => p.id === 'vendor-b')).toBe(false)
    expect(providers.some((p) => p.id === 'separate')).toBe(true)
    expect(providers.find((p) => p.id === 'manual')).toMatchObject({
      name: 'My manual provider',
      catalogOrigin: 'user',
    })
    expect(service.pi.getModels('vendor-a')).toHaveLength(0)
    const writes: unknown[] = []
    const sync = new ModelSyncService(service, {
      read: async () => ({ layers: [{ kind: 'user', version: 'fixture' }] }),
      snapshot: () => ({ model_providers: config.providers }),
      batchWrite: async (input: Parameters<ConfigService['batchWrite']>[0]) => {
        writes.push(input)
        for (const edit of input.edits) {
          const id = edit.keyPath[1]!
          const value = (config.providers[id] ??= {}) as Record<string, unknown>
          value[edit.keyPath[2]!] = edit.value
        }
        return {} as never
      },
    } as unknown as ConfigService)
    await expect(
      sync.sync('vendor-a', { fetch: async () => new Response(null, { status: 503 }) }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    expect(writes).toEqual([])
    const synced = await sync.sync('vendor-a', {
      fetch: async (url) => {
        expect(String(url)).toBe(`${baseUrl}/models`)
        return Response.json({ data: [{ id: 'm' }] })
      },
    })
    expect(synced.candidates[0]).toMatchObject({ id: 'm', enabled: false })
    expect(config.providers['vendor-a']).toMatchObject({
      kind: 'custom',
      directory_source: 'pi-remote',
      models: {},
    })
    await service.reload()
    config.providers['vendor-a'] = {
      kind: 'custom',
      directory_source: 'pi-remote',
      name: 'My saved vendor',
      base_url: baseUrl,
      auth: 'api-key',
      env: [],
      models: { m: { api: 'openai-completions', enabled: true } },
    }
    await service.reload()
    expect((await service.list()).find((p) => p.id === 'vendor-a')?.catalogOrigin).toBe('pi-remote')
    const model = await service.getPiModel(
      Model.Ref.make({ providerID: Provider.ID.make('vendor-a'), id: Model.ID.make('m') }),
    )
    expect(model.api).toBe('openai-completions')
    expect((await service.pi.getAuth('vendor-a'))?.auth.apiKey).toBe('directory-test-key')
    const response = await service.pi.completeSimple(
      model,
      normalizeContext({ messages: [{ role: 'user', content: 'Reply OK', timestamp: 1 }] }),
      { maxTokens: 8 },
    )
    expect(response.stopReason).not.toBe('error')
    expect(hits).toEqual(['/v1/chat/completions'])
    // Existing credentials keep both configured aliases visible; no identity is merged.
    fake.values.set('vendor-b', {
      id: 'cred_vendor-b',
      integrationID: 'vendor-b',
      methodID: null,
      label: 'default',
      value: { type: 'key', key: 'another-fixture-key' },
    })
    expect((await service.list()).some((p) => p.id === 'vendor-b')).toBe(true)
  } finally {
    await service.dispose()
    server.stop(true)
  }
})

type Stored = {
  id: string
  integrationID: string
  methodID: string | null
  label: string
  value: Credential.Value
}

const repository = (initial: Stored[] = []) => {
  const values = new Map(initial.map((value) => [value.integrationID, value]))
  return {
    values,
    adapter: {
      list: () =>
        [...values.values()].map(({ value: _value, ...summary }) => ({
          ...summary,
          keyVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        })),
      get: <T>(integrationID: string) =>
        Effect.succeed(
          (values.get(integrationID) ?? null) as {
            id: string
            integrationID: string
            kind: 'api-key' | 'oauth'
            methodID: string | null
            label: string
            value: T
          } | null,
        ),
      set: (input: { integrationID: string; methodID?: string; label?: string; value: unknown }) =>
        Effect.sync(() => {
          const current = values.get(input.integrationID)
          const next: Stored = {
            id: current?.id ?? `cred_${input.integrationID}`,
            integrationID: input.integrationID,
            methodID: input.methodID ?? null,
            label: input.label ?? 'default',
            value: input.value as Credential.Value,
          }
          values.set(input.integrationID, next)
          return { ...next, keyVersion: 1, createdAt: 1, updatedAt: 1 }
        }),
      upsertOAuth: (input: {
        providerID: string
        methodID: string
        label?: string
        value: Credential.Value
      }) =>
        Effect.sync(() => {
          const current = values.get(input.providerID)
          const next: Stored = {
            id: current?.id ?? `cred_${input.providerID}`,
            integrationID: input.providerID,
            methodID: input.methodID,
            label: input.label ?? current?.label ?? 'OAuth',
            value: input.value,
          }
          values.set(input.providerID, next)
          return { ...next, keyVersion: 1, createdAt: 1, updatedAt: 1 }
        }),
      remove: (integrationID: string) => Effect.sync(() => values.delete(integrationID)),
    } as unknown as EncryptedCredentialRepository,
  }
}

describe('EncryptedCredentialStore', () => {
  test('converts encrypted Pidex credentials without exposing secrets in list', async () => {
    const key = 'sk-not-in-metadata'
    const fake = repository([
      {
        id: 'cred_openai',
        integrationID: 'openai',
        methodID: null,
        label: 'default',
        value: { type: 'key', key },
      },
    ])
    const store = new EncryptedCredentialStore(fake.adapter)

    expect(await store.read('openai')).toEqual({ type: 'api_key', key })
    expect(await store.list()).toEqual([{ providerId: 'openai', type: 'api_key' }])
    expect(JSON.stringify(await store.list())).not.toContain(key)
  })

  test('serializes OAuth refreshes per provider and preserves method metadata', async () => {
    const fake = repository([
      {
        id: 'cred_anthropic',
        integrationID: 'anthropic',
        methodID: 'oauth-default',
        label: 'account',
        value: {
          type: 'oauth',
          methodID: 'oauth-default' as never,
          refresh: 'r0',
          access: 'a0',
          expires: 1,
        },
      },
    ])
    const store = new EncryptedCredentialStore(fake.adapter)
    const seen: string[] = []

    await Promise.all([
      store.modify('anthropic', async (current) => {
        seen.push(current?.type === 'oauth' ? current.access : 'missing')
        await Bun.sleep(5)
        return { type: 'oauth', refresh: 'r1', access: 'a1', expires: 2 }
      }),
      store.modify('anthropic', async (current) => {
        seen.push(current?.type === 'oauth' ? current.access : 'missing')
        return { type: 'oauth', refresh: 'r2', access: 'a2', expires: 3 }
      }),
    ])

    expect(seen).toEqual(['a0', 'a1'])
    expect(fake.values.get('anthropic')?.methodID).toBe('oauth-default')
    expect(fake.values.get('anthropic')?.value).toMatchObject({ type: 'oauth', access: 'a2' })
  })
})

describe('PiModelService DeepSeek protocol', () => {
  const deepSeekRepository = () =>
    repository([
      {
        id: 'cred_deepseek',
        integrationID: 'deepseek',
        methodID: null,
        label: 'DeepSeek',
        value: { type: 'key', key: 'sk-deepseek-secret' },
      },
    ])

  const deepSeekConfig = (protocol?: string) => ({
    schemaVersion: 2,
    providers: {
      deepseek: {
        kind: 'builtin',
        enabled: true,
        allow_models: ['deepseek-v4-pro'],
        deny_models: [],
        models: {},
        ...(protocol ? { protocol } : {}),
      },
    },
  })

  const deepSeekRef = () => ({
    providerID: 'deepseek' as never,
    id: 'deepseek-v4-pro' as never,
  })

  test('uses the catalog protocol instead of old DeepSeek overrides, including after reload', async () => {
    const fake = deepSeekRepository()
    let config: PiModelCatalogConfig = deepSeekConfig('anthropic-messages')
    const service = new PiModelService(fake.adapter, { config: () => config, env: {} })

    try {
      const before = await service.getPiModel(deepSeekRef())
      expect(before).toMatchObject({
        api: 'openai-completions',
        baseUrl: 'https://api.deepseek.com',
        reasoning: true,
        contextWindow: 1_000_000,
      })
      expect(before.compat).toBeDefined()
      expect(await service.isAuthConfigured('deepseek')).toBe(true)
      expect(service.pi.getModels('deepseek').map((model) => model.api)).toEqual([
        'openai-completions',
        'openai-completions',
      ])

      config = deepSeekConfig('openai-beta-fim')
      await service.reload()
      expect(await service.configIssues()).toEqual([])
      expect(await service.getPiModel(deepSeekRef())).toMatchObject({
        api: 'openai-completions',
        baseUrl: 'https://api.deepseek.com',
      })
      expect((await service.list()).find((provider) => provider.id === 'deepseek')).toMatchObject({
        source: {
          kind: 'builtin',
          defaultApi: 'openai-completions',
          baseUrl: 'https://api.deepseek.com',
        },
      })
    } finally {
      await service.dispose()
    }
  })
})

describe('PiModelService', () => {
  test('reload advances catalog revision and re-evaluates OAuth model availability', async () => {
    const fake = repository()
    const selectedModels: string[] = []
    const service = new PiModelService(fake.adapter, {
      env: {},
      config: { providers: { 'openai-codex': { kind: 'builtin', allow_models: selectedModels } } },
    })
    selectedModels.push(service.pi.getModels('openai-codex')[0]!.id)
    const beforeRevision = service.catalogRevision()

    expect((await service.models('openai-codex' as never)).some((model) => model.enabled)).toBe(
      false,
    )
    fake.values.set('openai-codex', {
      id: 'cred_openai_codex',
      integrationID: 'openai-codex',
      methodID: 'openai-codex:oauth',
      label: 'OAuth',
      value: {
        type: 'oauth',
        methodID: 'openai-codex:oauth' as never,
        refresh: 'oauth-refresh-secret',
        access: 'oauth-access-secret',
        expires: Date.now() + 60_000,
      },
    })

    await service.reload()

    expect(service.catalogRevision()).toBeGreaterThan(beforeRevision)
    expect((await service.models('openai-codex' as never)).some((model) => model.enabled)).toBe(
      true,
    )
  })

  test('reports configured API key, OAuth, environment, and auth-free providers', async () => {
    const fake = repository([
      {
        id: 'cred_deepseek',
        integrationID: 'deepseek',
        methodID: null,
        label: 'DeepSeek',
        value: { type: 'key', key: 'sk-deepseek-secret' },
      },
      {
        id: 'cred_openai_codex',
        integrationID: 'openai-codex',
        methodID: null,
        label: 'OpenAI Codex',
        value: {
          type: 'oauth',
          methodID: 'oauth-default' as never,
          refresh: 'oauth-refresh-secret',
          access: 'oauth-access-secret',
          expires: Date.now() + 60_000,
        },
      },
    ])
    const service = new PiModelService(fake.adapter, {
      env: { OPENAI_API_KEY: 'sk-openai-environment-secret' },
      config: {
        schemaVersion: 2,
        providers: {
          local: {
            kind: 'custom',
            name: 'Local',
            enabled: true,
            base_url: 'http://127.0.0.1:11434/v1',
            auth: 'none',
            env: [],
            allow_insecure_http: false,
            models: {
              chat: { api: 'openai-completions' },
            },
          },
        },
      },
    })

    expect(await service.isAuthConfigured('deepseek')).toBe(true)
    expect(await service.isAuthConfigured('openai-codex')).toBe(true)
    expect(await service.isAuthConfigured('openai')).toBe(true)
    expect(await service.isAuthConfigured('local')).toBe(true)
    expect(await service.isAuthConfigured('anthropic')).toBe(false)
    expect(await service.isAuthConfigured('missing')).toBe(false)
  })

  test('maps Pi models to the existing RPC-facing model schema', async () => {
    const key = 'sk-model-secret'
    const fake = repository([
      {
        id: 'cred_openai',
        integrationID: 'openai',
        methodID: null,
        label: 'default',
        value: { type: 'key', key },
      },
    ])
    const service = new PiModelService(fake.adapter, {
      config: {
        providers: {
          openai: {
            kind: 'builtin',
            enabled: true,
            allow_models: ['gpt-6-astra'],
            deny_models: [],
          },
        },
      },
      env: {},
    })
    const piModel = service.pi
      .getModels('openai')
      .find((candidate) => candidate.id === 'gpt-6-astra')
    expect(piModel).toBeDefined()
    expect(piModel?.cost).toMatchObject({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 })
    expect(piModel?.maxTokens).toBe(128_000)
    expect(piModel?.input).toContain('image')

    const resolved = await service.resolve({
      providerID: piModel!.provider as never,
      id: Model.ID.make(piModel!.id),
    })

    expect(String(resolved.providerID)).toBe('openai')
    expect(resolved.api.type).toBe('pi')
    expect(resolved.capabilities.tools).toBe(true)
    expect(resolved.enabled).toBe(true)
    expect(JSON.stringify(resolved)).not.toContain(key)
  })

  test('maps Pi reasoning levels to existing model variants and resolves a selected level', async () => {
    const fake = repository([
      {
        id: 'cred_openai',
        integrationID: 'openai',
        methodID: null,
        label: 'default',
        value: { type: 'key', key: 'sk-test' },
      },
    ])
    const service = new PiModelService(fake.adapter, {
      config: {
        providers: {
          openai: {
            kind: 'builtin',
            enabled: true,
            allow_models: ['gpt-5'],
            deny_models: [],
          },
        },
      },
      env: {},
    })
    const piModel = service.pi.getModels('openai').find((candidate) => candidate.reasoning)
    expect(piModel).toBeDefined()

    const info = await service.resolve({
      providerID: piModel!.provider as never,
      id: Model.ID.make(piModel!.id),
      variant: Model.VariantID.make('medium'),
    })

    expect(info.variants.map((variant) => String(variant.id))).toContain('medium')
    expect(info.variant).toBe('medium')
    expect(
      await service.getPiModel({
        providerID: piModel!.provider as never,
        id: Model.ID.make(piModel!.id),
        variant: Model.VariantID.make('medium'),
      }),
    ).toBe(piModel!)
  })

  test('missing reasoning selection sends the first advertised level and preserves explicit selections', async () => {
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        bodies.push((await request.json()) as Record<string, unknown>)
        const chunk = {
          id: 'reasoning-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test',
          choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
        }
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const service = new PiModelService(repository().adapter, {
      config: {
        schemaVersion: 2,
        providers: {
          'reasoning-test': {
            kind: 'custom',
            name: 'Reasoning test',
            enabled: true,
            base_url: `${server.url}v1`,
            auth: 'none',
            models: Object.fromEntries(
              [
                ['single', ['high']],
                ['multiple', ['low', 'high']],
              ].map(([id, values]) => [
                id,
                {
                  api: 'openai-completions',
                  reasoning: true,
                  optionSpecs: {
                    reasoningLevel: { values, map: '{"reasoning_effort": reasoningLevel}' },
                  },
                },
              ]),
            ),
          },
        },
      },
      env: {},
    })
    try {
      for (const [id, variant, expected] of [
        ['single', undefined, 'high'],
        ['multiple', undefined, 'low'],
        ['multiple', 'high', 'high'],
      ] as const) {
        const info = await service.resolve({
          providerID: Provider.ID.make('reasoning-test'),
          id: Model.ID.make(id),
          ...(variant ? { variant: Model.VariantID.make(variant) } : {}),
        })
        expect(info.variant).toBe(expected)
        const model = await service.getPiModel(
          Model.Ref.make({
            providerID: info.providerID,
            id: info.id,
            variant: Model.VariantID.make(info.variant!),
          }),
        )
        const result = await service.pi
          .streamSimple(
            model,
            normalizeContext({
              messages: [{ role: 'user', content: 'test', timestamp: 0 }],
            }),
            { apiKey: 'fixture-only', reasoning: info.variant as 'low' | 'high' },
          )
          .result()
        expect(result.errorMessage).toBeUndefined()
        expect(result.stopReason).toBe('stop')
        expect(bodies.at(-1)?.reasoning_effort).toBe(expected)
      }
      expect(bodies).toHaveLength(3)
    } finally {
      await service.dispose()
      await server.stop(true)
    }
  })

  test('loads Pi native providers and preserves custom-provider precedence', async () => {
    const fake = repository([
      {
        id: 'cred_custom_shadow',
        integrationID: 'custom-shadow',
        methodID: null,
        label: 'default',
        value: { type: 'key', key: 'sk-custom-secret' },
      },
    ])
    const service = new PiModelService(fake.adapter, {
      config: {
        schemaVersion: 2,
        providers: {
          'custom-shadow': {
            kind: 'custom',
            name: 'User Shadow',
            enabled: true,
            base_url: 'https://user-shadow.example/v1',
            auth: 'api-key',
            env: [],
            models: { local: { api: 'openai-completions' } },
          },
        },
      },
      env: {},
    })

    try {
      const providers = await service.list()
      // Pi native builtin providers
      expect(
        providers.some(
          (provider) =>
            provider.source.kind === 'builtin' && provider.catalogOrigin === 'pi-bundled',
        ),
      ).toBe(true)
      // Custom provider
      const custom = providers.find((provider) => provider.id === 'custom-shadow')
      expect(custom).toMatchObject({
        name: 'User Shadow',
        source: { kind: 'custom' },
        catalogOrigin: 'user',
        availability: { status: 'ready' },
      })

      const models = await service.models()
      expect(
        models.some(
          (model) => model.providerID === 'custom-shadow' && model.id === 'local' && model.enabled,
        ),
      ).toBe(true)

      const initialRevision = service.catalogRevision()
      await service.reload()
      expect(service.catalogRevision()).toBeGreaterThan(initialRevision)

      expect(await service.isAuthConfigured('custom-shadow')).toBe(true)
    } finally {
      await service.dispose()
    }
  })
})

test('明确三档贯通推荐、旧自动配置、内置模型和协议映射，手动配置保留', async () => {
  const recommendations = new ModelRecommendationStore()
  const resolve = spyOn(recommendations, 'resolve').mockResolvedValue({
    status: 'matched',
    recommended: {
      reasoning: true,
      optionSpecs: { reasoningLevel: { values: ['none', 'low', 'high'] } },
    },
  })
  const oldOptions = { reasoningLevel: { values: ['disabled', 'enabled'], map: '{}' } }
  const config = {
    providers: {
      gateway: {
        kind: 'custom',
        enabled: true,
        name: 'Gateway',
        base_url: 'https://gateway.example/v1',
        auth: 'none',
        models: {
          'hy4-preview': {
            api: 'openai-completions',
            reasoning: true,
            smart_config: { pinned: [] },
            option_specs: oldOptions,
          },
          manual: { api: 'openai-completions', reasoning: true, option_specs: oldOptions },
        },
      },
      google: { kind: 'builtin', enabled: true, models: {} as Record<string, unknown> },
    },
  }
  let service = new PiModelService(repository().adapter, { recommendations, config })
  const builtinID = service.pi.getModels('google')[0]!.id
  config.providers.google.models[builtinID] = {
    enabled: true,
    smart_config: { pinned: [] },
    option_specs: oldOptions,
  }
  try {
    const preview = await service.previewRecommendation({
      providerId: 'gateway',
      modelId: 'hy4-preview',
      modelType: 'chat',
    })
    expect(preview.recommended.optionSpecs?.reasoningLevel?.values).toEqual(['none', 'low', 'high'])
    const check = async () => {
      expect(
        (await service.models('gateway' as never))
          .find((model) => model.id === 'hy4-preview')
          ?.variants.map((variant) => String(variant.id)),
      ).toEqual(['none', 'low', 'high'])
      expect(
        (await service.models('gateway' as never))
          .find((model) => model.id === 'manual')
          ?.variants.map((variant) => String(variant.id)),
      ).toEqual(['disabled', 'enabled'])
      expect(
        (await service.models('google' as never))[0]?.variants.map((variant) => String(variant.id)),
      ).toEqual(['none', 'low', 'high'])
    }
    await check()
    const model = await service.getPiModel({
      providerID: 'gateway',
      id: 'hy4-preview',
      variant: 'low',
    } as never)
    const specs = (
      model as typeof model & { optionSpecs: Parameters<typeof compileOptionSpecs>[0] }
    ).optionSpecs
    const patch = applyModelOptionMap({}, compileOptionSpecs(specs)!, { reasoningLevel: 'low' })
    expect(patch).toMatchObject({ reasoning_effort: 'low', reasoning: { effort: 'low' } })
    expect(config.providers.gateway.models['hy4-preview'].option_specs).toEqual(oldOptions)
    await service.dispose()
    service = new PiModelService(repository().adapter, { recommendations, config })
    await check()
  } finally {
    await service.dispose()
    resolve.mockRestore()
  }
})

test('模型自身声明的档位不被 ZCode 通用两档覆盖，且空 map 不清除思考字段', async () => {
  const recommendations = new ModelRecommendationStore()
  // 本机 magpie 这类网关不在 models.dev，官方身份命中但没有任何档位推荐。
  const resolve = spyOn(recommendations, 'resolve').mockResolvedValue({
    status: 'matched',
    recommended: { reasoning: true },
  })
  const generic = { reasoningLevel: { values: ['disabled', 'enabled'], map: '{}' } }
  const config = {
    providers: {
      gateway: {
        kind: 'custom',
        enabled: true,
        name: 'Gateway',
        base_url: 'https://gateway.example/v1',
        auth: 'none',
        models: {
          // 网关映射到官方 hy4-preview，但自身只声明了 high。
          'hy4-preview': {
            api: 'openai-completions',
            reasoning: true,
            option_specs: generic,
            thinking_level_map: {
              off: null,
              minimal: null,
              low: null,
              medium: null,
              high: 'high',
              xhigh: null,
              max: null,
            },
          },
          // 网关自己声明了 low/high，比通用两档更精确。
          hy3: {
            api: 'openai-completions',
            reasoning: true,
            option_specs: generic,
            thinking_level_map: {
              off: null,
              minimal: null,
              low: 'low',
              medium: null,
              high: 'high',
              xhigh: null,
              max: null,
            },
          },
          // 没有任何声明时保留通用兜底。
          mystery: { api: 'openai-completions', reasoning: true, option_specs: generic },
        },
      },
    },
  }
  const service = new PiModelService(repository().adapter, { recommendations, config })
  try {
    const variants = async (id: string) =>
      (await service.models('gateway' as never))
        .find((model) => model.id === id)
        ?.variants.map((variant) => String(variant.id))
    expect(await variants('hy4-preview')).toEqual(['high'])
    expect(await variants('hy3')).toEqual(['low', 'high'])
    expect(await variants('mystery')).toEqual(['disabled', 'enabled'])
    // 模型声明的档位仍可被请求，通用 disabled 不再可选。
    await expect(
      service.getPiModel({ providerID: 'gateway', id: 'hy4-preview', variant: 'high' } as never),
    ).resolves.toBeDefined()
    await expect(
      service.getPiModel({
        providerID: 'gateway',
        id: 'hy4-preview',
        variant: 'disabled',
      } as never),
    ).rejects.toMatchObject({ code: 'VARIANT_NOT_FOUND' })
  } finally {
    await service.dispose()
    resolve.mockRestore()
  }
})

test('v1 推理开关走 Pi 原生控制且不发送不支持的 temperature', async () => {
  const recommendations = new ModelRecommendationStore()
  const resolve = spyOn(recommendations, 'resolve').mockResolvedValue({
    status: 'matched',
    recommended: {
      reasoning: true,
      optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } },
      catalog: { temperature: false, reasoningOptions: [{ type: 'toggle' }] },
    },
  })
  const bodies: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>)
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const service = new PiModelService(repository().adapter, {
    recommendations,
    config: {
      providers: {
        toggle: {
          kind: 'custom',
          name: 'Toggle',
          base_url: `${server.url}v1`,
          auth: 'none',
          models: {
            'toggle-example': {
              api: 'openai-completions',
              reasoning: true,
              option_specs: { reasoningLevel: { values: ['disabled', 'enabled'], map: '{}' } },
            },
          },
        },
      },
    },
  })
  try {
    const model = await service.getPiModel({ providerID: 'toggle', id: 'toggle-example' } as never)
    for (const reasoning of ['enabled', 'disabled']) {
      await service.pi
        .streamSimple(
          model,
          normalizeContext({ messages: [{ role: 'user', content: 'test', timestamp: 0 }] }),
          { apiKey: 'fixture-only', reasoning: reasoning as never, temperature: 0.5 },
        )
        .result()
    }
    expect(bodies[0]?.reasoning_effort).toBe('medium')
    expect(bodies[1]?.reasoning_effort).toBeUndefined()
    expect(bodies.every((body) => body.temperature === undefined)).toBe(true)
  } finally {
    await service.dispose()
    await server.stop(true)
    resolve.mockRestore()
  }
})

test('内置目录模型经当前协议过滤后无可发送模态时，发现结果省略 input 并通过 RPC schema', async () => {
  const service = new PiModelService(repository().adapter)
  await service.models()
  const native = service.pi.getModels('google')[0]!
  const getModels = spyOn(service.pi, 'getModels').mockReturnValue([
    { ...native, api: 'openai-responses', input: ['audio'] } as never,
  ])
  try {
    const models = await service.discoverBuiltinModels('google')
    expect(models).toHaveLength(1)
    expect(models[0]?.input).toBeUndefined()
    expect(() =>
      Schema.decodeUnknownSync(Schema.Array(ProviderModelDefinitionSchema))(models),
    ).not.toThrow()
  } finally {
    getModels.mockRestore()
    await service.dispose()
  }
})

test('文档字段优先于目录，缺项继承目录，手动整份模式不被重匹配', async () => {
  const recommendations = new ModelRecommendationStore()
  const resolve = spyOn(recommendations, 'resolve').mockResolvedValue({
    status: 'matched',
    recommended: { name: 'Catalog name', contextWindow: 100000, maxTokens: 12000 },
  })
  const document = {
    url: 'https://example.com/docs',
    extractor: { providerID: 'openai', id: 'model' },
    extractedAt: 123,
    data: { contextWindow: 150000000 },
    evidence: ['150M context'],
  }
  const config = {
    providers: {
      docs: {
        kind: 'custom',
        name: 'Docs',
        enabled: true,
        base_url: 'https://example.com/v1',
        auth: 'none',
        models: {
          automatic: {
            api: 'openai-completions',
            smart_config: { pinned: [], source: 'document', document },
          },
          manual: {
            api: 'openai-completions',
            context_window: 60000,
            smart_config: { pinned: [], enabled: false, source: 'document', document },
          },
        },
      },
    },
  }
  const service = new PiModelService(repository().adapter, { config, recommendations })
  try {
    const automatic = await service.getPiModel({ providerID: 'docs', id: 'automatic' } as never)
    expect(automatic.contextWindow).toBe(150000000)
    expect(automatic.maxTokens).toBe(12000)
    expect(automatic.name).toBe('Catalog name')
    resolve.mockResolvedValue({
      status: 'matched',
      recommended: { name: 'Updated', contextWindow: 200000, maxTokens: 16000 },
    })
    config.providers.docs.models.automatic.smart_config.document.extractedAt++
    await service.reload()
    expect(
      (await service.getPiModel({ providerID: 'docs', id: 'automatic' } as never)).contextWindow,
    ).toBe(150000000)
    expect(
      (await service.getPiModel({ providerID: 'docs', id: 'automatic' } as never)).maxTokens,
    ).toBe(16000)
    expect(
      (await service.getPiModel({ providerID: 'docs', id: 'manual' } as never)).contextWindow,
    ).toBe(60000)
  } finally {
    await service.dispose()
    resolve.mockRestore()
  }
})

test('内置 Provider 无需 smartConfig 直接热更新定价/阶梯与思考映射，用户手工字段保留且新模型默认不进聊天列表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidex-builtin-hot-update-'))
  let version = 1
  const catalogFor = (ver: number) => ({
    models: {
      'deepseek/deepseek-v4.1-flash-1017': {
        name: ver === 1 ? 'DeepSeek Flash v1' : 'DeepSeek Flash v2',
        limit: { context: 1_000_000, output: ver === 1 ? 384_000 : 512_000 },
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
      },
    },
    providers: {
      deepseek: {
        name: 'DeepSeek',
        api: 'https://api.deepseek.com',
        npm: '@ai-sdk/openai-compatible',
        marketVisible: true,
        models: {
          'deepseek-flash': {
            canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017',
            name: ver === 1 ? 'DeepSeek Flash v1' : 'DeepSeek Flash v2',
            pi_api: 'openai-completions',
            base_url: 'https://api.deepseek.com',
            limit: { context: 1_000_000, output: ver === 1 ? 384_000 : 512_000 },
            reasoning: true,
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            option_specs: {
              reasoningLevel: {
                values: ['off', 'high', 'max'],
                map: '{"custom_effort": reasoningLevel}',
              },
            },
            pricing: {
              currency: 'CNY',
              timeZone: 'Asia/Shanghai',
              defaultPeriod: 'idle',
              idle: {
                input: ver === 1 ? 1 : 0.8,
                output: 4,
                cacheRead: 0.02,
                cacheWrite: 0,
                tiers: [
                  {
                    inputTokensAbove: 200_000,
                    input: 1.5,
                    output: 6,
                    cacheRead: 0.03,
                    cacheWrite: 0,
                  },
                ],
              },
              busy: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 },
              rules: [],
              dateOverrides: [],
            },
          },
          'deepseek-brand-new': {
            name: 'DeepSeek Brand New',
            pi_api: 'openai-completions',
            base_url: 'https://api.deepseek.com',
            limit: { context: 128_000, output: 16_000 },
            reasoning: false,
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
    },
  })
  const fetcher = fixtureV2Fetch(() => catalogFor(version))
  const dirPath = join(dir, 'provider-directory.json')
  const recPath = join(dir, 'model-recommendations.json')
  const directory = new ProviderDirectoryStore(dirPath, fetcher)
  const recommendations = new ModelRecommendationStore(recPath, fetcher)
  const fake = repository([
    {
      id: 'cred_deepseek',
      integrationID: 'deepseek',
      methodID: null,
      label: 'DeepSeek',
      value: { type: 'key', key: 'sk-deepseek' },
    },
  ])
  const config: PiModelCatalogConfig = {
    schemaVersion: 2,
    providers: {
      deepseek: {
        kind: 'builtin',
        enabled: true,
        models: {
          // Only enabled + user-overridden contextWindow; NO smartConfig!
          'deepseek-flash': { enabled: true, context_window: 777_777 },
        },
      },
      'legacy-dev-vendor': {
        kind: 'custom',
        directory_source: 'models-dev',
        name: 'Legacy Vendor',
        base_url: 'https://legacy.example/v1',
        auth: 'none',
        models: {
          chat: { api: 'openai-completions', enabled: true },
        },
      },
    },
  }
  const service = new PiModelService(fake.adapter, { directory, recommendations, config })
  try {
    await service.refreshDirectory()
    const models1 = await service.models('deepseek' as never)
    const flash1 = models1.find((m) => m.id === 'deepseek-flash')!
    expect(flash1.name).toBe('DeepSeek Flash v1')
    expect(flash1.limit.context).toBe(777_777)
    expect(flash1.limit.output).toBe(384_000)
    expect(flash1.variants.map((v) => String(v.id))).toEqual(['off', 'high', 'max'])
    // Brand-new model from catalog is in discovery (enabled: false) and NOT auto-enabled in active models.
    expect(models1.some((m) => m.id === 'deepseek-brand-new')).toBe(false)
    const discovered = await service.discoverBuiltinModels('deepseek')
    expect(discovered.find((m) => m.id === 'deepseek-brand-new')?.enabled).toBe(false)
    expect(
      discovered.find((m) => m.id === 'deepseek-flash')?.pricing?.idle.tiers?.[0]?.inputTokensAbove,
    ).toBe(200_000)

    const piFlash1 = (await service.getPiModel({
      providerID: 'deepseek',
      id: 'deepseek-flash',
      variant: 'high',
    } as never)) as unknown as {
      optionSpecs: Parameters<typeof compileOptionSpecs>[0]
      pricing?: Model.Pricing
    }
    expect(piFlash1.pricing?.idle.input).toBe(1)
    expect(
      applyModelOptionMap({}, compileOptionSpecs(piFlash1.optionSpecs)!, {
        reasoningLevel: 'high',
      }),
    ).toEqual({ custom_effort: 'high' })

    // Catalog hot-update: untouched fields (name, maxTokens, pricing) update; user contextWindow stays 777_777.
    version = 2
    await service.refreshDirectory()
    const flash2 = (await service.models('deepseek' as never)).find(
      (m) => m.id === 'deepseek-flash',
    )!
    expect(flash2.name).toBe('DeepSeek Flash v2')
    expect(flash2.limit.output).toBe(512_000)
    expect(flash2.limit.context).toBe(777_777)
    const piFlash2 = (await service.getPiModel({
      providerID: 'deepseek',
      id: 'deepseek-flash',
    } as never)) as { pricing?: Model.Pricing }
    expect(piFlash2.pricing?.idle.input).toBe(0.8)

    // Existing saved custom provider with directory_source = "models-dev" still loads cleanly.
    expect((await service.models('legacy-dev-vendor' as never)).some((m) => m.id === 'chat')).toBe(
      true,
    )
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('curated bundled catalog lists both Moonshot regions and preserves saved providers and smartConfig', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidex-curated-market-'))
  const dirPath = join(dir, 'provider-directory.json')
  const recPath = join(dir, 'model-recommendations.json')
  const directory = new ProviderDirectoryStore(dirPath, fetch, { bundledFallback: true })
  const recommendations = new ModelRecommendationStore(recPath, fetch, { bundledFallback: true })
  const fake = repository()
  const config: Record<string, unknown> = {
    schema_version: 2,
    providers: {},
  }
  const service = new PiModelService(fake.adapter, {
    directory,
    recommendations,
    config,
    env: { DASHSCOPE_API_KEY: '' },
  })
  try {
    const market = await service.list()
    const cleanMarket = market.map((p) => String(p.id)).sort()
    expect(cleanMarket).toEqual([
      'deepseek',
      'minimax',
      'minimax-cn',
      'moonshotai',
      'moonshotai-cn',
      'qianwen-cn',
      'qwen-token-plan',
      'qwen-token-plan-cn',
      'qwencloud-beijing',
      'qwencloud-frankfurt',
      'qwencloud-hongkong',
      'qwencloud-singapore',
      'qwencloud-tokyo',
      'qwencloud-virginia',
    ])
    for (const [id, host, currency] of [
      ['moonshotai', 'api.moonshot.ai', 'USD'],
      ['moonshotai-cn', 'api.moonshot.cn', 'CNY'],
    ] as const) {
      expect(market.find((p) => p.id === id)).toMatchObject({
        auth: { apiKey: true },
        source: { env: ['MOONSHOT_API_KEY'], baseUrl: `https://${host}/v1` },
      })
      const models = await service.discoverBuiltinModels(id)
      expect(models.find((model) => model.id === 'kimi-k3.1-pro')?.pricing?.currency).toBe(currency)
    }
    expect(service.catalogModelCount('deepseek')).toBe(2)
    expect(service.catalogModelCount('minimax-cn')).toBe(2)
    expect(service.catalogModelCount('minimax')).toBe(2)

    const qwen = 'qianwen-cn'
    expect(await service.isAuthConfigured(qwen)).toBe(false)
    const qwenModels = Schema.decodeUnknownSync(Schema.Array(ProviderModelDefinitionSchema))(
      await service.discoverDirectoryModels(qwen),
    )
    expect(qwenModels).toHaveLength(18)
    expect(qwenModels).toHaveLength(service.catalogModelCount(qwen))
    expect(qwenModels.some((model) => model.pricing?.currency === 'CNY')).toBe(true)
    expect(qwenModels.find((model) => model.id === 'qwen4-max')).toMatchObject({
      input: expect.arrayContaining(['video']),
      catalog: { input: expect.arrayContaining(['pdf']) },
    })
    expect(await service.models(Provider.ID.make(qwen))).toEqual([])

    // MiniMax CN overlay is enriched onto builtin models (M3.1-Flash effort + M3 >512K CNY tiers).
    const minimaxModels = await service.discoverBuiltinModels('minimax-cn')
    const m31Flash = minimaxModels.find((m) => m.id === 'MiniMax-M3.1-Flash')
    expect(m31Flash?.pricing?.currency).toBe('CNY')
    expect(m31Flash?.pricing?.idle.input).toBe(1)
    expect(m31Flash?.optionSpecs?.reasoningLevel?.values).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    const m3 = minimaxModels.find((m) => m.id === 'MiniMax-M3')
    expect(m3?.pricing?.currency).toBe('CNY')
    expect(m3?.pricing?.idle.tiers?.[0]?.inputTokensAbove).toBe(512_000)

    // Saving a credential for a hidden builtin provider keeps it visible without revealing others.
    fake.values.set('openai', {
      id: 'cred_openai',
      integrationID: 'openai',
      methodID: null,
      label: 'default',
      value: { type: 'key', key: 'sk-saved-legacy-openai' },
    })
    const withSavedOpenAI = (await service.list()).map((p) => String(p.id)).sort()
    expect(withSavedOpenAI).toEqual([...cleanMarket, 'openai'].sort())

    Object.assign(config.providers as Record<string, unknown>, {
      [qwen]: {
        kind: 'custom',
        base_url: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
        auth: 'none',
        models: {
          'qwen4-max': {
            api: 'openai-completions',
            input: ['text', 'image', 'video'],
            smart_config: { pinned: [] },
          },
        },
      },
    })
    const qwenRef = { providerID: Provider.ID.make(qwen), id: Model.ID.make('qwen4-max') }
    expect((await service.resolve(qwenRef)).capabilities.input).toEqual(
      expect.arrayContaining(['video', 'pdf']),
    )
    let qwenPayload: unknown
    await service.pi.completeSimple(
      await service.getPiModel(qwenRef),
      {
        systemPrompt: 'Follow the workspace instructions.',
        messages: [{ role: 'user', content: 'Reply OK.', timestamp: 1 }],
      },
      {
        apiKey: 'fixture-key',
        maxTokens: 64,
        onPayload: (payload) => {
          qwenPayload = payload
          throw new Error('Stop before network')
        },
      },
    )
    expect(qwenPayload).toMatchObject({
      messages: [
        { role: 'system', content: 'Follow the workspace instructions.' },
        { role: 'user', content: 'Reply OK.' },
      ],
    })

    // Manually added custom provider still gets full smartConfig from hidden catalog providers/models.
    const openaiMatch = await recommendations.resolve({
      providerId: 'custom-provider',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-5',
      modelType: 'chat',
    })
    expect(openaiMatch.status).toBe('matched')
    expect(openaiMatch.recommended.contextWindow).toBeGreaterThan(0)

    const claudeMatch = await recommendations.resolve({
      providerId: 'custom-provider-2',
      baseUrl: 'https://api.anthropic.com/v1',
      modelId: 'claude-sonnet-4-5',
      modelType: 'chat',
    })
    expect(claudeMatch.status).toBe('matched')
    expect(claudeMatch.recommended.contextWindow).toBeGreaterThan(0)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Moonshot uses catalog protocols in both regions and dispatches both Kimi fast aliases', async () => {
  const directory = new ProviderDirectoryStore(undefined, fetch, { bundledFallback: true })
  const recommendations = new ModelRecommendationStore(undefined, fetch, { bundledFallback: true })
  const config = {
    schemaVersion: 2,
    providers: {
      moonshotai: {
        kind: 'builtin',
        protocol: 'anthropic-messages',
        base_url: 'https://api.moonshot.ai/anthropic/',
        allow_models: ['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
      },
      'moonshotai-cn': {
        kind: 'builtin',
        protocol: 'anthropic-messages',
        base_url: 'https://api.moonshot.cn/anthropic',
        allow_models: ['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
      },
      'moonshot-direct': {
        kind: 'custom',
        base_url: 'https://api.moonshot.ai/anthropic',
        auth: 'none',
        models: {
          'kimi-k2.7-code': { api: 'anthropic-messages', smart_config: { pinned: [] } },
        },
      },
    },
  }
  const service = new PiModelService(repository().adapter, {
    directory,
    recommendations,
    config,
    env: { MOONSHOT_API_KEY: 'unit-moonshot-key' },
  })
  const ref = (providerID: string, id: string) => ({
    providerID: Provider.ID.make(providerID),
    id: Model.ID.make(id),
  })
  try {
    for (const [providerId, host] of [
      ['moonshotai', 'api.moonshot.ai'],
      ['moonshotai-cn', 'api.moonshot.cn'],
    ] as const) {
      for (const id of ['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6']) {
        expect(await service.getPiModel(ref(providerId, id))).toMatchObject({
          api: 'openai-completions',
          baseUrl: `https://${host}/v1`,
        })
      }
      expect(
        (await service.providerDefinitions()).find((provider) => provider.id === providerId),
      ).not.toHaveProperty('baseUrl')
      expect(
        (await service.list()).find((provider) => String(provider.id) === providerId),
      ).toMatchObject({
        source: { defaultApi: 'openai-completions', baseUrl: `https://${host}/v1` },
      })
    }
    await expect(service.getPiModel(ref('moonshot-direct', 'kimi-k2.7-code'))).rejects.toThrow(
      '仅支持 openai-completions',
    )
    await expect(
      service.previewRecommendation({
        providerId: 'moonshotai',
        modelId: 'kimi-k2.7-code',
        modelType: 'chat',
        api: 'openai-responses',
      }),
    ).rejects.toThrow('仅支持 openai-completions')
    expect(
      await service.previewRecommendation({
        providerId: 'moonshotai',
        modelId: 'kimi-k3.1-pro',
        modelType: 'chat',
        api: 'openai-responses',
      }),
    ).toMatchObject({ status: 'matched' })

    for (const [providerId, currency, rates, k2Rate] of [
      ['moonshotai', 'USD', { '5m': 4, '1h': 8 }, 1.9],
      ['moonshotai-cn', 'CNY', { '5m': 26, '1h': 52 }, 13],
    ] as const) {
      const fastK2 = await service.getPiModel({
        ...ref(providerId, 'kimi-k2.7-code'),
        speedTier: 'fast',
      })
      const fastK3 = await service.getPiModel({
        ...ref(providerId, 'kimi-k3.1-pro'),
        speedTier: 'fast',
      })
      expect(fastK2).toMatchObject({
        speedInvocation: { requestModelId: 'kimi-k2.7-code-highspeed' },
        pricing: { currency, busy: { input: k2Rate, cacheWrite: 0 } },
      })
      expect(fastK3).toMatchObject({
        speedInvocation: { requestModelId: 'kimi-k3.1-pro-highspeed' },
        pricing: { currency, busy: { cacheWriteByTtl: rates } },
      })
      expect(await service.getPiModel(ref(providerId, 'kimi-k3.1-pro-highspeed'))).toMatchObject({
        speedTier: 'fast',
      })
      await expect(
        service.getPiModel({ ...ref(providerId, 'kimi-k3.1-pro'), speedTier: 'ultrafast' }),
      ).rejects.toThrow('不支持所选速度档位')
    }
  } finally {
    await service.dispose()
  }
})

test('SmartConfig intersects known custom endpoints with model protocol order', async () => {
  const baseUrl = 'https://api.moonshot.ai/anthropic'
  const openai = 'https://api.moonshot.ai/v1'
  const service = new PiModelService(repository().adapter, {
    directory: new ProviderDirectoryStore(undefined, fetch, { bundledFallback: true }),
    recommendations: new ModelRecommendationStore(undefined, fetch, { bundledFallback: true }),
    config: {
      providers: {
        'moonshot-multi': {
          kind: 'custom',
          auth: 'none',
          base_url: baseUrl,
          endpoints: { 'anthropic-messages': baseUrl, 'openai-completions': openai },
          models: { 'kimi-k2.7-code': { api: 'anthropic-messages', smart_config: { pinned: [] } } },
        },
        'moonshot-no-completions': {
          kind: 'custom',
          auth: 'none',
          base_url: baseUrl,
          endpoints: { 'anthropic-messages': baseUrl, 'openai-responses': openai },
          models: { 'kimi-k3.1-pro': { api: 'anthropic-messages', smart_config: { pinned: [] } } },
        },
        relay: {
          kind: 'custom',
          auth: 'none',
          base_url: 'https://relay.example/anthropic',
          endpoints: {
            'anthropic-messages': 'https://relay.example/anthropic',
            'openai-completions': 'https://relay.example/v1',
          },
          models: {
            'moonshotai/kimi-k2.7-code': {
              api: 'anthropic-messages',
              smart_config: { pinned: [] },
            },
          },
        },
      },
    },
  })
  try {
    for (const [providerId, id, api] of [
      ['moonshot-multi', 'kimi-k2.7-code', 'openai-completions'],
      ['moonshot-no-completions', 'kimi-k3.1-pro', 'openai-responses'],
    ] as const) {
      expect(
        await service.previewRecommendation({
          providerId,
          baseUrl,
          modelId: id,
          modelType: 'chat',
          api: 'anthropic-messages',
        }),
      ).toMatchObject({ status: 'matched', recommendedApi: api })
      expect(
        await service.getPiModel({
          providerID: Provider.ID.make(providerId),
          id: Model.ID.make(id),
        }),
      ).toMatchObject({ api, baseUrl: openai })
    }
    expect(
      await service.getPiModel({
        providerID: Provider.ID.make('relay'),
        id: Model.ID.make('moonshotai/kimi-k2.7-code'),
      }),
    ).toMatchObject({ api: 'anthropic-messages', baseUrl: 'https://relay.example/anthropic' })
  } finally {
    await service.dispose()
  }
})

test('catalog seeding locks available models, preserves added and delisted models, and resets after the last credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidex-builtin-seed-'))
  const dirPath = join(dir, 'provider-directory.json')
  const recPath = join(dir, 'model-recommendations.json')
  const directory = new ProviderDirectoryStore(dirPath, fetch, { bundledFallback: true })
  const recommendations = new ModelRecommendationStore(recPath, fetch, { bundledFallback: true })
  const fake = repository()
  const snapshot: Record<string, unknown> = {
    model_catalog: { schema_version: 2 },
    model_providers: {},
  }
  const config = {
    snapshot: () => structuredClone(snapshot),
    batchWrite: async ({
      edits,
    }: {
      edits: readonly { keyPath: readonly string[]; value: unknown }[]
    }) => {
      for (const edit of edits) {
        let cursor = snapshot
        for (let i = 0; i < edit.keyPath.length - 1; i++) {
          const segment = edit.keyPath[i]!
          const next = cursor[segment]
          if (!next || typeof next !== 'object' || Array.isArray(next)) {
            cursor[segment] = {}
          }
          cursor = cursor[segment] as Record<string, unknown>
        }
        const leaf = edit.keyPath[edit.keyPath.length - 1]!
        if (edit.value === null) delete cursor[leaf]
        else cursor[leaf] = structuredClone(edit.value)
      }
      return { settingsVersion: 1 } as never
    },
  }
  const service = new PiModelService(fake.adapter, {
    directory,
    recommendations,
    config: () => ({
      schemaVersion: 2,
      providers: (snapshot.model_providers as Record<string, unknown>) ?? {},
    }),
    env: {},
  })
  try {
    await service.list()
    const seeded = await seedBuiltinProviderCatalogModels({
      providerID: 'minimax',
      piModels: service,
      config,
      hadCredentialsBefore: false,
    })
    expect(seeded).toBe(true)
    const savedMinimax = (snapshot.model_providers as Record<string, Record<string, unknown>>)
      .minimax
    expect(savedMinimax?.allow_models).toEqual(['MiniMax-M3', 'MiniMax-M3.1-Flash'])
    expect(savedMinimax?.models).toEqual({
      'MiniMax-M3': { enabled: true },
      'MiniMax-M3.1-Flash': { enabled: true },
    })

    const skippedSecondKey = await seedBuiltinProviderCatalogModels({
      providerID: 'minimax',
      piModels: service,
      config,
      hadCredentialsBefore: true,
    })
    expect(skippedSecondKey).toBe(false)

    fake.values.set('minimax', {
      id: 'cred_minimax',
      integrationID: 'minimax',
      methodID: null,
      label: 'default',
      value: { type: 'key', key: 'sk-minimax' },
    })
    await service.reload()
    const enabledIds = (await service.models('minimax' as never)).map((m) => String(m.id)).sort()
    expect(enabledIds).toEqual(['MiniMax-M3', 'MiniMax-M3.1-Flash'])

    savedMinimax!.allow_models = [
      'MiniMax-M3',
      'MiniMax-M3.1-Flash',
      'MiniMax-M2.7',
      'MiniMax-Custom-Preview',
    ]
    ;(savedMinimax!.models as Record<string, unknown>)['MiniMax-Custom-Preview'] = {
      enabled: true,
      name: 'MiniMax Custom Preview',
      api: 'openai-completions',
      context_window: 200_000,
      max_tokens: 16_384,
      reasoning: true,
    }
    await service.reload()
    expect(service.pi.getModel('minimax', 'MiniMax-M2.7')).toBeDefined()
    expect(service.pi.getModel('minimax', 'MiniMax-Custom-Preview')).toMatchObject({
      id: 'MiniMax-Custom-Preview',
      name: 'MiniMax Custom Preview',
      api: 'openai-completions',
      contextWindow: 200_000,
      maxTokens: 16_384,
      reasoning: true,
    })
    expect(
      (await service.models('minimax' as never)).map((model) => String(model.id)).sort(),
    ).toEqual(['MiniMax-Custom-Preview', 'MiniMax-M2.7', 'MiniMax-M3', 'MiniMax-M3.1-Flash'])
    const resolvedCustom = await service.getPiModel({
      providerID: Provider.ID.make('minimax'),
      id: Model.ID.make('MiniMax-Custom-Preview'),
    })
    expect(resolvedCustom).toMatchObject({
      id: 'MiniMax-Custom-Preview',
      name: 'MiniMax Custom Preview',
      api: 'openai-completions',
      contextWindow: 200_000,
    })
    expect((resolvedCustom as { pricing?: unknown }).pricing).toBeUndefined()
    expect(service.catalogModelCount('minimax')).toBe(2)
    expect(
      (await service.discoverBuiltinModels('minimax')).map((model) => String(model.id)).sort(),
    ).toEqual(enabledIds)
    expect(savedMinimax!.allow_models).toContain('MiniMax-M2.7')

    const notResetWhileKeyExists = await resetUnconfiguredBuiltinProvider({
      providerID: 'minimax',
      piModels: service,
      providerCredentials: { list: async () => [{ id: 'cred_minimax' } as never] },
      config,
    })
    expect(notResetWhileKeyExists).toBe(false)

    fake.values.delete('minimax')
    await service.reload()
    const reset = await resetUnconfiguredBuiltinProvider({
      providerID: 'minimax',
      piModels: service,
      providerCredentials: { list: async () => [] },
      config,
    })
    expect(reset).toBe(true)
    expect((snapshot.model_providers as Record<string, unknown>).minimax).toBeUndefined()
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('catalog protocolEndpoints drive builtin protocol defaults, live overrides, and user precedence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pidex-catalog-protocol-endpoints-'))
  const dirPath = join(dir, 'provider-directory.json')
  const recPath = join(dir, 'model-recommendations.json')
  const fetcher = fixtureV2Fetch(() => ({
    owner: 'pidex-model-catalog',
    schemaVersion: 1,
    models: {},
    providers: {
      'qwen-token-plan-cn': {
        name: 'Qwen AI Token Plan (China)',
        api: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
        protocolEndpoints: {
          'openai-completions': 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
          'anthropic-messages': 'https://override.qianwenaiapi.com/apps/anthropic',
        },
        marketVisible: false,
        models: {
          'qwen3.8-max': {
            name: 'Qwen3.8 Max',
            pi_api: 'anthropic-messages',
            limit: { context: 131072, output: 32768 },
          },
        },
      },
    },
  }))
  const directory = new ProviderDirectoryStore(dirPath, fetcher, { bundledFallback: true })
  const recommendations = new ModelRecommendationStore(recPath, fetcher, { bundledFallback: true })
  const fake = repository()
  const config: Record<string, unknown> = {
    schema_version: 2,
    providers: {
      'qwen-token-plan-cn': {
        kind: 'builtin',
        enabled: true,
        protocol: 'anthropic-messages',
      },
    },
  }
  const service = new PiModelService(fake.adapter, { directory, recommendations, config, env: {} })
  try {
    const bundledList = await service.list()
    const qwenBundled = bundledList.find((p) => String(p.id) === 'qwen-token-plan-cn')
    expect(qwenBundled?.source.endpoints?.['openai-completions']).toBe(
      'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
    )
    expect(qwenBundled?.source.endpoints?.['anthropic-messages']).toBe(
      'https://token-plan.maas.qianwenaiapi.com/apps/anthropic',
    )
    const runtimeBundled = service.pi.getModels('qwen-token-plan-cn')[0]
    expect(runtimeBundled?.api).toBe('openai-completions')
    expect(runtimeBundled?.baseUrl).toBe(
      'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
    )

    // Online catalog protocolEndpoints override bundled defaults.
    await directory.refresh()
    await service.reload()
    const runtimeRefreshed = service.pi.getModels('qwen-token-plan-cn')[0]
    expect(runtimeRefreshed?.api).toBe('anthropic-messages')
    expect(runtimeRefreshed?.baseUrl).toBe('https://override.qianwenaiapi.com/apps/anthropic')

    // Explicit user config.endpoints still wins over catalog.
    config.providers = {
      'qwen-token-plan-cn': {
        kind: 'builtin',
        enabled: true,
        protocol: 'anthropic-messages',
        endpoints: {
          'anthropic-messages': 'https://custom-proxy.example.com/apps/anthropic',
        },
      },
    }
    await service.reload()
    const runtimeCustom = service.pi.getModels('qwen-token-plan-cn')[0]
    expect(runtimeCustom?.baseUrl).toBe('https://custom-proxy.example.com/apps/anthropic')
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('defaults system instructions to system role on openai-completions and non-OpenAI openai-responses endpoints', async () => {
  const fake = repository()
  const config: Record<string, unknown> = {
    schema_version: 2,
    providers: {
      'custom-relay': {
        kind: 'custom',
        name: 'Custom Relay',
        base_url: 'https://relay.example.com/v1',
        auth: 'none',
        models: {
          'deepseek-r1-completions': {
            api: 'openai-completions',
            reasoning: true,
          },
          'explicit-developer-completions': {
            api: 'openai-completions',
            reasoning: true,
            compat: { supportsDeveloperRole: true },
          },
          'deepseek-r1-responses': {
            api: 'openai-responses',
            reasoning: true,
          },
          'gpt-5.2': {
            api: 'openai-responses',
            reasoning: true,
          },
        },
      },
    },
  }
  const service = new PiModelService(fake.adapter, { config, env: {} })
  const capturePayload = async (modelId: string, viaRawPiGetModel = false) => {
    const model = viaRawPiGetModel
      ? service.pi.getModel('custom-relay', modelId)!
      : await service.getPiModel({
          providerID: Provider.ID.make('custom-relay'),
          id: Model.ID.make(modelId),
        })
    let captured: unknown
    await service.pi.completeSimple(
      model,
      {
        systemPrompt: 'Follow workspace rules.',
        messages: [{ role: 'user', content: 'Hello', timestamp: 1 }],
      },
      {
        apiKey: 'fixture-key',
        maxTokens: 64,
        onPayload: (payload) => {
          captured = payload
          throw new Error('Stop before network')
        },
      },
    )
    return captured
  }
  try {
    expect(await capturePayload('deepseek-r1-completions')).toMatchObject({
      messages: [
        { role: 'system', content: 'Follow workspace rules.' },
        { role: 'user', content: 'Hello' },
      ],
    })
    expect(await capturePayload('deepseek-r1-completions', true)).toMatchObject({
      messages: [
        { role: 'system', content: 'Follow workspace rules.' },
        { role: 'user', content: 'Hello' },
      ],
    })
    expect(await capturePayload('explicit-developer-completions')).toMatchObject({
      messages: [
        { role: 'developer', content: 'Follow workspace rules.' },
        { role: 'user', content: 'Hello' },
      ],
    })
    expect(await capturePayload('deepseek-r1-responses')).toMatchObject({
      input: [
        { role: 'system', content: 'Follow workspace rules.' },
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ],
    })
    expect(await capturePayload('gpt-5.2')).toMatchObject({
      input: [
        { role: 'developer', content: 'Follow workspace rules.' },
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ],
    })
  } finally {
    await service.dispose()
  }
})
