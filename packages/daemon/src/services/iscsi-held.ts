/**
 * "Is a LUN holding this?" — the ONE question the rest of ANAS asks before it
 * destroys, exports, rolls back, renames, shrinks or unmounts anything (story
 * `iscsi.6`).
 *
 * Why this exists at all: LIO's claim on a backing object is invisible to every
 * tool that normally answers "who is holding this open". `fuser -m`, `lsof` and
 * `/sys/block/<dev>/holders/` all report NOTHING for a device the kernel target
 * is serving (GT-41) — the claim lives only in configfs. And ZFS refuses only
 * two of the operations that would break a live LUN: `zpool destroy`/`export`
 * and `zfs destroy` fail with `dataset is busy`, while **`zfs rollback`, `zfs
 * rename`, a `volsize` shrink and an `rm` of a backing image all succeed
 * silently** under a live session with a mounted filesystem on the initiator
 * (GT-40). Nothing below ANAS is going to stop those, so ANAS stops them.
 *
 * Three rules shape this module:
 *
 *  1. **One source.** Everything is derived from `iscsiClaims()` — the same
 *     configfs-derived read `GET /v1/iscsi/claims` serves. No second reader, no
 *     second phrasing (the holder sentence comes from `describeLunHolder`).
 *  2. **Cached per request, never across requests.** A list endpoint asks once
 *     and answers for every row; the next request reads again. There is no
 *     shadow state and no TTL cache to go stale (Principle 11) — a LUN added a
 *     second ago must be visible to the very next refusal.
 *  3. **Fail-open.** No LIO on the node, an unreadable configfs, a throw
 *     anywhere: nothing is held, and the verb proceeds exactly as it did before
 *     this story. A read failure must never be the reason a pool cannot be
 *     destroyed — the same posture `busy-diagnosis.ts` has taken since 3.29.
 */

import type { IscsiClaim, IscsiHeldByLun } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { ConfigfsOptions } from './iscsi-configfs.js'
import type { IscsiPaths } from './iscsi.js'
import { iscsiClaims, readIscsiState } from './iscsi-mutate.js'

/** Trailing slashes, stripped before any path comparison. */
const TRAILING_SLASH_RE = /\/+$/

/**
 * What the caller is about to touch. Any field that is set is tried; a claim
 * matching ANY of them is a hold. Callers pass every identity they know — a
 * filesystem dataset passes both its `dataset` name (which catches a child
 * zvol) and its `path` mountpoint (which catches an image file inside it).
 */
export interface HeldByLunSubject {
  /** A ZFS pool root or an AHR pool name — any LUN whose backing sits on it. */
  pool?: string
  /** A ZFS dataset: the zvol itself, the image's dataset, or an ANCESTOR. */
  dataset?: string
  /** An absolute path: the exact file/device, or a directory anything sits under. */
  path?: string
}

/**
 * A claims reader that reads at most once.
 *
 * Deliberately a factory rather than a module-level cache: the lifetime is the
 * caller's, which in practice is one HTTP request. Nothing here survives the
 * response.
 */
export interface IscsiClaimCache {
  /** Every backing object a LUN currently holds. Never throws; `[]` on failure. */
  claims: () => Promise<IscsiClaim[]>
}

/**
 * The configfs half of an {@link IscsiPaths} override, in the shape
 * `busy-diagnosis` and `iscsi-configfs` take. One conversion, so a route that
 * already carries `iscsiPaths` can hand the LIO branch its test root without
 * every caller re-deriving the field names.
 */
export function configfsOptionsFrom(paths: IscsiPaths): ConfigfsOptions {
  const opts: ConfigfsOptions = {}
  if (paths.configfsRoot !== undefined)
    opts.root = paths.configfsRoot
  if (paths.blockRoot !== undefined)
    opts.blockRoot = paths.blockRoot
  return opts
}

/** Strip trailing slashes for path comparison (`/tank/` → `/tank`). */
function canonical(path: string): string {
  return path.replace(TRAILING_SLASH_RE, '') || '/'
}

