import { desktopClient } from '../../services/desktop-client/index.js'
import { withModelCatalogLoading } from '../../hooks/UseModelCatalogLoading.js'
import type { DesktopModelProviderSummary, ModelProviderID } from '../../../shared/Types.js'

/** Loads all providers and concurrently resolves catalogs for configured providers. */
export async function loadSpecializedModelProviders(): Promise<DesktopModelProviderSummary[]> {
  const providerList = await desktopClient
    .listModelProviders()
    .catch(() => [] as DesktopModelProviderSummary[])
  const configured = providerList.filter((provider) => provider.apiKeyConfigured)
  if (configured.length === 0) return providerList

  const fetched = await Promise.allSettled(
    configured.map(async (provider) => ({
      providerID: provider.providerID,
      catalog: await withModelCatalogLoading(() =>
        desktopClient.fetchProviderModels({
          providerID: provider.providerID as ModelProviderID,
          all: true,
        }),
      ),
    })),
  )

  const byId = new Map(
    fetched.flatMap((entry) =>
      entry.status === 'fulfilled' ? [[entry.value.providerID, entry.value.catalog]] : [],
    ),
  )
  if (byId.size === 0) return providerList

  return providerList.map((provider) => {
    const catalog = byId.get(provider.providerID)
    if (!catalog) return provider
    return {
      ...provider,
      defaultModels: catalog.models,
      modelMetadata: { ...provider.modelMetadata, ...catalog.modelMetadata },
    }
  })
}

/** Fetches the full model catalog for a single provider and returns merged summaries. */
export async function refreshSpecializedProviderInList(
  providers: readonly DesktopModelProviderSummary[],
  providerID: ModelProviderID,
): Promise<DesktopModelProviderSummary[] | null> {
  const target = providers.find((provider) => provider.providerID === providerID)
  if (!target?.apiKeyConfigured) return null
  const catalog = await withModelCatalogLoading(() =>
    desktopClient.fetchProviderModels({
      providerID,
      all: true,
    }),
  )
  return providers.map((provider) =>
    provider.providerID === providerID
      ? {
          ...provider,
          defaultModels: catalog.models,
          modelMetadata: { ...provider.modelMetadata, ...catalog.modelMetadata },
        }
      : provider,
  )
}
