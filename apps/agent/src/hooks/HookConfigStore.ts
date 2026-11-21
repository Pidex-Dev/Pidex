import { createHash } from 'node:crypto'
import { isRecord as isObject } from '@pidex/shared/guards'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import type { ConfigObject } from '../config/ConfigService'
import type { HookDefinition } from './HookDefinitions'
import { HookConfigError, MAX_HOOK_CONFIG_BYTES, parseHookDefinitions } from './HookDefinitions'

const sha256Hex = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

/**
 * Document shapes accepted by the loader. Only three exist, and each one is
 * reproduced exactly on write so hand-authored structure is never replaced.
 */
export type HookDocumentShape = 'bare-array' | 'object-array' | 'config-array' | 'id-map'

export type HookDocumentItem = {
  id: string
  /** The original object; unknown keys are preserved verbatim. */
  raw: Record<string, unknown>
}

export type HookDocument = {
  shape: HookDocumentShape
  items: HookDocumentItem[]
  /** Keys beside `hooks` (file/object-array) or beside `config` (config-array). */
  extra: Record<string, unknown>
}

const contained = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Effective definitions. For `id-map` the loader has always let an explicit
 * `id` inside the value override the map key, so management keeps that same
 * precedence instead of inventing a second identity.
 */
const definitionsOf = (
  items: readonly HookDocumentItem[],
  origin: string,
  shape: HookDocumentShape,
) =>
  parseHookDefinitions(
    items.map((item) =>
      shape === 'id-map' ? { id: item.id, ...item.raw } : { ...item.raw, id: item.id },
    ),
    origin,
  )

/**
 * Parses one Hook document into a shape-preserving editable model. Every shape
 * is validated through `parseHookDefinitions`, so runtime and management agree.
 */
export const decodeHookDocument = (
  parsed: unknown,
  origin: string,
  kind: 'file' | 'inline',
): HookDocument => {
  if (Array.isArray(parsed)) {
    const hooks = parseHookDefinitions(parsed, origin)
    return {
      shape: 'bare-array',
      items: parsed.map((value, index) => ({
        id: hooks[index]!.id,
        raw: { ...(value as Record<string, unknown>) },
      })),
      extra: {},
    }
  }
  if (!isObject(parsed))
    throw new HookConfigError('HOOK_INVALID', `Hook 配置必须是对象或数组: ${origin}`)

  const hooksValue = parsed.hooks
  if (hooksValue === undefined || hooksValue === null)
    return { shape: 'object-array', items: [], extra: {} }
  if (kind === 'inline' && isObject(hooksValue) && !Array.isArray(hooksValue)) {
    const table = hooksValue
    if (Array.isArray(table.config)) {
      const hooks = parseHookDefinitions(table.config, origin)
      return {
        shape: 'config-array',
        items: table.config.map((value, index) => ({
          id: hooks[index]!.id,
          raw: { ...(value as Record<string, unknown>) },
        })),
        extra: Object.fromEntries(Object.entries(table).filter(([key]) => key !== 'config')),
      }
    }
    const entries = Object.entries(table).filter(([, value]) => isObject(value))
    const rawItems = entries.map(([key, value]) => ({
      id: key,
      raw: { ...(value as Record<string, unknown>) },
    }))
    // Canonicalise to the effective id so later edit/delete address one row.
    const definitions = definitionsOf(rawItems, origin, 'id-map')
    return {
      shape: 'id-map',
      items: rawItems.map((item, index) => ({ ...item, id: definitions[index]!.id })),
      extra: {},
    }
  }

  if (!Array.isArray(hooksValue))
    throw new HookConfigError('HOOK_INVALID', `Hook 配置必须包含 hooks 数组: ${origin}`)
  const hooks = parseHookDefinitions(hooksValue, origin)
  return {
    shape: 'object-array',
    items: hooksValue.map((value, index) => ({
      id: hooks[index]!.id,
      raw: { ...(value as Record<string, unknown>) },
    })),
    // Only standalone files carry sibling root keys forward; inline config
    // writes target `hooks` alone, so the surrounding document is untouched.
    extra:
      kind === 'file'
        ? Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'hooks'))
        : {},
  }
}

/** Synchronous standalone-file reader used by the runtime loader. */
export const readStandaloneHookFile = (filePath: string, containmentRoot?: string) => {
  const canonical = realpathSync(filePath)
  if (containmentRoot && !contained(realpathSync(containmentRoot), canonical))
    throw new HookConfigError('HOOK_INVALID', `Hook 配置逃出 workspace: ${filePath}`)
  const bytes = readFileSync(canonical)
  if (bytes.byteLength > MAX_HOOK_CONFIG_BYTES)
    throw new HookConfigError('HOOK_INVALID', `Hook 配置超过 ${MAX_HOOK_CONFIG_BYTES} bytes`)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const document = decodeHookDocument(JSON.parse(text) as unknown, filePath, 'file')
  return {
    definitions: definitionsOf(document.items, filePath, document.shape),
    canonical,
    hash: sha256Hex(bytes),
  }
}

export const hookFileExists = (path: string) => existsSync(path)

/**
 * Inline `config.hooks` definitions for the runtime loader. Shares
 * `decodeHookDocument` with management so both accept exactly the same shapes
 * (array, `{ config: [...] }`, or an id-keyed object).
 */
export const inlineHookDefinitions = (config: ConfigObject, source: string): HookDefinition[] => {
  const document = decodeHookDocument(config, source, 'inline')
  return definitionsOf(document.items, source, document.shape)
}
