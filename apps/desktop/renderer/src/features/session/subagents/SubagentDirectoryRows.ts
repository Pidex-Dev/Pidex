import {
  resolveSubagentDisplayParts,
  type SubagentProfile,
  type SubagentProjection,
  type SubagentRole,
  type SubagentStatus,
} from '@pidex/shared/thread'
import { isTerminalSubagentStatus } from './SubagentStatusLabel.js'
import { resolveSubagentRole } from './SubagentRole.js'

export type SubagentDirectoryRow = {
  taskId: string
  agentName: string
  taskTitle: string
  name: string
  summary: string
  status: SubagentStatus
  profile: SubagentProfile
  /** 展示用角色：显式 role 优先，其次名称/任务推断。 */
  role: SubagentRole
  /** 排序与相对时间基准：结束 → 开始 → 创建。 */
  sortKey: number
  runningSince: number | null
  terminal: boolean
}

export function toSubagentDirectoryRow({
  task,
  currentRun,
}: SubagentProjection): SubagentDirectoryRow {
  const status: SubagentStatus = currentRun?.status ?? 'interrupted'
  const { agentName, taskTitle } = resolveSubagentDisplayParts({
    displayName: task.displayName,
    title: task.title,
    profile: task.profile,
    role: task.role,
    task: task.task,
  })
  return {
    taskId: task.id,
    agentName,
    taskTitle,
    name: taskTitle || agentName,
    summary: currentRun?.result?.summary ?? currentRun?.error ?? task.task,
    status,
    profile: task.profile,
    role: resolveSubagentRole({ role: task.role, displayName: task.displayName, task: task.task }),
    sortKey: currentRun?.finishedAt ?? currentRun?.startedAt ?? task.createdAt,
    runningSince: isTerminalSubagentStatus(status) ? null : (currentRun?.startedAt ?? null),
    terminal: isTerminalSubagentStatus(status),
  }
}

/** 只取该父 thread 的直属任务，按时间降序，并拆成运行中/已结束两段。 */
export function buildSubagentDirectory(
  projections: readonly SubagentProjection[],
  parentThreadId: string,
): { running: SubagentDirectoryRow[]; finished: SubagentDirectoryRow[] } {
  const rows = projections
    .filter((entry) => entry.task.parentThreadId === parentThreadId)
    .map(toSubagentDirectoryRow)
    .sort((left, right) => right.sortKey - left.sortKey)
  return {
    running: rows.filter((row) => !row.terminal),
    finished: rows.filter((row) => row.terminal),
  }
}
