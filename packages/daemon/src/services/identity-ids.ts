import type { CommandExecutor } from '../executor/types.js'
import type { FindmntNode } from '../parsers/findmnt.js'
import type { GuardReads } from '../safety/guard.js'
import type { WalkRoot } from './access-walk.js'
import { isPathWithin, SHARE_ID_MAX, SHARE_ID_MIN } from '@anas/shared'
import { CommandTimeoutError } from '../executor/deadline.js'
import { parseExports } from '../parsers/exports.js'
import { isFindmntTable } from '../parsers/findmnt.js'
import { isMutableShareId, parseGroups, parsePasswd } from '../parsers/getent.js'
import { parseSmbConf } from '../parsers/smb-conf.js'
import { findPathPattern, walkScopeFrom } from './access-walk.js'
import { isUnwalkableKind, kindOfMount, mountIndex, normalizePath } from './nested-filesystems.js'

// ============================================================================
// Which uid / gid a new share user or group gets (story cr.29, ruled
// 2026-10-15; WAVE2-DESIGN §6 — the ruling REPLACES its tombstones).
//
// `useradd` without `-u` hands out the highest uid in [UID_MIN, UID_MAX] + 1,
// so deleting the top share user gave its number — and every file it still
// owns — to the next user created (review M6 #25); `groupadd` the same for
// gids. ANAS now always passes `-u`/`-g`:
//
//  - explicit (the operator typed one on Add): used as given, refused only
//    when an account already holds it (the share band is the schema's);
//    NEVER checked for files — owning the old files is the point of it;
//  - picked: the highest in-band id any account holds, + 1 (useradd's own
//    rule: holes BELOW the top are exactly the numbers deleted accounts left,
//    the ones most likely to still own files), moving on past every id that
//    owns something under the paths ANAS manages, at most
//    {@link ID_PICK_TRIES} times.
//
// "Owns something" is read from two sources, both fail closed (a read that
// fails refuses the create, naming what could not be read — never a guess):
//
//  1. ZFS's own per-user / per-group accounting, one call per filesystem of
//     every imported pool. zfs-userspace(8), OpenZFS 2.x: "Displays space
//     consumed by, and quotas on, each user in the specified filesystem,
//     snapshot, or path" — `-H` "Do not print headers, use tab-delimited
//     output", `-p` "Use exact (parsable) numeric output", `-n` "Print
//     numeric ID instead of user/group name", `-o name` the one field,
//     `-t posixuser` (groupspace: `-t posixgroup`) the POSIX ids only. One
//     line per id, so one call answers for every candidate at once (6-12 ms
//     per dataset on the stunt node, probe P06). Snapshots are not read: the
//     ruling says "per dataset", and a node with thousands of snapshots would
//     put seconds on the request path.
//  2. A bounded `find` on every share root (smb.conf `path`, /etc/exports)
//     that is NOT on ZFS — btrfs (AHR), ext4, xfs — bounded exactly as nf.1's
//     recursive permission walk is (services/access-walk.ts: `-P`, `-xdev`
//     except on btrfs, every mount below the root `-prune`d by path), plus
//     `-uid N -print -quit` (find(1), findutils 4.10: "-uid n  File's numeric
//     user ID is less than, more than or exactly n"; "-quit  Exit immediately
//     (with return value zero if no errors have occurred)"). A local non-ZFS
//     filesystem mounted BELOW a share root becomes a walk root of its own
//     (nf.1 prunes it; here it still holds share files). Network filesystems
//     and armed automounts are never walked (nf.1's rule — walking a dead NFS
//     server hangs, walking an automount arms it); their files are numbered
//     by another host.
//
// The whole check shares one deadline per guard run ({@link ID_CHECK_BUDGET_MS}),
// so the route answers well inside the gateway's 20 s (cr.35 ladder: 10 s +
// TERM/KILL grace 7 s); a check that does not finish refuses like an
// unreadable one. The out for a node too large to walk is the explicit id.
// ============================================================================

const ZFS = '/usr/sbin/zfs'
const FIND = '/usr/bin/find'
const FINDMNT = '/usr/bin/findmnt'
const GETENT = '/usr/bin/getent'

