import type { AhrPool, AhrRepairFile, IscsiHeldByLun } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { Advisory, Gate, GuardReads, GuardSpec, ObjectView, Refusal } from '../safety/guard.js'
import type { AhrLayoutDisk } from '../services/ahr-layout.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import type { IscsiPaths } from '../services/iscsi.js'
import { relative, resolve as resolvePath } from 'node:path'
import { AhrCreateRequest, AhrMirrorReconcileRequest, AhrMountpointRequest, AhrParityRewriteRequest, AhrRepairRequest, isComposableDisk, PoolName } from '@anas/shared'
import { currentLane } from '../executor/deadline.js'
import { parseFindmnt, readFindmntTable } from '../parsers/findmnt.js'
import { hasMount, parseFstab } from '../parsers/fstab.js'
import { parseVgsReport, VGS_ARGS } from '../parsers/lvm-report.js'
import { ahrnameClaim, diskClaim, guardCheck, guardConfirm, guarded, mountClaim, sendRefusal } from '../safety/guard.js'
import { changeAhrMountpoint, createAhrPool, remountAhrPool } from '../services/ahr-create.js'
import { destroyAhrPool } from '../services/ahr-destroy.js'
import { ahrGuard, ahrPoolHeldByLun } from '../services/ahr-guard.js'
import { ahrNameOccupancy, isIntentStaleForPool } from '../services/ahr-identity.js'
import { defaultAhrIntentDir, readIntent } from '../services/ahr-intent.js'
import { AhrPlanError, fmtBytes, MIXED_SECTOR_WARNING_PREFIX, planFreshLayout } from '../services/ahr-layout.js'
import { mirrorReconcileArray, mirrorReconcileArrayRefusal, mirrorReconcileEvidence, mirrorReconcileWarnings, reconcileMirrorBand } from '../services/ahr-mirror-reconcile.js'
import { parityRewriteArray, parityRewriteArrayRefusal, parityRewriteEvidence, parityRewriteWarnings, rewriteBandParity } from '../services/ahr-parity-rewrite.js'
import { ahrLvPath } from '../services/ahr-paths.js'
import { repairAhrFiles } from '../services/ahr-repair.js'
import { attributeScrub, pathExists, runningAhrCheck, scrubAhrPool } from '../services/ahr-scrub.js'
import { topLevelMountPath } from '../services/ahr-snapshots.js'
import { AHR_FINDMNT_ARGS } from '../services/ahr-topology.js'
import { readConfig } from '../services/config-writer.js'
import { heldByLun, lioUnreadableAdvisory } from '../services/iscsi-held.js'
import { kernelInfo } from '../services/kernel-version.js'
import { mountTargetGate, mountTargetRefusal, normalizeMountpointPath } from '../services/mounts.js'
import { poolReferenceKey, poolReferenceWarning, poolUnreadableWarning, readPoolReferences } from '../services/pool-references.js'
import { mdSysPath, readMdAttrOrNull } from '../services/selfheal-io.js'
import { readMdGeometry } from '../services/selfheal-map.js'
import { collectDisks } from './disks.js'
import { requireIdentity } from './identity.js'

const FINDMNT = '/usr/bin/findmnt'
const REALPATH = '/usr/bin/realpath'
const VGS = '/usr/sbin/vgs'

const TRAILING_SLASHES_RE = /\/+$/

/**
 * The fields each short AHR verb's confirm leaves out of its signature (story
 * cr.38, WAVE3-DESIGN §5.2 rule 1): none — every field of the validated
 * request is signed. A test lists them, so adding one is a visible diff.
 */
export const AHR_CREATE_PRESENTATION_ONLY: Record<string, string> = {}
export const AHR_MOUNTPOINT_PRESENTATION_ONLY: Record<string, string> = {}
export const AHR_REMOUNT_PRESENTATION_ONLY: Record<string, string> = {}
export const AHR_DESTROY_PRESENTATION_ONLY: Record<string, string> = {}
/** cr.38 session B: the long verbs' confirms sign their whole request too. */
export const AHR_REPAIR_PRESENTATION_ONLY: Record<string, string> = {}
export const AHR_PARITY_REWRITE_PRESENTATION_ONLY: Record<string, string> = {}
export const AHR_MIRROR_RECONCILE_PRESENTATION_ONLY: Record<string, string> = {}

// The LUN-held helpers live in ./ahr-guard.ts since cr.38 (the guard's LUN
// gate is their caller too); re-exported so existing importers keep working.
export { ahrHeldByLunConflict, ahrPoolHeldByLun } from '../services/ahr-guard.js'

/**
 * The parity-rewrite confirm gate's LUN disclosure (seventh pass, F10), or no
 * line at all when nothing is served from the pool.
 *
 * A rewrite writes no file byte, so this is not a refusal — it is the fact an
 * operator being asked to agree to hours of whole-band reading cannot discover
 * from anywhere else on this screen.
 */
export function rewriteLunWarnings(held: IscsiHeldByLun | null): string[] {
  if (!held)
    return []
  const sessions = held.connectedInitiators.length
  return [
    `A guest's disk is live on this pool: iSCSI LUN ${held.index} ('${held.name}') of target ${held.targetIqn} is served from ${held.backingPath}${
      sessions > 0
        ? `, with ${sessions} initiator${sessions === 1 ? '' : 's'} logged in right now (${held.connectedInitiators.join(', ')}). Nothing this run writes is visible to them. It reads every member of the band twice and rewrites parity, and it writes no file. The array will be reading flat out underneath that disk for the duration`
        : '. No initiator is logged in right now. Nothing this run writes is visible to a guest. It reads every member of the band twice and rewrites parity, and it writes no file'}`,
  ]
}

/**
 * The mirror-reconcile confirm gate's LUN disclosure (story selfheal.11).
 *
 * Disclosed, never refused — and for a different reason than the rewrite's. A
 * reconcile DOES write file bytes, but every row it writes already matches the
 * checksum btrfs stored for it, so nothing a guest can read changes: the row it
 * would have been served either way is the row that goes down. What the
 * operator cannot discover anywhere else on this screen is that both legs will
 * be read flat out underneath a live guest disk for the duration.
 */
export function reconcileLunWarnings(held: IscsiHeldByLun | null): string[] {
  if (!held)
    return []
  const sessions = held.connectedInitiators.length
  return [
    `A guest's disk is live on this pool: iSCSI LUN ${held.index} ('${held.name}') of target ${held.targetIqn} is served from ${held.backingPath}${
      sessions > 0
        ? `, with ${sessions} initiator${sessions === 1 ? '' : 's'} logged in right now (${held.connectedInitiators.join(', ')}). Every row this run writes already matches the checksum btrfs stored for it, so what the guest reads does not change. The array will be reading both legs flat out underneath that disk for the duration`
        : '. No initiator is logged in right now. Every row this run writes already matches the checksum btrfs stored for it, so what a guest reads does not change'}`,
  ]
}

/**
 * The repair route's LUN-session refusal (seventh pass, F10).
 *
 * A repair writes 4 KiB it has PROVEN correct, and the CoW ruling says the old
 * extent is harmless — so this is not the "corrupt what the initiator sees"
 * hazard `heldByLunRefusal` exists for. What it is is a write into a file a
 * guest has open at the block layer: the initiator's own cache still holds the
 * old bytes, its filesystem is mid-transaction, and nothing about the repair is
 * visible to it. So the refusal is scoped to a LIVE SESSION and says what to do
 * about it, rather than refusing every LUN-backed file forever.
 */
export function lunSessionRefusal(path: string, held: IscsiHeldByLun) {
  return {
    error: {
      code: 'CONFLICT',
      reason: 'lun-session-active',
      message: `'${path}' backs iSCSI LUN ${held.targetIqn}/${held.index} ('${held.name}') and `
        + `${held.connectedInitiators.length} initiator${held.connectedInitiators.length === 1 ? ' is' : 's are'} `
        + `logged in right now (${held.connectedInitiators.join(', ')}). A repair writes a reconstructed `
        + `4 KiB block through md under that live session: the block itself is proven correct and btrfs's `
        + `copy-on-write leaves the old extent untouched, but the initiator keeps its own cache of the file, `
        + `and the change is invisible to it. Log the initiator out of LUN ${held.index} (or stop the `
        + `guest using it), then repair. This refusal has no confirm bypass.`,
    },
  }
}

/**
 * Why a pool in this state cannot be repaired (story selfheal.6).
 *
 * A repair reconstructs one block from every OTHER member of its stripe and
 * writes it back through md. That is sound only on an array that is complete
 * and still — a missing member has nothing to reconstruct from, and a resync,
 * recovery, reshape or check is moving or re-reading the very bytes the chain
 * computed. The engine refuses all of these too; the route says it first, and
 * says it in the pool's own vocabulary.
 */
const REPAIR_REFUSED_STATES: Record<string, string> = {
  degraded: 'is degraded: a reconstruction needs every other member of the stripe',
  building: 'is still building: the initial sync is writing the parity this repair would read',
  rebuilding: 'is rebuilding: a recovery is writing the members this repair would read',
  expanding: 'is expanding: the layout under the block is changing mid-reshape',
  scrubbing: 'is scrubbing: a check re-reads every stripe, including this one',
  offline: 'is offline: the volume is not assembled, so there is nothing to repair',
  failed: 'has failed: there is no array left to reconstruct from',
  readonly: 'is read-only: a repair writes the reconstructed block back through md',
}

/**
 * Job operations that must not overlap on the same pool.
 *
 * The parity rewrite (selfheal.10) joined the pair: it runs a full btrfs scrub
 * and then TWO whole-band md operations, so it fights a scrub for md's sync
 * thread and a repair for the array it is writing parity across. The mirror
 * reconcile (selfheal.11) joined it for the same reasons and one more — arm B
 * reads every row of both legs while arm A scrubs the pool, so it collides with
 * every other verb at both layers. The exclusion is mutual in every direction:
 * this one list is what all four ask.
 */
const REPAIR_EXCLUSIVE_OPERATIONS = ['ahr.scrub', 'ahr.repair', 'ahr.parity-rewrite', 'ahr.mirror-reconcile'] as const

