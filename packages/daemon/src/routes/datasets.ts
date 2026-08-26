import type { AccessEntry, AssociatedShare, CreateDatasetRequest, Dataset, DatasetAccess, DatasetDetail, DatasetListDefaults, IscsiHeldByLun, MountpointPermissions, Snapshot, UpdateDatasetPropertiesRequest } from '@anas/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ParsedAcl } from '../parsers/getfacl.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { IscsiPaths } from '../services/iscsi.js'
import type { Transport } from '../services/replication-transport.js'
import { CloneSnapshotRequest, CreateDatasetRequest as CreateDatasetRequestSchema, CreateSnapshotRequest, DatasetPath, PoolName, RenameSnapshotRequest, SetAccessRequest, SetPermissionsRequest, SnapshotName, UpdateDatasetPropertiesRequest as UpdateDatasetPropertiesRequestSchema } from '@anas/shared'
import { parseExports } from '../parsers/exports.js'
import { levelToAclPerms, levelToOctalDigit, modeDigitToLevel, parseGetfacl, permsToLevel } from '../parsers/getfacl.js'
import { PVE_STORAGE_CFG, readPveStorages, readZfsMountpoints } from '../parsers/pve-storage.js'
import { parseSmbConf } from '../parsers/smb-conf.js'
import { parseDatasetGet, parseSnapshotList, parseSnapshotNames, parseVolblocksizeDefault, parseZfsList, zfsListArgs, zfsSnapshotDetailArgs, zfsSnapshotListArgs } from '../parsers/zfs-list.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { confirmGate } from '../safety/gate.js'
import { enrichBusyError } from '../services/busy-diagnosis.js'
import { readConfig } from '../services/config-writer.js'
import { configfsOptionsFrom, createIscsiClaimCache, heldByLun, heldByLunRefusal } from '../services/iscsi-held.js'
import { createZfsSnapshot, destroyZfsSnapshot } from '../services/zfs-snapshot.js'
import { requireIdentity } from './identity.js'
import { createReplicationHandlers } from './replication.js'

const ZFS = '/usr/sbin/zfs'
const STAT = '/usr/bin/stat'
const CHOWN = '/usr/bin/chown'
const CHMOD = '/usr/bin/chmod'
const GETFACL = '/usr/bin/getfacl'
const SETFACL = '/usr/bin/setfacl'

/** Terminal sub-action of the dataset wildcard for the access editor. */
const ACCESS_SUFFIX = '/access'

/** The base-three access kinds (mode bits), in owner/group/everyone order. */
type BaseKind = 'owner' | 'owning-group' | 'everyone'

/** Levels for the base three principals, resolved from mode bits or a request. */
interface BaseLevels {
  'owner': AccessEntry['level']
  'owning-group': AccessEntry['level']
  'everyone': AccessEntry['level']
}

/** Whitespace splitter for `stat` output (owner group mode). */
const WHITESPACE_RE = /\s+/

/**
 * Build the `zfs create` argument array from a validated request — for a
 * filesystem OR a volume. A volume is a dataset of another type, not another
 * resource, so it shares this one builder rather than forking a parallel path.
 *
 * The zvol flags follow zfs(8)'s own order — `zfs create [-s] [-b blocksize]
 * [-o property=value]... -V size volume` — and the schema has already
 * guaranteed that `volsize` is present and that no filesystem-only property
 * (mountpoint / recordsize / quota) came along for the ride, because ZFS does
 * not have those properties on a zvol at all.
 */
function buildCreateArgs(fullName: string, req: CreateDatasetRequest): string[] {
  const args = ['create']
  const isVolume = req.type === 'volume'
  // Sparse (thin) FIRST: `-s` is what omits the refreservation, and the absence
  // of a refreservation is the whole meaning of `sparse` on the way back out.
  if (isVolume && req.sparse)
    args.push('-s')
  if (isVolume && req.volblocksize !== undefined)
    args.push('-b', String(req.volblocksize))
  const p = req.properties
  if (p) {
    if (p.compression !== undefined)
      args.push('-o', `compression=${p.compression}`)
    if (p.recordsize !== undefined)
      args.push('-o', `recordsize=${p.recordsize}`)
    if (p.quota !== undefined)
      args.push('-o', `quota=${p.quota === 0 ? 'none' : p.quota}`)
    if (p.reservation !== undefined)
      args.push('-o', `reservation=${p.reservation === 0 ? 'none' : p.reservation}`)
    if (p.mountpoint !== undefined)
      args.push('-o', `mountpoint=${p.mountpoint}`)
  }
  if (isVolume && req.volsize !== undefined)
    args.push('-V', String(req.volsize))
  args.push(fullName)
  return args
}

/**
 * Build one `<prop>=<value>` token per changed property (fed to `zfs set`).
 * Booleans map to on/off; a 0 quota/reservation means 'none'; the rest pass
 * through as-is. Only the settable properties in the shared schema are mapped —
 * anything else is silently absent (structured operations, Principle 5).
 *
 * `recordsize` has no 0 → 'none' mapping because ZFS has no such value: the
 * shared schema constrains it to a power of two in [512, 16M], so a blanked
 * field is a 400 at the boundary rather than a `recordsize=0` that ZFS refuses
 * partway through the apply (#43).
 */
function buildSetPairs(p: UpdateDatasetPropertiesRequest['properties']): string[] {
  const pairs: string[] = []
  const size = (n: number) => (n === 0 ? 'none' : String(n))
  if (p.compression !== undefined)
    pairs.push(`compression=${p.compression}`)
  if (p.recordsize !== undefined)
    pairs.push(`recordsize=${p.recordsize}`)
  if (p.quota !== undefined)
    pairs.push(`quota=${size(p.quota)}`)
  if (p.reservation !== undefined)
    pairs.push(`reservation=${size(p.reservation)}`)
  if (p.refquota !== undefined)
    pairs.push(`refquota=${size(p.refquota)}`)
  if (p.refreservation !== undefined)
    pairs.push(`refreservation=${size(p.refreservation)}`)
  if (p.atime !== undefined)
    pairs.push(`atime=${p.atime ? 'on' : 'off'}`)
  if (p.sync !== undefined)
    pairs.push(`sync=${p.sync}`)
  if (p.readonly !== undefined)
    pairs.push(`readonly=${p.readonly ? 'on' : 'off'}`)
  if (p.dedup !== undefined)
    pairs.push(`dedup=${p.dedup}`)
  // Volumes only (story iscsi.3). No 0 -> 'none' mapping: `volsize` has no such
  // value, and the schema's 1 MiB floor means a blanked field is a 400 at the
  // boundary rather than a `volsize=0` that ZFS would refuse mid-apply (#43).
  if (p.volsize !== undefined)
    pairs.push(`volsize=${p.volsize}`)
  return pairs
}

// ============================================================================
// The one volume-mutation gate (story iscsi.3, extended by iscsi.6).
// ============================================================================

/** Mutations that a LUN's claim on a volume must be able to veto (iscsi.6). */
export type VolumeOp = 'grow' | 'rollback' | 'rename' | 'destroy'

/**
 * `zfs destroy`'s "it has children" refusal, in its two shapes.
 *
 * A FILESYSTEM with children says `filesystem has children`; a VOLUME with
 * snapshots says `volume has children`. Both then print `use '-r' to destroy the
 * following datasets:` and list them.
 */
const ZFS_HAS_CHILDREN_RE = /\bhas children\b/i

/**
 * The one sentence that stands in for that CLI text (live-proof F15).
 *
 * It is used in BOTH places on purpose: as a confirm-door warning before the
 * operator commits, and as the job's error if they commit anyway. One string, so
 * the advice cannot say two different things — and it names the counts, the
 * snapshots themselves, and the two ways forward, because "guide, don't just
 * warn" is a standing ruling and `use '-r'` is a flag name, not guidance.
 *
 * The snapshot list is capped: a dataset with a snapshot schedule can have
 * hundreds, and a refusal that scrolls is a refusal nobody reads.
 */
function destroyNeedsRecursive(
  fullName: string,
  type: string,
  children: string[],
  snapshots: string[],
): string {
  const noun = type === 'volume' ? 'Volume' : 'Dataset'
  const parts: string[] = []
  if (snapshots.length > 0) {
    const shown = snapshots.slice(0, 5).join(', ')
    parts.push(`${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'} (${shown}${snapshots.length > 5 ? `, and ${snapshots.length - 5} more` : ''})`)
  }
  if (children.length > 0) {
    const shown = children.slice(0, 5).join(', ')
    parts.push(`${children.length} child dataset${children.length === 1 ? '' : 's'} (${shown}${children.length > 5 ? `, and ${children.length - 5} more` : ''})`)
  }
  return `${noun} '${fullName}' has ${parts.join(' and ')} — ZFS will not destroy it while they exist. `
    + `Destroy ${snapshots.length > 0 && children.length === 0 ? 'them' : 'those'} first, or confirm again with `
    + `Recursive to destroy ${fullName} and everything under it in one go. A recursive destroy is irreversible.`
}

/** A refusal from {@link assertVolumeMutable} — 409, Level 1, no confirm code. */
export interface VolumeRefusal {
  reason: string
  message: string
}

