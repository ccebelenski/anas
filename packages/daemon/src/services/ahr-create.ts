import type { AhrType, MountEntry } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { MdadmArrayPin } from '../parsers/mdadm-conf.js'
import type { AhrBandSlice } from './ahr-geometry.js'
import type { AhrLayoutDisk } from './ahr-layout.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { addMount, hasMount, parseFstab, removeMount } from '../parsers/fstab.js'
import { mdadmDetailExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { run } from './ahr-exec.js'
import { ahrDataOffsetArg, planDiskPartitions } from './ahr-geometry.js'
import { floorToGranularity, planFreshLayout } from './ahr-layout.js'
import { installProgramHook, pinArrays } from './ahr-mdadm-conf.js'
import { SUBVOL_DATA, SUBVOL_SNAPSHOTS } from './ahr-snapshots.js'
import { editConfig } from './config-writer.js'
import { pveNotify } from './pve-notify.js'

/**
 * AHR pool creation (Epic 11 + AHR, docs/AHR-DESIGN.md §4/§2.6) — the CREATE
 * mutation behind POST /v1/ahr. Builds the whole stack, bottom-up:
 *
 *   wipe (wipefs + sgdisk --zap-all, GT-12: stale foreign labels wedge hosts)
 *     → GPT band slices (planFreshLayout + planDiskPartitions; ONLY protected
 *       bands get partitions — §2.6, unused regions stay raw)
 *     → one mdadm array per band, metadata 1.2, deterministic name
 *       `<pool>-r<band>`, EXPLICIT --data-offset (GT-5/GT-6: the headroom is
 *       load-bearing for backup-file-free reshapes)
 *     → ARRAY pins in mdadm.conf + the monitor PROGRAM hook, then
 *       update-initramfs -u (ARRAY_PIN_REQUIRES_INITRAMFS)
 *     → LVM: pvcreate per array, one VG, one 100%FREE LV
 *     → btrfs `-d single -m dup` (NEVER btrfs-RAID — redundancy is md's job)
 *     → mountpoint + /etc/fstab (surgical addMount, nofail) + mount
 *
 * The initial RAID5/6 sync is deliberately NOT awaited: the pool is usable
 * immediately and the read layer reports it as `resyncing` ("building — pool
 * usable now"). Completion emits a PVE info notification (§7.2).
 */

const WIPEFS = '/usr/sbin/wipefs'
const SGDISK = '/usr/sbin/sgdisk'
const MDADM = '/usr/sbin/mdadm'
const UDEVADM = '/usr/bin/udevadm'
const REALPATH = '/usr/bin/realpath'
const LS = '/usr/bin/ls'
const PVCREATE = '/usr/sbin/pvcreate'
const VGCREATE = '/usr/sbin/vgcreate'
const LVCREATE = '/usr/sbin/lvcreate'
const MKFS_BTRFS = '/usr/sbin/mkfs.btrfs'
const BTRFS = '/usr/bin/btrfs'
const UPDATE_INITRAMFS = '/usr/sbin/update-initramfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'

/** Default base for pool mountpoints (§2.6: pool-scoped, never /mnt/pve). */
export const DEFAULT_AHR_MOUNT_BASE = '/mnt/anas-ahr'

/** The mount base: explicit override > ANAS_AHR_MOUNT_BASE (stunt/tests) > default. */
export function ahrMountBase(override?: string): string {
  return override ?? process.env.ANAS_AHR_MOUNT_BASE ?? DEFAULT_AHR_MOUNT_BASE
}

/** The LV device path of a pool (`/dev/<pool>/<pool>-vol`). */
export function ahrLvPath(name: string): string {
  return `/dev/${name}/${name}-vol`
}

export interface AhrCreateSpec {
  name: string
  tier: AhrType
  /** Route-validated 'available' disks (by-id + usable bytes). */
  disks: AhrLayoutDisk[]
  /** Route-validated mountpoint override (default: <mountBase>/<name>). */
  mountpoint?: string
}

export interface AhrCreateOptions {
  /** /etc/fstab location (config IS the API; tests point at a temp file). */
  fstabPath: string
  /** mdadm.conf override (else ANAS_MDADM_CONF / the Debian default). */
  mdadmConfPath?: string
  /** Mount-base override (else ANAS_AHR_MOUNT_BASE / /mnt/anas-ahr). */
  mountBase?: string
}

/**
 * Clear ghost md state on freshly carved partitions (§2.6 ghost-clearing).
 * Old md superblocks live INSIDE partitions (metadata 1.2, 4 KiB in) — a
 * whole-disk wipe never touches them, and when a new slice lands at the same
 * offset udev's incremental assembly can resurrect the dead array and hold
 * the partition busy before --create/--add runs. Stop any md holder of each
 * partition, then wipe the partition's signatures, then settle udev.
 * Shared by pool creation and hot-spare attach (§11).
 */
export async function clearGhostMdSignatures(
  executor: CommandExecutor,
  partitions: { diskId: string, partNumber: number }[],
): Promise<void> {
  for (const p of partitions) {
    const partPath = `/dev/disk/by-id/${p.diskId}-part${p.partNumber}`
    const real = await executor.exec(REALPATH, [partPath])
    if (real.exitCode === 0) {
      const kname = real.stdout.trim().split('/').pop()
      const holders = await executor.exec(LS, [`/sys/class/block/${kname}/holders`])
      for (const holder of holders.stdout.split(/\s+/).filter(h => h.startsWith('md')))
        await executor.exec(MDADM, ['--stop', `/dev/${holder}`])
    }
    await executor.exec(WIPEFS, ['-a', partPath])
  }
  await run(executor, UDEVADM, ['settle'])
}

/**
 * The canonical fstab entry for a pool: LV device, btrfs, nofail. When
 * `subvolLayout` is true (every pool created since §12) the entry carries
 * `subvol=@data` so the mountpoint mounts the data subvolume, not the
 * top-level — snapshots live under `@snapshots`, outside the mounted tree. A
 * pre-§12 flat pool has no `@data` subvolume, so its entry omits the option;
 * `changeAhrMountpoint` MUST pass the pool's real layout so a mountpoint move
 * never rewrites a flat pool's line to reference a subvolume it lacks.
 */
function ahrFstabEntry(name: string, mountpoint: string, subvolLayout: boolean): MountEntry {
  return {
    spec: ahrLvPath(name),
    mountpoint,
    fstype: 'btrfs',
    options: {
      common: {
        readOnly: false,
        // nofail mirrors the mounts precedent: a pool that cannot assemble
        // must never hold the host's boot hostage (guest philosophy).
        nofail: true,
        noauto: false,
        automount: false,
        noatime: false,
        nosuid: false,
        nodev: false,
        noexec: false,
        netdev: false,
      },
      passthrough: subvolLayout ? `subvol=${SUBVOL_DATA}` : '',
    },
    dump: 0,
    pass: 0,
  }
}

/**
 * Create an AHR pool. `spec.disks` must already be validated (available, no
 * duplicates); this recomputes the §2.1 layout and executes it. Progress is
 * reported at every stage; the initial md sync continues in the background.
 */
export async function createAhrPool(
  executor: CommandExecutor,
  spec: AhrCreateSpec,
  updateProgress: (message: string) => void,
  opts: AhrCreateOptions,
): Promise<{ created: string, mountpoint: string, arrays: string[] }> {
  const { name, tier } = spec
  const layout = planFreshLayout(spec.disks, tier)
  const protectedBands = layout.bands.filter(b => b.protected)
  if (protectedBands.length === 0)
    throw new Error(`no protected band is possible with the selected disks — an ${tier === 'ahr1' ? 'AHR-1' : 'AHR-2'} pool needs ${tier === 'ahr1' ? 2 : 4} disks reaching a common boundary`)

  // Deterministic disk ordinals (the `d<n>` of partition labels): ascending
  // rounded size, id as tie-break — the same order §2.1 sorts by.
  const disks = spec.disks
    .map(d => ({ id: d.id, rawBytes: d.usableBytes, roundedBytes: floorToGranularity(d.usableBytes) }))
    .sort((a, b) => a.roundedBytes - b.roundedBytes || a.id.localeCompare(b.id))

  // --- Wipe + partition (GT-12: prior signatures are a hazard, not residue) --
  interface PlannedDisk {
    id: string
    devPath: string
    /** band → GPT partition number on this disk. */
    partNumberByBand: Map<number, number>
  }
  const planned: PlannedDisk[] = []
  for (const [i, disk] of disks.entries()) {
    const devPath = `/dev/disk/by-id/${disk.id}`
    // Only protected bands are partitioned (§2.6); a disk participates in a
    // band when it reaches the band's upper boundary. Both sets are contiguous
    // from byte 0, so the slice chain planDiskPartitions validates holds.
    const slices: AhrBandSlice[] = protectedBands
      .filter(b => disk.roundedBytes >= b.range.endBytes)
      .map(b => ({ band: b.band, startBytes: b.range.startBytes, endBytes: b.range.endBytes }))
    const specs = planDiskPartitions({
      poolName: name,
      diskNumber: i + 1,
      diskUsableBytes: disk.roundedBytes,
      diskRawBytes: disk.rawBytes,
      slices,
    })

    updateProgress(`Wiping ${disk.id} (${i + 1}/${disks.length})`)
    await run(executor, WIPEFS, ['-a', devPath])
    await run(executor, SGDISK, ['--zap-all', devPath])
    updateProgress(`Partitioning ${disk.id} (${specs.length} band slice${specs.length === 1 ? '' : 's'})`)
    await run(executor, SGDISK, [...specs.flatMap(s => s.sgdiskArgs), devPath])

    planned.push({
      id: disk.id,
      devPath,
      partNumberByBand: new Map(specs.map(s => [s.band, s.number])),
    })
  }
  updateProgress('Settling udev (partition device nodes)')
  await run(executor, UDEVADM, ['settle'])

  // --- Clear ghost md state on the fresh partitions (§2.6) --------------------
  updateProgress('Clearing stale md signatures on new partitions')
  await clearGhostMdSignatures(
    executor,
    planned.flatMap(disk => [...disk.partNumberByBand.values()].map(partNumber => ({ diskId: disk.id, partNumber }))),
  )

  // --- One mdadm array per protected band ------------------------------------
  const mdDevices: string[] = []
  const arrayNames: string[] = []
  for (const band of protectedBands) {
    const arrayName = `${name}-r${band.band}`
    const mdDev = `/dev/md/${arrayName}`
    const members = planned
      .filter(d => d.partNumberByBand.has(band.band))
      .map(d => `/dev/disk/by-id/${d.id}-part${d.partNumberByBand.get(band.band)}`)
    updateProgress(`Creating array ${arrayName} (${band.level}×${members.length})`)
    await run(executor, MDADM, [
      '--create',
      mdDev,
      `--level=${band.level}`,
      `--raid-devices=${members.length}`,
      '--metadata=1.2',
      `--name=${arrayName}`,
      // Explicit, deterministic data offset (GT-5) — the default varies with
      // member size and the headroom backs backup-file-free reshapes (GT-6).
      ahrDataOffsetArg(band.heightBytes),
      // Explicit write-intent bitmap (mdadm only defaults it ≥100 GB members):
      // md's differential-resilver analog — a transiently-offline member
      // re-adds with a fast catch-up sync instead of a full rebuild.
      '--bitmap=internal',
      '--run',
      ...members,
    ])
    mdDevices.push(mdDev)
    arrayNames.push(arrayName)
  }

  // --- Pin names + monitor hook, then refresh the initramfs -------------------
  updateProgress('Pinning arrays in mdadm.conf')
  const pins: MdadmArrayPin[] = []
  for (const [i, arrayName] of arrayNames.entries()) {
    const res = await run(executor, MDADM, mdadmDetailExportArgs(mdDevices[i]))
    const uuid = parseMdadmDetailExport(res.stdout).uuid
    if (!uuid)
      throw new Error(`could not read the md UUID of ${mdDevices[i]} — refusing to pin without an identity`)
    pins.push({ name: arrayName, uuid })
  }
  await pinArrays(pins, opts.mdadmConfPath)
  await installProgramHook(undefined, opts.mdadmConfPath)
  // Early-boot assembly reads the conf baked into the initramfs
  // (ARRAY_PIN_REQUIRES_INITRAMFS) — the executor owns this side effect.
  updateProgress('Updating initramfs (mdadm.conf changed)')
  await run(executor, UPDATE_INITRAMFS, ['-u'])

  // --- LVM: PVs in band order → one VG → one LV -------------------------------
  updateProgress('Creating LVM stack (PVs → VG → LV)')
  for (const mdDev of mdDevices)
    await run(executor, PVCREATE, [mdDev])
  await run(executor, VGCREATE, [name, ...mdDevices])
  await run(executor, LVCREATE, ['-y', '-l', '100%FREE', '-n', `${name}-vol`, name])

  // --- btrfs on the single LV (filesystem ONLY — never btrfs-RAID) ------------
  const lvPath = ahrLvPath(name)
  updateProgress('Creating btrfs filesystem')
  await run(executor, MKFS_BTRFS, ['-L', name, '-d', 'single', '-m', 'dup', lvPath])

  // --- Subvolume layout (§12): @data (mounted) + @snapshots (outside) ---------
  // Mount the top-level briefly at the mountpoint dir, carve the two
  // subvolumes, unmount — the pool then mounts `subvol=@data`, so snapshots
  // live OUTSIDE the operator's tree and rollback is a subvolume swap.
  const mountpoint = spec.mountpoint ?? join(ahrMountBase(opts.mountBase), name)
  await mkdir(mountpoint, { recursive: true })
  updateProgress('Creating btrfs subvolume layout (@data, @snapshots)')
  await run(executor, MOUNT, ['-t', 'btrfs', '-o', 'subvolid=5', lvPath, mountpoint])
  try {
    await run(executor, BTRFS, ['subvolume', 'create', join(mountpoint, SUBVOL_DATA)])
    await run(executor, BTRFS, ['subvolume', 'create', join(mountpoint, SUBVOL_SNAPSHOTS)])
  }
  finally {
    await run(executor, UMOUNT, ['--', mountpoint])
  }

  // --- Mountpoint + fstab persistence + mount (subvol=@data) -------------------
  updateProgress(`Mounting at ${mountpoint}`)
  await editConfig(opts.fstabPath, (current) => {
    if (hasMount(current, mountpoint))
      throw new Error(`Mount '${mountpoint}' is already in /etc/fstab`)
    return addMount(current, ahrFstabEntry(name, mountpoint, true))
  })
  await run(executor, SYSTEMCTL, ['daemon-reload'])
  await run(executor, MOUNT, ['--', mountpoint])

  // Initial resync is NOT awaited — the pool is usable now; the read layer
  // shows the build progress as `resyncing`.
  updateProgress('Notifying PVE')
  await pveNotify(
    executor,
    'info',
    'AHR pool created',
    `Pool '${name}' (${tier === 'ahr1' ? '1-disk' : '2-disk'} fault tolerance, ${arrayNames.length} array${arrayNames.length === 1 ? '' : 's'}) was created and mounted at ${mountpoint}. The initial redundancy sync continues in the background; the pool is usable now.`,
  )

  return { created: name, mountpoint, arrays: arrayNames }
}

/**
 * Change a pool's mountpoint (route-validated: absolute, not reserved, no
 * collisions). Brief service interruption at the old path: umount → surgical
 * fstab rewrite → mount at the new path. The only mutable identity an AHR
 * pool has — everything else (md names, VG/LV) is fixed at creation.
 */
export async function changeAhrMountpoint(
  executor: CommandExecutor,
  pool: { name: string, mountpoint: string, mounted: boolean, subvolLayout: boolean },
  newMountpoint: string,
  updateProgress: (message: string) => void,
  opts: { fstabPath: string },
): Promise<{ mountpoint: string }> {
  const { name } = pool
  const lvPath = ahrLvPath(name)

  if (pool.mounted) {
    updateProgress(`Unmounting ${pool.mountpoint}`)
    await run(executor, UMOUNT, ['--', pool.mountpoint], { busyPath: pool.mountpoint })
  }

  updateProgress('Rewriting the fstab entry (surgical)')
  await editConfig(opts.fstabPath, (current) => {
    // The pool's line is found by mountpoint OR by LV spec (an unmounted or
    // hand-edited pool still gets its line replaced, never duplicated). The
    // pool's REAL layout carries through (§12): a subvol pool keeps
    // subvol=@data, a flat pool keeps its plain entry — the move never
    // fabricates a subvolume option the filesystem does not have.
    const existing = parseFstab(current).find(e => e.mountpoint === pool.mountpoint || e.spec === lvPath)
    const without = existing ? removeMount(current, existing.mountpoint) : current
    return addMount(without, ahrFstabEntry(name, newMountpoint, pool.subvolLayout))
  })
  await run(executor, SYSTEMCTL, ['daemon-reload'])

  updateProgress(`Mounting at ${newMountpoint}`)
  await mkdir(newMountpoint, { recursive: true })
  await run(executor, MOUNT, ['--', newMountpoint])
  // The old mountpoint directory stays (plain umount semantics — the mounts
  // feature's recorded decision).

  return { mountpoint: newMountpoint }
}