/** Which number: a user's uid or a group's gid. */
export type IdKind = 'uid' | 'gid'

/** How many owning ids the pick moves past before it gives up and asks for an explicit one. */
export const ID_PICK_TRIES = 32

/** One guard run's whole ownership check (zfs list/userspace, findmnt, every find). */
export const ID_CHECK_BUDGET_MS = 10_000

/** What a check found: nothing, something (and where), or a source it could not read. */
export type Ownership
  = | { owns: false }
    | { owns: true, where: string }
    | { unreadable: string }

/** What a candidate is checked against, read once per guard run. */
export interface OwnershipSources {
  /** Every ZFS filesystem of every imported pool. */
  datasets: string[]
  /** The non-ZFS share roots to walk, bounded as nf.1's walk is. */
  roots: WalkRoot[]
}

/** The reads the check needs beside the executor (the route's own, so tests serve them). */
export interface OwnershipReadOpts {
  executor: CommandExecutor
  reads: GuardReads
  /** smb.conf's text; null when it could not be read (an absent file reads as ''). */
  smbConf: () => Promise<string | null>
  /** /etc/exports' text; null when it could not be read (an absent file reads as ''). */
  exports: () => Promise<string | null>
  /** Clock and budget, injectable for the deadline test. */
  now?: () => number
  budgetMs?: number
}

const NOUN: Record<IdKind, { space: string, type: string, findTest: string }> = {
  uid: { space: 'userspace', type: 'posixuser', findTest: '-uid' },
  gid: { space: 'groupspace', type: 'posixgroup', findTest: '-gid' },
}

const ID_LINE_RE = /^\d+$/

/**
 * `zfs userspace|groupspace -H -p -n -o name -t posix…` output → the ids.
 * One numeric id per line; anything else is not the shape asked for, and an
 * unknown shape is unreadable (null), never "nobody owns anything".
 */
export function parseSpaceIds(stdout: string): number[] | null {
  const ids: number[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line)
      continue
    if (!ID_LINE_RE.test(line))
      return null
    ids.push(Number(line))
  }
  return ids
}

/** `zfs userspace -H -p -n -o name -t posixuser -- <fs>` (groupspace: `-t posixgroup`). */
export function spaceArgs(kind: IdKind, dataset: string): string[] {
  return [NOUN[kind].space, '-H', '-p', '-n', '-o', 'name', '-t', NOUN[kind].type, '--', dataset]
}

/**
 * The `find` argv that asks "does `id` own anything under this root?": the
 * same start, `-xdev` and prune as nf.1's {@link walkArgs}, then
 * `-uid N -print -quit` (or `-gid`) — the first match ends the walk.
 */
export function ownerFindArgs(kind: IdKind, id: number, root: WalkRoot): string[] {
  const args = ['-P', root.path]
  if (root.xdev)
    args.push('-xdev')
  if (root.prune.length > 0) {
    const terms = root.prune.flatMap((p, i) => [...(i > 0 ? ['-o'] : []), '-path', findPathPattern(p)])
    args.push('(', ...terms, ')', '-prune', '-o')
  }
  args.push(NOUN[kind].findTest, String(id), '-print', '-quit')
  return args
}

/** The findmnt row of the filesystem `path` sits on (the longest mount target containing it). */
function mountOf(path: string, mounts: Map<string, FindmntNode>): FindmntNode | undefined {
  let best: FindmntNode | undefined
  for (const [target, node] of mounts) {
    if (isPathWithin(target, path) && (!best || target.length > best.target.length))
      best = node
  }
  return best
}

/**
 * The walk roots for a set of share paths over a mount table. A root on ZFS is
 * covered by the accounting; a network filesystem or automount is never
 * walked; every other share root is walked with nf.1's bounds, and every local
 * non-ZFS mount below it (which that bound prunes) becomes a root of its own.
 * A root another root already reaches on the same filesystem is dropped.
 */
