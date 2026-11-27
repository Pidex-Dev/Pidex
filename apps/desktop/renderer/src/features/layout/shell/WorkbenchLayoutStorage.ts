import {
  BOTTOM_PANEL_HEIGHT_RATIO_STORAGE_KEY,
  RIGHT_DOCK_WIDTH_RATIO_STORAGE_KEY,
  bottomPanelHeightFromRatio,
  getResponsiveRightDockDefaultWidth,
  rightDockWidthFromRangeRatio,
  rightDockWidthFromRatio,
  rightDockWidthToRangeRatio,
} from './WorkbenchLayoutSizing.js'
import {
  WORKBENCH_LAYOUT_SCHEMA_VERSION,
  WORKBENCH_LAYOUT_STORAGE_KEY,
  clampAuxiliaryPanelWidth,
  clampBottomPanelHeight,
  clampPrimarySidebarWidth,
  createDefaultVisibility,
  createDefaultWorkbenchLayoutState,
  type WorkbenchLayoutSnapshot,
  type WorkbenchLayoutState,
  type WorkbenchPartVisibility,
} from './WorkbenchLayoutState.js'
import { isRecord } from '@pidex/shared/guards'

export { WORKBENCH_LAYOUT_STORAGE_KEY, WORKBENCH_LAYOUT_SCHEMA_VERSION }

export type { WorkbenchLayoutSnapshot, WorkbenchLayoutState, WorkbenchPartVisibility }

const LEGACY_RIGHT_DOCK_WIDTH_STORAGE_KEY = 'pidex.desktop.rightDockWidth'

export interface ReadWorkbenchLayoutInput {
  workspaceWidth: number
  workspaceHeight: number
  sidebarCollapsed: boolean
  sidebarWidth: number
}

export interface SaveWorkbenchLayoutTarget {
  storage?: Storage | null
}

export function readWorkbenchLayoutSnapshot(
  input: ReadWorkbenchLayoutInput,
  target: SaveWorkbenchLayoutTarget = {},
): WorkbenchLayoutSnapshot {
  const storage = resolveStorage(target.storage)
  const raw = safeGetItem(storage, WORKBENCH_LAYOUT_STORAGE_KEY)
  if (raw != null) {
    const parsed = tryParseStoredSnapshot(raw)
    if (parsed != null) {
      return normalizeSnapshot(parsed, input)
    }
  }
  const base = createDefaultWorkbenchLayoutState(input.workspaceWidth, input.workspaceHeight)
  const auxiliaryWidth = readStoredAuxiliaryWidth(storage, input)
  const bottomRatio = parseUnitInterval(safeGetItem(storage, BOTTOM_PANEL_HEIGHT_RATIO_STORAGE_KEY))
  return {
    ...base,
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    visibility: { ...base.visibility, primarySidebar: !input.sidebarCollapsed },
    primarySidebarWidth: clampPrimarySidebarWidth(input.sidebarWidth),
    auxiliaryPanelWidth: auxiliaryWidth,
    auxiliaryPanelWidthRangeRatio: rightDockWidthToRangeRatio(auxiliaryWidth, input.workspaceWidth),
    bottomPanelHeight:
      bottomRatio == null
        ? base.bottomPanelHeight
        : bottomPanelHeightFromRatio(bottomRatio, input.workspaceHeight),
  }
}

export function saveWorkbenchLayoutSnapshot(
  snapshot: WorkbenchLayoutSnapshot,
  target: SaveWorkbenchLayoutTarget = {},
): void {
  const storage = resolveStorage(target.storage)
  if (storage == null) return
  try {
    storage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    /* localStorage full or disabled; the in-memory state remains authoritative. */
  }
}

function readStoredAuxiliaryWidth(
  storage: Storage | null,
  input: ReadWorkbenchLayoutInput,
): number {
  const ratio = parseUnitInterval(safeGetItem(storage, RIGHT_DOCK_WIDTH_RATIO_STORAGE_KEY))
  if (ratio != null) return rightDockWidthFromRatio(ratio, input.workspaceWidth)

  const width = parseFiniteNumber(safeGetItem(storage, LEGACY_RIGHT_DOCK_WIDTH_STORAGE_KEY))
  if (width == null || width < 0) {
    return getResponsiveRightDockDefaultWidth(input.workspaceWidth, input.workspaceHeight)
  }
  return width <= 1
    ? rightDockWidthFromRangeRatio(width, input.workspaceWidth)
    : clampAuxiliaryPanelWidth(width, input.workspaceWidth)
}

