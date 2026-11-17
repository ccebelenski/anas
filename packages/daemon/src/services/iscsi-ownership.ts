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
 * Rule 2 is the pvepool.1 footprint pattern applied to block objects. The ONE
 * shared ownership answer, asked through {@link ownershipWithFallback} (which
 * wraps the `@anas/shared` predicate), decides — per DATASET, not per pool —
 * whether a LUN's backing dataset is inside PVE's footprint: a
 * storage root, a guest volume (`vm-101-disk-0`, `subvol-100-foo`, `basevol-*`),
 * a `dir` storage's tree, or the system/boot tree. An owned backing makes its
 * target foreign and hands-off. PVE's guest disks are never ANAS's candidates;
 * a sibling dataset on a PVE pool is ordinary ANAS storage.
 *
 * A LUN whose backing path does NOT resolve is a third thing, and it is
 * deliberately not "foreign": `zfs rename` under a live LUN succeeds silently and
 * leaves `udev_path` dangling (GT-40), so an ANAS target can acquire a broken LUN
 * without changing hands. Broken is reported as broken (`backingExists: false`),
 * and a target whose LUNs are on ANAS storage stays ANAS's problem to fix.
 *
 * Story `iscsi.5` made that third thing explicit and load-bearing. Live-proof
 * wave 1 (finding F2) hit the exact state this epic exists to surface — a
 * file-backed LUN whose pool was not imported — and watched ANAS hand its OWN
 * target a hands-off badge, because "resolves onto nothing" and "resolves onto
 * someone else's storage" were the same verdict here. They are not:
 *
 *   - `foreign`    — the backing IS there and it is NOT ours (a raw block device,
 *                    a PVE pool, a file on unmanaged storage). A positive fact.
 *   - `unresolved` — the backing is not there at all right now. An absence.
 *
 * An absence proves nothing about ownership, so **only a POSITIVE foreign
 * verdict takes a target away from ANAS**; the IQN convention decides the rest.
 * Getting that backwards removes the repair tools at precisely the moment they
 * are needed.
 *
 * The existence check is the CALLER's: `classifyBacking` takes the answer as an
 * argument rather than doing I/O of its own, so it stays pure, and the read
 * layer pays for exactly one `stat` per backing path (which it was already
 * doing, for `backingExists`).
 */

import type { IscsiLunKind, IscsiOwnershipTag, PveOwnership, PveStorageRef, SystemPoolFacts } from '@anas/shared'
import type { FindmntNode } from '../parsers/findmnt.js'
import type { ZfsMountpoint } from '../parsers/pve-storage.js'
import { configPathKey, isAnasIqn, ZVOL_PATH_PREFIX, zvolDatasetFromPath } from '@anas/shared'
import { matchMountpoint } from '../parsers/pve-storage.js'
import { ahrPoolHolding } from './ahr-topology.js'
import { ownershipWithFallback } from './pve-footprint.js'

/** The trailing slashes that are spelling, not path ({@link stripTrailingSlash}). */
const TRAILING_SLASH_RE = /\/+$/

