import React from 'react'
import type { SubagentStatus } from '@pidex/shared/thread'

export function subagentStatusLabel(status: string): string {
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'stopped') return '已停止'
  if (status === 'interrupted') return '已中断'
  if (status === 'queued') return '排队中'
  if (status === 'preparing') return '准备中'
  if (status === 'waiting-question') return '等待回答'
  if (status === 'waiting-permission') return '等待审批'
  if (status === 'steering') return '调整中'
  return '运行中'
}

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set([
  'completed',
  'failed',
  'stopped',
  'interrupted',
])

export function isTerminalSubagentStatus(status: SubagentStatus | null | undefined): boolean {
  return Boolean(status && TERMINAL_STATUSES.has(status))
}

/** 状态词只在需要用户注意时展示；completed 不额外加状态词。 */
export function subagentAttentionLabel(status: SubagentStatus): string | null {
  if (status === 'waiting-question' || status === 'waiting-permission') {
    return subagentStatusLabel(status)
  }
  if (status === 'failed' || status === 'stopped' || status === 'interrupted') {
    return subagentStatusLabel(status)
  }
  return null
}

let clockNow = Date.now()
const clockListeners = new Set<() => void>()
let clockTimer: number | null = null

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener)
  if (clockTimer == null && typeof window !== 'undefined') {
    clockNow = Date.now()
    clockTimer = window.setInterval(() => {
      clockNow = Date.now()
      for (const notify of clockListeners) notify()
    }, 1_000)
  }
  return () => {
    clockListeners.delete(listener)
    if (clockListeners.size === 0 && clockTimer != null && typeof window !== 'undefined') {
      window.clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

const subscribeNoop = () => () => {}
const SERVER_CLOCK_FALLBACK = 0

export function useRunningClock(running: boolean): number {
  return React.useSyncExternalStore(
    running ? subscribeClock : subscribeNoop,
    () => (running ? clockNow : SERVER_CLOCK_FALLBACK),
    () => SERVER_CLOCK_FALLBACK,
  )
}

export function formatElapsed(since: number | null, now: number): string {
  if (since == null) return '运行中'
  const seconds = Math.max(0, Math.floor((now - since) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