/**
 * Is `path` AT or UNDER `dir`? (`/tank` must not swallow `/tank-other`.)
 *
 * `/` is deliberately NOT an ancestor of anything here. Every backing path in
 * the system is under `/`, so a root subject would report every object as held —
 * and the root filesystem is in the Mounts inventory, so this is not
 * hypothetical. No screen ever legitimately asks "does a LUN live under `/`".
 */
function isUnder(path: string, dir: string): boolean {
  if (dir === '/')
    return false
  return path === dir || path.startsWith(`${dir}/`)
}

/** Is `dataset` the named dataset or a descendant of it? */
function isDescendantDataset(dataset: string, ancestor: string): boolean {
  return dataset === ancestor || dataset.startsWith(`${ancestor}/`)
}

/**
 * Create a per-request claims cache. The read happens on the FIRST call and is
 * shared by every later one (the in-flight promise is memoised, so N parallel
 * rows still cost one read).
 */
export function createIscsiClaimCache(
  executor: CommandExecutor,
  paths: IscsiPaths = {},
): IscsiClaimCache {
  let pending: Promise<IscsiClaim[]> | null = null
  return {
    claims() {
      pending ??= iscsiClaims(executor, paths)
        .then(r => r.claims)
        .catch((err: unknown) => {
          // FAIL-OPEN. A node with no LIO reports `installed: false` and an
          // empty list without throwing; this catches the genuinely broken
          // cases (an unreadable configfs, a malformed saveconfig).
          console.warn('anasd: could not read iSCSI claims for the held-by-LUN check:', err)
          return []
        })
      return pending
    },
  }
}

/** Does this claim hold anything the subject names? */
export function claimHoldsSubject(claim: IscsiClaim, subject: HeldByLunSubject): boolean {
  if (subject.pool !== undefined && subject.pool.length > 0 && claim.pool === subject.pool)
    return true
  if (subject.dataset !== undefined && subject.dataset.length > 0 && claim.dataset !== undefined
    && isDescendantDataset(claim.dataset, subject.dataset)) {
    return true
  }
  if (subject.path !== undefined && subject.path.startsWith('/') && claim.backingPath.length > 0
    && isUnder(canonical(claim.backingPath), canonical(subject.path))) {
    return true
  }
  return false
}

/** The wire shape, reduced from the claim. One sentence, one source. */
export function toHeldByLun(claim: IscsiClaim): IscsiHeldByLun {
  return {
    targetIqn: claim.targetIqn,
    index: claim.lunIndex,
    name: claim.backstoreName,
    backingPath: claim.backingPath,
    connectedInitiators: claim.connectedInitiators,
    detail: claim.detail,
  }
}

/**
 * The holding LUN, or null.
 *
 * When several LUNs hold the same subject — a pool with three image files on it
 * — the one with LIVE SESSIONS is named first: it is the one whose initiator is
 * about to lose its disk, and naming an idle LUN instead would understate the
 * blast radius. Otherwise the first claim in read order wins (stable across
 * calls, because the read walks configfs in directory order).
 */
export function pickHolder(claims: IscsiClaim[], subject: HeldByLunSubject): IscsiHeldByLun | null {
  let first: IscsiClaim | null = null
  for (const claim of claims) {
    if (!claimHoldsSubject(claim, subject))
      continue
    if (claim.connectedInitiators.length > 0)
      return toHeldByLun(claim)
    first ??= claim
  }
  return first ? toHeldByLun(first) : null
}

/** `pickHolder` against a per-request cache — the form the routes call. */
export async function heldByLun(
  cache: IscsiClaimCache,
  subject: HeldByLunSubject,
): Promise<IscsiHeldByLun | null> {
  return pickHolder(await cache.claims(), subject)
}

/**
 * A one-shot lookup for a caller with no cache to share (a single-row verb).
 * Still one read — it just does not outlive the call.
 */
export async function heldByLunOnce(
  executor: CommandExecutor,
  subject: HeldByLunSubject,
  paths: IscsiPaths = {},
): Promise<IscsiHeldByLun | null> {
  return heldByLun(createIscsiClaimCache(executor, paths), subject)
}

