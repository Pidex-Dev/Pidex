import type { HookTrustStatus } from '@pidex/agent-protocol'
import { hookRequiresTrust } from '../../hooks/HookDiscovery'

export type HookTrustRecord = {
  identity: string
  contentHash: string
}

export type HookSettingsState = {
  version: 1
  disabledIdentities: string[]
  trustedHashes: Record<string, string>
  generation: number
  updatedAt: number
  operations: Array<{
    operationId: string
    identity: string
    enabled: boolean
    generation: number
    updatedAt: number
  }>
  trustOperations: Array<{
    operationId: string
    hooks: HookTrustRecord[]
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
const SHA256_HEX = /^[a-f\d]{64}$/i

const defaultState = (): HookSettingsState => ({
  version: 1,
  disabledIdentities: [],
  trustedHashes: {},
  generation: 1,
  updatedAt: 0,
  operations: [],
  trustOperations: [],
})

const normalizeTrustRecords = (raw: unknown): HookTrustRecord[] | null => {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: HookTrustRecord[] = []
  for (const item of raw) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof (item as { identity?: unknown }).identity !== 'string' ||
      typeof (item as { contentHash?: unknown }).contentHash !== 'string'
    ) {
      return null
    }
    const identity = (item as { identity: string }).identity.toLowerCase()
    const contentHash = (item as { contentHash: string }).contentHash.toLowerCase()
    if (!SHA256_HEX.test(identity) || !SHA256_HEX.test(contentHash)) return null
    out.push({ identity, contentHash })
  }
  return out
}

