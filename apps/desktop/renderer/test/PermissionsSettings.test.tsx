import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocaleProvider } from '../src/features/i18n/LocaleProvider.js'
import { ConfigSettings } from '../src/features/settings/ConfigSettings.js'
import { GeneralSettings } from '../src/features/settings/GeneralSettings.js'
import { PermissionsSettings } from '../src/features/settings/PermissionsSettings.js'
import { createSettingsTargetId } from '../src/features/settings/SettingsRegistry.js'
import { DesktopSettingsProvider } from '../src/features/settings/UseDesktopSettings.js'

describe('PermissionsSettings consolidation', () => {
  test('renders consolidated permission controls and inline approval rules section inside PermissionsSettings', () => {
    const html = renderToStaticMarkup(
      <DesktopSettingsProvider>
        <PermissionsSettings workspacePath="F:/demo" />
      </DesktopSettingsProvider>,
    )

    expect(html).toContain(`id="${createSettingsTargetId('permissions', '权限预设')}"`)
    expect(html).toContain(`id="${createSettingsTargetId('permissions', 'Shell 安全级别')}"`)
    expect(html).toContain('Shell 安全')
    expect(html).toContain('权限预设')
    expect(html).toContain('权限说明')
    expect(html).toContain('Shell 安全级别')
    expect(html).toContain('审批规则')
    expect(html).not.toContain('安全模型（实验）')
  })

  test('does not render moved permission settings in GeneralSettings or ConfigSettings', () => {
    const generalHtml = renderToStaticMarkup(
      <LocaleProvider>
        <DesktopSettingsProvider>
          <GeneralSettings />
        </DesktopSettingsProvider>
      </LocaleProvider>,
    )
    const configHtml = renderToStaticMarkup(
      <DesktopSettingsProvider>
        <ConfigSettings />
      </DesktopSettingsProvider>,
    )

    expect(generalHtml).not.toContain('当前权限')
    expect(generalHtml).not.toContain('权限说明')
    expect(configHtml).not.toContain('权限预设')
    expect(configHtml).not.toContain('管理审批规则')
    expect(configHtml).not.toContain('Shell 安全级别')
  })
})
