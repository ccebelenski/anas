import type {
  AhrExpansionIntent,
  AhrExpansionStep,
  AhrPool,
  AhrPreviewBand,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { MdadmDetailExport } from '../parsers/mdadm-detail.js'
import type { MdstatArray } from '../parsers/mdstat.js'
import type { AhrExpansionPlan, ExistingBand } from './ahr-layout.js'
import { btrfsUsageArgs, parseBtrfsUsage } from '../parsers/btrfs-usage.js'
import { parseFindmnt } from '../parsers/findmnt.js'
import { LVS_ARGS, parseLvsReport, parsePvsReport, parseVgsReport, PVS_ARGS, VGS_ARGS } from '../parsers/lvm-report.js'
import { matchAhrArrayName, mdadmDetailExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { ahrDataOffsetArg, planDiskPartitions } from './ahr-geometry.js'
import { clearIntent, defaultAhrIntentDir, writeIntent } from './ahr-intent.js'
import { floorToGranularity, fmtBytes } from './ahr-layout.js'
import { pinArrays } from './ahr-mdadm-conf.js'
import { AHR_FINDMNT_ARGS, stripSubvolSuffix } from './ahr-topology.js'
import { pveNotify } from './pve-notify.js'

/**
 * AHR expansion step executor (Epic 11.6, docs/AHR-DESIGN.md §5) — the
 * dangerous part, kept deliberately dumb:
 *
 *   THE PLANNER OWNS EVERY LAYOUT DECISION. This module never invents a step —
 *   it realizes the ordered step list planExpansion produced, and each step is
 *   DETECT-THEN-DELTA (§5.1): it first reads what the system already IS and
 *   computes the remaining delta, so a re-run after any interruption is a
 *   no-op for completed work. That property — not a persisted step log — is
 *   what makes resume "recompute-and-continue" (§5.3).
 *
 * Hard rules encoded here:
 *  - NEVER `--backup-file`. AHR mandates offset-based reshapes (§5.1, GT-6);
 *    if mdadm errors demanding a backup file, the step FAILS with the exact
 *    stderr — that is a design-violation signal, never worked around.
 *  - NEVER re-issue a reshape. `reshape-wait` only observes /proc/mdstat; the
 *    kernel owns reshape resumability.
 *  - The filesystem grows LAST, and only after the LV beneath it is verified
 *    extended (never grow the fs before its block device).
 *  - A step failure halts the pipeline in a known state: intent → 'halted',
 *    PVE error notification naming the failed layer, return. The pool remains
 *    whatever it is (usually mounted and usable).
 */

const CAT = '/usr/bin/cat'
const LSBLK = '/usr/bin/lsblk'
const SGDISK = '/usr/sbin/sgdisk'
const MDADM = '/usr/sbin/mdadm'
const UDEVADM = '/usr/bin/udevadm'
const REALPATH = '/usr/bin/realpath'
const UPDATE_INITRAMFS = '/usr/sbin/update-initramfs'
const PVCREATE = '/usr/sbin/pvcreate'
const PVRESIZE = '/usr/sbin/pvresize'
const VGEXTEND = '/usr/sbin/vgextend'
const LVEXTEND = '/usr/sbin/lvextend'
const PVS = '/usr/sbin/pvs'
const VGS = '/usr/sbin/vgs'
const LVS = '/usr/sbin/lvs'
const BTRFS = '/usr/bin/btrfs'
const FINDMNT = '/usr/bin/findmnt'

const MIB = 1024 ** 2

/** mdadm stderr demanding a backup file — the GT-6 design-violation signal. */
const BACKUP_FILE_RE = /backup[ -]?file/i

/** `md/<pool>-r<band>` step target. */
const MD_TARGET_RE = /^md\/(.+)-r(\d+)$/

/** Trailing partition number of a kernel partition name (`sdq1`, `nvme0n1p2`). */
const PART_NUMBER_RE = /(\d+)$/

/**
 * Detection slack for the LVM no-op checks: PV metadata (~1 MiB) + extent
 * rounding (4 MiB default) sit between an md array's size and its PV's, and a
 * REAL growth delta is at least the 1 GiB layout granularity — so anything
 * within this margin is "already done".
 */
const LVM_SLACK_BYTES = 128 * MIB

/** VG free space below this is "nothing left to extend into" (< 2 extents). */
const VG_FREE_EPSILON_BYTES = 8 * MIB

/** `lsblk` args for one disk: its partitions with sizes + labels. */
export function diskLsblkArgs(device: string): string[] {
  return ['-Jb', '-o', 'NAME,TYPE,SIZE,PARTLABEL', device]
}

function byIdPath(diskId: string): string {
  return `/dev/disk/by-id/${diskId}`
}

function partByIdPath(diskId: string, partNumber: number): string {
  return `/dev/disk/by-id/${diskId}-part${partNumber}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---- Inputs / outcome -------------------------------------------------------

export interface ExpansionInput {
  pool: AhrPool
  intent: AhrExpansionIntent
  plan: AhrExpansionPlan
}

export interface ExpansionOptions {
  /** Intent store directory (default ANAS_AHR_INTENT_DIR / /etc/anas/ahr). */
  intentDir?: string
  /** reshape-wait poll interval (default 3000 ms; tests shrink it). */
  pollIntervalMs?: number
  /** Structured step-transition log sink (default console — journald, §7.1). */
  log?: (line: string) => void
}

export interface ExpansionOutcome {
  ok: boolean
  /** The plan's steps with their final statuses. */
  steps: AhrExpansionStep[]
  /** The step that halted the pipeline, when !ok. */
  failedStep?: AhrExpansionStep
  /** The failure message, when !ok. */
  error?: string
}

// ---- Existing-band projection (planner input from a live pool) --------------

/**
 * Project a live pool's arrays into the §2.3 planner's immutable
 * {@link ExistingBand} constraints. Boundaries are reconstructed from the
 * partition geometry, not guessed from disk sizes:
 *
 *  - an INTERIOR slice's size is exactly the band height (plus the 1 MiB GPT
 *    displacement for the bottom band — GT-4), so any member whose slice is
 *    not its disk's clamped top slice yields the exact boundary;
 *  - when EVERY member's slice clamps to its disk's end (the top band of a
 *    pool whose members all end there), the boundary is those disks' §2.5
 *    rounded usable size — which is, by construction, exactly where the
 *    clamped slice logically ends.
 */
export function projectExistingBands(pool: AhrPool): ExistingBand[] {
  const arrays = [...pool.arrays]
  arrays.sort((a, b) => a.band - b.band)
  const out: ExistingBand[] = []
  let start = 0
  for (const [i, arr] of arrays.entries()) {
    const exactHeights: number[] = []
    const clampedUsables: number[] = []
    for (const member of arr.members) {
      const disk = pool.disks.find(d => d.id === member.disk)
      const part = disk?.partitions.find(p => p.band === arr.band)
      if (!disk || !part)
        continue
      const isTopSlice = !disk.partitions.some(p => p.band > arr.band)
      const covered = MIB + disk.partitions.reduce((sum, p) => sum + p.sizeBytes, 0)
      if (isTopSlice && disk.sizeBytes > 0 && disk.sizeBytes - covered < MIB)
        clampedUsables.push(floorToGranularity(disk.sizeBytes))
      else
        exactHeights.push(part.sizeBytes + (i === 0 ? MIB : 0))
    }
    let end: number
    if (exactHeights.length > 0)
      end = start + Math.max(...exactHeights)
    else if (clampedUsables.length > 0)
      end = Math.min(...clampedUsables)
    else
      throw new Error(`cannot project band ${arr.band} of pool '${pool.name}' — no member partition geometry found`)
    if (end <= start)
      throw new Error(`projected band ${arr.band} of pool '${pool.name}' has a non-positive height — partition geometry is inconsistent`)
    out.push({
      band: arr.band,
      startBytes: start,
      endBytes: end,
      level: arr.level,
      // Spare slices (mdstat `(S)`, §11) are NOT band members: the planner
      // must never require the spare disk in the approved set, count it
      // toward member totals, or treat it as growable membership.
      members: arr.members.filter(m => m.memberState !== 'spare').map(m => m.disk),
    })
    start = end
  }
  return out
}

// ---- Shared system-reading helpers ------------------------------------------

/** A command that must succeed; throws its stderr verbatim otherwise. */
async function execChecked(executor: CommandExecutor, command: string, args: string[]): Promise<string> {
  const r = await executor.exec(command, args)
  if (r.exitCode !== 0) {
    const stderr = r.stderr.trim() || `${command} ${args.join(' ')} exited ${r.exitCode}`
    if (BACKUP_FILE_RE.test(r.stderr)) {
      throw new Error(
        `mdadm demanded a backup file — that violates the AHR offset-based reshape mandate (§5.1/GT-6) `
        + `and is never worked around; the array's data offsets need investigation. mdadm said: ${stderr}`,
      )
    }
    throw new Error(stderr)
  }
  return r.stdout
}

