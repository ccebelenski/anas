import type { AhrPool } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { LvmLv, LvmPv } from '../parsers/lvm-report.js'
import { parseDiskByIdListing } from '../parsers/disk-by-id.js'
import { lvIsCacheTarget, parseLvsReport, parsePvsReport, PVS_ARGS } from '../parsers/lvm-report.js'
import {
  cacheLvName,
  cachePartitionLabel,
  cacheRecoveryNotification,
  isMdPvName,
  matchCachePartitionLabel,
  rotatingCacheAdvisory,
  SGDISK_LVM_TYPE,
  UNKNOWN_PV_NAME,
} from './ahr-cache-state.js'
import { LVM_MIXED_BLOCK_ARGS, run } from './ahr-exec.js'
import { readDiskTree } from './ahr-expand-exec.js'
import { isAhrMountReadOnly } from './ahr-topology.js'
import { pveNotify } from './pve-notify.js'

/**
 * AHR read cache — the attach/detach executor (story ahrcache.1,
 * AHR-DESIGN §13, GitHub #63).
 *
 * Shape: the pool VG already carries the concatenation layer, so the cache
 * sits where LVM expects it — one GPT slice per cache disk → `pvcreate` →
 * `vgextend <pool>` → one linear `<pool>-cache` LV across those slices →
 * `lvconvert --type cache --cachevol … --cachemode writethrough`. The pool LV
 * keeps its name, its mapper path and its dm number across attach, failure and
 * detach (GT-18), so mounts, shares, LUNs and the fstab line are untouched.
 *
 * Linear, not mirrored, on purpose: a writethrough cache is never the only
 * copy of anything, so redundancy would buy nothing and cost half the flash.
 * For the same reason neither verb is confirm-gated — nothing holding data is
 * destroyed — and `--uncache` is safe to run unattended (dirty blocks are zero
 * by construction).
 *
 * Both verbs are §5.1 detect-then-delta sequences: every step first reads what
 * the system IS and performs only the remaining delta, so a re-run after an
 * interruption is a no-op for work already done, and a failed attach is undone
 * by the detach sequence, which is itself re-runnable.
 *
 * TWO mechanical facts from GT §18 the steps exist to honor:
 *  - `pvcreate` ABORTS non-interactively when the slice carries a stale foreign
 *    signature ("1 existing signature left on the device"), and `vgextend` then
 *    fails with a misleading "not found in Volume Group". Attach therefore
 *    `wipefs -a`s the slice first, exactly as `ahr-create` wipes a member disk.
 *  - detach must DELETE the partition (`sgdisk -d`), not merely `pvremove` +
 *    `wipefs` it: a partition with no filesystem is still a partition, and the
 *    disk keeps reading `other` in /v1/disks instead of `available` (GT-22).
 */

const SGDISK = '/usr/sbin/sgdisk'
const UDEVADM = '/usr/bin/udevadm'
const WIPEFS = '/usr/sbin/wipefs'
const REALPATH = '/usr/bin/realpath'
const LS = '/usr/bin/ls'
const PVCREATE = '/usr/sbin/pvcreate'
const PVREMOVE = '/usr/sbin/pvremove'
const PVS = '/usr/sbin/pvs'
const VGEXTEND = '/usr/sbin/vgextend'
const VGREDUCE = '/usr/sbin/vgreduce'
const LVCREATE = '/usr/sbin/lvcreate'
const LVREMOVE = '/usr/sbin/lvremove'
const LVCONVERT = '/usr/sbin/lvconvert'
const LVS = '/usr/sbin/lvs'
const LSBLK = '/usr/bin/lsblk'

/**
 * The lvm report flags these steps re-read LV state with. The topology
 * reader's LVS_ARGS carry the cache COLUMNS; here only names and attributes
 * are consulted, so the default columns suffice — and the same parser reads
 * both. Deliberately without `-a`: the hidden `_cvol`/`_corig` sub-LVs would
 * make "is there an orphan `<pool>-cache` LV" unanswerable.
 */
const LVS_STATE_ARGS = ['--reportformat', 'json', '--units', 'b', '--nosuffix']

/** lsblk args for the cache-slice sweep: the device tree with partition labels. */
export const AHR_CACHE_LSBLK_ARGS = ['-Jb', '-o', 'NAME,TYPE,SIZE,PARTLABEL']

/** The trailing partition number of a kernel device name (`sdd1` → 1). */
const PART_NUMBER_RE = /(\d+)$/

function byIdPath(diskId: string): string {
  return `/dev/disk/by-id/${diskId}`
}

// ---- Live slice discovery (detach + re-run detection) ----------------------