/** What ANAS knows about the storage a LUN's backing object sits on. */
export interface BackingClassification {
  /**
   * `zvol` / `file` when the path resolves onto storage ANAS manages;
   * `unresolved` when it resolves onto nothing AND was checked to be absent;
   * `foreign` otherwise.
   */
  kind: IscsiLunKind
  /** The ZFS pool root, when the path resolves onto ZFS. */
  pool: string | null
  /** The ZFS dataset (the zvol itself, or the file's dataset). */
  dataset: string | null
  /**
   * The MOUNTPOINT of the dataset / AHR pool the path resolves onto — the
   * filesystem the file is supposed to be on (story `iscsi.8`). Null for a zvol
   * (a device path has no mountpoint) and for anything unmatched. It is the
   * `expectedMount` half of the stub verdict: compared against the mount that
   * actually contains the file, it catches a placeholder sitting on the PARENT
   * filesystem of a dataset that did not mount.
   */
  mountpoint: string | null
  /** True when the backing DATASET is inside PVE's footprint (any kind, pvepool.1). */
  pveOwned: boolean
  /** The full ownership verdict behind `pveOwned` — null when not owned. */
  pveOwnership: PveOwnership | null
  /** True when the backing dataset is owned as a PVE guest volume. */
  pveGuestVolume: boolean
  /**
   * cr3: a FILE path whose dataset could not be judged because the ZFS
   * mountpoint table was unreadable (and no AHR pool holds it). Ownership is
   * UNKNOWN: never "not PVE's", never "foreign".
   */
  ownershipUnknown?: boolean
  /**
   * cr4 (D-11): the classification is unknown because a READ failed, not
   * because the storage is somebody else's.
   *
   * - `path` — the LUN's backing path could not be read from the kernel target
   *            configuration at all (`devPath` is empty). The target is
   *            hands-off (the safe side): a LUN whose backing cannot even be
   *            named is not one ANAS should act on.
   * - `ahr`  — the path resolves onto no ZFS dataset and the AHR pool topology
   *            that could hold it could not be read. The target stays ANAS's
   *            (the F2 rule keeps Repair available), the owner unknown.
   *
   * Either way it is never a positive "foreign" verdict, and the sentence says
   * what could not be read rather than claiming whose storage it is.
   */
  backingUnreadable?: 'path' | 'ahr'
}

/** The system facts ownership is derived from; both are already read elsewhere. */
export interface OwnershipInputs {
  /**
   * `poolRoot -> PveStorageRef[]`, from `readPveStorages()`. `null` means that
   * read FAILED — UNREADABLE, not "no storages" (pvepool.1 review fix 1) — and
   * {@link ownershipWithFallback} then treats EVERY dataset as PVE's until the
   * config can be read. Missing facts may only tighten the gate, never loosen it.
   */
  pveStorages: Map<string, PveStorageRef[]> | null
  /** ZFS mountpoints, from `readZfsMountpoints()` — resolves a file onto a dataset. */
  zfsMountpoints: ZfsMountpoint[]
  /**
   * cr3: the mountpoint table could not be READ (`zfs list` failed) — the
   * empty `zfsMountpoints` above is then not "no datasets", and a file's
   * dataset (and so its PVE ownership) is unknown. Absent/false = it read.
   */
  zfsMountpointsUnreadable?: boolean
  /**
   * The findmnt table of the SAME read (`readZfsMountpointsFull`) — the #85
   * gate on that resolution: a file whose SERVING filesystem (the longest-
   * prefix mount in this table) is not ZFS sits on no dataset, which is what
   * makes the AHR branch of {@link classifyBacking} reachable on a ZFS-root
   * node. `null`/omitted is UNREADABLE: the mountpoint match answers as
   * before, which can only tighten, never loosen.
   */
  findmntNodes?: FindmntNode[] | null
  /**
   * cr4 (D-11): the AHR pool topology read FAILED (it was attempted because a
   * file LUN resolved onto no ZFS dataset, and `readAhrPools` threw). A file
   * that matched neither a ZFS dataset nor an AHR mountpoint is then UNKNOWN —
   * it could be on an AHR pool ANAS manages, so it is never a positive
   * "foreign". Absent/false = the topology was not needed, or it read.
   */
  ahrUnreadable?: boolean
  /** AHR pool mountpoints (`name -> mountpoint`); an AHR pool's only block kind is a file. */
  ahrMountpoints?: Map<string, string>
  /**
   * Boot facts per imported pool (`readSystemPoolFacts()`), for the
   * system/boot-tree rule of the footprint predicate. `null` (or omitted — a
   * context that never read them, e.g. a create path) means UNREADABLE, and
   * the whole-pool fallback of {@link ownershipWithFallback} tightens toward
   * hands-off on any pool that hosts a zfspool storage. Missing facts may
   * only tighten the gate, never loosen it.
   */
  systemFacts?: SystemPoolFacts[] | null
}

function stripTrailingSlash(path: string): string {
  return path.replace(TRAILING_SLASH_RE, '') || '/'
}

/** An absolute path that is not a device node — an image file. */
function isFilePath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('/dev/')
}

/** The pool root of a dataset (`tank/data` → `tank`). */
function poolRoot(dataset: string): string {
  return dataset.split('/')[0]
}

