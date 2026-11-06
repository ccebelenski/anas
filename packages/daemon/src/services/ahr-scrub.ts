import type { AhrMetadataCorrected, AhrPool, AhrScrubFinding, AhrScrubResult, AhrScrubStripe } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { ExtentItem, SelfhealContext } from './selfheal-map.js'
import { AhrMetadataCorrected as AhrMetadataCorrectedSchema, AhrScrubResult as AhrScrubResultSchema } from '@anas/shared'
import { parseFindmnt } from '../parsers/findmnt.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { run } from './ahr-exec.js'
import { ahrLvPath } from './ahr-paths.js'
import { SUBVOL_DATA, subvolFromMountOptions } from './ahr-snapshots.js'
import { AhrTopologyUnreadableError } from './ahr-topology.js'
import { pveNotify } from './pve-notify.js'
import { mismatchCntArgs } from './scrub-schedules.js'
import {
  dropCaches,
  MD_DEFAULT_SYNC_MAX,
  MD_DEFAULT_SYNC_MIN,
  mdSysPath,
  probeFileBlock,
  readMdAttrOrNull,
  writeMdAttr,
} from './selfheal-io.js'
import { BTRFS_STRIPE_BYTES, extentsForStripe, resolveContext } from './selfheal-map.js'
import {
  foreignOpNote,
  isIdleSyncAction,
  markCheckIssued,
  ownsSyncOp,
  retireCheckIssued,
} from './selfheal-syncop.js'

/**
 * AHR pool scrub (Epic 11 + AHR, docs/AHR-DESIGN.md §4) — behind
 * POST /v1/ahr/:name/scrub. ONE scrub, TWO phases, strictly SEQUENTIAL and
 * never severable (story selfheal.4) — both are full-device reads and would
 * thrash each other concurrently (§4):
 *
 *   1. per-array `mdadm --action=check`, one band at a time — verifies
 *      parity/mirror consistency underneath the filesystem. Each band is waited
 *      through TWICE: first until md has actually STARTED the check
 *      (`sync_action`, or /proc/mdstat), then until it is idle again. A band
 *      whose check counted parity mismatches (`/sys/block/<md>/md/mismatch_cnt`
 *      > 0, read once the check has run AND gone idle) warns immediately: rot
 *      exists, and phase 2 is what names the files. A band md never started is
 *      said so and its counter — which belongs to an earlier check — is not
 *      read at all; a band whose check FINISHED before the first poll is
 *      recognised from `last_sync_action` TOGETHER WITH a `mismatch_cnt` that
 *      moved (md zeroes the counter at a sync start — `last_sync_action` is
 *      persistent and proves nothing on its own), and only then is its counter
 *      the verdict; and a band md froze, or took a resync/recover/reshape on
 *      instead, has this scrub's check CANCELLED (`--action=idle`, so it
 *      cannot fire beside the next band's) and is recorded as not checked —
 *      the scrub moves to the next band rather than spinning.
 *   2. btrfs scrub (start + poll `btrfs scrub status`) — checksums the
 *      filesystem's view of the data — then the ATTRIBUTION pass (story
 *      selfheal.3) names the corrupt files and their failing 4 KiB blocks.
 *
 * The attribution's probe reads are tiny, but they are still reads of the
 * array: §4's rule is that nothing else reads while a check runs, and running
 * it after phase 1 keeps that true (it used to sit between the phases when the
 * order was reversed). The manual Scrub button and the periodic timer run this
 * same code path — one job, one order.
 *
 * `btrfs scrub status` text is parsed minimally (Status / Bytes scrubbed % /
 * Error summary): like /proc/mdstat it has no structured alternative on the
 * shipped btrfs-progs, so it joins GT-13's sanctioned text exceptions.
 *
 * The per-band record rides the result (design review 2026-09-14, D1/D8):
 * `parityMismatches` (phase 1's verdicts), `bandsChecked` and `bandsSkipped`
 * (what was and was not looked at). A mismatch phase 2 cannot attribute is
 * PARITY-ONLY ROT — data checksums pass, the parity (or Q) member
 * disagrees, nothing in ANAS repairs it — and it gets its own second
 * notification instead of dying in the silence after "phase 2 will name the
 * files". `checkedArrays` counts bands actually checked, never the pool's
 * array count.
 *
 * Findings notify at `warning` via PVE (§7.2); a clean scrub that checked
 * every band is silent — healthy/idle shows nothing (dashboard policy §7.3) —
 * UNLESS the run's journal window carries corrected metadata reads
 * (selfheal.12, GT-20): the one rot signal a clean scrub can hold, which then
 * earns its own warning.
 */

const BTRFS = '/usr/bin/btrfs'
const MDADM = '/usr/sbin/mdadm'
const CAT = '/usr/bin/cat'
// The absent-file shape of a failed `cat /proc/mdstat`, copied from
// `readAhrPools` (ahr-topology.ts) — the two readers must treat ENOENT alike.
const CAT_MISSING_RE = /No such file or directory/
const REALPATH = '/usr/bin/realpath'
const JOURNALCTL = '/usr/bin/journalctl'
const STAT = '/usr/bin/stat'
const FINDMNT = '/usr/bin/findmnt'

/** `findmnt --json --real <mountpoint>` — the one mount, with its options. */
export const AHR_SCRUB_FINDMNT_ARGS = ['--json', '--real']

/** Default poll interval while waiting on scrub/check progress. */
export const AHR_SCRUB_POLL_MS = 5000

/**
 * Pause between a band's check going idle and the mismatch_cnt read (story
 * selfheal.4): md finalises the counter as the sync thread winds down, and the
 * +1 s is the margin a just-finished check needs before its counter is final.
 */
export const AHR_SCRUB_MISMATCH_DELAY_MS = 1000

/**
 * How long a band's check is given to actually START before the band is
 * recorded as not checked.
 *
 * Writing `check` to `sync_action` sets the recovery flags synchronously, so
 * the attribute reads `check` essentially as soon as mdadm returns; this window
 * exists for the case where md never takes it at all (frozen, already syncing,
 * an array that refuses). Without it the wait loop could look once, see an
 * array that had not started yet, call the check finished, and then read a
 * `mismatch_cnt` belonging to some EARLIER check — while phase 2 ran on top of
 * the check md was about to start.
 */
export const AHR_SCRUB_CHECK_START_TIMEOUT_MS = 30000

/**
 * The LAST-RESORT ceiling on one band's finish-wait (second-pass review F3).
 *
 * A check is unbounded BY DESIGN — days on a 20 TB band is normal, and the
 * poll loop is what keeps the job honest while it runs. The real exit from a
 * stuck wait is the sync_action policy below (frozen, or any non-check op, ends
 * the wait for that band immediately). This ceiling exists only for the state
 * nobody predicted: without it a band that never goes idle spins the job
 * forever, and with the active-job exclusion (R7) every later scrub or repair
 * on the pool is refused until anasd restarts.
 */
export const AHR_SCRUB_CHECK_FINISH_CEILING_MS = 7 * 24 * 60 * 60 * 1000

export interface AhrScrubOptions {
  /** Poll interval override (tests use 1). */
  pollIntervalMs?: number
  /** Delay before the mismatch_cnt read (tests use 1). */
  mismatchDelayMs?: number
  /** How long to wait for a band's check to start (tests use a few ms). */
  checkStartTimeoutMs?: number
  /** Absolute ceiling on a band's finish-wait (tests use a few ms). */
  checkFinishCeilingMs?: number
}

/** Minimal structured view of `btrfs scrub status`. */
interface BtrfsScrubStatus {
  /** `Status:` value (running/finished/aborted/…), or null when absent. */
  status: string | null
  /** Percent from the `Bytes scrubbed: … (N%)` line, when present. */
  percent: number | null
  /** `Error summary:` value, or null when absent. */
  errorSummary: string | null
}

const STATUS_RE = /^Status:\s+(\S+)/m
const PERCENT_RE = /^Bytes scrubbed:.*\(([\d.]+)%\)/m
const ERROR_SUMMARY_RE = /^Error summary:\s+(\S.*)$/m
const DEV_PREFIX_RE = /^\/dev\//

/** Parse the human-readable `btrfs scrub status` output (fail-open nulls). */
export function parseBtrfsScrubStatus(text: string): BtrfsScrubStatus {
  return {
    status: text.match(STATUS_RE)?.[1] ?? null,
    percent: PERCENT_RE.test(text) ? Number.parseFloat(text.match(PERCENT_RE)![1]) : null,
    errorSummary: text.match(ERROR_SUMMARY_RE)?.[1].trim() ?? null,
  }
}