/** One cache slice of a pool, as it stands on disk right now. */
export interface CacheSlice {
  /** Whole-disk by-id. */
  diskId: string
  /** GPT partition number. */
  partNumber: number
  /** The slice's by-id device path. */
  path: string
  /** The slice's kernel device path, as lvm names it (`/dev/sdd1`). */
  kernelPath: string
  /** Slice ordinal encoded in the label (`<pool>-cache<n>`). */
  ordinal: number
}

/** The first line of a command's stderr, for an error message. */
function stderrHead(stderr: string): string {
  return stderr.trim().split('\n')[0]?.trim() ?? ''
}

/**
 * Every `<pool>-cache<n>` slice the host can currently see, ordinal ascending.
 * Read by LABEL rather than from LVM, because detach must still find a slice
 * after `pvremove` and `wipefs` have erased every trace LVM knew about — which
 * is exactly the state GT-22 caught leaving the disk permanently unusable.
 *
 * THROWS when the read itself fails — `lsblk` exits non-zero or prints
 * something that is not JSON, or the by-id listing cannot be read (every slice
 * is addressed by its by-id path, so without the listing no slice can be
 * named). An empty list is the answer ONLY when the host genuinely shows no
 * slice. The distinction matters because detach drives vgreduce, pvremove,
 * wipefs and sgdisk from this list: a failed read that answered `[]` made the
 * detach skip every cleanup step after `--uncache` and report success with
 * nothing released, leaving the cache PV in the VG as free extents a later
 * expansion would grow the pool onto.
 */
export async function findCacheSlices(executor: CommandExecutor, pool: string): Promise<CacheSlice[]> {
  const [lsblkRes, byIdRes] = await Promise.all([
    executor.exec(LSBLK, AHR_CACHE_LSBLK_ARGS),
    executor.exec(LS, ['-la', '/dev/disk/by-id/']),
  ])
  if (lsblkRes.exitCode !== 0) {
    throw new Error(
      `could not read the block-device tree to find the cache slices of '${pool}': lsblk exited ${lsblkRes.exitCode}`
      + `${stderrHead(lsblkRes.stderr) ? ` (${stderrHead(lsblkRes.stderr)})` : ''}`,
    )
  }
  if (byIdRes.exitCode !== 0) {
    throw new Error(
      `could not read /dev/disk/by-id to name the cache slices of '${pool}': ls exited ${byIdRes.exitCode}`
      + `${stderrHead(byIdRes.stderr) ? ` (${stderrHead(byIdRes.stderr)})` : ''}`,
    )
  }
  const byIdMap = parseDiskByIdListing(byIdRes.stdout)
  interface Node { name?: string, type?: string, partlabel?: string | null, children?: Node[] }
  let root: { blockdevices?: Node[] }
  try {
    root = JSON.parse(lsblkRes.stdout)
  }
  catch {
    throw new Error(
      `could not read the block-device tree to find the cache slices of '${pool}': lsblk printed output that is not JSON`
      + ` (${lsblkRes.stdout.trim().slice(0, 80) || 'empty'})`,
    )
  }
  const slices: CacheSlice[] = []
  for (const disk of root.blockdevices ?? []) {
    if (disk.type !== 'disk' || !disk.name)
      continue
    const diskId = byIdMap.get(disk.name)
    if (diskId === undefined)
      continue
    for (const child of disk.children ?? []) {
      if (child.type !== 'part' || !child.name || !child.partlabel)
        continue
      const ordinal = matchCachePartitionLabel(pool, child.partlabel)
      if (ordinal === null)
        continue
      const num = child.name.match(PART_NUMBER_RE)
      if (!num)
        continue
      const partNumber = Number.parseInt(num[1], 10)
      slices.push({
        diskId,
        partNumber,
        path: `${byIdPath(diskId)}-part${partNumber}`,
        kernelPath: `/dev/${child.name}`,
        ordinal,
      })
    }
  }
  slices.sort((a, b) => a.ordinal - b.ordinal)
  return slices
}

// ---- Shared state reads -----------------------------------------------------

/**
 * Bytes of the PVs that sit on this pool's own cache slices — the cache's
 * size, scoped to what ANAS labelled. "Every non-md PV in the VG" would count a
 * PV an operator added by hand as cache flash.
 */
function cachePvBytes(pvs: LvmPv[], pool: string, sliceDevices: Set<string>): number {
  return pvs
    .filter(p => p.vgName === pool && sliceDevices.has(p.name))
    .reduce((sum, p) => sum + p.sizeBytes, 0)
}

/** Every LV of the pool VG as `lvs` reports it right now. */
async function readVgLvs(executor: CommandExecutor, pool: string): Promise<LvmLv[]> {
  const res = await executor.exec(LVS, LVS_STATE_ARGS)
  if (res.exitCode !== 0)
    throw new Error(`could not read LVM logical volumes: ${res.stderr.trim() || `lvs exited ${res.exitCode}`}`)
  return parseLvsReport(res.stdout).filter(l => l.vgName === pool)
}

