import type { MountEntry } from '@anas/shared'
import { directMountOptionArgs, parseFstab } from '../parsers/fstab.js'
import { ahrLvPath } from './ahr-paths.js'
import { readFstab } from './fstab-file.js'
import { mountThroughOpenedDir } from './mounts.js'

/** The `@data` subvolume — the mounted tree of a subvol-layout pool (§12). */
export const SUBVOL_DATA = '@data'
/** The `@snapshots` subvolume — the snapshot home, outside the mounted tree. */
export const SUBVOL_SNAPSHOTS = '@snapshots'

const LEADING_SLASHES_RE = /^\/+/

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

/** One `subvol=` token's value, its leading `/` dropped (btrfs accepts both spellings). */
function subvolOption(entry: MountEntry): string | null {
  for (const token of entry.options.passthrough.split(',')) {
    const t = token.trim()
    if (t.startsWith('subvol='))
      return t.slice('subvol='.length).replace(LEADING_SLASHES_RE, '')
  }
  return null
}

/**
 * The `subvol=` value from a mount's option string, e.g. "/@data" or "/".
 * Null when the option is absent (non-btrfs, or an old kernel that omits it).
 */
export function subvolFromMountOptions(options: string): string | null {
  for (const token of options.split(',')) {
    const eq = token.indexOf('=')
    if (eq > 0 && token.slice(0, eq) === 'subvol')
      return token.slice(eq + 1)
  }
  return null
}

/**
 * Whether a mount's options say it is the §12 subvolume layout — i.e. the
 * filesystem is mounted with `subvol=@data` (btrfs normalizes to `/@data`).
 * A flat pool mounts the top-level (`subvol=/`, `subvolid=5`) and returns
 * false. The mount is the source of truth (§5.3) — nothing is precomputed.
 */
export function isSubvolLayoutMount(options: string): boolean {
  const subvol = subvolFromMountOptions(options)
  if (subvol === null)
    return false
  const normalized = subvol.replace(LEADING_SLASHES_RE, '') // "/@data" → "@data"
  return normalized === SUBVOL_DATA
}

/**
 * Is `entry` the Previous Versions `@snapshots` line (smbsvc.1)? It carries
 * the pool's own LV spec, so the spec alone never tells it from the pool's
 * line (cr3 AHR-CORE-M3); the subvolume it mounts does.
 */
export function isAhrSnapshotsLine(entry: MountEntry): boolean {
  return subvolOption(entry) === SUBVOL_SNAPSHOTS
}

/**
 * THE rule for "the pool's OWN fstab line" (cr3 AHR-CORE-M3), one predicate
 * for every reader and writer that looks for it: the line whose spec is the
 * pool's LV path and that is NOT the `@snapshots` line. Before, each reader
 * took the first line with the LV spec — after a Change mountpoint moved the
 * pool's line below the `@snapshots` one, the Remount verb and the snapshot
 * rollback re-mounted the POOL `ro,subvol=@snapshots`, the boot cache rung
 * mounted the wrong line, and a second Change mountpoint moved the
 * `@snapshots` line instead of the pool's.
 */
export function isAhrPoolOwnLine(entry: MountEntry, name: string): boolean {
  return entry.spec === ahrLvPath(name) && !isAhrSnapshotsLine(entry)
}

/**
 * The pool's OWN fstab line as stored, three-valued (cr.52s-a): `line` — the
 * active line whose spec is the pool's LV path; `none` — the file was read and
 * carries no such active line; `unreadable` — the file could not be read, which
 * is never reported as "no line" (a read that could not see never answers
 * "nothing there"). A missing file is answered `unreadable` here too (detail
 * `the file does not exist`): a pool whose fstab is gone is never remounted on
 * ANAS's defaults as if it simply had no line.
 */
export type AhrPoolLine
  = | { kind: 'line', entry: MountEntry }
    | { kind: 'none' }
    | { kind: 'unreadable', detail: string }

export async function readAhrPoolLine(fstabPath: string, name: string): Promise<AhrPoolLine> {
  const read = await readFstab(fstabPath)
  if (read.state === 'unreadable')
    return { kind: 'unreadable', detail: read.reason }
  if (read.state === 'absent')
    return { kind: 'unreadable', detail: 'the file does not exist' }
  const entry = parseFstab(read.text).find(e => isAhrPoolOwnLine(e, name) && !e.disabled)
  return entry ? { kind: 'line', entry } : { kind: 'none' }
}

/**
 * Mount a pool DIRECTLY (cr.52r D3), through a directory the daemon itself
 * opened — the kernel resolves `/proc/self/fd/3` to exactly the directory, so a
 * parent swapped after the open cannot redirect the mount — at `pool.mountpoint`
 * (the path the caller's gate checked).
 *
 * The spec, type and options are the pool's OWN fstab line AS STORED
 * (`directMountOptionTokens(line)`, cr.52s-a review defect 6): the operator's
 * `noatime`, `compress=`, … ride the argv exactly as the line carries them, the
 * way `mount -- <lv>` took them from fstab before cr.52r — minus the
 * userspace-only tokens (`nofail`, `x-systemd.*`, …), which the LINE keeps but
 * the direct mount drops (cr.52s-e, the utab fact from cr.52s-d). `ahrFstabEntry` (ANAS's
 * defaults) is used ONLY when the pool has no line (`line === null`) — the
 * caller says so in its progress/log. Throws on a failed mount (and when the
 * directory is missing/broken at argv time).
 */
export async function mountAhrPool(
  executor: Parameters<typeof mountThroughOpenedDir>[0],
  pool: { name: string, mountpoint: string, subvolLayout: boolean | null },
  line: MountEntry | null,
): Promise<void> {
  // cr3 review 3: ANAS's defaults carry the layout (`subvol=@data` or not); a
  // layout that could not be read (null) is never guessed into a mount. Null
  // means the pool is not mounted, or the kernel mount table did not answer.
  if (line === null && pool.subvolLayout === null)
    throw new Error(`pool '${pool.name}' has no fstab line, and its subvolume layout could not be read (the pool is not mounted, or the kernel mount table did not answer) — not mounting it with guessed options. Mount it from the Hybrid RAID view if it is not mounted, or retry once the kernel mount table can be read`)
  const entry = line ?? ahrFstabEntry(pool.name, pool.mountpoint, pool.subvolLayout === true)
  const args = ['-c', '-t', entry.fstype, ...directMountOptionArgs(entry), '--', entry.spec]
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
    throw new Error(`could not read ${fstabPath} for the mount line of pool '${name}' (${line.detail}) — nothing was unmounted`)
  if (line.kind === 'none') {
    say(`Pool '${name}' has no line in ${fstabPath} — re-mounting with ANAS's default options`)
    return null
  }
  return line.entry
}
