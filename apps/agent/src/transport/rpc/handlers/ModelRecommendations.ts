import { PricingValidationError } from '../../../provider/ModelPricing'
import { ModelDocumentRpcMethods } from '@pidex/agent-protocol'
import { Model, Provider } from '@pidex/model-schema'
import { ModelDocumentService } from '../../../provider/ModelDocumentService'
import { Schema } from 'effect'
import {
  ModelSpecRepairRpcMethods,
  RecommendationPreviewParams,
} from '@pidex/agent-protocol'
import { AgentError } from '../../../Domain'
import { ModelSpecRepairService } from '../../../provider/pi/ModelSpecRepairService'
import type { RpcHandlerGroup } from './Types'

const documents = new ModelDocumentService()

const specPreviewParams = ModelSpecRepairRpcMethods['provider/model/specs/preview'].params
const specApplyParams = ModelSpecRepairRpcMethods['provider/model/specs/apply'].params

export const modelRecommendationHandlers = {
  name: 'model-recommendations',
  methods: [
    'model/document/extract', 'model/document/cancel', 'model/pricing/refresh',
    'model/recommendation/preview',
    'model/recommendation/refresh',
    'provider/model/specs/preview',
    'provider/model/specs/apply',
  ],
  async handle(runtime, method, rawParams, context) {
    try {
      if (method === 'model/document/cancel') return documents.cancel(Schema.decodeUnknownSync(ModelDocumentRpcMethods['model/document/cancel'].params)(rawParams).operationId, context.connectionId ?? '')
      if (method === 'model/pricing/refresh') {
        const input = Schema.decodeUnknownSync(ModelDocumentRpcMethods['model/pricing/refresh'].params)(rawParams)
        const status = await runtime.dependencies.piModels.refreshModelPricing(input.force ?? true, input.year)
        const fx = status.fx as { rate?: number; date?: string } | null
        return { fxRate: fx?.rate, fxDate: fx?.date, calendarYear: status.calendarYear, calendarAvailable: status.calendarAvailable }
      }
      if (method === 'model/document/extract') {
        const input = Schema.decodeUnknownSync(ModelDocumentRpcMethods['model/document/extract'].params)(rawParams)
        const config = runtime.dependencies.config?.snapshot() ?? {}
        const recent = (config.desktop as { recent_new_thread_model?: { providerID: string; id: string } } | undefined)?.recent_new_thread_model
        const configured = typeof config.model === 'string' && typeof config.model_provider === 'string' ? { providerID: config.model_provider, id: config.model } : undefined
        const main = recent ?? configured
        const extractor = input.extractor ?? (main?.providerID && main.id ? Model.Ref.make({ providerID: Provider.ID.make(main.providerID), id: Model.ID.make(main.id) }) : undefined)
        if (!extractor) throw new AgentError('INVALID_REQUEST', '请先选择资料提取模型。', 400)
        return await documents.extract({ ...input, extractor }, context.connectionId ?? '', runtime.dependencies.piModels)
      }

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
      if (cause instanceof PricingValidationError) throw new AgentError('INVALID_REQUEST', cause.message, 400)
      throw new AgentError('PROVIDER_UNAVAILABLE', method.startsWith('model/document/') ? '文档资料提取未完成：可能已取消、超时或提取模型不可用，请重试。' : '模型推荐配置不可用，请稍后重试。', 502)
    }
  },
} as const satisfies RpcHandlerGroup