/** A clean btrfs error summary (`no errors found`). */
function isCleanSummary(summary: string | null): boolean {
  return summary === null || summary === 'no errors found'
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The parity-mismatch counter md kept for a check on this array —
 * `/sys/block/<kernelName>/md/mismatch_cnt`, the same sysfs file the 11.17 md
 * event hook reads. Null when unreadable (fail-open: a missing counter costs
 * the early warning, never a false "rot exists").
 */
export async function mismatchCount(
  executor: CommandExecutor,
  kernelName: string,
): Promise<number | null> {
  try {
    const r = await executor.exec(CAT, mismatchCntArgs(kernelName))
    if (r.exitCode !== 0)
      return null
    const n = Number.parseInt(r.stdout.trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  catch {
    return null
  }
}

/** `/sys/block/<md>/md/sync_action` — what md says it is doing right now. */
export function syncActionArgs(kernelName: string): string[] {
  return [`/sys/block/${kernelName}/md/sync_action`]
}

/** `/sys/block/<md>/md/last_sync_action` — the last sync op md actually RAN. */
export function lastSyncActionArgs(kernelName: string): string[] {
  return [`/sys/block/${kernelName}/md/last_sync_action`]
}

/** Everything md prints in `sync_action`. Anything else is not an answer. */
const MD_SYNC_ACTIONS = new Set(['idle', 'none', 'frozen', 'resync', 'recover', 'check', 'repair', 'reshape'])

/**
 * md is doing nothing this wait can watch.
 *
 * Wider than {@link isIdleSyncAction} on purpose: an UNREADABLE `sync_action`
 * ends a wait (there is no signal left to wait on), but it must never license a
 * write — which is why the ownership helper treats null as not-idle and this
 * one does not (D2).
 */
function isIdleAction(action: string | null): boolean {
  return action === null || isIdleSyncAction(action)
}

/** The finish-wait ceiling, in the largest unit that states it plainly. */
function ceilingText(ms: number): string {
  if (ms >= 86400000)
    return `${Math.round(ms / 86400000)}d`
  if (ms >= 3600000)
    return `${Math.round(ms / 3600000)}h`
  return `${ms}ms`
}

/** One of md's two sync-op attributes, or null when it cannot be read. */
async function readSyncAttr(
  executor: CommandExecutor,
  args: string[],
): Promise<string | null> {
  try {
    const r = await executor.exec(CAT, args)
    const value = r.exitCode === 0 ? r.stdout.trim() : ''
    return MD_SYNC_ACTIONS.has(value) ? value : null
  }
  catch {
    return null
  }
}

/**
 * md's own word for this array's current sync operation, or null when it cannot
 * be read.
 *
 * Null is a real answer — a value md does not use is treated as unreadable
 * rather than as a state to wait on, which is what keeps the wait loops from
 * hanging on anything but md itself.
 */
export async function syncAction(
  executor: CommandExecutor,
  kernelName: string,
): Promise<string | null> {
  return readSyncAttr(executor, syncActionArgs(kernelName))
}

/**
 * The last sync operation md RAN on this array — the evidence a check that
 * finished before the first poll ever happened (story selfheal.4, F11).
 *
 * The same sysfs file the 11.17 md event hook reads to tell a routine check
 * from a real rebuild.
 */
export async function lastSyncAction(
  executor: CommandExecutor,
  kernelName: string,
): Promise<string | null> {
  return readSyncAttr(executor, lastSyncActionArgs(kernelName))
}

/**
 * One of the repair engine's sync-window knobs, or null when it cannot be read.
 *
 * Read through the SAME md layer that writes them (`selfheal-io.ts`) rather
 * than through `cat`, so the pre-issue guard below and the engine's own
 * save/restore are looking at one thing. Null is the answer on a band whose
 * sysfs is not there, and a null never triggers a restore.
 */
async function readSyncValue(kernelName: string, key: 'sync_min' | 'sync_max'): Promise<string | null> {
  return readMdAttrOrNull(mdSysPath(kernelName), key)
}

/**
 * Put a band's sync window back to md's own `0 … max` (GT-1), for a band the
 * caller has ALREADY proven idle. False when the write did not take — the
 * caller then skips the band rather than issuing a check into a one-stripe
 * window.
 */
async function restoreSyncWindow(kernelName: string): Promise<boolean> {
  try {
    await writeMdAttr(mdSysPath(kernelName), 'sync_min', MD_DEFAULT_SYNC_MIN)
    await writeMdAttr(mdSysPath(kernelName), 'sync_max', MD_DEFAULT_SYNC_MAX)
    return true
  }
  catch {
    return false
  }
}

/**
 * Take back the check this scrub asked for on a band it is walking away from
 * (third pass, T4) — but ONLY when the check is still the thing md is running
 * (design review 2026-09-14, D2).
 *
 * The finish-wait abandons a band md froze, took another sync op on, or simply
 * never finished before the ceiling. ANAS's `--action=check` is still ARMED on
 * it in some of those cases, and the loop moves straight on to issue the next
 * band's check — so when the array thaws, two parity checks run at once across
 * disks that are very often the same spindles. §4's whole point is that a
 * scrub's reads are strictly sequential.
 *
 * The dangerous case is the one that used to be treated the same way. A member
 * that failed mid-scrub puts md into `recover`, rebuilding onto a spare, and
 * `mdadm --action=idle` does not mean "drop my check" — it means "stop what you
 * are doing". It ABORTS the rebuild, and the periodic scrub does it on every
 * pass. So `sync_action` is re-read immediately before the write and the write
 * happens only for a `check` this run issued; every other state is left exactly
 * as it is and named in the progress line.
 *
 * Best-effort otherwise: md refuses `idle` on a frozen array (EBUSY), and a
 * failure there is worth a sentence, never a failed scrub. Returns what to say.
 */
async function cancelBandCheck(
  executor: CommandExecutor,
  device: string,
  kernelName: string | null,
  label: string,
  action: string | null,
): Promise<string> {
  if (kernelName === null) {
    // Nothing to read `sync_action` from, so nothing can be proven about what
    // md is doing — and an unprovable `idle` is exactly the write that aborts
    // a rebuild. Leave it, and say the check may still be armed.
    return `could not drop this scrub's check on ${label}. ${device} does not resolve to a kernel device, so what md is running there cannot be read. Nothing was written, and the check may still run beside a later band's check`
  }

  const own = await ownsSyncOp(kernelName, () => syncAction(executor, kernelName))
  if (own.action === 'frozen') {
    // md refuses `idle` on a frozen array (EBUSY), so the write was always a
    // no-op here — and an array that is frozen is one md may be about to do
    // something of its own on. Say plainly that the check may still be armed.
    retireCheckIssued(kernelName)
    return `could not drop this scrub's check on ${label}. md refuses idle on a frozen array, so the check may still run when it thaws`
  }
  if (own.foreign) {
    retireCheckIssued(kernelName)
    return `left ${label} alone: ${foreignOpNote(label, own.action)}. This scrub's check on ${label} was not dropped, because ending md's own operation would abort it`
  }
  if (!own.owned) {
    // Already idle: md is running nothing, so there is nothing to take back.
    retireCheckIssued(kernelName)
    return `this scrub's check on ${label} is no longer running. Nothing to drop`
  }

  let failure: string | null = null
  try {
    const r = await executor.exec(MDADM, ['--action=idle', device])
    if (r.exitCode !== 0)
      failure = r.stderr.trim() || `mdadm --action=idle exited ${r.exitCode}`
  }
  catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }
  retireCheckIssued(kernelName)
  if (action === 'frozen') {
    // md refuses idle while the array is frozen, so this one is expected to
    // bounce — say plainly that the check may still be armed when it thaws.
    return failure === null
      ? `asked md to drop this scrub's check on ${label}`
      : `could not drop this scrub's check on ${label} (${failure}). md refuses idle on a frozen array, so the check may still run when it thaws`
  }
  return failure === null
    ? `dropped this scrub's check on ${label} so it cannot run beside the next band's check`
    : `could not drop this scrub's check on ${label} (${failure}). The check may still run beside a later band's check`
}

/**
 * An md `check` running on ANY AHR band of the node, or null (S6).
 *
 * The route's "already scrubbing" refusals are all in-process: the pool state
 * the topology read reports, and the job queue's own record. Neither survives a
 * daemon restart. A restart mid-scrub leaves md's check on band r1 running
 * happily while the job that started it is gone — and the next scrub then
 * issues checks on bands that share spindles with it, which is precisely what
 * §4 exists to prevent. /proc/mdstat is the one place that still knows, so it
 * is read ONCE and every AHR band on the node is matched against it.
 *
 * A DELAYED or PENDING check counts: md has it queued and it will fire.
 *
 * cr.64b2-iii (Q): a FAILED mdstat read never answers "no check running". The
 * rule is `readAhrPools`' (ahr-topology.ts): an ABSENT `/proc/mdstat`
 * (coreutils cat's ENOENT line, exit 1) is honestly "no md arrays" — no check
 * can run on a node with no md — but EVERY other non-zero exit (Permission
 * denied, an I/O error) throws the same typed {@link AhrTopologyUnreadableError}
 * the topology readers throw, so the gate's route answers 503 UNAVAILABLE
 * naming the read instead of passing a scrub beside a check it could not see.
 */
export async function runningAhrCheck(
  executor: CommandExecutor,
  pools: AhrPool[],
): Promise<{ label: string, kernelName: string } | null> {
  const labels = new Map<string, string>()
  for (const pool of pools) {
    for (const array of pool.arrays) {
      if (array.kernelName)
        labels.set(array.kernelName, `${pool.name}-r${array.band}`)
    }
  }
  if (labels.size === 0)
    return null
  const mdstatRes = await executor.exec(CAT, MDSTAT_CAT_ARGS)
  if (mdstatRes.exitCode !== 0) {
    // The ENOENT rule copied from `readAhrPools` (ahr-topology.ts): cat's
    // `No such file or directory` line means no md stack — honestly "no
    // arrays", no check. Every other failed read could not SEE the checks.
    if (CAT_MISSING_RE.test(mdstatRes.stderr))
      return null
    throw new AhrTopologyUnreadableError('cat /proc/mdstat', mdstatRes.exitCode, mdstatRes.stderr)
  }
  const mdstat = parseMdstat(mdstatRes.stdout)
  for (const md of mdstat) {
    const label = labels.get(md.kernelName)
    if (!label)
      continue
    if (md.sync?.action === 'check' || md.syncDelayed || md.syncPending)
      return { label, kernelName: md.kernelName }
  }
  return null
}

// ---- Attribution: WHAT is corrupt (story selfheal.3) ------------------------

/**
 * `Error summary: csum=2` says how many, never which. The kernel does say
 * which — every scrub error is logged with the file's subvolume id, inode and
 * byte offset (GT-3):
 *
 *   BTRFS warning (device dm-0): scrub: checksum error at logical 14811136 on
 *   dev /dev/mapper/gtsh-data, physical 14811136 root 256 inode 257 offset
 *   1179648 length 4096 links 1 (path: f1.bin)
 *
 * The journal ENVELOPE is JSON (`journalctl -k -o json`); the MESSAGE inside it
 * is not, and the kernel offers no structured form of it — so this text parse
 * joins `btrfs scrub status` above as a sanctioned Principle-13 exception, for
 * the same reason.
 *
 * Two drill facts shape the rest:
 *   - the reported `offset` is the 64 KiB btrfs STRIPE start, not the failing
 *     4 KiB block, and the line carries no csum values (GT-3) — so the exact
 *     block is evidence ANAS gathers itself, by reading each of the 16 blocks
 *     in the stripe with O_DIRECT (a read error = a bad block);
 *   - `root N` is a subvolume id, so the printed path is subvolume-relative
 *     and names nothing on the node until `btrfs inspect-internal
 *     subvolid-resolve` turns the id into a name (GT-3/GT-6).
 *
 * A third fact shapes the compressed case (selfheal.8, live-proven twice):
 * when the failing extent is COMPRESSED the printed `offset` is extent-
 * relative — `0` for a corrupt extent starting 128 KiB into the file — and the
 * named logical is the 64 KiB stripe the failing blob sits in, not the blob
 * itself (two corrupt blobs 16 KiB apart were both reported at their stripe's
 * start). The kernel does not say which extent inside the stripe it was, so
 * the engine's mapping answers: the extents owning the stripe, resolved from
 * the extent tree's backrefs, and their real file ranges probed whole.
 */

/** One kernel scrub error line that named a file. */
export interface ScrubErrorLine {
  /** The `(device X)` name — the dm device btrfs is mounted from. */
  device: string
  logical: number
  /** The `on dev …` member path the error was seen on. */
  dev: string
  physical: number
  /** Subvolume id (`root N`) — resolved to a name before use. */
  root: number
  inode: number
  /** Byte offset within the file: the 64 KiB stripe start (GT-3). */
  offset: number
  /** Length as the kernel printed it (4096 on the drill), kept verbatim. */
  length: number
  links: number
  /** The subvolume-RELATIVE path the kernel printed. */
  path: string
}

/** btrfs file geometry the attribution walks in (GT-3). */
const BLOCK_BYTES = 4096
/** Blocks inside one btrfs scrub stripe — the 16 the probe reads. */
const BLOCKS_PER_STRIPE = BTRFS_STRIPE_BYTES / BLOCK_BYTES

/** At most this many FILES ride in a result; the counts always tell the truth. */
export const AHR_SCRUB_FINDINGS_CAP = 200
/** At most this many paths in the notification body, then "and N more". */
const NOTIFY_PATH_LIMIT = 20

/**
 * `dmesg` prefixes a line with the monotonic stamp (`[ 3455.495994] `);
 * journald's MESSAGE does not. Accepted either way, so the drill's recorded
 * captures parse exactly as the live journal does.
 */
const KERNEL_STAMP_RE = /^\[\s*\d+\.\d+\]\s*/

/**
 * A scrub error line that NAMED a file. `checksum error` is the drill's shape;
 * the kind word is left open (`unrecoverable error`, `read error`) because the
 * fields after it are what matter and the kernel spells the kind several ways.
 */
const SCRUB_PATH_RE = new RegExp(
  '^BTRFS \\w+ \\(device ([^)]+)\\): scrub: [\\w ()]*?error at logical (\\d+) on dev (\\S+?),? '
  + 'physical (\\d+) root (\\d+) inode (\\d+) offset (\\d+) length (\\d+) links (\\d+) \\(path: (.*)\\)$',
)

/**
 * An error line with NO path: `unable to fixup (regular) error at logical …`,
 * read errors, super-block errors. The logical is captured so an error already
 * attributed by a path-carrying line is not counted a second time.
 */
const SCRUB_NO_PATH_RE = /^BTRFS \w+ \(device ([^)]+)\): (?:scrub: )?[\w ()]*?error at logical (\d+)\b/

/** Parse ONE kernel MESSAGE into a path-carrying scrub error, or null. */
export function parseScrubWarning(message: string): ScrubErrorLine | null {
  const m = message.replace(KERNEL_STAMP_RE, '').trim().match(SCRUB_PATH_RE)
  if (!m)
    return null
  return {
    device: m[1],
    logical: Number(m[2]),
    dev: m[3],
    physical: Number(m[4]),
    root: Number(m[5]),
    inode: Number(m[6]),
    offset: Number(m[7]),
    length: Number(m[8]),
    links: Number(m[9]),
    path: m[10],
  }
}

/** An error line the kernel could not attach a path to, or null. */
export function parseUnattributedScrubError(message: string): { device: string, logical: number } | null {
  const text = message.replace(KERNEL_STAMP_RE, '').trim()
  if (SCRUB_PATH_RE.test(text))
    return null
  const m = text.match(SCRUB_NO_PATH_RE)
  return m ? { device: m[1], logical: Number(m[2]) } : null
}

/**
 * A corrected METADATA read (story selfheal.12, GT-20's verbatim captures):
 *
 *   BTRFS info (device dm-0): read error corrected: ino 0 off 30834688
 *   (dev /dev/mapper/gtsh-data sector 76608)
 *
 * The kernel logs one line per metadata read whose first DUP copy failed its
 * checksum and was served — and rewritten — from the mirror. A scrub on the
 * already-repaired array reports nothing (GT-20), so this line is the only
 * durable evidence a member is returning bad metadata. The kind word is left
 * open (`info`/`warning` — both spellings exist in the wild) and so is the
 * trailing parenthetical, because the fields after `corrected:` are what
 * matter; the same text-parse exception as the scrub warnings above applies.
 */

/** One kernel corrected-read line. */
export interface CorrectedReadLine {
  /** The `(device X)` name — the dm device btrfs is mounted from. */
  device: string
  /** The inode whose metadata was corrected (0 for tree blocks). */
  ino: number
  /** The logical byte offset the kernel printed. */
  offset: number
  /** The `dev …` member path the read was served — and rewritten — from. */
  dev: string
  /** The member sector the kernel printed. */
  sector: number
}

/**
 * The corrected-read shape: kind word open, the member parenthetical
 * `(dev … sector …)` captured, anything after it tolerated.
 */
const CORRECTED_READ_RE = new RegExp(
  '^BTRFS \\w+ \\(device ([^)]+)\\): read error corrected(?::| \\([^)]*\\):) '
  + 'ino (\\d+) off (\\d+) \\(dev (\\S+) sector (\\d+)\\)',
)

/** Parse ONE kernel MESSAGE into a corrected metadata read, or null. */
export function parseCorrectedRead(message: string): CorrectedReadLine | null {
  const m = message.replace(KERNEL_STAMP_RE, '').trim().match(CORRECTED_READ_RE)
  if (!m)
    return null
  return {
    device: m[1],
    ino: Number(m[2]),
    offset: Number(m[3]),
    dev: m[4],
    sector: Number(m[5]),
  }
}

/**
 * The window's corrected metadata reads, counted. One kernel line is one
 * corrected read — there is nothing to dedupe a correction against (unlike the
 * scrub errors above, each line IS the event). `devices` are the distinct
 * member paths, in first-seen order, so the operator is pointed at the disks
 * to check. `device`, when given, keeps another pool's lines out of this
 * count, exactly as the attribution's filter does — and fails open to no
 * filter for the same reason.
 */
export function correctedReadsFromMessages(
  messages: string[],
  device?: string | null,
): { count: number, devices: string[] } {
  let count = 0
  const devices = new Set<string>()
  for (const message of messages) {
    const line = parseCorrectedRead(message)
    if (!line)
      continue
    if (device && line.device !== device)
      continue
    count += 1
    devices.add(line.dev)
  }
  return { count, devices: [...devices] }
}

/**
 * `journalctl -k -o json` — one JSON object per line. Only the envelope is
 * parsed here; MESSAGE is handed on as text. A MESSAGE the journal stored as a
 * byte array (non-UTF-8 kernel output) is decoded rather than dropped; a line
 * that is not an envelope at all is skipped, so a truncated tail never costs
 * us the lines before it.
 */
export function kernelJournalMessages(stdout: string): string[] {
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (!text)
      continue
    try {
      const entry = JSON.parse(text) as { MESSAGE?: unknown }
      const msg = entry.MESSAGE
      if (typeof msg === 'string')
        out.push(msg)
      else if (Array.isArray(msg) && msg.every(b => typeof b === 'number'))
        out.push(String.fromCharCode(...msg as number[]))
    }
    catch {
      // Not a JSON envelope (a journalctl notice, a truncated tail) — skip it.
    }
  }
  return out
}

