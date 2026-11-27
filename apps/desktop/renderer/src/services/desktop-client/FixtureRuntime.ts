// Small stateless Browser Mock fallbacks shared with the Agent client. Keep
// these separate from FixtureShared.ts so Electron startup does not parse the
// much larger mock thread-history projection.
import type { DesktopPermissionMode } from '../../../shared/Types.js'
import type { PermissionConfig } from '@pidex/shared/thread'
import { permissionModeFromPermissionConfig } from '../AgentThreadAdapter.js'

export function permissionModeFromDesktopConfig(config: PermissionConfig): DesktopPermissionMode {
  return permissionModeFromPermissionConfig(config)
}

export async function bridgeWindowMaximized(): Promise<boolean> {
  return (await window.DesktopBridge?.isMaximized()) ?? false
}
