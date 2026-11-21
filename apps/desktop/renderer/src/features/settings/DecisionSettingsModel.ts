import type { RpcParams, RpcResult } from '@pidex/agent-protocol'
import type {
  DecisionConfig,
  DecisionGroup,
  DecisionMode,
  DecisionPointManifest,
  JudgeConfig,
  JudgeErrorKind,
  JudgeType,
} from '@pidex/shared/decision'

export type DecisionConfigScope = RpcParams<'decision/updateConfig'>['scope']
export type DecisionConfigPatch = RpcParams<'decision/updateConfig'>['patch'][number]
export type DecisionConfigView = RpcResult<'decision/getConfig'>
export type DecisionProbeOutcome = RpcResult<'decision/probe'>

export const DECISION_GROUP_ORDER: readonly DecisionGroup[] = [
  'input',
  'context',
  'safety',
  'turn',
  'teamwork',
]

export const DECISION_GROUP_TITLES: Record<DecisionGroup, string> = {
  input: '输入',
  context: '上下文',
  safety: '安全',
  turn: '轮次',
  teamwork: '协作',
}

export const DECISION_MODE_LABELS: Record<DecisionMode, string> = {
  off: '关闭',
  shadow: '影子',
  active: '生效',
}

export type DecisionGroupModeValue = DecisionMode | 'custom'

export const DECISION_GROUP_CUSTOM_MODE_LABEL = '自定义'
export const DECISION_GROUP_CUSTOM_MODE_DESCRIPTION = '该分组下包含不同模式的决策点；点击其他模式可一键统一覆盖全组。'

export const DECISION_GROUP_SUMMARIES: Record<DecisionGroup, string> = {
  input: '用户输入预检、任务框架与插话路由',
  context: '上下文压缩、陈旧结果遗忘与记忆存取判别',
  safety: '高危动作风控、提示词与外部指令投毒筛查',
  turn: '未完成承诺自动延续与完成前验证提醒',
  teamwork: '评审分级、子 Agent 路由与 PR 监控分流',
}

export const DECISION_MODE_DESCRIPTIONS: Record<DecisionMode, string> = {
  off: '不调用 Judge，直接使用回退结果。',
  shadow: '调用 Judge 并记录账本，但仍使用回退结果。',
  active: '采用 Judge 判定；弃权或失败时回退。',
}

export const JUDGE_TYPE_LABELS: Record<JudgeType, string> = {
  openai: 'OpenAI Decisions',
  typesafe: 'TypeSafe (jev)',
  systemone: 'System One',
  http: 'HTTP 端点',
  classifier: '本地分类器',
  llm: '会话 LLM',
  mock: 'Mock（测试）',
}

export const CUSTOM_DECISION_JUDGE_TYPES = ['systemone', 'openai', 'typesafe', 'http'] as const
export type CustomDecisionJudgeType = (typeof CUSTOM_DECISION_JUDGE_TYPES)[number]

export interface CustomJudgeFieldHints {
  baseUrl: string
  model: string
  hint: string
  path?: string
}

export const CUSTOM_JUDGE_FIELD_HINTS: Record<CustomDecisionJudgeType, CustomJudgeFieldHints> = {
  systemone: {
    baseUrl: '如 https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1',
    model: '如 decision-model-preview 或 clm-latest',
    hint: '支持千问百炼 System One 或自建 System One 服务（可填到 /v1 或完整 /systemone 地址）。',
  },
  openai: {
    baseUrl: '默认 https://api.openai.com/v1（可填自定义中继）',
    model: '如 gpt-6-luna',
    hint: '调用 OpenAI Decisions API（/v1/decisions）；留空 Base URL 默认直连官方地址。',
  },
  typesafe: {
    baseUrl: '默认 https://api.typesafe.ai/v1/systemone',
    model: '如 jev-latest',
    hint: '调用 TypeSafe (jev) 托管决策服务。',
  },
  http: {
    baseUrl: '如 http://127.0.0.1:8700',
    model: '可选（由自定义服务端决定）',
    path: '默认 /v1/systemone',
    hint: '自定义 HTTP 决策端点，需填写 Base URL，可选指定请求路径。',
  },
}

