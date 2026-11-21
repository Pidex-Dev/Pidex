import React from 'react'
import { Scale } from 'lucide-react'
import type { DecisionNoticeViewEntry } from '@pidex/session-view'
import { APP_ICON_SIZES, APP_ICON_STROKE_WIDTH } from '../../../components/ui/IconTokens.js'

/**
 * Compact timeline row for a projected `decision/notice` entry: the sanitized
 * code plus its user-facing message (injection interception, archival folds,
 * automatic follow-ups).
 */
export function DecisionNoticeItem({
  notice,
}: {
  notice: DecisionNoticeViewEntry
}): React.ReactNode {
  return (
    <div
      className="tw:flex tw:min-w-0 tw:items-start tw:gap-2 tw:rounded-3 tw:bg-app-hover/60 tw:px-2 tw:py-1.5 tw:type-1 tw:text-app-text-soft"
      data-decision-notice-code={notice.code}
      role="note"
    >
      <Scale
        aria-hidden="true"
        size={APP_ICON_SIZES.sm}
        strokeWidth={APP_ICON_STROKE_WIDTH}
        className="tw:size-icon-sm tw:mt-0.5 tw:shrink-0 tw:text-app-text-meta"
      />
      <span className="tw:min-w-0 tw:wrap-anywhere">
        <span className="tw:weight-medium tw:text-app-text">{notice.message}</span>
        <span className="tw:ml-2 tw:text-app-text-meta" title={notice.specId}>
          {notice.code}
        </span>
      </span>
    </div>
  )
}