export function shareWalkRoots(sharePaths: string[], mounts: Map<string, FindmntNode>): WalkRoot[] {
  // Two steps on an array we own (`toSorted()` is ES2023; this package targets ES2022).
  const pending = [...new Set(sharePaths.filter(p => p.startsWith('/')).map(normalizePath))]
  pending.sort()
  const seen = new Set<string>()
  const roots: WalkRoot[] = []
  while (pending.length > 0) {
    const path = pending.shift()!
    if (seen.has(path))
      continue
    seen.add(path)
    const own = mountOf(path, mounts)
    if (!own || own.fstype === 'zfs' || isUnwalkableKind(kindOfMount(own)))
      continue
    const scope = walkScopeFrom(path, mounts, [])
    roots.push(scope.roots[0])
    for (const ex of scope.excluded) {
      const node = mounts.get(ex.target)
      if (node && node.fstype !== 'zfs' && !isUnwalkableKind(kindOfMount(node)))
        pending.push(ex.target)
    }
  }
  // A root inside another root, on the same filesystem, is already walked.
  return roots
    .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))
    .filter((r, i, all) => !all.slice(0, i).some(p => isPathWithin(p.path, r.path) && mountOf(p.path, mounts) === mountOf(r.path, mounts)))
}

/** `<what> (<command>: <stderr or exit code>)` — the unreadable sentence's tail. */
function failed(what: string, command: string, r: { stderr: string, exitCode: number }): { unreadable: string } {
  return { unreadable: `${what} (${command}: ${r.stderr.trim() || `exit code ${r.exitCode}`})` }
}

/** The one deadline of this guard run's check. */
function deadlineOf(o: OwnershipReadOpts): Promise<number> {
  const now = o.now ?? Date.now
  return o.reads.once('idcheck:deadline', async () => now() + (o.budgetMs ?? ID_CHECK_BUDGET_MS))
}

/**
 * Run one read of the check inside its deadline: the remaining budget is the
 * command's `timeoutMs`; a spent budget or a timeout is an unreadable answer.
 */
async function withinDeadline<T>(
  o: OwnershipReadOpts,
  what: string,
  run: (timeoutMs: number) => Promise<T | { unreadable: string }>,
): Promise<T | { unreadable: string }> {
  const now = o.now ?? Date.now
  const left = (await deadlineOf(o)) - now()
  const budgetS = Math.round((o.budgetMs ?? ID_CHECK_BUDGET_MS) / 1000)
  const late = { unreadable: `${what} (the check did not finish within ${budgetS} s)` }
  if (left <= 0)
    return late
  try {
    return await run(left)
  }
  catch (err) {
    if (err instanceof CommandTimeoutError)
      return late
    return { unreadable: `${what} (${err instanceof Error ? err.message : String(err)})` }
  }
}

/** The datasets and walk roots, read once per guard run. */
export function readOwnershipSources(o: OwnershipReadOpts): Promise<OwnershipSources | { unreadable: string }> {
  return o.reads.once('idcheck:sources', async () => {
    const datasets = await withinDeadline(o, 'the list of ZFS filesystems', async (timeoutMs) => {
      const r = await o.executor.exec(ZFS, ['list', '-H', '-o', 'name', '-t', 'filesystem'], { timeoutMs })
      if (r.exitCode !== 0)
        return failed('the list of ZFS filesystems', 'zfs list', r)
      return r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    })
    if ('unreadable' in datasets)
      return datasets

    const smbConf = await o.smbConf()
    if (smbConf === null)
      return { unreadable: 'smb.conf (the SMB share paths)' }
    const exportsText = await o.exports()
    if (exportsText === null)
      return { unreadable: '/etc/exports (the NFS export paths)' }
    const paths = [...parseSmbConf(smbConf).shares.map(s => s.path), ...parseExports(exportsText).map(e => e.path)]
    if (paths.length === 0)
      return { datasets, roots: [] }

    const mounts = await withinDeadline(o, 'the mount table', async (timeoutMs) => {
      const r = await o.executor.exec(FINDMNT, ['--json'], { timeoutMs })
      if (r.exitCode !== 0 || !isFindmntTable(r.stdout))
        return failed('the mount table', 'findmnt', r.exitCode !== 0 ? r : { stderr: 'answered in an unknown shape', exitCode: r.exitCode })
      return mountIndex(r.stdout)
    })
    if ('unreadable' in mounts)
      return mounts
    return { datasets, roots: shareWalkRoots(paths, mounts) }
  })
}