// ---------------------------------------------------------------------------
// The disk-inventory seam (story iscsi.6, clause 6)
// ---------------------------------------------------------------------------

/**
 * Normalise a SCSI serial for comparison: lowercase, dashes stripped.
 *
 * LIO stores the unit serial as the UUID ANAS generated (`9bc6e907-6015-…`) and
 * the initiator's `lsblk SERIAL` reads it back in exactly that form (GT-43),
 * but the by-id/T10 designator carries the same digits with no dashes. One
 * normalisation makes the comparison survive either rendering without a second
 * matching rule.
 */
export function normalizeSerial(serial: string): string {
  return serial.toLowerCase().replaceAll('-', '')
}

/**
 * Every unit serial THIS node serves as a LUN, normalised.
 *
 * The loop-back hazard this exists for (GT-43): when the node's own initiator is
 * logged in to the node's own target, its LUNs come back as ordinary blank SCSI
 * disks — `transport: iscsi`, `status: available` — and the composer would
 * happily build a pool on storage that lives on the same node, on top of itself.
 * Nothing in `lsblk` can tell that disk apart from a real remote array; only the
 * serial can, because ANAS is the one that assigned it.
 *
 * FAIL-OPEN: an unreadable LIO tree yields an empty set and nothing is tagged.
 */
export async function iscsiServedSerials(
  executor: CommandExecutor,
  paths: IscsiPaths = {},
): Promise<Set<string>> {
  try {
    const { targets } = await readIscsiState(executor, paths)
    const serials = new Set<string>()
    for (const target of targets) {
      for (const lun of target.luns) {
        if (lun.serial)
          serials.add(normalizeSerial(lun.serial))
      }
    }
    return serials
  }
  catch (err: unknown) {
    console.warn('anasd: could not read this node\'s LUN serials for the disk inventory:', err)
    return new Set<string>()
  }
}

/** A refusal built by {@link heldByLunRefusal} — 409, no confirm code. */
export interface HeldByLunRefusal {
  reason: 'held-by-lun'
  message: string
  heldByLun: IscsiHeldByLun
}

/**
 * The guiding 409 body.
 *
 * Safety altitude: this is the **hard 409 with no bypass** tier — "unsafe NOW",
 * like a busy reshape, not "dangerous but yours to confirm". There is no safe
 * way to pull a block device out from under a live SCSI target, and a confirm
 * code would only make the data loss a two-click one.
 *
 * "Guide, don't just warn" means naming BOTH ways out, because they are
 * genuinely different intentions:
 *
 *   - delete the LUN and keep the data (the target stops serving it), or
 *   - delete the LUN **with `?destroyBacking=true`** and let the iSCSI screen
 *     destroy the zvol / image in the same step, which is what an operator who
 *     came here to reclaim the space actually wanted.
 */
export function heldByLunRefusal(
  what: string,
  action: string,
  held: IscsiHeldByLun,
): HeldByLunRefusal {
  const sessions = held.connectedInitiators.length
  const live = sessions > 0
    ? ` ${sessions} initiator${sessions === 1 ? ' is' : 's are'} logged in right now (${held.connectedInitiators.join(', ')}) and would lose the disk mid-write.`
    : ''
  return {
    reason: 'held-by-lun',
    message: `${action} ${what} is refused: it is ${held.detail}.${live} `
      // Backend-neutral on purpose: this one sentence is rendered for ZFS pools
      // and datasets, AHR (btrfs on LVM on md) pools and remote mounts alike, so
      // naming ZFS made it a false statement on three of the four (live-proof
      // wave 2 read an AHR pool refusal that blamed ZFS).
      + `Nothing underneath stops this on its own — the operation would either fail with a bare 'busy' error or succeed silently and corrupt what the initiator sees. `
      + `Delete LUN ${held.index} ('${held.name}') of target ${held.targetIqn} from the iSCSI screen first, `
      + `or delete it with destroyBacking=true to remove the backing object in the same step. `
      + `This refusal has no confirm bypass.`,
    heldByLun: held,
  }
}
