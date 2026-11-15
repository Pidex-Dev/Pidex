import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkbenchPanel, WorkbenchTabsHeader } from '../src/features/layout/dock/RightDock.js'
import { getWorkbenchRouteLaunchers, getWorkbenchTabDisplayTitle, getWorkbenchTabDefinition, createLauncherTab } from '../src/features/layout/tabs/WorkbenchTabRegistry.js'
import {
  NEW_PROVIDER_PANEL_ID,
  providerManagementRouteId,
  scopedProviderManagementTab,
} from '../src/features/models/provider-management/ProviderManagementPanelState.js'
import { BUILTIN_COMPOSITE_VIEWS } from '../src/features/layout/dock/CompositeViews.js'

test('供应商设置只跟随详情或新建路由，保持区域并排除编辑和聊天路由', () => {
  const tab = {
    id: 'provider-management',
    kind: 'provider-management',
    providerId: 'magpie',
    section: 'request',
  } as const
  expect(
    scopedProviderManagementTab(tab, '/providers', '?provider=deepseek&section=models'),
  ).toEqual({ ...tab, providerId: 'deepseek' })
  expect(providerManagementRouteId('/providers', '?newProvider=1')).toBe(NEW_PROVIDER_PANEL_ID)
  expect(scopedProviderManagementTab(tab, '/providers', '?newProvider=1')).toEqual({
    ...tab,
    providerId: NEW_PROVIDER_PANEL_ID,
  })
  for (const [path, search] of [
    ['/providers', ''],
    ['/providers', '?provider=magpie&edit=1'],
    ['/chat', '?provider=magpie'],
  ]) {
    expect(providerManagementRouteId(path!, search!)).toBeNull()
    expect(scopedProviderManagementTab(tab, path!, search!)).toBeNull()
  }
  expect(scopedProviderManagementTab(null, '/providers', '?provider=magpie')).toBeNull()
  expect(BUILTIN_COMPOSITE_VIEWS['provider-management']).toMatchObject({
    allowedLocations: ['right'],
    canMove: false,
    canFloat: false,
    canClose: true,
  })
})


test('模型编辑面板仅保留在当前供应商详情的右侧', () => {
  const tab = { id: 'provider-model', kind: 'provider-model', providerId: 'magpie', section: 'model' } as const
  expect(scopedProviderManagementTab(tab, '/providers', '?provider=magpie')).toEqual(tab)
  expect(scopedProviderManagementTab(tab, '/providers', '?provider=deepseek')).toBeNull()
  expect(scopedProviderManagementTab(tab, '/chat', '?provider=magpie')).toBeNull()
})


test('路由定义统一提供空状态与添加标签菜单的可用标签', () => {
  const provider = getWorkbenchRouteLaunchers({ page: 'providers', providerId: 'magpie' })
  expect(provider.map(({ id, label }) => ({ id, label }))).toEqual([
    { id: 'provider-management', label: '供应商设置' },
  ])
  expect(provider.map((entry) => entry.createTab())).toEqual([
    { id: 'provider-management', kind: 'provider-management', providerId: 'magpie', section: 'credentials' },
  ])
  expect(provider.map((entry) => getWorkbenchTabDisplayTitle(entry.createTab()!))).toEqual(['供应商设置'])
  expect(getWorkbenchRouteLaunchers({ page: 'conversation' }).some((entry) => entry.kind === 'provider-management')).toBe(false)
  expect(getWorkbenchRouteLaunchers({ page: 'conversation' }, false).some((entry) => entry.kind === 'side-chat')).toBe(false)
  expect(getWorkbenchRouteLaunchers({ page: 'providers', providerId: 'other' })[0]!.createTab()).toMatchObject({ providerId: 'other' })
})