/** Every stripe the kernel named for ONE file, in the order it named them. */
export interface ScrubFileGroup {
  root: number
  inode: number
  /** The subvolume-relative path, as the kernel printed it. */
  path: string
  stripes: AhrScrubStripe[]
}

/** What the journal said, grouped per file and capped. */
export interface ScrubAttribution {
  /** The first {@link AHR_SCRUB_FINDINGS_CAP} files, in first-seen order. */
  files: ScrubFileGroup[]
  /** Distinct stripes attributed to a file — ALL of them, cap or no cap. */
  errorsAttributed: number
  /** Distinct error logicals the kernel never attached a path to. */
  unattributed: number
  /** True when more files were seen than the cap carries. */
  truncated: boolean
}

/**
 * Group the window's kernel messages per file.
 *
 * `device`, when given, keeps another pool's concurrent scrub out of this
 * result: the kernel names the dm device the filesystem is mounted from, and
 * only lines from OUR device describe OUR files. An unresolvable device means
 * no filter — fail-open, because the filter's absence costs nothing on a node
 * scrubbing one pool, while a wrong filter would silently drop real findings.
 */
export function attributeScrubErrors(messages: string[], device?: string | null): ScrubAttribution {
  const files = new Map<string, ScrubFileGroup>()
  const seenFiles = new Set<string>()
  const seenStripes = new Set<string>()
  const attributedLogicals = new Set<number>()
  const unattributed = new Set<number>()
  let errorsAttributed = 0

  for (const message of messages) {
    const line = parseScrubWarning(message)
    if (line) {
      if (device && line.device !== device)
        continue
      attributedLogicals.add(line.logical)
      // The same stripe can be reported more than once (both copies of a RAID1
      // band, a re-read): one stripe, one error.
      const stripeKey = `${line.root}:${line.inode}:${line.logical}:${line.offset}`
      if (seenStripes.has(stripeKey))
        continue
      seenStripes.add(stripeKey)
      errorsAttributed += 1
      const key = `${line.root}:${line.inode}`
      seenFiles.add(key)
      const existing = files.get(key)
      if (existing) {
        existing.stripes.push({ logical: line.logical, offset: line.offset, length: line.length })
        continue
      }
      // Past the cap a file is COUNTED but not carried — errorsAttributed keeps
      // counting its stripes, so the numbers never shrink to fit the list.
      if (files.size >= AHR_SCRUB_FINDINGS_CAP)
        continue
      files.set(key, {
        root: line.root,
        inode: line.inode,
        path: line.path,
        stripes: [{ logical: line.logical, offset: line.offset, length: line.length }],
      })
      continue
    }
    const orphan = parseUnattributedScrubError(message)
    if (orphan && (!device || orphan.device === device))
      unattributed.add(orphan.logical)
  }

  // An `unable to fixup … at logical N` that follows the csum error for the
  // SAME logical is the same error said twice, never a second nameless one.
  for (const logical of attributedLogicals)
    unattributed.delete(logical)

  return {
    files: [...files.values()],
    errorsAttributed,
    unattributed: unattributed.size,
    truncated: seenFiles.size > files.size,
  }
}

/** The `key=N` counters in a btrfs `Error summary` line (`csum=2 read=1`). */
const SUMMARY_COUNT_RE = /\b\w+=(\d+)\b/g
const TRAILING_SLASH_RE = /\/+$/
const SURROUNDING_SLASH_RE = /^\/+|\/+$/g
const LEADING_SLASH_RE = /^\/+/

/** Sum of the `key=N` counters in a btrfs `Error summary` (`csum=2 read=1`). */
export function countErrorSummary(summary: string | null): number {
  if (!summary)
    return 0
  let total = 0
  for (const m of summary.matchAll(SUMMARY_COUNT_RE))
    total += Number(m[1])
  return total
}

/** Join non-empty path parts with single slashes. */
function joinParts(parts: (string | null)[]): string {
  return parts.map(p => (p ?? '')).filter(p => p !== '').join('/')
}

/** A subvolume path in its bare form: no leading or trailing slash (`/` → ``). */
function bareSubvol(subvol: string | null): string {
  return (subvol ?? '').replace(SURROUNDING_SLASH_RE, '')
}

/**
 * Where a finding IS, on this node.
 *
 * `subvolid-resolve` answers from the filesystem's TOP LEVEL (`@data`,
 * `@data/photos`, `@snapshots/nightly`), but an AHR pool in the §12 layout is
 * mounted `subvol=@data` AT its mountpoint — so `@data/f1.bin` lives at
 * `<mountpoint>/f1.bin`, and `<mountpoint>/@data/f1.bin` does not exist at all.
 * A flat pool mounts the top level (`subvol=/`) and the resolved path is the
 * relative one. `mounted` is the pool's OWN mounted subvolume, bare.
 *
 * A scrub covers the whole filesystem, so a finding can also land OUTSIDE the
 * mounted tree — `@snapshots/<name>/…` is real and expected, since AHR keeps
 * snapshots as siblings of `@data` (§12). There is no path to it under the
 * mountpoint, and inventing one would send the probe at a file that is not the
 * one the kernel named: those are reported filesystem-relative and flagged.
 */
