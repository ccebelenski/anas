/**
 * Per-path promise-chain lock — serializes writers to the SAME file
 * in-process (read-modify-write sequences that must not interleave).
 *
 * The ONE lock primitive for every file writer in anasd: extracted out of
 * backup-repos.ts (story rclone.1 slice 1) for the rclone.conf writer, and
 * the private copies in ahr-intent.ts, config-writer.ts and
 * replication-remotes.ts were folded into it (fix batch 2026-09-23). Sharing
 * the registry across modules means the lock is per-file process-wide: two
 * different services writing the same path now serialize too. Behaviour of
 * the chain is unchanged: a failure of one holder does not wedge the chain
 * for the next, and the holder's own result/throw is returned untouched.
 */

const locks = new Map<string, Promise<unknown>>()

export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(path, next.catch(() => {}))
  return next
}
