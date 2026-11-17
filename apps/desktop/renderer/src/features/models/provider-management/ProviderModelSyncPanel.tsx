import {
  CheckCheck,
  Filter,
  Minus,
  Plus,
  RefreshCw,
  Server,
} from 'lucide-react'
import type React from 'react'
import { useMemo } from 'react'
import type {
  DesktopModelMetadata,
  DesktopModelProviderSummary,
  DesktopProviderModelDefinition,
} from '../../../../shared/Types.js'
import { Button } from '../../../components/ui/Button.js'
import { Dropdown } from '../../../components/ui/Dropdown.js'
import { APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'
import {
  PopoverCheckboxItem,
  PopoverGroup,
  PopoverItem,
  PopoverLabel,
  PopoverRadioGroup,
  PopoverRadioItem,
  PopoverSeparator,
} from '../../../components/ui/PopoverItem.js'
import { SearchInput } from '../../../components/ui/SearchInput.js'
import { Tooltip } from '../../../components/ui/Tooltip.js'
import { modelLogoURL } from '../../../services/desktop-client/ModelLogo.js'
import { cx } from '../../../utils/Cx.js'
import { formatCompactNumber } from '../../../utils/UsageFormatters.js'
import { ProviderIcon } from '../ProviderIcon.js'
import { modelPrice } from './ModelCatalogDetails.js'
import {
  SYNC_CAPABILITY_FILTER_OPTIONS,
  resolveModelCapabilities,
  resolveModelContextWindow,
  type SyncStatusFilter,
} from './ModelSyncHelpers.js'

export type ProviderModelSyncPanelProps = {
  provider: DesktopModelProviderSummary
  discoveredModels: readonly DesktopProviderModelDefinition[] | null
  modelMetadata: Readonly<Record<string, DesktopModelMetadata>>
  addedModelIds: ReadonlySet<string>
  togglingModelIds: ReadonlySet<string>
  loading: boolean
  mutating: boolean
  error: string | null
  editingBlocked: boolean
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  statusFilter: SyncStatusFilter
  onStatusFilterChange: (next: SyncStatusFilter) => void
  capabilityFilters: ReadonlySet<string>
  onToggleCapabilityFilter: (key: string) => void
  onResetFilters: () => void
  filteredModels: readonly DesktopProviderModelDefinition[]
  expandedModelId: string | null
  onToggleExpand: (modelId: string) => void
  onRefresh: () => void
  onToggleModel: (model: DesktopProviderModelDefinition) => void
  onAddFilteredModels: () => void
}

export function ProviderModelSyncPanel({
  provider,
  discoveredModels,
  modelMetadata,
  addedModelIds,
  togglingModelIds,
  loading,
  mutating,
  error,
  editingBlocked,
  searchQuery,
  onSearchQueryChange,
  statusFilter,
  onStatusFilterChange,
  capabilityFilters,
  onToggleCapabilityFilter,
  onResetFilters,
  filteredModels,
  expandedModelId,
  onToggleExpand,
  onRefresh,
  onToggleModel,
  onAddFilteredModels,
}: ProviderModelSyncPanelProps): React.ReactNode {
  const totalCount = discoveredModels?.length ?? 0
  const addedCount = useMemo(
    () => (discoveredModels ?? []).filter((model) => addedModelIds.has(model.id)).length,
    [discoveredModels, addedModelIds],
  )
  const unaddedCount = totalCount - addedCount
  const addableFilteredCount = useMemo(
    () => filteredModels.filter((model) => !addedModelIds.has(model.id)).length,
    [filteredModels, addedModelIds],
  )
  const capabilityCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const option of SYNC_CAPABILITY_FILTER_OPTIONS) {
      counts[option.key] = 0
    }
    for (const model of discoveredModels ?? []) {
      const caps = resolveModelCapabilities(model, modelMetadata[model.id])
      for (const cap of caps) {
        if (cap.key in counts) {
          counts[cap.key] = (counts[cap.key] ?? 0) + 1
        }
      }
    }
    return counts
  }, [discoveredModels, modelMetadata])

  const activeFilterCount = (statusFilter !== 'all' ? 1 : 0) + capabilityFilters.size

  return (
    <section
      aria-label="同步模型"
      className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:overflow-hidden"
    >
      <header className="tw:flex tw:shrink-0 tw:items-center tw:justify-between tw:gap-2 tw:border-b tw:border-app-border-subtle tw:px-3 tw:py-2">
        <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
          <h3 className="tw:m-0 tw:truncate tw:type-2 tw:weight-bold tw:text-app-text">
            {provider.displayName} 模型
          </h3>
          <span className="tw:inline-flex tw:h-[20px] tw:min-w-[20px] tw:shrink-0 tw:items-center tw:justify-center tw:rounded-full tw:border tw:border-app-border-subtle tw:bg-app-control tw:px-2 tw:type-1 tw:tabular-nums tw:text-app-text-soft">
            {totalCount}
          </span>
        </div>
        <div className="tw:flex tw:shrink-0 tw:items-center tw:gap-1">
          <Tooltip content="刷新模型目录">
            <Button
              color="ghostSecondary"
              isIconOnly
              size="toolbar"
              aria-label="刷新模型目录"
              disabled={loading || mutating}
              onClick={onRefresh}
            >
              <RefreshCw
                className={cx('tw:size-icon-sm', loading && 'tw:animate-spin')}
                aria-hidden
                size={APP_ICON_SIZES.sm}
              />
            </Button>
          </Tooltip>
          <Button
            color="secondary"
            size="sm"
            disabled={loading || mutating || editingBlocked || addableFilteredCount === 0}
            title="添加当前筛选结果中全部未添加的模型"
            onClick={onAddFilteredModels}
          >
            <CheckCheck className="tw:size-icon-sm" aria-hidden size={APP_ICON_SIZES.sm} />
            添加全部模型
          </Button>
        </div>
      </header>

      <div className="tw:flex tw:shrink-0 tw:flex-col tw:gap-2 tw:border-b tw:border-app-border-subtle tw:px-3 tw:py-2">
        <div className="tw:flex tw:items-center tw:gap-2">
          <SearchInput
            aria-label="搜索候选模型"
            placeholder="搜索模型..."
            value={searchQuery}
            onChange={onSearchQueryChange}
            variant="outlined"
            size="sm"
            className="tw:min-w-0 tw:flex-1"
          />
          <Dropdown
            align="end"
            size="md"
            trigger={
              <Button
                isIconOnly
                color={activeFilterCount > 0 ? 'accentSubtle' : 'secondary'}
                size="sm"
                aria-label={
                  activeFilterCount > 0 ? `筛选模型（已选 ${activeFilterCount} 项）` : '筛选模型'
                }
                title={
                  activeFilterCount > 0
                    ? `筛选模型（已启用 ${activeFilterCount} 项筛选）`
                    : '按添加状态与模型能力筛选'
                }
              >
                <Filter className="tw:size-icon-sm" aria-hidden size={APP_ICON_SIZES.sm} />
              </Button>
            }
          >
            <PopoverGroup>
              <PopoverLabel>添加状态</PopoverLabel>
              <PopoverRadioGroup
                value={statusFilter}
                onValueChange={(value) => onStatusFilterChange(value as SyncStatusFilter)}
              >
                <PopoverRadioItem value="all">全部 ({totalCount})</PopoverRadioItem>
                <PopoverRadioItem value="unadded">未添加 ({unaddedCount})</PopoverRadioItem>
                <PopoverRadioItem value="added">已添加 ({addedCount})</PopoverRadioItem>
              </PopoverRadioGroup>
            </PopoverGroup>
            <PopoverSeparator />
            <PopoverGroup>
              <PopoverLabel>模型能力</PopoverLabel>
              {SYNC_CAPABILITY_FILTER_OPTIONS.map((option) => (
                <PopoverCheckboxItem
                  key={option.key}
                  keepOpen
                  checked={capabilityFilters.has(option.key)}
                  onCheckedChange={() => onToggleCapabilityFilter(option.key)}
                  meta={`${capabilityCounts[option.key] ?? 0} 个`}
                >
                  {option.label} ({capabilityCounts[option.key] ?? 0})
                </PopoverCheckboxItem>
              ))}
            </PopoverGroup>
            {activeFilterCount > 0 ? (
              <>
                <PopoverSeparator />
                <PopoverItem onClick={onResetFilters}>重置筛选</PopoverItem>
              </>
            ) : null}
          </Dropdown>
        </div>

        {editingBlocked ? (
          <p
            role="status"
            className="tw:m-0 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-hover tw:px-3 tw:py-2 tw:text-app-text-soft tw:type-1"
          >
            连接配置有未保存修改，请先保存或还原后再添加/移除模型。
          </p>
        ) : null}
      </div>

      <div className="tw:min-h-0 tw:flex-1 tw:overflow-y-auto tw:p-3">
        {loading && !discoveredModels?.length ? (
          <div className="tw:flex tw:items-center tw:justify-center tw:gap-2 tw:py-8 tw:text-app-text-soft tw:type-1">
            <RefreshCw className="tw:size-icon-sm tw:animate-spin" aria-hidden size={14} />
            <span role="status">正在获取模型目录…</span>
          </div>
        ) : error && !discoveredModels?.length ? (
          <div className="tw:flex tw:flex-col tw:items-center tw:gap-2 tw:px-3 tw:py-8 tw:text-center">
            <p role="alert" className="tw:m-0 tw:text-app-danger tw:type-1">
              {error}
            </p>
            <Button size="sm" color="outline" onClick={onRefresh}>
              重试
            </Button>
          </div>
        ) : discoveredModels?.length === 0 ? (
          <p className="tw:py-8 tw:text-center tw:text-app-text-soft tw:type-1">
            远端目录没有模型。
          </p>
        ) : filteredModels.length === 0 ? (
          <div className="tw:flex tw:flex-col tw:items-center tw:gap-2 tw:py-8 tw:text-center">
            <p className="tw:m-0 tw:text-app-text-soft tw:type-1">未找到匹配的模型。</p>
            {activeFilterCount > 0 || searchQuery ? (
              <Button
                size="sm"
                color="ghostSecondary"
                onClick={() => {
                  onSearchQueryChange('')
                  onResetFilters()
                }}
              >
                清除搜索与筛选
              </Button>
            ) : null}
          </div>
        ) : (
          <div
            className="tw:overflow-hidden tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-panel"
            role="list"
            aria-label="远端候选模型列表"
          >
            {filteredModels.map((model) => (
              <DiscoveredModelRow
                key={model.id}
                model={model}
                provider={provider}
                metadata={modelMetadata[model.id]}
                isAdded={addedModelIds.has(model.id)}
                isToggling={togglingModelIds.has(model.id)}
                disabled={editingBlocked}
                expanded={expandedModelId === model.id}
                current={
                  provider.config?.models.find((entry) => entry.id === model.id) as
                    | DesktopProviderModelDefinition
                    | undefined
                }
                onToggleExpand={() => onToggleExpand(model.id)}
                onToggleModel={() => onToggleModel(model)}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="tw:shrink-0 tw:border-t tw:border-app-border-subtle tw:bg-app-panel/60 tw:px-3 tw:py-2 tw:text-center tw:text-app-text-meta tw:type-1">
        点击行展开详情 · 点击右侧 + / - 添加或移除模型
      </footer>
    </section>
  )
}

export type DiscoveredModelRowProps = {
  model: DesktopProviderModelDefinition
  provider: DesktopModelProviderSummary
  metadata?: DesktopModelMetadata
  isAdded: boolean
  isToggling: boolean
  disabled?: boolean
  expanded: boolean
  current?: DesktopProviderModelDefinition
  onToggleExpand: () => void
  onToggleModel: () => void
}

export function DiscoveredModelRow({
  model,
  provider,
  metadata,
  isAdded,
  isToggling,
  disabled = false,
  expanded,
  current,
  onToggleExpand,
  onToggleModel,
}: DiscoveredModelRowProps): React.ReactNode {
  const capabilities = resolveModelCapabilities(model, metadata)
  const contextWindow = resolveModelContextWindow(model, metadata)
  const modelName = model.name || model.id
  const logo = modelLogoURL(model.id, model.name) ?? provider.logoURL
  const catalog = model.catalog
  const price = model.cost
  const hasCachePrice = price?.cacheRead !== undefined || price?.cacheWrite !== undefined
  const nonTextOutputs = (catalog?.output ?? []).filter((item) => item !== 'text')
  const reasoningControls = [
    ...(catalog?.reasoningOptions?.length
      ? catalog.reasoningOptions.map((option) =>
          option.type === 'toggle'
            ? '开关'
            : option.type === 'effort'
              ? option.values?.map((value) => (value === null ? '默认' : value)).join(' · ') || ''
              : `预算 ${option.min ?? 0}~${option.max ?? '∞'}`,
        )
      : []),
    ...(model.optionSpecs?.reasoningLevel?.values?.length
      ? [model.optionSpecs.reasoningLevel.values.join(' · ')]
      : []),
  ].filter(Boolean)
  const configDifferences = current
    ? [
        ['上下文', current.contextWindow, model.contextWindow],
        ['最大输入', current.maxInputTokens, model.maxInputTokens],
        ['最大输出', current.maxTokens, model.maxTokens],
        ['输入价', current.cost?.input, price?.input],
        ['输出价', current.cost?.output, price?.output],
      ].filter(
        ([, saved, recommended]) =>
          saved !== undefined && recommended !== undefined && saved !== recommended,
      )
    : []
  const supportsPdfNote = (catalog?.input ?? model.input)?.includes('pdf')
  const extraPriceParts = [
    catalog?.reasoningCost !== undefined ? `推理 ${modelPrice(catalog.reasoningCost)}` : null,
    catalog?.inputAudioCost !== undefined ? `音频入 ${modelPrice(catalog.inputAudioCost)}` : null,
    catalog?.outputAudioCost !== undefined ? `音频出 ${modelPrice(catalog.outputAudioCost)}` : null,
  ].filter(Boolean)

  return (
    <div
      role="listitem"
      className={cx(
        'discovered-model-row tw:border-b tw:border-app-border-subtle tw:last:border-b-0 tw:transition-colors tw:duration-100',
        isAdded
          ? 'tw:bg-app-success/10 tw:hover:bg-app-success/15'
          : expanded
            ? 'tw:bg-app-hover/60'
            : 'tw:bg-transparent tw:hover:bg-app-hover',
        isToggling && 'tw:opacity-70',
      )}
    >
      <div className="tw:flex tw:min-h-[36px] tw:min-w-0 tw:items-center tw:gap-2 tw:px-3 tw:py-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? `收起 ${modelName} 详情` : `展开 ${modelName} 详情`}
          title={model.id}
          onClick={onToggleExpand}
          className="tw:flex tw:min-w-0 tw:flex-1 tw:items-center tw:justify-between tw:gap-2 tw:rounded-2 tw:border-0 tw:bg-transparent tw:px-0 tw:py-1 tw:text-left tw:cursor-pointer tw:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-app-focus"
        >
          <div className="tw:flex tw:min-w-0 tw:flex-1 tw:items-center tw:gap-2">
            <span className="tw:inline-flex tw:size-4 tw:shrink-0 tw:items-center tw:justify-center">
              <ProviderIcon
                logoURL={logo}
                providerID={modelLogoURL(model.id, model.name) ? undefined : provider.providerID}
                className="tw:size-full"
                imageClassName="tw:object-contain tw:[.dark-theme_&]:invert tw:[.dark-theme_&]:hue-rotate-180"
                fallback={<Server className="tw:size-icon-sm" aria-hidden size={14} />}
              />
            </span>
            <span className="tw:min-w-0 tw:truncate tw:type-2 tw:weight-medium tw:text-app-text">
              {modelName}
            </span>
          </div>

          <div className="tw:flex tw:shrink-0 tw:items-center tw:gap-1">
            {capabilities.slice(0, 3).map((cap) => {
              const Icon = cap.icon
              return (
                <Tooltip key={cap.key} content={cap.label}>
                  <span
                    aria-label={cap.label}
                    className={cx(
                      'tw:inline-flex tw:size-[20px] tw:items-center tw:justify-center tw:rounded-full',
                      cap.badgeClass,
                    )}
                  >
                    <Icon size={11} />
                  </span>
                </Tooltip>
              )
            })}
            {capabilities.length > 3 ? (
              <span className="tw:px-1 tw:text-app-text-meta tw:type-1 tw:tabular-nums">
                +{capabilities.length - 3}
              </span>
            ) : null}
          </div>
        </button>

        <Tooltip content={isAdded ? '从模型列表移除' : '添加到模型列表'}>
          <Button
            color="ghostSecondary"
            isIconOnly
            size="toolbar"
            aria-label={isAdded ? `移除模型 ${modelName}` : `添加模型 ${modelName}`}
            disabled={isToggling || disabled}
            loading={isToggling}
            onClick={onToggleModel}
          >
            {isAdded ? (
              <Minus className="tw:size-icon-sm tw:text-app-success-fg" aria-hidden size={APP_ICON_SIZES.sm} />
            ) : (
              <Plus className="tw:size-icon-sm tw:text-app-text-soft" aria-hidden size={APP_ICON_SIZES.sm} />
            )}
          </Button>
        </Tooltip>
      </div>

      {expanded ? (
        <div className="tw:grid tw:gap-2 tw:border-t tw:border-app-border-subtle tw:bg-app-canvas/60 tw:p-3 tw:type-1 tw:text-app-text-soft">
          <div className="tw:grid tw:grid-cols-2 tw:gap-2">
            <div className="tw:grid tw:content-start tw:gap-1 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-panel tw:p-2">
              <span className="tw:text-app-text-meta">上下文 / 最大输出</span>
              <span className="tw:weight-medium tw:text-app-text tw:tabular-nums">
                {contextWindow ? formatCompactNumber(contextWindow) : '默认 128K'}
                {' / '}
                {model.maxTokens ? formatCompactNumber(model.maxTokens) : '默认 8K'}
              </span>
              {model.maxInputTokens !== undefined && model.maxInputTokens !== contextWindow ? (
                <span className="tw:text-app-text-meta tw:tabular-nums">
                  最大输入 {formatCompactNumber(model.maxInputTokens)}
                </span>
              ) : null}
            </div>

            <div className="tw:grid tw:content-start tw:gap-1 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-panel tw:p-2">
              <span className="tw:truncate tw:text-app-text-meta">
                价格 · $/M
                {catalog?.priceSource?.kind === 'reference'
                  ? ' · 原厂参考价'
                  : catalog?.priceSource
                    ? ' · 供应商价格'
                    : ''}
              </span>
              <span className="tw:weight-medium tw:text-app-text tw:tabular-nums">
                输入 {modelPrice(price?.input)} / 输出 {modelPrice(price?.output)}
              </span>
              {hasCachePrice ? (
                <span className="tw:text-app-text-meta tw:tabular-nums">
                  {[
                    price?.cacheRead !== undefined ? `缓存读 ${modelPrice(price.cacheRead)}` : null,
                    price?.cacheWrite !== undefined
                      ? `缓存写 ${modelPrice(price.cacheWrite)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              ) : null}
            </div>
          </div>

          <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-1">
            {capabilities.map((cap) => {
              const Icon = cap.icon
              return (
                <span
                  key={cap.key}
                  className={cx(
                    'tw:inline-flex tw:items-center tw:gap-1 tw:rounded-2 tw:px-2 tw:py-1',
                    cap.badgeClass,
                  )}
                >
                  <Icon size={11} />
                  <span>{cap.label}</span>
                </span>
              )
            })}
            {catalog?.temperature ? (
              <span className="tw:rounded-2 tw:bg-app-hover tw:px-2 tw:py-1 tw:text-app-text-soft">
                温度调节
              </span>
            ) : null}
            {nonTextOutputs.length > 0 ? (
              <span className="tw:rounded-2 tw:bg-app-hover tw:px-2 tw:py-1 tw:text-app-text-soft">
                输出 {nonTextOutputs.join(' / ')}
              </span>
            ) : null}
          </div>

          {reasoningControls.length > 0 ||
          price?.tiers?.length ||
          extraPriceParts.length > 0 ||
          configDifferences.length > 0 ||
          supportsPdfNote ? (
            <div className="tw:overflow-hidden tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-panel">
              {reasoningControls.length > 0 ? (
                <div className="tw:flex tw:items-baseline tw:justify-between tw:gap-3 tw:border-b tw:border-app-border-subtle tw:last:border-b-0 tw:px-2 tw:py-2">
                  <span className="tw:shrink-0 tw:text-app-text-meta">推理控制</span>
                  <span className="tw:min-w-0 tw:text-right tw:type-code tw:text-app-text">
                    {reasoningControls.join(' · ')}
                  </span>
                </div>
              ) : null}
              {price?.tiers?.map((tier) => (
                <div
                  key={tier.inputTokensAbove}
                  className="tw:flex tw:items-baseline tw:justify-between tw:gap-3 tw:border-b tw:border-app-border-subtle tw:last:border-b-0 tw:px-2 tw:py-2 tw:tabular-nums"
                >
                  <span className="tw:shrink-0 tw:text-app-text-meta">
                    &gt; {formatCompactNumber(tier.inputTokensAbove)} 阶梯价
                  </span>
                  <span className="tw:min-w-0 tw:text-right tw:text-app-text">
                    {[
                      `入 ${modelPrice(tier.input)}`,
                      `出 ${modelPrice(tier.output)}`,
                      tier.cacheRead !== undefined ? `读 ${modelPrice(tier.cacheRead)}` : null,
                      tier.cacheWrite !== undefined ? `写 ${modelPrice(tier.cacheWrite)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
              ))}
              {extraPriceParts.length > 0 ? (
                <div className="tw:flex tw:items-baseline tw:justify-between tw:gap-3 tw:border-b tw:border-app-border-subtle tw:last:border-b-0 tw:px-2 tw:py-2 tw:tabular-nums">
                  <span className="tw:shrink-0 tw:text-app-text-meta">附加参考价</span>
                  <span className="tw:min-w-0 tw:text-right tw:text-app-text-soft">
                    {extraPriceParts.join(' · ')}
                  </span>
                </div>
              ) : null}
              {configDifferences.length > 0 ? (
                <div className="tw:flex tw:items-baseline tw:justify-between tw:gap-3 tw:border-b tw:border-app-border-subtle tw:last:border-b-0 tw:px-2 tw:py-2 tw:tabular-nums">
                  <span className="tw:shrink-0 tw:text-app-text-meta">当前 / 推荐</span>
                  <span className="tw:min-w-0 tw:text-right tw:text-app-text">
                    {configDifferences
                      .map(([label, saved, recommended]) => `${label} ${saved}→${recommended}`)
                      .join(' · ')}
                  </span>
                </div>
              ) : null}
              {supportsPdfNote ? (
                <div className="tw:bg-app-warning/10 tw:px-2 tw:py-2 tw:text-app-warning-fg">
                  目录支持 PDF；当前客户端暂未支持原生发送。
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
