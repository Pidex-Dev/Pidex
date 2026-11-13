import { Schema } from 'effect'
import { defineMethod, type MethodMap } from '../wire/Definition'
import {
  NonEmptyStringSchema,
  OperationParamsSchema,
  SequenceSchema,
  TimestampSchema,
} from '../wire/Primitives'

export const PluginSourceSchema = Schema.Literals(['bundled', 'workspace', 'personal', 'installed'])

export const PluginInstallationPolicySchema = Schema.Literals([
  'NOT_AVAILABLE',
  'AVAILABLE',
  'INSTALLED_BY_DEFAULT',
])

export const PluginStatusSchema = Schema.Literals(['ready', 'unavailable', 'invalid'])

export const PluginAssetKindSchema = Schema.Literals(['logo', 'logoDark'])
export const PluginMarketplaceSectionSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  pluginIds: Schema.Array(NonEmptyStringSchema),
})

export const PluginSummarySchema = Schema.Struct({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  description: Schema.String,
  developerName: NonEmptyStringSchema,
  category: NonEmptyStringSchema,
  source: PluginSourceSchema,
  installationPolicy: PluginInstallationPolicySchema,
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  status: PluginStatusSchema,
  capabilities: Schema.Array(NonEmptyStringSchema),
  skills: Schema.Array(NonEmptyStringSchema),
  canInstall: Schema.optional(Schema.Boolean),
  canUninstall: Schema.optional(Schema.Boolean),
  inMarketplace: Schema.optional(Schema.Boolean),
  assetKinds: Schema.optional(Schema.Array(PluginAssetKindSchema)),
  unavailableReason: Schema.optional(NonEmptyStringSchema),
})

export const PluginDetailSkillSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  description: Schema.String,
})

/**
 * A component a plugin bundles or relies on. `host` components are injected by
 * the host runtime (for example the `node_repl` MCP adapter). Ownership does not
 * grant launch authority; editable MCP settings use the MCP management API.
 */
export const PluginComponentSchema = Schema.Struct({
  kind: Schema.Literals(['skill', 'mcp', 'documentation']),
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  description: Schema.String,
  managedBy: Schema.Literals(['plugin', 'host']),
})

/**
 * Install provenance shown before an install is confirmed. `catalogRevision` is
 * the pinned marketplace commit the details were read from; echoing it back in
 * `plugin/install` makes the install fail with CONFLICT if the catalog moved on.
 */
export const PluginInstallSourceSchema = Schema.Struct({
  /** Marketplace or local repository identifier; never a filesystem path. */
  repository: NonEmptyStringSchema,
  catalogRevision: Schema.optional(NonEmptyStringSchema),
  version: NonEmptyStringSchema,
  /** Components the host would activate after install. */
  components: Schema.Array(PluginComponentSchema),
  /** Declared components the host only diagnoses (commands, agents, hooks). */
  unsupportedComponents: Schema.Array(NonEmptyStringSchema),
})

export const AppToolModeSchema = Schema.Literals(['read', 'write'])

export const AppToolDescriptorSchema = Schema.Struct({
  name: NonEmptyStringSchema,
  description: Schema.String,
  mode: AppToolModeSchema,
})

export const AppSourceSchema = Schema.Literals(['builtin', 'plugin'])

export const AppAuthStatusSchema = Schema.Struct({
  required: Schema.Boolean,
  connected: Schema.Boolean,
  provider: Schema.optional(NonEmptyStringSchema),
})

export const AppSummarySchema = Schema.Struct({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  description: Schema.String,
  developerName: NonEmptyStringSchema,
  source: AppSourceSchema,
  enabled: Schema.Boolean,
  canUninstall: Schema.Boolean,
  pluginId: Schema.optional(NonEmptyStringSchema),
  iconName: Schema.optional(NonEmptyStringSchema),
  tools: Schema.Array(AppToolDescriptorSchema),
  auth: Schema.optional(AppAuthStatusSchema),
})

