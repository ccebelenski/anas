/**
 * Parser for `btrfs filesystem usage -b <mount>` (Epic 11 + AHR).
 *
 * btrfs has no JSON here; `-b` (raw bytes) is the most structured form
 * available (GT-13). This is the ONLY sanctioned source of used/free space on
 * an AHR pool: btrfs's dup metadata and allocation model make free space
 * genuinely unknowable from device sizes, so it is always READ live, never
 * precomputed (GT-14).
 *
 * Tolerant of format drift by design: every field is looked up by its label
 * and is null when absent — the stage-0 fixtures include a truncated capture
 * (Overall block only) that must still parse.
 */

/** Args for the btrfs binary. `-b` = raw byte values. */
export function btrfsUsageArgs(mountpoint: string): string[] {
  return ['filesystem', 'usage', '-b', mountpoint]
}

/** Structured view of `btrfs filesystem usage -b`. Absent fields are null. */
export interface BtrfsUsage {
  /** Overall: Device size. */
  deviceSizeBytes: number | null
  /** Overall: Device allocated. */
  deviceAllocatedBytes: number | null
  /** Overall: Device unallocated. */
  deviceUnallocatedBytes: number | null
  /** Overall: Device missing (>0 = a device vanished under the fs). */
  deviceMissingBytes: number | null
  /** Overall: Used. */
  usedBytes: number | null
  /** Overall: Free (estimated) — the number the UI shows as free (GT-14). */
  freeEstimatedBytes: number | null
  /** The `(min: N)` companion of Free (estimated). */
  freeEstimatedMinBytes: number | null
  /** Overall: Free (statfs, df). */
  freeStatfsBytes: number | null
  /** Overall: Global reserve. */
  globalReserveBytes: number | null
  /** Data block-group profile, e.g. "single" — must NEVER be a btrfs raid5/6. */
  dataProfile: string | null
  /** Metadata profile, e.g. "DUP". */
  metadataProfile: string | null
  /** System profile, e.g. "DUP". */
  systemProfile: string | null
}

/** Overall-block labels → output fields. */
const LABEL_FIELDS: Record<string, keyof BtrfsUsage> = {
  'Device size': 'deviceSizeBytes',
  'Device allocated': 'deviceAllocatedBytes',
  'Device unallocated': 'deviceUnallocatedBytes',
  'Device missing': 'deviceMissingBytes',
  'Used': 'usedBytes',
  'Free (estimated)': 'freeEstimatedBytes',
  'Free (statfs, df)': 'freeStatfsBytes',
  'Global reserve': 'globalReserveBytes',
}

/** `Data,single: Size:8388608, Used:0 (0.00%)` section headers. */
const PROFILE_RE = /^(Data|Metadata|System),([^:]+):/

const MIN_RE = /\(min:\s*(\d+)\)/
const INT_RE = /-?\d+/

/**
 * Parse `btrfs filesystem usage -b` output. Total and fail-safe: unknown
 * lines are skipped and missing fields stay null — never throws.
 */
export function parseBtrfsUsage(text: string): BtrfsUsage {
  const out: BtrfsUsage = {
    deviceSizeBytes: null,
    deviceAllocatedBytes: null,
    deviceUnallocatedBytes: null,
    deviceMissingBytes: null,
    usedBytes: null,
    freeEstimatedBytes: null,
    freeEstimatedMinBytes: null,
    freeStatfsBytes: null,
    globalReserveBytes: null,
    dataProfile: null,
    metadataProfile: null,
    systemProfile: null,
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()

    const profile = line.match(PROFILE_RE)
    if (profile) {
      const value = profile[2].trim()
      if (profile[1] === 'Data')
        out.dataProfile = value
      else if (profile[1] === 'Metadata')
        out.metadataProfile = value
      else out.systemProfile = value
      continue
    }

    const colon = line.indexOf(':')
    if (colon === -1)
      continue
    const label = line.slice(0, colon).trim()
    const field = LABEL_FIELDS[label]
    if (!field)
      continue
    const rest = line.slice(colon + 1)
    const value = rest.match(INT_RE)
    if (value)
      out[field] = Number.parseInt(value[0], 10) as never

    if (field === 'freeEstimatedBytes') {
      const min = rest.match(MIN_RE)
      if (min)
        out.freeEstimatedMinBytes = Number.parseInt(min[1], 10)
    }
  }

  return out
}
