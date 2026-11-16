import { expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  QuestionAnswerForm,
  parseAskUserQuestions,
} from '../src/features/session/approvals/AskUserQuestionApproval.js'
import {
  formatGrantOptionLabel,
  InlineApprovalCard,
} from '../src/features/session/approvals/InlineApprovalCard.js'
import { PlanApprovalCard } from '../src/features/session/approvals/PlanApprovalCard.js'

test('question form keeps strict tool input parsing and never falls back to a plan answer mapping', () => {
  const oneOption = {
    id: 'implement',
    header: '计划',
    question: '实施此计划？',
    options: [{ label: '是，实施此计划', description: '' }],
    multiSelect: false,
  }
  expect(parseAskUserQuestions({ questions: [oneOption] })).toBeNull()
  const question = {
    id: 'scope',
    header: '范围',
    question: '应该覆盖哪些客户端？',
    options: [
      { label: '仅桌面端', description: '集中完成桌面交互。' },
      { label: '桌面端与 CLI', description: '同时设计共享能力和两端入口。' },
    ],
    multiSelect: false,
  }
  const html = renderToStaticMarkup(
    <QuestionAnswerForm
      requestId="question-1"
      questions={[question]}
      identity="子代理"
      disabledReason="只能由父任务继续"
      onSubmit={() => {}}
      onReject={() => {}}
    />,
  )
  expect(html).toContain('data-variant="question"')
  expect(html).toContain('应该覆盖哪些客户端？')
  expect(html).toContain('只能由父任务继续')
  expect(html).toContain('<fieldset class="request-card-content" disabled="">')
  expect(html).toContain('request-card-marker')
})

test('permissions use independent allow/deny actions and preserve read-only command details', () => {
  const html = renderToStaticMarkup(
    <InlineApprovalCard
      request={{
        requestId: 'approval-1',
        toolName: 'Bash',
        input: { command: 'bun test' },
        description: '验证修改',
        autoReviewFallbackReason: '需要人工确认',
      }}
      disabledReason="父任务控制"
      onDecide={() => {}}
    />,
  )
  expect(html).toContain('需要运行 bun test，是否允许执行？')
  expect(html).toContain('canonical-command-shell canonical-command-card')
  expect(html).toContain('>是<')
  expect(html).not.toContain('允许一次')
  expect(html).toContain('否，请告知 Pidex 如何调整')
  expect(html).toContain('忽略')
  expect(html).toContain('提交')
  expect(html).toContain('bun test')
  expect(html).toContain('验证修改')
  expect(html).toContain('需要人工确认')
  expect(html).toContain('disabled=""')
  expect(html).toContain('radiogroup')
  expect(html).toContain('<textarea')
  expect(html).not.toContain('>拒绝<')
})

test('permission card formats outside-workspace titles and conversational grant options', () => {
  const fileHtml = renderToStaticMarkup(
    <InlineApprovalCard
      request={{
        requestId: 'approval-ext-file',
        toolName: 'Write',
        input: {
          affectedPaths: [{ path: 'C:\\Users\\XiaoHi\\Desktop\\文档\\测试.txt', operation: 'create' }],
        },
        description: '检测到风险或工作区外操作，需要批准',
        grantOptions: [
          { id: 's1', kind: 'files', scope: 'session', label: '在此会话中允许（当前项目）' },
          { id: 'p1', kind: 'files', scope: 'project', label: '始终允许（当前项目）' },
        ],
      }}
      onDecide={() => {}}
    />,
  )
  expect(fileHtml).toContain('需要在工作区外的 C:\\Users\\XiaoHi\\Desktop\\文档 目录创建 测试.txt，是否允许执行？')
  expect(fileHtml).not.toContain('检测到风险或工作区外操作，需要批准')
  expect(
    formatGrantOptionLabel({
      id: 's1',
      kind: 'files',
      scope: 'session',
      label: '在此会话中允许（当前项目）',
    }),
  ).toBe('是，且本次会话不再询问')
  expect(
    formatGrantOptionLabel({
      id: 'p1',
      kind: 'files',
      scope: 'project',
      label: '始终允许（当前项目）',
    }),
  ).toBe('是，且当前项目不再询问')

  const cmdHtml = renderToStaticMarkup(
    <InlineApprovalCard
      request={{
        requestId: 'approval-ext-cmd',
        toolName: 'exec_command',
        input: {
          cwd: 'F:\\workspace\\pidex',
          command:
            "Get-ChildItem -LiteralPath 'C:\\Users\\XiaoHi\\Desktop\\文档\\CodeX-Use\\Personal Agent' -Force | Select-Object Mode,Length",
        },
        description: '命令或 cwd 指向工作区外路径',
      }}
      workspacePath="F:\\workspace\\pidex"
      onDecide={() => {}}
    />,
  )
  expect(cmdHtml).toContain(
    '需要在工作区外的 C:\\Users\\XiaoHi\\Desktop\\文档\\CodeX-Use\\Personal Agent 目录运行 Get-ChildItem，是否允许执行？',
  )
  expect(cmdHtml).not.toContain('工作区外的 F:\\workspace\\pidex')
  expect(cmdHtml).not.toContain('命令或 cwd 指向工作区外路径')
  expect(cmdHtml).toContain('canonical-command-shell__prompt')
  expect(cmdHtml).not.toContain('exec_command -command')
})

test('guardian review exposes status, risk, authorization and rationale', () => {
  const html = renderToStaticMarkup(
    <InlineApprovalCard
      request={{
        requestId: 'approval-2',
        toolName: 'Bash',
        input: { command: 'rm -rf ./tmp' },
        description: '清理临时目录',
        guardian: {
          status: 'completed',
          source: 'model',
          risk: 'high',
          userAuthorization: 'low',
          confidence: 'high',
          categories: ['destructive'],
          rationale: '用户没有明确授权删除该目录。',
          reviewedAt: 1,
        },
      }}
      onDecide={() => {}}
    />,
  )
  expect(html).toContain('Guardian 自动审查')
  expect(html).toContain('审查完成')
  expect(html).toContain('高风险')
  expect(html).toContain('授权弱')
  expect(html).toContain('用户没有明确授权删除该目录。')
  expect(html).toContain('破坏性')
})

test('plan review renders implement selection, feedback input and ignore/submit actions', () => {
  const html = renderToStaticMarkup(
    <PlanApprovalCard
      approval={{
        id: 'approval',
        threadId: 'thread',
        turnId: 'turn',
        planItemId: 'turn-1:plan',
        version: 1,
        status: 'pending',
        title: '实施计划',
        markdown: '# 计划',
        nextTurnId: null,
        createdAt: 1,
        resolvedAt: null,
      }}
      disabledReason="只能由父任务继续"
      onRespond={async () => {}}
    />,
  )
  expect(html).toContain('data-variant="plan"')
  expect(html).toContain('实施此计划？')
  expect(html).toContain('是，实施此计划')
  expect(html).toContain('否，请告知 Pidex 如何调整')
  expect(html).toContain('忽略')
  expect(html).toContain('提交')
  expect(html).toContain('disabled=""')
  expect(html).not.toContain('计划已准备好')
  expect(html).not.toContain('查看全文')
  expect(html).not.toContain('修改计划')
  expect(html).not.toContain('开始实施')
  expect(html).not.toContain('退出 Plan')
  expect(html).not.toContain('跳过')
  expect(html).not.toContain('继续规划')
})
