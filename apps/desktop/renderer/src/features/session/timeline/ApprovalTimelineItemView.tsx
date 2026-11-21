import React from 'react'
import { Shield, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import type { ApprovalRequest } from '@pidex/shared/thread'
import { APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'

function approvalTargetLabel(approval: ApprovalRequest): string {
  if (approval.tool === 'McpElicitation') {
    const server = approval.toolIdentity?.server?.trim()
    if (server) return server
    const inputServer =
      typeof approval.input?.serverName === 'string' ? approval.input.serverName.trim() : ''
    if (inputServer) return inputServer
  }
  const tool = approval.tool.trim()
  return tool || '操作'
}

function approvalTimelineLabel(approval: ApprovalRequest): string {
  const target = approvalTargetLabel(approval)
  switch (approval.status) {
    case 'pending':
      return `等待用户授权 ${target}`
    case 'allowed':
      return `用户已授权 ${target}`
    case 'denied':
      return `用户已拒绝授权 ${target}`
    case 'cancelled':
      return `已取消授权 ${target}`
  }
}

/** Render a lightweight single-line timeline row for a user authorization event. */
export function ApprovalTimelineItemView({
  approval,
}: {
  approval: ApprovalRequest
}): React.ReactNode {
  const label = approvalTimelineLabel(approval)
  const pending = approval.status === 'pending'
  const Icon =
    approval.status === 'pending'
      ? ShieldAlert
      : approval.status === 'allowed'
        ? ShieldCheck
        : approval.status === 'denied'
          ? ShieldX
          : Shield
  return (
    <div
      className="canonical-lifecycle-tool"
      data-approval-id={approval.id}
      data-state={approval.status}
      role={pending ? 'status' : undefined}
    >
      <span className="canonical-lifecycle-tool__icon">
        <Icon size={APP_ICON_SIZES.sm} aria-hidden="true" />
        {pending ? (
          <Icon
            size={APP_ICON_SIZES.sm}
            className="canonical-lifecycle-tool__icon-flash"
            aria-hidden="true"
          />
        ) : null}
      </span>
      <span>{label}</span>
    </div>
  )
}
