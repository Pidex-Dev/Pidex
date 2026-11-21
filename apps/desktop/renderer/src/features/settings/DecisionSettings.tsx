import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Scale,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react'
import type {
  DecisionConfig,
  DecisionGroup,
  DecisionMode,
  DecisionPointManifest,
  JudgeConfig,
} from '@pidex/shared/decision'
import type { DesktopModelProviderSummary, ModelProviderID } from '../../../shared/Types.js'
import { buildModelPresets } from '../../ModelPresets.js'
import { Button } from '../../components/ui/Button.js'
import { Input } from '../../components/ui/Input.js'
import { SegmentedControl } from '../../components/ui/SegmentedControl.js'
import { Select } from '../../components/ui/Select.js'
import { ToggleSwitch } from '../../components/ui/ToggleSwitch.js'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from '../../components/ui/IconTokens.js'
import { useMountEffect } from '../../hooks/UseMountEffect.js'
import { useWindowEvent } from '../../hooks/UseExternalSubscription.js'
import { CONFIG_UPDATED_EVENT, desktopClient } from '../../services/desktop-client/index.js'
import {
  ModelPickerPopover,
  type ProviderModelOption,
} from '../session/composer/ModelPickerPopover.js'
import { SettingsContentArea } from './SettingsContentArea.js'
import { SettingsRow } from './SettingsRow.js'
import { SettingsSection } from './SettingsSection.js'
import {
  CUSTOM_DECISION_JUDGE_TYPES,
  DECISION_GROUP_CUSTOM_MODE_DESCRIPTION,
  DECISION_GROUP_CUSTOM_MODE_LABEL,
  DECISION_MODE_DESCRIPTIONS,
  DECISION_MODE_LABELS,
  DECISION_RECORD_STATE_PRIVACY_HINT,
  DECISION_ROUTE_CUSTOM_VALUE,
  DECISION_ROUTE_GLOBAL_VALUE,
  DECISION_ROUTE_SINGLE_PREFIX,
  JUDGE_THINKING_OPTIONS,
  JUDGE_TYPE_LABELS,
  buildDecisionGroupModePatches,
  customJudgeFieldHints,
  decisionErrorMessage,
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
  isDecisionVersionConflict,
  isJudgeDraftValid,
  judgeConfigFromDraft,
  judgeDraftOf,
  moveDecisionTier,
  nextDecisionJudgeName,
  orderJudgesByCascade,
  toggleDecisionTierMembership,
  type CustomDecisionJudgeType,
  type DecisionConfigPatch,
  type DecisionConfigScope,
  type DecisionConfigView,
  type DecisionGroupModeValue,
  type DecisionJudgeDraft,
  type DecisionProbeOutcome,
} from './DecisionSettingsModel.js'

type Props = {
  workspacePath?: string | null
  onOpenJudgePanel?: () => void
  onError?: (message: string) => void
  onNotice?: (message: string) => void
}

const MODE_OPTIONS = (['off', 'shadow', 'active'] as const).map((mode) => ({
  value: mode,
  label: DECISION_MODE_LABELS[mode],
  tooltip: DECISION_MODE_DESCRIPTIONS[mode],
}))

const SCOPE_OPTIONS: ReadonlyArray<{ value: DecisionConfigScope; label: string }> = [
  { value: 'user', label: '用户配置' },
  { value: 'profile', label: '活动 Profile' },
  { value: 'project', label: '项目配置' },
]

const CUSTOM_JUDGE_TYPE_OPTIONS = CUSTOM_DECISION_JUDGE_TYPES.map((type) => ({
  value: type,
  label: JUDGE_TYPE_LABELS[type],
}))

type AddJudgeTab = 'custom' | 'provider'

const ADD_JUDGE_TAB_OPTIONS: ReadonlyArray<{ value: AddJudgeTab; label: string }> = [
  { value: 'custom', label: '自定义独立端点' },
  { value: 'provider', label: '已配置供应商模型' },
]

const THINKING_OPTIONS = [
  { value: '', label: '默认' },
  ...JUDGE_THINKING_OPTIONS.map((value) => ({ value, label: value })),
]

type SaveJudgeOptions = {
  apiKey?: string
  clearApiKey?: boolean
  joinCascade?: boolean
}

function syncEffectiveProviders(
  current: DecisionConfigView['effectiveProviders'],
  config: DecisionConfig,
  overrides: Readonly<Record<string, string | null>> = {},
): DecisionConfigView['effectiveProviders'] {
  const previousByName = new Map(current.map((item) => [item.name, item]))
  return Object.entries(config.judges).map(([name, judge]) => {
    const override = Object.prototype.hasOwnProperty.call(overrides, name)
      ? overrides[name]
      : undefined
    const apiKeyMasked =
      override !== undefined
        ? (override ?? undefined)
        : judge.credentialId
          ? previousByName.get(name)?.apiKeyMasked
          : undefined
    return {
      name,
      type: judge.type,
      providerId: judge.providerId ?? judge.type,
      ...(judge.model ? { modelId: judge.model } : {}),
      ...(apiKeyMasked ? { apiKeyMasked } : {}),
    }
  })
}