/**
 * Every PV `pvs` reports right now. Fail-open would be WRONG here: each step
 * decides its delta from this read, and an empty list reads as "nothing is
 * done yet", which would re-run work that is already complete.
 */
async function readPvs(executor: CommandExecutor): Promise<LvmPv[]> {
  const res = await executor.exec(PVS, PVS_ARGS)
  if (res.exitCode !== 0)
    throw new Error(`could not read LVM physical volumes: ${res.stderr.trim() || `pvs exited ${res.exitCode}`}`)
  return parsePvsReport(res.stdout)
}

// ---- cache-attach -----------------------------------------------------------

/** Structured log sink (default stdout → journald, §7.1). */
export interface CacheOptions {
  log?: (line: string) => void
}

export interface CacheAttachInput {
  pool: AhrPool
  /** Cache disks by-id, in the order the operator picked them. */
  diskIds: string[]
  /**
   * The rotating disks among them, by-id. A rotating cache is LEGAL — this
   * carries the ONE advisory sentence, not an argument (no babysitting).
   */
  rotationalIds?: string[]
}

export interface CacheAttachResult {
  pool: string
  devices: string[]
  sizeBytes: number
  /** Rides out as the job result's `warnings` — the established advisory home. */
  warnings?: string[]
}

/**
 * Attach a writethrough read cache to an existing pool (§13).
 *
 * Per disk: GPT slice by by-id (label `<pool>-cache<n>`, type 8E00) →
 * `udevadm settle` → `wipefs -a` the slice → `pvcreate` → `vgextend`. Then one
 * linear `<pool>-cache` LV across the cache PVs only, and finally the
 * `lvconvert --type cache` that puts it in front of `<pool>-vol`.
 *
 * `sgdisk` + `udevadm settle` is the CREATE path's pair and it is the right one
 * here (GT-21): a cache disk is idle by definition at attach time — nothing
 * holds it, so the kernel's whole-table re-read succeeds and the slice
 * publishes at once. The expansion path's `partx -a` dance answers a holders
 * problem this path does not have.
 */
