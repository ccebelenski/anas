import type { MountEntry } from '@anas/shared'
import { mountOptionTokens } from '../parsers/fstab.js'
import { ahrLvPath } from './ahr-paths.js'
import { mountThroughOpenedDir } from './mounts.js'

/** The `@data` subvolume — the mounted tree of a subvol-layout pool (§12). */
export const SUBVOL_DATA = '@data'
/** The `@snapshots` subvolume — the snapshot home, outside the mounted tree. */
export const SUBVOL_SNAPSHOTS = '@snapshots'

/**
 * The fstab option ordering AHR pool mounts after the iSCSI target service
 * (story iscsi.8): LIO restores its LUNs from image files that live ON the
 * pool, so the pool's mount unit must start BEFORE rtslib-fb-targetctl.service
 * or LIO restores zero-byte placeholders. `x-systemd.before=` on the fstab line
 * is how the generator orders the generated `.mount` unit.
 */
export const AHR_ISCSI_ORDERING_OPTION = 'x-systemd.before=rtslib-fb-targetctl.service'

/**
 * The bound on how long the AHR mount waits for its BACKING DEVICE at boot
 * (live-proof O3). The 90 s stall O3 measured is not the mount's own timeout —
 * it is the `.device` job the mount waits on, so `x-systemd.device-timeout=` is
 * the knob that bounds it. The fstab generator turns this option into
 * `JobTimeoutSec=`/`TimeoutStartSec=` on the generated `.device` unit. 45 s
 * halves the absent-device stall while staying comfortably above any legitimate
 * present-device readiness.
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
 *
 * cr.52r D3: this entry is ALSO what the daemon mounts DIRECTLY (through an
 * opened directory, `mountThroughOpenedDir`) when a verb re-mounts a pool — the
 * remount, a snapshot rollback's remount and the boot re-attach mount the pool's
 * own configured line, never an invented mount.
 */
export function ahrFstabEntry(name: string, mountpoint: string, subvolLayout: boolean): MountEntry {
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
 * Mount a pool DIRECTLY from its configured fstab entry (cr.52r D3), through a
 * directory the daemon itself opened — the kernel resolves `/proc/self/fd/3` to
 * exactly the directory, so a parent swapped after the open cannot redirect the
 * mount. The spec and options are the pool's own line re-serialized
 * (`mountOptionTokens`), so the daemon never invents a mount: it re-runs the
 * one the node has. Rejects when the caller's job gate did not refuse first but
 * the directory is missing/broken at argv time. Throws on a failed mount.
 */
export async function mountAhrPool(
  executor: Parameters<typeof mountThroughOpenedDir>[0],
  pool: { name: string, mountpoint: string, subvolLayout: boolean },
): Promise<void> {
  const entry = ahrFstabEntry(pool.name, pool.mountpoint, pool.subvolLayout)
  const args = ['-c', '-t', entry.fstype, '-o', mountOptionTokens(entry), '--', entry.spec]
  const r = await mountThroughOpenedDir(executor, pool.mountpoint, args)
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `mount exited ${r.exitCode}`)
}
