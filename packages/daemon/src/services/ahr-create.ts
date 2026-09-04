import type { AhrType, MountEntry } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { MdadmArrayPin } from '../parsers/mdadm-conf.js'
import type { AhrBandSlice } from './ahr-geometry.js'
import type { AhrLayoutDisk } from './ahr-layout.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { addMount, addMountOption, hasMount, parseFstab, removeMount } from '../parsers/fstab.js'
import { mdadmDetailExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { ROLLED_BACK_MARKER } from './ahr-create-status.js'
import { destroyAhrPool } from './ahr-destroy.js'
import { LVM_MIXED_BLOCK_ARGS, run } from './ahr-exec.js'
import { ahrDataOffsetArg, planDiskPartitions } from './ahr-geometry.js'
import { floorToGranularity, planFreshLayout } from './ahr-layout.js'
import { installProgramHook, pinArrays } from './ahr-mdadm-conf.js'
import { ahrLvPath, ahrMountBase } from './ahr-paths.js'
import { SUBVOL_DATA, SUBVOL_SNAPSHOTS } from './ahr-snapshots.js'
import { editConfig } from './config-writer.js'
import { pveNotify } from './pve-notify.js'

export { ahrLvPath, ahrMountBase, DEFAULT_AHR_MOUNT_BASE } from './ahr-paths.js'

/**
 * AHR pool creation (Epic 11 + AHR, docs/AHR-DESIGN.md §4/§2.6) — the CREATE
 * mutation behind POST /v1/ahr. Builds the whole stack, bottom-up:
 *
 *   wipe (wipefs + sgdisk --zap-all, GT-12: stale foreign labels wedge hosts)
 *     → GPT band slices (planFreshLayout + planDiskPartitions; ONLY protected
 *       bands get partitions — §2.6, unused regions stay raw)
 *     → one mdadm array per band, metadata 1.2, deterministic name
 *       `<pool>-r<band>`, EXPLICIT --data-offset (GT-5/GT-6: the headroom is
 *       load-bearing for backup-file-free reshapes), then `wipefs -a` on the
 *       fresh md device (issue #17: PV labels at the data offset outlive every
 *       partition-level wipe and resurrect the old VG on an identical recreate)
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

const WHITESPACE_RE = /\s+/

/**
 * btrfs sector size, stated explicitly rather than inherited from the CPU page
 * size. It must be ≥ the LV's logical block size, which on a mixed-media pool
 * is the 4096 of its 4Kn band (issue #8) — 4 KiB satisfies every AHR stack.
 */
const BTRFS_SECTOR_SIZE = 4096

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
      for (const holder of holders.stdout.split(WHITESPACE_RE).filter(h => h.startsWith('md')))
        await executor.exec(MDADM, ['--stop', `/dev/${holder}`])
    }
    await executor.exec(WIPEFS, ['-a', partPath])
  }
  await run(executor, UDEVADM, ['settle'])
}

/**
 * The ONE fstab option that keeps an AHR pool ahead of the LIO restore service
 * (story `iscsi.8`, promoted from the standing `iscsi.5` candidate).
 *
 * `rtslib-fb-targetctl.service` gets an ordering drop-in from `install.sh` that
 * names every ZFS anchor there is — and there is no equivalent for AHR. An AHR
 * pool comes up as md assembly (udev) → LVM activation (udev) → an ordinary
 * fstab mount, with no ANAS unit anywhere in that path, and the generated mount
 * unit is named after the pool's mountpoint, so no static `After=` in a drop-in
 * can name it. Worse, ANAS writes AHR entries with `nofail` (a pool must never
 * hold the host's boot hostage), and systemd deliberately does NOT order a
 * `nofail` mount before `local-fs.target` — so even the weak anchor the drop-in
 * has does not cover it.
 *
 * `x-systemd.before=` on the fstab line is the mechanism that does: the fstab
 * generator turns it into a `Before=` on THAT mount unit, which is the only
 * place the pool's identity exists. It was a candidate until live-proof F2
 * showed what losing the race actually costs — not a missing LUN, which is
 * visible, but a LUN serving zeros, which is not.
 *
 * The flip side of that ordering edge is what live-proof O3 measured: if the
 * pool's LV device NEVER appears (its disks were pulled), the `nofail` mount
 * does not fail the boot, but its `.device` job runs the full
 * `DefaultTimeoutStartSec` (~90 s) before giving up — and because
 * `rtslib-fb-targetctl.service` (and `multi-user.target`) are ordered behind
 * the mount, every iSCSI LUN on the node comes back ~90 s late for a reason
 * nothing announces. {@link AHR_ISCSI_DEVICE_TIMEOUT_OPTION} bounds that wait.
 */