/** What to call each of them in a refusal, in the operator's words. */
const EXCLUSIVE_OPERATION_NAMES: Record<string, string> = {
  'ahr.scrub': 'a scrub',
  'ahr.repair': 'a repair',
  'ahr.parity-rewrite': 'a parity rewrite',
  'ahr.mirror-reconcile': 'a mirror reconcile',
}

/**
 * The node-wide md-check refusal, in one sentence for all three verbs
 * (sixth pass, N10).
 *
 * The job-queue exclusion above is IN-PROCESS: a check md is still running
 * from a previous daemon, or one mdcheck's timer started, is invisible to it.
 * /proc/mdstat is not, and the check is on a BAND — often a band whose disks
 * another pool shares. A scrub would issue a second check beside it (§4), a
 * repair's bounded check would fight it for the same sync thread, and a parity
 * rewrite would hand md a whole-band `repair` on an array md is already busy
 * re-reading. Only the scrub route used to ask; all three do now.
 */
function runningAhrCheckMessage(label: string): string {
  return `an md check is running on ${label} (started outside this job or by a previous daemon). ANAS runs one parity check at a time across the node's AHR bands, and this operation reads or writes the very stripes that check is re-reading. Wait for it to finish, or end it from the command line`
}

// ---- Repair path confinement (design review 2026-09-14, D12) ---------------
//
// The lexical check (resolvePath + relative) keeps a path STRING under the
// mountpoint string, and nothing more. A symlink inside the tree, or a bind
// mount laid over part of it, passes the string test while pointing somewhere
// else entirely — and this verb writes reconstructed bytes THROUGH md at
// wherever the path really resolves. So the route resolves the path on the
// filesystem (`realpath -e`), re-runs the containment check on the canonical
// form, and then asks findmnt WHICH filesystem the path sits on: it must be
// the pool's own LV, not a mount that happens to live inside the tree.

/** `realpath -e` — the canonical path, or null when it does not resolve. */
export async function repairRealPath(executor: CommandExecutor, path: string): Promise<string | null> {
  try {
    const r = await executor.exec(REALPATH, ['-e', path])
    const out = r.exitCode === 0 ? r.stdout.trim() : ''
    return out === '' ? null : out
  }
  catch {
    return null
  }
}

/**
 * `findmnt -T <path>` — the SOURCE device of the filesystem holding the path.
 *
 * `--nofsroot` is load-bearing on an AHR pool (sixth pass, N2). Without it
 * findmnt appends the filesystem root in brackets for a btrfs subvolume mount —
 * `/dev/mapper/ahr0-ahr0--vol[/@data]` — and every §12 pool mounts `subvol=@data`,
 * so `realpath` of that string fails and the repair route 400s on EVERY file of
 * EVERY subvol-layout pool.
 */
export function repairFindmntArgs(path: string): string[] {
  return ['-n', '-o', 'SOURCE', '--nofsroot', '--real', '-T', path]
}

/** `/dev/x[/@data]` → `/dev/x` — the fs-root suffix, belt to `--nofsroot`'s braces. */
const FINDMNT_FSROOT_RE = /\[[^\]]*\]$/

export async function repairMountSource(executor: CommandExecutor, path: string): Promise<string | null> {
  try {
    const r = await executor.exec(FINDMNT, repairFindmntArgs(path))
    const out = r.exitCode === 0 ? r.stdout.trim() : ''
    if (out === '')
      return null
    // The flag above is the fix; this is the second line of defence, because a
    // findmnt that ignored the flag would silently take every repair down.
    const source = out.split('\n')[0].trim().replace(FINDMNT_FSROOT_RE, '')
    return source === '' ? null : source
  }
  catch {
    return null
  }
}

// ---- Per-block cost, for the confirm gate (design review 2026-09-14, D13) ---

/** mdadm's default chunk — AHR create passes no `--chunk` flag. */
export const AHR_MDADM_DEFAULT_CHUNK_BYTES = 512 * 1024
/** The engine's stripe window on a RAID1 band (selfheal-repair `windowSectors`). */
export const AHR_RAID1_WINDOW_BYTES = 64 * 1024
/** Stripes swept either side of the target by the engine's stripe-cache evict. */
const EVICT_SPAN = 200
/** A device path's `/dev/` prefix, when resolving to a kernel name. */
const DEV_PREFIX_RE = /^\/dev\//

/** A band array's chunk in bytes, read live from sysfs; null when unreadable. */
async function arrayChunkBytes(executor: CommandExecutor, device: string): Promise<number | null> {
  try {
    const rp = await executor.exec(REALPATH, [device])
    const kernel = rp.exitCode === 0 ? rp.stdout.trim().replace(DEV_PREFIX_RE, '') : ''
    if (kernel === '')
      return null
    const raw = await readMdAttrOrNull(mdSysPath(kernel), 'chunk_size')
    const bytes = Number.parseInt(raw ?? '', 10)
    return Number.isFinite(bytes) && bytes > 0 ? bytes : null
  }
  catch {
    return null
  }
}

/**
 * The O_DIRECT read volume of ONE bounded check's stripe-cache sweep, in MiB
 * (D13) — the engine sweeps ±{@link EVICT_SPAN} stripes of one chunk each
 * around every block it repairs, twice per block (pre-check and post-check).
 * The pool's LARGEST chunk is the honest worst case; a band that cannot be
 * read falls back to mdadm's own default, which is what the pool was created
 * with absent a `--chunk` flag.
 */
export async function perBlockSweepMiB(executor: CommandExecutor, pool: AhrPool): Promise<number> {
  let largest = 0
  for (const array of pool.arrays) {
    const bytes = array.level === 'raid1'
      ? AHR_RAID1_WINDOW_BYTES
      : (await arrayChunkBytes(executor, array.device)) ?? AHR_MDADM_DEFAULT_CHUNK_BYTES
    largest = Math.max(largest, bytes)
  }
  if (largest === 0)
    largest = AHR_MDADM_DEFAULT_CHUNK_BYTES
  return Math.max(1, Math.round(EVICT_SPAN * 2 * largest / (1024 * 1024)))
}

export interface AhrMutationRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  confirmStore: ConfirmStore
  diskIdentityCache: DiskIdentityCache
  /** /etc/fstab location (config IS the API). Override via ANAS_FSTAB_PATH. */
  fstabPath: string
  /**
   * smb.conf path (story cr.24) — the AHR destroy confirm reads it to name SMB
   * shares that reference the pool. Absent ⇒ the SMB-share kind is not checked.
   */
  smbConfPath?: string
  /**
   * /etc/exports path (story cr.24). Absent ⇒ the NFS-export kind is not checked.
   */
  exportsPath?: string
  /**
   * The systemd unit-store dir (story cr.24) — backup/cloud/replication tasks
   * and schedules that reference the pool. Absent ⇒ these kinds are not checked.
   */
  systemdDir?: string
  /** mdadm.conf override (else ANAS_MDADM_CONF / the Debian default). */
  mdadmConfPath?: string
  /** Pool mount-base override (else ANAS_AHR_MOUNT_BASE / /mnt/anas-ahr). */
  mountBase?: string
  /** Scrub poll interval override (tests). */
  scrubPollIntervalMs?: number
  /**
   * Kernel release override (tests) — the mixed-LBS gate reads the RUNNING
   * kernel, which a test cannot change. Production always omits it.
   */
  kernelRelease?: string
  /**
   * iSCSI read-layer path overrides (story iscsi.6) — Destroy and Change mount
   * refuse while a LUN's image file lives on the pool. Real host paths by
   * default; overridable so a test never reads the kernel.
   */
  iscsiPaths?: IscsiPaths
  /**
   * AhrExpansionIntent store directory (else ANAS_AHR_INTENT_DIR /
   * /etc/anas/ahr). Destroy refuses while an intent is running and clears it
   * with the pool; create clears an orphan left under the new name (ident.3).
   */
  intentDir?: string
}

/**
 * Every AHR job operation (story ident.3 (d)). Destroy refuses while ANY of
 * them is queued or running on the pool: a scrub, a spare add, an expansion or
 * a snapshot that is dequeued after the pool is gone acts on whatever carries
 * the name by then. Each family names its pool under `name` or `pool`.
 */
const AHR_JOB_OPERATIONS = [
  'ahr.create',
  'ahr.destroy',
  'ahr.mountpoint',
  'ahr.remount',
  'ahr.scrub',
  'ahr.repair',
  'ahr.parity-rewrite',
  'ahr.mirror-reconcile',
  'ahr.expand',
  'ahr.expand.resume',
  'ahr.expand.abandon',
  'ahr.replace',
  'ahr.readd',
  'ahr.spare.add',
  'ahr.spare.remove',
  'ahr.cache.attach',
  'ahr.cache.detach',
  'ahr.snapshot.create',
  'ahr.snapshot.delete',
  'ahr.snapshot.rollback',
] as const

/**
 * AHR mutation layer (Epic 11 + AHR, docs/AHR-DESIGN.md §4) — the CREATE /
 * DESTROY / SCRUB third of /v1/ahr:
 *
 *   POST   /v1/ahr              — create pool (wipes disks; 409 confirm)
 *   DELETE /v1/ahr/:name        — destroy pool (409 confirm)
 *   POST   /v1/ahr/:name/scrub  — btrfs scrub then md checks (202, no confirm)
 *   POST   /v1/ahr/:name/repair — repair named blocks from parity (409 confirm)
 *   POST   /v1/ahr/:name/parity-rewrite — rewrite ONE band's parity (409 confirm)
 *   POST   /v1/ahr/:name/mirror-reconcile — reconcile ONE mirror band (409 confirm)
 *
 * All mutations are jobs (202). The expansion verbs (expand/plan/resume/
 * abandon/replace) live separately in routes/ahr-expand.ts. Reads live in
 * routes/ahr.ts.
 */
