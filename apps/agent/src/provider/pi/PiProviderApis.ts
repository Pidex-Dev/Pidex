import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import type { Api, Model as PiModel, ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { CustomProviderApi } from './PiProviderConfig'

/**
 * Whether an `openai-responses` model should send system instructions as `developer`
 * when `compat.supportsDeveloperRole` is not explicitly configured.
 */
export function supportsOpenAIResponsesDeveloperRole(modelId: string, baseUrl: string): boolean {
  if (URL.canParse(baseUrl)) {
    const endpoint = new URL(baseUrl)
    if (
      endpoint.protocol === 'https:' &&
      (endpoint.hostname === 'api.openai.com' || endpoint.hostname.endsWith('.openai.azure.com'))
    ) {
      return true
    }
  }
  const normalized = modelId.trim().toLowerCase()
  const bare = normalized.includes('/')
    ? normalized.slice(normalized.lastIndexOf('/') + 1)
    : normalized
  if (bare.includes('-chat')) return false
  return /^(?:o[134]|gpt-[5-9])(?:$|[.-])/.test(bare)
}

/**
 * Defaults `compat.supportsDeveloperRole` to `false` for `openai-completions` and non-OpenAI
 * `openai-responses` models unless explicitly configured, avoiding HTTP 400 rejections from
 * compatible gateways that only accept the `system` role.
 */
export function normalizeDeveloperRoleCompat<T extends PiModel<Api>>(model: T): T {
  if (model.api === 'openai-completions') {
    const compat = (model as PiModel<'openai-completions'>).compat
    if (compat?.supportsDeveloperRole !== undefined) return model
    return {
      ...model,
      compat: { ...compat, supportsDeveloperRole: false },
    }
  }
  if (model.api === 'openai-responses') {
    const compat = (model as PiModel<'openai-responses'>).compat
    if (compat?.supportsDeveloperRole !== undefined) return model
    if (supportsOpenAIResponsesDeveloperRole(model.id, model.baseUrl)) return model
    return {
      ...model,
      compat: { ...compat, supportsDeveloperRole: false },
    }
  }
  return model
}

/** Stream adapters keyed by wire protocol, shared by custom and builtin providers. */
export const piProviderApiStreams: Readonly<Record<CustomProviderApi, () => ProviderStreams>> = {
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
}
