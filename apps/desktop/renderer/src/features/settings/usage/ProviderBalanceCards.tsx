import type React from 'react'
import { InfoTooltip } from '../../../components/ui/Tooltip.js'
import { formatAmount, type ProviderBalance } from '../../../utils/UsageFormatters.js'

/**
 * 账户余额卡片：用量页与供应商连接页共用同一套 `.provider-balances` 样式和金额格式化，
 * 未知余额不渲染为 0，只在上游确认存在余额时展示。
 */
export function ProviderBalanceCards({
  balances,
  compact = false,
  accountName,
}: {
  balances: readonly ProviderBalance[]
  compact?: boolean
  accountName?: string
}): React.ReactNode {
  if (balances.length === 0) return null
  return (
    <div
      aria-label="账户余额"
      className="provider-balances tw:grid tw:grid-cols-[repeat(auto-fit,minmax(240px,1fr))] tw:gap-3 tw:@max-[900px]:grid-cols-1"
      role="group"
    >
      {balances.map((balance) =>
        compact ? (
          <div
            className="provider-balance-card tw:flex tw:min-w-0 tw:flex-wrap tw:items-baseline tw:justify-between tw:gap-x-4 tw:gap-y-2 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:px-4 tw:py-3"
            key={balance.currency}
          >
            {accountName ? (
              <h4 className="tw:m-0 tw:shrink-0 tw:type-2 tw:weight-medium">{accountName}</h4>
            ) : null}
            <div className="tw:flex tw:flex-wrap tw:items-baseline tw:justify-end tw:gap-x-2 tw:gap-y-1 tw:type-2">
              <span>账户余额</span>
              <strong className="tw:tabular-nums">
                {formatAmount(balance.currency, balance.total)}
              </strong>
              {balance.components?.length ? (
                <InfoTooltip
                  ariaLabel="余额明细"
                  content={
                    <span>
                      （含
                      {balance.components.map((component, index) => (
                        <span key={component.label}>
                          {index > 0 ? ' ' : ''}
                          {component.label}{' '}
                          <strong className="tw:tabular-nums">
                            {formatAmount(balance.currency, component.amount)}
                          </strong>
                        </span>
                      ))}
                      ）
                    </span>
                  }
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div
            className="provider-balance-card tw:grid tw:min-w-0 tw:gap-2 tw:rounded-3 tw:border tw:border-app-border-subtle tw:bg-app-raised tw:px-4 tw:py-3"
            key={balance.currency}
          >
            <div className="provider-balance-header tw:flex tw:items-baseline tw:justify-between tw:gap-2">
              <span className="provider-balance-label tw:min-w-0 tw:truncate tw:text-app-text-soft tw:type-3 tw:weight-medium">
                {balance.currency} 账户余额
              </span>
              <span className="provider-balance-total tw:whitespace-nowrap tw:text-app-text tw:type-3 tw:weight-bold tw:tabular-nums">
                {formatAmount(balance.currency, balance.total)}
              </span>
            </div>
            {balance.components && balance.components.length > 0 ? (
              <div className="provider-balance-components tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-x-3 tw:gap-y-2 tw:border-t tw:border-t-app-border-subtle tw:pt-2">
                {balance.components.map((component) => (
                  <span
                    className="provider-balance-component tw:inline-flex tw:items-center tw:gap-1 tw:text-app-text-soft tw:type-1 tw:tabular-nums"
                    key={component.label}
                  >
                    <span className="provider-balance-component-label tw:text-app-text-meta">
                      {component.label}
                    </span>
                    <span className="provider-balance-component-amount tw:text-app-text tw:weight-medium">
                      {formatAmount(balance.currency, component.amount)}
                    </span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ),
      )}
    </div>
  )
}
