/**
 * Shared systemd unit-status parsing — the small pure helpers the units-as-store
 * services (replication, backup, snapshot schedules) all derive run-status from.
 * Extracted so a new store reuses ONE implementation rather than a third copy
 * (single-source-of-truth): `systemctl show` key/value parsing, systemd's
 * human/µs timestamp forms, and the oneshot ActiveState/Result → run-result map.
 *
 * Pure computation, no I/O — the caller runs `systemctl show` and feeds stdout.
 */

/** A run's outcome, mapped from a oneshot service's systemd state. */
export type SystemdRunResult = 'success' | 'failure' | 'running' | 'unknown'

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
 * Map a service's systemd state to a run result. A oneshot is 'activating' (or
 * 'active') while running; after it exits, Result carries the outcome and
 * ActiveState becomes 'failed' on failure.
 */
export function deriveRunResult(props: Record<string, string>): SystemdRunResult {
  const active = props.ActiveState
  if (active === 'activating' || active === 'active' || active === 'reloading')
    return 'running'
  if (active === 'failed')
    return 'failure'
  const result = props.Result
  if (result === 'success')
    return 'success'
  if (result && result.length > 0)
    return 'failure'
  return 'unknown'
}
