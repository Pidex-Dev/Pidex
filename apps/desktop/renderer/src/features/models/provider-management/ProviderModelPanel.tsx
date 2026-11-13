import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DesktopProviderModelDefinition } from '../../../../shared/Types.js'
import { Button } from '../../../components/ui/Button.js'
import { editableModel, ModelEditor, normalizeEditableModel } from './ProviderEditorForm.js'
import { ProviderEditorNavigationGuard } from './ProviderEditorNavigationGuard.js'
import type { ProviderManagementPanelController } from '../../layout/shell/DesktopLayoutOutletContext.js'

/** 产品面可读的错误文本：只保留 message，剥离堆栈帧与内部源码路径，避免泄露实现细节。 */
function readableError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  const cleaned = raw
    .split('\n')
    .filter((line) => !/^\s*at\s/u.test(line))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return cleaned || '保存失败，请重试。'
}

export function ProviderModelPanel({
  panel,
  model,
  creating,
  nativeApi,
  providerId,
  baseUrl,
  onSave,
  onClose,
}: {
  panel: ProviderManagementPanelController
  model: DesktopProviderModelDefinition
  creating: boolean
  nativeApi?: string
  providerId: string
  baseUrl: string
  onSave: (model: DesktopProviderModelDefinition) => Promise<void>
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState(() => editableModel(model))
  const [savedDraft, setSavedDraft] = useState(() => JSON.stringify(draft))
  const dirty = JSON.stringify(draft) !== savedDraft
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const allowNavigation = useRef(false)
  const requestLeave = useRef<(() => Promise<boolean>) | null>(null)
  useEffect(() => {
    const beforeChange = () => allowNavigation.current
      ? Promise.resolve(true)
      : (requestLeave.current?.() ?? Promise.resolve(true))
    panel.beforeChange.current = beforeChange
    return () => {
      if (panel.beforeChange.current === beforeChange) panel.beforeChange.current = null
    }
  }, [panel.beforeChange])
  const close = onClose
  async function save(): Promise<boolean> {
    if (busy) return false
    const normalized = normalizeEditableModel(draft)
    if (normalized instanceof Error || !draft.id.trim()) {
      setError(normalized instanceof Error ? normalized.message : '模型 ID 不能为空。')
      return false
    }
    setBusy(true)
    setError(null)
    try {
      await onSave(normalized)
      setSavedDraft(JSON.stringify(draft))
      allowNavigation.current = true
      return true
    } catch (error) {
      setError(readableError(error))
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section aria-label={creating ? '添加模型' : '编辑模型'} className="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col tw:overflow-hidden">
      <div className="tw:flex-1 tw:p-4 tw:min-h-0 tw:overflow-y-auto">
        <fieldset
          disabled={busy}
          className="tw:m-0 tw:grid tw:min-w-0 tw:gap-4 tw:border-0 tw:p-0"
        >
          <ModelEditor
            providerId={providerId}
            baseUrl={baseUrl}
            model={draft}
            lockId={!creating}
            onChange={(next) => {
              allowNavigation.current = false
              setError(null)
              setDraft(next)
            }}
            {...(nativeApi ? { nativeApi } : {})}
          />
        </fieldset>
      </div>
      {error ? (
        <div className="tw:shrink-0 tw:px-5 tw:pb-2">
          <p role="alert" className="tw:m-0 tw:w-full tw:text-app-danger tw:type-1">
            {error}
          </p>
        </div>
      ) : null}
      <footer className="settings-management-dialog-footer tw:shrink-0">
        <Button size="md" color="secondary" disabled={busy} onClick={close}>
          取消
        </Button>
        <Button
          size="md"
          color="primary"
          disabled={busy}
          loading={busy}
          onClick={() => void save()}
        >
          {creating ? '添加模型' : '保存模型'}
        </Button>
      </footer>
      </section>
      <ProviderEditorNavigationGuard
        requestLeaveRef={requestLeave}
        dirty={dirty}
        busy={busy}
        allowNavigation={allowNavigation}
        onSave={save}
        onLeave={onClose}
      />
    </>
  )
}
