import { ModelHealthService } from '../src/provider/ModelHealthService'
import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import type { Api, AssistantMessage, Model as RuntimeModel } from '@earendil-works/pi-ai'
import { Model, Provider } from '@pidex/model-schema'
import type { EncryptedCredentialRepository } from '../src/auth/EncryptedCredentialRepository'
import { ModelService } from '../src/provider/runtime/ModelService'
import {
  parseProviderCatalog,
  serializeProviderDefinition,
} from '../src/provider/runtime/ProviderConfig'
import type { ModelOperationOptions } from '../src/provider/runtime/ModelOperations'
import {
  nativeMediaFormat,
  prepareMediaInput,
  type MediaInput,
} from '../src/provider/runtime/MediaInput'
import { prepareAttachmentUpload } from '../src/subagent/AttachmentService'

const repository = {
  list: () => [],
  get: () => Effect.succeed(null),
  getActiveBinding: () => null,
  getById: () => Effect.succeed(null),
} as unknown as EncryptedCredentialRepository
const ref = (id: string): Model.Ref => ({
  providerID: Provider.ID.make('relay'),
  id: Model.ID.make(id),
})
const service = () =>
  new ModelService(repository, {
    config: {
      providers: {
        relay: {
          kind: 'custom',
          auth: 'none',
          base_url: 'https://api.example/v1',
          endpoints: {
            'openai-embeddings': 'https://vectors.example/v1',
            'jina-rerank': 'https://rank.example/v1',
          },
          models: {
            embed: { api: 'openai-completions', modelType: 'embedding', tools: false },
            rank: { api: 'openai-completions', modelType: 'rerank' },
          },
        },
      },
    },
  })

test('嵌入与重排走独立端点，向量按输入索引恢复并校验响应', async () => {
  const models = service()
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    expect(init?.redirect).toBe('error')
    if (new URL(String(url)).hostname === 'vectors.example') {
      expect(body.input).toEqual(['first', 'second'])
      return Response.json({
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
        usage: { prompt_tokens: 2 },
      })
    }
    expect(body.top_n).toBe(1)
    return Response.json({ results: [{ index: 1, relevance_score: 0.95 }] })
  }) as NonNullable<ModelOperationOptions['fetch']>
  expect(await models.embed(ref('embed'), ['first', 'second'], 2, { fetch: fetcher })).toEqual({
    vectors: [
      [1, 2],
      [3, 4],
    ],
    inputTokens: 2,
  })
  expect(
    await models.rerank(ref('rank'), 'query', ['first', 'second'], 1, { fetch: fetcher }),
  ).toEqual({ results: [{ index: 1, score: 0.95 }], inputTokens: 0 })
  await expect(models.embed(ref('rank'), ['wrong'], undefined, { fetch: fetcher })).rejects.toThrow(
    '类型',
  )
  await expect(
    models.embed(ref('embed'), ['first'], undefined, {
      fetch: (async () =>
        Response.json({ data: [{ index: 0, embedding: ['bad'] }] })) as NonNullable<
        ModelOperationOptions['fetch']
      >,
    }),
  ).rejects.toThrow('格式')
  models.dispose()
})

test('用户添加的内置端点可保存，旧默认协议不写回', () => {
  const saved = serializeProviderDefinition({
    kind: 'builtin',
    id: 'google',
    enabled: true,
    allowModels: [],
    denyModels: [],
    models: [],
    protocol: 'anthropic-messages',
    endpoints: {
      'anthropic-messages': 'https://relay.example/anthropic',
      'openai-embeddings': 'https://relay.example/v1',
    },
  })
  expect(parseProviderCatalog({ providers: { google: saved.value } }).issues).toEqual([])
  expect(saved.value).not.toHaveProperty('protocol')
  expect(saved.value.endpoints).toEqual({
    'anthropic-messages': 'https://relay.example/anthropic',
    'openai-embeddings': 'https://relay.example/v1',
  })
})

