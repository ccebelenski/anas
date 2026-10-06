import type { CommandExecutor } from '../executor/types.js'
import type { ByIdMap } from '../parsers/lsblk.js'
import type { LsblkIndex, PartInfo } from './ahr-topology.js'
import { parseByIdToKernel, parseDiskByIdListing } from '../parsers/disk-by-id.js'
import { parseFindmnt } from '../parsers/findmnt.js'
import { parseFstab, removeMount } from '../parsers/fstab.js'
import { lvIsCacheTarget, LVS_ARGS, parseLvsReport, parsePvsReport, parseVgsReport, PVS_ARGS, VGS_ARGS } from '../parsers/lvm-report.js'
import { isMdPvName, matchCachePartitionLabel } from './ahr-cache-state.js'
import { uncacheAhrLv } from './ahr-cache.js'
import { run } from './ahr-exec.js'
import { matchPartitionLabel } from './ahr-geometry.js'
import { classifyPartition, readAhrPoolIdentity, resolveMdadmConfPath } from './ahr-identity.js'
import { clearIntent } from './ahr-intent.js'
import { unpinArrays } from './ahr-mdadm-conf.js'
import { ahrLvPath } from './ahr-paths.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS, indexLsblk } from './ahr-topology.js'
import { editConfig, readConfig } from './config-writer.js'
import { ahrSnapshotsMountpoint } from './share-selfservice.js'

/**
 * AHR pool destruction (Epic 11 + AHR, docs/AHR-DESIGN.md §4) — the DESTROY
 * mutation behind DELETE /v1/ahr/:name. Tears the stack down top-down:
 *
 *   umount (pool mountpoint AND the Previous Versions @snapshots mount)
 *     → fstab lines removed (surgical) → uncache/lvremove/vgremove/pvremove
 *     → mdadm --stop per array → --zero-superblock per member partition
 *     → sgdisk --zap-all per member DISK → partlabel sweep for members no
 *       array still claims (issue #16) → unpin mdadm.conf ARRAY lines
 *     → update-initramfs -u → clear the expansion intent
 *
 * IDENTITY, NOT NAMES (story ident.3, identity audit #4). Before anything
 * changes, destroy reads who the pool IS ({@link readAhrPoolIdentity}): the
 * md UUIDs pinned for it in mdadm.conf, its live arrays that are pinned or PVs
 * of its VG, and the PVs of its VG. Every act after that is gated on it — an
 * array is stopped only when it is the pool's, a partition's superblock is
 * zeroed only when the UUID inside it (`mdadm --examine`) is the pool's, a
 * disk is zapped only when every partition on it is the pool's, and a cache
 * disk only when its slice was a PV of the pool's VG. A same-named foreign
 * array (a hand-built `media-r1`, a pool moved in from another node) and its
 * disks are left exactly as they were, and the progress says so.
 *
 * Every step CHECKS current state before acting, so a re-run against a
 * half-destroyed pool is safe: already-absent layers are skipped, not errors.
 * A member disk that is not ATTACHED is skipped too — out loud, in the job
 * progress, because what cannot be scrubbed comes back with the disk. The
 * mountpoint directory is left in place (the mounts precedent — an empty
 * directory is not ANAS's to delete).
 */

const UMOUNT = '/usr/bin/umount'
const SYSTEMCTL = '/usr/bin/systemctl'
const LVS = '/usr/sbin/lvs'
const VGS = '/usr/sbin/vgs'
const PVS = '/usr/sbin/pvs'
const LVREMOVE = '/usr/sbin/lvremove'
const VGREMOVE = '/usr/sbin/vgremove'
const PVREMOVE = '/usr/sbin/pvremove'
const MDADM = '/usr/sbin/mdadm'
const SGDISK = '/usr/sbin/sgdisk'
const UPDATE_INITRAMFS = '/usr/sbin/update-initramfs'
const FINDMNT = '/usr/bin/findmnt'
const LSBLK = '/usr/bin/lsblk'
const LS = '/usr/bin/ls'

const BY_ID_DIR = '/dev/disk/by-id/'

