import { Credential } from '@pidex/model-schema'
import type { DecisionConfig, JudgeConfig } from '@pidex/shared/decision'
import { Effect, Schema } from 'effect'
import type { ProviderCredentialRepository } from '../auth/ProviderCredentialRepository'
import { JudgeError } from './DecisionErrors'
import { Judge, type JudgeLike } from './Judge'
import { CascadeJudge, type CascadeTier } from './JudgeCascade'
import type { ConfigService } from '../config/ConfigService'
import type { ApiKeyService } from '../provider/ApiKeyService'
import type { PiModelService } from '../provider/pi/PiModelService'
import type { AgentDatabase } from '../storage/database/AgentDatabase'
import { isOpenAIAddress, OpenAIDecisionsJudgeProvider } from './providers/OpenAIDecisionsJudgeProvider'
import { HttpJudgeProvider, SystemOneJudgeProvider } from './providers/SystemOneJudgeProvider'
import { createPiClassifierJudgeProvider } from './providers/PiClassifierJudgeProvider'
import { createPiLlmJudgeProvider } from './providers/PiLlmJudgeProvider'
import { MockJudgeProvider } from './providers/MockJudgeProvider'

export interface JudgeFactoryDeps {
  models?: PiModelService | undefined
  apiKeys?: ApiKeyService | undefined
  credentials?: ProviderCredentialRepository | undefined
  config?: ConfigService | undefined
  db?: AgentDatabase | undefined
}

// SAFETY: credential order is credentialId, then the bound provider's auth, then the shared openai key only for OpenAI's own address; a custom baseUrl never receives it.
function keyResolverFor(
  judge: JudgeConfig,
  deps: JudgeFactoryDeps,
  options: { openaiFallback?: boolean } = {},
): () => Promise<string | undefined> {
  return async () => {
    if (judge.credentialId) {
      if (deps.credentials) {
        try {
          const stored = await Effect.runPromise(
            deps.credentials.getById<Credential.Value>(judge.credentialId),
          )
          if (stored && stored.kind === 'api-key' && Schema.is(Credential.Key)(stored.value)) {
            return stored.value.key
          }
        } catch {
          throw new JudgeError('auth', 'The bound credential is unavailable')
        }
      }
      if (deps.apiKeys) {
        try {
          return await deps.apiKeys.copyMaterial(judge.credentialId)
        } catch {
          throw new JudgeError('auth', 'The bound credential is unavailable')
        }
      }
      throw new JudgeError(
        'auth',
        deps.credentials ? 'The bound credential is unavailable' : 'Credential store is unavailable',
      )
    }
    if (judge.providerId && deps.models) {
      const auth = await deps.models.pi.getAuth(judge.providerId)
      if (auth?.auth.apiKey) return auth.auth.apiKey
      throw new JudgeError('auth', `No API key is configured for provider ${judge.providerId}`)
    }
    if (options.openaiFallback && isOpenAIAddress(judge.baseUrl) && deps.models) {
      const auth = await deps.models.pi.getAuth('openai')
      if (auth?.auth.apiKey) return auth.auth.apiKey
    }
    return undefined
  }
}

function baseUrlResolverFor(
  judge: JudgeConfig,
  deps: JudgeFactoryDeps,
): string | (() => Promise<string | undefined>) | undefined {
  if (judge.baseUrl) return judge.baseUrl
  const providerId = judge.providerId
  const models = deps.models
  if (!providerId || !models) return undefined
  return async () => {
    const config = await models.catalogConfig()
    const configured = config.providers[providerId]
    if (configured?.baseUrl) return configured.baseUrl
    const piModels = models.pi.getModels(providerId)
    const matched = judge.model ? piModels.find((item) => item.id === judge.model) : undefined
    return matched?.baseUrl ?? piModels[0]?.baseUrl
  }
}

function qualifiedModelOf(judge: JudgeConfig): string | undefined {
  if (!judge.model) return undefined
  if (!judge.providerId || judge.model.startsWith(`${judge.providerId}/`)) return judge.model
  return `${judge.providerId}/${judge.model}`
}

/** Builds one configured judge; unknown or unwired types fail as `auth`. */
export function buildJudge(name: string, judge: JudgeConfig, deps: JudgeFactoryDeps): JudgeLike {
  const timeoutMs = judge.timeoutMs
  const baseUrl = baseUrlResolverFor(judge, deps)
  switch (judge.type) {
    case 'openai':
      return new Judge({
        provider: new OpenAIDecisionsJudgeProvider({
          apiKey: keyResolverFor(judge, deps, { openaiFallback: true }),
          model: judge.model,
          baseUrl,
          idPrefix: judge.providerId,
        }),
        timeoutMs,
      })
    case 'typesafe':
    case 'systemone':
      return new Judge({
        provider: new SystemOneJudgeProvider({
          kind: judge.type,
          apiKey: keyResolverFor(judge, deps),
          model: judge.model,
          baseUrl,
          idPrefix: judge.providerId,
        }),
        timeoutMs,
      })
    case 'http': {
      if (!judge.baseUrl) throw new JudgeError('bad_request', `Judge "${name}" needs a baseUrl`)
      return new Judge({
        provider: new HttpJudgeProvider({
          baseUrl: judge.baseUrl,
          path: judge.path,
          apiKey: keyResolverFor(judge, deps),
        }),
        timeoutMs,
      })
    }
    case 'classifier': {
      if (!deps.models) throw new JudgeError('auth', 'Model service is unavailable')
      const model = qualifiedModelOf(judge)
      if (!model) throw new JudgeError('bad_request', `Judge "${name}" needs a model`)
      return new Judge({
        provider: createPiClassifierJudgeProvider({ models: deps.models, model }),
        timeoutMs,
      })
    }
    case 'llm': {
      if (!deps.models || !deps.db || !deps.config)
        throw new JudgeError('auth', 'Model service is unavailable')
      return new Judge({
        provider: createPiLlmJudgeProvider({
          models: deps.models,
          db: deps.db,
          config: deps.config,
          model: qualifiedModelOf(judge),
          thinking: judge.thinking,
        }),
        timeoutMs,
      })
    }
    case 'mock':
      return new Judge({ provider: new MockJudgeProvider({ id: `mock:${name}` }), timeoutMs })
    default:
      throw new JudgeError('bad_request', `Unknown judge type for "${name}"`)
  }
}

/** The tier chain named by `tiers`, or every configured judge in insertion order. */
export function buildCascade(config: DecisionConfig, deps: JudgeFactoryDeps): JudgeLike | null {
  const names = config.tiers.length > 0 ? config.tiers : Object.keys(config.judges)
  const tiers: CascadeTier[] = []
  for (const name of names) {
    const judge = config.judges[name]
    if (!judge) continue
    tiers.push({ judge: buildJudge(name, judge, deps) })
  }
  if (tiers.length === 0) return null
  return new CascadeJudge(tiers)
}

/** A single named judge for probing; falls back to the first configured one. */
export function buildProbeJudge(
  config: DecisionConfig,
  deps: JudgeFactoryDeps,
  judgeName?: string,
): { name: string; judge: JudgeLike } | null {
  const name = judgeName ?? config.tiers[0] ?? Object.keys(config.judges)[0]
  if (!name) return null
  const judge = config.judges[name]
  if (!judge) return null
  return { name, judge: buildJudge(name, judge, deps) }
}