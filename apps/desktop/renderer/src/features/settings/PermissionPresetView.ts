import {
  DEFAULT_PERMISSION_CONFIG,
  PERMISSION_PRESETS,
  PERMISSION_PRESET_OPTIONS,
  matchPermissionPreset,
  permissionConfigForPreset,
  type PermissionPreset,
  type PermissionPresetSelection,
} from '@pidex/shared/thread'
import type { DesktopPermissionConfig, DesktopPermissionMode } from '../../../shared/Types.js'

/**
 * Renderer view over the shared permission preset catalog.
 *
 * The preset identity (`sandboxMode`, `approvalPolicy`, `approvalsReviewer`)
 * and every generated config come from `@pidex/shared/thread`.
 */
export type PermissionPresetVisibility = Record<string, never>

export type PermissionPresetOptionView = {
  value: DesktopPermissionMode
  label: string
  detail: string
  disabled?: boolean
}

export type PermissionPresetView = {
  selection: PermissionPresetSelection
  label: string
  detail: string
  /** Presets are always visible in the two-mode model. */
  hidden: boolean
  /** Always null in the two-mode model. */
  unavailableReason: string | null
  /** Visible options for menus. */
  options: PermissionPresetOptionView[]
}

const presetFor = (selection: PermissionPresetSelection): PermissionPreset =>
  PERMISSION_PRESETS.find((preset) => preset.id === selection) ??
  PERMISSION_PRESETS[0] ?? {
    id: 'auto-review',
    label: '帮我批准',
    description: '',
    config: DEFAULT_PERMISSION_CONFIG,
  }

export function permissionPresetSelection(
  config: DesktopPermissionConfig,
): PermissionPresetSelection {
  return matchPermissionPreset(config)
}

/** Always returns the stored config for the preset. */
export function permissionConfigForSelection(
  selection: PermissionPresetSelection,
  current?: DesktopPermissionConfig,
): DesktopPermissionConfig {
  return permissionConfigForPreset(selection, current)
}

export function permissionPresetLabel(selection: PermissionPresetSelection): string {
  return presetFor(selection).label
}

export function permissionPresetDescription(selection: PermissionPresetSelection): string {
  return presetFor(selection).description
}

export function permissionPresetUnavailableReason(
  _selection: PermissionPresetSelection,
  _visibility?: PermissionPresetVisibility,
): string | null {
  return null
}

export function visiblePermissionPresetOptions(
  _visibility?: PermissionPresetVisibility,
): PermissionPresetOptionView[] {
  return PERMISSION_PRESET_OPTIONS.map((option) => ({
    value: option.id,
    label: option.label,
    detail: option.description,
  }))
}

/** Resolves the actual stored selection plus the options a permission menu may show. */
export function permissionPresetView(
  selection: PermissionPresetSelection,
  _visibility?: PermissionPresetVisibility,
): PermissionPresetView {
  return {
    selection,
    label: permissionPresetLabel(selection),
    detail: permissionPresetDescription(selection),
    hidden: false,
    unavailableReason: null,
    options: visiblePermissionPresetOptions(),
  }
}

export function permissionPresetViewForConfig(
  config: DesktopPermissionConfig,
  _visibility?: PermissionPresetVisibility,
): PermissionPresetView {
  return permissionPresetView(matchPermissionPreset(config))
}
