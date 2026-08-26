import type { RetentionBucket } from '@anas/shared'

/**
 * Naming convention for ANAS-scheduled snapshots (Epic 17): `anas-<bucket>-<utc>`.
 *
 * This convention is what SCOPES pruning to our own snapshots — retention only
 * ever touches names that parse here. Everything else (replication bases, manual
 * ZFS snapshots, AHR-manual snapshots) is `source: 'other'` and never pruned.
 *
 * The name is charset-safe for BOTH backends: it satisfies ZFS's snapshot-label
 * rules AND btrfs path-segment rules AND the shared `SnapshotName` /
 * `AhrSnapshotName` validators — no `:` (stripped from the UTC stamp), only
 * `[A-Za-z0-9._-]`, sortable lexicographically for a fixed bucket (the UTC stamp
 * sorts by time). The bucket names contain no `-`, and the UTC stamp's only `-`
 * are inside the date, so `anas-<bucket>-<utc>` parses unambiguously.
 */

const PREFIX = 'anas-'

/** Trailing `.<ms>Z` of an ISO timestamp (dropped — second precision is enough). */
const ISO_MILLIS_RE = /\.\d+Z$/
/** Colons of an ISO timestamp — stripped for a filesystem/label-safe segment. */
const COLON_RE = /:/g

/**
 * `anas-<bucket>-YYYY-MM-DDTHHMMSSZ`. The bucket is one of the six retention
 * periods; the ordered list below anchors the parse whitelist.
 */
const BUCKETS = ['frequently', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'] as const

/** `anas-daily-2026-07-26T142301Z` → its parts, or null when not an ANAS name. */
const PARSE_RE = new RegExp(
  `^${PREFIX}(${BUCKETS.join('|')})-(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z$`,
)

/** A compact UTC stamp usable as a single label/path segment (no `:`). */
function utcStamp(now: Date): string {
  return now.toISOString().replace(ISO_MILLIS_RE, 'Z').replace(COLON_RE, '')
}

/**
 * Format an ANAS-scheduled snapshot name for a bucket at `now` (UTC). The
 * canonical name a schedule fire creates: `anas-<bucket>-<utc>`.
 */
export function formatScheduledName(bucket: RetentionBucket, now: Date): string {
  return `${PREFIX}${bucket}-${utcStamp(now)}`
}

/** The decoded parts of an ANAS-scheduled snapshot name. */
export interface ParsedScheduledName {
  bucket: RetentionBucket
  /** The instant encoded in the name (UTC). */
  timestamp: Date
}

/**
 * Parse an ANAS-scheduled snapshot name back to its bucket + timestamp, or null
 * when `name` is not one of ours (the source-scoping gate). A syntactically
 * ANAS-shaped name whose date components do not form a real UTC instant also
 * returns null — we never treat a malformed name as prunable.
 */
export function parseScheduledName(name: string): ParsedScheduledName | null {
  const m = PARSE_RE.exec(name)
  if (!m)
    return null
  const [, bucket, y, mo, d, h, mi, s] = m
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`
  const timestamp = new Date(iso)
  if (Number.isNaN(timestamp.getTime()))
    return null
  // Reject overflow (e.g. month 13 that Date would silently roll over): the
  // round-trip must reproduce the same components byte-for-byte.
  if (timestamp.toISOString().replace(ISO_MILLIS_RE, 'Z') !== iso)
    return null
  return { bucket: bucket as RetentionBucket, timestamp }
}

/** Is `name` an ANAS-scheduled snapshot name (source: 'anas')? */
export function isScheduledName(name: string): boolean {
  return parseScheduledName(name) !== null
}

// ---------------------------------------------------------------------------
//  Transient backup snapshots (story backup2.3)
// ---------------------------------------------------------------------------

/**
 * A snapshot-consistent backup run takes a TRANSIENT snapshot per snapshottable
 * source, backs up from it, and destroys it in a `finally`. Its name is
 * `anas-backup-<taskname>-<unix-seconds>` — a distinct prefix from the
 * `anas-<bucket>-<utc>` schedule convention above, on purpose: these are not
 * retention points, they are scaffolding that exists for the duration of one
 * run.
 *
 * ⚠ THE WHOLE REASON THIS PREDICATE IS SHARED (backup2.3's flagged risk): two
 * other subsystems walk the same snapshot lists and would otherwise reason about
 * these as if they were durable —
 *
 *   - REPLICATION's newest-common-snapshot discovery. A transient that happened
 *     to be the newest common snapshot would become an incremental base, and the
 *     backup's `finally` destroy would then break the chain mid-flight. It also
 *     must not inflate `snapshotsBehind` (a source snapshot that is deliberately
 *     never replicated is not lag).
 *   - SCHEDULES RETENTION's bucketing/pruning. A transient must never occupy a
 *     bucket slot, never be counted, and never be handed to `zfs destroy` — the
 *     backup run owns its lifecycle from creation to destruction.
 *
 * Both read the answer from HERE, so the two can never drift apart.
 */
const TRANSIENT_PREFIX = 'anas-backup-'

/**
 * `anas-backup-<taskname>-<unix-seconds>`, with an OPTIONAL `__<suffix>` that
 * AHR's per-subvolume snapshots carry (a single btrfs ro snapshot drops nested
 * subvolumes — GT-52 — so one run takes several, and every one of them has to
 * be recognised by the stale sweep). The task name may itself contain dashes,
 * so the seconds group anchors the split.
 */
const TRANSIENT_RE = /^anas-backup-([a-z0-9][a-z0-9-]*?)-(\d{1,19})(?:__(.*))?$/

/**
 * The transient snapshot name a run of `task` takes at `at`. Unix SECONDS, not
 * an ISO stamp: it is a lifetime marker (older-than comparisons in the stale
 * sweep), never a calendar bucket, and seconds keep the label short and legal on
 * both backends.
 */
export function formatTransientBackupSnapshot(task: string, at: Date): string {
  return `${TRANSIENT_PREFIX}${task}-${Math.floor(at.getTime() / 1000)}`
}

/** The decoded parts of a transient backup-snapshot name. */
export interface ParsedTransientBackupSnapshot {
  /** The backup task the snapshot was taken for. */
  task: string
  /** When it was taken (from the unix-seconds suffix). */
  at: Date
  /** AHR only: the `__`-suffixed nested subvolume this snapshot covers. */
  subvolume?: string
}

/** Parse a transient backup-snapshot name, or null when it is not one. */
export function parseTransientBackupSnapshot(name: string): ParsedTransientBackupSnapshot | null {
  const m = TRANSIENT_RE.exec(name)
  if (!m)
    return null
  const seconds = Number(m[2])
  if (!Number.isFinite(seconds))
    return null
  return { task: m[1], at: new Date(seconds * 1000), ...(m[3] ? { subvolume: m[3] } : {}) }
}

/**
 * Is `name` a transient backup snapshot? The ONE predicate replication and
 * retention both consult (see the block comment above). Deliberately answers on
 * the PREFIX shape alone — a name that starts `anas-backup-` but does not fully
 * parse is still ours, and still must not be adopted as a replication base or
 * pruned by a retention policy.
 */
export function isTransientBackupSnapshot(name: string): boolean {
  return name.startsWith(TRANSIENT_PREFIX)
}

/** Is `name` a transient snapshot belonging to THIS task? (the stale sweep's scope) */
export function isTransientBackupSnapshotOf(name: string, task: string): boolean {
  return parseTransientBackupSnapshot(name)?.task === task
}
