import {
  Binary,
  Brain,
  Code,
  Eye,
  MessageSquare,
  Mic,
  Sparkles,
  Video,
  Wrench,
} from 'lucide-react'
import type React from 'react'
import type {
  DesktopModelMetadata,
  DesktopModelProviderSummary,
  DesktopProviderModelDefinition,
} from '../../../../shared/Types.js'

export type SyncStatusFilter = 'all' | 'unadded' | 'added'

export type ModelCapability = {
  key: string
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  badgeClass: string
}

export const SYNC_CAPABILITY_FILTER_OPTIONS = [
  { key: 'reasoning', label: '推理' },
  { key: 'vision', label: '视觉 / 图片' },
  { key: 'tools', label: '工具调用' },
  { key: 'audio', label: '语音 / 音频' },
  { key: 'video', label: '视频' },
  { key: 'code', label: '代码' },
  { key: 'embedding', label: '向量嵌入' },
  { key: 'rerank', label: '重排' },
  { key: 'chat', label: '通用对话' },
] as const

function formatVendorName(prefix: string): string {
  const p = prefix.toLowerCase()
  if (p === 'openai') return 'OpenAI'
  if (p === 'anthropic') return 'Anthropic'
  if (p === 'google') return 'Google'
  if (p === 'meta') return 'Meta'
  if (p === 'deepseek') return 'DeepSeek'
  if (p === 'alibaba' || p === 'qwen') return '通义千问'
  if (p === 'zhipu' || p === 'zai' || p === 'glm') return '智谱 AI'
  if (p === 'moonshot' || p === 'kimi') return '月之暗面'
  if (p === 'minimax') return 'MiniMax'
  if (p === 'mistral') return 'Mistral'
  if (p === 'xiaomi' || p === 'mimo') return '小米'
  if (p === 'bytedance' || p === 'doubao') return '火山引擎'
  return prefix.charAt(0).toUpperCase() + prefix.slice(1)
}

export function resolveModelVendor(
  model: DesktopProviderModelDefinition,
  provider: DesktopModelProviderSummary,
): string {
  if (model.id.includes('/')) {
    const prefix = model.id.split('/')[0]!.trim()
    if (prefix) return formatVendorName(prefix)
  }
  const nameToMatch = `${model.id} ${model.name ?? ''}`.toLowerCase()
  if (/deepseek/i.test(nameToMatch)) return 'DeepSeek'
  if (/qwen|qwq|qvq/i.test(nameToMatch)) return '通义千问'
  if (/glm|chatglm/i.test(nameToMatch)) return '智谱 AI'
  if (/gpt|chatgpt|codex|(?:^|[-_/])o[134](?:[-_.]|$)/i.test(nameToMatch)) return 'OpenAI'
  if (/claude|anthropic/i.test(nameToMatch)) return 'Anthropic'
  if (/gemini/i.test(nameToMatch)) return 'Google'
  if (/gemma/i.test(nameToMatch)) return 'Google Gemma'
  if (/llama|meta-/i.test(nameToMatch)) return 'Meta'
  if (/mistral|mixtral|codestral/i.test(nameToMatch)) return 'Mistral'
  if (/mimo|xiaomi/i.test(nameToMatch)) return '小米 (Xiaomi)'
  if (/minimax|abab/i.test(nameToMatch)) return 'MiniMax'
  if (/kimi|moonshot/i.test(nameToMatch)) return '月之暗面 (Moonshot)'
  if (/mineru/i.test(nameToMatch)) return 'MinerU'
  if (/minicpm/i.test(nameToMatch)) return '面壁智能 (OpenBMB)'
  if (/omnivoice/i.test(nameToMatch)) return 'OmniVoice'
  if (/step|阶跃/i.test(nameToMatch)) return '阶跃星辰'
  if (/doubao|seedream/i.test(nameToMatch)) return '火山引擎 (字节)'
  if (/cohere|command-r/i.test(nameToMatch)) return 'Cohere'
  if (/nvidia|nemotron/i.test(nameToMatch)) return 'NVIDIA'
  return provider.displayName || provider.providerID
}

