import { describe, expect, test } from 'bun:test'
import type { PluginDetails } from '@pidex/agent-protocol'
import { createDesktopClient } from '../src/services/desktop-client/index.js'
import type { PluginCatalogItem } from '../src/features/plugins/PluginCatalog.js'
import {
  PLUGIN_INSTALL_PERMISSION_NOTICE,
  pluginInstallDisclosure,
  pluginInstallRevision,
  pluginInstallSourceLabel,
  pluginInstallSummaryLines,
} from '../src/features/plugins/PluginInstallDisclosure.js'

describe('desktop plugin client', () => {
  test('uses typed plugin RPC methods and supplies mutation operation ids', async () => {
    const requests: Array<{ method: string; params: unknown }> = []
    let legacyCatalog = false
    let catalogError: string | undefined
    const plugin = {
      id: 'task-planning',
      name: '任务规划',
      version: '1.0.0',
      description: '拆解工作',
      developerName: 'Pidex',
      category: 'Productivity',
      source: 'bundled',
      inMarketplace: true,
      installationPolicy: 'INSTALLED_BY_DEFAULT',
      installed: true,
      enabled: true,
      status: 'ready',
      capabilities: ['task-planning'],
      skills: ['task-planning'],
    }
    const details = {
      pluginId: 'task-planning',
      longDescription: '拆解复杂工作。',
      displayCapabilities: ['Planning'],
      defaultPrompts: ['帮我规划任务。'],
      skills: [{ id: 'task-planning', name: 'task-planning', description: '规划任务。' }],
    }
    const fetcher = async (_path: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body))
      requests.push({ method: body.method, params: body.params })
      if (body.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocol: 'thread-rpc-v4',
            serverInfo: { name: 'test', version: '1' },
            capabilities: [
              'rpc.typed.v1',
              'plugins.manage.v1',
              'plugins.details.v1',
              'plugins.lifecycle.v1',
              'plugins.assets.v1',
              'apps.manage.v1',
            ],
            limits: {
              maxFrameBytes: 1024,
              maxSubscriptions: 4,
              maxStreamsPerSubscription: 4,
              maxPendingRequests: 8,
            },
            connectionId: 'plugins-test',
          },
        })
      }
      if (body.method === 'initialized') return new Response(null, { status: 204 })
      if (body.method === 'plugin/list')
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            plugins: [legacyCatalog ? { ...plugin, inMarketplace: undefined } : plugin],
            generation: 1,
            updatedAt: 1,
            ...(legacyCatalog
              ? {}
              : {
                  sections: [{ id: 'included', title: '自带插件', pluginIds: ['task-planning'] }],
                }),
            ...(catalogError ? { catalogError } : {}),
          },
        })
      if (body.method === 'plugin/readAsset')
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { mimeType: 'image/png', base64: 'cG5n' },
        })
      if (body.method === 'plugin/getDetails')
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { details } })
      if (body.method === 'plugin/install' || body.method === 'plugin/uninstall')
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { pluginId: body.params.pluginId, generation: 3, updatedAt: 3 },
        })
      if (body.method === 'plugin/setEnabled')
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { plugin: { ...plugin, enabled: false }, generation: 2, updatedAt: 2 },
        })
      if (body.method === 'app/list')
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            apps: [
              {
                id: 'browser',
                name: 'Browser',
                description: 'Browser control',
                developerName: 'Pidex',
                source: 'builtin',
                enabled: true,
                canUninstall: false,
                tools: [],
              },
            ],
            generation: 1,
            updatedAt: 1,
          },
        })
      if (body.method === 'app/setEnabled')
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            app: {
              id: 'browser',
              name: 'Browser',
              description: 'Browser control',
              developerName: 'Pidex',
              source: 'builtin',
              enabled: body.params.enabled,
              canUninstall: false,
              tools: [],
            },
            generation: 2,
            updatedAt: 2,
          },
        })
      throw new Error(`Unhandled RPC method: ${body.method}`)
    }
    const client = createDesktopClient({ fetch: fetcher })

    expect(await client.readPluginAsset('pidex-demo', 'logo', 'F:\\workspace')).toEqual({
      mimeType: 'image/png',
      base64: 'cG5n',
    })
    expect(requests.find((item) => item.method === 'plugin/readAsset')?.params).toEqual({
      pluginId: 'pidex-demo',
      kind: 'logo',
      workspace: 'F:\\workspace',
    })
    await client.installPlugin('pidex-demo', 'b'.repeat(40))
    await client.uninstallPlugin('pidex-demo')
    const listed = await client.listPlugins('F:\\workspace', true)
    const loadedDetails = await client.getPluginDetails('task-planning', 'F:\\workspace')
    const disabled = await client.setPluginEnabled('task-planning', false)
    const listedApps = await client.listApps('F:\\workspace')
    const disabledApp = await client.setAppEnabled('browser', false)

    expect(listedApps.apps[0]?.id).toBe('browser')
    expect(disabledApp.enabled).toBe(false)
    expect(requests.find((item) => item.method === 'app/list')?.params).toEqual({
      workspace: 'F:\\workspace',
    })
    expect(requests.find((item) => item.method === 'app/setEnabled')?.params).toEqual({
      appId: 'browser',
      enabled: false,
      operationId: expect.any(String),
    })

    expect(requests.find((item) => item.method === 'plugin/install')?.params).toEqual({
      pluginId: 'pidex-demo',
      operationId: expect.any(String),
      expectedCatalogRevision: 'b'.repeat(40),
    })
    expect(requests.find((item) => item.method === 'plugin/uninstall')?.params).toEqual({
      pluginId: 'pidex-demo',
      operationId: expect.any(String),
    })
    expect(listed.plugins[0]?.id).toBe('task-planning')
    expect(listed.plugins[0]?.inMarketplace).toBe(true)
    expect(listed.sections?.[0]?.pluginIds).toEqual(['task-planning'])
    expect(listed.catalogError).toBeUndefined()
    expect(disabled.enabled).toBe(false)
    expect(loadedDetails).toEqual(details)
    expect(requests.find((item) => item.method === 'initialize')?.params).toMatchObject({
      capabilities: expect.arrayContaining(['plugins.manage.v1', 'plugins.details.v1']),
    })
    expect(requests.find((item) => item.method === 'plugin/list')?.params).toEqual({
      workspace: 'F:\\workspace',
      forceReload: true,
    })
    expect(requests.find((item) => item.method === 'plugin/getDetails')?.params).toEqual({
      pluginId: 'task-planning',
      workspace: 'F:\\workspace',
    })
    expect(requests.find((item) => item.method === 'plugin/setEnabled')?.params).toEqual({
      pluginId: 'task-planning',
      enabled: false,
      operationId: expect.any(String),
    })
    legacyCatalog = true
    const legacy = await client.listPlugins()
    expect(legacy.plugins[0]?.id).toBe('task-planning')
    expect(legacy.catalogError).toContain('重启开发 Agent')
    catalogError = '插件目录获取失败，请检查网络后刷新重试。'
    expect((await client.listPlugins()).catalogError).toBe(catalogError)
  })

  test('reports a missing versioned capability without duplicating its version', async () => {
    const methods: string[] = []
    const fetcher = async (_path: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body))
      methods.push(body.method)
      if (body.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocol: 'thread-rpc-v4',
            serverInfo: { name: 'test', version: '1' },
            capabilities: ['rpc.typed.v1'],
            limits: {
              maxFrameBytes: 1024,
              maxSubscriptions: 4,
              maxStreamsPerSubscription: 4,
              maxPendingRequests: 8,
            },
            connectionId: 'plugins-unsupported-test',
          },
        })
      }
      if (body.method === 'initialized') return new Response(null, { status: 204 })
      throw new Error(`Unhandled RPC method: ${body.method}`)
    }
    const client = createDesktopClient({ fetch: fetcher })

    expect(await client.readPluginAsset('task-planning', 'logo')).toBeNull()
    expect(methods).not.toContain('plugin/readAsset')
    expect(await client.getPluginDetails('task-planning')).toBeNull()
    expect(methods).not.toContain('plugin/getDetails')
    expect(client.listPlugins()).rejects.toThrow(
      'AGENT_OPERATION_UNSUPPORTED: 真实 Agent 会话暂不支持 plugins.manage.v1。',
    )
  })
})

