import {
  Activity,
  RefreshCw,
  Pencil,
  Plus,
  Minus,
  Brain,
  Eye,
  Wrench,
  Server,
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
import { Tooltip } from '../../../components/ui/Tooltip.js'
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
import { isImportableCandidate, resolveCandidateImportModel } from './ModelCandidateImport.js'
import { ProviderModelSpecRepairDialog } from './ProviderModelSpecRepairDialog.js'
import {
  editableModel,
  normalizeEditableModel,
  resolveDiscoveryChatApi,
} from './ProviderEditorForm.js'
import { ConfirmationDialog } from '../../../components/ui/ConfirmationDialog.js'
import { desktopClient } from '../../../services/desktop-client/index.js'
import { cx } from '../../../utils/Cx.js'
import { ProviderModelSyncPanel } from './ProviderModelSyncPanel.js'
import { filterDiscoveredModels, type SyncStatusFilter } from './ModelSyncHelpers.js'

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
}

function buildUpdatedDefinition(
  currentConfig: DesktopProviderDefinition,
  options: {
    add?: readonly {
      model: DesktopProviderModelDefinition
      match?: DesktopProviderModelMatch
      metadata?: DesktopModelMetadata
    }[]
    removeIds?: readonly string[]
  },
): DesktopProviderDefinition {
  type BrandedModelId = DesktopProviderModelDefinition['id']
  const removeSet = new Set(options.removeIds ?? [])
  const addItems = options.add ?? []
  const addIds = new Set(addItems.map((item) => item.model.id))

  if (currentConfig.kind === 'custom') {
    const resolvedAdded = addItems.map(({ model, metadata }) =>
      resolveCandidateImportModel(model, metadata),
    )
    return {
      ...currentConfig,
      models: [
        ...currentConfig.models.filter((m) => !removeSet.has(m.id) && !addIds.has(m.id)),
        ...resolvedAdded,
      ],
    }
  }

  const nextBuiltinAdditions = addItems.map(({ model, match, metadata }) => {
    if (isImportableCandidate(model, match)) {
      return { id: model.id, enabled: true }
    }
    const resolved = resolveCandidateImportModel(model, metadata)
    return {
      id: model.id,
      enabled: true,
      ...(model.name ? { name: model.name } : {}),
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(model.modelType ? { modelType: model.modelType } : {}),
      contextWindow: resolved.contextWindow,
      maxTokens: resolved.maxTokens,
      input: resolved.input,
      tools: resolved.tools,
    }
  })

  const filteredModels = currentConfig.models
    .filter((m) => !addIds.has(m.id))
    .map((m) => (removeSet.has(m.id) ? { ...m, enabled: false } : m))

  return {
    ...currentConfig,
    models: [...filteredModels, ...nextBuiltinAdditions],
    denyModels: [
      ...new Set([
        ...currentConfig.denyModels.filter((id) => !addIds.has(id)),
        ...(Array.from(removeSet) as BrandedModelId[]),
      ]),
    ],
    allowModels: [
      ...new Set([
        ...currentConfig.allowModels.filter((id) => !removeSet.has(id)),
        ...(Array.from(addIds) as BrandedModelId[]),
      ]),
    ],
  }
}

