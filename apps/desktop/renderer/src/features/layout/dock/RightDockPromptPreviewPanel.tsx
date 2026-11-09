import { useEffect, useState } from 'react'
import type React from 'react'
import { RefreshCw } from 'lucide-react'
import { APP_ICON_SIZE } from '../../../components/ui/IconTokens.js'
import { Button } from '../../../components/ui/Button.js'
import { ScrollArea } from '../../../components/ui/ScrollArea.js'
import {
  WorkbenchPanelEmpty,
  WorkbenchPanelError,
  WorkbenchPanelLoading,
} from '../panels/WorkbenchPanelStates.js'
import { desktopClient } from '../../../services/desktop-client/index.js'

type PromptPreviewPayload = {
  previewKind?: 'frozen' | 'estimated'
  turnId?: string
  compositionId?: string
  [key: string]: unknown
}

/**
 * 完整提示词诊断面板：读取当前任务的 system/developer/contextual-user 组成，
 * 仅在用户主动打开或刷新时读取，内容不写入日志或遥测。
 */
export function RightDockPromptPreviewPanel({
  sessionId,
}: {
  sessionId: string | null
}): React.ReactNode {
  const [preview, setPreview] = useState<PromptPreviewPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reloadVersion, setReloadVersion] = useState(0)

  useEffect(() => {
    if (!sessionId) {
      setPreview(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    desktopClient
      .getSessionPromptPreview(sessionId)
      .then((result) => {
        if (!cancelled) setPreview(result as PromptPreviewPayload)
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error && cause.message ? cause.message : '提示词预览读取失败。')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadVersion, sessionId])

  if (!sessionId) {
    return (
      <WorkbenchPanelEmpty title="提示词预览" description="请先打开一个任务，再预览提示词。" />
    )
  }
  if (error) {
    return (
      <WorkbenchPanelError
        title="无法读取提示词预览"
        message={error}
        retryable
        onRetry={() => setReloadVersion((version) => version + 1)}
      />
    )
  }
  if (loading || preview === null) {
    return <WorkbenchPanelLoading label="正在读取提示词预览…" />
  }
  const previewKind = preview.previewKind === 'frozen' ? '冻结快照 (frozen)' : '预计内容 (estimated)'
  return (
    <ScrollArea
      aria-label="当前任务完整提示词"
      className="right-dock-plan-scroll-area tw:min-h-0 tw:min-w-0 tw:flex-1 tw:bg-app-dock"
      contentClassName="right-dock-plan-scroll-content tw:min-w-0 tw:p-4"
    >
      <div className="tw:mx-auto tw:flex tw:w-full tw:max-w-[48rem] tw:flex-col tw:gap-3">
        <div className="tw:flex tw:items-center tw:justify-between tw:gap-2">
          <span className="tw:type-secondary tw:text-app-text-soft">
            {previewKind}
            {preview.turnId ? ` · turn ${preview.turnId}` : ''}
          </span>
          <Button
            color="ghostSecondary"
            isIconOnly
            size="sm"
            title="重新读取提示词预览"
            onClick={() => setReloadVersion((version) => version + 1)}
          >
            <RefreshCw size={APP_ICON_SIZE} />
          </Button>
        </div>
        <pre className="tw:m-0 tw:whitespace-pre tw:break-words tw:type-code tw:text-app-text">
          {JSON.stringify(preview, null, 2)}
        </pre>
      </div>
    </ScrollArea>
  )
}
