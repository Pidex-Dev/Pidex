import React from 'react'
import { cx } from '../../utils/Cx.js'
import { usePrefersReducedMotion } from '../../hooks/UsePrefersReducedMotion.js'

// INVARIANT: This primitive replaces Radix Collapsible because Radix Presence reads getComputedStyle().animationName on mount/unmount/animation events; pure CSS grid-template-rows folding avoids forced layout storms during session switches.

type CollapsibleContextValue = {
  open: boolean
  contentId: string
  triggerId: string
  onOpenChange?: (open: boolean) => void
}

const CollapsibleContext = React.createContext<CollapsibleContextValue | null>(null)

type CollapsibleProps = React.ComponentProps<'div'> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  asChild?: boolean
}

function withDataState(child: React.ReactElement, open: boolean, className?: string) {
  const childProps = child.props as { className?: string; 'data-state'?: string }
  return React.cloneElement(child, {
    'data-state': childProps['data-state'] ?? (open ? 'open' : 'closed'),
    className: cx(childProps.className, className),
  } as Partial<typeof child.props>)
}

export function Collapsible({
  open,
  defaultOpen,
  onOpenChange,
  asChild = false,
  children,
  className,
  ...props
}: CollapsibleProps): React.ReactNode {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const isControlled = open !== undefined
  const isOpen = isControlled ? open : uncontrolledOpen
  const idBase = React.useId()
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const contextValue = React.useMemo<CollapsibleContextValue>(
    () => ({
      open: isOpen,
      contentId: `collapsible-content-${idBase}`,
      triggerId: `collapsible-trigger-${idBase}`,
      onOpenChange: (next) => {
        if (!isControlled) setUncontrolledOpen(next)
        onOpenChangeRef.current?.(next)
      },
    }),
    [isOpen, isControlled, idBase],
  )

  if (asChild) {
    const child = React.Children.only(children) as React.ReactElement
    return (
      <CollapsibleContext.Provider value={contextValue}>
        {withDataState(child, isOpen, className)}
      </CollapsibleContext.Provider>
    )
  }

  return (
    <CollapsibleContext.Provider value={contextValue}>
      <div data-state={isOpen ? 'open' : 'closed'} className={className} {...props}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  )
}

type CollapsibleTriggerProps = React.ComponentProps<'button'> & { asChild?: boolean }

export function CollapsibleTrigger({
  asChild = false,
  children,
  className,
  onClick,
  type,
  ...props
}: CollapsibleTriggerProps): React.ReactNode {
  const context = React.useContext(CollapsibleContext)
  const stateProps = {
    'aria-expanded': context?.open ?? false,
    'aria-controls': context?.contentId,
    id: context?.triggerId,
    'data-state': context?.open ? ('open' as const) : ('closed' as const),
  }

  const toggleFromEvent = (event: React.MouseEvent<HTMLElement>): void => {
    onClick?.(event as React.MouseEvent<HTMLButtonElement>)
    if (!event.defaultPrevented && context) context.onOpenChange?.(!context.open)
  }

  if (asChild) {
    const child = React.Children.only(children) as React.ReactElement
    const childProps = child.props as {
      'aria-controls'?: string
      'aria-expanded'?: boolean
      'data-state'?: string
      id?: string
      className?: string
      onClick?: React.MouseEventHandler<HTMLElement>
    }
    return React.cloneElement(child, {
      ...stateProps,
      'aria-controls': childProps['aria-controls'] ?? stateProps['aria-controls'],
      'aria-expanded': childProps['aria-expanded'] ?? stateProps['aria-expanded'],
      'data-state': childProps['data-state'] ?? stateProps['data-state'],
      id: childProps.id ?? stateProps.id,
      className: cx(childProps.className, className),
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        childProps.onClick?.(event)
        toggleFromEvent(event)
      },
    } as Partial<typeof child.props>)
  }

  return (
    <button
      type={type ?? 'button'}
      className={className}
      onClick={toggleFromEvent}
      {...props}
      {...stateProps}
    >
      {children}
    </button>
  )
}

type CollapsibleContentProps = React.ComponentProps<'div'> & {
  expanded: boolean
  contentClassName?: string
  variant?: 'default' | 'slide'
}

export function CollapsibleContent({
  className,
  contentClassName,
  children,
  expanded,
  variant = 'default',
  ...props
}: CollapsibleContentProps): React.ReactNode {
  const reducedMotion = usePrefersReducedMotion()
  const context = React.useContext(CollapsibleContext)
  // INVARIANT: Content stays mounted in both states for CSS grid-template-rows transitions while children unmount when closed, avoiding computed style or height reads.
  return (
    <div
      id={context?.contentId}
      aria-hidden={!expanded}
      inert={!expanded ? true : undefined}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      data-variant={variant}
      data-state={expanded ? 'open' : 'closed'}
      className={cx('ui-collapsible-content tw:min-w-0 tw:overflow-hidden', className)}
      {...props}
    >
      {expanded ? <div className={cx('tw:min-w-0', contentClassName)}>{children}</div> : null}
    </div>
  )
}
