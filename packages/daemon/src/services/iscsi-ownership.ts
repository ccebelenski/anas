/**
 * iSCSI ownership — derived from the system, never stored (story `iscsi.2`).
 *
 * Principle 11 forbids a shadow database of "targets ANAS made". So ownership is
 * a QUESTION ASKED OF THE SYSTEM, re-answered on every read, from two facts that
 * are already there:
 *
 *   1. the IQN follows the ANAS naming convention (`isAnasIqn`, defined once in
 *      `@anas/shared` so the CREATE story generates exactly what this
 *      recognises — LIO has no rename, so an IQN is identity for life, GT-10);
 *   2. every LUN's backing object resolves onto storage ANAS manages.
 *
 * Rule 2 is the 3.25 PVE-tagging pattern applied to block objects. `storage.cfg`
 * is parsed (never written) to learn which ZFS pools PVE owns; a LUN backed by a
 * zvol on one of those pools, or by anything named like a PVE guest volume
 * (`vm-101-disk-0`), makes its target foreign and hands-off. PVE's guest disks
 * are never ANAS's candidates.
 *
 * A LUN whose backing path does NOT resolve is a third thing, and it is
 * deliberately not "foreign": `zfs rename` under a live LUN succeeds silently and
 * leaves `udev_path` dangling (GT-40), so an ANAS target can acquire a broken LUN
 * without changing hands. Broken is reported as broken (`backingExists: false`),
 * and a target whose LUNs are on ANAS storage stays ANAS's problem to fix.
 */

import type { IscsiLunKind, IscsiOwnershipTag, PveStorageRef } from '@anas/shared'
import type { ZfsMountpoint } from '../parsers/pve-storage.js'
import { isAnasIqn, ZVOL_PATH_PREFIX, zvolDatasetFromPath } from '@anas/shared'

/**
 * PVE's guest-volume naming on a `zfspool` storage: `vm-<vmid>-disk-<n>` for a
 * VM disk, `base-<vmid>-disk-<n>` for a template's base volume, `subvol-<vmid>-
 * disk-<n>` for a container's subvolume. A backing object with one of these
 * names belongs to a guest, whatever pool it is on, and is never an ANAS
 * candidate.
 */
export const PVE_GUEST_VOLUME_RE = /^(?:vm|base|subvol)-\d+-disk-\d+$/

/** Trailing slashes, stripped before any path comparison. */
const TRAILING_SLASH_RE = /\/+$/

/** What ANAS knows about the storage a LUN's backing object sits on. */
export interface BackingClassification {
  /** `zvol`, `file`, or `foreign` when it resolves onto nothing ANAS knows. */
  kind: IscsiLunKind
  /** The ZFS pool root, when the path resolves onto ZFS. */
  pool: string | null
  /** The ZFS dataset (the zvol itself, or the file's dataset). */
  dataset: string | null
  /** True when that pool/dataset is referenced by a PVE storage (3.25). */
  pveManaged: boolean
  /** True when the object is named like a PVE guest volume. */
  pveGuestVolume: boolean
}

/** The system facts ownership is derived from; both are already read elsewhere. */
export interface OwnershipInputs {
  /** `poolRoot -> PveStorageRef[]`, from `readPveStorages()`. */
  pveStorages: Map<string, PveStorageRef[]>
  /** ZFS mountpoints, from `readZfsMountpoints()` — resolves a file onto a dataset. */
  zfsMountpoints: ZfsMountpoint[]
  /** AHR pool mountpoints (`name -> mountpoint`); an AHR pool's only block kind is a file. */
  ahrMountpoints?: Map<string, string>
}

function stripTrailingSlash(path: string): string {
  return path.replace(TRAILING_SLASH_RE, '') || '/'
}

/** Is `path` at or under `dir`? (`/tank` must not swallow `/tank-other`.) */
function isUnder(path: string, dir: string): boolean {
  if (dir === '/')
    return path.startsWith('/')
  return path === dir || path.startsWith(`${dir}/`)
}

/** The pool root of a dataset (`tank/data` → `tank`). */
function poolRoot(dataset: string): string {
  return dataset.split('/')[0]
}

/** The last name component of a dataset (`tank/vm-101-disk-0` → `vm-101-disk-0`). */
function lastComponent(dataset: string): string {
  const parts = dataset.split('/')
  return parts.at(-1) ?? dataset
}

/**
 * Resolve an absolute path onto the ZFS dataset that hosts it. When datasets
 * nest, the LONGEST matching mountpoint wins — the same most-specific rule
 * `pve-storage.ts` uses for a PVE `dir` storage.
 */
function matchMountpoint(path: string, mountpoints: ZfsMountpoint[]): ZfsMountpoint | null {
  const target = stripTrailingSlash(path)
  let best: ZfsMountpoint | null = null
  let bestLen = -1
  for (const mp of mountpoints) {
    if (!mp.mountpoint)
      continue
    const canonical = stripTrailingSlash(mp.mountpoint)
    if (isUnder(target, canonical) && canonical.length > bestLen) {
      best = mp
      bestLen = canonical.length
    }
  }
  return best
}

/**
 * Classify a LUN's backing path.
 *
 * A `/dev/zvol/<pool>/<vol>` path is a zvol on that pool — parsed from the path,
 * because that stable path is exactly what LIO stores and what survives a reboot
 * (a `/dev/zdN` name does not, GT-48).
 *
 * Any other absolute path is a file, and its pool is whichever ZFS dataset (or
 * AHR pool) hosts it. A file that sits on neither is `foreign`: it may be a
 * plain block device someone exported by hand, or an image on storage ANAS does
 * not manage.
 */
