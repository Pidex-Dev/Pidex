import { sessionDisplayTitle, type SessionListItem } from '../../UiTypes.js'

export type ArchivedSort = 'updated' | 'created' | 'alphabetical'

export async function deleteArchivedSessions(
  ids: readonly string[],
  deleteOne: (id: string) => Promise<boolean>,
) {
  const results = await Promise.allSettled(ids.map(deleteOne))
  const removed = new Set<string>()
  let failed = 0
  let skipped = 0
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') failed++
    else if (result.value) removed.add(ids[index]!)
    else skipped++
  }
  return { removed, failed, skipped }
}

export function archivedGroups(
  sessions: readonly SessionListItem[],
  query: string,
  project: string,
  sort: ArchivedSort,
) {
  const needle = query.trim().toLocaleLowerCase()
  const groups = new Map<string, { id: string; label: string; sessions: SessionListItem[] }>()
  for (const session of sessions) {
    if (!session.archivedAt) continue
    const projectKey = session.projectId ?? 'chats'
    if (
      project !== 'all' &&
      (project === 'scheduled'
        ? !session.isScheduledSession && !session.hasScheduledRun
        : projectKey !== project)
    )
      continue
    if (
      needle &&
      !`${sessionDisplayTitle(session)} ${session.workspaceName}`
        .toLocaleLowerCase()
        .includes(needle)
    )
      continue
    const key = project === 'all' ? projectKey : project
    const group = groups.get(key) ?? {
      id: key,
      label: session.projectId ? session.workspaceName : '无项目聊天',
      sessions: [],
    }
    group.sessions.push(session)
    groups.set(key, group)
  }
  const compare = (a: SessionListItem, b: SessionListItem) =>
    sort === 'alphabetical'
      ? sessionDisplayTitle(a).localeCompare(sessionDisplayTitle(b)) || a.id.localeCompare(b.id)
      : timestamp(b, sort) - timestamp(a, sort) || a.id.localeCompare(b.id)
  for (const group of groups.values()) group.sessions.sort(compare)
  return [...groups.values()].sort((a, b) =>
    sort === 'alphabetical'
      ? a.label.localeCompare(b.label)
      : compare(a.sessions[0]!, b.sessions[0]!),
  )
}

function timestamp(session: SessionListItem, sort: ArchivedSort) {
  const value = Date.parse(
    sort === 'created' ? session.createdAt : (session.lastMessageAt ?? session.createdAt),
  )
  return Number.isFinite(value) ? value : 0
}