export async function attachAhrCache(
  executor: CommandExecutor,
  input: CacheAttachInput,
  updateProgress: (message: string) => void,
  opts: CacheOptions = {},
): Promise<CacheAttachResult> {
  const { pool, diskIds } = input
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const lvName = pool.lv.name
  const cacheLv = cacheLvName(pool.name)

  // --- Completion is detected FIRST, before any per-step delta -------------
  // Once `lvconvert` has run, the cache volume becomes the HIDDEN
  // `[<pool>-cache_cvol]`, which `lvs` without `-a` does not list — so the
  // "does the cache volume exist yet" test below would answer no on a fully
  // cached pool and re-issue `lvcreate`. The pool LV's own attribute is the
  // honest completion marker, and it is the first thing read.
  const already = (await readVgLvs(executor, pool.name)).find(l => l.name === lvName)
  if (already && lvIsCacheTarget(already.attr)) {
    updateProgress(`Pool '${pool.name}' already has a read cache`)
    const slices = await findCacheSlices(executor, pool.name)
    const sizeBytes = cachePvBytes(await readPvs(executor), pool.name, new Set(slices.flatMap(s => [s.kernelPath, s.path])))
    // The pool's OWN cache devices, not the ones this request asked for: the
    // cache that is already there may be built on other disks entirely (the
    // route's 409 catches that from the topology read, but a job that reaches
    // here has raced past it), and echoing the request would report the
    // operator's untouched disks as the cache.
    const devices = pool.cache && pool.cache.devices.length > 0 ? pool.cache.devices : diskIds
    return { pool: pool.name, devices, sizeBytes }
  }

  try {
    // --- Per disk: slice → wipe → pvcreate → vgextend ----------------------
    const slicePaths: string[] = []
    const sliceDevices = new Set<string>()
    for (const [i, diskId] of diskIds.entries()) {
      const slice = await ensureCachePv(executor, { pool: pool.name, diskId, ordinal: i + 1, updateProgress, log })
      slicePaths.push(slice.path)
      sliceDevices.add(slice.path).add(slice.kernelPath)
    }

    // --- The cache LV: linear across the cache PVs ONLY ---------------------
    // `-l 100%PVS` with the PVs named (GT-18's exact, proven form): it takes
    // all free extents of THOSE PVs and nothing else, so the cache can never
    // land on a band array. `lvconvert` then splits it into cdata + cmeta.
    if (!(await readVgLvs(executor, pool.name)).some(l => l.name === cacheLv)) {
      updateProgress(`Creating the cache volume '${cacheLv}' (${slicePaths.length} slice${slicePaths.length === 1 ? '' : 's'})`)
      await run(executor, LVCREATE, [...LVM_MIXED_BLOCK_ARGS, '-y', '-n', cacheLv, '-l', '100%PVS', pool.name, ...slicePaths])
      log(`ahr.cache pool=${pool.name} lv=${cacheLv} status=created`)
    }

    // --- Put it in front of the pool volume ---------------------------------
    // `-y` is load-bearing: lvconvert prompts otherwise and a job has no tty
    // (GT-18). Writethrough always — the mode is a parameter nowhere in this
    // product (EPICS §2: writeback and --type writecache are not exposed).
    const poolLv = (await readVgLvs(executor, pool.name)).find(l => l.name === lvName)
    if (!poolLv)
      throw new Error(`logical volume '${pool.name}/${lvName}' not found — refusing to attach a cache to a pool whose volume is missing`)
    if (!lvIsCacheTarget(poolLv.attr)) {
      updateProgress(`Attaching the cache to ${pool.name}/${lvName} (writethrough)`)
      await run(executor, LVCONVERT, [
        ...LVM_MIXED_BLOCK_ARGS,
        '-y',
        '--type',
        'cache',
        '--cachevol',
        cacheLv,
        '--cachemode',
        'writethrough',
        `${pool.name}/${lvName}`,
      ])
      log(`ahr.cache pool=${pool.name} disks=${diskIds.join(',')} status=attached mode=writethrough`)
    }

    const sizeBytes = cachePvBytes(await readPvs(executor), pool.name, sliceDevices)
    const warnings = input.rotationalIds && input.rotationalIds.length > 0
      ? [rotatingCacheAdvisory(input.rotationalIds)]
      : undefined
    return { pool: pool.name, devices: diskIds, sizeBytes, ...(warnings ? { warnings } : {}) }
  }
  catch (err) {
    // Roll back what this attempt put on the disks (issue #11's rule: an
    // operation that could only have been half-done by THIS run cleans up
    // after itself, so the pool is left uncached and the disks clean rather
    // than half-consumed — a stray cache PV would sit in the VG as free
    // extents a later expansion would try to grow the pool onto).
    //
    // Best-effort but NOT silent: the step's own error is the one the operator
    // needs and a rollback failure must never replace it, so the cause is what
    // is re-thrown — and the rollback's own failure goes to the journal, named
    // by pool and step. Swallowing it outright left a half-attached cache
    // (a stray PV in the VG, a slice on the disk) with nothing anywhere saying
    // the cleanup had not worked.
    updateProgress('Attach failed — removing what this attempt created')
    await detachAhrCache(executor, { pool }, () => {}, opts).catch((rbErr: unknown) => {
      const message = rbErr instanceof Error ? rbErr.message : String(rbErr)
      log(`ahr.cache pool=${pool.name} step=rollback status=failed error=${message}`)
      updateProgress(`The cleanup ALSO failed: ${message} — detach the cache to finish it`)
    })
    throw err
  }
}

/**
 * One cache disk, from bare metal to a PV of the pool VG; returns the slice's
 * by-id path and the kernel path lvm names it by. Each of the three acts
 * detects its own completion, so this is re-runnable at any point.
 */
