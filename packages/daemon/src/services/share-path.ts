import type { SharePathState } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { CommandTimeoutError } from '../executor/deadline.js'

/**
 * The read-time check of a share's backing path (cr.35, WAVE3-DESIGN §6.1
 * gap 1).
 *
 * It used to be a `statSync` in the daemon's own process. A share whose path
 * sits on a dead HARD NFS mount blocks that call in the kernel, and with it
 * the daemon's event loop: every request on the node, not just the share
 * list. (An async `fs.stat` would only move the hang into libuv's four-thread
 * pool, where four dead shares starve every file read the daemon makes.) So
 * the check is a child process, through the executor, under GNU `timeout` —
 * the same `timeout 2 stat -f` the mounts family probes liveness with
 * (fixtures/mounts/stat-f-exit-codes.txt is its capture: 0 healthy, 1 +
 * "No such file or directory" for a missing path, 124 after 2 s for a dead
 * hard NFS mount).
 *
 * A path that does not answer is `not-answering` — never `exists` and never
 * `missing` as a guess.
 */

const TIMEOUT = '/usr/bin/timeout'
const STAT = '/usr/bin/stat'

/** Seconds the stat may take before it is "not answering". */
export const SHARE_PATH_PROBE_S = 2

/** GNU `timeout`'s exit when it killed the child (124), and when its -k KILL had to (137). */
const TIMED_OUT_EXITS = new Set([124, 137])

/** stat's ENOENT / ENOTDIR texts in the C locale the probe forces. */
const MISSING_RE = /No such file or directory|Not a directory/

export interface SharePathProbe {
  state: SharePathState
  /** For `not-answering` and `unreadable`: what the probe saw, in one line. */
  detail?: string
}

/**
 * `timeout -k 1 2 stat -f -c %t -- <path>`. TERM at 2 s ends a stat on a hard
 * NFS mount (the capture's 124); `-k 1` sends KILL a second later to one that
 * ignored it (137). The executor's own deadline sits above both (2 + 1 + 5 s).
 */
export function sharePathProbeArgs(path: string): string[] {
  return ['-k', '1', String(SHARE_PATH_PROBE_S), STAT, '-f', '-c', '%t', '--', path]
}

/** Check one share path. Never throws. */
export async function probeSharePath(executor: CommandExecutor, path: string): Promise<SharePathProbe> {
  let r
  try {
    // LC_ALL=C: the missing-path verdict reads stat's error text, which is
    // translated in any other locale.
    r = await executor.exec(TIMEOUT, sharePathProbeArgs(path), { env: { LC_ALL: 'C' } })
  }
  catch (err) {
    if (err instanceof CommandTimeoutError) {
      // `timeout` itself could not end the stat (a process in uninterruptible
      // sleep): the executor stopped waiting. Still "not answering".
      return { state: 'not-answering', detail: `the stat did not return (${err.abandoned ? 'stuck in the kernel' : 'stopped'} after ${Math.round(err.budgetMs / 1000)} s)` }
    }
    return { state: 'unreadable', detail: err instanceof Error ? err.message : String(err) }
  }
  if (r.exitCode === 0)
    return { state: 'exists' }
  if (TIMED_OUT_EXITS.has(r.exitCode))
    return { state: 'not-answering', detail: `the stat did not return within ${SHARE_PATH_PROBE_S} s` }
  const line = r.stderr.trim().split('\n')[0] ?? ''
  if (r.exitCode === 1 && MISSING_RE.test(line))
    return { state: 'missing' }
  return { state: 'unreadable', detail: line || `stat exited ${r.exitCode}` }
}

/**
 * The wire fields for a share's path check: `pathState` always, and the
 * older `pathExists` only where it is a fact (exists / missing).
 */
export function sharePathFields(probe: SharePathProbe): { pathState: SharePathState, pathExists?: boolean } {
  if (probe.state === 'exists')
    return { pathState: 'exists', pathExists: true }
  if (probe.state === 'missing')
    return { pathState: 'missing', pathExists: false }
  return { pathState: probe.state }
}

/**
 * Check many paths at once, each path once (two shares on one path cost one
 * stat). Each check is its own child under its own 2 s, so one dead mount
 * never delays the others.
 */
export async function probeSharePaths(executor: CommandExecutor, paths: readonly string[]): Promise<Map<string, SharePathProbe>> {
  const unique = [...new Set(paths)]
  const results = await Promise.all(unique.map(p => probeSharePath(executor, p)))
  return new Map(unique.map((p, i) => [p, results[i]]))
}
