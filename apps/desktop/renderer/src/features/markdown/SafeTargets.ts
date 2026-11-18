import { parseThreadDeepLink } from '@pidex/shared/thread-reference'
import type { MarkdownFileReference } from './Types.js'

export type SafeMarkdownTarget =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; href: string }
  | { kind: 'thread'; threadId: string }
  | ({ kind: 'file' } & MarkdownFileReference)
  | { kind: 'unsafe' }

const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/
const RELATIVE_PATH = /^(?:\.{1,2}[\\/])/
const UNIX_PATH = /^\//
// 必须包含路径分隔符才视为文件路径，避免把 v1.2.3、Foo.Bar 这类普通文本误判为链接。
const SEPARATED_FILE_PATH =
  /^(?![a-zA-Z][a-zA-Z\d+.-]*:)[^<>"|?*\r\n]+[\\/][^<>"|?*\r\n]+\.[a-zA-Z\d]{1,12}(?:(?:#L\d+(?:-L?\d+)?)|(?::\d+(?::\d+)?))?$/u
// 不含分隔符的裸文件名仅在携带行列引用（如 foo.ts:12:3、foo.ts#L10-L12）时才识别为文件。
const BARE_FILE_LINE_REFERENCE =
  /^(?![a-zA-Z][a-zA-Z\d+.-]*:\/\/)[^<>"|?*\r\n\\/:\s]+\.[a-zA-Z\d]{1,12}(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/u

export function classifyMarkdownTarget(target: string): SafeMarkdownTarget {
  const value = target.trim()
  if (!value) return { kind: 'unsafe' }
  if (value.startsWith('#')) return { kind: 'anchor', href: value }
  if (WINDOWS_PATH.test(value) || RELATIVE_PATH.test(value) || UNIX_PATH.test(value)) {
    return { kind: 'file', ...parseMarkdownFileReference(value) }
  }
  if (SEPARATED_FILE_PATH.test(value) || BARE_FILE_LINE_REFERENCE.test(value)) {
    return { kind: 'file', ...parseMarkdownFileReference(value) }
  }

  const threadId = parseThreadDeepLink(value)
  if (threadId !== null) {
    return { kind: 'thread', threadId }
  }

  try {
    const url = new URL(value)
    if (url.protocol === 'https:') {
      return { kind: 'external', url: url.href }
    }
    if (url.protocol === 'file:') {
      return {
        kind: 'file',
        ...parseMarkdownFileReference(`${decodeFileUrl(url)}${url.hash}`),
      }
    }
  } catch {
    return { kind: 'unsafe' }
  }
  return { kind: 'unsafe' }
}

export function isInlinePluginLink(value: string): boolean {
  return /^plugin:\/\/[\w.@-]+$/u.test(value)
}

export function isSafeHttpsMediaSource(source: string): boolean {
  try {
    return new URL(source).protocol === 'https:'
  } catch {
    return false
  }
}

export function mediaKindForUrl(source: string): 'audio' | 'image' | 'video' | null {
  if (!isSafeHttpsMediaSource(source)) return null
  const pathname = new URL(source).pathname.toLowerCase()
  if (/\.(?:avif|gif|jpe?g|png|svg|webp)$/u.test(pathname)) return 'image'
  if (/\.(?:m4a|mp3|oga|ogg|wav)$/u.test(pathname)) return 'audio'
  if (/\.(?:m4v|mp4|ogv|webm)$/u.test(pathname)) return 'video'
  return null
}

export function isLikelyFileReference(value: string): boolean {
  const target = classifyMarkdownTarget(value)
  return target.kind === 'file'
}

export function parseMarkdownFileReference(value: string): MarkdownFileReference {
  const source = value.trim()
  const hashMatch = /#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?$/iu.exec(source)
  if (hashMatch?.index !== undefined) {
    return compactReference({
      path: source.slice(0, hashMatch.index),
      line: positiveInteger(hashMatch[1]),
      column: positiveInteger(hashMatch[2]),
      endLine: positiveInteger(hashMatch[3]),
      endColumn: positiveInteger(hashMatch[4]),
    })
  }

  const colonMatch = /:(\d+)(?::(\d+))?$/u.exec(source)
  if (colonMatch?.index !== undefined) {
    return compactReference({
      path: source.slice(0, colonMatch.index),
      line: positiveInteger(colonMatch[1]),
      column: positiveInteger(colonMatch[2]),
    })
  }
  return { path: source }
}

export function formatFileReferenceLocation(reference: MarkdownFileReference): string {
  const parts: string[] = []
  if (reference.line !== undefined) {
    if (reference.endLine !== undefined && reference.endLine !== reference.line) {
      parts.push(`lines ${reference.line}-${reference.endLine}`)
    } else {
      parts.push(`line ${reference.line}`)
    }
  } else if (reference.endLine !== undefined) {
    parts.push(`line ${reference.endLine}`)
  }

  if (reference.column !== undefined || reference.endColumn !== undefined) {
    if (
      reference.column !== undefined &&
      reference.endColumn !== undefined &&
      reference.endColumn !== reference.column
    ) {
      parts.push(`columns ${reference.column}-${reference.endColumn}`)
    } else if (reference.column === undefined) {
      if (reference.endColumn !== undefined) {
        parts.push(`column ${reference.endColumn}`)
      }
    } else {
      parts.push(`column ${reference.column}`)
    }
  }
  return parts.join(', ')
}

export function formatFileReferenceTooltip(
  reference: MarkdownFileReference,
  displayPath?: string | null,
): string {
  const basePath = displayPath?.trim() || reference.path
  const location = formatFileReferenceLocation(reference)
  return location ? `${basePath} (${location})` : basePath
}

export function formatFileReferenceShortLabel(reference: MarkdownFileReference): string {
  const normalized = reference.path.replace(/[\\/]+$/u, '')
  const basename = normalized.split(/[\\/]/u).pop() || reference.path
  const location = formatFileReferenceLocation(reference)
  return location ? `${basename} (${location})` : basename
}

export type ResolvedFileLinkDisplay = {
  resolvedText: string | null
  suffix: string
}

export function resolveFileLinkDisplayLabel(
  rawLabel: string,
  href: string,
  reference: MarkdownFileReference,
): ResolvedFileLinkDisplay {
  const trimmed = rawLabel.trim()
  const trimmedHref = href.trim()
  const formattedFull = formatFileReferenceTooltip(reference)
  if (
    !trimmed ||
    trimmed === trimmedHref ||
    trimmed === reference.path ||
    trimmed === formattedFull
  ) {
    return { resolvedText: formatFileReferenceShortLabel(reference), suffix: '' }
  }

  const location = formatFileReferenceLocation(reference)
  const suffix = location ? ` (${location})` : ''
  const candidates = [trimmed]
  const unwrapped = unwrapSingleBacktickPair(trimmed)
  if (unwrapped !== null) candidates.push(unwrapped)

  for (const candidate of candidates) {
    if (!isLikelyFileReference(candidate) && candidate !== unwrapped) continue
    const parsed = parseMarkdownFileReference(candidate)
    if (sameFilePath(parsed.path, reference.path)) {
      return {
        resolvedText: suffix ? `${parsed.path}${suffix}` : parsed.path,
        suffix: '',
      }
    }
  }

  return {
    resolvedText: null,
    suffix: suffix && !trimmed.endsWith(suffix) ? suffix : '',
  }
}

function unwrapSingleBacktickPair(value: string): string | null {
  const ticks = /^`+/u.exec(value)?.[0]
  if (!ticks || !value.endsWith(ticks) || value.length <= ticks.length * 2) return null
  if (value.at(-ticks.length - 1) === '`') return null
  return value.slice(ticks.length, -ticks.length).trim()
}

function sameFilePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/u, '')
  const a = normalize(left)
  const b = normalize(right)
  if (!a || !b) return false
  if (a === b || b.endsWith(`/${a}`) || a.endsWith(`/${b}`)) return true
  const baseA = a.split('/').pop()
  const baseB = b.split('/').pop()
  if (!baseA || !baseB || baseA !== baseB) return false
  return a === baseA || b === baseB
}

function decodeFileUrl(url: URL): string {
  const pathname = decodeURIComponent(url.pathname)
  if (/^\/[a-zA-Z]:\//u.test(pathname)) return pathname.slice(1)
  return pathname
}

function compactReference(reference: MarkdownFileReference): MarkdownFileReference {
  return Object.fromEntries(
    Object.entries(reference).filter(([, value]) => value !== undefined),
  ) as MarkdownFileReference
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
