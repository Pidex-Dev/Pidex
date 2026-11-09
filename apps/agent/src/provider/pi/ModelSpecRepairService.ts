import type { ModelSpecField, ModelSpecMatch, ModelSpecRepairItem } from '@pidex/agent-protocol'
import { Model } from '@pidex/model-schema'
import { AgentError } from '../../Domain'
import { ConfigServiceError, type ConfigService, type ConfigValue } from '../../config/ConfigService'
import type { PiCustomModelConfig } from './PiProviderConfig'
import type { PiModelService } from './PiModelService'

const PLACEHOLDER_CONTEXT = 32_768
const REPAIR_FIELDS: readonly ModelSpecField[] = [
  'contextWindow',
  'maxTokens',
  'maxInputTokens',
]

/** 配置键使用 snake_case；key-path 局部更新保留未知字段。 */
const CONFIG_KEYS: Record<ModelSpecField, string> = {
  contextWindow: 'context_window',
  maxInputTokens: 'max_input_tokens',
  maxTokens: 'max_tokens',
}

type SpecSelection = {
  readonly modelId: string
  readonly fields: readonly ModelSpecField[]
}

/**
 * 存量 32K 占位规格的批量检查与应用。
 *
 * 只读取已保存的自定义 Provider 模型；预览与应用各自重新解析推荐，
 * 用配置版本 + 推荐目录版本阻止陈旧结果覆盖。写入只包含用户选中的
 * 额度字段，智能配置开关、固定状态与其余字段原样保留。
 */
export class ModelSpecRepairService {
  constructor(
    private readonly piModels: PiModelService,
    private readonly config: ConfigService,
  ) {}

  async preview(providerId: string): Promise<{
    providerId: string
    configVersion: string
    catalogUpdatedAt?: number
    items: ModelSpecRepairItem[]
  }> {
    const provider = await this.customProvider(providerId)
    const configVersion = await this.userConfigVersion()
    const items: ModelSpecRepairItem[] = []
    let catalogUpdatedAt: number | undefined
    for (const model of Object.values(provider.models)) {
      if (model.contextWindow !== PLACEHOLDER_CONTEXT) continue
      const preview = await this.recommendation(providerId, provider, model)
      if (preview.updatedAt !== undefined) catalogUpdatedAt ??= preview.updatedAt
      const fields = REPAIR_FIELDS.flatMap((field) => {
        const suggested = preview.recommended[field]
        if (suggested === undefined) return []
        const noRepair = suggested === PLACEHOLDER_CONTEXT
        // 与原值相同且不是 32K 占位时不制造无意义条目。
        if (suggested === model[field] && !noRepair) return []
        return [
          {
            field,
            ...(model[field] !== undefined ? { current: model[field]! } : {}),
            suggested,
            pinned: false,
            noRepair,
            defaultSelected: !!model.smartConfig && model.smartConfig.pinned.length === 0 && !noRepair,
          },
        ]
      })
      items.push({
        modelId: Model.ID.make(model.id),
        name: model.name,
        match: this.matchOf(preview),
        fields,
      })
    }
    return {
      providerId,
      configVersion,
      ...(catalogUpdatedAt !== undefined ? { catalogUpdatedAt } : {}),
      items,
    }
  }

  async apply(input: {
    providerId: string
    expectedConfigVersion: string
    expectedCatalogUpdatedAt?: number | undefined
    selections: readonly SpecSelection[]
  }): Promise<{
    providerId: string
    updatedModels: number
    updatedFields: number
  }> {
    const provider = await this.customProvider(input.providerId)
    // 先核对配置版本，避免按旧预览写入已被编辑的模型。
    if ((await this.userConfigVersion()) !== input.expectedConfigVersion) {
      throw new AgentError('CONFLICT', '配置已变化，请重新检查 32K 模型规格', 409)
    }
    const edits: { keyPath: string[]; value: ConfigValue }[] = []
    let updatedModels = 0
    for (const selection of input.selections) {
      const model = provider.models[selection.modelId]
      if (!model) continue
      const preview = await this.recommendation(input.providerId, provider, model)
      // 目录在预览后更新过就必须重新生成预览，不能按旧结果覆盖。
      if (preview.updatedAt !== input.expectedCatalogUpdatedAt) {
        throw new AgentError('CONFLICT', '推荐目录已更新，请重新检查 32K 模型规格', 409)
      }
      let touched = 0
      for (const field of selection.fields) {
        const suggested = preview.recommended[field]
        if (suggested === undefined || suggested === PLACEHOLDER_CONTEXT) continue
        edits.push({
          keyPath: [
            'model_providers',
            input.providerId,
            'models',
            selection.modelId,
            CONFIG_KEYS[field],
          ],
          value: suggested,
        })
        touched += 1
      }
      if (touched) updatedModels += 1
    }
    if (!edits.length)
      return { providerId: input.providerId, updatedModels: 0, updatedFields: 0 }
    try {
      await this.config.batchWrite({
        target: { kind: 'user' },
        expectedVersion: input.expectedConfigVersion,
        edits,
      })
    } catch (cause) {
      if (cause instanceof ConfigServiceError && cause.code === 'CONFIG_VERSION_CONFLICT')
        throw new AgentError('CONFLICT', '配置已变化，请重新检查 32K 模型规格', 409)
      throw cause
    }
    return { providerId: input.providerId, updatedModels, updatedFields: edits.length }
  }

  private recommendation(
    providerId: string,
    provider: { baseUrl: string; endpoints?: Partial<Record<string, string>> },
    model: PiCustomModelConfig,
  ) {
    const baseUrl = (model.api && provider.endpoints?.[model.api]) || provider.baseUrl
    return this.piModels.previewRecommendation({
      providerId,
      baseUrl,
      modelId: model.id,
      modelType: model.modelType ?? 'chat',
    })
  }

  private matchOf(preview: {
    status: string
    identity?: string | undefined
    source?: 'official' | 'provider' | undefined
    candidates?: readonly string[] | undefined
    updatedAt?: number | undefined
  }): ModelSpecMatch {
    const status =
      preview.status === 'matched'
        ? (preview.source ?? 'official')
        : (preview.status as ModelSpecMatch['status'])
    return {
      status,
      ...(preview.identity ? { identity: Model.ID.make(preview.identity) } : {}),
      ...(preview.candidates
        ? { candidates: preview.candidates.map((id) => Model.ID.make(id)) }
        : {}),
      ...(preview.updatedAt !== undefined ? { updatedAt: preview.updatedAt } : {}),
    }
  }

  private async userConfigVersion(): Promise<string> {
    const configuration = await this.config.read({ includeLayers: true })
    const userLayer = configuration.layers?.find((layer) => layer.kind === 'user')
    if (!userLayer) throw new AgentError('CONFLICT', '供应商配置层不可用，请刷新后重试', 409)
    return userLayer.version
  }

  private async customProvider(providerId: string) {
    const provider = (await this.piModels.catalogConfig()).providers[providerId]
    if (!provider) {
      throw new AgentError('PROVIDER_NOT_FOUND', `Provider ${providerId} 不存在`, 404)
    }
    if (provider.kind !== 'custom') {
      throw new AgentError('INVALID_REQUEST', '只有自定义 Provider 支持检查 32K 模型规格', 400)
    }
    return provider
  }
}
