import { expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuestionAnswerForm } from '../src/features/session/approvals/AskUserQuestionApproval.js'
import {
  hasQuestionAnswer,
  initialPlanQuestionState,
  initialQuestionState,
  type AskUserQuestion,
} from '../src/features/session/approvals/AskUserQuestionModel.js'

const clientQuestion: AskUserQuestion = {
  id: 'scope',
  header: '范围',
  question: '计划应覆盖哪些客户端？',
  options: [
    {
      id: 'desktop',
      label: '仅桌面端',
      description: '本次集中完成桌面交互。',
      recommended: true,
    },
    {
      id: 'both',
      label: '桌面端与 CLI',
      description: '同时设计共享能力和两端入口。',
    },
  ],
  multiSelect: false,
}

const phaseQuestion: AskUserQuestion = {
  id: 'phase',
  header: '阶段',
  question: '先完成哪一部分？',
  options: [
    { id: 'ask', label: '提问交互' },
    { id: 'dock', label: '计划侧栏' },
  ],
  multiSelect: false,
}

const textQuestion: AskUserQuestion = {
  id: 'free',
  header: '补充',
  question: '还有其他约束吗？',
  options: [],
  multiSelect: false,
}

const render = (
  questions: AskUserQuestion[],
  taskMode: 'chat' | 'plan' | 'grill',
  extra: Record<string, unknown> = {},
) =>
  renderToStaticMarkup(
    <QuestionAnswerForm
      requestId={`ask-${taskMode}`}
      input={{ threadId: 'thread-1', version: 1 }}
      questions={questions}
      taskMode={taskMode}
      supportsQuestionSkip
      onSubmit={() => {}}
      onReject={() => {}}
      onInterrupt={() => {}}
      {...extra}
    />,
  )

const buttonWithLabel = (html: string, label: string): string =>
  html.match(new RegExp(`<button[^>]*>${label}`))?.[0] ?? ''

test('only explicit recommendations are preselected', () => {
  expect(initialPlanQuestionState()).toEqual({ selected: [], custom: '', answered: false })
  expect(hasQuestionAnswer(initialPlanQuestionState())).toBe(false)
  expect(initialQuestionState(clientQuestion).selected).toEqual(['desktop'])
  expect(initialQuestionState(phaseQuestion).selected).toEqual([])

  const html = render([clientQuestion, phaseQuestion], 'plan')
  expect((html.match(/aria-checked="true"/gu) ?? []).length).toBe(1)
  expect((html.match(/aria-checked="false"/gu) ?? []).length).toBe(1)
  expect(html).not.toContain('需要你确认')
  expect(html).toContain('推荐')
})

test('questions without a recommendation show skip until answered', () => {
  const html = render([phaseQuestion, clientQuestion], 'plan')
  expect(html).toContain('1 of 2')
  expect(html).toContain('否，并告诉助手应该如何做得不同')
  expect(html).not.toContain('自己回答')
  expect(buttonWithLabel(html, '跳过')).not.toContain('disabled')
  expect(html).toContain('aria-label="停止本轮"')
})

test('multi-question header renders compact counter and navigation controls', () => {
  const html = render([clientQuestion, phaseQuestion], 'plan')
  expect(html).toContain('1 of 2')
  expect(html).toContain('aria-label="上一题"')
  expect(html).toContain('aria-label="下一题"')
  expect(html).not.toContain('第 1 题（待答）')
})

test('plan text-only questions render the input without an empty option list', () => {
  const html = render([textQuestion], 'plan')
  expect(html).not.toContain('radiogroup')
  expect(html).toContain('自定义回答')
  expect(html).toContain('输入你的回答')
  expect(html).not.toContain('自己回答')
})

test('chat, plan and grill share the same question card', () => {
  for (const taskMode of ['chat', 'plan', 'grill'] as const) {
    const html = render([clientQuestion, phaseQuestion], taskMode)
    expect((html.match(/aria-checked="true"/gu) ?? []).length).toBe(1)
    expect(html).toContain('1 of 2')
    expect(html).toContain('下一题')
    expect(render([phaseQuestion, clientQuestion], taskMode)).toContain('跳过当前问题')
  }
  expect(render([clientQuestion], 'chat')).toContain('aria-label="关闭"')
  expect(render([clientQuestion], 'grill')).toContain('aria-label="停止本轮"')
})
