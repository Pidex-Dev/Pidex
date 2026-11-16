import { describe, expect, test } from 'bun:test'
import {
  decodeApprovalPolicy,
  decodeApprovalsReviewer,
  decodePermissionConfig,
  encodeApprovalPolicy,
} from '@pidex/shared/thread'
import type { ToolInvocation } from '../src/Domain'
import { executionPolicyFromV4 } from '../src/permission/ExecutionPolicy'
import { PermissionDecisionEngine } from '../src/permission/PermissionDecisionEngine'
import { secretScrubber } from '../src/security/SecretScrubber'
import { ToolRegistry } from '../src/tool/ToolRegistry'

const invocation = (overrides: Partial<ToolInvocation> = {}): ToolInvocation => ({
  id: 'tool',
  threadID: 'thread',
  turnID: 'turn',
  agentID: 'agent',
  name: 'exec_command',
  input: { command: 'Get-ChildItem' },
  permissionFacts: { risk: 'low' },
  permissionConfig: {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'auto_review',
    approvalsReviewer: 'auto_review',
  },
  taskMode: 'chat',
  model: {} as ToolInvocation['model'],
  ...overrides,
})

describe('统一权限真值', () => {
  test('普通读取权限申请无需审批，敏感读取仍按宿主风险审批', () => {
    const engine = new PermissionDecisionEngine()
    const tool = new ToolRegistry().get('request_permissions')
    const read = invocation({
      name: 'request_permissions',
      input: { scope: 'tool-call', readPaths: ['C:/test/ordinary.txt'], justification: 'read' },
    })
    expect(engine.evaluate(read, tool).action).toBe('allow')
    expect(
      engine.evaluate(
        { ...read, permissionFacts: { risk: 'high', ruleRequiresApproval: true } },
        tool,
      ).action,
    ).toBe('review')
  })

  test('旧版 approvalPolicy 与 approvalsReviewer 兼容解码为 auto_review 与 never', () => {
    expect(encodeApprovalPolicy('auto_review')).toBe('on-request')
    expect(encodeApprovalPolicy('never')).toBe('never')
    for (const legacy of ['on-request', 'untrusted', 'on-failure', 'auto_review']) {
      expect(decodeApprovalPolicy(legacy)).toBe('auto_review')
    }
    expect(decodeApprovalPolicy('never')).toBe('never')
    expect(
      decodeApprovalPolicy(
        JSON.stringify({
          type: 'granular',
          sandboxApproval: true,
          rules: false,
          skillApproval: false,
          requestPermissions: true,
          mcpTools: false,
          mcpElicitations: false,
        }),
      ),
    ).toBe('auto_review')
    expect(decodeApprovalsReviewer('user')).toBe('auto_review')
    expect(decodeApprovalsReviewer('auto_review')).toBe('auto_review')
    expect(
      decodePermissionConfig({
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      }),
    ).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'auto_review',
      approvalsReviewer: 'auto_review',
    })
  })

  test('旧 sandboxMode 只映射文件访问范围且 Shell 环境固定为宿主机', () => {
    const catalog = new ToolRegistry()
    const cases = [
      ['read-only', 'read-only'],
      ['workspace-write', 'workspace-write'],
      ['danger-full-access', 'full-access'],
    ] as const

    for (const [sandboxMode, fileAccess] of cases) {
      expect(
        executionPolicyFromV4({
          sandboxMode,
          approvalPolicy: 'auto_review',
          approvalsReviewer: 'auto_review',
        }),
      ).toMatchObject({
        fileAccess,
        shellEnvironment: 'host',
      })
      expect(catalog.list('chat', sandboxMode).map((tool) => tool.sdkName)).toContain('exec_command')
    }
  })

  test('approval policy 决策矩阵', () => {
    const engine = new PermissionDecisionEngine()
    const shell = new ToolRegistry().get('exec_command')
    expect(
      engine.evaluate(
        invocation({
          permissionConfig: {
            sandboxMode: 'workspace-write',
            approvalPolicy: 'auto_review',
            approvalsReviewer: 'auto_review',
          },
        }),
        shell,
      ),
    ).toMatchObject({ action: 'allow' })
    expect(
      engine.evaluate(
        invocation({
          input: {
            command: 'npm view',
            additionalPermissions: { networkDomains: ['npmjs.org'] },
          },
          permissionConfig: {
            sandboxMode: 'workspace-write',
            approvalPolicy: 'auto_review',
            approvalsReviewer: 'auto_review',
          },
        }),
        shell,
      ),
    ).toMatchObject({ action: 'review', reviewer: 'auto_review' })
    expect(
      engine.evaluate(
        invocation({
          permissionConfig: {
            sandboxMode: 'workspace-write',
            approvalPolicy: 'never',
            approvalsReviewer: 'auto_review',
          },
        }),
        shell,
      ),
    ).toMatchObject({ action: 'allow' })
    expect(
      engine.evaluate(
        invocation({
          input: {
            command: 'npm view',
            additionalPermissions: { networkDomains: ['npmjs.org'] },
          },
          permissionConfig: {
            sandboxMode: 'workspace-write',
            approvalPolicy: 'never',
            approvalsReviewer: 'auto_review',
          },
        }),
        shell,
      ),
    ).toMatchObject({ action: 'deny' })
  })

  test('Shell 静态规则审批服从 auto_review 与 never', () => {
    const engine = new PermissionDecisionEngine()
    const shell = new ToolRegistry().get('exec_command')
    const riskyInput = {
      command: 'winget uninstall fixture',
      __ruleRequiresApproval: true,
    }
    expect(
      engine.evaluate(
        invocation({ input: riskyInput, permissionFacts: { ruleRequiresApproval: true } }),
        shell,
      ),
    ).toMatchObject({
      action: 'review',
      reviewer: 'auto_review',
    })
    expect(
      engine.evaluate(
        invocation({
          input: riskyInput,
          permissionFacts: { ruleRequiresApproval: true },
          permissionConfig: {
            sandboxMode: 'workspace-write',
            approvalPolicy: 'never',
            approvalsReviewer: 'auto_review',
          },
        }),
        shell,
      ),
    ).toMatchObject({ action: 'deny' })
  })

  test('MCP 工具权限与模型控制标记隔离校验', () => {
    const engine = new PermissionDecisionEngine()
    const catalog = new ToolRegistry()
    const readTool = catalog.get('Read')
    const permissionConfig = {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'auto_review',
      approvalsReviewer: 'auto_review',
    } as const
    const baseline = engine.evaluate(
      invocation({ input: { path: 'sample.png' }, permissionConfig }),
      readTool,
    )
    const forged = engine.evaluate(
      invocation({
        input: { path: 'sample.png', __mcpElicitation: true },
        permissionConfig,
      }),
      readTool,
    )
    expect(forged).toEqual(baseline)
    const mcpTool = {
      ...readTool,
      sdkName: 'remote_lookup',
      name: 'remote_lookup',
      origin: {
        kind: 'mcp' as const,
        serverName: 'fixture',
        rawToolName: 'lookup',
        generation: 1,
      },
    }
    expect(
      engine.evaluate(
        invocation({
          name: 'remote_lookup',
          permissionConfig,
        }),
        {
          ...mcpTool,
          capabilities: { ...mcpTool.capabilities, externalState: true },
        },
      ),
    ).toMatchObject({ action: 'allow', risk: 'low' })
  })

  test.each(['plan', 'grill'] as const)('%s 使用统一调查判权并保留写入与提权限制', (taskMode) => {
    const catalog = new ToolRegistry()
    const engine = new PermissionDecisionEngine()
    const fullAccessNever = {
      sandboxMode: 'danger-full-access' as const,
      approvalPolicy: 'never' as const,
      approvalsReviewer: 'auto_review' as const,
    }
    for (const [name, input] of [['Read', { path: 'sample.png' }]] as const) {
      expect(
        engine.evaluate(
          invocation({ name, input, taskMode, permissionConfig: fullAccessNever }),
          catalog.get(name),
        ),
      ).toMatchObject({ action: 'allow' })
    }
    expect(
      engine.evaluate(
        invocation({
          taskMode,
          input: { command: 'Get-ChildItem' },
          permissionFacts: { risk: 'low', readOnlyShell: true },
          permissionConfig: fullAccessNever,
        }),
        catalog.get('exec_command'),
      ),
    ).toMatchObject({ action: 'allow' })
    expect(
      engine.evaluate(
        invocation({
          taskMode,
          input: { command: 'winget uninstall fixture' },
          permissionFacts: { risk: 'high', ruleRequiresApproval: true },
          permissionConfig: fullAccessNever,
        }),
        catalog.get('exec_command'),
      ),
    ).toMatchObject({ action: 'deny' })
    expect(
      engine.evaluate(
        invocation({
          taskMode,
          permissionFacts: { risk: 'low', ruleEffect: 'deny' },
          permissionConfig: fullAccessNever,
        }),
        catalog.get('exec_command'),
      ),
    ).toMatchObject({ action: 'deny' })
    expect(
      engine.evaluate(
        invocation({
          taskMode,
          permissionFacts: { risk: 'low', hookRequiresApproval: true },
          permissionConfig: fullAccessNever,
        }),
        catalog.get('exec_command'),
      ),
    ).toMatchObject({ action: 'deny' })
    for (const [name, input] of [
      ['Write', { file_path: 'x', content: 'x' }],
      ['Edit', { path: 'x', edits: [{ oldText: 'a', newText: 'b' }] }],
    ] as const) {
      expect(
        engine.evaluate(
          invocation({ name, input, taskMode, permissionConfig: fullAccessNever }),
          catalog.get(name),
        ),
      ).toMatchObject({ action: 'deny' })
    }
    expect(
      engine.evaluate(
        invocation({
          name: 'request_permissions',
          taskMode,
          input: { scope: 'turn', justification: 'need' },
        }),
        catalog.get('request_permissions'),
      ),
    ).toMatchObject({
      action: 'deny',
      reason: expect.stringContaining('禁止请求'),
    })
  })
})

