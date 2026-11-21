// Adapted from CopilotKit/OpenIntelligentUI process-partial-html.ts (MIT).
// Source revision and license are recorded in UPSTREAM.md.
// This improves incomplete layouts; it is not an HTML sanitizer.
// SAFETY: Scan tag boundaries rather than single-pass regex removal so nested tags cannot recombine.
export function processPartialHtml(html: string): string {
  const withoutTail = dropTrailingIncompleteTag(html)
  const withoutContainers = dropBlocks(withoutTail, ['style', 'script', 'head'])
  const withoutEntity = withoutContainers.replace(/&[a-zA-Z0-9#]*$/, '')
  const bodyStart = findTag(withoutEntity, 'body')
  if (!bodyStart) return withoutEntity
  const inner = withoutEntity.slice(bodyStart.end)
  const bodyEnd = findClosingTag(inner, 'body')
  return bodyEnd === -1 ? inner : inner.slice(0, bodyEnd)
}

type TagMatch = { start: number; end: number; closing: boolean; name: string }

function readTag(source: string, from: number): TagMatch | null {
  if (source[from] !== '<') return null
  const end = source.indexOf('>', from)
  if (end === -1) return null
  const raw = source.slice(from + 1, end)
  const closing = raw.startsWith('/')
  const name = (closing ? raw.slice(1) : raw)
    .trim()
    .split(/[\s/>]/, 1)[0]
    ?.toLowerCase()
  if (!name) return null
  return { start: from, end: end + 1, closing, name }
}

function findTag(source: string, name: string): TagMatch | null {
  for (let index = source.indexOf('<'); index !== -1; index = source.indexOf('<', index + 1)) {
    const tag = readTag(source, index)
    if (tag && tag.name === name && !tag.closing) return tag
  }
  return null
}

function findClosingTag(source: string, name: string): number {
  for (let index = source.indexOf('<'); index !== -1; index = source.indexOf('<', index + 1)) {
    const tag = readTag(source, index)
    if (tag && tag.name === name && tag.closing) return tag.start
  }
  return -1
}

function dropTrailingIncompleteTag(source: string): string {
  const lastOpen = source.lastIndexOf('<')
  if (lastOpen === -1) return source
  return source.indexOf('>', lastOpen) === -1 ? source.slice(0, lastOpen) : source
}

function dropBlocks(source: string, names: readonly string[]): string {
  let result = ''
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open === -1) return result + source.slice(index)
    result += source.slice(index, open)
    const tag = readTag(source, open)
    if (!tag) {
      return result + source.slice(open)
    }
    if (tag.closing || !names.includes(tag.name)) {
      result += source.slice(open, tag.end)
      index = tag.end
      continue
    }
    const closeStart = findClosingTag(source.slice(tag.end), tag.name)
    index = closeStart === -1 ? source.length : tag.end + closeStart + `</${tag.name}>`.length
  }
  return result
}
