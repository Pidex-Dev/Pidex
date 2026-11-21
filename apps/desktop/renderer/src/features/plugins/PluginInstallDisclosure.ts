import type { PluginDetails, PluginInstallSource } from '@pidex/agent-protocol'
import type { PluginCatalogItem } from './PluginCatalog.js'

/**
 * Pre-install disclosure. Installation only writes plugin files; it never
 * grants tool execution, so the dialog must say so explicitly.
 */
export type PluginInstallDisclosure = {
  pluginId: string
  /** Marketplace repository or local source name; never a filesystem path. */
  repository: string | null
  catalogRevision: string | null
  version: string | null
  skills: ReadonlyArray<{ id: string; name: string; description: string }>
  /** Host-managed MCP servers the host would activate. */
  hostManagedMcp: ReadonlyArray<{ id: string; name: string; description: string }>
  /**
   * True until the plugin manifest is on disk. An empty component list then only
   * means the catalog did not declare it, so the dialog must not claim "none".
   */
  manifestPending: boolean
  /** Declared components the host only diagnoses and never runs. */
  unsupportedComponents: readonly string[]
  /** False when the host could not disclose install provenance. */
  complete: boolean
}

export const PLUGIN_INSTALL_PERMISSION_NOTICE =
  '安装只会写入插件文件，不会授予执行权限；插件提供的技能与工具仍受统一权限和审批限制。'

export const PLUGIN_INSTALL_DISCLOSURE_UNAVAILABLE =
  '无法读取插件的安装来源与组件清单。为避免来源不明的安装，请刷新后重试。'

export function pluginInstallDisclosure(
  item: PluginCatalogItem,
  details: PluginDetails | null | undefined,
): PluginInstallDisclosure {
  const source: PluginInstallSource | undefined = details?.installSource
  const skills = source
    ? source.components
        .filter((component) => component.kind === 'skill')
        .map(({ id, name, description }) => ({ id, name, description }))
    : (details?.skills ?? (item.skills ?? []).map((id) => ({ id, name: id, description: '' })))
  const hostManagedMcp = source
    ? source.components
        .filter((component) => component.kind === 'mcp' && component.managedBy === 'host')
        .map(({ id, name, description }) => ({ id, name, description }))
    : []
  return {
    pluginId: item.id,
    repository: source?.repository ?? null,
    catalogRevision: source?.catalogRevision ?? null,
    version: source?.version ?? item.version ?? null,
    skills,
    hostManagedMcp,
    manifestPending: !item.installed,
    unsupportedComponents: source?.unsupportedComponents ?? [],
    complete: Boolean(source),
  }
}

/** Revision to echo into `plugin/install`; omitted for local sources. */
export function pluginInstallRevision(disclosure: PluginInstallDisclosure): string | undefined {
  return disclosure.catalogRevision ?? undefined
}

export function pluginInstallSourceLabel(disclosure: PluginInstallDisclosure): string {
  if (!disclosure.repository) return '未知来源'
  if (/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(disclosure.repository)) return disclosure.repository
  const labels: Record<string, string> = {
    bundled: '自带插件',
    installed: '已安装',
    workspace: '项目插件',
    personal: '个人插件',
  }
  return labels[disclosure.repository] ?? disclosure.repository
}

export function pluginInstallSummaryLines(disclosure: PluginInstallDisclosure): readonly string[] {
  return [
    `来源：${pluginInstallSourceLabel(disclosure)}`,
    ...(disclosure.catalogRevision ? [`目录版本：${disclosure.catalogRevision}`] : []),
    ...(disclosure.version ? [`版本：${disclosure.version}`] : []),
  ]
}
