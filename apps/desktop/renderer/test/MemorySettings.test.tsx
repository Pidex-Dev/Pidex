import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemorySettings } from '../src/features/settings/MemorySettings.js'
import { SETTINGS_ITEMS } from '../src/features/settings/SettingsRegistry.js'
import { DesktopSettingsProvider } from '../src/features/settings/UseDesktopSettings.js'

function renderMemorySettings(workspacePath: string | null): string {
  return renderToStaticMarkup(
    <DesktopSettingsProvider>
      <MemorySettings workspacePath={workspacePath} />
    </DesktopSettingsProvider>,
  )
}

describe('memory settings workspace scope', () => {
  test('renders markdown memory scopes and global toggle for a workspace', () => {
    const html = renderMemorySettings('  D:\\CodeProject\\Current  ')

    expect(html).toContain('启用记忆')
    expect(html).toContain('Markdown 文件是唯一正文来源')
    expect(html).toContain('用户记忆')
    expect(html).toContain('当前项目')
    expect(html).not.toContain('Agent data directory / project memory')
  })

  test('keeps the global toggle and hides project scope option without a workspace', () => {
    const html = renderMemorySettings(null)

    expect(html).toContain('启用记忆')
    expect(html).toContain('用户记忆')
    expect(html).not.toContain('>当前项目<')
  })

  test('describes the workspace as the current read-only scope', () => {
    const memorySettings = SETTINGS_ITEMS.find((item) => item.routeId === 'memory')

    expect(memorySettings?.description).toBe('自动记忆、当前工作区和召回时间线')
    expect(memorySettings?.rows.find((row) => row.title === '工作区')?.description).toBe(
      '显示当前工作区，项目记忆按工作区隔离',
    )
    expect(
      memorySettings?.rows.some((row) => row.description.includes('选择记忆所属的工作区')),
    ).toBeFalse()
  })
})
