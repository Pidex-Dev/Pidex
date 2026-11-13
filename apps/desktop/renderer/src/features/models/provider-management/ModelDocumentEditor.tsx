import { SmartConfigPinnedFields } from '@pidex/agent-protocol'
import { useEffect, useRef, useState } from 'react'
import type { RpcResult } from '@pidex/agent-protocol'
import type { RpcParams } from '@pidex/agent-protocol'
import { Button } from '../../../components/ui/Button.js'
import { Input } from '../../../components/ui/Input.js'
import { SettingsDropdown } from '../../settings/SettingsDropdown.js'
import { SpecializedModelSelect } from '../../settings/SpecializedModelSelect.js'
import { desktopClient } from '../../../services/desktop-client/index.js'
import { toUserErrorMessage } from '../../../utils/Errors.js'
import type { EditableModel } from './ProviderEditorForm.js'
import { fillModelDraft } from './SmartModelDraft.js'

type Candidate = RpcResult<'model/document/extract'>['candidates'][number]
export function ModelDocumentEditor({
  model,
  onChange,
}: {
  model: EditableModel
  onChange: (model: EditableModel) => void
}) {
  const [supported, setSupported] = useState(false)
  const [url, setUrl] = useState(model.smartConfig?.document?.url ?? '')
  const [extractor, setExtractor] = useState(() => {
    const ref = model.smartConfig?.document?.extractor
    return ref ? `${ref.providerID}/${ref.id}` : ''
  })
  const [pending, setPending] = useState<Candidate[]>([])
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef<string | null>(null)
  const identity = useRef(model.id)
  identity.current = model.id
  useEffect(() => {
    let live = true
    void desktopClient.modelRecommendations?.documentsSupported().then((value) => {
      if (live) setSupported(value)
    })
    return () => {
      live = false
      if (active.current) void desktopClient.modelRecommendations?.cancelDocument(active.current)
      active.current = null
    }
  }, [])
  useEffect(() => {
    if (active.current) void desktopClient.modelRecommendations?.cancelDocument(active.current)
    active.current = null
    setBusy(false)
    setPending([])
  }, [model.id])
  function cancel() {
    if (active.current) void desktopClient.modelRecommendations?.cancelDocument(active.current)
    active.current = null
    setBusy(false)
    setPending([])
  }
  if (!supported) return null
  const source = model.smartConfig?.source ?? 'catalog'
  const candidate = pending[selected]
  const proposed = candidate ? fillModelDraft(model, candidate.snapshot.data) : model
  const differences = Object.keys(proposed).filter(
    (key) =>
      JSON.stringify(proposed[key as keyof EditableModel]) !==
      JSON.stringify(model[key as keyof EditableModel]),
  )
  const setSource = (source: 'catalog' | 'document') => {
    cancel()
    onChange({
      ...model,
      smartConfig: {
        ...model.smartConfig,
        pinned:
          model.smartConfig !== undefined &&
          model.smartConfig.enabled !== false &&
          !model.smartConfig.pinned.length
            ? []
            : [...SmartConfigPinnedFields],
        enabled:
          model.smartConfig !== undefined &&
          model.smartConfig.enabled !== false &&
          !model.smartConfig.pinned.length,
        source,
      },
    })
  }
  async function extract() {
    const operationId = crypto.randomUUID(),
      modelId = model.id
    active.current = operationId
    setBusy(true)
    setError('')
    setPending([])
    const slash = extractor.indexOf('/')
    try {
      const result = await desktopClient.modelRecommendations!.extractDocument({
        operationId,
        url,
        modelId,
        ...(slash > 0
          ? {
              extractor: {
                providerID: extractor.slice(0, slash),
                id: extractor.slice(slash + 1),
              } as NonNullable<RpcParams<'model/document/extract'>['extractor']>,
            }
          : {}),
      })
      if (active.current !== operationId || identity.current !== modelId) return
      setPending([...result.candidates])
      setSelected(0)
      if (!result.candidates.length)
        setError('文档未找到可验证的模型资料，请检查地址或选择其他提取模型。')
    } catch (cause) {
      if (active.current === operationId) setError(toUserErrorMessage(cause))
    } finally {
      if (active.current === operationId) {
        active.current = null
        setBusy(false)
      }
    }
  }
  return (
    <div className="tw:grid tw:gap-3">
      <SettingsDropdown
        ariaLabel="智能配置资料来源"
        value={source}
        options={[
          { value: 'catalog', label: '默认资料库' },
          { value: 'document', label: '自定义文档' },
        ]}
        onChange={(value) => setSource(value as 'catalog' | 'document')}
      />
      {source === 'document' ? (
        <>
          <label>
            文档地址
            <Input
              aria-label="模型文档地址"
              value={url}
              placeholder="https://…"
              onChange={(event) => {
                cancel()
                setUrl(event.target.value)
              }}
            />
          </label>
          <SpecializedModelSelect
            label="资料提取模型"
            value={extractor}
            mainModel="默认聊天模型"
            specializedModelKey="generationModel"
            onChange={(value) => {
              cancel()
              setExtractor(value)
            }}
          />
          <div className="tw:flex tw:gap-2">
            <Button
              size="sm"
              disabled={busy || !url.trim() || !model.id.trim()}
              onClick={() => void extract()}
            >
              提取资料
            </Button>
            {busy ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (active.current)
                    void desktopClient.modelRecommendations?.cancelDocument(active.current)
                  active.current = null
                  setBusy(false)
                }}
              >
                取消提取
              </Button>
            ) : null}
          </div>
          {busy ? (
            <p role="status" className="tw:m-0">
              正在读取文档并提取资料…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="tw:m-0 tw:text-app-danger">
              {error}
            </p>
          ) : null}
          {candidate ? (
            <div className="tw:grid tw:gap-2">
              <SettingsDropdown
                ariaLabel="文档模型候选"
                value={String(selected)}
                options={pending.map((item, i) => ({ value: String(i), label: item.modelId }))}
                onChange={(value) => setSelected(Number(value))}
              />
              <p className="tw:m-0 tw:type-1">
                以下差异始终以当前草稿为准，采用前请核对模型与原文。
              </p>
              {differences.map((key) => (
                <div key={key} className="tw:type-1 tw:break-words">
                  <strong>
                    {{
                      name: '显示名称',
                      modelType: '模型类型',
                      contextWindow: '上下文窗口',
                      maxTokens: '最大输出',
                      maxInputTokens: '最大输入',
                      reasoning: '推理',
                      tools: '工具',
                      inputCost: '输入价格',
                      outputCost: '输出价格',
                      cacheReadCost: '缓存读取价格',
                      cacheWriteCost: '缓存写入价格',
                      pricing: '分时／原币价格',
                      reasoningLevelValues: '推理档位',
                      imageInput: '图像输入',
                      audioInput: '音频输入',
                      videoInput: '视频输入',
                    }[key] ?? key}
                  </strong>
                  ：{JSON.stringify(model[key as keyof EditableModel]) ?? '未设置'} →{' '}
                  {JSON.stringify(proposed[key as keyof EditableModel])}
                </div>
              ))}
              {!differences.length ? <p className="tw:m-0">资料与当前草稿一致。</p> : null}
              {candidate.snapshot.evidence.map((quote, index) => (
                <blockquote key={index} className="tw:m-0 tw:type-1">
                  {quote}
                </blockquote>
              ))}
              <Button
                size="sm"
                onClick={() => {
                  onChange({
                    ...proposed,
                    smartConfig: {
                      ...model.smartConfig,
                      pinned: [],
                      enabled: true,
                      source: 'document',
                      document: candidate.snapshot,
                    },
                  })
                  setPending([])
                }}
              >
                采用资料
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
