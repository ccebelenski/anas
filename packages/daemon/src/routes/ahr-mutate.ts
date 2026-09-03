import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { AhrLayoutDisk } from '../services/ahr-layout.js'
import type { DiskIdentityCache } from '../services/disk-identity-cache.js'
import type { IscsiPaths } from '../services/iscsi.js'
import type { IscsiHeldByLun } from '@anas/shared'
import { AhrCreateRequest, AhrMountpointRequest, isComposableDisk, PoolName } from '@anas/shared'
import { parseFindmnt } from '../parsers/findmnt.js'
import { hasMount } from '../parsers/fstab.js'
import { parseVgsReport, VGS_ARGS } from '../parsers/lvm-report.js'
import { confirmGate } from '../safety/gate.js'
import { changeAhrMountpoint, createAhrPool } from '../services/ahr-create.js'
import { destroyAhrPool } from '../services/ahr-destroy.js'
import { AhrPlanError, fmtBytes, MIXED_SECTOR_WARNING_PREFIX, planFreshLayout } from '../services/ahr-layout.js'
import { scrubAhrPool } from '../services/ahr-scrub.js'
import { AHR_FINDMNT_ARGS, readAhrPools } from '../services/ahr-topology.js'
import { readConfig } from '../services/config-writer.js'
import { createIscsiClaimCache, heldByLun, heldByLunRefusal } from '../services/iscsi-held.js'
import { kernelInfo } from '../services/kernel-version.js'
import { collectDisks } from './disks.js'
import { requireIdentity } from './identity.js'

const FINDMNT = '/usr/bin/findmnt'
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
) {
  const subject: { pool: string, path?: string } = { pool: pool.name }
  if (pool.mounted && pool.mountpoint.startsWith('/'))
    subject.path = pool.mountpoint
  return heldByLun(createIscsiClaimCache(executor, iscsiPaths), subject)
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
 *   POST   /v1/ahr             — create pool (wipes disks; 409 confirm)
 *   DELETE /v1/ahr/:name       — destroy pool (409 confirm)
 *   POST   /v1/ahr/:name/scrub — btrfs scrub then md checks (202, no confirm)
 *
 * All mutations are jobs (202). The expansion verbs (expand/plan/resume/
 * abandon/replace) live separately in routes/ahr-expand.ts. Reads live in
 * routes/ahr.ts.
 */
export async function ahrMutationRoutes(server: FastifyInstance, opts: AhrMutationRouteOptions) {
  const { executor, jobQueue, confirmStore, diskIdentityCache, fstabPath, mdadmConfPath, mountBase, kernelRelease } = opts
  const iscsiPaths = opts.iscsiPaths ?? {}

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
      return { error: { code: 'CONFLICT', message: `an LVM volume group named '${req.name}' already exists — the pool name becomes its VG name, so this would collide at vgcreate (after the disks were wiped); choose another name` } }
    }

    // Mountpoint override (§2.6): never in PVE's namespace, never a path that
    // is already mounted or claimed in fstab — the pool must not shadow or
    // fight anything that exists.
    if (req.mountpoint !== undefined) {
      const mp = req.mountpoint.replace(TRAILING_SLASHES_RE, '') || '/'
      if (mp === '/mnt/pve' || mp.startsWith('/mnt/pve/') || mp === '/') {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `mountpoint '${req.mountpoint}' is reserved — /mnt/pve belongs to PVE (§2.6) and / is not a pool mountpoint` } }
      }
      const findmntRes = await executor.exec(FINDMNT, AHR_FINDMNT_ARGS)
      const mounts = findmntRes.exitCode === 0 ? parseFindmnt(findmntRes.stdout) : []
      if (mounts.some(m => m.target === mp)) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: `'${mp}' is already a mountpoint — pick an unused path` } }
      }
      if (hasMount(await readConfig(fstabPath), mp)) {
        reply.code(409)
        return { error: { code: 'CONFLICT', message: `'${mp}' is already claimed in fstab — pick an unused path` } }
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
      message: `Creating AHR pool '${req.name}' will WIPE ${selected.length} disk(s) — all data on them will be permanently erased`,
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
      return { error: { code: 'VALIDATION_ERROR', message: `mountpoint '${parsed.data.mountpoint}' is reserved — /mnt/pve belongs to PVE (§2.6) and / is not a pool mountpoint` } }
    }
    if (mp === pool.mountpoint) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `'${mp}' is already this pool's mountpoint` } }
    }
    const findmntRes = await executor.exec(FINDMNT, AHR_FINDMNT_ARGS)
    const mounts = findmntRes.exitCode === 0 ? parseFindmnt(findmntRes.stdout) : []
    if (mounts.some(m => m.target === mp)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `'${mp}' is already a mountpoint — pick an unused path` } }
    }
    if (hasMount(await readConfig(fstabPath), mp)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `'${mp}' is already claimed in fstab — pick an unused path` } }
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
        pool.mounted ? 'The filesystem is unmounted during the move — open files will block it (retry after closing them)' : 'The pool is currently unmounted — only fstab is rewritten, then it mounts at the new path',
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
    const destroyHeld = await ahrPoolHeldByLun(executor, iscsiPaths, pool)
    if (destroyHeld) {
      reply.code(409)
      return ahrHeldByLunConflict(`AHR pool '${name}'`, 'Destroying', destroyHeld)
    }

    // Consumers under the mountpoint (submounts — shares/backups serving from
    // the pool stop with it). findmnt is the live truth.
    const warnings = [
      `Pool '${name}' (${fmtBytes(pool.capacity.usableBytes)} usable) will be permanently destroyed — every array, partition, and all data erased`,
      `The filesystem at '${pool.mountpoint}' will be unmounted — anything serving from it (shares, backups, mounts) stops working`,
    ]
    const findmntRes = await executor.exec(FINDMNT, AHR_FINDMNT_ARGS)
    if (findmntRes.exitCode === 0) {
      for (const m of parseFindmnt(findmntRes.stdout)) {
        if (m.target.startsWith(`${pool.mountpoint}/`))
          warnings.push(`'${m.target}' (${m.fstype}) is mounted beneath the pool and will lose its filesystem`)
      }
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

    const pool = (await readAhrPools(executor)).find(p => p.name === name)
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
      return { error: { code: 'CONFLICT', message: `AHR pool '${name}' is offline — the volume is not assembled, so there is nothing to scrub; see the Hybrid RAID view for which band arrays cannot start` } }
    }
    // Never concurrent (§4): a scrub and a resync/reshape are all full-device
    // passes — refuse while one is already running.
    if (pool.state === 'scrubbing' || pool.state === 'building' || pool.state === 'rebuilding' || pool.state === 'expanding') {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `AHR pool '${name}' is ${pool.state} — a scrub would thrash the running operation; wait for it to finish` } }
    }
    if (pool.mountpoint.startsWith('/dev/')) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `AHR pool '${name}' is not mounted — btrfs scrub needs the filesystem online` } }
    }

    const job = jobQueue.submit(
      'ahr.scrub',
      { ...identity, params: { name } },
      async updateProgress => scrubAhrPool(executor, pool, updateProgress, { pollIntervalMs: opts.scrubPollIntervalMs }),
    )
    reply.code(202)
    return { job }
  })
}
