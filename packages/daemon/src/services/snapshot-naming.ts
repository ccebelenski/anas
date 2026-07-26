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
