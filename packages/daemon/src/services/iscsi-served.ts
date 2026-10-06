/**
 * The served device is the LUN's identity (story `ident.2`, audit #8 #9 #10).
 *
 * A LUN's backstore records its backing as a PATH string (`udev_path`,
 * saveconfig `dev`), but LIO serves whatever it OPENED at create time. A `zfs
 * rename` of the volume plus a new volume at the old name leaves the two
 * naming different devices while every read still looks right: the size the
 * read layer reports is the served device's (sysfs, via the kernel name), and
 * the path now names the new volume. A "grow" computed from the served size
 * then shrinks the new volume, a delete with destroyBacking destroys it, and an
 * image restore writes into it.
 *
 * So every verb that acts on a LUN's backing object compares the two first:
 *
 *   - a block backstore: the `Major: M Minor: m` its configfs `info` reports
 *     (the device LIO opened) must equal `stat(path).rdev`;
 *   - a fileio backstore: LIO keeps the file open in the kernel and reports no
 *     inode, so the identity is the path's `dev:ino`, captured at the request
 *     and compared again inside the job.
 *
 * {@link servedDevice} is the ONE comparison (resize, destroyBacking, repair and
 * image restore all call it), and {@link reverifyServedLun} is the ONE job-time
 * re-read: under `withIscsiLock` the LUN at the index must still carry the same
 * serial, backstore, path and device, so a confirmed or queued job can never act
 * on a LUN that took over the index or a volume that took over the path.
 */

import type { IscsiLun, IscsiTargetDetail } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { ConfigfsBackstore, LioLiveState } from './iscsi-configfs.js'
import type { IscsiRefusal } from './iscsi-mutate.js'
import type { IscsiPaths } from './iscsi.js'
import { stat } from 'node:fs/promises'
import { normalizePlugin } from './iscsi-configfs.js'
import { readIscsiState } from './iscsi-mutate.js'

/** What one `stat` of a backing path says about the object it names. */
export interface DeviceStat {
  /** `block` for a block device node, `file` for a regular file, else `other`. */
  type: 'block' | 'file' | 'other'
  /** `st_rdev` split into major:minor (meaningful for a block device only). */
  rdevMajor: number
  rdevMinor: number
  /** `st_dev` and `st_ino` as decimal strings (bigint-exact). */
  dev: string
  ino: string
  /** `st_size` (a regular file's length; 0 for a device node). */
  size: number
}

/** Reads a path's identity; null when it does not resolve or cannot be read. */
export type StatDevice = (path: string) => Promise<DeviceStat | null>

/**
 * Split a Linux `dev_t` into major and minor — glibc's `gnu_dev_major` /
 * `gnu_dev_minor` encoding (12-bit major and 20-bit minor, split across the
 * low and high words). BigInt so a 64-bit value is exact.
 */
export function decodeDevT(rdev: bigint): { major: number, minor: number } {
  const major = ((rdev >> 8n) & 0xFFFn) | ((rdev >> 32n) & ~0xFFFn)
  const minor = (rdev & 0xFFn) | ((rdev >> 12n) & ~0xFFn)
  return { major: Number(major), minor: Number(minor) }
}

/** The real `stat` (follows the `/dev/zvol/...` symlink to the device node). */
export async function statDevice(path: string): Promise<DeviceStat | null> {
  if (!path.startsWith('/'))
    return null
  try {
    const st = await stat(path, { bigint: true })
    const { major, minor } = decodeDevT(st.rdev)
    return {
      type: st.isBlockDevice() ? 'block' : st.isFile() ? 'file' : 'other',
      rdevMajor: major,
      rdevMinor: minor,
      dev: st.dev.toString(),
      ino: st.ino.toString(),
      size: Number(st.size),
    }
  }
  catch {
    return null
  }
}

/** The stat seam from the iSCSI paths, defaulting to the real one. */
export function statDeviceFrom(paths: IscsiPaths): StatDevice {
  return paths.deviceStat ?? statDevice
}

/** A bare decimal number (the env seam's major/minor). */
const DIGITS_RE = /^\d+$/

/** The sentence every mismatch starts with — one phrasing, every door. */
export const SERVED_DEVICE_MISMATCH = 'LUN serves a different device than its path names'

/** The live backstore a LUN maps, by name AND plugin (names are per plugin). */
export function liveBackstoreOf(
  live: LioLiveState,
  lun: Pick<IscsiLun, 'name' | 'plugin'>,
): ConfigfsBackstore | undefined {
  return live.backstores.find(b => b.name === lun.name && normalizePlugin(b.plugin) === normalizePlugin(lun.plugin))
}