/**
 * What destroy actually needs to know — a structural subset of {@link AhrPool},
 * so the route keeps passing a full topology read while the failed-create
 * rollback (issue #11) can pass exactly what it knows without fabricating
 * capacity/state numbers for a pool that never finished existing.
 *
 * Everything else destroy needs (which arrays are live, which PVs/VG/LV exist,
 * what is mounted, whose partition is whose) it reads from the system at run
 * time — which is what makes it safe to invoke against a stack half-built to
 * ANY depth.
 */
export interface AhrDestroyTarget {
  /** Pool name — also the VG name and the md-name prefix. */
  name: string
  /**
   * Whether to consider the mountpoint at all. A live findmnt check still gates
   * the actual umount, so passing `true` speculatively is safe.
   */
  mounted: boolean
  mountpoint: string
  /** The disks to scrub, with the member partitions to zero superblocks on. */
  disks: { id: string, partitions: { device: string }[] }[]
  /**
   * md UUIDs the CALLER created in this same job — the failed create's
   * rollback (issue #11) runs before its arrays are pinned, so without them
   * nothing would prove the arrays it just built are this pool's.
   */
  createdArrayUuids?: string[]
  /**
   * The caller wiped every disk in `disks` itself, in this same job (the
   * failed create's rollback: a disk enters its plan only after its own wipe
   * succeeded). Those disks carry nothing but what the job built, so they are
   * scrubbed without the per-partition identity proof.
   */
  disksWipedByCaller?: boolean
}

export interface AhrDestroyOptions {
  /** /etc/fstab location. */
  fstabPath: string
  /** mdadm.conf override (else ANAS_MDADM_CONF / the Debian default). */
  mdadmConfPath?: string
  /**
   * The expansion-intent directory. When given, the pool's intent is removed
   * as the last step (story ident.3): an intent keyed by a NAME must not
   * outlive the pool it was written for. The operator's Destroy always passes
   * it; the failed-create rollback has no intent of its own to clear.
   */
  intentDir?: string
}

/**
 * What destroy did. `destroyed` is always the pool name; every other field is
 * present only when it happened, so the ordinary teardown of a healthy pool
 * still reports exactly `{ destroyed }` — the sweep speaks up only when it
 * found something membership did not (issue #16).
 */
export interface AhrDestroyResult {
  destroyed: string
  /** Member partitions the label sweep zeroed — no array named them. */
  sweptPartitions?: string[]
  /** Detached member disks the sweep zapped (they carried only this pool). */
  sweptDisks?: string[]
  /** Disks left partitioned — they carry partitions that are not this pool's. */
  preservedDisks?: string[]
  /** What the sweep could NOT scrub (reported, never silently dropped). */
  sweepFailures?: string[]
  /** Member disks that are not attached — nothing on them was scrubbed. */
  absentDisks?: string[]
  /** Same-named md arrays that are NOT this pool's — left running, untouched. */
  foreignArrays?: string[]
}

/** One partition of a disk destroy considers, with its identity verdict. */
interface PartFact {
  /** The path commands run against (by-id `-partN` when resolvable). */
  path: string
  /** ours = superblock UUID is the pool's, or a proven cache slice; blank-ours = no signature, this pool's label. */
  verdict: 'ours' | 'blank-ours' | 'foreign'
  /** Carries this pool's member or cache GPT label. */
  labeled: boolean
}

/** One disk destroy considers: by-id (or kernel) identity + every partition on it. */
interface DiskFact {
  id: string
  devPath: string
  parts: PartFact[]
}

/** The whole-disk path + per-partition path rule (by-id when the disk resolves — GT-2). */
function diskPaths(kernel: string, byIdByKernel: ByIdMap): { id: string, devPath: string, partPath: (p: PartInfo) => string } {
  const resolved = byIdByKernel.get(kernel)
  return {
    id: resolved ?? kernel,
    devPath: resolved ? `${BY_ID_DIR}${resolved}` : `/dev/${kernel}`,
    partPath: p => resolved !== undefined && p.partNumber !== null ? `${BY_ID_DIR}${resolved}-part${p.partNumber}` : `/dev/${p.name}`,
  }
}

