import { afterEach, expect, test } from 'bun:test'
import type { DesktopStartupSnapshot } from '@pidex/shared/desktop-startup-ipc'
import {
  getStartupConnectionSnapshot,
  publishStartupConnectionSnapshot,
  resetStartupConnectionStore,
  subscribeStartupConnection,
  subscribeStartupConnectionStore,
} from '../src/startup/StartupConnection.js'

afterEach(() => {
  resetStartupConnectionStore()
})

test('早到事件优先于旧快照，拒绝旧代通知并在清理后停止投递', async () => {
  const seen: number[] = []
  let emit!: (snapshot: DesktopStartupSnapshot) => void
  let resolve!: (snapshot: DesktopStartupSnapshot) => void
  const stop = subscribeStartupConnection(
    {
      onStartupChanged(listener) {
        emit = listener
        return () => {}
      },
      getStartupSnapshot: () =>
        new Promise((done) => {
          resolve = done
        }),
    },
    (state) => seen.push(state.revision),
    () => {
      throw new Error('unexpected error')
    },
  )
  const state = (generation: number, revision: number): DesktopStartupSnapshot => ({
    generation,
    revision,
    state: 'connected',
    label: 'ready',
  })
  emit(state(2, 3))
  resolve(state(1, 1))
  await Promise.resolve()
  emit(state(1, 4))
  emit(state(2, 3))
  emit(state(2, 5))
  stop()
  emit(state(3, 6))
  expect(seen).toEqual([3, 5])
})

test('连接快照仓库过滤旧快照并通知订阅方', () => {
  expect(getStartupConnectionSnapshot().state).toBe('connected')

  let notifications = 0
  const unsubscribe = subscribeStartupConnectionStore(() => {
    notifications += 1
  })

  publishStartupConnectionSnapshot({
    generation: 2,
    revision: 5,
    state: 'loading',
    label: 'Agent 连接中断，正在重试',
  })
  publishStartupConnectionSnapshot({
    generation: 1,
    revision: 99,
    state: 'failed',
    label: 'stale',
  })
  publishStartupConnectionSnapshot({
    generation: 2,
    revision: 5,
    state: 'failed',
    label: 'duplicate',
  })

  expect(notifications).toBe(1)
  expect(getStartupConnectionSnapshot()).toEqual({
    generation: 2,
    revision: 5,
    state: 'loading',
    label: 'Agent 连接中断，正在重试',
  })

  unsubscribe()
})
