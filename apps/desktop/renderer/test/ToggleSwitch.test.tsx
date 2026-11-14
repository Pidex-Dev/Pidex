import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToggleSwitch, type ToggleSwitchSize } from '../src/components/ui/ToggleSwitch.js'
import { expectSourceContains } from './SourceContract.js'

const SIZES: readonly ToggleSwitchSize[] = ['xs', 'sm', 'md', 'lg']

describe('ToggleSwitch 四档尺寸与样式契约', () => {
  test('默认输出 data-size="md"，并支持 xs/sm/md/lg 四档与可选 className', () => {
    const defaultHtml = renderToStaticMarkup(
      createElement(ToggleSwitch, {
        checked: false,
        onChange: () => {},
        ariaLabel: '默认开关',
      }),
    )
    expect(defaultHtml).toContain('data-size="md"')

    for (const size of SIZES) {
      const html = renderToStaticMarkup(
        createElement(ToggleSwitch, {
          checked: true,
          onChange: () => {},
          ariaLabel: `开关-${size}`,
          size,
          className: 'tw:ml-2',
        }),
      )
      expect(html).toContain(`data-size="${size}"`)
      expect(html).toContain('tw:ml-2')
      expect(html).toContain('data-state="checked"')
    }
  })

  test('ToggleSwitch.css 对齐 Radix Themes Switch 1.75 倍比例且不被 interaction.css 24px 最小高度锁死', () => {
    const css = readFileSync(new URL('../src/components/ui/ToggleSwitch.css', import.meta.url), 'utf8')
    const interactionCss = readFileSync(
      new URL('../src/styles/primitives/interaction.css', import.meta.url),
      'utf8',
    )
    expectSourceContains(css, "--cpx-switch-width: calc(var(--cpx-switch-height) * 1.75)")
    expectSourceContains(css, ".toggle-switch[data-size='xs']")
    expectSourceContains(css, "--cpx-switch-height: 16px")
    expectSourceContains(css, ".toggle-switch[data-size='sm']")
    expectSourceContains(css, "--cpx-switch-height: 20px")
    expectSourceContains(css, ".toggle-switch[data-size='md']")
    expectSourceContains(css, "--cpx-switch-height: 24px")
    expectSourceContains(css, ".toggle-switch[data-size='lg']")
    expectSourceContains(css, "--cpx-switch-height: 28px")
    expectSourceContains(
      css,
      'calc(var(--cpx-switch-width) - 2px - var(--cpx-switch-thumb-size) - var(--cpx-switch-thumb-gap) * 2)',
    )
    expectSourceContains(interactionCss, '.toggle-switch')
  })
})
