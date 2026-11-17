import type { RpcParams, RpcResult } from '@pidex/agent-protocol'
import React, { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../../components/ui/Button.js'
import { SegmentedControl } from '../../../components/ui/SegmentedControl.js'
import { SkeletonBlock, SkeletonRegion } from '../../../components/ui/Skeleton.js'
import {
  formatAmount,
  formatCheckedAt,
  formatCompactCount,
  formatCount,
  formatQuotaValue,
  formatResetTime,
  quotaRemainingPercent,
  sumDecimalAmounts,
  usageStatusLabel,
  type ProviderUsageSource,
} from '../../../utils/UsageFormatters.js'
import { ProviderBalanceCards } from './ProviderBalanceCards.js'
import type { ProviderUsageQueryPartition } from '../../provider-management/Types.js'

type ProviderRange = RpcParams<'usage/provider/query'>['range']
type UsageSourceDescriptor = RpcResult<'usage/source/list'>['sources'][number]
type ProviderUsagePartition = ProviderUsageQueryPartition

type Props = {
  /** 按查询范围分区的真实结果；每个范围独立保留结果、错误与刷新状态。 */
  partitions: Partial<Record<ProviderRange, ProviderUsagePartition>>
  descriptors: readonly UsageSourceDescriptor[]
  error: string | null
  loading: boolean
  providerNames?: Readonly<Record<string, string>>
  refreshingSourceIds?: readonly string[]
  selectedProviderId?: string
  selectedSourceId?: string
  onClearFilter: () => void
  onRefresh: (sourceIds?: readonly string[], force?: boolean, range?: ProviderRange) => void
}

const RANGE_OPTIONS = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
] as const

/** 汇总按页面默认范围展示，避免把不同范围的结果相加。 */
const SUMMARY_RANGE: ProviderRange = '7d'

