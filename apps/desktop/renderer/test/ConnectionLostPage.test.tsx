import { afterEach, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  ConnectionLostPage,
  RequireAgentConnection,
  resolveConnectionReturnTarget,
} from '../src/features/routing/ConnectionLostPage.js'
import {
  publishStartupConnectionSnapshot,
  resetStartupConnectionStore,
} from '../src/startup/StartupConnection.js'

afterEach(() => {
  resetStartupConnectionStore()
})

describe('resolveConnectionReturnTarget', () => {
  test('保留有效的原路由，并在缺失或指向自身时回退到 /new', () => {
    expect(resolveConnectionReturnTarget({ returnTo: '/settings/general?tab=1' })).toBe(
      '/settings/general?tab=1',
    )
    expect(resolveConnectionReturnTarget(null)).toBe('/new')
    expect(resolveConnectionReturnTarget({ returnTo: 'https://example.com' })).toBe('/new')
    expect(resolveConnectionReturnTarget({ returnTo: '/connection-lost' })).toBe('/new')
    expect(resolveConnectionReturnTarget({ returnTo: '/connection-lost?foo=1' })).toBe('/new')
  })
})

describe('ConnectionLostPage', () => {
  test('重连中显示鲸鱼加载动效与状态文案', () => {
    publishStartupConnectionSnapshot({
      generation: 2,
      revision: 1,
      state: 'loading',
      label: 'Agent 连接中断，正在重试',
    })

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/connection-lost'] },
        createElement(ConnectionLostPage),
      ),
    )

    expect(html).toContain('Pidex')
    expect(html).toContain('full-screen-whale-loader')
    expect(html).toContain('Agent 连接中断，正在重试')
    expect(html).not.toContain('重试连接')
  })

  test('连接失败时显示错误标题及重试与日志操作按钮', () => {
    publishStartupConnectionSnapshot({
      generation: 2,
      revision: 2,
      state: 'failed',
      label: 'Agent 连接失败，请重试或查看日志',
    })

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/connection-lost'] },
        createElement(ConnectionLostPage),
      ),
    )

    expect(html).toContain('Agent 连接失败，请重试或查看日志')
    expect(html).toContain('重试连接')
    expect(html).toContain('打开日志')
  })

  test('恢复连接后不再渲染断连页并准备返回原页面', () => {
    publishStartupConnectionSnapshot({
      generation: 2,
      revision: 3,
      state: 'connected',
      label: 'ready',
    })

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        {
          initialEntries: [{ pathname: '/connection-lost', state: { returnTo: '/settings/general' } }],
        },
        createElement(ConnectionLostPage),
      ),
    )

    expect(html).toBe('')
  })

  test('业务路由在已连接时正常渲染并在断连时拦截输出', () => {
    publishStartupConnectionSnapshot({
      generation: 3,
      revision: 1,
      state: 'connected',
      label: 'ready',
    })

    const connectedHtml = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/settings/general'] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(RequireAgentConnection) },
            createElement(Route, {
              path: '/settings/general',
              element: createElement('div', null, 'settings-page'),
            }),
          ),
        ),
      ),
    )
    expect(connectedHtml).toContain('settings-page')

    publishStartupConnectionSnapshot({
      generation: 3,
      revision: 2,
      state: 'loading',
      label: '正在重新连接…',
    })

    const disconnectedHtml = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/settings/general'] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(RequireAgentConnection) },
            createElement(Route, {
              path: '/settings/general',
              element: createElement('div', null, 'settings-page'),
            }),
          ),
        ),
      ),
    )
    expect(disconnectedHtml).toBe('')
  })
})
