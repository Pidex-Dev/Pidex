import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentPropsWithoutRef,
  type FormEventHandler,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../utils/Cn.js'
import { Button, type ButtonProps } from './Button.js'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from './IconTokens.js'
import { useDialogFocusRestore } from './UseDialogFocusRestore.js'

/** Width presets for Codex Desktop dialogs, resolved in `styles/modal.css`. */
export type DialogSize = 'narrow' | 'compact' | 'medium' | 'default' | 'large' | 'wide' | 'xwide'

/** Surface material presets matching Codex Desktop's frosted dialog hierarchy. */
export type DialogVariant = 'default' | 'translucent' | 'opaque'

/** Overlay backdrop intensity presets. */
export type DialogBackdrop = 'default' | 'dimmed' | 'flat'

/** Props for the shared Codex Desktop modal dialog primitive. */
export type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  size?: DialogSize
  variant?: DialogVariant
  backdrop?: DialogBackdrop
  showDialogClose?: boolean
  closeLabel?: string
  closeDisabled?: boolean
  closeButtonRef?: Ref<HTMLButtonElement>
  restoreFocusTarget?: HTMLElement | null
  contentClassName?: string
  overlayClassName?: string
  contentProps?: Omit<
    ComponentPropsWithoutRef<typeof RadixDialog.Content>,
    'className' | 'children'
  >
}

/**
 * Shared Codex Desktop modal dialog shell with frosted surface, light scrim,
 * focus restoration, and an optional top-right close button.
 */