export function ProviderUsagePanel({
  partitions,
  descriptors,
  error,
  loading,
  providerNames = {},
  refreshingSourceIds = [],
  selectedProviderId,
  selectedSourceId,
  onClearFilter,
  onRefresh,
}: Props): React.ReactNode {
  const [sourceRanges, setSourceRanges] = useState<Record<string, ProviderRange>>({})
  const descriptorById = useMemo(
    () => new Map(descriptors.map((source) => [source.sourceId, source])),
    [descriptors],
  )
  const summaryResults = useMemo(
    () => Object.values(partitions[SUMMARY_RANGE]?.results ?? {}),
    [partitions],
  )
  const sourceById = useMemo(
    () => new Map(summaryResults.map((source) => [source.sourceId, source])),
    [summaryResults],
  )
  const analyticsDescriptors = useMemo(
    () =>
      descriptors.filter(
        (source) =>
          source.availability === 'queryable' &&
          source.capabilities.some(
            (capability) =>
              capability === 'usage' ||
              capability === 'cost' ||
              capability === 'balance' ||
              capability === 'quota',
          ),
      ),
    [descriptors],
  )
  const visibleAnalytics = useMemo(
    () => filterDescriptors(analyticsDescriptors, selectedProviderId, selectedSourceId),
    [analyticsDescriptors, selectedProviderId, selectedSourceId],
  )
  const visibleResults = useMemo(
    () =>
      visibleAnalytics
        .map((descriptor) => sourceById.get(descriptor.sourceId))
        .filter((source): source is ProviderUsageSource => source !== undefined),
    [sourceById, visibleAnalytics],
  )
  const totals = useMemo(() => summarizeSources(visibleResults), [visibleResults])
  const hasFilter = Boolean(selectedProviderId || selectedSourceId)
  const activeSource = selectedSourceId ? descriptorById.get(selectedSourceId) : undefined
  const noMatchingFilter = hasFilter && visibleAnalytics.length === 0

  const handleSourceRangeChange = useCallback(
    (sourceId: string, nextRange: ProviderRange) => {
      setSourceRanges((current) => ({ ...current, [sourceId]: nextRange }))
      onRefresh([sourceId], true, nextRange)
    },
    [onRefresh],
  )

  const isRefreshingAll =
    visibleAnalytics.length > 0 &&
    visibleAnalytics.every((source) => refreshingSourceIds.includes(source.sourceId))

  return (
    <div
      aria-labelledby="usage-accounts-tab"
      className="usage-panel tw:grid tw:gap-4"
      id="usage-accounts-panel"
      role="tabpanel"
    >
      <div className="usage-panel-toolbar tw:flex tw:items-center tw:justify-between tw:gap-4 tw:@max-[900px]:flex-col tw:@max-[900px]:items-stretch">
        <div>
          <h3 className="tw:m-0 tw:text-app-text tw:type-4 tw:weight-bold">账户用量与成本</h3>
          <p className="tw:mt-1 tw:mb-0 tw:text-app-text-soft tw:type-1">
            汇总已配置账户的远端历史用量与成本；余额、套餐和凭据请到账户连接管理。
          </p>
        </div>
        <div className="usage-toolbar-actions tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2 tw:@max-[900px]:justify-start">
          <Button
            color="secondary"
            loading={isRefreshingAll || (loading && refreshingSourceIds.length === 0)}
            onClick={() =>
              onRefresh(
                visibleAnalytics.map((source) => source.sourceId),
                true,
              )
            }
          >
            刷新全部
          </Button>
        </div>
      </div>

      {hasFilter ? (
        <div
          className="usage-active-filter tw:flex tw:items-center tw:justify-between tw:gap-3 tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-3 tw:text-app-text-soft tw:type-1 tw:@max-[900px]:flex-col tw:@max-[900px]:items-stretch tw:@max-[900px]:justify-start"
          role="status"
        >
          <span>
            当前筛选：
            {activeSource?.displayName ?? selectedProviderId ?? selectedSourceId}
          </span>
          <Button color="secondary" onClick={onClearFilter}>
            清除筛选
          </Button>
        </div>
      ) : null}

      {error ? (
        <div
          className="usage-inline-error tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-4 tw:text-app-danger tw:type-1 tw:shadow-none"
          role="status"
        >
          {error}
        </div>
      ) : null}
      {loading && summaryResults.length === 0 ? <ProviderUsageSkeleton /> : null}

      {!loading && descriptors.length === 0 ? (
        <div
          className="usage-empty-state tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-4 tw:text-app-text-soft tw:type-1 tw:shadow-none"
          role="status"
        >
          <h3 className="tw:m-0 tw:mb-1 tw:text-app-text tw:type-2">还没有已配置的厂商</h3>
          <p className="tw:m-0 tw:mb-3">
            请先从供应商目录完成连接，这里只展示已配置账户的用量与成本。
          </p>
          <Link
            className="usage-text-link tw:w-fit tw:text-app-accent-fg tw:type-1 tw:no-underline tw:hover:underline tw:focus-visible:rounded-3 tw:focus-visible:outline-solid tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-app-focus"
            to="/providers"
          >
            前往供应商
          </Link>
        </div>
      ) : null}

      {!loading && noMatchingFilter ? (
        <div
          className="usage-empty-state tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-4 tw:text-app-text-soft tw:type-1 tw:shadow-none"
          role="status"
        >
          <h3 className="tw:m-0 tw:mb-1 tw:text-app-text tw:type-2">没有匹配的已配置来源</h3>
          <p className="tw:m-0 tw:mb-3">当前深链筛选可能已失效，清除后可查看其他账户。</p>
          <Button color="secondary" onClick={onClearFilter}>
            清除筛选
          </Button>
        </div>
      ) : null}

      {visibleAnalytics.length > 0 ? <UsageSummary totals={totals} /> : null}

      <div className="provider-usage-list tw:grid tw:gap-4">
        {visibleAnalytics.map((descriptor) => {
          const range = sourceRanges[descriptor.sourceId] ?? '7d'
          const isSourceLoading =
            loading &&
            (refreshingSourceIds.length === 0 || refreshingSourceIds.includes(descriptor.sourceId))
          return (
            <ProviderUsageCard
              descriptor={descriptor}
              key={descriptor.sourceId}
              loading={isSourceLoading}
              onRangeChange={(nextRange) => handleSourceRangeChange(descriptor.sourceId, nextRange)}
              onRefresh={() => onRefresh([descriptor.sourceId], true, range)}
              providerName={
                providerNames[String(descriptor.canonicalProviderId)] ??
                String(descriptor.canonicalProviderId)
              }
              range={range}
              source={partitions[range]?.results[descriptor.sourceId]}
            />
          )
        })}
      </div>
    </div>
  )
}

