import { describe, expect, test } from 'bun:test'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { renderToStaticMarkup } from 'react-dom/server'
import { FullAccessConfirmationContent } from '../src/features/session/approvals/FullAccessConfirmationDialog.js'

describe('FullAccessConfirmationDialog', () => {
  test('renders capability list, risk notice and pill actions', () => {
    const html = renderToStaticMarkup(
      <AlertDialog.Root open>
        <FullAccessConfirmationContent open title="启用 Full Access？" onAction={() => {}} />
      </AlertDialog.Root>,
    )

    expect(html).toContain('启用 Full Access？')
    expect(html).toContain('文件和文件夹')
    expect(html).toContain('终端命令与工具')
    expect(html).toContain('互联网与已连接的应用')
    expect(html).toContain('tw:weight-bold')
    expect(html).toContain('这会带来敏感数据丢失或泄露、提示注入等风险。你可以随时将其关闭。')
    expect(html).toContain('data-variant="secondary"')
    expect(html).toContain('data-variant="subtle-danger"')
    expect(html).toContain('data-shape="pill"')
    expect(html).toContain('取消')
    expect(html).toContain('确认')
    expect(html).not.toContain('关闭对话框')
  })

  test('renders error alert and disabled action state while saving', () => {
    const html = renderToStaticMarkup(
      <AlertDialog.Root open>
        <FullAccessConfirmationContent
          open
          actionDisabled
          error="权限模式未更新，请重试。"
          onAction={() => {}}
        />
      </AlertDialog.Root>,
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('权限模式未更新，请重试。')
    expect(html).toContain('disabled=""')
  })
})
