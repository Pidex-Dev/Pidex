import { ModelCatalogDetails, modelPrice } from './ModelCatalogDetails.js'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Activity,
  RefreshCw,
  Pencil,
  Plus,
  Minus,
  X,
  Brain,
  Eye,
  Wrench,
  Server,
  Check,
  Cpu,
  Mic,
  Code,
  Binary,
  Sparkles,
  MessageSquare,
  Filter,
  CheckCheck,
} from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  DesktopModelMetadata,
  DesktopModelProviderSummary,
  DesktopProviderDefinition,
  DesktopProviderModelDefinition,
  DesktopProviderModelMatch,
  ModelProviderID,
} from '../../../../shared/Types.js'
import type { ModelTestStatus } from '../UseModelCenterController.js'
import { Button } from '../../../components/ui/Button.js'
import { ProviderIcon } from '../ProviderIcon.js'
import { modelLogoURL } from '../../../services/desktop-client/ModelLogo.js'
import { SearchHeading } from '../../../components/ui/SearchHeading.js'
import { SearchInput } from '../../../components/ui/SearchInput.js'
import { APP_ICON_SIZE, APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'
import { toUserErrorMessage } from '../../../utils/Errors.js'
import { formatCompactNumber } from '../../../utils/UsageFormatters.js'
import { isExecutableDesktopProvider } from '../../../services/desktop-client/ProviderAdapters.js'
import { createPortal } from 'react-dom'
import { useDesktopLayoutOutletContext } from '../../layout/shell/DesktopLayoutOutletContext.js'
import { ProviderModelPanel } from './ProviderModelPanel.js'
import {
  candidateMatchHint,
  candidateMatchLabel,
  isImportableCandidate,
} from './ModelCandidateImport.js'
import { ProviderModelSpecRepairDialog } from './ProviderModelSpecRepairDialog.js'
import { editableModel, normalizeEditableModel, resolveDiscoveryChatApi } from './ProviderEditorForm.js'
import { useDialogFocusRestore } from '../../../components/ui/UseDialogFocusRestore.js'
import { ConfirmationDialog } from '../../../components/ui/ConfirmationDialog.js'
import { desktopClient } from '../../../services/desktop-client/index.js'
import { SETTINGS_MANAGEMENT_DIALOG_SIZE } from '../../settings/SettingsManagementDialogSizing.js'
import { cx } from '../../../utils/Cx.js'

export type ProviderModelsSectionProps = {
  provider: DesktopModelProviderSummary
  editingBlocked?: boolean
  models: readonly string[]
  modelMetadata?: Record<string, DesktopModelMetadata>
  busy: boolean
  testResults: Readonly<Record<string, ModelTestStatus>>
  onTestModels: (ids: readonly string[]) => Promise<void>
  onFetchModels: () => Promise<void>
  onSaveDefinition: (
    definition: DesktopProviderDefinition,
    providerId?: ModelProviderID,
  ) => Promise<void>
  onRefresh: () => Promise<void>
  onNotice: (message: string) => void
  onError: (message: string) => void
  onTestAllDiscoveredModels?: () => void
  onAddAllDiscoveredModels?: () => void
  onFilterDiscoveredModels?: () => void
}

export function ProviderModelsSection({
  provider,
  editingBlocked = false,
  models,
  modelMetadata = {},
  busy,
  testResults,
  onTestModels,
  onFetchModels,
  onSaveDefinition,
  onRefresh,
  onNotice,
  onError,
  onTestAllDiscoveredModels,
  onAddAllDiscoveredModels,
  onFilterDiscoveredModels,
}: ProviderModelsSectionProps): React.ReactNode {
  const [searchQuery, setSearchQuery] = useState('')
  const builtinConfig = provider.config?.kind === 'builtin' ? provider.config : null
  const customConfig = provider.config?.kind === 'custom' ? provider.config : null
  const [saving, setSaving] = useState(false)
  const panel = useDesktopLayoutOutletContext()?.providerManagement
  const modelEditorVersion = useRef(0)
  const [editingModel, setEditingModel] = useState<{
    version: number
    model: DesktopProviderModelDefinition
    creating: boolean
    nativeApi?: string
  } | null>(null)
  const [deletingModel, setDeletingModel] = useState<string | null>(null)
  const [discoveredModels, setDiscoveredModels] = useState<DesktopProviderModelDefinition[] | null>(
    null,
  )
  const [candidateMatches, setCandidateMatches] = useState<
    Readonly<Record<string, DesktopProviderModelMatch>>
  >({})
  const [specRepairOpen, setSpecRepairOpen] = useState(false)
  const [addedModelIds, setAddedModelIds] = useState<Set<string>>(new Set())
  const [togglingModelIds, setTogglingModelIds] = useState<Set<string>>(new Set())
  const [modalSearchQuery, setModalSearchQuery] = useState('')
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null)
  const pendingConfigRef = useRef<DesktopProviderDefinition | null>(null)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const { onCloseAutoFocus } = useDialogFocusRestore(discoveredModels !== null)
  const executable = isExecutableDesktopProvider(provider)
  const editable = provider.config != null

  useEffect(() => {
    if (customConfig && togglingModelIds.size === 0) {
      pendingConfigRef.current = customConfig
    }
  }, [customConfig, togglingModelIds.size])

  async function fetchModels() {
    if (saving || busy) return
    setDiscoveredModels([])
    setCandidateMatches({})
    setModalSearchQuery('')
    setExpandedModelId(null)
    setSaving(true)
    try {
      const result = await desktopClient.discoverProviderModels({
        providerId: provider.providerID,
        api: resolveDiscoveryChatApi(customConfig?.models ?? []),
      })
      setDiscoveredModels([...result.models])
      setCandidateMatches(Object.fromEntries((result.matches ?? []).map((match) => [String(match.id), match])))
      setAddedModelIds(new Set(rows.map((row) => row.id)))
      pendingConfigRef.current = provider.config ?? null
    } catch (error) {
      setDiscoveredModels(null)
      onError(toUserErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  async function toggleModel(model: DesktopProviderModelDefinition) {
    if (!provider.config || togglingModelIds.size > 0) return
    const currentConfig = pendingConfigRef.current ?? provider.config
    const isCurrentlyAdded = addedModelIds.has(model.id)
    const nextAdded = new Set(addedModelIds)
    let nextModels: readonly DesktopProviderDefinition['models'][number][]

    if (isCurrentlyAdded) {
      nextAdded.delete(model.id)
      nextModels = currentConfig.models.filter((m) => m.id !== model.id)
    } else {
      // 未知/歧义候选不按名称猜能力或上下文，直接进入编辑器手动补齐。
      if (!isImportableCandidate(model, candidateMatches[model.id])) {
        setDiscoveredModels(null)
        setCandidateMatches({})
        openModel(model.id, model)
        return
      }
      nextAdded.add(model.id)
      nextModels = [...currentConfig.models.filter((m) => m.id !== model.id), currentConfig.kind === 'builtin' ? { id: model.id, enabled: true } : { ...model, enabled: true }]
    }

    setAddedModelIds(nextAdded)
    const nextConfig = {
      ...currentConfig,
      models: nextModels,
      ...(currentConfig.kind === 'builtin' ? {
        denyModels: isCurrentlyAdded ? [...new Set([...currentConfig.denyModels, model.id])] : currentConfig.denyModels.filter((id) => id !== model.id),
        allowModels: isCurrentlyAdded ? currentConfig.allowModels.filter((id) => id !== model.id) : [...new Set([...currentConfig.allowModels, model.id])],
      } : {}),
    } as DesktopProviderDefinition
    pendingConfigRef.current = nextConfig
    setTogglingModelIds((prev) => new Set(prev).add(model.id))

    saveChainRef.current = saveChainRef.current
      .then(async () => {
        await onSaveDefinition(nextConfig, provider.providerID)
        await onRefresh()
        onNotice(
          isCurrentlyAdded
            ? `已移除模型 ${model.name ?? model.id}。`
            : `已添加模型 ${model.name ?? model.id}。`,
        )
      })
      .catch((error) => {
        setAddedModelIds((prev) => {
          const rolled = new Set(prev)
          if (isCurrentlyAdded) rolled.add(model.id)
          else rolled.delete(model.id)
          return rolled
        })
        pendingConfigRef.current = provider.config ?? null
        onError(toUserErrorMessage(error))
      })
      .finally(() => {
        setTogglingModelIds((prev) => {
          const next = new Set(prev)
          next.delete(model.id)
          return next
        })
      })
  }

  const filteredDiscoveredModels = useMemo(() => {
    if (!discoveredModels) return []
    const q = modalSearchQuery.trim().toLowerCase()
    if (!q) return discoveredModels
    return discoveredModels.filter((model) => {
      const vendor = resolveModelVendor(model, provider)
      const caps = resolveModelCapabilities(model, modelMetadata[model.id])
      const capLabels = caps.map((c) => c.label).join(' ')
      const text = `${model.id} ${model.name ?? ''} ${vendor} ${capLabels}`.toLowerCase()
      return text.includes(q)
    })
  }, [discoveredModels, modalSearchQuery, provider, modelMetadata])
  const rows = useMemo(
    () =>
      customConfig
        ? customConfig.models.map((model) => ({
            id: model.id,
            group: model.group,
            enabled: model.enabled !== false,
            metadata: {
              ...modelMetadata[model.id],
              name: model.name,
              contextWindow: model.contextWindow,
              outputTokens: model.maxTokens,
              reasoning: model.reasoning,
              vision: model.input?.includes('image'),
              providerApi: model.api,
              inputCost: model.cost?.input,
              outputCost: model.cost?.output,
            } as DesktopModelMetadata,
          }))
        : [
            ...new Set([
              ...(builtinConfig?.allowModels ?? []),
              ...(builtinConfig?.models.map((model) => String(model.id)) ?? []),
            ]),
          ]
            .filter(
              (id) =>
                builtinConfig?.models.find((model) => model.id === id)?.enabled !== false &&
                !builtinConfig?.denyModels.includes(id as never) &&
                (!builtinConfig?.allowModels.length ||
                  builtinConfig.allowModels.includes(id as never)),
            )
            .map((id) => {
              const override = builtinConfig?.models.find((model) => model.id === id)
              return {
                id,
                group: override?.group,
                enabled:
                  override?.enabled !== false && !builtinConfig?.denyModels.includes(id as never),
                metadata: {
                  ...modelMetadata[id],
                  name: override?.name ?? modelMetadata[id]?.name,
                  contextWindow: override?.contextWindow ?? modelMetadata[id]?.contextWindow,
                  outputTokens: override?.maxTokens ?? modelMetadata[id]?.outputTokens,
                  reasoning: override?.reasoning ?? modelMetadata[id]?.reasoning,
                  vision: override?.input?.includes('image') ?? modelMetadata[id]?.vision,
                  providerApi: override?.api ?? modelMetadata[id]?.providerApi,
                } as DesktopModelMetadata,
              }
            }),
    [customConfig, builtinConfig, models, modelMetadata],
  )

  async function openModel(id?: string, candidate?: DesktopProviderModelDefinition) {
    if (!(await panel?.open(provider.providerID, 'model'))) return
    const metadata = id ? modelMetadata[id] : undefined
    const protocolMetadata = id ? metadata : modelMetadata[models[0] ?? '']
    const configured = id
      ? (customConfig?.models.find((model) => model.id === id) ??
        builtinConfig?.models.find((model) => model.id === id))
      : undefined
    const api =
      candidate?.api ??
      configured?.api ??
      customConfig?.models.find((model) => !model.modelType || model.modelType === 'chat')?.api ??
      protocolMetadata?.providerApi ??
      provider.providerApis?.[0] ??
      'openai-completions'
    const nativeApi =
      builtinConfig?.id === 'deepseek'
        ? (builtinConfig.protocol ?? metadata?.providerApi ?? 'openai-completions')
        : builtinConfig && !configured?.api && !protocolMetadata?.providerApi
          ? (protocolMetadata?.nativeApi ??
            (provider.providerApis?.length ? undefined : provider.nativeApis?.[0]))
          : undefined
    const model = {
      id: (id ?? '') as DesktopProviderModelDefinition['id'],
      name: id ? (metadata?.name ?? id) : '',
      api,
      enabled: true,
      // 目录未给出上下文时保持为空，由用户明确填写，不再预填 32K。
      contextWindow: metadata?.contextWindow ?? 0,
      maxInputTokens: metadata?.inputTokens,
      maxTokens: metadata?.outputTokens ?? 8_192,
      reasoning: metadata?.reasoning ?? false,
      tools: metadata?.toolCall ?? true,
      modelType:
        metadata?.modelType === 'embedding' || metadata?.modelType === 'rerank'
          ? metadata.modelType
          : 'chat',
      input: metadata?.modalities?.input ?? (metadata?.vision ? ['text', 'image'] : ['text']),
      ...configured,
      ...candidate,
      catalog: candidate?.catalog ?? metadata?.catalog,
      cost: {
        input: candidate?.cost?.input ?? metadata?.inputCost ?? 0,
        output: candidate?.cost?.output ?? metadata?.outputCost ?? 0,
        cacheRead: candidate?.cost?.cacheRead ?? metadata?.cacheReadCost ?? 0,
        cacheWrite: candidate?.cost?.cacheWrite ?? metadata?.cacheWriteCost ?? 0,
        ...candidate?.cost,
        ...configured?.cost,
      },
    } as DesktopProviderModelDefinition
    const creating = !id || (!!candidate && !configured)
    setEditingModel({ version: ++modelEditorVersion.current, model: creating ? { ...model, enabled: true } : model, creating, ...(nativeApi ? { nativeApi } : {}) })
  }

  /**
   * 批量添加当前候选中的已匹配模型；未匹配、歧义与缺额度候选跳过并报告数量。
   * 单次整体保存，避免逐个写配置产生中间状态。
   */
  async function addAllDiscoveredModels() {
    if (!provider.config || !discoveredModels || saving || busy || togglingModelIds.size > 0) return
    const currentConfig = pendingConfigRef.current ?? provider.config
    const importable = discoveredModels.filter((model) =>
      isImportableCandidate(model, candidateMatches[model.id]),
    )
    const skipped = discoveredModels.length - importable.length
    if (!importable.length) {
      onNotice(`没有可批量添加的模型，${skipped} 个候选需手动补齐规格。`)
      return
    }
    const existing = new Set(addedModelIds)
    const added = importable
      .filter((model) => !existing.has(String(model.id)))
      .map((model) => ({ ...model, enabled: true }))
    if (!added.length) {
      onNotice('候选模型已全部添加。')
      return
    }
    setSaving(true)
    try {
      await onSaveDefinition(
        {
          ...currentConfig,
          models: [...currentConfig.models.filter((model) => !added.some((item) => item.id === model.id)), ...added.map((model) => currentConfig.kind === 'builtin' ? { id: model.id, enabled: true } : model)],
          ...(currentConfig.kind === 'builtin' ? {
            denyModels: currentConfig.denyModels.filter((id) => !added.some((model) => model.id === id)),
            allowModels: [...new Set([...currentConfig.allowModels, ...added.map((model) => model.id)])],
          } : {}),
        } as DesktopProviderDefinition,
        provider.providerID,
      )
      await onRefresh()
      pendingConfigRef.current = null
      setAddedModelIds(new Set([...existing, ...added.map((model) => model.id)]))
      onNotice(
        `已添加 ${added.length} 个模型${skipped ? `，跳过 ${skipped} 个需手动补齐的候选` : ''}。`,
      )
    } catch (error) {
      onError(toUserErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  async function saveModel(model: DesktopProviderModelDefinition) {
    const config = provider.config
    if (!config || !editingModel) throw new Error('供应商配置尚未加载。')
    const oldId = editingModel.creating ? null : editingModel.model.id
    if (
      config.models.some((item) => item.id === model.id && item.id !== oldId) ||
      (editingModel.creating && models.includes(model.id))
    )
      throw new Error('模型 ID 已存在。')
    if (config.kind === 'custom') {
      await onSaveDefinition(
        { ...config, models: [...config.models.filter((item) => item.id !== oldId), model] },
        provider.providerID,
      )
    } else {
      const previous = config.models.find((item) => item.id === oldId)
      const initial = normalizeEditableModel(editableModel(editingModel.model))
      if (initial instanceof Error) throw initial
      const override: Record<string, unknown> = {
        ...previous,
        id: model.id,
        enabled: model.enabled ?? true,
      }
      for (const [key, value] of Object.entries(model)) {
        if (key === 'api' && editingModel.nativeApi) continue
        if (
          editingModel.creating ||
          JSON.stringify(value) !==
            JSON.stringify(initial[key as keyof DesktopProviderModelDefinition])
        )
          override[key] = value
      }
      await onSaveDefinition(
        {
          ...config,
          models: [...config.models.filter((item) => item.id !== oldId), override as never],
          denyModels: config.denyModels.filter((id) => id !== model.id),
          allowModels: [...new Set([...config.allowModels, model.id])],
        },
        provider.providerID,
      )
    }
    await onRefresh()
    setEditingModel((current) => current ? { ...current, model, creating: false } : null)
    onNotice('模型配置已保存。')
  }

  async function removeModel(id: string) {
    if (!provider.config) return
    setSaving(true)
    try {
      const config = provider.config
      await onSaveDefinition(
        config.kind === 'custom'
          ? { ...config, models: config.models.filter((model) => model.id !== id) }
          : {
              ...config,
              allowModels: config.allowModels.filter((modelId) => modelId !== id),
              denyModels: [...new Set([...config.denyModels, id as never])],
              models: config.models.map((model) =>
                model.id === id ? { ...model, enabled: false } : model,
              ),
            },
        provider.providerID,
      )
      await onRefresh()
      setDeletingModel(null)
      onNotice('模型已移除。')
    } catch (error) {
      onError(toUserErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  const filtered = rows.filter(({ id, metadata }) =>
    [
      id,
      metadata?.name,
      metadata?.description,
      ...(metadata?.tags ?? []),
      metadata?.reasoning ? '推理 reasoning' : '',
      metadata?.vision ? '图片 vision' : '',
    ]
      .join(' ')
      .toLowerCase()
      .includes(searchQuery.trim().toLowerCase()),
  )

  return (
    <section
      className="model-center-models-section tw:grid tw:min-w-0 tw:gap-3"
      aria-label="模型列表"
    >
      <header className="tw:flex tw:min-w-0 tw:items-center tw:justify-between tw:gap-3">
        <SearchHeading
          title={
            <div className="tw:flex tw:items-center tw:gap-2">
              <h3 className="tw:m-0 tw:flex tw:items-center tw:gap-2 tw:type-4 tw:weight-bold">
                模型{' '}
                <span className="tw:inline-flex tw:h-5 tw:min-w-5 tw:items-center tw:justify-center tw:rounded-full tw:bg-app-hover tw:px-2 tw:type-1 tw:tabular-nums">
                  {rows.length}
                </span>
              </h3>
            </div>
          }
          search={
            <SearchInput
              aria-label="搜索模型"
              placeholder="搜索模型名称、ID 或能力"
              value={searchQuery}
              onChange={setSearchQuery}
            />
          }
        />
        <div className="tw:flex tw:shrink-0 tw:items-center tw:gap-1">
          <Button
            color="ghostSecondary"
            isIconOnly
            size="toolbar"
            aria-label="测试全部"
            title="测试全部"
            disabled={busy || !executable || !rows.some((row) => row.enabled)}
            onClick={() =>
              void onTestModels(rows.filter((row) => row.enabled).map((row) => row.id))
            }
          >
            <Activity className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
          </Button>
          <Button
            color="outline"
            size="sm"
            disabled={
              busy || saving || editingBlocked || provider.availability?.status === 'unavailable'
            }
            onClick={() => void fetchModels()}
          >
            <RefreshCw className="tw:size-icon-sm" aria-hidden size={APP_ICON_SIZES.sm} />
            同步模型
          </Button>
          {customConfig ? (
            <Button
              color="outline"
              size="sm"
              disabled={busy || saving || editingBlocked}
              onClick={() => setSpecRepairOpen(true)}
            >
              检查 32K 模型规格
            </Button>
          ) : null}
          {provider.config && editable ? (
            <Button
              color="outline"
              isIconOnly
              size="sm"
              aria-label="添加模型"
              title="添加模型"
              disabled={busy || saving || editingBlocked}
              onClick={() => openModel()}
            >
              <Plus className="tw:size-icon-sm" aria-hidden size={APP_ICON_SIZES.sm} />
            </Button>
          ) : null}
        </div>
      </header>
      <div className="model-center-models-list tw:grid tw:min-w-0">
        {filtered.map((row) => (
          <ModelRowItem
            key={row.id}
            modelId={row.id}
            metadata={row.metadata}
            disabled={busy || !executable || !row.enabled}
            enabled={row.enabled}
            testStatus={testResults[`${provider.providerID}/${row.id}`]}
            onTest={() => void onTestModels([row.id])}
            onEdit={() => openModel(row.id)}
            onRemove={() => setDeletingModel(row.id)}
            editingDisabled={busy || saving || editingBlocked || !provider.config || !editable}
            logoURL={modelLogoURL(row.id, row.metadata?.name) ?? provider.logoURL}
            providerID={
              modelLogoURL(row.id, row.metadata?.name) ? undefined : provider.providerID
            }
          />
        ))}
        {filtered.length === 0 ? (
          <p className="tw:px-3 tw:py-4 tw:text-app-text-soft tw:type-1">
            {rows.length === 0 ? '尚无模型，请同步目录或添加模型。' : '未找到匹配的模型。'}
          </p>
        ) : null}
      </div>
      {editingModel && panel?.host && panel.tab?.providerId === provider.providerID && panel.tab.section === 'model' ? createPortal(
        <ProviderModelPanel
          key={editingModel.version}
          panel={panel}
          providerId={provider.providerID}
          baseUrl={provider.baseURL ?? ''}
          model={editingModel.model}
          creating={editingModel.creating}
          {...(editingModel.nativeApi ? { nativeApi: editingModel.nativeApi } : {})}
          onSave={saveModel}
          onClose={panel.close}
        />,
        panel.host,
      ) : null}
      <Dialog.Root
        open={discoveredModels !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDiscoveredModels(null)
            setCandidateMatches({})
            setModalSearchQuery('')
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="ui-dialog-backdrop permission-modal-backdrop" />
          <Dialog.Content
            onCloseAutoFocus={onCloseAutoFocus}
            className={`ui-dialog-surface ui-dialog-surface--centered settings-management-dialog tw:flex tw:flex-col tw:overflow-hidden ${SETTINGS_MANAGEMENT_DIALOG_SIZE.discoveredModels}`}
          >
            <header className="settings-management-dialog-header">
              <div className="settings-management-dialog-heading">
                <Dialog.Title>添加远端模型</Dialog.Title>
                <Dialog.Description>
                  从 API 地址的 /models 目录选择模型，点击卡片即可切换添加状态。
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button color="ghostSecondary" isIconOnly size="toolbar" aria-label="关闭模型发现">
                  <X className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
                </Button>
              </Dialog.Close>
            </header>
            <div className="settings-management-dialog-body tw:flex tw:flex-col tw:gap-3 tw:overflow-y-auto">
              {saving ? (
                <p role="status">正在获取模型目录…</p>
              ) : discoveredModels?.length === 0 ? (
                <p className="tw:py-6 tw:text-center tw:text-app-text-soft tw:type-1">
                  远端目录没有模型。
                </p>
              ) : (
                <>
                  <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-2 tw:mb-1">
                    <SearchInput
                      aria-label="搜索候选模型"
                      placeholder="搜索模型名称、ID、厂商或能力"
                      value={modalSearchQuery}
                      onChange={setModalSearchQuery}
                      className="tw:flex-1 tw:min-w-[200px]"
                    />
                    <div className="tw:flex tw:shrink-0 tw:items-center tw:gap-1">
                      <Button
                        color="outline"
                        size="sm"
                        title="测试全部模型"
                        onClick={() => {
                          if (onTestAllDiscoveredModels) {
                            onTestAllDiscoveredModels()
                          } else {
                            onNotice('测试全部模型功能待接入')
                          }
                        }}
                      >
                        <Activity className="tw:size-icon-sm" aria-hidden size={APP_ICON_SIZES.sm} />
                        测试全部模型
                      </Button>
                      <Button
                        color="outline"
                        size="sm"
                        disabled={togglingModelIds.size > 0}
                        title="添加全部模型"
                        onClick={() => {
                          if (onAddAllDiscoveredModels) {
                            onAddAllDiscoveredModels()
                          } else {
                            void addAllDiscoveredModels()
                          }
                        }}
                      >
                        <CheckCheck className="tw:size-icon-sm" aria-hidden size={APP_ICON_SIZES.sm} />
                        添加全部模型
                      </Button>
                      <Button
                        color="outline"
                        size="sm"
                        title="筛选模型"
                        onClick={() => {
                          if (onFilterDiscoveredModels) {
                            onFilterDiscoveredModels()
                          } else {
                            onNotice('筛选模型功能待接入')
                          }
                        }}
                      >
                        <Filter className="tw:size-icon-sm" aria-hidden size={APP_ICON_SIZES.sm} />
                        筛选模型
                      </Button>
                    </div>
                  </div>
                  {filteredDiscoveredModels.length === 0 ? (
                    <p className="tw:py-6 tw:text-center tw:text-app-text-soft tw:type-1">
                      未找到匹配的模型。
                    </p>
                  ) : (
                    <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:max-[560px]:grid-cols-1">
                      {filteredDiscoveredModels.map((model) => (
                        <DiscoveredModelCard
                          key={model.id}
                          model={model}
                          match={candidateMatches[model.id]}
                          provider={provider}
                          metadata={modelMetadata[model.id]}
                          isSelected={addedModelIds.has(model.id)}
                          isToggling={togglingModelIds.size > 0}
                          expanded={expandedModelId === model.id}
                          onExpand={() => setExpandedModelId(expandedModelId === model.id ? null : model.id)}
                          current={provider.config?.models.find((entry) => entry.id === model.id) as DesktopProviderModelDefinition | undefined}
                          onToggle={() => void toggleModel(model)}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {customConfig ? (
        <ProviderModelSpecRepairDialog
          open={specRepairOpen}
          providerId={provider.providerID}
          onClose={() => setSpecRepairOpen(false)}
          onApplied={async () => {
            await onRefresh()
            onNotice('模型规格已更新。')
          }}
        />
      ) : null}
      <ConfirmationDialog
        open={deletingModel !== null}
        title="移除模型？"
        description={
          builtinConfig
            ? '将从可用模型中移除，可通过同步模型重新添加。'
            : '将从供应商配置中移除此模型。'
        }
        actionLabel="移除"
        actionDisabled={saving}
        onAction={() => {
          if (deletingModel) void removeModel(deletingModel)
        }}
        onCancel={() => setDeletingModel(null)}
      />
    </section>
  )
}

function ModelRowItem({
  modelId,
  metadata,
  disabled,
  enabled,
  testStatus,
  onTest,
  onEdit,
  onRemove,
  editingDisabled,
  logoURL,
  providerID,
}: {
  modelId: string
  metadata?: DesktopModelMetadata
  disabled: boolean
  enabled: boolean
  testStatus?: ModelTestStatus
  onTest: () => void
  onEdit: () => void
  onRemove: () => void
  editingDisabled: boolean
  logoURL?: string
  providerID?: string
}): React.ReactNode {
  const details = `${modelId} · 上下文 ${metadata?.contextWindow ? formatCompactNumber(metadata.contextWindow) : '未知'} / 输出 ${metadata?.outputTokens ? formatCompactNumber(metadata.outputTokens) : '未知'}${enabled ? '' : ' · 已停用'}`
  return (
    <article
      className="model-center-model-row tw:flex tw:min-w-0 tw:items-center tw:gap-3 tw:px-4 tw:py-3 tw:hover:bg-app-hover"
      title={details}
    >
      <span className="tw:flex tw:size-5 tw:shrink-0 tw:items-center tw:justify-center">
        <ProviderIcon
          providerID={providerID}
          logoURL={logoURL}
          className="tw:size-full"
          imageClassName="tw:object-contain tw:[.dark-theme_&]:invert tw:[.dark-theme_&]:hue-rotate-180"
          fallback={<Server className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />}
        />
      </span>
      <button
        type="button"
        className="tw:min-w-0 tw:flex-1 tw:truncate tw:text-left tw:type-2 tw:weight-medium"
        aria-label={`编辑模型 ${modelId}`}
        disabled={editingDisabled}
        onClick={onEdit}
      >
        {metadata?.name || modelId}
      </button>
      <div className="tw:flex tw:shrink-0 tw:items-center tw:gap-2 tw:text-app-text-soft">
        {metadata?.reasoning ? (
          <span role="img" aria-label="推理" title="推理">
            <Brain className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
          </span>
        ) : null}
        {metadata?.vision ? (
          <span role="img" aria-label="图片输入" title="图片输入">
            <Eye className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
          </span>
        ) : null}
        {metadata?.toolCall ? (
          <span role="img" aria-label="工具调用" title="工具调用">
            <Wrench className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
          </span>
        ) : null}
        {testStatus?.state === 'reachable' ? (
          <span role="status" className="tw:text-app-success tw:type-1">
            {testStatus.api ? `${testStatus.api} · ` : ''}
            {testStatus.latencyMs} ms
          </span>
        ) : testStatus?.state === 'failed' ? (
          <span
            role="status"
            className="tw:text-app-danger tw:type-1"
            title={`${testStatus.message}${testStatus.category ? ` · ${testStatus.category}` : ''}`}
          >
            失败
          </span>
        ) : null}
        <Button
          color="ghostSecondary"
          isIconOnly
          size="toolbar"
          disabled={disabled}
          aria-label={`测试模型 ${modelId}`}
          title={`测试模型 ${modelId}`}
          loading={testStatus?.state === 'testing'}
          onClick={onTest}
        >
          <Activity className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
        </Button>
        <Button
          color="ghostSecondary"
          isIconOnly
          size="toolbar"
          aria-label={`模型设置 ${modelId}`}
          title={`模型设置 ${modelId}`}
          disabled={editingDisabled}
          onClick={onEdit}
        >
          <Pencil className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
        </Button>
        <Button
          color="ghostSecondary"
          isIconOnly
          size="toolbar"
          aria-label={`移除模型 ${modelId}`}
          title={`移除模型 ${modelId}`}
          disabled={editingDisabled}
          onClick={onRemove}
        >
          <Minus className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
        </Button>
      </div>
    </article>
  )
}

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

export type ModelCapability = {
  key: string
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  badgeClass: string
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
      badgeClass: 'tw:bg-purple-500/10 tw:text-purple-600 dark:tw:text-purple-400',
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
      badgeClass: 'tw:bg-blue-500/10 tw:text-blue-600 dark:tw:text-blue-400',
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
      badgeClass: 'tw:bg-amber-500/10 tw:text-amber-600 dark:tw:text-amber-400',
    })
  }

  for (const kind of ['video', 'pdf'] as const) {
    if ((model.catalog?.input ?? model.input)?.includes(kind)) caps.push({
      key: kind, label: kind === 'pdf' ? 'PDF（目录）' : '视频', icon: Eye,
      badgeClass: 'tw:bg-app-hover tw:text-app-text-soft',
    })
  }
  if (model.catalog?.structuredOutput) caps.push({
    key: 'structured', label: '结构化输出', icon: Code,
    badgeClass: 'tw:bg-app-hover tw:text-app-text-soft',
  })

  const isCode = Boolean(/coder|coding|code/i.test(text))
  if (isCode) {
    caps.push({
      key: 'code',
      label: '代码',
      icon: Code,
      badgeClass: 'tw:bg-emerald-500/10 tw:text-emerald-600 dark:tw:text-emerald-400',
    })
  }

  const isEmbedding = Boolean(model.modelType === 'embedding' || /embed/i.test(text))
  if (isEmbedding) {
    caps.push({
      key: 'embedding',
      label: '向量嵌入',
      icon: Binary,
      badgeClass: 'tw:bg-teal-500/10 tw:text-teal-600 dark:tw:text-teal-400',
    })
  }

  const isRerank = Boolean(model.modelType === 'rerank' || /rerank/i.test(text))
  if (isRerank) {
    caps.push({
      key: 'rerank',
      label: '重排',
      icon: Sparkles,
      badgeClass: 'tw:bg-orange-500/10 tw:text-orange-600 dark:tw:text-orange-400',
    })
  }

  const hasTools = Boolean(model.tools ?? metadata?.toolCall ?? (!isEmbedding && !isRerank))
  if (hasTools && !isEmbedding && !isRerank) {
    caps.push({
      key: 'tools',
      label: '工具',
      icon: Wrench,
      badgeClass: 'tw:bg-app-hover tw:text-app-text-soft',
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
  // 上下文只接受目录/上游的明确值；名称中的 K/M 不代表真实额度。
  return null
}

export type DiscoveredModelCardProps = {
  model: DesktopProviderModelDefinition
  match?: DesktopProviderModelMatch
  provider: DesktopModelProviderSummary
  metadata?: DesktopModelMetadata
  isSelected: boolean
  isToggling: boolean
  onToggle: () => void
  expanded?: boolean
  onExpand?: () => void
  current?: DesktopProviderModelDefinition
}

export function DiscoveredModelCard({
  model,
  match,
  provider,
  metadata,
  isSelected,
  isToggling,
  onToggle,
  expanded, onExpand, current,
}: DiscoveredModelCardProps): React.ReactNode {
  const vendor = resolveModelVendor(model, provider)
  const capabilities = resolveModelCapabilities(model, metadata)
    .sort((a, b) => Number(b.key === 'tools') - Number(a.key === 'tools'))
  const contextWindow = resolveModelContextWindow(model, metadata)
  const importable = isImportableCandidate(model, match)
  const matchLabel = candidateMatchLabel(match?.status)
  const modelName = model.name || model.id
  const logo = modelLogoURL(model.id, model.name) ?? provider.logoURL

  return (
    <div className="tw:min-w-0 tw:self-start">
    <button
      type="button"
      role="checkbox"
      aria-checked={isSelected}
      aria-label={`${modelName}，${
        isSelected ? '已添加，点击移除' : importable ? '未添加，点击添加' : '规格待补齐，点击手动填写'
      }`}
      title={candidateMatchHint(match)}
      disabled={isToggling}
      onClick={onToggle}
      className={cx(
        'discovered-model-card tw:group tw:relative tw:flex tw:flex-col tw:justify-between tw:gap-2 tw:rounded-5 tw:p-3 tw:text-left tw:transition-all tw:duration-150 tw:cursor-pointer tw:outline-none tw:select-none tw:min-h-[118px] tw:w-full',
        'tw:focus-visible:ring-2 tw:focus-visible:ring-app-focus tw:focus-visible:ring-offset-1',
        isSelected
          ? 'tw:bg-app-accent-subtle/80 tw:border tw:border-app-accent tw:ring-1 tw:ring-app-accent tw:shadow-md tw:shadow-app-accent/20 dark:tw:shadow-app-accent/35'
          : 'tw:bg-app-panel tw:border tw:border-app-border-subtle tw:shadow-none tw:hover:border-app-border tw:hover:bg-app-hover/50 tw:hover:shadow-sm',
        isToggling && 'tw:opacity-70 tw:cursor-wait',
      )}
    >
      {/* 第一行：厂商和模型名称 */}
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-2 tw:min-w-0 tw:w-full">
        <div className="tw:flex tw:items-center tw:gap-2 tw:min-w-0 tw:flex-1">
          <span className="tw:inline-flex tw:size-4 tw:shrink-0 tw:items-center tw:justify-center">
            <ProviderIcon
              logoURL={logo}
              providerID={modelLogoURL(model.id, model.name) ? undefined : provider.providerID}
              className="tw:size-full"
              imageClassName="tw:object-contain tw:[.dark-theme_&]:invert tw:[.dark-theme_&]:hue-rotate-180"
              fallback={<Server className="tw:size-icon-sm" aria-hidden size={14} />}
            />
          </span>
          <span className="tw:truncate tw:type-2 tw:weight-medium tw:text-app-text" title={modelName}>
            {modelName}
          </span>
          <span className="tw:shrink-0 tw:rounded tw:bg-app-hover tw:px-1 tw:py-1 tw:type-1 tw:text-app-text-soft">
            {vendor}
          </span>
          <span
            className={cx(
              'tw:shrink-0 tw:rounded tw:px-1 tw:py-1 tw:type-1',
              importable
                ? 'tw:bg-app-accent-subtle tw:text-app-accent-fg'
                : 'tw:bg-app-hover tw:text-app-text-meta',
            )}
          >
            {matchLabel}
          </span>
        </div>

        <div className="tw:shrink-0">
          {isToggling ? (
            <span className="tw:inline-flex tw:items-center tw:gap-1 tw:rounded-full tw:bg-app-hover tw:px-2 tw:py-1 tw:type-1 tw:text-app-text-soft">
              <RefreshCw size="var(--inline-icon-size, 1em)" className="tw:animate-spin" />
              <span>保存中</span>
            </span>
          ) : isSelected ? (
            <span className="tw:inline-flex tw:items-center tw:gap-1 tw:rounded-full tw:bg-app-hover tw:text-app-text tw:px-2 tw:py-1 tw:type-1 tw:shadow-sm">
              <Check size="var(--inline-icon-size, 1em)" strokeWidth={2.5} />
              <span>已添加</span>
            </span>
          ) : (
            <span className="tw:inline-flex tw:items-center tw:gap-1 tw:rounded-full tw:border tw:border-dashed tw:border-app-border-subtle tw:px-2 tw:py-1 tw:type-1 tw:text-app-text-meta tw:group-hover:border-app-border tw:group-hover:text-app-text-soft">
              <Plus size="var(--inline-icon-size, 1em)" />
              <span>未添加</span>
            </span>
          )}
        </div>
      </div>

      <span className="tw:truncate tw:font-mono tw:type-1 tw:text-app-text-meta tw:w-full" title={model.id}>{model.id}</span>
      {model.catalog?.status && <span>{model.catalog.status}</span>}
      {/* 第二行：模型的信息，例如视觉，推理等 */}
      <div className="tw:flex tw:items-center tw:gap-1 tw:flex-wrap tw:min-h-5">
        {capabilities.slice(0, 4).map((cap) => {
          const Icon = cap.icon
          return (
            <span
              key={cap.key}
              className={cx(
                'tw:inline-flex tw:items-center tw:gap-1 tw:rounded tw:px-1 tw:py-1 tw:type-1',
                cap.badgeClass,
              )}
            >
              <Icon size={11} />
              <span>{cap.label}</span>
            </span>
          )
        })}
      </div>

      {capabilities.length > 4 && <span>+{capabilities.length - 4}</span>}
      {/* 第三行：模型的上下文长度 */}
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-2 tw:type-1 tw:text-app-text-soft tw:pt-1 tw:border-t tw:border-app-border-subtle/40">
        <div className="tw:flex tw:items-center tw:gap-1 tw:min-w-0">
          <Cpu size="var(--inline-icon-size, 1em)" className="tw:shrink-0 tw:text-app-text-meta" />
          <span>
            上下文长度:{' '}
            <strong className="tw:text-app-text">
              {contextWindow ? formatCompactNumber(contextWindow) : '未知'}
            </strong>
            {' · '}最大输出:{' '}
            <strong className="tw:text-app-text">{model.maxTokens ? formatCompactNumber(model.maxTokens) : '未知'}</strong>
          </span>
        </div>
      </div>
      <span className="tw:type-1 tw:text-app-text-soft">输入 {modelPrice(model.cost?.input)} / 输出 {modelPrice(model.cost?.output)} · USD / 百万 tokens{model.catalog?.priceSource?.kind === 'reference' ? ' · 原厂参考价' : model.catalog?.priceSource ? ' · 供应商价格' : ''}</span>
    </button>
    {onExpand && <button type="button" aria-expanded={expanded === true} onClick={onExpand} className="tw:py-2 tw:text-app-accent-fg tw:type-1">{expanded ? '收起详情' : '查看详情'}</button>}
    {expanded && <ModelCatalogDetails model={model} current={current} />}
    </div>
  )
}
