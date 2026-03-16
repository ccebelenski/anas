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
 * Parse a ZFS human-readable size string to bytes.
 * Examples: "480M" → 503316480, "123K" → 125952, "0B" → 0, "1.38G" → 1481637478
 * Returns 0 for "-" or empty strings.
 */
export function parseHumanSize(str: string): number {
  if (!str || str === '-') return 0

  const match = str.match(/^(\d+(?:\.\d+)?)\s*([BKMGTPE])$/i)
  if (!match) return 0

  const value = parseFloat(match[1])
  const unit = match[2].toUpperCase()
  return Math.round(value * (SIZE_UNITS[unit] ?? 1))
}

/**
 * Parse a string to a non-negative integer. Returns 0 for non-numeric input.
 */
export function parseIntOrZero(str: string | number | undefined): number {
  if (str === undefined || str === null) return 0
  const n = typeof str === 'number' ? str : parseInt(str, 10)
  return isNaN(n) ? 0 : Math.max(0, n)
}

/**
 * Parse a percentage string like "3%" to a number. Returns 0 for "-" or invalid.
 */
export function parsePercent(str: string): number {
  if (!str || str === '-') return 0
  const match = str.match(/^(\d+(?:\.\d+)?)%$/)
  if (!match) return 0
  return parseFloat(match[1])
}

/**
 * Parse a dedup ratio string like "1.00x" to a float. Returns 1.0 for "-" or invalid.
 */
export function parseDedupRatio(str: string): number {
  if (!str || str === '-') return 1.0
  const match = str.match(/^(\d+(?:\.\d+)?)x$/)
  if (!match) return 1.0
  return parseFloat(match[1])
}

/**
 * Parse a ZFS date string to ISO 8601.
 * Input: "Mon Mar 16 02:09:34 UTC 2026"
 * Output: "2026-03-16T02:09:34.000Z"
 * Returns null for "-" or invalid input.
 */
export function parseZfsDate(str: string): string | null {
  if (!str || str === '-') return null
  const d = new Date(str)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

/**
 * Parse a ZFS boolean property ("on"/"off") to a boolean.
 */
export function parseZfsBool(str: string): boolean {
  return str === 'on'
}
