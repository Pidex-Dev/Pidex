import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/**
 * Markdown files under the Pidex data root are the only source of truth for
 * memory bodies. SQLite keeps ownership metadata, task state and usage records.
 */
export type MemoryNamespace =
  | { kind: 'user' }
  | { kind: 'project'; projectId: string }
  | { kind: 'agent'; projectId: string; memoryKey: string }

export const MEMORY_INDEX_FILE = 'MEMORY.md'
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]
export const MEMORY_INDEX_MAX_LINES = 200
export const MEMORY_INDEX_MAX_CHARS = 25_000
export const MEMORY_BODY_MAX_CHARS = 25_000
export const MEMORY_INJECT_BUDGET_CHARS = 8_000
export const MEMORY_READ_MAX_BYTES = 4_096

const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

export type MemoryFileDiagnostic = {
  path: string
  code: 'invalid-frontmatter' | 'invalid-type' | 'duplicate-name' | 'too-large' | 'case-alias'
  message: string
}

export type MemoryFileSummary = {
  path: string
  name: string | null
  description: string | null
  type: MemoryType | null
  revision: string
  size: number
  updatedAt: number
  indexed: boolean
  diagnostics: MemoryFileDiagnostic[]
}

export type MemoryFileContent = MemoryFileSummary & { content: string }

const hash = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex')

export const memoryNamespaceKey = (namespace: MemoryNamespace) =>
  namespace.kind === 'user'
    ? 'user'
    : namespace.kind === 'project'
      ? `project:${namespace.projectId}`
      : `agent:${namespace.projectId}:${namespace.memoryKey}`

/**
 * Inverse of `memoryNamespaceKey`: SQLite stores the flat key, the RPC wire
 * contract carries the structured union. Unknown keys stay unknown instead of
 * being guessed into a namespace.
 */
export const memoryNamespaceFromKey = (key: string): MemoryNamespace | null => {
  if (key === 'user') return { kind: 'user' }
  const project = /^project:([A-Za-z0-9_-]{1,64})$/.exec(key)
  if (project) return { kind: 'project', projectId: project[1]! }
  const agent = /^agent:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,64})$/.exec(key)
  if (agent) return { kind: 'agent', projectId: agent[1]!, memoryKey: agent[2]! }
  return null
}

export const memoryNamespaceLabel = (namespace: MemoryNamespace) =>
  namespace.kind === 'user'
    ? '用户'
    : namespace.kind === 'project'
      ? '项目'
      : `子 Agent ${namespace.memoryKey}`

/** Model-supplied identity stays lowercase ASCII; invalid values are rejected, never repaired. */
export const normalizeMemoryKey = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase()
  return IDENTIFIER.test(trimmed) ? trimmed : null
}