/** The verdict of one served-device comparison. */
export interface ServedDeviceVerdict {
  /**
   * `block:<major>:<minor>` or `file:<dev>:<ino>` when the comparison held;
   * null when it did not (the refusal says why).
   */
  device: string | null
  refusal: IscsiRefusal | null
}

/**
 * THE comparison: is the object at the LUN's path the one LIO is serving?
 *
 * Pure over its inputs (the live backstore and one `stat` of the path) so it is
 * the same answer at the request and inside the job. A caller that is about to
 * act on the backing object refuses on a non-null `refusal`; a caller that only
 * unmaps (a LUN delete that keeps the backing) may proceed and still binds the
 * device when there is one.
 */
export function servedDevice(
  lun: Pick<IscsiLun, 'index' | 'name' | 'plugin' | 'backingPath'>,
  backstore: ConfigfsBackstore | undefined,
  st: DeviceStat | null,
): ServedDeviceVerdict {
  const path = lun.backingPath
  const plugin = normalizePlugin(lun.plugin)
  if (!backstore) {
    return {
      device: null,
      refusal: {
        reason: 'served-device-unknown',
        message: `LUN ${lun.index} ('${lun.name}') is not live in the kernel, so there is no served device to compare `
          + `with ${path || '(no path)'} — ANAS will not act on the backing object of a LUN whose device it cannot see.`,
      },
    }
  }
  if (plugin === 'block') {
    if (backstore.devMajor === null || backstore.devMinor === null) {
      return {
        device: null,
        refusal: {
          reason: 'served-device-unknown',
          message: `The kernel does not report which device LUN ${lun.index} ('${lun.name}') opened (no Major/Minor in `
            + `its configfs info), so ANAS cannot prove ${path} is the device it serves and will not act on it.`,
        },
      }
    }
    const served = `${backstore.devMajor}:${backstore.devMinor}`
    if (!st || st.type !== 'block') {
      return {
        device: null,
        refusal: {
          reason: 'served-device-mismatch',
          message: `${SERVED_DEVICE_MISMATCH}: LUN ${lun.index} ('${lun.name}') serves device ${served}, and ${path} `
            + `${st ? 'is not a block device' : 'no longer resolves'} — the volume was renamed or destroyed under the live LUN. `
            + `ANAS will not run a ZFS verb on what the path names now. Delete the LUN without "Also destroy" to drop it.`,
        },
      }
    }
    const named = `${st.rdevMajor}:${st.rdevMinor}`
    if (named !== served) {
      return {
        device: null,
        refusal: {
          reason: 'served-device-mismatch',
          message: `${SERVED_DEVICE_MISMATCH}: LUN ${lun.index} ('${lun.name}') serves device ${served}`
            + `${backstore.kernelDevice ? ` (${backstore.kernelDevice})` : ''}, but ${path} is device ${named} — the volume `
            + `was renamed or re-created under the live LUN. ANAS will not run a ZFS verb on the volume the path names now. `
            + `Delete the LUN without "Also destroy" to drop it, then export the volume you mean.`,
        },
      }
    }
    return { device: `block:${served}`, refusal: null }
  }
  // fileio: the kernel keeps the file open and names no inode, so the path's
  // own identity is what a request binds and a job compares.
  if (!st || st.type !== 'file') {
    return {
      device: null,
      refusal: {
        reason: 'served-device-unknown',
        message: `${path} ${st ? 'is not a regular file' : 'no longer resolves'}, so it is not the image LUN ${lun.index} `
          + `('${lun.name}') was created on — ANAS will not act on it.`,
      },
    }
  }
  return { device: `file:${st.dev}:${st.ino}`, refusal: null }
}

/**
 * Which live block backstore, if any, already serves the device `st` names.
 * The repair half of the rule: a hole is recreated only over a device no other
 * backstore serves.
 */
export function servedElsewhere(
  live: LioLiveState,
  st: DeviceStat | null,
): { name: string, device: string } | null {
  if (!st || st.type !== 'block')
    return null
  const device = `${st.rdevMajor}:${st.rdevMinor}`
  for (const b of live.backstores) {
    if (normalizePlugin(b.plugin) === 'block' && b.devMajor !== null && b.devMinor !== null
      && `${b.devMajor}:${b.devMinor}` === device) {
      return { name: b.name, device }
    }
  }
  return null
}

/** One served-device comparison with the stat done for you. */
export async function checkServedDevice(
  live: LioLiveState,
  lun: Pick<IscsiLun, 'index' | 'name' | 'plugin' | 'backingPath'>,
  statFn: StatDevice,
): Promise<ServedDeviceVerdict> {
  const st = lun.backingPath ? await statFn(lun.backingPath) : null
  return servedDevice(lun, liveBackstoreOf(live, lun), st)
}

