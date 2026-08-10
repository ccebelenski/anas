import type { CommandExecutor } from '../executor/types.js'
import type { ByIdMap } from '../parsers/lsblk.js'
import type { LsblkIndex, PartInfo } from './ahr-topology.js'
import { parseByIdToKernel, parseDiskByIdListing } from '../parsers/disk-by-id.js'
import { parseFindmnt } from '../parsers/findmnt.js'
import { parseFstab, removeMount } from '../parsers/fstab.js'
import { LVS_ARGS, parseLvsReport, parsePvsReport, parseVgsReport, PVS_ARGS, VGS_ARGS } from '../parsers/lvm-report.js'
import { getArrays, parseMdadmConfDoc } from '../parsers/mdadm-conf.js'
import { matchAhrArrayName, mdadmDetailExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { run } from './ahr-exec.js'
import { matchPartitionLabel } from './ahr-geometry.js'
import { DEFAULT_MDADM_CONF, unpinArrays } from './ahr-mdadm-conf.js'
import { ahrLvPath } from './ahr-paths.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS, indexLsblk } from './ahr-topology.js'
import { editConfig, readConfig } from './config-writer.js'

/**
 * AHR pool destruction (Epic 11 + AHR, docs/AHR-DESIGN.md §4) — the DESTROY
 * mutation behind DELETE /v1/ahr/:name. Tears the stack down top-down:
 *
 *   umount → fstab line removed (surgical) → lvremove/vgremove/pvremove
 *     → mdadm --stop per array → --zero-superblock per member partition
 *     → sgdisk --zap-all per member DISK → partlabel sweep for members no
 *       array still claims (issue #16) → unpin mdadm.conf ARRAY lines
 *     → update-initramfs -u
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
const CAT = '/usr/bin/cat'
const FINDMNT = '/usr/bin/findmnt'
const LSBLK = '/usr/bin/lsblk'
const LS = '/usr/bin/ls'

const BY_ID_DIR = '/dev/disk/by-id/'

/** ARRAY-pin device path of one band array (`/dev/md/<pool>-r<N>`). */
const PIN_DEVICE_RE = /^\/dev\/md\/(.+)$/

/**
 * What destroy actually needs to know — a structural subset of {@link AhrPool},
 * so the route keeps passing a full topology read while the failed-create
 * rollback (issue #11) can pass exactly what it knows without fabricating
 * capacity/state numbers for a pool that never finished existing.
 *
 * Everything else destroy needs (which arrays are live, which PVs/VG/LV exist,
 * what is mounted) it reads from the system at run time — which is what makes it
 * safe to invoke against a stack half-built to ANY depth.
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
}

export interface AhrDestroyOptions {
  /** /etc/fstab location. */
  fstabPath: string
  /** mdadm.conf override (else ANAS_MDADM_CONF / the Debian default). */
  mdadmConfPath?: string
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
}

/** One disk the partlabel sweep found still carrying this pool's members. */
interface LabeledDisk {
  /** by-id identity when it resolves, else the kernel name (GT-2 fallback). */
  id: string
  /** Whole-disk path to zap. */
  devPath: string
  /** This pool's member partitions on the disk, as device paths. */
  partitions: string[]
  /** True when the disk carries NOTHING but this pool's member partitions. */
  exclusive: boolean
}

/**
 * Every disk in the live lsblk tree that carries partitions LABELED for this
 * pool (`<pool>-d<n>-b<band>` — {@link matchPartitionLabel}), regardless of
 * whether any array still claims them. Pure: the caller decides what to scrub.
 *
 * Paths follow the topology reader's identity rule exactly — the by-id form
 * whenever the disk resolves, the kernel path only as a fallback.
 */
