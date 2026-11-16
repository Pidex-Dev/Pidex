import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ConfigSettings } from '../src/features/settings/ConfigSettings.js'
import { StorageSettings } from '../src/features/settings/StorageSettings.js'
import { createSettingsTargetId } from '../src/features/settings/SettingsRegistry.js'
import { DesktopSettingsProvider } from '../src/features/settings/UseDesktopSettings.js'

describe('StorageSettings data location migration', () => {
  test('renders the data location section inside StorageSettings with its search target id', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StorageSettings onError={() => {}} />
      </MemoryRouter>,
    )

    expect(html).toContain(`id="${createSettingsTargetId('storage', '数据位置')}"`)
    expect(html).toContain('数据位置')
    expect(html).toContain('当前数据目录')
    expect(html).toContain('配置文件')
    expect(html).toContain('Provider 凭据文件（可选）')
    expect(html).toContain('快速恢复')
    expect(html).toContain('更改位置')
    expect(html).toContain('选择目录')
  })

  test('does not render the data location section inside ConfigSettings', () => {
    const html = renderToStaticMarkup(
      <DesktopSettingsProvider>
        <ConfigSettings />
      </DesktopSettingsProvider>,
    )

    expect(html).not.toContain('数据位置')
    expect(html).not.toContain('当前数据目录')
    expect(html).not.toContain('更改位置')
    expect(html).not.toContain('选择目录')
  })
})
