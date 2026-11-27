import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '../src/components/ui/Button.js'
import {
  ConfirmationDialog,
  InputDialog,
  isInputDialogSubmitDisabled,
} from '../src/components/ui/ConfirmationDialog.js'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '../src/components/ui/Dialog.js'

describe('Codex Desktop Dialog primitives & ConfirmationDialog', () => {
  test('DialogBody, DialogHeader, DialogSection and DialogFooter render Codex structure', () => {
    const html = renderToStaticMarkup(
      <DialogBody>
        <DialogHeader subtitle="补充说明" title="通用弹窗标题" />
        <DialogSection spacing="large">
          <div>内容区</div>
        </DialogSection>
        <DialogFooter>
          <Button color="ghost">取消</Button>
          <Button color="primary">确认</Button>
        </DialogFooter>
      </DialogBody>,
    )

    expect(html).toContain('通用弹窗标题')
    expect(html).toContain('补充说明')
    expect(html).toContain('tw:p-5')
    expect(html).toContain('tw:pe-7')
    expect(html).toContain('tw:justify-end')
    expect(html).toContain('tw:gap-3')
    expect(html).toContain('data-size="medium"')
    expect(html).toContain('data-variant="ghost"')
    expect(html).toContain('data-variant="primary"')
  })

  test('DialogFooter preserves explicit Button size overrides', () => {
    const html = renderToStaticMarkup(
      <DialogFooter>
        <Button color="ghost" size="sm">
          次要
        </Button>
        <Button color="dangerSubtle">移除项目</Button>
      </DialogFooter>,
    )

    expect(html).toContain('data-size="sm"')
    expect(html).toContain('data-size="medium"')
    expect(html).toContain('data-variant="subtle-danger"')
  })

  test('Dialog, ConfirmationDialog and InputDialog export callable components and input validation works', () => {
    expect(typeof Dialog).toBe('function')
    expect(DialogTitle).toBeDefined()
    expect(typeof ConfirmationDialog).toBe('function')
    expect(typeof InputDialog).toBe('function')
    expect(isInputDialogSubmitDisabled('   ', false, false)).toBe(true)
    expect(isInputDialogSubmitDisabled('   ', true, false)).toBe(false)
    expect(isInputDialogSubmitDisabled('Pidex', false, true)).toBe(true)
    expect(isInputDialogSubmitDisabled('Pidex', false, false)).toBe(false)
  })

  test('ConfirmationDialog and modal.css enforce Codex Desktop frosted surface and soft-red destructive actions', async () => {
    const [confirmationSource, modalCss] = await Promise.all([
      Bun.file(new URL('../src/components/ui/ConfirmationDialog.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/styles/modal.css', import.meta.url)).text(),
    ])

    expect(confirmationSource).toContain('data-dialog-size="compact"')
    expect(confirmationSource).toContain('tw:justify-end tw:gap-3')
    expect(confirmationSource).toContain('color="ghost"')
    expect(confirmationSource).toContain("tone === 'danger' ? 'dangerSubtle' : 'primary'")
    expect(confirmationSource).toContain('size="medium"')
    expect(modalCss).toContain('backdrop-filter: blur(var(--cpx-sys-blur-lg));')
    expect(modalCss).toContain('0 0 0 0.5px var(--cpx-sys-color-border-default)')
    expect(modalCss).toContain(".ui-dialog-sized[data-dialog-size='compact']")
  })
})
