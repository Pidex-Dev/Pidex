import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DesktopModelProviderSummary } from '../shared/Types.js'
import { ConfigSettings } from '../src/features/settings/ConfigSettings.js'
import {
  SETTINGS_GROUPS,
  createSettingsTargetId,
} from '../src/features/settings/SettingsRegistry.js'
import { SpecializedModelSelect } from '../src/features/settings/SpecializedModelSelect.js'
import { DesktopSettingsProvider } from '../src/features/settings/UseDesktopSettings.js'

const SAMPLE_PROVIDERS: DesktopModelProviderSummary[] = [
  {
    providerID: 'openai',
    displayName: 'OpenAI',
    providerKind: 'builtin',
    defaultModels: ['gpt-5.4-mini'],
    apiKeyConfigured: true,
    apiKeySource: 'stored',
    modelMetadata: {
      'gpt-5.4-mini': {
        name: 'GPT-5.4 Mini',
      },
    },
  },
]

describe('ConfigSettings', () => {
  test('renders consolidated specialized models, config files section, and accurate copy', () => {
    const html = renderToStaticMarkup(
      <DesktopSettingsProvider>
        <ConfigSettings onError={() => {}} />
      </DesktopSettingsProvider>,
    )

    expect(html).toContain('管理专用模型、配置 Profile、配置文件与提示词诊断。')
    expect(html).toContain('配置文件与 Profile')
    expect(html).toContain('选择配置 Profile、配置层并打开对应的配置文件。')
    expect(html).toContain('专用模型')
    expect(html).toContain(`id="${createSettingsTargetId('config')}"`)
    expect(html).toContain(`id="${createSettingsTargetId('config', '生成模型')}"`)
    expect(html).toContain(`id="${createSettingsTargetId('config', '整理模型')}"`)
    expect(html).toContain(`id="${createSettingsTargetId('config', '代码模型')}"`)
    expect(html).toContain(`id="${createSettingsTargetId('config', '安全模型（实验）')}"`)
    expect(html).toContain('生成模型')
    expect(html).toContain('整理模型')
    expect(html).toContain('代码模型')
    expect(html).toContain('安全模型（实验）')
    expect(html).toContain('跟随会话主模型')

    expect(html).not.toContain('智能体默认设置')
    expect(html).not.toContain('配置审批策略和命令执行范围')
    expect(html).not.toContain('权限设置已移至「权限」页')
    expect(html).not.toContain('上面的会话主模型')
    expect(html).not.toContain('CLI/TUI')
  })

  test('SpecializedModelSelect displays provider/model label and reset button only when value is set', () => {
    const emptyHtml = renderToStaticMarkup(
      <SpecializedModelSelect
        value=""
        specializedModelKey="generationModel"
        providers={SAMPLE_PROVIDERS}
        onChange={() => {}}
      />,
    )
    expect(emptyHtml).toContain('跟随会话主模型')
    expect(emptyHtml).not.toContain('恢复默认（跟随会话主模型）')

    const configuredHtml = renderToStaticMarkup(
      <SpecializedModelSelect
        value="openai/gpt-5.4-mini"
        specializedModelKey="generationModel"
        providers={SAMPLE_PROVIDERS}
        onChange={() => {}}
      />,
    )
    expect(configuredHtml).toContain('OpenAI / GPT-5.4 Mini')
    expect(configuredHtml).toContain('恢复默认（跟随会话主模型）')
  })

  test('uses unified onError callback instead of window.alert and drops CLI/TUI copy', async () => {
    const source = await readFile(
      new URL('../src/features/settings/ConfigSettings.tsx', import.meta.url),
      'utf8',
    )

    expect(source).not.toContain('window.alert')
    expect(source).not.toContain('CLI/TUI')
    expect(source).toContain('reportError')

    const appGroup = SETTINGS_GROUPS.find((group) => group.id === 'app')
    const config = appGroup?.items.find((item) => item.routeId === 'config')
    const profileRow = config?.rows.find((row) => row.title === 'Profile')
    expect(profileRow?.description).toBe('选择启动配置 Profile；切换后重启 Pidex 生效')
  })
})
