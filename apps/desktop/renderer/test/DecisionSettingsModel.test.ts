import { describe, expect, test } from 'bun:test'
import type { DecisionConfig, DecisionPointManifest } from '@pidex/shared/decision'
import {
  DECISION_ROUTE_CUSTOM_VALUE,
  DECISION_ROUTE_GLOBAL_VALUE,
  DECISION_ROUTE_SINGLE_PREFIX,
  buildDecisionGroupModePatches,
  customJudgeFieldHints,
  decisionGroupModeCounts,
  decisionGroupModeOf,
  decisionGroupStatusSummary,
  decisionJudgeApiKeyMasked,
  decisionModeOf,
  decisionProbeDetail,
  decisionProbeLabel,
  decisionRouteSelectValue,
  filterDecisionProviderOptions,
  formatDecisionRouteSummary,
  groupDecisionManifest,
  isJudgeDraftValid,
  isStructuredChatModel,
  judgeConfigFromDraft,
  judgeDraftOf,
  moveDecisionTier,
  nextDecisionJudgeName,
  orderJudgesByCascade,
  parseDecisionRoute,
  toggleDecisionTierMembership,
} from '../src/features/settings/DecisionSettingsModel.js'

const baseConfig: DecisionConfig = {
  tiers: ['fast', 'strong'],
  judges: {
    fast: { type: 'classifier' },
    strong: { type: 'openai', model: 'gpt-5-mini', timeoutMs: 8_000 },
  },
  modes: { 'input.injection': 'active' },
  routes: {},
  features: {},
  recordState: false,
}

function point(overrides: Partial<DecisionPointManifest>): DecisionPointManifest {
  return {
    id: 'input.injection',
    group: 'input',
    title: 'Injection screening',
    titleZh: '注入筛查',
    summary: 'Screens external content',
    summaryZh: '筛查外部注入内容',
    defaultMode: 'off',
    feature: 'decision.input',
    ...overrides,
  }
}

