import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ConfigObject, ConfigService, ConfigValue } from '../config/ConfigService'
import type { InstalledSkill } from '@pidex/agent-protocol'
import {
  SkillSettingsConflictError,
  SkillSettingsRepository,
} from '../storage/repositories/SkillSettingsRepository'
import {
  parseSkillDocument,
  SkillService,
  type PluginSkillRoot,
  type SkillMetadata,
  type SkillScanOptions,
} from './SkillService'

const execFileAsync = promisify(execFile)
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/
const MAX_SKILL_BYTES = 1024 * 1024

const contained = (root: string, candidate: string) => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

type SkillStorageRoots = {
  dataRoot: string
  userHome: string
  builtinSkillsRoot?: string
}

export class SkillManagementError extends Error {
  constructor(
    readonly code: 'SKILL_NOT_FOUND' | 'PATH_DENIED' | 'CONFLICT' | 'SKILL_INVALID' | 'INTERNAL_ERROR',
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const normalizedIdentityPath = (path: string) => {
  if (path.startsWith('builtin://') || path.startsWith('plugin://')) {
    return path.toLowerCase()
  }
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

const builtinPath = (path: string) => path.startsWith('builtin://')

const workspaceRootForSkill = (path: string) => {
  const normalized = resolve(path).replaceAll('\\', '/')
  for (const marker of [
    '/.pidex/skills/',
    '/.agents/skills/',
    '/.codex/skills/',
    '/.claude/skills/',
  ]) {
    const index = normalized.toLowerCase().indexOf(marker)
    if (index >= 0) return normalized.slice(0, index)
  }
  return null
}

export const skillPathIdentity = (path: string) =>
  createHash('sha256').update(normalizedIdentityPath(path), 'utf8').digest('hex')

const toInstalledSkill = (skill: SkillMetadata, disabled: ReadonlySet<string>): InstalledSkill => ({
  name: skill.name,
  description: skill.description,
  path: skill.path,
  // Keep thread-rpc-v4 wire-compatible while the desktop maps builtin:// to “内置”.
  scope: skill.origin === 'builtin' ? 'user' : skill.origin,
  format: skill.format,
  enabled: !disabled.has(skillPathIdentity(skill.path)),
})

export class SkillManagementService {
  private readonly knownSkills = new Map<string, SkillMetadata>()

  constructor(
    private readonly settings: SkillSettingsRepository,
    private readonly roots: SkillStorageRoots,
    private readonly configService?: ConfigService,
    private readonly pluginSkillRoots?: (
      workspaceRoot?: string,
    ) => Promise<readonly PluginSkillRoot[]>,
  ) {}

  runtimeService() {
    const disabled = this.configuredDisabled(
      this.settings.disabledPathHashes(),
      this.configService?.snapshot() ?? {},
    )
    return new SkillService({
      ...(this.roots.builtinSkillsRoot ? { builtinSkillsRoot: this.roots.builtinSkillsRoot } : {}),
      ...(this.pluginSkillRoots ? { pluginSkillRoots: this.pluginSkillRoots } : {}),
      enabled: (skill) => !disabled.has(skillPathIdentity(skill.path)),
    })
  }

  async list(input: { workspace?: string | undefined; forceReload?: boolean | undefined } = {}) {
    const catalog = await this.scan(input.workspace)
    const state = this.settings.state()
    const config = this.configService
      ? (await this.configService.read(input.workspace ? { cwd: input.workspace } : {})).config
      : {}
    const disabled = this.configuredDisabled(new Set(state.disabledPathHashes), config)
    for (const skill of catalog.skills) {
      this.knownSkills.set(normalizedIdentityPath(skill.path), skill)
    }
    return {
      skills: catalog.skills.map((skill) => toInstalledSkill(skill, disabled)),
      generation: state.generation,
      updatedAt: state.updatedAt,
    }
  }

  async read(input: { workspace?: string | undefined; path: string }) {
    const skill = await this.resolveDiscoveredSkill(input.path, input.workspace)
    const state = this.settings.state()
    try {
      const loaded = await this.scanService(input.workspace).then(({ service }) =>
        service.read(skill.name),
      )
      if (normalizedIdentityPath(loaded.path) !== normalizedIdentityPath(skill.path)) {
        throw new SkillManagementError('SKILL_NOT_FOUND', '技能不存在或已被替换', 404)
      }
      return {
        skill: toInstalledSkill(skill, new Set(state.disabledPathHashes)),
        content: loaded.content,
      }
    } catch (cause) {
      if (cause instanceof SkillManagementError) throw cause
      throw new SkillManagementError('SKILL_NOT_FOUND', '技能不存在或无法读取', 404)
    }
  }

  async setEnabled(input: { path: string; enabled: boolean; operationId: string }) {
    const skill = await this.resolveKnownSkill(input.path)
    try {
      const result = this.settings.setEnabled({
        pathHash: skillPathIdentity(skill.path),
        enabled: input.enabled,
        operationId: input.operationId,
      })
      if (this.configService && !builtinPath(skill.path)) {
        const workspaceRoot =
          skill.origin === 'workspace' ? workspaceRootForSkill(skill.path) : null
        const target = workspaceRoot
          ? {
              filePath: join(workspaceRoot, '.pidex', 'config.json'),
              cwd: workspaceRoot,
            }
          : {}
        const read = await this.configService.read(workspaceRoot ? { cwd: workspaceRoot } : {})
        const skills = read.config.skills
        const existing =
          skills &&
          typeof skills === 'object' &&
          !Array.isArray(skills) &&
          Array.isArray((skills as ConfigObject).config)
            ? ((skills as ConfigObject).config as ConfigValue[])
            : []
        const normalizedPath = normalizedIdentityPath(skill.path)
        const entries = existing.filter(
          (entry) =>
            !entry ||
            typeof entry !== 'object' ||
            Array.isArray(entry) ||
            normalizedIdentityPath(String(entry.path ?? '')) !== normalizedPath,
        )
        entries.push({ path: skill.path, enabled: input.enabled })
        await this.configService.writeValue({
          keyPath: ['skills', 'config'],
          value: entries,
          ...target,
        })
      }
      return {
        result: {
          skill: {
            ...toInstalledSkill(skill, new Set(result.state.disabledPathHashes)),
            enabled: input.enabled,
          },
          generation: result.state.generation,
          updatedAt: result.state.updatedAt,
        },
        changed: result.changed,
      }
    } catch (cause) {
      if (cause instanceof SkillSettingsConflictError) {
        throw new SkillManagementError('CONFLICT', cause.message, 409)
      }
      throw cause
    }
  }

  private configuredDisabled(base: Set<string>, config: ConfigObject) {
    const disabled = new Set(base)
    const skills = config.skills
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return disabled
    const entries = Array.isArray((skills as ConfigObject).config)
      ? ((skills as ConfigObject).config as ConfigValue[])
      : []
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (typeof entry.path !== 'string' || typeof entry.enabled !== 'boolean') continue
      const identity = skillPathIdentity(entry.path)
      if (entry.enabled) disabled.delete(identity)
      else disabled.add(identity)
    }
    return disabled
  }

  private scanOptions(workspace?: string): SkillScanOptions {
    return {
      workspaceRoot: workspace ?? this.roots.userHome,
      dataRoot: this.roots.dataRoot,
      userHome: this.roots.userHome,
      ...(this.roots.builtinSkillsRoot ? { builtinSkillsRoot: this.roots.builtinSkillsRoot } : {}),
      includeWorkspace: workspace !== undefined,
    }
  }

  private async scanService(workspace?: string) {
    const service = new SkillService(
      this.roots.builtinSkillsRoot ? { builtinSkillsRoot: this.roots.builtinSkillsRoot } : {},
    )
    try {
      const catalog = await service.scan(this.scanOptions(workspace))
      return { service, catalog }
    } catch {
      throw new SkillManagementError('INTERNAL_ERROR', '技能目录扫描失败', 500)
    }
  }

  private async scan(workspace?: string) {
    return (await this.scanService(workspace)).catalog
  }

  private async canonicalRequestedPath(path: string) {
    if (!isAbsolute(path)) {
      throw new SkillManagementError('PATH_DENIED', '技能路径必须是绝对路径', 403)
    }
    try {
      return await realpath(path)
    } catch {
      throw new SkillManagementError('SKILL_NOT_FOUND', '技能不存在', 404)
    }
  }

  private async resolveDiscoveredSkill(path: string, workspace?: string) {
    const canonical = builtinPath(path)
      ? normalizedIdentityPath(path)
      : await this.canonicalRequestedPath(path)
    const catalog = await this.scan(workspace)
    const skill = catalog.skills.find(
      (candidate) => normalizedIdentityPath(candidate.path) === normalizedIdentityPath(canonical),
    )
    if (!skill)
      throw new SkillManagementError('SKILL_NOT_FOUND', '技能不存在或不在允许的技能目录中', 404)
    this.knownSkills.set(normalizedIdentityPath(skill.path), skill)
    return skill
  }

  private async resolveKnownSkill(path: string) {
    const canonical = builtinPath(path)
      ? normalizedIdentityPath(path)
      : await this.canonicalRequestedPath(path)
    const skill = this.knownSkills.get(normalizedIdentityPath(canonical))
    if (!skill) throw new SkillManagementError('SKILL_NOT_FOUND', '技能不存在或尚未发现', 404)
    return skill
  }

  resolveSkillTargetDir(scope: 'user' | 'project', name: string, workspace?: string) {
    const trimmed = name.trim()
    if (!SKILL_NAME_PATTERN.test(trimmed)) {
      throw new SkillManagementError(
        'SKILL_INVALID',
        'Skill 名称无效，仅支持字母、数字、连字符和下划线（1-64 字符）',
        400,
      )
    }
    if (scope === 'project') {
      if (!workspace) {
        throw new SkillManagementError('PATH_DENIED', '项目级 Skill 需要绑定工作区路径', 403)
      }
      const root = join(resolve(workspace), '.pidex', 'skills')
      const dir = join(root, trimmed)
      if (!contained(root, dir)) {
        throw new SkillManagementError('PATH_DENIED', 'Skill 目标路径越界', 403)
      }
      return { root, dir, name: trimmed, documentPath: join(dir, 'SKILL.md') }
    }
    const root = join(resolve(this.roots.dataRoot), 'skills')
    const dir = join(root, trimmed)
    if (!contained(root, dir)) {
      throw new SkillManagementError('PATH_DENIED', 'Skill 目标路径越界', 403)
    }
    return { root, dir, name: trimmed, documentPath: join(dir, 'SKILL.md') }
  }

  private async validateSkillFile(documentPath: string) {
    const raw = await readFile(documentPath, 'utf8').catch(() => {
      throw new SkillManagementError('SKILL_INVALID', '缺少有效的 SKILL.md 文件', 400)
    })
    if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_BYTES) {
      throw new SkillManagementError('SKILL_INVALID', 'SKILL.md 体积超过 1MB 限制', 400)
    }
    let parsed: { metadata: Record<string, unknown>; body: string }
    try {
      parsed = parseSkillDocument(raw)
    } catch (cause) {
      throw new SkillManagementError(
        'SKILL_INVALID',
        cause instanceof Error ? cause.message : 'SKILL.md frontmatter 格式无效',
        400,
      )
    }
    if (!parsed.body.trim()) {
      throw new SkillManagementError('SKILL_INVALID', 'SKILL.md 正文不能为空', 400)
    }
    return { content: raw, parsed }
  }

  async saveSkill(input: {
    scope: 'user' | 'project'
    workspace?: string | undefined
    name: string
    description?: string | undefined
    body?: string | undefined
    content?: string | undefined
    overwrite?: boolean | undefined
  }) {
    const target = this.resolveSkillTargetDir(input.scope, input.name, input.workspace)
    const exists = await lstat(target.dir).catch((cause: NodeJS.ErrnoException) =>
      cause.code === 'ENOENT' ? null : Promise.reject(cause),
    )
    if (exists && !input.overwrite) {
      throw new SkillManagementError('CONFLICT', `Skill "${target.name}" 已存在`, 409)
    }
    const documentContent =
      input.content?.trim()
        ? input.content
        : [
            '---',
            `name: ${target.name}`,
            `description: ${JSON.stringify(input.description?.trim() || `${target.name} skill`)}`,
            '---',
            '',
            (input.body ?? '').trim(),
            '',
          ].join('\n')

    if (Buffer.byteLength(documentContent, 'utf8') > MAX_SKILL_BYTES) {
      throw new SkillManagementError('SKILL_INVALID', 'SKILL.md 体积超过 1MB 限制', 400)
    }
    let parsed: { metadata: Record<string, unknown>; body: string }
    try {
      parsed = parseSkillDocument(documentContent)
    } catch (cause) {
      throw new SkillManagementError(
        'SKILL_INVALID',
        cause instanceof Error ? cause.message : 'SKILL.md frontmatter 格式无效',
        400,
      )
    }
    if (!parsed.body.trim()) {
      throw new SkillManagementError('SKILL_INVALID', 'SKILL.md 正文不能为空', 400)
    }

    await mkdir(target.dir, { recursive: true })
    await writeFile(target.documentPath, documentContent, 'utf8')
    const listed = await this.list({ workspace: input.workspace, forceReload: true })
    const canonicalDoc = await realpath(target.documentPath)
    const skill = listed.skills.find(
      (item) => normalizedIdentityPath(item.path) === normalizedIdentityPath(canonicalDoc),
    )
    return {
      skill: skill ?? null,
      path: canonicalDoc,
      content: documentContent,
      generation: listed.generation,
    }
  }

  async installSkill(input: {
    scope: 'user' | 'project'
    workspace?: string | undefined
    source:
      | { kind: 'local'; path: string }
      | { kind: 'git'; url: string; ref?: string | undefined; subpath?: string | undefined }
    name?: string | undefined
    overwrite?: boolean | undefined
  }) {
    const parentRoot =
      input.scope === 'project'
        ? input.workspace
          ? join(resolve(input.workspace), '.pidex', 'skills')
          : (() => {
              throw new SkillManagementError('PATH_DENIED', '项目级 Skill 需要绑定工作区路径', 403)
            })()
        : join(resolve(this.roots.dataRoot), 'skills')
    await mkdir(parentRoot, { recursive: true })
    const stage = await mkdtemp(join(parentRoot, '.install-'))
    try {
      let sourceDir: string
      let inferredName: string
      if (input.source.kind === 'local') {
        const candidate = await realpath(resolve(input.source.path)).catch(() => {
          throw new SkillManagementError('SKILL_NOT_FOUND', '本地 Skill 源路径不存在', 404)
        })
        const stat = await lstat(candidate)
        if (!stat.isDirectory()) {
          throw new SkillManagementError('SKILL_INVALID', '本地 Skill 源路径必须是目录', 400)
        }
        sourceDir = candidate
        inferredName = candidate.split(/[\\/]/).filter(Boolean).pop() ?? ''
      } else {
        let parsedUrl: URL
        try {
          parsedUrl = new URL(input.source.url)
        } catch {
          throw new SkillManagementError('SKILL_INVALID', 'Git 仓库 URL 无效', 400)
        }
        if (parsedUrl.protocol !== 'https:' || input.source.url.startsWith('-')) {
          throw new SkillManagementError('SKILL_INVALID', '仅支持 HTTPS Git 仓库地址', 400)
        }
        if (
          input.source.ref &&
          (input.source.ref.startsWith('-') ||
            input.source.ref.includes('..') ||
            !SAFE_GIT_REF_PATTERN.test(input.source.ref))
        ) {
          throw new SkillManagementError('SKILL_INVALID', 'Git ref 参数无效', 400)
        }
        if (
          input.source.subpath &&
          (isAbsolute(input.source.subpath) ||
            input.source.subpath.startsWith('-') ||
            input.source.subpath.split(/[\\/]+/).includes('..'))
        ) {
          throw new SkillManagementError('PATH_DENIED', 'Git subpath 参数无效', 403)
        }
        const cloneDir = join(stage, 'repo')
        const args = [
          'clone',
          '--depth',
          '1',
          ...(input.source.ref ? ['--branch', input.source.ref] : []),
          '--',
          input.source.url,
          cloneDir,
        ]
        try {
          await execFileAsync('git', args, { timeout: 60_000 })
        } catch (cause) {
          const detail = cause instanceof Error && cause.message ? `：${cause.message}` : ''
          throw new SkillManagementError('SKILL_INVALID', `拉取远程 Skill 仓库失败${detail}`, 502)
        }
        await rm(join(cloneDir, '.git'), { recursive: true, force: true })
        const candidate = input.source.subpath
          ? resolve(cloneDir, input.source.subpath)
          : cloneDir
        if (!contained(cloneDir, candidate)) {
          throw new SkillManagementError('PATH_DENIED', '远程 Skill 子路径越界', 403)
        }
        const resolvedSource = await realpath(candidate).catch(() => null)
        if (!resolvedSource || !contained(cloneDir, resolvedSource)) {
          throw new SkillManagementError('SKILL_NOT_FOUND', '远程仓库中未找到指定 Skill 目录', 404)
        }
        sourceDir = resolvedSource
        inferredName =
          input.source.subpath?.split(/[\\/]/).filter(Boolean).pop() ??
          parsedUrl.pathname.split('/').filter(Boolean).pop()?.replace(/\.git$/i, '') ??
          ''
      }

      const { content, parsed } = await this.validateSkillFile(join(sourceDir, 'SKILL.md'))
      const frontmatterName =
        typeof parsed.metadata.name === 'string' && parsed.metadata.name.trim()
          ? parsed.metadata.name.trim()
          : undefined
      const skillName = input.name?.trim() || frontmatterName || inferredName
      const target = this.resolveSkillTargetDir(input.scope, skillName, input.workspace)
      const exists = await lstat(target.dir).catch((cause: NodeJS.ErrnoException) =>
        cause.code === 'ENOENT' ? null : Promise.reject(cause),
      )
      if (exists) {
        if (!input.overwrite) {
          throw new SkillManagementError('CONFLICT', `Skill "${target.name}" 已存在`, 409)
        }
        await rm(target.dir, { recursive: true, force: true })
      }
      await mkdir(dirname(target.dir), { recursive: true })
      await cp(sourceDir, target.dir, { recursive: true, dereference: false })
      const listed = await this.list({ workspace: input.workspace, forceReload: true })
      const canonicalDoc = await realpath(target.documentPath)
      const skill = listed.skills.find(
        (item) => normalizedIdentityPath(item.path) === normalizedIdentityPath(canonicalDoc),
      )
      return {
        skill: skill ?? null,
        path: canonicalDoc,
        content,
        generation: listed.generation,
      }
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async removeSkill(input: {
    scope: 'user' | 'project'
    workspace?: string | undefined
    name: string
  }) {
    const target = this.resolveSkillTargetDir(input.scope, input.name, input.workspace)
    const exists = await lstat(target.dir).catch((cause: NodeJS.ErrnoException) =>
      cause.code === 'ENOENT' ? null : Promise.reject(cause),
    )
    if (!exists) {
      throw new SkillManagementError('SKILL_NOT_FOUND', `Skill "${target.name}" 不存在`, 404)
    }
    if (exists.isSymbolicLink() || !exists.isDirectory()) {
      throw new SkillManagementError('PATH_DENIED', '目标 Skill 目录不可删除', 403)
    }
    const canonical = await realpath(target.dir)
    const canonicalRoot = await realpath(target.root)
    if (!contained(canonicalRoot, canonical)) {
      throw new SkillManagementError('PATH_DENIED', 'Skill 路径越界，拒绝删除', 403)
    }
    await rm(canonical, { recursive: true, force: true })
    const docPaths = [join(canonical, 'SKILL.md'), target.documentPath]
    const normalizedTargets = new Set(docPaths.map((path) => normalizedIdentityPath(path)))
    const identityHashes = new Set(docPaths.map((path) => skillPathIdentity(path)))
    for (const pathHash of identityHashes) {
      if (this.settings.disabledPathHashes().has(pathHash)) {
        this.settings.setEnabled({
          pathHash,
          enabled: true,
          operationId: `remove-skill:${crypto.randomUUID()}`,
        })
      }
    }
    if (this.configService) {
      const workspaceRoot = input.scope === 'project' ? input.workspace : undefined
      const configTarget = workspaceRoot
        ? {
            filePath: join(workspaceRoot, '.pidex', 'config.json'),
            cwd: workspaceRoot,
          }
        : {}
      const read = await this.configService.read(workspaceRoot ? { cwd: workspaceRoot } : {})
      const skills = read.config.skills
      const existing =
        skills &&
        typeof skills === 'object' &&
        !Array.isArray(skills) &&
        Array.isArray((skills as ConfigObject).config)
          ? ((skills as ConfigObject).config as ConfigValue[])
          : []
      const entries = existing.filter(
        (entry) =>
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          !normalizedTargets.has(normalizedIdentityPath(String(entry.path ?? ''))),
      )
      if (entries.length !== existing.length) {
        await this.configService.writeValue({
          keyPath: ['skills', 'config'],
          value: entries,
          ...configTarget,
        })
      }
    }
    const listed = await this.list({ workspace: input.workspace, forceReload: true })
    return {
      removed: target.name,
      scope: input.scope,
      generation: listed.generation,
    }
  }
}
