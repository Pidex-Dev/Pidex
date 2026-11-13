import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { expectSourceContains, normalizeSource } from './SourceContract.js'

/*
 * Frozen contracts for the non-color design-token refactor.
 *
 * This suite intentionally describes the FUTURE state of the token system and
 * is allowed to fail against today's source. It statically reads the real
 * files with node:fs; there are no snapshots and no quantity baselines.
 *
 * Frozen semantics (do not weaken to make tests green):
 * - tokens.css defines semantic type roles, a corrected 4px spacing scale,
 *   semantic radius/motion/z-index roles, and no root --control-/--layout-/
 *   --app-icon-/--menu- geometry tokens.
 * - CheckStyleContracts.ts + style-contracts.json grow a featureTokenContract
 *   that governs non-color tokens across styles, TSX, inline styles, Tailwind
 *   arbitrary values and component geometry, with precise reasons and stale
 *   detection.
 * - base.css reduced-motion zeroes every system motion token.
 */

function read(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), 'utf8')
}

function extractTokens(source: string): Map<string, string> {
  const tokens = new Map<string, string>()
  for (const match of source.matchAll(/(^|[\r\n])[ \t]*(--[\w-]+)[ \t]*:[ \t]*([^;]+);/g)) {
    // 值里的换行只是格式化折行，CSS 声明本身与空白无关。
    tokens.set(match[2], match[3].replace(/\s+/g, ' ').trim())
  }
  return tokens
}

function missingFrom(tokens: Map<string, string>, expected: string[]): string[] {
  return expected.filter((name) => !tokens.has(name))
}

function blockContent(source: string, openPattern: RegExp): string | undefined {
  const startMatch = source.match(openPattern)
  if (!startMatch) return undefined
  const start = startMatch.index! + startMatch[0].length
  let depth = 1
  let index = start
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return depth === 0 ? source.slice(start, index) : undefined
}