describe('decision settings model', () => {
  test('groups the manifest into the fixed group order and drops empty groups', () => {
    const groups = groupDecisionManifest([
      point({ id: 'teamwork.review', group: 'teamwork' }),
      point({ id: 'input.injection', group: 'input' }),
      point({ id: 'safety.tool', group: 'safety' }),
    ])
    expect(groups.map((section) => section.group)).toEqual(['input', 'safety', 'teamwork'])
  })

  test('resolves the effective mode from config first and manifest default second', () => {
    expect(decisionModeOf(baseConfig, point({}))).toBe('active')
    expect(decisionModeOf(baseConfig, point({ id: 'turn.followup', defaultMode: 'shadow' }))).toBe(
      'shadow',
    )
  })

  test('moves cascade tiers and ignores out-of-range moves', () => {
    expect(moveDecisionTier(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b'])
    expect(moveDecisionTier(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
    expect(moveDecisionTier(['a', 'b'], 'missing', 1)).toEqual(['a', 'b'])
  })

  test('round-trips judge drafts and omits cleared optional fields', () => {
    const draft = judgeDraftOf(baseConfig.judges.strong!)
    expect(judgeConfigFromDraft(draft)).toEqual(baseConfig.judges.strong)
    const cleared = { ...draft, model: '', timeoutMs: '' }
    expect(judgeConfigFromDraft(cleared)).toEqual({ type: 'openai' })
  })

  test('rejects invalid judge names and timeouts', () => {
    const draft = judgeDraftOf(baseConfig.judges.fast!)
    expect(isJudgeDraftValid('fast', draft)).toBe(true)
    expect(isJudgeDraftValid(' ', draft)).toBe(false)
    expect(isJudgeDraftValid('fast', { ...draft, timeoutMs: '0' })).toBe(false)
    expect(isJudgeDraftValid('fast', { ...draft, timeoutMs: '1.5' })).toBe(false)
    expect(isJudgeDraftValid('fast', { ...draft, timeoutMs: 'abc' })).toBe(false)
  })

  test('parses comma and whitespace separated routes', () => {
    expect(parseDecisionRoute(' fast, strong ，local ')).toEqual(['fast', 'strong', 'local'])
    expect(parseDecisionRoute('  ')).toEqual([])
  })

  test('formats probe outcomes without raw provider details', () => {
    expect(decisionProbeLabel({ ok: true, providerId: 'openai', latencyMs: 42 })).toBe(
      '连通正常 · 42ms',
    )
    expect(
      decisionProbeLabel({
        ok: false,
        providerId: 'openai',
        latencyMs: 5_000,
        errorKind: 'timeout',
      }),
    ).toBe('请求超时 · 5000ms')
  })

  test('filters configured provider models to structured-output chat models by default', () => {
    const options = [
      {
        providerID: 'qwen',
        displayName: 'Qwen',
        apiKeyConfigured: true,
        modelPresets: [
          { id: 'qwen-plus' },
          { id: 'decision-model-preview' },
          { id: 'text-embedding-v3' },
          { id: 'qwen-plain' },
        ],
        modelMetadata: {
          'qwen-plus': { structuredOutput: true },
          'text-embedding-v3': { modelType: 'embedding' },
          'qwen-plain': { structuredOutput: false },
        },
      },
      {
        providerID: 'unconfigured',
        displayName: 'Unconfigured',
        apiKeyConfigured: false,
        modelPresets: [{ id: 'gpt-5-mini' }],
        modelMetadata: { 'gpt-5-mini': { structuredOutput: true } },
      },
    ]

    expect(isStructuredChatModel('qwen-plus', { structuredOutput: true })).toBe(true)
    expect(isStructuredChatModel('decision-model-preview', { structuredOutput: true })).toBe(false)
    expect(isStructuredChatModel('text-embedding-v3', { modelType: 'embedding' })).toBe(false)

    expect(filterDecisionProviderOptions(options, false)).toEqual([
      {
        providerID: 'qwen',
        displayName: 'Qwen',
        apiKeyConfigured: true,
        modelPresets: [{ id: 'qwen-plus' }],
        modelMetadata: options[0]!.modelMetadata,
      },
    ])

    expect(filterDecisionProviderOptions(options, true)[0]?.modelPresets.map((m) => m.id)).toEqual([
      'qwen-plus',
      'qwen-plain',
    ])
  })

  test('resolves custom judge hints, masked API key lookup, and provider LLM field stripping', () => {
    expect(customJudgeFieldHints('systemone').model).toContain('decision-model-preview')
    expect(customJudgeFieldHints('openai').model).toContain('gpt-6-luna')
    expect(
      isJudgeDraftValid('custom-http', {
        ...judgeDraftOf({ type: 'http' }),
        baseUrl: '',
      }),
    ).toBe(false)
    expect(
      isJudgeDraftValid('custom-http', {
        ...judgeDraftOf({ type: 'http', baseUrl: 'http://127.0.0.1:8700' }),
      }),
    ).toBe(true)

    expect(nextDecisionJudgeName({ 'qwen:qwen-plus': {} }, 'qwen', 'qwen-plus')).toBe(
      'qwen:qwen-plus-2',
    )

    const providerLlmDraft = {
      ...judgeDraftOf({
        type: 'llm',
        providerId: 'qwen',
        model: 'qwen-plus',
      }),
      baseUrl: 'https://ignored.example.com',
      credentialId: 'cred_ignored',
    }
    expect(judgeConfigFromDraft(providerLlmDraft)).toEqual({
      type: 'llm',
      providerId: 'qwen',
      model: 'qwen-plus',
    })

    expect(
      decisionJudgeApiKeyMasked(
        {
          effectiveProviders: [
            {
              name: 'qwen-decision',
              type: 'systemone',
              providerId: 'systemone',
              apiKeyMasked: '••••9876',
            },
          ],
        },
        'qwen-decision',
      ),
    ).toBe('••••9876')
    expect(decisionJudgeApiKeyMasked({ effectiveProviders: [] }, 'missing')).toBeNull()
  })

  test('formats probe HTTP status and diagnostic detail on failure', () => {
    const failed = {
      ok: false,
      providerId: 'magpie:systemone',
      latencyMs: 126,
      errorKind: 'bad_request' as const,
      httpStatus: 400,
      endpoint: 'http://127.0.0.1:3425/v1/systemone',
      errorMessage: 'Route unsupported',
    }
    expect(decisionProbeLabel(failed)).toBe('请求无效 (HTTP 400) · 126ms')
    expect(decisionProbeDetail(failed)).toBe(
      'http://127.0.0.1:3425/v1/systemone — Route unsupported',
    )
    expect(
      decisionProbeDetail({ ok: true, providerId: 'magpie:systemone', latencyMs: 42 }),
    ).toBeNull()
  })

  test('computes group-level mode, custom mixed state, status summary, and batch mode patches', () => {
    const points = [
      point({ id: 'input.preflight', defaultMode: 'shadow' }),
      point({ id: 'input.framing', defaultMode: 'shadow' }),
      point({ id: 'input.interrupt', defaultMode: 'shadow' }),
    ]
    const uniformConfig: DecisionConfig = {
      ...baseConfig,
      modes: {},
      routes: {},
    }
    expect(decisionGroupModeOf(uniformConfig, points)).toBe('shadow')
    expect(decisionGroupStatusSummary(uniformConfig, points)).toBe('3 项')

    const mixedConfig: DecisionConfig = {
      ...baseConfig,
      modes: {
        'input.preflight': 'active',
        'input.interrupt': 'off',
      },
      routes: {
        'input.preflight': ['strong'],
      },
    }
    expect(decisionGroupModeOf(mixedConfig, points)).toBe('custom')
    expect(decisionGroupModeCounts(mixedConfig, points)).toEqual({
      active: 1,
      shadow: 1,
      off: 1,
      customRouteCount: 1,
    })
    expect(decisionGroupStatusSummary(mixedConfig, points)).toBe(
      '3 项 · 1 生效 / 1 影子 / 1 关闭 · 1 项独立路由',
    )

    expect(buildDecisionGroupModePatches(points, 'active')).toEqual([
      { keyPath: ['modes', 'input.preflight'], value: 'active' },
      { keyPath: ['modes', 'input.framing'], value: 'active' },
      { keyPath: ['modes', 'input.interrupt'], value: 'active' },
    ])
  })

  test('orders judges by cascade tiers first and toggles cascade membership', () => {
    const configWithExtra: DecisionConfig = {
      ...baseConfig,
      tiers: ['strong'],
      judges: {
        fast: { type: 'classifier' },
        strong: { type: 'openai', model: 'gpt-5-mini' },
        backup: { type: 'systemone', model: 'clm-latest' },
      },
    }
    expect(
      orderJudgesByCascade(configWithExtra).map((item) => ({
        name: item.name,
        tierIndex: item.tierIndex,
      })),
    ).toEqual([
      { name: 'strong', tierIndex: 0 },
      { name: 'fast', tierIndex: null },
      { name: 'backup', tierIndex: null },
    ])

    expect(toggleDecisionTierMembership(['strong'], 'fast', true)).toEqual(['strong', 'fast'])
    expect(toggleDecisionTierMembership(['strong', 'fast'], 'strong', false)).toEqual(['fast'])
  })

  test('encodes and formats single-point route selection values', () => {
    const judges = { fast: {}, strong: {} }
    expect(decisionRouteSelectValue(undefined, judges)).toBe(DECISION_ROUTE_GLOBAL_VALUE)
    expect(decisionRouteSelectValue([], judges)).toBe(DECISION_ROUTE_GLOBAL_VALUE)
    expect(decisionRouteSelectValue(['fast'], judges)).toBe(`${DECISION_ROUTE_SINGLE_PREFIX}fast`)
    expect(decisionRouteSelectValue(['fast', 'strong'], judges)).toBe(DECISION_ROUTE_CUSTOM_VALUE)
    expect(decisionRouteSelectValue(['unknown'], judges)).toBe(DECISION_ROUTE_CUSTOM_VALUE)

    expect(formatDecisionRouteSummary([])).toBe('跟随全局级联')
    expect(formatDecisionRouteSummary(['fast', 'strong'])).toBe('fast → strong')
  })
})
