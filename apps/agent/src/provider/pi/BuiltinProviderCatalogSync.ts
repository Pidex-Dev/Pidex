import type { ConfigService } from '../../config/ConfigService'
import type { ProviderCredentialService } from '../ProviderCredentialService'
import type { PiModelService } from './PiModelService'
import {
  PI_PROVIDER_CONFIG_SCHEMA_VERSION,
  serializePiProviderDefinition,
} from './PiProviderConfig'

const configuredProvidersRecord = (
  snapshot: Record<string, unknown>,
): Readonly<Record<string, unknown>> =>
  snapshot.model_providers &&
  typeof snapshot.model_providers === 'object' &&
  !Array.isArray(snapshot.model_providers)
    ? (snapshot.model_providers as Record<string, unknown>)
    : {}

/**
 * 首次为未配置内置供应商接入凭据时，将当前目录的活跃模型 ID 写入 config.toml 锁定列表；
 * 仅记录极简 `{ enabled: true }`，价格与规格仍在运行时实时跟随目录热更新。
 */
export async function seedBuiltinProviderCatalogModels(input: {
  readonly providerID: string
  readonly piModels: Pick<PiModelService, 'isBuiltinProvider' | 'activeCatalogModelIDs'>
  readonly config: {
    snapshot(): Record<string, unknown>
    batchWrite: ConfigService['batchWrite']
  }
  readonly hadCredentialsBefore?: boolean
}): Promise<boolean> {
  const { providerID, piModels, config, hadCredentialsBefore = false } = input
  if (
    hadCredentialsBefore ||
    typeof piModels.isBuiltinProvider !== 'function' ||
    !piModels.isBuiltinProvider(providerID)
  )
    return false
  const rawProviders = configuredProvidersRecord(config.snapshot())
  if (Object.hasOwn(rawProviders, providerID)) return false
  const modelIDs = await piModels.activeCatalogModelIDs(providerID)
  if (modelIDs.length === 0) return false
  const serialized = serializePiProviderDefinition({
    kind: 'builtin',
    id: providerID,
    enabled: true,
    allowModels: [...modelIDs],
    denyModels: [],
    models: modelIDs.map((id) => ({ id, enabled: true })),
  })
  await config.batchWrite({
    edits: [
      { keyPath: ['model_catalog', 'schema_version'], value: PI_PROVIDER_CONFIG_SCHEMA_VERSION },
      ...Object.entries(serialized.value).map(([key, value]) => ({
        keyPath: ['model_providers', providerID, key],
        value: value as never,
      })),
    ],
  })
  return true
}

/**
 * 删除内置供应商最后一个凭据且无环境变量凭据时，清除其 config.toml 块以回到未配置状态；
 * 自定义 Provider 与仍有凭据的供应商不受影响。
 */
export async function resetUnconfiguredBuiltinProvider(input: {
  readonly providerID: string
  readonly piModels: Pick<PiModelService, 'isBuiltinProvider' | 'isAuthConfigured'>
  readonly providerCredentials: Pick<ProviderCredentialService, 'list'>
  readonly config: {
    snapshot(): Record<string, unknown>
    batchWrite: ConfigService['batchWrite']
  }
}): Promise<boolean> {
  const { providerID, piModels, providerCredentials, config } = input
  if (typeof piModels.isBuiltinProvider !== 'function' || !piModels.isBuiltinProvider(providerID))
    return false
  if ((await providerCredentials.list(providerID)).length > 0) return false
  if (await piModels.isAuthConfigured(providerID)) return false
  const rawProviders = configuredProvidersRecord(config.snapshot())
  const existing = rawProviders[providerID]
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false
  if ((existing as Record<string, unknown>).kind === 'custom') return false
  await config.batchWrite({
    edits: [{ keyPath: ['model_providers', providerID], value: null }],
  })
  return true
}
