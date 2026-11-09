import { renderToStaticMarkup } from 'react-dom/server'
import { AttachmentMediaPlayer } from '../src/features/session/attachments/AttachmentMediaPlayer.js'
import { describe, expect, test } from 'bun:test'
import type { DesktopComposerAttachment } from '../shared/Types.js'
import {
  canPreviewDraftAttachment,
  createDraftAttachmentPreviewTab,
} from '../src/features/session/attachments/AttachmentPreviewDescriptor.js'
import {
  calculateImageContainScale,
  clampImageScale,
  formatAttachmentText,
} from '../src/features/session/attachments/UserAttachmentPreviewPanel.js'

function attachment(patch: Partial<DesktopComposerAttachment> = {}): DesktopComposerAttachment {
  return {
    id: 'attachment-1',
    name: 'notes.md',
    path: 'C:\\notes.md',
    mediaType: 'text/markdown',
    sizeBytes: 12,
    kind: 'text',
    status: 'ready',
    textContent: '# Hello',
    ...patch,
  }
}

describe('用户附件预览', () => {
  test('只为完整的图片与 UTF-8 文本生成 draft descriptor', () => {
    expect(canPreviewDraftAttachment(attachment())).toBe(true)
    expect(createDraftAttachmentPreviewTab(attachment())).toMatchObject({
      id: 'user-attachment-preview',
      kind: 'attachment-preview',
      attachment: { kind: 'text' },
      source: { storage: 'draft', encoding: 'utf8', data: '# Hello' },
    })
    expect(canPreviewDraftAttachment(attachment({ truncated: true }))).toBe(false)
    expect(canPreviewDraftAttachment(attachment({ status: 'error' }))).toBe(false)
    expect(
      canPreviewDraftAttachment(
        attachment({
          kind: 'binary',
          mediaType: 'application/octet-stream',
          textContent: undefined,
        }),
      ),
    ).toBe(false)
  })

  test('本地文件与目录使用临时 grant 打开右侧预览', () => {
    expect(
      createDraftAttachmentPreviewTab(
        attachment({
          storage: 'local-path',
          pathKind: 'file',
          localGrantId: 'grant-file',
          textContent: undefined,
        }),
      ),
    ).toMatchObject({
      attachment: { kind: 'text' },
      source: { storage: 'draft-path', grantId: 'grant-file' },
    })
    expect(
      createDraftAttachmentPreviewTab(
        attachment({
          storage: 'local-path',
          pathKind: 'directory',
          localGrantId: 'grant-directory',
          kind: 'document',
          mediaType: 'inode/directory',
          textContent: undefined,
        }),
      ),
    ).toMatchObject({
      attachment: { kind: 'directory' },
      source: { storage: 'draft-path', grantId: 'grant-directory' },
    })
  })

  test('识别 Markdown、格式化合法 JSON，并让非法 JSON 回退原文', () => {
    expect(formatAttachmentText('# Title', 'README.md', 'text/plain')).toMatchObject({
      markdown: true,
      language: 'markdown',
      text: '# Title',
    })
    expect(formatAttachmentText('{"ok":true}', 'data.json', 'application/json')).toEqual({
      text: '{\n  "ok": true\n}',
      language: 'json',
      markdown: false,
      jsonInvalid: false,
    })
    expect(formatAttachmentText('{bad', 'data.json', 'application/json')).toMatchObject({
      text: '{bad',
      jsonInvalid: true,
    })
    expect(formatAttachmentText('name: value', 'config.yaml', 'text/plain').language).toBe('yaml')
  })

  test('图片适应窗口并把缩放限制在 5% 到 800%', () => {
    expect(calculateImageContainScale(1000, 700, 2000, 1000)).toBe(0.5)
    expect(calculateImageContainScale(1000, 700, 400, 300)).toBe(1)
    expect(clampImageScale(0.001)).toBe(0.05)
    expect(clampImageScale(20)).toBe(8)
  })
})

test('previews complete managed audio and video without reading a local path', () => {
  for (const [kind, mediaType] of [
    ['audio', 'audio/wav'],
    ['video', 'video/mp4'],
  ] as const) {
    const clip = attachment({ kind, mediaType, storage: 'managed', contentBase64: 'YQ==' })
    expect(createDraftAttachmentPreviewTab(clip)).toMatchObject({
      attachment: { kind, mediaType },
      source: { storage: 'draft', data: 'YQ==', encoding: 'base64' },
    })
    expect(createDraftAttachmentPreviewTab({ ...clip, truncated: true })).toBeNull()
  }
})

test('audio and video use the shared player controls instead of browser media controls', () => {
  for (const kind of ['audio', 'video'] as const) {
    const markup = renderToStaticMarkup(
      <AttachmentMediaPlayer kind={kind} name="clip" source="blob:clip" onError={() => {}} />,
    )
    expect(markup).toContain('<' + kind)
    expect(markup).not.toMatch(/<(audio|video)\b[^>]*\scontrols(?:[\s=>])/)
    expect(markup).toContain('aria-label="媒体播放控件"')
    expect(markup).toContain('aria-label="播放进度"')
    expect(markup).toContain('aria-label="音量设置"')
    expect(markup).not.toContain('aria-label="音量"')
    expect(markup).toContain('aria-label="播放倍速"')
  }
})
