import type { AppSummary, AppToolDescriptor, PluginUsedApp } from '@pidex/agent-protocol'
import {
  PluginSettingsConflictError,
  PluginSettingsRepository,
} from '../storage/repositories/PluginSettingsRepository'
import { PluginManagementError, type PluginManagementService } from './PluginManagementService'

type BuiltinAppSpec = {
  id: string
  name: string
  description: string
  developerName: string
  iconName: string
  pluginId?: string
  authProvider?: string
  tools: readonly AppToolDescriptor[]
}

const BUILTIN_APPS: readonly BuiltinAppSpec[] = [
  {
    id: 'computer-use',
    name: 'Computer Use',
    description: '发现已运行的 Windows 应用与窗口，读取界面和截图，并执行鼠标与键盘操作。',
    developerName: 'Pidex',
    iconName: 'computer-use',
    pluginId: 'computer-use',
    tools: [
      {
        name: 'ComputerApps',
        description: '发现当前正在运行的 Windows 应用与窗口，返回窗口引用。',
        mode: 'read',
      },
      {
        name: 'ComputerRead',
        description: '读取指定 Windows 窗口的 UI 自动化树与界面截图。',
        mode: 'read',
      },
      {
        name: 'ComputerAction',
        description: '在已授权的 Windows 窗口中执行点击、输入、快捷键、滚动或拖拽操作。',
        mode: 'write',
      },
      {
        name: 'js',
        description: '通过宿主 node_repl 在受控 JavaScript 上下文中执行桌面操控脚本。',
        mode: 'write',
      },
      {
        name: 'js_reset',
        description: '重置当前会话的 node_repl 求值上下文。',
        mode: 'write',
      },
    ],
  },
  {
    id: 'pets',
    name: 'Pets',
    description: '管理桌面伙伴、浏览社区宠物目录并切换当前激活的桌面宠物。',
    developerName: 'Pidex',
    iconName: 'pets',
    tools: [
      {
        name: 'pets_list',
        description: '列出本地已安装的桌面宠物及其资源状态。',
        mode: 'read',
      },
      {
        name: 'pets_catalog',
        description: '浏览社区宠物市场目录与预览信息。',
        mode: 'read',
      },
      {
        name: 'pets_preview',
        description: '从远程链接预览宠物包清单与资源大小。',
        mode: 'read',
      },
      {
        name: 'pets_install',
        description: '从社区目录或链接安装新的桌面宠物到本地库。',
        mode: 'write',
      },
      {
        name: 'pets_remove',
        description: '从本地宠物库中卸载指定的桌面宠物。',
        mode: 'write',
      },
    ],
  },
  {
    id: 'browser',
    name: 'Browser',
    description: '控制 Pidex 内置浏览器标签页，读取网页快照、截图并执行导航与交互操作。',
    developerName: 'Pidex',
    iconName: 'browser',
    tools: [
      {
        name: 'BrowserTabs',
        description: '列出、创建、接管、释放或关闭内置浏览器标签页。',
        mode: 'read',
      },
      {
        name: 'BrowserRead',
        description: '读取内置浏览器当前页面的 DOM/ARIA 结构化快照。',
        mode: 'read',
      },
      {
        name: 'BrowserScreenshot',
        description: '捕获内置浏览器当前标签页的可视区域截图。',
        mode: 'read',
      },
      {
        name: 'BrowserNavigate',
        description: '在已授权站点的标签页中执行跳转、前进、后退、刷新或停止加载。',
        mode: 'write',
      },
      {
        name: 'BrowserAct',
        description: '在内置浏览器页面上执行点击、输入、选择、按键或滚动等交互。',
        mode: 'write',
      },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: '关联 GitHub 账号与 Pull Request，读取 CI 检查摘要并同步、发布或合并 PR。',
    developerName: 'Pidex',
    iconName: 'github',
    authProvider: 'github',
    tools: [
      {
        name: 'pr_watch_read',
        description: '读取所属 Pull Request 的 CI 检查结果、状态摘要与审查要求。',
        mode: 'read',
      },
      {
        name: 'attach_pull_request',
        description: '将已有的 GitHub Pull Request 绑定到当前会话侧边栏。',
        mode: 'write',
      },
      {
        name: 'pr_watch_sync',
        description: '同步当前 PR 修复工作树与远端分支最新提交。',
        mode: 'write',
      },
      {
        name: 'pr_watch_publish',
        description: '发布当前 PR 修复工作树的本地提交到远端分支。',
        mode: 'write',
      },
      {
        name: 'pr_watch_merge',
        description: '在通过检查与权限校验后执行 Pull Request 合并。',
        mode: 'write',
      },
    ],
  },
]

const BUILTIN_APP_MAP = new Map(BUILTIN_APPS.map((app) => [app.id, app]))

export type AppAuthChecker = (provider: string) => Promise<boolean> | boolean

/**
 * Manages first-class Pidex Apps (built-in host capability providers and plugin-declared
 * `.app.json` connectors) along with their read/write tool inventories and independent
 * enable/disable state.
 */
export class AppManagementService {
  private mutation: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(appId: string, generation: number) => void>()

  constructor(
    private readonly settings: PluginSettingsRepository,
    private readonly plugins: PluginManagementService,
    private readonly checkAuth?: AppAuthChecker,
  ) {}

  isEnabled(appId: string): boolean {
    return !this.settings.appState().disabledAppIds.includes(appId)
  }

  subscribe(listener: (appId: string, generation: number) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async list(input: { workspace?: string | undefined } = {}) {
    const state = this.settings.appState()
    const disabled = new Set(state.disabledAppIds)
    const apps: AppSummary[] = []
    const seen = new Set<string>()

    for (const spec of BUILTIN_APPS) {
      seen.add(spec.id)
      const auth = spec.authProvider
        ? {
            required: true,
            connected: Boolean(
              await Promise.resolve(this.checkAuth?.(spec.authProvider)).catch(() => false),
            ),
            provider: spec.authProvider,
          }
        : undefined
      apps.push({
        id: spec.id,
        name: spec.name,
        description: spec.description,
        developerName: spec.developerName,
        source: 'builtin',
        enabled: !disabled.has(spec.id),
        canUninstall: false,
        iconName: spec.iconName,
        ...(spec.pluginId ? { pluginId: spec.pluginId } : {}),
        tools: [...spec.tools],
        ...(auth ? { auth } : {}),
      })
    }

    const declared = await this.plugins.declaredApps(input.workspace)
    for (const entry of declared) {
      if (seen.has(entry.id) || !entry.pluginInstalled) continue
      seen.add(entry.id)
      apps.push({
        id: entry.id,
        name: entry.name ?? entry.id,
        description: entry.description ?? `由插件 ${entry.pluginName} 声明的应用连接器。`,
        developerName: entry.developerName,
        source: 'plugin',
        enabled: !disabled.has(entry.id) && entry.pluginEnabled,
        canUninstall: false,
        pluginId: entry.pluginId,
        tools: [],
      })
    }

    return {
      apps,
      generation: state.generation,
      updatedAt: state.updatedAt,
    }
  }

  setEnabled(input: { appId: string; enabled: boolean; operationId: string }) {
    const run = async () => {
      const current = await this.list()
      const target = current.apps.find((app) => app.id === input.appId)
      if (!target) {
        throw new PluginManagementError('PLUGIN_NOT_FOUND', '应用不存在', 404)
      }
      try {
        const result = this.settings.setAppEnabled(input)
        const updated: AppSummary = {
          ...target,
          enabled: !result.state.disabledAppIds.includes(input.appId),
        }
        if (result.changed) {
          for (const listener of this.listeners) {
            try {
              listener(input.appId, result.state.generation)
            } catch {
              // Subscriber errors must not fail persisted state updates.
            }
          }
        }
        return {
          app: updated,
          generation: result.state.generation,
          updatedAt: result.state.updatedAt,
        }
      } catch (cause) {
        if (cause instanceof PluginSettingsConflictError) {
          throw new PluginManagementError('CONFLICT', cause.message, 409)
        }
        throw cause
      }
    }
    const result = this.mutation.then(run)
    this.mutation = result.catch(() => {})
    return result
  }

  async resolveUsedApp(ref: {
    id: string
    name?: string
    description?: string
    required?: boolean
  }): Promise<PluginUsedApp> {
    const builtin = BUILTIN_APP_MAP.get(ref.id)
    const authConnected = builtin?.authProvider
      ? Boolean(await Promise.resolve(this.checkAuth?.(builtin.authProvider)).catch(() => false))
      : undefined
    return {
      id: ref.id,
      name: ref.name ?? builtin?.name ?? ref.id,
      description: ref.description ?? builtin?.description ?? '',
      ...(ref.required !== undefined ? { required: ref.required } : {}),
      installed: Boolean(builtin),
      enabled: this.isEnabled(ref.id),
      ...(authConnected !== undefined ? { authConnected } : {}),
      ...(builtin?.iconName ? { iconName: builtin.iconName } : {}),
      ...(builtin?.developerName ? { developerName: builtin.developerName } : {}),
      ...(builtin ? { tools: [...builtin.tools] } : {}),
    }
  }
}