describe('脱敏', () => {
  test('命令、对象字段和输出凭据统一脱敏', () => {
    expect(secretScrubber.scrubText('Authorization: Bearer abc.def.ghi')).toContain('<redacted>')
    expect(
      secretScrubber.scrub({
        command: 'api_key=super-secret',
        stdout: 'ghp_abcdefghijklmnopqrstuvwxyz',
        password: 'raw',
      }),
    ).toEqual({
      command: 'api_key=<redacted>',
      stdout: '<redacted>',
      password: '<redacted>',
    })
    const multiline = secretScrubber.scrubText(
      'password = "value with spaces"\nAuthorization: Basic dXNlcjpwYXNz\nnext=ok',
    )
    expect(multiline).toBe('password = <redacted>\nAuthorization: <redacted>\nnext=ok')
    expect(() => secretScrubber.assertSafeOpaqueState('{"api_key":"secret value"}')).toThrow(
      'Opaque RunState',
    )
  })
})

test('预设允许普通操作；模型控制标记无效且 never-review 不能绕过可信限制', () => {
  const engine = new PermissionDecisionEngine()
  const catalog = new ToolRegistry()
  for (const sandboxMode of ['workspace-write', 'danger-full-access'] as const) {
    for (const approvalPolicy of ['auto_review', 'never'] as const) {
      const permissionConfig = {
        sandboxMode,
        approvalsReviewer: 'auto_review' as const,
        approvalPolicy,
      }
      for (const name of ['Read', 'Write', 'exec_command'])
        expect(
          engine.evaluate(invocation({ name, permissionConfig }), catalog.get(name)).action,
        ).toBe('allow')
      expect(
        engine.evaluate(
          invocation({ name: 'Read', permissionConfig }),
          catalog.get('Read'),
        ).risk,
      ).toBe('low')
      const tool = { ...catalog.get('Read'), approvalStrategy: 'never-review' as const }
      const input = {
        __hookRequiresApproval: true,
        __ruleRequiresApproval: true,
        __skillScript: true,
      }
      expect(engine.evaluate(invocation({ input, permissionConfig }), tool).action).toBe('allow')
      expect(
        engine.evaluate(
          invocation({ permissionConfig, permissionFacts: { hookRequiresApproval: true } }),
          tool,
        ).action,
      ).toBe(
        sandboxMode === 'danger-full-access' && approvalPolicy === 'never'
          ? 'allow'
          : approvalPolicy === 'never'
            ? 'deny'
            : 'review',
      )
      expect(
        engine.evaluate(
          invocation({ permissionConfig, permissionFacts: { denyReason: 'hard deny' } }),
          tool,
        ).action,
      ).toBe(sandboxMode === 'danger-full-access' && approvalPolicy === 'never' ? 'allow' : 'deny')
    }
  }
})

