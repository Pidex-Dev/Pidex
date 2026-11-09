import { matchPath } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import {
  BrainCircuit,
  Clock3,
  Egg,
  FolderKanban,
  GitBranch,
  MessagesSquare,
  Plug,
  SquarePen,
} from 'lucide-react'
import type { ProtocolCapability } from '@pidex/agent-protocol'
import type { AppView } from '../../UiTypes.js'

/**
 * 页面定义是 Renderer 内页面路径、名称与侧栏归属的唯一来源。
 * 只描述客户端展示与适用场景，不替代 Agent 权限或运行时能力判定。
 */

export type SidebarPane =
  | 'git'
  | 'chats'
  | 'activity'
  | 'scheduled'
  | 'plugins'
  | 'providers'
  | 'pets'
  | 'settings'

/** 导航轨目的地键：与 sidebarCustomization.destinationOrder 中的 id 一一对应。 */
export type SidebarRailDestinationId =
  | 'git'
  | 'automations'
  | 'plugins'
  | 'providers'
  | 'pets'
  | 'sessionGroups'

export type AppPageId =
  | 'home'
  | 'chat'
  | 'projects'
  | 'workflows'
  | 'git'
  | 'plugins'
  | 'providers'
  | 'pets'
  | 'automations'
  | 'pullRequests'
  | 'settings'

export type AppPageNav = {
  view: AppView
  label: string
  path: string
  icon: LucideIcon
  /** null 表示所有环境都可用。 */
  capabilities: readonly ProtocolCapability[] | null
  /** 该入口是否出现在导航轨的目的地列表，以及所在分组。 */
  rail?: { id: SidebarRailDestinationId; group: 'fixed' | 'other' }
}

export type AppPage = {
  id: AppPageId
  /** React Router 路径模式；用 matchPath 解析，避免自行拼接前缀判断。 */
  patterns: readonly string[]
  /** 无障碍标题与 document.title 前缀。 */
  title: string
  /** 主页或聊天工作区：承载工作区工具栏、底部面板、文件与聊天侧栏。 */
  workspace: boolean
  /** 侧栏归属；workspace 表示按设置落在 chats 或 activity 面板。 */
  sidebar: { kind: 'workspace' } | { kind: 'pane'; pane: SidebarPane } | null
  nav?: AppPageNav
}

/**
 * 顺序即导航入口顺序；`projects` 位于工作组与已安排之间，
 * 由调用方通过 showProjects 决定是否显示。
 */
export const APP_PAGES: readonly AppPage[] = [
  {
    id: 'home',
    patterns: ['/new'],
    title: '新对话',
    workspace: true,
    sidebar: { kind: 'workspace' },
    nav: {
      view: 'new',
      label: '新建任务',
      path: '/new',
      icon: SquarePen,
      capabilities: null,
    },
  },
  {
    id: 'chat',
    patterns: ['/threads/:threadId'],
    title: '会话',
    workspace: true,
    sidebar: { kind: 'workspace' },
  },
  {
    id: 'projects',
    patterns: ['/projects', '/projects/:projectId'],
    title: '项目',
    // 项目页复用的设置外壳，不承载聊天工作区工具栏与底部面板。
    workspace: false,
    sidebar: { kind: 'workspace' },
    nav: {
      view: 'projects',
      label: '项目',
      path: '/projects',
      icon: FolderKanban,
      capabilities: null,
    },
  },
  {
    id: 'workflows',
    patterns: ['/workflows', '/workflows/:groupId'],
    title: '工作组',
    workspace: false,
    sidebar: null,
    nav: {
      view: 'sessionGroups',
      label: '工作组',
      path: '/workflows',
      icon: MessagesSquare,
      capabilities: ['workflow.v1', 'session-group.v1'],
      rail: { id: 'sessionGroups', group: 'other' },
    },
  },
  {
    id: 'automations',
    patterns: ['/automations'],
    title: '已安排',
    workspace: false,
    sidebar: { kind: 'pane', pane: 'scheduled' },
    nav: {
      view: 'automations',
      label: '已安排',
      path: '/automations',
      icon: Clock3,
      capabilities: null,
      rail: { id: 'automations', group: 'fixed' },
    },
  },
  {
    id: 'git',
    patterns: ['/git'],
    title: 'Git 看板',
    workspace: false,
    sidebar: { kind: 'pane', pane: 'git' },
    nav: {
      view: 'git',
      label: 'Git 看板',
      path: '/git',
      icon: GitBranch,
      capabilities: ['git.review.v1'],
      rail: { id: 'git', group: 'other' },
    },
  },
  {
    id: 'plugins',
    patterns: ['/plugins', '/plugins/*'],
    title: '插件与技能',
    workspace: false,
    sidebar: { kind: 'pane', pane: 'plugins' },
    nav: {
      view: 'plugins',
      label: '插件',
      path: '/plugins',
      icon: Plug,
      capabilities: ['skills.manage.v1', 'mcp.manage.v1'],
      rail: { id: 'plugins', group: 'fixed' },
    },
  },
  {
    id: 'providers',
    patterns: ['/providers', '/providers/*'],
    title: '供应商',
    workspace: false,
    sidebar: { kind: 'pane', pane: 'providers' },
    nav: {
      view: 'providers',
      label: '供应商',
      path: '/providers',
      icon: BrainCircuit,
      capabilities: null,
      rail: { id: 'providers', group: 'other' },
    },
  },
  {
    id: 'pets',
    patterns: ['/pets'],
    title: '宠物',
    workspace: false,
    sidebar: { kind: 'pane', pane: 'pets' },
    nav: {
      view: 'pets',
      label: '宠物市场',
      path: '/pets',
      icon: Egg,
      capabilities: ['pets.management.v1'],
      rail: { id: 'pets', group: 'other' },
    },
  },
  {
    id: 'pullRequests',
    patterns: ['/pull-requests'],
    title: '拉取请求',
    workspace: false,
    sidebar: null,
  },
  {
    id: 'settings',
    patterns: ['/settings/:tab', '/settings/environment/:projectId'],
    title: '设置',
    workspace: false,
    sidebar: { kind: 'pane', pane: 'settings' },
  },
]

const UNKNOWN_PAGE_TITLE = 'Pidex Desktop'

export function resolveAppPage(pathname: string): AppPage | null {
  for (const page of APP_PAGES) {
    if (page.patterns.some((pattern) => matchPath(pattern, pathname) !== null)) return page
  }
  return null
}

export function pageTitle(page: AppPage | null): string {
  return page?.title ?? UNKNOWN_PAGE_TITLE
}

/** 导航轨目的地：顺序、分组与侧栏面板都来自所属页面。 */
export function sidebarRailDestinations(): Array<{
  id: SidebarRailDestinationId
  group: 'fixed' | 'other'
  pane: SidebarPane | null
}> {
  return APP_PAGES.flatMap((page) =>
    page.nav?.rail
      ? [
          {
            id: page.nav.rail.id,
            group: page.nav.rail.group,
            pane: page.sidebar?.kind === 'pane' ? page.sidebar.pane : null,
          },
        ]
      : [],
  )
}

/** 导航入口 ID 到页面 ID：用于没有侧栏面板的入口判断选中状态。 */
export function pageIdForNavView(view: AppView): AppPageId | null {
  return APP_PAGES.find((page) => page.nav?.view === view)?.id ?? null
}