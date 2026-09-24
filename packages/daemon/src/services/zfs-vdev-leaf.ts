import type { PoolDisk, Vdev, VdevRole } from '@anas/shared'
import type { ParsedPoolStatus } from '../parsers/zpool-status.js'
import { basename } from 'node:path'

/**
 * Stories vdevs.1 / vdevs.2 — finding the ONE leaf a request names against the
 * pool's own `zpool status`, shared by every route that hands ZFS a device.
 *
 * The removal path (`zfs-vdev-remove.ts`) and the attach/replace path
 * (`POST /pools/:name/attach`) ask the SAME question — which leaf does this
 * name fit, and what device does ZFS know it by — so they ask it in one place.
 * They differ only in what they do with the answer: a removal of a leaf inside
 * a mirrored log takes out the whole `mirror-N`, while a replace acts on the
 * leaf itself.
 *
 * The shape that makes this necessary is the #66 layout: a pool built from
 * by-id PARTITIONS of one device (log on `-part1`, cache on `-part2`, data on
 * `-part3`). The parser strips `-partN` to derive the DISK's identity, so all
 * three leaves carry the same `disk.id` — a name that fits more than one leaf
 * is a name we must not guess at.
 */

/** A leaf of the pool, with the vdev and class it sits in. */
export interface PoolLeafMatch {
  /** The class its top-level vdev belongs to. */
  role: VdevRole
  /** The top-level vdev it is (or belongs to), as the pool view shows it. */
  vdev: Vdev
  /** The leaf itself — `disk.path` is what ZFS knows it by. */
  disk: PoolDisk
}

/** A name the pool DOES carry but must not act on, with the sentence to say. */
export interface VdevRefusal {
  refusal: true
  message: string
}

export function isVdevRefusal(lookup: unknown): lookup is VdevRefusal {
  return typeof lookup === 'object' && lookup !== null && 'refusal' in lookup
}

/** The refusal for a name the pool does not carry. */
export function unknownVdevMessage(pool: string, vdev: string): string {
  return `pool ${pool} carries no vdev '${vdev}'`
}

/**
 * The refusal for a name that fits more than one leaf. A split device — one SSD
 * partitioned into a log and a cache — carries two leaves whose by-id DISK
 * identity is the same string (the `-partN` suffix is what tells them apart),
 * so a request naming the disk names both, and guessing would take out (or
 * replace) the SLOG of an operator who picked the L2ARC (GitHub #66 layout).
 */
export function ambiguousVdevMessage(pool: string, vdev: string, candidates: string[]): string {
  return `'${vdev}' names more than one device in pool ${pool} (${candidates.join(', ')}) — name the one you mean by its device`
}

/** How a candidate reads in the ambiguity sentence: `cache ata-SSD-part2`. */
export function describeCandidate(role: VdevRole, token: string): string {
  return `${role} ${basename(token)}`
}

/** The three spellings a leaf answers to: its path, its basename, its id. */
export function namesLeaf(disk: { id: string, path: string }, name: string): boolean {
  return disk.path === name || basename(disk.path) === name || disk.id === name
}

/**
 * Every leaf of the pool that `name` fits, in topology order. The caller
 * decides what a hit means and whether more than one is an ambiguity.
 */
export function matchPoolLeaves(status: ParsedPoolStatus, name: string): PoolLeafMatch[] {
  const matches: PoolLeafMatch[] = []
  for (const group of status.vdevGroups) {
    for (const vdev of group.vdevs) {
      for (const disk of vdev.disks) {
        if (namesLeaf(disk, name))
          matches.push({ role: group.role, vdev, disk })
      }
    }
  }
  return matches
}

/** One leaf device, resolved from the name a request named it by. */
export interface ResolvedLeaf {
  /** The class it belongs to. */
  role: VdevRole
  /** The top-level vdev it sits in, as the pool view shows it. */
  vdev: string
  /** Exactly what `zpool replace`/`attach` is handed for the EXISTING leaf. */
  path: string
}

/** What a leaf lookup answers: the one leaf, a refusal sentence, or nothing. */
export type LeafLookup = ResolvedLeaf | VdevRefusal | null

/**
 * The leaf DEVICE a name refers to — the attach/replace answer, where the unit
 * is always the leaf itself (a mirror leg is replaced on its own; the vdev it
 * belongs to is not what changes).
 *
 * Three answers, never a guess: one leaf, a refusal naming the candidates when
 * the name fits several, or nothing. An ACTIVE spare is listed twice (in the
 * vdev it patches and in the spares section) but it is ONE device, so matches
 * are deduplicated by device path before they are counted.
 */
export function resolveLeafDevice(status: ParsedPoolStatus, name: string): LeafLookup {
  const byPath = new Map<string, PoolLeafMatch>()
  for (const match of matchPoolLeaves(status, name)) {
    if (!byPath.has(match.disk.path))
      byPath.set(match.disk.path, match)
  }
  const unique = [...byPath.values()]
  if (unique.length === 0)
    return null
  if (unique.length > 1) {
    return {
      refusal: true,
      message: ambiguousVdevMessage(
        status.name,
        name,
        unique.map(m => describeCandidate(m.role, m.disk.path)),
      ),
    }
  }
  const [one] = unique
  return { role: one.role, vdev: one.vdev.name, path: one.disk.path }
}
