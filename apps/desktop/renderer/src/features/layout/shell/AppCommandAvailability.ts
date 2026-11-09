import type { AppPage } from '../../routing/PageDefinitions.js'

/**
 * 菜单与快捷键共用的可用条件：菜单的 enabled 状态、点击执行和快捷键拦截
 * 都必须先经过同一判定，避免“菜单可点但无动作”或快捷键吃掉按键。
 */
export type AppCommandId =
  | 'openFiles'
  | 'toggleBottomPanel'
  | 'stepWorkspaceLayout'
  | 'openBrowser'
  | 'reloadBrowser'
  | 'openReview'
  | 'openSideChat'
  | 'toggleTerminal'

export type AppCommandContext = {
  /** 当前页面解析结果；未知路径为 null。 */
  page: AppPage | null
  hasWorkspace: boolean
  browserAvailable: boolean
  browserOpen: boolean
  sideChatSupported: boolean
}

/**
 * 主页与聊天工作区承载工作区级动作；其余页面只保留全局命令。
 * 浏览器相关动作额外要求宿主能力，刷新还要求浏览器已打开。
 */
export function canRunAppCommand(command: AppCommandId, context: AppCommandContext): boolean {
  const onWorkspacePage = context.page?.workspace === true
  switch (command) {
    case 'openFiles':
      return onWorkspacePage && context.hasWorkspace
    case 'toggleBottomPanel':
    case 'stepWorkspaceLayout':
    case 'toggleTerminal':
    case 'openReview':
      return onWorkspacePage
    case 'openBrowser':
      return onWorkspacePage && context.browserAvailable
    case 'reloadBrowser':
      return onWorkspacePage && context.browserAvailable && context.browserOpen
    case 'openSideChat':
      return onWorkspacePage && context.sideChatSupported
  }
}