export function classifyBacking(devPath: string, inputs: OwnershipInputs): BackingClassification {
  const empty: BackingClassification = {
    kind: 'foreign',
    pool: null,
    dataset: null,
    pveManaged: false,
    pveGuestVolume: false,
  }
  if (!devPath.startsWith('/'))
    return empty

  // `/dev/zvol/<pool>/<vol>` — parsed by the ONE shared helper, which the
  // backup consistency derivation (backup2.4) reads the same way. The fallback
  // keeps the pre-existing behaviour for the degenerate `/dev/zvol/<pool>` form
  // the helper (rightly) does not call a volume.
  const dataset = zvolDatasetFromPath(devPath)
    ?? (devPath.startsWith(ZVOL_PATH_PREFIX) ? stripTrailingSlash(devPath.slice(ZVOL_PATH_PREFIX.length)) : '')
  if (dataset) {
    const pool = poolRoot(dataset)
    return {
      kind: 'zvol',
      pool,
      dataset,
      pveManaged: (inputs.pveStorages.get(pool)?.length ?? 0) > 0,
      pveGuestVolume: PVE_GUEST_VOLUME_RE.test(lastComponent(dataset)),
    }
  }

  // Any other /dev/ path is a raw block device LIO was pointed at directly —
  // not a kind ANAS creates, so it is foreign whatever it is.
  if (devPath.startsWith('/dev/'))
    return empty

  const mp = matchMountpoint(devPath, inputs.zfsMountpoints)
  if (mp) {
    return {
      kind: 'file',
      pool: mp.pool,
      dataset: mp.dataset,
      pveManaged: (inputs.pveStorages.get(mp.pool)?.length ?? 0) > 0,
      pveGuestVolume: false,
    }
  }

  // AHR's only block object is a file on its btrfs volume, so an AHR pool
  // mountpoint is as much "ANAS-managed storage" as a ZFS dataset is.
  if (inputs.ahrMountpoints) {
    let best: { pool: string, mountpoint: string } | null = null
    for (const [pool, mountpoint] of inputs.ahrMountpoints) {
      const canonical = stripTrailingSlash(mountpoint)
      if (isUnder(stripTrailingSlash(devPath), canonical)
        && (best === null || canonical.length > best.mountpoint.length)) {
        best = { pool, mountpoint: canonical }
      }
    }
    if (best)
      return { kind: 'file', pool: best.pool, dataset: null, pveManaged: false, pveGuestVolume: false }
  }

  return { ...empty, kind: 'foreign' }
}

/** One LUN, reduced to what ownership needs to know about it. */
export interface OwnershipLun {
  /** Backstore name — used to name the deciding LUN in the verdict. */
  name: string
  /** The backing path from saveconfig `dev` / configfs `udev_path`. */
  backingPath: string
}

/**
 * Derive a target's ownership from its IQN and its LUNs.
 *
 * `anas` requires BOTH halves — an ANAS-generated IQN and every LUN on
 * ANAS-managed storage. Everything else is `foreign` and carries the reason,
 * so the UI explains its hands-off badge instead of merely wearing one.
 *
 * The IQN is checked FIRST: a target ANAS did not create is foreign no matter
 * whose storage it happens to sit on, and saying so is a cheaper, truer
 * explanation than a storage verdict.
 */
export function deriveOwnership(
  iqn: string,
  luns: OwnershipLun[],
  inputs: OwnershipInputs,
): IscsiOwnershipTag {
  if (!isAnasIqn(iqn)) {
    return {
      ownership: 'foreign',
      reason: 'iqn-not-anas',
      detail: `IQN '${iqn}' was not generated by ANAS (an ANAS target's naming authority ends in '.anas')`,
    }
  }

  if (luns.length === 0) {
    return {
      ownership: 'foreign',
      reason: 'no-luns',
      detail: `Target '${iqn}' has no LUNs, so no backing object ties it to ANAS-managed storage`,
    }
  }

  for (const lun of luns) {
    const c = classifyBacking(lun.backingPath, inputs)
    if (c.pveGuestVolume) {
      return {
        ownership: 'foreign',
        reason: 'backing-pve-guest-disk',
        detail: `LUN '${lun.name}' is backed by the PVE guest volume ${c.dataset ?? lun.backingPath}`,
      }
    }
    if (c.pveManaged) {
      const refs = c.pool ? inputs.pveStorages.get(c.pool) ?? [] : []
      const names = refs.map(r => r.storage).join(', ')
      return {
        ownership: 'foreign',
        reason: 'backing-pve-storage',
        detail: `LUN '${lun.name}' is backed by ${lun.backingPath} on pool '${c.pool}', which PVE manages${names ? ` (${names})` : ''}`,
      }
    }
    if (c.kind === 'foreign') {
      return {
        ownership: 'foreign',
        reason: 'backing-not-anas-storage',
        detail: `LUN '${lun.name}' is backed by ${lun.backingPath}, which is not on storage ANAS manages`,
      }
    }
  }

  return {
    ownership: 'anas',
    reason: 'anas-managed',
    detail: `IQN follows the ANAS naming convention and all ${luns.length} LUN${luns.length === 1 ? '' : 's'} are backed by ANAS-managed storage`,
  }
}
