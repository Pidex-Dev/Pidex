export type SharedSlashCommandId = 'plan' | 'grill' | 'goal' | 'status'

export type SharedSlashCommandArgumentMode = 'none' | 'optional-text'

export type SharedSlashCommandDefinition = {
  id: SharedSlashCommandId
  trigger: string
  argumentMode: SharedSlashCommandArgumentMode
}

export const SHARED_SLASH_COMMANDS = {
  plan: {
    id: 'plan',
    trigger: 'plan',
    argumentMode: 'optional-text',
  },
  goal: { id: 'goal', trigger: 'goal', argumentMode: 'optional-text' },
  grill: {
    id: 'grill',
    trigger: 'grill',
    argumentMode: 'optional-text',
  },
  status: {
    id: 'status',
    trigger: 'status',
    argumentMode: 'none',
  },
} as const satisfies Record<SharedSlashCommandId, SharedSlashCommandDefinition>

export function parsePlanTaskFromInput(input: string): string | null {
  return parseCommandTask(input, 'plan')
}

export function parseGrillTaskFromInput(input: string): string | null {
  return parseCommandTask(input, 'grill')
}

export function parseGoalTaskFromInput(input: string): string | null {
  return parseCommandTask(input, 'goal')
}

// SAFETY: Prefix match plus trim avoids quadratic regex backtracking on long whitespace input.
function parseCommandTask(input: string, command: string): string | null {
  const prefix = `/${command}`
  if (!input.slice(0, prefix.length).toLowerCase().startsWith(prefix)) return null
  const rest = input.slice(prefix.length)
  if (!/^\s/.test(rest)) return null
  return rest.trim() || null
}