export function ProviderModelsSection({
  provider,
  editingBlocked = false,
  models,
  modelMetadata = {},
  busy,
  testResults,
  onTestModels,
  onSaveDefinition,
  onRefresh,
  onNotice,
  onError,
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
  const [syncLoading, setSyncLoading] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [specRepairOpen, setSpecRepairOpen] = useState(false)
  const [optimisticAdded, setOptimisticAdded] = useState<Readonly<Record<string, boolean>>>({})
  const [togglingModelIds, setTogglingModelIds] = useState<Set<string>>(new Set())
  const [syncSearchQuery, setSyncSearchQuery] = useState('')
  const [syncStatusFilter, setSyncStatusFilter] = useState<SyncStatusFilter>('all')
  const [syncCapabilityFilters, setSyncCapabilityFilters] = useState<Set<string>>(new Set())
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null)
  const pendingConfigRef = useRef<DesktopProviderDefinition | null>(null)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const executable = isExecutableDesktopProvider(provider)
  const editable = provider.config != null

  useEffect(() => {
    if (provider.config && togglingModelIds.size === 0) {
      pendingConfigRef.current = provider.config
    }
  }, [provider.config, togglingModelIds.size])

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

  const effectiveAddedIds = useMemo(() => {
    const next = new Set(rows.map((row) => row.id))
    for (const [id, added] of Object.entries(optimisticAdded)) {
      if (added) next.add(id)
      else next.delete(id)
    }
    return next
  }, [rows, optimisticAdded])

  const filteredDiscoveredModels = useMemo(
    () =>
      filterDiscoveredModels(discoveredModels ?? [], {
        query: syncSearchQuery,
        statusFilter: syncStatusFilter,
        capabilityFilters: syncCapabilityFilters,
        addedIds: effectiveAddedIds,
        provider,
        modelMetadata,
      }),
    [
      discoveredModels,
      syncSearchQuery,
      syncStatusFilter,
      syncCapabilityFilters,
      effectiveAddedIds,
      provider,
      modelMetadata,
    ],
  )

  async function fetchModels() {
    if (syncLoading) return
    setSyncLoading(true)
    setSyncError(null)
    try {
      const result = await desktopClient.discoverProviderModels({
        providerId: provider.providerID,
        api: resolveDiscoveryChatApi(customConfig?.models ?? []),
      })
      setDiscoveredModels([...result.models])
      setCandidateMatches(
        Object.fromEntries((result.matches ?? []).map((match) => [String(match.id), match])),
      )
      setExpandedModelId(null)
      if (togglingModelIds.size === 0) {
        pendingConfigRef.current = provider.config ?? null
      }
    } catch (error) {
      const message = toUserErrorMessage(error)
      setSyncError(message)
      onError(message)
    } finally {
      setSyncLoading(false)
    }
  }

  async function openSyncPanel() {
    if (saving || busy) return
    if (panel) {
      const opened = await panel.open(provider.providerID, 'sync')
      if (!opened) return
    }
    await fetchModels()
  }

  function enqueueModelMutation(options: {
    add?: readonly DesktopProviderModelDefinition[]
    removeIds?: readonly string[]
    noticeMessage: string
  }) {
    if (!provider.config || editingBlocked) return
    const addItems = (options.add ?? []).filter((m) => !effectiveAddedIds.has(m.id))
    const removeIds = (options.removeIds ?? []).filter((id) => effectiveAddedIds.has(id))
    if (addItems.length === 0 && removeIds.length === 0) return

    const mutatedIds = [...addItems.map((m) => m.id), ...removeIds]
    const previousConfig = pendingConfigRef.current ?? provider.config
    const nextConfig = buildUpdatedDefinition(previousConfig, {
      add: addItems.map((model) => ({
        model,
        match: candidateMatches[model.id],
        metadata: modelMetadata[model.id],
      })),
      removeIds,
    })

    pendingConfigRef.current = nextConfig
    setOptimisticAdded((prev) => {
      const next = { ...prev }
      for (const m of addItems) next[m.id] = true
      for (const id of removeIds) next[id] = false
      return next
    })
    setTogglingModelIds((prev) => {
      const next = new Set(prev)
      for (const id of mutatedIds) next.add(id)
      return next
    })

    saveChainRef.current = saveChainRef.current
      .then(async () => {
        await onSaveDefinition(nextConfig, provider.providerID)
        await onRefresh()
        onNotice(options.noticeMessage)
      })
      .catch((error) => {
        pendingConfigRef.current = provider.config ?? null
        onError(toUserErrorMessage(error))
      })
      .finally(() => {
        setOptimisticAdded((prev) => {
          const next = { ...prev }
          for (const id of mutatedIds) delete next[id]
          return next
        })
        setTogglingModelIds((prev) => {
          const next = new Set(prev)
          for (const id of mutatedIds) next.delete(id)
          return next
        })
      })
  }

  function toggleModel(model: DesktopProviderModelDefinition) {
    if (togglingModelIds.has(model.id) || editingBlocked) return
    const isAdded = effectiveAddedIds.has(model.id)
    if (isAdded) {
      enqueueModelMutation({
        removeIds: [model.id],
        noticeMessage: `已移除模型 ${model.name ?? model.id}。`,
      })
    } else {
      enqueueModelMutation({
        add: [model],
        noticeMessage: `已添加模型 ${model.name ?? model.id}。`,
      })
    }
  }

  function addFilteredModels() {
    if (editingBlocked) return
    const toAdd = filteredDiscoveredModels.filter((model) => !effectiveAddedIds.has(model.id))
    if (toAdd.length === 0) {
      onNotice('当前筛选结果中的模型已全部添加。')
      return
    }
    const noticeMessage =
      toAdd.length === 1
        ? `已添加模型 ${toAdd[0]!.name ?? toAdd[0]!.id}。`
        : `已添加 ${toAdd.length} 个模型。`
    enqueueModelMutation({ add: toAdd, noticeMessage })
  }

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
    setEditingModel({
      version: ++modelEditorVersion.current,
      model: creating ? { ...model, enabled: true } : model,
      creating,
      ...(nativeApi ? { nativeApi } : {}),
    })
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
    setEditingModel((current) => (current ? { ...current, model, creating: false } : null))
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
    <section className="model-center-models-section tw:grid tw:min-w-0 tw:gap-3" aria-label="模型列表">
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
              busy ||
              saving ||
              syncLoading ||
              editingBlocked ||
              provider.availability?.status === 'unavailable'
            }
            onClick={() => void openSyncPanel()}
          >
            <RefreshCw
              className={cx('tw:size-icon-sm', syncLoading && 'tw:animate-spin')}
              aria-hidden
              size={APP_ICON_SIZES.sm}
            />
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
            providerID={modelLogoURL(row.id, row.metadata?.name) ? undefined : provider.providerID}
          />
        ))}
        {filtered.length === 0 ? (
          <p className="tw:px-3 tw:py-4 tw:text-app-text-soft tw:type-1">
            {rows.length === 0 ? '尚无模型，请同步目录或添加模型。' : '未找到匹配的模型。'}
          </p>
        ) : null}
      </div>
      {editingModel &&
      panel?.host &&
      panel.tab?.providerId === provider.providerID &&
      panel.tab.section === 'model'
        ? createPortal(
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
          )
        : null}
      {panel?.host &&
      panel.tab?.providerId === provider.providerID &&
      panel.tab.section === 'sync'
        ? createPortal(
            <ProviderModelSyncPanel
              provider={provider}
              discoveredModels={discoveredModels}
              modelMetadata={modelMetadata}
              addedModelIds={effectiveAddedIds}
              togglingModelIds={togglingModelIds}
              loading={syncLoading}
              mutating={togglingModelIds.size > 0 || saving || busy}
              error={syncError}
              editingBlocked={editingBlocked}
              searchQuery={syncSearchQuery}
              onSearchQueryChange={setSyncSearchQuery}
              statusFilter={syncStatusFilter}
              onStatusFilterChange={setSyncStatusFilter}
              capabilityFilters={syncCapabilityFilters}
              onToggleCapabilityFilter={(key) => {
                setSyncCapabilityFilters((prev) => {
                  const next = new Set(prev)
                  if (next.has(key)) next.delete(key)
                  else next.add(key)
                  return next
                })
              }}
              onResetFilters={() => {
                setSyncStatusFilter('all')
                setSyncCapabilityFilters(new Set())
              }}
              filteredModels={filteredDiscoveredModels}
              expandedModelId={expandedModelId}
              onToggleExpand={(id) => setExpandedModelId((prev) => (prev === id ? null : id))}
              onRefresh={() => void fetchModels()}
              onToggleModel={toggleModel}
              onAddFilteredModels={addFilteredModels}
            />,
            panel.host,
          )
        : null}
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
  const hasCapabilities = Boolean(metadata?.reasoning || metadata?.vision || metadata?.toolCall)
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
      <div className="tw:flex tw:shrink-0 tw:items-center tw:gap-4">
        {hasCapabilities ? (
          <div
            role="group"
            aria-label="模型功能"
            className="tw:flex tw:shrink-0 tw:items-center tw:gap-1 tw:text-app-text-soft"
          >
            {metadata?.reasoning ? (
              <Tooltip content="推理">
                <span
                  role="img"
                  aria-label="推理"
                  className="tw:inline-flex tw:size-5 tw:items-center tw:justify-center"
                >
                  <Brain className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
                </span>
              </Tooltip>
            ) : null}
            {metadata?.vision ? (
              <Tooltip content="图片输入">
                <span
                  role="img"
                  aria-label="图片输入"
                  className="tw:inline-flex tw:size-5 tw:items-center tw:justify-center"
                >
                  <Eye className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
                </span>
              </Tooltip>
            ) : null}
            {metadata?.toolCall ? (
              <Tooltip content="工具调用">
                <span
                  role="img"
                  aria-label="工具调用"
                  className="tw:inline-flex tw:size-5 tw:items-center tw:justify-center"
                >
                  <Wrench className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
                </span>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
        <div
          role="group"
          aria-label="模型操作"
          className="tw:flex tw:shrink-0 tw:items-center tw:gap-1 tw:text-app-text-soft"
        >
          {testStatus?.state === 'reachable' ? (
            <span role="status" className="tw:px-1.5 tw:text-app-success tw:type-1">
              {testStatus.api ? `${testStatus.api} · ` : ''}
              {testStatus.latencyMs} ms
            </span>
          ) : testStatus?.state === 'failed' ? (
            <Tooltip
              content={`${testStatus.message}${testStatus.category ? ` · ${testStatus.category}` : ''}`}
            >
              <span role="status" className="tw:px-1.5 tw:text-app-danger tw:type-1">
                失败
              </span>
            </Tooltip>
          ) : null}
          <Tooltip content="测试模型">
            <Button
              color="ghostSecondary"
              isIconOnly
              size="toolbar"
              disabled={disabled}
              aria-label={`测试模型 ${modelId}`}
              loading={testStatus?.state === 'testing'}
              onClick={onTest}
            >
              <Activity className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
            </Button>
          </Tooltip>
          <Tooltip content="模型设置">
            <Button
              color="ghostSecondary"
              isIconOnly
              size="toolbar"
              aria-label={`模型设置 ${modelId}`}
              disabled={editingDisabled}
              onClick={onEdit}
            >
              <Pencil className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
            </Button>
          </Tooltip>
          <Tooltip content="移除模型">
            <Button
              color="ghostSecondary"
              isIconOnly
              size="toolbar"
              aria-label={`移除模型 ${modelId}`}
              disabled={editingDisabled}
              onClick={onRemove}
            >
              <Minus className="tw:size-icon-md" aria-hidden size={APP_ICON_SIZE} />
            </Button>
          </Tooltip>
        </div>
      </div>
    </article>
  )
}
