import type { CommandExecutor } from '../executor/types.js'
import { readFile } from 'node:fs/promises'
import { isPathWithin } from '@anas/shared'
import { parseFindmnt } from '../parsers/findmnt.js'
import { parseFstab } from '../parsers/fstab.js'
import { readFindmnt } from './mounts.js'

/**
 * The ONE configured-but-unmounted source check (story rclone.2; story
 * backup2.11 wires it into backup).
 *
 * The incident it exists for: a boot race left a CIFS mount defined in
 * `/etc/fstab` unmounted, and the job that read through it saw the EMPTY
 * MOUNTPOINT DIRECTORY and happily did its work on nothing. For a backup that
 * is a near-empty snapshot presented as a good one; for an rclone `sync` it is
 * the catastrophic shape — an empty source mirrors as a delete of everything at
 * the destination. So a path that sits on a mount the system was configured to
 * have, and does not currently have, is REFUSED with the mount named.
 *
 * The two facts are ones the daemon already reads for the Mounts view and
 * nothing else is consulted:
 *   1. `/etc/fstab` — what the system is configured to mount (the parser is
 *      Mounts' own, so a disabled `#ANAS ` line is still a configured mount and
 *      an entry with a non-absolute mountpoint — swap — is already dropped).
 *   2. `findmnt --json` — what is mounted right now. It reads
 *      `/proc/self/mountinfo`, so it can never hang, even on a dead NFS server.
 *
 * Two deliberate limits, both stated rather than papered over:
 *   - ONLY an fstab-configured mount is detectable. A path under a mount
 *     somebody mounted by hand and then unmounted is indistinguishable from a
 *     path that was always a plain directory — nothing on the system records
 *     the intent. An absent path is the caller's own existence check.
 *   - FAIL OPEN. An unreadable mount table (or an unreadable fstab) means the
 *     guard cannot see the system, and a guard that cannot see must not claim
 *     a mount is missing: it passes, exactly as every other derivation in this
 *     daemon fails open rather than blocking on its own blindness.
 */

/** The facts one guard pass needs — read once, reusable for several paths. */
export interface SourceGuardFacts {
  /** Every fstab-configured mount, absolute mountpoints only (file order). */
  configured: { mountpoint: string, disabled: boolean }[]
  /** Mountpoints the kernel currently has (findmnt targets). */
  mounted: Set<string>
  /**
   * The mount table could not be read. While true the guard passes everything
   * — it has no evidence that anything is missing (fail open).
   */
  mountTableUnavailable: boolean
}

/** A configured mount that is not currently mounted. */
export interface UnmountedMount {
  mountpoint: string
  /** Its fstab line is commented out with the `#ANAS ` marker (disabled, not deleted). */
  disabled: boolean
}

/**
 * Build the facts from the two texts. PURE, so every case in the matrix (source
 * on an unmounted mount, under one, on a mounted one, on no configured mount at
 * all, an unreadable table) is expressible as two strings.
 */
export function buildSourceGuardFacts(fstabText: string, findmntText: string): SourceGuardFacts {
  const nodes = parseFindmnt(findmntText)
  return {
    configured: parseFstab(fstabText).map(e => ({ mountpoint: e.mountpoint, disabled: e.disabled === true })),
    mounted: new Set(nodes.map(n => n.target)),
    // An empty table is the unreadable case: a running Linux system always has
    // at least `/` mounted, so zero rows can only mean the read failed — and
    // without it EVERY path would look like it sits on an unmounted `/`.
    mountTableUnavailable: nodes.length === 0,
  }
}

/** Read the two facts the way the Mounts view reads them. Never throws. */
export async function readSourceGuardFacts(
  executor: CommandExecutor,
  fstabPath: string,
): Promise<SourceGuardFacts> {
  let fstabText = ''
  try {
    fstabText = await readFile(fstabPath, 'utf-8')
  }
  catch {
    // Absent or unreadable fstab: nothing is configured as far as we can tell.
  }
  return buildSourceGuardFacts(fstabText, await readFindmnt(executor))
}

/**
 * The configured-but-unmounted mount `path` sits on, or null when there is
 * none.
 *
 * LONGEST-PREFIX match, exactly as the consistency derivation finds a path's
 * filesystem: the deepest configured mountpoint containing the path is the one
 * the path is actually on, and a shallower one being absent says nothing about
 * it. Pure prefix arithmetic — the path itself is never touched (the hang trap
 * applies here as everywhere).
 */
export function unmountedMountFor(path: string, facts: SourceGuardFacts): UnmountedMount | null {
  if (facts.mountTableUnavailable)
    return null
  let best: { mountpoint: string, disabled: boolean } | null = null
  let bestLen = -1
  for (const entry of facts.configured) {
    if (!isPathWithin(entry.mountpoint, path))
      continue
    const len = entry.mountpoint === '/' ? 0 : entry.mountpoint.length
    if (len > bestLen) {
      best = entry
      bestLen = len
    }
  }
  if (!best || facts.mounted.has(best.mountpoint))
    return null
  return { mountpoint: best.mountpoint, disabled: best.disabled }
}

/**
 * The refusal sentence. ASCII only (it becomes a job error and a notification
 * body line — the mojibake rule), and it NAMES the mount, because "the source
 * is empty" without the mount name sends the operator looking in the wrong
 * place.
 */
export function unmountedSourceRefusal(path: string, mount: UnmountedMount): string {
  const where = path === mount.mountpoint ? `${path} is` : `${path} is under ${mount.mountpoint}, which is`
  const disabled = mount.disabled ? ' (its /etc/fstab entry is disabled)' : ''
  return `${where} a mount defined in /etc/fstab but not mounted right now${disabled} - `
    + `the directory would be empty or incomplete, so the run is refused instead of reading through it. `
    + `Mount ${mount.mountpoint} and run it again.`
}

/**
 * The whole guard in one call: the refusal sentence for `path`, or null when it
 * is not on a configured-but-unmounted mount. The caller decides what a
 * refusal means (a 400 on a door, a thrown run failure inside a job).
 */
export function guardSourcePath(path: string, facts: SourceGuardFacts): string | null {
  const mount = unmountedMountFor(path, facts)
  return mount ? unmountedSourceRefusal(path, mount) : null
}

/** {@link guardSourcePath} with its own fact read — the one-shot form. */
export async function guardSource(
  executor: CommandExecutor,
  path: string,
  fstabPath: string,
): Promise<string | null> {
  return guardSourcePath(path, await readSourceGuardFacts(executor, fstabPath))
}