/**
 * THE seam for "may this volume be mutated this way?" — one function, one call
 * site per verb, so the LUN-held refusal lives HERE and nowhere else.
 *
 * Two rules, and they are refused at DIFFERENT altitudes for the same reason:
 * both are irreversible from the outside, and neither has a safe confirm.
 *
 *  1. **volsize never shrinks** (story iscsi.3). ZFS allows it and truncates
 *     silently — it does not even refuse under a live iSCSI session — so the
 *     refusal has to be ANAS's. Unconditional: a volume nothing is serving is
 *     just as truncated as one under a LUN.
 *  2. **nothing is mutated while a LUN holds it** (story iscsi.6). `rollback`,
 *     `rename` and a `volsize` change all return exit 0 with a live session and
 *     a mounted filesystem on the initiator (GT-40); `destroy` is the one ZFS
 *     itself refuses, and only with a bare `dataset is busy` that names nothing.
 *     `fuser`, `lsof` and sysfs `holders/` see NOTHING (GT-41) — the claim is in
 *     configfs and this is the only place it can be turned into an answer.
 *
 * The two compose: a shrink of a held volume names the LUN as well, because
 * "you cannot shrink this" and "something is serving it right now" are both
 * things the operator needs before deciding what to do.
 *
 * A GROW of a held volume is deliberately ALLOWED — it is the supported live
 * path (`iscsi.3`: the zvol grows, the initiator rescans and sees the new size),
 * and refusing it would take away the only safe resize there is.
 *
 * `current` is the volume's dataset row (null when the caller could not read it,
 * in which case nothing is asserted — fail-open, the same posture as the other
 * pre-flight reads here). `next` carries the requested new state. `held` is the
 * holding LUN from `heldByLun()`, or null when nothing holds it (which is also
 * what an unreadable LIO tree yields — fail-open again).
 *
 * Every dataset verb that can touch a volume routes through here. **There is no
 * dataset RENAME endpoint today** (`zfs rename` is not exposed by any route);
 * `rename` is nonetheless a first-class op here so that the day one is added it
 * has a gate to call and a test that fails if it does not.
 */
export function assertVolumeMutable(
  name: string,
  op: VolumeOp,
  current: Dataset | null,
  next?: { volsize?: number },
  held?: IscsiHeldByLun | null,
): VolumeRefusal | null {
  if (!current || current.type !== 'volume')
    return null

  const shrinking = op === 'grow'
    && next?.volsize !== undefined
    && current.volsize !== undefined
    && next.volsize < current.volsize

  if (shrinking) {
    const heldClause = held
      ? ` It is also ${held.detail}${held.connectedInitiators.length > 0 ? ` with ${held.connectedInitiators.length} initiator(s) logged in` : ''}.`
      : ''
    return {
      reason: 'shrink',
      message: `Volume '${name}' is ${current.volsize} bytes; a volsize of ${next.volsize} bytes would SHRINK it. `
        + `ZFS would truncate it silently and anything written past the new end — a partition table, a filesystem, a LUN's data — would be gone.${heldClause} `
        + `Destroy and recreate the volume at the smaller size instead. This refusal has no confirm bypass.`,
    }
  }

  // A grow is the one mutation a LUN does not veto: it is live and safe, and it
  // is the whole point of `iscsi.3`'s Resize Volume.
  if (!held || op === 'grow')
    return null

  const action = op === 'rollback'
    ? `Rolling back volume`
    : op === 'rename' ? `Renaming volume` : `Destroying volume`
  const refusal = heldByLunRefusal(`'${name}'`, action, held)
  return { reason: refusal.reason, message: refusal.message }
}

// ============================================================================
// Layered access / ACLs (Epic 4.7.2). The base three principals (owner /
// owning-group / everyone) are POSIX mode bits; extra named principals are
// POSIX ACL entries. See parsers/getfacl.ts for the level ↔ perms mapping.
// ============================================================================

/** Split a stat mode (e.g. `755`, `2770`) into its owner/group/other levels. */
function baseLevelsFromMode(mode: string): BaseLevels {
  // Keep the low three digits; a leading setuid/setgid/sticky digit is ignored
  // for level reporting (setgid is managed separately for ACL inheritance).
  const digits = mode.slice(-3).padStart(3, '0')
  const digit = (i: number) => Number.parseInt(digits[i], 10) || 0
  return {
    'owner': modeDigitToLevel(digit(0)),
    'owning-group': modeDigitToLevel(digit(1)),
    'everyone': modeDigitToLevel(digit(2)),
  }
}

const NUMERIC_ID_RE = /^\d+$/
/** A bare-numeric principal token means the uid/gid did not resolve to a name. */
function isNumericId(name: string): boolean {
  return NUMERIC_ID_RE.test(name)
}

/** Tag an entry as an orphan (unresolved uid/gid) when `orphan` is true. */
function orphanFlag(entry: AccessEntry, orphan: boolean): AccessEntry {
  return orphan ? { ...entry, unresolved: true } : entry
}

/** The base-three AccessEntry list derived from mode bits (mode-only datasets). */
function baseEntriesFromMode(mode: string, ownerOrphan = false, groupOrphan = false): AccessEntry[] {
  const levels = baseLevelsFromMode(mode)
  return [
    orphanFlag({ kind: 'owner', level: levels.owner }, ownerOrphan),
    orphanFlag({ kind: 'owning-group', level: levels['owning-group'] }, groupOrphan),
    { kind: 'everyone', level: levels.everyone },
  ]
}

/** Base three levels → 3-digit octal mode string (e.g. `750`). */
function levelsToMode(levels: BaseLevels): string {
  return `${levelToOctalDigit(levels.owner)}${levelToOctalDigit(levels['owning-group'])}${levelToOctalDigit(levels.everyone)}`
}

/**
 * One principal's symbolic perms for a RECURSIVE chmod. Uses capital `X` so
 * execute lands only on directories (and files that already have it) — a
 * blanket numeric octal (`levelsToMode`) would sprinkle +x onto every plain
 * data file on a recursive Read grant. none → `` (empty), read → `rX`,
 * read-write → `rwX`.
 */
function levelToSymbolicPerms(level: AccessEntry['level']): string {
  switch (level) {
    case 'none': return ''
    case 'read': return 'rX'
    case 'read-write': return 'rwX'
  }
}

/** Base three levels → a symbolic chmod mode (`u=rwX,g=rX,o=`) for a recursive apply. */
function levelsToSymbolic(levels: BaseLevels): string {
  return `u=${levelToSymbolicPerms(levels.owner)},g=${levelToSymbolicPerms(levels['owning-group'])},o=${levelToSymbolicPerms(levels.everyone)}`
}

/** A named (user/group) AccessEntry — kind narrowed, name guaranteed present. */
type NamedEntry = AccessEntry & { kind: 'user' | 'group', name: string }

function isNamed(e: AccessEntry): e is NamedEntry {
  return (e.kind === 'user' || e.kind === 'group') && e.name !== undefined
}

/**
 * Build a `setfacl --set` spec declaratively from the base three levels plus the
 * named entries. The mask is pinned to `rwx` (union) so no principal is masked
 * below its stated level — the reported level stays truthful. The same spec is
 * used for the access ACL and, with `-d`, the default (inheritance) ACL.
 */
function buildAclSpec(base: BaseLevels, named: NamedEntry[], recursive: boolean): string {
  const p = (level: AccessEntry['level']) => levelToAclPerms(level, recursive)
  const specs = [
    `u::${p(base.owner)}`,
    `g::${p(base['owning-group'])}`,
    `o::${p(base.everyone)}`,
  ]
  for (const n of named)
    specs.push(`${n.kind === 'user' ? 'u' : 'g'}:${n.name}:${p(n.level)}`)
  specs.push('m::rwx')
  return specs.join(',')
}

/**
 * The snapshot sub-resource of a dataset wildcard, or null if the wildcard is a
 * plain dataset path. find-my-way only allows a terminal wildcard, so the whole
 * `<datasetpath>/snapshots/<snap>/<action>` tail arrives as one `*` capture.
 * Split on the `snapshots` path segment: everything before it is the dataset
 * path (may contain '/'), everything after is the snapshot sub-resource.
 * Snapshot names never contain '/', so this is unambiguous.
 *
 *   media/snapshots                 → { datasetPath: 'media' }                       (collection)
 *   media/movies/snapshots/snap1    → { datasetPath: 'media/movies', snap: 'snap1' } (item)
 *   media/snapshots/snap1/rollback  → { datasetPath: 'media', snap: 'snap1', rollback }
 *   snapshots                       → { datasetPath: '' }                            (pool-root dataset)
 */
interface SnapshotTail {
  datasetPath: string
  snap?: string
  rollback: boolean
  /** `<snap>/clone` — clone the snapshot into a new dataset (Epic 5.7). */
  clone: boolean
  /** Trailing segments we don't understand (→ 404). */
  extra: boolean
}

