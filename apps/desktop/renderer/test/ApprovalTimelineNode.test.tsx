import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildRenderTurnEntry, type VisibleTurnEntry } from '@pidex/session-view'
import type { ApprovalRequest, Item } from '@pidex/shared/thread'
import { ApprovalTimelineItemView } from '../src/features/session/timeline/ApprovalTimelineItemView'
import {
  CanonicalConversationTurn,
  buildProcessActivityModel,
} from '../src/features/session/timeline/CanonicalThreadView'
import {
  ConversationItemContext,
  OPTIONAL_CONVERSATION_ITEM_CONTEXT,
} from '../src/features/session/timeline/ConversationItemContext'
import { createKeyedDisclosureStore } from '../src/components/ui/KeyedDisclosureStore'

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'approval-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    toolCallID: 'call-action',
    tool: 'BrowserAction',
    command: null,
    cwd: null,
    paths: [],
    requestedPermissions: { readPaths: [], writePaths: [], networkDomains: [] },
    review: null,
    risk: 'medium',
    reason: '本次点击单个按钮 ref=e8 风险未知，需要确认后放行。',
    status: 'pending',
    createdAt: 20,
    ...overrides,
  }
}

function makeToolItem(
  overrides: Partial<Extract<Item, { type: 'tool' }>> = {},
): Extract<Item, { type: 'tool' }> {
  return {
    id: 'tool-1',
    messageID: 'turn-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    type: 'tool',
    callID: 'call-action',
    tool: 'BrowserAction',
    title: 'BrowserAction',
    state: 'completed',
    input: {},
    output: 'ok',
    error: null,
    createdAt: 18,
    ...overrides,
  }
}

function makeVisibleTurn(
  approvals: ApprovalRequest[],
  items: Item[] = [],
  turnStatus: VisibleTurnEntry['turn']['status'] = 'waiting-permission',
): VisibleTurnEntry {
  return {
    id: 'turn-1',
    turn: {
      id: 'turn-1',
      threadId: 'thread-1',
      status: turnStatus,
      mode: 'chat',
      model: { providerID: 'openai', id: 'gpt-4o' },
      permissionConfig: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'auto_review',
        approvalsReviewer: 'auto_review',
      },
      rootAgentId: 'agent-1',
      sourceInputID: 'input-1',
      mergedInputIDs: [],
      queuePosition: null,
      startedAt: 10,
      finishedAt: turnStatus === 'completed' ? 40 : null,
      createdAt: 10,
      error: null,
    },
    userInputs: [],
    agents: [],
    items,
    approvals,
    attachments: [],
    contextReferences: [],
  }
}

