import type { AhrPool, AhrScrubSchedule } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { AhrSnapshotOptions } from './ahr-snapshots.js'
import { readAhrPools } from './ahr-topology.js'
import { readScrubSchedule } from './scrub-schedule-units.js'
import { isEnabledArgs, MDCHECK_PRIMARY, parseMdcheckEnabled, SYSTEMCTL } from './scrub-schedules.js'
import {
  kernelName,
  MD_DEFAULT_RMW_LEVEL,
  MD_DEFAULT_STRIPE_CACHE_SIZE,
  MD_DEFAULT_SYNC_MAX,
  MD_DEFAULT_SYNC_MIN,
  mdSysPath,
  readMdAttrOrNull,
  writeMdAttr,
} from './selfheal-io.js'
import { sweepSelfhealPins } from './selfheal-repair.js'
import { isIdleSyncAction, mayWidenSyncMaxUnder } from './selfheal-syncop.js'

/**
 * Daemon-start reconciliation for the self-heal engine (design review
 * 2026-09-14, D4).
 *
 * ## What goes wrong without it
 *
 * The repair engine turns four md knobs aside for the duration of ONE 4 KiB
 * block — `sync_min`/`sync_max` down to a single stripe, `rmw_level` to 0,
 * `stripe_cache_size` to its 17-slot floor — and puts every one of them back in
 * a `finally`. A `finally` does not run for SIGKILL, for the OOM killer, or for
 * a package upgrade restarting anasd mid-sequence. The knobs then persist for
 * the LIFE OF THE ASSEMBLY, and none of it is visible:
 *
 *  - `sync_max` bounded to one stripe is GT-13's trap. The next monthly parity
 *    check covers that one stripe, suspends there, and the scrub's finish-wait
 *    then holds the pool's job exclusion for seven days. A whole band goes
 *    unchecked and the pool reports a scrub that "ran".
 *  - `rmw_level=0` makes every ordinary write to that array a
 *    reconstruct-write — correct, and much slower.
 *  - `stripe_cache_size=17` is the eviction floor, not a working size.
 *  - the transient `anas-selfheal-<ts>` snapshot pins an extent for ever.
 *
 * ## Why this is not shadow state (Principle 11)
 *
 * Nothing is remembered between runs and nothing is asserted about what ANAS
 * "owns". Every value is READ off the running kernel and compared with the
 * value md itself ships (GT-1: `rmw_level=1`, `sync_min=0`, `sync_max=max`,
 * `stripe_cache_size=256`); the snapshot sweep matches ANAS's own transient
 * prefix and destroys nothing else. Reading the system and putting a known
 * default back is the opposite of a shadow database.
 *
 * ## What it will not touch
 *
 * A band md is mid-operation on keeps `sync_min` and `sync_action` exactly as
 * they are and is REPORTED (D2 from the other direction: nothing here
 * interrupts or re-aims an operation md is running). `sync_max` is written
 * under one such operation only — a recovery or a resync over a window with
 * exactly the repair engine's one-stripe shape, widened to `max` (cr3
 * AHR-HEAL-H4, gated as {@link reconcileBand} says). `rmw_level` and
 * `stripe_cache_size` are safe to set under a running op — they change how md
 * writes, never what it is doing — so those are restored regardless.
 */

/** What one reconciliation pass did, one sentence per line, for journald. */
export interface SelfhealReconcileReport {
  /** Knobs put back, one line per band. */
  restored: string[]
  /** Transient snapshots destroyed. */
  snapshots: string[]
  /** Bands left alone because md was running something. */
  skipped: string[]
  /** Anything that could not be read or written — never fatal. */
  errors: string[]
  /**
   * State notes that are the WHOLE of their story — observed, said, never
   * acted on (the preset ruling, decision-tree F7). One line each.
   */
  notes: string[]
}

