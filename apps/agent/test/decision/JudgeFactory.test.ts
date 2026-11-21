import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { systemOneEndpoint } from '../../src/decision/providers/SystemOneJudgeProvider'
import { buildJudge } from '../../src/decision/JudgeFactory'

describe('Decision JudgeFactory & SystemOne endpoint', () => {
  test('systemOneEndpoint appends /systemone for /v1 and prefixed .../v1 paths', () => {
    expect(systemOneEndpoint('http://127.0.0.1:8700')).toBe('http://127.0.0.1:8700/v1/systemone')
    expect(systemOneEndpoint('https://api.example.com/v1')).toBe('https://api.example.com/v1/systemone')
    expect(
      systemOneEndpoint('https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1'),
    ).toBe('https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1/systemone')
    expect(
      systemOneEndpoint('https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1/systemone'),
    ).toBe('https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1/systemone')
  })

  test('buildJudge resolves bound provider baseUrl and apiKey for systemone', async () => {
    let seenUrl = ''
    let seenAuth = ''
    let seenModel = ''
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      const headers = new Headers(init?.headers)
      seenAuth = headers.get('Authorization') ?? ''
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
      seenModel = body.model ?? ''
      return new Response(
        JSON.stringify({
          model: 'decision-model-preview',
          answers: { ready: { noul: 0.99, confidence: 0.99 } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const judge = buildJudge(
        'qwen-decision',
        {
          type: 'systemone',
          providerId: 'qwen',
          model: 'decision-model-preview',
        },
        {
          models: {
            catalogConfig: async () => ({
              providers: {
                qwen: { baseUrl: 'https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1' },
              },
            }),
            pi: {
              getAuth: async (providerId: string) =>
                providerId === 'qwen' ? { auth: { apiKey: 'sk-provider-secret' } } : undefined,
              getModels: () => [],
            },
          } as never,
        },
      )

      const result = await judge.evaluate({
        state: { text: 'ping' },
        questions: { ready: { type: 'boolean', instructions: 'ping?' } },
      })

      expect(seenUrl).toBe('https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1/systemone')
      expect(seenAuth).toBe('Bearer sk-provider-secret')
      expect(seenModel).toBe('decision-model-preview')
      expect(result.answers.ready?.type).toBe('boolean')
      expect((result.answers.ready as { probability?: number })?.probability).toBe(0.99)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('buildJudge preserves providerId prefix for llm models whose model id contains a slash', async () => {
    const seenRefs: Array<{ providerID: string; id: string }> = []
    const judge = buildJudge(
      'magpie-llm',
      {
        type: 'llm',
        providerId: 'magpie',
        model: 'qwen-token-plan/decision-model-preview',
      },
      {
        models: {
          getPiModel: (ref: { providerID: string; id: string }) => {
            seenRefs.push(ref)
            return { provider: ref.providerID, id: ref.id }
          },
          pi: {
            completeSimple: async () => ({
              stopReason: 'stop',
              content: [{ type: 'text', text: '{"answers":{"ready":{"p":0.9}}}' }],
              usage: { input: 10, output: 5 },
            }),
          },
        } as never,
        db: {} as never,
        config: {} as never,
      },
    )

    await judge.evaluate({
      state: { text: 'ping' },
      questions: { ready: { type: 'boolean', instructions: 'ping?' } },
    })

    expect(seenRefs).toEqual([
      {
        providerID: 'magpie',
        id: 'qwen-token-plan/decision-model-preview',
      },
    ])
  })

  test('SystemOneJudgeProvider attaches sanitized endpoint and scrubbed plain-text error body on HTTP 404', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('404 page not found for sk-secret-value', { status: 404 })) as unknown as typeof fetch

    try {
      const judge = buildJudge(
        'magpie-systemone',
        {
          type: 'systemone',
          providerId: 'magpie',
          model: 'qwen-token-plan/decision-model-preview',
        },
        {
          models: {
            catalogConfig: async () => ({
              providers: {
                magpie: { baseUrl: 'http://127.0.0.1:8080/v1/systemone?token=should-strip' },
              },
            }),
            pi: {
              getAuth: async () => ({ auth: { apiKey: 'sk-secret-value' } }),
              getModels: () => [],
            },
          } as never,
        },
      )

      let caught: unknown
      try {
        await judge.evaluate({
          state: { text: 'ping' },
          questions: { ready: { type: 'boolean', instructions: 'ping?' } },
        })
      } catch (error) {
        caught = error
      }

      expect(caught).toMatchObject({
        kind: 'bad_request',
        status: 404,
        endpoint: 'http://127.0.0.1:8080/v1/systemone',
        message: '404 page not found for …',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('buildJudge resolves encrypted credentialId from ProviderCredentialRepository', async () => {
    let seenAuth = ''
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seenAuth = headers.get('Authorization') ?? ''
      return new Response(
        JSON.stringify({
          model: 'decision-model-preview',
          answers: { ready: { noul: 0.95, confidence: 0.95 } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    try {
      const judge = buildJudge(
        'qwen-custom',
        {
          type: 'systemone',
          model: 'decision-model-preview',
          baseUrl: 'https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1',
          credentialId: 'cred_decision_1',
        },
        {
          credentials: {
            getById: (id: string) =>
              Effect.succeed(
                id === 'cred_decision_1'
                  ? {
                      id,
                      integrationID: 'decision.qwen-custom',
                      kind: 'api-key' as const,
                      methodID: null,
                      label: 'qwen-custom',
                      value: { type: 'key' as const, key: 'sk-encrypted-decision-key' },
                    }
                  : null,
              ),
          } as never,
        },
      )

      const result = await judge.evaluate({
        state: { text: 'ping' },
        questions: { ready: { type: 'boolean', instructions: 'ping?' } },
      })

      expect(seenAuth).toBe('Bearer sk-encrypted-decision-key')
      expect(result.answers.ready?.type).toBe('boolean')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
