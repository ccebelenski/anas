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
export const VGS_ARGS = [...LVM_REPORT_FLAGS]
export const LVS_ARGS = [...LVM_REPORT_FLAGS]

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
  pvCount: number
  lvCount: number
  sizeBytes: number
  freeBytes: number
}

/** One logical volume (`<pool>-vol` in AHR pools). */
export interface LvmLv {
  name: string
  vgName: string
  /** lv_attr string, e.g. "-wi-a-----". */
  attr: string
  sizeBytes: number
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

/** Parse `lvs --reportformat json` output. */
export function parseLvsReport(json: string): LvmLv[] {
  return reportRows<'lv', RawLv>(json, 'lv')
    .filter(r => typeof r.lv_name === 'string' && typeof r.vg_name === 'string')
    .map(r => ({
      name: r.lv_name!,
      vgName: r.vg_name!,
      attr: r.lv_attr ?? '',
      sizeBytes: parseLvmSize(r.lv_size),
    }))
}
