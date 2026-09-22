// PVE footprint ownership (story pvepool.1 — GitHub #61; DESIGN.md
// "PVE footprint ownership"). Story 3.25 tagged a whole ZFS pool as PVE's
// when any `zfspool` storage named it; PVE's real footprint is smaller and
// comes from ZFSPoolPlugin.pm (PVE 9.2.20): a `zfspool` storage owns its
// configured `pool` path — possibly a nested dataset such as `rpool/data` —
// plus that path's DIRECT children whose names match PVE_GUEST_VOLUME_RE
// (`zfs list -d1` + that regex is the whole inventory). A `dir` storage owns
// the dataset its path resolves onto and everything under it. Everything else
// on the pool is invisible to PVE.
//
// This module is PURE: it decides ownership from the storage refs (and
// optional system-pool facts) alone. It never lists children and never
// touches the system — callers feed it `parsePveStorageCfg` output. The
// per-dataset rule: ownership is decided here, once, and every consumer
// (schedules, replication, iSCSI, backup, datasets UI) asks the same
// predicate; pool-level PVE refusals stay hands-off and unchanged.

import type { PveOwnership, PveStorageRef, SystemPoolFacts } from './schemas/zfs.js'

/**
 * PVE's own guest-volume name check, verbatim from ZFSPoolPlugin.pm
 * `zfs_parse_zvol_list` (PVE 9.2.20): `vm|base|subvol|basevol-<vmid>-*`.
 * This regex and the `-d1` listing depth are the contract with the plugin —
 * re-read the plugin on the target PVE version before changing either.
 */
export const PVE_GUEST_VOLUME_RE = /^(vm|base|subvol|basevol)-\d+-\S+$/

/** The dataset's basename would make PVE inventory it as a guest disk. */
export function isPveGuestName(basename: string): boolean {
  return PVE_GUEST_VOLUME_RE.test(basename)
}

/**
 * The dataset a storage ref's configured path resolves onto, or undefined
 * when the ref carries no footprint (`zfs` storages are not a footprint; a
 * `dir` ref whose path resolved onto nothing has none). A `zfspool` ref
 * without a configured path points at the bare pool root.
 */
export function pveStoragePath(ref: PveStorageRef, poolRoot: string): string | undefined {
  if (ref.type === 'zfspool')
    return ref.dataset ?? poolRoot
  if (ref.type === 'dir')
    return ref.dataset
  return undefined
}

function parentOf(name: string): string | undefined {
  const i = name.lastIndexOf('/')
  return i === -1 ? undefined : name.slice(0, i)
}

function baseOf(name: string): string {
  const i = name.lastIndexOf('/')
  return i === -1 ? name : name.slice(i + 1)
}

function isUnder(ancestor: string, name: string): boolean {
  return name.startsWith(`${ancestor}/`)
}

/**
 * Rule (d): the system/boot tree. Applies only when `system` facts are given
 * FOR THIS POOL and at least one boot dataset is set. Each boot dataset is
 * owned, every ancestor of it up to and including the pool root, and
 * everything under the boot dataset's parent (the whole pool when the boot
 * dataset IS the pool root — there is no parent, and the boot tree is the
 * pool). `storage` is undefined; the reason names the pool and dataset.
 */
function systemOwnership(dataset: string, poolRoot: string, system?: SystemPoolFacts): PveOwnership | null {
  if (!system || system.pool !== poolRoot)
    return null
  const boots = [...new Set([system.bootfs, system.rootDataset].filter((b): b is string => !!b))]
  if (boots.length === 0)
    return null
  for (const boot of boots) {
    if (dataset === boot)
      return { kind: 'system', reason: `${dataset} is the boot filesystem of pool ${poolRoot}` }
  }
  for (const boot of boots) {
    // Ancestors of the boot dataset, up to and including the pool root.
    for (let cur = parentOf(boot); cur !== undefined; cur = parentOf(cur)) {
      if (dataset === cur)
        return { kind: 'system', reason: `${dataset} holds the boot filesystems of pool ${poolRoot}` }
    }
    // Everything under the boot dataset's parent (recursively). When the boot
    // dataset is the pool root there is no parent — the pool root is the
    // umbrella and the whole pool is system-owned.
    const umbrella = parentOf(boot) ?? boot
    if (dataset === umbrella || isUnder(umbrella, dataset)) {
      return {
        kind: 'system',
        reason: `${dataset} is under ${umbrella}, which holds the boot filesystems of pool ${poolRoot}`,
      }
    }
  }
  return null
}