function parseSnapshotTail(wildcard: string): SnapshotTail | null {
  const parts = wildcard.split('/')
  const idx = parts.indexOf('snapshots')
  if (idx === -1)
    return null

  const datasetPath = parts.slice(0, idx).join('/')
  const rest = parts.slice(idx + 1)
  const snap = rest[0]
  const rollback = rest.length === 2 && rest[1] === 'rollback'
  const clone = rest.length === 2 && rest[1] === 'clone'
  const known = rest.length === 0 || rest.length === 1 || rollback || clone
  return { datasetPath, snap, rollback, clone, extra: !known }
}

export async function datasetRoutes(
  server: FastifyInstance,
  opts: {
    executor: CommandExecutor
    jobQueue: JobQueue
    confirmStore: ConfirmStore
    /** smb.conf path — for reporting shares that serve a dataset (Epic 4.4). */
    smbConfPath?: string
    /** /etc/exports path — for reporting NFS exports of a dataset (Epic 4.4). */
    exportsPath?: string
    /** Stage-3 remote/peer SSH transport for replication (Epic 5.5.2). */
    transport: Transport
    /**
     * iSCSI read-layer path overrides (story iscsi.6) — the held-by-LUN gate
     * reads configfs. Defaults inside the service to the real host locations;
     * overridable so a test (and a dev box with no LIO) never reads the kernel.
     */
    iscsiPaths?: IscsiPaths
  },
) {
  const { executor, jobQueue, confirmStore, transport } = opts
  const iscsiPaths = opts.iscsiPaths ?? {}

  // Replication (Epic 5.5.1) shares this file's dataset `*` wildcard (find-my-way
  // permits only one wildcard route per method+path). The send/recv logic lives
  // in replication.ts; it reuses the dataset helpers below. Function declarations
  // are hoisted, so wiring them here (before they textually appear) is safe.
  const replication = createReplicationHandlers({
    executor,
    jobQueue,
    resolveDatasetName,
    poolExists,
    datasetExists,
    listSnapshotsDetail,
    // Story 3.25 boundary guard: same storage.cfg detection GET /pools uses.
    // Fail-open (non-PVE host / unreadable config → not PVE-managed).
    isPveManagedPool: async (pool: string) => {
      try {
        const refs = await readPveStorages(PVE_STORAGE_CFG, await readZfsMountpoints())
        return (refs.get(pool) ?? []).length > 0
      }
      catch {
        return false
      }
    },
    transport,
  })

  /** Does the named pool exist? (source of truth is `zpool list`). */
  async function poolExists(poolName: string): Promise<boolean> {
    const r = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = r.exitCode === 0 && r.stdout.trim() ? parseZpoolList(r.stdout) : []
    return pools.some(p => p.name === poolName)
  }

  /**
   * The pool's flat dataset list PLUS the ZFS-owned defaults the Create dialog
   * quotes (story iscsi.3), from ONE `zfs list` — the default `volblocksize`
   * rides in the same JSON the tree is built from, so stating it instead of
   * hard-coding it costs no extra command (Principle 7).
   */
  async function listDatasetsAndDefaults(
    poolName: string,
  ): Promise<{ datasets: Dataset[], defaults: DatasetListDefaults }> {
    const r = await executor.exec(ZFS, zfsListArgs(poolName))
    if (r.exitCode !== 0 || !r.stdout.trim())
      return { datasets: [], defaults: { volblocksize: null } }
    return {
      datasets: parseZfsList(r.stdout),
      defaults: { volblocksize: parseVolblocksizeDefault(r.stdout) },
    }
  }

  /** The pool's flat dataset list (filesystems + volumes). */
  async function listDatasets(poolName: string): Promise<Dataset[]> {
    return (await listDatasetsAndDefaults(poolName)).datasets
  }

  /** Snapshot names below a dataset (for destroy warnings). */
  async function snapshotNames(fullName: string): Promise<string[]> {
    const r = await executor.exec(ZFS, zfsSnapshotListArgs(fullName))
    if (r.exitCode !== 0 || !r.stdout.trim())
      return []
    return parseSnapshotNames(r.stdout)
  }

  /** Does the named dataset (or pool-root dataset) exist? */
  async function datasetExists(poolName: string, fullName: string): Promise<boolean> {
    const datasets = await listDatasets(poolName)
    return datasets.some(d => d.name === fullName)
  }

  /**
   * The dataset row for one full name, or null. Fail-open by design: every
   * caller uses it to feed {@link assertVolumeMutable}, which asserts nothing on
   * a null (the verb then proceeds exactly as it did before this story).
   */
  async function datasetRow(poolName: string, fullName: string): Promise<Dataset | null> {
    const datasets = await listDatasets(poolName)
    return datasets.find(d => d.name === fullName) ?? null
  }

  /**
   * Is an iSCSI LUN holding this dataset (story iscsi.6)?
   *
   * The dataset name catches the zvol itself AND any zvol beneath it (a `-r`
   * destroy of `tank/vms` sweeps `tank/vms/lun1`); the mountpoint catches an
   * image FILE living inside a filesystem dataset, which is the AHR-shaped
   * backing kind and the one ZFS's own `dataset is busy` explains worst.
   *
   * One `iscsiClaims()` read per call — the verbs here are single-row, so there
   * is nothing to amortise and nothing that outlives the request (Principle 11).
   */
  async function datasetHeldByLun(row: Dataset | null, fullName: string): Promise<IscsiHeldByLun | null> {
    const subject: { dataset: string, path?: string } = { dataset: fullName }
    if (row?.mountpoint && row.mountpoint.startsWith('/'))
      subject.path = row.mountpoint
    return heldByLun(createIscsiClaimCache(executor, iscsiPaths), subject)
  }

  /**
   * Stamp `heldByLun` onto every row a LUN holds (story iscsi.6).
   *
   * ONE `iscsiClaims()` read for the whole list, shared through the per-request
   * cache — the version-skew ruling makes the field additive, so a row nothing
   * holds carries nothing and an older daemon carries nothing at all. Fail-open:
   * on any read failure no row is stamped and the list is exactly what it was.
   */
  async function annotateHeldByLun(datasets: Dataset[]): Promise<void> {
    if (datasets.length === 0)
      return
    const cache = createIscsiClaimCache(executor, iscsiPaths)
    if ((await cache.claims()).length === 0)
      return
    for (const d of datasets) {
      const subject: { dataset: string, path?: string } = { dataset: d.name }
      if (d.mountpoint && d.mountpoint.startsWith('/'))
        subject.path = d.mountpoint
      const held = await heldByLun(cache, subject)
      if (held)
        d.heldByLun = held
    }
  }

  /**
   * Run the volume gate and, if it refuses, send the Level 1 409 (no confirm
   * code — there is no override path, per Safety Semantics). Returns true when
   * the caller has been answered and must stop.
   *
   * Story iscsi.6: the gate now also needs to know whether a LUN holds the
   * volume, so the claims read happens HERE, before the gate — and therefore
   * before any destructive command, which is the whole point of a pre-flight
   * refusal.
   */
  async function volumeGateRefused(
    poolName: string,
    fullName: string,
    op: VolumeOp,
    reply: FastifyReply,
    next?: { volsize?: number },
  ): Promise<boolean> {
    const row = await datasetRow(poolName, fullName)
    const held = row?.type === 'volume' ? await datasetHeldByLun(row, fullName) : null
    const refusal = assertVolumeMutable(fullName, op, row, next, held)
    if (!refusal)
      return false
    reply.code(409)
    reply.send({ error: { code: 'CONFLICT', reason: refusal.reason, message: refusal.message } })
    return true
  }

  /** A dataset's snapshots, newest-first (empty when it has none). */
  async function listSnapshotsDetail(fullName: string): Promise<Snapshot[]> {
    const r = await executor.exec(ZFS, zfsSnapshotDetailArgs(fullName))
    if (r.exitCode !== 0 || !r.stdout.trim())
      return []
    return parseSnapshotList(r.stdout)
  }

  /**
   * SMB/NFS shares serving a dataset's mountpoint (Epic 4.4). Matches share
   * paths in smb.conf and /etc/exports against the exact mountpoint (a share ON
   * this dataset — nested paths are out of scope for MVP). Reuses the read-only
   * share parsers so admin-made shares surface too (Principle 11). A missing
   * config path or file simply contributes no shares for that protocol.
   */
  async function associatedShares(mountpoint: string): Promise<AssociatedShare[]> {
    const shares: AssociatedShare[] = []
    if (opts.smbConfPath) {
      const text = await readConfig(opts.smbConfPath)
      for (const share of parseSmbConf(text).shares) {
        if (share.path === mountpoint)
          shares.push({ protocol: 'smb', name: share.name })
      }
    }
    if (opts.exportsPath) {
      const text = await readConfig(opts.exportsPath)
      for (const exp of parseExports(text)) {
        if (exp.path === mountpoint)
          shares.push({ protocol: 'nfs', name: exp.path })
      }
    }
    return shares
  }

  /**
   * Every shared path on the system → the protocols sharing it, read ONCE for
   * the whole flat list (not N+1 per dataset like `associatedShares`). Reuses
   * the same read-only smb.conf / exports parsers so admin-made shares surface
   * too (Principle 11). Fail-open: a missing config path or unreadable file
   * simply contributes no entries for that protocol.
   */
  async function sharedPathProtocols(): Promise<Map<string, Set<'smb' | 'nfs'>>> {
    const map = new Map<string, Set<'smb' | 'nfs'>>()
    const add = (path: string, proto: 'smb' | 'nfs') => {
      if (!path)
        return
      const set = map.get(path) ?? new Set<'smb' | 'nfs'>()
      set.add(proto)
      map.set(path, set)
    }
    if (opts.smbConfPath) {
      const text = await readConfig(opts.smbConfPath)
      for (const share of parseSmbConf(text).shares)
        add(share.path, 'smb')
    }
    if (opts.exportsPath) {
      const text = await readConfig(opts.exportsPath)
      for (const exp of parseExports(text))
        add(exp.path, 'nfs')
    }
    return map
  }

  /**
   * Snapshot counts for every dataset in the pool, tallied from ONE recursive
   * name-only `zfs list -t snapshot` pass — NOT one call per dataset. Each name
   * is `<dataset>@<snap>`; the dataset half gets a +1. Fail-open: a non-zero
   * exit or empty output yields an empty map, so counts are simply omitted.
   */
  async function snapshotCounts(poolName: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    const r = await executor.exec(ZFS, ['list', '-j', '-o', 'name', '-t', 'snapshot', '-r', poolName])
    if (r.exitCode !== 0 || !r.stdout.trim())
      return counts
    for (const full of parseSnapshotNames(r.stdout)) {
      const at = full.indexOf('@')
      if (at < 0)
        continue
      const dataset = full.slice(0, at)
      counts.set(dataset, (counts.get(dataset) ?? 0) + 1)
    }
    return counts
  }

  /**
   * Resolve the pool + wildcard tail to a dataset full name, validating the
   * dataset path (empty tail = the pool-root dataset). Returns null after
   * sending a 400 on an invalid path.
   */
  function resolveDatasetName(poolName: string, datasetPath: string, reply: FastifyReply): string | null {
    if (!datasetPath)
      return poolName
    const parsed = DatasetPath.safeParse(datasetPath)
    if (!parsed.success) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid dataset path: ${parsed.error.issues[0]?.message}` } })
      return null
    }
    return `${poolName}/${parsed.data}`
  }

  /** Stat a mountpoint for owner/group/mode, or null if it can't be read. */
  async function statMountpoint(mountpoint: string): Promise<MountpointPermissions | null> {
    const r = await executor.exec(STAT, ['-c', '%U %G %a', mountpoint])
    if (r.exitCode !== 0 || !r.stdout.trim())
      return null
    const [owner, group, mode] = r.stdout.trim().split(WHITESPACE_RE)
    if (!owner || !group || !mode)
      return null
    return { owner, group, mode }
  }

  /**
   * Is `getfacl`/`setfacl` present (the `acl` package)? Feature-detect, then
   * memoize: whether the package is installed does not change at runtime, so we
   * probe `getfacl --version` once per process instead of on every access
   * request. The cache is a closure variable, so a fresh server (each
   * `createServer()` re-invokes `datasetRoutes`) starts with a fresh cache. A
   * cached Promise avoids a concurrent double-probe.
   */
  let aclSupportedCache: Promise<boolean> | null = null
  function aclSupported(): Promise<boolean> {
    aclSupportedCache ??= executor.exec(GETFACL, ['--version']).then(r => r.exitCode === 0)
    return aclSupportedCache
  }

  /** The dataset's `acltype` value (`off`, `posixacl`, …); '' if unreadable. */
  async function getAcltype(dataset: string): Promise<string> {
    const r = await executor.exec(ZFS, ['get', '-Hp', '-o', 'value', 'acltype', dataset])
    return r.exitCode === 0 ? r.stdout.trim() : ''
  }

  /** True when the dataset has POSIX ACLs in effect (ZFS may print `posix`). */
  function isPosixAcl(acltype: string): boolean {
    return acltype === 'posixacl' || acltype === 'posix'
  }

  /**
   * Resolve the pool + wildcard tail to a mounted-filesystem mountpoint for the
   * access editor. Sends a 404 (and returns null) for an unknown dataset, a
   * volume, or an unmounted filesystem — access applies to a real directory.
   */
  async function resolveAccessTarget(
    poolName: string,
    path: string,
    reply: FastifyReply,
  ): Promise<{ fullName: string, mountpoint: string } | null> {
    let fullName = poolName
    if (path) {
      const pathParsed = DatasetPath.safeParse(path)
      if (!pathParsed.success) {
        reply.code(400)
        reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid dataset path: ${pathParsed.error.issues[0]?.message}` } })
        return null
      }
      fullName = `${poolName}/${pathParsed.data}`
    }

    const r = await executor.exec(ZFS, ['get', '-j', 'all', fullName])
    const parsed = r.exitCode === 0 && r.stdout.trim() ? parseDatasetGet(r.stdout, fullName) : null
    if (!parsed) {
      reply.code(404)
      reply.send({ error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } })
      return null
    }
    if (parsed.base.type !== 'filesystem' || !parsed.base.mountpoint) {
      reply.code(404)
      reply.send({ error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' is not a mounted filesystem` } })
      return null
    }
    return { fullName, mountpoint: parsed.base.mountpoint }
  }

  // --- GET /pools/:name/datasets — flat list (UI builds the tree) ----------
  server.get<{ Params: { name: string } }>('/pools/:name/datasets', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const { datasets, defaults } = await listDatasetsAndDefaults(poolName)

    // Enrich the flat feed so the UI can light up share badges + a snapshot
    // count on collapsed rows (Epic 4.4 / 15.4). Both sources are gathered ONCE
    // for the whole list (shares parsed once; snapshots in a single recursive
    // pass) — never per dataset. Fail-open: any read error leaves the optional
    // fields undefined and the dataset list still returns.
    try {
      const [shareMap, snapCounts] = await Promise.all([
        sharedPathProtocols(),
        snapshotCounts(poolName),
      ])
      for (const d of datasets) {
        if (d.mountpoint) {
          const protos = shareMap.get(d.mountpoint)
          if (protos && protos.size) {
            // Canonical order (smb, nfs) — matches the schema enum order.
            const over: ('smb' | 'nfs')[] = []
            if (protos.has('smb'))
              over.push('smb')
            if (protos.has('nfs'))
              over.push('nfs')
            d.sharedOver = over
          }
        }
        const count = snapCounts.get(d.name)
        if (count !== undefined)
          d.snapshotCount = count
      }
    }
    catch {
      // fail-open — omit the enrichment fields rather than fail the list
    }

    // Story iscsi.6: which rows a LUN is holding, so the toolbar can grey
    // Destroy/Rollback with the reason attached instead of letting the operator
    // find out from a 409. ONE claims read for the whole list (the per-request
    // cache) — never a request per row.
    await annotateHeldByLun(datasets)

    // Story iscsi.3: `defaults` carries the ZFS-owned volblocksize the Create
    // dialog quotes. Optional and additive — an older UI ignores it, and a newer
    // UI against an older daemon simply gets nothing and says "ZFS default"
    // with no number rather than inventing one.
    return { data: datasets, defaults }
  })

  // --- GET /pools/:name/datasets/*path — detail ---------------------------
  // Wildcard `*` captures the full (possibly nested) dataset path. The `PUT`
  // permissions action shares this wildcard because find-my-way only allows a
  // wildcard as the final path segment — see the PUT handler below.
  server.get<{ Params: { 'name': string, '*': string } }>('/pools/:name/datasets/*', async (request, reply) => {
    const poolName = request.params.name
    const path = request.params['*']

    // Access sub-resource: `<dataset>/access` (layered permissions editor).
    if (path === 'access' || path.endsWith(ACCESS_SUFFIX)) {
      const dpath = path === 'access' ? '' : path.slice(0, -ACCESS_SUFFIX.length)
      return getAccess(poolName, dpath, reply)
    }

    // Snapshot sub-resource: `<dataset>/snapshots[/<snap>]`.
    const tail = parseSnapshotTail(path)
    if (tail) {
      if (tail.extra) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Unknown snapshot resource '${path}'` } }
      }
      return tail.snap
        ? snapshotDetail(poolName, tail.datasetPath, tail.snap, reply)
        : listSnapshots(poolName, tail.datasetPath, reply)
    }

    const fullName = path ? `${poolName}/${path}` : poolName

    const r = await executor.exec(ZFS, ['get', '-j', 'all', fullName])
    if (r.exitCode !== 0 || !r.stdout.trim()) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }

    const parsed = parseDatasetGet(r.stdout, fullName)
    if (!parsed) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }

    // POSIX permissions from the mountpoint (filesystems only, when mounted).
    const permissions = parsed.base.type === 'filesystem' && parsed.base.mountpoint
      ? await statMountpoint(parsed.base.mountpoint)
      : null

    // Shares serving this dataset's mountpoint (filesystems with a mountpoint
    // only; volumes and unmounted datasets have no path to share) — Epic 4.4.
    const associated = parsed.base.type === 'filesystem' && parsed.base.mountpoint
      ? await associatedShares(parsed.base.mountpoint)
      : []

    const detail: DatasetDetail = {
      ...parsed.base,
      properties: parsed.properties,
      permissions,
      associatedShares: associated,
    }

    return { data: detail }
  })

  // --- POST /pools/:name/datasets — create --------------------------------
  server.post<{ Params: { name: string } }>('/pools/:name/datasets', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = CreateDatasetRequestSchema.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data
    const fullName = `${poolName}/${req.path}`

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    // 409 if it already exists — the system is the source of truth.
    const existing = await listDatasets(poolName)
    if (existing.some(d => d.name === fullName)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Dataset '${fullName}' already exists` } }
    }

    const args = buildCreateArgs(fullName, req)

    const job = jobQueue.submit(
      'zfs.create',
      { ...identity, params: { dataset: fullName } },
      async () => {
        const result = await executor.exec(ZFS, args)
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs create exited with code ${result.exitCode}`)
        return { created: fullName }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- POST /pools/:name/datasets/*path/snapshots[...] — snapshot actions --
  // The only POST on the dataset wildcard is the snapshot sub-resource: create
  // a snapshot (collection) or roll back to one (`/snapshots/:snap/rollback`).
  server.post<{ Params: { 'name': string, '*': string }, Querystring: { force?: string } }>('/pools/:name/datasets/*', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data
    const wildcard = request.params['*']

    // Replication sub-resource: `<dataset>/replicate/plan` (dry-run, 200) and
    // `<dataset>/replicate` (run, 202 job). Checked before the snapshot tail —
    // these are their own action, dispatched into replication.ts.
    const REPLICATE_PLAN_SUFFIX = '/replicate/plan'
    const REPLICATE_SUFFIX = '/replicate'
    if (wildcard === 'replicate/plan' || wildcard.endsWith(REPLICATE_PLAN_SUFFIX)) {
      const dpath = wildcard === 'replicate/plan' ? '' : wildcard.slice(0, -REPLICATE_PLAN_SUFFIX.length)
      return replication.planReplication(poolName, dpath, request, reply)
    }
    if (wildcard === 'replicate' || wildcard.endsWith(REPLICATE_SUFFIX)) {
      const dpath = wildcard === 'replicate' ? '' : wildcard.slice(0, -REPLICATE_SUFFIX.length)
      return replication.runReplication(poolName, dpath, request, reply)
    }

    const tail = parseSnapshotTail(wildcard)
    if (!tail || tail.extra || (tail.snap && !tail.rollback && !tail.clone)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Unknown resource '${wildcard}'` } }
    }

    if (tail.rollback && tail.snap)
      return rollbackSnapshot(poolName, tail.datasetPath, tail.snap, request, reply)

    if (tail.clone && tail.snap)
      return cloneSnapshot(poolName, tail.datasetPath, tail.snap, request, reply)

    // Collection POST → create a snapshot.
    return createSnapshot(poolName, tail.datasetPath, request, reply)
  })

  // --- PUT /pools/:name/datasets/*path — update props OR permissions ------
  // find-my-way only permits a wildcard as the final segment, so a nested
  // dataset path plus a `/permissions` suffix cannot be two routes. We branch
  // here: a wildcard ending in `/permissions` is the SetPermissions action,
  // otherwise it is a property update.
  server.put<{ Params: { 'name': string, '*': string } }>('/pools/:name/datasets/*', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data
    const wildcard = request.params['*']

    // Snapshot rename: `<dataset>/snapshots/<snap>`.
    const tail = parseSnapshotTail(wildcard)
    if (tail) {
      if (!tail.snap || tail.rollback || tail.clone || tail.extra) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Unknown snapshot resource '${wildcard}'` } }
      }
      return renameSnapshot(poolName, tail.datasetPath, tail.snap, request, reply)
    }

    const PERM_SUFFIX = '/permissions'
    if (wildcard === 'permissions' || wildcard.endsWith(PERM_SUFFIX)) {
      const path = wildcard === 'permissions' ? '' : wildcard.slice(0, -PERM_SUFFIX.length)
      return setPermissions(poolName, path, request, reply)
    }

    if (wildcard === 'access' || wildcard.endsWith(ACCESS_SUFFIX)) {
      const path = wildcard === 'access' ? '' : wildcard.slice(0, -ACCESS_SUFFIX.length)
      return setAccess(poolName, path, request, reply)
    }

    return updateProperties(poolName, wildcard, request, reply)
  })

  async function updateProperties(
    poolName: string,
    path: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    // Empty path targets the pool-root dataset (3.26 — the root is a
    // first-class dataset and accepts property-set like any child).
    const fullName = resolveDatasetName(poolName, path, reply)
    if (!fullName)
      return reply

    const bodyParsed = UpdateDatasetPropertiesRequestSchema.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid property update: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const props = bodyParsed.data.properties
    const pairs = buildSetPairs(props)

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const existing = await listDatasets(poolName)
    const target = existing.find(d => d.name === fullName)
    if (!target) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }

    // Story iscsi.3 — a volume and a filesystem accept DIFFERENT properties, and
    // ZFS reports the mismatch as an opaque failure part-way through the set.
    // Refuse the mismatch at the boundary instead, naming the property.
    if (target.type === 'volume') {
      const notOnVolume = (['recordsize', 'quota', 'refquota', 'atime'] as const)
        .filter(k => props[k] !== undefined)
      if (notOnVolume.length > 0) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `'${fullName}' is a volume; ${notOnVolume.join(', ')} ${notOnVolume.length > 1 ? 'are filesystem properties' : 'is a filesystem property'} and ZFS does not carry ${notOnVolume.length > 1 ? 'them' : 'it'} on a volume` } }
      }
      // THE gate: grow yes, shrink never (assertVolumeMutable, the one seam).
      // Story iscsi.6: the holding LUN rides in too, so a refused shrink names
      // what is serving the volume as well as why the shrink itself is refused.
      const refusal = assertVolumeMutable(
        fullName,
        'grow',
        target,
        { volsize: props.volsize },
        target?.type === 'volume' ? await datasetHeldByLun(target, fullName) : null,
      )
      if (refusal) {
        reply.code(409)
        return { error: { code: 'CONFLICT', reason: refusal.reason, message: refusal.message } }
      }
    }
    else if (props.volsize !== undefined) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `'${fullName}' is a filesystem; volsize applies only to a volume` } }
    }

    const job = jobQueue.submit(
      'zfs.set',
      { ...identity, params: { dataset: fullName, properties: bodyParsed.data.properties } },
      async (updateProgress) => {
        // ONE `zfs set` carrying every pair, not one call per property (#43).
        // ZFS validates the whole property list before it writes any of it, so
        // a value it rejects can no longer land AFTER earlier properties were
        // already applied — the half-applied edit is structurally impossible,
        // not merely unlikely. (Values are also validated at the API boundary
        // by the shared schema, so a bad one rarely reaches ZFS at all.)
        const spec = pairs.join(' ')
        updateProgress(`Setting ${spec} on ${fullName}`)
        const result = await executor.exec(ZFS, ['set', ...pairs, fullName])
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs set ${spec} exited with code ${result.exitCode}`)
        return { dataset: fullName, applied: pairs }
      },
    )

    reply.code(202)
    return { job }
  }

  async function setPermissions(
    poolName: string,
    path: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    // Empty path targets the pool root dataset; otherwise validate the path.
    let fullName = poolName
    if (path) {
      const pathParsed = DatasetPath.safeParse(path)
      if (!pathParsed.success) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid dataset path: ${pathParsed.error.issues[0]?.message}` } }
      }
      fullName = `${poolName}/${pathParsed.data}`
    }

    const bodyParsed = SetPermissionsRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid permissions request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { owner, group, mode, recursive } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Resolve the mountpoint from the dataset — permissions apply to the path.
    const r = await executor.exec(ZFS, ['get', '-j', 'all', fullName])
    if (r.exitCode !== 0 || !r.stdout.trim()) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }
    const parsed = parseDatasetGet(r.stdout, fullName)
    if (!parsed) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }
    const mountpoint = parsed.base.mountpoint
    if (!mountpoint) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Dataset '${fullName}' has no mountpoint (volume or unmounted)` } }
    }

    const job = jobQueue.submit(
      'fs.setPermissions',
      { ...identity, params: { dataset: fullName, mountpoint, owner, group, mode, recursive } },
      async (updateProgress) => {
        if (owner !== undefined || group !== undefined) {
          const spec = group !== undefined ? `${owner ?? ''}:${group}` : `${owner}`
          const args = recursive ? ['-R', spec, mountpoint] : [spec, mountpoint]
          updateProgress(`chown ${spec} ${mountpoint}`)
          const result = await executor.exec(CHOWN, args)
          if (result.exitCode !== 0)
            throw new Error(result.stderr.trim() || `chown exited with code ${result.exitCode}`)
        }
        if (mode !== undefined) {
          const args = recursive ? ['-R', mode, mountpoint] : [mode, mountpoint]
          updateProgress(`chmod ${mode} ${mountpoint}`)
          const result = await executor.exec(CHMOD, args)
          if (result.exitCode !== 0)
            throw new Error(result.stderr.trim() || `chmod exited with code ${result.exitCode}`)
        }
        return { dataset: fullName, mountpoint }
      },
    )

    reply.code(202)
    return { job }
  }

  // --- GET access — the layered access state of a dataset mountpoint -------
  async function getAccess(poolName: string, path: string, reply: FastifyReply) {
    const target = await resolveAccessTarget(poolName, path, reply)
    if (!target)
      return reply
    const { fullName, mountpoint } = target

    const perm = await statMountpoint(mountpoint)
    if (!perm) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Mountpoint '${mountpoint}' could not be read` } }
    }

    const supported = await aclSupported()
    const enabled = isPosixAcl(await getAcltype(fullName))

    let entries: AccessEntry[]
    let aclText: string | null = null
    /** acltype says posixacl, but the ACL itself could not be read (#37). */
    let aclDegraded = false

    // A principal whose uid/gid no longer resolves shows as a bare number
    // (getfacl/stat print the numeric id) — an orphan from a delete outside
    // ANAS. Flag it so the UI can render "unknown (uid N)".
    const ownerOrphan = isNumericId(perm.owner)
    const groupOrphan = isNumericId(perm.group)

    if (enabled && supported) {
      // ACLs are live: read the full ACL and map it to entries.
      const r = await executor.exec(GETFACL, ['-pcE', mountpoint])
      if (r.exitCode === 0 && r.stdout.trim()) {
        const acl = parseGetfacl(r.stdout)
        entries = [
          orphanFlag({ kind: 'owner', level: permsToLevel(acl.owner) }, ownerOrphan),
          orphanFlag({ kind: 'owning-group', level: permsToLevel(acl.owningGroup) }, groupOrphan),
          { kind: 'everyone', level: permsToLevel(acl.everyone) },
          // Named entries; mask + default entries are managed, not shown.
          ...acl.named.map((n): AccessEntry =>
            orphanFlag({ kind: n.type, name: n.name, level: permsToLevel(n.perms) }, isNumericId(n.name))),
        ]
      }
      else {
        // ACLs enabled but unreadable. The mode bits are all we have, so the
        // entries below are an APPROXIMATION and any named grants are missing
        // from them. Say so (aclDegraded) and stop claiming healthy ACLs —
        // a client that believed `aclEnabled: true` here would present an empty
        // named list as the truth and let the operator "apply" it (#37).
        aclDegraded = true
        entries = baseEntriesFromMode(perm.mode, ownerOrphan, groupOrphan)
      }
      // Raw ACL text (with header, no effective comments) for the Advanced panel.
      const raw = await executor.exec(GETFACL, ['-pE', mountpoint])
      aclText = raw.exitCode === 0 ? raw.stdout : null
    }
    else {
      // No ACLs: the base three come straight from the mode bits.
      entries = baseEntriesFromMode(perm.mode, ownerOrphan, groupOrphan)
    }

    const data: DatasetAccess = {
      owner: perm.owner,
      group: perm.group,
      aclSupported: supported,
      aclEnabled: enabled && !aclDegraded,
      entries,
      aclText,
    }
    if (aclDegraded)
      data.aclDegraded = true
    return { data }
  }

  // --- PUT access — set the layered access state (chown + chmod / ACLs) ----
  async function setAccess(poolName: string, path: string, request: FastifyRequest, reply: FastifyReply) {
    const bodyParsed = SetAccessRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid access request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const target = await resolveAccessTarget(poolName, path, reply)
    if (!target)
      return reply
    const { fullName, mountpoint } = target

    const perm = await statMountpoint(mountpoint)
    if (!perm) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Mountpoint '${mountpoint}' could not be read` } }
    }

    const recursive = req.applyToExisting === true

    const requestedNamed = (req.entries ?? []).filter(isNamed)
    const baseChanged = req.entries !== undefined
    /** Named grants are stripped ONLY on an explicit request (#37). */
    const clearNamed = req.clearNamed === true

    // owner/group only when actually changing (respect the current identity).
    const ownerChanged = req.owner !== undefined && req.owner !== perm.owner
    const groupChanged = req.group !== undefined && req.group !== perm.group

    // Plan reads (feature-detect + current ACL state) outside the job, like the
    // permissions path resolves the mountpoint outside the job.
    const supported = await aclSupported()
    const enabled = isPosixAcl(await getAcltype(fullName))

    // When ACLs are live, read the ACL once up front and reuse it for BOTH the
    // base-level fallback and the named grants we must preserve — one getfacl.
    let liveAcl: ParsedAcl | null = null
    if (enabled && supported) {
      const r = await executor.exec(GETFACL, ['-pcE', mountpoint])
      if (r.exitCode === 0 && r.stdout.trim())
        liveAcl = parseGetfacl(r.stdout)
    }

    // Desired base three: a supplied entry overrides the current level, so a
    // partial request never silently drops an unmentioned base principal. The
    // fallback "current" level must be the REAL current level: when ACLs are
    // live, take it from the actual ACL (`group::` etc.) — the mode's group
    // digit is the ACL MASK (rwx), not the owning-group level, so reading it as
    // the group level would silently escalate an omitted owning-group to
    // read-write. With no ACLs, the mode bits ARE the truth.
    const current: BaseLevels = liveAcl
      ? {
          'owner': permsToLevel(liveAcl.owner),
          'owning-group': permsToLevel(liveAcl.owningGroup),
          'everyone': permsToLevel(liveAcl.everyone),
        }
      : baseLevelsFromMode(perm.mode)
    const levelOf = (kind: BaseKind) => req.entries?.find(e => e.kind === kind)?.level ?? current[kind]
    const base: BaseLevels = {
      'owner': levelOf('owner'),
      'owning-group': levelOf('owning-group'),
      'everyone': levelOf('everyone'),
    }

    // A base-only edit PRESERVES the live named grants — it never deletes them
    // by omission (#37). Restating them in the declarative `setfacl --set` is
    // also the only correct way to move the base levels on an ACL'd directory:
    // a plain chmod would write the ACL MASK, not `group::`. When there is
    // nothing to preserve (no live ACL, or the caller asked to clear) this list
    // is empty and the mode-bit path below runs as before.
    const preservedNamed: NamedEntry[] = (baseChanged && requestedNamed.length === 0 && !clearNamed)
      ? (liveAcl?.named ?? []).map(n => ({ kind: n.type, name: n.name, level: permsToLevel(n.perms) }))
      : []
    const named = requestedNamed.length > 0 ? requestedNamed : preservedNamed
    const hasNamed = named.length > 0
    const aclAutoEnabled = hasNamed && supported && !enabled

    // Strip the named ACL entries only when the caller explicitly said so. The
    // acltype check (rather than "we saw named entries") means an explicit
    // clear still runs when the ACL could not be read — the operator asked.
    const clearAcls = clearNamed && supported && enabled

    const job = jobQueue.submit(
      'fs.setAccess',
      {
        ...identity,
        params: {
          dataset: fullName,
          mountpoint,
          ownerChanged,
          groupChanged,
          baseChanged,
          namedCount: named.length,
          preservedNamedCount: preservedNamed.length,
          clearNamed,
          applyToExisting: recursive,
          aclAutoEnabled,
        },
      },
      async (updateProgress) => {
        // Named grants need the acl package. Gate BEFORE any mutation so a
        // missing tool never leaves a half-applied state. (Only a REQUESTED
        // grant can hit this — preserved entries imply a readable live ACL.)
        if (hasNamed && !supported)
          throw new Error('The acl package (setfacl) is not installed; named user/group grants require it. Install it (apt install acl), or grant owner/group/everyone only.')

        // 1) Ownership.
        if (ownerChanged || groupChanged) {
          const spec = ownerChanged && groupChanged
            ? `${req.owner}:${req.group}`
            : ownerChanged
              ? `${req.owner}`
              : `:${req.group}`
          const args = recursive ? ['-R', spec, mountpoint] : [spec, mountpoint]
          updateProgress(`chown ${spec} ${mountpoint}`)
          const r = await executor.exec(CHOWN, args)
          if (r.exitCode !== 0)
            throw new Error(r.stderr.trim() || `chown exited with code ${r.exitCode}`)
        }

        if (hasNamed) {
          // 2) Enable POSIX ACLs on the dataset if not already (side effect).
          if (!enabled) {
            updateProgress(`zfs set acltype=posixacl xattr=sa ${fullName}`)
            const r = await executor.exec(ZFS, ['set', 'acltype=posixacl', 'xattr=sa', fullName])
            if (r.exitCode !== 0)
              throw new Error(r.stderr.trim() || `zfs set acltype=posixacl exited with code ${r.exitCode}`)
          }

          // 3) Set the access ACL DECLARATIVELY so dropped principals disappear.
          const spec = buildAclSpec(base, named, recursive)
          const setArgs = recursive ? ['-R', '--set', spec, mountpoint] : ['--set', spec, mountpoint]
          updateProgress(`setfacl --set ${spec} ${mountpoint}`)
          const setR = await executor.exec(SETFACL, setArgs)
          if (setR.exitCode !== 0)
            throw new Error(setR.stderr.trim() || `setfacl --set exited with code ${setR.exitCode}`)

          // 4) Matching DEFAULT ACL so new files inherit the grants.
          // ASSUMPTION (verify live): `setfacl -R -d --set` applies default
          // entries only to directories and does NOT error on regular files
          // during the recursive walk (GNU acl skips default-on-file). If it
          // errors live, switch step 4 to a `find <mp> -type d`-scoped set.
          const defArgs = recursive ? ['-R', '-d', '--set', spec, mountpoint] : ['-d', '--set', spec, mountpoint]
          updateProgress(`setfacl -d --set ${spec} ${mountpoint}`)
          const defR = await executor.exec(SETFACL, defArgs)
          if (defR.exitCode !== 0)
            throw new Error(defR.stderr.trim() || `setfacl -d --set exited with code ${defR.exitCode}`)

          // 5) setgid on the directory so new files take the group, completing
          // inheritance. ASSUMPTION (verify live): recursive `chmod -R g+s`
          // also sets setgid on plain files, which is inert for data files; if
          // the orchestrator prefers dirs-only, scope with `find -type d`.
          const gidArgs = recursive ? ['-R', 'g+s', mountpoint] : ['g+s', mountpoint]
          updateProgress(`chmod g+s ${mountpoint}`)
          const gidR = await executor.exec(CHMOD, gidArgs)
          if (gidR.exitCode !== 0)
            throw new Error(gidR.stderr.trim() || `chmod g+s exited with code ${gidR.exitCode}`)

          return { dataset: fullName, mountpoint, aclEnabled: true, aclAutoEnabled, namedCount: named.length }
        }

        // No named entries to apply → mode bits, plus an EXPLICIT ACL clear.
        // Strip the requested-away ACLs first so the mode bits are the whole
        // truth. This runs only for `clearNamed: true` — never inferred.
        if (clearAcls) {
          const clearArgs = recursive ? ['-R', '-b', '-k', mountpoint] : ['-b', '-k', mountpoint]
          updateProgress(`setfacl -b -k ${mountpoint}`)
          const clearR = await executor.exec(SETFACL, clearArgs)
          if (clearR.exitCode !== 0)
            throw new Error(clearR.stderr.trim() || `setfacl -b -k exited with code ${clearR.exitCode}`)
          // Also drop the setgid bit we set for ACL inheritance — with the
          // named grants gone there is nothing to inherit, and a leftover
          // setgid would make the reported mode (e.g. 2775 vs 775) misleading.
          // A recursive clear that ALSO sets the base levels folds `g-s` into
          // that one mode chmod below (one `-R` walk instead of two); every
          // other shape needs its own call.
          if (!recursive || !baseChanged) {
            const gsArgs = recursive ? ['-R', 'g-s', mountpoint] : ['g-s', mountpoint]
            updateProgress(`chmod g-s ${mountpoint}`)
            const unsetR = await executor.exec(CHMOD, gsArgs)
            if (unsetR.exitCode !== 0)
              throw new Error(unsetR.stderr.trim() || `chmod g-s exited with code ${unsetR.exitCode}`)
          }
        }
        if (baseChanged) {
          // Recursive: symbolic perms with capital `X` so execute is applied only
          // to directories (and already-executable files), never sprinkled onto
          // plain data files. When we cleared ACLs, append `,g-s` so the setgid
          // bit is removed in the SAME recursive walk (the `=` clauses set the
          // base perms, `g-s` strips setgid). Non-recursive: numeric octal is
          // correct — the mountpoint is always a directory — and the setgid-clear
          // above stays its own cheap call.
          // ASSUMPTION (verify live): `chmod -R 'u=rwX,g=rX,o=,g-s' <mp>` is
          // accepted by GNU coreutils chmod (symbolic mode with X, comma-separated
          // clauses mixing `=` and `-` operators).
          const mode = recursive
            ? (clearAcls ? `${levelsToSymbolic(base)},g-s` : levelsToSymbolic(base))
            : levelsToMode(base)
          const modeArgs = recursive ? ['-R', mode, mountpoint] : [mode, mountpoint]
          updateProgress(`chmod ${mode} ${mountpoint}`)
          const modeR = await executor.exec(CHMOD, modeArgs)
          if (modeR.exitCode !== 0)
            throw new Error(modeR.stderr.trim() || `chmod ${mode} exited with code ${modeR.exitCode}`)
        }

        return { dataset: fullName, mountpoint, aclEnabled: enabled, aclAutoEnabled: false, namedCount: 0, clearedNamed: clearAcls }
      },
    )

    reply.code(202)
    return { job }
  }

  // --- DELETE /pools/:name/datasets/*path — destroy (dangerous) -----------
  server.delete<{ Params: { 'name': string, '*': string }, Querystring: { recursive?: string } }>('/pools/:name/datasets/*', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    // Snapshot destroy: `<dataset>/snapshots/<snap>` (plain 202, no confirm).
    const tail = parseSnapshotTail(request.params['*'])
    if (tail) {
      if (!tail.snap || tail.rollback || tail.clone || tail.extra) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Unknown snapshot resource '${request.params['*']}'` } }
      }
      return destroySnapshot(poolName, tail.datasetPath, tail.snap, request, reply)
    }

    const pathParsed = DatasetPath.safeParse(request.params['*'])
    if (!pathParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid dataset path: ${pathParsed.error.issues[0]?.message}` } }
    }
    const fullName = `${poolName}/${pathParsed.data}`
    const recursive = request.query.recursive === 'true' || request.query.recursive === '1'

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const datasets = await listDatasets(poolName)
    const targetDataset = datasets.find(d => d.name === fullName)
    if (!targetDataset) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }

    // Story iscsi.6: BEFORE the confirm gate and before any `zfs destroy`, ask
    // configfs whether a LUN is serving this dataset — the volume itself, a
    // child zvol a `-r` destroy would sweep, or an image file inside a
    // filesystem's mountpoint. ZFS refuses a destroy of a claimed object with a
    // bare `dataset is busy` that names nothing, and a `-r` destroy whose CHILD
    // is the claimed one is worse: the parent's other children are destroyed
    // first, then it stops. Refusing up front is the only non-destructive
    // answer. Fail-open — an unreadable LIO tree holds nothing.
    const heldForDestroy = await datasetHeldByLun(targetDataset, fullName)
    // A volume routes through the ONE gate (story iscsi.3); a filesystem gets
    // the same refusal built from the same helper, so the two never drift.
    const volumeRefusal = assertVolumeMutable(fullName, 'destroy', targetDataset, undefined, heldForDestroy)
    if (volumeRefusal) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: volumeRefusal.reason, message: volumeRefusal.message } }
    }
    if (heldForDestroy && targetDataset.type !== 'volume') {
      const refusal = heldByLunRefusal(
        `dataset '${fullName}'${recursive ? ' (recursive)' : ''}`,
        'Destroying',
        heldForDestroy,
      )
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: refusal.reason, message: refusal.message } }
    }

    const children = datasets.filter(d => d.name.startsWith(`${fullName}/`))
    const snapshots = await snapshotNames(fullName)
    // Shares serving this dataset's mountpoint will break when it's destroyed
    // (Epic 4.4) — warn, but do not block (like the children/snapshots warnings).
    const shares = targetDataset.type === 'filesystem' && targetDataset.mountpoint
      ? await associatedShares(targetDataset.mountpoint)
      : []

    const warnings = [
      `Destroying '${fullName}' is irreversible — all data in the dataset is permanently lost.`,
    ]
    if (children.length > 0)
      warnings.push(`${children.length} child dataset(s) will also be destroyed.`)
    if (snapshots.length > 0)
      warnings.push(`${snapshots.length} snapshot(s) of '${fullName}' will also be destroyed.`)
    if (shares.length > 0)
      warnings.push(`${shares.length} share(s) serve this dataset (${shares.map(s => `'${s.protocol}:${s.name}'`).join(', ')}) and will stop working.`)
    // Live-proof F15: without this, confirming a non-recursive destroy of a
    // volume that has snapshots produced a FAILED job carrying nothing but the
    // raw `zfs` text ("volume has children / use '-r' to destroy the following
    // datasets: …"). Correct, safe, and no help at all — "guide, don't just
    // warn" wants the two ways forward named where the operator is standing,
    // which is the confirm door.
    if (!recursive && (children.length > 0 || snapshots.length > 0)) {
      warnings.push(destroyNeedsRecursive(fullName, targetDataset.type, children.map(c => c.name), snapshots))
    }

    // The confirmation protects "destroy this dataset" — `recursive` is NOT part
    // of the signature. The flag is chosen after the challenge is issued (like
    // the pool-destroy cleanup bug), so binding it here would make the confirmed
    // request mismatch the minted code and 409 again.
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'zfs.destroy',
      params: { dataset: fullName },
      message: `Destroying dataset '${fullName}' permanently erases its data`,
      warnings,
    })) {
      return reply
    }

    const args = recursive ? ['destroy', '-r', fullName] : ['destroy', fullName]

    const job = jobQueue.submit(
      'zfs.destroy',
      { ...identity, params: { dataset: fullName, recursive } },
      async () => {
        const result = await executor.exec(ZFS, args)
        if (result.exitCode !== 0) {
          // A busy dataset can't be unmounted for destroy — name the holders
          // (3.29); the path comes from the ZFS error (`cannot unmount '<path>'`).
          const base = result.stderr.trim() || `zfs destroy exited with code ${result.exitCode}`
          // Story iscsi.6: name the dataset explicitly so the LIO branch can
          // look up `/dev/zvol/<dataset>` even when ZFS's message quotes a
          // MOUNTPOINT (a busy filesystem) rather than the dataset itself.
          // ZFS's own refusal for "it has children" is a bare CLI sentence and
          // is the one failure this route can predict exactly, so it is
          // translated rather than forwarded (F15). Everything else keeps the
          // busy-diagnosis path, which names holding processes and LUNs.
          if (!recursive && ZFS_HAS_CHILDREN_RE.test(base)) {
            throw new Error(destroyNeedsRecursive(
              fullName,
              targetDataset.type,
              children.map(c => c.name),
              snapshots,
            ))
          }
          throw new Error(await enrichBusyError(executor, base, undefined, {
            ...configfsOptionsFrom(iscsiPaths),
            dataset: fullName,
          }))
        }
        return { destroyed: fullName }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- Snapshot sub-resource handlers (Epic 5) ---------------------------
  // All reached via the dataset `*` wildcard; the tail is parsed by
  // parseSnapshotTail. Full ZFS snapshot name is `<dataset>@<snap>`.

  async function listSnapshots(poolName: string, datasetPath: string, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply
    if (!(await datasetExists(poolName, fullName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }
    return { data: await listSnapshotsDetail(fullName) }
  }

  async function snapshotDetail(poolName: string, datasetPath: string, snap: string, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply
    if (!(await datasetExists(poolName, fullName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }
    const snapshot = (await listSnapshotsDetail(fullName)).find(s => s.snapshotName === snap)
    if (!snapshot) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${fullName}@${snap}' not found` } }
    }
    return { data: snapshot }
  }

  async function createSnapshot(poolName: string, datasetPath: string, request: FastifyRequest, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply

    const bodyParsed = CreateSnapshotRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create snapshot request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { name, recursive } = bodyParsed.data
    const snapName = `${fullName}@${name}`

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await datasetExists(poolName, fullName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }

    // 409 if the snapshot already exists — the system is the source of truth.
    const existing = await listSnapshotsDetail(fullName)
    if (existing.some(s => s.name === snapName)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Snapshot '${snapName}' already exists` } }
    }

    const job = jobQueue.submit(
      'zfs.snapshot',
      { ...identity, params: { snapshot: snapName, recursive: recursive ?? false } },
      async () => {
        // The ONE zfs-snapshot verb (backup2.3's extraction) — same argv, same
        // error text, one definition shared with the schedules service and the
        // backup runner.
        await createZfsSnapshot(executor, { dataset: fullName, name, recursive: recursive === true })
        return { created: snapName }
      },
    )

    reply.code(202)
    return { job }
  }

  async function renameSnapshot(poolName: string, datasetPath: string, snap: string, request: FastifyRequest, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply

    const snapParsed = SnapshotName.safeParse(snap)
    if (!snapParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid snapshot name: ${snapParsed.error.issues[0]?.message}` } }
    }

    const bodyParsed = RenameSnapshotRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid rename snapshot request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { newName } = bodyParsed.data
    const from = `${fullName}@${snap}`
    const to = `${fullName}@${newName}`

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const existing = await listSnapshotsDetail(fullName)
    if (!existing.some(s => s.name === from)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${from}' not found` } }
    }

    const job = jobQueue.submit(
      'zfs.rename',
      { ...identity, params: { from, to } },
      async () => {
        const result = await executor.exec(ZFS, ['rename', from, to])
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs rename exited with code ${result.exitCode}`)
        return { renamed: from, to }
      },
    )

    reply.code(202)
    return { job }
  }

  async function destroySnapshot(poolName: string, datasetPath: string, snap: string, request: FastifyRequest, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply

    const snapParsed = SnapshotName.safeParse(snap)
    if (!snapParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid snapshot name: ${snapParsed.error.issues[0]?.message}` } }
    }
    const snapName = `${fullName}@${snap}`

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const existing = await listSnapshotsDetail(fullName)
    if (!existing.some(s => s.name === snapName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${snapName}' not found` } }
    }

    // Plain 202 — destroying a snapshot removes a recovery point, not live data,
    // so no confirmation gate (DESIGN safety semantics).
    const job = jobQueue.submit(
      'zfs.destroy',
      { ...identity, params: { snapshot: snapName } },
      async () => {
        await destroyZfsSnapshot(executor, { dataset: fullName, name: snapParsed.data })
        return { destroyed: snapName }
      },
    )

    reply.code(202)
    return { job }
  }

  async function rollbackSnapshot(poolName: string, datasetPath: string, snap: string, request: FastifyRequest, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply

    const snapParsed = SnapshotName.safeParse(snap)
    if (!snapParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid snapshot name: ${snapParsed.error.issues[0]?.message}` } }
    }
    const snapName = `${fullName}@${snap}`
    // `?force=true` maps to `zfs rollback -r` (also destroys intermediate
    // snapshots). NOT bound into the confirm signature — it is chosen after the
    // challenge is issued (the pool-destroy cleanup bug).
    const q = request.query as { force?: string }
    const force = q.force === 'true' || q.force === '1'

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const snapshots = await listSnapshotsDetail(fullName)
    const target = snapshots.find(s => s.name === snapName)
    if (!target) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${snapName}' not found` } }
    }

    // Snapshots newer than the target block a plain rollback; ZFS needs `-r`
    // (force) to destroy them. listSnapshotsDetail is newest-first, so "newer"
    // are the ones ahead of the target in the list.
    const targetIndex = snapshots.findIndex(s => s.name === snapName)
    const laterSnapshots = snapshots.slice(0, targetIndex).map(s => s.snapshotName)

    // Story iscsi.3: a rollback of a VOLUME goes through the one gate, which
    // iscsi.6 taught the "held by LUN" refusal. ZFS itself permits rolling a
    // zvol back under a live iSCSI session — exit 0, with a filesystem mounted
    // on the initiator (GT-40) — so nothing below ANAS is going to stop it.
    if (await volumeGateRefused(poolName, fullName, 'rollback', reply))
      return reply

    // Story iscsi.6: the same applies to a FILESYSTEM dataset holding a LUN's
    // image file. A rollback rewrites that file's contents underneath a LIO
    // backstore that is still serving it — the initiator's filesystem does not
    // even know, and there is no rescan that repairs it. Refused before the
    // confirm gate, before `zfs rollback`.
    const rollbackRow = await datasetRow(poolName, fullName)
    if (rollbackRow?.type !== 'volume') {
      const held = await datasetHeldByLun(rollbackRow, fullName)
      if (held) {
        const refusal = heldByLunRefusal(`dataset '${fullName}' to snapshot '${snap}'`, 'Rolling back', held)
        reply.code(409)
        reply.send({ error: { code: 'CONFLICT', reason: refusal.reason, message: refusal.message } })
        return reply
      }
    }

    const warnings = [
      `Rolling back discards all changes to '${fullName}' since snapshot '${snap}'.`,
    ]
    if (laterSnapshots.length > 0) {
      warnings.push(`${laterSnapshots.length} more recent snapshot(s) exist (${laterSnapshots.join(', ')}); rollback requires force to destroy them, and doing so is irreversible.`)
    }

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'zfs.rollback',
      params: { snapshot: snapName },
      message: `Rolling back '${fullName}' to snapshot '${snap}' discards newer data`,
      warnings,
    })) {
      return reply
    }

    const args = force ? ['rollback', '-r', snapName] : ['rollback', snapName]

    const job = jobQueue.submit(
      'zfs.rollback',
      { ...identity, params: { snapshot: snapName, force } },
      async () => {
        const result = await executor.exec(ZFS, args)
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs rollback exited with code ${result.exitCode}`)
        return { rolledBack: snapName }
      },
    )

    reply.code(202)
    return { job }
  }

  async function cloneSnapshot(poolName: string, datasetPath: string, snap: string, request: FastifyRequest, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply

    const snapParsed = SnapshotName.safeParse(snap)
    if (!snapParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid snapshot name: ${snapParsed.error.issues[0]?.message}` } }
    }
    const snapName = `${fullName}@${snap}`

    const bodyParsed = CloneSnapshotRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid clone request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { target } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // 404 if the source snapshot does not exist (system is the source of truth).
    const existing = await listSnapshotsDetail(fullName)
    if (!existing.some(s => s.name === snapName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${snapName}' not found` } }
    }

    // 409 if the target dataset already exists — clone creates a NEW dataset.
    const targetPool = target.split('/')[0]
    const targetDatasets = await listDatasets(targetPool)
    if (targetDatasets.some(d => d.name === target)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Dataset '${target}' already exists` } }
    }

    // Plain 202 — creating a new dataset from a snapshot is not destructive, so
    // no confirmation gate (it never touches existing data).
    const job = jobQueue.submit(
      'zfs.clone',
      { ...identity, params: { snapshot: snapName, target } },
      async () => {
        const result = await executor.exec(ZFS, ['clone', snapName, target])
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs clone exited with code ${result.exitCode}`)
        return { cloned: snapName, target }
      },
    )

    reply.code(202)
    return { job }
  }
}
