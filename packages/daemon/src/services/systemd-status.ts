/**
 * Shared systemd unit-status parsing — the small pure helpers the units-as-store
 * services (replication, backup, snapshot schedules) all derive run-status from.
 * Extracted so a new store reuses ONE implementation rather than a third copy
 * (single-source-of-truth): `systemctl show` key/value parsing, systemd's
 * human/µs timestamp forms, and the oneshot ActiveState/Result → run-result map.
 *
 * Pure computation, no I/O — the caller runs `systemctl show` and feeds stdout.
 */

/**
 * A run's outcome, mapped from a oneshot service's systemd state.
 *
 * `disabled` and `never-run` are not outcomes the unit reported — they are the
 * honest answers when systemd is holding NO run to date: the former because a
 * disabled unit's history is garbage-collected, the latter because an enabled
 * unit that has never fired has none to begin with. See
 * {@link hasRetainedRunHistory}.
 */
export type SystemdRunResult
  = 'success' | 'failure' | 'running' | 'unknown' | 'disabled' | 'never-run'

/**
 * The one-line caveat a DISABLED task's detail carries, so a reader who sees
 * `disabled` where a result used to be knows it is a systemd lifetime fact and
 * not a lost run. Defined once and rendered by backup, snapshot schedules and
 * replication alike (live-proof F9).
 */
export const DISABLED_HISTORY_NOTE
  = 'run history is not retained while a task is disabled'

/** systemd 'n/a' sentinel + a leading weekday name on a human timestamp. */
const NA_RE = /^n\/a$/i
const INFINITY_RE = /infinity/i
const WEEKDAY_PREFIX_RE = /^[A-Z][a-z]{2}\s+/

/** Parse `systemctl show` `key=value` lines into a map. */
export function parseShow(stdout: string): Record<string, string> {
  const props: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0)
      props[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return props
}

/**
 * Parse a systemd timestamp property to ISO, or null. On PVE 9 / systemd 257
 * these print a HUMAN date string ("Sun 2026-07-19 02:00:00 UTC"), NOT
 * microseconds (verified live) — handle both the µs form and the
 * day-name-prefixed date.
 */
export function parseSystemdTimestamp(raw: string | undefined): string | null {
  if (!raw || raw === '0' || NA_RE.test(raw) || INFINITY_RE.test(raw))
    return null
  const usec = Number(raw)
  if (Number.isFinite(usec) && usec > 0) {
    const d = new Date(Math.floor(usec / 1000))
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  // Strip a leading weekday name ("Sun ") — Date.parse dislikes it combined with
  // the "UTC" suffix on some engines; the rest parses cleanly.
  const cleaned = raw.replace(WEEKDAY_PREFIX_RE, '')
  const parsed = Date.parse(cleaned)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/**
 * Does systemd still hold a record of this unit having run?
 *
 * `Result=` is a DEFAULT-VALUED property: an unloaded unit prints `Result=success`
 * having never run at all. The exit/inactive timestamps are not defaulted — they
 * are empty exactly when there is no run to date them — so they are the reliable
 * "is there any history here" signal. Either one is enough.
 */
export function hasRetainedRunHistory(props: Record<string, string>): boolean {
  return parseSystemdTimestamp(props.ExecMainExitTimestamp) !== null
    || parseSystemdTimestamp(props.InactiveEnterTimestamp) !== null
}

/** What the caller knows that `systemctl show` does not. */
export interface RunResultContext {
  /**
   * Whether the task/schedule is ENABLED (its timer installed). Absent means
   * "not known", which behaves exactly as it did before this option existed.
   */
  enabled?: boolean
}

/**
 * Map a service's systemd state to a run result. A oneshot is 'activating' (or
 * 'active') while running; after it exits, Result carries the outcome and
 * ActiveState becomes 'failed' on failure.
 *
 * **The disabled hole (live-proof F9).** systemd unloads an inactive unit that
 * nothing references, and a DISABLED task has no installed timer to reference
 * its service — so its run history is garbage-collected, and `systemctl show`
 * then answers from property DEFAULTS: `Result=success` with empty timestamps.
 * Composed with "no result reads as success", a disabled task reported
 * `success` / next run `never` no matter what had actually happened to it,
 * including a failure. That is a fabricated outcome, which is worse than no
 * outcome, so when the caller says the task is disabled AND systemd retains no
 * history, the answer is `disabled` — there is no run to report.
 *
 * **The enabled twin.** An ENABLED unit is referenced by its timer, so systemd
 * keeps it loaded and its timestamps are not garbage-collected — which is why
 * empty exit/inactive timestamps on a loaded unit can mean exactly one thing:
 * it has NEVER run. The same default-valued `Result=success` then reads as a
 * successful run that never happened, so when the caller says the task is
 * enabled AND systemd retains no history, the answer is `never-run`. The gate
 * on `ActiveState` being present keeps the two honest absences distinct: an
 * EMPTY props map means systemd answered nothing at all and stays fail-open
 * `unknown` (never-run would fabricate an absence we did not verify).
 *
 * A disabled unit that is running RIGHT NOW (Run Now goes through the unit) or
 * that still has its timestamps is reported truthfully; an enabled unit that
 * has run (timestamps retained) likewise keeps its real result. The caveats
 * are only for the states where systemd genuinely holds no run to date.
 */
export function deriveRunResult(
  props: Record<string, string>,
  ctx: RunResultContext = {},
): SystemdRunResult {
  const active = props.ActiveState
  if (active === 'activating' || active === 'active' || active === 'reloading')
    return 'running'
  if (active === 'failed')
    return 'failure'
  if (ctx.enabled === false && !hasRetainedRunHistory(props))
    return 'disabled'
  if (ctx.enabled === true && active !== undefined && active !== '' && !hasRetainedRunHistory(props))
    return 'never-run'
  const result = props.Result
  if (result === 'success')
    return 'success'
  if (result && result.length > 0)
    return 'failure'
  return 'unknown'
}
