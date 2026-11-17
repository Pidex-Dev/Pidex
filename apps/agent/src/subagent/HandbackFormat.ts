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

const indentTwoSpaces = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join('\n')

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
 */
export const formatSubagentHandback = (input: SubagentHandbackInput): string => {
  const headerParts = [`taskId=${input.taskId}`, `status=${input.status}`]
  if (input.displayName) headerParts.push(`name=${input.displayName}`)
  if (input.title) headerParts.push(`title=${input.title}`)
  if (input.profile) headerParts.push(`profile=${input.profile}`)
  if (input.runId) headerParts.push(`runId=${input.runId}`)

  const bodyLines: string[] = []
  const renderedResult = renderResultText(input.result)
  if (renderedResult) {
    bodyLines.push('Findings:')
    bodyLines.push(indentTwoSpaces(renderedResult))
  }
  if (input.error) {
    bodyLines.push(`Error: ${input.error.replaceAll(/\r?\n/g, ' ')}`)
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
