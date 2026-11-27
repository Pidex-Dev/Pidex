import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isRecord } from '@pidex/shared/guards'
import { isMissingFileError, writeJsonAtomically } from '../windows/DebouncedAtomicJsonWriter.js'
import type {
  DesktopDataLocationChange,
  DesktopDataLocationState,
} from '@pidex/shared/desktop-data-location-ipc'

const FILE_NAME = 'data-location.json'

type PendingDataLocation = {
  operationId: string
  sourceDataDir: string
  targetDataDir: string
}

type DataLocationBootstrap = {
  version: 1
  activeDataDir: string | null
  pending?: PendingDataLocation
}

export type DataLocationLaunch = {
  dataDir: string
  relocation: PendingDataLocation | null
}

export class DataLocationBootstrapError extends Error {}

export class DataLocationStore {
  readonly #filePath: string
  readonly #defaultDataDir: string
  readonly #environmentDataDir: string | null

  constructor(
    userDataDirectory: string,
    defaultDataDir: string,
    environmentDataDir: string | null,
  ) {
    this.#filePath = join(resolve(userDataDirectory), FILE_NAME)
    this.#defaultDataDir = resolve(defaultDataDir)
    this.#environmentDataDir = environmentDataDir ? resolve(environmentDataDir) : null
  }

  async #readBootstrap(): Promise<DataLocationBootstrap> {
    let source: string
    try {
      source = await readFile(this.#filePath, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) return { version: 1, activeDataDir: null }
      throw new DataLocationBootstrapError(
        '无法读取 data-location.json，请检查文件访问权限后重试。',
      )
    }
    try {
      return normalizeBootstrap(JSON.parse(source))
    } catch (error) {
      if (error instanceof DataLocationBootstrapError) throw error
      throw new DataLocationBootstrapError(
        'data-location.json 的内容无效，请修复数据目录定位文件后重试。',
      )
    }
  }

  async state(): Promise<DesktopDataLocationState> {
    const value = this.#environmentDataDir ? null : await this.#readBootstrap()
    return {
      defaultDataDir: this.#defaultDataDir,
      currentDataDir: this.#environmentDataDir ?? value?.activeDataDir ?? this.#defaultDataDir,
      pendingDataDir: value?.pending?.targetDataDir ?? null,
      controlSource: this.#environmentDataDir
        ? 'env'
        : value?.activeDataDir
          ? 'bootstrap'
          : 'default',
      isEnvControlled: this.#environmentDataDir !== null,
    }
  }

  async launch(): Promise<DataLocationLaunch> {
    if (this.#environmentDataDir) {
      return { dataDir: this.#environmentDataDir, relocation: null }
    }
    const value = await this.#readBootstrap()
    if (value.pending) {
      return {
        dataDir: value.pending.targetDataDir,
        relocation: value.pending,
      }
    }
    return {
      dataDir: value.activeDataDir ?? this.#defaultDataDir,
      relocation: null,
    }
  }

  async schedule(
    selectedParent: string,
    installDirectory: string,
    workspaceRoots: readonly string[] = [],
  ): Promise<DesktopDataLocationChange> {
    if (this.#environmentDataDir) {
      throw new Error('当前数据目录由 PIDEX_DATA_DIR 控制')
    }
    const parent = requireLocalAbsolutePath(selectedParent)
    if (basename(parent).toLowerCase() === '.pidex') {
      throw new Error('请选择 .pidex 的父目录')
    }
    const targetDataDir = resolve(parent, '.pidex')
    if ((await pathExists(targetDataDir)) && !(await isEmptyDirectory(targetDataDir))) {
      throw new Error('目标 .pidex 目录必须为空')
    }
    const value = await this.#readBootstrap()
    const sourceDataDir = value.activeDataDir ?? this.#defaultDataDir
    if (samePath(sourceDataDir, targetDataDir)) {
      throw new Error('所选位置就是当前数据目录')
    }
    if (
      pathsOverlap(targetDataDir, installDirectory) ||
      pathsOverlap(targetDataDir, sourceDataDir)
    ) {
      throw new Error('目标目录不能位于安装目录或当前数据目录内')
    }
    if (workspaceRoots.some((workspaceRoot) => pathsOverlap(targetDataDir, workspaceRoot))) {
      throw new Error('目标数据目录不能与已注册工作区互相包含')
    }
    const pending = {
      operationId: randomUUID(),
      sourceDataDir: resolve(sourceDataDir),
      targetDataDir,
    }
    await writeJsonAtomically(this.#filePath, { ...value, pending })
    return {
      sourceDataDir: pending.sourceDataDir,
      targetDataDir: pending.targetDataDir,
      restartScheduled: true,
    }
  }

  async promotePending(operationId: string): Promise<void> {
    if (this.#environmentDataDir) return
    const { pending, ...value } = await this.#readBootstrap()
    if (!pending) return
    if (pending.operationId !== operationId) {
      throw new DataLocationBootstrapError('待迁移的数据位置已更改，请重新启动 Pidex。')
    }
    await writeJsonAtomically(this.#filePath, {
      ...value,
      activeDataDir: pending.targetDataDir,
    })
  }

  async restoreActive(): Promise<void> {
    if (this.#environmentDataDir) return
    const { pending, ...value } = await this.#readBootstrap()
    if (pending) await writeJsonAtomically(this.#filePath, value)
  }
}

function normalizeBootstrap(value: unknown): DataLocationBootstrap {
  if (!isRecord(value)) throw new Error('invalid data location')
  if (value.version !== 1) {
    throw new DataLocationBootstrapError(
      '当前 Pidex 无法识别 data-location.json 的版本，请使用支持该版本的客户端。',
    )
  }
  if (value.activeDataDir !== null && typeof value.activeDataDir !== 'string') {
    throw new Error('invalid active data location')
  }
  return {
    ...value,
    version: 1,
    activeDataDir:
      value.activeDataDir === null ? null : requireLocalAbsolutePath(value.activeDataDir),
    ...(value.pending === undefined ? {} : { pending: normalizePending(value.pending) }),
  }
}

function normalizePending(value: unknown): PendingDataLocation {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !/^[a-zA-Z0-9-]{8,128}$/.test(value.operationId) ||
    typeof value.sourceDataDir !== 'string' ||
    typeof value.targetDataDir !== 'string'
  )
    throw new Error('invalid pending data location')
  return {
    ...value,
    operationId: value.operationId,
    sourceDataDir: requireLocalAbsolutePath(value.sourceDataDir),
    targetDataDir: requireLocalAbsolutePath(value.targetDataDir),
  }
}

function requireLocalAbsolutePath(value: string): string {
  const normalized = resolve(value)
  if (!isAbsolute(value) || value.startsWith('\\\\')) {
    throw new Error('数据目录必须是本地绝对路径')
  }
  return normalized
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left)
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(resolve(parent), resolve(child))
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`))
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false)
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0
  } catch {
    return false
  }
}