/** Field placeholder hints for a custom judge type; falls back to System One hints for other types. */
export function customJudgeFieldHints(type: JudgeType): CustomJudgeFieldHints {
  return type in CUSTOM_JUDGE_FIELD_HINTS
    ? CUSTOM_JUDGE_FIELD_HINTS[type as CustomDecisionJudgeType]
    : CUSTOM_JUDGE_FIELD_HINTS.systemone
}

export const JUDGE_THINKING_OPTIONS = ['off', 'low', 'medium', 'high'] as const
export type JudgeThinking = (typeof JUDGE_THINKING_OPTIONS)[number]

export const JUDGE_ERROR_KIND_LABELS: Record<JudgeErrorKind, string> = {
  auth: '认证失败',
  payment_required: '账户欠费',
  rate_limited: '触发限流',
  bad_request: '请求无效',
  timeout: '请求超时',
  aborted: '请求被中止',
  unreachable: '无法连接',
  server: '服务端错误',
  invalid_response: '响应无效',
  unexpected: '未知错误',
}

export interface DecisionManifestGroup {
  group: DecisionGroup
  title: string
  summary: string
  points: DecisionPointManifest[]
}

/** Groups manifest decision points into the fixed five display groups. */
export function groupDecisionManifest(
  manifest: readonly DecisionPointManifest[],
): DecisionManifestGroup[] {
  return DECISION_GROUP_ORDER.map((group) => ({
    group,
    title: DECISION_GROUP_TITLES[group],
    summary: DECISION_GROUP_SUMMARIES[group],
    points: manifest.filter((point) => point.group === group),
  })).filter((section) => section.points.length > 0)
}

/** Effective mode of a decision point: explicit config first, manifest default second. */
export function decisionModeOf(
  config: DecisionConfig,
  point: DecisionPointManifest,
): DecisionMode {
  return config.modes[point.id] ?? point.defaultMode
}

export interface DecisionGroupModeCounts {
  off: number
  shadow: number
  active: number
  customRouteCount: number
}

/** Computes the group-level mode (`off` | `shadow` | `active` | `custom`) across all points in a group. */
export function decisionGroupModeOf(
  config: DecisionConfig,
  points: readonly DecisionPointManifest[],
): DecisionGroupModeValue {
  if (points.length === 0) return 'off'
  const first = decisionModeOf(config, points[0]!)
  for (let index = 1; index < points.length; index += 1) {
    if (decisionModeOf(config, points[index]!) !== first) {
      return 'custom'
    }
  }
  return first
}

/** Counts each effective mode and custom routes inside a manifest group. */
export function decisionGroupModeCounts(
  config: DecisionConfig,
  points: readonly DecisionPointManifest[],
): DecisionGroupModeCounts {
  const counts: DecisionGroupModeCounts = {
    off: 0,
    shadow: 0,
    active: 0,
    customRouteCount: 0,
  }
  for (const point of points) {
    counts[decisionModeOf(config, point)] += 1
    if ((config.routes[point.id]?.length ?? 0) > 0) {
      counts.customRouteCount += 1
    }
  }
  return counts
}

/** Formats a compact Chinese status summary for a collapsed decision group header. */
export function decisionGroupStatusSummary(
  config: DecisionConfig,
  points: readonly DecisionPointManifest[],
): string {
  const counts = decisionGroupModeCounts(config, points)
  const modeParts: string[] = []
  if (counts.active > 0) modeParts.push(`${counts.active} 生效`)
  if (counts.shadow > 0) modeParts.push(`${counts.shadow} 影子`)
  if (counts.off > 0) modeParts.push(`${counts.off} 关闭`)
  const base = modeParts.length > 1 ? `${points.length} 项 · ${modeParts.join(' / ')}` : `${points.length} 项`
  return counts.customRouteCount > 0 ? `${base} · ${counts.customRouteCount} 项独立路由` : base
}

