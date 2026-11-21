import type { Item } from '@pidex/shared/thread'
import { isFileMutationTool } from './CanonicalItemRenderer.js'
import { toolDetailKind } from './ToolCommandCard.js'
import type { ToolActivityIconKind } from './ToolActivityPresentation.js'

type ToolItem = Extract<Item, { type: 'tool' }>

export type RepeatedProcessGroupRun = {
  kind: 'repeated'
  key: string
  baseLabel: string
  label: string
  iconKind: ToolActivityIconKind
  active: boolean
  failed: boolean
  items: ToolItem[]
}

export type ProcessGroupRun = { kind: 'single'; item: Item } | RepeatedProcessGroupRun

type RepeatedToolIdentity = {
  key: string
  baseLabel: string
  iconKind: ToolActivityIconKind
}

function isToolActive(item: ToolItem): boolean {
  return item.state === 'pending' || item.state === 'waiting-permission' || item.state === 'running'
}

function isToolFailed(item: ToolItem): boolean {
  return item.state === 'error' || item.state === 'interrupted'
}

function repeatedToolIdentity(item: Item): RepeatedToolIdentity | null {
  if (item.type !== 'tool') return null
  if (isFileMutationTool(item)) return null
  if (toolDetailKind(item) !== 'generic') return null

  const descriptor = item.activity
  if (!descriptor) {
    const toolName = item.tool.trim()
    if (!toolName) return null
    return {
      key: `raw:${toolName.toLowerCase()}`,
      baseLabel: `调用工具 ${toolName}`,
      iconKind: 'tool',
    }
  }

  switch (descriptor.type) {
    case 'integration': {
      const source = descriptor.source?.trim()
      return {
        key: `integration:${(source || 'unknown').toLowerCase()}`,
        baseLabel: source ? `使用 ${source}` : '使用集成',
        iconKind: 'integration',
      }
    }
    case 'tool': {
      const name = descriptor.name?.trim() || item.tool.trim()
      if (descriptor.mode === 'search') {
        return {
          key: 'tool:search',
          baseLabel: '搜索工具',
          iconKind: 'tool',
        }
      }
      if (descriptor.mode === 'load') {
        return {
          key: `tool:load:${name.toLowerCase()}`,
          baseLabel: name ? `加载工具 ${name}` : '加载工具',
          iconKind: 'skill',
        }
      }
      return {
        key: `tool:call:${name.toLowerCase()}`,
        baseLabel: name ? `调用工具 ${name}` : '调用工具',
        iconKind: 'tool',
      }
    }
    case 'web_search':
      return {
        key: 'web_search',
        baseLabel: '搜索网页',
        iconKind: 'web-search',
      }
    case 'command': {
      if (descriptor.kind === 'current_time') {
        return {
          key: 'command:current_time',
          baseLabel: '检查当前日期和时间',
          iconKind: 'current-time',
        }
      }
      return null
    }
    default:
      return null
  }
}

/**
 * Collapses consecutive calls to the same generic/MCP/integration tool inside
 * an expanded process group into a nested disclosure run while keeping shell
 * commands and file mutations as standalone rows.
 */
export function groupRepeatedProcessItems(items: readonly Item[]): ProcessGroupRun[] {
  const runs: ProcessGroupRun[] = []
  let currentIdentity: RepeatedToolIdentity | null = null
  let currentBucket: ToolItem[] = []

  const flush = (): void => {
    if (currentBucket.length === 0) return
    if (currentBucket.length === 1 || !currentIdentity) {
      for (const item of currentBucket) {
        runs.push({ kind: 'single', item })
      }
    } else {
      const first = currentBucket[0]!
      const active = currentBucket.some(isToolActive)
      const failed = !active && currentBucket.some(isToolFailed)
      runs.push({
        kind: 'repeated',
        key: `repeated:${first.id}:${currentIdentity.key}`,
        baseLabel: currentIdentity.baseLabel,
        label: `${currentIdentity.baseLabel} · ${currentBucket.length} 次调用`,
        iconKind: currentIdentity.iconKind,
        active,
        failed,
        items: currentBucket,
      })
    }
    currentIdentity = null
    currentBucket = []
  }

  for (const item of items) {
    const identity = repeatedToolIdentity(item)
    if (!identity) {
      flush()
      runs.push({ kind: 'single', item })
      continue
    }
    if (currentIdentity && currentIdentity.key === identity.key) {
      currentBucket.push(item as ToolItem)
    } else {
      flush()
      currentIdentity = identity
      currentBucket = [item as ToolItem]
    }
  }

  flush()
  return runs
}
