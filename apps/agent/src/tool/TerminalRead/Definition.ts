import { z } from 'zod'
import type {
  TerminalOutputMirror,
  TerminalOutputReadResult,
} from '../../terminal/TerminalOutputMirror'
import { AgentError } from '../../Domain'
import type { ToolDefinition } from '../ToolRegistry'

const escapeUntrustedTerminalOutput = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const schema = z
  .object({
    terminalId: z.string().min(1).optional(),
    afterSequence: z.number().int().min(-1).optional(),
    maxBytes: z.number().int().min(1).max(32_768).optional(),
  })
  .strict()

type TerminalReadOutput =
  | TerminalOutputReadResult
  | {
      terminalId: string | null
      instanceId: null
      oldestSequence: 0
      nextSequence: 0
      gap: false
      truncated: false
      content: ''
      unavailable: true
    }

export const createTerminalReadDefinition = (
  mirror: TerminalOutputMirror,
): ToolDefinition<z.infer<typeof schema>, TerminalReadOutput> => ({
  sdkName: 'TerminalRead',
  name: 'terminal.read',
  schema,
  description:
    'Read sanitized plain-text output from an integrated terminal belonging to this task. Terminal control sequences are removed. Use only when terminal output is needed.',
  capabilities: {
    filesystem: 'none',
    network: 'none',
    process: false,
    externalState: false,
    userInteraction: true,
    readOnly: true,
  },
  allowedModes: ['chat', 'plan'],
  allowedProfiles: ['main'],
  approvalStrategy: 'policy',
  visibility: 'deferred',
  executionMode: 'sequential',
  inputSchema: {
    type: 'object',
    properties: {
      terminalId: {
        type: 'string',
        description:
          'Optional terminal ID; defaults to the most recently updated terminal in this task.',
      },
      afterSequence: {
        type: 'integer',
        minimum: -1,
        description: 'Read output after this sequence number. Omit for the first read.',
      },
      maxBytes: {
        type: 'integer',
        minimum: 1,
        maximum: 32_768,
        default: 8_192,
        description: 'Maximum returned UTF-8 bytes; default 8192.',
      },
    },
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const threadId = context.invocation?.threadID
    if (!threadId)
      throw new AgentError('TERMINAL_CONTEXT_REQUIRED', '终端读取缺少受信任的任务上下文', 403)
    return (
      mirror.read({
        threadId,
        ...(input.terminalId === undefined ? {} : { terminalId: input.terminalId }),
        ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
      }) ?? {
        terminalId: input.terminalId ?? null,
        instanceId: null,
        oldestSequence: 0,
        nextSequence: 0,
        gap: false,
        truncated: false,
        content: '',
        unavailable: true,
      }
    )
  },
  formatResult: (output) => {
    const { content, ...metadata } = output
    return {
      content: [
        JSON.stringify(metadata),
        '<untrusted_terminal_output>',
        escapeUntrustedTerminalOutput(content),
        '</untrusted_terminal_output>',
      ].join('\n'),
      details: metadata,
    }
  },
})