/** Builds config patches to set every point in a group to the target mode. */
export function buildDecisionGroupModePatches(
  points: readonly DecisionPointManifest[],
  mode: DecisionMode,
): DecisionConfigPatch[] {
  return points.map((point) => ({
    keyPath: ['modes', point.id],
    value: mode,
  }))
}

export interface OrderedJudgeEntry {
  name: string
  judge: JudgeConfig
  tierIndex: number | null
}

/** Orders configured judges with active cascade tiers first (in cascade order), followed by unassigned judges. */
export function orderJudgesByCascade(config: DecisionConfig): OrderedJudgeEntry[] {
  const entries: OrderedJudgeEntry[] = []
  const seen = new Set<string>()
  config.tiers.forEach((name, index) => {
    const judge = config.judges[name]
    if (!judge || seen.has(name)) return
    seen.add(name)
    entries.push({ name, judge, tierIndex: index })
  })
  for (const [name, judge] of Object.entries(config.judges)) {
    if (seen.has(name)) continue
    entries.push({ name, judge, tierIndex: null })
  }
  return entries
}

/** Toggles whether a judge is included in the global cascade tiers. */
export function toggleDecisionTierMembership(
  tiers: readonly string[],
  name: string,
  included: boolean,
): string[] {
  const has = tiers.includes(name)
  if (included) {
    return has ? [...tiers] : [...tiers, name]
  }
  return has ? tiers.filter((item) => item !== name) : [...tiers]
}

export const DECISION_ROUTE_GLOBAL_VALUE = '__global__'
export const DECISION_ROUTE_CUSTOM_VALUE = '__custom__'
export const DECISION_ROUTE_SINGLE_PREFIX = 'judge:'

/** Encodes a point's route array into a compact Select value (`__global__`, `judge:<name>`, or `__custom__`). */
export function decisionRouteSelectValue(
  route: readonly string[] | undefined,
  configuredJudges: Readonly<Record<string, unknown>>,
): string {
  if (!route || route.length === 0) return DECISION_ROUTE_GLOBAL_VALUE
  if (
    route.length === 1 &&
    Object.prototype.hasOwnProperty.call(configuredJudges, route[0]!)
  ) {
    return `${DECISION_ROUTE_SINGLE_PREFIX}${route[0]!}`
  }
  return DECISION_ROUTE_CUSTOM_VALUE
}

/** Formats a readable summary for a point's custom route cascade. */
export function formatDecisionRouteSummary(route: readonly string[] | undefined): string {
  if (!route || route.length === 0) return '跟随全局级联'
  return route.join(' → ')
}

/** Moves one cascade tier by `delta` positions; out-of-range moves are no-ops. */
export function moveDecisionTier(tiers: readonly string[], name: string, delta: number): string[] {
  const index = tiers.indexOf(name)
  const target = index + delta
  if (index < 0 || target < 0 || target >= tiers.length) return [...tiers]
  const next = [...tiers]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved!)
  return next
}

export interface DecisionJudgeDraft {
  type: JudgeType
  providerId?: string
  model: string
  baseUrl: string
  path: string
  credentialId: string
  thinking: '' | JudgeThinking
  timeoutMs: string
}

/** Editable text draft of one judge; empty strings mean "leave the field unset". */
export function judgeDraftOf(config: JudgeConfig): DecisionJudgeDraft {
  return {
    type: config.type,
    ...(config.providerId ? { providerId: config.providerId } : {}),
    model: config.model ?? '',
    baseUrl: config.baseUrl ?? '',
    path: config.path ?? '',
    credentialId: config.credentialId ?? '',
    thinking: config.thinking ?? '',
    timeoutMs: config.timeoutMs === undefined ? '' : String(config.timeoutMs),
  }
}

/**
 * Builds the judge config from a draft. Optional fields are omitted when blank
 * so a cleared field is removed instead of writing an invalid empty string.
 */