describe('non-color design token contracts', () => {
  test('tokens.css defines the Radix 9-step typography scale tokens', async () => {
    const tokens = extractTokens(await read('../src/styles/design-system/tokens.css'))
    const steps = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
    const required = [
      ...steps.map((step) => `--cpx-sys-font-size-${step}`),
      ...steps.map((step) => `--cpx-sys-line-height-${step}`),
      ...steps.map((step) => `--cpx-sys-letter-spacing-${step}`),
      '--cpx-sys-font-size-code',
      '--cpx-sys-line-height-code',
      '--cpx-sys-letter-spacing-code',
      '--cpx-sys-font-weight-light',
      '--cpx-sys-font-weight-regular',
      '--cpx-sys-font-weight-medium',
      '--cpx-sys-font-weight-bold',
    ]

    const missing = missingFrom(tokens, required)
    expect(
      missing,
      `tokens.css must define every Radix typography scale token; missing: ${missing.join(', ') || 'none'}`,
    ).toEqual([])
  })

  test('tokens.css locks the Radix 9-step typography sizes, weights, and line heights', async () => {
    const tokens = extractTokens(await read('../src/styles/design-system/tokens.css'))
    expect(normalizeSource(tokens.get('--cpx-sys-font-family-sans'))).toBe(
      normalizeSource(
        'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
      ),
    )
    const expected: Record<string, string> = {
      '--cpx-sys-font-size-code': '12px',
      '--cpx-sys-font-size-1': '12px',
      '--cpx-sys-font-size-2': '14px',
      '--cpx-sys-font-size-3': '16px',
      '--cpx-sys-font-size-4': '18px',
      '--cpx-sys-font-size-5': '20px',
      '--cpx-sys-font-size-6': '24px',
      '--cpx-sys-font-size-7': '28px',
      '--cpx-sys-font-size-8': '35px',
      '--cpx-sys-font-size-9': '60px',
      '--cpx-sys-font-weight-light': '300',
      '--cpx-sys-font-weight-regular': '400',
      '--cpx-sys-font-weight-medium': '500',
      '--cpx-sys-font-weight-bold': '700',
      '--cpx-sys-line-height-1': '1.3333',
      '--cpx-sys-line-height-2': '1.4286',
      '--cpx-sys-line-height-3': '1.5',
      '--cpx-sys-line-height-4': '1.4444',
      '--cpx-sys-line-height-5': '1.4',
      '--cpx-sys-line-height-6': '1.25',
      '--cpx-sys-line-height-7': '1.2857',
      '--cpx-sys-line-height-8': '1.1429',
      '--cpx-sys-line-height-9': '1',
      '--cpx-sys-line-height-code': '1.5',
    }
    const mismatched = Object.entries(expected).filter(
      ([name, value]) => tokens.get(name) !== value,
    )

    expect(
      mismatched,
      `Radix typography contract mismatch: ${mismatched.map(([name, value]) => `${name}=${tokens.get(name) ?? '(missing)'} (expected ${value})`).join(', ') || 'none'}`,
    ).toEqual([])
  })

  test('DesktopThemeProvider applies proportional scaling to the complete 9-step scale', async () => {
    const provider = await read('../src/features/theme/DesktopThemeProvider.tsx')
    const scaleBlock = provider.match(/const scale = \{([\s\S]*?)\n  \}/)?.[1]
    expect(scaleBlock, 'DesktopThemeProvider must declare its UI font scale').toBeDefined()

    const scale = new Map<string, number>()
    for (const match of scaleBlock!.matchAll(/'?([\w]+)'?\s*:\s*(\d+)/g)) {
      scale.set(match[1], Number(match[2]))
    }
    expect(Object.fromEntries(scale)).toEqual({
      1: 12,
      2: 14,
      3: 16,
      4: 18,
      5: 20,
      6: 24,
      7: 28,
      8: 35,
      9: 60,
    })
    expect(provider).toContain('Math.round((base * uiFontSize) / 14)')
    expect(provider).toContain("'--cpx-sys-font-size-9'")

    for (const uiFontSize of [11, 14, 16]) {
      const derived = [...scale.values()].map((base) => Math.round((base * uiFontSize) / 14))
      expect(derived).toEqual(
        uiFontSize === 11
          ? [9, 11, 13, 14, 16, 19, 22, 28, 47]
          : uiFontSize === 14
            ? [12, 14, 16, 18, 20, 24, 28, 35, 60]
            : [14, 16, 18, 21, 23, 27, 32, 40, 69],
      )
    }
  })

  test('base, utilities, and Tailwind consume the shared Radix 9-step typography scale', async () => {
    const [base, tailwind] = await Promise.all([
      read('../src/styles/base.css'),
      read('../src/styles/tailwind.css'),
    ])

    expect(base).toMatch(/body\s*\{[\s\S]*?font-size:\s*var\(--cpx-sys-font-size-2\);/)
    for (const step of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(tailwind).toMatch(
        new RegExp(`@utility type-${step} \\{[\\s\\S]*?font-size: var\\(--cpx-sys-font-size-${step}\\);`),
      )
      expect(tailwind).toContain(`--text-${step}: var(--cpx-sys-font-size-${step});`)
    }
    expect(tailwind).toMatch(
      /@utility type-code \{\s*font-family: var\(--cpx-sys-font-family-mono\);\s*font-size: var\(--cpx-sys-font-size-code\);/,
    )
    for (const weight of ['light', 'regular', 'medium', 'bold']) {
      expect(tailwind).toMatch(
        new RegExp(`@utility weight-${weight} \\{\\s*font-weight: var\\(--cpx-sys-font-weight-${weight}\\);`),
      )
    }
  })

  test('representative components keep page, section, row, reading, control, metric, and meta responsibilities distinct', async () => {
    const [settings, session, markdown, button, settingsSection, generalSettings, conversation] =
      await Promise.all([
        read('../src/styles/primitives/settings.css'),
        read('../src/features/session/QuickChatView.tsx'),
        read('../src/styles/markdown.css'),
        read('../src/components/ui/Button.tsx'),
        read('../src/features/settings/SettingsSection.tsx'),
        read('../src/features/settings/GeneralSettings.tsx'),
        read('../src/styles/primitives/conversation.css'),
      ])

    expect(generalSettings).toMatch(/className="settings-page-title [^"]*tw:type-6 tw:weight-bold/)
    expect(settingsSection).toMatch(/className="settings-section-title [^"]*tw:type-4 tw:weight-bold/)
    expect(settings).toMatch(
      /\.settings-management-row-title\s*\{[^}]*font-size:\s*var\(--cpx-sys-font-size-2\);/s,
    )
    expect(session).toContain('tw:type-7 tw:weight-bold')
    expect(markdown).toMatch(/\.md-body\s*\{[^}]*font-size:\s*var\(--cpx-sys-font-size-2\);/s)
    expect(markdown).toMatch(/h2\s*\{[^}]*font-size:\s*var\(--cpx-sys-font-size-6\);/s)
    expect(button).toMatch(/font-size:\s*var\(--cpx-sys-font-size-2\);/)
    expect(settings).toMatch(
      /\.usage-metric-card strong\s*\{[^}]*font-size:\s*var\(--cpx-sys-font-size-5\);[^}]*font-variant-numeric:\s*tabular-nums;/s,
    )
    expect(conversation).toMatch(/font-size:\s*var\(--cpx-sys-font-size-1\);/)
  })

  test('tokens.css defines the Radix 9-step spacing scale 1..9 = 4/8/12/16/24/32/40/48/64px with --cpx-sys-scaling', async () => {
    const source = await read('../src/styles/design-system/tokens.css')
    const rootBlock = blockContent(source, /:root\s*\{/)
    expect(rootBlock, 'tokens.css must have a :root block').toBeDefined()
    const tokens = extractTokens(rootBlock!)
    const expected: Record<string, string> = {
      '--cpx-sys-scaling': '1',
      '--cpx-sys-space-1': 'calc(4px * var(--cpx-sys-scaling))',
      '--cpx-sys-space-2': 'calc(8px * var(--cpx-sys-scaling))',
      '--cpx-sys-space-3': '12px',
      '--cpx-sys-space-4': '16px',
      '--cpx-sys-space-5': '24px',
      '--cpx-sys-space-6': '32px',
      '--cpx-sys-space-7': '40px',
      '--cpx-sys-space-8': '48px',
      '--cpx-sys-space-9': '64px',
      '--cpx-comp-menubar-height': '36px',
    }
    const mismatched = Object.entries(expected).filter(
      ([name, value]) => tokens.get(name) !== value,
    )
    const details = mismatched
      .map(([name, value]) => `${name}=${tokens.get(name) ?? '(missing)'} (expected ${value})`)
      .join(', ')

    expect(
      details,
      `tokens.css space scale must match Radix 9-step nonlinear scale: ${details || 'ok'}`,
    ).toBe('')
    expect(source).toMatch(/\[data-ui-density='compact'\]\s*\{\s*--cpx-sys-scaling:\s*0\.9;/)
    expect(source).toMatch(/\[data-ui-density='default'\]\s*\{\s*--cpx-sys-scaling:\s*1;/)
    expect(source).toMatch(/\[data-ui-density='spacious'\]\s*\{\s*--cpx-sys-scaling:\s*1\.1;/)
  })

  test('tokens.css defines semantic radius roles', async () => {
    const tokens = extractTokens(await read('../src/styles/design-system/tokens.css'))
    const roles = ['indicator', 'compact', 'control', 'container', 'floating', 'pill'].map(
      (role) => `--cpx-sys-radius-${role}`,
    )

    const missing = missingFrom(tokens, roles)
    expect(
      missing,
      `tokens.css must define every radius role as a --cpx-sys-radius-* token; missing: ${missing.join(', ') || 'none'}`,
    ).toEqual([])
  })

  test('tokens.css defines semantic motion roles', async () => {
    const tokens = extractTokens(await read('../src/styles/design-system/tokens.css'))
    const roles = ['instant', 'feedback', 'exit', 'state', 'enter', 'panel', 'loading'].map(
      (role) => `--cpx-sys-motion-${role}`,
    )

    const missing = missingFrom(tokens, roles)
    expect(
      missing,
      `tokens.css must define every motion role as a --cpx-sys-motion-* token; missing: ${missing.join(', ') || 'none'}`,
    ).toEqual([])
  })

  test('tokens.css defines semantic z-index roles', async () => {
    const tokens = extractTokens(await read('../src/styles/design-system/tokens.css'))
    const roles = [
      'local',
      'sticky',
      'dock',
      'composer',
      'modal',
      'popover',
      'tooltip',
      'toast',
    ].map((role) => `--cpx-sys-z-${role}`)

    const missing = missingFrom(tokens, roles)
    expect(
      missing,
      `tokens.css must define every z-index role as a --cpx-sys-z-* token; missing: ${missing.join(', ') || 'none'}`,
    ).toEqual([])
  })

  test('tokens.css no longer defines root geometry tokens --control-/--layout-/--app-icon-/--menu-', async () => {
    const tokens = extractTokens(await read('../src/styles/design-system/tokens.css'))
    const banned = [...tokens.keys()].filter((name) =>
      /^--(?:control|layout|app-icon|menu)-/.test(name),
    )

    expect(
      banned,
      `tokens.css must not define root geometry tokens: ${banned.join(', ') || 'none'}`,
    ).toEqual([])
  })

  test('CheckStyleContracts.ts implements the featureTokenContract', async () => {
    const checker = await read('../scripts/CheckStyleContracts.ts')

    expect(checker).toContain('featureTokenContract')

    // Coverage: styles + scripts/TSX + inline style + Tailwind arbitrary +
    // component geometry + every literal non-color dimension.
    for (const marker of [
      'feature styles must not use literal',
      'feature TSX must not use literal',
      'inline style',
      'Tailwind arbitrary',
      'semantic typography role',
      'component geometry',
      'literal typography',
      'literal radius',
      'literal motion',
      'literal shadow',
      'literal z-index',
      'literal spacing',
    ]) {
      expect(
        checker.includes(marker),
        `CheckStyleContracts.ts must enforce the non-color token contract for "${marker}"`,
      ).toBe(true)
    }

    // Precise reason + stale detection (mirrors the feature color contract).
    expect(checker).toContain('feature token exception needs a concrete reason')
    expect(checker).toContain('stale feature token exception')
  })

  test('style-contracts.json ships a precise, stale-detectable featureTokenContract', async () => {
    const manifest = JSON.parse(await read('../style-contracts.json')) as {
      featureTokenContract: {
        roots: string[]
        componentGeometryExceptions: Array<{
          file: string
          value?: string
          localProperty?: string
          reason: string
        }>
        inlineStyleExceptions: Array<{
          file: string
          value?: string
          localProperty?: string
          reason: string
        }>
        tailwindArbitraryExceptions: Array<{
          file: string
          value?: string
          localProperty?: string
          reason: string
        }>
        tailwindTypographyExceptions: Array<{
          file: string
          value?: string
          localProperty?: string
          reason: string
        }>
        literalTypographyExceptions: Array<{
          file: string
          value?: string
          localProperty?: string
          reason: string
        }>
        literalRadiusExceptions: Array<{
          file: string
          value?: string
          localProperty?: string
          reason: string
        }>
        literalMotionExceptions: Array<{
          file: string
          value?: string
          localProperty?: string
          reason: string
        }>
        literalShadowExceptions: Array<{
          file: string
          value?: string
          localProperty?: string
          reason: string
        }>
        literalZIndexExceptions: Array<{
          file: string
          value?: string
          localProperty?: string
          reason: string
        }>
        literalSpacingExceptions: Array<{
          file: string
          value?: string
          localProperty?: string
          reason: string
        }>
      }
    }

    expect(
      manifest.featureTokenContract,
      'style-contracts.json must contain featureTokenContract',
    ).toBeDefined()
    expect(manifest.featureTokenContract.roots).toEqual(['src/styles/features', 'src/styles/lazy'])

    for (const [category, exceptions] of Object.entries({
      componentGeometryExceptions: manifest.featureTokenContract.componentGeometryExceptions,
      inlineStyleExceptions: manifest.featureTokenContract.inlineStyleExceptions,
      tailwindArbitraryExceptions: manifest.featureTokenContract.tailwindArbitraryExceptions,
      tailwindTypographyExceptions: manifest.featureTokenContract.tailwindTypographyExceptions,
      literalTypographyExceptions: manifest.featureTokenContract.literalTypographyExceptions,
      literalRadiusExceptions: manifest.featureTokenContract.literalRadiusExceptions,
      literalMotionExceptions: manifest.featureTokenContract.literalMotionExceptions,
      literalShadowExceptions: manifest.featureTokenContract.literalShadowExceptions,
      literalZIndexExceptions: manifest.featureTokenContract.literalZIndexExceptions,
      literalSpacingExceptions: manifest.featureTokenContract.literalSpacingExceptions,
    })) {
      expect(
        Array.isArray(exceptions),
        `featureTokenContract.${category} must be an exception array`,
      ).toBe(true)
      for (const exception of exceptions) {
        expect(
          exception.file.length > 0 && !exception.file.includes('*'),
          `${category} exception must name one concrete file without wildcards: ${exception.file}`,
        ).toBe(true)
        expect(
          exception.reason.length > 15,
          `${category} exception needs a concrete reason (>15 chars): ${exception.file} -> ${exception.value ?? exception.localProperty ?? ''}`,
        ).toBe(true)
        expect(
          (exception.value ?? exception.localProperty ?? '').length > 0,
          `${category} exception must pin the exact value or local property: ${exception.file}`,
        ).toBe(true)
      }
    }
  })

  test('base.css reduced-motion zeroes every system motion token', async () => {
    const base = await read('../src/styles/base.css')
    const reduceMotion = blockContent(base, /\[data-reduce-motion=['"]on['"]\]\s*\{/)

    expect(
      reduceMotion,
      'base.css must contain a :root[data-reduce-motion="on"] block that resets motion tokens',
    ).toBeDefined()

    const motionTokens = [
      '--cpx-sys-motion-instant',
      '--cpx-sys-motion-feedback',
      '--cpx-sys-motion-exit',
      '--cpx-sys-motion-state',
      '--cpx-sys-motion-enter',
      '--cpx-sys-motion-panel',
      '--cpx-sys-motion-loading',
    ]
    const declarations = new Map<string, string>()
    for (const match of reduceMotion!.matchAll(/(--cpx-sys-motion-[\w-]+)[ \t]*:[ \t]*([^;]+);/g)) {
      declarations.set(match[1], match[2].trim())
    }

    const missing = motionTokens.filter((name) => !declarations.has(name))
    expect(
      missing,
      `reduced-motion must zero every system motion token; missing: ${missing.join(', ') || 'none'}`,
    ).toEqual([])

    for (const name of motionTokens) {
      const value = declarations.get(name)
      expect(
        value !== undefined && /^0(?:ms)?$/.test(value),
        `${name} must be zeroed under reduced-motion (got: ${value ?? '(missing)'})`,
      ).toBe(true)
    }

    // base.css must never reintroduce non-zero motion tokens (e.g. 1ms).
    const nonZero = [...declarations.entries()].filter(([, value]) => !/^0(?:ms)?$/.test(value))
    expect(
      nonZero,
      `base.css must not set non-zero motion tokens; offending: ${nonZero.map(([name, value]) => `${name}: ${value}`).join(', ') || 'none'}`,
    ).toEqual([])
  })

  test('tokens.css pins the shared page widths and the conversation width', async () => {
    const tokens = extractTokens(await read('../src/styles/design-system/tokens.css'))
    expect(tokens.get('--cpx-sys-layout-content-max-width')).toBe('1009px')
    expect(tokens.get('--cpx-sys-layout-wide-max-width')).toBe('1250px')
    // 会话正文上限是摘要三段判定的基准，必须与 threadSummaryState 的 736 一致。
    expect(tokens.get('--cpx-sys-layout-conversation-max-width')).toBe('736px')
    expect(tokens.has('--cpx-sys-layout-reading-max-width')).toBe(false)
  })

  test('页面宽度不再有手动档位：布局只读会话/一级页面两个固定上限', async () => {
    const desktopLayout = await read('../src/features/layout/shell/DesktopLayout.tsx')
    const conversationPage = await read('../src/features/session/conversation/ConversationPage.tsx')
    const workbench = await read('../src/styles/features/layout-workbench.css')
    const canonical = await read('../src/styles/primitives/conversation.css')

    expect(desktopLayout).not.toContain('data-page-width')
    expect(conversationPage).not.toContain('data-conversation-width')
    expect(workbench).not.toContain('data-page-width')
    expect(canonical).not.toContain('data-conversation-width')
    expect(workbench).toMatch(
      /\.desktop-main-route\s*\{\s*--page-content-max-width:\s*var\(--cpx-sys-layout-content-max-width\);/,
    )
    expect(canonical).toContain(
      '--page-content-max-width: var(--cpx-sys-layout-conversation-max-width);',
    )
  })

  test('canonical conversation lets the final agent response fill the page width', async () => {
    const conversation = await read('../src/styles/primitives/conversation.css')
    const markdown = await read('../src/styles/markdown.css')
    expect(conversation).toMatch(
      /\.canonical-turn\s*\{[\s\S]*?max-width:\s*var\(--page-content-max-width\)/,
    )
    expect(conversation).toMatch(/\.canonical-turn\s*\{[\s\S]*?container-type:\s*inline-size/)
    expect(conversation).not.toMatch(/--thread-reading-width/)
    expect(conversation).toMatch(
      /\.canonical-text-item--result\s*\{\s*width:\s*100%;\s*background:\s*transparent;\s*box-shadow:\s*none;\s*\}/,
    )
    expect(markdown).toMatch(
      /\.conversation-page \.md-wide-block\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%/,
    )
    expect(markdown).toMatch(
      /:is\(ul, ol\)[\s\S]*?\.md-wide-block\s*\{[\s\S]*?width:\s*100cqi;[\s\S]*?max-width:\s*100cqi;[\s\S]*?margin-inline-start:\s*calc\(100% - 100cqi\)/,
    )
  })

  test('reduced-motion consumers reuse the theme provider instead of installing observers', async () => {
    const hook = await read('../src/hooks/UsePrefersReducedMotion.ts')
    const provider = await read('../src/features/theme/DesktopThemeProvider.tsx')
    const context = await read('../src/features/theme/ThemeContext.ts')

    // hooks 不能放在 try/catch 里，改为直接读 context 并在无 Provider 时回退。
    expectSourceContains(hook, 'useContext(DesktopThemeContext)')
    expectSourceContains(hook, 'theme.reducedMotion')
    expect(hook).not.toContain('new MutationObserver')
    expect(hook).not.toContain("addEventListener('change'")
    expect(provider).toContain("draftSettings.reduceMotion === 'system'")
    expect(provider).toContain("draftSettings.reduceMotion === 'on'")
    expect(provider).toContain('reducedMotion,')
    expect(context).toContain('reducedMotion: boolean')
  })

  test('canonical conversation narrative content inherits one reading rhythm', async () => {
    const conversation = await read('../src/styles/primitives/conversation.css')
    const markdown = await read('../src/styles/markdown.css')
    expect(conversation).toMatch(
      /\.canonical-turn\s*\{[\s\S]*?font-size:\s*var\(--cpx-sys-font-size-2\);/,
    )
    for (const selector of [
      '\\.canonical-turn__thinking,\\s*\\.canonical-turn__status',
      '\\.cpx-agent-activity',
      '\\.canonical-turn-activity',
      '\\.canonical-process-card',
      '\\.cpx-agent-activity__item',
      '\\.cpx-agent-activity__details',
      '\\.cpx-agent-activity__file-changes',
      '\\.canonical-lifecycle-tool',
    ]) {
      expect(conversation).toMatch(new RegExp(`${selector}\\s*\\{[\\s\\S]*?font:\\s*inherit;`))
    }
    const itemRenderer = await read('../src/features/session/timeline/CanonicalItemRenderer.tsx')
    expectSourceContains(
      itemRenderer,
      'canonical-text-item tw:min-w-0 tw:text-app-text tw:type-2',
    )
    expect(markdown).toMatch(/\.md-body\s*\{[\s\S]*?font-size:\s*var\(--cpx-sys-font-size-2\);/)
    expect(conversation).toMatch(
      /\.canonical-turn__process\s*\{\s*gap:\s*var\(--cpx-sys-space-3\);/,
    )
    expect(markdown).toMatch(
      /\.md-table-block table\s*\{[\s\S]*?font-size:\s*var\(--cpx-sys-font-size-2\);/,
    )
    expect(conversation).toMatch(/font-size:\s*var\(--cpx-sys-font-size-1\);/)
    expect(conversation).toMatch(/font-size:\s*var\(--cpx-sys-font-size-code\);/)
    expect(markdown).toMatch(/line-height:\s*var\(--cpx-sys-line-height-code\);/)
  })

  test('Markdown code fallbacks use the shared code line-height token without a local floor', async () => {
    const markdown = await read('../src/styles/markdown.css')
    expect(markdown).not.toMatch(/line-height:\s*max\(20px,\s*var\(--cpx-sys-line-height-code\)\)/)
    expect(markdown).toMatch(
      /\.md-code-placeholder,[\s\S]*?\.md-math-fallback\s*\{[\s\S]*?line-height:\s*var\(--cpx-sys-line-height-code\)/,
    )
  })

  test('settings page content defaults to content max width', async () => {
    const settingsPage = await read('../src/features/settings/GeneralSettings.tsx')
    // 设置页内容宽度改由 TSX utility 承担：内容上限 + 两侧 space-6 内边距
    // （原 `_settings-core.scss` 的 max-width 公式）。
    expectSourceContains(
      settingsPage,
      'tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-6)*2)]',
    )
  })

  test('review diff preserves shared code rhythm with a 24px floor for line actions', async () => {
    const review = await read('../src/styles/primitives/review.css')
    expect(review).toContain(
      '--review-diffs-line-height: max(24px, calc(1em * var(--cpx-sys-line-height-code)))',
    )
    expect(review).toMatch(/line-height:\s*var\(--cpx-sys-line-height-code\)/)
  })

  test('home and conversation share a continuous reading column with a matching composer', async () => {
    const conversation = await read('../src/styles/primitives/conversation.css')
    const threadComposerDock = await read(
      '../src/features/session/conversation/ThreadComposerDock.tsx',
    )
    const composerSurface = await read('../src/features/session/composer/ComposerSurface.tsx')
    const timeline = await read('../src/features/session/timeline/SessionTimelineView.tsx')
    const page = await read('../src/features/session/conversation/ConversationPage.tsx')

    expect(conversation).not.toContain('--conversation-shift-offset')
    expect(conversation).toMatch(
      /\.conversation-page \.workflow-page__composer-inner\s*\{\s*width: 100%;\s*min-width: 0;\s*max-width: var\(--page-content-max-width\);\s*margin-inline: auto;/,
    )
    expect(conversation).toMatch(
      /\.quick-chat-view,\s*\.conversation-page\s*\{\s*--cpx-sys-layout-conversation-max-width: 48rem;\s*--page-content-max-width: var\(--cpx-sys-layout-conversation-max-width\);\s*--session-content-w: 100%;/,
    )
    expect(conversation).toMatch(
      /\.quick-chat-view > \.quick-chat-hero-region,\s*\.quick-chat-view > \.quick-chat-composer-region\s*\{\s*width: 100%;\s*max-width: calc\(var\(--page-content-max-width\) \+ 2 \* var\(--cpx-sys-space-4\)\);\s*margin-inline: auto;\s*padding-inline: var\(--cpx-sys-space-4\);/,
    )
    // 消息与吸底输入框共用带最小左右留白的列，窄窗口也不能贴边。
    expect(conversation).toMatch(
      /\.conversation-page \.thread-scroll-layout__inner\s*\{\s*width: 100%;\s*max-width: calc\(var\(--page-content-max-width\) \+ 2 \* var\(--cpx-sys-space-4\)\);\s*margin-inline: auto;\s*padding-inline: var\(--cpx-sys-space-4\);/,
    )
    expect(conversation).not.toMatch(
      /\.quick-chat-view,\s*\.conversation-page \.thread-scroll-layout__inner/,
    )
    expect(conversation).not.toContain('53.5rem')
    expect(conversation).not.toContain('--page-content-max-width: 40rem;')
    expect(conversation).not.toContain('--conversation-composer-overhang')
    expect(conversation).not.toContain('--conversation-inline-gutter')
    for (const homeView of ['QuickChatView', 'ChatNewSessionView', 'WorkingNewSessionView']) {
      const source = await read(`../src/features/session/${homeView}.tsx`)
      expect(source).not.toContain('tw:px-8')
      expect(source).not.toContain('tw:max-w-none')
      expect(source).not.toContain('scrollbar-gutter:stable')
      expect(source).toContain('tw:w-[var(--quick-chat-surface-width)]')
    }
    expect(conversation).toContain('--session-timeline-width: 100%;')
    expect(timeline).toContain('tw:w-[var(--session-timeline-width,var(--session-content-w,100%))]')
    expect(conversation).not.toContain('--conversation-content-inline-start')
    expect(conversation).not.toContain('@media (max-width: 760px)')
    expect(conversation).toMatch(
      /\.conversation-page \.workflow-main-scroll-footer \.chat-input__dropdown--suggestion\s*\{\s*width: 100%;\s*max-width: 100%;/,
    )
    expect(page).not.toContain('subagent-timeline-summary')
    expect(conversation).toMatch(/\.right-dock-side-chat\s*\{\s*--session-content-w: 100%;/)
    expect(conversation).toMatch(
      /\.canonical-turn\s*\{[\s\S]*?width:\s*min\(var\(--page-content-max-width\),\s*var\(--session-content-w\)\);[\s\S]*?max-width:\s*var\(--page-content-max-width\);[\s\S]*?margin-inline:\s*auto;/,
    )
    expect(conversation).toMatch(
      /\.right-dock-side-chat \.canonical-model-switch-divider,[\s\S]*?\.right-dock-side-chat \.workflow-page__composer-inner\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;[\s\S]*?margin-inline:\s*0;/,
    )
    expect(threadComposerDock).not.toMatch(/tw:w-\[min\(/)
    expect(threadComposerDock).not.toMatch(/tw:max-w-\[var\(/)
    expect(composerSurface).toContain("className?.includes('workflow-page__composer-inner')")
  })
})
