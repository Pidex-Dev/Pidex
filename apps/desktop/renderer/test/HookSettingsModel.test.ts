import { describe, expect, test } from 'bun:test'
import type { DiscoveredHook, HookSourceGroup } from '@pidex/agent-protocol'
import {
  groupHooksByEvent,
  hookCountLabel,
  hookErrorCodeOf,
  hookErrorMessage,
  isWorkspaceScopeError,
  splitHookGroups,
} from '../src/features/settings/hooks/HookSettingsModel.js'

const makeHook = (overrides: Partial<DiscoveredHook> = {}): DiscoveredHook => ({
  identity: 'a'.repeat(64),
  id: 'h1',
  event: 'session_start',
  command: 'node start.js',
  filePath: 'C:\\data\\hooks.json',
  enabled: true,
  ...overrides,
})

const makeGroup = (overrides: Partial<HookSourceGroup> = {}): HookSourceGroup => ({
  id: 'config:user',
  kind: 'config',
  scope: 'user',
  displayName: '用户配置',
  scopeLabel: '所有项目',
  hooks: [makeHook()],
  diagnostics: [],
  ...overrides,
})

describe('Hook 设置模型', () => {
  test('按来自配置和来自插件拆分分组', () => {
    const { configGroups, pluginGroups } = splitHookGroups([
      makeGroup({ id: 'config:user', kind: 'config' }),
      makeGroup({ id: 'plugin:ponytail', kind: 'plugin', pluginId: 'ponytail', displayName: 'Ponytail' }),
    ])
    expect(configGroups.map((g) => g.id)).toEqual(['config:user'])
    expect(pluginGroups.map((g) => g.id)).toEqual(['plugin:ponytail'])
    expect(hookCountLabel(3)).toBe('3 个钩子')
  })

  test('按生命周期事件分组并优先展示 statusMessage 作为摘要', () => {
    const sections = groupHooksByEvent([
      makeHook({
        identity: 'b'.repeat(64),
        id: 's1',
        event: 'subagent_start',
        command: 'node sub.js',
        statusMessage: 'Loading ponytail mode...',
      }),
      makeHook({
        identity: 'a'.repeat(64),
        id: 's2',
        event: 'session_start',
        command: 'node start.js',
      }),
    ])
    expect(sections.map((s) => s.title)).toEqual(['SessionStart', '子智能体启动'])
    expect(sections[0]!.items[0]!.displayLabel).toBe('1 - node start.js')
    expect(sections[1]!.items[0]!.displayLabel).toBe('1 - Loading ponytail mode...')
  })

  test('错误码映射到用户可读提示并识别工作区作用域错误', () => {
    expect(hookErrorCodeOf({ code: 'CONFLICT' })).toBe('CONFLICT')
    expect(hookErrorCodeOf({ data: { code: 'HOOK_SOURCE_INVALID' } })).toBe('HOOK_SOURCE_INVALID')
    expect(hookErrorCodeOf(new Error('boom'))).toBeNull()
    expect(hookErrorMessage({ code: 'CONFLICT' })).toContain('冲突')
    expect(hookErrorMessage({ code: 'HOOK_INVALID', message: '配置无效' })).toBe('配置无效')
    expect(hookErrorMessage(null, '兜底')).toBe('兜底')
    expect(
      isWorkspaceScopeError({
        code: 'HOOK_SOURCE_INVALID',
        message: '项目不属于当前 Agent 已知工作区',
      }),
    ).toBe(true)
    expect(isWorkspaceScopeError({ code: 'HOOK_INVALID', message: '工作区' })).toBe(false)
  })
})