export function judgeConfigFromDraft(draft: DecisionJudgeDraft): JudgeConfig {
  const timeoutMs = draft.timeoutMs.trim() === '' ? undefined : Number(draft.timeoutMs)
  const providerId = draft.providerId?.trim()
  const isProviderLlm = Boolean(providerId && draft.type === 'llm')
  return {
    type: draft.type,
    ...(providerId ? { providerId } : {}),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(!isProviderLlm && draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
    ...(draft.type === 'http' && draft.path.trim() ? { path: draft.path.trim() } : {}),
    ...(!isProviderLlm && draft.credentialId.trim()
      ? { credentialId: draft.credentialId.trim() }
      : {}),
    ...(draft.type === 'llm' && draft.thinking ? { thinking: draft.thinking } : {}),
    ...(timeoutMs !== undefined && Number.isInteger(timeoutMs) && timeoutMs >= 1
      ? { timeoutMs }
      : {}),
  }
}

/** True when the draft can be written: valid timeout, required URL for http, and a usable judge name. */
export function isJudgeDraftValid(name: string, draft: DecisionJudgeDraft): boolean {
  if (!name.trim()) return false
  if (draft.type === 'http' && !draft.baseUrl.trim()) return false
  if (draft.timeoutMs.trim() === '') return true
  const timeoutMs = Number(draft.timeoutMs)
  return Number.isInteger(timeoutMs) && timeoutMs >= 1
}

/** Parses a comma / whitespace separated route list into judge names. */
export function parseDecisionRoute(value: string): string[] {
  return value
    .split(/[,，\s]+/u)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

export const DECISION_RECORD_STATE_PRIVACY_HINT =
  '默认只写入状态摘要（SHA-256）。开启后会额外保存脱敏后的决策状态与问题原文，用于复盘判定依据；内容仍可能包含业务上下文，请按需开启。'

const DECISION_ERROR_MESSAGES: Partial<Record<string, string>> = {
  CONFIG_LAYER_READONLY: '该配置层为只读，无法写入。',
  CONFIG_VERSION_CONFLICT: '配置已被其他客户端修改，已刷新，请重试。',
  CONFIG_VALIDATION_ERROR: '决策配置无效，请检查 Judge 与级联设置。',
  CONFIG_PATH_NOT_FOUND: '目标配置文件不存在。',
  CONFIG_PROJECT_UNTRUSTED: '当前工作区未受信任，无法写入项目配置。',
  CONFIG_PROFILE_INVALID: '活动 Profile 配置无效。',
  CONFIG_PROFILE_NOT_FOUND: '找不到所选 Profile。',
  CREDENTIAL_STORE_UNAVAILABLE: '加密凭据库当前不可用，无法保存 API Key。',
  CREDENTIAL_NOT_FOUND: '未找到对应的已保存凭据。',
  OPERATION_ID_CONFLICT: '操作标识冲突，请重试。',
  THREAD_NOT_FOUND: '会话不存在或已被删除。',
}

function decisionErrorCodeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const value = error as { code?: unknown; errorCode?: unknown; data?: { code?: unknown } }
  const code =
    typeof value.errorCode === 'string'
      ? value.errorCode
      : typeof value.code === 'string'
        ? value.code
        : typeof value.data?.code === 'string'
          ? value.data.code
          : null
  return code
}

/** User-facing message for a decision RPC failure; never echoes raw payloads. */
export function decisionErrorMessage(error: unknown, fallback: string): string {
  const code = decisionErrorCodeOf(error)
  if (code && DECISION_ERROR_MESSAGES[code]) return DECISION_ERROR_MESSAGES[code]
  const message = error instanceof Error ? error.message : ''
  return message || fallback
}

/** True when a failed write should trigger a config reload before retrying. */
export function isDecisionVersionConflict(error: unknown): boolean {
  return decisionErrorCodeOf(error) === 'CONFIG_VERSION_CONFLICT'
}

/** Compact probe status line: connectivity plus latency or sanitized error kind. */
export function decisionProbeLabel(outcome: DecisionProbeOutcome): string {
  if (outcome.ok) return `连通正常 · ${outcome.latencyMs}ms`
  const kind = outcome.errorKind ? JUDGE_ERROR_KIND_LABELS[outcome.errorKind] : '探测失败'
  const status = outcome.httpStatus ? ` (HTTP ${outcome.httpStatus})` : ''
  return `${kind}${status} · ${outcome.latencyMs}ms`
}

/** Optional sanitized failure detail (endpoint + upstream reason) shown beneath a failed probe. */
export function decisionProbeDetail(outcome: DecisionProbeOutcome): string | null {
  if (outcome.ok) return null
  const parts = [outcome.endpoint?.trim(), outcome.errorMessage?.trim()].filter(
    (part): part is string => Boolean(part),
  )
  return parts.length > 0 ? parts.join(' — ') : null
}

/** Masked API key summary (e.g. `••••1234`) saved for a custom judge, or null when unset. */
export function decisionJudgeApiKeyMasked(
  view: Pick<DecisionConfigView, 'effectiveProviders'>,
  judgeName: string,
): string | null {
  return view.effectiveProviders.find((item) => item.name === judgeName)?.apiKeyMasked ?? null
}

const CLASSIFIER_NATIVE_APIS = new Set([
  'typesafe-system-one',
  'cloudflare-workers-ai-system-one',
  'llama-cpp-classify',
])

const NON_CHAT_MODEL_TYPES = new Set(['embedding', 'rerank', 'classifier', 'decision'])

const DECISION_ONLY_MODEL_PATTERN = /(?:^|[-_:/])(decision|systemone|jev|clm)(?:$|[-_:/])/i

export interface DecisionModelMetadataLike {
  name?: string
  structuredOutput?: boolean
  modelType?: string
  nativeApi?: string
}

export interface DecisionProviderOptionLike<TPreset extends { id: string } = { id: string }> {
  providerID: string
  displayName: string
  modelPresets: TPreset[]
  apiKeyConfigured?: boolean
  modelMetadata?: Record<string, DecisionModelMetadataLike>
}

/** True when a provider model is a standard chat model usable via the conversation LLM protocol. */
export function isChatModelForDecision(
  modelID: string,
  metadata?: DecisionModelMetadataLike,
): boolean {
  if (metadata?.modelType && NON_CHAT_MODEL_TYPES.has(metadata.modelType)) return false
  if (metadata?.nativeApi && CLASSIFIER_NATIVE_APIS.has(metadata.nativeApi)) return false
  if (DECISION_ONLY_MODEL_PATTERN.test(modelID)) return false
  return true
}

/** True when a configured provider's chat model explicitly advertises structured output. */
export function isStructuredChatModel(
  modelID: string,
  metadata?: DecisionModelMetadataLike,
): boolean {
  return isChatModelForDecision(modelID, metadata) && Boolean(metadata?.structuredOutput)
}

/**
 * Filters configured providers and their models for the conversation-LLM Judge picker.
 * Unconfigured providers and non-chat models are excluded; when `showAll` is false only
 * models advertising `structuredOutput` remain.
 */
export function filterDecisionProviderOptions<
  TPreset extends { id: string },
  TOption extends DecisionProviderOptionLike<TPreset>,
>(options: readonly TOption[], showAll: boolean): TOption[] {
  const result: TOption[] = []
  for (const provider of options) {
    if (provider.apiKeyConfigured === false) continue
    const presets = provider.modelPresets.filter((preset) =>
      showAll
        ? isChatModelForDecision(preset.id, provider.modelMetadata?.[preset.id])
        : isStructuredChatModel(preset.id, provider.modelMetadata?.[preset.id]),
    )
    if (presets.length === 0) continue
    result.push({ ...provider, modelPresets: presets })
  }
  return result
}

/** Generates a unique readable Judge name for a provider model. */
export function nextDecisionJudgeName(
  existingJudges: Readonly<Record<string, unknown>>,
  providerID: string,
  modelID: string,
): string {
  const base = `${providerID}:${modelID}`.replace(/\s+/g, '-')
  if (!Object.prototype.hasOwnProperty.call(existingJudges, base)) return base
  let suffix = 2
  while (Object.prototype.hasOwnProperty.call(existingJudges, `${base}-${suffix}`)) {
    suffix += 1
  }
  return `${base}-${suffix}`
}