const assertIdentifier = (value: string, label: string) => {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 标识不合法`)
  return value
}

export const memoryNamespaceDirectory = (rootDirectory: string, namespace: MemoryNamespace) => {
  if (namespace.kind === 'user') return join(rootDirectory, 'user')
  const projectId = assertIdentifier(namespace.projectId, 'projectId')
  if (namespace.kind === 'project') return join(rootDirectory, 'projects', projectId)
  const memoryKey = assertIdentifier(namespace.memoryKey, 'memoryKey')
  return join(rootDirectory, 'projects', projectId, 'agents', memoryKey)
}

/**
 * Only flat Markdown files inside the namespace directory are addressable. Any
 * separator, drive letter or traversal segment is rejected instead of repaired.
 */
export const normalizeMemoryPath = (value: string): string => {
  const input = value.trim()
  if (!input || input.includes('\0')) throw new Error('记忆文件名不能为空')
  const normalized = input.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized))
    throw new Error('记忆文件名必须是命名空间内的相对文件名')
  const segments = normalized.split('/')
  if (segments.length !== 1) throw new Error('记忆文件名不能包含目录')
  const segment = segments[0]!
  if (segment === '.' || segment === '..') throw new Error('记忆文件名不合法')
  if (!/^[^<>:"|?*\u0000-\u001f]+$/u.test(segment)) throw new Error('记忆文件名包含非法字符')
  if (/[. ]$/.test(segment)) throw new Error('记忆文件名不能以空格或点结尾')
  if (!/\.md$/i.test(segment)) throw new Error('记忆文件必须是 Markdown 文件')
  if (segment.length > 120) throw new Error('记忆文件名过长')
  const base = segment.slice(0, -3).toLowerCase()
  if (RESERVED_NAMES.has(base)) throw new Error('记忆文件名与系统保留名冲突')
  return segment.toLowerCase() === MEMORY_INDEX_FILE.toLowerCase() ? MEMORY_INDEX_FILE : segment
}

const assertContained = async (root: string, target: string) => {
  const relation = relative(root, target)
  if (relation.startsWith('..') || relation === '' || /^[A-Za-z]:/.test(relation))
    throw new Error('记忆文件越界')
}

/**
 * Rejects junctions and symlinks that resolve outside the namespace directory.
 * A not-yet-created file is checked through its real parent directory.
 */
const resolveSafePath = async (root: string, relativePath: string) => {
  await mkdir(root, { recursive: true })
  const canonicalRoot = await realpath(root)
  const target = join(canonicalRoot, relativePath)
  await assertContained(canonicalRoot, target)
  let candidate = target
  while (true) {
    try {
      const canonical = await realpath(candidate)
      await assertContained(canonicalRoot, canonical)
      return canonical
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      const parent = dirname(candidate)
      if (parent === candidate) throw new Error('记忆文件越界')
      candidate = parent
      if (candidate === canonicalRoot) break
    }
  }
  return target
}

type Frontmatter = { name: string; description: string; type: MemoryType } | null

const parseFrontmatter = (
  text: string,
): { frontmatter: Frontmatter; body: string; diagnostic: MemoryFileDiagnostic['code'] | null } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { frontmatter: null, body: text, diagnostic: 'invalid-frontmatter' }
  let parsed: unknown
  try {
    parsed = parseYaml(match[1]!)
  } catch {
    return { frontmatter: null, body: text, diagnostic: 'invalid-frontmatter' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { frontmatter: null, body: text, diagnostic: 'invalid-frontmatter' }
  const record = parsed as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  const type = typeof record.type === 'string' ? record.type.trim() : ''
  if (!name) return { frontmatter: null, body: text, diagnostic: 'invalid-frontmatter' }
  if (!(MEMORY_TYPES as readonly string[]).includes(type))
    return { frontmatter: null, body: text, diagnostic: 'invalid-type' }
  return {
    frontmatter: { name, description, type: type as MemoryType },
    body: text.slice(match[0].length),
    diagnostic: null,
  }
}

export const serializeMemoryDocument = (
  frontmatter: { name: string; description?: string; type: MemoryType },
  body: string,
) =>
  [
    '---',
    stringifyYaml({
      name: frontmatter.name,
      description: frontmatter.description ?? '',
      type: frontmatter.type,
    }).trimEnd(),
    '---',
    '',
    body.trimEnd(),
    '',
  ].join('\n')

const normalizeIndexLinkTarget = (raw: string): string | null => {
  const target = raw.replace(/^\.\//, '').split('#')[0]!
  if (!target || target === MEMORY_INDEX_FILE || /^[a-z]+:/i.test(target)) return null
  return target
}

const indexLinks = (text: string) => {
  const links: string[] = []
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)) {
    const target = normalizeIndexLinkTarget(match[1]!)
    if (target) links.push(target)
  }
  return links
}

export const memoryFileRevision = (text: string) => hash(text)

export type MemoryDirectoryListing = {
  files: MemoryFileSummary[]
  index: { content: string; revision: string; exists: boolean }
  indexDiagnostics: MemoryFileDiagnostic[]
}

/**
 * Reads the namespace from disk. Nothing is cached: an external edit shows up on
 * the next read and never gets overwritten by a stale in-process copy.
 */
export const listMemoryDirectory = async (
  rootDirectory: string,
  namespace: MemoryNamespace,
): Promise<MemoryDirectoryListing> => {
  const directory = memoryNamespaceDirectory(rootDirectory, namespace)
  let entries: string[] = []
  try {
    entries = await readdir(directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  const indexEntry = entries.find((entry) => entry.toLowerCase() === MEMORY_INDEX_FILE.toLowerCase())
  let indexContent = ''
  let indexRevision = memoryFileRevision('')
  let indexExists = false
  if (indexEntry) {
    const target = await resolveSafePath(directory, indexEntry)
    indexContent = await readFile(target, 'utf8')
    indexRevision = memoryFileRevision(indexContent)
    indexExists = true
  }
  const links = new Set(indexLinks(indexContent).map((link) => link.toLowerCase()))
  const seen = new Map<string, string>()
  const files: MemoryFileSummary[] = []
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (!/\.md$/i.test(entry)) continue
    if (entry.toLowerCase() === MEMORY_INDEX_FILE.toLowerCase()) continue
    let path: string
    try {
      path = normalizeMemoryPath(entry)
      if (path === MEMORY_INDEX_FILE) continue
    } catch {
      continue
    }
    const target = await resolveSafePath(directory, entry)
    const text = await readFile(target, 'utf8')
    const info = await stat(target)
    const revision = memoryFileRevision(text)
    const { frontmatter, diagnostic } = parseFrontmatter(text)
    const diagnostics: MemoryFileDiagnostic[] = []
    const aliasKey = path.toLowerCase()
    const previous = seen.get(aliasKey)
    if (previous && previous !== path) {
      diagnostics.push({
        path,
        code: 'case-alias',
        message: `与 ${previous} 仅大小写不同，已排除自动注入`,
      })
    }
    seen.set(aliasKey, path)
    if (diagnostic === 'invalid-frontmatter')
      diagnostics.push({
        path,
        code: 'invalid-frontmatter',
        message: '缺少或无法解析 frontmatter（name/description/type），已排除自动注入',
      })
    if (diagnostic === 'invalid-type')
      diagnostics.push({
        path,
        code: 'invalid-type',
        message: 'frontmatter type 必须是 user/feedback/project/reference',
      })
    if (text.length > MEMORY_BODY_MAX_CHARS)
      diagnostics.push({ path, code: 'too-large', message: '正文超过 25,000 字符上限' })
    files.push({
      path,
      name: frontmatter?.name ?? null,
      description: frontmatter?.description ?? null,
      type: frontmatter?.type ?? null,
      revision,
      size: text.length,
      updatedAt: info.mtimeMs,
      indexed: links.has(path.toLowerCase()),
      diagnostics,
    })
  }
  const indexDiagnostics: MemoryFileDiagnostic[] = []
  if (indexContent.length > MEMORY_INDEX_MAX_CHARS)
    indexDiagnostics.push({
      path: MEMORY_INDEX_FILE,
      code: 'too-large',
      message: '索引超过 25,000 字符上限',
    })
  if (indexContent.split('\n').length > MEMORY_INDEX_MAX_LINES)
    indexDiagnostics.push({
      path: MEMORY_INDEX_FILE,
      code: 'too-large',
      message: '索引超过 200 行上限',
    })
  const known = new Set(files.map((file) => file.path.toLowerCase()))
  for (const link of indexLinks(indexContent))
    if (!known.has(link.toLowerCase()))
      indexDiagnostics.push({
        path: link,
        code: 'duplicate-name',
        message: '索引指向不存在的记忆文件',
      })
  return {
    files,
    index: { content: indexContent, revision: indexRevision, exists: indexExists },
    indexDiagnostics,
  }
}

export const readMemoryFile = async (
  rootDirectory: string,
  namespace: MemoryNamespace,
  relativePath: string,
): Promise<MemoryFileContent | null> => {
  const path = normalizeMemoryPath(relativePath)
  const directory = memoryNamespaceDirectory(rootDirectory, namespace)
  let target: string
  try {
    target = await resolveSafePath(directory, path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
  let text: string
  let info
  try {
    text = await readFile(target, 'utf8')
    info = await stat(target)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
  const { frontmatter, diagnostic } = parseFrontmatter(text)
  const listing = await listMemoryDirectory(rootDirectory, namespace)
  const summary = listing.files.find((file) => file.path === path)
  const diagnostics: MemoryFileDiagnostic[] = []
  if (path !== MEMORY_INDEX_FILE) {
    if (diagnostic === 'invalid-frontmatter')
      diagnostics.push({
        path,
        code: 'invalid-frontmatter',
        message: '缺少或无法解析 frontmatter（name/description/type），已排除自动注入',
      })
    if (diagnostic === 'invalid-type')
      diagnostics.push({
        path,
        code: 'invalid-type',
        message: 'frontmatter type 必须是 user/feedback/project/reference',
      })
  }
  return {
    path,
    name: frontmatter?.name ?? null,
    description: frontmatter?.description ?? null,
    type: frontmatter?.type ?? null,
    revision: memoryFileRevision(text),
    size: text.length,
    updatedAt: info.mtimeMs,
    indexed: summary?.indexed ?? false,
    diagnostics,
    content: text,
  }
}

export type MemoryReadPage = {
  content: string
  offset: number
  nextOffset: number | null
  truncated: boolean
  totalBytes: number
}

/** Body reads are byte bounded and report where to continue. */
export const paginateMemoryContent = (content: string, offset = 0): MemoryReadPage => {
  const bytes = Buffer.from(content, 'utf8')
  const start = Math.max(0, Math.min(offset, bytes.length))
  const end = Math.min(bytes.length, start + MEMORY_READ_MAX_BYTES)
  // Never split a multi-byte sequence: trim trailing continuation bytes.
  let safeEnd = end
  while (safeEnd > start && safeEnd < bytes.length && (bytes[safeEnd]! & 0xc0) === 0x80) safeEnd -= 1
  const slice = bytes.subarray(start, safeEnd).toString('utf8')
  return {
    content: slice,
    offset: start,
    nextOffset: safeEnd < bytes.length ? safeEnd : null,
    truncated: safeEnd < bytes.length,
    totalBytes: bytes.length,
  }
}

export type MemoryWriteResult = {
  path: string
  revision: string
  created: boolean
}

const writeAtomically = async (target: string, text: string) => {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/**
 * Writes one Markdown file. `expectedRevision` guards against clobbering an
 * external edit; a conflict is reported, never merged or silently retried.
 */
export const writeMemoryFile = async (input: {
  rootDirectory: string
  namespace: MemoryNamespace
  relativePath: string
  content: string
  expectedRevision?: string | null
  bodyLimit?: number
}): Promise<MemoryWriteResult> => {
  const path = normalizeMemoryPath(input.relativePath)
  const directory = memoryNamespaceDirectory(input.rootDirectory, input.namespace)
  const target = await resolveSafePath(directory, path)
  if (input.content.length > (input.bodyLimit ?? MEMORY_BODY_MAX_CHARS))
    throw new Error(`记忆内容超过 ${input.bodyLimit ?? MEMORY_BODY_MAX_CHARS} 字符上限`)
  let previous: string | null = null
  try {
    previous = await readFile(target, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  const currentRevision = previous === null ? memoryFileRevision('') : memoryFileRevision(previous)
  if (input.expectedRevision == null) {
    // Creating a file needs no revision; replacing one does, so a stale model
    // copy can never clobber an external edit.
    if (previous !== null)
      throw Object.assign(new Error('写入已存在的记忆文件必须提交读取得到的 revision'), {
        code: 'MEMORY_CONFLICT',
      })
  } else if (input.expectedRevision !== currentRevision) {
    throw Object.assign(new Error('记忆文件已在外部修改，请重新读取后再保存'), {
      code: 'MEMORY_CONFLICT',
    })
  }
  const normalized = input.content.endsWith('\n') ? input.content : `${input.content}\n`
  await writeAtomically(target, normalized)
  return { path, revision: memoryFileRevision(normalized), created: previous === null }
}

/**
 * Removes links to a deleted memory file from `MEMORY.md` without touching
 * unrelated entries. Drops a list line when removing the link leaves no body.
 */
export const pruneMemoryIndexEntry = async (input: {
  rootDirectory: string
  namespace: MemoryNamespace
  relativePath: string
}): Promise<boolean> => {
  const path = normalizeMemoryPath(input.relativePath)
  if (path === MEMORY_INDEX_FILE) return false
  const directory = memoryNamespaceDirectory(input.rootDirectory, input.namespace)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
  const indexEntry = entries.find((entry) => entry.toLowerCase() === MEMORY_INDEX_FILE.toLowerCase())
  if (!indexEntry) return false
  const target = await resolveSafePath(directory, indexEntry)
  let content: string
  try {
    content = await readFile(target, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
  const targetKey = path.toLowerCase()
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  let changed = false
  const nextLines: string[] = []
  for (const line of lines) {
    let lineChanged = false
    const pruned = line.replace(/\[[^\]]*\]\(([^)\s]+)\)/gu, (full, rawTarget: string) => {
      const normalized = normalizeIndexLinkTarget(rawTarget)
      if (normalized && normalized.toLowerCase() === targetKey) {
        lineChanged = true
        return ''
      }
      return full
    })
    if (!lineChanged) {
      nextLines.push(line)
      continue
    }
    changed = true
    if (/^\s*(?:[-*+]|\d+\.)\s*$/.test(pruned) || pruned.trim() === '') continue
    nextLines.push(pruned)
  }
  if (!changed) return false
  await writeAtomically(target, nextLines.join(lineEnding))
  return true
}

export const deleteMemoryFile = async (input: {
  rootDirectory: string
  namespace: MemoryNamespace
  relativePath: string
  expectedRevision?: string | null
}): Promise<boolean> => {
  const path = normalizeMemoryPath(input.relativePath)
  const directory = memoryNamespaceDirectory(input.rootDirectory, input.namespace)
  let target: string
  try {
    target = await resolveSafePath(directory, path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
  let previous: string
  try {
    previous = await readFile(target, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
  if (
    input.expectedRevision != null &&
    input.expectedRevision !== memoryFileRevision(previous)
  )
    throw Object.assign(new Error('记忆文件已在外部修改，请重新读取后再删除'), {
      code: 'MEMORY_CONFLICT',
    })
  await rm(target, { force: true })
  if (path !== MEMORY_INDEX_FILE) {
    await pruneMemoryIndexEntry({
      rootDirectory: input.rootDirectory,
      namespace: input.namespace,
      relativePath: path,
    }).catch(() => undefined)
  }
  return true
}

/**
 * Removes only files this system owns: nothing is deleted recursively, and a
 * file whose frontmatter is missing or unknown is left for the user.
 */
export const resetMemoryNamespace = async (
  rootDirectory: string,
  namespace: MemoryNamespace,
): Promise<number> => {
  const directory = memoryNamespaceDirectory(rootDirectory, namespace)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw cause
  }
  let removed = 0
  for (const entry of entries) {
    if (!/\.md$/i.test(entry)) continue
    let path: string
    try {
      path = normalizeMemoryPath(entry)
    } catch {
      continue
    }
    if (path === MEMORY_INDEX_FILE) {
      await rm(await resolveSafePath(directory, entry), { force: true })
      removed += 1
      continue
    }
    const target = await resolveSafePath(directory, entry)
    const text = await readFile(target, 'utf8')
    if (parseFrontmatter(text).frontmatter === null) continue
    await rm(target, { force: true })
    removed += 1
  }
  return removed
}
