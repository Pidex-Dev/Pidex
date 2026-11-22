import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocaleProvider } from '../src/features/i18n/LocaleProvider.js'
import { GeneralSettings } from '../src/features/settings/GeneralSettings.js'
import {
  SETTINGS_GROUPS,
  SETTINGS_SEARCH_DOCUMENTS,
} from '../src/features/settings/SettingsRegistry.js'
import { DesktopSettingsProvider } from '../src/features/settings/UseDesktopSettings.js'

const REMOVED_CONTROLS_AND_TYPOS = [
  '需按 ^ + 回车键发送长文本提示',
  '速度',
  '建议提示',
  '从其他 AI 应用导入工作内容',
  '打开源许可证',
  '实现性',
  '实验性',
  'Rust Glob / Grep / Diff 内核',
  '弹出窗口快捷键',
  '默认使用无项目聊天',
] as const

describe('GeneralSettings', () => {
  test('renders backed general settings controls without placeholder or ineffective switches', () => {
    const html = renderToStaticMarkup(
      <DesktopSettingsProvider>
        <LocaleProvider preference="zh-CN">
          <GeneralSettings />
        </LocaleProvider>
      </DesktopSettingsProvider>,
    )

    expect(html).toContain('默认打开目标')
    expect(html).toContain('集成终端 Shell')
    expect(html).toContain('允许普通模式提问')
    expect(html).toContain('代码审查')
    expect(html).toContain('AI 审查结果')
    expect(html).toContain('消息输入预测')
    expect(html).toContain('轮次完成通知')
    expect(html).toContain('显示上下文窗口使用量')
    expect(html).toContain('上下文用量展示方式')

    for (const label of REMOVED_CONTROLS_AND_TYPOS) {
      expect(html).not.toContain(label)
    }
    expect(html).not.toContain('弹出窗口')
  })

  test('renders translated real sections in en-US without removed experimental toggle', () => {
    const html = renderToStaticMarkup(
      <DesktopSettingsProvider>
        <LocaleProvider preference="en-US">
          <GeneralSettings />
        </LocaleProvider>
      </DesktopSettingsProvider>,
    )

    expect(html).toContain('Default open target')
    expect(html).toContain('Notifications')
    expect(html).toContain('Conversation footer')
    expect(html).not.toContain('Rust Glob / Grep / Diff kernels')
    expect(html).not.toContain('Open source licenses')
    expect(html).not.toContain('Pop-up window')
  })

  test('keeps general settings search registry aligned with real controls', () => {
    const appGroup = SETTINGS_GROUPS.find((group) => group.id === 'app')
    const general = appGroup?.items.find((item) => item.routeId === 'general')
    const generalDocs = SETTINGS_SEARCH_DOCUMENTS.filter((doc) => doc.tabId === 'general')

    expect(general).toBeDefined()
    for (const removed of [...REMOVED_CONTROLS_AND_TYPOS, '跟进行为']) {
      expect(general?.rows.some((item) => item.title === removed)).toBeFalse()
      expect(generalDocs.some((doc) => doc.rowTitle === removed)).toBeFalse()
    }

    for (const expectedTitle of [
      '默认打开目标',
      '集成终端 Shell',
      '语言',
      '允许普通模式提问',
      '代码审查',
      'AI 审查结果',
      '消息输入预测',
      '通知',
      '显示上下文窗口使用量',
      '上下文用量展示方式',
    ]) {
      expect(general?.rows.some((item) => item.title === expectedTitle)).toBeTrue()
      expect(generalDocs.some((doc) => doc.rowTitle === expectedTitle)).toBeTrue()
    }
  })
})
