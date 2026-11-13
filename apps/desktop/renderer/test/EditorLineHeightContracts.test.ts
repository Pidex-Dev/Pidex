import { describe, expect, test } from 'bun:test'

import { codeEditorLineHeight } from '../src/features/editor/CodeMirrorTheme.js'
import { markdownRichThemeSpec } from '../src/features/editor/MarkdownRichExtensions.js'

describe('editor line-height contracts', () => {
  test('CodeMirror keeps the shared code leading with explicit pixels', () => {
    expect(codeEditorLineHeight(8)).toBe(15)
    expect(codeEditorLineHeight(13)).toBe(20)
    expect(codeEditorLineHeight(14)).toBe(21)
    expect(codeEditorLineHeight(24)).toBe(31)
  })

  test('rich Markdown uses the Radix 9-step scale tokens for body and headings', () => {
    expect(markdownRichThemeSpec['&.cm-markdown-rich .cm-content'].fontSize).toBe(
      'var(--cpx-sys-font-size-2)',
    )
    expect(markdownRichThemeSpec['&.cm-markdown-rich .cm-md-rich-h1']).toEqual({
      fontFamily: 'var(--cpx-sys-font-family-sans)',
      fontSize: 'var(--cpx-sys-font-size-7)',
      lineHeight: 'var(--cpx-sys-line-height-7)',
      fontWeight: 'var(--cpx-sys-font-weight-bold)',
    })
    expect(markdownRichThemeSpec['&.cm-markdown-rich .cm-md-rich-h2']).toEqual({
      fontFamily: 'var(--cpx-sys-font-family-sans)',
      fontSize: 'var(--cpx-sys-font-size-6)',
      lineHeight: 'var(--cpx-sys-line-height-6)',
      fontWeight: 'var(--cpx-sys-font-weight-bold)',
    })
    expect(markdownRichThemeSpec['&.cm-markdown-rich .cm-md-rich-h3']).toEqual({
      fontFamily: 'var(--cpx-sys-font-family-sans)',
      fontSize: 'var(--cpx-sys-font-size-4)',
      lineHeight: 'var(--cpx-sys-line-height-4)',
      fontWeight: 'var(--cpx-sys-font-weight-bold)',
    })
    expect(
      markdownRichThemeSpec[
        '&.cm-markdown-rich .cm-md-rich-h4, &.cm-markdown-rich .cm-md-rich-h5, &.cm-markdown-rich .cm-md-rich-h6'
      ],
    ).toEqual({
      fontFamily: 'var(--cpx-sys-font-family-sans)',
      fontSize: 'var(--cpx-sys-font-size-2)',
      lineHeight: 'var(--cpx-sys-line-height-2)',
      fontWeight: 'var(--cpx-sys-font-weight-medium)',
    })
  })

  test('rich Markdown code blocks keep the shared code line token', () => {
    const codeBlock = markdownRichThemeSpec['&.cm-markdown-rich .cm-line.cm-md-rich-code-block']
    expect(codeBlock.fontSize).toBe('var(--cpx-sys-font-size-code)')
    expect(markdownRichThemeSpec['&.cm-markdown-rich .cm-md-rich-code-block-widget']).toEqual({
      display: 'block',
      boxSizing: 'border-box',
      margin: '14px 0',
    })
    expect(
      markdownRichThemeSpec['&.cm-markdown-rich .cm-md-rich-code-block-widget .md-code-block'],
    ).toEqual({
      margin: '0',
    })
    expect(markdownRichThemeSpec['&.cm-markdown-rich .cm-line.cm-md-rich-horizontal-rule']).toEqual(
      {
        minHeight: '1lh',
        borderTop: '1px solid var(--cpx-sys-color-border-default)',
        color: 'transparent',
        transform: 'translateY(0.5lh)',
      },
    )
    expect(markdownRichThemeSpec['&.cm-markdown-rich .cm-line.cm-md-rich-alert']).toEqual({
      boxSizing: 'border-box',
      borderLeft: '3.5px solid var(--cpx-sys-color-border-default)',
      paddingLeft: '12px',
      color: 'var(--cpx-sys-color-fg-primary)',
    })
    expect(
      markdownRichThemeSpec['&.cm-markdown-rich .cm-line.cm-md-rich-alert--important'],
    ).toEqual({
      borderLeftColor: '#a855f7',
      background: 'color-mix(in srgb, #a855f7 6%, transparent)',
    })
    // List items no longer add padding on top of the semantic line height.
    expect(
      markdownRichThemeSpec['&.cm-markdown-rich .cm-line.cm-md-rich-list-item'],
    ).toBeUndefined()
  })
})