export function Dialog({
  open,
  onOpenChange,
  children,
  size = 'default',
  variant = 'default',
  backdrop = 'default',
  showDialogClose = true,
  closeLabel = '关闭对话框',
  closeDisabled = false,
  closeButtonRef,
  restoreFocusTarget,
  contentClassName,
  overlayClassName,
  contentProps,
}: DialogProps): ReactNode {
  const { onCloseAutoFocus: restoreFocus } = useDialogFocusRestore(open, restoreFocusTarget)
  const { onCloseAutoFocus: callerCloseAutoFocus, ...restContentProps } = contentProps ?? {}

  function handleCloseAutoFocus(event: Event): void {
    callerCloseAutoFocus?.(event)
    if (!event.defaultPrevented) {
      restoreFocus(event)
    }
  }

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={cn('ui-dialog-backdrop permission-modal-backdrop', overlayClassName)}
          data-backdrop={backdrop !== 'default' ? backdrop : undefined}
        />
        <RadixDialog.Content
          {...restContentProps}
          className={cn(
            'ui-dialog-surface ui-dialog-surface--centered ui-dialog-sized tw:box-border tw:max-h-[calc(100vh-2rem)] tw:overflow-hidden tw:outline-none',
            contentClassName,
          )}
          data-dialog-size={size}
          data-variant={variant !== 'default' ? variant : undefined}
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          {children}
          {showDialogClose ? (
            <RadixDialog.Close asChild disabled={closeDisabled}>
              <Button
                isIconOnly
                className="tw:absolute tw:top-4 tw:right-4"
                color="ghost"
                disabled={closeDisabled}
                ref={closeButtonRef}
                size="toolbar"
                title={closeLabel}
              >
                <X
                  aria-hidden="true"
                  className="tw:size-icon-sm"
                  size={APP_ICON_SIZE}
                  strokeWidth={APP_ICON_STROKE_WIDTH}
                />
              </Button>
            </RadixDialog.Close>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/** Props for the primary content wrapper inside a `Dialog`. */
export type DialogBodyProps = {
  as?: 'div' | 'form'
  children: ReactNode
  className?: string
  padding?: 'default' | 'none'
  onSubmit?: FormEventHandler<HTMLFormElement>
}

/**
 * Parent layout container that establishes the shared 20px Codex Desktop dialog
 * padding and vertical section rhythm.
 */
export function DialogBody({
  as = 'div',
  children,
  className,
  padding = 'default',
  onSubmit,
}: DialogBodyProps): ReactNode {
  const classes = cn(
    'tw:flex tw:min-h-0 tw:flex-col tw:gap-3 tw:text-app-text tw:type-2',
    padding === 'default' && 'tw:p-5',
    className,
  )

  if (as === 'form') {
    return (
      <form className={classes} onSubmit={onSubmit}>
        {children}
      </form>
    )
  }

  return <div className={classes}>{children}</div>
}

/** Props for the structured header block inside a `DialogBody`. */
export type DialogHeaderProps = {
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  titleSize?: 'dialog' | 'base' | 'sm'
  reserveCloseSpace?: boolean
  className?: string
}

/**
 * Standardized Codex Desktop dialog header with heading scale, optional leading
 * icon, subtitle tone, and clearance for the top-right close button.
 */
export function DialogHeader({
  title,
  subtitle,
  icon,
  titleSize = 'dialog',
  reserveCloseSpace = true,
  className,
}: DialogHeaderProps): ReactNode {
  const titleClass =
    titleSize === 'sm'
      ? 'tw:type-2 tw:weight-bold'
      : titleSize === 'base'
        ? 'tw:type-3 tw:weight-bold'
        : 'tw:type-4 tw:weight-bold'

  return (
    <header className={cn('tw:flex tw:flex-col tw:items-start tw:gap-3', className)}>
      {icon ? (
        <span
          aria-hidden="true"
          className="tw:inline-flex tw:size-9 tw:shrink-0 tw:items-center tw:justify-center tw:rounded-4 tw:bg-app-hover tw:text-app-text"
        >
          {icon}
        </span>
      ) : null}
      <div
        className={cn(
          'tw:flex tw:min-w-0 tw:w-full tw:flex-col tw:gap-1',
          // INVARIANT: Clears the 24px close button at right-4 inside 20px body padding so wrapped titles never collide.
          reserveCloseSpace && 'tw:pe-7',
        )}
      >
        <div className={cn('tw:m-0 tw:min-w-0 tw:text-app-text tw:break-words', titleClass)}>
          {title}
        </div>
        {subtitle ? (
          <div className="tw:m-0 tw:min-w-0 tw:text-app-text-soft tw:type-2">{subtitle}</div>
        ) : null}
      </div>
    </header>
  )
}

/** Props for grouping content blocks inside a `DialogBody`. */
export type DialogSectionProps = {
  children: ReactNode
  spacing?: 'default' | 'large'
  className?: string
}

/** Logical content block inside a `DialogBody`. */
export function DialogSection({
  children,
  spacing = 'default',
  className,
}: DialogSectionProps): ReactNode {
  return (
    <div
      className={cn(
        'tw:flex tw:min-w-0 tw:w-full tw:flex-col',
        spacing === 'large' ? 'tw:gap-3' : 'tw:gap-2',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Props for the right-aligned action row at the bottom of a `DialogBody`. */
export type DialogFooterProps = {
  children: ReactNode
  className?: string
}

/**
 * Right-aligned Codex Desktop dialog action bar. Direct `Button` children
 * default to `size="medium"` unless they specify a size explicitly.
 */
export function DialogFooter({ children, className }: DialogFooterProps): ReactNode {
  const normalizedChildren = Children.map(children, (child) => {
    if (!isValidElement(child)) return child
    if (child.type === Button) {
      const buttonEl = child as ReactElement<ButtonProps>
      if (buttonEl.props.size === undefined) {
        return cloneElement(buttonEl, { size: 'medium' })
      }
    }
    return child
  })

  return (
    <footer
      className={cn(
        'tw:mt-2 tw:flex tw:w-full tw:flex-wrap tw:items-center tw:justify-end tw:gap-3',
        className,
      )}
    >
      {normalizedChildren}
    </footer>
  )
}

/** Accessible dialog title primitive bound to Radix Dialog. */
export const DialogTitle = RadixDialog.Title

/** Accessible dialog description primitive bound to Radix Dialog. */
export const DialogDescription = RadixDialog.Description

/** Accessible dialog close trigger primitive bound to Radix Dialog. */
export const DialogClose = RadixDialog.Close