export function DecisionSettings({
  workspacePath,
  onOpenJudgePanel,
  onError,
  onNotice,
}: Props): React.ReactNode {
  const supported = useMemo(() => desktopClient.supportsDecisionEngine(), [])
  const navigate = useNavigate()
  const cwd = workspacePath?.trim() || undefined
  const [view, setView] = useState<DecisionConfigView | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [scope, setScope] = useState<DecisionConfigScope>('user')
  const [busy, setBusy] = useState(false)
  const [probes, setProbes] = useState<Readonly<Record<string, DecisionProbeOutcome>>>({})
  const [probing, setProbing] = useState<ReadonlySet<string>>(() => new Set())
  const [providers, setProviders] = useState<DesktopModelProviderSummary[]>([])
  const mountedRef = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    if (!desktopClient.supportsDecisionEngine()) return
    setLoading(true)
    setLoadError('')
    try {
      const [result, providerList] = await Promise.all([
        desktopClient.getDecisionConfig(cwd ?? null),
        desktopClient.listModelProviders().catch(() => [] as DesktopModelProviderSummary[]),
      ])
      if (!mountedRef.current) return
      setView(result)
      setProviders(providerList)

      const configured = providerList.filter((provider) => provider.apiKeyConfigured)
      if (configured.length > 0) {
        const fetched = await Promise.allSettled(
          configured.map(async (provider) => ({
            providerID: provider.providerID,
            catalog: await desktopClient.fetchProviderModels({
              providerID: provider.providerID as ModelProviderID,
              all: true,
            }),
          })),
        )
        if (!mountedRef.current) return
        const byId = new Map(
          fetched.flatMap((entry) =>
            entry.status === 'fulfilled' ? [[entry.value.providerID, entry.value.catalog]] : [],
          ),
        )
        if (byId.size > 0) {
          setProviders((current) =>
            current.map((provider) => {
              const catalog = byId.get(provider.providerID)
              if (!catalog) return provider
              return {
                ...provider,
                defaultModels: catalog.models,
                modelMetadata: { ...provider.modelMetadata, ...catalog.modelMetadata },
              }
            }),
          )
        }
      }
    } catch (error) {
      if (!mountedRef.current) return
      setView(null)
      setLoadError(decisionErrorMessage(error, '无法读取决策配置。'))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [cwd])

  useMountEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
    }
  })

  useWindowEvent(typeof window === 'undefined' ? null : window, CONFIG_UPDATED_EVENT, () => {
    void load()
  })

  const applyPatch = useCallback(
    async (
      patch: readonly DecisionConfigPatch[],
      maskedOverrides: Readonly<Record<string, string | null>> = {},
    ): Promise<boolean> => {
      if (busy) return false
      setBusy(true)
      setActionError('')
      try {
        const result = await desktopClient.updateDecisionConfig({
          scope,
          ...(scope === 'project' && cwd ? { cwd } : {}),
          patch: [...patch],
          ...(version ? { expectedVersion: version } : {}),
        })
        if (!mountedRef.current) return false
        setVersion(result.version)
        setView((current) =>
          current
            ? {
                ...current,
                config: result.config,
                effectiveProviders: syncEffectiveProviders(
                  current.effectiveProviders,
                  result.config,
                  maskedOverrides,
                ),
              }
            : current,
        )
        onNotice?.('决策配置已保存。')
        return true
      } catch (error) {
        if (!mountedRef.current) return false
        setActionError(decisionErrorMessage(error, '决策配置保存失败。'))
        if (isDecisionVersionConflict(error)) void load()
        return false
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    },
    [busy, cwd, load, onNotice, scope, version],
  )

  const saveJudge = useCallback(
    async (name: string, judge: JudgeConfig, options: SaveJudgeOptions = {}): Promise<boolean> => {
      if (busy || !view) return false
      const trimmedKey = options.apiKey?.trim() ?? ''
      const isNewJudge = !Object.prototype.hasOwnProperty.call(view.config.judges, name)
      setBusy(true)
      setActionError('')
      let createdNewCredential = false
      try {
        let nextJudge: JudgeConfig = { ...judge }
        const maskedOverrides: Record<string, string | null> = {}
        if (trimmedKey) {
          const savedKey = await desktopClient.setDecisionJudgeApiKey({
            judgeName: name,
            apiKey: trimmedKey,
          })
          createdNewCredential = isNewJudge
          nextJudge = {
            ...nextJudge,
            ...(savedKey.credentialId ? { credentialId: savedKey.credentialId } : {}),
          }
          maskedOverrides[name] = savedKey.apiKeyMasked
        } else if (options.clearApiKey) {
          await desktopClient.setDecisionJudgeApiKey({
            judgeName: name,
            apiKey: null,
          })
          const { credentialId: _removed, ...rest } = nextJudge
          nextJudge = rest
          maskedOverrides[name] = null
        }

        const patch: DecisionConfigPatch[] = [{ keyPath: ['judges', name], value: nextJudge }]
        if (options.joinCascade) {
          patch.push({
            keyPath: ['tiers'],
            value: view.config.tiers.includes(name)
              ? view.config.tiers
              : [...view.config.tiers, name],
          })
        }

        const result = await desktopClient.updateDecisionConfig({
          scope,
          ...(scope === 'project' && cwd ? { cwd } : {}),
          patch,
          ...(version ? { expectedVersion: version } : {}),
        })
        if (!mountedRef.current) return false
        setVersion(result.version)
        setView((current) =>
          current
            ? {
                ...current,
                config: result.config,
                effectiveProviders: syncEffectiveProviders(
                  current.effectiveProviders,
                  result.config,
                  maskedOverrides,
                ),
              }
            : current,
        )
        onNotice?.('决策配置已保存。')
        return true
      } catch (error) {
        if (createdNewCredential) {
          await desktopClient
            .setDecisionJudgeApiKey({ judgeName: name, apiKey: null })
            .catch(() => undefined)
        }
        if (!mountedRef.current) return false
        setActionError(decisionErrorMessage(error, '决策配置保存失败。'))
        if (isDecisionVersionConflict(error)) void load()
        return false
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    },
    [busy, cwd, load, onNotice, scope, version, view],
  )

  const probeJudge = useCallback(
    async (judgeName: string): Promise<void> => {
      if (probing.has(judgeName)) return
      setProbing((current) => new Set(current).add(judgeName))
      try {
        const outcome = await desktopClient.probeDecisionJudge({
          judgeName,
          ...(cwd ? { cwd } : {}),
        })
        if (!mountedRef.current) return
        setProbes((current) => ({ ...current, [judgeName]: outcome }))
      } catch (error) {
        if (!mountedRef.current) return
        onError?.(decisionErrorMessage(error, 'Judge 连通性探测失败。'))
      } finally {
        if (mountedRef.current) {
          setProbing((current) => {
            const next = new Set(current)
            next.delete(judgeName)
            return next
          })
        }
      }
    },
    [cwd, onError, probing],
  )

  if (!supported) {
    return (
      <SettingsContentArea>
        <div className="settings-content-inner tw:grid tw:gap-5 tw:w-full tw:min-w-0 tw:mx-auto tw:p-5 tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-6)*2)]">
          <header className="tw:grid tw:gap-2">
            <h1 className="tw:m-0 tw:type-6 tw:weight-bold tw:text-app-text">决策</h1>
            <p className="tw:m-0 tw:type-1 tw:text-app-text-soft">
              当前 Agent 运行时未声明 decision.engine.v1，决策引擎不可用。
            </p>
          </header>
          <SettingsRow
            title="决策引擎不可用"
            description="请升级 Agent 运行时后再配置 Judge 与决策点。"
            control={<span className="tw:type-1 tw:text-app-text-meta">不支持的运行时</span>}
          />
        </div>
      </SettingsContentArea>
    )
  }

  const config = view?.config ?? null
  const manifestGroups = groupDecisionManifest(view?.manifest ?? [])

  return (
    <SettingsContentArea>
      <div className="settings-content-inner tw:@container tw:grid tw:gap-6 tw:w-full tw:min-w-0 tw:mx-auto tw:p-5 tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-6)*2)]">
        <header className="tw:flex tw:items-start tw:justify-between tw:gap-4">
          <div className="tw:grid tw:gap-1">
            <h1 className="tw:m-0 tw:type-6 tw:weight-bold tw:text-app-text">决策</h1>
            <p className="tw:m-0 tw:type-1 tw:text-app-text-soft">
              配置 Judge 级联与各决策点的运行模式；影子模式只记录不生效。
            </p>
          </div>
          <div className="tw:flex tw:shrink-0 tw:items-center tw:gap-2">
            <Select
              ariaLabel="配置层"
              size="sm"
              value={scope}
              options={SCOPE_OPTIONS.filter((option) => option.value !== 'project' || Boolean(cwd))}
              onValueChange={(value) => setScope(value as DecisionConfigScope)}
            />
            <Button
              isIconOnly
              color="ghostSecondary"
              size="toolbar"
              type="button"
              disabled={loading}
              title="刷新"
              aria-label="刷新"
              onClick={() => void load()}
            >
              <RefreshCw
                aria-hidden="true"
                size={APP_ICON_SIZE}
                strokeWidth={APP_ICON_STROKE_WIDTH}
                className={`tw:size-icon-md ${loading ? 'tw:animate-spin' : ''}`}
              />
            </Button>
          </div>
        </header>

        {loadError ? (
          <div
            className="tw:rounded-container tw:border tw:border-app-danger-border tw:bg-app-danger-subtle tw:px-4 tw:py-3 tw:type-1 tw:text-app-danger"
            role="alert"
          >
            {loadError}
          </div>
        ) : null}
        {actionError ? (
          <div
            className="tw:rounded-container tw:border tw:border-app-danger-border tw:bg-app-danger-subtle tw:px-4 tw:py-3 tw:type-1 tw:text-app-danger"
            role="alert"
          >
            {actionError}
          </div>
        ) : null}

        {!view && !loadError ? (
          <div className="tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:px-4 tw:py-4 tw:type-1 tw:text-app-text-soft">
            正在读取决策配置…
          </div>
        ) : null}

        {config ? (
          <>
            <JudgesAndCascadeSection
              view={view!}
              providers={providers}
              busy={busy}
              probes={probes}
              probing={probing}
              onTiersChange={(tiers) => void applyPatch([{ keyPath: ['tiers'], value: tiers }])}
              onProbe={(name) => void probeJudge(name)}
              onSaveJudge={saveJudge}
              onRemoveJudge={(name) =>
                void applyPatch([
                  { keyPath: ['judges', name], value: null },
                  { keyPath: ['tiers'], value: config.tiers.filter((tier) => tier !== name) },
                ])
              }
              onOpenModelSettings={() => navigate('/settings/models')}
            />
            <DecisionPointsSection
              config={config}
              manifestGroups={manifestGroups}
              busy={busy}
              onGroupModeChange={(points, mode) =>
                void applyPatch(buildDecisionGroupModePatches(points, mode))
              }
              onModeChange={(specId, mode) =>
                void applyPatch([{ keyPath: ['modes', specId], value: mode }])
              }
              onRouteChange={(specId, route) =>
                void applyPatch([
                  { keyPath: ['routes', specId], value: route.length > 0 ? route : null },
                ])
              }
            />
            <SettingsSection
              title="决策面板"
              description="在会话工作台的 Judge 面板中实时查看判定记录、概率分布与审批对照，并进行纠偏。"
            >
              <SettingsRow
                title="Judge 面板"
                description="打开右侧工作台的 Judge 标签页，展示当前会话的决策账本。"
                control={
                  <Button
                    color="secondary"
                    size="sm"
                    type="button"
                    onClick={() => {
                      if (onOpenJudgePanel) {
                        onOpenJudgePanel()
                      } else {
                        navigate('/new?panel=judge')
                      }
                    }}
                  >
                    <Scale aria-hidden="true" size={14} />
                    打开面板
                  </Button>
                }
              />
            </SettingsSection>
            <SettingsSection
              title="账本记录"
              description="决策账本用于复盘 Judge 判定与实际结果的差异。"
            >
              <SettingsRow
                title="记录决策状态原文"
                description={DECISION_RECORD_STATE_PRIVACY_HINT}
                control={(aria) => (
                  <ToggleSwitch
                    ariaLabelledby={aria.labelledby}
                    ariaDescribedby={aria.describedby}
                    checked={config.recordState}
                    disabled={busy}
                    onChange={(checked) =>
                      void applyPatch([{ keyPath: ['recordState'], value: checked }])
                    }
                  />
                )}
              />
              <div className="tw:flex tw:items-start tw:gap-2 tw:px-3 tw:pb-3 tw:type-1 tw:text-app-text-meta">
                <ShieldAlert
                  aria-hidden="true"
                  size={APP_ICON_SIZE}
                  strokeWidth={APP_ICON_STROKE_WIDTH}
                  className="tw:size-icon-md tw:shrink-0"
                />
                <span>
                  API Key 仅加密保存在 Pidex 凭据库中，不会明文写入配置文件、账本或日志；删除 Judge
                  时会自动清理其专属凭据。
                </span>
              </div>
            </SettingsSection>
          </>
        ) : null}
      </div>
    </SettingsContentArea>
  )
}

function JudgesAndCascadeSection({
  view,
  providers,
  busy,
  probes,
  probing,
  onTiersChange,
  onProbe,
  onSaveJudge,
  onRemoveJudge,
  onOpenModelSettings,
}: {
  view: DecisionConfigView
  providers: readonly DesktopModelProviderSummary[]
  busy: boolean
  probes: Readonly<Record<string, DecisionProbeOutcome>>
  probing: ReadonlySet<string>
  onTiersChange: (tiers: string[]) => void
  onProbe: (name: string) => void
  onSaveJudge: (name: string, judge: JudgeConfig, options?: SaveJudgeOptions) => Promise<boolean>
  onRemoveJudge: (name: string) => void
  onOpenModelSettings: () => void
}): React.ReactNode {
  const config = view.config
  const orderedJudges = useMemo(() => orderJudgesByCascade(config), [config])
  const [expandedJudges, setExpandedJudges] = useState<ReadonlySet<string>>(() => new Set())
  const [addFormOpen, setAddFormOpen] = useState(false)
  const [addTab, setAddTab] = useState<AddJudgeTab>('custom')
  const [customName, setCustomName] = useState('')
  const [customType, setCustomType] = useState<CustomDecisionJudgeType>('systemone')
  const [customModel, setCustomModel] = useState('')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customPath, setCustomPath] = useState('')
  const [customApiKey, setCustomApiKey] = useState('')
  const [showCustomApiKey, setShowCustomApiKey] = useState(false)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [showAllModels, setShowAllModels] = useState(false)
  const [selectedModel, setSelectedModel] = useState<{
    providerID: ModelProviderID
    modelID: string
  } | null>(null)

  const allProviderOptions = useMemo<ProviderModelOption[]>(
    () =>
      providers.map((provider) => ({
        providerID: provider.providerID as ModelProviderID,
        displayName: provider.displayName,
        modelPresets: buildModelPresets(provider.defaultModels, provider.modelMetadata),
        apiKeyConfigured: provider.apiKeyConfigured,
        logoURL: provider.logoURL,
        modelMetadata: provider.modelMetadata,
      })),
    [providers],
  )
  const visibleProviderOptions = useMemo(
    () => filterDecisionProviderOptions(allProviderOptions, showAllModels),
    [allProviderOptions, showAllModels],
  )
  const selectedProvider = selectedModel
    ? providers.find((item) => item.providerID === selectedModel.providerID)
    : undefined
  const selectedLabel = selectedModel
    ? `${selectedProvider?.displayName ?? selectedModel.providerID} / ${selectedProvider?.modelMetadata?.[selectedModel.modelID]?.name || selectedModel.modelID}`
    : '选择已配置供应商的对话模型…'

  const trimmedCustomName = customName.trim()
  const customNameTaken = Boolean(trimmedCustomName && config.judges[trimmedCustomName])
  const customHints = customJudgeFieldHints(customType)
  const canAddCustom =
    trimmedCustomName.length > 0 &&
    !customNameTaken &&
    (customType !== 'http' || customBaseUrl.trim().length > 0)

  const toggleJudgeExpanded = (name: string): void => {
    setExpandedJudges((current) => {
      const next = new Set(current)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  const handleAddCustom = async (): Promise<void> => {
    if (!canAddCustom || busy) return
    const nextJudge: JudgeConfig = {
      type: customType,
      ...(customModel.trim() ? { model: customModel.trim() } : {}),
      ...(customBaseUrl.trim() ? { baseUrl: customBaseUrl.trim() } : {}),
      ...(customType === 'http' && customPath.trim() ? { path: customPath.trim() } : {}),
    }
    const ok = await onSaveJudge(trimmedCustomName, nextJudge, {
      ...(customApiKey.trim() ? { apiKey: customApiKey.trim() } : {}),
      joinCascade: true,
    })
    if (!ok) return
    setCustomName('')
    setCustomModel('')
    setCustomBaseUrl('')
    setCustomPath('')
    setCustomApiKey('')
    setShowCustomApiKey(false)
    setAddFormOpen(false)
  }

  const showAddForm = addFormOpen || orderedJudges.length === 0

  return (
    <SettingsSection
      title="Judge 与级联"
      description="按级联顺序尝试已启用的 Judge（低层弃权或不确定时自动升级到下一级）；点击单个 Judge 可展开编辑。"
      actions={
        orderedJudges.length > 0 ? (
          <Button
            color="secondary"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => setAddFormOpen((current) => !current)}
          >
            {addFormOpen ? (
              <>收起添加</>
            ) : (
              <>
                <Plus aria-hidden="true" size={14} />
                添加 Judge
              </>
            )}
          </Button>
        ) : null
      }
    >
      {orderedJudges.length === 0 ? (
        <div className="tw:px-3 tw:py-3 tw:type-1 tw:text-app-text-soft">
          尚未配置 Judge。从下方添加独立 Decision 端点或选用已配置供应商模型后，即可启用决策点。
        </div>
      ) : (
        <div className="tw:grid tw:divide-y tw:divide-app-border-subtle">
          {orderedJudges.map(({ name, tierIndex }) => (
            <JudgeEditor
              key={name}
              name={name}
              tierIndex={tierIndex}
              tierCount={config.tiers.length}
              expanded={expandedJudges.has(name)}
              onToggleExpanded={() => toggleJudgeExpanded(name)}
              config={config}
              apiKeyMasked={decisionJudgeApiKeyMasked(view, name)}
              busy={busy}
              probe={probes[name] ?? null}
              probing={probing.has(name)}
              onMoveTier={(delta) => onTiersChange(moveDecisionTier(config.tiers, name, delta))}
              onToggleTier={(included) =>
                onTiersChange(toggleDecisionTierMembership(config.tiers, name, included))
              }
              onProbe={() => onProbe(name)}
              onSave={(judge, options) => onSaveJudge(name, judge, options)}
              onRemove={() => onRemoveJudge(name)}
            />
          ))}
        </div>
      )}
      {showAddForm ? (
        <div className="tw:grid tw:gap-4 tw:border-t tw:border-app-border-subtle tw:bg-app-underlay/40 tw:px-4 tw:py-4">
          <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3">
            <SegmentedControl
              ariaLabel="添加 Judge 方式"
              semantics="tabs"
              variant="inset"
              size="sm"
              value={addTab}
              options={ADD_JUDGE_TAB_OPTIONS}
              onChange={(value) => setAddTab(value as AddJudgeTab)}
            />
            {addTab === 'provider' ? (
              <label className="tw:flex tw:cursor-pointer tw:items-center tw:gap-2 tw:type-1 tw:text-app-text-soft">
                <span>显示全部对话模型</span>
                <ToggleSwitch
                  ariaLabel="显示全部对话模型"
                  checked={showAllModels}
                  disabled={busy}
                  onChange={setShowAllModels}
                />
              </label>
            ) : null}
          </div>
          {addTab === 'custom' ? (
            <div className="tw:grid tw:gap-3">
              <div className="tw:grid tw:grid-cols-2 tw:gap-x-4 tw:gap-y-2 tw:@max-[40rem]:grid-cols-1">
                <label className="tw:grid tw:gap-1">
                  <span className="tw:type-1 tw:text-app-text-soft">名称</span>
                  <Input
                    size="sm"
                    aria-label="新 Judge 名称"
                    placeholder="如 qwen-decision 或 openai-main"
                    invalid={customNameTaken}
                    value={customName}
                    onChange={(event) => setCustomName(event.target.value)}
                  />
                </label>
                <label className="tw:grid tw:gap-1">
                  <span className="tw:type-1 tw:text-app-text-soft">协议类型</span>
                  <Select
                    ariaLabel="新 Judge 协议类型"
                    size="sm"
                    value={customType}
                    options={CUSTOM_JUDGE_TYPE_OPTIONS}
                    onValueChange={(value) => setCustomType(value as CustomDecisionJudgeType)}
                  />
                </label>
                <label className="tw:grid tw:gap-1">
                  <span className="tw:type-1 tw:text-app-text-soft">模型</span>
                  <Input
                    size="sm"
                    aria-label="新 Judge 模型"
                    placeholder={customHints.model}
                    value={customModel}
                    onChange={(event) => setCustomModel(event.target.value)}
                  />
                </label>
                <label className="tw:grid tw:gap-1">
                  <span className="tw:type-1 tw:text-app-text-soft">Base URL</span>
                  <Input
                    size="sm"
                    aria-label="新 Judge Base URL"
                    placeholder={customHints.baseUrl}
                    value={customBaseUrl}
                    onChange={(event) => setCustomBaseUrl(event.target.value)}
                  />
                </label>
                {customType === 'http' ? (
                  <label className="tw:grid tw:gap-1">
                    <span className="tw:type-1 tw:text-app-text-soft">请求路径</span>
                    <Input
                      size="sm"
                      aria-label="新 Judge 请求路径"
                      placeholder={customHints.path ?? '/v1/systemone'}
                      value={customPath}
                      onChange={(event) => setCustomPath(event.target.value)}
                    />
                  </label>
                ) : null}
                <label
                  className={`tw:grid tw:gap-1 ${customType === 'http' ? '' : 'tw:col-span-2 tw:@max-[40rem]:col-span-1'}`}
                >
                  <span className="tw:type-1 tw:text-app-text-soft">API Key</span>
                  <span className="tw:flex tw:items-center tw:gap-2">
                    <Input
                      size="sm"
                      type={showCustomApiKey ? 'text' : 'password'}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="新 Judge API Key"
                      placeholder="直接输入 API Key（加密存入 Pidex 凭据库，本地地址可留空）"
                      value={customApiKey}
                      onChange={(event) => setCustomApiKey(event.target.value)}
                      className="tw:min-w-0 tw:flex-1"
                    />
                    <Button
                      isIconOnly
                      color="ghostSecondary"
                      size="toolbar"
                      type="button"
                      title={showCustomApiKey ? '隐藏 API Key' : '显示 API Key'}
                      aria-label={showCustomApiKey ? '隐藏 API Key' : '显示 API Key'}
                      onClick={() => setShowCustomApiKey((current) => !current)}
                    >
                      {showCustomApiKey ? (
                        <EyeOff className="tw:size-icon-sm" aria-hidden="true" size={14} />
                      ) : (
                        <Eye className="tw:size-icon-sm" aria-hidden="true" size={14} />
                      )}
                    </Button>
                  </span>
                </label>
              </div>
              <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-2">
                <p
                  className={`tw:m-0 tw:type-1 ${customNameTaken ? 'tw:text-app-danger' : 'tw:text-app-text-meta'}`}
                >
                  {customNameTaken
                    ? `已存在同名 Judge「${trimmedCustomName}」。`
                    : customHints.hint}
                </p>
                <Button
                  color="primary"
                  size="sm"
                  type="button"
                  disabled={busy || !canAddCustom}
                  onClick={() => void handleAddCustom()}
                >
                  <Plus aria-hidden="true" size={14} />
                  添加并加入级联
                </Button>
              </div>
            </div>
          ) : (
            <div className="tw:grid tw:gap-2">
              <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                <ModelPickerPopover
                  open={pickerOpen}
                  onOpenChange={setPickerOpen}
                  selectedProviderID={selectedModel?.providerID}
                  selectedModelPreset={selectedModel?.modelID}
                  providerOptions={visibleProviderOptions}
                  allProviders={providers}
                  onProviderModelChange={(providerID, modelID) => {
                    setSelectedModel({ providerID, modelID })
                  }}
                  onOpenModelSettings={onOpenModelSettings}
                  align="start"
                  side="bottom"
                  trigger={
                    <Button
                      color="secondary"
                      size="sm"
                      type="button"
                      disabled={busy}
                      className="tw:max-w-[22rem] tw:justify-between"
                    >
                      <span className="tw:truncate">{selectedLabel}</span>
                      <ChevronDown aria-hidden="true" size={14} className="tw:shrink-0" />
                    </Button>
                  }
                />
                <span className="tw:shrink-0 tw:rounded-indicator tw:bg-app-control tw:px-2 tw:py-1 tw:type-1 tw:text-app-text-soft">
                  协议：会话 LLM
                </span>
                <Button
                  color="primary"
                  size="sm"
                  type="button"
                  disabled={busy || !selectedModel}
                  onClick={() => {
                    if (!selectedModel) return
                    const name = nextDecisionJudgeName(
                      config.judges,
                      selectedModel.providerID,
                      selectedModel.modelID,
                    )
                    void onSaveJudge(
                      name,
                      {
                        type: 'llm',
                        providerId: selectedModel.providerID,
                        model: selectedModel.modelID,
                      },
                      { joinCascade: true },
                    ).then((ok) => {
                      if (ok) {
                        setSelectedModel(null)
                        setAddFormOpen(false)
                      }
                    })
                  }}
                >
                  <Plus aria-hidden="true" size={14} />
                  添加并加入级联
                </Button>
              </div>
              <p className="tw:m-0 tw:type-1 tw:text-app-text-meta">
                {visibleProviderOptions.length === 0
                  ? showAllModels
                    ? '暂无已配置密钥的供应商，请先在「模型」设置中配置供应商。'
                    : '未在已配置供应商中筛选到明确支持结构化输出的对话模型；可开启右上角「显示全部对话模型」。'
                  : '仅选用已配置供应商的普通对话模型走「会话 LLM」结构化判定；如需调用原生 Decision API（如 System One / OpenAI Decisions），请切回「自定义独立端点」。'}
              </p>
            </div>
          )}
        </div>
      ) : null}
    </SettingsSection>
  )
}

function JudgeEditor({
  name,
  tierIndex,
  tierCount,
  expanded,
  onToggleExpanded,
  config,
  apiKeyMasked,
  busy,
  probe,
  probing,
  onMoveTier,
  onToggleTier,
  onProbe,
  onSave,
  onRemove,
}: {
  name: string
  tierIndex: number | null
  tierCount: number
  expanded: boolean
  onToggleExpanded: () => void
  config: DecisionConfig
  apiKeyMasked: string | null
  busy: boolean
  probe: DecisionProbeOutcome | null
  probing: boolean
  onMoveTier: (delta: -1 | 1) => void
  onToggleTier: (included: boolean) => void
  onProbe: () => void
  onSave: (judge: JudgeConfig, options?: SaveJudgeOptions) => Promise<boolean>
  onRemove: () => void
}): React.ReactNode {
  const saved = config.judges[name]!
  const [draft, setDraft] = useState<DecisionJudgeDraft>(() => judgeDraftOf(saved))
  const [pendingApiKey, setPendingApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const savedKey = JSON.stringify(saved)
  const [syncedKey, setSyncedKey] = useState(savedKey)
  if (syncedKey !== savedKey) {
    setSyncedKey(savedKey)
    setDraft(judgeDraftOf(saved))
  }
  const isProviderLlm = Boolean(saved.providerId && saved.type === 'llm')
  const dirty =
    JSON.stringify(judgeConfigFromDraft(draft)) !== savedKey || pendingApiKey.trim().length > 0
  const valid = isJudgeDraftValid(name, draft)
  const probeDetail = probe ? decisionProbeDetail(probe) : null
  const hints = customJudgeFieldHints(draft.type)
  const hasSavedKey = Boolean(apiKeyMasked || saved.credentialId)
  const inCascade = tierIndex !== null
  const typeOptions = useMemo(() => {
    if ((CUSTOM_DECISION_JUDGE_TYPES as readonly string[]).includes(draft.type)) {
      return CUSTOM_JUDGE_TYPE_OPTIONS
    }
    return [
      ...CUSTOM_JUDGE_TYPE_OPTIONS,
      { value: draft.type, label: JUDGE_TYPE_LABELS[draft.type] },
    ]
  }, [draft.type])
  const patchField = (field: keyof DecisionJudgeDraft, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }
  const handleSave = async (): Promise<void> => {
    const ok = await onSave(judgeConfigFromDraft(draft), {
      ...(pendingApiKey.trim() ? { apiKey: pendingApiKey.trim() } : {}),
    })
    if (ok) {
      setPendingApiKey('')
      setShowApiKey(false)
    }
  }
  const handleClearKey = async (): Promise<void> => {
    const ok = await onSave(judgeConfigFromDraft(draft), { clearApiKey: true })
    if (ok) {
      setPendingApiKey('')
      setShowApiKey(false)
    }
  }
  return (
    <div className="tw:grid tw:gap-3 tw:px-4 tw:py-3">
      <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-4">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggleExpanded}
          className="tw:flex tw:min-w-0 tw:flex-1 tw:cursor-pointer tw:items-center tw:gap-2 tw:border-0 tw:bg-transparent tw:p-0 tw:text-left tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-app-focus"
        >
          {expanded ? (
            <ChevronDown
              aria-hidden="true"
              size={14}
              className="tw:shrink-0 tw:text-app-text-meta"
            />
          ) : (
            <ChevronRight
              aria-hidden="true"
              size={14}
              className="tw:shrink-0 tw:text-app-text-meta"
            />
          )}
          <span
            className={`tw:inline-flex tw:h-5 tw:min-w-5 tw:shrink-0 tw:items-center tw:justify-center tw:rounded-indicator tw:px-2 tw:type-1 tw:weight-medium tw:tabular-nums ${
              inCascade
                ? 'tw:bg-app-selected tw:text-app-text'
                : 'tw:bg-app-control tw:text-app-text-meta'
            }`}
            title={inCascade ? `全局级联第 ${tierIndex + 1} 级` : '未加入全局级联'}
          >
            {inCascade ? `#${tierIndex + 1}` : '未启用'}
          </span>
          <span className="tw:truncate tw:type-2 tw:weight-medium tw:text-app-text">{name}</span>
          <span className="tw:shrink-0 tw:rounded-indicator tw:bg-app-control tw:px-2 tw:py-1 tw:type-1 tw:text-app-text-soft">
            {JUDGE_TYPE_LABELS[saved.type]}
          </span>
          {saved.model ? (
            <span className="tw:truncate tw:type-1 tw:text-app-text-meta">{saved.model}</span>
          ) : null}
          {probe ? (
            <span
              className={`tw:shrink-0 tw:type-1 tw:tabular-nums ${probe.ok ? 'tw:text-app-success' : 'tw:text-app-danger'}`}
              role="status"
            >
              {decisionProbeLabel(probe)}
            </span>
          ) : null}
        </button>
        <span className="tw:flex tw:shrink-0 tw:items-center tw:gap-1">
          {inCascade ? (
            <>
              <Button
                isIconOnly
                color="ghostSecondary"
                size="toolbar"
                type="button"
                disabled={busy || tierIndex === 0}
                title="在级联中上移"
                aria-label={`上移 ${name}`}
                onClick={() => onMoveTier(-1)}
              >
                <ArrowUp className="tw:size-icon-sm" aria-hidden="true" size={14} />
              </Button>
              <Button
                isIconOnly
                color="ghostSecondary"
                size="toolbar"
                type="button"
                disabled={busy || tierIndex === tierCount - 1}
                title="在级联中下移"
                aria-label={`下移 ${name}`}
                onClick={() => onMoveTier(1)}
              >
                <ArrowDown className="tw:size-icon-sm" aria-hidden="true" size={14} />
              </Button>
            </>
          ) : null}
          <Button
            color="ghostSecondary"
            size="xs"
            type="button"
            disabled={busy}
            onClick={() => onToggleTier(!inCascade)}
          >
            {inCascade ? '移出级联' : '加入级联'}
          </Button>
          <Button
            color="ghostSecondary"
            size="xs"
            type="button"
            loading={probing}
            disabled={busy || probing}
            onClick={onProbe}
          >
            探测
          </Button>
          <Button color="ghostSecondary" size="xs" type="button" onClick={onToggleExpanded}>
            {expanded ? '收起' : '编辑'}
          </Button>
          <Button
            isIconOnly
            color="ghostSecondary"
            size="toolbar"
            type="button"
            disabled={busy}
            title="删除 Judge"
            aria-label={`删除 ${name}`}
            onClick={onRemove}
          >
            <Trash2 className="tw:size-icon-sm" aria-hidden="true" size={14} />
          </Button>
        </span>
      </div>
      {probeDetail ? (
        <div
          className="tw:rounded-control tw:border tw:border-app-danger-border tw:bg-app-danger-subtle tw:px-3 tw:py-2 tw:type-1 tw:text-app-danger tw:break-words tw:select-text"
          role="alert"
        >
          {probeDetail}
        </div>
      ) : null}
      {expanded ? (
        <div className="tw:grid tw:gap-3 tw:border-t tw:border-app-border-subtle tw:pt-3">
          {isProviderLlm ? (
            <div className="tw:grid tw:grid-cols-3 tw:gap-x-4 tw:gap-y-2 tw:@max-[40rem]:grid-cols-1">
              <label className="tw:grid tw:gap-1">
                <span className="tw:type-1 tw:text-app-text-soft">模型</span>
                <Input
                  size="sm"
                  aria-label={`${name} 模型`}
                  placeholder="供应商下的对话模型 ID"
                  value={draft.model}
                  onChange={(event) => patchField('model', event.target.value)}
                />
              </label>
              <label className="tw:grid tw:gap-1">
                <span className="tw:type-1 tw:text-app-text-soft">思考强度</span>
                <Select
                  ariaLabel={`${name} 思考强度`}
                  size="sm"
                  value={draft.thinking}
                  options={THINKING_OPTIONS}
                  onValueChange={(value) => patchField('thinking', value)}
                />
              </label>
              <label className="tw:grid tw:gap-1">
                <span className="tw:type-1 tw:text-app-text-soft">超时（毫秒）</span>
                <Input
                  size="sm"
                  aria-label={`${name} 超时毫秒`}
                  inputMode="numeric"
                  placeholder="默认"
                  invalid={!valid}
                  value={draft.timeoutMs}
                  onChange={(event) => patchField('timeoutMs', event.target.value)}
                />
              </label>
            </div>
          ) : (
            <div className="tw:grid tw:grid-cols-2 tw:gap-x-4 tw:gap-y-2 tw:@max-[40rem]:grid-cols-1">
              <label className="tw:grid tw:gap-1">
                <span className="tw:type-1 tw:text-app-text-soft">协议类型</span>
                <Select
                  ariaLabel={`${name} 协议类型`}
                  size="sm"
                  value={draft.type}
                  options={typeOptions}
                  onValueChange={(value) => patchField('type', value)}
                />
              </label>
              <label className="tw:grid tw:gap-1">
                <span className="tw:type-1 tw:text-app-text-soft">模型</span>
                <Input
                  size="sm"
                  aria-label={`${name} 模型`}
                  placeholder={hints.model}
                  value={draft.model}
                  onChange={(event) => patchField('model', event.target.value)}
                />
              </label>
              <label className="tw:grid tw:gap-1">
                <span className="tw:type-1 tw:text-app-text-soft">Base URL</span>
                <Input
                  size="sm"
                  aria-label={`${name} Base URL`}
                  placeholder={hints.baseUrl}
                  value={draft.baseUrl}
                  onChange={(event) => patchField('baseUrl', event.target.value)}
                />
              </label>
              {draft.type === 'http' ? (
                <label className="tw:grid tw:gap-1">
                  <span className="tw:type-1 tw:text-app-text-soft">请求路径</span>
                  <Input
                    size="sm"
                    aria-label={`${name} 请求路径`}
                    placeholder={hints.path ?? '/v1/systemone'}
                    value={draft.path}
                    onChange={(event) => patchField('path', event.target.value)}
                  />
                </label>
              ) : null}
              <div className="tw:grid tw:gap-1">
                <div className="tw:flex tw:items-center tw:justify-between tw:gap-2">
                  <span className="tw:type-1 tw:text-app-text-soft">API Key</span>
                  {hasSavedKey ? (
                    <span className="tw:flex tw:items-center tw:gap-1.5">
                      <span className="tw:type-1 tw:text-app-text-meta tw:tabular-nums">
                        已加密 {apiKeyMasked ?? '凭据'}
                      </span>
                      <Button
                        color="ghostSecondary"
                        size="xs"
                        type="button"
                        disabled={busy}
                        onClick={() => void handleClearKey()}
                      >
                        清除
                      </Button>
                    </span>
                  ) : null}
                </div>
                <span className="tw:flex tw:items-center tw:gap-1.5">
                  <Input
                    size="sm"
                    type={showApiKey ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`${name} API Key`}
                    placeholder={
                      hasSavedKey ? '输入新 API Key 以替换' : '直接输入 API Key（加密入库）'
                    }
                    value={pendingApiKey}
                    onChange={(event) => setPendingApiKey(event.target.value)}
                    className="tw:min-w-0 tw:flex-1"
                  />
                  <Button
                    isIconOnly
                    color="ghostSecondary"
                    size="toolbar"
                    type="button"
                    title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                    aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                    onClick={() => setShowApiKey((current) => !current)}
                  >
                    {showApiKey ? (
                      <EyeOff className="tw:size-icon-sm" aria-hidden="true" size={14} />
                    ) : (
                      <Eye className="tw:size-icon-sm" aria-hidden="true" size={14} />
                    )}
                  </Button>
                </span>
              </div>
              {draft.type === 'llm' ? (
                <label className="tw:grid tw:gap-1">
                  <span className="tw:type-1 tw:text-app-text-soft">思考强度</span>
                  <Select
                    ariaLabel={`${name} 思考强度`}
                    size="sm"
                    value={draft.thinking}
                    options={THINKING_OPTIONS}
                    onValueChange={(value) => patchField('thinking', value)}
                  />
                </label>
              ) : null}
              <label className="tw:grid tw:gap-1">
                <span className="tw:type-1 tw:text-app-text-soft">超时（毫秒）</span>
                <Input
                  size="sm"
                  aria-label={`${name} 超时毫秒`}
                  inputMode="numeric"
                  placeholder="默认"
                  invalid={!valid}
                  value={draft.timeoutMs}
                  onChange={(event) => patchField('timeoutMs', event.target.value)}
                />
              </label>
            </div>
          )}
          <div className="tw:flex tw:items-center tw:justify-end tw:gap-2">
            <Button
              color="primary"
              size="sm"
              type="button"
              disabled={busy || !dirty || !valid}
              onClick={() => void handleSave()}
            >
              保存修改
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function DecisionPointsSection({
  config,
  manifestGroups,
  busy,
  onGroupModeChange,
  onModeChange,
  onRouteChange,
}: {
  config: DecisionConfig
  manifestGroups: ReturnType<typeof groupDecisionManifest>
  busy: boolean
  onGroupModeChange: (points: readonly DecisionPointManifest[], mode: DecisionMode) => void
  onModeChange: (specId: string, mode: DecisionMode) => void
  onRouteChange: (specId: string, route: string[]) => void
}): React.ReactNode {
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<DecisionGroup>>(() => new Set())

  const toggleGroup = (group: DecisionGroup): void => {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(group)) {
        next.delete(group)
      } else {
        next.add(group)
      }
      return next
    })
  }

  return (
    <SettingsSection
      title="决策点"
      description="默认按分组一键切换关闭 / 影子 / 生效；展开分组可微调单项模式与 Judge 路由。"
    >
      {manifestGroups.length === 0 ? (
        <div className="tw:px-3 tw:py-5 tw:text-center tw:type-1 tw:text-app-text-soft">
          当前运行时未注册任何决策点。升级 Agent 或启用相应能力后，这里会列出可配置的决策点。
        </div>
      ) : (
        <div className="tw:grid tw:divide-y tw:divide-app-border-subtle">
          {manifestGroups.map((section) => {
            const expanded = expandedGroups.has(section.group)
            const groupMode = decisionGroupModeOf(config, section.points)
            const statusSummary = decisionGroupStatusSummary(config, section.points)
            const groupOptions =
              groupMode === 'custom'
                ? [
                    ...MODE_OPTIONS.map((option) => ({ ...option, disabled: busy })),
                    {
                      value: 'custom' as DecisionGroupModeValue,
                      label: DECISION_GROUP_CUSTOM_MODE_LABEL,
                      tooltip: DECISION_GROUP_CUSTOM_MODE_DESCRIPTION,
                      disabled: true,
                    },
                  ]
                : MODE_OPTIONS.map((option) => ({
                    ...option,
                    value: option.value as DecisionGroupModeValue,
                    disabled: busy,
                  }))

            return (
              <div key={section.group} className="tw:grid">
                <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-4 tw:px-3 tw:py-1">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggleGroup(section.group)}
                    className="tw:flex tw:min-w-0 tw:flex-1 tw:cursor-pointer tw:items-start tw:gap-3 tw:border-0 tw:bg-transparent tw:p-0 tw:text-left tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-app-focus"
                  >
                    {expanded ? (
                      <ChevronDown
                        aria-hidden="true"
                        size={16}
                        className="tw:mt-1 tw:shrink-0 tw:text-app-text-meta"
                      />
                    ) : (
                      <ChevronRight
                        aria-hidden="true"
                        size={16}
                        className="tw:mt-1 tw:shrink-0 tw:text-app-text-meta"
                      />
                    )}
                    <span className="tw:grid tw:min-w-0 tw:gap-1">
                      <span className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                        <span className="tw:type-2 tw:weight-medium tw:text-app-text">
                          {section.title}
                        </span>
                        <span className="tw:rounded-indicator tw:bg-app-control tw:px-2 tw:py-1 tw:type-1 tw:text-app-text-meta tw:tabular-nums">
                          {statusSummary}
                        </span>
                      </span>
                      <span className="tw:type-1 tw:text-app-text-soft">{section.summary}</span>
                    </span>
                  </button>
                  <SegmentedControl
                    ariaLabel={`${section.title} 分组模式`}
                    semantics="tabs"
                    variant="inset"
                    size="xs"
                    value={groupMode}
                    options={groupOptions}
                    onChange={(value) => {
                      if (value !== 'custom') {
                        onGroupModeChange(section.points, value)
                      }
                    }}
                  />
                </div>
                {expanded ? (
                  <div className="tw:grid tw:divide-y tw:divide-app-border-subtle tw:border-t tw:border-app-border-subtle tw:bg-app-underlay/35">
                    {section.points.map((point) => (
                      <DecisionPointRow
                        key={point.id}
                        point={point}
                        config={config}
                        busy={busy}
                        onModeChange={onModeChange}
                        onRouteChange={onRouteChange}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </SettingsSection>
  )
}

function DecisionPointRow({
  point,
  config,
  busy,
  onModeChange,
  onRouteChange,
}: {
  point: DecisionPointManifest
  config: DecisionConfig
  busy: boolean
  onModeChange: (specId: string, mode: DecisionMode) => void
  onRouteChange: (specId: string, route: string[]) => void
}): React.ReactNode {
  const savedRoute = config.routes[point.id] ?? []
  const judgeNames = useMemo(() => Object.keys(config.judges), [config.judges])
  const selectValue = decisionRouteSelectValue(savedRoute, config.judges)
  const [customEditorOpen, setCustomEditorOpen] = useState(
    () => selectValue === DECISION_ROUTE_CUSTOM_VALUE,
  )
  const [pendingJudge, setPendingJudge] = useState('')
  const mode = decisionModeOf(config, point)

  const routeOptions = useMemo(() => {
    const base = [
      { value: DECISION_ROUTE_GLOBAL_VALUE, label: '路由：跟随全局级联' },
      ...judgeNames.map((name) => ({
        value: `${DECISION_ROUTE_SINGLE_PREFIX}${name}`,
        label: `路由：${name}`,
      })),
    ]
    if (judgeNames.length > 1 || selectValue === DECISION_ROUTE_CUSTOM_VALUE) {
      base.push({
        value: DECISION_ROUTE_CUSTOM_VALUE,
        label: savedRoute.length > 1 ? `自定义级联（${savedRoute.length} 级）` : '自定义级联…',
      })
    }
    return base
  }, [judgeNames, savedRoute.length, selectValue])

  const availableToAdd = judgeNames.filter((name) => !savedRoute.includes(name))
  const showCustomCascade = customEditorOpen || selectValue === DECISION_ROUTE_CUSTOM_VALUE

  return (
    <div className="tw:grid tw:gap-2.5 tw:pl-10 tw:px-3 tw:py-1">
      <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-4">
        <div className="tw:grid tw:min-w-0 tw:flex-1 tw:gap-1">
          <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
            <span className="tw:type-2 tw:weight-medium tw:text-app-text">{point.titleZh}</span>
            {savedRoute.length > 0 ? (
              <span
                className="tw:rounded-indicator tw:bg-app-control tw:px-2 tw:py-1 tw:type-1 tw:text-app-text-soft"
                title={`单点路由：${formatDecisionRouteSummary(savedRoute)}`}
              >
                {formatDecisionRouteSummary(savedRoute)}
              </span>
            ) : null}
          </div>
          <span className="tw:type-1 tw:text-app-text-soft">{point.summaryZh}</span>
        </div>
        <div className="tw:flex tw:shrink-0 tw:flex-wrap tw:items-center tw:gap-3">
          {judgeNames.length > 0 || savedRoute.length > 0 ? (
            <Select
              ariaLabel={`${point.titleZh} 单点路由`}
              size="sm"
              value={customEditorOpen ? DECISION_ROUTE_CUSTOM_VALUE : selectValue}
              options={routeOptions}
              onValueChange={(next) => {
                if (next === DECISION_ROUTE_GLOBAL_VALUE) {
                  setCustomEditorOpen(false)
                  if (savedRoute.length > 0) onRouteChange(point.id, [])
                  return
                }
                if (next.startsWith(DECISION_ROUTE_SINGLE_PREFIX)) {
                  setCustomEditorOpen(false)
                  const target = next.slice(DECISION_ROUTE_SINGLE_PREFIX.length)
                  onRouteChange(point.id, [target])
                  return
                }
                if (next === DECISION_ROUTE_CUSTOM_VALUE) {
                  setCustomEditorOpen(true)
                  if (savedRoute.length === 0 && config.tiers.length > 0) {
                    onRouteChange(point.id, [...config.tiers])
                  }
                }
              }}
            />
          ) : null}
          <SegmentedControl
            ariaLabel={`${point.titleZh} 模式`}
            semantics="tabs"
            variant="inset"
            size="xs"
            value={mode}
            options={MODE_OPTIONS.map((option) => ({ ...option, disabled: busy }))}
            onChange={(value) => onModeChange(point.id, value as DecisionMode)}
          />
        </div>
      </div>
      {showCustomCascade ? (
        <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:rounded-control tw:border tw:border-app-border-subtle tw:bg-app-panel tw:px-3 tw:py-2">
          <span className="tw:type-1 tw:text-app-text-meta">级联顺序：</span>
          {savedRoute.length === 0 ? (
            <span className="tw:type-1 tw:text-app-text-soft">未指定（跟随全局级联）</span>
          ) : (
            savedRoute.map((judgeName, index) => (
              <span
                key={judgeName}
                className="tw:inline-flex tw:items-center tw:gap-1 tw:rounded-indicator tw:bg-app-control tw:px-2 tw:py-1 tw:type-1 tw:text-app-text"
              >
                <span className="tw:text-app-text-meta tw:tabular-nums">{index + 1}.</span>
                <span>{judgeName}</span>
                {index > 0 ? (
                  <Button
                    isIconOnly
                    color="ghostSecondary"
                    size="xs"
                    type="button"
                    disabled={busy}
                    title="前移"
                    aria-label={`${point.titleZh} 路由前移 ${judgeName}`}
                    onClick={() =>
                      onRouteChange(point.id, moveDecisionTier(savedRoute, judgeName, -1))
                    }
                  >
                    <ArrowUp className="tw:size-icon-xs" aria-hidden="true" size={12} />
                  </Button>
                ) : null}
                {index < savedRoute.length - 1 ? (
                  <Button
                    isIconOnly
                    color="ghostSecondary"
                    size="xs"
                    type="button"
                    disabled={busy}
                    title="后移"
                    aria-label={`${point.titleZh} 路由后移 ${judgeName}`}
                    onClick={() =>
                      onRouteChange(point.id, moveDecisionTier(savedRoute, judgeName, 1))
                    }
                  >
                    <ArrowDown className="tw:size-icon-xs" aria-hidden="true" size={12} />
                  </Button>
                ) : null}
                <Button
                  isIconOnly
                  color="ghostSecondary"
                  size="xs"
                  type="button"
                  disabled={busy}
                  title="移除此级"
                  aria-label={`${point.titleZh} 路由移除 ${judgeName}`}
                  onClick={() => {
                    const nextRoute = savedRoute.filter((item) => item !== judgeName)
                    onRouteChange(point.id, nextRoute)
                    if (nextRoute.length <= 1) setCustomEditorOpen(false)
                  }}
                >
                  <X className="tw:size-icon-xs" aria-hidden="true" size={12} />
                </Button>
              </span>
            ))
          )}
          {availableToAdd.length > 0 ? (
            <Select
              ariaLabel={`${point.titleZh} 添加级联 Judge`}
              size="sm"
              value={pendingJudge}
              placeholder="+ 添加下一级…"
              options={availableToAdd.map((name) => ({ value: name, label: name }))}
              onValueChange={(next) => {
                if (!next) return
                onRouteChange(point.id, [...savedRoute, next])
                setPendingJudge('')
              }}
            />
          ) : null}
          {savedRoute.length > 0 ? (
            <Button
              color="ghostSecondary"
              size="xs"
              type="button"
              disabled={busy}
              onClick={() => {
                setCustomEditorOpen(false)
                onRouteChange(point.id, [])
              }}
            >
              重置为全局
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
