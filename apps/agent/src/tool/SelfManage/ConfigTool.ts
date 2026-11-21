import { join } from 'node:path'
import { z } from 'zod'
import { AgentError } from '../../Domain'
import type { ConfigService, ConfigValue } from '../../config/ConfigService'
import type { ToolContext, ToolDefinition } from '../ToolRegistry'
import {
  assertSelfManageWritable,
  buildSelfManageInspection,
  SELF_MANAGE_BASE,
  toJsonObjectSchema,
} from './Shared'

const schema = z
  .object({
    action: z.enum(['read', 'set', 'list_profiles', 'select_profile']),
    scope: z.enum(['user', 'project']).optional(),
    keyPath: z.array(z.string().min(1)).min(1).optional(),
    value: z.unknown().optional(),
    profileId: z.string().nullable().optional(),
    includeLayers: z.boolean().optional(),
  })
  .strict()

type Input = z.infer<typeof schema>

const USER_DEFAULT_ROOTS = new Set([
  'desktop',
  'cli',
  'features',
  'agent',
  'model',
  'model_provider',
  'model_reasoning_effort',
  'personality',
  'profile',
  'model_providers',
  'model_catalog',
  'provider_credentials',
  'shell_security_level',
  'telemetry',
  'logging',
  'data_dir',
  'auto_review',
])

const resolveConfigScope = (input: Input, context: ToolContext): 'user' | 'project' => {
  if (input.scope) return input.scope
  const rootKey = input.keyPath?.[0]
  if (rootKey && USER_DEFAULT_ROOTS.has(rootKey)) return 'user'
  return 'user'
}

export const createConfigTool = (configService: ConfigService): ToolDefinition<Input, unknown> => ({
  ...SELF_MANAGE_BASE,
  sdkName: 'pidex_config',
  name: 'pidex.config',
  description:
    'Read or update Pidex settings (user @pidex/config.json or project .pidex/config.json) and manage profiles.',
  schema,
  inputSchema: toJsonObjectSchema(
    {
      action: { type: 'string', enum: ['read', 'set', 'list_profiles', 'select_profile'] },
      scope: { type: 'string', enum: ['user', 'project'] },
      keyPath: { type: 'array', items: { type: 'string' } },
      value: {},
      profileId: { type: ['string', 'null'] },
      includeLayers: { type: 'boolean' },
    },
    ['action'],
  ),
  inspectInput: (input, context) => {
    const readOnly = input.action === 'read' || input.action === 'list_profiles'
    if (!readOnly) assertSelfManageWritable(context)
    if (readOnly) {
      return buildSelfManageInspection({
        context,
        action: input.action,
        readOnly: true,
        externalWrite: false,
      })
    }
    const scope = input.action === 'select_profile' ? 'user' : resolveConfigScope(input, context)
    const targetPath =
      scope === 'project'
        ? join(context.workspace.rootPath, '.pidex', 'config.json')
        : configService.userConfigPath
    return buildSelfManageInspection({
      context,
      action: input.action,
      readOnly: false,
      affectedPaths: [targetPath],
      externalWrite: scope === 'user',
      extraFingerprint: {
        scope,
        keyPath: input.keyPath ?? null,
        profileId: input.profileId ?? null,
      },
    })
  },
  execute: async (input, context) => {
    if (input.action === 'read') {
      return configService.read({
        cwd: context.workspace.rootPath,
        includeLayers: input.includeLayers ?? false,
      })
    }
    if (input.action === 'list_profiles') {
      return configService.profileList()
    }
    if (input.action === 'select_profile') {
      return configService.profileSelect(input.profileId ?? null)
    }
    if (!input.keyPath || input.keyPath.length === 0) {
      throw new AgentError('INVALID_TOOL_INPUT', 'set 操作必须提供 keyPath', 400)
    }
    const scope = resolveConfigScope(input, context)
    return configService.writeValue({
      keyPath: input.keyPath,
      value: (input.value === undefined ? null : input.value) as ConfigValue,
      ...(scope === 'project'
        ? {
            cwd: context.workspace.rootPath,
            target: { kind: 'project' as const },
          }
        : {
            cwd: context.workspace.rootPath,
            target: { kind: 'user' as const },
          }),
    })
  },
})