export const AHR_ISCSI_ORDERING_OPTION = 'x-systemd.before=rtslib-fb-targetctl.service'

/**
 * The bound on how long the AHR mount waits for its BACKING DEVICE at boot
 * (live-proof O3). The 90 s stall O3 measured is not the mount's own timeout —
 * it is the `.device` job the mount waits on, so `x-systemd.device-timeout=` is
 * the knob that bounds it (`x-systemd.mount-timeout` would not: the mount never
 * gets far enough to time out, it is blocked waiting for a device that will
 * never come). The fstab generator turns this option into
 * `JobTimeoutSec=`/`TimeoutStartSec=` on the generated `.device` unit, so a
 * permanently-absent pool gives up here instead of at the 90 s default and
 * releases `rtslib-fb-targetctl.service` (and `multi-user.target`) that much
 * sooner.
 *
 * The value is a floor over realistic PRESENT-device readiness, not an
 * aggressively short one: AHR pools are typically spinning disks, and staggered
 * spin-up + md assembly + LVM activation can take tens of seconds on a cold
 * boot even when every disk is there. Abandoning a slow-but-present pool would
 * be the WORSE bug — LIO would restore before the mount is up and place the
 * 0-byte placeholder {@link AHR_ISCSI_ORDERING_OPTION} exists to prevent. 45 s
 * halves the absent-device stall while staying comfortably above any legitimate
 * present-device readiness, so the success path is unchanged; only a device
 * that is genuinely never coming gives up sooner.
 */
export const AHR_ISCSI_DEVICE_TIMEOUT_OPTION = 'x-systemd.device-timeout=45s'

/**
 * The canonical fstab entry for a pool: LV device, btrfs, nofail. When
 * `subvolLayout` is true (every pool created since §12) the entry carries
 * `subvol=@data` so the mountpoint mounts the data subvolume, not the
 * top-level — snapshots live under `@snapshots`, outside the mounted tree. A
 * pre-§12 flat pool has no `@data` subvolume, so its entry omits the option;
 * `changeAhrMountpoint` MUST pass the pool's real layout so a mountpoint move
 * never rewrites a flat pool's line to reference a subvolume it lacks.
 *
 * Every pool created from now on also carries {@link AHR_ISCSI_ORDERING_OPTION}
 * and {@link AHR_ISCSI_DEVICE_TIMEOUT_OPTION}, whether or not it will ever hold
 * a LUN. Together they cost a boot-time ordering edge on a service that is
 * usually not installed (systemd ignores a `Before=` on a unit that does not
 * exist) plus a bound on how long an absent device holds the boot (O3); they
 * are the difference between a pool that is mounted when LIO restores and one
 * that silently is not, without letting a pool that will never assemble stall
 * the boot for the full 90 s default.
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
      passthrough: subvolLayout
        ? `subvol=${SUBVOL_DATA},${AHR_ISCSI_ORDERING_OPTION},${AHR_ISCSI_DEVICE_TIMEOUT_OPTION}`
        : `${AHR_ISCSI_ORDERING_OPTION},${AHR_ISCSI_DEVICE_TIMEOUT_OPTION}`,
    },
    dump: 0,
    pass: 0,
  }
}

/**
 * Add {@link AHR_ISCSI_ORDERING_OPTION} and
 * {@link AHR_ISCSI_DEVICE_TIMEOUT_OPTION} to an EXISTING pool's fstab line,
 * once, surgically (story `iscsi.8`; device-timeout from live-proof O3).
 *
 * Called at the moment an image LUN is placed on an AHR pool — the moment the
 * ordering starts to matter and not before. Pools that will never hold a LUN are
 * left exactly as they are: ANAS is a guest in `/etc/fstab`, and a mass
 * migration that edited every AHR line on upgrade would be an owner's move.
 *
 * The line is found by MOUNTPOINT or by LV spec, the same pair
 * `changeAhrMountpoint` uses, so an unmounted or hand-edited pool is still
 * matched. `addMountOption` rewrites the options column and nothing else, one
 * token at a time, and is a byte-identical no-op when a token is already there —
 * so this is safe on the second, third and hundredth LUN, and a pool that
 * predates the device-timeout gains it the next time a LUN lands on it.
 *
 * Returns whether the file changed. Never throws: a pool with no fstab line
 * (someone mounts it by hand) simply gets nothing, and adding a LUN must not
 * fail over a boot-ordering nicety.
 */
