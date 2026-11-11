import { describe, expect, test } from 'bun:test'
import { AgentError } from '../src/Domain'
import {
  listProviderModels,
  resolveModelListingRoot,
  type ListableChatApi,
  type ProviderModelFetch,
} from '../src/provider/pi'

interface CapturedRequest {
  readonly url: URL
  readonly headers: Headers
  readonly init: RequestInit
}

const capture = (respond: (request: CapturedRequest) => Response) => {
  const requests: CapturedRequest[] = []
  const fetch: ProviderModelFetch = async (input, init) => {
    const request = {
      url: input instanceof URL ? input : new URL(String(input)),
      headers: new Headers(init?.headers),
      init: init ?? {},
    }
    requests.push(request)
    return respond(request)
  }
  return { requests, fetch }
}

const expectListingError = async (operation: Promise<unknown>, message?: string, code = 'PROVIDER_UNAVAILABLE', status = 400) => {
  const error = (await operation.then(
    () => undefined,
    (cause: unknown) => cause,
  )) as unknown
  expect(error).toBeInstanceOf(AgentError)
  expect((error as AgentError).code).toBe(code)
  expect((error as AgentError).status).toBe(status)
  if (message) expect((error as AgentError).message).toContain(message)
  return error as AgentError
}

describe('Pi model listing roots', () => {
  test('removes full inference URL suffixes for every chat protocol', () => {
    expect(
      resolveModelListingRoot('https://gateway.example/v1/chat/completions/', 'openai-completions'),
    ).toBe('https://gateway.example/v1')
    expect(
      resolveModelListingRoot('https://gateway.example/v1/responses', 'openai-responses'),
    ).toBe('https://gateway.example/v1')
    expect(
      resolveModelListingRoot(
        'https://gateway.example/anthropic/v1/messages',
        'anthropic-messages',
      ),
    ).toBe('https://gateway.example/anthropic')
    expect(
      resolveModelListingRoot(
        'https://gateway.example/v1beta/models/gemini-2.5-pro:generateContent',
        'google-generative-ai',
      ),
    ).toBe('https://gateway.example/v1beta')
    expect(resolveModelListingRoot('https://gateway.example/v1/', 'openai-completions')).toBe(
      'https://gateway.example/v1',
    )
  })
})

