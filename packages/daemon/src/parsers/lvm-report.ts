/**
 * Parsers for `pvs` / `vgs` / `lvs --reportformat json` (Epic 11 + AHR).
 *
 * The daemon always runs the byte form (`--units b --nosuffix` — sizes are
 * exact integer byte strings), but the parser also tolerates lvm's default
 * human-suffixed sizes (`508.00m`, `<2.49g`) because that is the form the
 * stage-0 ground truth captured (fixtures/ahr/lvm-*.json — see NOTES.md).
 * Suffixed values round-trip approximately (display precision), byte values
 * exactly. LVM suffix semantics: lowercase = powers of 1024, uppercase =
 * powers of 1000; a leading `<`/`>` marks display rounding and is ignored.
 */

/** Shared report flags — append to `pvs`/`vgs`/`lvs`. */
const LVM_REPORT_FLAGS = ['--reportformat', 'json', '--units', 'b', '--nosuffix']

/**
 * `-o +dev_size` APPENDS the underlying device size to the default columns, so
 * a PV that has not been resized after its md array grew is detectable from
 * structured output alone (`pv_size < dev_size`) — the system truth a resume
 * needs to plan its own catch-up pv-resize (issue #13). Appending keeps every
 * default column, so existing consumers and fixtures are unaffected.
 */
export const PVS_ARGS = [...LVM_REPORT_FLAGS, '-o', '+dev_size']
/**
 * `-o +vg_uuid` APPENDS the VG's LVM UUID (story ident.3): a VG NAME is reused
 * by a destroy-then-recreate, its UUID is not, so it is what an AHR expansion
 * intent records to tell its own pool from a later one of the same name.
 * Appending keeps every default column, exactly as `+dev_size` does for pvs.
 */
export const VGS_ARGS = [...LVM_REPORT_FLAGS, '-o', '+vg_uuid']

/**
 * The lvmcache columns, APPENDED the same way `+dev_size` is (story
 * ahrcache.1, AHR-DESIGN §13): a pool LV that is a cache target reports its
 * mode, policy and counters as structured cells — no parsing, no `dmsetup`
 * arithmetic (GT-18). Every default column is kept, so existing consumers and
 * fixtures are unaffected, and an UNCACHED LV simply reports them empty.
 *
 * Deliberately WITHOUT `-a`: the hidden `[<pool>-vol_corig]` / `[<cache>_cvol]`
 * sub-LVs are of no interest to any consumer, and admitting them would give the
 * topology reader's "the single LV in this VG" fallback three rows to choose
 * between.
 *
 * These numbers go STALE rather than absent once the cache device dies (GT-23),
 * so they are only ever presented behind the `dmsetup status` health gate.
 */
const LVS_CACHE_COLUMNS = [
  'cache_mode',
  'cache_policy',
  'cache_total_blocks',
  'cache_used_blocks',
  'cache_read_hits',
  'cache_read_misses',
  'cache_dirty_blocks',
].join(',')

export const LVS_ARGS = [...LVM_REPORT_FLAGS, '-o', `+${LVS_CACHE_COLUMNS}`]

// ---- Raw report shapes -----------------------------------------------------

interface RawPv {
  pv_name?: string
  vg_name?: string
  pv_size?: string
  pv_free?: string
  dev_size?: string
}

interface RawVg {
  vg_name?: string
  vg_uuid?: string
  pv_count?: string
  lv_count?: string
  vg_size?: string
  vg_free?: string
}

interface RawLv {
  lv_name?: string
  vg_name?: string
  lv_attr?: string
  lv_size?: string
  cache_mode?: string
  cache_policy?: string
  cache_total_blocks?: string
  cache_used_blocks?: string
  cache_read_hits?: string
  cache_read_misses?: string
  cache_dirty_blocks?: string
}

interface RawReport<K extends string, T> {
  report?: ({ [key in K]?: T[] })[]
}

// ---- Clean records ---------------------------------------------------------

/** One physical volume (an md band array, in AHR pools). */
export interface LvmPv {
  /** PV device path as lvm reports it (often the kernel md path). */
  name: string
  /** Owning VG name, or null for an unassigned PV. */
  vgName: string | null
  sizeBytes: number
  freeBytes: number
  /**
   * Size of the underlying device. `pv_size < devSizeBytes` means the PV has
   * not been resized to cover a grown array — the stranded-capacity signature
   * (issue #13). 0 when the report did not carry the column (older captures /
   * fixtures), which reads as "nothing to reclaim" — fail-safe, never a
   * spurious resize.
   */
  devSizeBytes: number
}

/** One volume group (one per AHR pool, named after it). */
export interface LvmVg {
  name: string
  /** LVM's VG UUID, or null when the report did not carry the column (older captures). */
  uuid: string | null
  pvCount: number
  lvCount: number
  sizeBytes: number
  freeBytes: number
}

/** One logical volume (`<pool>-vol` in AHR pools). */
export interface LvmLv {
  name: string
  vgName: string
  /** lv_attr string, e.g. "-wi-a-----" (a cached LV reads "Cwi-aoC---"). */
  attr: string
  sizeBytes: number
  /**
   * lvmcache columns (story ahrcache.1). `null` on every LV that is not a
   * cache target — the cells come back as empty strings there, and a 0 would
   * read as a measurement.
   *
   * On a DEAD cache device these keep reporting the last values the kernel
   * managed to read (GT-23), so no consumer may present them without first
   * checking `dmsetup status` (see parsers/dmsetup.ts).
   */
  cacheMode: string | null
  cachePolicy: string | null
  cacheTotalBlocks: number | null
  cacheUsedBlocks: number | null
  cacheReadHits: number | null
  cacheReadMisses: number | null
  cacheDirtyBlocks: number | null
}