describe('ApprovalTimelineNode', () => {
  test('三类授权与全部状态生成统一单行文案', () => {
    expect(
      renderToStaticMarkup(
        <ApprovalTimelineItemView
          approval={makeApproval({ status: 'pending', tool: 'BrowserAction' })}
        />,
      ),
    ).toContain('等待用户授权 BrowserAction')
    expect(
      renderToStaticMarkup(
        <ApprovalTimelineItemView
          approval={makeApproval({ status: 'allowed', tool: 'BrowserAction' })}
        />,
      ),
    ).toContain('用户已授权 BrowserAction')
    expect(
      renderToStaticMarkup(
        <ApprovalTimelineItemView
          approval={makeApproval({ status: 'denied', tool: 'request_permissions' })}
        />,
      ),
    ).toContain('用户已拒绝授权 request_permissions')
    expect(
      renderToStaticMarkup(
        <ApprovalTimelineItemView
          approval={makeApproval({
            status: 'cancelled',
            tool: 'McpElicitation',
            toolIdentity: { server: 'github', tool: 'create_issue' },
          })}
        />,
      ),
    ).toContain('已取消授权 github')
  })

  test('等待授权时正文流渲染单行普通节点且不重复渲染长理由卡片', () => {
    const approval = makeApproval({ status: 'pending' })
    const entry = buildRenderTurnEntry(makeVisibleTurn([approval], [], 'waiting-permission'))
    const markup = renderToStaticMarkup(
      <CanonicalConversationTurn
        disclosureState={createKeyedDisclosureStore({})}
        dockedPlanItemId={null}
        entry={entry}
        onOpenPlanInRightDock={() => {}}
        onOpenSubagent={() => {}}
        threadId="thread-1"
      />,
    )

    expect(markup).toContain('canonical-lifecycle-tool')
    expect(markup).toContain('等待用户授权 BrowserAction')
    expect(markup).toContain('data-approval-id="approval-1"')
    expect(markup).toContain('data-state="pending"')
    expect(markup).not.toContain('canonical-blocker-card')
    expect(markup).not.toContain('需要授权')
    expect(markup).not.toContain(approval.reason)
  })

  test('点击完成与重开会话展开处理过程时授权节点保持可见', () => {
    const approval = makeApproval({ status: 'allowed' })
    const tool = makeToolItem({ id: 'tool-browser', callID: 'call-action', createdAt: 18 })
    const answer: Item = {
      id: 'text-final',
      messageID: 'turn-1',
      turnId: 'turn-1',
      agentId: 'agent-1',
      type: 'text',
      text: '已完成点击测试。',
      phase: 'final_answer',
      placement: 'result',
      status: 'completed',
      createdAt: 35,
    }
    const entry = buildRenderTurnEntry(makeVisibleTurn([approval], [tool, answer], 'completed'))
    const disclosureState = createKeyedDisclosureStore({})
    disclosureState.setExpanded('turn-activity:turn-1', true)

    const markup = renderToStaticMarkup(
      <ConversationItemContext.Provider value={OPTIONAL_CONVERSATION_ITEM_CONTEXT}>
        <CanonicalConversationTurn
          disclosureState={disclosureState}
          dockedPlanItemId={null}
          entry={entry}
          onOpenPlanInRightDock={() => {}}
          onOpenSubagent={() => {}}
          threadId="thread-1"
        />
      </ConversationItemContext.Provider>,
    )

    expect(markup).toContain('用户已授权 BrowserAction')
    expect(markup).toContain('data-approval-id="approval-1"')
    expect(markup).toContain('data-state="allowed"')
    expect(markup).toContain('已完成点击测试。')
    expect(markup).not.toContain(approval.reason)
  })

  test('buildProcessActivityModel 按工具调用锚点与时间顺序穿插授权节点并正确控制思考占位', () => {
    const firstTool = makeToolItem({
      id: 'tool-read',
      callID: 'call-read',
      tool: 'Read',
      createdAt: 10,
    })
    const guardedTool = makeToolItem({
      id: 'tool-action',
      callID: 'call-action',
      tool: 'BrowserAction',
      createdAt: 20,
    })
    const anchoredApproval = makeApproval({
      id: 'approval-anchored',
      toolCallID: 'call-action',
      status: 'allowed',
      createdAt: 22,
    })
    const trailingApproval = makeApproval({
      id: 'approval-trailing',
      toolCallID: 'call-missing',
      tool: 'McpElicitation',
      toolIdentity: { server: 'linear', tool: 'update' },
      status: 'pending',
      createdAt: 30,
    })

    const model = buildProcessActivityModel(
      [firstTool, guardedTool],
      { activitySliceClosed: false, hasBlockingRequest: true, turnActive: true },
      [],
      [anchoredApproval, trailingApproval],
    )

    expect(model.units.map((unit) => unit.key)).toEqual([
      'process-item:tool-read',
      'process-approval:approval-anchored',
      'process-item:tool-action',
      'process-approval:approval-trailing',
    ])
    expect(model.showThinkingFallback).toBe(false)

    const resumed = buildProcessActivityModel(
      [],
      { activitySliceClosed: false, hasBlockingRequest: false, turnActive: true },
      [],
      [anchoredApproval],
    )
    expect(resumed.showThinkingFallback).toBe(true)
  })

  test('ApprovalTimelineItemView 在非等待态不渲染动画层', () => {
    const allowedMarkup = renderToStaticMarkup(
      <ApprovalTimelineItemView approval={makeApproval({ status: 'allowed' })} />,
    )
    const pendingMarkup = renderToStaticMarkup(
      <ApprovalTimelineItemView approval={makeApproval({ status: 'pending' })} />,
    )
    expect(pendingMarkup).toContain('canonical-lifecycle-tool__icon-flash')
    expect(pendingMarkup).toContain('role="status"')
    expect(allowedMarkup).not.toContain('canonical-lifecycle-tool__icon-flash')
    expect(allowedMarkup).not.toContain('role="status"')
  })
})
