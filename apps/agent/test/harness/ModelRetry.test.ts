import { expect, test } from 'bun:test'
import {
  createAssistantMessageEventStream,
  fauxProvider,
  normalizeContext,
  Type,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai'
import { streamSimple as streamOpenAI } from '@earendil-works/pi-ai/api/openai-completions'
import { runAgentLoop } from '../../src/orchestration/harness/AgentLoop'
import type { AgentEvent } from '../../src/orchestration/harness/AgentTypes'
import { createFailureMessage } from '../../src/orchestration/harness/Messages'
import { ModelAttempt, ModelRetryBudget } from '../../src/orchestration/harness/ModelAttempt'

const model = fauxProvider({ models: [{ id: 'retry', input: ['text'] }] }).getModel()
const baseMessage = createFailureMessage(model, '', false)

function completed(content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse' = 'stop') {
  return { ...baseMessage, content, stopReason } satisfies AssistantMessage
}

function failedAttempt(code: string, status?: number, headers?: Headers): ModelAttempt {
  const attempt = new ModelAttempt()
  attempt.onError(Object.assign(new Error(), { code, status, headers }))
  return attempt
}

test('confirmed offline retries outlive the transient budget, while fatal failures and long server delays stop', () => {
  const budget = new ModelRetryBudget(true)
  for (let index = 0; index < 5; index++) {
    expect(budget.next(failedAttempt('ECONNREFUSED'), false)).toMatchObject({ state: 'retrying' })
  }
  expect(budget.next(failedAttempt('ECONNREFUSED'), false)).toBeUndefined()
  for (let index = 0; index < 7; index++) {
    expect(budget.next(failedAttempt('EAI_AGAIN'), true)).toEqual({
      state: 'waiting-for-network',
      delayMs: Math.min(60_000, 5000 * 2 ** index),
    })
  }
  expect(budget.next(failedAttempt('ENOTFOUND'), true)).toMatchObject({
    state: 'waiting-for-network',
  })
  expect(budget.next(failedAttempt('invalid_api_key', 401), true)).toBeUndefined()
  expect(budget.next(failedAttempt('insufficient_quota', 429), true)).toBeUndefined()
  expect(budget.next(failedAttempt('unsupported_media_type', 503), true)).toBeUndefined()
  expect(new ModelRetryBudget(true).next(failedAttempt('ENETUNREACH', 503), true)).toMatchObject({
    state: 'retrying',
  })
  expect(
    budget.next(
      failedAttempt('rate_limit_error', 429, new Headers({ 'retry-after': '330' })),
      true,
    ),
  ).toEqual({ retryAfterMs: 330_000 })
  expect(
    new ModelRetryBudget(false).next(
      failedAttempt('overloaded_error', 529, new Headers({ 'x-should-retry': 'false' })),
      true,
    ),
  ).toBeUndefined()
})

test('the pinned Pi adapter preserves HTTP errors and identifies a premature stream end', async () => {
  const responses = [
    Response.json(
      { error: { code: 'insufficient_quota' } },
      { status: 429, headers: { 'retry-after': '600' } },
    ),
    Response.json(
      { error: { code: 'overloaded_error' } },
      { status: 503, headers: { 'retry-after-ms': '380000' } },
    ),
    new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
  ]
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => responses.shift()!,
  })
  const endpoint: Model<'openai-completions'> = {
    ...model,
    api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    compat: { supportsFinishReason: true },
  }
  const context = normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 0 }] })
  const budget = new ModelRetryBudget(true)
  const request = async () => {
    const attempt = new ModelAttempt()
    const result = await streamOpenAI(endpoint, context, {
      apiKey: 'test-key',
      maxRetries: 0,
      signal: attempt.signal,
      onProviderError: (error) => attempt.onError(error),
      onResponse: (response) => attempt.onResponse(response),
    }).result()
    expect(result.stopReason).toBe('error')
    return budget.next(attempt, true)
  }
  try {
    expect(await request()).toBeUndefined()
    expect(await request()).toEqual({ retryAfterMs: 380_000 })
    expect(await request()).toMatchObject({ state: 'retrying' })
  } finally {
    await server.stop(true)
  }
})