export async function ahrMutationRoutes(server: FastifyInstance, opts: AhrMutationRouteOptions) {
  const { executor, jobQueue, confirmStore, diskIdentityCache, fstabPath, mdadmConfPath, mountBase, kernelRelease, smbConfPath, exportsPath, systemdDir } = opts
  const iscsiPaths = opts.iscsiPaths ?? {}
  const intentDir = opts.intentDir ?? defaultAhrIntentDir()

  /**
   * An AHR pool's CONFIGURED mountpoint (cr.57 (f)): the target of the pool's
   * OWN /etc/fstab line — the persistence line whose spec is the pool's volume
   * (`services/ahr-fstab.ts`'s `ahrFstabEntry`, the same spec destroyAhrPool
   * matches). A reference is the CONFIGURATION, not the mount: an unmounted
   * pool still owns its configured path — destroying it invalidates a share
   * served from there even though nothing is mounted now. `undefined` when
   * fstab cannot be read or names no such line: the configured path is then
   * simply not knowable, and only the name-matched kinds stay in scope.
   */
  async function ahrConfiguredMountpoint(poolName: string): Promise<string | undefined> {
    if (!fstabPath)
      return undefined
    const fstabText = await readConfig(fstabPath)
    for (const entry of parseFstab(fstabText)) {
      if (entry.spec === ahrLvPath(poolName) && entry.mountpoint.startsWith('/'))
        return entry.mountpoint
    }
    return undefined
  }

  /**
   * The ONE "what references this pool" answer (story cr.24). The AHR pool owns
   * its `@data` path and is matched by name for replication/snapshot/scrub
   * references. When the pool is UNMOUNTED the topology's `mountpoint` is its
   * LV device path — but its CONFIGURED mountpoint (the target of its own
   * fstab line, cr.57 (f)) is still a path its storage is served from, so it
   * is a reference path too: an unmounted pool is never "owns no path" while
   * its configured path exists. The pool's own fstab line at that path is the
   * pool itself, never a "mount beneath this pool" (cr.31 D3).
   */
  async function ahrPoolReferences(pool: { name: string, mountpoint: string }) {
    const mountedPath = pool.mountpoint.startsWith('/dev/')
      ? [await ahrConfiguredMountpoint(pool.name)].filter((p): p is string => p !== undefined)
      : [pool.mountpoint]
    return readPoolReferences({
      executor,
      pool: pool.name,
      paths: mountedPath,
      ownMounts: { mountpoints: mountedPath },
      ...(smbConfPath ? { smbConfPath } : {}),
      ...(exportsPath ? { exportsPath } : {}),
      ...(systemdDir ? { systemdDir } : {}),
      ...(fstabPath ? { fstabPath } : {}),
    })
  }

  /**
   * A scrub or a repair already in flight on this pool, or null.
   *
   * There is no per-pool AHR mutation lock in the daemon — the one piece of
   * serialization AHR has is `withTopLevelMount`, which covers the §12 snapshot
   * mount and nothing else. So the two full-array verbs refuse each other AND
   * themselves at SUBMIT through the job queue's own record: a scrub started
   * mid-repair would re-read every stripe while the engine has md's
   * `rmw_level`, `sync_min`/`sync_max` and `stripe_cache_size` turned aside; a
   * repair started mid-scrub would fight the check for the same knobs; and two
   * scrubs of one pool would run `mdadm --action=check` over each other's
   * bands, which §4 exists to prevent.
   *
   * The query is `findActive` — non-terminal jobs only. `findByOperation`
   * answers with the LATEST job of an operation whatever its status, so one
   * finished scrub submitted after a running one made the running one invisible
   * and the exclusion silently stopped holding.
   *
   * The queue is in memory, so after a daemon restart this honestly answers
   * "nothing in flight" — the engine's own gates (`sync_action` not idle) are
   * the backstop, and no shadow state is introduced to paper over it.
   */
  function conflictingAhrJob(name: string, selfJobId?: string): { operation: string, id: string } | null {
    // `selfJobId` is the caller's OWN job (cr.38: the gate re-runs inside the
    // job): only a job submitted BEFORE it counts. A run that counted itself
    // would refuse every time, and one that counted a newer job — submitted
    // after it passed its route, through the same race — would refuse a run
    // the newer job's own re-check is about to refuse.
    const job = jobQueue.findActive(REPAIR_EXCLUSIVE_OPERATIONS, name, 'name', undefined, selfJobId ? { before: selfJobId } : {})
    return job ? { operation: job.operation, id: job.id } : null
  }

  /** Parse + validate a pool-name param, or 400 and return null. */
  function parsePoolName(raw: string, reply: FastifyReply): string | null {
    const parsed = PoolName.safeParse(raw)
    if (!parsed.success) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${parsed.error.issues[0]?.message}` } })
      return null
    }
    return parsed.data
  }

  // -------------------------------------------------------------------------
  // The short verbs' guard specs (story cr.38 session A, WAVE3-DESIGN §2.3,
  // §3, ruling (j)). Create, mountpoint, remount and destroy each run ONE
  // gate list at the route and again in the job against facts the job reads
  // itself, and every job holds its lock keys (cr.33, §4.2) before it
  // re-reads. What a confirm binds to the pool is the band arrays, plus the VG
  // UUID when `vgs` reports one; what the job locks is `ahr:<vg uuid>` while
  // that UUID is known and the `ahrname:<name>` lock alone when it is
  // unreadable — and always the name key for create and destroy, plus the
  // disks a verb writes and the path a verb mounts at.
  // -------------------------------------------------------------------------

  const guard = ahrGuard({ executor, intentDir, iscsiPaths: () => iscsiPaths, jobQueue })

  /** `/etc/fstab`, once per guard run (the mountpoint gates of create and move share it). */
  const fstabOnce = (reads: GuardReads) => reads.once('fstab', () => readConfig(fstabPath))

  /**
   * The MOUNTPOINT-COLLISION gates (§2.6, at both doors since cr.38): `mp` is
   * not a live mountpoint and not claimed in fstab. The live table goes
   * through cr.60's STRICT reader (cr.64b2 (k)) — an unreadable table refuses
   * 503 UNAVAILABLE naming the read, never "no collision" from a read that
   * could not see (a failed findmnt must not hand the mountpoint to a create
   * or move); the job asks again, so an fstab line added while the job waited
   * refuses before the wipe or the unmount instead of after it.
   */
  function mountpointCollisionGates<O>(mp: string): Gate<O>[] {
    return [
      async (_o, reads) => {
        const table = await reads.once('ahr-mount-collision', () => readFindmntTable(executor, AHR_FINDMNT_ARGS))
        if (table === null)
          return { status: 503, code: 'UNAVAILABLE', message: `ANAS could not read the kernel mount table (findmnt), so it cannot check whether '${mp}' is already a mountpoint — nothing was done` }
        return parseFindmnt(table).some(m => m.target === mp)
          ? { status: 409, code: 'CONFLICT', message: `'${mp}' is already a mountpoint. Pick an unused path` }
          : null
      },
      async (_o, reads) => hasMount(await fstabOnce(reads), mp)
        ? { status: 409, code: 'CONFLICT', message: `'${mp}' is already claimed in fstab. Pick an unused path` }
        : null,
    ]
  }

  /** A pool that does not exist yet, with the disks it would be built on as the inventory reads them now. */
  interface NewAhrPool {
    name: string
    /** The requested disks that are composable now, in the request's order. */
    selected: (AhrLayoutDisk & { model: string | null })[]
    /** One sentence per requested disk that is not (empty: all eligible). */
    problems: string[]
  }

  /** The fresh layout for a selection, or the 400 that says why it cannot be built. */
  function planCreate(o: NewAhrPool, tier: AhrCreateRequest['tier']): { layout: ReturnType<typeof planFreshLayout> } | { refusal: Refusal } {
    let layout: ReturnType<typeof planFreshLayout>
    try {
      // kernelInfo() gates mixed logical block sizes: below the md floor the
      // planner THROWS and lands as a 400 — before any confirm code is
      // minted, and long before a disk is touched (§4).
      layout = planFreshLayout(o.selected, tier, kernelInfo(kernelRelease))
    }
    catch (err) {
      if (err instanceof AhrPlanError)
        return { refusal: { status: 400, code: 'VALIDATION_ERROR', message: err.message } }
      throw err
    }
    if (!layout.minDisksMet || layout.capacity.usableBytes === 0)
      return { refusal: { status: 400, code: 'VALIDATION_ERROR', message: layout.warnings[0] ?? 'The disk selection cannot form a protected pool' } }
    return { layout }
  }

  /**
   * The create's guard spec (cr.38: "create binds disks, tier and
   * mountpoint"). The name is the object (nothing else exists yet); its read
   * resolves every requested disk against the live inventory, so the gate that
   * judges the selection and the job body that wipes it see the same answer,
   * and the body never wipes a disk only the route read. Gates, in the route's
   * order: the name is free (pool, VG, occupancy), the mountpoint is free, every
   * disk is composable, the layout is buildable.
   */
  function createSpec(req: { name: string, tier: AhrCreateRequest['tier'], disks: string[], mountpoint?: string }): GuardSpec<NewAhrPool> {
    return {
      operation: 'ahr.create',
      object: {
        what: `AHR pool '${req.name}'`,
        read: async (reads) => {
          // Resolve every disk against the live inventory — only status
          // 'available' is eligible (GT-12: these exclusions are
          // safety-critical, not cosmetic). logicalSectorSize rides along: a
          // mixed 4Kn/512e selection gives the bands differing logical block
          // sizes, which the LVM stack must be told to accept (issue #8).
          const inventory = await reads.once('inventory', () => collectDisks(executor, diskIdentityCache))
          const problems: string[] = []
          const selected: NewAhrPool['selected'] = []
          for (const id of req.disks) {
            const disk = inventory.find(d => d.id === id)
            if (!disk) {
              problems.push(`disk '${id}' not found`)
              continue
            }
            if (!isComposableDisk(disk)) {
              problems.push(disk.handsOff
                ? `disk '${id}' is hands-off: ${disk.handsOffReason ?? disk.handsOff}`
                : `disk '${id}' is not available (status: ${disk.status}${disk.poolName ? `, pool '${disk.poolName}'` : ''})`)
              continue
            }
            selected.push({ id: disk.id, usableBytes: disk.size, logicalSectorSize: disk.logicalSectorSize, model: disk.model })
          }
          return { name: req.name, selected, problems }
        },
        id: async o => ({ name: o.name }),
        unbound: () => `Could not bind the create of AHR pool '${req.name}'`,
      },
      gates: [
        // cr.52 (review H1): the create's mountpoint runs the one shared
        // system-path refusal (like every door that sets one) — at the route
        // and again in the job, before a single disk is wiped.
        mountTargetGate<NewAhrPool>(req.mountpoint),
        // Name collision: one AHR pool per name (also the VG name).
        async (o, reads) => (await guard.reads.pools(reads)).some(p => p.name === o.name)
          ? { status: 409, code: 'CONFLICT', message: `AHR pool '${o.name}' already exists` }
          : null,
        // VG-name collision: the pool name becomes the LVM VG name, and
        // `vgcreate` runs only AFTER the disks are wiped — so naming a pool
        // after an existing VG (e.g. 'pve', the PVE root VG) would pass
        // confirm, wipe disks, then die at vgcreate leaving an orphaned
        // half-stack. Fail CLOSED when vgs cannot be read (code review H6):
        // 503 is the file's idiom for "cannot read state the operation
        // depends on".
        async (o, reads) => {
          const vgsRes = await reads.once('vgs', () => executor.exec(VGS, VGS_ARGS))
          if (vgsRes.exitCode !== 0)
            return { status: 503, code: 'UNAVAILABLE', message: `cannot read LVM volume groups (vgs: ${vgsRes.stderr.trim().split('\n')[0] || 'no stderr'}) — refusing to create a pool whose VG name could not be checked against the existing volume groups` }
          return parseVgsReport(vgsRes.stdout).some(v => v.name === o.name)
            ? { status: 409, code: 'CONFLICT', message: `an LVM volume group named '${o.name}' already exists. The pool name becomes its VG name, so vgcreate would fail after the disks were wiped. Choose another name` }
            : null
        },
        // Name occupancy (story ident.3, identity audit #4): a live md array
        // named `<name>-r<N>` (anyone's), an mdadm.conf pin, or a partition
        // labelled for the name would make the new pool's identity ambiguous
        // from its first minute.
        async (o) => {
          const occupied = await ahrNameOccupancy(executor, o.name, { mdadmConfPath })
          return occupied.length > 0
            ? { status: 409, code: 'CONFLICT', message: `the name '${o.name}' is already in use on this node: ${occupied.join('; ')}. Choose another name` }
            : null
        },
        // The mountpoint override (§2.6) must not shadow or fight anything
        // that exists — at the route and again right before the wipe.
        ...(req.mountpoint !== undefined ? mountpointCollisionGates<NewAhrPool>(req.mountpoint) : []),
        async o => o.problems.length > 0
          ? { status: 400, code: 'VALIDATION_ERROR', message: `Ineligible disk selection: ${o.problems.join('; ')}` }
          : null,
        // The layout is buildable (the same §2.1 math the create job runs).
        async (o) => {
          const planned = planCreate(o, req.tier)
          return 'refusal' in planned ? planned.refusal : null
        },
      ],
      locks: async () => {
        const disks = [...new Set(req.disks)]
        disks.sort()
        return [
          ahrnameClaim(req.name),
          ...(req.mountpoint !== undefined ? [mountClaim(normalizeMountpointPath(req.mountpoint))] : []),
          ...disks.map(id => diskClaim(id)),
        ]
      },
    }
  }

  // --- POST /ahr — create pool (WIPES the selected disks) -------------------
  server.post('/ahr', async (request, reply) => {
    const parsed = AhrCreateRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create request: ${parsed.error.issues[0]?.message}` } }
    }
    const req = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Request-only (WAVE3-DESIGN §3.2: about the value typed, not the node):
    // normalised here; /mnt/pve and / answer through the create's shared
    // refusal gate (cr.52r doc ruling — ONE 409, reason system-mount-target).
    let mountpoint: string | undefined
    if (req.mountpoint !== undefined) {
      mountpoint = req.mountpoint.replace(TRAILING_SLASHES_RE, '') || '/'
    }

    const spec = createSpec({ name: req.name, tier: req.tier, disks: req.disks, mountpoint })
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const planned = planCreate(pre.object, req.tier)
    if ('refusal' in planned)
      return sendRefusal(reply, planned.refusal)

    // Confirm gate (Principle 14): the CONCRETE consequence — every disk that
    // will be wiped, by id + model + size. Story cr.38: the code signs the
    // whole validated request — the name, the tier, the disks and the
    // mountpoint — so a resend that picks other disks, another tier or
    // another path answers 409 CONFIRM_SCOPE_CHANGED instead of wiping disks
    // the operator never saw listed.
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { name: req.name, tier: req.tier, disks: req.disks, mountpoint: mountpoint ?? null },
      address: ['name'],
      presentationOnly: AHR_CREATE_PRESENTATION_ONLY,
      message: `Creating AHR pool '${req.name}' will WIPE ${pre.object.selected.length} disk(s). All data on them will be permanently erased`,
      warnings: [
        ...pre.object.selected.map(d => `${d.id} (${d.model ?? 'unknown model'}, ${fmtBytes(d.usableBytes)}) will be completely erased`),
        // Geometry advisories the planner raised — the mixed 4Kn/512e label
        // (issue #8) belongs in front of the operator BEFORE the wipe, not as a
        // post-wipe job failure. Only the sector-geometry one is confirm-worthy.
        ...planned.layout.warnings.filter(w => w.startsWith(MIXED_SECTOR_WARNING_PREFIX)),
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.create',
      { ...identity, params: { name: req.name, tier: req.tier, disks: req.disks, mountpoint: mountpoint ?? null } },
      guarded(spec, pre, async (fresh, { updateProgress }) => createAhrPool(
        executor,
        // The disks as the job's own inventory read resolved them (sizes and
        // sector geometry read now, never the route's).
        { name: req.name, tier: req.tier, disks: fresh.selected, mountpoint },
        updateProgress,
        // diskCache: the job re-checks every disk is STILL available before
        // the first wipe (ident.3 (a)); intentDir: an orphan intent under the
        // new name is cleared before anything is built (ident.3 (d)).
        { fstabPath, mdadmConfPath, mountBase, diskCache: diskIdentityCache, intentDir },
      )),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  // --- PUT /ahr/:name/mountpoint — the one mutable pool identity -------------
  server.put<{ Params: { name: string } }>('/ahr/:name/mountpoint', async (request, reply) => {
    const name = parsePoolName(request.params.name, reply)
    if (!name)
      return

    const parsed = AhrMountpointRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid mountpoint request: ${parsed.error.issues[0]?.message}` } }
    }
    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Request-only (about the value typed): normalised here; /mnt/pve and /
    // answer through the move's shared refusal gate (cr.52r doc ruling — ONE
    // 409, reason system-mount-target, PVE-territory sentence for /mnt/pve).
    const mp = parsed.data.mountpoint.replace(TRAILING_SLASHES_RE, '') || '/'

    // Story cr.38 (§2.3 "mountpoint": every gate was request-time only, and
    // there was no system-pool gate). One gate list at both doors: not
    // already this pool's mountpoint, the target free (live mount, fstab), the
    // system-pool hard 409 (cr.23 — the move unmounts the pool), and the
    // LUN-held hard 409 (iscsi.6 — the move pulls an image file out from
    // under a live LIO backstore). The job holds the pool's key and the target
    // path's `mount:` key.
    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.mountpoint',
      object: guard.poolView(name, 'a mountpoint change'),
      gates: [
        async pool => mp === pool.mountpoint
          ? { status: 400, code: 'VALIDATION_ERROR', message: `'${mp}' is already this pool's mountpoint` }
          : null,
        // cr.52 (review H1): the one shared system-path refusal on the move's
        // TARGET, re-run in the job under the pool's key.
        mountTargetGate<AhrPool>(mp),
        ...mountpointCollisionGates<AhrPool>(mp),
        guard.systemPoolGate,
        guard.lunGate('Changing', pool => `the mountpoint of AHR pool '${pool.name}'`),
      ],
      // D3, cr.38r: the LUN gate just FAILED OPEN on a broken claims read —
      // nothing held, exactly what a node genuinely serving a LUN would look
      // like. Warn, never refuse; the job reports any the confirm did not list.
      advisories: async (_pool, reads) => lioUnreadableAdvisory(await guard.reads.claims(reads), 'pool'),
      locks: async (pool, bound) => guard.claims(pool, bound, 'exclusive', { extra: [mountClaim(normalizeMountpointPath(mp))] }),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const pool = pre.object

    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { name, mountpoint: mp },
      address: ['name'],
      presentationOnly: AHR_MOUNTPOINT_PRESENTATION_ONLY,
      message: `Moving pool '${name}' from '${pool.mountpoint}' to '${mp}' briefly unmounts it`,
      warnings: [
        `Anything serving from '${pool.mountpoint}' (shares, backups, mounts) stops working until re-pointed at '${mp}'`,
        pool.mounted ? 'The filesystem is unmounted during the move. Open files will block it (retry after closing them)' : 'The pool is currently unmounted. Only fstab is rewritten, then the filesystem mounts at the new path',
        // D3: the LIO-unreadable disclosure rides the confirm warnings too.
        ...pre.advisories.map(a => a.warning),
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.mountpoint',
      { ...identity, params: { name, mountpoint: mp } },
      // The pool as the job read it: its mountpoint and mount state NOW, never
      // the route's (an unmount between the two is not the job's to undo).
      guarded(spec, pre, async (live, { updateProgress, newAdvisories }) => {
        const result = await changeAhrMountpoint(
          executor,
          { name: live.name, mountpoint: live.mountpoint, mounted: live.mounted, subvolLayout: live.subvolLayout },
          mp,
          updateProgress,
          { fstabPath },
        )
        // D3 (cr.38r): the job re-read the advisories under its lock — a
        // claims read that broke since the confirm rides the result (destroy
        // and repair already do).
        return newAdvisories.length > 0
          ? { ...result, warnings: [...((result as { warnings?: string[] }).warnings ?? []), ...newAdvisories] }
          : result
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /ahr/:name/remount — the read-only aftermath ---------------------
  /**
   * Bring a btrfs-forced-readonly pool back read-write (story ahrcache.1
   * slice 2, AHR-DESIGN §13 "Resolved 2026-09-24").
   *
   * The aftermath the automatic uncache CANNOT fix. `lvconvert --uncache`
   * restores reads in the same second with the cache device gone (GT-20), but
   * if the pool took a WRITE during the failure window, the I/O error aborted a
   * btrfs metadata transaction and btrfs set a flag that survives the repair:
   * `mount -o remount,rw` is refused ("remounting read-write after error is not
   * allowed"), and only umount + mount restores writes.
   *
   * That is why this is an OPERATOR verb and not a fourth line in the recovery
   * job: an unmount breaks every open handle on the filesystem — SMB and NFS
   * clients, a backup mid-run, a job reading a file — and a machine does not get
   * to decide that on someone's behalf. The confirm gate says exactly that.
   *
   * Four gates, at the route and again in the job (cr.38), cheapest first:
   *  - not mounted read-only ⇒ 409. There is nothing to remount, and running an
   *    unmount/mount cycle "just in case" would cost the handles for nothing.
   *  - the read cache is still FAILED ⇒ 409. Every read on the pool returns EIO
   *    while the dead cache is in front of it (GT-19), so a remount would land
   *    a filesystem that cannot serve a byte and btrfs would force it read-only
   *    again on the first error. Uncache first — the message says so.
   *  - a system pool ⇒ hard 409 (cr.23: the unmount pulls whatever the pool
   *    holds at a system path away from the running node).
   *  - a LUN holds the pool ⇒ hard 409, no confirm bypass. The unmount pulls the
   *    image file out from under a live LIO backstore, which is the same rule
   *    destroy and change-mount already apply (iscsi.6).
   */
  server.post<{ Params: { name: string } }>('/ahr/:name/remount', async (request, reply) => {
    const name = parsePoolName(request.params.name, reply)
    if (!name)
      return

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.remount',
      object: guard.poolView(name, 'a remount'),
      gates: [
        async pool => !pool.mountedReadOnly
          ? {
              status: 409,
              code: 'CONFLICT',
              message: pool.mounted
                ? `AHR pool '${pool.name}' is mounted read-write — there is nothing to remount. Remount exists to clear a btrfs forced-readonly filesystem, which is what an I/O error leaves behind`
                : `AHR pool '${pool.name}' is not mounted, so there is nothing to remount. Bring the pool online first — see the Hybrid RAID view`,
            }
          : null,
        // The dead cache must go FIRST. Remounting over it lands a filesystem
        // that returns EIO on every read, and btrfs forces it read-only again
        // on the first error — the operator would have broken every open
        // handle to arrive exactly where they started.
        async pool => pool.cache?.state === 'failed'
          ? {
              status: 409,
              code: 'CONFLICT',
              message: `AHR pool '${pool.name}' still has a FAILED read cache in front of its volume: every read returns an I/O error until the cache is removed, `
                + `and a remount would be forced read-only again by the first one. Detach the cache first (no data is lost — a writethrough cache holds no only copy), then Remount`,
            }
          : null,
        guard.systemPoolGate,
        guard.lunGate('Remounting'),
        // cr.52r P2: this verb MOUNTS the stored path again, so the STORED
        // path runs the mount-target refusal before the unmount/mount — a path
        // that has since resolved into a protected tree refuses here, at the
        // route and again in the job.
        async pool => mountTargetRefusal(pool.mountpoint),
      ],
      // D3, cr.38r: the LUN gate above FAILED OPEN on a broken claims read —
      // warn, never refuse; the job reports any the confirm did not list.
      advisories: async (_pool, reads) => lioUnreadableAdvisory(await guard.reads.claims(reads), 'pool'),
      locks: async (pool, bound) => guard.claims(pool, bound, 'exclusive'),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { name },
      address: ['name'],
      presentationOnly: AHR_REMOUNT_PRESENTATION_ONLY,
      message: `Remounting pool '${name}' unmounts and mounts its filesystem`,
      warnings: [
        `Open share handles break: '${pre.object.mountpoint}' is unmounted and mounted again, and anything holding a file open on it — SMB and NFS clients, a backup mid-run, a running job — loses it`,
        'This is the only way back: btrfs refuses `mount -o remount,rw` after an I/O error, so a plain remount cannot clear the read-only flag',
        'Fix the cause first if you have not: a pool that is read-only again after this has an error it is still meeting',
        // D3: the LIO-unreadable disclosure rides the confirm warnings too.
        ...pre.advisories.map(a => a.warning),
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.remount',
      { ...identity, params: { name } },
      guarded(spec, pre, async (live, { updateProgress, newAdvisories }) => {
        const result = await remountAhrPool(executor, { name: live.name, mountpoint: live.mountpoint, subvolLayout: live.subvolLayout }, updateProgress)
        // D3 (cr.38r): a claims read that broke since the confirm rides the
        // result (the remount's own post-mount check may fail first — the
        // advisory is dropped then, as the report of the run's outcome must).
        return newAdvisories.length > 0
          ? { ...result, warnings: [...((result as { warnings?: string[] }).warnings ?? []), ...newAdvisories] }
          : result
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  /**
   * Destroy's own gate beside the shared ones: an expansion being DRIVEN
   * right now (story ident.3 (d)) — a running reshape is mid-flight on these
   * very arrays. This pool's intent only: a stale one (an earlier namesake's)
   * refuses nothing. An unreadable intent file reads as none, as it always
   * has: the destroy clears the intent with the pool, and refusing over a
   * corrupt file would leave the pool undestroyable.
   */
  const runningIntentGate: Gate<AhrPool> = async (pool) => {
    const liveIntent = await readIntent(pool.name, intentDir).catch(() => null)
    return liveIntent?.state === 'running' && !isIntentStaleForPool(liveIntent, pool)
      ? { status: 409, code: 'CONFLICT', message: `AHR pool '${pool.name}' has an expansion being driven right now. Wait for it to finish or halt before destroying the pool` }
      : null
  }

  /**
   * What still references the pool (story cr.24) as the guard's advisories:
   * one per reference and per unreadable source, plus the LIO-unreadable
   * disclosure (D3: a broken claims read fail-opens to "nothing held", which
   * a node genuinely serving a LUN would look exactly like). Warn, never
   * refuse; the job reports any the confirm did not list.
   */
  async function destroyAdvisories(pool: AhrPool, reads: GuardReads): Promise<Advisory[]> {
    const read = await ahrPoolReferences(pool)
    const advisories: Advisory[] = [...(await lioUnreadableAdvisory(await guard.reads.claims(reads), 'pool'))]
    // ident.3 (deliberate): the running-intent gate reads a corrupt intent file
    // as "no expansion" so the pool stays destroyable — refusing over it would
    // leave the pool undestroyable. Deliberate is not silent: disclosed here,
    // listed at the confirm and (through the job's re-read) on the result.
    try {
      await readIntent(pool.name, intentDir)
    }
    catch {
      advisories.push({
        key: 'intent-unreadable',
        warning: `The expansion-intent file for AHR pool '${pool.name}' could not be read — it is treated as no expansion so the destroy is not blocked, and it is removed with the pool`,
      })
    }
    advisories.push(
      ...read.refs.map(ref => ({ key: `ref:${poolReferenceKey(ref)}`, warning: poolReferenceWarning(ref) })),
      ...read.unreadableSources.map(src => ({ key: `unreadable:${src.kind}`, warning: poolUnreadableWarning(src, pool.name) })),
    )
    return advisories
  }

  // --- DELETE /ahr/:name — destroy pool --------------------------------------
  server.delete<{ Params: { name: string } }>('/ahr/:name', async (request, reply) => {
    const name = parsePoolName(request.params.name, reply)
    if (!name)
      return

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story cr.38 (§2.3 "destroy": in-flight, intent, system pool and LUN-held
    // were request-time only). ONE gate list at both doors, every gate a hard
    // 409 with no confirm bypass:
    //  - nothing may still be working on the pool (ident.3 (d)): a queued or
    //    running AHR job would be dequeued against whatever carries the name
    //    once this pool is gone;
    //  - no expansion is being driven;
    //  - not a system pool (cr.23: the live mount table is an AHR pool's whole
    //    answer; an unreadable table is a system pool);
    //  - no LUN's image file lives on the pool (iscsi.6: every array,
    //    partition and byte goes, including the file LIO is serving).
    // The confirm is bound to the pool's IDENTITY (its array UUIDs and VG
    // UUID, identity audit P1), and the job holds the pool's key, its name key
    // and every disk it wipes. cr.31/31b's "gate before any act" and the
    // fail-closed `lvs` stay inside `destroyAhrPool`, after these.
    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.destroy',
      object: guard.poolView(name, 'a destroy'),
      gates: [
        guard.inFlightGate(AHR_JOB_OPERATIONS),
        runningIntentGate,
        guard.systemPoolGate,
        guard.lunGate('Destroying'),
      ],
      advisories: destroyAdvisories,
      locks: async (pool, bound) => guard.claims(pool, bound, 'exclusive', { namespace: true, disks: pool.disks.map(d => d.id) }),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const pool = pre.object

    // Consumers under the mountpoint (submounts — shares/backups serving from
    // the pool stop with it). findmnt is the live truth.
    // An UNMOUNTED pool's `mountpoint` is its LV device path (the topology's
    // honest "where the filesystem lives"), so it is never named as a place
    // that will be unmounted (cr.31 D3): the job drops the fstab line that
    // names the volume, and that is what the sentence says.
    const warnings = [
      `Pool '${name}' (${fmtBytes(pool.capacity.usableBytes)} usable) will be permanently destroyed. Every array, partition, and all data is erased`,
      pool.mounted
        ? `The filesystem at '${pool.mountpoint}' will be unmounted: anything serving from it (shares, backups, mounts) stops working`
        : `The pool's filesystem is not mounted. An /etc/fstab line for its volume '${ahrLvPath(name)}' is removed with the pool`,
    ]
    const findmntRes = await executor.exec(FINDMNT, AHR_FINDMNT_ARGS)
    if (findmntRes.exitCode === 0) {
      for (const m of parseFindmnt(findmntRes.stdout)) {
        if (m.target.startsWith(`${pool.mountpoint}/`))
          warnings.push(`'${m.target}' (${m.fstype}) is mounted beneath the pool and will lose its filesystem`)
      }
    }

    // The read cache goes WITH the pool (ahrcache.1 §13): destroy releases it
    // and wipes its slice, so the flash comes back as an available disk. Said
    // at the confirm door because the cache disks are not the disks the
    // operator picked when they built the pool, and nothing else on this
    // screen names them.
    if (pool.cache && pool.cache.state !== 'absent' && pool.cache.devices.length > 0) {
      warnings.push(`The read cache on ${pool.cache.devices.join(', ')} is removed with the pool: the ${fmtBytes(pool.cache.sizeBytes)} slice is wiped and the disk comes back available`)
    }

    // Fail-open is not fail-silent (D3), and story cr.24: name what STILL
    // references the pool — warn, never refuse (the guard's advisories). What
    // the confirm listed is what the job compares against when it re-reads.
    warnings.push(...pre.advisories.map(a => a.warning))

    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { name },
      address: ['name'],
      presentationOnly: AHR_DESTROY_PRESENTATION_ONLY,
      message: `Destroying AHR pool '${name}' erases all of its data`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.destroy',
      { ...identity, params: { name } },
      guarded(spec, pre, async (live, { updateProgress, newAdvisories }) => {
        // The guard re-read the pool (same identity), re-ran every gate and
        // re-read the references before this line; references the confirm did
        // not list ride the RESULT (cr.24 ruling (j): never a failed job).
        const result = await destroyAhrPool(executor, live, updateProgress, { fstabPath, mdadmConfPath, intentDir })
        if (newAdvisories.length > 0)
          return { ...result, warnings: [...(result.warnings ?? []), ...newAdvisories] }
        return result
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  // -------------------------------------------------------------------------
  // The long verbs' shared gates (story cr.38 session B, WAVE3-DESIGN §2.3
  // rows "scrub", "repair", "parity rewrite / mirror reconcile"; ruling (j)).
  // Each is ONE function the route runs and the job runs again — when it
  // starts, and (parity rewrite, mirror reconcile) before every md act.
  // -------------------------------------------------------------------------

  /**
   * The in-process half of the four verbs' mutual exclusion, as a gate. At the
   * route every family job in flight on the pool refuses (as it always did);
   * in the job only one submitted BEFORE it does: a job never counts itself,
   * and two requests that both passed the route before either was submitted
   * do not refuse each other — the older runs, the newer is refused by its own
   * re-check.
   */
  function familyConflictGate(sentence: (active: { operation: string, id: string }) => string, reason?: string): Gate<AhrPool> {
    return async (pool) => {
      const active = conflictingAhrJob(pool.name, currentLane().jobId)
      return active ? { status: 409, code: 'CONFLICT', ...(reason ? { reason } : {}), message: sentence(active) } : null
    }
  }

  /** The node-wide half (N10): an md check no ANAS job of this daemon issued. */
  function foreignCheckGate(reason?: string): Gate<AhrPool> {
    return async (_pool, reads) => {
      const foreign = await runningAhrCheck(executor, await guard.reads.pools(reads))
      return foreign ? { status: 409, code: 'CONFLICT', ...(reason ? { reason } : {}), message: runningAhrCheckMessage(foreign.label) } : null
    }
  }

  /** The pool-state roll-up the three writing verbs refuse on (`REPAIR_REFUSED_STATES`). */
  function refusedStateGate(tail: string, reason?: string): Gate<AhrPool> {
    return async (pool) => {
      const stateRefusal = REPAIR_REFUSED_STATES[pool.state]
      return stateRefusal ? { status: 409, code: 'CONFLICT', ...(reason ? { reason } : {}), message: `AHR pool '${pool.name}' ${stateRefusal}. ${tail}` } : null
    }
  }

  /**
   * A band verb's object (parity rewrite, mirror reconcile): the pool bound
   * to its identity PLUS the band's own md array UUID (§3.3 "AHR band"), so a
   * code minted for band r1 of this pool is no code for a band r1 that is
   * another array, and a job that waited finds the array it was confirmed for
   * or refuses IDENTITY_MISMATCH.
   */
  function bandView(name: string, band: number, noun: string): ObjectView<AhrPool> {
    const base = guard.poolView(name, noun)
    return {
      ...base,
      id: async (pool, reads) => {
        const id = await base.id(pool, reads)
        const array = pool.arrays.find(a => a.band === band)
        return id && array ? { ...id, band: array.uuid ?? `unknown:${band}` } : null
      },
      unbound: part => part === 'id' ? `Could not read the identity of band r${band} of AHR pool '${name}' — refusing ${noun} that cannot be bound to it` : base.unbound(part),
    }
  }

  // --- POST /ahr/:name/scrub — btrfs scrub then md checks (no confirm) --------
  //
  // Story cr.38 session B (§2.3 "scrub": the job re-ran neither the job
  // conflict nor the node-wide check). One gate list at both doors; the job
  // holds the pool's key SHARED (§4.2) for the whole run — never given back
  // around its polls: the scrub job IS the driver of each band's check and of
  // the btrfs pass, and the verbs a shared key keeps out (mountpoint, remount,
  // rollback, destroy, an expansion step) are exactly the ones that must not
  // cycle or reshape the pool under it. The long lane leaves a slot for short
  // verbs.
  server.post<{ Params: { name: string } }>('/ahr/:name/scrub', async (request, reply) => {
    const name = parsePoolName(request.params.name, reply)
    if (!name)
      return

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.scrub',
      object: guard.poolView(name, 'a scrub'),
      gates: [
        // Unreachable before busy (issue #18): a scrub reads every byte
        // through the btrfs filesystem and then checks each band array, and an
        // offline pool has neither — the volume is not assembled. "is offline"
        // names the condition where "is not mounted" only describes a symptom.
        async pool => pool.state === 'offline'
          ? { status: 409, code: 'CONFLICT', message: `AHR pool '${pool.name}' is offline: the volume is not assembled, so there is nothing to scrub. See the Hybrid RAID view for which band arrays cannot start` }
          : null,
        // Never concurrent (§4): a scrub and a resync/reshape are all
        // full-device passes — refuse while one is already running.
        async pool => (pool.state === 'scrubbing' || pool.state === 'building' || pool.state === 'rebuilding' || pool.state === 'expanding')
          ? { status: 409, code: 'CONFLICT', message: `AHR pool '${pool.name}' is ${pool.state}: a scrub would thrash the running operation. Wait for it to finish` }
          : null,
        async pool => pool.mountpoint.startsWith('/dev/')
          ? { status: 409, code: 'CONFLICT', message: `AHR pool '${pool.name}' is not mounted: btrfs scrub needs the filesystem online` }
          : null,
        // The other half of the selfheal.6 pair: a scrub cannot start
        // mid-repair — the engine has md's knobs turned aside for the duration
        // of each block and a check would re-read every stripe underneath it —
        // and it cannot start on top of another scrub either, which would run a
        // second `--action=check` over the same bands (§4: never concurrent).
        familyConflictGate(active => active.operation === 'ahr.scrub'
          ? `a scrub is already in flight on AHR pool '${name}' (job ${active.id}). Wait for it to finish`
          : `${EXCLUSIVE_OPERATION_NAMES[active.operation] ?? 'another job'} job is in flight on AHR pool '${name}' (job ${active.id}). Wait for it to finish`),
        // Both refusals above are IN-PROCESS: the pool state a topology read
        // reports, and the job queue's own record. Neither survives a daemon
        // restart — md's check on band r1 keeps running while the job that
        // issued it is gone (S6). /proc/mdstat still knows, so it is read once
        // and matched against EVERY AHR band on the node: another pool's bands
        // are very often the same disks.
        foreignCheckGate(),
      ],
      locks: async (pool, bound) => guard.claims(pool, bound, 'shared'),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'ahr.scrub',
      { ...identity, params: { name } },
      guarded(spec, pre, async (live, ctx) => scrubAhrPool(executor, live, ctx.updateProgress, { pollIntervalMs: opts.scrubPollIntervalMs })),
      { locks: pre.locks, lane: 'long' },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /ahr/:name/repair — repair named blocks from parity (409 confirm) -
  //
  // Story selfheal.6. The request is EXPLICIT — the files and the 4 KiB blocks
  // the operator picked out of a scrub's findings — because this writes through
  // md, and what it writes over is named by the caller and nobody else. Never
  // automatic, never a read-path heal: those two boundaries are the epic's.
  //
  // Story cr.38 session B (§2.3 "repair": the job re-ran none of the job
  // conflict, the running check, the path confinement or the LUN session).
  // The object is the pool PLUS the request's files resolved against it now
  // (`confineRepairFiles`); one gate list at both doors; the confirm signs the
  // request and binds the canonical selection as the revision, so a path that
  // resolves elsewhere by the time the job runs (a symlink swapped in) fails
  // STATE_CHANGED and nothing is written. The pool's key is held shared for
  // the run (§4.2 "repair block").
  server.post<{ Params: { name: string } }>('/ahr/:name/repair', async (request, reply) => {
    const name = parsePoolName(request.params.name, reply)
    if (!name)
      return

    const parsed = AhrRepairRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid repair request: ${parsed.error.issues[0]?.message}. Repair takes absolute paths under the pool's mountpoint, each with at least one 4 KiB block. Findings inside a snapshot (@snapshots/…) are filesystem-relative and cannot be repaired` } }
    }
    const requested = parsed.data.files

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    type RepairObject = AhrPool & { repair: { files: AhrRepairFile[] } | { refusal: Refusal } | null }
    const view = guard.poolView(name, 'a repair')
    const spec: GuardSpec<RepairObject> = {
      operation: 'ahr.repair',
      object: {
        ...view,
        read: async (reads) => {
          const pool = await view.read(reads)
          if (!pool)
            return null
          const mounted = pool.mounted && !pool.mountpoint.startsWith('/dev/')
          return { ...pool, repair: mounted ? await confineRepairFiles(pool, requested) : null }
        },
        revision: async o => o.repair && 'files' in o.repair ? JSON.stringify(o.repair.files) : null,
        unbound: part => part === 'revision'
          ? `Could not resolve the files of this repair on AHR pool '${name}' — refusing a repair that cannot be bound to them`
          : view.unbound(part),
      },
      gates: [
        async pool => (!pool.mounted || pool.mountpoint.startsWith('/dev/'))
          ? { status: 409, code: 'CONFLICT', message: `AHR pool '${pool.name}' is not mounted: a repair resolves the block through the live filesystem` }
          : null,
        // Hard refusals, all of them BEFORE a confirm code is minted
        // (Principle 14, "unsafe now" has no bypass).
        refusedStateGate('Repair when the pool is healthy and idle'),
        familyConflictGate(active => `${active.operation === 'ahr.repair' ? 'another repair' : EXCLUSIVE_OPERATION_NAMES[active.operation] ?? 'another job'} is in flight on AHR pool '${name}' (job ${active.id}). Wait for it to finish`),
        // The node-wide half of the same exclusion (N10): a check from a
        // previous daemon, or one mdcheck's timer started, survives the job
        // queue's memory.
        foreignCheckGate(),
        // A backup (or any snapshot verb) holding the pool's on-demand
        // top-level mount is the same refusal the engine makes at its gates —
        // said here, at the door, rather than after the operator confirmed.
        async (pool) => {
          if (!pool.subvolLayout)
            return null
          const top = topLevelMountPath(pool)
          return (await executor.exec(FINDMNT, ['--mountpoint', top])).exitCode === 0
            ? { status: 409, code: 'CONFLICT', message: `the top-level mount for AHR pool '${pool.name}' is already held at ${top}. A backup or snapshot job is in flight, and the repair needs that mount to take its own read-only snapshot. Retry when the other job has finished` }
            : null
        },
        // Confinement (D12): every path a live file under the pool's tree,
        // resolved on the filesystem, on the pool's own LV.
        async pool => pool.repair && 'refusal' in pool.repair ? pool.repair.refusal : null,
        // LUN awareness (seventh pass, F10): a file that backs a LUN with a
        // LIVE initiator session is refused — in the same tier as every other
        // "unsafe now". ONE claims read per run, shared across every file and
        // with the advisory below.
        async (pool, reads) => {
          if (!pool.repair || !('files' in pool.repair))
            return null
          const claims = await guard.reads.claims(reads)
          for (const file of pool.repair.files) {
            const held = await heldByLun(claims, { path: file.path })
            if (held && held.connectedInitiators.length > 0) {
              const { error } = lunSessionRefusal(file.path, held)
              return { status: 409, code: 'CONFLICT', reason: error.reason, message: error.message }
            }
          }
          return null
        },
      ],
      // Fail-open is not fail-silent (D3): a broken claims read reads as
      // "nothing held", which a node genuinely serving a LUN would look
      // exactly like — and repair then writes reconstructed data through md
      // over a file a live session may be holding. The gate above refuses the
      // session case; this discloses the case the read could not see. Warn,
      // never refuse; the job reports any the confirm did not list.
      advisories: async (_pool, reads) => lioUnreadableAdvisory(await guard.reads.claims(reads), 'pool'),
      locks: async (pool, bound) => guard.claims(pool, bound, 'shared'),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const pool = pre.object
    const files = (pool.repair as { files: AhrRepairFile[] }).files
    const blocks = files.reduce((n, f) => n + f.blocks.length, 0)

    // Confirm gate: what actually happens to the array, in the operator's terms.
    // The signature carries the exact selection (and the canonical form is
    // bound as the revision), so a confirm code cannot be replayed against a
    // different set of files or blocks — the files ADDRESS the repair.
    //
    // The per-block cost is stated CONCRETELY (design review 2026-09-14, D13):
    // the engine drops the node's page cache twice per block (probe + cold
    // read), sweeps ~400 stripes of chunk-sized O_DIRECT reads twice per
    // block to evict md's stripe cache, and holds the stripe cache at its
    // floor (17) for the whole run — on a busy node all of that is felt.
    const sweepMiB = await perBlockSweepMiB(executor, pool)
    const striped = pool.arrays.some(a => a.level !== 'raid1')
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { name, files: requested },
      address: ['name', 'files'],
      presentationOnly: AHR_REPAIR_PRESENTATION_ONLY,
      message: `Repairing ${blocks} block(s) in ${files.length} file(s) on AHR pool '${name}' writes reconstructed data through md`,
      warnings: [
        'A read-only snapshot of the file\'s subvolume is taken for the duration and removed afterwards',
        `md's rmw_level, sync_min, sync_max and stripe_cache_size on the pool's array(s) are changed for the duration and restored afterwards`,
        'One 4 KiB block per finding is written THROUGH md. The write happens only after the reconstruction from the other members matches the checksum btrfs stored for it',
        `Per block: two node-wide page-cache drops (drop_caches), two ~${sweepMiB} MiB read sweeps over the array${striped ? ', and the band\'s stripe cache held at its floor for the duration' : ''}. A busy node will feel it. Bring latency-sensitive workloads down first`,
        'Nothing else on the array is touched: no other file, and no parity rewrite beyond the stripes these blocks live in',
        'A block that cannot be proven is left untouched. It is reported as unrepairable, or as corruption that arrived above md',
        // Fail-open is not fail-silent (D3): the LIO-unreadable advisory when
        // the claims read the gate just used could not run. Warn, never refuse.
        ...pre.advisories.map(a => a.warning),
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.repair',
      { ...identity, params: { name, files: files.map(f => f.path), blocks } },
      guarded(spec, pre, async (live, { updateProgress, newAdvisories }) => {
        const result = await repairAhrFiles(executor, live, (live.repair as { files: AhrRepairFile[] }).files, updateProgress)
        if (newAdvisories.length > 0)
          return { ...result, warnings: newAdvisories }
        return result
      }),
      { locks: pre.locks, lane: 'long' },
    )
    reply.code(202)
    return { job }
  })

  /**
   * The repair's path confinement (design review 2026-09-14, D12), ONE
   * function for both doors (cr.38): every requested path must be a live file
   * under the pool's mountpoint, resolved on the filesystem (`realpath -e` —
   * a symlink inside the tree passes the string test while pointing somewhere
   * else), contained on the canonical form, on the pool's OWN LV (a bind mount
   * laid over part of the tree is not pool data). The two ways a scrub finding
   * fails that are exactly the two flags it carries: `outsideMount` (a block
   * inside `@snapshots/…`) and `missing` (deleted since the scrub) — both
   * refused by name, never quietly skipped. Answers the canonical selection,
   * each file's blocks deduplicated and ascending (the same block twice would
   * run the whole sequence twice), or the refusal.
   */
  async function confineRepairFiles(pool: AhrPool, requested: AhrRepairFile[]): Promise<{ files: AhrRepairFile[] } | { refusal: Refusal }> {
    const name = pool.name
    const lexicalRoot = resolvePath(pool.mountpoint)
    const root = await repairRealPath(executor, lexicalRoot)
    if (!root)
      return { refusal: { status: 409, code: 'CONFLICT', message: `the mountpoint '${pool.mountpoint}' of AHR pool '${name}' could not be resolved on the filesystem. Refusing to repair against an unresolvable root` } }
    const lvDevice = await repairRealPath(executor, ahrLvPath(pool.name))
    if (!lvDevice)
      return { refusal: { status: 409, code: 'CONFLICT', message: `the LV device '${ahrLvPath(pool.name)}' of AHR pool '${name}' could not be resolved. Refusing to repair against an unresolvable pool device` } }
    const files: AhrRepairFile[] = []
    for (const file of requested) {
      const abs = resolvePath(file.path)
      if (abs === lexicalRoot || relative(lexicalRoot, abs).startsWith('..'))
        return { refusal: { status: 400, code: 'VALIDATION_ERROR', message: `'${file.path}' is not a file under '${pool.mountpoint}'. Repair works on the live @data tree only. A finding outside the mounted tree (a snapshot) cannot be repaired` } }
      if (!(await pathExists(executor, abs)))
        return { refusal: { status: 409, code: 'CONFLICT', message: `'${file.path}' does not exist. The file was deleted since the scrub named it, and there is nothing to repair` } }
      const real = await repairRealPath(executor, abs)
      if (!real || real === root || relative(root, real).startsWith('..')) {
        return { refusal: { status: 400, code: 'VALIDATION_ERROR', message: real
          ? `'${file.path}' resolves to '${real}', which is not a file under '${pool.mountpoint}'. Repair works on the live @data tree only`
          : `'${file.path}' could not be resolved on the filesystem (realpath -e failed). A repair path must be a real file under '${pool.mountpoint}'` } }
      }
      const source = await repairMountSource(executor, real)
      const sourceReal = source ? await repairRealPath(executor, source) : null
      if (!source || !sourceReal)
        return { refusal: { status: 400, code: 'VALIDATION_ERROR', message: `the filesystem holding '${file.path}' could not be determined (findmnt failed). A repair is refused until the path's filesystem can be confirmed as the pool's own` } }
      if (sourceReal !== lvDevice)
        return { refusal: { status: 400, code: 'VALIDATION_ERROR', message: `'${file.path}' sits on ${sourceReal}, not on AHR pool '${name}'s own device (${lvDevice}). A mount inside the pool's tree is not pool data` } }
      const unique = [...new Set(file.blocks)]
      unique.sort((a, b) => a - b)
      files.push({ path: real, blocks: unique, ...(file.inode !== undefined ? { inode: file.inode } : {}) })
    }
    return { files }
  }

  /**
   * The band verbs' common gates (cr.38 session B), in the order the routes
   * have always refused in: the band exists (400, a request about a band the
   * pool does not have), the pool mounted, the proof (evidence), the state
   * roll-up, the in-process exclusion, the node-wide check, the band's own md
   * state read from md rather than from the pool rollup. Every one of them is
   * re-run when the job starts and again before every md act (§3.2: "parity
   * rewrite's … is this pattern; it becomes the helper's call").
   */
  function bandGates(args: {
    band: number
    evidence: () => { ok: true } | { ok: false, code: string, reason: string }
    mountedSentence: string
    stateTail: string
    conflictSentence: (active: { operation: string, id: string }) => string
    bandRefusal: (pool: AhrPool) => Promise<{ reason: string, code: string } | null>
  }): Gate<AhrPool>[] {
    return [
      async pool => pool.arrays.some(a => a.band === args.band)
        ? null
        : { status: 400, code: 'VALIDATION_ERROR', message: `AHR pool '${pool.name}' has no band r${args.band}: its bands are ${pool.arrays.map(a => `r${a.band}`).join(', ') || 'none'}` },
      async pool => (!pool.mounted || pool.mountpoint.startsWith('/dev/'))
        ? { status: 409, code: 'CONFLICT', reason: 'pool-not-mounted', message: args.mountedSentence.replace('{pool}', pool.name) }
        : null,
      async () => {
        const proof = args.evidence()
        return proof.ok ? null : { status: 409, code: 'CONFLICT', reason: proof.code, message: proof.reason }
      },
      refusedStateGate(args.stateTail, 'array-busy'),
      familyConflictGate(args.conflictSentence, 'job-active'),
      foreignCheckGate('array-busy'),
      async (pool) => {
        const refusal = await args.bandRefusal(pool)
        return refusal ? { status: 409, code: 'CONFLICT', reason: refusal.code, message: refusal.reason } : null
      },
    ]
  }

  // --- POST /ahr/:name/parity-rewrite — rewrite one band's parity (confirm) --
  //
  // Story selfheal.10. The ONE case where ANAS runs `mdadm --action=repair`:
  // md counted mismatches on this band and the checksum pass came back clean
  // across the pool, so the data is right and the parity is what is wrong. The
  // preconditions below are that proof, taken here and taken AGAIN inside the
  // job immediately before the md write — a band that lost a member in between
  // is a band this must not touch.
  //
  // Story cr.38 session B: those preconditions are the guard's gate list
  // (§2.3: the job never re-ran the running check or the state roll-up), the
  // confirm binds the band's array UUID, the job holds the pool's key shared,
  // gives it back while md repairs and checks, and re-guards before each.
  server.post<{ Params: { name: string } }>('/ahr/:name/parity-rewrite', async (request, reply) => {
    const name = parsePoolName(request.params.name, reply)
    if (!name)
      return

    const parsed = AhrParityRewriteRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid parity-rewrite request: ${parsed.error.issues[0]?.message}. The body names one band (\`{ "band": 1 }\`), because md repairs a whole array at a time` } }
    }
    const band = parsed.data.band

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // The proof may come from the pool's last completed SCRUB or from its last
    // completed REPAIR, whichever is newer (seventh pass, F2).
    const evidence = () => parityRewriteEvidence(name, [
      jobQueue.findLastCompleted('ahr.scrub', name),
      jobQueue.findLastCompleted('ahr.repair', name),
    ], band)
    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.parity-rewrite',
      object: bandView(name, band, 'a parity rewrite'),
      gates: bandGates({
        band,
        evidence,
        mountedSentence: `AHR pool '{pool}' is not mounted. The parity rewrite starts with a fresh btrfs scrub, which needs the filesystem online`,
        stateTail: 'Rewrite parity when the pool is healthy and idle',
        conflictSentence: active => `${EXCLUSIVE_OPERATION_NAMES[active.operation] ?? 'another job'} is in flight on AHR pool '${name}' (job ${active.id}). A parity rewrite reads every member of a band twice. Wait for it to finish`,
        // The band's own state, read from md rather than from the pool rollup:
        // a pool can read `healthy` while THIS array is mid-check. A RAID1
        // band is refused for good and not for now (N1).
        bandRefusal: async (pool) => {
          const array = parityRewriteArray(pool, band)!
          try {
            return await parityRewriteArrayRefusal(await readMdGeometry(executor, array.device))
          }
          catch (error) {
            return { reason: `band r${band} of AHR pool '${name}' (${array.device}) could not be read: ${error instanceof Error ? error.message : String(error)}`, code: 'array-busy' }
          }
        },
      }),
      locks: async (pool, bound) => guard.claims(pool, bound, 'shared'),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const pool = pre.object
    const array = parityRewriteArray(pool, band)!
    const proof = evidence() as { ok: true, mismatchCnt: number }
    // Is a guest's disk live on this pool (F10)? Disclosed, never refused.
    const rewriteHeld = await ahrPoolHeldByLun(executor, iscsiPaths, pool)

    // Confirm gate: what md is about to do, in the operator's terms. The
    // signature carries the band, and the bound identity its array UUID, so a
    // code minted for r1 cannot rewrite r2 — or another array numbered r1.
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { name, band },
      address: ['name', 'band'],
      presentationOnly: AHR_PARITY_REWRITE_PRESENTATION_ONLY,
      message: `Rewriting parity on band r${band} of AHR pool '${name}' recomputes that band's parity from the data it holds now (md counted ${proof.mismatchCnt} mismatch(es) there, and the pool's last checksum scrub was clean)`,
      // The estimate includes phase 1's full-pool checksum scrub (N8). The LUN
      // disclosure (seventh pass, F10) is a WARNING here and a refusal on
      // Repair, and the difference is what each verb writes.
      warnings: [...parityRewriteWarnings(name, array, pool.capacity.usedBytes), ...rewriteLunWarnings(rewriteHeld)],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.parity-rewrite',
      { ...identity, params: { name, band } },
      guarded(spec, pre, async (live, ctx) => rewriteBandParity(executor, live, band, {
        updateProgress: ctx.updateProgress,
        evidence,
        attributeFindings: async since => (await attributeScrub(executor, live, since, ctx.updateProgress)).findings ?? [],
        pollIntervalMs: opts.scrubPollIntervalMs,
        reguard: async () => {
          await ctx.reguard()
        },
        release: ctx.release,
      })),
      { locks: pre.locks, lane: 'long' },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /ahr/:name/mirror-reconcile — reconcile one mirror band ---------
  //
  // Story selfheal.11. The R9 root's verb: md counted DISAGREEING LEGS on a
  // RAID1 band and the checksum pass came back clean across the pool, so one
  // leg holds something btrfs has never been asked to read. Arm A repeats the
  // ordinary scrub (which heals the band through md when md serves the rotten
  // leg — GT-22); arm B reads both legs and arbitrates each differing row
  // against the checksum btrfs stored for it.
  //
  // md's own `repair` is NOT the fallback and never will be on a mirror: it
  // copies the first in-sync leg over the other without arbitrating. The
  // service refuses to spawn it at all (`assertNoMdRepair`).
  //
  // Story cr.38 session B: as the parity rewrite — one gate list at both
  // doors, the band's array UUID bound, the key shared, given back around each
  // md check, the gates re-run before each act.
  server.post<{ Params: { name: string } }>('/ahr/:name/mirror-reconcile', async (request, reply) => {
    const name = parsePoolName(request.params.name, reply)
    if (!name)
      return

    const parsed = AhrMirrorReconcileRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid mirror-reconcile request: ${parsed.error.issues[0]?.message}. The body names one band (\`{ "band": 2 }\`), because md counts disagreeing legs over a whole array and never says where` } }
    }
    const band = parsed.data.band

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // The proof may come from the pool's last completed SCRUB or from its last
    // completed REPAIR, whichever is newer — the same shortcut the parity
    // rewrite takes, and for the same reason.
    const evidence = () => mirrorReconcileEvidence(name, [
      jobQueue.findLastCompleted('ahr.scrub', name),
      jobQueue.findLastCompleted('ahr.repair', name),
    ], band)
    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.mirror-reconcile',
      object: bandView(name, band, 'a mirror reconcile'),
      gates: bandGates({
        band,
        evidence,
        mountedSentence: `AHR pool '{pool}' is not mounted. Arm A is a btrfs scrub and arm B reads the checksum tree, and both need the filesystem online`,
        stateTail: 'Reconcile a mirror when the pool is healthy and idle',
        conflictSentence: active => `${EXCLUSIVE_OPERATION_NAMES[active.operation] ?? 'another job'} is in flight on AHR pool '${name}' (job ${active.id}). A mirror reconcile scrubs the pool and reads every row of both legs. Wait for it to finish`,
        // The band's own state, read from md. A PARITY band is refused here
        // for good and not for now — it has a verb of its own.
        bandRefusal: async (pool) => {
          const array = mirrorReconcileArray(pool, band)!
          try {
            return await mirrorReconcileArrayRefusal(await readMdGeometry(executor, array.device))
          }
          catch (error) {
            return { reason: `band r${band} of AHR pool '${name}' (${array.device}) could not be read: ${error instanceof Error ? error.message : String(error)}`, code: 'array-busy' }
          }
        },
      }),
      locks: async (pool, bound) => guard.claims(pool, bound, 'shared'),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const pool = pre.object
    const array = mirrorReconcileArray(pool, band)!
    const proof = evidence() as { ok: true, mismatchCnt: number }
    // Is a guest's disk live on this pool? Disclosed, never refused: every row
    // this verb writes already matches its stored checksum, so nothing a guest
    // can read changes.
    const mirrorHeld = await ahrPoolHeldByLun(executor, iscsiPaths, pool)

    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { name, band },
      address: ['name', 'band'],
      presentationOnly: AHR_MIRROR_RECONCILE_PRESENTATION_ONLY,
      message: `Reconciling mirror band r${band} of AHR pool '${name}' makes its two legs agree again (md counted ${proof.mismatchCnt} disagreeing unit(s) there, and the pool's last checksum scrub was clean)`,
      warnings: [...mirrorReconcileWarnings(name, array, pool.capacity.usedBytes), ...reconcileLunWarnings(mirrorHeld)],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.mirror-reconcile',
      { ...identity, params: { name, band } },
      guarded(spec, pre, async (live, ctx) => reconcileMirrorBand(executor, live, band, {
        updateProgress: ctx.updateProgress,
        evidence,
        attributeFindings: async since => (await attributeScrub(executor, live, since, ctx.updateProgress)).findings ?? [],
        pollIntervalMs: opts.scrubPollIntervalMs,
        reguard: async () => {
          await ctx.reguard()
        },
        release: ctx.release,
      })),
      { locks: pre.locks, lane: 'long' },
    )
    reply.code(202)
    return { job }
  })
}