export interface SelfhealReconcileOptions {
  /** Pools to walk. Default: the node's, read live. */
  pools?: AhrPool[]
  /** Passed to the snapshot service (tests point its runtime dir at a temp path). */
  ahrSnapshotOptions?: AhrSnapshotOptions
  /**
   * The systemd unit directory the `anas-scrub` units live in. Provided by the
   * daemon (index.ts); ABSENT in the tests and the direct call, which is what
   * keeps the mdcheck-ownership note below from reading the test host's real
   * unit directory.
   */
  systemdDir?: string
  /**
   * Is a self-heal job IN FLIGHT on this pool right now (sixth pass, N9)?
   *
   * The reconciliation runs from `index.ts` AFTER the socket is listening, and
   * the boot scan it chains off can take minutes on a real node. An operator
   * who hits Repair or Rewrite parity in that window gets a job whose transient
   * snapshot this sweep would destroy and whose `sync_min`/`sync_max` this
   * walk would widen out from under it — the engine's OWN knobs, read as a
   * killed run's leftovers because they look exactly alike.
   *
   * The daemon wires the job queue's `findActive` for `ahr.repair`,
   * `ahr.parity-rewrite` and `ahr.scrub`. Absent (the direct/test call), every
   * pool is reconciled — the queue is in memory, so on a genuine cold start
   * there is nothing in flight to protect and the answer would be "no" anyway.
   */
  activeJob?: (pool: string) => { operation: string, id: string } | null | undefined
}

/** True when the report has nothing worth a journald line. */
export function reconcileWasQuiet(report: SelfhealReconcileReport): boolean {
  return report.restored.length === 0
    && report.snapshots.length === 0
    && report.skipped.length === 0
    && report.errors.length === 0
    && report.notes.length === 0
}

/**
 * The mdcheck-ownership note (the preset ruling, decision-tree F7).
 *
 * When ANAS's periodic scrub owns md checks — the `anas-scrub` units exist
 * WITH pools listed — the toggle has disabled mdadm's mdcheck timers. A
 * `systemctl preset`, or a manual enable, can turn them back on (GT-21: a
 * plain mdadm upgrade will NOT), and then TWO parity checks run on the node.
 * ANAS notes it, once, at daemon start, and does nothing else: re-disabling is
 * the operator's one command, stated in the note. The existing state note on
 * the Scrubs row ("double parity check: mdcheck is on") covers the UI side.
 *
 * Pure so the decision is testable without a unit directory; the caller reads
 * the two facts and hands them in.
 */
export function mdcheckReenabledNote(
  schedule: AhrScrubSchedule | null,
  mdcheckEnabled: boolean,
): string | null {
  if (!schedule || schedule.pools.length === 0 || !mdcheckEnabled)
    return null
  return 'mdcheck timers are enabled while ANAS periodic scrub owns md checks '
    + '(a systemctl preset or a manual enable turned them back on). Both will run. '
    + 'Disable them with: systemctl disable --now mdcheck_start.timer mdcheck_continue.timer'
}

/** The two facts the note reads: our schedule (null when the units are absent) and mdcheck's state. */
async function mdcheckOwnershipNote(executor: CommandExecutor, dir: string): Promise<string | null> {
  let schedule: AhrScrubSchedule | null = null
  try {
    schedule = await readScrubSchedule(dir)
  }
  catch {
    schedule = null
  }
  let mdcheckEnabled = false
  try {
    const r = await executor.exec(SYSTEMCTL, isEnabledArgs(MDCHECK_PRIMARY))
    mdcheckEnabled = parseMdcheckEnabled(r.stdout)
  }
  catch {
    mdcheckEnabled = false
  }
  return mdcheckReenabledNote(schedule, mdcheckEnabled)
}

/**
 * Walk every AHR band, put back any self-heal knob a killed repair left turned
 * aside, and sweep the engine's transient snapshots. Never throws — a
 * reconciliation that cannot read one band still fixes the others.
 */
