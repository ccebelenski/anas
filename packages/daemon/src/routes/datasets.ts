import type { AssociatedShare, CreateDatasetRequest, Dataset, DatasetDetail, DatasetListDefaults, IscsiHeldByLun, Snapshot, UpdateDatasetPropertiesRequest } from '@anas/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { LockClaim, LockMode } from '../jobs/locks.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { Advisory, Gate, GuardReads, GuardSpec, ObjectView, Refusal } from '../safety/guard.js'
import type { AccessObject, AccessService, SetAccessPlan } from '../services/access.js'
import type { IscsiPaths } from '../services/iscsi.js'
import type { PveFootprint } from '../services/pve-footprint.js'
import type { Transport } from '../services/replication-transport.js'
import { CloneSnapshotRequest, CreateDatasetRequest as CreateDatasetRequestSchema, CreateSnapshotRequest, DatasetPath, DestroyDatasetQuery, lunGrowGuidance, PoolName, RenameSnapshotRequest, reservedDatasetSegment, RollbackSnapshotQuery, SetAccessRequest, SnapshotName, UpdateDatasetPropertiesRequest as UpdateDatasetPropertiesRequestSchema } from '@anas/shared'
import { parseExports } from '../parsers/exports.js'
import { parseSmbConf } from '../parsers/smb-conf.js'
import { parseZfsJson } from '../parsers/utils.js'
import { parseDatasetGet, parseSnapshotList, parseSnapshotNames, parseVolblocksizeDefault, parseZfsList, zfsListArgs, zfsSnapshotDetailArgs, zfsSnapshotListArgs, zfsSweepSnapshotListArgs } from '../parsers/zfs-list.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { guardCheck, guardConfirm, guarded, sendRefusal, zfsDatasetClaims } from '../safety/guard.js'
import { readDatasetGuid, readPoolGuid, readRollbackIds } from '../safety/stable-id.js'
import { createAccessService, SET_ACCESS_PRESENTATION_ONLY, signedAccessRequest } from '../services/access.js'
import { enrichBusyError } from '../services/busy-diagnosis.js'
import { readConfig } from '../services/config-writer.js'
import { configfsOptionsFrom, createIscsiClaimCache, heldByLun, heldByLunRefusal, lioUnreadableAdvisory } from '../services/iscsi-held.js'
import { readIscsiState, withIscsiLock } from '../services/iscsi-mutate.js'
import { checkServedDevice, reverifyServedLun, servedLunIdentity, statDeviceFrom } from '../services/iscsi-served.js'
import { mountTargetGate } from '../services/mounts.js'
import { loadPveFootprint, ownershipRefusal, pveDescendantsUnlistedMessage, pveManagedRefusal, pveNamingGuardMessage, pveRecursiveRefusalMessage } from '../services/pve-footprint.js'
import { describeHolds, readLocalHoldsChecked } from '../services/replication-holds.js'
import { createZfsSnapshot, destroyZfsSnapshot } from '../services/zfs-snapshot.js'
import { requireIdentity } from './identity.js'
import { createReplicationHandlers } from './replication.js'

const ZFS = '/usr/sbin/zfs'

/** Terminal sub-action of the dataset wildcard for the access editor. */
const ACCESS_SUFFIX = '/access'

/** `zfs list` stderr when the named dataset (or its pool) is not there. */
const DATASET_ABSENT_RE = /dataset does not exist/i