export const PluginUsedAppSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  description: Schema.String,
  required: Schema.optional(Schema.Boolean),
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  authConnected: Schema.optional(Schema.Boolean),
  iconName: Schema.optional(NonEmptyStringSchema),
  developerName: Schema.optional(NonEmptyStringSchema),
  tools: Schema.optional(Schema.Array(AppToolDescriptorSchema)),
})

export const PluginDetailsSchema = Schema.Struct({
  pluginId: NonEmptyStringSchema,
  longDescription: Schema.String,
  displayCapabilities: Schema.Array(NonEmptyStringSchema),
  defaultPrompts: Schema.Array(NonEmptyStringSchema),
  skills: Schema.Array(PluginDetailSkillSchema),
  /** Optional apps referenced or provided by this plugin; older clients can ignore it. */
  apps: Schema.optional(Schema.Array(PluginUsedAppSchema)),
  /** Optional install provenance; older clients can ignore it. */
  installSource: Schema.optional(PluginInstallSourceSchema),
  /** Optional plugin component inventory; older clients can ignore it. */
  components: Schema.optional(Schema.Array(PluginComponentSchema)),
  websiteURL: Schema.optional(NonEmptyStringSchema),
  privacyPolicyURL: Schema.optional(NonEmptyStringSchema),
  termsOfServiceURL: Schema.optional(NonEmptyStringSchema),
})

export const PluginListParamsSchema = Schema.Struct({
  workspace: Schema.optional(NonEmptyStringSchema),
  forceReload: Schema.optional(Schema.Boolean),
})

export const PluginListResultSchema = Schema.Struct({
  plugins: Schema.Array(PluginSummarySchema),
  catalogError: Schema.optional(NonEmptyStringSchema),
  sections: Schema.optional(Schema.Array(PluginMarketplaceSectionSchema)),
  generation: SequenceSchema,
  updatedAt: TimestampSchema,
})

export const PluginGetDetailsParamsSchema = Schema.Struct({
  pluginId: NonEmptyStringSchema,
  workspace: Schema.optional(NonEmptyStringSchema),
})

export const PluginGetDetailsResultSchema = Schema.Struct({
  details: PluginDetailsSchema,
})

export const PluginSetEnabledParamsSchema = Schema.Struct({
  pluginId: NonEmptyStringSchema,
  enabled: Schema.Boolean,
  ...OperationParamsSchema.fields,
})

export const PluginSetEnabledResultSchema = Schema.Struct({
  plugin: PluginSummarySchema,
  generation: SequenceSchema,
  updatedAt: TimestampSchema,
})

export const PluginLifecycleParamsSchema = Schema.Struct({
  pluginId: NonEmptyStringSchema,
  ...OperationParamsSchema.fields,
})

/**
 * Install-only extension. `expectedCatalogRevision` is optional so older
 * callers keep working; when present the host compares it before downloading.
 */
export const PluginInstallParamsSchema = Schema.Struct({
  ...PluginLifecycleParamsSchema.fields,
  expectedCatalogRevision: Schema.optional(NonEmptyStringSchema),
})

export const PluginLifecycleResultSchema = Schema.Struct({
  pluginId: NonEmptyStringSchema,
  generation: SequenceSchema,
  updatedAt: TimestampSchema,
})

export const AppListParamsSchema = Schema.Struct({
  workspace: Schema.optional(NonEmptyStringSchema),
})

export const AppListResultSchema = Schema.Struct({
  apps: Schema.Array(AppSummarySchema),
  generation: SequenceSchema,
  updatedAt: TimestampSchema,
})

export const AppSetEnabledParamsSchema = Schema.Struct({
  appId: NonEmptyStringSchema,
  enabled: Schema.Boolean,
  ...OperationParamsSchema.fields,
})

export const AppSetEnabledResultSchema = Schema.Struct({
  app: AppSummarySchema,
  generation: SequenceSchema,
  updatedAt: TimestampSchema,
})