export async function reconcileSelfhealState(
  executor: CommandExecutor,
  options?: SelfhealReconcileOptions,
): Promise<SelfhealReconcileReport> {
  const report: SelfhealReconcileReport = { restored: [], snapshots: [], skipped: [], errors: [], notes: [] }

  // The mdcheck-ownership note (F7) — before the pool walk, because it does
  // not depend on the pools being readable, and only when a unit directory was
  // handed in (the daemon does; the tests and the direct call do not, so they
  // never read the host's own unit directory).
  if (options?.systemdDir) {
    try {
      const note = await mdcheckOwnershipNote(executor, options.systemdDir)
      if (note)
        report.notes.push(note)
    }
    catch {
      // A note that cannot be decided says nothing — never fatal, never acted on.
    }
  }

  let pools: AhrPool[]
  try {
    pools = options?.pools ?? await readAhrPools(executor)
  }
  catch (error) {
    report.errors.push(`AHR pools could not be read: ${errorText(error)}`)
    return report
  }

  for (const pool of pools) {
    // A pool with a self-heal job in flight is left ENTIRELY alone — knobs and
    // snapshots both (N9). The ordering is unchanged: reconcile still runs
    // after the boot scan, it just refuses to reconcile over a live run.
    const active = options?.activeJob?.(pool.name)
    if (active) {
      report.skipped.push(
        `${pool.name}: not reconciled. ${active.operation} job ${active.id} is in flight on this pool, and its md knobs and transient snapshot are in use`,
      )
      continue
    }
    for (const array of pool.arrays) {
      const label = `${pool.name}-r${array.band}`
      try {
        await reconcileBand(executor, label, array.device, report)
      }
      catch (error) {
        report.errors.push(`${label}: ${errorText(error)}`)
      }
    }
    try {
      const sweep = await sweepSelfhealPins(executor, pool, pool.mountpoint, options?.ahrSnapshotOptions)
      report.snapshots.push(...sweep.swept)
      report.errors.push(...sweep.errors)
    }
    catch (error) {
      report.errors.push(`${pool.name}: transient self-heal snapshots could not be swept: ${errorText(error)}`)
    }
  }
  return report
}

/** A bare non-negative integer. */
const WINDOW_INTEGER_RE = /^\d+$/

/**
 * Is `sync_min..sync_max` exactly one window of the size the repair engine
 * narrows to (`windowSectors` in selfheal-repair.ts: 128 sectors on RAID1, one
 * chunk on RAID5/6), starting on a window boundary? Anything else — or a
 * level or chunk size that cannot be read — is not proven to be the engine's.
 */
async function isEngineWindow(sys: string, syncMin: string | null, syncMax: string | null): Promise<boolean> {
  if (syncMin === null || syncMax === null || !WINDOW_INTEGER_RE.test(syncMin) || !WINDOW_INTEGER_RE.test(syncMax))
    return false
  const level = await readMdAttrOrNull(sys, 'level')
  let per: number
  if (level === 'raid1') {
    per = 128
  }
  else if (level === 'raid5' || level === 'raid6') {
    const chunk = await readMdAttrOrNull(sys, 'chunk_size')
    if (chunk === null || !WINDOW_INTEGER_RE.test(chunk) || Number(chunk) <= 0)
      return false
    per = Number(chunk) / 512
  }
  else {
    return false
  }
  const min = Number(syncMin)
  return Number(syncMax) - min === per && min % per === 0
}