async function ensureCachePv(
  executor: CommandExecutor,
  ctx: {
    pool: string
    diskId: string
    ordinal: number
    updateProgress: (message: string) => void
    log: (line: string) => void
  },
): Promise<{ path: string, kernelPath: string }> {
  const { pool, diskId, ordinal, updateProgress, log } = ctx
  const label = cachePartitionLabel(pool, ordinal)
  const dev = byIdPath(diskId)

  // 1. The slice. Detected by LABEL — the disk's own record of what it is for.
  let tree = await readDiskTree(executor, dev)
  if (!tree)
    throw new Error(`cache disk '${diskId}' is not attached (no /dev/disk/by-id entry) — nothing to partition`)
  let slice = tree.parts.find(p => p.partlabel === label)
  if (!slice) {
    if (tree.parts.length > 0) {
      throw new Error(
        `disk '${diskId}' already carries ${tree.parts.length} partition${tree.parts.length === 1 ? '' : 's'} `
        + `and none is a '${label}' cache slice — refusing to partition a disk that is not empty`,
      )
    }
    updateProgress(`Creating the cache slice on ${diskId}`)
    // Whole disk, 1 MiB to the last usable sector (GT-4's start, the create
    // path's end clamp). ONE slice per cache disk, deliberately: a second slice
    // on an already-attached cache disk would be a partition on a HELD disk,
    // which needs the expansion path's partx-then-verify (GT-21).
    await run(executor, SGDISK, ['-n', '1:1M:0', '-t', `1:${SGDISK_LVM_TYPE}`, '-c', `1:${label}`, dev])
    // The kernel node appears at once on an idle disk; the by-id symlink and
    // the PARTLABEL need the settle (GT-21).
    await run(executor, UDEVADM, ['settle'])
    tree = await readDiskTree(executor, dev)
    slice = tree?.parts.find(p => p.partlabel === label)
    log(`ahr.cache pool=${pool} disk=${diskId} slice=${label} status=created`)
  }
  if (!slice || slice.number === null) {
    throw new Error(
      `the cache slice '${label}' was written to the GPT of '${diskId}' but never appeared as a device — `
      + `check \`dmesg\`; the slice exists on disk, so re-running the attach is safe`,
    )
  }
  const slicePath = `${dev}-part${slice.number}`
  // VERIFY the by-id form every later step addresses it by — the step that
  // creates a thing is the step that proves it (§5.1, issue #12).
  const resolved = await executor.exec(REALPATH, [slicePath])
  if (resolved.exitCode !== 0)
    throw new Error(`the cache slice device '${slicePath}' did not appear — udev has not published the partition`)
  const kernelPath = resolved.stdout.trim()

  const pv = (await readPvs(executor)).find(p => p.name === slicePath || p.name === kernelPath)

  // 2. The PV. `wipefs -a` FIRST: a recycled disk's stale signature makes
  //    `pvcreate` abort non-interactively, and `vgextend` then fails with a
  //    misleading "not found in Volume Group" (GT-18).
  if (!pv) {
    updateProgress(`Preparing ${diskId} as a cache physical volume`)
    await run(executor, WIPEFS, ['-a', slicePath])
    await run(executor, PVCREATE, [...LVM_MIXED_BLOCK_ARGS, slicePath])
    log(`ahr.cache pool=${pool} disk=${diskId} pv=${slicePath} status=created`)
  }

  // 3. Into the VG.
  if (pv?.vgName !== pool) {
    updateProgress(`Adding ${diskId} to volume group '${pool}'`)
    await run(executor, VGEXTEND, [...LVM_MIXED_BLOCK_ARGS, pool, slicePath])
    log(`ahr.cache pool=${pool} disk=${diskId} status=vg-extended`)
  }
  return { path: slicePath, kernelPath }
}

// ---- cache-detach -----------------------------------------------------------

/**
 * `lvconvert --uncache <vg>/<lv>` — the ONE command that releases a dm-cache,
 * in the ONE place that knows how to spell it.
 *
 * Detach is not its only caller: DESTROY must run it before `lvremove`,
 * because a cached pool's LV is a dm-cache TARGET and `lvremove` refuses one,
 * which left the pool half-destroyed (unmounted, fstab line gone, VG/LV and
 * arrays intact). A second copy of the argv there would be a copy that drifts.
 *
 * Live and unconditional by design (GT-20): it needs no `--force`, no unmount
 * and under a third of a second, and it works with the cache device ABSENT —
 * writethrough guarantees there is nothing to flush.
 */
export async function uncacheAhrLv(executor: CommandExecutor, vg: string, lvName: string): Promise<void> {
  await run(executor, LVCONVERT, [...LVM_MIXED_BLOCK_ARGS, '-y', '--uncache', `${vg}/${lvName}`])
}

/**
 * `vgreduce --removemissing <vg>` — behind the ONE guard that makes it safe.
 *
 * `--removemissing` drops EVERY absent PV, not the one we mean. A stopped band
 * md array reads `[unknown]` in `pvs` exactly as a dead cache device does
 * (GT-19), so without this test the recovery for a failed cache would quietly
 * evict a band's PV from a pool that was merely not assembled. The
 * discriminator is the same one `buildAhrCacheState` uses: every band must
 * already be accounted for by its own named md PV.
 *
 * Extracted because detach is no longer its only caller — the udev auto-uncache
 * rung and the boot rung (slice 2) run the same drop, and a second copy of this
 * guard is a copy that can be forgotten in exactly the case it exists for.
 *
 * Throws with the operator's next move; never runs `vgreduce` on a doubt.
 */