// ---- Size parsing ----------------------------------------------------------

const BINARY_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
  e: 1024 ** 6,
}
const SI_UNITS: Record<string, number> = {
  B: 1,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  E: 1000 ** 6,
}

const SIZE_RE = /^[<>]?\s*([\d.]+)\s*([a-z]?)$/i

/**
 * Parse an lvm size cell to integer bytes. Handles the exact byte form
 * (`--units b --nosuffix`), suffixed human forms (lowercase binary, uppercase
 * SI), display-rounding `<`/`>` prefixes, and lvm's trailing-space quirk
 * (`"0 "`). Unparseable input yields 0 (fail-open, consistent with the other
 * tolerant parsers).
 */
export function parseLvmSize(value: string | undefined): number {
  if (!value)
    return 0
  const m = value.trim().match(SIZE_RE)
  if (!m)
    return 0
  const num = Number.parseFloat(m[1])
  if (Number.isNaN(num))
    return 0
  const unit = m[2]
  const factor = unit === '' ? 1 : (BINARY_UNITS[unit] ?? SI_UNITS[unit])
  if (factor === undefined)
    return 0
  return Math.round(num * factor)
}

// ---- Report parsing --------------------------------------------------------

function reportRows<K extends string, T>(json: string, key: K): T[] {
  let root: RawReport<K, T>
  try {
    root = JSON.parse(json)
  }
  catch {
    return []
  }
  const rows: T[] = []
  for (const section of root.report ?? []) {
    for (const row of section[key] ?? [])
      rows.push(row)
  }
  return rows
}

/** Parse `pvs --reportformat json` output. */
export function parsePvsReport(json: string): LvmPv[] {
  return reportRows<'pv', RawPv>(json, 'pv')
    .filter(r => typeof r.pv_name === 'string')
    .map(r => ({
      name: r.pv_name!,
      vgName: r.vg_name ? r.vg_name : null,
      sizeBytes: parseLvmSize(r.pv_size),
      freeBytes: parseLvmSize(r.pv_free),
      devSizeBytes: parseLvmSize(r.dev_size),
    }))
}

/** Parse `vgs --reportformat json` output. */
export function parseVgsReport(json: string): LvmVg[] {
  return reportRows<'vg', RawVg>(json, 'vg')
    .filter(r => typeof r.vg_name === 'string')
    .map(r => ({
      name: r.vg_name!,
      uuid: r.vg_uuid ? r.vg_uuid : null,
      pvCount: Number.parseInt(r.pv_count ?? '0', 10) || 0,
      lvCount: Number.parseInt(r.lv_count ?? '0', 10) || 0,
      sizeBytes: parseLvmSize(r.vg_size),
      freeBytes: parseLvmSize(r.vg_free),
    }))
}

/**
 * Whether an LV is ACTIVE, read from `lv_attr` field 5 (index 4) — lvm's State
 * field, and a structured column of the report (never scraped prose). ONLY `a`
 * means active; every other documented value means the volume is not usable:
 * `-` not active, `s`/`S` suspended (snapshot), `I` invalid snapshot,
 * `m`/`M` (suspended) snapshot merge failed, `d` mapped device without tables,
 * `i` mapped device with an inactive table, `X` unknown.
 *
 * An AHR pool whose band arrays did not all start comes up exactly here: the LV
 * is still listed by `lvs` and still sized, its VG is partial, and it is NOT
 * active — the volume is offline and no data can be read (issue #18).
 *
 * Returns `null` when the attr string is absent or too short to carry the field
 * (older captures and fixtures that dropped the column): UNKNOWN, never
 * "inactive" — a column we did not get must not manufacture a failure verdict.
 */
export function lvIsActive(attr: string): boolean | null {
  if (attr.length < 5)
    return null
  return attr[4] === 'a'
}

/**
 * Whether an LV is an lvmcache CACHE TARGET, read from `lv_attr` field 1
 * (index 0) — lvm's Volume-type field, where `C` means "cached". A structured
 * single character, never scraped prose, and it keeps reading `C` while the
 * cache device is missing (`Cwi-aoC-p-`, GT-19), which is exactly when the
 * question matters.
 *
 * This answers "is there a cache", NOT "is it working" — `dmsetup status` is
 * the only source for that (parsers/dmsetup.ts).
 */
export function lvIsCacheTarget(attr: string): boolean {
  return attr.length > 0 && attr[0] === 'C'
}

/** An lvm report cell that is present and non-empty, else null. */
function cell(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed || null
}

/** An lvm counter cell as an integer, or null when the column is empty. */
function counter(value: string | undefined): number | null {
  const raw = cell(value)
  if (raw === null)
    return null
  const n = Number.parseInt(raw, 10)
  return Number.isNaN(n) ? null : n
}

/** Parse `lvs --reportformat json` output. */
export function parseLvsReport(json: string): LvmLv[] {
  return reportRows<'lv', RawLv>(json, 'lv')
    .filter(r => typeof r.lv_name === 'string' && typeof r.vg_name === 'string')
    .map(r => ({
      name: r.lv_name!,
      vgName: r.vg_name!,
      attr: r.lv_attr ?? '',
      sizeBytes: parseLvmSize(r.lv_size),
      cacheMode: cell(r.cache_mode),
      cachePolicy: cell(r.cache_policy),
      cacheTotalBlocks: counter(r.cache_total_blocks),
      cacheUsedBlocks: counter(r.cache_used_blocks),
      cacheReadHits: counter(r.cache_read_hits),
      cacheReadMisses: counter(r.cache_read_misses),
      cacheDirtyBlocks: counter(r.cache_dirty_blocks),
    }))
}