/**
 * The ONE predicate, asked through {@link OwnershipInputs}: does PVE own this
 * dataset? Feed it the pool's storage refs and that pool's boot facts. Facts
 * that are `null` or omitted are UNREADABLE and take the whole-pool fallback
 * — {@link ownershipWithFallback} is the single statement of the rule.
 * Exported for callers that already HOLD an {@link OwnershipInputs} (the iSCSI
 * mutate paths) — one predicate assembly, never two.
 */
export function ownershipFromInputs(inputs: OwnershipInputs, dataset: string): PveOwnership | null {
  return ownershipWithFallback(
    inputs.pveStorages ?? new Map(),
    inputs.systemFacts ?? null,
    dataset,
    inputs.pveStorages === null,
  )
}

/** Ask {@link ownershipFromInputs} from inside this module. */
const ownershipOf = ownershipFromInputs

// matchMountpoint is IMPORTED (parsers/pve-storage.ts) — the ONE longest-prefix
// path → dataset resolver, shared with the dir-storage parser and the footprint
// service's datasetOfPath; this file used to carry a private copy.

/**
 * Classify a LUN's backing path.
 *
 * A `/dev/zvol/<pool>/<vol>` path is a zvol on that pool — parsed from the path,
 * because that stable path is exactly what LIO stores and what survives a reboot
 * (a `/dev/zdN` name does not, GT-48).
 *
 * Any other absolute path is a file, and its pool is whichever ZFS dataset (or
 * AHR pool) hosts it. A file that sits on neither is `foreign` — it may be a
 * plain block device someone exported by hand, or an image on storage ANAS does
 * not manage — UNLESS `backingExists` says the path is not there at all, in
 * which case it is `unresolved` and proves nothing (story `iscsi.5`).
 *
 * `backingExists` is deliberately three-valued and only ONE value changes the
 * verdict:
 *
 *   - `false`               — checked, absent  ⇒ `unresolved`
 *   - `true`                — checked, present ⇒ `foreign` (a positive verdict)
 *   - `null` / omitted      — not checked, or the check itself failed (EACCES,
 *                             EIO) ⇒ `foreign`, the pre-existing behaviour. The
 *                             create paths (`resolveZvolBacking`,
 *                             `resolveFileBackingDir`) call it this way on
 *                             purpose: an image that does not exist YET must
 *                             still be refused if its directory is not ANAS's.
 *
 * A `/dev/zvol/...` path is NEVER `unresolved`: it names its own pool and
 * volume, so a missing device there is a stale path on a known object, which is
 * already reported as `backingExists: false` on the LUN (GT-40).
 */