/** One band's four knobs, read and put back where they are not md's own. */
async function reconcileBand(
  executor: CommandExecutor,
  label: string,
  device: string,
  report: SelfhealReconcileReport,
): Promise<void> {
  const sys = mdSysPath(await kernelName(executor, device))
  if ((await readMdAttrOrNull(sys, 'level')) === null)
    return // not assembled — the boot scan's problem, not this one's

  const action = await readMdAttrOrNull(sys, 'sync_action')
  const syncMin = await readMdAttrOrNull(sys, 'sync_min')
  const syncMax = await readMdAttrOrNull(sys, 'sync_max')

  const windowNarrowed = (syncMax !== null && syncMax !== MD_DEFAULT_SYNC_MAX)
    || (syncMin !== null && syncMin !== MD_DEFAULT_SYNC_MIN)
  if (windowNarrowed) {
    // cr3 AHR-HEAL-H4 — a recovery or a resync md may park at a one-stripe
    // window a killed repair left (the parking is from md's source as
    // recalled, not captured; see `widenUnderForeignOp`). No run of THIS
    // process wrote it, so the proof that it is the engine's is its SHAPE:
    // exactly one window of the engine's own size (one chunk of a parity
    // band, 128 sectors of a mirror). Its cost when the shape coincides with
    // someone else's window is I/O (a check runs on past it), never data.
    //
    // UNPROVEN: what md leaves in `sync_min` after a check interrupted by a
    // member failure. If it is [high, high] (the review's expectation) this
    // branch never fires for that case. The node probe records it: variant B
    // with the daemon KILLED before the member is failed, reading
    // sync_min/sync_max before and after.
    //
    // Gated like the repair's cleanup: `sync_action` (read above) must allow
    // it, and — re-read AFTER `sync_max`, immediately before the write —
    // `sync_action` again and `reshape_position === 'none'` (unreadable is not
    // `none`). Never `sync_min` (EBUSY mid-recovery), never `idle`.
    const shaped = mayWidenSyncMaxUnder(action) && await isEngineWindow(sys, syncMin, syncMax)
    const actionNow = shaped ? await readMdAttrOrNull(sys, 'sync_action') : null
    const reshape = shaped ? await readMdAttrOrNull(sys, 'reshape_position') : null
    if (shaped && mayWidenSyncMaxUnder(actionNow) && reshape === 'none') {
      await writeMdAttr(sys, 'sync_max', MD_DEFAULT_SYNC_MAX)
      report.restored.push(
        `${label}: sync_max widened to max under ${actionNow} (was ${syncMin ?? '?'}..${syncMax ?? '?'}: a killed repair's one-stripe window, which md parks a ${action} at). sync_min was left at ${syncMin ?? '?'}: md refuses it mid-${action}; the next pass puts it back once md is idle`,
      )
    }
    else if (!isIdleSyncAction(action)) {
      // Widening `sync_max` under a running recovery resumes and then re-bounds
      // an operation that is not ours. Say what was found; the next pass, or
      // the scrub's own pre-issue check, puts it back once md is done.
      report.skipped.push(
        `${label}: sync_min=${syncMin ?? 'unreadable'} sync_max=${syncMax ?? 'unreadable'} left as they are: md is running ${action ?? 'an operation whose sync_action could not be read'}`,
      )
    }
    else {
      await writeMdAttr(sys, 'sync_min', MD_DEFAULT_SYNC_MIN)
      await writeMdAttr(sys, 'sync_max', MD_DEFAULT_SYNC_MAX)
      report.restored.push(
        `${label}: sync window restored to ${MD_DEFAULT_SYNC_MIN}..${MD_DEFAULT_SYNC_MAX} (was ${syncMin ?? '?'}..${syncMax ?? '?'}: a repair had left it bounded to one stripe, which would have made the next parity check cover that stripe alone)`,
      )
    }
  }

  const rmw = await readMdAttrOrNull(sys, 'rmw_level')
  if (rmw !== null && rmw !== MD_DEFAULT_RMW_LEVEL) {
    await writeMdAttr(sys, 'rmw_level', MD_DEFAULT_RMW_LEVEL)
    report.restored.push(`${label}: rmw_level restored to ${MD_DEFAULT_RMW_LEVEL} (was ${rmw})`)
  }

  const cache = await readMdAttrOrNull(sys, 'stripe_cache_size')
  const cacheSize = cache === null ? null : Number(cache)
  if (cacheSize !== null && Number.isFinite(cacheSize) && cacheSize < MD_DEFAULT_STRIPE_CACHE_SIZE) {
    await writeMdAttr(sys, 'stripe_cache_size', String(MD_DEFAULT_STRIPE_CACHE_SIZE))
    report.restored.push(`${label}: stripe_cache_size restored to ${MD_DEFAULT_STRIPE_CACHE_SIZE} (was ${cache})`)
  }
}

/** An error's message, without a stack, for a line an operator reads. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
