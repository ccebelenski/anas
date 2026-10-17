import type { MountEntry } from '@anas/shared'
import { readFile } from 'node:fs/promises'
import { mountOptionTokens, parseFstab } from '../parsers/fstab.js'
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
 * cr.52s-a: this is the line ANAS WRITES (pool create, or a move of a pool
 * that had no line). A verb that re-mounts a pool (the remount, a snapshot
 * rollback's remount, the boot re-attach, a move) mounts the pool's line AS
 * STORED instead (`mountAhrPool`'s `line`) — these defaults stand in only for a
 * pool with no line, and the caller says so.
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

/** The fstab the daemon was configured with when a caller has no path to hand (the server's own default). */
export function defaultAhrFstabPath(): string {
  return process.env.ANAS_FSTAB_PATH ?? '/etc/fstab'
}

/**
 * The pool's OWN fstab line as stored, three-valued (cr.52s-a): `line` — the
 * active line whose spec is the pool's LV path; `none` — the file was read and
 * carries no such active line; `unreadable` — the file could not be read, which
 * is never reported as "no line" (a read that could not see never answers
 * "nothing there").
 */
export type AhrPoolLine
  = | { kind: 'line', entry: MountEntry }
    | { kind: 'none' }
    | { kind: 'unreadable', detail: string }

export async function readAhrPoolLine(fstabPath: string, name: string): Promise<AhrPoolLine> {
  let text: string
  try {
    text = await readFile(fstabPath, 'utf8')
  }
  catch (err) {
    return { kind: 'unreadable', detail: err instanceof Error ? err.message : String(err) }
  }
  const spec = ahrLvPath(name)
  const entry = parseFstab(text).find(e => e.spec === spec && !e.disabled)
  return entry ? { kind: 'line', entry } : { kind: 'none' }
}

/**
 * Mount a pool DIRECTLY (cr.52r D3), through a directory the daemon itself
 * opened — the kernel resolves `/proc/self/fd/3` to exactly the directory, so a
 * parent swapped after the open cannot redirect the mount — at `pool.mountpoint`
 * (the path the caller's gate checked).
 *
 * The spec, type and options are the pool's OWN fstab line AS STORED
 * (`mountOptionTokens(line)`, cr.52s-a review defect 6): the operator's
 * `noatime`, `compress=`, … ride the argv exactly as the line carries them, the
 * way `mount -- <lv>` took them from fstab before cr.52r. `ahrFstabEntry` (ANAS's
 * defaults) is used ONLY when the pool has no line (`line === null`) — the
 * caller says so in its progress/log. Throws on a failed mount (and when the
 * directory is missing/broken at argv time).
 */
export async function mountAhrPool(
  executor: Parameters<typeof mountThroughOpenedDir>[0],
  pool: { name: string, mountpoint: string, subvolLayout: boolean },
  line: MountEntry | null,
): Promise<void> {
  const entry = line ?? ahrFstabEntry(pool.name, pool.mountpoint, pool.subvolLayout)
  const args = ['-c', '-t', entry.fstype, '-o', mountOptionTokens(entry), '--', entry.spec]
  const r = await mountThroughOpenedDir(executor, pool.mountpoint, args)
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `mount exited ${r.exitCode}`)
}

/**
 * Read the pool's line for a verb that UNMOUNTS and then re-mounts it (the
 * remount, the snapshot rollback): call BEFORE the unmount, so an unreadable
 * fstab refuses while nothing has been done. Returns the stored line, or null
 * (no line: ANAS's defaults) after saying so through `say`.
 */
export async function ahrPoolLineForRemount(
  fstabPath: string,
  name: string,
  say: (message: string) => void,
): Promise<MountEntry | null> {
  const line = await readAhrPoolLine(fstabPath, name)
  if (line.kind === 'unreadable')
    throw new Error(`could not read ${fstabPath} for pool '${name}''s own mount line (${line.detail}) — nothing was unmounted`)
  if (line.kind === 'none') {
    say(`Pool '${name}' has no line in ${fstabPath} — re-mounting with ANAS's default options`)
    return null
  }
  return line.entry
}