/**
 * The stable identity a confirm binds and a job re-reads: everything that
 * would differ if the index were reused or the path re-pointed.
 */
export interface ServedLunIdentity {
  target: string
  index: number
  serial: string | null
  backstore: string
  backingPath: string
  /** The verified served device, or null when it could not be verified. */
  device: string | null
}

export function servedLunIdentity(iqn: string, lun: IscsiLun, device: string | null): ServedLunIdentity {
  return {
    target: iqn,
    index: lun.index,
    serial: lun.serial,
    backstore: lun.name,
    backingPath: lun.backingPath,
    device,
  }
}

/**
 * Re-read the LUN inside the job (call it UNDER `withIscsiLock`) and prove it is
 * still the one the request was accepted for. Throws with a sentence naming
 * what changed; nothing has been touched when it does.
 *
 * `requireDevice` is set by every caller that acts on the backing object: the
 * served device must still verify and equal the bound one. Without it (a LUN
 * delete that keeps the backing) a bound device is still compared when the
 * fresh read can verify one.
 */
export async function reverifyServedLun(
  executor: CommandExecutor,
  paths: IscsiPaths,
  expected: ServedLunIdentity,
  opts: { requireDevice: boolean },
): Promise<{ target: IscsiTargetDetail, lun: IscsiLun, live: LioLiveState }> {
  const { ctx, targets } = await readIscsiState(executor, paths)
  const target = targets.find(t => t.iqn === expected.target)
  const head = `LUN ${expected.index} of ${expected.target} is no longer the LUN this request was accepted for`
  const tail = 'Nothing was changed. Refresh the iSCSI view and retry against what is there now.'
  if (!target)
    throw new Error(`${head}: the target is gone. ${tail}`)
  const lun = target.luns.find(l => l.index === expected.index)
  if (!lun)
    throw new Error(`${head}: there is no LUN at that index any more. ${tail}`)
  if (lun.serial !== expected.serial)
    throw new Error(`${head}: its unit serial is now ${lun.serial ?? '(unknown)'}, not ${expected.serial ?? '(unknown)'} — a different LUN took the index. ${tail}`)
  if (lun.name !== expected.backstore)
    throw new Error(`${head}: its backstore is now '${lun.name}', not '${expected.backstore}'. ${tail}`)
  if (lun.backingPath !== expected.backingPath)
    throw new Error(`${head}: its backing path is now ${lun.backingPath}, not ${expected.backingPath}. ${tail}`)
  const verdict = await checkServedDevice(ctx.live, lun, statDeviceFrom(paths))
  if (opts.requireDevice && verdict.refusal)
    throw new Error(`${verdict.refusal.message} ${tail}`)
  if (expected.device !== null && verdict.device !== null && verdict.device !== expected.device) {
    throw new Error(`${SERVED_DEVICE_MISMATCH}: LUN ${expected.index} served ${expected.device} when the request was `
      + `accepted and ${verdict.device} now — the backing object was replaced in between. ${tail}`)
  }
  if (opts.requireDevice && expected.device === null)
    throw new Error(`${head}: its served device was never verified. ${tail}`)
  return { target, lun, live: ctx.live }
}

/**
 * The test seam's env form: `ANAS_ISCSI_DEVICE_STAT` is a `;`-separated list of
 * `<path>=<major>:<minor>` (a block device node) or `<path>=file:<dev>:<ino>[:<size>]`
 * (a regular file). A listed path answers from the list; anything else gets the
 * real `stat`. Undefined when the variable is unset or lists nothing, so
 * production never carries the seam at all.
 */
export function deviceStatSeamFromEnv(value: string | undefined): StatDevice | undefined {
  const table = new Map<string, DeviceStat>()
  for (const entry of (value ?? '').split(';')) {
    const eq = entry.lastIndexOf('=')
    if (eq <= 0)
      continue
    const path = entry.slice(0, eq).trim()
    const spec = entry.slice(eq + 1).trim().split(':')
    if (!path.startsWith('/'))
      continue
    if (spec[0] === 'file' && spec.length >= 3) {
      table.set(path, { type: 'file', rdevMajor: 0, rdevMinor: 0, dev: spec[1], ino: spec[2], size: Number(spec[3] ?? 0) })
    }
    else if (spec.length === 2 && spec.every(n => DIGITS_RE.test(n))) {
      table.set(path, { type: 'block', rdevMajor: Number(spec[0]), rdevMinor: Number(spec[1]), dev: '0', ino: '0', size: 0 })
    }
  }
  if (table.size === 0)
    return undefined
  return async path => table.get(path) ?? statDevice(path)
}