export interface DiskTree {
  /** Whole-disk kernel name. */
  kernel: string
  sizeBytes: number
  parts: { name: string, number: number | null, sizeBytes: number, partlabel: string | null }[]
}

/** One disk's live partition view, or null when the device is absent. */
export async function readDiskTree(executor: CommandExecutor, device: string): Promise<DiskTree | null> {
  const r = await executor.exec(LSBLK, diskLsblkArgs(device))
  if (r.exitCode !== 0)
    return null
  interface Node { name?: string, type?: string, size?: number, partlabel?: string | null, children?: Node[] }
  let root: { blockdevices?: Node[] }
  try {
    root = JSON.parse(r.stdout)
  }
  catch {
    return null
  }
  const disk = (root.blockdevices ?? []).find(d => d.type === 'disk' && d.name)
  if (!disk)
    return null
  const parts = (disk.children ?? [])
    .filter(c => c.type === 'part' && c.name)
    .map(c => ({
      name: c.name!,
      number: PART_NUMBER_RE.test(c.name!) ? Number.parseInt(c.name!.match(PART_NUMBER_RE)![1], 10) : null,
      sizeBytes: c.size ?? 0,
      partlabel: c.partlabel ?? null,
    }))
  return { kernel: disk.name!, sizeBytes: disk.size ?? 0, parts }
}

/** One resolved (live) band array — kernel handle valid for this pass only. */
export interface ResolvedArray {
  band: number
  kernelName: string
  /** Kernel device path (`/dev/md127`) — the handle commands run against. */
  dev: string
  md: MdstatArray
  detail: MdadmDetailExport
}

/**
 * Resolve a pool's live arrays by superblock name (GT-2/GT-3 discipline):
 * /proc/mdstat discovers, `--detail --export` identifies. Keyed by band.
 */
export async function resolveAhrArrays(executor: CommandExecutor, poolName: string): Promise<Map<number, ResolvedArray>> {
  const out = new Map<number, ResolvedArray>()
  const mdstatText = await execChecked(executor, CAT, MDSTAT_CAT_ARGS)
  for (const md of parseMdstat(mdstatText)) {
    const res = await executor.exec(MDADM, mdadmDetailExportArgs(`/dev/${md.kernelName}`))
    const detail = parseMdadmDetailExport(res.stdout)
    const named = matchAhrArrayName(detail.name ?? detail.devName ?? '')
    if (!named || named.pool !== poolName)
      continue
    out.set(named.band, { band: named.band, kernelName: md.kernelName, dev: `/dev/${md.kernelName}`, md, detail })
  }
  return out
}

const bandLabelCache = new Map<string, RegExp>()
/** `<pool>-d<n>-b<band>` partition-label matcher (d-number-agnostic). */
function bandLabelRe(poolName: string, band: number): RegExp {
  const key = `${poolName}:${band}`
  let re = bandLabelCache.get(key)
  if (!re) {
    re = new RegExp(`^${poolName}-d\\d+-b${band}$`)
    bandLabelCache.set(key, re)
  }
  return re
}

/** The `<pool>-d(\d+)-` label prefix, for d-number recovery/assignment. */
const dNumberCache = new Map<string, RegExp>()
function dNumberRe(poolName: string): RegExp {
  let re = dNumberCache.get(poolName)
  if (!re) {
    re = new RegExp(`^${poolName}-d(\\d+)-b\\d+$`)
    dNumberCache.set(poolName, re)
  }
  return re
}

/** lsblk args reused from the topology reader for the pool-wide label scan. */
const POOL_SCAN_LSBLK_ARGS = ['-Jb', '-o', 'NAME,TYPE,SIZE,PARTLABEL']

/**
 * The `d<n>` ordinal for a disk's partition labels: its own existing labels
 * win (a disk keeps its number for life); a fresh disk gets max(seen)+1 from a
 * pool-wide label scan.
 */
async function resolveDiskNumber(executor: CommandExecutor, poolName: string, disk: DiskTree): Promise<number> {
  const re = dNumberRe(poolName)
  for (const p of disk.parts) {
    const m = p.partlabel?.match(re)
    if (m)
      return Number.parseInt(m[1], 10)
  }
  let max = 0
  const r = await executor.exec(LSBLK, POOL_SCAN_LSBLK_ARGS)
  if (r.exitCode === 0) {
    try {
      interface Node { partlabel?: string | null, children?: Node[] }
      const walk = (node: Node): void => {
        const m = node.partlabel?.match(re)
        if (m)
          max = Math.max(max, Number.parseInt(m[1], 10))
        for (const child of node.children ?? [])
          walk(child)
      }
      for (const dev of (JSON.parse(r.stdout) as { blockdevices?: Node[] }).blockdevices ?? [])
        walk(dev)
    }
    catch {
      // Fall through — max stays at the highest seen (0).
    }
  }
  return max + 1
}

/**
 * DETECT-THEN-DELTA partitioning of one disk: compute the disk's full slice
 * chain from the plan's protected bands, skip every slice whose partition
 * already exists (matched by its band label), and sgdisk only the missing
 * ones. Exported for the replace job, which partitions the incoming disk
 * before its first `mdadm --add`.
 */
