import { describe, expect, test } from 'bun:test'
import { createToolExposurePlan } from '../src/tool/ToolExposurePlan'
import { ToolCatalog } from '../src/tool/ToolRegistry'
import type { SubagentProfile, TaskMode } from '../src/Domain'
import type { ApprovalPolicy } from '@pidex/shared/thread'
import { AgentRuntimeService } from '../src/orchestration/AgentRuntimeService'
import { createLifecycleTools } from '../src/orchestration/pi/PiToolAdapter'
import type { ToolExposureInput } from '../src/tool/ToolExposurePlan'

test('运行时重建 Goal 工具暴露后仍可调用 complete/blocked，普通聊天和 allowlist 不扩大', async () => {
  const runtime = new AgentRuntimeService({
    db: {} as never,
    toolExecutor: {
      exposurePlan: (input: ToolExposureInput) => createToolExposurePlan(new ToolCatalog(), input),
    } as never,
  } as never)
  const input = {
    taskMode: 'chat' as const,
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'never' as const,
  }
  expect(runtime.toolExposure(input).allows('update_goal')).toBe(false)
  expect(runtime.toolExposure({ ...input, hasActiveGoal: true }).allows('update_goal')).toBe(true)
  const request = {
    taskMode: 'chat' as const,
    permissionConfig: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      approvalsReviewer: 'auto_review',
    },
    updateGoal: async () => {},
  }
  const plan = runtime.toolExposure(request as never)
  expect(plan.allows('update_goal')).toBe(true)
  expect(
    runtime.toolExposure({ ...request, allowedTools: ['Read'] } as never).allows('update_goal'),
  ).toBe(false)
  const calls: string[] = []
  const tools = createLifecycleTools(
    {
      updateGoal: async ({ status }) => {
        calls.push(status)
        return { status }
      },
    },
    { ...request, exposedTools: plan.exposed } as never,
  )
  const goalTool = tools.find(({ name }) => name === 'update_goal')!
  await goalTool.execute('complete-call', { status: 'complete' }, undefined, undefined)
  await goalTool.execute('blocked-call', { status: 'blocked' }, undefined, undefined)
  expect(calls).toEqual(['complete', 'blocked'])
})

const exposure = (input: {
  taskMode: TaskMode
  profile?: SubagentProfile
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy?: ApprovalPolicy
  allowedTools?: readonly string[]
}) =>
  createToolExposurePlan(new ToolCatalog(), {
    taskMode: input.taskMode,
    sandboxMode: input.sandboxMode ?? 'workspace-write',
    approvalPolicy: input.approvalPolicy ?? 'auto_review',
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
  })

