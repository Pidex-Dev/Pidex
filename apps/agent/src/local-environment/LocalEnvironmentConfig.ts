import { omitUndefined } from '../OmitUndefined'
import type { ConfigObject } from '../config/ConfigService'
import {
  LOCAL_ENVIRONMENT_SCHEMA_VERSION,
  type LocalEnvironmentAction,
  type LocalEnvironmentConfig,
  type PlatformCommand,
} from './Types'

export class LocalEnvironmentConfigError extends Error {
  readonly code = 'LOCAL_ENVIRONMENT_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'LocalEnvironmentConfigError'
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmpty = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LocalEnvironmentConfigError(`${path} 必须是非空字符串`)
  }
  return value
}

const optionalString = (value: unknown, path: string): string | undefined => {
  if (value === undefined) return undefined
  return nonEmpty(value, path)
}

const platformCommand = (value: unknown, path: string): PlatformCommand => {
  if (!isObject(value)) throw new LocalEnvironmentConfigError(`${path} 必须是对象`)
  return {
    script: nonEmpty(value.script, `${path}.script`),
    ...omitUndefined({
      windows: optionalString(value.windows, `${path}.windows`),
      macos: optionalString(value.macos, `${path}.macos`),
      linux: optionalString(value.linux, `${path}.linux`),
    }),
  }
}

const action = (value: unknown, index: number): LocalEnvironmentAction => {
  const path = `actions[${index}]`
  if (!isObject(value)) throw new LocalEnvironmentConfigError(`${path} 必须是对象`)
  const icon = optionalString(value.icon, `${path}.icon`)
  const windows = optionalString(value.windows, `${path}.windows`)
  const macos = optionalString(value.macos, `${path}.macos`)
  const linux = optionalString(value.linux, `${path}.linux`)
  return {
    name: nonEmpty(value.name, `${path}.name`),
    command: nonEmpty(value.command, `${path}.command`),
    ...omitUndefined({ icon, windows, macos, linux }),
  }
}

export const parseLocalEnvironmentConfig = (value: ConfigObject): LocalEnvironmentConfig => {
  if (value.schema_version !== LOCAL_ENVIRONMENT_SCHEMA_VERSION) {
    throw new LocalEnvironmentConfigError(
      `schema_version 必须为 ${LOCAL_ENVIRONMENT_SCHEMA_VERSION}`,
    )
  }
  const actionsValue = value.actions ?? []
  if (!Array.isArray(actionsValue)) throw new LocalEnvironmentConfigError('actions 必须是数组')
  const actions = actionsValue.map(action)
  const names = new Set<string>()
  for (const item of actions) {
    const key = item.name.toLocaleLowerCase()
    if (names.has(key)) throw new LocalEnvironmentConfigError(`action 名称重复：${item.name}`)
    names.add(key)
  }
  return {
    schema_version: LOCAL_ENVIRONMENT_SCHEMA_VERSION,
    name: nonEmpty(value.name, 'name'),
    ...(value.setup !== undefined ? { setup: platformCommand(value.setup, 'setup') } : {}),
    ...(value.cleanup !== undefined ? { cleanup: platformCommand(value.cleanup, 'cleanup') } : {}),
    actions,
  }
}