export async function ensureDiskPartitions(
  executor: CommandExecutor,
  poolName: string,
  diskId: string,
  previewBands: AhrPreviewBand[],
): Promise<{ created: number }> {
  const dev = byIdPath(diskId)
  const disk = await readDiskTree(executor, dev)
  if (!disk)
    throw new Error(`disk '${diskId}' is not present — a missing disk is never partitioned around`)
  const usable = floorToGranularity(disk.sizeBytes)
  const slices = previewBands
    .filter(b => b.level !== null && b.range.endBytes <= usable)
    .map(b => ({ band: b.band, startBytes: b.range.startBytes, endBytes: b.range.endBytes }))
  if (slices.length === 0)
    return { created: 0 }

  const diskNumber = await resolveDiskNumber(executor, poolName, disk)
  const specs = planDiskPartitions({ poolName, diskNumber, diskUsableBytes: usable, diskRawBytes: disk.sizeBytes, slices })
  const missing = specs.filter((spec) => {
    if (disk.parts.some(p => p.partlabel !== null && bandLabelRe(poolName, spec.band).test(p.partlabel)))
      return false // slice already carved (any d-number)
    const collision = disk.parts.find(p => p.number === spec.number)
    if (collision) {
      throw new Error(
        `partition ${spec.number} already exists on '${diskId}' with unexpected label `
        + `'${collision.partlabel ?? ''}' — refusing to touch a partition ANAS does not recognize`,
      )
    }
    return true
  })
  if (missing.length === 0)
    return { created: 0 }

  await execChecked(executor, SGDISK, [...missing.flatMap(s => s.sgdiskArgs), dev])
  // Give udev a beat to create the -partN by-id symlinks (best-effort).
  await executor.exec(UDEVADM, ['settle'])
  return { created: missing.length }
}

interface BandMember {
  diskId: string
  partKernel: string
  partNumber: number
  partByIdPath: string
}

/**
 * The member partitions a band SHOULD have per the plan: every approved disk
 * tall enough for the band, each contributing its labeled slice. A serving
 * disk without its slice fails the step (the plan's partition steps precede
 * every md step — a missing slice means something external interfered).
 */
async function expectedBandMembers(
  executor: CommandExecutor,
  poolName: string,
  band: AhrPreviewBand,
  approvedDisks: string[],
): Promise<BandMember[]> {
  const out: BandMember[] = []
  for (const diskId of approvedDisks) {
    const disk = await readDiskTree(executor, byIdPath(diskId))
    if (!disk)
      throw new Error(`approved disk '${diskId}' is not present — a missing disk is never treated as intent (§5.3)`)
    if (floorToGranularity(disk.sizeBytes) < band.range.endBytes)
      continue
    const part = disk.parts.find(p => p.partlabel !== null && bandLabelRe(poolName, band.band).test(p.partlabel))
    if (!part || part.number === null)
      throw new Error(`disk '${diskId}' has no partition for band ${band.band} — the partition step did not complete`)
    out.push({ diskId, partKernel: part.name, partNumber: part.number, partByIdPath: partByIdPath(diskId, part.number) })
  }
  return out
}

/** Numeric mdadm level for a shared-schema level ('raid5' → '5'). */
function levelNumber(level: string): string {
  return level.replace('raid', '')
}

/**
 * Attach one disk's labeled band slice to its band array as a hot spare
 * (§11): `mdadm <array> --add-spare <slice>`. Detect-then-delta: a slice that
 * is already an array member (spare or otherwise) is left alone. Shared by
 * the spare-attach verb (services/ahr-spare.ts) and the expansion coupling
 * below. Returns true when a slice was actually added.
 */
export async function addSpareSlice(
  executor: CommandExecutor,
  poolName: string,
  diskId: string,
  band: number,
  arrayDev: string,
  currentMemberKernels: ReadonlySet<string>,
): Promise<boolean> {
  const disk = await readDiskTree(executor, byIdPath(diskId))
  if (!disk)
    throw new Error(`spare disk '${diskId}' is not present — a missing disk is never worked around`)
  const part = disk.parts.find(p => p.partlabel !== null && bandLabelRe(poolName, band).test(p.partlabel))
  if (!part || part.number === null)
    throw new Error(`spare disk '${diskId}' has no partition for band ${band} — the partition step did not complete`)
  if (currentMemberKernels.has(part.name))
    return false // already attached (resume/no-op path)
  await execChecked(executor, MDADM, [arrayDev, '--add-spare', partByIdPath(diskId, part.number)])
  return true
}

/**
 * Slot hygiene shared by spare-attach (§11) and Re-add (11.9): remove any
 * FAULTY member of `arrayDev` whose device node is now ABSENT — md's own
 * "detached" test. This is the returned-disk case that a name match misses: a
 * disk that dropped and came back WITHOUT a reboot re-enumerates under a NEW
 * kernel name, so the array's faulty slot still names the OLD (now-absent)
 * node. `mdadm --remove detached` clears exactly those slots (never a
 * faulty-but-PRESENT disk — that stays for Replace/Re-add to own). Returns
 * true when a `--remove detached` was actually issued.
 */
export async function removeDetachedFaultySlots(
  executor: CommandExecutor,
  arrayDev: string,
  members: readonly MdstatArray['members'][number][],
): Promise<boolean> {
  const faulty = members.filter(m => m.faulty)
  if (faulty.length === 0)
    return false
  let anyAbsent = false
  for (const m of faulty) {
    const real = await executor.exec(REALPATH, [`/dev/${m.device}`])
    if (real.exitCode !== 0)
      anyAbsent = true
  }
  if (!anyAbsent)
    return false
  await executor.exec(MDADM, [arrayDev, '--remove', 'detached'])
  return true
}

// ---- reshape-wait ----------------------------------------------------------

interface WaitContext {
  poolName: string
  label: string
  kernelName: string
  pollIntervalMs: number
  updateProgress: (message: string) => void
  log: (line: string) => void
  /** Kernel names already error-notified for degraded-during-sync (§8 once). */
  degradedNotified: Set<string>
}

/**
 * Observe one array until its sync thread (reshape/resync/recover) finishes.
 * NEVER issues a command beyond reading /proc/mdstat — the kernel owns
 * reshape resumability (§5.1). Throws when the array disappears or goes
 * INACTIVE (the GT-8 family — e.g. an external event mid-wait); a
 * degraded-but-reshaping array CONTINUES, with one 'error' notification for
 * the §8 combined-risk state.
 */
async function waitForArrayIdle(executor: CommandExecutor, ctx: WaitContext): Promise<void> {
  let lastDecile = -1
  for (;;) {
    const text = await execChecked(executor, CAT, MDSTAT_CAT_ARGS)
    const md = parseMdstat(text).find(a => a.kernelName === ctx.kernelName)
    if (!md)
      throw new Error(`array ${ctx.label} (${ctx.kernelName}) disappeared from /proc/mdstat during the wait`)
    if (!md.active) {
      throw new Error(
        `array ${ctx.label} went INACTIVE during the wait (all members demoted to spares — the GT-8 `
        + `post-interruption state). The daemon's boot recovery ladder (mdadm --run, then --readwrite) `
        + `restores it; Resume the expansion afterwards.`,
      )
    }
    const degraded = (md.raidDevices !== null && md.activeDevices !== null && md.activeDevices < md.raidDevices)
      || md.members.some(m => m.faulty)
    if (degraded && md.sync && !ctx.degradedNotified.has(ctx.kernelName)) {
      ctx.degradedNotified.add(ctx.kernelName)
      await pveNotify(
        executor,
        'error',
        `AHR: disk failed during reshape (${ctx.poolName})`,
        `Array ${ctx.label} is degraded while its ${md.sync.action} continues — the combined-risk state (§8): `
        + `md will finish the operation degraded, but a second disk failure now means data loss. `
        + `Do not remove any disk; replace the failed one as soon as the operation completes.`,
      )
    }
    if (md.sync) {
      const pct = md.sync.percent
      const speed = md.sync.speedKibPerSec !== null ? `${(md.sync.speedKibPerSec / 1024).toFixed(1)} MiB/s` : 'speed n/a'
      const eta = md.sync.finishMinutes !== null ? `ETA ${Math.ceil(md.sync.finishMinutes)} min` : 'ETA n/a'
      ctx.updateProgress(`${md.sync.action} ${ctx.label}: ${pct.toFixed(1)}% (${speed}, ${eta})${degraded ? ' — DEGRADED' : ''}`)
      const decile = Math.floor(pct / 10)
      if (decile > lastDecile) {
        lastDecile = decile
        ctx.log(`ahr.expand pool=${ctx.poolName} step=reshape-wait target=${ctx.label} progress=${pct.toFixed(1)}%`)
      }
      await sleep(ctx.pollIntervalMs)
      continue
    }
    if (md.syncDelayed || md.syncPending) {
      ctx.updateProgress(`${ctx.label}: sync queued behind another array`)
      await sleep(ctx.pollIntervalMs)
      continue
    }
    return
  }
}

