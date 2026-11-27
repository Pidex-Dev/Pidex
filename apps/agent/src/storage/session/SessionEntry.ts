import { SessionError, type SessionTreeEntry } from '../../orchestration/harness/Types'

export type SessionEntryRow = {
  id: string
  payload: string
}

/**
 * Canonical decoder for session entries persisted as UTF-8 JSON.
 *
 * Both session replay and usage aggregation use this boundary so malformed
 * payloads are handled consistently.
 */
export const parseSessionEntry = (row: SessionEntryRow): SessionTreeEntry => {
  try {
    const value = JSON.parse(row.payload) as Partial<SessionTreeEntry>
    if (
      value.id !== row.id ||
      typeof value.type !== 'string' ||
      typeof value.timestamp !== 'string'
    ) {
      throw new Error('entry payload does not match its index columns')
    }
    return value as SessionTreeEntry
  } catch (cause) {
    throw new SessionError(
      'invalid_session',
      `Invalid session entry ${row.id}`,
      cause instanceof Error ? cause : undefined,
    )
  }
}
