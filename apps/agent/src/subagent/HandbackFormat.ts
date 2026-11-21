export interface SubagentHandbackInput {
  taskId: string
  runId?: string
  displayName?: string
  title?: string
  profile?: string
  status: string
  result?: unknown
  error?: string | null
}

const LINE_BREAK_VARIANTS = new RegExp(
  '\\r\\n?|[\\u2028\\u2029\\u0085' + String.fromCharCode(0x0b, 0x0c, 0x1c, 0x1d, 0x1e) + ']',
  'gu',
)
const RESULT_TEXT_LIMIT = 120_000
const RESULT_HEAD_LENGTH = 60_000
const RESULT_TAIL_LENGTH = 50_000
const TRUNCATION_MARKER = '\n…[middle truncated]…\n'

const normalizeLineBreaks = (text: string) => text.replaceAll(LINE_BREAK_VARIANTS, '\n')

const flattenLineBreaks = (text: string) => normalizeLineBreaks(text).replaceAll('\n', ' ')

// INVARIANT: every physical line break variant must become \n before indenting so child output cannot emit unindented continuation lines.
const indentTwoSpaces = (text: string) =>
  normalizeLineBreaks(text)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')

const truncateMiddle = (text: string): string =>
  text.length <= RESULT_TEXT_LIMIT
    ? text
    : `${text.slice(0, RESULT_HEAD_LENGTH)}${TRUNCATION_MARKER}${text.slice(-RESULT_TAIL_LENGTH)}`

const renderResultText = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.summary === 'string' && record.summary.trim()) {
      return record.summary.trim()
    }
    const serialized = JSON.stringify(value, null, 2)
    return serialized && serialized !== '{}' ? serialized : null
  }
  return String(value)
}

/**
 * Format subagent handback content with indented boundaries so child output cannot
 * spoof top-level parent directives, preserving continuation handles on incomplete runs.
 * Line-break variants are normalized before indenting, header and error text stay on a
 * single line, and oversized results are middle-truncated to bound parent context usage.
 */
export const formatSubagentHandback = (input: SubagentHandbackInput): string => {
  const headerParts = [`taskId=${input.taskId}`, `status=${input.status}`]
  if (input.displayName) headerParts.push(`name=${flattenLineBreaks(input.displayName)}`)
  if (input.title) headerParts.push(`title=${flattenLineBreaks(input.title)}`)
  if (input.profile) headerParts.push(`profile=${input.profile}`)
  if (input.runId) headerParts.push(`runId=${input.runId}`)

  const bodyLines: string[] = []
  const renderedResult = renderResultText(input.result)
  if (renderedResult) {
    bodyLines.push('Findings:')
    bodyLines.push(indentTwoSpaces(truncateMiddle(renderedResult)))
  }
  if (input.error) {
    bodyLines.push(`Error: ${flattenLineBreaks(input.error)}`)
  }
  if (input.status !== 'completed') {
    bodyLines.push(
      `Continuation: Call ToolSearch to activate send_agent if needed, then use send_agent(taskID="${input.taskId}", message="...") to resume or inspect this subagent.`,
    )
  } else if (!renderedResult) {
    bodyLines.push('(no text output recorded)')
  }

  return [
    `[Subagent hand-back (${headerParts.join(', ')})]`,
    indentTwoSpaces(bodyLines.join('\n')),
    '[/Subagent hand-back]',
  ].join('\n')
}