/** Every id ZFS accounts for on any filesystem → the first filesystem it was seen on. */
function zfsOwners(kind: IdKind, o: OwnershipReadOpts, datasets: string[]): Promise<Map<number, string> | { unreadable: string }> {
  return o.reads.once(`idcheck:zfs:${kind}`, async () => {
    const owners = new Map<number, string>()
    for (const ds of datasets) {
      const what = `ZFS's ${kind === 'uid' ? 'per-user' : 'per-group'} accounting of '${ds}'`
      const ids = await withinDeadline(o, what, async (timeoutMs) => {
        const r = await o.executor.exec(ZFS, spaceArgs(kind, ds), { timeoutMs })
        if (r.exitCode !== 0)
          return failed(what, `zfs ${NOUN[kind].space}`, r)
        return parseSpaceIds(r.stdout) ?? { unreadable: `${what} (zfs ${NOUN[kind].space} answered in an unknown shape)` }
      })
      if ('unreadable' in ids)
        return ids
      for (const id of ids) {
        if (!owners.has(id))
          owners.set(id, ds)
      }
    }
    return owners
  })
}

/**
 * Does `id` own anything under the paths ANAS manages? Reads are shared
 * through `reads`, so a pick that checks several candidates lists the
 * datasets, reads the accounting and the mount table once.
 */
export async function idOwnership(kind: IdKind, id: number, o: OwnershipReadOpts): Promise<Ownership> {
  const sources = await readOwnershipSources(o)
  if ('unreadable' in sources)
    return sources
  const owners = await zfsOwners(kind, o, sources.datasets)
  if ('unreadable' in owners)
    return owners
  const ds = owners.get(id)
  if (ds !== undefined)
    return { owns: true, where: `the ZFS filesystem '${ds}'` }

  for (const root of sources.roots) {
    const what = `the files under '${root.path}'`
    const hit = await o.reads.once(`idcheck:find:${kind}:${id}:${root.path}`, () => withinDeadline(o, what, async (timeoutMs) => {
      const r = await o.executor.exec(FIND, ownerFindArgs(kind, id, root), { timeoutMs })
      const first = r.stdout.split('\n')[0]?.trim() ?? ''
      // A match is a match whatever else went wrong; no match is only an
      // answer when find says it examined everything (find(1) EXIT STATUS:
      // "if the return value is non-zero, you should not rely on the
      // correctness of the results").
      if (first)
        return first
      if (r.exitCode !== 0)
        return failed(what, 'find', r)
      return ''
    }))
    if (typeof hit !== 'string')
      return hit
    if (hit)
      return { owns: true, where: `'${hit}'` }
  }
  return { owns: false }
}

/**
 * The account holding `id`, looked up BY NUMBER through every NSS source. A
 * user found by uid also carries its primary gid (cr.29c: whether a group of
 * the same number would be that user's private group).
 */
export type IdHolder = { holder: string | null, primaryGid?: number } | { unreadable: string }

/**
 * `getent passwd <uid>` / `getent group <gid>`: a lookup by number reaches
 * every NSS source even where enumeration is off (sssd's default), which
 * `getent passwd` alone would not list. getent(1): exit 2 "One or more
 * supplied key could not be found in the database" — the id is free; any
 * other failure is unreadable.
 */
export async function idHolder(executor: CommandExecutor, kind: IdKind, id: number): Promise<IdHolder> {
  const db = kind === 'uid' ? 'passwd' : 'group'
  let r
  try {
    r = await executor.exec(GETENT, [db, String(id)])
  }
  catch (err) {
    return { unreadable: `the account database (getent ${db} ${id}: ${err instanceof Error ? err.message : String(err)})` }
  }
  if (r.exitCode === 2)
    return { holder: null }
  if (r.exitCode !== 0)
    return failed(`the account database`, `getent ${db} ${id}`, r)
  const entry = kind === 'uid'
    ? parsePasswd(r.stdout).find(e => e.uid === id)
    : parseGroups(r.stdout).find(e => e.gid === id)
  // exit 0 with a line that does not hold the id is not a shape we know.
  if (!entry)
    return { unreadable: `the account database (getent ${db} ${id} answered in an unknown shape)` }
  return 'uid' in entry ? { holder: entry.name, primaryGid: entry.gid } : { holder: entry.name }
}

