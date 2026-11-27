import { fixtureV2Fetch } from './fixtures/CatalogV2Fixture'
import { expect, test } from 'bun:test'
import { createModels, createProvider, type ModelsStoreEntry } from '@earendil-works/pi-ai'
import { Effect } from 'effect'
import type { ProviderCredentialRepository } from '../src/auth/ProviderCredentialRepository'
import { withBuiltinProviderOverrides } from '../src/provider/runtime/BuiltinProviderOverrides'
import { ModelService } from '../src/provider/runtime/ModelService'
import { providerApiStreams } from '../src/provider/runtime/ProviderApis'
import { withOpenAIModelDiscovery } from '../src/provider/runtime/OpenAIModelDiscovery'
import { ProviderDirectoryStore } from '../src/provider/runtime/ProviderDirectoryStore'

test('static OpenAI catalogs discover remote models, preserve metadata and cache, and skip disabled providers', async () => {
  let requests = 0
  let fail = false
  let enabled = true
  let baseUrl: string | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests++
      expect(new URL(request.url).pathname).toBe(baseUrl ? '/override/models' : '/v1/models')
      expect(request.headers.get('authorization')).toBe('Bearer fixture-key')
      return fail
        ? new Response('unavailable', { status: 503 })
        : Response.json({ data: [{ id: 'known' }, { id: 'remote-only' }] })
    },
  })
  const values = new Map<string, ModelsStoreEntry>()
  const modelsStore = {
    read: async (id: string) => values.get(id),
    write: async (id: string, value: ModelsStoreEntry) => {
      values.set(id, value)
    },
    delete: async (id: string) => {
      values.delete(id)
    },
  }
  const provider = () =>
    createProvider({
      id: 'nvidia',
      name: 'NVIDIA',
      baseUrl: `${server.url}v1`,
      auth: {
        apiKey: { name: 'fixture', resolve: async () => ({ auth: { apiKey: 'fixture-key' } }) },
      },
      models: [
        {
          id: 'known',
          name: 'Known model',
          provider: 'nvidia',
          baseUrl: `${server.url}v1`,
          api: 'openai-completions',
          contextWindow: 131072,
          maxTokens: 65536,
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      api: providerApiStreams['openai-completions'](),
    })
  const repository = {
    list: () => [],
    get: () => Effect.succeed(null),
  } as unknown as ProviderCredentialRepository
  const directory = new ProviderDirectoryStore(
    undefined,
    fixtureV2Fetch(() => ({
      models: { known: { name: 'Known model' } },
      providers: {
        'another-provider': {
          name: 'Another directory provider',
          marketVisible: true,
          models: {
            known: {
              name: 'Known model',
              pi_api: 'openai-completions',
              base_url: `${server.url}v1`,
              limit: { context: 131072, output: 65536 },
              reasoning: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
              cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
            },
          },
        },
      },
    })),
  )
  await directory.refresh()
  const runtime = () => {
    const models = createModels({ modelsStore })
    models.setProvider(provider())
    return new ModelService(repository, {
      models,
      directory,
      config: () => ({
        schemaVersion: 2,
        providers: {
          nvidia: { kind: 'builtin', enabled, ...(baseUrl ? { base_url: baseUrl } : {}) },
        },
      }),
    })
  }
  const service = runtime()
  const restored = runtime()
  const endpointOverride = withBuiltinProviderOverrides(service.registry.getProvider('nvidia')!, {
    kind: 'builtin',
    enabled: true,
    allowModels: [],
    denyModels: [],
    models: {},
    endpoints: { 'openai-completions': 'https://relay.example/v1' },
  })
  try {
    await service.refresh(true, 'nvidia')
    // 上游发现的模型作为候选进入同步弹窗，未显式添加前不进入模型选择器。
    expect(
      (await service.discoverBuiltinModels('nvidia')).map((model) => String(model.id)),
    ).toContain('remote-only')
    expect((await service.models()).map((model) => String(model.id))).not.toContain('remote-only')
    expect(service.registry.getModel('nvidia', 'known')).toMatchObject({
      name: 'Known model',
      contextWindow: 131072,
      maxTokens: 65536,
      reasoning: true,
    })
    expect(endpointOverride.getModels().find((model) => model.id === 'remote-only')).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://relay.example/v1',
    })
    expect(requests).toBe(1)
    expect(JSON.stringify([...values.values()])).not.toContain('fixture-key')
    await restored.reload()
    expect(restored.registry.getModel('nvidia', 'remote-only')).toBeDefined()
    expect(requests).toBe(1)
    fail = true
    await expect(service.refresh(true, 'nvidia')).rejects.toMatchObject({
      code: 'CATALOG_REFRESH_FAILED',
    })
    expect(service.registry.getModel('nvidia', 'remote-only')).toBeDefined()
    expect(requests).toBe(2)
    fail = false
    enabled = true
    baseUrl = `${server.url}override`
    await service.refresh(true, 'nvidia')
    expect(service.registry.getModel('nvidia', 'remote-only')?.baseUrl).toBe(baseUrl)
    expect(requests).toBe(3)
    enabled = false
    await service.refresh(true, 'nvidia')
    expect(requests).toBe(3)
    const native = { ...provider(), refreshModels: async () => {} }
    expect(withOpenAIModelDiscovery(native, async () => undefined)).toBe(native)
  } finally {
    server.stop(true)
    await service.dispose()
    await restored.dispose()
  }
})
