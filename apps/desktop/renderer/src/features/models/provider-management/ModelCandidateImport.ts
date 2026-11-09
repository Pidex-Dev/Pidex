import type { DesktopProviderModelDefinition } from '../../../../shared/Types.js'
import type { DesktopProviderModelMatch } from '../../../../shared/Types.js'

export type CandidateMatchStatus = DesktopProviderModelMatch['status'] | 'unknown'

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
