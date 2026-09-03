/**
 * Parsing utilities for converting ZFS command output into typed values.
 */

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
  P: 1024 ** 5,
  E: 1024 ** 6,
}

/**
 * A ZFS size value, in EITHER of the two forms the tools print:
 *
 *   display form  `480M`  `1.38G`  `0B`  `24K`   — 3 significant digits + unit
 *   exact form    `1331439861760`  `0`           — a unit-less byte count
 *
 * The unit is therefore OPTIONAL, and its absence means bytes. `%` and `x`
 * values have their own parsers below and must not fall in here.
 */
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*([BKMGTPE])?$/i
const PERCENT_RE = /^(\d+(?:\.\d+)?)%$/
/** A ratio, with or without the trailing `x` a non-`-p` command appends. */
const DEDUP_RATIO_RE = /^(\d+(?:\.\d+)?)x?$/

/**
 * Parse a ZFS size value to bytes.
 *
 * Both forms are accepted because BOTH are live in this codebase on purpose:
 * `zfsListArgs` asks for `-p` (issue #50 — a safety gate compares against its
 * numbers, and the display form's 3 significant digits are up to ~0.5% out),
 * while `zfs get -j all` and the snapshot listings stay in display form so the
 * property bag they carry stays human-readable. One tolerant parser, not two
 * that can drift apart (single source of truth).
 *
 * Examples: "480M" → 503316480, "123K" → 125952, "0B" → 0, "1.38G" →
 * 1481637478, "1331439861760" → 1331439861760.
 *
 * Returns 0 for "-", "none", empty and anything else unparseable. A `number`
 * is accepted as-is: `-p` output is documented as strings, but nothing stops a
 * future libzfs from emitting a JSON number and the safety gate must not care.
 */
export function parseHumanSize(str: string | number): number {
  if (typeof str === 'number')
    return Number.isFinite(str) ? Math.round(str) : 0
  if (!str || str === '-')
    return 0

  const match = str.match(SIZE_RE)
  if (!match)
    return 0

  const value = Number.parseFloat(match[1])
  const unit = (match[2] ?? 'B').toUpperCase()
  return Math.round(value * (SIZE_UNITS[unit] ?? 1))
}

/**
 * Parse a string to a non-negative integer. Returns 0 for non-numeric input.
 */
export function parseIntOrZero(str: string | number | undefined): number {
  if (str === undefined || str === null)
    return 0
  const n = typeof str === 'number' ? str : Number.parseInt(str, 10)
  return Number.isNaN(n) ? 0 : Math.max(0, n)
}

/**
 * Parse a percentage string like "3%" to a number. Returns 0 for "-" or invalid.
 */
export function parsePercent(str: string): number {
  if (!str || str === '-')
    return 0
  const match = str.match(PERCENT_RE)
  if (!match)
    return 0
  return Number.parseFloat(match[1])
}

/**
 * Parse a dedup/compress ratio like "1.00x" to a float. Returns 1.0 for "-" or
 * invalid. The trailing `x` is optional: whether libzfs keeps it under `-p` is
 * unverified on a real node (checklist item for the #50 live capture), so both
 * "1.42x" and "1.42" read as 1.42 rather than one of them silently defaulting.
 */
export function parseDedupRatio(str: string | number): number {
  if (typeof str === 'number')
    return Number.isFinite(str) ? str : 1.0
  if (!str || str === '-')
    return 1.0
  const match = str.match(DEDUP_RATIO_RE)
  if (!match)
    return 1.0
  return Number.parseFloat(match[1])
}

/**
 * Parse a ZFS date string to ISO 8601.
 * Input: "Mon Mar 16 02:09:34 UTC 2026"
 * Output: "2026-03-16T02:09:34.000Z"
 * Returns null for "-" or invalid input.
 */
export function parseZfsDate(str: string): string | null {
  if (!str || str === '-')
    return null
  const d = new Date(str)
  if (Number.isNaN(d.getTime()))
    return null
  return d.toISOString()
}

/**
 * Parse a ZFS boolean property ("on"/"off") to a boolean.
 */
export function parseZfsBool(str: string): boolean {
  return str === 'on'
}

/**
 * Parse ZFS-family `-j` JSON output, tolerating EMPTY stdout. Ground truth
 * (stunt node, 2026-07-18): with zero pools, `zpool list -j` prints NOTHING —
 * empty stdout, exit 0 — and the same holds family-wide for empty result
 * sets. A fresh node with no pools yet is a legitimate state, not an error:
 * blank input yields `empty` instead of a JSON.parse crash.
 */
export function parseZfsJson<T>(json: string | T, empty: T): T {
  if (typeof json !== 'string')
    return json
  const text = json.trim()
  return text === '' ? empty : JSON.parse(text) as T
}
