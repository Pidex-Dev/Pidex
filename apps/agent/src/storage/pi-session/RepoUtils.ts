import { uuidv7 } from '@earendil-works/pi-ai'
import {
  SessionError,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry,
} from '../../orchestration/harness/Types.ts'
import { Session } from './Session.ts'

export function createSessionId(): string {
  return uuidv7()
}

export function createTimestamp(): string {
  return new Date().toISOString()
}

export function toSession<TMetadata extends SessionMetadata>(
  storage: SessionStorage<TMetadata>,
): Session<TMetadata> {
  return new Session(storage)
}

export async function getEntriesToFork(
  storage: SessionStorage,
  options: { entryId?: string; position?: 'before' | 'at' },
): Promise<SessionTreeEntry[]> {
  if (!options.entryId) return storage.getEntries()
  const target = await storage.getEntry(options.entryId)
  if (!target) {
    throw new SessionError('invalid_fork_target', `Entry ${options.entryId} not found`)
  }
  let effectiveLeafId: string | null
  if ((options.position ?? 'before') === 'at') {
    effectiveLeafId = target.id
  } else {
    if (target.type !== 'message' || target.message.role !== 'user') {
      throw new SessionError(
        'invalid_fork_target',
        `Entry ${options.entryId} is not a user message`,
      )
    }
    effectiveLeafId = target.parentId
  }
  return storage.getPathToRootOrCompaction(effectiveLeafId)
}