export async function dropMissingCachePv(
  executor: CommandExecutor,
  ctx: {
    pool: AhrPool
    /** The PVs `pvs` reports in this pool's VG, already filtered. */
    inVg: LvmPv[]
    updateProgress: (message: string) => void
    log: (line: string) => void
  },
): Promise<void> {
  const { pool, inVg, updateProgress, log } = ctx
  const missing = inVg.filter(p => p.name === UNKNOWN_PV_NAME)
  if (missing.length === 0)
    return
  const bandPvCount = inVg.filter(p => isMdPvName(p.name)).length
  const bandCount = pool.arrays.length
  if (bandPvCount < bandCount) {
    throw new Error(
      `volume group '${pool.name}' is missing ${missing.length} physical volume${missing.length === 1 ? '' : 's'} `
      + `while only ${bandPvCount} of ${bandCount} band arrays are present — a stopped band array is indistinguishable `
      + `from a failed cache device here, and 'vgreduce --removemissing' would drop the band's physical volume with the cache's. `
      + `Bring the band arrays up first (see the Hybrid RAID view), then detach the cache`,
    )
  }
  updateProgress(`Dropping the missing cache device from volume group '${pool.name}'`)
  await run(executor, VGREDUCE, [...LVM_MIXED_BLOCK_ARGS, '--removemissing', pool.name])
  log(`ahr.cache pool=${pool.name} status=vg-reduced-missing`)
}

export interface CacheDetachResult {
  pool: string
  /** The disks handed back to the inventory (their slices are gone). */
  released: string[]
}

/**
 * Detach the read cache (§13) — also the RECOVERY path when the cache device
 * has failed, which is why every step tolerates the device being absent:
 *
 *   `lvconvert --uncache` → `lvremove` any orphan cache volume
 *     → `vgreduce` (or `--removemissing`) → `pvremove` → `wipefs -a`
 *     → `sgdisk -d`
 *
 * `--uncache` is live and needs no force, no unmount and under a third of a
 * second, with the device present OR gone (GT-20): writethrough guarantees
 * there is nothing to flush, so there is no dirty-data path to lose. Read
 * service resumes on the very next I/O.
 *
 * It ENDS at deleting the partition, not at wiping it: a wiped partition is
 * still a partition, and /v1/disks reports the disk `other` — never
 * `available` — until the slice is removed from the GPT (GT-22).
 */
export async function detachAhrCache(
  executor: CommandExecutor,
  input: { pool: AhrPool },
  updateProgress: (message: string) => void,
  opts: CacheOptions = {},
): Promise<CacheDetachResult> {
  const { pool } = input
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const lvName = pool.lv.name
  const cacheLv = cacheLvName(pool.name)

  // The on-disk truth about which disks are OURS, read FIRST — before any
  // mutation: a `<pool>-cache<n>` GPT label is the only thing that says a disk
  // carries this pool's cache, and it survives `pvremove` and `wipefs`
  // (GT-22). Every step after the uncache is driven from this list, so an
  // unreadable one must stop the detach here (findCacheSlices throws), with
  // nothing yet changed — not after the uncache, where "no slices" would have
  // skipped every cleanup step and reported success.
  const slices = await findCacheSlices(executor, pool.name)
  const sliceDevices = new Set(slices.flatMap(s => [s.kernelPath, s.path]))

  // 1. Uncache — drops the cache volume and restores direct service.
  const lvs = await readVgLvs(executor, pool.name)
  const poolLv = lvs.find(l => l.name === lvName)
  if (poolLv && lvIsCacheTarget(poolLv.attr)) {
    updateProgress(`Removing the cache from ${pool.name}/${lvName}`)
    await uncacheAhrLv(executor, pool.name, lvName)
    log(`ahr.cache pool=${pool.name} status=uncached`)
  }
  // 1b. An ORPHAN `<pool>-cache` volume — an attach that died between
  //     `lvcreate` and `lvconvert`. It is visible only while it is NOT in front
  //     of the pool volume (a live one is the hidden `_cvol`), so this branch
  //     can only ever see the half-done case, and `vgreduce` below cannot
  //     proceed while it holds the cache PV.
  if (!lvIsCacheTarget(poolLv?.attr ?? '') && lvs.some(l => l.name === cacheLv)) {
    updateProgress(`Removing the unattached cache volume '${cacheLv}'`)
    await run(executor, LVREMOVE, [...LVM_MIXED_BLOCK_ARGS, '-f', `${pool.name}/${cacheLv}`])
    log(`ahr.cache pool=${pool.name} lv=${cacheLv} status=orphan-removed`)
  }

  // 2. The cache PVs leave the VG. A PV whose device is GONE cannot be named,
  //    so `--removemissing` is the only form that reaches it (GT-20); it
  //    rewrites a consistent VG and drops the ghost.
  const inVg = (await readPvs(executor)).filter(p => p.vgName === pool.name)
  const missing = inVg.filter(p => p.name === UNKNOWN_PV_NAME)
  // ONLY the PVs sitting on a disk that carries one of OUR slices. The old
  // test — "in the VG and not an md device" — ejected every non-md PV there,
  // including one an operator had added to the VG by hand, which detach has no
  // business touching (guest philosophy: we own what we labelled, nothing else).
  const namedCache = inVg.filter(p => sliceDevices.has(p.name))
  if (missing.length > 0)
    await dropMissingCachePv(executor, { pool, inVg, updateProgress, log })
  if (namedCache.length > 0) {
    updateProgress(`Removing ${namedCache.length} cache device${namedCache.length === 1 ? '' : 's'} from volume group '${pool.name}'`)
    await run(executor, VGREDUCE, [...LVM_MIXED_BLOCK_ARGS, pool.name, ...namedCache.map(p => p.name)])
    log(`ahr.cache pool=${pool.name} status=vg-reduced`)
  }

  // 3–5. Per slice: drop the PV label, wipe, and DELETE the partition. Driven
  //      by the on-disk labels, so a slice LVM has already forgotten is still
  //      found and still handed back.
  const remaining = slices.length > 0 ? await readPvs(executor) : []
  const released: string[] = []
  for (const slice of slices) {
    if (remaining.some(p => p.name === slice.kernelPath || p.name === slice.path)) {
      updateProgress(`Removing the physical-volume label from ${slice.diskId}`)
      await run(executor, PVREMOVE, [...LVM_MIXED_BLOCK_ARGS, '-y', slice.path])
    }
    updateProgress(`Wiping the cache slice on ${slice.diskId}`)
    await run(executor, WIPEFS, ['-a', slice.path])
    // THE step that hands the disk back. Without it /v1/disks keeps reporting
    // the disk `other` for ever and it can never be picked again (GT-22).
    updateProgress(`Deleting the cache slice from ${slice.diskId}`)
    await run(executor, SGDISK, ['-d', String(slice.partNumber), byIdPath(slice.diskId)])
    released.push(slice.diskId)
    log(`ahr.cache pool=${pool.name} disk=${slice.diskId} slice=${slice.partNumber} status=released`)
  }
  if (slices.length > 0)
    await run(executor, UDEVADM, ['settle'])

  return { pool: pool.name, released: [...new Set(released)] }
}

