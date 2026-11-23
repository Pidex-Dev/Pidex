import { describe, expect, test } from 'bun:test'
import { Schema } from 'effect'
import { Credential, Model, Provider } from '../src'

describe('model and provider schemas', () => {
  test('Model.Ref contains providerID, id, and optional variant', () => {
    const decode = Schema.decodeUnknownSync(Model.Ref)
    const encode = Schema.encodeSync(Model.Ref)

    expect(encode(decode({ providerID: 'openai', id: 'gpt-5' }))).toEqual({
      providerID: 'openai',
      id: 'gpt-5',
    })
    expect(decode({ providerID: 'openai', id: 'gpt-5', variant: 'high' })).toMatchObject({
      providerID: 'openai',
      id: 'gpt-5',
      variant: 'high',
    })
  })

  test('empty constructors produce complete valid infos', () => {
    const provider = Provider.Info.empty(Provider.ID.openai)
    const model = Model.Info.empty(provider.id, Model.ID.make('gpt-5'))

    expect(Schema.is(Provider.Info)(provider)).toBe(true)
    expect(Schema.is(Model.Info)(model)).toBe(true)
  })

  test('describes builtin and custom provider origin and availability', () => {
    const builtinProvider = Schema.decodeUnknownSync(Provider.Info)({
      id: 'deepseek',
      name: 'DeepSeek',
      source: {
        type: 'pi',
        kind: 'builtin',
        apis: ['openai-completions'],
        baseUrl: 'https://api.deepseek.com',
      },
      catalogOrigin: 'pi-bundled',
      availability: { status: 'ready' },
      auth: { apiKey: true, oauth: false },
    })
    const customProvider = Schema.decodeUnknownSync(Provider.Info)({
      id: 'my-custom',
      name: 'My Custom',
      source: {
        type: 'pi',
        kind: 'custom',
        apis: ['openai-completions'],
        baseUrl: 'https://api.example.com',
      },
      catalogOrigin: 'user',
      availability: { status: 'ready' },
      auth: { apiKey: true, oauth: false },
    })
    const unavailable = Schema.decodeUnknownSync(Provider.Availability)({
      status: 'unavailable',
      reason: 'unsupported-protocol',
    })

    expect(builtinProvider.source.kind).toBe('builtin')
    expect(builtinProvider.catalogOrigin).toBe('pi-bundled')
    expect(customProvider.source.kind).toBe('custom')
    expect(customProvider.catalogOrigin).toBe('user')
    expect(unavailable.reason).toBe('unsupported-protocol')
  })
})

describe('credential schemas', () => {
  test('decodes OAuth and API key variants', () => {
    const oauth = Schema.decodeUnknownSync(Credential.Value)({
      type: 'oauth',
      methodID: 'oauth-default',
      refresh: 'refresh-token',
      access: 'access-token',
      expires: 0,
      metadata: { account: 'primary' },
    })
    const key = Schema.decodeUnknownSync(Credential.Value)({ type: 'key', key: 'secret' })
    expect(oauth.type).toBe('oauth')
    expect(key.type).toBe('key')
  })
})

describe('pricing schemas', () => {
  test('Model.Pricing supports optional busy/idle long-context tiers and remains backward-compatible', () => {
    const decode = Schema.decodeUnknownSync(Model.Pricing)
    const legacy = decode({
      currency: 'CNY',
      timeZone: 'Asia/Shanghai',
      defaultPeriod: 'idle',
      idle: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: null },
      busy: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: null },
      rules: [],
      dateOverrides: [],
    })
    expect(legacy.idle.tiers).toBeUndefined()

    const tiered = decode({
      currency: 'CNY',
      timeZone: 'Asia/Shanghai',
      defaultPeriod: 'idle',
      idle: {
        input: 1,
        output: 4,
        cacheRead: 0.02,
        cacheWrite: 0,
        tiers: [{ inputTokensAbove: 200_000, input: 2, output: 6, cacheRead: 0.04, cacheWrite: 0 }],
      },
      busy: {
        input: 2,
        output: 8,
        cacheRead: 0.04,
        cacheWrite: 0,
        tiers: [{ inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 0.08, cacheWrite: 0 }],
      },
      rules: [],
      dateOverrides: [],
    })
    expect(tiered.idle.tiers?.[0]?.inputTokensAbove).toBe(200_000)
    expect(tiered.busy.tiers?.[0]?.output).toBe(12)
  })
})
