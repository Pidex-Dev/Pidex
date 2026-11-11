import type React from 'react'
import { APP_ICON_SIZE } from './IconTokens.js'

type PidexMarkIconProps = {
  className?: string
  size?: number
}

/**
 * Pidex 启卷品牌矢量图标，默认使用 `fill="currentColor"` 继承父级前景色。
 */
export function PidexMarkIcon({
  className,
  size = APP_ICON_SIZE,
}: PidexMarkIconProps): React.ReactNode {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      focusable="false"
      height={size}
      viewBox="0 0 1024 1024"
      width={size}
    >
      <g fill="currentColor" transform="translate(100 180) scale(1.44) translate(-217 -275)">
        <path d="M225 389Q214 389 218 376L236 319Q250 275 300 275H781Q794 275 789 288C780 318 754 328 723 336C657 352 594 371 579 405Q571 419 571 437C601 397 699 377 789 340V615Q789 631 774 641C695 675 611 684 552 734V399Q552 389 542 389Z" />
        <path d="M356 410H432Q473 410 473 454V680Q473 734 417 734H241Q226 734 238 726C307 691 320 649 327 591L350 419Q351 410 356 410Z" />
      </g>
    </svg>
  )
}
