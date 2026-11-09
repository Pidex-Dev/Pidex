import { describe, expect, test } from 'bun:test'
import type { AppPage } from '../src/features/routing/PageDefinitions.js'
import { resolveAppPage } from '../src/features/routing/PageDefinitions.js'
import { canRunAppCommand } from '../src/features/layout/shell/AppCommandAvailability.js'

const pageOf = (pathname: string): AppPage | null => resolveAppPage(pathname)

function context(pathname: string, overrides: Record<string, boolean> = {}) {
  return {
    page: pageOf(pathname),
    hasWorkspace: true,
    browserAvailable: true,
    browserOpen: true,
    sideChatSupported: true,
    ...overrides,
  }
}

describe('命令可用条件', () => {
  test('工作区页面允许工作区级动作', () => {
    for (const pathname of ['/new', '/threads/task-1']) {
      for (const command of [
        'openFiles',
        'toggleBottomPanel',
        'stepWorkspaceLayout',
        'openBrowser',
        'reloadBrowser',
        'openReview',
        'openSideChat',
        'toggleTerminal',
      ] as const) {
        expect(canRunAppCommand(command, context(pathname))).toBe(true)
      }
    }
  })

  test('非工作区页面禁用全部工作区级动作', () => {
    for (const pathname of [
      '/projects/project-1',
      '/git',
      '/plugins',
      '/providers',
      '/pets',
      '/automations',
      '/pull-requests',
      '/workflows',
      '/settings/general',
      '/unknown',
    ]) {
      for (const command of [
        'openFiles',
        'toggleBottomPanel',
        'stepWorkspaceLayout',
        'openBrowser',
        'reloadBrowser',
        'openReview',
        'openSideChat',
        'toggleTerminal',
      ] as const) {
        expect(canRunAppCommand(command, context(pathname))).toBe(false)
      }
    }
  })

  test('缺工作区时只有文件面板不可用', () => {
    expect(canRunAppCommand('openFiles', context('/new', { hasWorkspace: false }))).toBe(false)
    expect(canRunAppCommand('toggleBottomPanel', context('/new', { hasWorkspace: false }))).toBe(true)
    expect(canRunAppCommand('openReview', context('/new', { hasWorkspace: false }))).toBe(true)
  })

  test('浏览器能力与打开状态分别限制打开与刷新', () => {
    expect(canRunAppCommand('openBrowser', context('/new', { browserAvailable: false }))).toBe(false)
    expect(canRunAppCommand('openBrowser', context('/new', { browserOpen: false }))).toBe(true)
    expect(canRunAppCommand('reloadBrowser', context('/new', { browserOpen: false }))).toBe(false)
    expect(canRunAppCommand('reloadBrowser', context('/new', { browserAvailable: false }))).toBe(
      false,
    )
  })

  test('侧边聊天需要 Agent 能力支持', () => {
    expect(canRunAppCommand('openSideChat', context('/new', { sideChatSupported: false }))).toBe(
      false,
    )
  })
})