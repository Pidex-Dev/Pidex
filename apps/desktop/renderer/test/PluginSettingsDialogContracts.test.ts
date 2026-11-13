import { describe, expect, test } from 'bun:test'

describe('插件设置与详情弹窗契约', () => {
  test('App 与 Skill 详情弹窗使用自适应 max-h-[85vh]，不固定 640px 高度', async () => {
    const [appDialog, skillDialog, hookSettings] = await Promise.all([
      Bun.file(
        new URL('../src/features/settings/plugins/AppDetailsDialog.tsx', import.meta.url),
      ).text(),
      Bun.file(
        new URL('../src/features/settings/plugins/SkillDetailsDialog.tsx', import.meta.url),
      ).text(),
      Bun.file(new URL('../src/features/settings/hooks/HookSettings.tsx', import.meta.url)).text(),
    ])

    for (const source of [appDialog, skillDialog, hookSettings]) {
      expect(source).toContain('tw:w-[min(640px,calc(100vw-32px))]')
      expect(source).toContain('tw:max-h-[85vh]')
      expect(source).not.toContain('tw:h-[min(640px,85vh)]')
    }
  })

  test('PluginsSettingsPage 不包含无输入假成功的添加插件市场弹窗', async () => {
    const pluginsSettings = await Bun.file(
      new URL('../src/features/settings/plugins/PluginsSettingsPage.tsx', import.meta.url),
    ).text()

    expect(pluginsSettings).not.toContain('已成功添加插件市场源。')
    expect(pluginsSettings).not.toContain('添加插件市场')
    expect(pluginsSettings).not.toContain('addMarketplaceOpen')
  })

  test('所有 Skills 图标统一使用 Lightbulb（插件详情页技能列表除外）', async () => {
    const [
      builtinPresentation,
      pluginsSettings,
      skillDialog,
      pluginProductDetails,
      skillCatalogCard,
      catalogDetails,
      userMessageContent,
      workbenchTabs,
      sidebarPlugins,
    ] = await Promise.all([
      Bun.file(new URL('../src/features/plugins/BuiltinSkillPresentation.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/features/settings/plugins/PluginsSettingsPage.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/features/settings/plugins/SkillDetailsDialog.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/features/plugins/PluginProductDetailsView.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/features/plugins/SkillCatalogCard.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/features/plugins/CatalogDetailsView.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/features/session/timeline/CanonicalUserMessageContent.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/features/layout/tabs/WorkbenchTabRegistry.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/features/layout/sidebar/SidebarPluginsPane.tsx', import.meta.url)).text(),
    ])

    for (const source of [
      builtinPresentation,
      pluginsSettings,
      skillDialog,
      pluginProductDetails,
      skillCatalogCard,
      catalogDetails,
      userMessageContent,
      workbenchTabs,
      sidebarPlugins,
    ]) {
      expect(source).toContain('<Lightbulb')
    }
  })

  test('PluginSettingsDetailsView 技能与钩子分栏展示且不包含左侧灯泡', async () => {
    const pluginSettingsDetails = await Bun.file(
      new URL('../src/features/settings/plugins/PluginSettingsDetailsView.tsx', import.meta.url),
    ).text()

    expect(pluginSettingsDetails).not.toContain('<Lightbulb')
    expect(pluginSettingsDetails).not.toContain('tw:type-section-title')
    expect(pluginSettingsDetails).toContain('<ToggleSwitch')
    expect(pluginSettingsDetails).toContain('>技能</h2>')
    expect(pluginSettingsDetails).toContain('>钩子</h2>')
    expect(pluginSettingsDetails).toContain('在设置中管理')
  })
})
