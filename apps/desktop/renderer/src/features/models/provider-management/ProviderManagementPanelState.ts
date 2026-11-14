import type { ProviderManagementTab } from '../../layout/dock/RightDockState.js'

export const NEW_PROVIDER_PANEL_ID = '__new_custom_provider__'

export function providerManagementRouteId(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search)
  if (pathname !== '/providers' || params.get('edit') === '1') return null
  if (params.get('newProvider') === '1') return NEW_PROVIDER_PANEL_ID
  return params.get('provider') || null
}

export function scopedProviderManagementTab(
  tab: ProviderManagementTab | null,
  pathname: string,
  search: string,
): ProviderManagementTab | null {
  const providerId = providerManagementRouteId(pathname, search)
  if (tab?.section === 'model' && tab.providerId !== providerId) return null
  return tab && providerId ? { ...tab, providerId } : null
}
