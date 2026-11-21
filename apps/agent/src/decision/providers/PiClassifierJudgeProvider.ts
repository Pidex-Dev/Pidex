import type {
  ClassifierApi,
  ClassifierModel,
  ClassifierQuestion,
  JsonObject,
} from '@earendil-works/pi-ai'
import type { JudgeInput } from '@pidex/shared/decision'
import { JudgeError } from '../DecisionErrors'
import type { JudgeProvider } from '../Judge'
import type { PiModelService } from '../../provider/pi/PiModelService'
import { ClassifierJudgeProvider, type ClassifierOutcome } from './ClassifierJudgeProvider'

const asJsonObject = (state: JudgeInput): JsonObject =>
  typeof state === 'string' ? { text: state } : (state as JsonObject)

/**
 * A pi-ai classifier model (`typesafe-system-one`, `cloudflare-workers-ai-system-one`,
 * `llama-cpp-classify`) reached through the host's PiModelService and its encrypted
 * provider credentials. `model` is written as `provider/model-id`.
 */
export function createPiClassifierJudgeProvider(input: {
  models: PiModelService
  model: string
}): JudgeProvider {
  const separator = input.model.indexOf('/')
  if (separator <= 0)
    throw new JudgeError('bad_request', 'Classifier judge model must be provider/model-id')
  const providerId = input.model.slice(0, separator)
  const modelId = input.model.slice(separator + 1)
  return new ClassifierJudgeProvider({
    model: input.model,
    call: async (request): Promise<ClassifierOutcome> => {
      const model = input.models.pi.getModelOfType('classifier', providerId, modelId) as
        ClassifierModel<ClassifierApi> | undefined
      if (!model) throw new JudgeError('auth', `Classifier model ${input.model} is not configured`)
      const result = await input.models.pi.classify(
        model,
        {
          state: asJsonObject(request.state),
          questions: request.questions as Record<string, ClassifierQuestion>,
        },
        { ...(request.signal ? { signal: request.signal } : {}) },
      )
      return {
        answers: result.answers,
        usage: result.usage
          ? { input: result.usage.input, output: result.usage.output }
          : undefined,
        stopReason: result.stopReason,
        errorMessage: result.errorMessage,
      }
    },
  })
}
