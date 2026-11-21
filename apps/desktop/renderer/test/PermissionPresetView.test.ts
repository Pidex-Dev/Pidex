import { describe, expect, test } from 'bun:test'
import {
  AUTO_REVIEW_PERMISSION_CONFIG,
  DEFAULT_PERMISSION_CONFIG,
  FULL_ACCESS_PERMISSION_CONFIG,
  PERMISSION_PRESETS,
} from '@pidex/shared/thread'
import {
  PERMISSION_MODE_OPTIONS,
  permissionConfigForMode,
  permissionModeForConfig,
} from '../src/features/settings/SettingsStorage.js'
import { permissionPresetViewForConfig } from '../src/features/settings/PermissionPresetView.js'

describe('shared permission preset round-trip', () => {
  test('generates and re-identifies every shared preset exactly', () => {
    for (const preset of PERMISSION_PRESETS) {
      const generated = permissionConfigForMode(preset.id)
      expect(generated).toEqual(preset.config)
      expect(permissionModeForConfig(generated)).toBe(preset.id)
    }
    expect(DEFAULT_PERMISSION_CONFIG).toEqual(AUTO_REVIEW_PERMISSION_CONFIG)
    expect(permissionModeForConfig(DEFAULT_PERMISSION_CONFIG)).toBe('auto-review')
    expect(permissionModeForConfig(AUTO_REVIEW_PERMISSION_CONFIG)).toBe('auto-review')
    expect(permissionModeForConfig(FULL_ACCESS_PERMISSION_CONFIG)).toBe('full-access')
  })

  test('full access recognition requires both danger-full-access and never policy', () => {
    expect(
      permissionModeForConfig({
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        approvalsReviewer: 'auto_review',
      }),
    ).toBe('auto-review')
    expect(
      permissionModeForConfig({
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        approvalsReviewer: 'auto_review',
      }),
    ).toBe('full-access')
  })

  test('exposes only the two active preset catalog labels and descriptions', () => {
    expect(PERMISSION_MODE_OPTIONS.map((option) => option.label)).toEqual(['帮我批准', '完全访问'])
    const labels = Object.fromEntries(
      PERMISSION_MODE_OPTIONS.map((option) => [option.value, option.label]),
    )
    expect(labels).toEqual({
      'auto-review': '帮我批准',
      'full-access': '完全访问',
    })
    expect(PERMISSION_MODE_OPTIONS[0]!.detail).toBe('仅对检测到的风险操作请求批准')
    expect(PERMISSION_MODE_OPTIONS[1]!.detail).toBe('直接执行所有操作，无需请求批准')
  })
})

describe('permission preset view', () => {
  test('always exposes both auto-review and full-access without hidden toggles', () => {
    for (const config of [AUTO_REVIEW_PERMISSION_CONFIG, FULL_ACCESS_PERMISSION_CONFIG]) {
      const view = permissionPresetViewForConfig(config)
      expect(view.hidden).toBe(false)
      expect(view.unavailableReason).toBeNull()
      expect(view.options.map((option) => option.value)).toEqual(['auto-review', 'full-access'])
      expect(view.options.every((option) => !option.disabled)).toBe(true)
    }
  })
})
