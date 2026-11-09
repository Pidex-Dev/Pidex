import { describe, expect, test } from 'bun:test'
import {
  APP_PAGES,
  pageIdForNavView,
  pageTitle,
  resolveAppPage,
  sidebarRailDestinations,
} from '../src/features/routing/PageDefinitions.js'
import { sidebarPaneForRoute } from '../src/features/layout/sidebar/SidebarNavigation.js'
import { TOP_NAV_ITEMS } from '../src/features/layout/sidebar/SidebarTopNav.js'

describe('页面定义', () => {
  test('解析主页、聊天、项目与独立页面', () => {
    const cases: Array<[string, string, string]> = [
      ['/new', 'home', '新对话'],
      ['/threads/task-1', 'chat', '会话'],
      ['/projects', 'projects', '项目'],
      ['/projects/project-1', 'projects', '项目'],
      ['/workflows', 'workflows', '工作组'],
      ['/workflows/group-1', 'workflows', '工作组'],
      ['/git', 'git', 'Git 看板'],
      ['/plugins', 'plugins', '插件与技能'],
      ['/plugins/detail', 'plugins', '插件与技能'],
      ['/providers', 'providers', '供应商'],
      ['/providers/detail', 'providers', '供应商'],
      ['/pets', 'pets', '宠物'],
      ['/automations', 'automations', '已安排'],
      ['/pull-requests', 'pullRequests', '拉取请求'],
      ['/settings/general', 'settings', '设置'],
      ['/settings/environment/project-1', 'settings', '设置'],
    ]
    for (const [pathname, id, title] of cases) {
      const page = resolveAppPage(pathname)
      expect(page?.id).toBe(id)
      expect(pageTitle(page)).toBe(title)
    }
  })

  test('相似路径与未知路径不误匹配', () => {
    for (const pathname of ['/projectsfoo', '/gitx', '/pluginsx', '/threads/a/b', '/unknown']) {
      expect(resolveAppPage(pathname)).toBeNull()
      expect(pageTitle(resolveAppPage(pathname))).toBe('Pidex Desktop')
    }
  })

  test('项目页复用设置外壳，不当作聊天工作区', () => {
    expect(resolveAppPage('/projects')?.workspace).toBe(false)
    expect(resolveAppPage('/projects/project-1')?.workspace).toBe(false)
    expect(resolveAppPage('/new')?.workspace).toBe(true)
    expect(resolveAppPage('/threads/task-1')?.workspace).toBe(true)
  })

  test('侧栏归属与页面解析一致', () => {
    expect(sidebarPaneForRoute('/new', false)).toBe('chats')
    expect(sidebarPaneForRoute('/new', true)).toBe('activity')
    expect(sidebarPaneForRoute('/threads/task-1', false)).toBe('chats')
    expect(sidebarPaneForRoute('/projects/project-1', true)).toBe('activity')
    expect(sidebarPaneForRoute('/automations', false)).toBe('scheduled')
    expect(sidebarPaneForRoute('/settings/appearance', false)).toBe('settings')
    expect(sidebarPaneForRoute('/plugins/detail', false)).toBe('plugins')
    expect(sidebarPaneForRoute('/providers/detail', false)).toBe('providers')
    expect(sidebarPaneForRoute('/git', false)).toBe('git')
    expect(sidebarPaneForRoute('/pets', false)).toBe('pets')
    expect(sidebarPaneForRoute('/workflows', false)).toBeNull()
    expect(sidebarPaneForRoute('/pull-requests', false)).toBeNull()
    expect(sidebarPaneForRoute('/unknown', false)).toBeNull()
  })

  test('导航入口从页面定义生成，且与既有顺序一致', () => {
    expect(APP_PAGES.filter((page) => page.nav).map((page) => page.nav!.view)).toEqual([
      'new',
      'projects',
      'sessionGroups',
      'automations',
      'git',
      'plugins',
      'providers',
      'pets',
    ])
    expect(TOP_NAV_ITEMS.map((item) => ({ view: item.view, label: item.label, path: item.path })))
      .toEqual([
        { view: 'new', label: '新建任务', path: '/new' },
        { view: 'sessionGroups', label: '工作组', path: '/workflows' },
        { view: 'automations', label: '已安排', path: '/automations' },
        { view: 'git', label: 'Git 看板', path: '/git' },
        { view: 'plugins', label: '插件', path: '/plugins' },
        { view: 'providers', label: '供应商', path: '/providers' },
        { view: 'pets', label: '宠物市场', path: '/pets' },
      ])
    expect(pageIdForNavView('projects')).toBe('projects')
    expect(pageIdForNavView('search')).toBeNull()
  })

  test('导航轨目的地来自页面定义的侧栏面板与分组', () => {
    expect(sidebarRailDestinations()).toEqual([
      { id: 'sessionGroups', group: 'other', pane: null },
      { id: 'automations', group: 'fixed', pane: 'scheduled' },
      { id: 'git', group: 'other', pane: 'git' },
      { id: 'plugins', group: 'fixed', pane: 'plugins' },
      { id: 'providers', group: 'other', pane: 'providers' },
      { id: 'pets', group: 'other', pane: 'pets' },
    ])
  })

  test('页面定义不包含未接线的导航入口', () => {
    expect(APP_PAGES.some((page) => page.nav?.path === '/search')).toBe(false)
    expect(APP_PAGES.some((page) => page.nav?.path === '/sites')).toBe(false)
    expect(APP_PAGES.some((page) => page.nav?.path === '/pull-requests')).toBe(false)
  })
})