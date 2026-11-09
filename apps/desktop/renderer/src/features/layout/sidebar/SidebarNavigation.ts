import { resolveAppPage, type SidebarPane } from '../../routing/PageDefinitions.js'

export type { SidebarPane } from '../../routing/PageDefinitions.js'

export const SIDEBAR_RAIL_WIDTH = 52
export const MODERN_SIDEBAR_DEFAULT_WIDTH = 340
export const MODERN_SIDEBAR_MIN_WIDTH = 290

/**
 * 页面到侧栏面板的唯一映射：聊天与项目共用任务侧栏，
 * 具体落在 chats 还是 activity 由侧栏活动视图设置决定。
 */
export function sidebarPaneForRoute(pathname: string, activity: boolean): SidebarPane | null {
  const page = resolveAppPage(pathname)
  if (!page?.sidebar) return null
  if (page.sidebar.kind === 'workspace') return activity ? 'activity' : 'chats'
  return page.sidebar.pane
}
