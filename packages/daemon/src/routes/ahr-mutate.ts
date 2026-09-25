import type { AhrPool, AhrRepairFile, IscsiHeldByLun } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { AhrLayoutDisk } from '../services/ahr-layout.js'
import type { MirrorReconcileRefusal } from '../services/ahr-mirror-reconcile.js'
import type { ParityRewriteRefusal } from '../services/ahr-parity-rewrite.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import type { IscsiPaths } from '../services/iscsi.js'
import { relative, resolve as resolvePath } from 'node:path'
import { AhrCreateRequest, AhrMirrorReconcileRequest, AhrMountpointRequest, AhrParityRewriteRequest, AhrRepairRequest, isComposableDisk, PoolName } from '@anas/shared'
import { parseFindmnt } from '../parsers/findmnt.js'
import { hasMount } from '../parsers/fstab.js'
import { parseVgsReport, VGS_ARGS } from '../parsers/lvm-report.js'
import { confirmGate } from '../safety/gate.js'
import { changeAhrMountpoint, createAhrPool, remountAhrPool } from '../services/ahr-create.js'
import { destroyAhrPool } from '../services/ahr-destroy.js'
import { AhrPlanError, fmtBytes, MIXED_SECTOR_WARNING_PREFIX, planFreshLayout } from '../services/ahr-layout.js'
import { mirrorReconcileArray, mirrorReconcileArrayRefusal, mirrorReconcileEvidence, mirrorReconcileWarnings, reconcileMirrorBand } from '../services/ahr-mirror-reconcile.js'
import { parityRewriteArray, parityRewriteArrayRefusal, parityRewriteEvidence, parityRewriteWarnings, rewriteBandParity } from '../services/ahr-parity-rewrite.js'
import { ahrLvPath } from '../services/ahr-paths.js'
import { repairAhrFiles } from '../services/ahr-repair.js'
import { attributeScrub, pathExists, runningAhrCheck, scrubAhrPool } from '../services/ahr-scrub.js'
import { topLevelMountPath } from '../services/ahr-snapshots.js'
import { AHR_FINDMNT_ARGS, readAhrPools } from '../services/ahr-topology.js'
import { readConfig } from '../services/config-writer.js'
import { createIscsiClaimCache, heldByLun, heldByLunRefusal } from '../services/iscsi-held.js'
import { kernelInfo } from '../services/kernel-version.js'
import { mdSysPath, readMdAttrOrNull } from '../services/selfheal-io.js'
import { readMdGeometry } from '../services/selfheal-map.js'
import { collectDisks } from './disks.js'
import { requireIdentity } from './identity.js'

const FINDMNT = '/usr/bin/findmnt'
const REALPATH = '/usr/bin/realpath'
const VGS = '/usr/sbin/vgs'

const TRAILING_SLASHES_RE = /\/+$/

/**
 * Is an iSCSI LUN's image file living on this AHR pool (story iscsi.6)?
 *
 * A file on the btrfs volume IS the AHR block object — AHR's only backing kind
 * — so it is matched two ways: by the pool NAME (`classifyBacking` resolves an
 * AHR-hosted file onto its pool) and by the MOUNTPOINT (which still answers
 * when the pool could not be classified). `rm` of a backing file succeeds
 * silently and LIO keeps serving the unlinked inode (GT-40), so an unmount, a
 * destroy — or a rollback swapping `@data` out from under the file (issue #51)
 * — is data loss with no error anywhere.
 *
 * Module-scope (not a route closure) so routes/ahr-snapshots.ts's rollback
 * route runs the SAME check from the SAME helper — one source, one phrasing.
 */
export async function ahrPoolHeldByLun(
  executor: CommandExecutor,
  iscsiPaths: IscsiPaths,
  pool: { name: string, mountpoint: string, mounted: boolean },
  cache = createIscsiClaimCache(executor, iscsiPaths),
) {
  const subject: { pool: string, path?: string } = { pool: pool.name }
  if (pool.mounted && pool.mountpoint.startsWith('/'))
    subject.path = pool.mountpoint
  return heldByLun(cache, subject)
}

/**
 * The hard-409 body for a held pool — ONE shape (`CONFLICT` /
 * `reason: 'held-by-lun'`, no confirm bypass in the text) for every caller.
 * `heldByLunRefusal` writes the message; this shapes the response.
 */
