import { z } from 'zod'
import { AgentError } from '../../Domain'
import type { ToolCatalogEntry, ToolDefinition } from '../ToolRegistry'

/** Model-facing summary used by the capability catalog and ToolSearch results. */
export const toolCatalogSummary = (
  tool: Pick<ToolCatalogEntry, 'sdkName' | 'description' | 'origin'>,
): { name: string; description: string; source?: string } => ({
  name: tool.sdkName,
  description: typeof tool.description === 'string' ? tool.description : '',
  ...(tool.origin?.kind === 'mcp' ? { source: `mcp:${tool.origin.serverName}` } : {}),
})

/** Search matches the canonical name, the short description and the MCP server name. */
const toolSearchHaystack = (tool: Pick<ToolCatalogEntry, 'sdkName' | 'description' | 'origin'>) => {
  const summary = toolCatalogSummary(tool)
  return `${summary.name}\n${summary.description}\n${summary.source ?? ''}`.toLowerCase()
}

export const toolSearchDefinition: ToolDefinition<
  { query: string; max_results: number; offset: number },
  {
    tools: Array<{ name: string; description: string; source?: string }>
    total: number
    offset: number
    addedToolNames: string[]
  }
> = {
  sdkName: 'ToolSearch',
  name: 'tool.search',
  description:
    'Discover and activate deferred tools within the allowed catalog. query matches names, descriptions and MCP server names. Use * to browse, offset to paginate and max_results up to 20. Matches become callable on the next request. select:<exact-name> activates an exact tool and returns its full schema.',
  schema: z
    .object({
      query: z.string().min(1),
      max_results: z.number().int().min(1).max(20).default(5),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description:
          'Keywords matching names, descriptions and MCP server names; * browses the catalog, select:<exact-name> selects an exact tool.',
      },
      max_results: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Pagination offset for browsing results omitted by the result limit.',
      },
    },
    additionalProperties: false,
    required: ['query'],
  },
  capabilities: {
    filesystem: 'none',
    network: 'none',
    process: false,
    externalState: false,
    userInteraction: false,
    readOnly: false,
  },
  allowedModes: ['chat', 'plan'],
  allowedProfiles: ['main', 'default', 'explorer', 'worker'],
  approvalStrategy: 'never-review',
  visibility: 'eager',
  executionMode: 'parallel',
  execute: async (input, context) => {
    const raw = input.query.trim()
    const selection = raw.match(/^select:(.+)$/i)?.[1]?.trim()
    const browseAll = raw === '*'
    const query = raw.toLowerCase()
    const matches = (context.deferredTools ?? []).filter((tool) =>
      selection
        ? tool.sdkName === selection
        : browseAll || toolSearchHaystack(tool).includes(query),
    )
    if (selection && matches.length === 0)
      throw new AgentError(
        'DEFERRED_TOOL_NOT_FOUND',
        `延迟工具 ${selection} 不存在或不在当前权限范围内`,
        404,
      )
    const page = matches.slice(input.offset, input.offset + input.max_results)
    return {
      tools: page.map((tool) => {
        const summary = toolCatalogSummary(tool)
        return {
          name: summary.name,
          description: summary.description,
          ...(summary.source ? { source: summary.source } : {}),
        }
      }),
      total: matches.length,
      offset: input.offset,
      addedToolNames: page.map((tool) => tool.sdkName),
    }
  },
  formatResult: (output) => ({
    content: JSON.stringify(output, null, 2),
    details: output,
    addedToolNames: output.addedToolNames,
  }),
}
