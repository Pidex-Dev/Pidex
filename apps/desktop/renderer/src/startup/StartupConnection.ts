import { useExternalSubscription } from '../hooks/UseExternalSubscription.js'
import type { DesktopDataLocationIpcBridge } from '@pidex/shared/desktop-data-location-ipc'
import type {
  DesktopStartupIpcBridge,
  DesktopStartupSnapshot,
} from '@pidex/shared/desktop-startup-ipc'

const CONNECTED_FALLBACK_SNAPSHOT: DesktopStartupSnapshot = {
  generation: 0,
  revision: 0,
  state: 'connected',
  label: 'ready',
}

let currentSnapshot: DesktopStartupSnapshot | undefined
const connectionListeners = new Set<() => void>()

type StartupRecoveryBridge = Pick<DesktopStartupIpcBridge, 'retryStartup'> &
  Pick<DesktopDataLocationIpcBridge, 'retryDataLocation' | 'restoreDataLocation'>

export interface StartupRecoveryAction {
  label: string
  errorMessage: string
  run(bridge: StartupRecoveryBridge): Promise<void>
}

export function startupRecoveryActions(snapshot: DesktopStartupSnapshot): StartupRecoveryAction[] {
  if (snapshot.state !== 'failed') return []
  if (snapshot.failureReason === 'relocation') {
    return [
      {
        label: '重试迁移',
        errorMessage: '无法重试迁移，请查看日志。',
        run: (bridge) => bridge.retryDataLocation(),
      },
      {
        label: '恢复原位置并重启',
        errorMessage: '无法恢复原数据位置，请查看日志。',
        run: (bridge) => bridge.restoreDataLocation(),
      },
    ]
  }
  return [
    {
      label: '重试连接',
      errorMessage: '无法重试连接，请查看日志。',
      run: (bridge) => bridge.retryStartup(snapshot.generation),
    },
  ]
}

function isStaleStartupSnapshot(
  current: DesktopStartupSnapshot | undefined,
  incoming: DesktopStartupSnapshot,
): boolean {
  if (!current) return false
  if (incoming.generation < current.generation) return true
  return incoming.generation === current.generation && incoming.revision <= current.revision
}

/** 更新全局启动/连接快照并通知订阅组件。 */
export function publishStartupConnectionSnapshot(snapshot: DesktopStartupSnapshot): void {
  if (isStaleStartupSnapshot(currentSnapshot, snapshot)) return
  currentSnapshot = snapshot
  for (const listener of connectionListeners) listener()
}

export function getStartupConnectionSnapshot(): DesktopStartupSnapshot {
  return currentSnapshot ?? CONNECTED_FALLBACK_SNAPSHOT
}

export function subscribeStartupConnectionStore(listener: () => void): () => void {
  connectionListeners.add(listener)
  return () => {
    connectionListeners.delete(listener)
  }
}

export function resetStartupConnectionStore(): void {
  currentSnapshot = undefined
  for (const listener of connectionListeners) listener()
}

export function useStartupConnectionSnapshot(): DesktopStartupSnapshot {
  return useExternalSubscription(subscribeStartupConnectionStore, getStartupConnectionSnapshot)
}

/** 先订阅再取快照；revision 防止晚到的快照覆盖新事件。 */
export function subscribeStartupConnection(
  bridge: Pick<DesktopStartupIpcBridge, 'getStartupSnapshot' | 'onStartupChanged'>,
  listener: (snapshot: DesktopStartupSnapshot) => void,
  onError: () => void,
): () => void {
  let latest: DesktopStartupSnapshot | undefined
  let disposed = false
  const accept = (snapshot: DesktopStartupSnapshot) => {
    if (disposed || isStaleStartupSnapshot(latest, snapshot)) return
    latest = snapshot
    listener(snapshot)
  }
  const unsubscribe = bridge.onStartupChanged(accept)
  void bridge.getStartupSnapshot().then(accept, () => {
    if (!disposed && !latest) onError()
  })
  return () => {
    disposed = true
    unsubscribe()
  }
}
