import * as Dialog from '@radix-ui/react-dialog'
import { RefreshCw, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { ModelSpecField, RpcParams, RpcResult } from '@pidex/agent-protocol'
import type { ModelProviderID } from '../../../../shared/Types.js'
import { Button } from '../../../components/ui/Button.js'
import { APP_ICON_SIZE, APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'
import { useDialogFocusRestore } from '../../../components/ui/UseDialogFocusRestore.js'
import { toUserErrorMessage } from '../../../utils/Errors.js'
import { formatCompactNumber } from '../../../utils/UsageFormatters.js'
import { desktopClient } from '../../../services/desktop-client/index.js'
import { SETTINGS_MANAGEMENT_DIALOG_SIZE } from '../../settings/SettingsManagementDialogSizing.js'
import { candidateMatchHint, candidateMatchLabel } from './ModelCandidateImport.js'

type Preview = RpcResult<'provider/model/specs/preview'>
type Item = Preview['items'][number]

const FIELD_LABELS: Record<ModelSpecField, string> = {
  contextWindow: '上下文',
  maxInputTokens: '最大输入',
  maxTokens: '最大输出',
}

/**
 * 存量 32K 占位规格的批量修复预览。一次只处理当前提供商；
 * 应用时带配置与目录版本，版本变化会被服务端拒绝并要求重新预览。
 */
export function ProviderModelSpecRepairDialog({
  open,
  providerId,
  onClose,
  onApplied,
}: {
  open: boolean
  providerId: ModelProviderID
  onClose: () => void
  onApplied: () => Promise<void> | void
}): React.ReactNode {
  const { onCloseAutoFocus } = useDialogFocusRestore(open)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<Readonly<Record<string, ModelSpecField[]>>>({})
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!open) return
    let active = true
    setPreview(null)
    setSelected({})
    setError(null)
    setLoading(true)
    void (async () => {
      try {
        const recommendations = desktopClient.modelRecommendations
        if (!recommendations?.previewModelSpecs || !(await recommendations.specsSupported())) {
          throw new Error('当前 Agent 不支持 32K 模型规格检查。')
        }
        const result = await recommendations.previewModelSpecs(providerId)
        if (!active) return
        setPreview(result)
        const defaults: Record<string, ModelSpecField[]> = {}
        for (const item of result.items) {
          const fields = item.fields
            .filter((field) => field.defaultSelected && !field.noRepair)
            .map((field) => field.field)
          if (fields.length) defaults[item.modelId] = fields
        }
        setSelected(defaults)
      } catch (cause) {
        if (active) setError(toUserErrorMessage(cause))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [open, providerId, reloadToken])

  const selections = useMemo(
    () =>
      Object.entries(selected)
        .filter(([, fields]) => fields.length)
        .map(([modelId, fields]) => ({ modelId, fields })),
    [selected],
  )

  const toggle = (item: Item, field: ModelSpecField) => {
    setSelected((current) => {
      const existing = current[item.modelId] ?? []
      const next = existing.includes(field)
        ? existing.filter((value) => value !== field)
        : [...existing, field]
      return { ...current, [item.modelId]: next }
    })
  }

  async function apply() {
    if (!preview || !selections.length || applying) return
    setApplying(true)
    setError(null)
    try {
      const recommendations = desktopClient.modelRecommendations
      if (!recommendations?.applyModelSpecs) throw new Error('当前 Agent 不支持规格修复。')
      await recommendations.applyModelSpecs({
        providerId: preview.providerId,
        expectedConfigVersion: preview.configVersion,
        ...(preview.catalogUpdatedAt !== undefined
          ? { expectedCatalogUpdatedAt: preview.catalogUpdatedAt }
          : {}),
        selections: selections as unknown as RpcParams<'provider/model/specs/apply'>['selections'],
        operationId: crypto.randomUUID(),
      })
      await onApplied()
      onClose()
    } catch (cause) {
      setError(toUserErrorMessage(cause))
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-dialog-backdrop permission-modal-backdrop" />
        <Dialog.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className={`ui-dialog-surface ui-dialog-surface--centered settings-management-dialog tw:flex tw:flex-col tw:overflow-hidden ${SETTINGS_MANAGEMENT_DIALOG_SIZE.providerModels}`}
        >
          <header className="settings-management-dialog-header tw:shrink-0">
            <div className="settings-management-dialog-heading">
              <Dialog.Title>检查 32K 模型规格</Dialog.Title>
              <Dialog.Description>
                扫描当前提供商中上下文为 32,768 的已保存模型；按字段选择要应用的官方或供应商规格。
              </Dialog.Description>
            </div>
            <Button
              color="ghostSecondary"
              isIconOnly
              size="toolbar"
              aria-label="关闭规格检查"
              onClick={onClose}
            >
              <X aria-hidden size={APP_ICON_SIZE} />
            </Button>
          </header>
          <div className="settings-management-dialog-body tw:min-h-0 tw:flex-1 tw:overflow-y-auto">
            {loading ? (
              <p className="tw:py-8 tw:text-center tw:text-app-text-soft tw:type-body-sm">
                正在检查模型规格…
              </p>
            ) : error ? (
              <div className="tw:grid tw:gap-3 tw:py-6">
                <p role="alert" className="tw:m-0 tw:text-app-danger tw:type-body-sm">
                  {error}
                </p>
                <Button
                  color="outline"
                  size="sm"
                  onClick={() => setReloadToken((token) => token + 1)}
                >
                  <RefreshCw aria-hidden size={APP_ICON_SIZES.sm} />
                  重新检查
                </Button>
              </div>
            ) : !preview ? null : preview.items.length === 0 ? (
              <p className="tw:py-8 tw:text-center tw:text-app-text-soft tw:type-body-sm">
                没有发现上下文为 32,768 的已保存模型。
              </p>
            ) : (
              <div className="tw:grid tw:gap-3">
                {preview.items.map((item) => {
                  const hint = candidateMatchHint(item.match)
                  return (
                    <section
                      key={item.modelId}
                      className="tw:grid tw:gap-2 tw:rounded-lg tw:border tw:border-app-border-subtle tw:p-3"
                    >
                      <header className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                        <strong className="tw:text-app-text tw:type-row-title">{item.name}</strong>
                        <span className="tw:font-mono tw:text-app-text-meta tw:type-caption">
                          {item.modelId}
                        </span>
                        <span className="tw:rounded tw:bg-app-hover tw:px-1.5 tw:py-0.5 tw:type-caption tw:text-app-text-soft">
                          {candidateMatchLabel(item.match.status)}
                        </span>
                        {item.match.identity ? (
                          <span className="tw:text-app-text-meta tw:type-caption">
                            {item.match.identity}
                          </span>
                        ) : null}
                        {item.match.updatedAt ? (
                          <span className="tw:text-app-text-meta tw:type-caption">
                            目录更新 {new Date(item.match.updatedAt).toLocaleString()}
                          </span>
                        ) : null}
                      </header>
                      {item.fields.length === 0 ? (
                        <p className="tw:m-0 tw:text-app-text-soft tw:type-body-sm">
                          没有可应用的确定推荐值，请保留原值或手动编辑。
                        </p>
                      ) : (
                        <div className="tw:grid tw:gap-1">
                          {item.fields.map((field) => (
                            <label
                              key={field.field}
                              className="tw:flex tw:items-center tw:gap-2 tw:type-body-sm"
                            >
                              <input
                                type="checkbox"
                                checked={
                                  (selected[item.modelId] ?? []).includes(field.field) &&
                                  !field.noRepair
                                }
                                disabled={field.noRepair}
                                onChange={() => toggle(item, field.field)}
                              />
                              <span className="tw:w-20 tw:shrink-0 tw:text-app-text">
                                {FIELD_LABELS[field.field]}
                              </span>
                              <span className="tw:text-app-text-soft">
                                {field.current ? formatCompactNumber(field.current) : '未设置'} →{' '}
                                {formatCompactNumber(field.suggested)}
                              </span>

                              {field.noRepair ? (
                                <span className="tw:type-caption tw:text-app-text-meta">
                                  无须修复
                                </span>
                              ) : null}
                            </label>
                          ))}
                        </div>
                      )}
                      {hint ? (
                        <p className="tw:m-0 tw:text-app-text-meta tw:type-caption">{hint}</p>
                      ) : null}
                    </section>
                  )
                })}
              </div>
            )}
          </div>
          {error && preview ? (
            <p role="alert" className="tw:shrink-0 tw:px-6 tw:pb-2 tw:text-app-danger tw:type-body-sm">
              {error}
            </p>
          ) : null}
          <footer className="settings-management-dialog-footer tw:shrink-0">
            <Button size="md" color="secondary" disabled={applying} onClick={onClose}>
              取消
            </Button>
            <Button
              size="md"
              color="primary"
              disabled={applying || !selections.length}
              loading={applying}
              onClick={() => void apply()}
            >
              应用选中字段（{selections.length} 个模型）
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
