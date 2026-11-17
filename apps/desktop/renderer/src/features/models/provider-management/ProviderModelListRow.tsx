import { Server } from 'lucide-react'
import type React from 'react'
import type {
  DesktopModelMetadata,
  DesktopProviderModelDefinition,
} from '../../../../shared/Types.js'
import { Tooltip } from '../../../components/ui/Tooltip.js'
import { modelLogoURL } from '../../../services/desktop-client/ModelLogo.js'
import { cx } from '../../../utils/Cx.js'
import { formatCompactNumber } from '../../../utils/UsageFormatters.js'
import { ProviderIcon } from '../ProviderIcon.js'
import { modelPrice } from './ModelCatalogDetails.js'
import {
  resolveModelCapabilities,
  resolveModelContextWindow,
  type ModelCapability,
} from './ModelSyncHelpers.js'

export type ProviderModelListRowProps = {
  model: DesktopProviderModelDefinition
  providerID?: string
  logoURL?: string
  metadata?: DesktopModelMetadata
  expanded: boolean
  enabled?: boolean
  current?: DesktopProviderModelDefinition
  unknownContextLabel?: string
  unknownMaxTokensLabel?: string
  className?: string
  title?: string
  actions: React.ReactNode
  onToggleExpand: () => void
}

/** 渲染左右模型列表共用的单层紧凑模型行、能力徽章与展开详情。 */
export function ProviderModelListRow({
  model,
  providerID,
  logoURL,
  metadata,
  expanded,
  enabled = true,
  current,
  unknownContextLabel = '未知',
  unknownMaxTokensLabel = '未知',
  className,
  title,
  actions,
  onToggleExpand,
}: ProviderModelListRowProps): React.ReactNode {
  const capabilities = resolveModelCapabilities(model, metadata)
  const modelName = model.name || model.id
  const resolvedLogo = logoURL ?? modelLogoURL(model.id, model.name)
  const fallbackProvider =
    modelLogoURL(model.id, model.name) ? undefined : providerID

  return (
    <div
      role="listitem"
      className={cx(
        'tw:border-b tw:border-app-border-subtle tw:last:border-b-0 tw:transition-colors tw:duration-100',
        className,
      )}
    >
      <div
        className={cx(
          'tw:flex tw:min-h-[36px] tw:min-w-0 tw:items-center tw:gap-2 tw:px-3 tw:py-1',
          !enabled && 'tw:opacity-65',
        )}
      >
        <span className="tw:inline-flex tw:size-4 tw:shrink-0 tw:items-center tw:justify-center">
          <ProviderIcon
            logoURL={resolvedLogo}
            providerID={fallbackProvider}
            className="tw:size-full"
            imageClassName="tw:object-contain tw:[.dark-theme_&]:invert tw:[.dark-theme_&]:hue-rotate-180"
            fallback={<Server className="tw:size-icon-sm" aria-hidden size={14} />}
          />
        </span>

        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? `收起 ${modelName} 详情` : `展开 ${modelName} 详情`}
          title={title ?? model.id}
          onClick={onToggleExpand}
          className="tw:flex tw:min-w-0 tw:flex-1 tw:items-center tw:justify-between tw:gap-2 tw:rounded-2 tw:border-0 tw:bg-transparent tw:px-0 tw:py-1 tw:text-left tw:cursor-pointer tw:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-app-focus"
        >
          <span className="tw:min-w-0 tw:truncate tw:type-2 tw:weight-medium tw:text-app-text">
            {modelName}
          </span>

          <ModelCapabilityBadges capabilities={capabilities} />
        </button>

        {actions}
      </div>

      {expanded ? (
        <ModelExpandedDetails
          model={model}
          metadata={metadata}
          capabilities={capabilities}
          enabled={enabled}
          current={current}
          unknownContextLabel={unknownContextLabel}
          unknownMaxTokensLabel={unknownMaxTokensLabel}
        />
      ) : null}
    </div>
  )
}

function ModelCapabilityBadges({
  capabilities,
}: {
  capabilities: readonly ModelCapability[]
}): React.ReactNode {
  return (
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
  )
}

function ModelExpandedDetails({
  model,
  metadata,
  capabilities,
  enabled,
  current,
  unknownContextLabel,
  unknownMaxTokensLabel,
}: {
  model: DesktopProviderModelDefinition
  metadata?: DesktopModelMetadata
  capabilities: readonly ModelCapability[]
  enabled: boolean
  current?: DesktopProviderModelDefinition
  unknownContextLabel: string
  unknownMaxTokensLabel: string
}): React.ReactNode {
  const contextWindow = resolveModelContextWindow(model, metadata)
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
    <div className="tw:grid tw:gap-2 tw:border-t tw:border-app-border-subtle tw:bg-app-canvas/60 tw:p-3 tw:type-1 tw:text-app-text-soft">
      <div className="tw:grid tw:grid-cols-2 tw:gap-2">
        <div className="tw:grid tw:content-start tw:gap-1 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-panel tw:p-2">
          <span className="tw:text-app-text-meta">上下文 / 最大输出</span>
          <span className="tw:weight-medium tw:text-app-text tw:tabular-nums">
            {contextWindow ? formatCompactNumber(contextWindow) : unknownContextLabel}
            {' / '}
            {model.maxTokens ? formatCompactNumber(model.maxTokens) : unknownMaxTokensLabel}
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
                price?.cacheWrite !== undefined ? `缓存写 ${modelPrice(price.cacheWrite)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          ) : null}
        </div>
      </div>

      <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-1">
        {!enabled ? (
          <span className="tw:rounded-2 tw:bg-app-hover tw:px-2 tw:py-1 tw:text-app-text-meta">
            已停用
          </span>
        ) : null}
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
  )
}
