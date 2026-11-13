import { SmartConfigPinnedFields } from '@pidex/agent-protocol'
import { ModelDocumentEditor } from './ModelDocumentEditor.js'
import { useEffect, useRef, useState } from 'react'
import type { ModelRecommendation, RpcResult } from '@pidex/agent-protocol'
import { desktopClient } from '../../../services/desktop-client/index.js'
import { Button } from '../../../components/ui/Button.js'
import { ToggleSwitch } from '../../../components/ui/ToggleSwitch.js'
import { InfoTooltip } from '../../../components/ui/InfoTooltip.js'
import { toUserErrorMessage } from '../../../utils/Errors.js'
import type { EditableModel } from './ProviderEditorForm.js'
import { fillModelDraft } from './SmartModelDraft.js'
import { useProviderManagementStore } from '../../provider-management/UseProviderManagementStore.js'

export function useRecommendationSupport() {
  const [supported, setSupported] = useState(false)
  useEffect(() => {
    let active = true
    void desktopClient.modelRecommendations
      ?.supported()
      .then((value) => {
        if (active) setSupported(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  return supported
}

export function useSmartModelConfig(
  model: EditableModel,
  onChange: (next: EditableModel) => void,
  providerId: string,
  baseUrl: string,
) {
  const supported = useRecommendationSupport()
  const catalogRevision = useProviderManagementStore((state) => state.catalogRevision)
  const [preview, setPreview] = useState<RpcResult<'model/recommendation/preview'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sequence = useRef(0)
  const latest = useRef({ model, onChange })
  latest.current = { model, onChange }
  const enabled = supported && model.smartConfig !== undefined && model.smartConfig.pinned.length === 0 && model.smartConfig.enabled !== false

  async function load(fill: boolean) {
    if (!supported) return
    if (!model.id.trim()) {
      if (fill) setError('请先填写模型 ID，再开启智能配置。')
      return
    }
    const request = ++sequence.current
    setBusy(true)
    setError(null)
    try {
      const result = await desktopClient.modelRecommendations!.preview({
        providerId,
        baseUrl,
        modelId: model.id,
        modelType: model.modelType ?? 'chat',
      })
      if (request !== sequence.current) return
      setPreview(result)
      if (fill) {
        const current = latest.current
        const config = current.model.smartConfig ?? { pinned: [] }
        const base = result.status === 'matched' ? fillModelDraft(current.model, result.recommended) : current.model
        const filled = config.source === 'document' && config.document ? fillModelDraft(base, config.document.data) : base
        current.onChange({ ...filled, smartConfig: { ...config, pinned: [], enabled: true } })
      }
    } catch (cause) {
      if (request === sequence.current) {
        setError(toUserErrorMessage(cause))
      }
    } finally {
      if (request === sequence.current) setBusy(false)
    }
  }

  useEffect(() => {
    setPreview(null)
    setError(null)
    setBusy(false)
    void load(enabled)
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 请求序号用于取消回包，不引用 DOM 节点。
      sequence.current++
    }
    // 只在身份或目录更新时重新匹配；手动编辑不触发重新填充。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, providerId, baseUrl, model.id, model.modelType, model.api, catalogRevision, model.smartConfig?.source, model.smartConfig?.document?.extractedAt])

  const setEnabled = (next: boolean) => {
    if (next) {
      if (!latest.current.model.id.trim()) {
        setError('请先填写模型 ID，再开启智能配置。')
        return
      }
      latest.current.onChange({ ...latest.current.model, smartConfig: { ...latest.current.model.smartConfig, pinned: [], enabled: true } })
      void load(true)
    } else {
      sequence.current++
      setBusy(false)
      setError(null)
      latest.current.onChange({ ...latest.current.model, smartConfig: latest.current.model.smartConfig ? { ...latest.current.model.smartConfig, enabled: false, pinned: [...SmartConfigPinnedFields] } : undefined })
    }
  }

  const controls = supported ? (
    <div className="tw:grid tw:gap-2 tw:text-app-text-soft tw:type-1">
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-2">
        <div className="tw:flex tw:items-center tw:gap-2">
          <h3 className="tw:m-0 tw:type-4 tw:weight-bold">智能配置</h3>
          <InfoTooltip
            ariaLabel="智能配置说明"
            content="按完整官方模型 ID、官方别名与供应商前缀匹配 models.dev 推荐；普通网关前缀不影响官方身份。打开开关后自动匹配并填充推荐值；暂未匹配时保留当前值和开启状态，目录更新同步后继续自动匹配。关闭后使用手动值，手动修改字段也会自动关闭开关。"
          />
        </div>
        <ToggleSwitch ariaLabel="智能配置" checked={enabled} onChange={setEnabled} />
      </div>
      <ModelDocumentEditor model={model} onChange={onChange} />
      {error || busy || (enabled && preview?.status !== 'matched') ? (
        <p role={error ? 'alert' : 'status'} className="tw:m-0">
          {error ??
            (!enabled
              ? ''
              : !model.id.trim()
                ? '输入模型 ID 后匹配推荐。'
                : busy
                  ? '正在匹配推荐…'
                  : !preview
                    ? ''
                    : {
                        matched: '',
                        unmatched: '暂未匹配，已保留智能配置；目录更新同步后会自动采用推荐',
                        ambiguous: preview.candidates?.length
                          ? `模型身份存在歧义：${preview.candidates.join(' / ')}`
                          : '模型身份存在歧义，请使用完整 ID',
                        'no-cache': '推荐目录暂不可用，已保留智能配置，更新后会重新匹配',
                      }[preview.status])}
          {preview?.status === 'no-cache' ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => {
                void desktopClient.modelRecommendations?.refresh().finally(() => void load(latest.current.model.smartConfig?.pinned.length === 0 && latest.current.model.smartConfig.enabled !== false))
              }}
            >
              立即刷新推荐数据
            </Button>
      ) : null}
      </p>
      ) : null}
    </div>
  ) : null

  return {
    controls,
    enabled,
    recommended:
      preview?.status === 'matched' ? (preview.recommended as ModelRecommendation) : undefined,
    /** 手动修改切换整份配置，运行时不再覆盖手动值。 */
    change: (next: EditableModel) => {
      sequence.current++
      setBusy(false)
      setError(null)
      onChange({ ...next, smartConfig: next.smartConfig ? { ...next.smartConfig, enabled: false, pinned: [...SmartConfigPinnedFields] } : undefined })
    },
  }
}