export function findingPath(
  mountpoint: string,
  mounted: string | null,
  resolved: string | null,
  relative: string,
): { path: string, outsideMount: boolean } {
  const root = mountpoint.replace(TRAILING_SLASH_RE, '')
  const under = bareSubvol(mounted)
  const full = bareSubvol(resolved)
  const rel = relative.replace(LEADING_SLASH_RE, '')
  // Top-level mount: the resolved subvolume IS a directory under the mountpoint.
  if (under === '')
    return { path: joinParts([root, full, rel]), outsideMount: false }
  if (full === under)
    return { path: joinParts([root, rel]), outsideMount: false }
  // Nested under the mounted subvolume — keep the remainder (`@data/photos`
  // mounted at `@data` is `<mountpoint>/photos`).
  if (full.startsWith(`${under}/`))
    return { path: joinParts([root, full.slice(under.length + 1), rel]), outsideMount: false }
  return { path: joinParts([full, rel]), outsideMount: true }
}

/**
 * The pool's mounted subvolume, bare (`@data`, or `` for a top-level mount).
 *
 * Read from the live mount, through the SAME helper the topology's
 * `subvolLayout` comes from — the mount is the source of truth (§5.3), nothing
 * is precomputed. When the mount cannot be read (or an old kernel omits the
 * option), the pool's own `subvolLayout` stands in: it is that same reading,
 * one hop earlier.
 */
async function mountedSubvolume(executor: CommandExecutor, pool: AhrPool): Promise<string> {
  try {
    const r = await executor.exec(FINDMNT, [...AHR_SCRUB_FINDMNT_ARGS, pool.mountpoint])
    if (r.exitCode === 0) {
      const mount = parseFindmnt(r.stdout).find(m => m.target === pool.mountpoint)
      const subvol = mount ? subvolFromMountOptions(mount.options) : null
      if (subvol !== null)
        return bareSubvol(subvol)
    }
  }
  catch {
    // fall through to the pool's own reading
  }
  return pool.subvolLayout ? SUBVOL_DATA : ''
}

/**
 * How many kernel journal entries one scrub's attribution read may take.
 *
 * The executor hands stdout over as a string through a 10 MB buffer, and a
 * journal envelope is ~800 bytes — so an unbounded read on a node with tens of
 * thousands of scrub errors does not truncate, it FAILS (execFile kills the
 * child with ENOBUFS) and the whole attribution is lost, which is the opposite
 * of what a best-effort pass should do when there is more to say than fits.
 * Bounded, the last {@link AHR_SCRUB_JOURNAL_LINE_CAP} matching entries come
 * back and the result says the listing is incomplete.
 */
export const AHR_SCRUB_JOURNAL_LINE_CAP = 5000

/**
 * The MESSAGE patterns the window is read for (`journalctl -g`): both error
 * shapes the attribution can use, plus the corrected-metadata reads counted
 * into `metadataCorrected` (selfheal.12) — one read of the window serves both.
 */
const SCRUB_JOURNAL_GREP = 'error at logical|read error corrected'

/** The bounded journalctl argv for one scrub's window. */
export function scrubJournalArgs(since: string, options?: { grep?: boolean, cap?: number }): string[] {
  const args = ['-k', '-o', 'json', '-S', since, '--no-pager', '-n', String(options?.cap ?? AHR_SCRUB_JOURNAL_LINE_CAP)]
  return options?.grep === false ? args : [...args, '-g', SCRUB_JOURNAL_GREP]
}

/**
 * journalctl's `-S` takes LOCAL wall-clock time in `YYYY-MM-DD HH:MM:SS`.
 * Seconds are floored, which only ever widens the window by under a second —
 * the safe direction: a scrub's own errors can never be older than its start.
 */
