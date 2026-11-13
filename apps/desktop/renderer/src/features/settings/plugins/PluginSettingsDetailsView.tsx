import type React from 'react'
import { useEffect, useState } from 'react'
import { ChevronRight, ExternalLink, ShieldCheck, Server } from 'lucide-react'
import { Button } from '../../../components/ui/Button.js'
import { ConfirmationDialog } from '../../../components/ui/ConfirmationDialog.js'
import { ToggleSwitch } from '../../../components/ui/ToggleSwitch.js'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from '../../../components/ui/IconTokens.js'
import { PluginIcon } from '../../plugins/PluginIcon.js'
import { usePluginDetails } from '../../plugins/UsePluginDetails.js'
import type { PluginCatalogItem } from '../../plugins/PluginCatalog.js'
import { desktopClient } from '../../../services/desktop-client/index.js'
import type { PluginUsedApp } from '@pidex/agent-protocol'
import type { DesktopInstalledSkill, DesktopMcpServerListItem } from '../../../../shared/Types.js'
import { ComputerRuntimeStatus } from '../../plugins/ComputerRuntimeStatus.js'
import { resolveAppIconName } from './AppDetailsDialog.js'
import { isWorkspaceScopeError } from '../hooks/HookSettingsModel.js'
import { errorMessageOr as errorMessageOf } from '@pidex/shared/errors'

export type PluginSettingsSkillItem = {
  id: string
  name: string
  description?: string
}

export type PluginSettingsDetailsViewProps = {
  item: PluginCatalogItem
  workspacePath: string | null
  installedSkills?: readonly DesktopInstalledSkill[]
  busySkillPaths?: ReadonlySet<string>
  matchingMcpServer?: DesktopMcpServerListItem | null
  mcpAttemptBusy?: boolean
  onBack: () => void
  onViewMarketDetails: (item: PluginCatalogItem) => void
  onSelectApp?: (app: PluginUsedApp, trigger?: HTMLElement | null) => void
  onSelectSkill?: (skill: PluginSettingsSkillItem, trigger?: HTMLElement | null) => void
  onToggleSkill?: (skill: PluginSettingsSkillItem, enabled: boolean) => void
  onManageHooks?: () => void
  onUninstall: (item: PluginCatalogItem) => Promise<void>
  onStartOAuth?: (server: DesktopMcpServerListItem) => void
  onLogoutOAuth?: (server: DesktopMcpServerListItem) => void
  onError: (message: string) => void
  onNotice?: (message: string) => void
}

export function resolvePluginDetailSkill(
  plugin: Pick<PluginCatalogItem, 'id' | 'enabled'>,
  skill: PluginSettingsSkillItem,
  installedSkills?: readonly DesktopInstalledSkill[],
): DesktopInstalledSkill | null {
  if (!installedSkills?.length) return null
  const expectedPath = `plugin://${plugin.id}/skills/${skill.id}/SKILL.md`
  return (
    installedSkills.find(
      (candidate) =>
        candidate.path === expectedPath ||
        candidate.name === skill.name ||
        candidate.name === skill.id,
    ) ?? null
  )
}

