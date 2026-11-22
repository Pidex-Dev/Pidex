import React, { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { desktopClient } from '../../services/desktop-client/index.js'
import { withModelCatalogLoading } from '../../hooks/UseModelCatalogLoading.js'
import { useMountEffect } from '../../hooks/UseMountEffect.js'
import { useWindowEvent } from '../../hooks/UseExternalSubscription.js'
import type { DesktopModelProviderSummary, ModelProviderID } from '../../../shared/Types.js'
import { buildModelPresets, getModelDisplayLabel } from '../../ModelPresets.js'
import { Button } from '../../components/ui/Button.js'
import { APP_ICON_SIZES } from '../../components/ui/IconTokens.js'
import { useLocale } from '../i18n/LocaleProvider.js'
import {
  ModelPickerPopover,
  type ProviderModelOption,
} from '../session/composer/ModelPickerPopover.js'

function splitProviderModel(value: string): { providerID: string; id: string } | null {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return null
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

export type SpecializedModelKey =
  | 'generationModel'
  | 'organizationModel'
  | 'codingModel'
  | 'securityModel'

const SPECIALIZED_MODEL_LABELS: Record<SpecializedModelKey, string> = {
  generationModel: '生成模型',
  organizationModel: '整理模型',
  codingModel: '代码模型',
  securityModel: '安全模型（实验）',
}

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

export function SpecializedModelSelect({
  value,
  specializedModelKey,
  onChange,
  label: customLabel,
  emptyLabel = '跟随会话主模型',
  providers: providersProp,
  onProviderOpen,
  onOpenModelSettings,
}: {
  label?: string
  emptyLabel?: string
  value: string
  mainModel?: string
  specializedModelKey: SpecializedModelKey
  providers?: readonly DesktopModelProviderSummary[]
  onProviderOpen?: (providerID: ModelProviderID) => void
  onOpenModelSettings?: () => void
  onChange: (newValue: string) => void
}): React.ReactNode {
  const { t } = useLocale()
  const label = customLabel ?? SPECIALIZED_MODEL_LABELS[specializedModelKey]
  const [open, setOpen] = useState(false)
  const [loadedProviders, setLoadedProviders] = useState<DesktopModelProviderSummary[]>([])
  const mountedRef = useRef(true)

  const reloadOwnProviders = useCallback(async () => {
    try {
      const next = await loadSpecializedModelProviders()
      if (mountedRef.current) setLoadedProviders(next)
    } catch {
      if (mountedRef.current) setLoadedProviders([])
    }
  }, [])

  useMountEffect(() => {
    mountedRef.current = true
    if (providersProp === undefined) {
      void reloadOwnProviders()
    }
    return () => {
      mountedRef.current = false
    }
  })

  useWindowEvent(
    typeof window === 'undefined' ? null : window,
    'desktop:model-provider-changed',
    () => {
      if (providersProp === undefined) {
        void reloadOwnProviders()
      }
    },
  )

  const effectiveProviders = providersProp ?? loadedProviders

  const handleOwnProviderOpen = useCallback(
    (providerID: ModelProviderID) => {
      if (onProviderOpen) {
        onProviderOpen(providerID)
        return
      }
      if (providersProp !== undefined) return
      void refreshSpecializedProviderInList(loadedProviders, providerID)
        .then((next) => {
          if (mountedRef.current && next) setLoadedProviders(next)
        })
        .catch(() => {})
    },
    [loadedProviders, onProviderOpen, providersProp],
  )

  const providerOptions = useMemo<ProviderModelOption[]>(
    () =>
      effectiveProviders
        .filter((provider) => provider.apiKeyConfigured)
        .map((provider) => ({
          providerID: provider.providerID as ModelProviderID,
          displayName: provider.displayName,
          modelPresets: buildModelPresets(provider.defaultModels, provider.modelMetadata),
          apiKeyConfigured: provider.apiKeyConfigured,
          logoURL: provider.logoURL,
          modelMetadata: provider.modelMetadata,
        })),
    [effectiveProviders],
  )

  const parsedValue = useMemo(() => splitProviderModel(value), [value])

  const displayLabel = useMemo(() => {
    if (!value) return t(emptyLabel)
    if (!parsedValue) return value
    const provider = effectiveProviders.find((item) => item.providerID === parsedValue.providerID)
    const providerName = provider?.displayName ?? parsedValue.providerID
    const modelName =
      provider?.modelMetadata?.[parsedValue.id]?.name || getModelDisplayLabel(parsedValue.id)
    return `${providerName} / ${modelName}`
  }, [effectiveProviders, emptyLabel, parsedValue, t, value])

  return (
    <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-1.5">
      <ModelPickerPopover
        open={open}
        onOpenChange={setOpen}
        selectedProviderID={parsedValue?.providerID as ModelProviderID | undefined}
        selectedModelPreset={parsedValue?.id}
        providerOptions={providerOptions}
        allProviders={effectiveProviders}
        onProviderModelChange={(providerID, modelID) => {
          onChange(`${providerID}/${modelID}`)
          setOpen(false)
        }}
        onProviderOpen={handleOwnProviderOpen}
        onOpenModelSettings={onOpenModelSettings}
        align="end"
        side="bottom"
        footerAction={
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={!value}
            onClick={() => {
              onChange('')
              setOpen(false)
            }}
          >
            {t('恢复跟随会话主模型')}
          </Button>
        }
        trigger={
          <button
            type="button"
            aria-label={t(label)}
            data-theme-component="dropdown-trigger"
            title={displayLabel}
            className="ui-select-trigger settings-dropdown settings-dropdown-trigger tw:min-h-6 tw:min-w-0 tw:max-w-[min(360px,48vw)] tw:max-[900px]:w-full tw:max-[900px]:max-w-none tw:appearance-none tw:inline-flex tw:items-center tw:justify-between tw:gap-control-gap tw:border tw:rounded-control tw:px-row-inline tw:py-0 tw:text-left tw:type-2 tw:weight-medium tw:cursor-pointer tw:outline-none tw:transition-[background-color,border-color,color,opacity] tw:duration-feedback tw:ease-out"
          >
            <span className="ui-select-value tw:min-w-0 tw:truncate">{displayLabel}</span>
            <ChevronDown
              aria-hidden="true"
              className="tw:shrink-0"
              size="var(--inline-icon-size, 1em)"
            />
          </button>
        }
      />
      {value ? (
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          type="button"
          aria-label={t('恢复默认（跟随会话主模型）')}
          title={t('恢复默认（跟随会话主模型）')}
          onClick={() => onChange('')}
        >
          <RotateCcw aria-hidden="true" className="tw:size-icon-sm" size={APP_ICON_SIZES.sm} />
        </Button>
      ) : null}
    </div>
  )
}
