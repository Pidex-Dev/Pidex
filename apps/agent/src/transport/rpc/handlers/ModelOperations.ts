import { AgentError } from '../../../Domain'
import { ModelServiceError } from '../../../provider/runtime/ModelService'
import { Schema } from 'effect'
import { EmbedParamsSchema, RerankParamsSchema } from '@pidex/agent-protocol'
import type { RpcHandlerGroup } from './Types'

export const modelOperationHandlers = {
  name: 'model-operations',
  methods: ['model/embed', 'model/rerank'],
  async handle(runtime, method, rawParams) {
    try {
      if (method === 'model/embed') {
        const input = Schema.decodeUnknownSync(EmbedParamsSchema)(rawParams)
        return await runtime.dependencies.runtimeModels.embed(
          input.model,
          input.input,
          input.dimensions,
        )
      }
      const input = Schema.decodeUnknownSync(RerankParamsSchema)(rawParams)
      return await runtime.dependencies.runtimeModels.rerank(
        input.model,
        input.query,
        input.documents,
        input.topN,
      )
    } catch (cause) {
      if (cause instanceof ModelServiceError)
        throw new AgentError('PROVIDER_UNAVAILABLE', '模型或凭据不可用，请检查提供商配置', 400)
      throw cause
    }
  },
} as const satisfies RpcHandlerGroup