/** Does this GPT label mark a member or cache slice of `pool`? */
function isPoolLabel(pool: string, label: string | null): boolean {
  return label !== null && (matchPartitionLabel(pool, label) !== null || matchCachePartitionLabel(pool, label) !== null)
}

/**
 * May destroy zap this whole disk? Only when EVERY partition on it is the
 * pool's: proven by the superblock inside it, or an empty slice the pool
 * itself labelled (the state a re-run finds after an earlier pass zeroed the
 * superblocks — there is nothing on it to lose, and leaving the labels would
 * keep the disk out of the inventory). One partition that is anyone else's —
 * a superblock of another array, a filesystem, an unlabelled slice — keeps the
 * GPT (guest philosophy: the same exclusivity the ZFS destroy cleanup applies).
 */
function zappable(disk: DiskFact): boolean {
  return disk.parts.length > 0 && disk.parts.every(p => p.verdict !== 'foreign')
}

/**
 * Destroy an AHR pool. `pool` names the disks and member partitions to scrub
 * even after the upper layers are gone — the live topology read for an
 * operator-initiated Destroy, or the create's own plan when a failed create
 * rolls itself back (issue #11). Idempotent per step (checks-then-acts
 * throughout), which is what lets BOTH callers point it at a stack built to any
 * depth: absent layers are skipped, not errors.
 */