export function ahrHeldByLunConflict(what: string, action: string, held: IscsiHeldByLun) {
  const refusal = heldByLunRefusal(what, action, held)
  return { error: { code: 'CONFLICT', reason: refusal.reason, message: refusal.message } }
}

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
}

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
  const { executor, jobQueue, confirmStore, diskIdentityCache, fstabPath, mdadmConfPath, mountBase, kernelRelease } = opts
  const iscsiPaths = opts.iscsiPaths ?? {}

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
  function conflictingAhrJob(name: string, exceptJobId?: string): { operation: string, id: string } | null {
    const job = jobQueue.findActive(REPAIR_EXCLUSIVE_OPERATIONS, name)
    // `exceptJobId` is the caller's OWN job: the parity rewrite re-asks this
    // question from inside its handler, and a run that counts itself as a
    // conflicting job refuses every time.
    return job && job.id !== exceptJobId ? { operation: job.operation, id: job.id } : null
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

    // Name collision: one AHR pool per name (also the VG name).
    if ((await readAhrPools(executor)).some(p => p.name === req.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `AHR pool '${req.name}' already exists` } }
    }

    // VG-name collision (pre-flight, BEFORE the confirm gate): the pool name
    // becomes the LVM VG name, and `vgcreate` runs only AFTER the disks are
    // wiped — so naming a pool after an existing VG (e.g. 'pve', the PVE root
    // VG) would pass confirm, wipe disks, then die at vgcreate leaving an
    // orphaned half-stack. Refuse now, while nothing has been touched.
    const vgsRes = await executor.exec(VGS, VGS_ARGS)
    const existingVgs = vgsRes.exitCode === 0 ? parseVgsReport(vgsRes.stdout) : []
    if (existingVgs.some(v => v.name === req.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `an LVM volume group named '${req.name}' already exists. The pool name becomes its VG name, so vgcreate would fail after the disks were wiped. Choose another name` } }
    }

    // Mountpoint override (§2.6): never in PVE's namespace, never a path that
    // is already mounted or claimed in fstab — the pool must not shadow or
    // fight anything that exists.
    if (req.mountpoint !== undefined) {
      const mp = req.mountpoint.replace(TRAILING_SLASHES_RE, '') || '/'
      if (mp === '/mnt/pve' || mp.startsWith('/mnt/pve/') || mp === '/') {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `mountpoint '${req.mountpoint}' is reserved. /mnt/pve belongs to PVE, and / is not a pool mountpoint` } }
      }
      const findmntRes = await executor.exec(FINDMNT, AHR_FINDMNT_ARGS)
      const mounts = findmntRes.exitCode === 0 ? parseFindmnt(findmntRes.stdout) : []
      if (mounts.some(m => m.target === mp)) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: `'${mp}' is already a mountpoint. Pick an unused path` } }
      }
      if (hasMount(await readConfig(fstabPath), mp)) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: `'${mp}' is already claimed in fstab. Pick an unused path` } }
      }
      req.mountpoint = mp
    }

    // Resolve every disk against the live inventory — only status 'available'
    // is eligible (GT-12: these exclusions are safety-critical, not cosmetic).
    const inventory = await collectDisks(executor, diskIdentityCache)
    const problems: string[] = []
    // logicalSectorSize rides along: a mixed 4Kn/512e selection gives the bands
    // differing logical block sizes, which the LVM stack must be told to accept
    // (issue #8). The planner labels it; nothing here refuses it.
    const selected: (AhrLayoutDisk & { model: string | null })[] = []
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
    if (problems.length > 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Ineligible disk selection: ${problems.join('; ')}` } }
    }

    // Validate the layout is buildable before gating (the same §2.1 math the
    // create job will execute).
    let layout: ReturnType<typeof planFreshLayout>
    try {
      // kernelInfo() gates mixed logical block sizes: below the md floor this
      // THROWS and lands as the 400 below — before any confirm code is minted,
      // and long before a disk is touched (§4).
      layout = planFreshLayout(selected, req.tier, kernelInfo(kernelRelease))
    }
    catch (err) {
      if (err instanceof AhrPlanError) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: err.message } }
      }
      throw err
    }
    if (!layout.minDisksMet || layout.capacity.usableBytes === 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: layout.warnings[0] ?? 'The disk selection cannot form a protected pool' } }
    }

    // Confirm gate (Principle 14): the CONCRETE consequence — every disk that
    // will be wiped, by id + model + size.
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.create',
      params: { name: req.name },
      message: `Creating AHR pool '${req.name}' will WIPE ${selected.length} disk(s). All data on them will be permanently erased`,
      warnings: [
        ...selected.map(d => `${d.id} (${d.model ?? 'unknown model'}, ${fmtBytes(d.usableBytes)}) will be completely erased`),
        // Geometry advisories the planner raised — the mixed 4Kn/512e label
        // (issue #8) belongs in front of the operator BEFORE the wipe, not as a
        // post-wipe job failure. The layout's own capacity warnings already ride
        // the composer preview; only the sector-geometry one is confirm-worthy.
        ...layout.warnings.filter(w => w.startsWith(MIXED_SECTOR_WARNING_PREFIX)),
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.create',
      { ...identity, params: { name: req.name, tier: req.tier, disks: req.disks, mountpoint: req.mountpoint ?? null } },
      async updateProgress => createAhrPool(
        executor,
        { name: req.name, tier: req.tier, disks: selected, mountpoint: req.mountpoint },
        updateProgress,
        { fstabPath, mdadmConfPath, mountBase },
      ),
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

    const pool = (await readAhrPools(executor)).find(p => p.name === name)
    if (!pool) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `AHR pool '${name}' not found` } }
    }

    const mp = parsed.data.mountpoint.replace(TRAILING_SLASHES_RE, '') || '/'
    if (mp === '/mnt/pve' || mp.startsWith('/mnt/pve/') || mp === '/') {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `mountpoint '${parsed.data.mountpoint}' is reserved. /mnt/pve belongs to PVE, and / is not a pool mountpoint` } }
    }
    if (mp === pool.mountpoint) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `'${mp}' is already this pool's mountpoint` } }
    }
    const findmntRes = await executor.exec(FINDMNT, AHR_FINDMNT_ARGS)
    const mounts = findmntRes.exitCode === 0 ? parseFindmnt(findmntRes.stdout) : []
    if (mounts.some(m => m.target === mp)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `'${mp}' is already a mountpoint. Pick an unused path` } }
    }
    if (hasMount(await readConfig(fstabPath), mp)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `'${mp}' is already claimed in fstab. Pick an unused path` } }
    }

    // Story iscsi.6: moving the mountpoint UNMOUNTS the filesystem, which pulls
    // the image file out from under a live LIO backstore. A hard 409 with no
    // confirm bypass — "unsafe now", before anything is touched.
    const moveHeld = await ahrPoolHeldByLun(executor, iscsiPaths, pool)
    if (moveHeld) {
      reply.code(409)
      return ahrHeldByLunConflict(`the mountpoint of AHR pool '${name}'`, 'Changing', moveHeld)
    }

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.mountpoint',
      params: { name, mountpoint: mp },
      message: `Moving pool '${name}' from '${pool.mountpoint}' to '${mp}' briefly unmounts it`,
      warnings: [
        `Anything serving from '${pool.mountpoint}' (shares, backups, mounts) stops working until re-pointed at '${mp}'`,
        pool.mounted ? 'The filesystem is unmounted during the move. Open files will block it (retry after closing them)' : 'The pool is currently unmounted. Only fstab is rewritten, then the filesystem mounts at the new path',
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.mountpoint',
      { ...identity, params: { name, mountpoint: mp } },
      async updateProgress => changeAhrMountpoint(
        executor,
        { name: pool.name, mountpoint: pool.mountpoint, mounted: pool.mounted, subvolLayout: pool.subvolLayout },
        mp,
        updateProgress,
        { fstabPath },
      ),
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
   * Three doors before the gate, cheapest first:
   *  - not mounted read-only ⇒ 409. There is nothing to remount, and running an
   *    unmount/mount cycle "just in case" would cost the handles for nothing.
   *  - the read cache is still FAILED ⇒ 409. Every read on the pool returns EIO
   *    while the dead cache is in front of it (GT-19), so a remount would land
   *    a filesystem that cannot serve a byte and btrfs would force it read-only
   *    again on the first error. Uncache first — the message says so.
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

    const pool = (await readAhrPools(executor)).find(p => p.name === name)
    if (!pool) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `AHR pool '${name}' not found` } }
    }

    if (!pool.mountedReadOnly) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: pool.mounted
        ? `AHR pool '${name}' is mounted read-write — there is nothing to remount. Remount exists to clear a btrfs forced-readonly filesystem, which is what an I/O error leaves behind`
        : `AHR pool '${name}' is not mounted, so there is nothing to remount. Bring the pool online first — see the Hybrid RAID view` } }
    }

    // The dead cache must go FIRST. Remounting over it lands a filesystem that
    // returns EIO on every read, and btrfs forces it read-only again on the
    // first error — the operator would have broken every open handle to arrive
    // exactly where they started.
    if (pool.cache?.state === 'failed') {
      reply.code(409)
      return { error: { code: 'CONFLICT', message:
        `AHR pool '${name}' still has a FAILED read cache in front of its volume: every read returns an I/O error until the cache is removed, `
        + `and a remount would be forced read-only again by the first one. Detach the cache first (no data is lost — a writethrough cache holds no only copy), then Remount` } }
    }

    const remountHeld = await ahrPoolHeldByLun(executor, iscsiPaths, pool)
    if (remountHeld) {
      reply.code(409)
      return ahrHeldByLunConflict(`AHR pool '${name}'`, 'Remounting', remountHeld)
    }

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.remount',
      params: { name },
      message: `Remounting pool '${name}' unmounts and mounts its filesystem`,
      warnings: [
        `Open share handles break: '${pool.mountpoint}' is unmounted and mounted again, and anything holding a file open on it — SMB and NFS clients, a backup mid-run, a running job — loses it`,
        'This is the only way back: btrfs refuses `mount -o remount,rw` after an I/O error, so a plain remount cannot clear the read-only flag',
        'Fix the cause first if you have not: a pool that is read-only again after this has an error it is still meeting',
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.remount',
      { ...identity, params: { name } },
      async updateProgress => remountAhrPool(executor, { name: pool.name, mountpoint: pool.mountpoint }, updateProgress),
    )
    reply.code(202)
    return { job }
  })

  // --- DELETE /ahr/:name — destroy pool --------------------------------------
  server.delete<{ Params: { name: string } }>('/ahr/:name', async (request, reply) => {
    const name = parsePoolName(request.params.name, reply)
    if (!name)
      return

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const pool = (await readAhrPools(executor)).find(p => p.name === name)
    if (!pool) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `AHR pool '${name}' not found` } }
    }

    // Story iscsi.6: a LUN's image file on this pool makes the destroy unsafe
    // NOW — every array, partition and byte goes, including the file LIO is
    // serving, and nothing in ZFS/btrfs/md is going to refuse it. Hard 409, no
    // confirm bypass, before the confirm code is minted.
    // The cache is created HERE so the same read's failure bit can be
    // disclosed at the confirm door below (D3).
    const claimsCache = createIscsiClaimCache(executor, iscsiPaths)
    const destroyHeld = await ahrPoolHeldByLun(executor, iscsiPaths, pool, claimsCache)
    if (destroyHeld) {
      reply.code(409)
      return ahrHeldByLunConflict(`AHR pool '${name}'`, 'Destroying', destroyHeld)
    }

    // Consumers under the mountpoint (submounts — shares/backups serving from
    // the pool stop with it). findmnt is the live truth.
    const warnings = [
      `Pool '${name}' (${fmtBytes(pool.capacity.usableBytes)} usable) will be permanently destroyed. Every array, partition, and all data is erased`,
      `The filesystem at '${pool.mountpoint}' will be unmounted: anything serving from it (shares, backups, mounts) stops working`,
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

    // Fail-open is not fail-silent (D3): a broken claims read looks exactly
    // like a pool holding no LUNs, and the destroy takes the image file with
    // it. Disclose; the hard 409 above is unchanged.
    if (await claimsCache.readFailed()) {
      warnings.push('ANAS could not check whether an iSCSI LUN is served from this pool. The LIO configuration was unreadable. If this node serves iSCSI, verify by hand before confirming.')
    }

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.destroy',
      params: { name },
      message: `Destroying AHR pool '${name}' erases all of its data`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.destroy',
      { ...identity, params: { name } },
      async updateProgress => destroyAhrPool(executor, pool, updateProgress, { fstabPath, mdadmConfPath }),
    )
    reply.code(202)
    return { job }
  })

  // --- POST /ahr/:name/scrub — btrfs scrub then md checks (no confirm) --------
  server.post<{ Params: { name: string } }>('/ahr/:name/scrub', async (request, reply) => {
    const name = parsePoolName(request.params.name, reply)
    if (!name)
      return

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const pools = await readAhrPools(executor)
    const pool = pools.find(p => p.name === name)
    if (!pool) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `AHR pool '${name}' not found` } }
    }
    // Unreachable before busy (issue #18): a scrub reads every byte through the
    // btrfs filesystem and then checks each band array, and an offline pool has
    // neither — the volume is not assembled. This gate predates the `offline`
    // state, so an unassembled pool used to arrive here reading `degraded` and
    // pass; the mount check below would usually stop it, but a lingering mount
    // entry is not a guarantee, and "is offline" names the condition where
    // "is not mounted" only describes a symptom.
    if (pool.state === 'offline') {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `AHR pool '${name}' is offline: the volume is not assembled, so there is nothing to scrub. See the Hybrid RAID view for which band arrays cannot start` } }
    }
    // Never concurrent (§4): a scrub and a resync/reshape are all full-device
    // passes — refuse while one is already running.
    if (pool.state === 'scrubbing' || pool.state === 'building' || pool.state === 'rebuilding' || pool.state === 'expanding') {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `AHR pool '${name}' is ${pool.state}: a scrub would thrash the running operation. Wait for it to finish` } }
    }
    if (pool.mountpoint.startsWith('/dev/')) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `AHR pool '${name}' is not mounted: btrfs scrub needs the filesystem online` } }
    }
    // The other half of the selfheal.6 pair: a scrub cannot start mid-repair —
    // the engine has md's knobs turned aside for the duration of each block and
    // a check would re-read every stripe underneath it — and it cannot start on
    // top of another scrub either, which would run a second `--action=check`
    // over the same bands (§4: never concurrent).
    const scrubBlocker = conflictingAhrJob(name)
    if (scrubBlocker) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          message: scrubBlocker.operation === 'ahr.scrub'
            ? `a scrub is already in flight on AHR pool '${name}' (job ${scrubBlocker.id}). Wait for it to finish`
            : `${EXCLUSIVE_OPERATION_NAMES[scrubBlocker.operation] ?? 'another job'} job is in flight on AHR pool '${name}' (job ${scrubBlocker.id}). Wait for it to finish`,
        },
      }
    }
    // Both refusals above are IN-PROCESS: the pool state a topology read
    // reports, and the job queue's own record. Neither survives a daemon
    // restart — md's check on band r1 keeps running while the job that issued
    // it is gone (S6). A new scrub would then issue checks on bands sharing
    // spindles with it, which is exactly what §4 forbids. /proc/mdstat still
    // knows, so it is read once and matched against EVERY AHR band on the
    // node: another pool's bands are very often the same disks.
    const foreignCheck = await runningAhrCheck(executor, pools)
    if (foreignCheck) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: runningAhrCheckMessage(foreignCheck.label) } }
    }

    const job = jobQueue.submit(
      'ahr.scrub',
      { ...identity, params: { name } },
      async updateProgress => scrubAhrPool(executor, pool, updateProgress, { pollIntervalMs: opts.scrubPollIntervalMs }),
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
  server.post<{ Params: { name: string } }>('/ahr/:name/repair', async (request, reply) => {
    const name = parsePoolName(request.params.name, reply)
    if (!name)
      return

    const parsed = AhrRepairRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid repair request: ${parsed.error.issues[0]?.message}. Repair takes absolute paths under the pool's mountpoint, each with at least one 4 KiB block. Findings inside a snapshot (@snapshots/…) are filesystem-relative and cannot be repaired` } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const pools = await readAhrPools(executor)
    const pool = pools.find(p => p.name === name)
    if (!pool) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `AHR pool '${name}' not found` } }
    }
    if (!pool.mounted || pool.mountpoint.startsWith('/dev/')) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `AHR pool '${name}' is not mounted: a repair resolves the block through the live filesystem` } }
    }

    // Hard refusals, all of them BEFORE a confirm code is minted (Principle 14,
    // "unsafe now" has no bypass).
    const stateRefusal = REPAIR_REFUSED_STATES[pool.state]
    if (stateRefusal) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `AHR pool '${name}' ${stateRefusal}. Repair when the pool is healthy and idle` } }
    }
    const blocker = conflictingAhrJob(name)
    if (blocker) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `${blocker.operation === 'ahr.repair' ? 'another repair' : EXCLUSIVE_OPERATION_NAMES[blocker.operation] ?? 'another job'} is in flight on AHR pool '${name}' (job ${blocker.id}). Wait for it to finish` } }
    }
    // The node-wide half of the same exclusion (N10): a check from a previous
    // daemon, or one mdcheck's timer started, survives the job queue's memory.
    const repairForeignCheck = await runningAhrCheck(executor, pools)
    if (repairForeignCheck) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: runningAhrCheckMessage(repairForeignCheck.label) } }
    }
    // A backup (or any snapshot verb) holding the pool's on-demand top-level
    // mount is the same refusal the engine makes at its gates — said here, at
    // the door, rather than after the operator has confirmed.
    if (pool.subvolLayout) {
      const top = topLevelMountPath(pool)
      if ((await executor.exec(FINDMNT, ['--mountpoint', top])).exitCode === 0) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: `the top-level mount for AHR pool '${name}' is already held at ${top}. A backup or snapshot job is in flight, and the repair needs that mount to take its own read-only snapshot. Retry when the other job has finished` } }
      }
    }

    // Every path must be a live file under the pool's mountpoint. The two ways
    // a scrub finding fails that are exactly the two flags it carries:
    // `outsideMount` (a corrupt block inside `@snapshots/…` — real, expected,
    // and not reachable through the mounted tree) and `missing` (deleted since
    // the scrub). Both are refused by name, never quietly skipped.
    //
    // Confinement is NOT lexical only (design review 2026-09-14, D12): the
    // string check below is followed by `realpath -e` (a symlink inside the
    // tree passes the string test while pointing somewhere else), the
    // containment check re-run on the canonical form, and a findmnt check that
    // the path's filesystem is the pool's OWN LV (a bind mount laid over part
    // of the tree fails the string test no better than it fails this one).
    const lexicalRoot = resolvePath(pool.mountpoint)
    const root = await repairRealPath(executor, lexicalRoot)
    if (!root) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `the mountpoint '${pool.mountpoint}' of AHR pool '${name}' could not be resolved on the filesystem. Refusing to repair against an unresolvable root` } }
    }
    const lvDevice = await repairRealPath(executor, ahrLvPath(pool.name))
    if (!lvDevice) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `the LV device '${ahrLvPath(pool.name)}' of AHR pool '${name}' could not be resolved. Refusing to repair against an unresolvable pool device` } }
    }
    const files: AhrRepairFile[] = []
    for (const file of parsed.data.files) {
      const abs = resolvePath(file.path)
      if (abs === lexicalRoot || relative(lexicalRoot, abs).startsWith('..')) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `'${file.path}' is not a file under '${pool.mountpoint}'. Repair works on the live @data tree only. A finding outside the mounted tree (a snapshot) cannot be repaired` } }
      }
      if (!(await pathExists(executor, abs))) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: `'${file.path}' does not exist. The file was deleted since the scrub named it, and there is nothing to repair` } }
      }
      const real = await repairRealPath(executor, abs)
      if (!real || real === root || relative(root, real).startsWith('..')) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: real
          ? `'${file.path}' resolves to '${real}', which is not a file under '${pool.mountpoint}'. Repair works on the live @data tree only`
          : `'${file.path}' could not be resolved on the filesystem (realpath -e failed). A repair path must be a real file under '${pool.mountpoint}'` } }
      }
      const source = await repairMountSource(executor, real)
      const sourceReal = source ? await repairRealPath(executor, source) : null
      if (!source || !sourceReal) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `the filesystem holding '${file.path}' could not be determined (findmnt failed). A repair is refused until the path's filesystem can be confirmed as the pool's own` } }
      }
      if (sourceReal !== lvDevice) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `'${file.path}' sits on ${sourceReal}, not on AHR pool '${name}'s own device (${lvDevice}). A mount inside the pool's tree is not pool data` } }
      }
      // One attempt per block, in ascending order: the same block twice would
      // run the whole sequence twice and the second pass would abort on its own
      // repair ("not corrupt here").
      const unique = [...new Set(file.blocks)]
      unique.sort((a, b) => a - b)
      files.push({ path: real, blocks: unique, ...(file.inode !== undefined ? { inode: file.inode } : {}) })
    }
    const blocks = files.reduce((n, f) => n + f.blocks.length, 0)

    // LUN awareness, UP FRONT (seventh pass, F10). `heldByLunOnce` was already
    // called by the repair JOB, but only after the fact, to word the advice on
    // a block that could not be repaired. A file that backs a LUN with a LIVE
    // initiator session is refused here instead — before a confirm code is
    // minted, in the same tier as every other "unsafe now" (Principle 14).
    // ONE claims read for the whole request, shared across every file.
    const repairClaims = createIscsiClaimCache(executor, iscsiPaths)
    for (const file of files) {
      const held = await heldByLun(repairClaims, { path: file.path })
      if (held && held.connectedInitiators.length > 0) {
        reply.code(409)
        return lunSessionRefusal(file.path, held)
      }
    }

    // Confirm gate: what actually happens to the array, in the operator's terms.
    // The signature carries the exact selection, so a confirm code cannot be
    // replayed against a different set of files or blocks.
    //
    // The per-block cost is stated CONCRETELY (design review 2026-09-14, D13):
    // the engine drops the node's page cache twice per block (probe + cold
    // read), sweeps ~400 stripes of chunk-sized O_DIRECT reads twice per
    // block to evict md's stripe cache, and holds the stripe cache at its
    // floor (17) for the whole run — on a busy node all of that is felt.
    const sweepMiB = await perBlockSweepMiB(executor, pool)
    const striped = pool.arrays.some(a => a.level !== 'raid1')
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.repair',
      params: { name, files },
      message: `Repairing ${blocks} block(s) in ${files.length} file(s) on AHR pool '${name}' writes reconstructed data through md`,
      warnings: [
        'A read-only snapshot of the file\'s subvolume is taken for the duration and removed afterwards',
        `md's rmw_level, sync_min, sync_max and stripe_cache_size on the pool's array(s) are changed for the duration and restored afterwards`,
        'One 4 KiB block per finding is written THROUGH md. The write happens only after the reconstruction from the other members matches the checksum btrfs stored for it',
        `Per block: two node-wide page-cache drops (drop_caches), two ~${sweepMiB} MiB read sweeps over the array${striped ? ', and the band\'s stripe cache held at its floor for the duration' : ''}. A busy node will feel it. Bring latency-sensitive workloads down first`,
        'Nothing else on the array is touched: no other file, and no parity rewrite beyond the stripes these blocks live in',
        'A block that cannot be proven is left untouched. It is reported as unrepairable, or as corruption that arrived above md',
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.repair',
      { ...identity, params: { name, files: files.map(f => f.path), blocks } },
      async updateProgress => repairAhrFiles(executor, pool, files, updateProgress),
    )
    reply.code(202)
    return { job }
  })

  // --- POST /ahr/:name/parity-rewrite — rewrite one band's parity (confirm) --
  //
  // Story selfheal.10. The ONE case where ANAS runs `mdadm --action=repair`:
  // md counted mismatches on this band and the checksum pass came back clean
  // across the pool, so the data is right and the parity is what is wrong. The
  // preconditions below are that proof, taken here and taken AGAIN inside the
  // job immediately before the md write — a band that lost a member in between
  // is a band this must not touch.
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

    const pools = await readAhrPools(executor)
    const pool = pools.find(p => p.name === name)
    if (!pool) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `AHR pool '${name}' not found` } }
    }
    const array = parityRewriteArray(pool, band)
    if (!array) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `AHR pool '${name}' has no band r${band}: its bands are ${pool.arrays.map(a => `r${a.band}`).join(', ') || 'none'}` } }
    }
    if (!pool.mounted || pool.mountpoint.startsWith('/dev/')) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'pool-not-mounted', message: `AHR pool '${name}' is not mounted. The parity rewrite starts with a fresh btrfs scrub, which needs the filesystem online` } }
    }

    // Hard refusals, every one of them BEFORE a confirm code is minted
    // (Principle 14: "unsafe now" has no bypass, and none of these is a risk
    // the operator can accept — they are states in which the verb is wrong).
    // The proof may come from the pool's last completed SCRUB or from its last
    // completed REPAIR, whichever is newer (seventh pass, F2): a repair that
    // wrote a proven block and saw md still counting mismatches has measured
    // the residual, and making the operator sit through a fresh multi-hour
    // two-phase scrub to rediscover that number is the gap F2 names.
    const evidence = () => parityRewriteEvidence(name, [
      jobQueue.findLastCompleted('ahr.scrub', name),
      jobQueue.findLastCompleted('ahr.repair', name),
    ], band)
    const proof = evidence()
    if (!proof.ok) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: proof.code, message: proof.reason } }
    }
    const stateRefusal = REPAIR_REFUSED_STATES[pool.state]
    if (stateRefusal) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'array-busy', message: `AHR pool '${name}' ${stateRefusal}. Rewrite parity when the pool is healthy and idle` } }
    }
    // Set the moment the job exists, and read only from inside the handler —
    // every call there happens in a later microtask than the assignment below,
    // because `rewriteBandParity` awaits before it asks. A run must not count
    // ITSELF as the job that blocks it.
    let selfJobId: string | undefined
    const jobConflict = () => {
      const active = conflictingAhrJob(name, selfJobId)
      return active
        ? `${EXCLUSIVE_OPERATION_NAMES[active.operation] ?? 'another job'} is in flight on AHR pool '${name}' (job ${active.id}). A parity rewrite reads every member of a band twice. Wait for it to finish`
        : null
    }
    const conflict = jobConflict()
    if (conflict) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'job-active', message: conflict } }
    }
    // The node-wide half of the same exclusion (N10): this verb hands md a
    // whole-band `repair`, which is the last thing to issue onto a node where
    // md is already running a check of its own.
    const rewriteForeignCheck = await runningAhrCheck(executor, pools)
    if (rewriteForeignCheck) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'array-busy', message: runningAhrCheckMessage(rewriteForeignCheck.label) } }
    }
    // The band's own state, read from md rather than from the pool rollup: a
    // pool can read `healthy` while THIS array is mid-check, and the rewrite
    // happens on the array. A RAID1 band is refused here for good and not for
    // now (N1): `not-a-parity-band` never becomes true.
    let bandRefusal: ParityRewriteRefusal | null
    try {
      bandRefusal = await parityRewriteArrayRefusal(await readMdGeometry(executor, array.device))
    }
    catch (error) {
      bandRefusal = {
        reason: `band r${band} of AHR pool '${name}' (${array.device}) could not be read: ${error instanceof Error ? error.message : String(error)}`,
        code: 'array-busy',
      }
    }
    if (bandRefusal) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: bandRefusal.code, message: bandRefusal.reason } }
    }
    // Is a guest's disk live on this pool (F10)? Disclosed, never refused.
    const rewriteHeld = await ahrPoolHeldByLun(executor, iscsiPaths, pool)

    // Confirm gate: what md is about to do, in the operator's terms. The
    // signature carries the band, so a code minted for r1 cannot rewrite r2.
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.parity-rewrite',
      params: { name, band },
      message: `Rewriting parity on band r${band} of AHR pool '${name}' recomputes that band's parity from the data it holds now (md counted ${proof.mismatchCnt} mismatch(es) there, and the pool's last checksum scrub was clean)`,
      // The estimate includes phase 1's full-pool checksum scrub (N8) — on a
      // pool with real data in it that pass is usually the dominant term, and
      // a gate that quoted only the two md passes understated the wait.
      //
      // The LUN disclosure (seventh pass, F10) is a WARNING here and a refusal
      // on Repair, and the difference is what each verb writes. A rewrite reads
      // every member of the band twice and writes parity: no guest-visible byte
      // changes, so there is nothing for an initiator to be surprised by — but
      // the operator is agreeing to hours of the array reading flat out under a
      // guest's live disk, and that is theirs to weigh.
      warnings: [...parityRewriteWarnings(name, array, pool.capacity.usedBytes), ...rewriteLunWarnings(rewriteHeld)],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.parity-rewrite',
      { ...identity, params: { name, band } },
      async updateProgress => rewriteBandParity(executor, pool, band, {
        updateProgress,
        evidence,
        jobConflict,
        attributeFindings: async since => (await attributeScrub(executor, pool, since, updateProgress)).findings ?? [],
        pollIntervalMs: opts.scrubPollIntervalMs,
      }),
    )
    selfJobId = job.id
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

    const pools = await readAhrPools(executor)
    const pool = pools.find(p => p.name === name)
    if (!pool) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `AHR pool '${name}' not found` } }
    }
    const array = mirrorReconcileArray(pool, band)
    if (!array) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `AHR pool '${name}' has no band r${band}: its bands are ${pool.arrays.map(a => `r${a.band}`).join(', ') || 'none'}` } }
    }
    if (!pool.mounted || pool.mountpoint.startsWith('/dev/')) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'pool-not-mounted', message: `AHR pool '${name}' is not mounted. Arm A is a btrfs scrub and arm B reads the checksum tree, and both need the filesystem online` } }
    }

    // Hard refusals, every one of them BEFORE a confirm code is minted
    // (Principle 14). The proof may come from the pool's last completed SCRUB
    // or from its last completed REPAIR, whichever is newer — the same
    // shortcut the parity rewrite takes, and for the same reason.
    const evidence = () => mirrorReconcileEvidence(name, [
      jobQueue.findLastCompleted('ahr.scrub', name),
      jobQueue.findLastCompleted('ahr.repair', name),
    ], band)
    const proof = evidence()
    if (!proof.ok) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: proof.code, message: proof.reason } }
    }
    const stateRefusal = REPAIR_REFUSED_STATES[pool.state]
    if (stateRefusal) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'array-busy', message: `AHR pool '${name}' ${stateRefusal}. Reconcile a mirror when the pool is healthy and idle` } }
    }
    // Set the moment the job exists, and read only from inside the handler —
    // a run must not count ITSELF as the job that blocks it.
    let selfMirrorJobId: string | undefined
    const jobConflict = () => {
      const active = conflictingAhrJob(name, selfMirrorJobId)
      return active
        ? `${EXCLUSIVE_OPERATION_NAMES[active.operation] ?? 'another job'} is in flight on AHR pool '${name}' (job ${active.id}). A mirror reconcile scrubs the pool and reads every row of both legs. Wait for it to finish`
        : null
    }
    const conflict = jobConflict()
    if (conflict) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'job-active', message: conflict } }
    }
    // The node-wide half of the same exclusion (N10): this verb issues its own
    // whole-band checks, and md runs one sync thread per array.
    const mirrorForeignCheck = await runningAhrCheck(executor, pools)
    if (mirrorForeignCheck) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: 'array-busy', message: runningAhrCheckMessage(mirrorForeignCheck.label) } }
    }
    // The band's own state, read from md rather than from the pool rollup. A
    // PARITY band is refused here for good and not for now
    // (`not-a-mirror-band` never becomes true) — it has a verb of its own.
    let mirrorRefusal: MirrorReconcileRefusal | null
    try {
      mirrorRefusal = await mirrorReconcileArrayRefusal(await readMdGeometry(executor, array.device))
    }
    catch (error) {
      mirrorRefusal = {
        reason: `band r${band} of AHR pool '${name}' (${array.device}) could not be read: ${error instanceof Error ? error.message : String(error)}`,
        code: 'array-busy',
      }
    }
    if (mirrorRefusal) {
      reply.code(409)
      return { error: { code: 'CONFLICT', reason: mirrorRefusal.code, message: mirrorRefusal.reason } }
    }
    // Is a guest's disk live on this pool? Disclosed, never refused: every row
    // this verb writes already matches its stored checksum, so nothing a guest
    // can read changes.
    const mirrorHeld = await ahrPoolHeldByLun(executor, iscsiPaths, pool)

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.mirror-reconcile',
      params: { name, band },
      message: `Reconciling mirror band r${band} of AHR pool '${name}' makes its two legs agree again (md counted ${proof.mismatchCnt} disagreeing unit(s) there, and the pool's last checksum scrub was clean)`,
      warnings: [...mirrorReconcileWarnings(name, array, pool.capacity.usedBytes), ...reconcileLunWarnings(mirrorHeld)],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.mirror-reconcile',
      { ...identity, params: { name, band } },
      async updateProgress => reconcileMirrorBand(executor, pool, band, {
        updateProgress,
        evidence,
        jobConflict,
        attributeFindings: async since => (await attributeScrub(executor, pool, since, updateProgress)).findings ?? [],
        pollIntervalMs: opts.scrubPollIntervalMs,
      }),
    )
    selfMirrorJobId = job.id
    reply.code(202)
    return { job }
  })
}