describe('ToolExposurePlan finalize_result exposure', () => {
  test('纯时间草案仅由支持该能力的 Plan 主 Agent 提交，allowlist 仍有效', () => {
    const input = {
      taskMode: 'plan' as const,
      sandboxMode: 'read-only' as const,
      approvalPolicy: 'never' as const,
      hasTaskSchedules: true,
    }
    expect(createToolExposurePlan(new ToolCatalog(), input).allows('submit_task_schedule')).toBe(
      true,
    )
    expect(
      createToolExposurePlan(new ToolCatalog(), { ...input, hasTaskSchedules: false }).allows(
        'submit_task_schedule',
      ),
    ).toBe(false)
    expect(
      createToolExposurePlan(new ToolCatalog(), { ...input, profile: 'explorer' }).allows(
        'submit_task_schedule',
      ),
    ).toBe(false)
    expect(
      createToolExposurePlan(new ToolCatalog(), { ...input, taskMode: 'chat' }).allows(
        'submit_task_schedule',
      ),
    ).toBe(false)
    expect(
      createToolExposurePlan(new ToolCatalog(), { ...input, allowedTools: ['Read'] }).allows(
        'submit_task_schedule',
      ),
    ).toBe(false)
  })
  test('Chat 主 Agent 以文本收尾，不暴露 finalize_result', () => {
    const plan = exposure({ taskMode: 'chat', profile: 'main' })
    expect(plan.allows('finalize_result')).toBe(false)
    expect(plan.allows('update_plan')).toBe(true)
    expect(plan.allows('request_permissions')).toBe(true)
    expect(plan.exposed).not.toContain('finalize_result')
  })

  test('Plan 主 Agent 不暴露 finalize_result，改以 submit_plan 交付', () => {
    const plan = exposure({ taskMode: 'plan', profile: 'main' })
    expect(plan.allows('finalize_result')).toBe(false)
    expect(plan.allows('update_plan')).toBe(false)
    expect(plan.allows('request_permissions')).toBe(false)
    expect(plan.allows('submit_plan')).toBe(true)
    expect(plan.exposed).toContain('submit_plan')
    expect(plan.exposed).toContain('exec_command')
    expect(plan.exposed).toContain('write_stdin')
    expect(plan.exposed).toContain('Read')
    expect(plan.exposed).not.toContain('Write')
    expect(plan.exposed).not.toContain('Edit')
    expect(plan.exposed).not.toContain('apply_patch')
    expect(plan.exposed).not.toContain('view_image')
  })

  test('Grill 主 Agent 使用调查权限、可提问与派发 Explorer，但不暴露计划提交', () => {
    const plan = exposure({ taskMode: 'grill', profile: 'main', sandboxMode: 'danger-full-access' })
    expect(plan.allows('request_user_input')).toBe(true)
    expect(plan.allows('Agent')).toBe(true)
    expect(plan.allows('spawn_agents')).toBe(false)
    expect(plan.allows('submit_plan')).toBe(false)
    expect(plan.allows('submit_schedule_plan')).toBe(false)
    expect(plan.allows('update_plan')).toBe(false)
    expect(plan.allows('update_goal')).toBe(false)
    expect(plan.allows('request_permissions')).toBe(false)
    expect(plan.exposed).toContain('Read')
    expect(plan.exposed).toContain('exec_command')
    expect(plan.exposed).toContain('write_stdin')
    expect(plan.exposed).not.toContain('Write')
    expect(plan.exposed).not.toContain('Edit')
    expect(plan.exposed).not.toContain('apply_patch')
    expect(plan.exposed).not.toContain('view_image')
  })

  test('Plan、Grill 与 Explorer 暴露调查工具集，Glob/Grep 仅 Explorer 可见，写工具仍不可见', () => {
    for (const [taskMode, profile] of [
      ['plan', 'main'],
      ['grill', 'main'],
      ['chat', 'explorer'],
      ['plan', 'explorer'],
    ] as const) {
      const plan = exposure({ taskMode, profile })
      for (const name of ['Read', 'exec_command', 'write_stdin'])
        expect(plan.exposed).toContain(name)
      for (const name of ['Write', 'Edit', 'apply_patch', 'view_image'])
        expect(plan.exposed).not.toContain(name)
      if (profile === 'explorer') {
        expect(plan.exposed).toContain('Glob')
        expect(plan.exposed).toContain('Grep')
      } else {
        expect(plan.exposed).not.toContain('Glob')
        expect(plan.exposed).not.toContain('Grep')
      }
    }
  })

  test('暴露计划沿用配置的文件访问范围，不再改写为 read-only', () => {
    const full = exposure({ taskMode: 'plan', sandboxMode: 'danger-full-access' })
    expect(full.exposed).toContain('exec_command')
    const readOnly = exposure({ taskMode: 'plan', sandboxMode: 'read-only' })
    expect(readOnly.exposed).toContain('exec_command')
    expect(readOnly.exposed).toContain('Read')
    expect(readOnly.exposed).not.toContain('Write')
    expect(readOnly.exposed).not.toContain('apply_patch')
  })

  test('submit_plan 只属于 Plan 主 Agent', () => {
    expect(exposure({ taskMode: 'chat', profile: 'main' }).allows('submit_plan')).toBe(false)
    for (const profile of ['default', 'explorer', 'worker'] as const) {
      expect(exposure({ taskMode: 'plan', profile }).allows('submit_plan')).toBe(false)
    }
  })

  test('单层 explorer/worker 不再暴露 Agent，仅 default 子 Agent 保留有限深度递归，控制工具按需 deferred', () => {
    for (const profile of ['default', 'explorer', 'worker'] as const) {
      const plan = exposure({ taskMode: 'chat', profile })
      expect(plan.allows('finalize_result')).toBe(true)
      expect(plan.allows('update_plan')).toBe(false)
      expect(plan.allows('request_permissions')).toBe(false)
      expect(plan.allows('Agent')).toBe(profile === 'default')
      expect(plan.deferred).toContain('followup_agent')
      expect(plan.deferred).toContain('send_agent')
      expect(plan.deferred).toContain('stop_agent')
      expect(plan.deferred).toContain('list_agents')
      expect(plan.allows('report_agent')).toBe(true)
    }
  })

  test('深度上限隐藏创建入口，但保留父子通信工具与 deferred 控制发现', () => {
    const plan = createToolExposurePlan(new ToolCatalog(), {
      taskMode: 'chat',
      profile: 'default',
      depth: 3,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'auto_review',
    })
    expect(plan.allows('Agent')).toBe(false)
    expect(plan.allows('spawn_agents')).toBe(false)
    expect(plan.allows('report_agent')).toBe(true)
    expect(plan.deferred).toContain('send_agent')
    expect(plan.deferred).toContain('stop_agent')
  })

  test('Skill allowlist 不恢复主 Agent 收尾工具，子 Agent 的收尾工具不被剥离', () => {
    const main = exposure({
      taskMode: 'chat',
      profile: 'main',
      allowedTools: ['Read', 'finalize_result'],
    })
    expect(main.allows('Read')).toBe(true)
    expect(main.allows('finalize_result')).toBe(false)
    const subagent = exposure({
      taskMode: 'chat',
      profile: 'default',
      allowedTools: ['Read'],
    })
    expect(subagent.allows('Read')).toBe(true)
    expect(subagent.allows('finalize_result')).toBe(true)
  })
})
