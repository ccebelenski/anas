/**
 * Per-path promise-chain lock — serializes writers to the SAME file
 * in-process (read-modify-write sequences that must not interleave).
 *
 * Extracted out of backup-repos.ts (story rclone.1 slice 1) so the rclone.conf
 * writer shares the ONE lock primitive instead of a second copy — behaviour is
 * unchanged: the lock is a promise chain per path, a failure of one holder
 * does not wedge the chain for the next, and the holder's own result/throw is
 * returned untouched.
 */

const locks = new Map<string, Promise<unknown>>()

export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(path, next.catch(() => {}))
  return next
}
