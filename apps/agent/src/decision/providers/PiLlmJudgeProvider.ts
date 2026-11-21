import type { Api, Model as PiModel } from '@earendil-works/pi-ai'
import { Model, Provider } from '@pidex/model-schema'
import type { JudgeConfig } from '@pidex/shared/decision'
import { JudgeError } from '../DecisionErrors'
import type { JudgeProvider } from '../Judge'
import type { ConfigService } from '../../config/ConfigService'
import type { AgentDatabase } from '../../storage/database/AgentDatabase'
import type { PiModelService } from '../../provider/pi/PiModelService'
import { resolveSpecializedPiModel } from '../../provider/pi/PiSpecializedModelResolver'
import { LlmJudgeProvider, type LlmCompletion } from './LlmJudgeProvider'

const thinkingLevelOf = (thinking: JudgeConfig['thinking']): 'minimal' | 'low' | 'medium' | 'high' => {
  if (thinking === undefined || thinking === 'off') return 'minimal'
  return thinking
}

const refOf = (model: string): Model.Ref => {
  const separator = model.indexOf('/')
  if (separator <= 0) throw new JudgeError('bad_request', 'LLM judge model must be provider/model-id')
  return Model.Ref.make({
    providerID: Provider.ID.make(model.slice(0, separator)),
    id: Model.ID.make(model.slice(separator + 1)),
  })
}

/**
 * Any chat model as a zero-shot judge through PiModelService. Without an explicit
 * model it falls back to `specialized_models.security`, then `generation`.
 */
export function createPiLlmJudgeProvider(input: {
  models: PiModelService
  db: AgentDatabase
  config: ConfigService
  model?: string | undefined
  thinking?: JudgeConfig['thinking']
}): JudgeProvider {
  const resolveModel = async (): Promise<PiModel<Api>> => {
    if (input.model) return input.models.getPiModel(refOf(input.model))
    for (const purpose of ['security', 'generation'] as const) {
      const resolved = await resolveSpecializedPiModel({
        purpose,
        db: input.db,
        models: input.models,
        configService: input.config,
        includeMainFallback: false,
      })
      if (resolved) return resolved.model
    }
    throw new JudgeError('auth', 'No judge model is configured')
  }
  const complete: LlmCompletion = async (request) => {
    const model = await resolveModel()
    const response = await input.models.pi.completeSimple(
      model,
      {
        systemPrompt: request.system,
        messages: [{ role: 'user', content: request.user, timestamp: Date.now() }],
      },
      {
        ...(request.signal ? { signal: request.signal } : {}),
        maxRetries: 0,
        reasoning: thinkingLevelOf(input.thinking),
      },
    )
    if (response.stopReason === 'error')
      throw new JudgeError('server', 'The judge model call failed')
    if (response.stopReason === 'aborted') {
      const aborted = new Error('The judge model call was aborted')
      aborted.name = 'AbortError'
      throw aborted
    }
    const text = response.content
      .flatMap((item) => (item.type === 'text' ? [item.text] : []))
      .join('\n')
    return {
      text,
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
    }
  }
  return new LlmJudgeProvider({ id: `llm:${input.model ?? 'specialized'}`, complete })
}