export function classifyBacking(
  devPath: string,
  inputs: OwnershipInputs,
  backingExists?: boolean | null,
): BackingClassification {
  const unmatched: BackingClassification = {
    kind: backingExists === false ? 'unresolved' : 'foreign',
    pool: null,
    dataset: null,
    mountpoint: null,
    pveOwned: false,
    pveOwnership: null,
    pveGuestVolume: false,
  }
  // cr4 (D-11): no path at all is not an absence — it is a read that did not
  // see. The LUN's backing path could not be read from the kernel target
  // configuration (neither source named a backstore `dev`/`udev_path`), so the
  // owner is UNKNOWN, never a positive `foreign`.
  if (devPath.length === 0)
    return { ...unmatched, kind: 'foreign', backingUnreadable: 'path' }
  if (!devPath.startsWith('/'))
    return unmatched

  // `/dev/zvol/<pool>/<vol>` — parsed by the ONE shared helper, which the
  // backup consistency derivation (backup2.4) reads the same way. The fallback
  // keeps the pre-existing behaviour for the degenerate `/dev/zvol/<pool>` form
  // the helper (rightly) does not call a volume.
  const dataset = zvolDatasetFromPath(devPath)
    ?? (devPath.startsWith(ZVOL_PATH_PREFIX) ? stripTrailingSlash(devPath.slice(ZVOL_PATH_PREFIX.length)) : '')
  if (dataset) {
    const pool = poolRoot(dataset)
    const owned = ownershipOf(inputs, dataset)
    return {
      kind: 'zvol',
      pool,
      dataset,
      mountpoint: null,
      pveOwned: owned !== null,
      pveOwnership: owned,
      pveGuestVolume: owned?.kind === 'guest-volume',
    }
  }

  // Any other /dev/ path is a raw block device LIO was pointed at directly —
  // not a kind ANAS creates, so it is foreign whatever it is (or unresolved,
  // when the device node itself has gone).
  if (devPath.startsWith('/dev/'))
    return unmatched

  // `matchMountpoint` only returns rows of the mountpoint table, and the table
  // parser never emits an empty dataset (`parseZfsMountpoints` skips rows
  // without one) — so an `mp` always carries the dataset it matched, and there
  // is no "mountpoint without a dataset" shape to answer.
  const mp = matchMountpoint(devPath, inputs.zfsMountpoints, inputs.findmntNodes ?? null)
  if (mp) {
    const owned = ownershipOf(inputs, mp.dataset)
    return {
      kind: 'file',
      pool: mp.pool,
      dataset: mp.dataset,
      mountpoint: mp.mountpoint,
      pveOwned: owned !== null,
      pveOwnership: owned,
      // A file cannot be a guest VOLUME (PVE inventories zvols/subvols, never
      // plain files) — but a dir storage's tree is owned as `dir-storage`, and
      // `pveOwned` already reflects that.
      pveGuestVolume: false,
    }
  }

  // AHR's only block object is a file on its btrfs volume, so an AHR pool
  // mountpoint is as much "ANAS-managed storage" as a ZFS dataset is. When
  // pool mountpoints nest, the deepest holder wins (ahrPoolHolding owns that
  // rule); the answer keeps the slash-stripped spelling it always carried.
  if (inputs.ahrMountpoints) {
    const best = ahrPoolHolding(devPath, Array.from(inputs.ahrMountpoints, ([name, mountpoint]) => ({ name, mountpoint })))
    if (best)
      return { kind: 'file', pool: best.name, dataset: null, mountpoint: configPathKey(best.mountpoint), pveOwned: false, pveOwnership: null, pveGuestVolume: false }
  }

  // cr3: with the mountpoint table unreadable, "no dataset matched" proves
  // nothing — the file may sit on a PVE storage's dataset. Unknown, never
  // "foreign" (which would take the target away) and never "not PVE's".
  if (inputs.zfsMountpointsUnreadable)
    return { ...unmatched, kind: 'unresolved', ownershipUnknown: true }

  // cr4 (D-11): the file matched neither a ZFS dataset nor an AHR mountpoint
  // because the AHR topology read FAILED. It could be on an AHR pool ANAS
  // manages, so the owner is unknown — never a positive `foreign`. This does
  // NOT set `ownershipUnknown`: that flag refuses Repair, and the F2 rule is
  // that an unreadable topology must keep the repair tools available. The
  // verdict is carried by `backingUnreadable` instead.
  if (inputs.ahrUnreadable)
    return { ...unmatched, backingUnreadable: 'ahr' }

  return unmatched
}

/** One LUN, reduced to what ownership needs to know about it. */
export interface OwnershipLun {
  /** Backstore name — used to name the deciding LUN in the verdict. */
  name: string
  /** The backing path from saveconfig `dev` / configfs `udev_path`. */
  backingPath: string
  /**
   * Does that path resolve on this node RIGHT NOW? `false` is the only value
   * that turns an unmatched backing into `unresolved` rather than `foreign`
   * (see {@link classifyBacking}); `null`/omitted means "not checked".
   */
  backingExists?: boolean | null
  /**
   * cr4 (D-11): the LUN's own configfs directory, when it is live in the kernel
   * target tree. Named in the sentence when its backing path could not be read,
   * so the operator has a grounded path to look at.
   */
  configfsPath?: string
}

/**
 * The sentence for a LUN whose backing path could not be read (cr4, D-11).
 *
 * Nothing is claimed about whose storage it is — only that the read did not
 * see, where it looked, and the one thing to do. The configfs LUN directory is
 * named when the LUN is live; otherwise the saved configuration that was read
 * is named instead, because there is no configfs path for a target that is not
 * there.
 */