/** Where a dataset name's pool part ends: the first `/`, `@` (snapshot) or `#` (bookmark). */
const POOL_PART_END = /[/@#]/

/** A createtxg as `zfs list -Hp` prints it. */
const TXG_RE = /^\d+$/

/**
 * Story cr.37 (WAVE3-DESIGN §5.2 rule 1): the request fields the dataset
 * destroy and the rollback confirms do NOT sign, each with its reason. None:
 * `recursive` and `force` decide what the job destroys.
 * `datasets-guard.test.ts` pins both lists.
 */
export const DATASET_DESTROY_PRESENTATION_ONLY: Record<string, string> = {}
export const SNAPSHOT_ROLLBACK_PRESENTATION_ONLY: Record<string, string> = {}

/**
 * A wildcard path whose reading (dataset or snapshot sub-route) could not be
 * decided because the `zfs list` that decides it failed for a reason other
 * than "does not exist" (story ident.1 review, audit #12).
 */
class PathUnresolvedError extends Error {
  constructor(full: string, detail: string) {
    super(`Could not resolve the path '${full}': reading it from ZFS failed (${detail}). Nothing was done; retry once ZFS answers.`)
    this.name = 'PathUnresolvedError'
  }
}

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
 *
 * Exported rather than route-private because the new-LUN image restore
 * (story backup2.10) creates its zvol backing through the SAME `zfs create`
 * argv — one builder for the volume-create arguments, not two copies.
 */
export function buildCreateArgs(fullName: string, req: CreateDatasetRequest): string[] {
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
  // cr.12: `--` ends option parsing before the dataset name.
  args.push('--', fullName)
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
  // cr.52 (review H1): the property-set door gains the mountpoint property that
  // create always carried — `zfs set mountpoint=<path>`, guarded like create's.
  if (p.mountpoint !== undefined)
    pairs.push(`mountpoint=${p.mountpoint}`)
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

/**
 * The snapshot sub-resource of a dataset wildcard, or null if the wildcard is a
 * plain dataset path. find-my-way only allows a terminal wildcard, so the whole
 * `<datasetpath>/snapshots/<snap>/<action>` tail arrives as one `*` capture.
 * Split on a `snapshots` path segment: everything before it is the dataset
 * path (may contain '/'), everything after is the snapshot sub-resource.
 * Snapshot names never contain '/'; a DATASET named `…/snapshots/…` (one made
 * before ident.1 reserved the segment) is what makes it ambiguous, and the
 * router resolves that by what exists ({@link snapshotTails}).
 *
 *   media/snapshots                 → { datasetPath: 'media' }                       (collection)
 *   media/movies/snapshots/snap1    → { datasetPath: 'media/movies', snap: 'snap1' } (item)
 *   media/snapshots/snap1/rollback  → { datasetPath: 'media', snap: 'snap1', rollback }
 *   snapshots                       → { datasetPath: '' }                            (pool-root dataset)
 */
export interface SnapshotTail {
  datasetPath: string
  snap?: string
  rollback: boolean
  /** `<snap>/clone` — clone the snapshot into a new dataset (Epic 5.7). */
  clone: boolean
  /** Trailing segments we don't understand (→ 404). */
  extra: boolean
}

/**
 * Every reading of `wildcard` as a snapshot sub-route — one per `snapshots`
 * segment, leftmost first (story ident.1). A dataset created before the
 * segment was reserved may itself be named `…/snapshots/…`, so the leftmost
 * split is not always the right one; the router picks among these by what
 * exists ({@link datasetRoutes}' `resolveSnapshotTail`).
 *
 * Exported for tests.
 */
export function snapshotTails(wildcard: string): SnapshotTail[] {
  const parts = wildcard.split('/')
  const tails: SnapshotTail[] = []
  parts.forEach((seg, idx) => {
    if (seg !== 'snapshots')
      return
    const datasetPath = parts.slice(0, idx).join('/')
    const rest = parts.slice(idx + 1)
    const snap = rest[0]
    const rollback = rest.length === 2 && rest[1] === 'rollback'
    const clone = rest.length === 2 && rest[1] === 'clone'
    const known = rest.length === 0 || rest.length === 1 || rollback || clone
    tails.push({ datasetPath, snap, rollback, clone, extra: !known })
  })
  return tails
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
    /**
     * The ONE permissions writer (access.1) — shared with the AHR and share
     * routes so the acl-package probe is made once per server. Built here
     * when a caller (a test) registers the routes on their own.
     */
    accessService?: AccessService
    /**
     * The `anas-repl-*` task units (ANAS_SYSTEMD_DIR / `/etc/systemd/system`):
     * a forced rollback refused over a replication hold names the task that
     * holds the snapshot (nf.3 D11), and the replication handlers read them
     * for the legacy hold migration. Defaults to the units' own default.
     */
    systemdDir?: string
  },
) {
  const { executor, jobQueue, confirmStore, transport } = opts
  const iscsiPaths = opts.iscsiPaths ?? {}
  const access = opts.accessService ?? createAccessService({ executor, iscsiPaths })

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
    // PVE footprint ownership (story pvepool.1): the ONE service that answers
    // "is this dataset PVE's?" — the target guard asks it per request.
    pveFootprint: () => loadPveFootprint(executor),
    transport,
    ...(opts.systemdDir ? { systemdDir: opts.systemdDir } : {}),
  })

  /** Does the named pool exist? (source of truth is `zpool list`). */
  async function poolExists(poolName: string): Promise<boolean> {
    const r = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = r.exitCode === 0 && r.stdout.trim() ? parseZpoolList(r.stdout) : []
    return pools.some(p => p.name === poolName)
  }

  /**
   * The PVE footprint, loaded ONCE per request (story pvepool.1). The ONE
   * answerer for "does PVE own this dataset?" — every guard and every stamp in
   * this file asks it; there is no local copy of the old pool-level rule.
   */
  function pveFootprint() {
    return loadPveFootprint(executor)
  }

  /**
   * Stamp the per-node `pve` verdict onto every OWNED row (story pvepool.1).
   * Additive and optional (version-skew ruling): a row outside PVE's footprint
   * carries no field, so "absent" means manageable — an older UI ignores the
   * field entirely and keeps today's whole-pool rule.
   */
  function stampPveOwnership(pve: PveFootprint, rows: Dataset[]): void {
    for (const d of rows) {
      const owned = pve.ownershipOf(d.name)
      if (owned)
        d.pve = owned
    }
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

  /**
   * Story ident.1 (audit #12): does `<pool>/<path>` name an existing
   * filesystem or volume? Asked only when the path carries a reserved
   * sub-resource segment (`snapshots`, `access`, `permissions`) unless
   * `always` — elsewhere there is nothing ambiguous to resolve.
   *
   * "No" is only ever ZFS's own answer (`dataset does not exist`). Any other
   * failed read throws {@link PathUnresolvedError}: reading a failed lookup as
   * "not a dataset" would route DELETE `tank/snapshots/old` to the snapshot
   * destroy of `tank@old`, unconfirmed.
   */
  async function namesExistingDataset(poolName: string, path: string, always = false): Promise<boolean> {
    if (!path || (!always && reservedDatasetSegment(path) === null))
      return false
    if (!PoolName.safeParse(poolName).success || !DatasetPath.safeParse(path).success)
      return false
    const full = `${poolName}/${path}`
    const r = await executor.exec(ZFS, ['list', '-H', '-o', 'name', '-t', 'filesystem,volume', '--', full])
    if (r.exitCode === 0)
      return r.stdout.trim() === full
    if (DATASET_ABSENT_RE.test(r.stderr))
      return false
    throw new PathUnresolvedError(full, r.stderr.trim() || `exit ${r.exitCode}`)
  }

  /**
   * Run a path resolution; a {@link PathUnresolvedError} answers 503 and the
   * request goes no further (never a guess at which resource the path names).
   */
  async function resolveOrRefuse<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<{ ok: true, value: T } | { ok: false, body: { error: { code: string, message: string } } }> {
    try {
      return { ok: true, value: await fn() }
    }
    catch (err) {
      if (!(err instanceof PathUnresolvedError))
        throw err
      reply.code(503)
      return { ok: false, body: { error: { code: 'UNAVAILABLE', message: err.message } } }
    }
  }

  /**
   * The snapshot sub-route `wildcard` names, or null when it names a dataset
   * (story ident.1, audit #12). A path that names an EXISTING dataset is that
   * dataset — never a snapshot route: destroying `tank/snapshots/old` once
   * destroyed `tank@old`. Otherwise, when several `snapshots` segments could
   * split it, the rightmost split whose dataset exists wins (the pool root
   * always does); with none, the leftmost (the old reading — the handler then
   * 404s the missing dataset).
   */
  async function resolveSnapshotTail(poolName: string, wildcard: string): Promise<SnapshotTail | null> {
    if (await namesExistingDataset(poolName, wildcard))
      return null
    const tails = snapshotTails(wildcard)
    if (tails.length <= 1)
      return tails[0] ?? null
    for (let i = tails.length - 1; i >= 0; i--) {
      const t = tails[i]
      if (!t.extra && (t.datasetPath === '' || await namesExistingDataset(poolName, t.datasetPath, true)))
        return t
    }
    return tails[0]
  }

  /** Does the named dataset (or pool-root dataset) exist? */
  async function datasetExists(poolName: string, fullName: string): Promise<boolean> {
    const datasets = await listDatasets(poolName)
    return datasets.some(d => d.name === fullName)
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
  async function datasetHeldByLun(
    row: Dataset | null,
    fullName: string,
    cache = createIscsiClaimCache(executor, iscsiPaths),
  ): Promise<IscsiHeldByLun | null> {
    const subject: { dataset: string, path?: string } = { dataset: fullName }
    if (row?.mountpoint && row.mountpoint.startsWith('/'))
      subject.path = row.mountpoint
    return heldByLun(cache, subject)
  }

  /**
   * Story ident.1 (audit #20): the refusal for a RECURSIVE permission change
   * (chown/chmod/setfacl `-R`) whose tree holds a PVE-owned descendant — the
   * same `ownedDescendant` question a recursive destroy or snapshot asks —
   * or null when there is none. An unreadable dataset list refuses (a walk the
   * daemon cannot see through is never allowed). The question lives in the
   * access service (access.1) so the share grant asks the same one.
   */
  async function recursiveOwnedRefusal(poolName: string, fullName: string) {
    return access.zfsRecursiveRefusal(poolName, fullName)
  }

  // -------------------------------------------------------------------------
  // Story cr.37 (WAVE3-DESIGN §2.1 dataset rows, §3, §4.2, §5; EPICS §2 ruling
  // (j)): every dataset and snapshot verb describes itself ONCE as a guard
  // spec. The route runs the spec's gates (`guardCheck`) and the job runs the
  // SAME list again against facts it reads itself (`guarded`) before any `zfs`
  // that changes anything; a refusal fails the job with the gate's own code
  // and sentence. The job is submitted with the verb's `zfs:` lock claims
  // (cr.33), so its re-read sees whatever ran on the dataset before it.
  //
  // Identity: the two confirmed verbs bind the object's stable id (destroy:
  // the dataset's guid; rollback: the snapshot createtxgs, ident.1). The
  // unconfirmed verbs have no confirmed object to compare with: their id is
  // the name the request named, and every gate re-runs against whatever
  // carries that name when the job starts.
  // -------------------------------------------------------------------------

  /** A pool's dataset listing: the rows, and each dataset's createtxg (what a recursive destroy binds). */
  interface PoolListing {
    datasets: Dataset[]
    /** name → createtxg, from the same `zfs list -j` (it prints createtxg on every row). */
    createtxg: Map<string, string>
  }

  /** The pool's listing, or null when the read FAILED (never "no datasets": a recursive verb refuses on it). */
  async function readPoolListing(poolName: string): Promise<PoolListing | null> {
    const r = await executor.exec(ZFS, zfsListArgs(poolName))
    if (r.exitCode !== 0 || !r.stdout.trim())
      return null
    try {
      const raw = parseZfsJson<{ datasets?: Record<string, { name?: string, createtxg?: string }> }>(r.stdout, { datasets: {} })
      const createtxg = new Map<string, string>()
      for (const ds of Object.values(raw.datasets ?? {})) {
        if (ds.name && ds.createtxg)
          createtxg.set(ds.name, ds.createtxg)
      }
      return { datasets: parseZfsList(r.stdout), createtxg }
    }
    catch {
      return null
    }
  }

  /** The per-run reads the dataset gates share (one per guard run, never across doors). */
  const dsReads = {
    listing: (reads: GuardReads, pool: string) => reads.once(`zfs-list:${pool}`, () => readPoolListing(pool)),
    footprint: (reads: GuardReads) => reads.once('pve-footprint', () => pveFootprint()),
    claims: (reads: GuardReads) => reads.once('iscsi-claims', async () => createIscsiClaimCache(executor, iscsiPaths)),
    snapshots: (reads: GuardReads, dataset: string) => reads.once(`snapshots:${dataset}`, () => listSnapshotsDetail(dataset)),
    poolGuid: (reads: GuardReads, pool: string) => reads.once(`pool-guid:${pool}`, () => readPoolGuid(executor, pool)),
    rollbackIds: (reads: GuardReads, dataset: string, snapshot: string) =>
      reads.once(`rollback-ids:${snapshot}`, () => readRollbackIds(executor, dataset, snapshot)),
    bookmarks: (reads: GuardReads, dataset: string) => reads.once(`bookmarks:${dataset}`, () => readBookmarks(dataset)),
  }

  /** The pool a dataset, snapshot (`@`) or bookmark (`#`) name lives in. */
  function poolOf(name: string): string {
    return name.split(POOL_PART_END)[0]
  }

  /**
   * The lock claims (cr.33, §4.2) for each named dataset in its mode: the
   * dataset's `zfs:<pool guid>/<path>` key, every ancestor's and the pool's
   * shared, and the pool's name key shared. A pool whose guid cannot be read
   * is locked by its name key only, exclusive (§4.2's conservative fallback;
   * cr.33b: the shared name key of every guid-keyed claim set meets it).
   */
  async function datasetClaims(reads: GuardReads, wanted: [name: string, mode: LockMode][]): Promise<LockClaim[]> {
    const out: LockClaim[] = []
    for (const [name, mode] of wanted) {
      const pool = poolOf(name)
      const guid = (await dsReads.poolGuid(reads, pool))?.guid
      out.push(...zfsDatasetClaims(guid, name, mode))
    }
    return out
  }

  /** 400 VALIDATION_ERROR: a request the daemon cannot act on as stated. */
  function invalid(message: string): Refusal {
    return { status: 400, code: 'VALIDATION_ERROR', message }
  }

  /** 409 CONFLICT, with the machine-readable reason when there is one. */
  function conflict(message: string, reason?: string): Refusal {
    return { status: 409, code: 'CONFLICT', message, ...(reason ? { reason } : {}) }
  }

  /**
   * The OWNERSHIP gate (story pvepool.1): an OWNED dataset (a storage root, a
   * guest volume, a dir-storage tree, the boot tree) is view-only to every
   * verb here. 409 PVE_MANAGED (cr.47b — the one answer a PVE-territory fact
   * gets at every door) with the predicate's reason, no bypass.
   */
  function ownedGate<O>(nameOf: (o: O) => string): Gate<O> {
    return async (o, reads) => {
      const owned = (await dsReads.footprint(reads)).ownershipOf(nameOf(o))
      return owned ? ownershipRefusal(owned) : null
    }
  }

  /** A dataset verb's object: its row in the pool listing, and the listing. */
  interface DatasetObject {
    name: string
    /** Null only when `listing` is (the pool listing could not be read). */
    row: Dataset | null
    listing: PoolListing | null
  }

  /**
   * Read a dataset for a guard: null when the pool listing names no such
   * dataset; an object with `listing: null` when the listing itself could not
   * be read, so {@link listedGate} decides what that means for the verb.
   */
  function datasetView(
    poolName: string,
    fullName: string,
    id: ObjectView<DatasetObject>['id'],
    extra: Partial<ObjectView<DatasetObject>> = {},
  ): ObjectView<DatasetObject> {
    return {
      what: `Dataset '${fullName}'`,
      read: async (reads) => {
        const listing = await dsReads.listing(reads, poolName)
        if (!listing)
          return { name: fullName, row: null, listing: null }
        const row = listing.datasets.find(d => d.name === fullName)
        return row ? { name: fullName, row, listing } : null
      },
      id,
      unbound: () => `Could not read dataset '${fullName}' — refusing a change that cannot be bound to it`,
      ...extra,
    }
  }

  /** An unconfirmed verb's id: the name the request named. */
  function nameId(key: string, name: string): () => Promise<Record<string, string>> {
    return async () => ({ [key]: name })
  }

  /**
   * The pool listing could not be read (pvepool.1 review fix 4): a RECURSIVE
   * verb would sweep a subtree the daemon cannot see, refused 400; a plain one
   * keeps its vanished-target 404.
   */
  function listedGate(recursive: boolean, verb: string): Gate<DatasetObject> {
    return async (o) => {
      if (o.listing)
        return null
      return recursive
        ? invalid(pveDescendantsUnlistedMessage(verb, o.name))
        : { status: 404, code: 'NOT_FOUND', message: `Dataset '${o.name}' not found` }
    }
  }

  /**
   * A recursive verb's OWNED-DESCENDANT gate (pvepool.1 review fix 2): a
   * storage registered on a NESTED path leaves the tree above it unowned, so
   * `-r` would take PVE's storage root and its guest disks with it.
   */
  function ownedDescendantGate(label: string): Gate<DatasetObject> {
    return async (o, reads) => {
      if (!o.listing)
        return null
      const descendant = (await dsReads.footprint(reads)).ownedDescendant(o.listing.datasets, o.name)
      return descendant ? ownershipRefusal(descendant.ownership, pveRecursiveRefusalMessage(label, o.name, descendant)) : null
    }
  }

  /**
   * The destroy's HELD-BY-LUN gate (story iscsi.6): a LUN serving the volume,
   * a child zvol a `-r` destroy would sweep, or an image file inside a
   * filesystem's mountpoint. ZFS refuses a destroy of a claimed object with a
   * bare `dataset is busy` that names nothing, and a `-r` destroy whose CHILD
   * is the claimed one destroys the parent's other children first, then
   * stops. A volume goes through the one volume gate (iscsi.3); a filesystem
   * gets the same refusal from the same helper. Fail-open: an unreadable LIO
   * tree holds nothing (disclosed as an advisory).
   */
  function destroyLunGate(recursive: boolean): Gate<DatasetObject> {
    return async (o, reads) => {
      if (!o.row)
        return null
      const held = await datasetHeldByLun(o.row, o.name, await dsReads.claims(reads))
      const volumeRefusal = assertVolumeMutable(o.name, 'destroy', o.row, undefined, held)
      if (volumeRefusal)
        return conflict(volumeRefusal.message, volumeRefusal.reason)
      if (held && o.row.type !== 'volume') {
        const refusal = heldByLunRefusal(`dataset '${o.name}'${recursive ? ' (recursive)' : ''}`, 'Destroying', held)
        return conflict(refusal.message, refusal.reason)
      }
      return null
    }
  }

  /**
   * The recursive destroy's HOLD gate (story cr.47e, nf.3 D11's pattern on the
   * bigger sweep). `zfs destroy -r <fs>` over a tree whose child's snapshot
   * carries a user hold is a PARTIAL destroy — wave-2 node row 6: it took the
   * siblings, the held child's other children and the parent's own snapshots,
   * then failed on the held one (exit 1; only `w2z/p`, `w2z/p/c` and
   * `w2z/p/c@s` were left), and `zfs destroy -rnv` cannot pre-check (it exits 0
   * and lists the held snapshot as "would destroy"). The gate reads the holds
   * on every snapshot the sweep would destroy — the dataset's own and each
   * descendant's — ahead of time and refuses, naming each hold, so nothing
   * unheld is ever destroyed first.
   *
   * The sweep set is enumerated with ONE `zfs list -H -t snapshot -r -o name`
   * rather than per-dataset snapshot reads: a recursive list returns exactly
   * what `destroy -r` destroys, fresh from ZFS (a snapshot made beside the pool
   * listing is covered), in one call instead of one per descendant. Then ONE
   * `zfs holds -H` on all of them (the same call D11 uses) reads the tags. Fail
   * closed: a sweep that cannot be listed, or holds that cannot be read, refuse —
   * destroying on a guess is exactly the partial this gate exists for.
   *
   * A NON-recursive destroy takes no gate: ZFS itself refuses a dataset that
   * still has snapshots before touching anything (live-proof F15), so there is
   * no unheld half-destroy to protect against.
   */
  const destroyHoldGate: Gate<DatasetObject> = async (o, reads) => {
    const swept = await reads.once(`destroy-sweep:${o.name}`, async () => {
      const r = await executor.exec(ZFS, zfsSweepSnapshotListArgs(o.name))
      if (r.exitCode !== 0)
        return null
      return r.stdout.split('\n').map(line => line.trim()).filter(Boolean)
    })
    if (swept === null) {
      return conflict(`Could not read the snapshots a recursive destroy of '${o.name}' would sweep — refusing: `
        + 'a held one would stop the destroy only after the unheld ones were gone', 'snapshot-holds-unreadable')
    }
    if (swept.length === 0)
      return null
    const holds = await reads.once(`holds:${swept.join('\0')}`, () => readLocalHoldsChecked(executor, swept))
    if (!holds) {
      return conflict(`Could not read the holds on the snapshots a recursive destroy of '${o.name}' would destroy — `
        + 'refusing: a held one would stop the destroy only after the unheld ones were gone', 'snapshot-holds-unreadable')
    }
    const held = swept.filter(name => (holds.get(name) ?? []).length > 0)
    if (held.length === 0)
      return null
    const named: string[] = []
    for (const name of held)
      named.push(`${name} ${(await describeHolds(holds.get(name)!, opts.systemdDir)).join(', ')}`)
    return conflict(`A recursive destroy of '${o.name}' is refused: it would destroy held snapshots, `
      + `and ZFS stops at a held snapshot only after destroying the unheld ones — nothing was done. ${named.join('; ')}.`, 'snapshot-held')
  }

  /**
   * Fail-open is not fail-silent (D3): a broken claims read reads as "nothing
   * held", which a dataset genuinely serving a LUN would look exactly like —
   * `zfs destroy` succeeds silently under a live session (GT-40). The key, the
   * sentence and the read-failed test are the one shared helper in
   * `services/iscsi-held.ts`; this adapter only supplies the per-run cache and
   * the family's noun.
   */
  async function lioUnreadableDisclosure(reads: GuardReads): Promise<Advisory[]> {
    return lioUnreadableAdvisory(await dsReads.claims(reads), 'dataset')
  }

  /**
   * The dataset DESTROY spec. A recursive destroy binds its blast radius as
   * the scope (WAVE3-DESIGN §5.2 rule 2): every child dataset by name and
   * createtxg, so a child created after the challenge makes the resend 409
   * CONFIRM_SCOPE_CHANGED and the job (if it appears while the job waits)
   * fail STATE_CHANGED. createtxg is ZFS's own creation stamp: a child
   * destroyed and re-created under the same name carries a new one.
   */
  function destroyGuardSpec(poolName: string, fullName: string, recursive: boolean): GuardSpec<DatasetObject> {
    return {
      operation: 'zfs.destroy',
      object: datasetView(poolName, fullName, o => readDatasetGuid(executor, o.name), {
        ...(recursive
          ? {
              scope: async (o: DatasetObject) => {
                if (!o.listing)
                  return null
                const children: string[] = []
                for (const d of o.listing.datasets.filter(d => d.name.startsWith(`${o.name}/`))) {
                  const txg = o.listing.createtxg.get(d.name)
                  if (!txg)
                    return null
                  children.push(`${d.name} (createtxg ${txg})`)
                }
                children.sort()
                return { children: children.join(', ') }
              },
            }
          : {}),
        scopeLabels: { children: 'the child datasets' },
        unbound: part => part === 'scope'
          ? `Could not list the child datasets of '${fullName}' — refusing a recursive destroy that cannot be bound to them`
          : `Could not read the guid of dataset '${fullName}' — refusing a destroy that cannot be bound to it`,
      }),
      gates: [
        listedGate(recursive, 'destroy'),
        ownedGate<DatasetObject>(o => o.name),
        ...(recursive ? [ownedDescendantGate('Destroy'), destroyHoldGate] : []),
        destroyLunGate(recursive),
      ],
      advisories: (_o, reads) => lioUnreadableDisclosure(reads),
      // §4.2: exclusive on the dataset, which excludes every verb on a
      // descendant (each holds this key shared, as an ancestor).
      locks: (o, _bound, reads) => datasetClaims(reads, [[o.name, 'exclusive']]),
    }
  }

  /** A snapshot verb's object: the snapshot, found in its dataset's listing. */
  interface SnapshotObject {
    dataset: string
    snap: string
    snapName: string
    /** The dataset's snapshots, newest first. */
    snapshots: Snapshot[]
  }

  function snapshotView(fullName: string, snap: string, extra: Partial<ObjectView<SnapshotObject>> = {}): ObjectView<SnapshotObject> {
    const snapName = `${fullName}@${snap}`
    return {
      what: `Snapshot '${snapName}'`,
      read: async (reads) => {
        const snapshots = await dsReads.snapshots(reads, fullName)
        return snapshots.some(s => s.name === snapName) ? { dataset: fullName, snap, snapName, snapshots } : null
      },
      id: nameId('snapshot', snapName),
      unbound: () => `Could not read snapshot '${snapName}' — refusing a change that cannot be bound to it`,
      ...extra,
    }
  }

  /**
   * A dataset's bookmarks with their createtxg, or null when the read failed.
   * `zfs rollback -r` destroys every bookmark newer than the target, as well
   * as every newer snapshot.
   */
  async function readBookmarks(dataset: string): Promise<{ name: string, txg: bigint }[] | null> {
    const r = await executor.exec(ZFS, ['list', '-t', 'bookmark', '-H', '-p', '-o', 'name,createtxg', '-d', '1', '--', dataset])
    if (r.exitCode !== 0)
      return null
    const out: { name: string, txg: bigint }[] = []
    for (const line of r.stdout.split('\n')) {
      const [name, txg] = line.trim().split('\t')
      if (!name || !txg || !name.startsWith(`${dataset}#`) || !TXG_RE.test(txg))
        continue
      out.push({ name, txg: BigInt(txg) })
    }
    return out
  }

  /**
   * What `zfs rollback -r` destroys: every snapshot newer than the target (the
   * listing is newest first) and every bookmark created after it. Null when a
   * read failed. Sorted, so the bound string compares.
   */
  async function forceDestroys(o: SnapshotObject, reads: GuardReads): Promise<string[] | null> {
    const ids = await dsReads.rollbackIds(reads, o.dataset, o.snapName)
    const bookmarks = await dsReads.bookmarks(reads, o.dataset)
    const index = o.snapshots.findIndex(s => s.name === o.snapName)
    if (!ids || !bookmarks || index < 0)
      return null
    const target = BigInt(ids.snapshotTxg)
    const names = [
      ...o.snapshots.slice(0, index).map(s => s.name),
      ...bookmarks.filter(b => b.txg > target).map(b => b.name),
    ]
    names.sort()
    return names
  }

  /**
   * The rollback's HELD-BY-LUN gate (iscsi.3 + iscsi.6). ZFS rolls a zvol back
   * under a live iSCSI session (exit 0, with a filesystem mounted on the
   * initiator, GT-40) and rewrites an image FILE inside a filesystem
   * underneath a LIO backstore still serving it. Refused, no bypass. The row
   * read is fail-open (nothing asserted on an unreadable listing).
   */
  const rollbackLunGate: Gate<SnapshotObject> = async (o, reads) => {
    const row = (await dsReads.listing(reads, poolOf(o.dataset)))?.datasets.find(d => d.name === o.dataset) ?? null
    const held = await datasetHeldByLun(row, o.dataset, await dsReads.claims(reads))
    if (row?.type === 'volume') {
      const refusal = assertVolumeMutable(o.dataset, 'rollback', row, undefined, held)
      return refusal ? conflict(refusal.message, refusal.reason) : null
    }
    if (!held)
      return null
    const refusal = heldByLunRefusal(`dataset '${o.dataset}' to snapshot '${o.snap}'`, 'Rolling back', held)
    return conflict(refusal.message, refusal.reason)
  }

  /**
   * The forced rollback's HOLD gate (nf.3 D11). `zfs rollback -r` destroys the
   * newer snapshots one at a time, newest first, and a snapshot with a user
   * hold cannot be destroyed (`zfs-hold(8)`: "attempts to destroy that snapshot
   * by using the zfs destroy command return EBUSY") — so the rollback destroys
   * every unheld snapshot newer than the held one, then fails "dataset is busy"
   * and is not done (wave-3b row 5b: `@s1r` lost, the replication base kept,
   * no rollback). A forced rollback whose sweep includes a held snapshot is
   * therefore refused before anything runs, naming each held snapshot and who
   * holds it (a replication's `anas-repl-*` base above all: destroying it
   * would also break that task's next incremental).
   *
   * Read with `zfs holds -H` on the swept snapshots, not `zfs get userrefs`:
   * userrefs is only a count, and the refusal names the TAG (which task) —
   * the same read the replication's own hold settle step parses. Fail closed:
   * holds that cannot be read refuse, since destroying snapshots on a guess
   * is exactly the case this gate exists for. Bookmarks carry no holds.
   */
  const rollbackHoldGate: Gate<SnapshotObject> = async (o, reads) => {
    const swept = o.snapshots.slice(0, o.snapshots.findIndex(s => s.name === o.snapName)).map(s => s.name)
    if (swept.length === 0)
      return null
    const holds = await reads.once(`holds:${swept.join('\0')}`, () => readLocalHoldsChecked(executor, swept))
    if (!holds) {
      return conflict(`Could not read the holds on the snapshots a forced rollback of '${o.dataset}' to '${o.snap}' destroys — `
        + 'refusing: a held one would stop the rollback only after the newer unheld ones were destroyed', 'snapshot-holds-unreadable')
    }
    const held = swept.filter(name => (holds.get(name) ?? []).length > 0)
    if (held.length === 0)
      return null
    const named: string[] = []
    for (const name of held)
      named.push(`${name} ${(await describeHolds(holds.get(name)!, opts.systemdDir)).join(', ')}`)
    return conflict(`A forced rollback of '${o.dataset}' to '${o.snap}' is refused: it would destroy held snapshots, `
      + `and ZFS stops at a held snapshot only after destroying the newer unheld ones — nothing was done. ${named.join('; ')}.`, 'snapshot-held')
  }

  /**
   * The ROLLBACK spec: bound to the target snapshot's createtxg and the newest
   * snapshot's (ident.1: a snapshot taken after the challenge makes it another
   * rollback). With `force` the scope is what `-r` destroys, snapshots AND
   * bookmarks by name, so a bookmark made after the challenge is a change too,
   * and the hold gate (nf.3 D11) refuses a sweep over a held snapshot.
   */
  function rollbackGuardSpec(fullName: string, snap: string, force: boolean): GuardSpec<SnapshotObject> {
    return {
      operation: 'zfs.rollback',
      object: snapshotView(fullName, snap, {
        id: (o, reads) => dsReads.rollbackIds(reads, o.dataset, o.snapName),
        ...(force
          ? {
              scope: async (o: SnapshotObject, reads: GuardReads) => {
                const destroys = await forceDestroys(o, reads)
                return destroys ? { destroys: destroys.join(', ') } : null
              },
            }
          : {}),
        scopeLabels: { destroys: 'what force destroys' },
        unbound: part => part === 'scope'
          ? `Could not read the snapshots and bookmarks of '${fullName}' — refusing a forced rollback that cannot be bound to what it destroys`
          : `Could not read the snapshots of '${fullName}' — refusing a rollback that cannot be bound to them`,
      }),
      gates: [ownedGate<SnapshotObject>(o => o.dataset), rollbackLunGate, ...(force ? [rollbackHoldGate] : [])],
      // cr.37 review (P1): the same LIO-unreadable disclosure destroy gives —
      // the rollback gate reads LIO exactly as fail-open, so it warns the same.
      advisories: (_o, reads) => lioUnreadableDisclosure(reads),
      // §4.2: a rollback rewrites the dataset, exclusive.
      locks: (o, _bound, reads) => datasetClaims(reads, [[o.dataset, 'exclusive']]),
    }
  }

  /**
   * The NAME COLLISION gate: a dataset already carries the name — 409, the
   * system is the source of truth. Fail-open on an unreadable listing: `zfs
   * create`/`zfs clone` refuse an existing name themselves.
   */
  function collisionGate<O>(nameOf: (o: O) => string): Gate<O> {
    return async (o, reads) => {
      const name = nameOf(o)
      const listing = await dsReads.listing(reads, poolOf(name))
      return listing?.datasets.some(d => d.name === name) ? conflict(`Dataset '${name}' already exists`) : null
    }
  }

  /**
   * The PVE NAMING gate (story pvepool.1): a guest-named direct child of a
   * storage path would be inventoried by PVE as a guest disk on its next scan.
   */
  function namingGate<O>(nameOf: (o: O) => string): Gate<O> {
    return async (o, reads) => {
      const name = nameOf(o)
      const claim = (await dsReads.footprint(reads)).claimedByPve(name)
      return claim ? invalid(pveNamingGuardMessage(claim.storage, name)) : null
    }
  }

  /** A create's object: the pool the new dataset goes into. */
  interface CreateObject { pool: string, name: string }

  /**
   * The dataset CREATE spec: the pool exists, the name is free, the naming
   * guard and ownership of the new name (a storage root, a dir-storage tree,
   * the boot tree). A plain child of a storage root is owned by neither rule —
   * the point of pvepool.1.
   */
  function createGuardSpec(poolName: string, fullName: string, mountpoint?: string): GuardSpec<CreateObject> {
    return {
      operation: 'zfs.create',
      object: {
        what: `Pool '${poolName}'`,
        read: async reads => (await reads.once(`pool-exists:${poolName}`, () => poolExists(poolName))) ? { pool: poolName, name: fullName } : null,
        id: nameId('dataset', fullName),
        unbound: () => `Could not read pool '${poolName}'`,
      },
      // cr.52 (review H1): the create's `-o mountpoint=` value runs the one
      // shared system-path refusal like every other door — at the route and,
      // because this is a gate, again in the job before the `zfs create`.
      gates: [
        collisionGate<CreateObject>(o => o.name),
        namingGate<CreateObject>(o => o.name),
        ownedGate<CreateObject>(o => o.name),
        mountTargetGate<CreateObject>(mountpoint),
      ],
      // §4.2: the new name's key exclusive, its ancestors' shared — a destroy
      // of the parent (exclusive on it) and this create serialise.
      locks: (o, _bound, reads) => datasetClaims(reads, [[o.name, 'exclusive']]),
    }
  }

  /** The snapshot name is taken — 409 (ZFS would refuse it too, with less to say). */
  function snapshotCollisionGate(snapName: string): Gate<DatasetObject> {
    return async (o, reads) => {
      const existing = await dsReads.snapshots(reads, o.name)
      return existing.some(s => s.name === snapName) ? conflict(`Snapshot '${snapName}' already exists`) : null
    }
  }

  /**
   * The SNAPSHOT CREATE spec: the dataset exists, ownership (a storage-root
   * snapshot sweeps PVE's guest zvols; a guest volume's snapshots are PVE's to
   * take), and with `recursive` every descendant (a storage on a NESTED path).
   */
  function snapshotGuardSpec(poolName: string, fullName: string, snapName: string, recursive: boolean): GuardSpec<DatasetObject> {
    return {
      operation: 'zfs.snapshot',
      object: datasetView(poolName, fullName, nameId('dataset', fullName)),
      gates: [
        listedGate(recursive, 'snapshot'),
        ownedGate<DatasetObject>(o => o.name),
        ...(recursive ? [ownedDescendantGate('Recursive snapshot')] : []),
        snapshotCollisionGate(snapName),
      ],
      // §4.2: a snapshot is shared — two snapshots run together; a destroy,
      // rollback or rename of the dataset waits.
      locks: (o, _bound, reads) => datasetClaims(reads, [[o.name, 'shared']]),
    }
  }

  /**
   * The spec of a verb on ONE existing snapshot that needs nothing but the
   * dataset's ownership: rename and destroy (pvepool.1: an owned dataset's
   * snapshots are PVE's to manage).
   *
   * The DESTROY takes its dataset key SHARED (cr.47 (c), node row 6): a
   * recursive `zfs destroy -r <fs>@<snap>` is ATOMIC — a held or send-busy
   * child destroys NOTHING (c1/c4) — and ZFS's own "dataset is busy" refusal
   * protects even the one snapshot a send reads (c5, no `-r`). Deleting an
   * unrelated old snapshot therefore no longer waits hours behind a mover; the
   * schedule's own prune already takes the key shared.
   *
   * The RENAME stays EXCLUSIVE: the node proved `zfs rename -r` is stopped by
   * NEITHER a hold NOR a running send (c2/c3) — a send completes and the
   * receiver gets the OLD name (F2) — so there is no ZFS busy refusal to lean
   * on, and a shared key would let a mover's incremental base be renamed under
   * it. (docs/WAVE3-DESIGN.md §4.2)
   */
  function snapshotOwnedSpec(operation: 'zfs.rename' | 'zfs.destroy', fullName: string, snap: string): GuardSpec<SnapshotObject> {
    return {
      operation,
      object: snapshotView(fullName, snap),
      gates: [ownedGate<SnapshotObject>(o => o.dataset)],
      locks: (o, _bound, reads) => datasetClaims(reads, [[o.dataset, operation === 'zfs.rename' ? 'exclusive' : 'shared']]),
    }
  }

  /**
   * The CLONE spec — a dataset create wearing another hat: the source
   * snapshot exists and its dataset is not PVE's; the target name is free,
   * passes the naming guard and is not owned.
   */
  function cloneGuardSpec(fullName: string, snap: string, target: string): GuardSpec<SnapshotObject> {
    return {
      operation: 'zfs.clone',
      object: snapshotView(fullName, snap),
      gates: [
        ownedGate<SnapshotObject>(o => o.dataset),
        collisionGate<SnapshotObject>(() => target),
        namingGate<SnapshotObject>(() => target),
        ownedGate<SnapshotObject>(() => target),
      ],
      // §4.2: the source is read (shared), the target is created (exclusive).
      locks: (o, _bound, reads) => datasetClaims(reads, [[o.dataset, 'shared'], [target, 'exclusive']]),
    }
  }

  /**
   * A volsize grow rounded UP to a multiple of the volume's `volblocksize` (O1
   * follow-up, 0.3.1), exactly as growZvolLun does on the iSCSI door and as
   * `zfs create -V` does silently. Without it an unaligned volsize makes `zfs
   * set volsize=` fail with a raw "must be a multiple of volume block size".
   * Fail-open: an absent volblocksize applies the size as asked.
   */
  function roundVolsize(row: Dataset | null, volsize: number | undefined): number | undefined {
    const bs = row?.volblocksize
    if (volsize === undefined || bs === undefined || bs <= 0 || volsize % bs === 0)
      return volsize
    return Math.ceil(volsize / bs) * bs
  }

  /**
   * The PROPERTY KIND gate (story iscsi.3): a volume and a filesystem accept
   * DIFFERENT properties, and ZFS reports the mismatch as an opaque failure
   * part-way through the set — refused at the boundary, naming the property.
   */
  function propertyKindGate(props: UpdateDatasetPropertiesRequest['properties']): Gate<DatasetObject> {
    return async (o) => {
      if (!o.row)
        return null
      if (o.row.type === 'volume') {
        const notOnVolume = (['recordsize', 'quota', 'refquota', 'atime', 'mountpoint'] as const).filter(k => props[k] !== undefined)
        return notOnVolume.length > 0
          ? invalid(`'${o.name}' is a volume; ${notOnVolume.join(', ')} ${notOnVolume.length > 1 ? 'are filesystem properties' : 'is a filesystem property'} and ZFS does not carry ${notOnVolume.length > 1 ? 'them' : 'it'} on a volume`)
          : null
      }
      return props.volsize !== undefined ? invalid(`'${o.name}' is a filesystem; volsize applies only to a volume`) : null
    }
  }

  /**
   * THE volume gate for a property edit (assertVolumeMutable, the one seam):
   * grow yes, shrink never — compared against the volume's size NOW, so a
   * volume grown past the requested size while the job waited is a shrink and
   * refused. The holding LUN rides in, so a refused shrink names it.
   */
  function shrinkGate(props: UpdateDatasetPropertiesRequest['properties']): Gate<DatasetObject> {
    return async (o, reads) => {
      if (o.row?.type !== 'volume')
        return null
      const held = await datasetHeldByLun(o.row, o.name, await dsReads.claims(reads))
      const refusal = assertVolumeMutable(o.name, 'grow', o.row, { volsize: roundVolsize(o.row, props.volsize) }, held)
      return refusal ? conflict(refusal.message, refusal.reason) : null
    }
  }

  /** The PROPERTY SET spec: the dataset exists, ownership, the property kind, the volume gate. */
  function setPropertiesGuardSpec(poolName: string, fullName: string, props: UpdateDatasetPropertiesRequest['properties']): GuardSpec<DatasetObject> {
    return {
      operation: 'zfs.set',
      object: datasetView(poolName, fullName, nameId('dataset', fullName)),
      // cr.52 (review H1): once `mountpoint` is settable here its value runs
      // the one shared system-path refusal, at the route and in the job.
      gates: [listedGate(false, 'set'), ownedGate<DatasetObject>(o => o.name), mountTargetGate<DatasetObject>(props.mountpoint), propertyKindGate(props), shrinkGate(props)],
      // cr.37 review (P1): shrinkGate's held-LUN read is the same fail-open
      // read destroy's is — disclose an unreadable LIO tree the same way.
      advisories: (_o, reads) => lioUnreadableDisclosure(reads),
      locks: (o, _bound, reads) => datasetClaims(reads, [[o.name, 'exclusive']]),
    }
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
    const r = await executor.exec(ZFS, ['list', '-j', '-o', 'name', '-t', 'snapshot', '-r', '--', poolName])
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

    // Story pvepool.1: per-node PVE ownership, decided by the one predicate —
    // owned rows carry `pve`, everything else (the siblings this story exists
    // to unlock) carries nothing. Fail-open like the enrichment above.
    try {
      stampPveOwnership(await pveFootprint(), datasets)
    }
    catch {
      // fail-open — omit the field rather than fail the list
    }

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
    // cr.12 (H4 step 5): the pool name is validated before ANY command runs —
    // same validator, same 400 shape as the list route above.
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data
    const path = request.params['*']

    // ident.1: a path naming an existing dataset is that dataset, whatever
    // reserved segment it carries.
    const isDatasetRead = await resolveOrRefuse(reply, () => namesExistingDataset(poolName, path))
    if (!isDatasetRead.ok)
      return isDatasetRead.body
    const isDataset = isDatasetRead.value

    // Access sub-resource: `<dataset>/access` (layered permissions editor).
    if (!isDataset && (path === 'access' || path.endsWith(ACCESS_SUFFIX))) {
      const dpath = path === 'access' ? '' : path.slice(0, -ACCESS_SUFFIX.length)
      return getAccess(poolName, dpath, reply)
    }

    // Snapshot sub-resource: `<dataset>/snapshots[/<snap>]`.
    const tailRead = isDataset ? { ok: true as const, value: null } : await resolveOrRefuse(reply, () => resolveSnapshotTail(poolName, path))
    if (!tailRead.ok)
      return tailRead.body
    const tail = tailRead.value
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

    const r = await executor.exec(ZFS, ['get', '-j', 'all', '--', fullName])
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
      ? await access.statMountpoint(parsed.base.mountpoint)
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

    // Story pvepool.1: the same per-node verdict the tree stamps, so Detail
    // agrees with the list by construction. Additive; absent when not owned.
    try {
      const owned = (await pveFootprint()).ownershipOf(fullName)
      if (owned)
        detail.pve = owned
    }
    catch {
      // fail-open — omit the field rather than fail the detail
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

    // Story cr.37: the one guard spec both doors run — the pool exists, the
    // name is free (409; the system is the source of truth), and the PVE
    // footprint (pvepool.1): the NAMING GUARD first (a guest-named direct
    // child of a storage path would be inventoried by PVE as a guest disk),
    // then ownership of the new name. The job runs them again before
    // `zfs create`, holding the new name's lock.
    const spec = createGuardSpec(poolName, fullName, req.properties?.mountpoint)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const args = buildCreateArgs(fullName, req)

    const job = jobQueue.submit(
      'zfs.create',
      { ...identity, params: { dataset: fullName } },
      guarded(spec, pre, async () => {
        const result = await executor.exec(ZFS, args)
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs create exited with code ${result.exitCode}`)
        return { created: fullName }
      }),
      { locks: pre.locks },
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

    const tailRead = await resolveOrRefuse(reply, () => resolveSnapshotTail(poolName, wildcard))
    if (!tailRead.ok)
      return tailRead.body
    const tail = tailRead.value
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

    // ident.1: a path naming an existing dataset is a property update of that
    // dataset, whatever reserved segment it carries.
    const isDatasetRead = await resolveOrRefuse(reply, () => namesExistingDataset(poolName, wildcard))
    if (!isDatasetRead.ok)
      return isDatasetRead.body
    if (isDatasetRead.value)
      return updateProperties(poolName, wildcard, request, reply)

    // Snapshot rename: `<dataset>/snapshots/<snap>`.
    const tailRead = await resolveOrRefuse(reply, () => resolveSnapshotTail(poolName, wildcard))
    if (!tailRead.ok)
      return tailRead.body
    const tail = tailRead.value
    if (tail) {
      if (!tail.snap || tail.rollback || tail.clone || tail.extra) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Unknown snapshot resource '${wildcard}'` } }
      }
      return renameSnapshot(poolName, tail.datasetPath, tail.snap, request, reply)
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

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story cr.37: the one guard spec both doors run — the dataset exists,
    // PVE ownership (pvepool.1: an OWNED dataset is view-only for properties),
    // the property kind (iscsi.3: a volume and a filesystem accept DIFFERENT
    // properties) and the volume gate (grow yes, shrink never, compared with
    // the size the volume has NOW). The job runs them again before `zfs set`.
    const spec = setPropertiesGuardSpec(poolName, fullName, props)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const target = pre.object.row as Dataset

    // O1 follow-up (0.3.1): a volsize grow is rounded UP to the volume's
    // `volblocksize` — the size the gate compared, the one the params report
    // (an already-aligned request is unchanged).
    props.volsize = roundVolsize(target, props.volsize)

    // Job-result warnings: the LUN grow guidance (below), and the LIO-unreadable
    // disclosure (P1) — advisory on every verb whose LUN gate is fail-open.
    const warnings: string[] = []
    warnings.push(...pre.advisories.map(a => a.warning))
    /** ident.1: the served LUN a volsize grow was verified against (re-read in the job). */
    let servedGrow: ReturnType<typeof servedLunIdentity> | null = null

    if (target.type === 'volume' && props.volsize !== undefined) {
      // A grow of a LUN-backed volume succeeds — and then goes quiet. The
      // shared sentence (lunGrowGuidance) rides the job result as a warning,
      // exactly as the iSCSI door's own LUN resize carries it: one definition,
      // two doors.
      const held = await datasetHeldByLun(target, fullName)
      if (held !== null)
        warnings.push(lunGrowGuidance(props.volsize))

      // ident.1 + ident.2 (audit #8): a grow of a zvol a live LUN serves runs
      // `zfs set volsize=` on the volume the PATH names, so that volume must be
      // the device LIO serves (`stat(/dev/zvol/<ds>).rdev` = the backstore's
      // major:minor) — after a rename + re-create under the live LUN it is not,
      // and the size the gate compared was the served device's. Refused 409
      // `served-device-mismatch` with ident.2's sentence; re-verified in the job.
      if (held !== null) {
        const { ctx, targets } = await readIscsiState(executor, iscsiPaths)
        const lun = targets.find(t => t.iqn === held.targetIqn)?.luns.find(l => l.index === held.index)
        if (lun) {
          const verdict = await checkServedDevice(ctx.live, lun, statDeviceFrom(iscsiPaths))
          if (verdict.refusal) {
            reply.code(409)
            return { error: { code: 'CONFLICT', reason: verdict.refusal.reason, message: verdict.refusal.message } }
          }
          servedGrow = servedLunIdentity(held.targetIqn, lun, verdict.device)
        }
      }
    }

    const job = jobQueue.submit(
      'zfs.set',
      { ...identity, params: { dataset: fullName, properties: bodyParsed.data.properties } },
      // Ruling (j): ownership, the property kind and the volume gate again,
      // against the dataset as it is now (the shrink compares the CURRENT size).
      guarded(spec, pre, async (dataset, { updateProgress, newAdvisories }) => {
        // The job's own re-read may earn the disclosure the route door did not
        // have (P1); `newAdvisories` is already filtered against the route's.
        warnings.push(...newAdvisories)
        // ONE `zfs set` carrying every pair, not one call per property (#43).
        // ZFS validates the whole property list before it writes any of it, so
        // a value it rejects can no longer land AFTER earlier properties were
        // already applied — the half-applied edit is structurally impossible,
        // not merely unlikely. The volsize is rounded against the volume the
        // job just re-read (the size its gate compared).
        const pairs = buildSetPairs({ ...props, volsize: roundVolsize(dataset.row, props.volsize) })
        // (The property list as one string, for progress/errors — NOT the
        // guard's `spec` this line used to shadow.)
        const propArgs = pairs.join(' ')
        const apply = async () => {
          updateProgress(`Setting ${propArgs} on ${fullName}`)
          const result = await executor.exec(ZFS, ['set', '--', ...pairs, fullName])
          if (result.exitCode !== 0)
            throw new Error(result.stderr.trim() || `zfs set ${propArgs} exited with code ${result.exitCode}`)
          return { dataset: fullName, applied: pairs, warnings }
        }
        // A grow of a served zvol: the LUN and its served device are re-read
        // under the iSCSI lock, immediately before the `zfs set`.
        const served = servedGrow
        if (!served)
          return apply()
        return withIscsiLock(async () => {
          await reverifyServedLun(executor, iscsiPaths, served, { requireDevice: true })
          return apply()
        })
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  }

  // --- GET access — the layered access state of a dataset mountpoint -------
  // The writer itself lives in services/access.ts (access.1): this route only
  // names the ZFS target and sends what the service answers.
  async function getAccess(poolName: string, path: string, reply: FastifyReply) {
    const target = await access.resolveZfsTarget(poolName, path)
    if (!target.ok) {
      reply.code(target.failure.status)
      return target.failure.body
    }
    const read = await access.readAccess(target.value)
    if (!read.ok) {
      reply.code(read.failure.status)
      return read.failure.body
    }
    return { data: read.value }
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

    // pvepool.1 review fixes: an OWNED dataset is view-only — setfacl/chmod on
    // its mountpoint (let alone -R) is PVE's territory to change. Asked BEFORE
    // the target resolution so an owned VOLUME is refused 409 PVE_MANAGED with
    // the reason (the resolution would 404 it as "not a mounted filesystem")
    // and before any command runs. The plain path parse is the one the
    // resolution repeats; the 400 it can send is identical.
    const name = access.zfsFullName(poolName, path)
    if (!name.ok) {
      reply.code(name.failure.status)
      return name.failure.body
    }
    const fullName = name.value

    // Story cr.37: the one `fs.setAccess` guard spec (services/access.ts),
    // with this door's own gates first — pvepool.1 review fixes: an OWNED
    // dataset is view-only (setfacl/chmod on its mountpoint is PVE's to
    // change), asked BEFORE the target resolution so an owned VOLUME is
    // refused 400 with the reason rather than 404'd as "not a mounted
    // filesystem"; and ident.1 (audit #20): `setfacl -R`/`chmod -R`
    // (applyToExisting) walks into every child dataset mounted beneath this
    // one, refused when any descendant is PVE's. Then the resolution and the
    // plan from the live state, whose revision the confirm and the job bind.
    const spec = access.setAccessGuardSpec({
      what: `Dataset '${fullName}'`,
      address: { dataset: fullName },
      req,
      resolve: () => access.resolveZfsTarget(poolName, path),
      before: [
        ownedGate<AccessObject>(() => fullName),
        async () => {
          if (req.applyToExisting !== true)
            return null
          // cr.47b: an owned descendant answers 409 PVE_MANAGED like every
          // other door; the unlistable-subtree case is a different fact and
          // keeps its 400.
          const refusal = await recursiveOwnedRefusal(poolName, fullName)
          return refusal ? (refusal.pveOwned ? pveManagedRefusal(refusal.message) : invalid(refusal.message)) : null
        },
      ],
    })
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const plan = pre.object.plan as SetAccessPlan

    // Operator ruling 2026-10-11: rewriting every existing file is a Level 2
    // dangerous operation — 409 + X-Anas-Confirm-Code, asked LAST so a
    // refused request never offers a confirm. Story cr.37: the code signs the
    // whole request (owner, group, entries, clearNamed) and the revision of
    // the ACL state the plan was computed from.
    if (plan.recursive) {
      const confirm = await access.recursiveConfirm(plan.target, { named: plan.hasNamed, walk: plan.walk })
      if (!guardConfirm(confirmStore, request, reply, spec, pre, {
        validated: { dataset: fullName, ...signedAccessRequest(req) },
        address: ['dataset'],
        presentationOnly: SET_ACCESS_PRESENTATION_ONLY,
        message: confirm.message,
        warnings: confirm.warnings,
      })) {
        return reply
      }
    }

    const job = jobQueue.submit(
      'fs.setAccess',
      { ...identity, params: access.jobParams(plan) },
      // Ruling (j): the gates again, and the plan only while the state it was
      // computed from is unchanged (STATE_CHANGED otherwise, nothing written).
      guarded(spec, pre, async (_o, ctx) => access.runSetAccess(plan, ctx.updateProgress)),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  }

  // --- DELETE /pools/:name/datasets/*path — destroy (dangerous) -----------
  server.delete<{ Params: { 'name': string, '*': string }, Querystring: Record<string, unknown> }>('/pools/:name/datasets/*', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    // Snapshot destroy: `<dataset>/snapshots/<snap>` (plain 202, no confirm).
    // ident.1: unless the path names an existing dataset — then it is that
    // dataset's (confirm-gated) destroy, never a snapshot's.
    const tailRead = await resolveOrRefuse(reply, () => resolveSnapshotTail(poolName, request.params['*']))
    if (!tailRead.ok)
      return tailRead.body
    const tail = tailRead.value
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
    // Story cr.37: the flag is normalised (absent ≡ `false`; `true`/`1` on) by
    // the one lenient schema before the confirm signs it.
    const { recursive } = DestroyDatasetQuery.parse(request.query ?? {})

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story cr.37: the one guard spec both doors run — the listing (a
    // recursive destroy over an unreadable list is refused, pvepool.1 review
    // fix 4), PVE ownership of the dataset and, recursive, of every
    // descendant (pvepool.1), and the LUN gate (iscsi.6) — all before the
    // confirm is minted, and again in the job before `zfs destroy`.
    const spec = destroyGuardSpec(poolName, fullName, recursive)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const targetDataset = pre.object.row as Dataset
    const datasets = pre.object.listing?.datasets ?? []

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
    // What is bound is what was shown (WAVE3-DESIGN §5.2 rule 2): a recursive
    // destroy names every child dataset its code is bound to.
    if (recursive && children.length > 0)
      warnings.push(`Child datasets destroyed with it: ${children.map(c => c.name).sort().join(', ')}.`)
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
    // The LIO-unreadable disclosure (D3) — an advisory, re-read by the job.
    warnings.push(...pre.advisories.map(a => a.warning))

    // Story cr.37 (M3): the code signs the whole validated request —
    // `recursive` included, the confirm window re-challenges in place when the
    // box is ticked (cr.44) — plus the dataset's guid (ident.1: a dataset
    // destroyed and recreated under the same name is IDENTITY_MISMATCH) and,
    // recursive, the child datasets (a child created since is
    // CONFIRM_SCOPE_CHANGED naming it). A resend with the other `recursive` is
    // CONFIRM_SCOPE_CHANGED naming the flag.
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { dataset: fullName, recursive },
      address: ['dataset'],
      presentationOnly: DATASET_DESTROY_PRESENTATION_ONLY,
      message: `Destroying dataset '${fullName}' permanently erases its data`,
      warnings,
    })) {
      return reply
    }

    const args = recursive ? ['destroy', '-r', '--', fullName] : ['destroy', '--', fullName]

    const job = jobQueue.submit(
      'zfs.destroy',
      { ...identity, params: { dataset: fullName, recursive, guid: pre.bound.id.guid } },
      // Ruling (j): the job may have waited behind scrubs, backups and the
      // dataset's lock. Same object (guid), the same child set (recursive)
      // and every gate above, against the tree as it is NOW — a child created,
      // a storage PVE registered or a LUN added since the challenge refuses
      // the destroy here, before `zfs destroy` runs.
      guarded(spec, pre, async (_dataset, ctx) => {
        // cr.34 (WAVE3-DESIGN §6.3): a recursive destroy walks every
        // descendant and snapshot (thousands, in user space) — 30 min.
        const result = await executor.exec(ZFS, args, recursive ? { timeoutMs: 1_800_000 } : undefined)
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
        return { destroyed: fullName, ...(ctx.newAdvisories.length > 0 ? { warnings: ctx.newAdvisories } : {}) }
      }),
      // Story cr.33: the job starts only when it holds the dataset's keys.
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })

  // --- Snapshot sub-resource handlers (Epic 5) ---------------------------
  // All reached via the dataset `*` wildcard; the tail is parsed by
  // resolveSnapshotTail. Full ZFS snapshot name is `<dataset>@<snap>`.

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

    // Story cr.37: the one guard spec both doors run — the dataset exists (a
    // recursive snapshot over an unreadable pool list is refused, pvepool.1
    // review fix 4), PVE ownership (a storage-root snapshot sweeps PVE's guest
    // zvols; a guest volume's snapshots are PVE's to take), with `recursive`
    // every descendant (a storage registered on a NESTED path), and the name
    // is free. The job runs them again before `zfs snapshot`.
    const spec = snapshotGuardSpec(poolName, fullName, snapName, recursive === true)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'zfs.snapshot',
      { ...identity, params: { snapshot: snapName, recursive: recursive ?? false } },
      guarded(spec, pre, async () => {
        // The ONE zfs-snapshot verb (backup2.3's extraction) — same argv, same
        // error text, one definition shared with the schedules service and the
        // backup runner.
        await createZfsSnapshot(executor, { dataset: fullName, name, recursive: recursive === true })
        return { created: snapName }
      }),
      { locks: pre.locks },
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

    // Story cr.37: the snapshot exists and its dataset is not PVE's
    // (pvepool.1: an OWNED dataset's snapshots are PVE's to manage) — at the
    // route and again in the job before `zfs rename`.
    const spec = snapshotOwnedSpec('zfs.rename', fullName, snap)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'zfs.rename',
      { ...identity, params: { from, to } },
      guarded(spec, pre, async () => {
        const result = await executor.exec(ZFS, ['rename', '--', from, to])
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs rename exited with code ${result.exitCode}`)
        return { renamed: from, to }
      }),
      { locks: pre.locks },
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

    // Story cr.37: the snapshot exists and its dataset is not PVE's
    // (pvepool.1: a guest volume's snapshots are PVE's to destroy, and a
    // storage root's are taken and kept by PVE itself) — at the route and
    // again in the job before `zfs destroy`.
    const spec = snapshotOwnedSpec('zfs.destroy', fullName, snap)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // Plain 202 — destroying a snapshot removes a recovery point, not live data,
    // so no confirmation gate (DESIGN safety semantics).
    const job = jobQueue.submit(
      'zfs.destroy',
      { ...identity, params: { snapshot: snapName } },
      guarded(spec, pre, async () => {
        await destroyZfsSnapshot(executor, { dataset: fullName, name: snapParsed.data })
        return { destroyed: snapName }
      }),
      { locks: pre.locks },
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
    // `?force=true` maps to `zfs rollback -r`: it also destroys every snapshot
    // and bookmark newer than the target. Story cr.37: normalised by the one
    // lenient schema (absent ≡ `false`) and BOUND into the confirm below — the
    // confirm window re-challenges in place when the box is ticked (cr.44).
    const { force } = RollbackSnapshotQuery.parse(request.query ?? {})

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story cr.37: the one guard spec both doors run — the snapshot exists,
    // PVE ownership (pvepool.1: a rollback rewrites PVE's data in place, the
    // most damaging snapshot verb here) and the LUN gate for a volume and for
    // an image file inside a filesystem (iscsi.3 + iscsi.6) — all before the
    // confirm is minted, and again in the job before `zfs rollback`.
    const spec = rollbackGuardSpec(fullName, snap, force)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // Snapshots newer than the target block a plain rollback; ZFS needs `-r`
    // (force) to destroy them. The listing is newest-first, so "newer" are the
    // ones ahead of the target in the list.
    const snapshots = pre.object.snapshots
    const laterSnapshots = snapshots.slice(0, snapshots.findIndex(s => s.name === snapName)).map(s => s.snapshotName)

    const warnings = [
      `Rolling back discards all changes to '${fullName}' since snapshot '${snap}'.`,
    ]
    if (force) {
      // What is bound is what was shown (WAVE3-DESIGN §5.2 rule 2): the
      // snapshots AND bookmarks `-r` destroys, by name — the force twin of the
      // pool destroy's "Disks to wipe".
      const destroys = pre.bound.scope?.destroys ?? ''
      const count = destroys ? destroys.split(', ').length : 0
      warnings.push(count > 0
        ? `Force destroys the ${count} snapshot(s) and bookmark(s) newer than '${snap}' — irreversible.`
        : `Force destroys nothing here: no snapshot or bookmark is newer than '${snap}'.`)
      if (count > 0)
        warnings.push(`Destroyed by force: ${destroys}.`)
    }
    else if (laterSnapshots.length > 0) {
      warnings.push(`${laterSnapshots.length} more recent snapshot(s) exist (${laterSnapshots.join(', ')}); rollback requires force to destroy them, and doing so is irreversible.`)
    }
    // The LIO-unreadable disclosure (D3, P1) — the same warning destroy shows.
    warnings.push(...pre.advisories.map(a => a.warning))

    // Story cr.37 (M3): the code signs the whole validated request — `force`
    // included — plus the target snapshot's createtxg and the newest one's
    // (ident.1: a snapshot taken after this challenge is IDENTITY_MISMATCH)
    // and, with force, what it destroys (a bookmark made since is
    // CONFIRM_SCOPE_CHANGED). A resend with the other `force` is
    // CONFIRM_SCOPE_CHANGED naming the flag.
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { snapshot: snapName, force },
      address: ['snapshot'],
      presentationOnly: SNAPSHOT_ROLLBACK_PRESENTATION_ONLY,
      message: `Rolling back '${fullName}' to snapshot '${snap}' discards newer data`,
      warnings,
    })) {
      return reply
    }

    const args = force ? ['rollback', '-r', '--', snapName] : ['rollback', '--', snapName]

    const job = jobQueue.submit(
      'zfs.rollback',
      { ...identity, params: { snapshot: snapName, force, ...pre.bound.id } },
      // Ruling (j): the same snapshot (both createtxgs), the same set force
      // destroys, PVE ownership and the LUN gate, read again now — a LUN
      // created on the volume while the job waited refuses it here.
      guarded(spec, pre, async (_snap, ctx) => {
        const result = await executor.exec(ZFS, args)
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs rollback exited with code ${result.exitCode}`)
        return { rolledBack: snapName, ...(ctx.newAdvisories.length > 0 ? { warnings: ctx.newAdvisories } : {}) }
      }),
      { locks: pre.locks },
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

    // Story cr.37: the one guard spec both doors run — the source snapshot
    // exists and its dataset is not PVE's (a clone out of PVE's snapshot tree
    // is PVE's to make); clone is a dataset create wearing another hat, so the
    // target name is free (409), passes the naming guard and is not owned
    // (pvepool.1). The job runs them again before `zfs clone`.
    const spec = cloneGuardSpec(fullName, snap, target)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // Plain 202 — creating a new dataset from a snapshot is not destructive, so
    // no confirmation gate (it never touches existing data).
    const job = jobQueue.submit(
      'zfs.clone',
      { ...identity, params: { snapshot: snapName, target } },
      guarded(spec, pre, async () => {
        const result = await executor.exec(ZFS, ['clone', '--', snapName, target])
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs clone exited with code ${result.exitCode}`)
        return { cloned: snapName, target }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  }
}
