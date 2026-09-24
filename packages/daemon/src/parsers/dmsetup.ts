/**
 * `dmsetup status` — the device-mapper target line of ONE mapped device
 * (story ahrcache.1, AHR-DESIGN §13).
 *
 * This exists for a single question: is the lvmcache in front of an AHR pool
 * actually working? `lvs` cannot answer it. When the cache device dies, the
 * lvmcache counters keep reporting the last values the kernel read before the
 * metadata went away (GT-23) — stale, not absent — while every read on the
 * pool returns EIO (GT-19). Device-mapper is honest about the same moment:
 *
 *   healthy   tank-tank--vol: 0 2080768 cache 8 3881/2048 128 3870/8000 …
 *   failed    tank-tank--vol: 0 2080768 cache Fail        (or `cache Error`)
 *   uncached  tank-tank--vol: 0 2080768 linear
 *
 * The failure WORD is not one word. GT-19 captured `Error` after a write had
 * aborted the metadata transaction; pulling the cache device under a pure read
 * load gives `Fail` (measured on the stunt node during ahrcache.1, kernel
 * 7.0.14-17-pve) — dm-cache emits `Fail` for a cache in CM_FAIL and `Error`
 * from the generic target-error path. Matching a token LIST would have been
 * one kernel wording away from reporting a dead cache as healthy, so the test
 * here is structural instead: a real dm-cache status line opens with the
 * metadata block size, a digit. Anything that does not is a failure word,
 * whatever this kernel calls it.
 *
 * TWO line shapes, both handled (measured on the stunt node, lvm2 2.03.31):
 * `dmsetup status` with NO argument lists every device and prefixes each line
 * with `<name>: `, while `dmsetup status <name>` — the form used here, because
 * it asks about one pool — prints the target line BARE:
 *
 *   # dmsetup status                 gtcache-gtcache--vol: 0 2080768 cache 8 …
 *   # dmsetup status gtcache-…--vol  0 2080768 cache 8 24/2048 128 8/8000 …
 *
 * After the optional name the shape is `<start> <length> <target> <args…>`.
 * Only the TARGET and whether its args are the single token `Error` are read —
 * deliberately not the cache status fields, whose layout has changed across
 * kernel versions and whose numbers `lvs` already reports as named columns.
 */

const DMSETUP = '/usr/sbin/dmsetup'

/** The `dmsetup` binary path — one home, so every caller runs the same one. */
export const DMSETUP_BIN = DMSETUP

const WHITESPACE_RE = /\s+/
/** A `<start>`/`<length>` field: a plain sector count. */
const SECTOR_RE = /^\d+$/
/** A real dm-cache status opens with the metadata block size — a digit. */
const LEADING_DIGIT_RE = /^\d/

/** Args for `dmsetup status <name>` (a single mapped device, by dm name). */
export function dmsetupStatusArgs(dmName: string): string[] {
  return ['status', dmName]
}

/** One parsed `dmsetup status` line. */
export interface DmStatusLine {
  /**
   * dm name as dmsetup prints it (e.g. `tank-tank--vol`), or null in the
   * single-device form, which does not repeat the name it was asked about.
   */
  name: string | null
  /** The target type: `cache`, `linear`, `thin-pool`, … */
  target: string
  /** Everything after the target type, verbatim and trimmed. */
  args: string
}

/**
 * Parse the FIRST target line of `dmsetup status` output, in either shape.
 * Null when the output is empty or does not carry a `<start> <len> <target>`
 * triplet — fail-open, like every other parser here: an unreadable line is
 * "unknown", never a manufactured verdict.
 *
 * A device with several targets prints several lines; an AHR pool LV is always
 * one whole-device target, so only the first is read.
 */
export function parseDmsetupStatus(stdout: string): DmStatusLine | null {
  const line = stdout.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (!line)
    return null
  const tokens = line.split(WHITESPACE_RE)
  // The listing form leads with `<name>:`; the single-device form does not.
  // A dm name cannot contain a colon, so the trailing one is unambiguous.
  const named = tokens[0].endsWith(':')
  const name = named ? tokens[0].slice(0, -1) : null
  const fields = named ? tokens.slice(1) : tokens
  // start, length, target — anything shorter is not a target line, and the
  // first two MUST be sector numbers. Without that test dmsetup's own prose
  // ("Device does not exist.") parses as a target line with target `not`.
  if (fields.length < 3 || !SECTOR_RE.test(fields[0]) || !SECTOR_RE.test(fields[1]))
    return null
  if (named && !name)
    return null
  return { name, target: fields[2], args: fields.slice(3).join(' ') }
}

/**
 * The health of a dm-cache target, from its status line:
 *  - `'healthy'` — the target reports a real status line, which by the
 *    kernel's own format opens with the metadata block size: a DIGIT.
 *  - `'failed'` — it reports a failure word instead (`Fail`, `Error`): the
 *    cache device is gone and EVERY read on the volume fails, promoted or not.
 *    dm-cache does NOT fall through to the origin (GT-19).
 *  - `null` — not a cache target (a plain `linear` volume), or nothing
 *    legible. "No cache" and "no line to read" are the same answer here: there
 *    is no cache health to report.
 *
 * The digit test, rather than a list of failure words, is deliberate — see the
 * module comment. It also errs in the safe direction: the failure this story
 * exists to fix is a pool reporting healthy while every read returns EIO, so
 * an unrecognised cache status must read as failed, never as fine.
 */
export function dmCacheHealth(line: DmStatusLine | null): 'healthy' | 'failed' | null {
  if (!line || line.target !== 'cache')
    return null
  return LEADING_DIGIT_RE.test(line.args.trim()) ? 'healthy' : 'failed'
}