test('媒体请求映射为真实协议部件；不支持协议拒绝，不能静默丢弃媒体', async () => {
  const model = {
    api: 'google-generative-ai',
    input: ['text', 'audio', 'video'],
  } as unknown as RuntimeModel<Api>
  const request = await prepareMediaInput(model, {
    messages: [
      {
        role: 'user',
        content: 'describe',
        timestamp: 1,
        media: [{ kind: 'video', mimeType: 'video/mp4', data: 'Zml4dHVyZQ==' }],
      } as any,
    ],
  })
  const content = request.context.messages[0]!.content as Array<{ text: string }>
  expect(request.applyPayload({ contents: [{ role: 'user', parts: content }] })).toEqual({
    contents: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'describe' },
          { inlineData: { mimeType: 'video/mp4', data: 'Zml4dHVyZQ==' } },
        ],
      },
    ],
  })
  expect(() => request.applyPayload({})).toThrow('未能映射')
  const signal = new AbortController().signal
  expect(
    (
      request.applyPayload({ contents: [{ role: 'user', parts: content }], signal }) as {
        signal: AbortSignal
      }
    ).signal,
  ).toBe(signal)
  await expect(
    prepareMediaInput(
      { ...model, api: 'anthropic-messages' },
      {
        messages: [
          {
            role: 'user',
            content: '',
            timestamp: 1,
            media: [{ kind: 'audio', mimeType: 'audio/wav', data: '' }],
          } as any,
        ],
      },
    ),
  ).rejects.toThrow('协议不支持')
})