/** The other number space: a uid's is the gids, a gid's the uids. */
export function otherKind(kind: IdKind): IdKind {
  return kind === 'uid' ? 'gid' : 'uid'
}

/** Why the pick could not choose an id. */
export type PickResult
  = | { id: number, skipped: { id: number, where: string }[] }
    | { refusal: 'unreadable', unreadable: string }
    | { refusal: 'band-full', from: number }
    | { refusal: 'tries', from: number, skipped: { id: number, where: string }[] }

/** Callbacks into the route's in-flight reservations (ids promised to creates that have not finished). */
export interface PickReservations {
  /** Is this id promised to an unfinished create? */
  held: (id: number) => boolean
  /** Promise it to this create — synchronously, false when another create took it meanwhile. */
  take: (id: number) => boolean
}

/**
 * The OTHER number space the pick steps around where it can (cr.29c): a uid
 * pick skips numbers a group holds as its gid, a gid pick numbers a user holds
 * as its uid, so a picked id never makes uid N and gid N name two unrelated
 * accounts (the state an explicit id is asked to confirm).
 */
export interface PickAvoid {
  /** Every id of the other kind the account database enumerates. */
  ids: number[]
  /** Is this number promised to an unfinished create of the other kind? */
  held: (id: number) => boolean
}

/**
 * Pick the id a new account gets: from the highest in-band id any account
 * holds + 1 (the band's first, 1000, when none does), skipping ids an account
 * or an unfinished create holds, and ids that own something. `accounts` is
 * every id the account database enumerates (any band). With `avoid`, numbers
 * the other kind holds are stepped over too (enumerated, promised, then a
 * by-number lookup of the candidate) — and when that leaves nothing in the
 * band, the pick runs again without it ("where it can"). The final check of a
 * candidate is a by-number `getent` lookup, then the synchronous reservation.
 */
export async function pickId(
  kind: IdKind,
  accounts: number[],
  reservations: PickReservations,
  o: OwnershipReadOpts,
  avoid?: PickAvoid,
): Promise<PickResult> {
  const picked = await pickFrom(kind, accounts, reservations, o, avoid)
  if (avoid && 'refusal' in picked && picked.refusal === 'band-full')
    return pickFrom(kind, accounts, reservations, o, undefined)
  return picked
}

async function pickFrom(
  kind: IdKind,
  accounts: number[],
  reservations: PickReservations,
  o: OwnershipReadOpts,
  avoid: PickAvoid | undefined,
): Promise<PickResult> {
  const used = new Set(accounts)
  const others = new Set(avoid?.ids ?? [])
  const top = accounts.reduce((m, id) => (isMutableShareId(id) && id > m ? id : m), SHARE_ID_MIN - 1)
  const from = top + 1
  const skipped: { id: number, where: string }[] = []
  // The band's top, 60000 (login.defs UID_MAX / GID_MAX), is a candidate too (cr.29c).
  for (let n = from; n <= SHARE_ID_MAX; n++) {
    if (used.has(n) || reservations.held(n))
      continue
    if (avoid && (others.has(n) || avoid.held(n)))
      continue
    if (avoid) {
      // By number: a directory group / user the enumeration does not list.
      const other = await idHolder(o.executor, otherKind(kind), n)
      if ('unreadable' in other)
        return { refusal: 'unreadable', unreadable: other.unreadable }
      if (other.holder !== null)
        continue
    }
    if (skipped.length >= ID_PICK_TRIES)
      return { refusal: 'tries', from, skipped }
    const owned = await idOwnership(kind, n, o)
    if ('unreadable' in owned)
      return { refusal: 'unreadable', unreadable: owned.unreadable }
    if (owned.owns) {
      skipped.push({ id: n, where: owned.where })
      continue
    }
    const holder = await idHolder(o.executor, kind, n)
    if ('unreadable' in holder)
      return { refusal: 'unreadable', unreadable: holder.unreadable }
    if (holder.holder !== null)
      continue
    if (reservations.take(n))
      return { id: n, skipped }
  }
  return { refusal: 'band-full', from }
}