test('disconnect after a tool result reuses the prepared step and replaces failed reasoning', async () => {
  const toolCall = { type: 'toolCall', id: 'already-ran', name: 'write', arguments: {} } as const
  const text = { type: 'text', text: 'final answer' } as const
  const events: AgentEvent[] = []
  const inputs: Context[] = []
  const signals: AbortSignal[] = []
  let preparations = 0
  let runs = 0
  let committed = false
  const result = await runAgentLoop(
    [{ role: 'user', content: 'write once', timestamp: 1 }],
    {
      messages: [],
      systemPrompt: '',
      tools: [
        {
          name: 'write',
          label: 'Write',
          description: 'writes once',
          parameters: Type.Object({}),
          execute: async () => {
            runs += 1
            return { content: [{ type: 'text', text: 'written' }] }
          },
        },
      ],
    },
    {
      model,
      convertToLlm: (messages) => messages as Context['messages'],
      hasCommittedToolResult: (id) => committed && id === toolCall.id,
    },
    (event) => {
      events.push(event)
      if (event.type === 'turn_end' && event.toolResults.length > 0) committed = true
    },
    undefined,
    async (_model, input) => {
      preparations += 1
      return {
        retry: 'bounded',
        stream: (attempt) => {
          inputs.push(input)
          signals.push(attempt.signal)
          const stream = createAssistantMessageEventStream()
          if (inputs.length === 2) {
            const failure = {
              ...baseMessage,
              content: [{ type: 'thinking' as const, thinking: 'discarded reasoning' }],
            }
            stream.push({ type: 'start', partial: failure })
            stream.push({
              type: 'thinking_delta',
              partial: failure,
              contentIndex: 0,
              delta: 'discarded reasoning',
            })
            attempt.onError(Object.assign(new Error(), { cause: { code: 'ECONNRESET' } }))
            stream.push({ type: 'error', reason: 'error', error: failure })
          } else {
            const message = completed(
              inputs.length === 1 ? [toolCall] : [toolCall, text],
              'toolUse',
            )
            if (inputs.length === 1) {
              stream.push({ type: 'start', partial: message })
              stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message })
              stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: '{}', partial: message })
              stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message })
            }
            stream.push({ type: 'done', reason: 'toolUse', message })
          }
          return stream
        },
      }
    },
  )
  const updates = events.flatMap((event) =>
    event.type === 'message_update' ? [event.assistantMessageEvent.type] : [],
  )
  expect(updates.slice(0, 3)).toEqual(['toolcall_start', 'toolcall_delta', 'toolcall_end'])
  expect(runs).toBe(1)
  expect(preparations).toBe(2)
  expect(inputs).toHaveLength(3)
  expect(inputs[1]).toBe(inputs[2])
  expect(inputs[2]?.messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: toolCall.id })
  expect(signals[1]).not.toBe(signals[2])
  expect(events.filter((event) => event.type === 'model_recovery')).toEqual([
    expect.objectContaining({ state: 'retrying', discardOutput: true }),
    expect.objectContaining({ state: null }),
  ])
  expect(result.filter((item) => item.role === 'assistant').map((item) => item.content)).toEqual([
    [toolCall],
    [text],
  ])
})

test('stop promptly cancels an offline wait on the original turn', async () => {
  const controller = new AbortController()
  const recovery: Array<string | null> = []
  let attempts = 0
  const result = await runAgentLoop(
    [],
    { messages: [], systemPrompt: '' },
    { model, convertToLlm: () => [] },
    (event) => {
      if (event.type !== 'model_recovery') return
      recovery.push(event.state)
      if (event.state === 'waiting-for-network') controller.abort()
    },
    controller.signal,
    async () => ({
      retry: 'wait-for-network',
      stream: (attempt) => {
        attempts += 1
        const stream = createAssistantMessageEventStream()
        attempt.onError(Object.assign(new Error(), { cause: { code: 'ENETUNREACH' } }))
        stream.push({ type: 'error', reason: 'error', error: baseMessage })
        return stream
      },
    }),
  )
  expect(recovery).toEqual(['waiting-for-network', null])
  expect(attempts).toBe(1)
  expect(result.at(-1)).toMatchObject({ stopReason: 'aborted' })
})