export function journalSince(when: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} `
    + `${p(when.getHours())}:${p(when.getMinutes())}:${p(when.getSeconds())}`
}

/** The pool LV's kernel dm name (`dm-0`) — the name the kernel lines carry. */
export async function poolDmName(executor: CommandExecutor, pool: AhrPool): Promise<string | null> {
  try {
    const r = await executor.exec(REALPATH, [ahrLvPath(pool.name)])
    const name = r.exitCode === 0 ? r.stdout.trim().replace(DEV_PREFIX_RE, '') : ''
    return name === '' ? null : name
  }
  catch {
    return null
  }
}

/** Resolve a subvolume id to its name (`@data`), once per id; null when it does not resolve. */
async function resolveSubvolume(
  executor: CommandExecutor,
  mountpoint: string,
  root: number,
  cache: Map<number, string | null>,
): Promise<string | null> {
  const cached = cache.get(root)
  if (cached !== undefined)
    return cached
  let name: string | null = null
  try {
    const r = await executor.exec(BTRFS, ['inspect-internal', 'subvolid-resolve', String(root), mountpoint])
    const text = r.exitCode === 0 ? r.stdout.trim() : ''
    name = text === '' ? null : text
  }
  catch {
    name = null
  }
  cache.set(root, name)
  return name
}

/**
 * Did ONE 4 KiB file block fail to read?
 *
 * The read itself is the engine's — `probeFileBlock` (selfheal-io), the same
 * O_DIRECT read the repair's cold-read uses, so there is one definition of
 * "read this block and see" on this filesystem and not two that can drift.
 * O_DIRECT is what makes it a real read: a cached page would answer from memory
 * and every block would look fine (GT-9a).
 */
async function probeBlock(executor: CommandExecutor, path: string, block: number): Promise<boolean> {
  return !(await probeFileBlock(executor, path, block))
}

/**
 * The failing 4 KiB blocks inside ONE named 64 KiB stripe: read each of the 16
 * blocks and collect the ones that error (GT-3 — the kernel names the stripe,
 * never the block).
 *
 * A block past EOF reads zero bytes and exits 0, so a file that shrank is not
 * reported as sixteen bad blocks.
 */
async function probeStripe(executor: CommandExecutor, path: string, offset: number): Promise<number[]> {
  const bad: number[] = []
  const base = Math.floor(offset / BLOCK_BYTES)
  for (let i = 0; i < BLOCKS_PER_STRIPE; i++) {
    const block = base + i
    if (await probeBlock(executor, path, block))
      bad.push(block)
  }
  return bad
}

/** A compressed extent's file block range, as `extentBlocks` carries it. */
interface ExtentBlockRange {
  first: number
  count: number
}

/**
 * The failing 4 KiB blocks of the extents that own ONE named stripe
 * (selfheal.8).
 *
 * For a COMPRESSED extent the kernel's `offset` is extent-relative, not
 * file-relative, so the stripe it names cannot be probed at the printed
 * offset. The extent's real file range comes from its EXTENT_DATA item, and
 * THAT range is probed whole: one bad on-disk sector of a compressed blob
 * makes every block of the logical extent read back EIO (GT-9b), so the
 * honest answer is expected to be the whole extent — all of its failing
 * blocks recorded. Uncompressed extents sharing the stripe keep the kernel's
 * own geometry: the stripe-window they cover is what is probed, bounded to
 * the 16 blocks the plain probe reads.
 *
 * `extentRange` describes the compressed extent containing the first failing
 * block — the block a repair is handed (the engine repairs the whole blob
 * when given any block of the extent).
 */
async function probeStripeExtents(
  executor: CommandExecutor,
  path: string,
  candidates: ExtentItem[],
  stripeLogical: number,
): Promise<{ badBlocks: number[], extentRange: ExtentBlockRange | null }> {
  const stripeStart = Math.floor(stripeLogical / BTRFS_STRIPE_BYTES) * BTRFS_STRIPE_BYTES
  const bad = new Set<number>()
  let extentRange: ExtentBlockRange | null = null
  /** The page cache is dropped ONCE, lazily — an all-uncompressed stripe never pays for it. */
  let dropped = false
  for (const extent of candidates) {
    const compressed = extent.compression !== 'none'
    // D9 (design review 2026-09-14) — O_DIRECT is not enough on a COMPRESSED
    // extent: btrfs cannot do direct I/O on compressed data and falls back to
    // the buffered path, so a warm page answers the probe and the block reads
    // as fine whatever is on the disk. The engine's own cold read drops the
    // cache for exactly this reason; the attribution probe now does it from
    // the SAME helper (`dropCaches`, selfheal-io) rather than a second copy.
    //
    // A failed drop is not fatal — the probe still runs, and the reason text
    // for "nothing failed" states the ambiguity rather than claiming the file
    // was repaired. It is node-wide and cheap; the attribution reads are tiny.
    if (compressed && !dropped) {
      dropped = true
      try {
        await dropCaches(executor)
      }
      catch {
        // Not root, or a read-only /proc: say nothing, probe anyway.
      }
    }
    // The file block range to read: the WHOLE extent when compressed; the
    // part inside the named stripe when not. A range past EOF reads zero
    // bytes and exits 0 — a shrunken file is not a wall of failures.
    const length = extent.length ?? 0
    let firstBlock: number
    let lastBlock: number
    if (compressed) {
      firstBlock = Math.floor(extent.fileOffset / BLOCK_BYTES)
      lastBlock = Math.ceil((extent.fileOffset + length) / BLOCK_BYTES)
    }
    else {
      const within = stripeStart - (extent.diskByte ?? 0)
      const fileStart = extent.fileOffset + Math.max(0, within)
      const fileEnd = extent.fileOffset + Math.min(length, within + BTRFS_STRIPE_BYTES)
      if (fileEnd <= fileStart)
        continue
      firstBlock = Math.floor(fileStart / BLOCK_BYTES)
      lastBlock = Math.ceil(fileEnd / BLOCK_BYTES)
    }
    for (let block = firstBlock; block < lastBlock; block++) {
      if (bad.has(block))
        continue
      if (await probeBlock(executor, path, block)) {
        bad.add(block)
        if (compressed && extentRange === null) {
          extentRange = { first: Math.floor(extent.fileOffset / BLOCK_BYTES), count: Math.ceil(length / BLOCK_BYTES) }
        }
      }
    }
  }
  // eslint-disable-next-line e18e/prefer-array-to-sorted -- toSorted() is ES2023; this package targets ES2022 (no such lib member)
  return { badBlocks: [...bad].sort((a, b) => a - b), extentRange }
}

/**
 * Does the path still exist? A file deleted since the scrub is reported, not
 * probed — and, from selfheal.6, a repair request naming it is refused rather
 * than run (the route imports this one copy).
 */
export async function pathExists(executor: CommandExecutor, path: string): Promise<boolean> {
  try {
    return (await executor.exec(STAT, ['-c', '%s', path])).exitCode === 0
  }
  catch {
    return false
  }
}

/**
 * Turn the grouped kernel reports into findings: resolve each subvolume once,
 * then probe every named stripe of every file that still exists.
 *
 * Each stripe is probed through the self-heal engine's mapping (selfheal.5) —
 * the extents owning the stripe are resolved from the filesystem's trees, and
 * a COMPRESSED one is probed over its real file range (selfheal.8: the
 * kernel's `offset` is extent-relative there, so the printed offset points at
 * the wrong 64 KiB). Where every extent in the stripe is uncompressed the
 * kernel's offset IS the file offset (GT-3) and the plain 16-block probe is
 * exact.
 *
 * When the extents CANNOT be resolved, the stripe is STILL probed at the
 * kernel's printed offset (second-pass review F6). The earlier cut dropped the
 * probe, on the reasoning that a compressed extent's printed offset is
 * extent-relative (selfheal.8) and names the wrong 64 KiB. Half of that is
 * right and the conclusion was not: a probe reads the FILE with O_DIRECT, so a
 * block that comes back EIO is a block of this file that genuinely cannot be
 * read, whichever extent it belongs to. The wrong window can only cost a MISS,
 * never a false accusation — and the kernel's offset is EXACT for an
 * uncompressed extent (GT-3), which is the common case. Dropping it voided the
 * whole pool's findings whenever the mapping was unavailable for any reason.
 *
 * So the rule is: probe what the kernel named; report the blocks that failed;
 * and when nothing in that window failed AND the mapping was not available to
 * say where else to look, report `unidentified` with the reason rather than an
 * empty `badBlocks` that reads as "nothing wrong here". A resolved COMPRESSED
 * extent still bypasses the printed offset entirely and is probed over its real
 * file range, which is strictly better than either.
 *
 * And the window says so about ITSELF (T7, third pass). A probe made with the
 * mapping down sets `probedUnverified` on the finding, and the `reason` is kept
 * even when blocks WERE found — the blocks named are real, the list of them is
 * not known to be complete. The findings window and the notification belong to
 * another owner; what they should render off this pair is: blocks listed, plus
 * a plain line that the search window could not be verified and why, so a
 * repair offered on those blocks is not read as a repair of the whole file.
 */
async function buildFindings(
  executor: CommandExecutor,
  pool: AhrPool,
  groups: ScrubFileGroup[],
  updateProgress: (message: string) => void,
): Promise<AhrScrubFinding[]> {
  const subvols = new Map<number, string | null>()
  const findings: AhrScrubFinding[] = []
  const mounted = await mountedSubvolume(executor, pool)
  let mapping: SelfhealContext | null = null
  let mappingError: string | null = null
  try {
    mapping = await resolveContext(executor, pool.mountpoint)
  }
  catch (err) {
    mappingError = err instanceof Error ? err.message : String(err)
  }
  for (const [i, group] of groups.entries()) {
    const subvolume = await resolveSubvolume(executor, pool.mountpoint, group.root, subvols)
    // An unresolvable subvolume id (deleted since the scrub) leaves only the
    // relative path the kernel printed — reported as it was printed, and marked
    // missing rather than dressed up as a path on the node.
    if (subvolume === null) {
      updateProgress(`Attributing scrub errors: ${i + 1}/${groups.length} (${group.path})`)
      findings.push({ path: group.path, subvolume, inode: group.inode, stripes: group.stripes, badBlocks: [], missing: true })
      continue
    }
    const where = findingPath(pool.mountpoint, mounted, subvolume, group.path)
    updateProgress(`Attributing scrub errors: ${i + 1}/${groups.length} (${where.path})`)
    // Outside the mounted tree (a snapshot under `@snapshots`, §12): real, and
    // reachable only through a top-level mount this job does not take. Reported
    // filesystem-relative and flagged — never probed at a path that is not it.
    if (where.outsideMount) {
      findings.push({ path: where.path, subvolume, inode: group.inode, stripes: group.stripes, badBlocks: [], outsideMount: true })
      continue
    }
    if (!(await pathExists(executor, where.path))) {
      findings.push({ path: where.path, subvolume, inode: group.inode, stripes: group.stripes, badBlocks: [], missing: true })
      continue
    }
    const badBlocks: number[] = []
    let extentRange: ExtentBlockRange | null = null
    let unidentifiedReason: string | null = null
    /** At least one stripe of this file was probed with the mapping down (T7). */
    let probedUnverified = false
    for (const stripe of group.stripes) {
      let candidates: ExtentItem[] | null = null
      if (mapping !== null) {
        try {
          candidates = await extentsForStripe(executor, mapping, group.root, group.inode, stripe.logical)
        }
        catch (err) {
          unidentifiedReason ??= `extent could not be resolved (${err instanceof Error ? err.message : String(err)})`
        }
      }
      else {
        unidentifiedReason ??= `extent could not be resolved (${mappingError})`
      }
      if (candidates === null) {
        // Mapping unavailable for this stripe (F6). Probe at the kernel's
        // offset anyway: an EIO there is a real bad block of this file. If the
        // extent happens to be compressed the window is the wrong one and the
        // probe finds nothing — which is a MISS, and `unidentifiedReason` is
        // already set, so the finding says so instead of reading as clean.
        //
        // MARK IT (T7). The blocks this probe names are real, but the WINDOW
        // was never verified: a compressed extent's printed offset names the
        // wrong 64 KiB, so blocks outside it can be bad with nothing here to
        // say so. `probedUnverified` carries that fact whether or not the
        // probe happened to hit — a lucky stripe must not read as a complete
        // account of the file.
        probedUnverified = true
        badBlocks.push(...await probeStripe(executor, where.path, stripe.offset))
        continue
      }
      if (candidates.length === 0) {
        unidentifiedReason ??= 'no extent of this file covers the reported stripe'
        continue
      }
      if (candidates.some(e => e.compression !== 'none')) {
        const probed = await probeStripeExtents(executor, where.path, candidates, stripe.logical)
        if (probed.badBlocks.length > 0) {
          badBlocks.push(...probed.badBlocks)
          extentRange ??= probed.extentRange
        }
        else {
          unidentifiedReason ??= 'no block failed on re-read: either the file changed since the scrub, or the read was served from cache'
        }
      }
      else {
        // Every extent in the named stripe is uncompressed, so the kernel's
        // offset IS the file offset of the stripe (GT-3): probe it.
        badBlocks.push(...await probeStripe(executor, where.path, stripe.offset))
      }
    }
    findings.push({
      path: where.path,
      subvolume,
      inode: group.inode,
      stripes: group.stripes,
      badBlocks,
      ...(extentRange ? { compressed: true, extentBlocks: extentRange } : {}),
      // `unidentified` still means "no block could be named at all", so it
      // stays gated on an EMPTY badBlocks — but the REASON is kept either way
      // (T7). One stripe of a multi-stripe file resolving and hitting used to
      // erase the reason every other stripe had for finding nothing, and the
      // finding then read as a complete list of this file's bad blocks.
      ...(unidentifiedReason ? { ...(badBlocks.length === 0 ? { unidentified: true } : {}), reason: unidentifiedReason } : {}),
      ...(probedUnverified ? { probedUnverified: true } : {}),
    })
  }
  return findings
}

/**
 * Read the kernel journal for THIS scrub's window and name what is corrupt.
 *
 * Best-effort by construction: a scrub that found errors and said so is worth
 * having even when the journal is unreadable or a probe fails, so every failure
 * here degrades to "no attribution" instead of failing the job.
 */
export async function attributeScrub(
  executor: CommandExecutor,
  pool: AhrPool,
  startedAt: Date,
  updateProgress: (message: string) => void,
): Promise<Pick<AhrScrubResult, 'findings' | 'errorsAttributed' | 'unattributed' | 'truncated'>> {
  updateProgress('Reading the kernel journal for the scrub\'s errors')
  const since = journalSince(startedAt)
  let r = await executor.exec(JOURNALCTL, scrubJournalArgs(since))
  if (r.exitCode !== 0) {
    // `-g` needs a journalctl built with PCRE2; without it the whole window is
    // read (still line-capped) rather than nothing being read at all.
    const plain = await executor.exec(JOURNALCTL, scrubJournalArgs(since, { grep: false }))
    if (plain.exitCode !== 0)
      throw new Error(r.stderr.trim() || `journalctl exited ${r.exitCode}`)
    r = plain
  }
  const messages = kernelJournalMessages(r.stdout)
  // The cap reached means OLDER entries of this window were not read (`-n`
  // keeps the most recent) — the listing is incomplete and says so.
  const capped = messages.length >= AHR_SCRUB_JOURNAL_LINE_CAP
  const attribution = attributeScrubErrors(messages, await poolDmName(executor, pool))
  const findings = await buildFindings(executor, pool, attribution.files, updateProgress)
  return {
    findings,
    errorsAttributed: attribution.errorsAttributed,
    unattributed: attribution.unattributed,
    truncated: attribution.truncated || capped,
  }
}

/**
 * The corrected metadata reads in ONE window, for one pool (story selfheal.12).
 *
 * Read through the SAME bounded argv as the attribution — the grep
 * alternation now carries the corrected-read shape, and the no-`-g` fallback
 * stands — so one definition of "read the kernel journal for this window"
 * serves the scrub and the repair alike (the repair imports this helper rather
 * than growing a second one). Fail-open at the caller: a journal that cannot
 * be read costs the count, never the run, and never invents a clean bill.
 */
export async function readCorrectedReads(
  executor: CommandExecutor,
  pool: AhrPool,
  since: Date,
): Promise<{ count: number, devices: string[] }> {
  const args = scrubJournalArgs(journalSince(since))
  let r = await executor.exec(JOURNALCTL, args)
  if (r.exitCode !== 0) {
    // Same fallback as the attribution: no PCRE2 means the whole window is
    // read rather than nothing being read at all.
    r = await executor.exec(JOURNALCTL, scrubJournalArgs(journalSince(since), { grep: false }))
  }
  const device = await poolDmName(executor, pool)
  return correctedReadsFromMessages(kernelJournalMessages(r.stdout), device)
}

/**
 * The one operator sentence the corrected count earns (selfheal.12) — shared
 * by the scrub and the repair notifications so the two windows say it in the
 * same words. Only ever composed when `count` is above zero.
 */
export function metadataCorrectedSentence(corrected: { count: number, devices: string[] }): string {
  const n = corrected.count
  return `btrfs corrected ${n} metadata read(s) from the mirror copy during this run. `
    + 'A member is returning bad metadata. Check that disk\'s SMART data in Disks.'
}

/** The notification body: the summary sentence, then the files it is about. */
function findingsBody(pool: AhrPool, btrfsErrors: string, result: AhrScrubResult): string {
  const head = `btrfs scrub on pool '${pool.name}' reported: ${btrfsErrors}. `
    + `Latent corruption was found. Check 'btrfs scrub status ${pool.mountpoint}' and the pool's disks.`
  const findings = result.findings ?? []
  if (findings.length === 0) {
    // Errors with nothing to name: rate-limited kernel warnings, or errors the
    // kernel never attached a path to. Say which, rather than print an empty list.
    const unattributed = result.unattributed
      ? `\n\n${result.unattributed} error(s) name no file (read/IO or metadata errors). No per-file attribution is possible.`
      : ''
    return `${head}${unattributed}${skippedSection(result.bandsSkipped)}`
  }
  const lines = findings.slice(0, NOTIFY_PATH_LIMIT).map((f) => {
    const blocks = f.outsideMount
      ? 'in a snapshot, outside the mounted tree'
      : f.missing
        ? 'deleted since the scrub'
        : f.compressed && f.extentBlocks
          ? `compressed extent, ${f.extentBlocks.count} blocks`
          : f.unidentified
            ? `block not identified (${f.reason ?? 'no reason recorded'})`
            : `${f.badBlocks.length} bad 4K block(s)`
    // T7's fact, carried to the reader (fourth pass): a probe made without the
    // mapping searched an unverified window, so the blocks listed are real but
    // not known to be complete. The `unidentified` arm already names the
    // reason as its block text — repeating it in the suffix would say it twice.
    const unverified = f.probedUnverified && !f.unidentified
      ? ` (search window unverified: ${f.reason ?? 'no reason recorded'})`
      : ''
    return `  ${f.path}: ${blocks}${unverified}`
  })
  if (findings.length > NOTIFY_PATH_LIMIT)
    lines.push(`  …and ${findings.length - NOTIFY_PATH_LIMIT} more`)
  const counts = [
    `${result.errorsAttributed ?? 0} of ${result.errorsReported ?? 0} reported error(s) attributed`,
    ...(result.unattributed ? [`${result.unattributed} naming no file`] : []),
    ...(result.truncated ? [`the list is incomplete: the ${AHR_SCRUB_FINDINGS_CAP}-file cap or the kernel-journal read cap was reached`] : []),
  ].join(', ')
  return `${head}\n\nAffected files (${counts}):\n${lines.join('\n')}${skippedSection(result.bandsSkipped)}`
}

