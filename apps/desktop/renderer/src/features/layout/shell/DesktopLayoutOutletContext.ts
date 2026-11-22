import { useOutletContext } from 'react-router-dom'
import type { DesktopInstalledSkill } from '../../../../shared/Types.js'
import type { ProviderManagementTab, ProviderManagementSection } from '../dock/RightDockState.js'

export type ProviderManagementPanelController = {
  tab: ProviderManagementTab | null
  host: HTMLElement | null
  open: (providerId: string, section: ProviderManagementSection) => Promise<boolean>
  close: () => void
  /** 注册离开拦截回调；返回注销函数，卸载时调用。 */
  registerBeforeChange: (fn: () => Promise<boolean>) => () => void
  /** 执行当前已注册的离开拦截回调；未注册时视为允许。 */
  confirmBeforeChange: () => Promise<boolean>
  claimProvider: (providerId: string | null) => void
}

export type DesktopLayoutOutletContextValue = {
  workspacePath: string | null
  useSkill: (skill: DesktopInstalledSkill) => void
  openSkillPreview: (skill: DesktopInstalledSkill) => void
  openJudgePanel?: () => void
  providerManagement?: ProviderManagementPanelController
}

export function useDesktopLayoutOutletContext(): DesktopLayoutOutletContextValue {
  return useOutletContext<DesktopLayoutOutletContextValue>()
}
