import './SidebarRow.css'
import { Children, cloneElement, forwardRef } from 'react'
import type { HTMLAttributes, ReactElement, ReactNode, Ref } from 'react'
import { cx } from '../../utils/Cx.js'

export type SidebarRowLeadingMode = 'icon' | 'spacer' | 'none'
export type SidebarRowIndent = 'none' | 'session'
export type SidebarRowLayout = 'flex' | 'grid'

export type SidebarRowProps = HTMLAttributes<HTMLElement> & {
  active?: boolean
  as?: 'div' | 'li'
  asChild?: boolean
  className?: string
  indent?: SidebarRowIndent
  labelClassName?: string
  layout?: SidebarRowLayout
  leading?: ReactNode
  leadingMode?: SidebarRowLeadingMode
  trailing?: ReactNode
  children: ReactNode
}

export const SidebarRow = forwardRef<HTMLElement, SidebarRowProps>(function SidebarRow(
  {
    active = false,
    as = 'div',
    asChild = false,
    children,
    className,
    indent = 'none',
    labelClassName,
    layout = 'grid',
    leading,
    leadingMode = leading ? 'icon' : 'spacer',
    trailing,
    ...rowProps
  },
  ref,
): ReactNode {
  const hasTrailing = trailing !== undefined && trailing !== null
  const rowClassName = cx(
    'sidebar-row',
    `sidebar-row--${layout}`,
    active ? 'active' : undefined,
    active ? 'selected' : undefined,
    indent === 'session' ? 'sidebar-row--session' : undefined,
    leadingMode === 'none' ? 'sidebar-row--no-leading' : undefined,
    className,
  )
  const rowAttributes = {
    ...rowProps,
    'data-layout': layout,
    'data-leading-mode': leadingMode,
    ...(hasTrailing ? { 'data-has-trailing': 'true' } : {}),
    ...(active ? { 'data-selected': 'true' } : {}),
  }

  if (asChild) {
    const child = Children.only(children) as ReactElement<{
      className?: string
      children?: ReactNode
      ref?: Ref<HTMLElement>
    }>

    return cloneElement(
      child,
      {
        ...rowAttributes,
        className: cx(rowClassName, child.props.className),
        ref,
      },
      renderRowContent({
        children: child.props.children,
        labelClassName,
        layout,
        leading,
        leadingMode,
        trailing,
      }),
    )
  }

  const Component = as
  return (
    <Component
      className={rowClassName}
      ref={ref as Ref<HTMLDivElement> & Ref<HTMLLIElement>}
      {...rowAttributes}
    >
      {renderRowContent({
        children,
        labelClassName,
        layout,
        leading,
        leadingMode,
        trailing,
      })}
    </Component>
  )
})

function renderRowContent({
  children,
  labelClassName,
  layout: _layout,
  leading,
  leadingMode,
  trailing,
}: {
  children: ReactNode
  labelClassName?: string
  layout: SidebarRowLayout
  leading?: ReactNode
  leadingMode: SidebarRowLeadingMode
  trailing?: ReactNode
}): ReactNode {
  const hasLeading =
    leadingMode === 'icon' ? leading !== undefined && leading !== null : leadingMode === 'spacer'
  const hasTrailing = trailing !== undefined && trailing !== null

  return (
    <>
      {hasLeading ? (
        <span
          aria-hidden={leadingMode === 'spacer' ? true : undefined}
          className={cx(
            'sidebar-row-leading',
            leadingMode === 'icon' ? 'sidebar-item-icon' : 'sidebar-row-leading-spacer',
          )}
        >
          {leadingMode === 'icon' ? leading : null}
        </span>
      ) : null}
      <span className={cx('sidebar-row-main', labelClassName)}>{children}</span>
      {hasTrailing ? <span className="sidebar-row-trailing">{trailing}</span> : null}
    </>
  )
}

export function SidebarEmptyRow({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): ReactNode {
  return (
    <div
      {...props}
      className={cx('sidebar-row', 'sidebar-row--flex', 'sidebar-empty-row', className)}
      data-layout="flex"
      data-variant="empty"
    >
      <span aria-hidden="true" className="sidebar-row-leading sidebar-row-leading-spacer" />
      <p className="sidebar-empty">{children}</p>
    </div>
  )
}