function labeledMemberDisks(index: LsblkIndex, poolName: string, byIdByKernel: ByIdMap): LabeledDisk[] {
  const byDisk = new Map<string, PartInfo[]>()
  for (const part of index.partsByKernel.values()) {
    const list = byDisk.get(part.disk.name) ?? []
    list.push(part)
    byDisk.set(part.disk.name, list)
  }

  const out: LabeledDisk[] = []
  for (const [kernel, parts] of byDisk) {
    const members = parts.filter(p => p.partlabel !== null && matchPartitionLabel(poolName, p.partlabel) !== null)
    if (members.length === 0)
      continue
    const resolved = byIdByKernel.get(kernel)
    out.push({
      id: resolved ?? kernel,
      devPath: resolved ? `${BY_ID_DIR}${resolved}` : `/dev/${kernel}`,
      partitions: members.map(p => resolved !== undefined && p.partNumber !== null
        ? `${BY_ID_DIR}${resolved}-part${p.partNumber}`
        : `/dev/${p.name}`),
      exclusive: members.length === parts.length,
    })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
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
  const mdadmConfPath = opts.mdadmConfPath ?? process.env.ANAS_MDADM_CONF ?? DEFAULT_MDADM_CONF

  // Identify the pool's LIVE md arrays up front (kernel names are valid only
  // within this pass — GT-2): every mdstat array whose superblock name matches
  // `<pool>-r<N>`. Also the source for PV matching once the VG name is gone.
  const mdstatRes = await executor.exec(CAT, MDSTAT_CAT_ARGS)
  const liveArrays: string[] = [] // kernel device paths, e.g. /dev/md127
  if (mdstatRes.exitCode === 0) {
    for (const md of parseMdstat(mdstatRes.stdout)) {
      const res = await executor.exec(MDADM, mdadmDetailExportArgs(`/dev/${md.kernelName}`))
      const detail = parseMdadmDetailExport(res.stdout)
      const named = matchAhrArrayName(detail.name ?? detail.devName ?? '')
      if (named?.pool === name)
        liveArrays.push(`/dev/${md.kernelName}`)
    }
  }

  // --- umount (only when actually mounted; the directory stays) --------------
  const mountpoint = pool.mounted ? pool.mountpoint : null
  const findmntRes = await executor.exec(FINDMNT, AHR_FINDMNT_ARGS)
  const mounts = findmntRes.exitCode === 0 ? parseFindmnt(findmntRes.stdout) : []
  if (mountpoint && mounts.some(m => m.target === mountpoint)) {
    updateProgress(`Unmounting ${mountpoint}`)
    await run(executor, UMOUNT, [mountpoint], { busyPath: mountpoint })
  }

  // --- fstab: drop the pool's line (found by mountpoint OR by LV spec, so a
  // half-destroyed, already-unmounted pool still gets its line removed) -------
  const fstabText = await readConfig(opts.fstabPath)
  const fstabEntry = parseFstab(fstabText).find(
    e => e.mountpoint === mountpoint || e.spec === ahrLvPath(name),
  )
  if (fstabEntry) {
    updateProgress('Removing /etc/fstab entry')
    await editConfig(opts.fstabPath, current => removeMount(current, fstabEntry.mountpoint))
    await run(executor, SYSTEMCTL, ['daemon-reload'])
  }

  // --- LVM teardown (each layer checked live before acting) -------------------
  const lvsRes = await executor.exec(LVS, LVS_ARGS)
  const lvs = lvsRes.exitCode === 0 ? parseLvsReport(lvsRes.stdout).filter(l => l.vgName === name) : []
  for (const lv of lvs) {
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

  // --- md arrays: stop, then erase every member superblock --------------------
  for (const dev of liveArrays) {
    updateProgress(`Stopping array ${dev}`)
    await run(executor, MDADM, ['--stop', dev])
  }

  // Live disk truth for the whole scrub phase, read ONCE — before anything is
  // zapped, while the labels are still there to read. The single by-id listing
  // answers two questions (which member disks are ATTACHED, and which kernel
  // disk is which by-id), and the lsblk tree carries every partition's label,
  // which is what finds members no array claims any more.
  const byIdRes = await executor.exec(LS, ['-la', BY_ID_DIR])
  const byIdAll = byIdRes.exitCode === 0 ? parseByIdToKernel(byIdRes.stdout) : new Map<string, string>()
  const byIdByKernel: ByIdMap = byIdRes.exitCode === 0 ? parseDiskByIdListing(byIdRes.stdout) : new Map()
  const lsblkRes = await executor.exec(LSBLK, AHR_LSBLK_ARGS)
  const labeled = lsblkRes.exitCode === 0 ? labeledMemberDisks(indexLsblk(lsblkRes.stdout), name, byIdByKernel) : []

  // A member with no by-id entry is not here to scrub — and its scrub commands
  // would fail on a path that does not exist. Concluded ONLY from a listing we
  // actually read: an unreadable /dev/disk/by-id degrades to "assume attached"
  // (scrub exactly as before), never to "absent", which would skip the scrub of
  // a disk that is right here.
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
    for (const part of disk.partitions) {
      // Tolerated failure: an already-zeroed or vanished partition is exactly
      // the half-destroyed state a re-run must survive.
      await executor.exec(MDADM, ['--zero-superblock', part.device])
    }
  }

  // --- Disks: drop the partition tables ---------------------------------------
  for (const disk of presentDisks) {
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
  // at the next boot, which blocked the clean re-add. So sweep by LABEL across
  // every disk the host can see. Same acts as the attached path, same order.
  const sweptPartitions: string[] = []
  const sweptDisks: string[] = []
  const preservedDisks: string[] = []
  const sweepFailures: string[] = []
  const namedDisks = new Set(pool.disks.map(d => d.id))
  for (const disk of labeled) {
    if (namedDisks.has(disk.id))
      continue // membership already covered it (or reported it absent)
    for (const partition of disk.partitions) {
      updateProgress(`Zeroing the md superblock on ${partition} — a '${name}' member partition no array claims`)
      const res = await executor.exec(MDADM, ['--zero-superblock', partition])
      if (res.exitCode === 0)
        sweptPartitions.push(partition)
      else
        sweepFailures.push(partition)
    }
    if (!disk.exclusive) {
      // Guest philosophy: a disk carrying anything else keeps its GPT — the
      // superblocks are gone, which is what closes the ghost-assembly hole.
      // (The same exclusivity guard the ZFS destroy-cleanup path applies.)
      updateProgress(`Leaving the partition table on ${disk.id} — it carries partitions that are not '${name}'`)
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
  const confDoc = parseMdadmConfDoc(await readConfig(mdadmConfPath))
  const uuids = getArrays(confDoc)
    .filter((a) => {
      const m = a.device.match(PIN_DEVICE_RE)
      return a.uuid !== undefined && m !== null && matchAhrArrayName(m[1])?.pool === name
    })
    .map(a => a.uuid!)
  if (uuids.length > 0) {
    updateProgress('Unpinning arrays from mdadm.conf')
    await unpinArrays(uuids, opts.mdadmConfPath)
    updateProgress('Updating initramfs (mdadm.conf changed)')
    await run(executor, UPDATE_INITRAMFS, ['-u'])
  }

  return {
    destroyed: name,
    ...(sweptPartitions.length > 0 ? { sweptPartitions } : {}),
    ...(sweptDisks.length > 0 ? { sweptDisks } : {}),
    ...(preservedDisks.length > 0 ? { preservedDisks } : {}),
    ...(sweepFailures.length > 0 ? { sweepFailures } : {}),
    ...(absentDisks.length > 0 ? { absentDisks } : {}),
  }
}