const demoItem: PluginCatalogItem = {
  id: 'pidex-demo',
  name: 'Pidex Demo',
  description: 'Demo',
  category: 'manageable',
  actionKind: 'install',
  iconName: 'plugin',
  tone: 'creative',
  status: 'not-installed',
  installed: false,
  enabled: false,
  canInstall: true,
  version: '1.0.0',
  skills: ['pidex-demo'],
}

const installedDetails = (installSource?: PluginDetails['installSource']): PluginDetails => ({
  pluginId: 'pidex-demo',
  longDescription: 'Demo',
  displayCapabilities: [],
  defaultPrompts: [],
  skills: [{ id: 'pidex-demo', name: 'pidex-demo', description: '规划任务。' }],
  ...(installSource ? { installSource } : {}),
})

describe('plugin install disclosure', () => {
  test('maps marketplace provenance, activated components and skipped declarations', () => {
    const disclosure = pluginInstallDisclosure(
      demoItem,
      installedDetails({
        repository: 'codepilotx-dev/Pidex-Plugins',
        catalogRevision: 'a'.repeat(40),
        version: '1.2.0',
        components: [
          {
            kind: 'skill',
            id: 'pidex-demo',
            name: 'pidex-demo',
            description: '规划任务。',
            managedBy: 'plugin',
          },
          {
            kind: 'mcp',
            id: 'node_repl',
            name: 'Node REPL',
            description: '宿主执行入口',
            managedBy: 'host',
          },
          {
            kind: 'documentation',
            id: 'readme',
            name: 'README.md',
            description: '',
            managedBy: 'plugin',
          },
        ],
        unsupportedComponents: ['commands', 'on-open'],
      }),
    )
    expect(disclosure).toEqual({
      pluginId: 'pidex-demo',
      repository: 'codepilotx-dev/Pidex-Plugins',
      catalogRevision: 'a'.repeat(40),
      version: '1.2.0',
      skills: [{ id: 'pidex-demo', name: 'pidex-demo', description: '规划任务。' }],
      hostManagedMcp: [{ id: 'node_repl', name: 'Node REPL', description: '宿主执行入口' }],
      manifestPending: true,
      unsupportedComponents: ['commands', 'on-open'],
      complete: true,
    })
    expect(pluginInstallRevision(disclosure)).toBe('a'.repeat(40))
    expect(pluginInstallSourceLabel(disclosure)).toBe('codepilotx-dev/Pidex-Plugins')
    expect(pluginInstallSummaryLines(disclosure)).toEqual([
      '来源：codepilotx-dev/Pidex-Plugins',
      `目录版本：${'a'.repeat(40)}`,
      '版本：1.2.0',
    ])
    expect(PLUGIN_INSTALL_PERMISSION_NOTICE).toContain('不会授予执行权限')
  })

  test('local sources disclose a source name and no revision', () => {
    const disclosure = pluginInstallDisclosure(
      demoItem,
      installedDetails({
        repository: 'personal',
        version: '1.0.0',
        components: [],
        unsupportedComponents: [],
      }),
    )
    expect(pluginInstallSourceLabel(disclosure)).toBe('个人插件')
    expect(pluginInstallRevision(disclosure)).toBeUndefined()
    expect(pluginInstallSummaryLines(disclosure)).toEqual(['来源：个人插件', '版本：1.0.0'])
    // Not installed yet, so the host-managed MCP list is still unknown.
    expect(disclosure.manifestPending).toBe(true)
    expect(
      pluginInstallDisclosure(
        { ...demoItem, installed: true, status: 'disabled' },
        installedDetails({
          repository: 'installed',
          version: '1.0.0',
          components: [],
          unsupportedComponents: [],
        }),
      ).manifestPending,
    ).toBe(false)
  })

  test('missing provenance is flagged incomplete so the dialog can refuse', () => {
    const disclosure = pluginInstallDisclosure(demoItem, installedDetails())
    expect(disclosure.complete).toBe(false)
    expect(disclosure.repository).toBeNull()
    expect(pluginInstallRevision(disclosure)).toBeUndefined()
    expect(pluginInstallDisclosure(demoItem, null).complete).toBe(false)
  })
})