const normalizeState = (value: HookSettingsState | null): HookSettingsState => {
  if (!value || value.version !== 1) return defaultState()
  const trustedHashes: Record<string, string> = {}
  if (
    value.trustedHashes &&
    typeof value.trustedHashes === 'object' &&
    !Array.isArray(value.trustedHashes)
  ) {
    for (const [identity, hash] of Object.entries(value.trustedHashes)) {
      if (typeof hash === 'string' && SHA256_HEX.test(identity) && SHA256_HEX.test(hash)) {
        trustedHashes[identity.toLowerCase()] = hash.toLowerCase()
      }
    }
  }
  return {
    version: 1,
    disabledIdentities: [
      ...new Set(
        Array.isArray(value.disabledIdentities)
          ? value.disabledIdentities
              .filter((hash) => typeof hash === 'string' && SHA256_HEX.test(hash))
              .map((hash) => hash.toLowerCase())
          : [],
      ),
    ],
    trustedHashes,
    generation:
      Number.isSafeInteger(value.generation) && value.generation >= 1 ? value.generation : 1,
    updatedAt: Number.isFinite(value.updatedAt) && value.updatedAt >= 0 ? value.updatedAt : 0,
    operations: Array.isArray(value.operations)
      ? value.operations
          .filter(
            (operation) =>
              operation &&
              typeof operation.operationId === 'string' &&
              typeof operation.identity === 'string' &&
              SHA256_HEX.test(operation.identity) &&
              typeof operation.enabled === 'boolean' &&
              Number.isSafeInteger(operation.generation) &&
              operation.generation >= 1 &&
              Number.isFinite(operation.updatedAt) &&
              operation.updatedAt >= 0,
          )
          .slice(-MAX_OPERATIONS)
      : [],
    trustOperations: Array.isArray(value.trustOperations)
      ? value.trustOperations
          .flatMap((operation) => {
            if (
              !operation ||
              typeof operation.operationId !== 'string' ||
              !Number.isSafeInteger(operation.generation) ||
              operation.generation < 1 ||
              !Number.isFinite(operation.updatedAt) ||
              operation.updatedAt < 0
            ) {
              return []
            }
            const hooks = normalizeTrustRecords(operation.hooks)
            if (!hooks) return []
            return [
              {
                operationId: operation.operationId,
                hooks,
                generation: operation.generation,
                updatedAt: operation.updatedAt,
              },
            ]
          })
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

  trustedHashes() {
    return new Map(Object.entries(this.state().trustedHashes))
  }

  trustStatusFor(
    hook: {
      kind: 'config' | 'plugin'
      scope: 'user' | 'project'
      identity: string
      contentHash: string
    },
    options?: {
      projectConfigAllowed?: boolean
      trustedMap?: ReadonlyMap<string, string>
    },
  ): HookTrustStatus {
    if (!hookRequiresTrust(hook)) return 'trusted'
    const trusted = options?.trustedMap ?? this.trustedHashes()
    const saved = trusted.get(hook.identity.toLowerCase())
    if (saved === hook.contentHash.toLowerCase()) return 'trusted'
    if (saved !== undefined) return 'modified'
    if (hook.kind === 'config' && hook.scope === 'project' && options?.projectConfigAllowed) {
      return 'trusted'
    }
    return 'untrusted'
  }

  setEnabled(input: { identity: string; enabled: boolean; operationId: string }) {
    const identity = input.identity.toLowerCase()
    const state = this.state()
    const existing = state.operations.find(
      (operation) => operation.operationId === input.operationId,
    )
    if (existing) {
      if (existing.identity.toLowerCase() !== identity || existing.enabled !== input.enabled) {
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
    const wasEnabled = !disabled.has(identity)
    if (input.enabled) disabled.delete(identity)
    else disabled.add(identity)
    const changed = wasEnabled !== input.enabled
    const updatedAt = changed ? Date.now() : state.updatedAt
    const generation = changed ? state.generation + 1 : state.generation
    const next: HookSettingsState = {
      ...state,
      version: 1,
      disabledIdentities: [...disabled].sort(),
      generation,
      updatedAt,
      operations: [
        ...state.operations,
        {
          operationId: input.operationId,
          identity,
          enabled: input.enabled,
          generation,
          updatedAt,
        },
      ].slice(-MAX_OPERATIONS),
    }
    this.database.setSetting(SETTINGS_KEY, next)
    return { state: next, changed }
  }

  trustHooks(input: { hooks: readonly HookTrustRecord[]; operationId: string }) {
    const deduped = new Map<string, string>()
    for (const item of input.hooks) {
      const identity = item.identity.toLowerCase()
      const contentHash = item.contentHash.toLowerCase()
      const prev = deduped.get(identity)
      if (prev !== undefined && prev !== contentHash) {
        throw new HookSettingsConflictError('同一请求中存在冲突的 Hook 指纹')
      }
      deduped.set(identity, contentHash)
    }
    const normalizedHooks: HookTrustRecord[] = [...deduped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([identity, contentHash]) => ({ identity, contentHash }))

    const state = this.state()
    const existing = state.trustOperations.find(
      (operation) => operation.operationId === input.operationId,
    )
    if (existing) {
      if (JSON.stringify(existing.hooks) !== JSON.stringify(normalizedHooks)) {
        throw new HookSettingsConflictError('operationId 已用于其他 Hook 信任请求')
      }
      return {
        state: {
          ...state,
          generation: existing.generation,
          updatedAt: existing.updatedAt,
        },
        trusted: existing.hooks,
        changed: false,
      }
    }

    const nextTrusted: Record<string, string> = { ...state.trustedHashes }
    const disabled = new Set(state.disabledIdentities)
    let changed = false
    for (const item of normalizedHooks) {
      if (nextTrusted[item.identity] !== item.contentHash) {
        nextTrusted[item.identity] = item.contentHash
        changed = true
      }
      if (disabled.delete(item.identity)) {
        changed = true
      }
    }

    const updatedAt = changed ? Date.now() : state.updatedAt
    const generation = changed ? state.generation + 1 : state.generation
    const next: HookSettingsState = {
      ...state,
      version: 1,
      disabledIdentities: [...disabled].sort(),
      trustedHashes: nextTrusted,
      generation,
      updatedAt,
      trustOperations: [
        ...state.trustOperations,
        {
          operationId: input.operationId,
          hooks: normalizedHooks,
          generation,
          updatedAt,
        },
      ].slice(-MAX_OPERATIONS),
    }
    this.database.setSetting(SETTINGS_KEY, next)
    return { state: next, trusted: normalizedHooks, changed }
  }
}