// ---- The automatic recovery (slice 2) ---------------------------------------

/**
 * The VG names whose pool LV is a dm-cache TARGET right now — ONE `lvs` call.
 *
 * The boot rung's cheap pre-check. A full `readAhrPools()` is a dozen commands
 * (mdstat, a `mdadm --detail` per array, two lsblk trees, the by-id listing,
 * vgs/lvs/pvs, findmnt, a btrfs usage read per pool), and the overwhelming
 * majority of daemon starts have no cache on the node at all, let alone a
 * broken one. This answers "is there anything here that could possibly need the
 * cache rung?" for the price of one command, and the expensive read happens
 * only when the answer is yes.
 *
 * Fail-open with an EMPTY list: an unreadable `lvs` at daemon start is not
 * evidence of a failed cache, and the rung it gates is a repair, not an alarm —
 * the udev event and the next start both get another chance.
 */
export async function cachedVgNames(executor: CommandExecutor): Promise<Set<string>> {
  const res = await executor.exec(LVS, LVS_STATE_ARGS)
  if (res.exitCode !== 0)
    return new Set()
  return new Set(parseLvsReport(res.stdout).filter(l => lvIsCacheTarget(l.attr)).map(l => l.vgName))
}

export interface CacheRecoveryResult {
  pool: string
  /** Whether `lvconvert --uncache` actually ran (false = already uncached). */
  uncached: boolean
  /** Whether the ghost PV was dropped from the VG. */
  vgReduced: boolean
  /** The filesystem is btrfs-forced-readonly and needs the Remount verb. */
  readOnly: boolean
  /** How the device was named in the notification (by-id, slice label, null). */
  device: string | null
}

/**
 * The automatic recovery from a failed/missing cache device (ahrcache.1
 * slice 2, §13 "Resolved 2026-09-24") — the body of BOTH rungs: the udev
 * auto-uncache on a cache disk's removal, and the boot rung at activation.
 *
 *   `lvconvert --uncache` → `vgreduce --removemissing` (guarded) → notify
 *
 * It runs UNATTENDED, which every line of GT-20 licenses: `--uncache` needs no
 * `--force`, no unmount and under a third of a second; a writethrough cache
 * holds no dirty block by construction, so there is nothing to flush and
 * nothing to lose; and read service resumes on the very next I/O. Leaving the
 * pool returning EIO on every read while a human finds a button is strictly
 * worse.
 *
 * Deliberately NARROWER than {@link detachAhrCache}: it does NOT wipe or delete
 * the `<pool>-cache<n>` slice. A device that died and comes back carries that
 * slice, and it is what keeps the disk attributed to its pool so the UI can
 * offer Reclaim (Detach cache) rather than showing an unexplained foreign disk.
 * With the device absent there is no slice to find anyway; with the device
 * present-but-broken, deleting it would be a destructive step taken by a
 * machine, which this rung is not licensed for.
 *
 * IDEMPOTENT: a second event on an already-uncached pool finds no cache target
 * and no missing PV, runs no command, and reports `uncached: false`.
 */