describe('Pi model listing', () => {
  test('lists OpenAI-compatible models through the injected fetch and rejects empty catalogs', async () => {
    const openai = capture(() =>
      Response.json({ data: [{ id: 'zeta' }, { id: 'alpha', name: 'Alpha' }] }),
    )
    const result = await listProviderModels({
      api: 'openai-completions',
      baseUrl: 'https://gateway.example/v1/chat/completions',
      apiKey: 'fixture-key',
      fetch: openai.fetch,
    })
    expect(openai.requests[0]?.url.href).toBe('https://gateway.example/v1/models')
    expect(openai.requests[0]?.headers.get('authorization')).toBe('Bearer fixture-key')
    expect(result.models).toEqual([
      { id: 'alpha', name: 'Alpha' },
      { id: 'zeta', name: 'zeta' },
    ])
    expect(result.fetchedAt).toBeGreaterThan(0)

    const responses = capture(() => Response.json({ data: [{ id: 'response-model' }] }))
    await listProviderModels({
      api: 'openai-responses',
      baseUrl: 'https://gateway.example/v1/responses',
      fetch: responses.fetch,
    })
    expect(responses.requests[0]?.url.href).toBe('https://gateway.example/v1/models')

    await expectListingError(
      listProviderModels({
        api: 'openai-completions',
        baseUrl: 'https://gateway.example/v1',
        fetch: async () => Response.json({ data: [] }),
      }),
      '上游未返回任何模型',
    )
    await expectListingError(
      listProviderModels({
        api: 'openai-completions',
        baseUrl: 'https://gateway.example/v1',
        fetch: async () => Response.json({ error: 'invalid credentials' }),
      }),
      '格式无效',
    )
  })

  test('keeps explicitly declared upstream reasoning levels in declared order', async () => {
    const result = await listProviderModels({
      api: 'openai-responses',
      baseUrl: 'https://gateway.example/v1',
      fetch: async () =>
        Response.json({
          data: [
            { id: 'listed', reasoning_levels: ['low', 'high', 'low', ''] },
            { id: 'efforts', supported_reasoning_levels: [{ effort: 'none' }, { effort: 'max' }] },
            { id: 'declared-both', reasoning_levels: ['medium'], supported_reasoning_levels: [{ effort: 'low' }] },
            { id: 'none' },
            { id: 'invalid', reasoning_levels: [1, null], supported_reasoning_levels: 'low' },
          ],
        }),
    })
    expect(result.models).toEqual([
      { id: 'declared-both', name: 'declared-both', reasoningLevels: ['medium'] },
      { id: 'efforts', name: 'efforts', reasoningLevels: ['none', 'max'] },
      { id: 'invalid', name: 'invalid' },
      { id: 'listed', name: 'listed', reasoningLevels: ['low', 'high'] },
      { id: 'none', name: 'none' },
    ])
  })

  test('keeps only explicitly declared upstream limits and ignores unrelated fields', async () => {
    const result = await listProviderModels({
      api: 'openai-completions',
      baseUrl: 'https://gateway.example/v1',
      fetch: async () =>
        Response.json({
          data: [
            {
              id: 'a',
              context_length: 200_000,
              max_input_tokens: 180_000,
              max_output_tokens: 64_000,
            },
            {
              id: 'b',
              context_window: 1_000_000,
              top_provider: { context_length: 900_000, max_completion_tokens: 32_000 },
            },
            { id: 'c', limit: { context: 1_000, output: 10 }, max_tokens: 5_000 },
            { id: 'd', context_length: -1, max_output_tokens: 1.5 },
          ],
        }),
    })
    expect(result.models).toEqual([
      { id: 'a', name: 'a', contextWindow: 200_000, maxInputTokens: 180_000, maxTokens: 64_000 },
      { id: 'b', name: 'b', contextWindow: 1_000_000, maxTokens: 32_000 },
      { id: 'c', name: 'c' },
      { id: 'd', name: 'd' },
    ])

    const gemini = capture(() =>
      Response.json({
        models: [
          { name: 'models/gemini-x', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 },
        ],
      }),
    )
    const google = await listProviderModels({
      api: 'google-generative-ai',
      baseUrl: 'https://gateway.example/v1beta',
      fetch: gemini.fetch,
    })
    expect(google.models).toEqual([
      {
        id: 'gemini-x',
        name: 'gemini-x',
        contextWindow: 1_048_576,
        maxInputTokens: 1_048_576,
        maxTokens: 65_536,
      },
    ])
  })

  test('lists Anthropic models with pagination and caller-selected authorization', async () => {
    const authorization = capture((request) =>
      request.url.searchParams.get('after_id') === 'model-2'
        ? Response.json({ data: [{ id: 'model-3', display_name: 'Model 3' }], has_more: false })
        : Response.json({
            data: [{ id: 'model-1', display_name: 'Model 1' }, { id: 'model-2' }],
            has_more: true,
            last_id: 'model-2',
          }),
    )
    const result = await listProviderModels({
      api: 'anthropic-messages',
      baseUrl: 'https://gateway.example/anthropic/v1/messages',
      headers: { authorization: 'Bearer oauth-token' },
      apiKey: 'ignored-key',
      fetch: authorization.fetch,
    })
    expect(authorization.requests.map((request) => request.url.pathname)).toEqual([
      '/anthropic/v1/models',
      '/anthropic/v1/models',
    ])
    expect(authorization.requests[0]?.url.searchParams.get('limit')).toBe('1000')
    expect(authorization.requests[1]?.url.searchParams.get('after_id')).toBe('model-2')
    for (const request of authorization.requests) {
      expect(request.headers.get('anthropic-version')).toBe('2023-06-01')
      expect(request.headers.get('authorization')).toBe('Bearer oauth-token')
      expect(request.headers.get('x-api-key')).toBeNull()
    }
    expect(result.models).toEqual([
      { id: 'model-1', name: 'Model 1' },
      { id: 'model-2', name: 'model-2' },
      { id: 'model-3', name: 'Model 3' },
    ])

    const apiKey = capture(() => Response.json({ data: [{ id: 'model-x' }] }))
    await listProviderModels({
      api: 'anthropic-messages',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'anthropic-key',
      fetch: apiKey.fetch,
    })
    expect(apiKey.requests[0]?.url.pathname).toBe('/v1/models')
    expect(apiKey.requests[0]?.headers.get('x-api-key')).toBe('anthropic-key')

    await expectListingError(
      listProviderModels({
        api: 'anthropic-messages',
        baseUrl: 'https://gateway.example',
        fetch: async () => Response.json({ data: [{ id: 'model' }], has_more: true }),
      }),
      '格式无效',
    )
    await expectListingError(
      listProviderModels({
        api: 'anthropic-messages',
        baseUrl: 'https://gateway.example',
        fetch: async () => Response.json({ data: [] }),
      }),
      '上游未返回任何模型',
    )
  })

  test('lists Gemini models with page tokens, prefix stripping and x-goog-api-key', async () => {
    const gemini = capture((request) =>
      request.url.searchParams.get('pageToken') === 'page-2'
        ? Response.json({ models: [{ name: 'models/gemini-3-flash' }], nextPageToken: '' })
        : Response.json({
            models: [
              { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
              { name: 'gemini-embed' },
            ],
            nextPageToken: 'page-2',
          }),
    )
    const result = await listProviderModels({
      api: 'google-generative-ai',
      baseUrl: 'https://gateway.example/v1beta/models/gemini-2.5-pro:generateContent',
      apiKey: 'gemini-key',
      fetch: gemini.fetch,
    })
    expect(gemini.requests.map((request) => request.url.pathname)).toEqual([
      '/v1beta/models',
      '/v1beta/models',
    ])
    expect(gemini.requests[0]?.url.searchParams.get('pageSize')).toBe('1000')
    expect(gemini.requests[0]?.url.searchParams.get('pageToken')).toBeNull()
    expect(gemini.requests[1]?.url.searchParams.get('pageToken')).toBe('page-2')
    for (const request of gemini.requests) {
      expect(request.headers.get('x-goog-api-key')).toBe('gemini-key')
    }
    expect(result.models).toEqual([
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-embed', name: 'gemini-embed' },
      { id: 'gemini-3-flash', name: 'gemini-3-flash' },
    ])
    await expectListingError(
      listProviderModels({
        api: 'google-generative-ai',
        baseUrl: 'https://gateway.example/v1beta',
        fetch: async () => Response.json({ models: [] }),
      }),
      '上游未返回任何模型',
    )
  })

  test('reports upstream failures without leaking response bodies, keys or paths', async () => {
    const secretKey = 'super-secret-fixture-key'
    const body = JSON.stringify({ error: 'raw upstream body with token', key: secretKey })
    const http = await expectListingError(
      listProviderModels({
        api: 'anthropic-messages',
        baseUrl: 'https://gateway.example/v1',
        apiKey: secretKey,
        fetch: async () => new Response(body, { status: 503 }),
      }),
      'HTTP 503', 'PROVIDER_UNAVAILABLE', 502,
    )
    const openaiHttp = await expectListingError(
      listProviderModels({
        api: 'openai-completions',
        baseUrl: 'https://gateway.example/v1',
        apiKey: secretKey,
        fetch: async () => new Response(body, { status: 401 }),
      }),
      'HTTP 401', 'PROVIDER_AUTH_FAILED', 400,
    )
    for (const error of [http, openaiHttp]) {
      expect(JSON.stringify(error)).not.toContain(secretKey)
      expect(error.message).not.toContain('raw upstream body')
      expect(error.message).not.toContain('CodePilotX')
    }

    await expectListingError(
      listProviderModels({
        api: 'anthropic-messages',
        baseUrl: 'https://gateway.example/v1',
        fetch: async () => new Response('not-json', { status: 200 }),
      }),
      '格式无效',
    )
    await expectListingError(
      listProviderModels({
        api: 'anthropic-messages',
        baseUrl: 'https://gateway.example/v1',
        fetch: async () =>
          new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
      }),
      '响应过大',
    )
    await expectListingError(
      listProviderModels({
        api: 'anthropic-messages',
        baseUrl: 'https://gateway.example/v1',
        fetch: async () => {
          throw new DOMException('The operation timed out.', 'TimeoutError')
        },
      }),
      '超时', 'PROVIDER_TIMEOUT', 502,
    )
    await expectListingError(
      listProviderModels({
        api: 'google-generative-ai',
        baseUrl: 'https://gateway.example/v1beta',
        fetch: async () => Response.json({ candidates: [] }),
      }),
      '格式无效',
    )
    await expect(
      listProviderModels({
        api: 'nope' as ListableChatApi,
        baseUrl: 'https://gateway.example/v1',
        fetch: async () => Response.json({ data: [] }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
  })
})


test('Google 模型发现保留 1.5 亿输入额度', async () => {
  const result = await listProviderModels({
    api: 'google-generative-ai', baseUrl: 'https://gateway.example/v1beta',
    fetch: async () => Response.json({ models: [{ name: 'models/large-context', inputTokenLimit: 150_000_000, outputTokenLimit: 32768 }] }),
  })
  expect(result.models[0]).toMatchObject({ contextWindow: 150_000_000, maxInputTokens: 150_000_000 })
})
