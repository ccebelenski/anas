import type { CommandExecutor } from '../executor/types.js'
import { parseFindmnt } from '../parsers/findmnt.js'
import { parseFstab, removeMount } from '../parsers/fstab.js'
import { LVS_ARGS, parseLvsReport, parsePvsReport, parseVgsReport, PVS_ARGS, VGS_ARGS } from '../parsers/lvm-report.js'
import { getArrays, parseMdadmConfDoc } from '../parsers/mdadm-conf.js'
import { matchAhrArrayName, mdadmDetailExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { run } from './ahr-exec.js'
import { DEFAULT_MDADM_CONF, unpinArrays } from './ahr-mdadm-conf.js'
import { ahrLvPath } from './ahr-paths.js'
import { AHR_FINDMNT_ARGS } from './ahr-topology.js'
import { editConfig, readConfig } from './config-writer.js'

/**
 * AHR pool destruction (Epic 11 + AHR, docs/AHR-DESIGN.md §4) — the DESTROY
 * mutation behind DELETE /v1/ahr/:name. Tears the stack down top-down:
 *
 *   umount → fstab line removed (surgical) → lvremove/vgremove/pvremove
 *     → mdadm --stop per array → --zero-superblock per member partition
 *     → sgdisk --zap-all per member DISK → unpin mdadm.conf ARRAY lines
 *     → update-initramfs -u
 *
 * Every step CHECKS current state before acting, so a re-run against a
 * half-destroyed pool is safe: already-absent layers are skipped, not errors.
 * The mountpoint directory is left in place (the mounts precedent — an empty
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
): Promise<{ destroyed: string }> {
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
  updateProgress('Zeroing md superblocks')
  for (const disk of pool.disks) {
    for (const part of disk.partitions) {
      // Tolerated failure: an already-zeroed or vanished partition is exactly
      // the half-destroyed state a re-run must survive.
      await executor.exec(MDADM, ['--zero-superblock', part.device])
    }
  }

  // --- Disks: drop the partition tables ---------------------------------------
  for (const disk of pool.disks) {
    updateProgress(`Zapping partition table on ${disk.id}`)
    await run(executor, SGDISK, ['--zap-all', `/dev/disk/by-id/${disk.id}`])
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

  return { destroyed: name }
}