export async function destroyAhrPool(
  executor: CommandExecutor,
  pool: AhrDestroyTarget,
  updateProgress: (message: string) => void,
  opts: AhrDestroyOptions,
): Promise<AhrDestroyResult> {
  const { name } = pool
  const mdadmConfPath = resolveMdadmConfPath(opts.mdadmConfPath)
  const wipedByCaller = pool.disksWipedByCaller === true

  // --- WHO the pool is, read before anything changes (story ident.3) --------
  // Kernel names are valid only within this pass (GT-2); the UUIDs are not.
  const identity = await readAhrPoolIdentity(executor, name, { mdadmConfPath, extraUuids: pool.createdArrayUuids })
  const liveArrays = identity.arrays.map(a => a.dev) // e.g. /dev/md127
  const foreignArrays = identity.foreign.map(f => `/dev/${f.kernelName}`)
  for (const f of identity.foreign) {
    updateProgress(
      `Leaving md array /dev/${f.kernelName} alone: it is named '${name}-r${f.band}' but it is not this pool's `
      + `(UUID ${f.uuid ?? 'unreadable'} is not pinned for '${name}' in mdadm.conf and it is not in the volume group)`,
    )
  }

  // Live disk truth for the whole scrub phase, read ONCE and up front — while
  // every label, PV and superblock is still there to read. The single by-id
  // listing answers two questions (which member disks are ATTACHED, and which
  // kernel disk is which by-id), and the lsblk tree carries every partition's
  // label and signature.
  const byIdRes = await executor.exec(LS, ['-la', BY_ID_DIR])
  const byIdAll = byIdRes.exitCode === 0 ? parseByIdToKernel(byIdRes.stdout) : new Map<string, string>()
  const byIdByKernel: ByIdMap = byIdRes.exitCode === 0 ? parseDiskByIdListing(byIdRes.stdout) : new Map()
  const lsblkRes = await executor.exec(LSBLK, AHR_LSBLK_ARGS)
  const index: LsblkIndex = lsblkRes.exitCode === 0 ? indexLsblk(lsblkRes.stdout) : { partsByKernel: new Map(), lvmByDmName: new Map() }

  // The pool's cache slices: a non-md PV of the pool's VG, on a partition the
  // pool labelled `<pool>-cache<n>`. A label alone is not ownership — a slice
  // LVM does not count in this VG is left alone (identity audit #4).
  const provenCacheParts = new Set<string>()
  for (const pvName of identity.pvNames) {
    if (isMdPvName(pvName))
      continue
    const kernel = pvName.startsWith('/dev/') ? pvName.slice('/dev/'.length) : pvName
    const part = index.partsByKernel.get(kernel)
    if (part && part.partlabel !== null && matchCachePartitionLabel(name, part.partlabel) !== null)
      provenCacheParts.add(part.name)
  }

  // Every disk destroy might touch: the target's disks, any disk carrying
  // this pool's labels (issue #16's detached members), and the cache disks —
  // each with EVERY partition on it classified, so a zap decision sees the
  // whole disk, not just the slices the pool knows about.
  const partsByDisk = new Map<string, PartInfo[]>()
  for (const part of index.partsByKernel.values()) {
    const list = partsByDisk.get(part.disk.name) ?? []
    list.push(part)
    partsByDisk.set(part.disk.name, list)
  }
  const targetIds = new Set(pool.disks.map(d => d.id))
  const facts = new Map<string, DiskFact>()
  for (const [kernel, parts] of partsByDisk) {
    const paths = diskPaths(kernel, byIdByKernel)
    const relevant = targetIds.has(paths.id) || parts.some(p => isPoolLabel(name, p.partlabel))
    if (!relevant)
      continue
    const partFacts: PartFact[] = []
    for (const part of parts.sort((a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0))) {
      const path = paths.partPath(part)
      const labeled = isPoolLabel(name, part.partlabel)
      let verdict: PartFact['verdict']
      if (wipedByCaller && targetIds.has(paths.id)) {
        verdict = 'ours' // the caller wiped this disk in this very job
      }
      else if (provenCacheParts.has(part.name)) {
        verdict = 'ours'
      }
      else {
        const v = await classifyPartition(executor, identity, path)
        verdict = v === 'ours' ? 'ours' : v === 'blank' && labeled && part.fstype === null ? 'blank-ours' : 'foreign'
      }
      partFacts.push({ path, verdict, labeled })
    }
    facts.set(paths.id, { id: paths.id, devPath: paths.devPath, parts: partFacts })
  }

  // --- umount (only when actually mounted; the directory stays) --------------
  const mountpoint = pool.mounted ? pool.mountpoint : null
  const findmntRes = await executor.exec(FINDMNT, AHR_FINDMNT_ARGS)
  const mounts = findmntRes.exitCode === 0 ? parseFindmnt(findmntRes.stdout) : []
  if (mountpoint && mounts.some(m => m.target === mountpoint)) {
    updateProgress(`Unmounting ${mountpoint}`)
    await run(executor, UMOUNT, [mountpoint], { busyPath: mountpoint })
  }

  // The Previous Versions @snapshots mount (smbsvc.1) is a SIBLING of the pool
  // mount base — never under the pool mountpoint — and the design keeps it
  // across enable/disable on purpose. Destroy is not disable: with the LV gone
  // the mount has no filesystem left to show, a still-mounted one holds the LV
  // open (the lvremove below would fail on it), and its fstab line would dangle
  // across a pool that no longer exists. This is the one place the "the mount
  // stays" ruling ends. Unmounted but fstab-claimed is still torn down — the
  // mount is found live (like everything else here), never inferred from fstab.
  const snapMount = ahrSnapshotsMountpoint(name)
  if (mounts.some(m => m.target === snapMount)) {
    updateProgress(`Unmounting ${snapMount} (Previous Versions @snapshots mount)`)
    await run(executor, UMOUNT, [snapMount], { busyPath: snapMount })
  }

  // --- fstab: drop the pool's lines (found by mountpoint OR by LV spec, so a
  // half-destroyed, already-unmounted pool still gets its line removed). The LV
  // spec matches BOTH the pool's own line and the @snapshots line — every
  // match goes; a destroyed pool leaves no line behind. ------------------------
  const fstabText = await readConfig(opts.fstabPath)
  const fstabMountpoints = new Set(
    parseFstab(fstabText)
      .filter(e => e.mountpoint === mountpoint || e.mountpoint === snapMount || e.spec === ahrLvPath(name))
      .map(e => e.mountpoint),
  )
  for (const mp of fstabMountpoints) {
    updateProgress(`Removing /etc/fstab entry for ${mp}`)
    await editConfig(opts.fstabPath, current => removeMount(current, mp))
  }
  if (fstabMountpoints.size > 0) {
    await run(executor, SYSTEMCTL, ['daemon-reload'])
  }

  // --- LVM teardown (each layer checked live before acting) -------------------
  const lvsRes = await executor.exec(LVS, LVS_ARGS)
  const lvs = lvsRes.exitCode === 0 ? parseLvsReport(lvsRes.stdout).filter(l => l.vgName === name) : []
  for (const lv of lvs) {
    // A cached pool's LV is a dm-cache TARGET, and `lvremove` REFUSES one —
    // which left the pool half-destroyed exactly here: already unmounted, its
    // fstab line gone, and the VG, LV and arrays all still standing. Releasing
    // the cache first is the detach step's own command (ahrcache.1 §13), and it
    // is live, needs no force and works with the cache device absent (GT-20).
    // The cache SLICE itself needs nothing extra: its disk is zapped below
    // with the rest — when the slice was proven a PV of this pool's VG.
    if (lvIsCacheTarget(lv.attr)) {
      updateProgress(`Removing the read cache from ${name}/${lv.name}`)
      await uncacheAhrLv(executor, name, lv.name)
    }
    updateProgress(`Removing logical volume ${name}/${lv.name}`)
    await run(executor, LVREMOVE, ['-y', `${name}/${lv.name}`])
  }
  const vgsRes = await executor.exec(VGS, VGS_ARGS)
  if (vgsRes.exitCode === 0 && parseVgsReport(vgsRes.stdout).some(v => v.name === name)) {
    updateProgress(`Removing volume group ${name}`)
    await run(executor, VGREMOVE, ['-y', name])
  }
  const pvsRes = await executor.exec(PVS, PVS_ARGS)
  const pvs = pvsRes.exitCode === 0
    ? parsePvsReport(pvsRes.stdout).filter(pv => pv.vgName === name || liveArrays.includes(pv.name))
    : []
  for (const pv of pvs) {
    updateProgress(`Removing physical volume ${pv.name}`)
    await run(executor, PVREMOVE, ['-y', pv.name])
  }

  // --- md arrays: stop the pool's own, then erase the pool's superblocks ------
  for (const dev of liveArrays) {
    updateProgress(`Stopping array ${dev}`)
    await run(executor, MDADM, ['--stop', dev])
  }

  // A member with no by-id entry is not here to scrub — and its scrub commands
  // would fail on a path that does not exist. Concluded ONLY from a listing we
  // actually read: an unreadable /dev/disk/by-id degrades to "assume attached",
  // never to "absent", which would skip the scrub of a disk that is right here.
  const absentDisks = byIdAll.size > 0 ? pool.disks.filter(d => !byIdAll.has(d.id)).map(d => d.id) : []
  for (const id of absentDisks) {
    // Said out loud, never skipped silently (issue #16): a disk that is not
    // here keeps its superblocks and its labels, and brings them back with it.
    updateProgress(
      `Disk ${id} has no /dev/disk/by-id entry — it is not attached, so its md superblocks and `
      + `partition table CANNOT be scrubbed; it will still carry '${name}' member partitions if it returns`,
    )
  }
  const presentDisks = pool.disks.filter(d => !absentDisks.includes(d.id))

  updateProgress('Zeroing md superblocks')
  for (const disk of presentDisks) {
    const fact = facts.get(disk.id)
    for (const part of disk.partitions) {
      // Only a partition whose superblock is THIS pool's (identity audit #4).
      // When the tree could not be read the caller-wiped rollback still
      // scrubs its own partitions; nothing else is zeroed blind.
      const verdict = fact?.parts.find(p => p.path === part.device)?.verdict
        ?? (wipedByCaller ? 'ours' : await classifyPartition(executor, identity, part.device))
      if (verdict !== 'ours')
        continue
      // Tolerated failure: an already-zeroed or vanished partition is exactly
      // the half-destroyed state a re-run must survive.
      await executor.exec(MDADM, ['--zero-superblock', part.device])
    }
  }

  // --- Disks: drop the partition tables ---------------------------------------
  const preservedDisks: string[] = []
  for (const disk of presentDisks) {
    const fact = facts.get(disk.id)
    if (!wipedByCaller && (!fact || !zappable(fact))) {
      if (fact && fact.parts.length > 0) {
        updateProgress(`Leaving the partition table on ${disk.id} — it carries partitions that are not this pool's`)
        preservedDisks.push(disk.id)
      }
      continue
    }
    updateProgress(`Zapping partition table on ${disk.id}`)
    await run(executor, SGDISK, ['--zap-all', `${BY_ID_DIR}${disk.id}`])
  }

  // --- Partlabel sweep: members that no array claims any more (issue #16) -----
  // Everything above works off CURRENT array membership. A member that dropped
  // out of every array — the likeliest state for a disk in a pool being
  // destroyed after trouble — appears in none of it. On pve5 (2026-08-09) that
  // left one detached disk with all three partitions, live md superblocks and
  // its `<pool>-d*-b*` labels fully intact while its four attached siblings were
  // blanked; mdadm's incremental assembly then resurrected ghost INACTIVE arrays
  // at the next boot, which blocked the clean re-add. So sweep every disk the
  // host can see that carries this pool's labels — and act, as everywhere
  // else, only on what the superblock proves is the pool's.
  const sweptPartitions: string[] = []
  const sweptDisks: string[] = []
  const sweepFailures: string[] = []
  const sweepDisks = [...facts.values()]
    .filter(d => !targetIds.has(d.id) && d.parts.some(p => p.labeled))
    .sort((a, b) => a.id.localeCompare(b.id))
  for (const disk of sweepDisks) {
    for (const part of disk.parts.filter(p => p.verdict === 'ours')) {
      updateProgress(`Zeroing the md superblock on ${part.path} — a '${name}' member partition no array claims`)
      const res = await executor.exec(MDADM, ['--zero-superblock', part.path])
      if (res.exitCode === 0)
        sweptPartitions.push(part.path)
      else
        sweepFailures.push(part.path)
    }
    if (!zappable(disk)) {
      // Guest philosophy: a disk carrying anything that is not provably this
      // pool's keeps its GPT. Its own superblocks (if any) are gone above,
      // which is what closes the ghost-assembly hole.
      updateProgress(`Leaving the partition table on ${disk.id} — it carries partitions that are not this pool's`)
      preservedDisks.push(disk.id)
      continue
    }
    updateProgress(`Zapping partition table on ${disk.id} (detached '${name}' member)`)
    // Tolerated, unlike the attached path's zap: this disk was not in the
    // destroy target list, and the superblock zeroing above already closed the
    // ghost-assembly hole. Failing the JOB here would skip the mdadm.conf unpin
    // below — trading a surviving GPT for surviving ARRAY pins.
    const res = await executor.exec(SGDISK, ['--zap-all', disk.devPath])
    if (res.exitCode === 0)
      sweptDisks.push(disk.id)
    else
      sweepFailures.push(disk.devPath)
  }

  // --- Unpin ARRAY lines (by the UUIDs recorded in the conf itself, so this
  // works even when the arrays are long stopped) + refresh the initramfs ------
  const uuids = [...identity.pinned]
  if (uuids.length > 0) {
    updateProgress('Unpinning arrays from mdadm.conf')
    await unpinArrays(uuids, mdadmConfPath)
    updateProgress('Updating initramfs (mdadm.conf changed)')
    await run(executor, UPDATE_INITRAMFS, ['-u'])
  }

  // --- The expansion intent goes with the pool (story ident.3) ---------------
  // It is keyed by NAME: left behind, it would read as the halted expansion
  // of the next pool created under this name and drive its disks.
  if (opts.intentDir !== undefined) {
    updateProgress('Clearing the expansion record')
    await clearIntent(name, opts.intentDir)
  }

  return {
    destroyed: name,
    ...(sweptPartitions.length > 0 ? { sweptPartitions } : {}),
    ...(sweptDisks.length > 0 ? { sweptDisks } : {}),
    ...(preservedDisks.length > 0 ? { preservedDisks } : {}),
    ...(sweepFailures.length > 0 ? { sweepFailures } : {}),
    ...(absentDisks.length > 0 ? { absentDisks } : {}),
    ...(foreignArrays.length > 0 ? { foreignArrays } : {}),
  }
}
