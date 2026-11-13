import type { PluginDetails } from '@pidex/agent-protocol'
import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog.js'
import { desktopClient } from '../../services/desktop-client/index.js'
import type { PluginCatalogItem } from './PluginCatalog.js'
import {
  PLUGIN_INSTALL_DISCLOSURE_UNAVAILABLE,
  PLUGIN_INSTALL_PERMISSION_NOTICE,
  pluginInstallDisclosure,
  pluginInstallRevision,
  pluginInstallSourceLabel,
  type PluginInstallDisclosure,
} from './PluginInstallDisclosure.js'

export type PluginInstallConfirmation = { revision?: string }

/**
 * True when the host rejected an install because the catalog moved. The caller
 * should reload details so the user confirms the new revision.
 */
export function isPluginInstallConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { errorCode?: unknown }).errorCode
  if (code === 'CONFLICT') return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.includes('插件目录已更新')
}

type PendingInstall = {
  item: PluginCatalogItem
  disclosure: PluginInstallDisclosure | null
  error: string | null
  /** Resolves with the echoed catalog revision, or null when cancelled. */
  resolve: (confirmation: PluginInstallConfirmation | null) => void
}

/**
 * Shared install confirmation for every entry point (catalog card, details
 * page, "立即试用" and deep links). Install never grants execution, so the
 * dialog discloses source, revision, activated and skipped components.
 */
export function usePluginInstallConfirmation(workspacePath?: string | null) {
  const [pending, setPending] = useState<PendingInstall | null>(null)
  const resolveRef = useRef<PendingInstall['resolve'] | null>(null)

  const settle = useCallback((confirmation: PluginInstallConfirmation | null) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setPending(null)
    resolve?.(confirmation)
  }, [])

  const confirmInstall = useCallback(
    async (
      item: PluginCatalogItem,
      details?: PluginDetails | null,
    ): Promise<PluginInstallConfirmation | null> => {
      let disclosed = details ?? null
      try {
        if (!disclosed) disclosed = await desktopClient.getPluginDetails(item.id, workspacePath)
      } catch {
        disclosed = null
      }
      const disclosure = pluginInstallDisclosure(item, disclosed)
      return new Promise<PluginInstallConfirmation | null>((resolve) => {
        resolveRef.current = resolve
        setPending({
          item,
          disclosure: disclosure.complete ? disclosure : null,
          error: disclosure.complete ? null : PLUGIN_INSTALL_DISCLOSURE_UNAVAILABLE,
          resolve,
        })
      })
    },
    [workspacePath],
  )

  const dialog: React.ReactNode = (
    <ConfirmationDialog
      open={pending !== null}
      title={pending ? `安装 ${pending.item.name}？` : '安装插件？'}
      description={
        pending ? (
          <PluginInstallDisclosureContent
            disclosure={pending.disclosure}
            fallbackError={pending.error}
          />
        ) : undefined
      }
      actionLabel="安装"
      actionDisabled={pending?.disclosure === null}
      onCancel={() => settle(null)}
      onAction={() =>
        settle({
          ...(pending?.disclosure ? { revision: pluginInstallRevision(pending.disclosure) } : {}),
        })
      }
    />
  )

  return { confirmInstall, dialog }
}

function PluginInstallDisclosureContent({
  disclosure,
  fallbackError,
}: {
  disclosure: PluginInstallDisclosure | null
  fallbackError: string | null
}): React.ReactNode {
  if (!disclosure)
    return <p className="tw:m-0">{fallbackError ?? PLUGIN_INSTALL_DISCLOSURE_UNAVAILABLE}</p>
  return (
    <div className="plugin-install-disclosure tw:grid tw:gap-2">
      <dl className="plugin-install-disclosure__facts tw:m-0 tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:gap-x-3 tw:gap-y-1">
        <dt className="tw:text-app-text-soft">来源</dt>
        <dd className="tw:m-0 tw:wrap-anywhere">{pluginInstallSourceLabel(disclosure)}</dd>
        {disclosure.catalogRevision ? (
          <>
            <dt className="tw:text-app-text-soft">目录版本</dt>
            <dd className="tw:m-0 tw:wrap-anywhere">{disclosure.catalogRevision}</dd>
          </>
        ) : null}
        {disclosure.version ? (
          <>
            <dt className="tw:text-app-text-soft">插件版本</dt>
            <dd className="tw:m-0 tw:wrap-anywhere">{disclosure.version}</dd>
          </>
        ) : null}
      </dl>
      <PluginInstallComponentList
        title="Skills"
        emptyLabel="不包含技能"
        items={disclosure.skills.map((skill) => skill.name)}
      />
      <PluginInstallComponentList
        title="宿主管理 MCP"
        emptyLabel={disclosure.manifestPending ? '安装后由宿主按清单确定' : '不包含宿主管理 MCP'}
        items={disclosure.hostManagedMcp.map((server) => server.name)}
      />
      {disclosure.unsupportedComponents.length ? (
        <PluginInstallComponentList
          title="不可用组件（仅诊断，不执行）"
          emptyLabel=""
          items={disclosure.unsupportedComponents}
        />
      ) : null}
      <p className="plugin-install-disclosure__notice tw:m-0 tw:text-app-text-soft">
        {PLUGIN_INSTALL_PERMISSION_NOTICE}
      </p>
    </div>
  )
}

function PluginInstallComponentList({
  title,
  items,
  emptyLabel,
}: {
  title: string
  items: readonly string[]
  emptyLabel: string
}): React.ReactNode {
  return (
    <div className="plugin-install-disclosure__group tw:grid tw:gap-1">
      <strong className="tw:text-app-text">{title}</strong>
      {items.length ? (
        <span className="tw:text-app-text-soft tw:wrap-anywhere">{items.join('、')}</span>
      ) : (
        <span className="tw:text-app-text-meta">{emptyLabel}</span>
      )}
    </div>
  )
}
