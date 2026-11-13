import { omitUndefined } from '@pidex/shared/guards'
import type { ModelRecommendation } from '@pidex/agent-protocol'
import type { EditableModel } from './ProviderEditorForm.js'

/** 推荐只填普通草稿字段，保存继续走现有模型配置。 */
export function fillModelDraft(
  model: EditableModel,
  recommended: ModelRecommendation,
): EditableModel {
  const specs = recommended.optionSpecs
  const reasoningValues = specs?.reasoningLevel?.values ?? recommended.reasoningLevels
  const optionSpecFields = omitUndefined({
    reasoningLevelValues: reasoningValues?.join('\n'),
    reasoningLevelMap: specs?.reasoningLevel?.map,
    maxOutputTokensMax: specs?.maxOutputTokens?.max,
    maxOutputTokensMap: specs?.maxOutputTokens?.map,
  })
  return {
    ...model,
    ...(recommended.cost && !recommended.pricing ? { pricing: undefined } : {}),
    ...optionSpecFields,
    ...omitUndefined({
      pricing: recommended.pricing,
      modelType: recommended.modelType,
      name: recommended.name,
      contextWindow: recommended.contextWindow,
      maxInputTokens: recommended.maxInputTokens,
      maxTokens: recommended.maxTokens,
      reasoning: recommended.reasoning,
      tools: recommended.tools,
      costTiers: recommended.cost?.tiers,
      imageInput: recommended.input?.includes('image'),
      audioInput: recommended.input?.includes('audio'),
      videoInput: recommended.input?.includes('video'),
      inputCost: recommended.cost?.input,
      outputCost: recommended.cost?.output,
      cacheReadCost: recommended.cost?.cacheRead,
      cacheWriteCost: recommended.cost?.cacheWrite,
    }),
  }
}
