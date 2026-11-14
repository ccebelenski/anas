import type { ScrubRunning } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { parseBtrfsScrubStatus } from './ahr-scrub.js'

/**
 * The btrfs checksum scrub RUNNING RIGHT NOW on an AHR pool's filesystem
 * (scrub.r2, GitHub #82): phase 2 of the ANAS scrub — a day or more on a real
 * pool — and a `btrfs scrub` started outside ANAS both read idle while only
 * `ahrScrubRunning` was consulted, because md says nothing about the btrfs
 * pass. `ahrScrubRunning` keeps precedence; this runs only when no band is
 * checking. One `btrfs scrub status` per mounted AHR pool per `GET /scrub`
 * is the accepted cost.
 *
 * A status read that cannot be made (non-zero exit, a throw, the deadline)
 * answers {@link BTRFS_SCRUB_UNKNOWN} (cr3): the row says the running state is
 * unknown, never idle — and the whole `GET /scrub` still answers.
 *
 * The read carries its own 3 s deadline (`timeoutMs`) because the fail-open
 * above only holds for the ANSWER, not for the latency: with no deadline of
 * its own this request-lane call inherits the lane's 10 s (up to ~17 s when
 * the child ignores SIGTERM), and the panel polls every 10 s — one sick pool
 * would stall every row, ZFS included. 3 s is far above a `scrub status`
 * read's real cost and comfortably under the poll.
 *
 * WHY its own module instead of a sibling of `ahrScrubRunning` in
 * `scrub-schedules.ts`: the parser lives in `ahr-scrub.ts`, and the store
 * module is on the daemon START path (via the selfheal-reconcile read) — an
 * import edge from there would drag the whole scrub engine onto startup and
 * cycle `scrub-schedules ↔ ahr-scrub`, exactly what the F1/F4 structural guard
 * in `scrub-schedules.test.ts` exists to catch. Reached only through
 * `routes/scrub.ts`, this module stays off the start path and the guard green.
 */

/** The btrfs utility — module-private here, exactly as it is in `ahr-scrub.ts`. */
const BTRFS = '/usr/bin/btrfs'

/**
 * The answer when the status read could not be made (cr3, AHR-HEAL "other
 * doors": a failed or hung read used to answer null, which the row rendered
 * as "not running" — a scrub in flight shown idle). The row says unknown.
 */
export const BTRFS_SCRUB_UNKNOWN = 'unknown' as const

export async function btrfsScrubRunning(
  executor: CommandExecutor,
  mountpoint: string,
): Promise<ScrubRunning | null | typeof BTRFS_SCRUB_UNKNOWN> {
  try {
    const r = await executor.exec(BTRFS, ['scrub', 'status', mountpoint], { timeoutMs: 3000 })
    if (r.exitCode !== 0)
      return BTRFS_SCRUB_UNKNOWN
    const st = parseBtrfsScrubStatus(r.stdout)
    if (st.status !== 'running')
      return null
    return { phase: 'btrfs-checksums', ...(st.percent !== null && { percent: st.percent }) }
  }
  catch {
    return BTRFS_SCRUB_UNKNOWN
  }
}
