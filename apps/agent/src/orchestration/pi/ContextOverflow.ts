const CONTEXT_OVERFLOW_MARKERS = [
  'context_length_exceeded',
  'maximum context length',
  'prompt is too long',
  'too many tokens',
] as const

/** Provider-neutral fallback for Pi responses that currently expose only error text. */
export const isProviderContextOverflow = (message: string | undefined) => {
  const normalized = message?.trim().toLowerCase()
  if (!normalized) return false
  if (CONTEXT_OVERFLOW_MARKERS.some((marker) => normalized.includes(marker))) return true
  if (
    normalized.includes('context window') &&
    /(exceed|too (?:large|long)|maximum|limit)/.test(normalized)
  )
    return true
  if (
    normalized.includes('input token count') &&
    /(exceed|too (?:large|high)|maximum|limit)/.test(normalized)
  )
    return true
  return false
}

export const REACTIVE_COMPACTION_INSTRUCTIONS = [
  'Preserve the current user request, completed tool calls, key file state and remaining steps.',
  'Remove old tool output and repeated background that do not help continue the task.',
  'Do not treat compaction itself as a user request.',
].join('\n')

export const REACTIVE_CONTINUATION_PROMPT = [
  'Context was compacted because of the window limit. Continue the current unfinished request.',
  'Do not narrate compaction or ask again for information the user already provided.',
  'Reuse tool results from retained history. Never repeat a toolCallId or clearly completed side effect.',
].join('\n')