function resolveStorage(explicit: SaveWorkbenchLayoutTarget['storage']): Storage | null {
  if (explicit != null) return explicit
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function safeGetItem(storage: Storage | null, key: string): string | null {
  if (storage == null) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function tryParseStoredSnapshot(raw: string): WorkbenchLayoutSnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.schemaVersion !== WORKBENCH_LAYOUT_SCHEMA_VERSION) return null
  const visibility = parseVisibility(parsed.visibility)
  if (visibility == null) return null
  const primarySidebarWidth = parseFiniteNumber(parsed.primarySidebarWidth)
  const auxiliaryPanelWidth = parseFiniteNumber(parsed.auxiliaryPanelWidth)
  const bottomPanelHeight = parseFiniteNumber(parsed.bottomPanelHeight)
  if (primarySidebarWidth == null || auxiliaryPanelWidth == null || bottomPanelHeight == null) {
    return null
  }
  const auxiliaryMaximized = parsed.auxiliaryMaximized === true
  const beforeAuxiliaryMaximized = auxiliaryMaximized
    ? (parseVisibility(parsed.beforeAuxiliaryMaximized) ?? createDefaultVisibility())
    : null
  const beforeAuxiliaryMaximizedAuxiliaryWidth = auxiliaryMaximized
    ? parseFiniteNumber(parsed.beforeAuxiliaryMaximizedAuxiliaryWidth)
    : null
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    visibility,
    primarySidebarWidth,
    auxiliaryPanelWidth,
    auxiliaryPanelWidthRangeRatio: parseUnitInterval(parsed.auxiliaryPanelWidthRangeRatio),
    bottomPanelHeight,
    auxiliaryMaximized,
    beforeAuxiliaryMaximized,
    beforeAuxiliaryMaximizedAuxiliaryWidth,
  }
}

function normalizeSnapshot(
  snapshot: WorkbenchLayoutSnapshot,
  input: ReadWorkbenchLayoutInput,
): WorkbenchLayoutSnapshot {
  const safeWorkspaceWidth = Math.max(input.workspaceWidth, 0)
  const safeWorkspaceHeight = Math.max(input.workspaceHeight, 0)
  const visibility: WorkbenchPartVisibility = {
    primarySidebar: snapshot.visibility.primarySidebar,
    mainContent: snapshot.visibility.mainContent,
    auxiliaryPanel: snapshot.visibility.auxiliaryPanel,
    bottomPanel: snapshot.visibility.bottomPanel,
  }
  if (!snapshot.auxiliaryMaximized && !visibility.mainContent) {
    visibility.mainContent = true
  }
  const primarySidebarWidth = clampPrimarySidebarWidth(snapshot.primarySidebarWidth)
  const auxiliaryPanelWidth = clampAuxiliaryPanelWidth(
    snapshot.auxiliaryPanelWidth,
    safeWorkspaceWidth,
  )
  const auxiliaryPanelWidthRangeRatio =
    snapshot.auxiliaryPanelWidthRangeRatio ??
    rightDockWidthToRangeRatio(auxiliaryPanelWidth, safeWorkspaceWidth)
  const bottomPanelHeight = clampBottomPanelHeight(snapshot.bottomPanelHeight, safeWorkspaceHeight)
  const beforeAuxiliaryMaximized = snapshot.auxiliaryMaximized
    ? { ...(snapshot.beforeAuxiliaryMaximized ?? visibility) }
    : null
  const beforeAuxiliaryMaximizedAuxiliaryWidth = snapshot.auxiliaryMaximized
    ? clampAuxiliaryPanelWidth(
        snapshot.beforeAuxiliaryMaximizedAuxiliaryWidth ?? snapshot.auxiliaryPanelWidth,
        safeWorkspaceWidth,
      )
    : null
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    visibility,
    primarySidebarWidth,
    auxiliaryPanelWidth,
    auxiliaryPanelWidthRangeRatio,
    bottomPanelHeight,
    auxiliaryMaximized: snapshot.auxiliaryMaximized,
    beforeAuxiliaryMaximized,
    beforeAuxiliaryMaximizedAuxiliaryWidth,
  }
}

function parseVisibility(value: unknown): WorkbenchPartVisibility | null {
  if (!isRecord(value)) return null
  if (
    typeof value.primarySidebar !== 'boolean' ||
    typeof value.mainContent !== 'boolean' ||
    typeof value.auxiliaryPanel !== 'boolean' ||
    typeof value.bottomPanel !== 'boolean'
  ) {
    return null
  }
  return {
    primarySidebar: value.primarySidebar,
    mainContent: value.mainContent,
    auxiliaryPanel: value.auxiliaryPanel,
    bottomPanel: value.bottomPanel,
  }
}

function parseUnitInterval(value: unknown): number | null {
  const parsed = parseFiniteNumber(value)
  return parsed != null && parsed >= 0 && parsed <= 1 ? parsed : null
}

function parseFiniteNumber(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
