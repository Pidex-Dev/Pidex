import { beforeEach, describe, expect, test } from 'bun:test'
import {
  closeSettingsDialog,
  extractSettingsTab,
  getSettingsDialogSnapshot,
  isSettingsPath,
  normalizeSettingsDestination,
  openSettingsDialog,
  resetSettingsDialogStateForTest,
  setSettingsDialogActiveTab,
  subscribeSettingsDialogNavigation,
} from '../src/features/settings/SettingsDialogStore.js'

describe('SettingsDialogStore', () => {
  beforeEach(() => {
    resetSettingsDialogStateForTest()
  })

  test('isSettingsPath matches settings subpaths and excludes /settings/providers', () => {
    expect(isSettingsPath('/settings')).toBeTrue()
    expect(isSettingsPath('/settings/')).toBeTrue()
    expect(isSettingsPath('/settings/general')).toBeTrue()
    expect(isSettingsPath('/settings/environment/proj-1')).toBeTrue()
    expect(isSettingsPath('/settings/providers')).toBeFalse()
    expect(isSettingsPath('/settings/providers/openai')).toBeFalse()
    expect(isSettingsPath('/providers')).toBeFalse()
    expect(isSettingsPath('/new')).toBeFalse()
  })

  test('normalizeSettingsDestination normalizes legacy environment and worktree query aliases', () => {
    expect(normalizeSettingsDestination('/settings')).toBe('/settings/general')
    expect(normalizeSettingsDestination('/settings/')).toBe('/settings/general')
    expect(normalizeSettingsDestination('/settings/environment/proj-1')).toBe(
      '/settings/environments?projectId=proj-1',
    )
    expect(normalizeSettingsDestination('/settings/local-environment?foo=bar')).toBe(
      '/settings/environments?foo=bar',
    )
    expect(
      normalizeSettingsDestination('/settings/worktrees?tab=environments&threadId=t-1&mode=edit'),
    ).toBe('/settings/environments?threadId=t-1&mode=edit')
    expect(normalizeSettingsDestination('/settings/plugins?tab=mcps')).toBe(
      '/settings/plugins?tab=mcps',
    )
  })

  test('extractSettingsTab extracts route tab with general fallback', () => {
    expect(extractSettingsTab('/settings/appearance')).toBe('appearance')
    expect(extractSettingsTab('/settings/environment/proj-1')).toBe('environments')
    expect(extractSettingsTab('/settings')).toBe('general')
  })

  test('opens and closes the dialog, updates its active tab and notifies navigation subscribers', () => {
    const pushed: string[] = []
    const unsubscribe = subscribeSettingsDialogNavigation((dest) => {
      pushed.push(dest)
    })

    openSettingsDialog('/settings/appearance')
    expect(getSettingsDialogSnapshot()).toMatchObject({
      open: true,
      destination: '/settings/appearance',
      activeTab: 'appearance',
      revision: 1,
    })
    expect(pushed).toEqual([])

    openSettingsDialog('/settings/plugins?tab=mcps')
    expect(getSettingsDialogSnapshot()).toMatchObject({
      open: true,
      destination: '/settings/plugins?tab=mcps',
      activeTab: 'plugins',
      revision: 2,
    })
    expect(pushed).toEqual(['/settings/plugins?tab=mcps'])

    setSettingsDialogActiveTab('pets')
    expect(getSettingsDialogSnapshot().activeTab).toBe('pets')

    closeSettingsDialog()
    expect(getSettingsDialogSnapshot().open).toBeFalse()

    openSettingsDialog()
    expect(getSettingsDialogSnapshot()).toMatchObject({
      open: true,
      destination: '/settings/general',
      activeTab: 'general',
    })

    closeSettingsDialog()
    expect(getSettingsDialogSnapshot().open).toBeFalse()
    unsubscribe()
  })
})
