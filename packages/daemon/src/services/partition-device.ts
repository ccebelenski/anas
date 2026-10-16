/**
 * A by-id PARTITION as the new device of an attach, replace or raidz expand
 * (story nf.1, D1 of the 0.4.4 wave-3 node pass; the vdevs.2 / GitHub #66
 * layout). The whole-disk composability pre-flight (cr.12) resolves a new
 * device against the disk INVENTORY, which lists whole disks only, so every
 * `<disk>-partN` read "not found" and a partition-backed leaf could never be
 * replaced by another partition. A partition is checked on what it is
 * instead: that it exists and is a partition, that the disk it sits on is one
 * the inventory knows and is not hands-off, that nothing mounts or holds it,
 * and that the block layer's own low-level probe finds no content on it.
 *
 * Pure parsers only; the route closure runs the reads (`routes/pools.ts`).
 */

/** A by-id partition name: `<disk by-id>-partN` (udev's own suffix). */
export const PART_BY_ID_RE = /-part\d+$/

/**
 * The columns the partition probe asks for. `lsblk <device>` lists the device
 * itself plus its dependents (a device-mapper or md child is a `children`
 * entry), so one call answers "is it a partition", "which disk" and "is
 * anything stacked on it". FSTYPE is deliberately not asked: lsblk reads
 * udev's cached probe, and the signature check is `blkid -p` (fresh).
 */
export const PARTITION_PROBE_ARGS = ['-J', '-o', 'NAME,TYPE,PKNAME,MOUNTPOINT']

/**
 * lsblk(8) EXIT STATUS: "32 none of specified devices found". The one
 * non-zero exit that is an answer (the partition is not there), not a failed
 * read.
 */
export const LSBLK_NONE_FOUND = 32

/**
 * blkid(8) EXIT STATUS: 0 = something was found, 2 = "no (specified) devices
 * could be identified", 8 = "an ambivalent probing result was detected by
 * low-level probing mode (-p)". Anything else is a failed read.
 */
export const BLKID_FOUND = 0
export const BLKID_NOTHING = 2
export const BLKID_AMBIVALENT = 8

/** `KEY="value"` pairs on a `blkid -p` line. */
const BLKID_PAIR_RE = /\b([A-Z_]+)="([^"]*)"/g

/** What the partition probe reports about one device. */
export interface PartitionProbe {
  /** The kernel name (`sdj4`) — lsblk follows the by-id symlink. */
  name: string
  /** lsblk TYPE: `part` for a partition. */
  type: string
  /** The kernel name of the disk the partition sits on. */
  pkname: string | null
  mountpoint: string | null
  /** Kernel names of anything stacked on the partition (dm, md, …). */
  holders: string[]
}

interface RawProbe { name?: unknown, type?: unknown, pkname?: unknown, mountpoint?: unknown, children?: unknown }

const str = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v : null

/**
 * Parse `lsblk -J -o NAME,TYPE,PKNAME,MOUNTPOINT <device>`. Null when the
 * answer is not lsblk's shape or names no device — an unreadable answer,
 * never "a blank partition".
 */
export function parsePartitionProbe(json: string): PartitionProbe | null {
  let dev: RawProbe | undefined
  try {
    dev = (JSON.parse(json) as { blockdevices?: RawProbe[] }).blockdevices?.[0]
  }
  catch {
    return null
  }
  const name = str(dev?.name)
  const type = str(dev?.type)
  if (!dev || !name || !type)
    return null
  const children = Array.isArray(dev.children) ? dev.children as RawProbe[] : []
  return {
    name,
    type,
    pkname: str(dev.pkname),
    mountpoint: str(dev.mountpoint),
    holders: children.map(c => str(c?.name) ?? '?'),
  }
}

/**
 * The CONTENT signatures on a `blkid -p` line, as `KEY=value`. Low-level
 * probing of a partition also reports where the partition sits in its
 * table (`PART_ENTRY_SCHEME`, `PART_ENTRY_UUID`, … — captured on the wave-3
 * node for a blank partition: `blkid -p …-part1` "shows only PART_ENTRY_*"),
 * and those say nothing about what the partition holds. Every other key —
 * `TYPE`, `USAGE`, `UUID`, `LABEL`, a nested `PTTYPE` — is content.
 */
export function blkidContentSignatures(stdout: string): string[] {
  const found: string[] = []
  for (const [, key, value] of stdout.matchAll(BLKID_PAIR_RE)) {
    if (!key.startsWith('PART_ENTRY_'))
      found.push(`${key}=${value}`)
  }
  return found
}

/**
 * The GPT partition NAME on a `blkid -p` line — its `PART_ENTRY_NAME` key —
 * or null when the partition is unnamed (the captured blank line
 * `zfs/blkid-p-blank-partition.txt` carries none) or the line is not
 * blkid's. The name says nothing about content (see
 * {@link blkidContentSignatures}), but it is where AHR writes its slice labels
 * (`<pool>-d<n>-b<band>`, `<pool>-cache<n>`; ZFS's own whole-disk label reads
 * `PART_ENTRY_NAME="zfs-be7977a25d6c0c32"` in the wave-3 capture
 * `docs/probes/wave3-node/out/n6-zpool-create.log`), so the ZFS partition gate
 * reads it to see the other door's slices (cr.57, review M3).
 */
export function blkidPartEntryName(stdout: string): string | null {
  for (const [, key, value] of stdout.matchAll(BLKID_PAIR_RE)) {
    if (key === 'PART_ENTRY_NAME')
      return value === '' ? null : value
  }
  return null
}