test('所有路由只列出 launcher 标签，内容面板仍支持模块打开', () => {
  const routes = [{ page: 'conversation' }, { page: 'providers', providerId: 'magpie' }] as const
  for (const route of routes) {
    const launchers = getWorkbenchRouteLaunchers(route)
    expect(launchers.every((entry) => entry.launcher)).toBe(true)
    expect(launchers.some((entry) => entry.kind === 'provider-model' || entry.kind === 'plan')).toBe(false)
    expect(createLauncherTab('provider-model', route)).toBeNull()
    expect(createLauncherTab('plan', route)).toBeNull()
  }
  const model = { id: 'provider-model', kind: 'provider-model', providerId: 'magpie', section: 'model' } as const
  expect(getWorkbenchTabDefinition(model)).toMatchObject({ launcher: false, routes: ['providers'] })
  expect(getWorkbenchTabDisplayTitle(model, null)).toBe('编辑模型')
  expect(getWorkbenchTabDefinition('plan').launcher).toBe(false)
  expect(BUILTIN_COMPOSITE_VIEWS['provider-model'].allowedLocations).toEqual(['right'])
})

test('可自启动面板不超过 1 个时不显示空状态 launcher 和标签栏添加按钮', () => {
  const noop = () => {}
  const providerTab = {
    id: 'provider-management',
    kind: 'provider-management',
    providerId: 'magpie',
    section: 'credentials',
  } as const
  const reviewTab = { id: 'review', kind: 'review' } as const

  const providerStrip = renderToStaticMarkup(
    createElement(WorkbenchTabsHeader, {
      onCloseOtherTabs: noop,
      onCloseTab: noop,
      onCloseTabsToRight: noop,
      onCreateSideChat: noop,
      onMoveTab: noop,
      onOpenTab: noop,
      onPinTab: noop,
      onReorderTab: noop,
      onSelectTab: noop,
      panelRoute: { page: 'providers', providerId: 'magpie' },
      sideChatAvailable: false,
      state: { open: true, activeTabId: providerTab.id, tabIds: [providerTab.id] },
      tabsById: { [providerTab.id]: providerTab },
      target: 'right',
      terminalDisplayPath: null,
    }),
  )
  expect(providerStrip).not.toContain('right-dock-add-button')

  const conversationStrip = renderToStaticMarkup(
    createElement(WorkbenchTabsHeader, {
      onCloseOtherTabs: noop,
      onCloseTab: noop,
      onCloseTabsToRight: noop,
      onCreateSideChat: noop,
      onMoveTab: noop,
      onOpenTab: noop,
      onPinTab: noop,
      onReorderTab: noop,
      onSelectTab: noop,
      panelRoute: { page: 'conversation' },
      sideChatAvailable: true,
      state: { open: true, activeTabId: reviewTab.id, tabIds: [reviewTab.id] },
      tabsById: { [reviewTab.id]: reviewTab },
      target: 'right',
      terminalDisplayPath: null,
    }),
  )
  expect(conversationStrip).toContain('right-dock-add-button')

  const panelContext = {
    browser: { availability: { status: 'available' } },
    files: { availability: { status: 'available' } },
    goal: {},
    plan: {},
    review: { onToggleReviewView: noop },
    sideChat: { available: true },
    terminal: { availability: { status: 'available' } },
  } as never
  const emptyBaseProps = {
    maxWidth: 800,
    minWidth: 200,
    onClose: noop,
    onCloseOtherTabs: noop,
    onCloseTab: noop,
    onCloseTabsToRight: noop,
    onCreateSideChat: noop,
    onFileLoadError: noop,
    onMoveTab: noop,
    onOpenFileFromBrowser: noop,
    onOpenTab: noop,
    onPinTab: noop,
    onPreviewFile: noop,
    onRecreateSideChat: noop,
    onReorderTab: noop,
    onResetWidth: noop,
    onSelectTab: noop,
    onSetWidth: noop,
    panelContext,
    sessionId: null,
    state: { open: true, activeTabId: null, tabIds: [] },
    tabsById: {},
    target: 'right' as const,
    width: 400,
  }

  const providerEmptyPanel = renderToStaticMarkup(
    createElement(WorkbenchPanel, {
      ...emptyBaseProps,
      panelRoute: { page: 'providers', providerId: 'magpie' },
    }),
  )
  expect(providerEmptyPanel).not.toContain('right-panel-tabs-empty-state')

  const conversationEmptyPanel = renderToStaticMarkup(
    createElement(WorkbenchPanel, {
      ...emptyBaseProps,
      panelRoute: { page: 'conversation' },
    }),
  )
  expect(conversationEmptyPanel).toContain('right-panel-tabs-empty-state')
})
