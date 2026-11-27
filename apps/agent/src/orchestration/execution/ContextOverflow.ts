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