test('切换模型会降级历史音视频，当前轮次仍校验媒体能力', async () => {
  const audio: MediaInput = { kind: 'audio', mimeType: 'audio/wav', data: 'YXVkaW8=' }
  const video: MediaInput = { kind: 'video', mimeType: 'video/mp4', data: 'dmlkZW8=' }
  const user = (media: MediaInput[], timestamp = 1) => ({
    role: 'user' as const,
    content: 'describe',
    timestamp,
    media,
  })
  const assistant: AssistantMessage = {
    role: 'assistant',
    api: 'google-generative-ai',
    provider: 'google',
    model: 'gemini',
    content: [],
    timestamp: 2,
    stopReason: 'stop',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
  for (const [cause, input, error] of [
    ['model', ['text'], '模型不支持视频'],
    ['protocol', ['text', 'audio', 'video'], '协议不支持'],
  ] as const) {
    const model = { api: 'anthropic-messages', input } as unknown as RuntimeModel<Api>
    const history = user([audio, audio, video, video, audio])
    const current = user([], 3)
    const { context, applyPayload } = await prepareMediaInput(model, {
      messages: [history, assistant, current],
    })
    expect(context.messages[0]?.content).toEqual([
      { type: 'text', text: 'describe' },
      { type: 'text', text: `(audio omitted: ${cause} does not support audio)` },
      { type: 'text', text: `(video omitted: ${cause} does not support video)` },
      { type: 'text', text: `(audio omitted: ${cause} does not support audio)` },
    ])
    expect(context.messages[2]).toBe(current)
    expect(applyPayload({})).toEqual({})
    await expect(
      prepareMediaInput(model, { messages: [history, assistant, user([video], 3)] }),
    ).rejects.toThrow(error)
  }
})

test('音视频上传校验文件头，不把任意二进制作为媒体保存', () => {
  const wav = new TextEncoder().encode('RIFF1234WAVEfixture')
  expect(
    prepareAttachmentUpload({ kind: 'audio', name: 'clip.wav', mimeType: 'audio/wav', data: wav })
      .data,
  ).toEqual(wav)
  expect(() =>
    prepareAttachmentUpload({
      kind: 'audio',
      name: 'clip.wav',
      mimeType: 'audio/wav',
      data: new Uint8Array([1, 2, 3]),
    }),
  ).toThrow('MIME')
  expect(() =>
    prepareAttachmentUpload({
      kind: 'video',
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      data: 'base64',
    }),
  ).toThrow('二进制')
})

test('原生 Gemini SDK 的最终 payload hook 包含视频数据，无需修改 SDK', async () => {
  const models = new ModelService(repository)
  const native = models.registry
    .getProvider('google')!
    .getModels()
    .find((model) => model.api === 'google-generative-ai')!
  const model = {
    ...native,
    input: [...native.input, 'video'] as typeof native.input,
    catalog: { input: ['text', 'video', 'pdf'] },
  }
  const prepared = await prepareMediaInput(
    model,
    {
      messages: [
        {
          role: 'user',
          content: 'describe',
          timestamp: 1,
          media: [{ kind: 'video', mimeType: 'video/mp4', data: 'Zml4dHVyZQ==' }],
          mediaAttachments: [
            {
              kind: 'pdf',
              mimeType: 'application/pdf',
              name: 'report.pdf',
              attachmentId: 'pdf',
              inputId: 'input',
              sizeBytes: 8,
            },
          ],
        } as any,
      ],
    },
    {
      currentInputIds: new Set(['input']),
      readAttachment: async () => Buffer.from('%PDF-1.7'),
    },
  )
  let sent: unknown
  await models.registry.completeSimple(model, prepared.context, {
    apiKey: 'fixture-key',
    maxRetries: 0,
    onPayload: (payload) => {
      sent = prepared.applyPayload(payload)
      throw new Error('Stop before network')
    },
  })
  expect(JSON.stringify(sent)).toContain('inlineData')
  expect(JSON.stringify(sent)).toContain('video/mp4')
  expect(JSON.stringify(sent)).toContain('application/pdf')
  expect(JSON.stringify(sent)).not.toContain('pidex-media:')
  models.dispose()
})

test('原生媒体能力随供应商端点、协议和模型变化', () => {
  const qwenBase = 'https://maas.qianwenaiapi.com/compatible-mode/v1'
  const model = {
    id: 'qwen4-max',
    input: ['text', 'video'],
    catalog: { input: ['text', 'video', 'pdf'] },
  } as unknown as Parameters<typeof nativeMediaFormat>[0]
  for (const [id, api, baseUrl, video, pdf] of [
    ['qwen4-max', 'openai-completions', qwenBase, 'completions', 'completions'],
    [
      'qwen4-max',
      'anthropic-messages',
      'https://maas.qianwenaiapi.com/apps/anthropic',
      'anthropic',
      'anthropic',
    ],
    ['qwen4-max', 'openai-responses', qwenBase, undefined, undefined],
    [
      'qwen4-max',
      'openai-completions',
      `${qwenBase.replace('.com', '.com.example')}`,
      undefined,
      undefined,
    ],
    ['kimi-k3', 'openai-completions', 'https://api.moonshot.ai/v1', 'completions', undefined],
    ['kimi-k3', 'openai-completions', qwenBase, undefined, undefined],
    [
      'glm-5v-turbo',
      'openai-completions',
      'https://open.bigmodel.cn/api/paas/v4',
      undefined,
      'completions',
    ],
    ['google/gemini', 'openai-responses', 'https://openrouter.ai/api/v1', 'responses', 'responses'],
    [
      'gpt-5',
      'azure-openai-responses',
      'https://example.openai.azure.com/openai/v1',
      undefined,
      'responses',
    ],
    [
      'amazon.nova-pro-v1:0',
      'bedrock-converse-stream',
      'https://bedrock-runtime.us-east-1.amazonaws.com',
      'bedrock',
      'bedrock',
    ],
    ['gpt-5', 'openai-responses', 'https://api.openai.com/v1', undefined, 'responses'],
    ['claude', 'anthropic-messages', 'https://api.anthropic.com', undefined, 'anthropic'],
  ] as const) {
    const routed = { ...model, id, api, baseUrl }
    expect(nativeMediaFormat(routed, 'video', 'video/mp4')).toBe(video)
    expect(nativeMediaFormat(routed, 'pdf', 'application/pdf')).toBe(pdf)
  }
  const disabled = {
    ...model,
    api: 'openai-completions' as const,
    baseUrl: qwenBase,
    mediaInput: {
      endpoint: qwenBase,
      protocol: 'openai-completions' as const,
      pdf: false,
      video: [],
    },
  }
  expect(nativeMediaFormat(disabled, 'video', 'video/mp4')).toBeUndefined()
  expect(nativeMediaFormat(disabled, 'pdf', 'application/pdf')).toBeUndefined()
})

test('非聊天模型的健康测试走嵌入和重排接口', async () => {
  const calls: string[] = []
  const models = {
    getRuntimeModel: async (model: Model.Ref) => ({
      modelType: model.id === 'embed' ? 'embedding' : 'rerank',
    }),
    embed: async () => {
      calls.push('embed')
      return { vectors: [[1]], inputTokens: 1 }
    },
    rerank: async () => {
      calls.push('rerank')
      return { results: [{ index: 0, score: 1 }], inputTokens: 1 }
    },
    registry: {
      completeSimple: () => {
        throw new Error('Must not send a chat request')
      },
    },
  } as unknown as ModelService
  const health = new ModelHealthService(models, async () => {})
  expect((await health.probe(ref('embed'))).ok).toBe(true)
  expect((await health.probe(ref('rank'))).ok).toBe(true)
  expect(calls).toEqual(['embed', 'rerank'])
  await health.dispose()
})

test('自定义 Gemini 的音视频与工具开关进入目录，非聊天模型不会伪装成聊天能力', async () => {
  const models = new ModelService(repository, {
    config: {
      providers: {
        relay: {
          kind: 'custom',
          auth: 'none',
          base_url: 'https://generativelanguage.googleapis.com/v1beta',
          models: {
            chat: {
              api: 'google-generative-ai',
              input: ['text', 'audio', 'video'],
              tools: false,
              max_input_tokens: 12345,
            },
            embed: { api: 'openai-completions', modelType: 'embedding' },
          },
        },
      },
    },
  })
  const catalog = await models.models()
  expect(catalog.find((model) => model.id === 'chat')).toMatchObject({
    capabilities: { tools: false, input: ['text', 'audio', 'video'] },
    limit: { input: 12345 },
  })
  expect(catalog.find((model) => model.id === 'embed')).toMatchObject({
    modelType: 'embedding',
    capabilities: { tools: false, output: ['embedding'] },
    variants: [],
  })
  models.dispose()
})

test('兼容视频只发送到明确声明了协议、端点和文件格式的模型', async () => {
  const data = 'Zml4dHVyZQ=='
  const baseUrl = 'https://gateway.example/v1'
  const input = {
    role: 'user' as const,
    content: 'Describe the clip',
    timestamp: 1,
    media: [{ kind: 'video', mimeType: 'video/mp4', data }] satisfies MediaInput[],
  }
  for (const api of ['openai-completions', 'anthropic-messages'] as const) {
    const model = {
      api,
      baseUrl,
      input: ['text', 'video'],
      mediaInput: { endpoint: baseUrl, protocol: api, video: ['video/mp4'] },
    } as unknown as RuntimeModel<Api>
    const { context, applyPayload } = await prepareMediaInput(model, { messages: [input] })
    expect(applyPayload({ messages: context.messages })).toEqual({
      messages: [
        expect.objectContaining({
          role: 'user',
          content: [
            { type: 'text', text: 'Describe the clip' },
            api === 'anthropic-messages'
              ? { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data } }
              : { type: 'video_url', video_url: { url: `data:video/mp4;base64,${data}` } },
          ],
        }),
      ],
    })
    await expect(
      prepareMediaInput(
        { ...model, baseUrl: 'https://other.example/v1' },
        {
          messages: [input],
        },
      ),
    ).rejects.toThrow('协议不支持')
    await expect(
      prepareMediaInput(model, {
        messages: [
          {
            ...input,
            media: [{ kind: 'video', mimeType: 'video/webm', data }] satisfies MediaInput[],
          } as typeof input,
        ],
      }),
    ).rejects.toThrow('协议不支持')
  }
})
