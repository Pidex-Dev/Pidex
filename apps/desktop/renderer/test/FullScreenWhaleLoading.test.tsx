import { describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FullScreenWhaleLoading } from '../src/components/ui/FullScreenWhaleLoading.js'
import { WorkbenchPanelLoading } from '../src/features/layout/panels/WorkbenchPanelStates.js'
import { ThreadScrollLayout } from '../src/features/session/conversation/ThreadScrollLayout.js'
import {
  resolveModelSetupLoadingLabel,
  SetupBootState,
} from '../src/features/models/setup/RequireConfiguredModel.js'

describe('FullScreenWhaleLoading', () => {
  test('renders only the shared whale icon and shimmer by default without visible text', () => {
    const html = renderToStaticMarkup(<FullScreenWhaleLoading label="正在读取模型配置…" />)

    expect(html).toContain('class="full-screen-whale-loader"')
    expect(html).toContain('data-full-screen-loading="true"')
    expect(html).toContain('data-loading-label="正在读取模型配置…"')
    expect(html).toContain('src="/pidex-mark-green.svg"')
    expect(html).toContain('full-screen-whale-loader__base')
    expect(html).toContain('full-screen-whale-loader__overlay')
    expect(html).not.toContain('full-screen-whale-loader__status-viewport')
    expect(html).not.toContain('>正在读取模型配置…<')
    expect(html).not.toContain('ui-button-spinner')
  })

  test('exposes accessible status label while hiding decorative logo art', () => {
    const html = renderToStaticMarkup(<FullScreenWhaleLoading label="正在打开模型设置…" />)

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="正在打开模型设置…"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-atomic="true"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('alt=""')
    expect(html).not.toContain('>正在打开模型设置…<')
  })

  test('SetupBootState delegates to the label-less full-screen whale loader', () => {
    const html = renderToStaticMarkup(<SetupBootState label="正在读取桌面设置…" />)

    expect(html).toContain('data-full-screen-loading="true"')
    expect(html).toContain('data-loading-label="正在读取桌面设置…"')
    expect(html).toContain('aria-label="正在读取桌面设置…"')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('full-screen-whale-loader__status-viewport')
    expect(html).not.toContain('>正在读取桌面设置…<')
    expect(html).not.toContain('ui-button-spinner')
  })

  test('renders contained variant without fullscreen attribute, contained class, or visible text', () => {
    const html = renderToStaticMarkup(
      <FullScreenWhaleLoading label="正在加载会话内容…" variant="contained" />,
    )

    expect(html).toContain('class="full-screen-whale-loader full-screen-whale-loader--contained"')
    expect(html).not.toContain('data-full-screen-loading="true"')
    expect(html).toContain('data-loading-variant="contained"')
    expect(html).toContain('data-loading-label="正在加载会话内容…"')
    expect(html).toContain('aria-label="正在加载会话内容…"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('full-screen-whale-loader__status-viewport')
    expect(html).not.toContain('>正在加载会话内容…<')
  })

  test('renders contained variant without label when showLabel is false', () => {
    const html = renderToStaticMarkup(
      <FullScreenWhaleLoading label="正在加载子智能体…" showLabel={false} variant="contained" />,
    )

    expect(html).toContain('<div class="full-screen-whale-loader full-screen-whale-loader--contained"')
    expect(html).not.toContain('<main ')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="正在加载子智能体…"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('data-loading-label="正在加载子智能体…"')
    expect(html).toContain('full-screen-whale-loader__logo')
    expect(html).not.toContain('full-screen-whale-loader__status-viewport')
    expect(html).not.toContain('>正在加载子智能体…<')
  })

  test('WorkbenchPanelLoading delegates to label-less contained whale loader', () => {
    const html = renderToStaticMarkup(<WorkbenchPanelLoading label="正在加载子智能体…" />)

    expect(html).toContain('workbench-panel-loading')
    expect(html).toContain('full-screen-whale-loader full-screen-whale-loader--contained')
    expect(html).toContain('aria-label="正在加载子智能体…"')
    expect(html).not.toContain('full-screen-whale-loader__status-viewport')
    expect(html).not.toContain('ui-spinner')
    expect(html).not.toContain('workbench-panel-state__spinner')
  })

  test('ThreadScrollLayout stretches content slot so contained loading centers vertically', () => {
    const html = renderToStaticMarkup(
      <ThreadScrollLayout scrollRef={createRef()} footerRef={createRef()}>
        <FullScreenWhaleLoading label="正在加载会话内容…" variant="contained" />
      </ThreadScrollLayout>,
    )

    expect(html).toContain('thread-scroll-layout__content')
    expect(html).toContain('tw:flex-[1_0_auto]')
    expect(html).toContain('full-screen-whale-loader--contained')
  })

  test('resolves real-stage labels from provider and settings state', () => {
    expect(resolveModelSetupLoadingLabel(false, false)).toBe('正在读取模型配置…')
    expect(resolveModelSetupLoadingLabel(false, true)).toBe('正在读取模型配置…')
    expect(resolveModelSetupLoadingLabel(true, false)).toBe('正在读取桌面设置…')
    expect(resolveModelSetupLoadingLabel(true, true)).toBe('正在准备模型设置…')
  })
})