function backingUnreadableDetail(lun: OwnershipLun, saveconfigPath: string | undefined): string {
  if (lun.configfsPath) {
    return `The backing path of LUN '${lun.name}' could not be read from the kernel target configuration: `
      + `the configfs path ${lun.configfsPath} was read and names no backstore with a device path, `
      + `so ANAS cannot tell whose storage it is. Refresh this screen to read it again.`
  }
  if (saveconfigPath) {
    return `The backing path of LUN '${lun.name}' could not be read from the kernel target configuration: `
      + `the LUN is not in the running configuration (configfs), and the saved configuration (${saveconfigPath}) names no `
      + `storage object for its backstore, so ANAS cannot tell whose storage it is. `
      + `Refresh this screen to read it again.`
  }
  return `The backing path of LUN '${lun.name}' could not be read from the kernel target configuration, `
    + `so ANAS cannot tell whose storage it is. Refresh this screen to read it again.`
}

/**
 * The sentence for a file LUN that matched no ZFS dataset because the AHR pool
 * topology could not be read (cr4, D-11). Unknown, said as unknown.
 */
function ahrUnreadableDetail(lun: OwnershipLun): string {
  return `The backing path of LUN '${lun.name}' (${lun.backingPath}) resolves onto no ZFS dataset, and `
    + `this node's AHR pool topology could not be read, so ANAS cannot tell whose storage it is. `
    + `Refresh this screen to read it again.`
}

/**
 * Derive a target's ownership from its IQN and its LUNs.
 *
 * The IQN is checked FIRST and it is the AUTHORITY for `anas`: a target ANAS did
 * not create is foreign no matter whose storage it happens to sit on, and a
 * target ANAS did create stays ANAS's unless some LUN's backing POSITIVELY
 * resolves onto storage that is somebody else's (story `iscsi.5`).
 *
 * That leaves exactly two ways to lose a target — a backing dataset inside
 * PVE's footprint (guest volume, storage root, dir-storage tree, boot tree,
 * pvepool.1) or a resolvable backing on unmanaged storage — and each one
 * carries its reason, so the UI explains its hands-off badge instead of merely
 * wearing one.
 *
 * Two states that are NOT foreign, and used to be:
 *
 *  - **an `unresolved` LUN.** The pool is exported, the dataset was renamed, the
 *    image file is gone. That is the boot-restore hole this epic exists to
 *    surface (GT-20/GT-21), reported through `/v1/iscsi/health` and repairable
 *    through `POST /v1/iscsi/health/repair` — both of which need the target to
 *    still be ANAS's.
 *  - **no LUNs at all.** A target created a second ago has none; a target whose
 *    whole pool was late at boot comes up enabled with none (GT-21). Neither is
 *    evidence of anyone else's ownership, and marking them hands-off made the
 *    first one impossible to add a LUN to.
 */