export async function ensureAhrTargetOrdering(
  executor: CommandExecutor,
  fstabPath: string,
  pool: { name: string, mountpoint: string },
): Promise<boolean> {
  let changed = false
  try {
    await editConfig(fstabPath, (current) => {
      const lvPath = ahrLvPath(pool.name)
      const existing = parseFstab(current).find(e => e.mountpoint === pool.mountpoint || e.spec === lvPath)
      if (!existing)
        return current
      // Two tokens, each added idempotently: the ordering edge (iscsi.8) and the
      // bound on how long an absent device holds the boot (O3). Order matches the
      // create-time entry — `before=` then `device-timeout=`.
      const withOrdering = addMountOption(current, existing.mountpoint, AHR_ISCSI_ORDERING_OPTION)
      const next = addMountOption(withOrdering, existing.mountpoint, AHR_ISCSI_DEVICE_TIMEOUT_OPTION)
      changed = next !== current
      return next
    })
    // The fstab generator owns the mount unit; a reload is how a changed line
    // becomes a changed unit without a reboot. Only on a real change, and never
    // fatal — the ordering it establishes is for the NEXT boot anyway.
    if (changed)
      await executor.exec(SYSTEMCTL, ['daemon-reload'])
  }
  catch {
    return false
  }
  return changed
}

/** One disk as the create planned it — the rollback's list of what to scrub. */
interface PlannedDisk {
  id: string
  devPath: string
  /** band → GPT partition number on this disk. */
  partNumberByBand: Map<number, number>
}

/**
 * What the in-flight create has touched, for the automatic rollback (issue
 * #11). Deliberately tiny and in-memory only: it lives exactly as long as the
 * job that owns it. This is NOT shadow state — nothing reads it to describe the
 * system, and nothing survives the job.
 */
interface CreateLedger {
  /**
   * Whether the FIRST destructive command has run. Before it, a failure has
   * changed nothing and must simply propagate; after it, the selected disks
   * hold only what this attempt built.
   */
  destructive: boolean
  /** The pool mountpoint, resolved up front so rollback has it at every stage. */
  mountpoint: string
  /** Disks recorded as the plan reaches them — including a half-partitioned one. */
  planned: PlannedDisk[]
}

/**
 * The create pipeline itself. Everything it touches is recorded in `ledger` as
 * it goes, so a failure at ANY point can be rolled back by the caller — see
 * {@link createAhrPool}.
 */