function UsageSummary({
  totals,
}: {
  totals: ReturnType<typeof summarizeSources>
}): React.ReactNode {
  return (
    <dl className="usage-account-summary tw:m-0 tw:grid tw:grid-cols-4 tw:gap-3 tw:@max-[1100px]:grid-cols-2 tw:@max-[900px]:grid-cols-1">
      <div className="tw:grid tw:min-w-0 tw:gap-1 tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-3">
        <dt className="tw:text-app-text-soft tw:type-1">总 Token</dt>
        <dd className="tw:m-0 tw:text-app-text tw:type-4 tw:tabular-nums">
          {formatCompactCount(totals.tokens)}
        </dd>
      </div>
      <div className="tw:grid tw:min-w-0 tw:gap-1 tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-3">
        <dt className="tw:text-app-text-soft tw:type-1">请求数</dt>
        <dd className="tw:m-0 tw:text-app-text tw:type-4 tw:tabular-nums">
          {formatCount(totals.requests)}
        </dd>
      </div>
      <div className="tw:grid tw:min-w-0 tw:gap-1 tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-3">
        <dt className="tw:text-app-text-soft tw:type-1">有数据的来源</dt>
        <dd className="tw:m-0 tw:text-app-text tw:type-4 tw:tabular-nums">
          {formatCount(totals.sources)}
        </dd>
      </div>
      {totals.costs.map((cost) => (
        <div
          className="tw:grid tw:min-w-0 tw:gap-1 tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-3"
          key={cost.currency}
        >
          <dt className="tw:text-app-text-soft tw:type-1">{cost.currency} 成本</dt>
          <dd className="tw:m-0 tw:text-app-text tw:type-4 tw:tabular-nums">
            {formatAmount(cost.currency, cost.amount)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ProviderUsageSkeleton(): React.ReactNode {
  return (
    <SkeletonRegion className="usage-loading tw:grid tw:gap-3" label="正在查询账户用量与成本">
      {Array.from({ length: 3 }, (_, index) => (
        <SkeletonBlock
          className="usage-loading-provider tw:h-[180px] tw:w-full tw:rounded-4"
          key={index}
        />
      ))}
    </SkeletonRegion>
  )
}

function ProviderUsageCard({
  descriptor,
  providerName,
  source,
  loading,
  range = '7d',
  onRangeChange,
  onRefresh,
}: {
  descriptor: UsageSourceDescriptor
  providerName: string
  source?: ProviderUsageSource
  loading: boolean
  range?: ProviderRange
  onRangeChange?: (range: ProviderRange) => void
  onRefresh: () => void
}): React.ReactNode {
  const providerId = String(descriptor.canonicalProviderId)
  const status =
    source?.status ?? (descriptor.connection.kind === 'none' ? 'not-connected' : 'unavailable')
  const hasTimeSeries = descriptor.capabilities.some(
    (capability) => capability === 'usage' || capability === 'cost',
  )
  return (
    <article
      className="provider-usage-card tw:grid tw:min-w-0 tw:gap-3 tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-panel tw:p-4 tw:shadow-none tw:data-[status=exhausted]:border-app-danger-border"
      data-status={status}
      data-stability={descriptor.stability}
    >
      <header className="provider-usage-header tw:flex tw:items-start tw:justify-between tw:gap-4 tw:@max-[900px]:flex-col tw:@max-[900px]:items-stretch">
        <div>
          <div className="provider-usage-title tw:flex tw:flex-wrap tw:items-center tw:gap-2">
            <h3 className="tw:m-0 tw:text-app-text tw:type-4 tw:weight-bold">
              <Link
                className="tw:w-fit tw:text-inherit tw:no-underline tw:hover:underline tw:focus-visible:rounded-3 tw:focus-visible:outline-solid tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-app-focus"
                title="前往账户连接"
                to={`/providers?provider=${encodeURIComponent(providerId)}`}
              >
                {descriptor.displayName}
              </Link>
            </h3>
            <span className="usage-badge tw:inline-flex tw:min-h-[20px] tw:items-center tw:rounded-full tw:px-2 tw:py-1 tw:type-1">
              {scopeLabel(descriptor.scope)}
            </span>
            <span
              className="usage-badge tw:inline-flex tw:min-h-[20px] tw:items-center tw:rounded-full tw:px-2 tw:py-1 tw:type-1"
              data-stability={descriptor.stability}
            >
              {descriptor.stability === 'official' ? '官方接口' : '实验性'}
            </span>
            <span
              className="usage-badge tw:inline-flex tw:min-h-[20px] tw:items-center tw:rounded-full tw:px-2 tw:py-1 tw:type-1"
              data-status={status}
            >
              {usageStatusLabel(status)}
            </span>
          </div>
          <p className="tw:mt-1 tw:mb-0 tw:text-app-text-soft tw:type-1">
            <Link
              className="usage-text-link tw:w-fit tw:text-app-accent-fg tw:type-1 tw:no-underline tw:hover:underline tw:focus-visible:rounded-3 tw:focus-visible:outline-solid tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-app-focus"
              to={`/providers?provider=${encodeURIComponent(providerId)}`}
            >
              {providerName}
            </Link>
            {' · '}
            {connectionLabel(descriptor.connection)}
            {' · '}
            {formatCheckedAt(source?.checkedAt)}
          </p>
        </div>
        <div className="provider-usage-card-actions tw:flex tw:shrink-0 tw:flex-wrap tw:items-center tw:justify-end tw:gap-2">
          {hasTimeSeries && onRangeChange ? (
            <SegmentedControl
              ariaLabel={`${descriptor.displayName} 时间范围`}
              onChange={onRangeChange}
              options={RANGE_OPTIONS}
              value={range}
            />
          ) : null}
          <Button color="secondary" loading={loading} onClick={onRefresh}>
            刷新
          </Button>
        </div>
      </header>

      {descriptor.queryPolicy === 'metered' ? (
        <div
          className="usage-cost-notice tw:rounded-4 tw:bg-app-raised tw:p-4 tw:text-app-text-soft tw:type-1 tw:shadow-none"
          role="note"
        >
          Reporting API 为计费查询，价格以官方为准；Pidex 使用一小时缓存且不会后台轮询。
        </div>
      ) : null}
      {descriptor.stability === 'experimental' ? (
        <div className="usage-experimental-note tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:px-4 tw:py-3 tw:text-app-text-soft tw:type-1 tw:shadow-none">
          实验性来源可能随官方客户端端点变化；失败只影响此卡片。
        </div>
      ) : null}
      {source?.error ? (
        <div
          className="usage-source-error tw:grid tw:gap-1 tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-4 tw:text-app-danger tw:type-1 tw:shadow-none"
          role="status"
        >
          <strong>{source.error.message}</strong>
          <span>
            {source.error.retryable ? '可以稍后重试。' : errorCategoryLabel(source.error.category)}
          </span>
          <Link
            className="usage-text-link tw:w-fit tw:text-app-accent-fg tw:type-1 tw:no-underline tw:hover:underline tw:focus-visible:rounded-3 tw:focus-visible:outline-solid tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-app-focus"
            to={`/providers?provider=${encodeURIComponent(providerId)}`}
          >
            修复账户连接
          </Link>
        </div>
      ) : null}

      {source?.groups.length ? (
        <div className="provider-usage-groups tw:grid tw:gap-3">
          {source.groups.map((group) => (
            <ProviderUsageGroupCard group={group} key={group.id} />
          ))}
        </div>
      ) : (
        <p className="usage-chart-empty tw:m-0 tw:py-4 tw:text-center tw:text-app-text-soft tw:type-1">
          {loading ? '正在查询此来源。' : '当前时间范围没有可展示的历史用量。'}
        </p>
      )}
    </article>
  )
}

function ProviderUsageGroupCard({
  group,
}: {
  group: ProviderUsageSource['groups'][number]
}): React.ReactNode {
  return (
    <section className="provider-usage-group tw:grid tw:gap-3 tw:border-t tw:border-t-app-border-subtle tw:pt-3">
      <h4 className="tw:m-0 tw:text-app-text tw:type-2 tw:weight-medium">{group.label}</h4>
      {group.balances && group.balances.length > 0 ? (
        <ProviderBalanceCards balances={group.balances} />
      ) : null}
      {group.quotaWindows && group.quotaWindows.length > 0 ? (
        <div
          aria-label="额度与重置"
          className="provider-quotas tw:grid tw:grid-cols-[repeat(auto-fit,minmax(240px,1fr))] tw:gap-3 tw:@max-[900px]:grid-cols-1"
          role="group"
        >
          {group.quotaWindows.map((quota) => {
            const percent = quotaRemainingPercent(quota)
            const resetText =
              quota.state === 'unlimited' ? '不重置' : formatResetTime(quota.resetsAt)
            return (
              <div
                className="provider-quota-card tw:group tw:grid tw:min-w-0 tw:gap-2 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:px-4 tw:py-3 tw:data-[state=exhausted]:border-app-danger-border"
                data-state={quota.state}
                key={quota.id}
              >
                <div className="provider-quota-header tw:flex tw:items-center tw:justify-between tw:gap-2">
                  <span className="provider-quota-label tw:min-w-0 tw:truncate tw:text-app-text tw:type-2 tw:weight-medium">
                    {quota.label}
                  </span>
                  <span
                    className="provider-quota-reset tw:shrink-0 tw:whitespace-nowrap tw:text-app-text-meta tw:type-1 tw:tabular-nums"
                    title="重置时间"
                  >
                    {resetText}
                  </span>
                </div>
                <div className="provider-quota-progress tw:min-w-0">
                  <div className="provider-quota-bar-track tw:h-1 tw:w-full tw:overflow-hidden tw:rounded-full tw:bg-app-border-subtle">
                    <div
                      className="provider-quota-bar-fill tw:h-full tw:rounded-full"
                      style={{ '--usage-ratio': percent / 100 } as React.CSSProperties}
                    />
                  </div>
                </div>
                <div className="provider-quota-meta tw:flex tw:items-center tw:justify-between tw:gap-2">
                  <span className="provider-quota-value tw:text-app-text-soft tw:type-1 tw:tabular-nums tw:group-data-[state=exhausted]:text-app-danger">
                    {formatQuotaValue(quota)}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
      {group.totals ? (
        <dl className="provider-totals tw:m-0 tw:grid tw:grid-cols-3 tw:gap-3 tw:@max-[1100px]:grid-cols-2 tw:@max-[900px]:grid-cols-1">
          <div className="tw:grid tw:min-w-0 tw:gap-1 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-3">
            <dt className="tw:text-app-text-soft tw:type-1">输入 Token</dt>
            <dd className="tw:m-0 tw:text-app-text tw:type-2 tw:tabular-nums">
              {formatCompactCount(group.totals.inputTokens)}
            </dd>
          </div>
          <div className="tw:grid tw:min-w-0 tw:gap-1 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-3">
            <dt className="tw:text-app-text-soft tw:type-1">输出 Token</dt>
            <dd className="tw:m-0 tw:text-app-text tw:type-2 tw:tabular-nums">
              {formatCompactCount(group.totals.outputTokens)}
            </dd>
          </div>
          <div className="tw:grid tw:min-w-0 tw:gap-1 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-3">
            <dt className="tw:text-app-text-soft tw:type-1">缓存 Token</dt>
            <dd className="tw:m-0 tw:text-app-text tw:type-2 tw:tabular-nums">
              {formatCompactCount(group.totals.cachedTokens)}
            </dd>
          </div>
          <div className="tw:grid tw:min-w-0 tw:gap-1 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-3">
            <dt className="tw:text-app-text-soft tw:type-1">请求数</dt>
            <dd className="tw:m-0 tw:text-app-text tw:type-2 tw:tabular-nums">
              {formatCount(group.totals.requests)}
            </dd>
          </div>
          {group.totals.costs.map((cost) => (
            <div
              className="tw:grid tw:min-w-0 tw:gap-1 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:p-3"
              key={cost.currency}
            >
              <dt className="tw:text-app-text-soft tw:type-1">{cost.currency} 成本</dt>
              <dd className="tw:m-0 tw:text-app-text tw:type-2 tw:tabular-nums">
                {formatAmount(cost.currency, cost.amount)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {group.series && group.series.length > 0 ? <ProviderSeries points={group.series} /> : null}
      {group.breakdown && group.breakdown.length > 0 ? (
        <ol className="provider-breakdown tw:m-0 tw:grid tw:w-full tw:list-none tw:gap-0 tw:p-0">
          {group.breakdown.map((item) => (
            <li
              className="tw:flex tw:items-center tw:gap-2 tw:border-t tw:border-t-app-border-subtle tw:py-2"
              key={`${item.kind}/${item.id}`}
            >
              <span className="tw:mr-auto tw:grid tw:min-w-0">
                <strong className="tw:truncate tw:text-app-text tw:type-1">{item.label}</strong>
                <small className="tw:block tw:text-app-text-soft tw:type-1">
                  {item.kind === 'model' ? '模型' : '工具'}
                </small>
              </span>
              <span className="tw:text-right tw:text-app-text-soft tw:type-1 tw:tabular-nums">
                {formatBreakdownUsage(item)}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {!group.totals &&
      !group.series?.length &&
      !group.breakdown?.length &&
      !group.quotaWindows?.length &&
      !group.balances?.length ? (
        <p className="usage-chart-empty tw:m-0 tw:py-4 tw:text-center tw:text-app-text-soft tw:type-1">
          当前时间范围没有返回数据。
        </p>
      ) : null}
    </section>
  )
}

function ProviderSeries({
  points,
}: {
  points: NonNullable<ProviderUsageSource['groups'][number]['series']>
}): React.ReactNode {
  const tokenValues = points.map(
    (point) => point.inputTokens + point.outputTokens + point.cachedTokens,
  )
  const requestValues = points.map((point) => point.requests)
  const costCurrency = [
    ...new Set(points.flatMap((point) => point.costs.map((cost) => cost.currency))),
  ].sort()[0]
  const costValues = costCurrency
    ? points.map((point) => {
        const amount = point.costs.find((cost) => cost.currency === costCurrency)?.amount
        const value = amount === undefined ? 0 : Number(amount)
        return Number.isFinite(value) && value >= 0 ? value : 0
      })
    : points.map(() => 0)
  const hasTokens = tokenValues.some((value) => value > 0)
  const hasRequests = requestValues.some((value) => value > 0)
  const mode = hasTokens ? 'tokens' : hasRequests ? 'requests' : 'costs'
  const values = mode === 'tokens' ? tokenValues : mode === 'requests' ? requestValues : costValues
  const max = Math.max(1, ...values)
  const width = Math.max(240, points.length * 18)
  return (
    <div className="provider-series tw:min-w-0 tw:overflow-x-auto">
      <svg
        aria-label="来源每日用量趋势"
        className="tw:block tw:h-[64px] tw:w-full tw:min-w-[240px]"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${width} 64`}
      >
        {values.map((value, index) => (
          <rect
            fill="var(--usage-chart-1)"
            height={(value / max) * 56}
            key={points[index]?.date}
            rx="2"
            width="12"
            x={index * 18 + 3}
            y={60 - (value / max) * 56}
          >
            <title>
              {mode === 'tokens'
                ? `${points[index]?.date} · ${formatCount(value)} Token`
                : mode === 'requests'
                  ? `${points[index]?.date} · ${formatCount(value)} 次请求`
                  : `${points[index]?.date} · ${formatAmount(
                      costCurrency ?? 'USD',
                      points[index]?.costs.find((cost) => cost.currency === costCurrency)?.amount ??
                        '0',
                    )}`}
            </title>
          </rect>
        ))}
      </svg>
    </div>
  )
}

function filterDescriptors(
  descriptors: readonly UsageSourceDescriptor[],
  providerId: string | undefined,
  sourceId: string | undefined,
): UsageSourceDescriptor[] {
  return descriptors
    .filter(
      (descriptor) => !providerId || descriptor.providerIds.some((id) => String(id) === providerId),
    )
    .filter((descriptor) => !sourceId || descriptor.sourceId === sourceId)
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
}

function summarizeSources(sources: readonly ProviderUsageSource[]): {
  tokens: number
  requests: number
  sources: number
  costs: Array<{ currency: string; amount: string }>
} {
  let tokens = 0
  let requests = 0
  let populatedSources = 0
  const costs = new Map<string, string[]>()
  for (const source of sources) {
    let populated = false
    for (const group of source.groups) {
      if (!group.totals) continue
      populated = true
      tokens += group.totals.inputTokens + group.totals.outputTokens + group.totals.cachedTokens
      requests += group.totals.requests
      for (const cost of group.totals.costs) {
        const values = costs.get(cost.currency) ?? []
        values.push(cost.amount)
        costs.set(cost.currency, values)
      }
    }
    if (populated) populatedSources += 1
  }
  return {
    tokens,
    requests,
    sources: populatedSources,
    costs: [...costs]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, values]) => ({
        currency,
        amount: sumDecimalAmounts(values),
      })),
  }
}

function formatBreakdownUsage(
  item: NonNullable<ProviderUsageSource['groups'][number]['breakdown']>[number],
): string {
  const parts: string[] = []
  if (item.requests !== undefined) {
    parts.push(`${formatCount(item.requests)} 次`)
  }
  if (
    item.inputTokens !== undefined ||
    item.outputTokens !== undefined ||
    item.cachedTokens !== undefined
  ) {
    parts.push(
      `${formatCompactCount(
        (item.inputTokens ?? 0) + (item.outputTokens ?? 0) + (item.cachedTokens ?? 0),
      )} Token`,
    )
  }
  if (item.costs?.length) {
    parts.push(item.costs.map((cost) => formatAmount(cost.currency, cost.amount)).join(' / '))
  }
  return parts.join(' · ') || '暂无明细'
}

function scopeLabel(scope: UsageSourceDescriptor['scope']): string {
  if (scope === 'api-key') return '当前 Key'
  if (scope === 'account') return '账户'
  if (scope === 'organization') return '组织'
  return '订阅'
}

function connectionLabel(connection: UsageSourceDescriptor['connection']): string {
  if (connection.kind === 'provider-key') return '使用活动推理 Key'
  if (connection.kind === 'billing-key') {
    return `独立管理凭据${connection.maskedValue ? ` · ${connection.maskedValue}` : ''}`
  }
  if (connection.kind === 'oauth') return 'OAuth 已连接'
  if (connection.kind === 'env') return '使用环境变量'
  return '未连接'
}

function errorCategoryLabel(
  category: NonNullable<ProviderUsageSource['error']>['category'],
): string {
  if (category === 'authentication') return '请检查凭据。'
  if (category === 'permission') return '当前凭据缺少所需权限。'
  if (category === 'plan') return '当前账户或套餐不支持此查询。'
  if (category === 'rate-limit') return '厂商接口当前限流。'
  if (category === 'network') return '暂时无法连接厂商接口。'
  if (category === 'invalid-response') return '厂商返回了无法识别的数据。'
  return '查询暂时失败。'
}
