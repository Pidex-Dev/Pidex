export type HookSettingsState = {
  version: 1
  disabledIdentities: string[]
  generation: number
  updatedAt: number
  operations: Array<{
    operationId: string
    identity: string
    enabled: boolean
    generation: number
    updatedAt: number
  }>
}

type SettingsDatabase = {
  getSetting<T>(key: string): T | null
  setSetting(key: string, value: unknown): void
}

const SETTINGS_KEY = 'hooks.runtime.v1'
const MAX_OPERATIONS = 100
const defaultState = (): HookSettingsState => ({
  version: 1,
  disabledIdentities: [],
  generation: 1,
  updatedAt: 0,
  operations: [],
})

const normalizeState = (value: HookSettingsState | null): HookSettingsState => {
  if (!value || value.version !== 1) return defaultState()
  return {
    version: 1,
    disabledIdentities: [
      ...new Set(value.disabledIdentities.filter((hash) => /^[a-f\d]{64}$/i.test(hash))),
    ],
    generation:
      Number.isSafeInteger(value.generation) && value.generation >= 1 ? value.generation : 1,
    updatedAt: Number.isFinite(value.updatedAt) && value.updatedAt >= 0 ? value.updatedAt : 0,
    operations: Array.isArray(value.operations)
      ? value.operations
          .filter(
            (operation) =>
              typeof operation.operationId === 'string' &&
              /^[a-f\d]{64}$/i.test(operation.identity) &&
              typeof operation.enabled === 'boolean' &&
              Number.isSafeInteger(operation.generation) &&
              operation.generation >= 1 &&
              Number.isFinite(operation.updatedAt) &&
              operation.updatedAt >= 0,
          )
          .slice(-MAX_OPERATIONS)
      : [],
  }
}

export class HookSettingsConflictError extends Error {}

export class HookSettingsRepository {
  constructor(private readonly database: SettingsDatabase) {}

  state() {
    return normalizeState(this.database.getSetting<HookSettingsState>(SETTINGS_KEY))
  }

  disabledIdentities() {
    return new Set(this.state().disabledIdentities)
  }

  setEnabled(input: { identity: string; enabled: boolean; operationId: string }) {
    const state = this.state()
    const existing = state.operations.find(
      (operation) => operation.operationId === input.operationId,
    )
    if (existing) {
      if (existing.identity !== input.identity || existing.enabled !== input.enabled) {
        throw new HookSettingsConflictError('operationId 已用于其他 Hook 设置请求')
      }
      return {
        state: {
          ...state,
          generation: existing.generation,
          updatedAt: existing.updatedAt,
        },
        changed: false,
      }
    }

    const disabled = new Set(state.disabledIdentities)
    const wasEnabled = !disabled.has(input.identity)
    if (input.enabled) disabled.delete(input.identity)
    else disabled.add(input.identity)
    const changed = wasEnabled !== input.enabled
    const updatedAt = changed ? Date.now() : state.updatedAt
    const generation = changed ? state.generation + 1 : state.generation
    const next: HookSettingsState = {
      version: 1,
      disabledIdentities: [...disabled].sort(),
      generation,
      updatedAt,
      operations: [
        ...state.operations,
        {
          operationId: input.operationId,
          identity: input.identity,
          enabled: input.enabled,
          generation,
          updatedAt,
        },
      ].slice(-MAX_OPERATIONS),
    }
    this.database.setSetting(SETTINGS_KEY, next)
    return { state: next, changed }
  }
}