test('两预设按实际风险处理外部操作、联网与未知工具', () => {
  const engine = new PermissionDecisionEngine()
  const tool = new ToolRegistry().get('exec_command')
  const presets = [
    {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'auto_review',
      approvalsReviewer: 'auto_review',
    },
    {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'auto_review',
    },
  ] as const
  const cases = [
    [{ risk: 'low' }, ['allow', 'allow']],
    [{ risk: 'low', externalCommand: true }, ['review', 'allow']],
    [{ risk: 'low', externalWrite: true }, ['review', 'allow']],
    [{ risk: 'low', networkAccess: true }, ['review', 'allow']],
    [{ risk: 'medium' }, ['review', 'allow']],
    [{ risk: 'high' }, ['review', 'allow']],
    [{}, ['review', 'allow']],
    [{ risk: 'critical', destructive: true, ruleEffect: 'deny' }, ['deny', 'deny']],
    [{ risk: 'low', ruleEffect: 'ask' }, ['review', 'review']],
  ] as const
  for (const [facts, actions] of cases)
    for (let index = 0; index < presets.length; index++) {
      const result = engine.evaluate(
        invocation({ permissionConfig: presets[index]!, permissionFacts: facts }),
        tool,
      )
      expect(result.action).toBe(actions[index]!)
      if (result.action === 'review') expect(result.reviewer).toBe('auto_review')
    }
  expect(
    engine.evaluate(
      invocation({
        permissionConfig: { ...presets[0], approvalPolicy: 'never' },
        permissionFacts: { risk: 'high', ruleEffect: 'allow' },
      }),
      tool,
    ).action,
  ).toBe('allow')
})
