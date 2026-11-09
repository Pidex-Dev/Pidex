import { Schema } from 'effect'
import {
  ModelSpecRepairRpcMethods,
  RecommendationPreviewParams,
} from '@pidex/agent-protocol'
import { AgentError } from '../../../Domain'
import { ModelSpecRepairService } from '../../../provider/pi/ModelSpecRepairService'
import type { RpcHandlerGroup } from './Types'

const specPreviewParams = ModelSpecRepairRpcMethods['provider/model/specs/preview'].params
const specApplyParams = ModelSpecRepairRpcMethods['provider/model/specs/apply'].params

export const modelRecommendationHandlers = {
  name: 'model-recommendations',
  methods: [
    'model/recommendation/preview',
    'model/recommendation/refresh',
    'provider/model/specs/preview',
    'provider/model/specs/apply',
  ],
  async handle(runtime, method, rawParams) {
    try {
      if (method === 'model/recommendation/preview') {
        const input = Schema.decodeUnknownSync(RecommendationPreviewParams)(rawParams)
        return await runtime.dependencies.piModels.previewRecommendation(input)
      }
      if (method === 'provider/model/specs/preview' || method === 'provider/model/specs/apply') {
        const repair = new ModelSpecRepairService(
          runtime.dependencies.piModels,
          runtime.dependencies.config,
        )
        if (method === 'provider/model/specs/preview') {
          const input = Schema.decodeUnknownSync(specPreviewParams)(rawParams)
          return await repair.preview(input.providerId)
        }
        const input = Schema.decodeUnknownSync(specApplyParams)(rawParams)
        const result = await repair.apply(input)
        // 复用目录刷新与发布链路，使后续 turn 使用新规格。
        await runtime.dependencies.providers.reload()
        await runtime.publishCatalogUpdated()
        return result
      }
      const result = await runtime.dependencies.piModels.refreshRecommendations()
      // 推荐目录更新会改变已保存智能模型的生效值，推一次目录更新让 UI 重新拉取。
      await runtime.publishCatalogUpdated(false).catch(() => undefined)
      return result
    } catch (cause) {
      if (cause instanceof AgentError) throw cause
      throw new AgentError('PROVIDER_UNAVAILABLE', '模型推荐配置不可用，请稍后重试。', 502)
    }
  },
} as const satisfies RpcHandlerGroup
