import { CheckCheck, Filter, Minus, Plus, RefreshCw } from 'lucide-react'
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
import { cx } from '../../../utils/Cx.js'
import {
  SYNC_CAPABILITY_FILTER_OPTIONS,
  resolveModelCapabilities,
  type SyncStatusFilter,
} from './ModelSyncHelpers.js'
import { ProviderModelListRow } from './ProviderModelListRow.js'

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
                    DesktopProviderModelDefinition | undefined
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
  const modelName = model.name || model.id

  return (
    <ProviderModelListRow
      model={model}
      providerID={provider.providerID}
      logoURL={provider.logoURL}
      metadata={metadata}
      expanded={expanded}
      current={current}
      unknownContextLabel="默认 128K"
      unknownMaxTokensLabel="默认 8K"
      onToggleExpand={onToggleExpand}
      className={cx(
        'discovered-model-row',
        isAdded
          ? 'tw:bg-app-success/10 tw:hover:bg-app-success/15'
          : expanded
            ? 'tw:bg-app-hover/60'
            : 'tw:bg-transparent tw:hover:bg-app-hover',
        isToggling && 'tw:opacity-70',
      )}
      actions={
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
              <Minus
                className="tw:size-icon-sm tw:text-app-success-fg"
                aria-hidden
                size={APP_ICON_SIZES.sm}
              />
            ) : (
              <Plus
                className="tw:size-icon-sm tw:text-app-text-soft"
                aria-hidden
                size={APP_ICON_SIZES.sm}
              />
            )}
          </Button>
        </Tooltip>
      }
    />
  )
}
