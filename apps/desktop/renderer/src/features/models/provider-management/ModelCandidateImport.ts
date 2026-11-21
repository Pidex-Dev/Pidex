import type {
  DesktopModelMetadata,
  DesktopProviderModelDefinition,
  DesktopProviderModelMatch,
} from '../../../../shared/Types.js'

export type CandidateMatchStatus = DesktopProviderModelMatch['status'] | 'unknown'

export const GENERIC_MODEL_CONTEXT_WINDOW = 128_000
export const GENERIC_MODEL_MAX_TOKENS = 8_192

/** 只有官方/供应商明确给出上下文与最大输出时才能直接导入。 */
export function isImportableCandidate(
  model: DesktopProviderModelDefinition,
  match: DesktopProviderModelMatch | undefined,
): boolean {
  return (
    (match?.status === 'official' || match?.status === 'provider') &&
    !!model.contextWindow &&
    !!model.maxTokens
  )
}

/**
 * 补齐远端候选模型的缺失规格：保留远端与目录已有字段，仅对缺失的上下文、
 * 最大输出、输入模态与工具能力填入通用默认值，便于直接拖拽或批量添加。
 */
export function resolveCandidateImportModel(
  model: DesktopProviderModelDefinition,
  metadata?: DesktopModelMetadata,
): DesktopProviderModelDefinition {
  const contextWindow =
    model.contextWindow && model.contextWindow > 0
      ? model.contextWindow
      : metadata?.contextWindow && metadata.contextWindow > 0
        ? metadata.contextWindow
        : GENERIC_MODEL_CONTEXT_WINDOW
  const maxTokens =
    model.maxTokens && model.maxTokens > 0
      ? model.maxTokens
      : metadata?.outputTokens && metadata.outputTokens > 0
        ? metadata.outputTokens
        : GENERIC_MODEL_MAX_TOKENS
  type ModelInputModality = NonNullable<DesktopProviderModelDefinition['input']>[number]
  const rawInput: readonly ModelInputModality[] =
    model.input && model.input.length > 0
      ? model.input
      : metadata?.modalities?.input && metadata.modalities.input.length > 0
        ? (metadata.modalities.input.filter(
            (item): item is ModelInputModality =>
              item === 'text' || item === 'image' || item === 'audio' || item === 'video',
          ) as readonly ModelInputModality[])
        : metadata?.vision
          ? (['text', 'image'] as const)
          : (['text'] as const)
  const input: ModelInputModality[] = rawInput.length > 0 ? [...rawInput] : ['text']
  const isNonChat = model.modelType === 'embedding' || model.modelType === 'rerank'
  const tools = model.tools ?? metadata?.toolCall ?? !isNonChat
  return {
    ...model,
    enabled: true,
    contextWindow,
    maxTokens,
    input,
    tools,
  }
}

export function candidateMatchLabel(status: CandidateMatchStatus | undefined): string {
  switch (status) {
    case 'official':
      return '官方匹配'
    case 'provider':
      return '供应商规格'
    case 'ambiguous':
      return '歧义'
    case 'no-cache':
      return '目录不可用'
    case 'unmatched':
      return '未匹配'
    default:
      return '规格未知'
  }
}

/** 歧义候选身份提示；无候选时退回通用说明。 */
export function candidateMatchHint(
  match: { status: CandidateMatchStatus; candidates?: readonly string[] } | undefined,
): string | undefined {
  if (match?.status === 'ambiguous' && match.candidates?.length)
    return `可能是 ${match.candidates.join(' / ')}，请确认后手动补齐。`
  if (match?.status === 'unmatched') return '目录未收录，请手动补齐上下文与最大输出。'
  if (match?.status === 'no-cache') return '推荐目录不可用，请手动补齐上下文与最大输出。'
  return undefined
}
