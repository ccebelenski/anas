import type { UnmountedMount } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { FindmntNode } from '../parsers/findmnt.js'
import type { LiveAtTarget } from './mount-match.js'
import { readFile } from 'node:fs/promises'
import { isPathWithin } from '@anas/shared'
import { parseFindmnt } from '../parsers/findmnt.js'
import { parseFstab } from '../parsers/fstab.js'
import { liveAtTarget, specMatchesLive } from './mount-match.js'
import { readFindmnt } from './mounts.js'

const ZFS = '/usr/sbin/zfs'
const TIMEOUT = '/usr/bin/timeout'
const REALPATH = '/usr/bin/realpath'
/** Seconds a path resolution may take before the path is judged as written. */
const REALPATH_TIMEOUT_S = '5'

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
 * The facts are ones the daemon already reads for the Mounts view:
 *   1. `/etc/fstab` — what the system is configured to mount (the parser is
 *      Mounts' own, so a disabled `#ANAS ` line is still a configured mount and
 *      an entry with a non-absolute mountpoint — swap — is already dropped).
 *      A `noauto` line is NOT configured to be mounted at boot — it mounts on
 *      demand, when somebody runs `mount` for it — so it is not the boot race
 *      this guard exists for and does not count as configured.
 *   2. ZFS `mountpoint,canmount,mounted` (story ident.4 (c), audit #16) — a
 *      dataset whose key is not loaded, or with `canmount=off`/`noauto`, is
 *      not mounted and its mountpoint is an empty directory on the parent;
 *      before ident.4 such a source backed up as an empty "good" snapshot.
 *   3. `findmnt --json` — what is mounted right now. It reads
 *      `/proc/self/mountinfo`, so it can never hang, even on a dead NFS server.
 *      A configured mountpoint counts as mounted only when what the kernel has
 *      there IS the configured thing (services/mount-match.ts): a local disk
 *      mounted by hand where a failed CIFS line points is "not mounted".
 *
 * The source is judged as written and as `realpath` resolves it (bounded by
 * `timeout`), so a symlink into an unmounted mount is refused too.
 *
 * Two deliberate limits, both stated rather than papered over:
 *   - ONLY a configured mount (fstab or ZFS) is detectable. A path under a mount
 *     somebody mounted by hand and then unmounted is indistinguishable from a
 *     path that was always a plain directory — nothing on the system records
 *     the intent. An absent path is the caller's own existence check.
 *   - FAIL OPEN on the mount table. An unreadable mount table (or an
 *     unreadable fstab) means the guard cannot see the system, and a guard
 *     that cannot see must not claim a mount is missing: it passes, exactly as
 *     every other derivation in this daemon fails open rather than blocking on
 *     its own blindness.
 *   - NOT fail-open on the ZFS facts (ident.4 review). An unmounted dataset's
 *     mountpoint is an ordinary empty directory on its mounted parent, so
 *     without `zfs list` a path below a live ZFS mount cannot be told apart
 *     from one. While the ZFS facts are unavailable, a path that sits BELOW a
 *     live ZFS mount (not at it) is refused with that reason stated
 *     (`zfsFactsUnavailable`); a path at a live ZFS mount, or on no ZFS at
 *     all, is judged as before.
 */

/** The facts one guard pass needs — read once, reusable for several paths. */
export interface SourceGuardFacts {
  /**
   * Every configured mount, absolute mountpoints only: the fstab lines (file
   * order) with the two fstab fields a refusal sentence NAMES — `source`
   * (fs_spec) and `fstype` (fs_vfstype) — then every ZFS filesystem whose
   * `mountpoint` is a path (story ident.4 (c): `origin: 'zfs'`, `source` = the
   * dataset). `noauto` fstab entries are not among them: they are not
   * configured to be mounted at boot.
   */
  configured: UnmountedMount[]
  /** Mountpoints the kernel currently has (findmnt targets). */
  mounted: Set<string>
  /** The flattened kernel table, for the live-source comparison (ident.4 (c)). */
  live: FindmntNode[]
  /**
   * Resolved paths (`realpath -e`) for the paths the facts were read for: a
   * symlinked source is judged where it really leads as well as where it is
   * written. A path absent here is judged as written.
   */
  realpaths: Map<string, string>
  /**
   * The mount table could not be read. While true the guard passes everything
   * — it has no evidence that anything is missing (fail open).
   */
  mountTableUnavailable: boolean
  /**
   * The ZFS mount facts could not be read (`zfs list` failed). While true a
   * path below a live ZFS mount is not provably mounted and is refused.
   */
  zfsFactsUnavailable: boolean
}

/** One row of `zfs list -H -p -t filesystem -o name,mountpoint,canmount,mounted`. */
interface ZfsMountRow {
  name: string
  mountpoint: string
  canmount: string
  mounted: boolean
}

const CANMOUNT_VALUES = new Set(['on', 'off', 'noauto'])

/**
 * Parse the ZFS mount facts. Total: a line that is not exactly the four
 * columns with a path mountpoint and the known property words is skipped —
 * `legacy` / `none` mountpoints are not ZFS-managed mounts (a legacy one is an
 * fstab line, and the fstab half covers it).
 */
export function parseZfsMountFacts(text: string): ZfsMountRow[] {
  const rows: ZfsMountRow[] = []
  for (const line of text.split('\n')) {
    const cols = line.split('\t')
    if (cols.length !== 4)
      continue
    const [name, mountpoint, canmount, mounted] = cols.map(c => c.trim())
    if (!name || !mountpoint.startsWith('/') || !CANMOUNT_VALUES.has(canmount) || (mounted !== 'yes' && mounted !== 'no'))
      continue
    rows.push({ name, mountpoint, canmount, mounted: mounted === 'yes' })
  }
  return rows
}

/**
 * Build the facts from the texts. PURE, so every case in the matrix (source
 * on an unmounted mount, under one, on a mounted one, on a different
 * filesystem at the configured target, on an unmounted ZFS dataset, on no
 * configured mount at all, an unreadable table) is expressible as strings.
 */
export function buildSourceGuardFacts(
  fstabText: string,
  findmntText: string,
  /** `zfs list` output; null = the read FAILED (not "no datasets"). */
  zfsText: string | null = '',
  realpaths: Map<string, string> = new Map(),
): SourceGuardFacts {
  const nodes = parseFindmnt(findmntText)
  const fstab: UnmountedMount[] = parseFstab(fstabText)
    // The parser has already classified the option list (`MountCommonOptions`),
    // so `noauto` is read from its structured field — never re-parsed from
    // the raw line. A disabled `#ANAS ` entry still counts: it is configured,
    // just switched off.
    .filter(e => !e.options.common.noauto)
    .map(e => ({
      mountpoint: e.mountpoint,
      source: e.spec,
      fstype: e.fstype,
      disabled: e.disabled === true,
    }))
  const zfs: UnmountedMount[] = parseZfsMountFacts(zfsText ?? '').map(r => ({
    mountpoint: r.mountpoint,
    source: r.name,
    fstype: 'zfs',
    origin: 'zfs' as const,
    canmount: r.canmount,
  }))
  return {
    configured: [...fstab, ...zfs],
    mounted: new Set(nodes.map(n => n.target)),
    live: nodes,
    realpaths,
    // An empty table is the unreadable case: a running Linux system always has
    // at least `/` mounted, so zero rows can only mean the read failed — and
    // without it EVERY path would look like it sits on an unmounted `/`.
    mountTableUnavailable: nodes.length === 0,
    zfsFactsUnavailable: zfsText === null,
  }
}

/**
 * `zfs list` for the mount facts; null when the read failed. A node without a
 * single pool answers exit 0 with nothing, which is "no datasets", not a
 * failure. (A node without ZFS at all has no live ZFS mount either, so the
 * unavailable verdict never fires there.)
 */
async function readZfsMountText(executor: CommandExecutor): Promise<string | null> {
  try {
    const r = await executor.exec(ZFS, ['list', '-H', '-p', '-t', 'filesystem', '-o', 'name,mountpoint,canmount,mounted'])
    return r.exitCode === 0 ? r.stdout : null
  }
  catch {
    return null
  }
}

/**
 * `realpath -e` of one path, in a child bounded by `timeout` — resolving a
 * path stats every component, and a component on a dead NFS server would
 * hang the caller (the hang trap). Undefined when it does not resolve, does
 * not exist, or does not answer in time: the path is then judged as written.
 */
async function resolvePath(executor: CommandExecutor, path: string): Promise<string | undefined> {
  try {
    const r = await executor.exec(TIMEOUT, ['-s', 'KILL', REALPATH_TIMEOUT_S, REALPATH, '-e', '--', path])
    const out = r.stdout.trim()
    return r.exitCode === 0 && out.startsWith('/') && !out.includes('\n') ? out : undefined
  }
  catch {
    return undefined
  }
}

/**
 * Read the facts the way the Mounts view reads them, plus the ZFS mount facts
 * and the resolved form of `paths` (the sources about to be judged). Never
 * throws.
 */
export async function readSourceGuardFacts(
  executor: CommandExecutor,
  fstabPath: string,
  paths: string[] = [],
): Promise<SourceGuardFacts> {
  let fstabText = ''
  try {
    fstabText = await readFile(fstabPath, 'utf-8')
  }
  catch {
    // Absent or unreadable fstab: nothing is configured as far as we can tell.
  }
  const [findmntText, zfsText] = await Promise.all([readFindmnt(executor), readZfsMountText(executor)])
  const realpaths = new Map<string, string>()
  for (const p of new Set(paths)) {
    const real = await resolvePath(executor, p)
    if (real && real !== p)
      realpaths.set(p, real)
  }
  return buildSourceGuardFacts(fstabText, findmntText, zfsText, realpaths)
}

/**
 * Is a configured mount actually THERE? Something is mounted at its
 * mountpoint AND it is the configured thing (ident.4 (c)): the live source and
 * fstype match (`specMatchesLive`). An fstab automount whose placeholder is
 * armed counts as there — the first access mounts it.
 */
function configuredIsThere(entry: UnmountedMount, live: LiveAtTarget): boolean {
  if (live.real)
    return specMatchesLive({ spec: entry.source, fstype: entry.fstype }, live.real)
  return live.armed && entry.origin !== 'zfs'
}

/** The deepest configured mountpoint containing `path`, with every entry configured there. */
function deepestConfigured(path: string, facts: SourceGuardFacts): UnmountedMount[] {
  let bestLen = -1
  let best: UnmountedMount[] = []
  for (const entry of facts.configured) {
    if (!isPathWithin(entry.mountpoint, path))
      continue
    const len = entry.mountpoint === '/' ? 0 : entry.mountpoint.length
    if (len > bestLen) {
      best = [entry]
      bestLen = len
    }
    else if (len === bestLen) {
      best.push(entry)
    }
  }
  return best
}

/** The not-there mount for one written-or-resolved path, or null. */
function unmountedFor(path: string, facts: SourceGuardFacts): UnmountedMount | null {
  const entries = deepestConfigured(path, facts)
  if (entries.length === 0)
    return null
  const live = liveAtTarget(facts.live, entries[0].mountpoint)
  // Several configurations may name one mountpoint (two boot environments
  // both `mountpoint=/`, an fstab line and a dataset): the mountpoint is
  // there when ANY of them is what the kernel has.
  if (entries.some(e => configuredIsThere(e, live)))
    return null
  const named = entries.find(e => e.origin !== 'zfs') ?? entries[0]
  return live.real
    ? { ...named, mountedSource: live.real.source, mountedFstype: live.real.fstype }
    : named
}

/**
 * The configured mount `path` sits on that is not there right now — nothing
 * mounted at it, or a different filesystem than the configured one — or null
 * when there is none.
 *
 * LONGEST-PREFIX match, exactly as the consistency derivation finds a path's
 * filesystem: the deepest configured mountpoint containing the path is the one
 * the path is actually on, and a shallower one being absent says nothing about
 * it. The path is judged as written AND, when the facts carry it, as resolved
 * (a symlink into an unmounted mount is refused too). Pure prefix arithmetic —
 * the path itself is never touched here (the hang trap applies here as
 * everywhere; the resolution ran bounded in `readSourceGuardFacts`).
 */
export function unmountedMountFor(path: string, facts: SourceGuardFacts): UnmountedMount | null {
  if (facts.mountTableUnavailable)
    return null
  const real = facts.realpaths.get(path)
  const configured = unmountedFor(path, facts) ?? (real ? unmountedFor(real, facts) : null)
  if (configured)
    return configured
  if (!facts.zfsFactsUnavailable)
    return null
  return belowLiveZfs(path, facts) ?? (real ? belowLiveZfs(real, facts) : null)
}

/**
 * ZFS facts unavailable: the live ZFS mount `path` sits BELOW (not at), as the
 * not-provably-mounted verdict, or null. The deepest live mount containing the
 * path is the filesystem it is on; a later row at the same target is stacked
 * on top.
 */
function belowLiveZfs(path: string, facts: SourceGuardFacts): UnmountedMount | null {
  let best: FindmntNode | undefined
  for (const n of facts.live) {
    if (n.fstype === 'autofs' || !isPathWithin(n.target, path))
      continue
    if (!best || n.target.length >= best.target.length)
      best = n
  }
  if (!best || best.fstype !== 'zfs' || best.target === path)
    return null
  return { mountpoint: best.target, source: best.source, fstype: 'zfs', origin: 'zfs', zfsFactsUnavailable: true }
}

/**
 * The refusal sentence. ASCII only (it becomes a job error and a notification
 * body line — the mojibake rule), and it NAMES the mount, because "the source
 * is empty" without the mount name sends the operator looking in the wrong
 * place.
 */
export function unmountedSourceRefusal(path: string, mount: UnmountedMount): string {
  const where = path === mount.mountpoint ? `${path} is` : `${path} is under ${mount.mountpoint}, which is`
  if (mount.zfsFactsUnavailable) {
    return `${path} is under ${mount.mountpoint} (ZFS dataset ${mount.source}), and the ZFS mount facts could not be read (zfs list failed) - `
      + `whether ${path} is the mountpoint of a dataset that is not mounted right now cannot be proved, so the run is refused instead of reading through it. `
      + `Run it again once zfs list answers.`
  }
  if (mount.origin === 'zfs') {
    const why = mount.canmount === 'off'
      ? ` (canmount=off - it is never mounted)`
      : mount.mountedSource
        ? ''
        : ` (an encrypted dataset whose key is not loaded stays unmounted too)`
    const other = mount.mountedSource ? `; ${mount.mountedSource} (${mount.mountedFstype ?? 'unknown type'}) is mounted there instead` : ''
    return `${where} the mountpoint of ZFS dataset ${mount.source}, which is not mounted right now${why}${other} - `
      + `the directory would be empty or a different filesystem, so the run is refused instead of reading through it. `
      + `Mount ${mount.source} and run it again.`
  }
  const disabled = mount.disabled ? ' (its /etc/fstab entry is disabled)' : ''
  if (mount.mountedSource) {
    return `${where} a mount defined in /etc/fstab as ${mount.source} (${mount.fstype}), but ${mount.mountedSource} (${mount.mountedFstype ?? 'unknown type'}) is mounted there instead${disabled} - `
      + `the run would read a different filesystem than the one configured, so it is refused. `
      + `Unmount what is at ${mount.mountpoint}, mount ${mount.source} there, and run it again.`
  }
  return `${where} a mount defined in /etc/fstab but not mounted right now${disabled} - `
    + `the directory would be empty or incomplete, so the run is refused instead of reading through it. `
    + `Mount ${mount.mountpoint} and run it again.`
}

/**
 * The "which is …" clause naming WHY a configured mount is not there — the one
 * wording the backup archive refusal and any other short form share. The
 * plain fstab case reads exactly as it did before ident.4.
 */
export function notThereClause(mount: UnmountedMount): string {
  const instead = mount.mountedSource ? ` but has ${mount.mountedSource} (${mount.mountedFstype ?? 'unknown type'}) mounted instead` : ''
  if (mount.zfsFactsUnavailable)
    return 'a ZFS dataset whose mount facts could not be read (zfs list failed), so the path cannot be proved to be mounted'
  if (mount.origin === 'zfs') {
    const off = mount.canmount === 'off' ? ' (canmount=off)' : ''
    return instead
      ? `the mountpoint of ZFS dataset ${mount.source}${off}${instead}`
      : `the mountpoint of ZFS dataset ${mount.source}${off} but not mounted`
  }
  return instead ? `configured in /etc/fstab${instead}` : 'configured in /etc/fstab but not mounted'
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
  return guardSourcePath(path, await readSourceGuardFacts(executor, fstabPath, [path]))
}
