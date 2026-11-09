import type { PromptSection } from './Types'

/**
 * Capability summary budget. The model only needs the exact names and a one-line
 * hint to decide what to search for;完整说明与参数按需通过 ToolSearch / Read 加载。
 */
export const CAPABILITY_CATALOG_MAX_CHARS = 8_000
export const CAPABILITY_DESCRIPTION_MAX_CHARS = 160

export interface CapabilityToolSummary {
  /** Canonical model-facing name. */
  name: string
  description: string
  /** Discovery source label, for example `mcp:<server>`. */
  source?: string
}

export const truncateCapabilityText = (value: string, max = CAPABILITY_DESCRIPTION_MAX_CHARS) =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`

const GUIDANCE = [
  'Discover and activate deferred tools before calling them. Ordinary tools directly declared in this request do not require a search.',
  'This catalog lists deferred tools only, not all tools for this turn. An absent name does not imply unavailability: consult the current tool declarations, not historical claims about missing tools.',
  'Use ToolSearch: query matches names, descriptions and MCP server names. query="*" browses the catalog; use offset for pagination and max_results up to 20. Matches become callable on the next request. select:<exact-name> activates an exact tool with its full schema.',
  'See skills.catalog for Skill names, descriptions and locations. Use Read to load the full SKILL.md when needed, then follow its steps. Skill bodies are not preloaded here.',
].join('\n')

const toolLine = (tool: CapabilityToolSummary) => {
  const description = truncateCapabilityText(tool.description.trim().replace(/\s+/gu, ' '))
  const source = tool.source ? ` [${tool.source}]` : ''
  return `- ${tool.name}${description ? `: ${description}` : ''}${source}`
}

/**
 * Single generation path shared by the frozen turn composition (main Agent and
 * subagents) and the prompt preview. It only lists what the current mode,
 * profile, allowlist and availability already allow the model to discover.
 */
export const buildCapabilityCatalogSection = (
  tools: readonly CapabilityToolSummary[],
): PromptSection => {
  const lines: string[] = []
  const header = `${GUIDANCE}\n\nDiscoverable capabilities (deferred tools):`
  const omission = (count: number) =>
    `Catalog has ${tools.length} entries; showing the first ${count}. ${tools.length - count} more entries are omitted; use ToolSearch with offset to discover further pages.`
  let used = header.length
  for (const tool of tools) {
    const line = toolLine(tool)
    const nextCount = lines.length + 1
    const suffixLength = nextCount < tools.length ? omission(nextCount).length + 1 : 0
    if (used + line.length + 1 + suffixLength > CAPABILITY_CATALOG_MAX_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  const omitted = tools.length - lines.length
  const body = [
    ...lines,
    ...(tools.length === 0 ? ['- No deferred tools are currently discoverable.'] : []),
    ...(omitted > 0 ? [omission(lines.length)] : []),
  ].join('\n')
  return {
    id: 'capabilities.catalog',
    role: 'developer',
    cache: 'session-stable',
    authority: 'builtin',
    source: { type: 'runtime', name: 'capability-catalog' },
    content: `${header}\n${body}`,
  }
}