export function resolveModelCapabilities(
  model: DesktopProviderModelDefinition,
  metadata?: DesktopModelMetadata,
): ModelCapability[] {
  const caps: ModelCapability[] = []
  const text = `${model.id} ${model.name ?? ''}`.toLowerCase()

  const isReasoning = Boolean(
    model.reasoning ??
      metadata?.reasoning ??
      /reason|deepseek-r1|qwq|o1|o3|o4|thinking/i.test(text),
  )
  if (isReasoning) {
    caps.push({
      key: 'reasoning',
      label: '推理',
      icon: Brain,
      badgeClass: 'tw:bg-app-info/15 tw:text-app-info-fg',
    })
  }

  const isVision = Boolean(
    model.input?.includes('image') ||
      metadata?.vision ||
      metadata?.modalities?.input?.includes('image') ||
      /vision|vl|-v-|image/i.test(text),
  )
  if (isVision) {
    caps.push({
      key: 'vision',
      label: '视觉',
      icon: Eye,
      badgeClass: 'tw:bg-app-success/15 tw:text-app-success-fg',
    })
  }

  const isAudio = Boolean(
    model.input?.includes('audio') ||
      metadata?.modalities?.input?.includes('audio') ||
      /audio|voice|speech|tts|whisper/i.test(text),
  )
  if (isAudio) {
    caps.push({
      key: 'audio',
      label: '语音',
      icon: Mic,
      badgeClass: 'tw:bg-app-danger/15 tw:text-app-danger-fg',
    })
  }

  const catalogInputs = model.catalog?.input ?? model.input
  if (catalogInputs?.includes('video')) {
    caps.push({
      key: 'video',
      label: '视频',
      icon: Video,
      badgeClass: 'tw:bg-app-skill/15 tw:text-app-skill-fg',
    })
  }
  if (catalogInputs?.includes('pdf')) {
    caps.push({
      key: 'pdf',
      label: 'PDF（目录）',
      icon: Eye,
      badgeClass: 'tw:bg-app-hover tw:text-app-text-soft',
    })
  }
  if (model.catalog?.structuredOutput) {
    caps.push({
      key: 'structured',
      label: '结构化输出',
      icon: Code,
      badgeClass: 'tw:bg-app-hover tw:text-app-text-soft',
    })
  }

  const isCode = Boolean(/coder|coding|code/i.test(text))
  if (isCode) {
    caps.push({
      key: 'code',
      label: '代码',
      icon: Code,
      badgeClass: 'tw:bg-app-chart-cyan/15 tw:text-app-chart-cyan',
    })
  }

  const isEmbedding = Boolean(model.modelType === 'embedding' || /embed/i.test(text))
  if (isEmbedding) {
    caps.push({
      key: 'embedding',
      label: '向量嵌入',
      icon: Binary,
      badgeClass: 'tw:bg-app-chart-blue/15 tw:text-app-chart-blue',
    })
  }

  const isRerank = Boolean(model.modelType === 'rerank' || /rerank/i.test(text))
  if (isRerank) {
    caps.push({
      key: 'rerank',
      label: '重排',
      icon: Sparkles,
      badgeClass: 'tw:bg-app-chart-orange/15 tw:text-app-chart-orange',
    })
  }

  const hasTools = Boolean(model.tools ?? metadata?.toolCall ?? (!isEmbedding && !isRerank))
  if (hasTools && !isEmbedding && !isRerank) {
    caps.push({
      key: 'tools',
      label: '工具',
      icon: Wrench,
      badgeClass: 'tw:bg-app-warning/15 tw:text-app-warning-fg',
    })
  }

  if (caps.length === 0) {
    caps.push({
      key: 'chat',
      label: '通用对话',
      icon: MessageSquare,
      badgeClass: 'tw:bg-app-hover tw:text-app-text-soft',
    })
  }

  return caps
}

/** 上下文只接受目录/上游的明确值；名称中的 K/M 不代表真实额度。 */
export function resolveModelContextWindow(
  model: DesktopProviderModelDefinition,
  metadata?: DesktopModelMetadata,
): number | null {
  if (model.contextWindow && model.contextWindow > 0) {
    return model.contextWindow
  }
  if (metadata?.contextWindow && metadata.contextWindow > 0) {
    return metadata.contextWindow
  }
  return null
}

export function filterDiscoveredModels(
  models: readonly DesktopProviderModelDefinition[],
  options: {
    query: string
    statusFilter: SyncStatusFilter
    capabilityFilters: ReadonlySet<string>
    addedIds: ReadonlySet<string>
    provider: DesktopModelProviderSummary
    modelMetadata: Readonly<Record<string, DesktopModelMetadata>>
  },
): DesktopProviderModelDefinition[] {
  const q = options.query.trim().toLowerCase()
  return models.filter((model) => {
    const isAdded = options.addedIds.has(model.id)
    if (options.statusFilter === 'added' && !isAdded) return false
    if (options.statusFilter === 'unadded' && isAdded) return false

    const caps = resolveModelCapabilities(model, options.modelMetadata[model.id])
    if (options.capabilityFilters.size > 0) {
      const capKeys = new Set(caps.map((cap) => cap.key))
      for (const required of options.capabilityFilters) {
        if (!capKeys.has(required)) return false
      }
    }

    if (!q) return true
    const vendor = resolveModelVendor(model, options.provider)
    const capLabels = caps.map((c) => c.label).join(' ')
    const text = `${model.id} ${model.name ?? ''} ${vendor} ${capLabels}`.toLowerCase()
    return text.includes(q)
  })
}