async function executeCreate(
  executor: CommandExecutor,
  spec: AhrCreateSpec,
  updateProgress: (message: string) => void,
  opts: AhrCreateOptions,
  ledger: CreateLedger,
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
  const planned = ledger.planned
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

    // Recorded BEFORE the disk is touched: rollback must know about a disk
    // whose wipe or partitioning failed HALFWAY, not just the finished ones.
    planned.push({
      id: disk.id,
      devPath,
      partNumberByBand: new Map(specs.map(s => [s.band, s.number])),
    })

    updateProgress(`Wiping ${disk.id} (${i + 1}/${disks.length})`)
    // THE POINT OF NO RETURN. Everything before this is planning; from here on
    // the selected disks carry only what THIS attempt put there, which is what
    // makes an automatic rollback safe (issue #11).
    ledger.destructive = true
    await run(executor, WIPEFS, ['-a', devPath])
    await run(executor, SGDISK, ['--zap-all', devPath])
    updateProgress(`Partitioning ${disk.id} (${specs.length} band slice${specs.length === 1 ? '' : 's'})`)
    await run(executor, SGDISK, [...specs.flatMap(s => s.sgdiskArgs), devPath])
  }
  updateProgress('Settling udev (partition device nodes)')
  // `udevadm settle` IS sufficient here, unlike on the expansion path (issue
  // #12, which needs `partx -a`). The difference is holders, not luck: create
  // only ever runs on disks the inventory reported 'available' and has just
  // wiped, so nothing holds them and sgdisk's whole-table BLKRRPART re-read
  // succeeds — the partitions exist by the time udev is asked about them.
  // Expansion partitions disks whose OTHER slices are live md members, and the
  // kernel refuses to re-read a held disk's table. If create ever gains the
  // ability to partition an in-use disk, it needs the expansion path's
  // partx-then-verify treatment.
  await run(executor, UDEVADM, ['settle'])

  // --- Clear ghost md state on the fresh partitions (§2.6) --------------------
  updateProgress('Clearing stale md signatures on new partitions')
  await clearGhostMdSignatures(
    executor,
    planned.flatMap(disk => Array.from(disk.partNumberByBand.values(), partNumber => ({ diskId: disk.id, partNumber }))),
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
    // Wipe the fresh array's signatures IMMEDIATELY, unconditionally: a device
    // ANAS created one command ago can hold nothing but residue. That residue is
    // real, and NOTHING ELSE REACHES IT — an LVM PV label + VG metadata live at
    // the md DATA OFFSET (~128 MiB deep, INSIDE the member partitions), far
    // below anything partition- or disk-level wiping touches, and destroy's
    // `pvremove` can only clear PVs that LVM could still SEE. Recreating the
    // same deterministic geometry re-exposes the dead pool's labels byte for
    // byte, LVM "finds" the old VG, and pvcreate rightly refuses without -ff
    // (issue #17, pve5 2026-08-09).
    // Wiping here — before mdadm --detail, the pins, and any udev/LVM scan —
    // makes create immune to the whole resurrection class, whatever destroy
    // could or could not reach.
    await run(executor, WIPEFS, ['-a', mdDev])
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
  // LVM_MIXED_BLOCK_ARGS on every call: a mixed-media pool's bands legitimately
  // differ in logical block size (a 4Kn member makes its band 4096), which LVM
  // refuses by default — issue #8, where a 4Kn + 512e create died at vgcreate
  // AFTER the disks were wiped and the initial sync was already running.
  updateProgress('Creating LVM stack (PVs → VG → LV)')
  for (const mdDev of mdDevices)
    await run(executor, PVCREATE, [...LVM_MIXED_BLOCK_ARGS, mdDev])
  await run(executor, VGCREATE, [...LVM_MIXED_BLOCK_ARGS, name, ...mdDevices])
  await run(executor, LVCREATE, [...LVM_MIXED_BLOCK_ARGS, '-y', '-l', '100%FREE', '-n', `${name}-vol`, name])

  // --- btrfs on the single LV (filesystem ONLY — never btrfs-RAID) ------------
  // --sectorsize 4096 is EXPLICIT, not inherited from the CPU page size: it is
  // what makes a mixed-block-size LV safe (4096 ≥ the LV's stacked logical
  // block size, always), so the guarantee must not depend on the host's arch.
  const lvPath = ahrLvPath(name)
  updateProgress('Creating btrfs filesystem')
  await run(executor, MKFS_BTRFS, ['-L', name, '-d', 'single', '-m', 'dup', '--sectorsize', String(BTRFS_SECTOR_SIZE), lvPath])

  // --- Subvolume layout (§12): @data (mounted) + @snapshots (outside) ---------
  // Mount the top-level briefly at the mountpoint dir, carve the two
  // subvolumes, unmount — the pool then mounts `subvol=@data`, so snapshots
  // live OUTSIDE the operator's tree and rollback is a subvolume swap.
  const { mountpoint } = ledger
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
 * Create an AHR pool, rolling the partial stack back if anything fails (issue
 * #11).
 *
 * WHY AUTOMATIC TEARDOWN IS SAFE HERE, and nowhere else in ANAS: create WIPES
 * the selected disks as its first destructive act. From that instant the disks
 * contain only what this very attempt built, so tearing it down can destroy no
 * operator data — the alternative (leaving it) strands the disks in a half-built
 * state that no verb but a manual Destroy can clear, while the useless initial
 * sync grinds on for hours.
 *
 * The teardown REUSES {@link destroyAhrPool} — the same checks-then-acts path
 * the operator's own Destroy takes, proven on pve5 against a half-built
 * mid-recovery stack. There is deliberately no second teardown implementation to
 * drift out of step with the first.
 *
 * It calls the SERVICE, not the route: the 409 confirm gate exists to make an
 * operator state their intent to destroy data that is theirs. Here the job is
 * cleaning up what it ITSELF created seconds ago, on disks the operator already
 * confirmed for wiping when they started the create. A second confirmation would
 * have nothing new to tell them, and there is no operator in the loop to answer
 * it — the job is already failing.
 *
 * The job always fails with the ORIGINAL error (the actual diagnosis), annotated
 * with what happened to the partial pool. If the rollback ALSO fails, both are
 * reported: the original first, because it is still the thing that went wrong.
 *
 * KNOWN LIMITATION (accepted, out of scope): this is in-process. A daemon crash
 * or restart mid-create cannot run it, and the boot scan has no create branch
 * (unlike expansions, which persist an intent). Such a pool surfaces as `failed`
 * with Destroy available — visible and actionable, just not automatic.
 */
export async function createAhrPool(
  executor: CommandExecutor,
  spec: AhrCreateSpec,
  updateProgress: (message: string) => void,
  opts: AhrCreateOptions,
): Promise<{ created: string, mountpoint: string, arrays: string[] }> {
  const ledger: CreateLedger = {
    destructive: false,
    mountpoint: spec.mountpoint ?? join(ahrMountBase(opts.mountBase), spec.name),
    planned: [],
  }

  try {
    return await executeCreate(executor, spec, updateProgress, opts, ledger)
  }
  catch (err) {
    const original = err instanceof Error ? err.message : String(err)
    // Nothing destructive ran — the disks are untouched and there is nothing to
    // undo. Propagate the diagnosis unchanged; annotating it would imply a
    // cleanup that never needed to happen.
    if (!ledger.destructive)
      throw err

    updateProgress('Create FAILED — rolling back the partial pool')
    let rollbackError: string | null = null
    try {
      await destroyAhrPool(
        executor,
        {
          name: spec.name,
          // `mounted: true` lets destroy CONSIDER the mountpoint; its own live
          // findmnt check decides whether anything is actually mounted, so this
          // is correct at every stage — before the first mount and after it.
          mounted: true,
          mountpoint: ledger.mountpoint,
          disks: ledger.planned.map(d => ({
            id: d.id,
            partitions: Array.from(d.partNumberByBand.values(), n => ({ device: `/dev/disk/by-id/${d.id}-part${n}` })),
          })),
        },
        m => updateProgress(`Rollback: ${m}`),
        { fstabPath: opts.fstabPath, mdadmConfPath: opts.mdadmConfPath },
      )
    }
    catch (rbErr) {
      rollbackError = rbErr instanceof Error ? rbErr.message : String(rbErr)
    }

    // Tell the operator either way — a create that failed while they were not
    // watching must never be discoverable only by reading job history. PVE's own
    // notification channel is the one that survives a daemon restart.
    await pveNotify(
      executor,
      'warning',
      'AHR pool creation failed',
      rollbackError === null
        ? `Creating pool '${spec.name}' failed: ${original}\n\nThe partial pool was rolled back — the selected disks are blank and the create can be retried.`
        : `Creating pool '${spec.name}' failed: ${original}\n\nThe automatic rollback ALSO failed: ${rollbackError}\n\nThe partial pool is still on the disks — destroy it from the Hybrid RAID view before retrying.`,
    ).catch(() => {
      // Best-effort: a notification failure must never mask the real error.
    })

    if (rollbackError === null)
      throw new Error(`${original}${ROLLED_BACK_MARKER}`)
    throw new Error(`${original} — the automatic rollback ALSO FAILED: ${rollbackError}; the partial pool is still on the disks and must be destroyed manually before retrying`)
  }
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