export function PluginSettingsDetailsView({
  item,
  workspacePath,
  installedSkills,
  busySkillPaths,
  matchingMcpServer,
  mcpAttemptBusy = false,
  onBack,
  onViewMarketDetails,
  onSelectApp,
  onSelectSkill,
  onToggleSkill,
  onManageHooks,
  onUninstall,
  onStartOAuth,
  onLogoutOAuth,
  onError,
  onNotice,
}: PluginSettingsDetailsViewProps): React.ReactNode {
  const { details, error: detailsError } = usePluginDetails(item, workspacePath)
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [uninstallBusy, setUninstallBusy] = useState(false)
  const [hasHooks, setHasHooks] = useState(false)

  useEffect(() => {
    if (!desktopClient.supportsHookManagement()) {
      setHasHooks(false)
      return
    }
    let cancelled = false
    const cwd = workspacePath?.trim() || undefined
    void (async () => {
      try {
        let result
        try {
          result = await desktopClient.listHookGroups(cwd ?? null)
        } catch (error) {
          if (!cwd || !isWorkspaceScopeError(error)) throw error
          result = await desktopClient.listHookGroups(null)
        }
        if (cancelled) return
        setHasHooks(
          result.groups.some(
            (group) => group.kind === 'plugin' && group.pluginId === item.id && group.hooks.length > 0,
          ),
        )
      } catch {
        if (!cancelled) setHasHooks(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [item.id, workspacePath])

  const handleOpenExternal = (url?: string) => {
    if (!url) return
    void desktopClient.openExternalURL(url).catch((err) => {
      onError(errorMessageOf(err, '无法打开外部链接'))
    })
  }

  const handleConfirmUninstall = async () => {
    try {
      setUninstallBusy(true)
      await onUninstall(item)
      setConfirmUninstall(false)
      onNotice?.(`已成功卸载插件 “${item.name}”。`)
      onBack()
    } catch (err) {
      onError(errorMessageOf(err, '卸载插件失败'))
    } finally {
      setUninstallBusy(false)
    }
  }

  // Account / OAuth status
  const hasMcpAuth = Boolean(matchingMcpServer?.runtime?.auth && matchingMcpServer.runtime.auth.source !== 'none')
  const requiresLogin =
    hasMcpAuth ||
    item.capabilities.includes('auth') ||
    item.capabilities.includes('oauth') ||
    item.id === 'google-calendar' ||
    item.id === 'github' ||
    item.id === 'gmail'

  const authState = matchingMcpServer?.runtime?.auth
  const isConnected = authState?.source === 'oauth' && authState.canLogout

  // Skills and components
  const usedApps = details?.apps ?? []
  const skills = details?.skills ?? (item.skills ?? []).map((id) => ({ id, name: id, description: '' }))
  const nonSkillComponents = (details?.components ?? []).filter((comp) => comp.kind !== 'skill')

  // About metadata fields
  const categoryText = item.category === 'manageable' ? '效率' : item.category === 'included' ? '系统' : '扩展'
  const developerText = item.developerName || '官方'
  const versionText = item.version?.trim() || ''
  const websiteUrl = details?.websiteURL?.trim() || ''
  const privacyUrl = details?.privacyPolicyURL?.trim() || ''
  const termsUrl = details?.termsOfServiceURL?.trim() || ''
  const mcpUrl = matchingMcpServer?.summary?.trim() || details?.websiteURL?.trim() || ''
  const displayUrl = mcpUrl || (websiteUrl.startsWith('http') ? websiteUrl : '')
  const authTypeText = hasMcpAuth || requiresLogin ? 'OAuth' : ''

  return (
    <div className="plugin-settings-details-view tw:w-full tw:min-w-0 tw:pb-8">
      {/* 顶部面包屑导航 */}
      <nav aria-label="路径导航" className="tw:flex tw:items-center tw:gap-1 tw:type-1 tw:text-app-text-soft tw:mb-5">
        <button
          type="button"
          onClick={onBack}
          className="tw:border-0 tw:bg-transparent tw:p-0 tw:type-1 tw:text-app-text-soft tw:hover:text-app-text tw:transition-colors tw:cursor-pointer"
        >
          插件设置
        </button>
        <ChevronRight size={14} className="tw:text-app-text-meta tw:shrink-0" aria-hidden="true" />
        <span className="tw:text-app-text tw:type-2 tw:weight-medium">{item.name}</span>
      </nav>

      {/* 头部展示：图标、标题、简述、查看详情与卸载 */}
      <header className="tw:flex tw:flex-wrap tw:items-start tw:justify-between tw:gap-4 tw:mb-6">
        <div className="tw:flex tw:items-center tw:gap-4 tw:min-w-0">
          <span className="tw:size-9 tw:rounded-container tw:overflow-hidden tw:flex tw:items-center tw:justify-center tw:bg-app-panel tw:border tw:border-app-border-subtle tw:shrink-0">
            <PluginIcon
              plugin={{ ...item, workspacePath }}
              logoSource={item.logoSource}
              logoDarkSource={item.logoDarkSource}
              name={item.iconName}
            />
          </span>
          <div className="tw:min-w-0">
            <h1 className="tw:m-0 tw:type-6 tw:weight-bold tw:text-app-text tw:truncate">{item.name}</h1>
            <p className="tw:m-0 tw:mt-1 tw:type-1 tw:text-app-text-soft tw:line-clamp-2">
              {item.description}
            </p>
            {item.id === 'computer-use' ? <ComputerRuntimeStatus /> : null}
          </div>
        </div>

        <div className="tw:flex tw:items-center tw:gap-2 tw:shrink-0">
          <Button
            color="secondary"
            onClick={() => onViewMarketDetails(item)}
            title="前往插件市场查看完整介绍"
          >
            查看详情
          </Button>
          {item.canUninstall !== false ? (
            <Button
              color="danger"
              disabled={uninstallBusy}
              onClick={() => setConfirmUninstall(true)}
            >
              卸载
            </Button>
          ) : null}
        </div>
      </header>

      {detailsError ? (
        <div className="tw:type-1 tw:mb-5 tw:flex tw:items-center tw:justify-between tw:gap-3 tw:border tw:border-app-danger-border tw:bg-app-danger-subtle tw:px-4 tw:py-3 tw:text-app-danger tw:rounded-container">
          <span>{detailsError}</span>
        </div>
      ) : null}

      {/* 账号关联 / 连接状态卡片 */}
      {requiresLogin ? (
        <section className="tw:mb-6" aria-label="账号与连接状态">
          <div className="tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:px-3 tw:py-2 tw:flex tw:items-center tw:justify-between tw:gap-4">
            <div className="tw:flex tw:items-center tw:gap-3 tw:min-w-0">
              <ShieldCheck size={APP_ICON_SIZE} strokeWidth={APP_ICON_STROKE_WIDTH} className="tw:text-app-accent tw:shrink-0" />
              <div className="tw:min-w-0">
                <span className="tw:type-2 tw:weight-medium tw:text-app-text tw:block tw:truncate">
                  {item.name}
                </span>
                <span className="tw:type-1 tw:text-app-text-soft tw:block tw:mt-1">
                  {isConnected ? '已授权连接，服务运行正常' : '需要关联授权以启用完整功能'}
                </span>
              </div>
            </div>

            <div>
              {mcpAttemptBusy ? (
                <Button color="primary" disabled loading title="等待授权中">
                  等待授权
                </Button>
              ) : isConnected && matchingMcpServer && onLogoutOAuth ? (
                <Button
                  color="danger"
                  onClick={() => onLogoutOAuth(matchingMcpServer)}
                >
                  退出登录
                </Button>
              ) : matchingMcpServer && onStartOAuth ? (
                <Button
                  color="secondary"
                  onClick={() => onStartOAuth(matchingMcpServer)}
                >
                  关联
                </Button>
              ) : (
                <Button
                  color="secondary"
                  onClick={() => {
                    if (websiteUrl) handleOpenExternal(websiteUrl)
                    else onNotice?.('该插件已通过宿主授权就绪。')
                  }}
                >
                  关联
                </Button>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {/* 使用的应用区 */}
      {usedApps.length > 0 ? (
        <section className="tw:mb-6" aria-label="使用的应用">
          <h2 className="tw:m-0 tw:mb-2 tw:type-2 tw:weight-medium tw:text-app-text">使用的应用</h2>
          <div className="tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:divide-y tw:divide-app-border-subtle tw:overflow-hidden">
            {usedApps.map((usedApp) => {
              const statusText = !usedApp.installed
                ? '尚未安装或配置'
                : !usedApp.enabled
                  ? '已禁用'
                  : usedApp.authConnected === false
                    ? '需要授权'
                    : null
              const content = (
                <>
                  <span
                    aria-hidden="true"
                    className="tw:flex tw:size-6 tw:shrink-0 tw:items-center tw:justify-center tw:rounded-full tw:border tw:border-app-border-subtle tw:bg-app-canvas/80 tw:text-app-text-soft tw:overflow-hidden"
                  >
                    <PluginIcon name={resolveAppIconName({ id: usedApp.id })} />
                  </span>
                  <div className="tw:flex-1 tw:min-w-0">
                    <div className="tw:type-2 tw:weight-medium tw:text-app-text tw:truncate">
                      {usedApp.name}
                    </div>
                    {usedApp.description ? (
                      <div className="tw:type-1 tw:text-app-text-soft tw:mt-1 tw:truncate">
                        {usedApp.description}
                      </div>
                    ) : null}
                  </div>
                  <div className="tw:flex tw:items-center tw:gap-2 tw:shrink-0">
                    {statusText ? (
                      <span className="tw:type-1 tw:text-app-text-meta">{statusText}</span>
                    ) : null}
                    <ChevronRight
                      size={16}
                      className="tw:text-app-text-meta tw:shrink-0"
                      aria-hidden="true"
                    />
                  </div>
                </>
              )
              return onSelectApp ? (
                <button
                  key={usedApp.id}
                  type="button"
                  onClick={(event) => onSelectApp(usedApp, event.currentTarget)}
                  className="tw:w-full tw:border-0 tw:bg-transparent tw:px-3 tw:py-2 tw:flex tw:items-center tw:gap-3 tw:text-left tw:hover:bg-app-panel-hover tw:transition-colors tw:cursor-pointer tw:focus-visible:outline-2 tw:focus-visible:outline-offset-[-2px] tw:focus-visible:outline-app-focus"
                >
                  {content}
                </button>
              ) : (
                <div key={usedApp.id} className="tw:px-3 tw:py-2 tw:flex tw:items-center tw:gap-3">
                  {content}
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      {/* 技能列表区 */}
      {skills.length > 0 ? (
        <section className="tw:mb-6" aria-label="技能">
          <h2 className="tw:m-0 tw:mb-2 tw:type-2 tw:weight-medium tw:text-app-text">技能</h2>
          <div className="tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:divide-y tw:divide-app-border-subtle tw:overflow-hidden">
            {skills.map((skill) => {
              const matchedSkill = resolvePluginDetailSkill(item, skill, installedSkills)
              const skillEnabled = matchedSkill ? matchedSkill.enabled : item.enabled
              const skillBusy = matchedSkill ? Boolean(busySkillPaths?.has(matchedSkill.path)) : false

              return (
                <div
                  key={skill.id}
                  className={`tw:px-3 tw:py-2 tw:flex tw:items-center tw:justify-between tw:gap-4${
                    onSelectSkill ? ' tw:hover:bg-app-panel-hover tw:transition-colors' : ''
                  }`}
                >
                  {onSelectSkill ? (
                    <button
                      type="button"
                      onClick={(event) => onSelectSkill(skill, event.currentTarget)}
                      className="tw:flex-1 tw:min-w-0 tw:border-0 tw:bg-transparent tw:p-0 tw:text-left tw:cursor-pointer tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-app-focus tw:rounded-xs"
                    >
                      <div className="tw:type-2 tw:weight-medium tw:text-app-text">{skill.name}</div>
                      {skill.description ? (
                        <div className="tw:type-1 tw:text-app-text-soft tw:mt-1">{skill.description}</div>
                      ) : null}
                    </button>
                  ) : (
                    <div className="tw:flex-1 tw:min-w-0">
                      <div className="tw:type-2 tw:weight-medium tw:text-app-text">{skill.name}</div>
                      {skill.description ? (
                        <div className="tw:type-1 tw:text-app-text-soft tw:mt-1">{skill.description}</div>
                      ) : null}
                    </div>
                  )}

                  <div className="tw:flex tw:items-center tw:gap-3 tw:shrink-0">
                    {onToggleSkill ? (
                      <ToggleSwitch
                        ariaLabel={`启用 ${skill.name}`}
                        checked={skillEnabled}
                        disabled={skillBusy || !item.installed}
                        onChange={(checked) => onToggleSkill(skill, checked)}
                      />
                    ) : null}
                    {onSelectSkill ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        onClick={(event) => onSelectSkill(skill, event.currentTarget)}
                        className="tw:border-0 tw:bg-transparent tw:p-0 tw:inline-flex tw:items-center tw:justify-center tw:text-app-text-meta tw:hover:text-app-text tw:cursor-pointer"
                      >
                        <ChevronRight size={16} />
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      {/* 钩子区域 */}
      {hasHooks ? (
        <section className="tw:mb-6" aria-label="钩子">
          <h2 className="tw:m-0 tw:mb-2 tw:type-2 tw:weight-medium tw:text-app-text">钩子</h2>
          <div className="tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:overflow-hidden">
            {onManageHooks ? (
              <button
                type="button"
                onClick={onManageHooks}
                className="tw:w-full tw:border-0 tw:bg-transparent tw:px-3 tw:py-2 tw:flex tw:items-center tw:justify-between tw:gap-3 tw:text-left tw:hover:bg-app-panel-hover tw:transition-colors tw:cursor-pointer tw:focus-visible:outline-2 tw:focus-visible:outline-offset-[-2px] tw:focus-visible:outline-app-focus"
              >
                <span className="tw:type-2 tw:weight-medium tw:text-app-text">在设置中管理</span>
                <ChevronRight size={16} className="tw:text-app-text-meta tw:shrink-0" aria-hidden="true" />
              </button>
            ) : (
              <div className="tw:px-3 tw:py-2 tw:flex tw:items-center tw:justify-between tw:gap-3">
                <span className="tw:type-2 tw:weight-medium tw:text-app-text">在设置中管理</span>
                <ChevronRight size={16} className="tw:text-app-text-meta tw:shrink-0" aria-hidden="true" />
              </div>
            )}
          </div>
        </section>
      ) : null}

      {/* 其他组件区 */}
      {nonSkillComponents.length > 0 ? (
        <section className="tw:mb-6" aria-label="组件">
          <h2 className="tw:m-0 tw:mb-2 tw:type-2 tw:weight-medium tw:text-app-text">组件</h2>
          <div className="tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:divide-y tw:divide-app-border-subtle tw:overflow-hidden">
            {nonSkillComponents.map((comp) => (
              <div key={comp.id} className="tw:px-3 tw:py-2 tw:flex tw:items-start tw:gap-3">
                <Server size={16} className="tw:text-app-accent tw:mt-1 tw:shrink-0" aria-hidden="true" />
                <div className="tw:min-w-0">
                  <div className="tw:type-2 tw:weight-medium tw:text-app-text">{comp.name}</div>
                  {comp.description ? (
                    <div className="tw:type-1 tw:text-app-text-soft tw:mt-1">{comp.description}</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* 关于元数据区域 */}
      <section aria-label="关于信息">
        <h2 className="tw:m-0 tw:mb-2 tw:type-2 tw:weight-medium tw:text-app-text">关于</h2>
        <div className="tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:divide-y tw:divide-app-border-subtle tw:overflow-hidden">
          {/* 类别 */}
          <div className="tw:grid tw:grid-cols-[140px_1fr] tw:items-center tw:px-3 tw:py-2 tw:gap-4">
            <span className="tw:type-1 tw:text-app-text-soft">类别</span>
            <span className="tw:type-1 tw:text-app-text">{categoryText}</span>
          </div>

          {/* 开发者 */}
          <div className="tw:grid tw:grid-cols-[140px_1fr] tw:items-center tw:px-3 tw:py-2 tw:gap-4">
            <span className="tw:type-1 tw:text-app-text-soft">开发者</span>
            <span className="tw:type-1 tw:text-app-text">{developerText}</span>
          </div>

          {/* 版本 */}
          {versionText ? (
            <div className="tw:grid tw:grid-cols-[140px_1fr] tw:items-center tw:px-3 tw:py-2 tw:gap-4">
              <span className="tw:type-1 tw:text-app-text-soft">版本</span>
              <span className="tw:type-1 tw:text-app-text">{versionText}</span>
            </div>
          ) : null}

          {/* 网站 */}
          {websiteUrl ? (
            <div className="tw:grid tw:grid-cols-[140px_1fr] tw:items-center tw:px-3 tw:py-2 tw:gap-4">
              <span className="tw:type-1 tw:text-app-text-soft">网站</span>
              <span className="tw:type-1 tw:text-app-text tw:truncate">
                <button
                  type="button"
                  onClick={() => handleOpenExternal(websiteUrl)}
                  className="tw:border-0 tw:bg-transparent tw:p-0 tw:type-1 tw:text-app-accent tw:hover:underline tw:cursor-pointer tw:inline-flex tw:items-center tw:gap-1 tw:max-w-full tw:truncate"
                >
                  <span className="tw:truncate">{websiteUrl}</span>
                  <ExternalLink size={12} className="tw:shrink-0" aria-hidden="true" />
                </button>
              </span>
            </div>
          ) : null}

          {/* 隐私政策 */}
          {privacyUrl ? (
            <div className="tw:grid tw:grid-cols-[140px_1fr] tw:items-center tw:px-3 tw:py-2 tw:gap-4">
              <span className="tw:type-1 tw:text-app-text-soft">隐私政策</span>
              <span className="tw:type-1 tw:text-app-text">
                <button
                  type="button"
                  onClick={() => handleOpenExternal(privacyUrl)}
                  className="tw:border-0 tw:bg-transparent tw:p-0 tw:type-1 tw:text-app-accent tw:hover:underline tw:cursor-pointer tw:inline-flex tw:items-center tw:gap-1"
                >
                  查看隐私政策
                  <ExternalLink size={12} className="tw:shrink-0" aria-hidden="true" />
                </button>
              </span>
            </div>
          ) : null}

          {/* 服务条款 */}
          {termsUrl ? (
            <div className="tw:grid tw:grid-cols-[140px_1fr] tw:items-center tw:px-3 tw:py-2 tw:gap-4">
              <span className="tw:type-1 tw:text-app-text-soft">服务条款</span>
              <span className="tw:type-1 tw:text-app-text">
                <button
                  type="button"
                  onClick={() => handleOpenExternal(termsUrl)}
                  className="tw:border-0 tw:bg-transparent tw:p-0 tw:type-1 tw:text-app-accent tw:hover:underline tw:cursor-pointer tw:inline-flex tw:items-center tw:gap-1"
                >
                  查看条款
                  <ExternalLink size={12} className="tw:shrink-0" aria-hidden="true" />
                </button>
              </span>
            </div>
          ) : null}

          {/* URL */}
          {displayUrl ? (
            <div className="tw:grid tw:grid-cols-[140px_1fr] tw:items-center tw:px-3 tw:py-2 tw:gap-4">
              <span className="tw:type-1 tw:text-app-text-soft">URL</span>
              <span className="tw:type-1 tw:text-app-text tw:truncate">{displayUrl}</span>
            </div>
          ) : null}

          {/* 支持的授权方式 */}
          {authTypeText ? (
            <div className="tw:grid tw:grid-cols-[140px_1fr] tw:items-center tw:px-3 tw:py-2 tw:gap-4">
              <span className="tw:type-1 tw:text-app-text-soft">支持的授权方式</span>
              <span className="tw:type-1 tw:text-app-text">{authTypeText}</span>
            </div>
          ) : null}
        </div>
      </section>

      {/* 卸载确认弹窗框 */}
      <ConfirmationDialog
        open={confirmUninstall}
        title="卸载插件？"
        description={`将从当前配置中卸载“${item.name}”。此操作无法撤销。`}
        actionLabel="卸载"
        tone="danger"
        actionDisabled={uninstallBusy}
        onCancel={() => setConfirmUninstall(false)}
        onAction={handleConfirmUninstall}
      />
    </div>
  )
}