/** The `bandsSkipped` lines a notification carries (D8) — empty when all bands were checked. */
function skippedSection(skipped: { band: string, reason: string }[] | undefined): string {
  const list = skipped ?? []
  if (list.length === 0)
    return ''
  return `\n\nNot checked (${list.length} of the pool's bands):\n${
    list.map(s => `  ${s.band} was not checked: ${s.reason}`).join('\n')}`
}

/** The parity-only notification's title: the bands, compactly. */
function parityTitle(parity: { band: string }[]): string {
  return `AHR scrub: parity mismatch on ${parity.map(p => p.band).join(', ')}`
}

/**
 * The parity-only rot notification (design review 2026-09-14, D1).
 *
 * Phase 1 counted `mismatch_cnt > 0` on a band and phase 2 attributed no
 * corrupt file, so the "phase 2 will name the files" promise came back empty.
 * `dataClean` is only ever true when the checksum scrub reported NO errors at
 * all — then "every file's checksum passes" is a fact, and only then does the
 * parity assertion follow from it: every block md would recompute parity FROM
 * is proven right, so the member that disagrees is the parity one. That arm
 * also has a VERB now (selfheal.10) and says so.
 *
 * When phase 2 DID report errors that named no file, neither of those holds
 * (sixth pass, N6). The body used to assert the parity conclusion in both arms
 * and then tell the operator "nothing in ANAS repairs parity", which stopped
 * being true when Rewrite parity shipped. The not-clean arm now says what to
 * do FIRST instead: the rewrite is refused while any finding stands, because
 * md would recompute parity from the corrupt data and make the rot permanent.
 */
function parityBody(pool: AhrPool, parity: { band: string, mismatchCnt: number }[], dataClean: boolean): string {
  const bands = parity.map(p => `${p.band} (${p.mismatchCnt})`).join(', ')
  if (dataClean) {
    return `Parity mismatch on ${bands}, but the checksum scrub found no corrupt files. Every file's checksum passes, `
      + `so the rot is in the PARITY (or Q) member of the band. `
      + `Rewrite it from the pool's Scrubs row: Scrubs → parity mismatch → Rewrite parity (a fresh checksum scrub runs first, and any finding aborts the run before md is touched). `
      + `Until that runs, at the next disk failure in this band md would reconstruct from the wrong parity.`
  }
  return `Parity mismatch on ${bands}. The checksum scrub reported errors but named no file, so this scrub cannot tell whether the rot is in parity or in data. `
    + `Do the data first: repair from parity any file a scrub names (Scrubs → the pool's findings), then scrub pool '${pool.name}' again and see what the second run says. `
    + `Rewrite parity is refused while a finding stands. md recomputes parity from the data as it is, so running it over rot would make that rot permanent and invisible. `
    + `At the next disk failure in this band, md would reconstruct from parity nothing has proven right.`
}

/** The skipped-bands notification body (D8): what was not looked at, and why. */
function skippedBody(skipped: { band: string, reason: string }[]): string {
  return `The scrub did not check every band of the pool:\n${
    skipped.map(s => `  ${s.band} was not checked: ${s.reason}`).join('\n')
  }\nThe unchecked bands have no verdict from this scrub. Run Scrub again once the cause has passed.`
}

/** First line of an error's message, for progress lines and verdict sentences. */
function firstErrorLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).trim().split('\n')[0] ?? ''
}

/** One btrfs scrub pass over a filesystem — the scrub's phase 2, on its own. */
export interface BtrfsScrubPass {
  /**
   * Local wall clock stamped BEFORE `btrfs scrub start`. The kernel-journal
   * read that attributes errors to files is bounded to this instant, so an
   * older scrub's errors are never re-reported as this pass's findings
   * (selfheal.3).
   */
  startedAt: Date
  /** The `Error summary:` line, verbatim, or null when the pass was clean. */
  btrfsErrors: string | null
}

/**
 * Run ONE btrfs scrub to completion and report what it found.
 *
 * Extracted from `scrubAhrPool`'s phase 2 because the parity rewrite
 * (selfheal.10) runs exactly this pass, for exactly this purpose, immediately
 * before it lets md rewrite a band's parity: md repair recomputes parity from
 * the data AS IT IS, so a file whose checksum fails has to be found FIRST or
 * its rot is blessed (GT-18's negative control). Two callers, one scrub — the
 * poll wording, the aborted-scrub error and the clean-summary rule are the
 * same in both because they are the same code.
 */
export async function btrfsScrubPass(
  executor: CommandExecutor,
  mountpoint: string,
  label: string,
  updateProgress: (message: string) => void,
  pollIntervalMs: number,
): Promise<BtrfsScrubPass> {
  const startedAt = new Date()
  // scrub.r1 (#81): `-B` keeps `btrfs scrub start` in the FOREGROUND for the
  // whole pass. Without it btrfs-progs forks a background child that keeps the
  // parent's pipes and process group (no setsid, no stdio redirect): the
  // command returns at once but the executor waits for the pipes, the 300 s
  // job deadline (cr.34) signals the group at its expiry, the signal reaches
  // the scrub child, and every pool whose checksum pass takes over five
  // minutes ends `interrupted` at exactly 300 s. With `-B` the command
  // OUTLIVING the budget is the normal case, so it runs with no deadline at
  // all, and `btrfs scrub status` is polled BESIDE it for progress only —
  // the pass ends when the COMMAND returns, never when a poll reads
  // `finished` while the child is still up.
  let commandSettled = false
  let spawnError: unknown
  const pass = executor.exec(BTRFS, ['scrub', 'start', '-B', mountpoint], {
    timeoutMs: null,
    longRunning: 'btrfs scrub: a verify pass over the whole filesystem, hours to days on a large pool',
  })
  pass.then(
    () => { commandSettled = true },
    (err: unknown) => {
      spawnError = err
      commandSettled = true
    },
  )
  for (;;) {
    if (commandSettled)
      break
    // The poll is for PROGRESS ONLY (#81): a status read that fails — a
    // transient ioctl error, a status file that will not open, a read that
    // hangs to the lane deadline — must never decide the pass's verdict. A
    // throw here failed the job while the `-B` child kept reading the array
    // with nobody holding it (the story ships no cancel hook), and let a
    // retry start a second scrub beside the first. Say so on the progress
    // line, sleep the interval like any other poll, keep waiting for the
    // COMMAND — the verdict comes from the final read below.
    try {
      const st = parseBtrfsScrubStatus((await run(executor, BTRFS, ['scrub', 'status', mountpoint])).stdout)
      if (st.status === 'running')
        updateProgress(`btrfs scrub running${st.percent !== null ? ` (${st.percent.toFixed(1)}%)` : ''}`)
    }
    catch (err) {
      updateProgress(`btrfs scrub running (status unreadable: ${firstErrorLine(err)})`)
    }
    // A fast pass can settle DURING the poll — then the verdict read follows
    // immediately; sleeping a full interval first only delays the job.
    if (commandSettled)
      break
    await sleep(pollIntervalMs)
  }
  // The exec promise REJECTS only when the process could not start (ENOENT,
  // EACCES) — there is no deadline to fire any more. That is a failure, and
  // it is reported with the SPAWN error's own message even when the status
  // read fails too (the ordinary consequence of the same cause: btrfs missing
  // means ENOENT on both calls) — the loop above can no longer throw past
  // this check.
  if (spawnError !== undefined)
    throw spawnError instanceof Error ? spawnError : new Error(String(spawnError))
  // Verdict from ONE final read — RETRIED while it lags (#81): the status
  // file can still read `running` for a moment after `-B` returned, and a
  // read that throws would lose the verdict of a scrub that finished fine.
  // Up to 3 attempts, one pollIntervalMs apart, while the read throws or
  // says `running`; whatever the LAST attempt produced is the verdict, under
  // the existing rules. The exit code is NOT the verdict: btrfs-progs exits
  // non-zero when the pass FINISHED WITH ERRORS, which is a finding for
  // phase 2's attribution, not a failure.
  const verdictAttempts = 3
  let attemptResult: { verdict?: BtrfsScrubStatus, error?: unknown } = {}
  for (let attempt = 1; attempt <= verdictAttempts; attempt++) {
    try {
      const v = parseBtrfsScrubStatus((await run(executor, BTRFS, ['scrub', 'status', mountpoint])).stdout)
      attemptResult = { verdict: v }
      if (v.status !== 'running')
        break
    }
    catch (err) {
      attemptResult = { error: err }
    }
    if (attempt < verdictAttempts)
      await sleep(pollIntervalMs)
  }
  if (attemptResult.verdict === undefined)
    throw new Error(`btrfs scrub on '${label}' finished but its status could not be read: ${firstErrorLine(attemptResult.error)}`)
  const verdict = attemptResult.verdict
  if (verdict.status === 'aborted')
    throw new Error(`btrfs scrub on '${label}' was aborted${isCleanSummary(verdict.errorSummary) ? '' : ` (${verdict.errorSummary})`}`)
  // finished — or no Status line at all (nothing to report): done either way.
  if (verdict.status === 'finished' || verdict.status === null)
    return { startedAt, btrfsErrors: isCleanSummary(verdict.errorSummary) ? null : verdict.errorSummary }
  // The command returned but the pass has no verdict (scrub.r1): a signal
  // reached the child some other way, it crashed, or the status says
  // something we do not know — the pass is NOT complete, say so plainly.
  throw new Error(`btrfs scrub on '${label}' ended without finishing (status: ${verdict.status})`)
}

/**
 * Scrub an AHR pool: phase 1 md parity (one band at a time), THEN phase 2 btrfs
 * checksums + attribution — never concurrent (selfheal.4). Progress is
 * reported on every poll (never an unbounded silent wait); each phase's
 * duration is unbounded by design (hours on real disks).
 */