export async function recoverFailedAhrCache(
  executor: CommandExecutor,
  input: {
    pool: AhrPool
    /** How the device was named by whoever raised the event (a GPT label). */
    sliceLabel?: string | null
    /** `missing` at activation (boot rung), `failed` under a live pool. */
    reason?: 'failed' | 'missing'
  },
  updateProgress: (message: string) => void,
  opts: CacheOptions = {},
): Promise<CacheRecoveryResult> {
  const { pool } = input
  const reason = input.reason ?? 'failed'
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const lvName = pool.lv.name

  // The device's name, as honestly as it can still be given: the by-id the
  // topology resolved while the disk was there, else the GPT label udev
  // reported, else nothing. A disk that is gone cannot be asked what it was.
  const device = pool.cache?.devices[0] ?? input.sliceLabel ?? null

  // 1. Uncache. The pool LV's own attribute is the completion marker (a live
  //    cache volume is the HIDDEN `_cvol`, which `lvs` without `-a` never
  //    lists), so this is the test a re-run re-asks and answers "done".
  const poolLv = (await readVgLvs(executor, pool.name)).find(l => l.name === lvName)
  let uncached = false
  if (poolLv && lvIsCacheTarget(poolLv.attr)) {
    updateProgress(`Removing the failed cache from ${pool.name}/${lvName}`)
    await uncacheAhrLv(executor, pool.name, lvName)
    log(`ahr.cache pool=${pool.name} rung=recover status=uncached device=${device ?? 'unknown'}`)
    uncached = true
  }
  else {
    log(`ahr.cache pool=${pool.name} rung=recover status=already-uncached`)
  }

  // 2. Drop the ghost PV — behind the band guard, which is the whole reason
  //    this is a shared helper (an unassembled band reads `[unknown]` too).
  const inVg = (await readPvs(executor)).filter(p => p.vgName === pool.name)
  const vgReduced = inVg.some(p => p.name === UNKNOWN_PV_NAME)
  if (vgReduced)
    await dropMissingCachePv(executor, { pool, inVg, updateProgress, log })

  // 3. The fact that decides what the operator is told. Read AFTER the
  //    uncache: the write that trips btrfs can land during the failure window.
  const readOnly = pool.mounted ? await isAhrMountReadOnly(executor, pool.mountpoint) : false

  // 4. One notification, best-effort — a broken mail target must never fail a
  //    recovery that already restored service (the standing AHR posture).
  const note = cacheRecoveryNotification({ pool: pool.name, device, readOnly, reason })
  await pveNotify(executor, 'warning', note.title, note.body)
  log(`ahr.cache pool=${pool.name} rung=recover readonly=${readOnly} notified=1`)

  return { pool: pool.name, uncached, vgReduced, readOnly, device }
}

/**
 * The error-severity notification the automatic recovery sends when it could
 * not restore service — ONE builder for both rungs (parallel construction):
 * the boot rung at activation (`when: 'boot'`) and the udev rung's event job
 * under a live pool (`when: 'udev'`). Both failures leave the pool serving
 * nothing — every read through a dead dm-cache is an I/O error — and both run
 * unattended, so the announcement is identical down to the operator's next
 * move. Only the clause naming WHEN it tried differs.
 */
export async function notifyCacheRecoveryFailed(
  executor: CommandExecutor,
  pool: string,
  when: 'boot' | 'udev',
  message: string,
  /**
   * What the evidence said: `missing` only when the cache PV's device is gone
   * (an `[unknown]` PV under the band guard, or no labelled slice left on any
   * disk); `failed` for a cache whose device is present but reports a failure.
   * The body never claims a device is missing on the strength of a dm answer.
   */
  cause: 'missing' | 'failed',
): Promise<void> {
  await pveNotify(
    executor,
    'error',
    `AHR read cache recovery FAILED: ${pool}`,
    `Pool '${pool}' has a read cache ${cause === 'missing' ? 'whose device is missing' : 'that has failed'}, and ANAS could not drop it automatically `
    + `${when === 'boot' ? 'at start-up' : 'after the cache device was removed'}: ${message} `
    + `The pool cannot serve reads until the cache is removed — every read through a dead dm-cache returns an I/O error. `
    + `Detach the cache from the Hybrid RAID view once the reason above is dealt with.`,
  )
}
