import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  FishingHook,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react'
import type { DiscoveredHook, HookSourceGroup } from '@pidex/agent-protocol'
import { Button } from '../../../components/ui/Button.js'
import { ToggleSwitch } from '../../../components/ui/ToggleSwitch.js'
import { APP_ICON_SIZE, APP_ICON_STROKE_WIDTH } from '../../../components/ui/IconTokens.js'
import { desktopClient } from '../../../services/desktop-client/index.js'
import { PluginIcon } from '../../plugins/PluginIcon.js'
import { mergePluginCatalog } from '../../plugins/PluginCatalog.js'
import { usePluginCatalog } from '../../plugins/UsePluginCatalog.js'
import { SettingsContentArea } from '../SettingsContentArea.js'
import { SettingsRow } from '../SettingsRow.js'
import {
  groupHooksByEvent,
  hookCountLabel,
  hookErrorMessage,
  isWorkspaceScopeError,
  splitHookGroups,
} from './HookSettingsModel.js'

type Props = {
  workspacePath?: string | null
}

export function HookSettings({ workspacePath }: Props): React.ReactNode {
  const cwd = workspacePath?.trim() || undefined
  const supported = useMemo(() => desktopClient.supportsHookManagement(), [])
  const [groups, setGroups] = useState<readonly HookSourceGroup[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [scopedNotice, setScopedNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [expandedHooks, setExpandedHooks] = useState<Set<string>>(() => new Set())
  const [busyIdentities, setBusyIdentities] = useState<Set<string>>(() => new Set())
  const mounted = useRef(true)
  const { plugins } = usePluginCatalog(workspacePath ?? null)

  const pluginCatalogById = useMemo(() => {
    const items = mergePluginCatalog(plugins, workspacePath)
    return new Map(items.map((item) => [item.id, item]))
  }, [plugins, workspacePath])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadGroups = useCallback(async () => {
    if (!supported) return
    setLoading(true)
    setLoadError('')
    setActionError('')
    try {
      let result
      try {
        result = await desktopClient.listHookGroups(cwd ?? null)
      } catch (error) {
        if (!cwd || !isWorkspaceScopeError(error)) throw error
        result = await desktopClient.listHookGroups(null)
        setScopedNotice('当前工作区不受项目配置管理，只显示用户与全局插件 Hook。')
      }
      if (!mounted.current) return
      setGroups(result.groups)
      if (!cwd) setScopedNotice('')
    } catch (error) {
      if (!mounted.current) return
      setGroups(null)
      setLoadError(hookErrorMessage(error, '无法读取 Hook 配置。'))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [cwd, supported])

  useEffect(() => {
    void loadGroups()
  }, [loadGroups])

  const handleToggleHook = async (hook: DiscoveredHook, enabled: boolean) => {
    if (busyIdentities.has(hook.identity)) return
    setActionError('')
    setBusyIdentities((current) => new Set(current).add(hook.identity))
    setGroups((current) =>
      current?.map((group) => ({
        ...group,
        hooks: group.hooks.map((item) =>
          item.identity === hook.identity ? { ...item, enabled } : item,
        ),
      })) ?? null,
    )
    try {
      await desktopClient.setHookEnabled({ identity: hook.identity, enabled })
    } catch (error) {
      if (!mounted.current) return
      setGroups((current) =>
        current?.map((group) => ({
          ...group,
          hooks: group.hooks.map((item) =>
            item.identity === hook.identity ? { ...item, enabled: !enabled } : item,
          ),
        })) ?? null,
      )
      setActionError(hookErrorMessage(error, '切换 Hook 状态失败。'))
    } finally {
      if (mounted.current) {
        setBusyIdentities((current) => {
          const next = new Set(current)
          next.delete(hook.identity)
          return next
        })
      }
    }
  }

  const toggleExpandHook = (identity: string) => {
    setExpandedHooks((current) => {
      const next = new Set(current)
      if (next.has(identity)) next.delete(identity)
      else next.add(identity)
      return next
    })
  }

  if (!supported) {
    return (
      <SettingsContentArea>
        <div className="settings-content-inner tw:grid tw:gap-5 tw:w-full tw:min-w-0 tw:mx-auto tw:p-5 tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-6)*2)]">
          <header className="tw:grid tw:gap-2">
            <h1 className="tw:m-0 tw:type-6 tw:weight-bold tw:text-app-text">钩子</h1>
            <p className="tw:m-0 tw:type-1 tw:text-app-text-soft">
              当前 Agent 运行时未声明 hooks.management.v1，无法在桌面端管理 Hook。
            </p>
          </header>
          <SettingsRow
            title="Hook 管理不可用"
            description="请升级 Agent 运行时，或检查配置目录下的钩子文件。"
            control={<span className="settings-row-status">不支持的运行时</span>}
          />
        </div>
      </SettingsContentArea>
    )
  }

  const { configGroups, pluginGroups } = splitHookGroups(groups ?? [])
  const selectedGroup = selectedGroupId
    ? ((groups ?? []).find((group) => group.id === selectedGroupId) ?? null)
    : null

  const renderGroupIcon = (group: HookSourceGroup) => {
    if (group.kind === 'plugin' && group.pluginId) {
      const pluginItem = pluginCatalogById.get(group.pluginId)
      if (pluginItem) {
        return (
          <span className="tw:inline-flex tw:size-5 tw:shrink-0 tw:items-center tw:justify-center">
            <PluginIcon
              plugin={{ ...pluginItem, workspacePath: workspacePath ?? null }}
              logoDarkSource={pluginItem.logoDarkSource}
              logoSource={pluginItem.logoSource}
              name={pluginItem.iconName}
            />
          </span>
        )
      }
      return <FishingHook size={APP_ICON_SIZE} strokeWidth={APP_ICON_STROKE_WIDTH} />
    }
    return <Settings size={APP_ICON_SIZE} strokeWidth={APP_ICON_STROKE_WIDTH} />
  }

  return (
    <SettingsContentArea>
      <div className="settings-content-inner tw:grid tw:gap-5 tw:w-full tw:min-w-0 tw:mx-auto tw:p-5 tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-6)*2)]">
        <header className="tw:flex tw:items-start tw:justify-between tw:gap-4">
          <div className="tw:grid tw:gap-1">
            <h1 className="tw:m-0 tw:type-6 tw:weight-bold tw:text-app-text">钩子</h1>
            <p className="tw:m-0 tw:type-1 tw:text-app-text-soft">
              通过配置和已启用的插件管理生命周期钩子。
            </p>
          </div>
          <Button
            isIconOnly
            color="ghostSecondary"
            size="toolbar"
            type="button"
            disabled={loading}
            title="刷新"
            aria-label="刷新"
            onClick={() => void loadGroups()}
          >
            <RefreshCw
              aria-hidden="true"
              size={APP_ICON_SIZE}
              strokeWidth={APP_ICON_STROKE_WIDTH}
              className={loading ? 'tw:animate-spin' : undefined}
            />
          </Button>
        </header>

        {loadError ? (
          <div
            className="tw:rounded-container tw:border tw:border-app-danger-border tw:bg-app-danger-subtle tw:px-4 tw:py-3 tw:type-1 tw:text-app-danger"
            role="alert"
          >
            {loadError}
          </div>
        ) : null}

        {scopedNotice ? (
          <div className="tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:px-4 tw:py-3 tw:type-1 tw:text-app-text-soft">
            {scopedNotice}
          </div>
        ) : null}

        {!groups && !loadError ? (
          <div className="tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:px-4 tw:py-4 tw:type-1 tw:text-app-text-soft">
            正在扫描配置目录与已启用插件中的钩子…
          </div>
        ) : null}

        {groups && groups.length === 0 && !loadError ? (
          <div className="tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:px-4 tw:py-5 tw:text-center tw:type-1 tw:text-app-text-soft">
            暂未在配置目录（.pidex / .claude / .codex / .agents）或已启用插件中发现钩子。
          </div>
        ) : null}

        {configGroups.length > 0 ? (
          <section className="tw:grid tw:gap-2" aria-label="来自配置">
            <h2 className="tw:m-0 tw:type-1 tw:text-app-text-soft">来自配置</h2>
            <div className="tw:grid tw:gap-2">
              {configGroups.map((group) => (
                <HookGroupCard
                  key={group.id}
                  group={group}
                  icon={renderGroupIcon(group)}
                  onOpen={() => {
                    setActionError('')
                    setSelectedGroupId(group.id)
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}

        {pluginGroups.length > 0 ? (
          <section className="tw:grid tw:gap-2" aria-label="来自插件">
            <h2 className="tw:m-0 tw:type-1 tw:text-app-text-soft">来自插件</h2>
            <div className="tw:grid tw:gap-2">
              {pluginGroups.map((group) => (
                <HookGroupCard
                  key={group.id}
                  group={group}
                  icon={renderGroupIcon(group)}
                  onOpen={() => {
                    setActionError('')
                    setSelectedGroupId(group.id)
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}

        <HookGroupDialog
          group={selectedGroup}
          icon={selectedGroup ? renderGroupIcon(selectedGroup) : null}
          actionError={actionError}
          expandedHooks={expandedHooks}
          busyIdentities={busyIdentities}
          onClose={() => setSelectedGroupId(null)}
          onToggleExpand={toggleExpandHook}
          onToggleEnabled={(hook, enabled) => void handleToggleHook(hook, enabled)}
        />
      </div>
    </SettingsContentArea>
  )
}

function HookGroupCard({
  group,
  icon,
  onOpen,
}: {
  group: HookSourceGroup
  icon: React.ReactNode
  onOpen: () => void
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="tw:flex tw:w-full tw:items-center tw:justify-between tw:gap-3 tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel tw:px-4 tw:py-3 tw:text-left tw:transition-colors tw:hover:bg-app-surface-hover tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-app-focus"
    >
      <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-3">
        <span className="tw:flex tw:size-6 tw:shrink-0 tw:items-center tw:justify-center tw:rounded-lg tw:text-app-text-soft">
          {icon}
        </span>
        <div className="tw:grid tw:min-w-0 tw:gap-1">
          <span className="tw:truncate tw:type-2 tw:weight-medium tw:text-app-text">
            {group.displayName}
          </span>
          <span className="tw:type-1 tw:text-app-text-soft">
            {hookCountLabel(group.hooks.length)}
          </span>
        </div>
      </div>
      <ChevronRight
        aria-hidden="true"
        size={APP_ICON_SIZE}
        strokeWidth={APP_ICON_STROKE_WIDTH}
        className="tw:shrink-0 tw:text-app-text-soft"
      />
    </button>
  )
}

const formatHookTimeout = (timeoutMs: number): string =>
  timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}秒` : `${timeoutMs}ms`

function HookGroupDialog({
  group,
  icon,
  actionError,
  expandedHooks,
  busyIdentities,
  onClose,
  onToggleExpand,
  onToggleEnabled,
}: {
  group: HookSourceGroup | null
  icon: React.ReactNode
  actionError: string
  expandedHooks: ReadonlySet<string>
  busyIdentities: ReadonlySet<string>
  onClose: () => void
  onToggleExpand: (identity: string) => void
  onToggleEnabled: (hook: DiscoveredHook, enabled: boolean) => void
}): React.ReactNode {
  const sections = useMemo(() => (group ? groupHooksByEvent(group.hooks) : []), [group])

  return (
    <Dialog.Root open={group !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-dialog-backdrop permission-modal-backdrop" />
        <Dialog.Content className="ui-dialog-surface ui-dialog-surface--centered settings-management-dialog tw:flex tw:flex-col tw:overflow-hidden tw:p-5 tw:rounded-2xl tw:w-[min(640px,calc(100vw-32px))] tw:max-h-[85vh] tw:border tw:border-app-border-subtle tw:bg-app-panel tw:text-app-text tw:shadow-2xl">
          {group ? (
            <>
              <div className="tw:flex tw:items-start tw:justify-between tw:gap-3 tw:shrink-0">
                <div className="tw:grid tw:gap-1 tw:min-w-0">
                  <div className="tw:flex tw:items-center tw:gap-2 tw:min-w-0">
                    <span className="tw:inline-flex tw:shrink-0 tw:items-center tw:justify-center tw:text-app-text">
                      {icon}
                    </span>
                    <Dialog.Title className="tw:m-0 tw:truncate tw:type-2 tw:weight-medium tw:text-app-text">
                      {group.displayName}
                    </Dialog.Title>
                  </div>
                  <Dialog.Description className="tw:m-0 tw:type-1 tw:text-app-text-soft">
                    {group.scopeLabel}
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <Button
                    isIconOnly
                    color="ghostSecondary"
                    size="toolbar"
                    title="关闭"
                    aria-label="关闭"
                  >
                    <X
                      aria-hidden="true"
                      size={APP_ICON_SIZE}
                      strokeWidth={APP_ICON_STROKE_WIDTH}
                    />
                  </Button>
                </Dialog.Close>
              </div>

              {actionError ? (
                <div
                  className="tw:mt-3 tw:rounded-lg tw:border tw:border-app-danger-border tw:bg-app-danger-subtle tw:px-3 tw:py-2 tw:type-1 tw:text-app-danger"
                  role="alert"
                >
                  {actionError}
                </div>
              ) : null}

              {group.diagnostics.length > 0 ? (
                <div className="tw:mt-3 tw:grid tw:gap-1">
                  {group.diagnostics.map((diagnostic) => (
                    <div
                      key={`${diagnostic.code}:${diagnostic.message}`}
                      className="tw:flex tw:items-start tw:gap-2 tw:rounded-lg tw:border tw:border-app-border-subtle tw:bg-app-canvas/60 tw:px-3 tw:py-2 tw:type-1 tw:text-app-text-soft"
                    >
                      <AlertTriangle
                        aria-hidden="true"
                        size={14}
                        className="tw:mt-1 tw:shrink-0 tw:text-app-warning"
                      />
                      <span>{diagnostic.message}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="tw:mt-4 tw:min-h-0 tw:min-w-0 tw:flex-1 tw:overflow-y-auto tw:overflow-x-hidden tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-canvas/60 tw:divide-y tw:divide-app-border-subtle">
                {sections.length === 0 ? (
                  <div className="tw:px-4 tw:py-5 tw:text-center tw:type-1 tw:text-app-text-soft">
                    该来源暂无有效钩子。
                  </div>
                ) : (
                  sections.map((section) => (
                    <div key={section.event} className="tw:grid tw:min-w-0">
                      <div className="tw:flex tw:min-w-0 tw:items-start tw:gap-2 tw:px-4 tw:py-3">
                        <FishingHook
                          aria-hidden="true"
                          size={15}
                          strokeWidth={APP_ICON_STROKE_WIDTH}
                          className="tw:mt-1 tw:shrink-0 tw:text-app-text-soft"
                        />
                        <div className="tw:grid tw:min-w-0 tw:gap-1">
                          <span className="tw:type-2 tw:weight-medium tw:text-app-text">
                            {section.title}
                          </span>
                          <span className="tw:type-1 tw:text-app-text-soft">
                            {section.subtitle}
                          </span>
                        </div>
                      </div>
                      <div className="tw:grid tw:min-w-0 tw:gap-2 tw:border-t tw:border-app-border-subtle tw:px-4 tw:py-3 tw:pl-7">
                        {section.items.map(({ hook, displayLabel }) => {
                          const expanded = expandedHooks.has(hook.identity)
                          const busy = busyIdentities.has(hook.identity)
                          return (
                            <div key={hook.identity} className="tw:grid tw:min-w-0 tw:gap-2">
                              <div className="tw:flex tw:min-w-0 tw:items-center tw:justify-between tw:gap-2">
                                <span
                                  className={`tw:min-w-0 tw:truncate tw:type-1 ${
                                    hook.enabled ? 'tw:text-app-text' : 'tw:text-app-text-soft'
                                  }`}
                                  title={displayLabel}
                                >
                                  {displayLabel}
                                </span>
                                <div className="tw:flex tw:shrink-0 tw:items-center tw:gap-1">
                                  <Button
                                    isIconOnly
                                    color="ghostSecondary"
                                    size="toolbar"
                                    type="button"
                                    title={`打开配置文件 (${hook.filePath})`}
                                    aria-label={`打开配置文件 (${hook.filePath})`}
                                    onClick={() =>
                                      void desktopClient.openPathWithDefaultTarget(hook.filePath)
                                    }
                                  >
                                    <ExternalLink
                                      aria-hidden="true"
                                      size={14}
                                      strokeWidth={APP_ICON_STROKE_WIDTH}
                                    />
                                  </Button>
                                  <Button
                                    isIconOnly
                                    color="ghostSecondary"
                                    size="toolbar"
                                    type="button"
                                    title={expanded ? '收起详情' : '展开详情'}
                                    aria-label={expanded ? '收起详情' : '展开详情'}
                                    aria-expanded={expanded}
                                    onClick={() => onToggleExpand(hook.identity)}
                                  >
                                    {expanded ? (
                                      <ChevronUp
                                        aria-hidden="true"
                                        size={14}
                                        strokeWidth={APP_ICON_STROKE_WIDTH}
                                      />
                                    ) : (
                                      <ChevronDown
                                        aria-hidden="true"
                                        size={14}
                                        strokeWidth={APP_ICON_STROKE_WIDTH}
                                      />
                                    )}
                                  </Button>
                                  <ToggleSwitch
                                    ariaLabel={`启用 ${hook.id}`}
                                    checked={hook.enabled}
                                    disabled={busy}
                                    onChange={(checked) => onToggleEnabled(hook, checked)}
                                  />
                                </div>
                              </div>
                              {expanded ? (
                                <dl className="tw:m-0 tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:items-baseline tw:gap-x-5 tw:gap-y-2 tw:rounded-container tw:border tw:border-app-border-subtle tw:bg-app-panel/60 tw:p-3 tw:type-1">
                                  <dt className="tw:text-app-text-soft">Hook 类型</dt>
                                  <dd className="tw:m-0 tw:text-app-text">{section.title}</dd>
                                  <dt className="tw:text-app-text-soft">命令</dt>
                                  <dd className="tw:m-0 tw:min-w-0">
                                    <code className="tw:break-all tw:font-mono tw:text-app-text">
                                      {hook.command}
                                    </code>
                                  </dd>
                                  {hook.matcher ? (
                                    <>
                                      <dt className="tw:text-app-text-soft">匹配器</dt>
                                      <dd className="tw:m-0 tw:min-w-0">
                                        <code className="tw:break-all tw:font-mono tw:text-app-text">
                                          {hook.matcher}
                                        </code>
                                      </dd>
                                    </>
                                  ) : null}
                                  {hook.timeoutMs !== undefined ? (
                                    <>
                                      <dt className="tw:text-app-text-soft">超时</dt>
                                      <dd className="tw:m-0 tw:text-app-text">
                                        {formatHookTimeout(hook.timeoutMs)}
                                      </dd>
                                    </>
                                  ) : null}
                                </dl>
                              ) : null}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
