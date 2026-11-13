import { rename } from 'node:fs/promises'

/** Windows reports these while another process still holds a directory handle. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])
const RETRY_DELAYS_MS = [25, 50, 100] as const

export type RenameWithRetryOptions = {
  rename?: (from: string, to: string) => Promise<void>
  delay?: (milliseconds: number) => Promise<void>
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

/**
 * Renames a plugin directory with a bounded retry for transient occupancy.
 * Invalid paths, rejected contents and download failures must surface
 * immediately, so only occupancy error codes are retried (at most 3 times).
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameWithRetryOptions = {},
): Promise<void> {
  const run = options.rename ?? rename
  const delay = options.delay ?? wait
  for (let attempt = 0; ; attempt++) {
    try {
      await run(from, to)
      return
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | null)?.code
      if (!code || !BUSY_CODES.has(code) || attempt >= RETRY_DELAYS_MS.length) throw cause
      await delay(RETRY_DELAYS_MS[attempt]!)
    }
  }
}