export async function scrubAhrPool(
  executor: CommandExecutor,
  pool: AhrPool,
  updateProgress: (message: string) => void,
  opts?: AhrScrubOptions,
): Promise<AhrScrubResult> {
  const { name } = pool
  const interval = opts?.pollIntervalMs ?? AHR_SCRUB_POLL_MS
  const mismatchDelay = opts?.mismatchDelayMs ?? AHR_SCRUB_MISMATCH_DELAY_MS
  if (!pool.mounted)
    throw new Error(`pool '${name}' is not mounted. btrfs scrub needs the filesystem online`)

  // --- Phase 1/2: md parity checks, one band at a time (sequenced, §4) --------
  // Band-ascending order without copying the pool's array list.
  // The per-band record (design review 2026-09-14, D1/D8): phase 1's verdicts
  // and skips ride the result — a parity mismatch phase 2 cannot attribute is
  // the parity-only-rot case and must survive into the report, and a band the
  // scrub did not check must never read as coverage.
  const bandsChecked: string[] = []
  const bandsSkipped: { band: string, reason: string }[] = []
  const parityMismatches: { band: string, bandIndex: number, array: string, mismatchCnt: number, level: string }[] = []
  const order = pool.arrays.map((_, i) => i)
  order.sort((x, y) => pool.arrays[x].band - pool.arrays[y].band)
  for (const i of order) {
    const array = pool.arrays[i]
    const label = `${name}-r${array.band}`
    /**
     * This band's md kernel name, once it resolves — the key the `finally`
     * below retires (sixth pass, N3).
     *
     * `markCheckIssued` is what licenses ANAS to write `idle` to an array
     * (D2), and it used to be taken back only inside `cancelBandCheck` —
     * the abandonment path. Every band checked SUCCESSFULLY, and every band
     * skipped before that cancel, left its token in the set for the life of
     * the daemon. A later check on that array — mdcheck's, or one an
     * operator started — then read as ours, and the next thing to ask
     * `ownsSyncOp` would have written `idle` over somebody else's op.
     */
    let bandKernel: string | null = null
    try {
      updateProgress(`phase 1/2: md parity check on ${label}`)

      // /proc/mdstat keys arrays by transient kernel names (GT-2). Resolve the
      // CURRENT kernel name from the stable pin symlink (array.device is always
      // /dev/md/<pool>-r<band>) at point-of-use — NEVER trust array.kernelName
      // from the route-time topology read: md kernel numbers re-enumerate AND get
      // reused across any reassembly between the route read and this check, so a
      // stale md127 could match a DIFFERENT array in mdstat and make us wait on
      // the wrong device (or none). Resolved BEFORE the check is issued so the
      // pre-check snapshot below is genuinely "before"; the check is issued
      // either way, so an unresolvable name costs the wait, never the check.
      const rp = await executor.exec(REALPATH, [array.device])
      const kernelName = rp.exitCode === 0 ? rp.stdout.trim().replace(DEV_PREFIX_RE, '') : null
      bandKernel = kernelName
      // What md had last run here BEFORE this check, AND the counter it left —
      // together, the only evidence that says whether a check no poll ever saw
      // was ours and ran to the end (F11, third pass).
      //
      // `last_sync_action` on its own proves nothing about THIS check. It is
      // PERSISTENT: any node that has ever run mdcheck reads `check` there for
      // ever, so "idle and last_sync_action=check" is the resting state of a
      // perfectly ordinary array and matches a check that was aborted two
      // seconds in by a member failure exactly as well as one that completed.
      // `mismatch_cnt` is the discriminator — md ZEROES it when a sync op
      // starts, so a counter that MOVED since this snapshot is proof a sync op
      // ran here after we issued ours.
      const priorAction = kernelName ? await lastSyncAction(executor, kernelName) : null
      const priorMismatch = kernelName ? await mismatchCount(executor, kernelName) : null

      if (kernelName) {
        // S3: the route read the pool's state once, and bands are checked one at
        // a time over hours. A member that failed since then has md recovering
        // onto a spare RIGHT NOW, and issuing a check into that either bounces
        // (mdadm exits non-zero and `run` throws, failing the whole scrub) or —
        // worse, once the cancel path runs — aborts the rebuild. Re-read what md
        // is doing immediately before issuing, per band.
        const busy = await syncAction(executor, kernelName)
        if (!isIdleAction(busy)) {
          updateProgress(`${label} was not checked. md is running ${busy} on that band, and a parity check would fight it`)
          bandsSkipped.push({ band: label, reason: `md was running '${busy}' when this band's turn came` })
          continue
        }
        // D4(b): a repair that was killed mid-sequence leaves `sync_max` bounded
        // to ONE STRIPE, and the knob PERSISTS (GT-13's trap) — a check issued
        // under it covers that stripe, suspends, and the finish-wait then holds
        // the pool's job exclusion for the full ceiling. The band is idle (just
        // proven), so the window can simply be put back.
        const syncMax = await readSyncValue(kernelName, 'sync_max')
        const syncMin = await readSyncValue(kernelName, 'sync_min')
        if ((syncMax !== null && syncMax !== MD_DEFAULT_SYNC_MAX) || (syncMin !== null && syncMin !== MD_DEFAULT_SYNC_MIN)) {
          const widened = await restoreSyncWindow(kernelName)
          if (widened) {
            updateProgress(`${label}: sync window was bounded to ${syncMin ?? '?'}..${syncMax ?? '?'} (an interrupted repair left it there). It was restored to ${MD_DEFAULT_SYNC_MIN}..${MD_DEFAULT_SYNC_MAX} before issuing the check`)
          }
          else {
            updateProgress(`${label} was not checked. Its sync window is bounded to ${syncMin ?? '?'}..${syncMax ?? '?'} and could not be restored, so a check would cover that sliver of the band and suspend there`)
            bandsSkipped.push({ band: label, reason: `its sync window is bounded to ${syncMin ?? '?'}..${syncMax ?? '?'} and could not be restored` })
            continue
          }
        }
      }

      // Issued without `run`: a band that entered recovery in the few
      // milliseconds since the read above makes mdadm exit non-zero, and one
      // band's refusal must not fail the whole scrub (S3).
      const issue = await executor.exec(MDADM, ['--action=check', array.device])
      if (issue.exitCode !== 0) {
        updateProgress(`${label} was not checked (mdadm --action=check exited ${issue.exitCode}${issue.stderr.trim() ? `: ${issue.stderr.trim()}` : ''})`)
        bandsSkipped.push({ band: label, reason: `mdadm --action=check exited ${issue.exitCode}${issue.stderr.trim() ? `: ${issue.stderr.trim()}` : ''}` })
        continue
      }
      if (kernelName) {
        // From here on THIS scrub owns the check on this band, and only now may
        // it write `idle` there (D2).
        markCheckIssued(kernelName)
      }

      if (!kernelName) {
        // A FOURTH abandonment path (fourth pass): the check above WAS issued —
        // the comment before the resolution says so deliberately — so walking
        // away without taking it back would leave it armed beside the next
        // band's check. It cannot be taken back safely either: with no kernel
        // name there is no `sync_action` to prove the check is still what md is
        // running, and an unprovable `idle` is the write that aborts a rebuild.
        updateProgress(await cancelBandCheck(executor, array.device, null, label, null))
        updateProgress(`Cannot resolve ${array.device} to a kernel device. Not waiting on its check`)
        bandsSkipped.push({ band: label, reason: 'the md device could not be resolved to a kernel name' })
        continue
      }
      // WAIT FOR IT TO START before waiting for it to finish. md takes the write
      // to `sync_action` asynchronously; a first mdstat read that lands before
      // the sync thread is running shows no check, which the finish-wait below
      // would read as "already done" — and then the mismatch_cnt read belongs to
      // an earlier check and phase 2 runs while md's check is under it.
      let started = false
      let observable = true
      let alreadyFinished = false
      /** The proven verdict of a check that finished before the first poll. */
      let finishedMismatch: number | null = null
      /** md is idle and last ran a check, but nothing proves it was THIS one. */
      let checkStateUnknown = false
      const startDeadline = Date.now() + (opts?.checkStartTimeoutMs ?? AHR_SCRUB_CHECK_START_TIMEOUT_MS)
      for (;;) {
        const md = parseMdstat((await run(executor, CAT, MDSTAT_CAT_ARGS)).stdout)
          .find(a => a.kernelName === kernelName)
        if (md && (md.sync?.action === 'check' || md.syncDelayed || md.syncPending)) {
          started = true
          break
        }
        const action = await syncAction(executor, kernelName)
        if (action === null) {
          // No `sync_action` to watch — there is no signal here to wait on, so
          // this band keeps the plain mdstat wait rather than burning the window.
          observable = false
          break
        }
        if (!isIdleAction(action)) {
          started = true
          break
        }
        if (Date.now() >= startDeadline) {
          // Three states look identical here — a small band's check that RAN TO
          // COMPLETION between mdadm returning and the first poll (F11), a check
          // md never took at all, and a check that started and died two seconds
          // in — and md is idle in all three. They are told apart from md's own
          // records, and a band is counted only when all of the evidence agrees
          // (third pass, T2):
          //
          //   · `last_sync_action` = check  — the last op md RAN here was a check
          //   · `mismatch_cnt` MOVED        — md zeroed it at a sync start, so
          //                                   the number is a new one, not the
          //                                   stale one this band already held
          //   · `sync_action` idle          — whatever ran, it is over
          //
          // Anything short of that is "unknown", NOT a verdict: no rot is
          // claimed from a counter that may be a previous check's, and no clean
          // bill is given to a band whose check may have died at 2%.
          const lastAction = await lastSyncAction(executor, kernelName)
          if (lastAction !== 'check')
            break // md's last op here was not a check at all: ours never started.
          // The counter finalizes as the sync thread winds down, the same settle
          // the verdict read below takes.
          await sleep(mismatchDelay)
          const nowMismatch = await mismatchCount(executor, kernelName)
          if (priorMismatch !== null && nowMismatch !== null && nowMismatch !== priorMismatch) {
            alreadyFinished = true
            finishedMismatch = nowMismatch
            updateProgress(
              `md check on ${label} finished before the first poll`
              + `${priorAction !== null && priorAction !== 'check' ? ` (md was last running '${priorAction}')` : ''}`
              + `. Its counter moved from ${priorMismatch} to ${nowMismatch}`,
            )
          }
          else {
            checkStateUnknown = true
          }
          break
        }
        updateProgress(`md check on ${label} (waiting for md to start it)`)
        await sleep(interval)
      }
      if (!started && observable && !alreadyFinished) {
        // Say it, and read NO counter as a verdict: `mismatch_cnt` still holds
        // whatever the last check that DID run left there, and reporting it as
        // this scrub's verdict would invent rot (or, worse, clear a real
        // finding). `priorAction` earns its snapshot here — md updates
        // `last_sync_action` when an op BEGINS, so a value that changed under us
        // says md did take a check, and an unmoved counter then says that check
        // did not run to the end.
        updateProgress(
          !checkStateUnknown
            ? `md never started the check on ${label}. This band was not checked, and its mismatch_cnt read belongs to an earlier check`
            : priorAction !== 'check'
              ? `check state unknown on ${label}. Not counted. md took a check and is idle again, but its mismatch_cnt never moved from ${priorMismatch ?? 'unreadable'}, so nothing says the check ran to the end`
              : `check state unknown on ${label}. Not counted. md is idle and last ran a check, but its mismatch_cnt never moved from ${priorMismatch ?? 'unreadable'}, so nothing tells this scrub's check from an earlier one`,
        )
        // The skip rides the result (D8): the band reads as "not checked", with
        // the same why the progress line just gave the operator.
        bandsSkipped.push({
          band: label,
          reason: !checkStateUnknown
            ? 'md never started the check'
            : 'check state unknown: nothing proves md ran the check to the end',
        })
        continue
      }

      // FINISH-WAIT, with a deadline policy (second-pass review F3). A `check`
      // in progress is waited on for as long as it takes — hours or days on a
      // real band. What is NOT waited on is md doing something else: `frozen`,
      // or a resync/recover/reshape/repair that replaced our check, means this
      // band is not being checked for us and never will be in this run. Waiting
      // on those spun the job forever, and with the active-job exclusion (R7)
      // that refused every later scrub and repair on the pool until a restart.
      let checked = true
      /** What md was doing when this band's finish-wait gave up on it (T4). */
      let abandonedOn: string | null = null
      /** Why the band was not checked, for the result's `bandsSkipped` (D8). */
      let skippedReason: string | null = null
      if (!alreadyFinished) {
        const finishDeadline = Date.now() + (opts?.checkFinishCeilingMs ?? AHR_SCRUB_CHECK_FINISH_CEILING_MS)
        for (;;) {
          const md = parseMdstat((await run(executor, CAT, MDSTAT_CAT_ARGS)).stdout)
            .find(a => a.kernelName === kernelName)
          const action = await syncAction(executor, kernelName)
          // Array gone from mdstat, or its check finished (and is not queued/parked
          // behind another sync): move to the next band. A `resync=PENDING` check
          // (syncPending, sync still null — e.g. an auto-read-only array parks its
          // check until first write, GT-9) is IN-FLIGHT, not finished: treating it
          // as done lets the next band's check start and the pending one later
          // fires concurrently, breaking the strictly-sequential guarantee (§4).
          // sysfs is consulted alongside mdstat: an op that has left mdstat's
          // progress line but not yet gone idle is still running.
          const mdstatIdle = !md || (md.sync?.action !== 'check' && !md.syncDelayed && !md.syncPending)
          const sysfsIdle = isIdleAction(action)
          if (mdstatIdle && sysfsIdle)
            break
          if (action !== null && !isIdleAction(action) && action !== 'check') {
            // No counter read: whatever `mismatch_cnt` holds is not this band's
            // check verdict, and a resync/recover/reshape overwrites it anyway.
            updateProgress(`${label} was not checked (sync_action=${action}). md is not running this scrub's check on that band`)
            checked = false
            abandonedOn = action
            skippedReason = `md was running '${action}' instead of this scrub's check`
            break
          }
          if (Date.now() >= finishDeadline) {
            updateProgress(`${label} was not checked (sync_action=${action ?? 'unreadable'}). Still not idle after the ${ceilingText(opts?.checkFinishCeilingMs ?? AHR_SCRUB_CHECK_FINISH_CEILING_MS)} ceiling. Not waiting on it any longer`)
            checked = false
            abandonedOn = action
            skippedReason = `still not idle after the ${ceilingText(opts?.checkFinishCeilingMs ?? AHR_SCRUB_CHECK_FINISH_CEILING_MS)} ceiling: the check may still be running`
            break
          }
          updateProgress(`md check on ${label}${md?.sync ? ` (${md.sync.percent.toFixed(1)}%)` : ' (queued)'}`)
          await sleep(interval)
        }
      }
      if (!checked) {
        // Never walk away leaving our check armed on the band (T4): the next
        // band's check is issued immediately after this `continue`.
        updateProgress(await cancelBandCheck(executor, array.device, kernelName, label, abandonedOn))
        bandsSkipped.push({ band: label, reason: skippedReason ?? 'the check was abandoned' })
        continue
      }

      // The check's verdict: md counted parity mismatches ⇒ rot EXISTS in this
      // band. Phase 2 is what names the files, and it starts right now — say so
      // in one warning rather than leaving the operator staring at a number (§e).
      // Read only now: idle, plus the settle the counter needs (selfheal.4).
      // The finished-before-the-first-poll path already took that settle and
      // read the counter to PROVE the check ran — that read IS the verdict, and
      // reading again would only risk catching the zero of a newer sync op.
      let mismatches: number | null
      if (alreadyFinished) {
        mismatches = finishedMismatch
      }
      else {
        await sleep(mismatchDelay)
        mismatches = await mismatchCount(executor, kernelName)
      }
      // A verdict exists — the band WAS checked, mismatch or not (D8:
      // `checkedArrays` counts bands actually checked, either way).
      //
      // A counter that could NOT BE READ is not a verdict (sixth pass, N12): the
      // check ran, but nothing came back from it, so the band has no clean bill
      // and no finding. Counting it as coverage is the same false assurance D8
      // closed for the bands that were never checked at all.
      if (mismatches === null) {
        updateProgress(`${label} was checked, but its mismatch_cnt could not be read. This band has no verdict from this scrub`)
        bandsSkipped.push({ band: label, reason: 'checked, but its mismatch_cnt could not be read' })
        continue
      }
      bandsChecked.push(label)
      if (mismatches > 0) {
        // The band's LEVEL rides the row (N1): md counts mismatching stripes on
        // a parity band and disagreeing LEGS on a mirror, and only the first has
        // a Rewrite-parity verb. A consumer that cannot tell them apart must not
        // offer one.
        parityMismatches.push({ band: label, bandIndex: array.band, array: array.device, mismatchCnt: mismatches, level: array.level })
        await pveNotify(
          executor,
          'warning',
          `AHR scrub: parity mismatch on ${label}`,
          `rot exists in ${label}. Phase 2 is running now and checks every file's checksum. `
          + `If a file is affected, it will be named`,
        )
      }
    }
    finally {
      // Ours or not, this scrub is done with this band: the token never
      // outlives the iteration that took it.
      if (bandKernel !== null)
        retireCheckIssued(bandKernel)
    }
  }

  // --- Phase 2/2: btrfs checksum scrub ----------------------------------------
  updateProgress('phase 2/2: btrfs checksum scrub')
  const { startedAt, btrfsErrors } = await btrfsScrubPass(executor, pool.mountpoint, name, updateProgress, interval)

  // --- Attribution: which files, which blocks (selfheal.3) -------------------
  // Runs AFTER phase 1 by construction now — its probe reads are tiny, but §4's
  // rule is that nothing else reads the array while a check runs.
  let attribution: Pick<AhrScrubResult, 'findings' | 'errorsAttributed' | 'unattributed' | 'truncated'> = {}
  if (btrfsErrors !== null) {
    try {
      attribution = await attributeScrub(executor, pool, startedAt, updateProgress)
    }
    catch (err) {
      // Never fails the scrub: the count and the notification stand on their own.
      console.error(`ahr-scrub: could not attribute '${name}' scrub errors: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // --- Corrected metadata reads (selfheal.12) ---------------------------------
  // The run's own window, read at the END so the corrections this run's own
  // scrub and probe reads triggered are inside it too (GT-20: a rotten DUP
  // metadata copy is repaired by the read that serves it, and the scrub's own
  // summary never says so). One more bounded, grep-filtered read of the same
  // window — never a standing watcher. Fail-open: a journal that cannot be
  // read costs the count, never the scrub, and never invents a clean bill.
  let metadataCorrected: AhrMetadataCorrected | undefined
  try {
    const corrected = await readCorrectedReads(executor, pool, startedAt)
    if (corrected.count > 0)
      metadataCorrected = AhrMetadataCorrectedSchema.parse(corrected)
  }
  catch (err) {
    console.error(`ahr-scrub: could not read '${name}' scrub's corrected-metadata lines: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Validated at the daemon boundary before it leaves as a job result — the
  // shared schema is the contract, here as at every other boundary (Principle 6).
  // The per-band record rides with it (D1/D8): parityMismatches,
  // bandsChecked and bandsSkipped are phase 1's own verdicts, returned —
  // omitted when empty, like every other additive field on this result.
  const result = AhrScrubResultSchema.parse({
    scrubbed: name,
    btrfsErrors,
    checkedArrays: bandsChecked.length,
    ...(bandsChecked.length > 0 ? { bandsChecked } : {}),
    ...(bandsSkipped.length > 0 ? { bandsSkipped } : {}),
    ...(parityMismatches.length > 0 ? { parityMismatches } : {}),
    ...(btrfsErrors !== null ? { errorsReported: countErrorSummary(btrfsErrors) } : {}),
    ...(metadataCorrected ? { metadataCorrected } : {}),
    ...attribution,
  })

  // --- Notifications: one story, in the honest buckets ------------------------
  // The findings warning is the scrub's own message (§7.3), now carrying the
  // skipped bands (D8 — a check that skipped a band never reads as coverage).
  // The PARITY-ONLY case (D1) gets its own notification: phase 1 counted
  // mismatches and phase 2 named NO file, so the promised attribution never
  // came and the operator must not read the silence as "false alarm".
  // The corrected-metadata sentence (selfheal.12) rides whichever notification
  // this scrub emits — and when nothing else was wrong it earns its own, so
  // the one signal GT-20 proved exists is never silent.
  const findings = result.findings ?? []
  const parity = result.parityMismatches ?? []
  const skipped = result.bandsSkipped ?? []
  const correctedSuffix = metadataCorrected ? `\n\n${metadataCorrectedSentence(metadataCorrected)}` : ''
  if (btrfsErrors !== null) {
    await pveNotify(executor, 'warning', 'AHR scrub found errors', findingsBody(pool, btrfsErrors, result) + correctedSuffix)
    if (parity.length > 0 && findings.length === 0)
      await pveNotify(executor, 'warning', parityTitle(parity), parityBody(pool, parity, false) + correctedSuffix)
  }
  else if (parity.length > 0) {
    // Phase 1 said rot exists (its own per-band warning already went out);
    // this is the SECOND notification that closes the story: phase 2 ran
    // clean, so the checksum pass has nothing to name — the rot is parity-only.
    await pveNotify(executor, 'warning', parityTitle(parity), parityBody(pool, parity, true) + correctedSuffix)
  }
  else if (skipped.length > 0) {
    // Nothing found AND something skipped: without this the scrub reports
    // clean while it never looked at a whole band (D8's false assurance).
    await pveNotify(executor, 'warning', 'AHR scrub did not check every band', skippedBody(skipped) + correctedSuffix)
  }
  else if (metadataCorrected) {
    // A CLEAN scrub that corrected metadata (the exact GT-20 shape): the
    // summary says nothing, so this is the only notification the run gets.
    await pveNotify(executor, 'warning', 'AHR scrub: metadata corrected from the mirror', metadataCorrectedSentence(metadataCorrected))
  }

  return result
}
