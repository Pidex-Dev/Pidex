export const DESKTOP_SHELL_IPC_CHANNELS = {
  openExternal: 'shell:open-external',
  listExternalOpenTargets: 'shell:list-external-open-targets',
  openPathWithTarget: 'shell:open-path-with-target',
  revealPathInFolder: 'shell:reveal-path-in-folder',
  openDirectory: 'shell:open-directory',
  getUserDataStorageSummary: 'shell:get-user-data-storage-summary',
  listUserDataDownloadedResources: 'shell:list-user-data-downloaded-resources',
  deleteUserDataDownloadedResource: 'shell:delete-user-data-downloaded-resource',
} as const

export type DesktopUserDataStorageSummary = {
  userDataDir: string
  totalBytes: number
  runtimesBytes: number
  otherBytes: number
}

export type DesktopUserDataDownloadedResource = {
  id: string
  name: string
  category: 'font' | 'runtime'
  description: string
  path: string
  sizeBytes: number
}

export type DesktopExternalOpenTargetKind = 'editor' | 'file-explorer' | 'terminal'

export type DesktopExternalOpenTarget = {
  targetId: string
  label: string
  kind: DesktopExternalOpenTargetKind
  iconDataUrl?: string
}

export interface DesktopShellIpcBridge {
  openExternal(url: string): Promise<void>
  listExternalOpenTargets(targetPath: string): Promise<DesktopExternalOpenTarget[]>
  openPathWithTarget(targetPath: string, targetId: string): Promise<void>
  revealPathInFolder(targetPath: string): Promise<void>
  openDirectory(targetPath: string): Promise<void>
  getUserDataStorageSummary(): Promise<DesktopUserDataStorageSummary>
  listUserDataDownloadedResources(): Promise<DesktopUserDataDownloadedResource[]>
  deleteUserDataDownloadedResource(
    resourceId: string,
  ): Promise<{ resourceId: string; reclaimedBytes: number }>
}
