import {
  calculateCost,
  type Api,
  type Model,
  type StreamOptions,
  type Usage,
} from '@earendil-works/pi-ai'
import { isRecord } from '@pidex/shared/guards'

const tokenCount = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

export function observeCacheWriteUsage(api: Api, options?: StreamOptions) {
  const completions = api === 'openai-completions'
  const anthropic = api === 'anthropic-messages'
  if (!completions && !anthropic && api !== 'openai-responses') return undefined

  let headerWrites: Record<string, number> | undefined
  let anthropicWrites: Record<string, number> | undefined
  let openAiInput:
    { total: number; read: number | undefined; write: number | undefined } | undefined
  return {
    options: {
      ...options,
      async onResponse(response, model) {
        if (!anthropic) {
          const writes: Record<string, number> = {}
          for (const [name, raw] of Object.entries(response.headers)) {
            const ttl = /^msh-usage-cache-write-tokens-(5m|1h)$/i.exec(name)?.[1]?.toLowerCase()
            const count = /^\d+$/.test(raw) ? tokenCount(Number(raw)) : undefined
            if (ttl && count !== undefined) writes[ttl] = count
          }
          headerWrites = Object.keys(writes).length ? writes : undefined
        }
        await options?.onResponse?.(response, model)
      },
      async onProviderStreamEvent(event, model) {
        if (isRecord(event)) {
          const source =
            anthropic && event.type === 'message_start'
              ? event.message
              : !anthropic && !completions
                ? event.response
                : event
          const usage = isRecord(source) ? source.usage : undefined
          if (isRecord(usage)) {
            if (anthropic && isRecord(usage.cache_creation)) {
              const short = tokenCount(usage.cache_creation.ephemeral_5m_input_tokens)
              const long = tokenCount(usage.cache_creation.ephemeral_1h_input_tokens)
              anthropicWrites = {
                ...anthropicWrites,
                ...(short !== undefined ? { '5m': short } : {}),
                ...(long !== undefined ? { '1h': long } : {}),
              }
            } else if (!anthropic) {
              const total = tokenCount(completions ? usage.prompt_tokens : usage.input_tokens)
              const details = completions ? usage.prompt_tokens_details : usage.input_tokens_details
              const detail = isRecord(details) ? details : undefined
              if (total !== undefined) {
                openAiInput = {
                  total,
                  read: tokenCount(detail?.cached_tokens ?? usage.cached_tokens),
                  write: tokenCount(detail?.cache_write_tokens ?? usage.cache_write_tokens),
                }
              }
            }
          }
        }
        await options?.onProviderStreamEvent?.(event, model)
      },
    } satisfies StreamOptions,
    settle(usage: Usage, model: Model<Api>) {
      const split = anthropic ? anthropicWrites : headerWrites
      const splitTotal = Object.values(split ?? {}).reduce((sum, tokens) => sum + tokens, 0)
      const inputTotal = openAiInput?.total ?? usage.input + usage.cacheRead + usage.cacheWrite
      const read = openAiInput?.read ?? usage.cacheRead
      const write = anthropic
        ? Math.max(usage.cacheWrite, splitTotal)
        : (openAiInput?.write ??
          (usage.cacheWrite || Math.min(splitTotal, Math.max(0, inputTotal - read))))
      const input = anthropic ? usage.input : Math.max(0, inputTotal - read - write)
      if (input !== usage.input || read !== usage.cacheRead || write !== usage.cacheWrite) {
        const delta = input + read + write - usage.input - usage.cacheRead - usage.cacheWrite
        Object.assign(usage, {
          input,
          cacheRead: read,
          cacheWrite: write,
          totalTokens: usage.totalTokens + delta,
        })
        calculateCost(model, usage)
      }
      return split && splitTotal <= write ? split : undefined
    },
  }
}
