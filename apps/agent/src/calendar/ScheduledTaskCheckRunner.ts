import type { ScheduleAutomaticCheck } from '@pidex/shared/schedule-draft'
import type { ScheduledTask } from '@pidex/shared/scheduled-task'
import type { TaskOccurrence } from '@pidex/shared/task-schedule'
import { normalizeScheduledPermission } from '../automation/AutomationService'
import type { AgentDatabase } from '../storage/database/AgentDatabase'
import type { ToolExecutor } from '../tool/ToolExecutor'
import type { ThreadWorkspaceResolver } from '../workspace/ThreadWorkspaceResolver'

export const createScheduledTaskCheckRunner = (deps: {
  db: AgentDatabase
  workspaceResolver: ThreadWorkspaceResolver
  toolExecutor: ToolExecutor
}) => {
  return async (
    check: ScheduleAutomaticCheck,
    occurrence: TaskOccurrence,
    run: ScheduledTask | null,
  ): Promise<boolean> => {
    const threadId = run?.threadId ?? occurrence.snapshot.execution?.targetThreadId
    const turnId =
      run?.turnId ??
      (threadId ? deps.db.repositories.taskSchedules.latestTurnId(threadId) : null)
    const execution = run ?? occurrence.snapshot.execution
    if (!threadId || !turnId || !execution) return false
    const runtime = await deps.workspaceResolver.resolve(threadId)
    const context = {
      threadID: threadId,
      turnID: turnId,
      toolCallID: `task-check:${occurrence.id}:${occurrence.resultVersion}:${occurrence.snapshot.checks.indexOf(check)}`,
      taskMode: 'chat' as const,
      signal: AbortSignal.timeout(120_000),
      workspace: runtime.workspace,
      defaultCwd: runtime.cwd,
      permissionConfig: normalizeScheduledPermission(execution.permissionConfig),
      model: execution.model,
      taskSummary: '任务自动验收',
    }
    if (check.kind === 'command-exit-code') {
      const result = await deps.toolExecutor.execute<{ exitCode: number }>(
        'PowerShell',
        { command: check.command, timeout: 120_000, description: '任务自动验收' },
        context,
      )
      return result.exitCode === check.expectedExitCode
    }
    return await deps.toolExecutor.execute<boolean>(
      'task_schedule_check',
      {
        file_path: check.path,
        ...(check.kind === 'document-section' ? { section: check.section } : {}),
      },
      context,
    )
  }
}