// ---- The step executor ------------------------------------------------------

interface StepContext {
  executor: CommandExecutor
  pool: AhrPool
  intent: AhrExpansionIntent
  plan: AhrExpansionPlan
  updateProgress: (message: string) => void
  log: (line: string) => void
  pollIntervalMs: number
  degradedNotified: Set<string>
}

/** Parse a `md/<pool>-r<band>` step target, verifying the pool matches. */
function bandFromTarget(target: string, poolName: string): { band: number, previewLabel: string } {
  const m = target.match(MD_TARGET_RE)
  if (!m || m[1] !== poolName)
    throw new Error(`step target '${target}' does not belong to pool '${poolName}'`)
  return { band: Number.parseInt(m[2], 10), previewLabel: `${poolName}-r${m[2]}` }
}

function previewBand(ctx: StepContext, band: number): AhrPreviewBand {
  const pb = ctx.plan.preview.bands.find(b => b.band === band)
  if (!pb)
    throw new Error(`plan preview has no band ${band} — plan and step list disagree (planner bug)`)
  return pb
}

/** Pool hot spares whose §2.5-rounded usable size reaches this band's top edge. */
function bandCoveringSpares(pool: AhrPool, pb: AhrPreviewBand): AhrPool['disks'] {
  return pool.disks.filter(d => d.role === 'spare' && d.usableBytes >= pb.range.endBytes)
}

/**
 * Detach the pool's hot-spare slices from a band array BEFORE a --grow /
 * --convert reshape (§11, the spare-absorption guard): with BOTH the newly
 * added member slice and a hot-spare slice sitting as spares, md's reshape may
 * absorb the HOT SPARE into the new raid slot instead of the intended new
 * slice — silently converting the spare disk into a data member while the new
 * disk stays spare. Removing the spare slices first (a spare `--remove` is
 * instant and safe) leaves ONLY the intended new slice as a spare, so md fills
 * the new slot deterministically. Idempotent: a spare slice that is not
 * currently a member of this band is skipped (resume path).
 */
async function detachBandSpares(
  executor: CommandExecutor,
  poolName: string,
  band: number,
  resolved: ResolvedArray,
  spares: AhrPool['disks'],
): Promise<void> {
  const memberKernels = new Set(resolved.md.members.map(m => m.device))
  for (const s of spares) {
    const disk = await readDiskTree(executor, byIdPath(s.id))
    const part = disk?.parts.find(p => p.partlabel !== null && bandLabelRe(poolName, band).test(p.partlabel))
    if (!disk || !part || part.number === null || !memberKernels.has(part.name))
      continue
    await execChecked(executor, MDADM, [resolved.dev, '--remove', partByIdPath(s.id, part.number)])
  }
}

/**
 * Re-attach the pool's hot-spare slices to a band after a grow/convert — or
 * confirm coverage on the no-op/resume path — so a spare NEVER silently loses
 * coverage (§11). Best-effort: a transient refusal (e.g. mid-reshape) only
 * logs; the next run re-ensures. `addSpareSlice` is idempotent (an
 * already-attached slice is skipped).
 */
