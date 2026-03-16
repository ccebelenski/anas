const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/**
 * Format a byte count to a human-readable string.
 * e.g. 503316480 → "480.0 MB"
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const value = bytes / Math.pow(k, i)
  return `${value.toFixed(decimals)} ${UNITS[i]}`
}
