/**
 * Ownership of an md sync operation — the ONE place that decides whether ANAS
 * may write `idle` to an array's `sync_action` (design review 2026-09-14, D2).
 *
 * ## Why this exists
 *
 * `echo idle > sync_action` and `mdadm --action=idle` do not mean "cancel the
 * check I asked for". They mean "stop whatever md is doing", and md is very
 * often doing something else: a member that failed while a repair or a scrub
 * was walking the pool puts the array straight into `recover`, rebuilding onto
 * a spare. Three code paths used to write `idle` on sight — the bounded check's
 * poll loop, the knob restore, and the scrub's band cancel — and every one of
 * them would ABORT that rebuild. The periodic scrub would do it on every pass.
 *
 * So the rule, in one function: re-read `sync_action` IMMEDIATELY before any
 * write of `idle`, and write only when it reads `check` AND this daemon is the
 * one that issued a check on that array and has not yet ended it. Anything
 * else — a resync, a recovery, a reshape, a repair, a frozen array, a check
 * somebody else started, or an attribute that cannot be read at all — is a
 * FOREIGN operation: the knob is left exactly as it is and the caller records
 * one sentence saying so.
 *
 * The same rule covers `sync_min` / `sync_max`: narrowing the window under a
 * running recovery, or widening it back mid-rebuild, is the same interference
 * with the same array.
 *
 * ## Why the issue log is not shadow state (Principle 11)
 *
 * Nothing here is persisted and nothing here is consulted as a fact about the
 * system — `sync_action` is always re-read from the kernel, and it is the
 * authority. The set records only what THIS process did in THIS run, which is
 * the one thing sysfs cannot tell us: md reports `check`, never "check, asked
 * for by anasd". After a restart the set is empty, which is the honest answer —
 * and then every op reads as foreign and nothing is interrupted, which is the
 * safe direction to fail.
 */

/**
 * Arrays this daemon has issued a `check` on and not yet ended, keyed by md
 * KERNEL name (`md127`) — the one identity both the repair engine and the
 * scrub resolve before they touch sysfs.
 */
const issuedChecks = new Set<string>()

/** Record that this run just wrote `check` to this array's `sync_action`. */
export function markCheckIssued(kernel: string): void {
  issuedChecks.add(kernel)
}

/** Forget a check this run issued — it has ended, or it is no longer ours. */
export function retireCheckIssued(kernel: string): void {
  issuedChecks.delete(kernel)
}

/** Has this run issued a check on this array that it has not yet retired? */
export function hasIssuedCheck(kernel: string): boolean {
  return issuedChecks.has(kernel)
}

/**
 * The `sync_max` value this daemon last NARROWED an array's window to, by
 * kernel name (cr3 AHR-HEAL-H4). The one fact that lets a cleanup tell "the
 * one-stripe window this run left" from a window someone else set: under a
 * foreign recovery or resync, `sync_max` is widened back to `max` only while it
 * still reads exactly this value. Not persisted, never consulted as a fact
 * about the array — `sync_max` itself is re-read every time (Principle 11).
 */
const narrowedWindows = new Map<string, string>()

/** Record that this run just wrote `sync_max` to this value on this array. */
export function markWindowNarrowed(kernel: string, syncMax: string): void {
  narrowedWindows.set(kernel, syncMax)
}

/** The `sync_max` this run last narrowed this array to, or null. */
export function narrowedSyncMax(kernel: string): string | null {
  return narrowedWindows.get(kernel) ?? null
}

/** The window is md's own again (or no longer ours to put back). */
export function forgetWindowNarrowed(kernel: string): void {
  narrowedWindows.delete(kernel)
}

/**
 * The foreign md operations a widened `sync_max` may release (cr3
 * AHR-HEAL-H4): a recovery and a resync, the two md parks at `sync_max`. Never
 * `reshape` (mdadm's backup-file reshape drives `sync_max` itself), never a
 * check or repair (not ours, and widening resumes them over the whole band),
 * never `frozen`, never an unreadable state. The ONE list both widen writes
 * (the repair's cleanup and the daemon-start reconcile) consult.
 */
const WIDEN_UNDER_ACTIONS = new Set(['recover', 'resync'])

/** May `sync_max` be widened under this `sync_action`? @see WIDEN_UNDER_ACTIONS */
export function mayWidenSyncMaxUnder(action: string | null): boolean {
  return action !== null && WIDEN_UNDER_ACTIONS.has(action)
}

/** Tests only: start from a clean slate between cases. */
export function forgetIssuedChecks(): void {
  issuedChecks.clear()
  narrowedWindows.clear()
}

/**
 * md is running nothing. `none` is what an array that has never synced reports;
 * a value that could NOT be read is deliberately not idle — an unreadable
 * attribute is a reason to leave the array alone, never a licence to write to
 * it.
 */
export function isIdleSyncAction(action: string | null): boolean {
  return action === 'idle' || action === 'none'
}

/** What `sync_action` said, and whether this run may end the op it names. */
export interface SyncOpOwnership {
  /** `sync_action` as it read a moment ago; null when it could not be read. */
  action: string | null
  /** md is running THIS run's check: `idle` may be written. */
  owned: boolean
  /** md is running something this run did not start: write nothing. */
  foreign: boolean
}

/**
 * Re-read `sync_action` and say whether this run owns the operation it names.
 *
 * The read is passed in because the two callers reach sysfs differently — the
 * repair engine reads the attribute file directly (its whole md layer does),
 * the scrub reads it through the executor so mock mode can fixture it. The
 * DECISION is here, once.
 */
export async function ownsSyncOp(
  kernel: string,
  readAction: () => Promise<string | null>,
): Promise<SyncOpOwnership> {
  const action = await readAction()
  if (isIdleSyncAction(action))
    return { action, owned: false, foreign: false }
  const owned = action === 'check' && issuedChecks.has(kernel)
  return { action, owned, foreign: !owned }
}

/** The sentence a caller records when it leaves a foreign operation alone. */
export function foreignOpNote(label: string, action: string | null): string {
  return `md is running ${action ?? 'an operation whose sync_action could not be read'} on ${label}; not touched`
}