async function ensureBandSpares(
  ctx: StepContext,
  band: number,
  arrayDev: string,
  spares: AhrPool['disks'],
  memberKernels: ReadonlySet<string>,
): Promise<void> {
  for (const s of spares) {
    try {
      if (await addSpareSlice(ctx.executor, ctx.pool.name, s.id, band, arrayDev, memberKernels))
        ctx.log(`ahr.expand pool=${ctx.pool.name} band=${band} spare=${s.id} status=re-attached`)
    }
    catch (err) {
      ctx.log(`ahr.expand pool=${ctx.pool.name} band=${band} spare=${s.id} warn=reattach-failed detail=${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** Run one step. Returns true when the step was a detected no-op. */
async function runStep(ctx: StepContext, step: AhrExpansionStep): Promise<boolean> {
  const { executor, pool } = ctx
  switch (step.kind) {
    case 'partition': {
      const { created } = await ensureDiskPartitions(executor, pool.name, step.target, ctx.plan.preview.bands)
      return created === 0
    }

    case 'array-grow': {
      const { band } = bandFromTarget(step.target, pool.name)
      const pb = previewBand(ctx, band)
      const arrays = await resolveAhrArrays(executor, pool.name)
      const resolved = arrays.get(band)
      if (!resolved)
        throw new Error(`array ${pool.name}-r${band} not found — cannot grow an array that does not exist`)
      const spares = bandCoveringSpares(pool, pb)
      const current = new Set(resolved.md.members.map(m => m.device))
      const members = await expectedBandMembers(executor, pool.name, pb, ctx.intent.approvedDisks)
      const toAdd = members.filter(m => !current.has(m.partKernel))
      const raidDevices = resolved.detail.devices ?? resolved.md.raidDevices ?? 0
      if (toAdd.length === 0 && raidDevices >= pb.memberCount) {
        // Already grown — still ensure the hot spares cover this band (a resume
        // that landed after the grow must not leave coverage dropped).
        await ensureBandSpares(ctx, band, resolved.dev, spares, current)
        return true
      }
      for (const m of toAdd)
        await execChecked(executor, MDADM, [resolved.dev, '--add', m.partByIdPath])
      if (raidDevices < pb.memberCount) {
        // §11 spare-absorption guard: pull the hot-spare slices out of THIS band
        // first so md cannot absorb a spare into the new raid slot; grow with
        // only the intended new slice present as a spare, then re-attach.
        await detachBandSpares(executor, pool.name, band, resolved, spares)
        // NO --backup-file, ever (§5.1/GT-6): offsets carry the critical section.
        await execChecked(executor, MDADM, ['--grow', resolved.dev, `--raid-devices=${pb.memberCount}`])
        const post = (await resolveAhrArrays(executor, pool.name)).get(band)
        if (post)
          await ensureBandSpares(ctx, band, post.dev, spares, new Set(post.md.members.map(m => m.device)))
      }
      return false
    }

    case 'array-convert': {
      const { band } = bandFromTarget(step.target, pool.name)
      const pb = previewBand(ctx, band)
      if (pb.level === null)
        throw new Error(`plan preview band ${band} has no level for array-convert (planner bug)`)
      const arrays = await resolveAhrArrays(executor, pool.name)
      const resolved = arrays.get(band)
      if (!resolved)
        throw new Error(`array ${pool.name}-r${band} not found — cannot convert an array that does not exist`)
      const spares = bandCoveringSpares(pool, pb)
      const raidDevices = resolved.detail.devices ?? resolved.md.raidDevices ?? 0
      const level = resolved.detail.level ?? resolved.md.personality
      if (level === pb.level && raidDevices >= pb.memberCount) {
        // Already converted — still confirm spare coverage (resume path).
        await ensureBandSpares(ctx, band, resolved.dev, spares, new Set(resolved.md.members.map(m => m.device)))
        return true
      }
      const current = new Set(resolved.md.members.map(m => m.device))
      const members = await expectedBandMembers(executor, pool.name, pb, ctx.intent.approvedDisks)
      for (const m of members.filter(x => !current.has(x.partKernel)))
        await execChecked(executor, MDADM, [resolved.dev, '--add', m.partByIdPath])
      // §11 spare-absorption guard (same as array-grow): a hot spare's slice
      // sits in this band as a spare too; detach before the level/width reshape
      // so md cannot absorb it into a new slot, then re-attach after.
      await detachBandSpares(executor, pool.name, band, resolved, spares)
      if (level !== pb.level) {
        // One-shot level+count change (GT-7); offset-based, NO --backup-file.
        await execChecked(executor, MDADM, ['--grow', resolved.dev, `--level=${levelNumber(pb.level)}`, `--raid-devices=${pb.memberCount}`])
      }
      else {
        await execChecked(executor, MDADM, ['--grow', resolved.dev, `--raid-devices=${pb.memberCount}`])
      }
      const post = (await resolveAhrArrays(executor, pool.name)).get(band)
      if (post)
        await ensureBandSpares(ctx, band, post.dev, spares, new Set(post.md.members.map(m => m.device)))
      return false
    }

    case 'array-create': {
      const { band } = bandFromTarget(step.target, pool.name)
      const pb = previewBand(ctx, band)
      if (pb.level === null)
        throw new Error(`plan preview band ${band} has no level for array-create (planner bug)`)
      const before = await resolveAhrArrays(executor, pool.name)
      let resolved = before.get(band)
      const created = !resolved
      if (!resolved) {
        const members = await expectedBandMembers(executor, pool.name, pb, ctx.intent.approvedDisks)
        if (members.length !== pb.memberCount)
          throw new Error(`band ${band} expects ${pb.memberCount} member slices but ${members.length} are present`)
        const name = `${pool.name}-r${band}`
        await execChecked(executor, MDADM, [
          '--create',
          `/dev/md/${name}`,
          '--run',
          `--level=${levelNumber(pb.level)}`,
          `--raid-devices=${pb.memberCount}`,
          '--metadata=1.2',
          `--name=${name}`,
          // Explicit generous data offset (§2.6/GT-5) — the reshape headroom that
          // keeps every future grow backup-file-free.
          ahrDataOffsetArg(pb.heightBytes),
          // Explicit write-intent bitmap (see ahr-create.ts): fast differential
          // re-add for transiently-offline members, never an implicit default.
          '--bitmap=internal',
          ...members.map(m => m.partByIdPath),
        ])
        // Pin the new array + refresh the initramfs copy (§2.6). Best-effort:
        // pinning is boot-name determinism, not data safety — a failure is
        // logged loudly but never halts a data-layer-complete step.
        try {
          const after = await resolveAhrArrays(executor, pool.name)
          resolved = after.get(band)
          const uuid = resolved?.detail.uuid
          if (uuid) {
            await pinArrays([{ name, uuid }])
            const r = await executor.exec(UPDATE_INITRAMFS, ['-u'])
            if (r.exitCode !== 0)
              ctx.log(`ahr.expand pool=${pool.name} warn=update-initramfs-failed detail=${r.stderr.trim()}`)
          }
          else {
            ctx.log(`ahr.expand pool=${pool.name} warn=pin-skipped detail=no-uuid-for-${name}`)
          }
        }
        catch (err) {
          ctx.log(`ahr.expand pool=${pool.name} warn=pin-failed detail=${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // §11 expansion coupling: a new band automatically extends every attached
      // spare that can reach its boundary — partition the new slice, then
      // --add-spare. Evaluated on EVERY run (the already-created resume path
      // must not skip it): a spare never silently loses coverage. Spares that
      // cannot cover the taller band were already named in the plan warnings.
      const spares = pool.disks.filter(d => d.role === 'spare' && d.usableBytes >= pb.range.endBytes)
      let extended = 0
      if (spares.length > 0) {
        if (!resolved)
          resolved = (await resolveAhrArrays(executor, pool.name)).get(band)
        if (!resolved)
          throw new Error(`array ${pool.name}-r${band} not found after create — cannot extend the pool's hot spares onto it`)
        const memberKernels = new Set(resolved.md.members.map(m => m.device))
        for (const s of spares) {
          ctx.updateProgress(`extending hot spare ${s.id} to band ${band}`)
          await ensureDiskPartitions(executor, pool.name, s.id, ctx.plan.preview.bands)
          if (await addSpareSlice(executor, pool.name, s.id, band, resolved.dev, memberKernels)) {
            extended++
            ctx.log(`ahr.expand pool=${pool.name} step=array-create target=${step.target} spare=${s.id} status=extended`)
          }
        }
      }
      return !created && extended === 0
    }

    case 'reshape-wait': {
      const { band } = bandFromTarget(step.target, pool.name)
      const arrays = await resolveAhrArrays(executor, pool.name)
      const resolved = arrays.get(band)
      if (!resolved)
        throw new Error(`array ${pool.name}-r${band} not found for reshape-wait`)
      await waitForArrayIdle(executor, {
        poolName: pool.name,
        label: `${pool.name}-r${band}`,
        kernelName: resolved.kernelName,
        pollIntervalMs: ctx.pollIntervalMs,
        updateProgress: ctx.updateProgress,
        log: ctx.log,
        degradedNotified: ctx.degradedNotified,
      })
      return false
    }

    case 'pv-create': {
      const { band } = bandFromTarget(step.target, pool.name)
      const arrays = await resolveAhrArrays(executor, pool.name)
      const resolved = arrays.get(band)
      if (!resolved)
        throw new Error(`array ${pool.name}-r${band} not found for pv-create`)
      const pvs = parsePvsReport(await execChecked(executor, PVS, PVS_ARGS))
      if (pvs.some(p => p.name === resolved.dev || p.name === `/dev/md/${pool.name}-r${band}`))
        return true
      await execChecked(executor, PVCREATE, [resolved.dev])
      return false
    }

    case 'pv-resize': {
      const { band } = bandFromTarget(step.target, pool.name)
      const arrays = await resolveAhrArrays(executor, pool.name)
      const resolved = arrays.get(band)
      if (!resolved)
        throw new Error(`array ${pool.name}-r${band} not found for pv-resize`)
      const pvs = parsePvsReport(await execChecked(executor, PVS, PVS_ARGS))
      const pv = pvs.find(p => p.name === resolved.dev || p.name === `/dev/md/${pool.name}-r${band}`)
      if (!pv)
        throw new Error(`PV for array ${pool.name}-r${band} not found — the pool's LVM layer is inconsistent`)
      const arrayBytes = (resolved.md.blocks ?? 0) * 1024
      if (arrayBytes > 0 && pv.sizeBytes >= arrayBytes - LVM_SLACK_BYTES)
        return true // already resized
      await execChecked(executor, PVRESIZE, [resolved.dev])
      return false
    }

    case 'vg-extend': {
      // The PVs to add are exactly the plan's pv-create targets (planner-owned).
      const createBands = ctx.plan.steps
        .filter(s => s.kind === 'pv-create')
        .map(s => bandFromTarget(s.target, pool.name).band)
      const arrays = await resolveAhrArrays(executor, pool.name)
      const pvs = parsePvsReport(await execChecked(executor, PVS, PVS_ARGS))
      const toAdd: string[] = []
      for (const band of createBands) {
        const resolved = arrays.get(band)
        if (!resolved)
          throw new Error(`array ${pool.name}-r${band} not found for vg-extend`)
        const pv = pvs.find(p => p.name === resolved.dev || p.name === `/dev/md/${pool.name}-r${band}`)
        if (!pv)
          throw new Error(`PV for array ${pool.name}-r${band} not found — pv-create did not complete`)
        if (pv.vgName !== pool.name)
          toAdd.push(resolved.dev)
      }
      if (toAdd.length === 0)
        return true
      await execChecked(executor, VGEXTEND, [pool.name, ...toAdd])
      return false
    }

    case 'lv-extend': {
      const vgs = parseVgsReport(await execChecked(executor, VGS, VGS_ARGS))
      const vg = vgs.find(v => v.name === pool.name)
      if (!vg)
        throw new Error(`volume group '${pool.name}' not found — cannot extend its LV`)
      if (vg.freeBytes < VG_FREE_EPSILON_BYTES)
        return true // nothing left to extend into — already done
      await execChecked(executor, LVEXTEND, ['-l', '+100%FREE', `/dev/${pool.name}/${pool.lv.name}`])
      return false
    }

    case 'fs-grow': {
      // LAST, and only after the LV beneath it is VERIFIED extended (§5.1).
      const vgs = parseVgsReport(await execChecked(executor, VGS, VGS_ARGS))
      const vg = vgs.find(v => v.name === pool.name)
      if (!vg)
        throw new Error(`volume group '${pool.name}' not found — refusing to grow the filesystem`)
      if (vg.freeBytes >= VG_FREE_EPSILON_BYTES)
        throw new Error(`lv-extend is not complete (VG '${pool.name}' still has ${fmtBytes(vg.freeBytes)} free) — refusing to grow the filesystem before its block device`)
      const lvs = parseLvsReport(await execChecked(executor, LVS, LVS_ARGS))
      const lv = lvs.find(l => l.vgName === pool.name && l.name === pool.lv.name)
      if (!lv)
        throw new Error(`logical volume '${pool.name}/${pool.lv.name}' not found — refusing to grow the filesystem`)
      const mapperPath = `/dev/mapper/${dmName(pool.name, pool.lv.name)}`
      const mounts = parseFindmnt(await execChecked(executor, FINDMNT, AHR_FINDMNT_ARGS))
      // findmnt appends the mounted subvolume to a btrfs source
      // (`…-vol[/@data]`) — strip it before matching, else EVERY §12
      // subvol-layout pool's fs-grow halts here (the same class of bug fixed in
      // ahr-topology.ts; shared helper, never a raw `source === mapperPath`).
      const mount = mounts.find(m => stripSubvolSuffix(m.source) === mapperPath)
      if (!mount)
        throw new Error(`pool '${pool.name}' filesystem is not mounted — btrfs can only be resized mounted`)
      const usageRes = await executor.exec(BTRFS, btrfsUsageArgs(mount.target))
      if (usageRes.exitCode === 0) {
        const usage = parseBtrfsUsage(usageRes.stdout)
        if (usage.deviceSizeBytes !== null && usage.deviceSizeBytes >= lv.sizeBytes - LVM_SLACK_BYTES)
          return true // filesystem already fills the LV
      }
      await execChecked(executor, BTRFS, ['filesystem', 'resize', 'max', mount.target])
      return false
    }

    default:
      throw new Error(`unknown step kind '${step.kind as string}'`)
  }
}

/** dm name of `<vg>-<lv>` (device-mapper escapes `-` as `--`). */
function dmName(vg: string, lv: string): string {
  return `${vg.replaceAll('-', '--')}-${lv.replaceAll('-', '--')}`
}

/** Halt bookkeeping shared by the expansion and replace drivers. */
async function haltWithFailure(
  executor: CommandExecutor,
  input: ExpansionInput,
  intentDir: string,
  layer: string,
  message: string,
): Promise<void> {
  await writeIntent(input.pool.name, { ...input.intent, state: 'halted' }, { dir: intentDir })
  await pveNotify(
    executor,
    'error',
    `AHR expansion halted: ${input.pool.name}`,
    `${layer} failed: ${message} — the pool remains at its current (usable) layout. `
    + `Fix the cause and Resume (recompute-and-continue), or Abandon the expansion.`,
  )
}

/**
 * Drive an expansion plan to completion (§5.1). Steps run strictly in the
 * planner's order; each is detect-then-delta. On the first failure the
 * pipeline halts: intent → 'halted', PVE 'error' notification naming the
 * failed layer, outcome returned (the job layer decides how to surface it).
 * On completion the intent is CLEARED and an 'info' notification carries the
 * before → after capacity.
 */
export async function executeExpansion(
  executor: CommandExecutor,
  input: ExpansionInput,
  updateProgress: (message: string) => void,
  opts: ExpansionOptions = {},
): Promise<ExpansionOutcome> {
  const intentDir = opts.intentDir ?? defaultAhrIntentDir()
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const ctx: StepContext = {
    executor,
    pool: input.pool,
    intent: input.intent,
    plan: input.plan,
    updateProgress,
    log,
    pollIntervalMs: opts.pollIntervalMs ?? 3000,
    degradedNotified: new Set(),
  }

  const steps = input.plan.steps.map(s => ({ ...s }))
  for (const step of steps) {
    step.status = 'running'
    log(`ahr.expand pool=${input.pool.name} step=${step.kind} target=${step.target} status=running`)
    updateProgress(`${step.kind}: ${step.target}`)
    try {
      const skipped = await runStep(ctx, step)
      step.status = 'done'
      log(`ahr.expand pool=${input.pool.name} step=${step.kind} target=${step.target} status=done${skipped ? ' (already done)' : ''}`)
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      step.status = 'failed'
      step.detail = message
      log(`ahr.expand pool=${input.pool.name} step=${step.kind} target=${step.target} status=failed error=${message}`)
      await haltWithFailure(executor, input, intentDir, `step '${step.kind}' (${step.target})`, message)
      return { ok: false, steps, failedStep: step, error: message }
    }
  }

  await clearIntent(input.pool.name, intentDir)
  const { before, after } = input.intent
  const pendingDelta = after.pendingBytes - before.pendingBytes
  await pveNotify(
    executor,
    'info',
    `AHR expansion complete: ${input.pool.name}`,
    `Usable capacity ${fmtBytes(before.usableBytes)} → ${fmtBytes(after.usableBytes)}.${
      pendingDelta > 0
        ? ` ${fmtBytes(after.pendingBytes)} is pending — physically present but locked until more disks cross the top band boundary (§5.2).`
        : ''}`,
  )
  log(`ahr.expand pool=${input.pool.name} status=complete usable=${before.usableBytes}->${after.usableBytes}`)
  return { ok: true, steps }
}

// ---- Guided replace ---------------------------------------------------------

export interface ReplaceInput extends ExpansionInput {
  oldDiskId: string
  newDiskId: string
}

/**
 * The guided single-disk replace (§5.1): partition the incoming disk, then per
 * band the outgoing disk serves — SEQUENTIALLY, bands share the one incoming
 * spindle (GT-10) — `mdadm --add` the new slice and `mdadm --replace --with`
 * (the outgoing member stays in-array during the copy: no degraded window).
 * A band whose outgoing member is already faulty/absent gets a plain `--add`
 * (rebuild) — `--replace` needs a live source; fail-then-rebuild is only ever
 * for disks that are already dead. After the swaps, any residual expansion
 * plan steps (new bands the replacement unlocks) run through
 * {@link executeExpansion}, which owns intent completion. Finally the outgoing
 * disk's superblocks are zeroed and its GPT zapped — ONLY when it is still
 * present and was healthy; a dead disk is left alone. Bands keep their names:
 * nothing is unpinned.
 */
export async function executeReplace(
  executor: CommandExecutor,
  input: ReplaceInput,
  updateProgress: (message: string) => void,
  opts: ExpansionOptions = {},
): Promise<ExpansionOutcome> {
  const intentDir = opts.intentDir ?? defaultAhrIntentDir()
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const pollIntervalMs = opts.pollIntervalMs ?? 3000
  const { pool, oldDiskId, newDiskId } = input

  const oldBands = pool.arrays
    .filter(a => a.members.some(m => m.disk === oldDiskId))
    .map(a => a.band)
    .sort((a, b) => a - b)
  const oldWasHealthy = pool.arrays.every(a =>
    a.members.every(m => m.disk !== oldDiskId || m.memberState === 'in_sync'),
  )

  try {
    // Phase 1 — partition the incoming disk for every band it will serve.
    updateProgress(`partitioning ${newDiskId}`)
    log(`ahr.replace pool=${pool.name} phase=partition disk=${newDiskId}`)
    await ensureDiskPartitions(executor, pool.name, newDiskId, input.plan.preview.bands)
    const newDisk = await readDiskTree(executor, byIdPath(newDiskId))
    if (!newDisk)
      throw new Error(`replacement disk '${newDiskId}' is not present`)

    // Phase 2 — swap band by band, sequentially (one spindle, GT-10).
    for (const band of oldBands) {
      const arrays = await resolveAhrArrays(executor, pool.name)
      const resolved = arrays.get(band)
      if (!resolved)
        throw new Error(`array ${pool.name}-r${band} not found for replace`)
      const label = `${pool.name}-r${band}`

      const newPart = newDisk.parts.find(p => p.partlabel !== null && bandLabelRe(pool.name, band).test(p.partlabel))
      if (!newPart || newPart.number === null)
        throw new Error(`replacement disk '${newDiskId}' has no partition for band ${band}`)
      const newPartPath = partByIdPath(newDiskId, newPart.number)

      const oldDisk = await readDiskTree(executor, byIdPath(oldDiskId))
      const oldPart = oldDisk?.parts.find(p => p.partlabel !== null && bandLabelRe(pool.name, band).test(p.partlabel))
      const oldMember = oldPart ? resolved.md.members.find(m => m.device === oldPart.name) : undefined
      const newAlreadyMember = resolved.md.members.some(m => m.device === newPart.name)

      if (!oldMember && newAlreadyMember) {
        log(`ahr.replace pool=${pool.name} band=${band} status=already-swapped`)
        continue // this band's swap already completed (resume path)
      }

      if (!newAlreadyMember)
        await execChecked(executor, MDADM, [resolved.dev, '--add', newPartPath])

      if (oldMember && !oldMember.faulty && oldPart) {
        // Live outgoing member: copy without ever dropping redundancy.
        updateProgress(`replacing ${oldDiskId} in ${label} (live copy, no degraded window)`)
        await execChecked(executor, MDADM, [resolved.dev, '--replace', `/dev/${oldPart.name}`, '--with', newPartPath])
      }
      else {
        // Dead/absent outgoing member: the --add above already starts the
        // rebuild into the new slice (the band was degraded).
        updateProgress(`rebuilding ${label} onto ${newDiskId}`)
      }

      await waitForReplaceDone(executor, {
        kernelName: resolved.kernelName,
        label,
        oldPartKernel: oldPart?.name ?? null,
        pollIntervalMs,
        updateProgress,
        log,
        poolName: pool.name,
      })

      // The outgoing member is marked faulty once the copy lands — detach it.
      if (oldPart) {
        const post = await resolveAhrArrays(executor, pool.name)
        const still = post.get(band)?.md.members.find(m => m.device === oldPart.name)
        if (still) {
          const r = await executor.exec(MDADM, [resolved.dev, '--remove', `/dev/${oldPart.name}`])
          if (r.exitCode !== 0)
            log(`ahr.replace pool=${pool.name} band=${band} warn=remove-failed detail=${r.stderr.trim()}`)
        }
      }
      log(`ahr.replace pool=${pool.name} band=${band} status=swapped`)
    }
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`ahr.replace pool=${pool.name} status=failed error=${message}`)
    await haltWithFailure(executor, input, intentDir, `disk replace (${oldDiskId} → ${newDiskId})`, message)
    return { ok: false, steps: input.plan.steps.map(s => ({ ...s })), error: message }
  }

  // Phase 3 — residual expansion steps (new bands the replacement unlocked).
  // executeExpansion owns intent completion/halting and the final notification.
  const outcome = await executeExpansion(executor, input, updateProgress, opts)
  if (!outcome.ok)
    return outcome

  // Phase 4 — retire the outgoing disk, ONLY if still present and healthy.
  // Best-effort: the replace has fully succeeded; cleanup failure only logs.
  if (oldWasHealthy) {
    try {
      const oldDisk = await readDiskTree(executor, byIdPath(oldDiskId))
      if (oldDisk) {
        updateProgress(`retiring ${oldDiskId} (zero superblocks, zap GPT)`)
        for (const part of oldDisk.parts) {
          if (part.number !== null && part.partlabel !== null && dNumberRe(pool.name).test(part.partlabel))
            await executor.exec(MDADM, ['--zero-superblock', partByIdPath(oldDiskId, part.number)])
        }
        await executor.exec(SGDISK, ['--zap-all', byIdPath(oldDiskId)])
        log(`ahr.replace pool=${pool.name} disk=${oldDiskId} status=retired`)
      }
      else {
        log(`ahr.replace pool=${pool.name} disk=${oldDiskId} status=absent-left-alone`)
      }
    }
    catch (err) {
      log(`ahr.replace pool=${pool.name} warn=retire-failed detail=${err instanceof Error ? err.message : String(err)}`)
    }
  }
  else {
    log(`ahr.replace pool=${pool.name} disk=${oldDiskId} status=dead-left-alone`)
  }
  return outcome
}

interface ReplaceWaitContext {
  poolName: string
  label: string
  kernelName: string
  /** The outgoing member's kernel partition name, when the disk is present. */
  oldPartKernel: string | null
  pollIntervalMs: number
  updateProgress: (message: string) => void
  log: (line: string) => void
}

/**
 * Wait for one band's replace/rebuild copy to finish: the sync thread idle
 * AND the outgoing member (when present) no longer a healthy in-array member.
 * Observation only — like every wait, it never issues md commands.
 */
async function waitForReplaceDone(executor: CommandExecutor, ctx: ReplaceWaitContext): Promise<void> {
  for (;;) {
    const text = await execChecked(executor, CAT, MDSTAT_CAT_ARGS)
    const md = parseMdstat(text).find(a => a.kernelName === ctx.kernelName)
    if (!md)
      throw new Error(`array ${ctx.label} (${ctx.kernelName}) disappeared from /proc/mdstat during the replace`)
    if (!md.active)
      throw new Error(`array ${ctx.label} went INACTIVE during the replace — daemon boot recovery (GT-8 ladder) is required before resuming`)
    if (md.sync) {
      const speed = md.sync.speedKibPerSec !== null ? `${(md.sync.speedKibPerSec / 1024).toFixed(1)} MiB/s` : 'speed n/a'
      const eta = md.sync.finishMinutes !== null ? `ETA ${Math.ceil(md.sync.finishMinutes)} min` : 'ETA n/a'
      ctx.updateProgress(`${md.sync.action} ${ctx.label}: ${md.sync.percent.toFixed(1)}% (${speed}, ${eta})`)
      await sleep(ctx.pollIntervalMs)
      continue
    }
    if (md.syncDelayed || md.syncPending) {
      ctx.updateProgress(`${ctx.label}: copy queued behind another array`)
      await sleep(ctx.pollIntervalMs)
      continue
    }
    const oldEntry = ctx.oldPartKernel ? md.members.find(m => m.device === ctx.oldPartKernel) : undefined
    if (oldEntry && !oldEntry.faulty) {
      // want-replacement set but the copy has not started/landed yet.
      await sleep(ctx.pollIntervalMs)
      continue
    }
    return
  }
}

// ---- Re-add (story 11.9: the returned-disk verb) ---------------------------

export interface ReaddBandResult {
  band: number
  /** 'differential' = --re-add rode the write-intent bitmap; 'full' = rebuild. */
  mode: 'differential' | 'full'
}

/**
 * Guided re-add of a disk that fell offline and came back (11.9, §8). For
 * every partition on the disk whose label matches this pool AND whose md
 * superblock UUID matches the band's array (the identity check — a lookalike
 * slice from some other life is refused, never absorbed):
 *
 *   remove the faulty slot if still attached → `mdadm --re-add` (with the
 *   §2.6 write-intent bitmap this is a differential catch-up — md's resilver
 *   analog) → on refusal, fall back to a FULL member rebuild
 *   (--zero-superblock + --add) → wait each recovery out sequentially.
 *
 * Throws when the device is absent or no slice qualifies — the route turns
 * that into a 400 naming the reason.
 */
export async function executeReadd(
  executor: CommandExecutor,
  input: { pool: AhrPool, diskId: string },
  updateProgress: (message: string) => void,
  opts: { pollIntervalMs?: number, log?: (line: string) => void } = {},
): Promise<{ bands: ReaddBandResult[] }> {
  const { pool, diskId } = input
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const pollIntervalMs = opts.pollIntervalMs ?? 3000

  const disk = await readDiskTree(executor, byIdPath(diskId))
  if (!disk)
    throw new Error(`disk '${diskId}' is not present — re-add needs the returned device attached`)

  const arrays = await resolveAhrArrays(executor, pool.name)
  const candidates: { band: number, array: ResolvedArray, partPath: string, partKernel: string }[] = []
  const rejects: string[] = []
  for (const [band, array] of [...arrays.entries()].sort((a, b) => a[0] - b[0])) {
    const part = disk.parts.find(p => p.partlabel !== null && bandLabelRe(pool.name, band).test(p.partlabel))
    if (!part)
      continue
    // Already an active in-sync member? Nothing to do for this band.
    const member = array.md.members.find(m => m.device === part.name)
    if (member && !member.faulty)
      continue
    const partPath = `${byIdPath(diskId)}-part${part.number}`
    // Identity check: the slice's superblock must belong to THIS band array.
    const exam = await executor.exec(MDADM, ['--examine', '--export', partPath])
    const examUuid = exam.exitCode === 0 ? parseMdadmDetailExport(exam.stdout).uuid : null
    if (examUuid !== array.detail.uuid) {
      rejects.push(`band ${band}: slice superblock ${examUuid ?? '(none)'} does not match array ${array.detail.uuid ?? '(unknown)'}`)
      continue
    }
    candidates.push({ band, array, partPath, partKernel: part.name })
  }
  if (candidates.length === 0) {
    throw new Error(
      `disk '${diskId}' has no re-addable slice for pool '${pool.name}'`
      + (rejects.length ? ` — ${rejects.join('; ')}` : ' — no matching band partitions found'),
    )
  }

  const results: ReaddBandResult[] = []
  const degradedNotified = new Set<string>()
  for (const c of candidates) {
    const label = `${pool.name}-r${c.band}`
    // Clear the stale faulty slot so `--re-add` is ACCEPTED — identified by
    // what the slot IS, not what the returning disk is called now:
    //  - the returning partition itself, if still listed faulty (the disk came
    //    back under the SAME kernel name, e.g. after a reboot);
    //  - any faulty member whose device node is now ABSENT (detached) — the
    //    reboot-less return re-enumerates under a NEW name, so the array's
    //    faulty slot names the OLD (gone) node and a name match misses it.
    // Without this, the stale slot lingers, `--re-add` is refused, and 11.9's
    // differential catch-up silently degrades to a full rebuild.
    if (c.array.md.members.some(m => m.device === c.partKernel && m.faulty)) {
      // Same-name return (e.g. after a reboot): the faulty slot IS this exact
      // partition — remove it by path.
      updateProgress(`removing faulty slot ${c.partKernel} from ${label}`)
      await executor.exec(MDADM, [c.array.dev, '--remove', c.partPath])
    }
    else if (await removeDetachedFaultySlots(executor, c.array.dev, c.array.md.members)) {
      // Reboot-less return: the disk re-enumerated under a NEW name, so the
      // array's faulty slot names the OLD (now-absent) node — cleared as
      // detached so the following `--re-add` is accepted.
      updateProgress(`removed detached faulty slot(s) from ${label}`)
    }

    updateProgress(`re-adding ${c.partPath} to ${label}`)
    log(`ahr.readd pool=${pool.name} band=${c.band} part=${c.partPath} attempt=re-add`)
    const readd = await executor.exec(MDADM, [c.array.dev, '--re-add', c.partPath])
    let mode: ReaddBandResult['mode'] = 'differential'
    if (readd.exitCode !== 0) {
      // md refused the shortcut (no bitmap coverage / stale event count):
      // full rebuild as a brand-new member — stated in the confirm upfront.
      mode = 'full'
      updateProgress(`--re-add refused for ${label} (${readd.stderr.trim() || 'no reason given'}) — full rebuild`)
      log(`ahr.readd pool=${pool.name} band=${c.band} fallback=full-rebuild`)
      await execChecked(executor, MDADM, ['--zero-superblock', c.partPath])
      await execChecked(executor, MDADM, [c.array.dev, '--add', c.partPath])
    }

    await waitForArrayIdle(executor, {
      poolName: pool.name,
      label,
      kernelName: c.array.kernelName,
      pollIntervalMs,
      updateProgress,
      log,
      degradedNotified,
    })
    results.push({ band: c.band, mode })
  }

  await pveNotify(
    executor,
    'info',
    `AHR: disk re-added (${pool.name})`,
    `Disk ${diskId} rejoined pool '${pool.name}': `
    + results.map(r => `band ${r.band} (${r.mode === 'differential' ? 'differential catch-up' : 'full rebuild'})`).join(', ')
    + '. Redundancy is restored.',
  )
  return { bands: results }
}