export function deriveOwnership(
  iqn: string,
  luns: OwnershipLun[],
  inputs: OwnershipInputs,
  /**
   * cr4 (D-11): where the saved configuration was read, named in the
   * `backing-unreadable` sentence for a LUN that is not live in configfs.
   */
  paths: { saveconfigPath?: string } = {},
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
      ownership: 'anas',
      reason: 'no-luns',
      detail: `IQN follows the ANAS naming convention; the target has no LUNs (newly created, or its backing storage did not come up at boot)`,
    }
  }

  const unresolved: OwnershipLun[] = []
  const unknownTopology: OwnershipLun[] = []
  for (const lun of luns) {
    const c = classifyBacking(lun.backingPath, inputs, lun.backingExists)
    // cr4 (D-11): a LUN with NO backing path at all was not read. The owner is
    // unknown, so the target is hands-off (the safe side), and the sentence
    // says what could not be read — never whose storage it is.
    if (c.backingUnreadable === 'path') {
      return {
        ownership: 'foreign',
        reason: 'backing-unreadable',
        detail: backingUnreadableDetail(lun, paths.saveconfigPath),
      }
    }
    // cr3 ISCSI-H1: an image FILE that is not there (or is a placeholder, which
    // the read layer hands over as `backingExists: false`) says nothing about
    // whose storage it is on. Its dataset was inferred from whatever filesystem
    // serves the directory RIGHT NOW, and with the image's own filesystem not
    // mounted that is the parent — on a node that boots from ZFS, the boot
    // dataset, which PVE owns. Taking that as a positive foreign verdict handed
    // ANAS's own target a hands-off badge and switched off the placeholder
    // quarantine and the degraded mark. So an absent file is an absence, full
    // stop: it can never take the target away. A `/dev/...` path is different —
    // a zvol path NAMES its dataset, which is a fact about the name and stays.
    if (lun.backingExists === false && isFilePath(lun.backingPath)) {
      if (c.kind === 'unresolved' || c.pveOwnership !== null)
        unresolved.push(lun)
      continue
    }
    // cr4 (D-11): a file that matched no ZFS dataset BECAUSE the AHR topology
    // could not be read is unknown, not foreign. The file may be on an AHR pool
    // ANAS manages, so the target stays ANAS's (the F2 rule: an unreadable
    // topology must not remove the repair tools) and the sentence says the
    // owner could not be read.
    if (c.backingUnreadable === 'ahr') {
      unknownTopology.push(lun)
      continue
    }
    // cr3: a file whose dataset could not be judged (the mountpoint table was
    // unreadable) — the same answer as an absence: it never takes the target.
    if (c.ownershipUnknown) {
      unresolved.push(lun)
      continue
    }
    if (c.pveGuestVolume) {
      return {
        ownership: 'foreign',
        reason: 'backing-pve-guest-disk',
        detail: `LUN '${lun.name}' is backed by the PVE guest volume ${c.dataset ?? lun.backingPath}`,
      }
    }
    // Any OTHER owned kind — storage root, dir-storage tree, system/boot tree —
    // is equally hands-off, and the ownership reason names the storage AND the
    // dataset (pvepool.1: never "this pool").
    if (c.pveOwnership) {
      return {
        ownership: 'foreign',
        reason: 'backing-pve-storage',
        detail: `LUN '${lun.name}' is backed by ${lun.backingPath} — ${c.pveOwnership.reason}`,
      }
    }
    if (c.kind === 'foreign') {
      return {
        ownership: 'foreign',
        reason: 'backing-not-anas-storage',
        detail: `LUN '${lun.name}' is backed by ${lun.backingPath}, which is not on storage ANAS manages`,
      }
    }
    if (c.kind === 'unresolved')
      unresolved.push(lun)
  }

  if (unresolved.length > 0) {
    const named = unresolved.map(l => `'${l.name}' (${l.backingPath})`).join(', ')
    return {
      ownership: 'anas',
      reason: 'backing-unresolved',
      detail: `IQN follows the ANAS naming convention; ${unresolved.length} of ${luns.length} LUN${luns.length === 1 ? '' : 's'} `
        + `resolve${unresolved.length === 1 ? 's' : ''} onto no storage on this node right now — ${named}. `
        + `An absent backing is a hole to repair, not a change of ownership.`,
    }
  }

  // cr4 (D-11): the AHR topology could not be read, so an unmatched file LUN's
  // owner is unknown. The target stays ANAS's (so Repair and the screens keep
  // working), and the sentence says the owner could not be read — it does not
  // claim the backing is foreign, nor that it resolves onto nothing.
  if (unknownTopology.length > 0) {
    return {
      ownership: 'anas',
      reason: 'backing-unreadable',
      detail: unknownTopology.length === 1
        ? ahrUnreadableDetail(unknownTopology[0]!)
        : `The backing paths of ${unknownTopology.length} LUNs (${unknownTopology.map(l => l.name).join(', ')}) `
          + `resolve onto no ZFS dataset, and this node's AHR pool topology could not be read, so ANAS cannot tell `
          + `whose storage they are on. Refresh this screen to read it again.`,
    }
  }

  return {
    ownership: 'anas',
    reason: 'anas-managed',
    detail: `IQN follows the ANAS naming convention and all ${luns.length} LUN${luns.length === 1 ? '' : 's'} are backed by ANAS-managed storage`,
  }
}