const PluginErrors = [
  'PLUGIN_NOT_FOUND',
  'PLUGIN_NOT_INSTALLED',
  'PLUGIN_INVALID',
  'CONFLICT',
  'PATH_DENIED',
  'INTERNAL_ERROR',
] as const

export const PluginRpcMethods = {
  'app/list': defineMethod({
    params: AppListParamsSchema,
    result: AppListResultSchema,
    errors: PluginErrors,
    capability: 'apps.manage.v1',
    mutation: false,
    exactParams: true,
    exactResult: true,
  }),
  'app/setEnabled': defineMethod({
    params: AppSetEnabledParamsSchema,
    result: AppSetEnabledResultSchema,
    errors: PluginErrors,
    capability: 'apps.manage.v1',
    mutation: true,
    exactParams: true,
    exactResult: true,
  }),
  'plugin/readAsset': defineMethod({
    params: Schema.Struct({
      pluginId: NonEmptyStringSchema,
      kind: PluginAssetKindSchema,
      workspace: Schema.optional(NonEmptyStringSchema),
    }),
    result: Schema.Struct({
      mimeType: Schema.Literals(['image/png', 'image/jpeg', 'image/webp']),
      base64: Schema.String,
    }),
    errors: PluginErrors,
    capability: 'plugins.assets.v1',
    mutation: false,
    exactParams: true,
    exactResult: true,
  }),
  'plugin/install': defineMethod({
    params: PluginInstallParamsSchema,
    result: PluginLifecycleResultSchema,
    errors: PluginErrors,
    capability: 'plugins.lifecycle.v1',
    mutation: true,
    exactParams: true,
    exactResult: true,
  }),
  'plugin/uninstall': defineMethod({
    params: PluginLifecycleParamsSchema,
    result: PluginLifecycleResultSchema,
    errors: PluginErrors,
    capability: 'plugins.lifecycle.v1',
    mutation: true,
    exactParams: true,
    exactResult: true,
  }),
  'plugin/list': defineMethod({
    params: PluginListParamsSchema,
    result: PluginListResultSchema,
    errors: PluginErrors,
    capability: 'plugins.manage.v1',
    mutation: false,
    exactParams: true,
    exactResult: true,
  }),
  'plugin/getDetails': defineMethod({
    params: PluginGetDetailsParamsSchema,
    result: PluginGetDetailsResultSchema,
    errors: PluginErrors,
    capability: 'plugins.details.v1',
    mutation: false,
    exactParams: true,
    exactResult: true,
  }),
  'plugin/setEnabled': defineMethod({
    params: PluginSetEnabledParamsSchema,
    result: PluginSetEnabledResultSchema,
    errors: PluginErrors,
    capability: 'plugins.manage.v1',
    mutation: true,
    exactParams: true,
    exactResult: true,
  }),
} as const satisfies MethodMap

export type PluginSource = typeof PluginSourceSchema.Type
export type PluginInstallationPolicy = typeof PluginInstallationPolicySchema.Type
export type PluginStatus = typeof PluginStatusSchema.Type
export type PluginSummary = typeof PluginSummarySchema.Type
export type PluginDetailSkill = typeof PluginDetailSkillSchema.Type
export type PluginComponent = typeof PluginComponentSchema.Type
export type PluginDetails = typeof PluginDetailsSchema.Type
export type PluginInstallSource = typeof PluginInstallSourceSchema.Type
export type PluginAssetKind = typeof PluginAssetKindSchema.Type
export type PluginMarketplaceSection = typeof PluginMarketplaceSectionSchema.Type
export type AppToolMode = typeof AppToolModeSchema.Type
export type AppToolDescriptor = typeof AppToolDescriptorSchema.Type
export type AppSource = typeof AppSourceSchema.Type
export type AppAuthStatus = typeof AppAuthStatusSchema.Type
export type AppSummary = typeof AppSummarySchema.Type
export type PluginUsedApp = typeof PluginUsedAppSchema.Type
