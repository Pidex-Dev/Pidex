import type { ReactNode } from 'react'
import { Button, type ButtonProps } from '../../../components/ui/Button.js'
import { cn } from '../../../utils/Cn.js'

/** 供应商右侧面板容器查询锚点；窄于 380px 时操作按钮折叠为纯图标。 */
export const PROVIDER_PANEL_CONTAINER_CLASS = 'tw:@container/provider-panel'

type ProviderPanelActionButtonProps = Omit<
  ButtonProps,
  'children' | 'color' | 'leftIcon' | 'shape' | 'size' | 'variant'
> & {
  icon: ReactNode
  label: string
}

const BUTTON_RESPONSIVE_CLASS =
  'tw:[min-inline-size:var(--button-box-size)] tw:shrink-0 tw:transition-[background-color,border-color,color,opacity,transform,box-shadow,gap,padding-inline] tw:duration-feedback tw:ease-standard tw:motion-reduce:transition-none tw:@max-[380px]/provider-panel:gap-0 tw:@max-[380px]/provider-panel:px-0 tw:@max-[380px]/provider-panel:[transition-delay:var(--cpx-sys-motion-instant),var(--cpx-sys-motion-instant),var(--cpx-sys-motion-instant),var(--cpx-sys-motion-instant),var(--cpx-sys-motion-instant),var(--cpx-sys-motion-instant),var(--cpx-sys-motion-feedback),var(--cpx-sys-motion-feedback)]'

const LABEL_RESPONSIVE_CLASS =
  'tw:inline-grid tw:grid-cols-[1fr] tw:opacity-100 tw:transition-[grid-template-columns,opacity] tw:duration-feedback tw:ease-standard tw:motion-reduce:transition-none tw:[transition-delay:var(--cpx-sys-motion-instant),var(--cpx-sys-motion-feedback)] tw:@max-[380px]/provider-panel:pointer-events-none tw:@max-[380px]/provider-panel:grid-cols-[0fr] tw:@max-[380px]/provider-panel:opacity-0 tw:@max-[380px]/provider-panel:[transition-delay:var(--cpx-sys-motion-feedback),var(--cpx-sys-motion-instant)]'

/** 供应商设置右侧面板的响应式操作按钮：宽态显示图标与文字，窄态先淡出文字再收拢为 28×28 纯图标按钮。 */
export function ProviderPanelActionButton({
  className,
  icon,
  label,
  title,
  ...props
}: ProviderPanelActionButtonProps): ReactNode {
  return (
    <Button
      {...props}
      aria-label={props['aria-label'] ?? label}
      className={cn(BUTTON_RESPONSIVE_CLASS, className)}
      color="secondary"
      leftIcon={icon}
      shape="default"
      size="sm"
      title={title ?? label}
    >
      <span className={LABEL_RESPONSIVE_CLASS}>
        <span className="tw:min-w-0 tw:overflow-hidden tw:whitespace-nowrap">{label}</span>
      </span>
    </Button>
  )
}
