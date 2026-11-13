import { useEffect, useState } from 'react'
import type { ModelPricing, ModelUnitPrices } from '@pidex/agent-protocol'
import { Input } from '../../../components/ui/Input.js'
import { Button } from '../../../components/ui/Button.js'
import { ToggleSwitch } from '../../../components/ui/ToggleSwitch.js'
import { Select } from '../../../components/ui/Select.js'
import { desktopClient } from '../../../services/desktop-client/index.js'
import { toUserErrorMessage } from '../../../utils/Errors.js'

const zero = { input: null, output: null, cacheRead: null, cacheWrite: null }
const initial: ModelPricing = {
  currency: 'USD',
  timeZone: 'Asia/Shanghai',
  defaultPeriod: 'idle',
  idle: zero,
  busy: zero,
  rules: [],
  dateOverrides: [],
}
const periods = [
  { value: 'idle', label: '闲时' },
  { value: 'busy', label: '忙时' },
]
const labels = { input: '输入', output: '输出', cacheRead: '缓存读取', cacheWrite: '缓存写入' }
export function ModelPricingEditor({
  value,
  onChange,
  rowClassName,
}: {
  rowClassName: string
  value?: ModelPricing
  onChange: (value?: ModelPricing) => void
}) {
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!value) return
    let active = true
    void desktopClient.modelRecommendations
      ?.refreshPricing(false)
      .then((result) => {
        if (active)
          setStatus(
            `Frankfurter：${result.fxRate ? `1 CNY = ${result.fxRate} USD（${result.fxDate}）` : '暂无可用汇率，人民币费用将标记未知'}；${result.calendarYear} 中国节假日：${result.calendarAvailable ? '已缓存' : '不可用，按较高价格估算'}`,
          )
      })
      .catch((cause) => {
        if (active) setStatus(toUserErrorMessage(cause))
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在启用或关闭分时计费时读取资料状态。
  }, [!!value])

  const update = (patch: Partial<ModelPricing>) => onChange({ ...value!, ...patch })
  const rule = (index: number, patch: Partial<ModelPricing['rules'][number]>) =>
    update({ rules: value!.rules.map((item, i) => (i === index ? { ...item, ...patch } : item)) })
  return (
    <div className="tw:grid tw:gap-4">
      <div className="tw:flex tw:items-center tw:justify-between">
        <span>分时／原币计费</span>
        <ToggleSwitch
          ariaLabel="分时计费"
          checked={!!value}
          onChange={(enabled) => onChange(enabled ? structuredClone(initial) : undefined)}
        />
      </div>
      {value ? (
        <>
          <p className="tw:m-0 tw:type-1 tw:text-app-text-soft">
            以下为原币／百万 Token；固定美元价格仅在关闭分时计费后生效。请求开始时冻结价格与汇率。
          </p>
          <div className={rowClassName}>
            <span>计费币种</span>
            <Select
              triggerClassName="tw:w-full"
              ariaLabel="计费币种"
              value={value.currency}
              options={[
                { value: 'USD', label: 'USD 美元' },
                { value: 'CNY', label: 'CNY 人民币' },
              ]}
              onValueChange={(currency) =>
                update({ currency: currency as ModelPricing['currency'] })
              }
            />
          </div>
          <label className={rowClassName}>
            <span>计费时区</span>
            <Input
              aria-label="计费时区"
              value={value.timeZone}
              onChange={(event) => update({ timeZone: event.target.value })}
            />
          </label>
          <div className={rowClassName}>
            <span>默认计费档</span>
            <Select
              triggerClassName="tw:w-full"
              ariaLabel="默认计费档"
              value={value.defaultPeriod}
              options={periods}
              onValueChange={(period) => update({ defaultPeriod: period as 'idle' | 'busy' })}
            />
          </div>
          {(['idle', 'busy'] as const).map((period) => (
            <section
              key={period}
              aria-label={period === 'idle' ? '闲时价格' : '忙时价格'}
              className="tw:grid tw:min-w-0 tw:gap-4 tw:border-t tw:border-app-border-subtle tw:pt-5"
            >
              <h4 className="tw:m-0 tw:type-4 tw:weight-bold">
                {period === 'idle' ? '闲时价格' : '忙时价格'}
              </h4>
              {(Object.keys(labels) as (keyof ModelUnitPrices)[]).map((key) => (
                <label key={key} className={rowClassName}>
                  <span>{labels[key]}</span>
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    aria-label={`${period === 'idle' ? '闲时' : '忙时'}${labels[key]}价格`}
                    value={value[period][key] === null ? '' : String(value[period][key])}
                    placeholder="未知"
                    onChange={(event) =>
                      update({
                        [period]: {
                          ...value[period],
                          [key]: event.target.value === '' ? null : Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
              ))}
            </section>
          ))}
          <h4 className="tw:m-0 tw:border-t tw:border-app-border-subtle tw:pt-5 tw:type-4 tw:weight-bold">
            时间规则
          </h4>
          {value.rules.map((item, index) => (
            <div key={index} className="tw:grid tw:gap-4">
              <div className="tw:flex tw:items-center tw:justify-between">
                <span>规则 {index + 1}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => update({ rules: value.rules.filter((_, i) => i !== index) })}
                >
                  删除规则
                </Button>
              </div>
              <div className={rowClassName}>
                <span>计费档</span>
                <Select
                  triggerClassName="tw:w-full"
                  ariaLabel={`规则 ${index + 1} 计费档`}
                  value={item.period}
                  options={periods}
                  onValueChange={(period) => rule(index, { period: period as 'idle' | 'busy' })}
                />
              </div>
              <div className={rowClassName}>
                <span>适用星期</span>
                <div className="tw:flex tw:flex-wrap tw:gap-3">
                  {['日', '一', '二', '三', '四', '五', '六'].map((day, i) => (
                    <label key={i}>
                      <input
                        type="checkbox"
                        checked={item.weekdays.includes(i)}
                        onChange={(event) =>
                          rule(index, {
                            weekdays: event.target.checked
                              ? [...item.weekdays, i]
                              : item.weekdays.filter((d) => d !== i),
                          })
                        }
                      />
                      周{day}
                    </label>
                  ))}
                </div>
              </div>
              <div className={rowClassName}>
                <span>节假日条件</span>
                <Select
                  triggerClassName="tw:w-full"
                  ariaLabel={`规则 ${index + 1} 节假日`}
                  value={item.holiday}
                  options={[
                    { value: 'any', label: '所有日期' },
                    { value: 'exclude-cn', label: '排除中国节假日' },
                    { value: 'only-cn', label: '仅中国节假日' },
                  ]}
                  onValueChange={(holiday) =>
                    rule(index, { holiday: holiday as typeof item.holiday })
                  }
                />
              </div>
              {item.intervals.map((interval, j) => (
                <div key={j} className={rowClassName}>
                  <span>时间段 {j + 1}</span>
                  <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
                    <Input
                      className="tw:min-w-0 tw:flex-1"
                      type="time"
                      aria-label={`规则 ${index + 1} 时间段 ${j + 1} 开始`}
                      value={interval.start}
                      onChange={(event) =>
                        rule(index, {
                          intervals: item.intervals.map((slot, k) =>
                            k === j ? { ...slot, start: event.target.value } : slot,
                          ),
                        })
                      }
                    />
                    <span>至</span>
                    <Input
                      className="tw:min-w-0 tw:flex-1"
                      type="time"
                      aria-label={`规则 ${index + 1} 时间段 ${j + 1} 结束`}
                      value={interval.end}
                      onChange={(event) =>
                        rule(index, {
                          intervals: item.intervals.map((slot, k) =>
                            k === j ? { ...slot, end: event.target.value } : slot,
                          ),
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        rule(index, { intervals: item.intervals.filter((_, k) => k !== j) })
                      }
                    >
                      删除
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  rule(index, { intervals: [...item.intervals, { start: '09:00', end: '12:00' }] })
                }
              >
                添加时间段
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              update({
                rules: [
                  ...value.rules,
                  {
                    period: 'busy',
                    weekdays: [1, 2, 3, 4, 5],
                    holiday: 'exclude-cn',
                    intervals: [{ start: '09:00', end: '12:00' }],
                  },
                ],
              })
            }
          >
            添加规则
          </Button>
          <h4 className="tw:m-0 tw:border-t tw:border-app-border-subtle tw:pt-5 tw:type-4 tw:weight-bold">
            指定日期覆盖
          </h4>
          {value.dateOverrides.map((item, index) => (
            <div key={index} className={rowClassName}>
              <span>日期覆盖 {index + 1}</span>
              <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
                <Input
                  className="tw:min-w-0 tw:flex-1"
                  type="date"
                  aria-label={`覆盖日期 ${index + 1}`}
                  value={item.date}
                  onChange={(event) =>
                    update({
                      dateOverrides: value.dateOverrides.map((d, i) =>
                        i === index ? { ...d, date: event.target.value } : d,
                      ),
                    })
                  }
                />
                <Select
                  triggerClassName="tw:shrink-0"
                  ariaLabel={`覆盖计费档 ${index + 1}`}
                  value={item.period}
                  options={periods}
                  onValueChange={(period) =>
                    update({
                      dateOverrides: value.dateOverrides.map((d, i) =>
                        i === index ? { ...d, period: period as 'idle' | 'busy' } : d,
                      ),
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    update({ dateOverrides: value.dateOverrides.filter((_, i) => i !== index) })
                  }
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              update({ dateOverrides: [...value.dateOverrides, { date: '', period: 'idle' }] })
            }
          >
            添加日期覆盖
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void desktopClient
                .modelRecommendations!.refreshPricing()
                .then((result) =>
                  setStatus(
                    `Frankfurter：${result.fxRate ? `1 CNY = ${result.fxRate} USD（${result.fxDate}）` : '暂无可用汇率，费用将标记未知'}；${result.calendarYear} 中国节假日：${result.calendarAvailable ? '已缓存' : '不可用，按较高价格估算'}`,
                  ),
                )
                .catch((cause) => setStatus(toUserErrorMessage(cause)))
                .finally(() => setBusy(false))
            }}
          >
            刷新汇率与节假日日历
          </Button>
          {status ? (
            <p role="status" className="tw:m-0 tw:type-1">
              {status}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