/**
 * Which PVE storage owns `dataset` — a full ZFS name like
 * `rpool/data/vm-100-disk-0` (the pool root is its first path segment).
 * Returns null when the dataset is outside PVE's footprint, i.e. ANAS may
 * manage it. Rules, in precedence:
 *
 *  (d) system       — the boot tree (see systemOwnership); wins over anything
 *  (a) storage-root — the dataset IS a zfspool ref's configured path
 *  (b) guest-volume — the dataset's parent is a zfspool ref's configured path
 *                     AND its basename matches PVE_GUEST_VOLUME_RE
 *  (c) dir-storage  — the dataset equals or lies under a `dir` ref's dataset
 *
 * Subtree inheritance: any ancestor owned by (b) or (c) makes the dataset
 * owned with that same kind and storage (a guest subvol's children, a dir
 * storage's tree). Ancestors owned only by (a) do NOT propagate — children of
 * a storage root that are not guest-named are NOT owned. A storage root
 * itself is never inherited through either way.
 */
export function pveOwnership(refs: PveStorageRef[], dataset: string, system?: SystemPoolFacts): PveOwnership | null {
  const poolRoot = dataset.split('/')[0]
  const systemOwned = systemOwnership(dataset, poolRoot, system)
  if (systemOwned)
    return systemOwned

  for (const ref of refs) {
    const path = pveStoragePath(ref, poolRoot)
    if (ref.type === 'zfspool' && path !== undefined && dataset === path) {
      return {
        kind: 'storage-root',
        storage: ref.storage,
        reason: `PVE storage '${ref.storage}' owns ${dataset} as a storage root`,
      }
    }
  }

  for (const ref of refs) {
    const path = pveStoragePath(ref, poolRoot)
    if (ref.type === 'zfspool' && path !== undefined && parentOf(dataset) === path && isPveGuestName(baseOf(dataset))) {
      return {
        kind: 'guest-volume',
        storage: ref.storage,
        reason: `PVE storage '${ref.storage}' owns ${dataset} as a guest volume`,
      }
    }
  }

  for (const ref of refs) {
    const path = pveStoragePath(ref, poolRoot)
    if (ref.type === 'dir' && path !== undefined && (dataset === path || isUnder(path, dataset))) {
      return {
        kind: 'dir-storage',
        storage: ref.storage,
        reason: `PVE storage '${ref.storage}' owns ${dataset} as directory storage`,
      }
    }
  }

  // Subtree inheritance from the nearest owned ancestor down. A dir storage's
  // rule (c) is already transitive, so its branch here only guards a future
  // narrowing of (c); the guest-volume branch is the live one.
  for (let cur = parentOf(dataset); cur !== undefined; cur = parentOf(cur)) {
    for (const ref of refs) {
      const path = pveStoragePath(ref, poolRoot)
      if (path === undefined)
        continue
      if (ref.type === 'zfspool' && parentOf(cur) === path && isPveGuestName(baseOf(cur))) {
        return {
          kind: 'guest-volume',
          storage: ref.storage,
          reason: `PVE storage '${ref.storage}' owns ${dataset} under guest volume ${cur}`,
        }
      }
      if (ref.type === 'dir' && (cur === path || isUnder(path, cur))) {
        return {
          kind: 'dir-storage',
          storage: ref.storage,
          reason: `PVE storage '${ref.storage}' owns ${dataset} under directory storage ${cur}`,
        }
      }
    }
  }

  return null
}

/**
 * The naming guard for dataset create/rename/clone: non-null when PVE would
 * inventory the dataset on its next `zfs list -d1` — its parent is a zfspool
 * ref's configured path and its basename matches the guest-volume regex.
 * Only the zfspool direct-child shape counts; a dir storage inventories
 * plain files, and deeper nesting is never listed.
 */
export function wouldBeClaimedByPve(refs: PveStorageRef[], dataset: string): { storage: string } | null {
  const parent = parentOf(dataset)
  if (parent === undefined || !isPveGuestName(baseOf(dataset)))
    return null
  const poolRoot = parent.split('/')[0]
  for (const ref of refs) {
    if (ref.type !== 'zfspool')
      continue
    if (pveStoragePath(ref, poolRoot) === parent)
      return { storage: ref.storage }
  }
  return null
}
