import type { AhrPool } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { IscsiPaths } from '../services/iscsi.js'
import { AhrCreateSnapshotRequest, AhrSnapshotName, PoolName } from '@anas/shared'
import { confirmGate } from '../safety/gate.js'
import { readIntent } from '../services/ahr-intent.js'
import {
  createAhrSnapshot,
  defaultSnapshotName,
  deleteAhrSnapshot,
  listAhrSnapshots,
  rollbackAhrSnapshot,
} from '../services/ahr-snapshots.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { ahrHeldByLunConflict, ahrPoolHeldByLun } from './ahr-mutate.js'
import { requireIdentity } from './identity.js'

export interface AhrSnapshotRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  confirmStore: ConfirmStore
  /** AhrExpansionIntent store dir — snapshot mutations refuse mid-expansion. */
  intentDir: string
  /** On-demand top-level mount base override (tests point at a temp dir). */
  subvolRuntimeDir?: string
  /** iSCSI read-layer path overrides (story iscsi.6) — the rollback refusal. */
  iscsiPaths?: IscsiPaths
}

/**
 * AHR snapshot routes (story 11.12, docs/AHR-DESIGN.md §12/§4):
 *
 *   GET    /v1/ahr/:name/snapshots                  — list (200)
 *   POST   /v1/ahr/:name/snapshots {name?}          — create (202 job)
 *   DELETE /v1/ahr/:name/snapshots/:snap            — delete (202 / 409 confirm)
 *   POST   /v1/ahr/:name/snapshots/:snap/rollback   — rollback (202 / 409 confirm)
 *
 * Snapshots require the §12 subvolume layout (`subvolLayout: true`); a flat
 * pre-§12 pool is refused with the "snapshots unavailable, no migration"
 * advisory. Every mutation also refuses while an expansion intent exists or
 * the pool is failed/read-only — consistent with the other AHR verbs. Rollback
 * additionally refuses while an iSCSI LUN's image file lives on the pool (story
 * iscsi.6, issue #51) — the same hard 409 destroy/mountpoint use. All
 * mutations are jobs (202); delete/rollback are confirm-gated (Principle 14).
 */
export async function ahrSnapshotRoutes(server: FastifyInstance, opts: AhrSnapshotRouteOptions) {
  const { executor, jobQueue, confirmStore, intentDir, subvolRuntimeDir } = opts
  const svc = { runtimeDir: subvolRuntimeDir }

  /**
   * The iSCSI read-layer paths for the rollback refusal: the explicit test
   * seam wins, else the env-derived object server.ts decorates onto the app —
   * the SAME object every other route was handed, never a second env→paths
   * mapping here. Read lazily (decoration lands before ready()); a bare app
   * without it falls back to the library defaults, exactly like `{}` would.
   */
  const iscsiPaths = (): IscsiPaths =>
    opts.iscsiPaths ?? (server as unknown as { iscsiPaths?: IscsiPaths }).iscsiPaths ?? {}

  async function loadPool(rawName: string, reply: FastifyReply): Promise<AhrPool | null> {
    const parsed = PoolName.safeParse(rawName)
    if (!parsed.success) {
      reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${parsed.error.issues[0]?.message}` } })
      return null
    }
    const pool = (await readAhrPools(executor)).find(p => p.name === parsed.data)
    if (!pool) {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: `AHR pool '${parsed.data}' not found` } })
      return null
    }
    return pool
  }

  /** Parse a `:snap` param as a charset-safe snapshot name, or 400 → null. */
  function parseSnapName(raw: string, reply: FastifyReply): string | null {
    const parsed = AhrSnapshotName.safeParse(raw)
    if (!parsed.success) {
      reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid snapshot name: ${parsed.error.issues[0]?.message}` } })
      return null
    }
    return parsed.data
  }

  /**
   * The shared guard for a snapshot MUTATION (create/delete/rollback): the pool
   * must carry the §12 subvolume layout, have no expansion intent, and not be
   * in an offline/failed/read-only state. Returns true (and sends the 409) on
   * refusal.
   */
  async function refuseUnsafe(pool: AhrPool, reply: FastifyReply): Promise<boolean> {
    if (!pool.subvolLayout) {
      reply.code(409).send({ error: {
        code: 'CONFLICT',
        message: `Pool '${pool.name}' uses the pre-snapshot flat layout — btrfs snapshots are unavailable. There is no in-place migration (moving data across subvolume boundaries is a copy); destroy and recreate the pool to gain the @data/@snapshots layout (§12).`,
      } })
      return true
    }
    const intent = await readIntent(pool.name, intentDir)
    if (intent) {
      reply.code(409).send({ error: {
        code: 'CONFLICT',
        message: `Pool '${pool.name}' has an expansion intent (state '${intent.state}') — snapshots can change once it completes or is abandoned.`,
      } })
      return true
    }
    // `offline` (issue #18) belongs in this gate for the same reason `failed`
    // does: no filesystem is mounted, so a snapshot create/delete/rollback has
    // nothing to act on. It was reachable here while an unassembled pool still
    // read `degraded` — btrfs would then refuse on its own, but a pool-state
    // refusal that names the actual condition beats an errno from a subcommand.
    if (pool.state === 'offline') {
      reply.code(409).send({ error: {
        code: 'CONFLICT',
        message: `Pool '${pool.name}' is offline — the volume is not assembled, so there is no filesystem to snapshot. See the Hybrid RAID view for which band arrays cannot start.`,
      } })
      return true
    }
    if (pool.state === 'failed' || pool.state === 'readonly') {
      reply.code(409).send({ error: {
        code: 'CONFLICT',
        message: `Pool '${pool.name}' is ${pool.state} — resolve that before snapshot operations.`,
      } })
      return true
    }
    return false
  }

  // ---- GET /ahr/:name/snapshots — list -------------------------------------
  server.get<{ Params: { name: string } }>('/ahr/:name/snapshots', async (request, reply) => {
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    if (!pool.subvolLayout)
      return { data: [] } // flat layout: no snapshots (the UI shows the advisory)
    return { data: await listAhrSnapshots(executor, pool, svc) }
  })

  // ---- POST /ahr/:name/snapshots — create (202 job) ------------------------
  server.post<{ Params: { name: string } }>('/ahr/:name/snapshots', async (request, reply) => {
    const bodyParsed = AhrCreateSnapshotRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid snapshot request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    if (await refuseUnsafe(pool, reply))
      return

    const name = bodyParsed.data.name ?? defaultSnapshotName()
    // Reject a name that already exists (a snapshot create should never clobber).
    const existing = await listAhrSnapshots(executor, pool, svc)
    if (existing.some(s => s.name === name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Snapshot '${name}' already exists in pool '${pool.name}'` } }
    }

    const job = jobQueue.submit(
      'ahr.snapshot.create',
      { ...identity, params: { pool: pool.name, name } },
      async updateProgress => createAhrSnapshot(executor, pool, name, updateProgress, svc),
    )
    reply.code(202)
    return { job }
  })

  // ---- DELETE /ahr/:name/snapshots/:snap — delete (202 / 409 confirm) ------
  server.delete<{ Params: { name: string, snap: string } }>('/ahr/:name/snapshots/:snap', async (request, reply) => {
    const snap = parseSnapName(request.params.snap, reply)
    if (!snap)
      return
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    if (await refuseUnsafe(pool, reply))
      return
    if (!(await listAhrSnapshots(executor, pool, svc)).some(s => s.name === snap)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${snap}' not found in pool '${pool.name}'` } }
    }

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.snapshot.delete',
      params: { pool: pool.name, snap },
      message: `Deleting snapshot '${snap}' from pool '${pool.name}'`,
      warnings: [
        `Snapshot '${snap}' is permanently removed — its point-in-time copy is gone.`,
        `The live @data and every other snapshot are untouched; only this snapshot's exclusive space is freed.`,
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.snapshot.delete',
      { ...identity, params: { pool: pool.name, snap } },
      async updateProgress => deleteAhrSnapshot(executor, pool, snap, updateProgress, svc),
    )
    reply.code(202)
    return { job }
  })

  // ---- POST /ahr/:name/snapshots/:snap/rollback — rollback (202/409) --------
  server.post<{ Params: { name: string, snap: string } }>('/ahr/:name/snapshots/:snap/rollback', async (request, reply) => {
    const snap = parseSnapName(request.params.snap, reply)
    if (!snap)
      return
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const pool = await loadPool(request.params.name, reply)
    if (!pool)
      return
    if (await refuseUnsafe(pool, reply))
      return
    if (!(await listAhrSnapshots(executor, pool, svc)).some(s => s.name === snap)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${snap}' not found in pool '${pool.name}'` } }
    }

    // Story iscsi.6 (issue #51): a LUN's image file on this pool makes the
    // rollback unsafe NOW — the swap unmounts the pool and RENAMES `@data` —
    // LIO's open inode — out from under a live fileio backstore. A mounted pool
    // dies mid-job on EBUSY; an UNMOUNTED one diverges silently, LIO still
    // serving the preserved subvolume while the live `@data` goes stale. The
    // same hard 409 the destroy/mountpoint routes use — no confirm bypass,
    // before the confirm code is minted.
    const rollbackHeld = await ahrPoolHeldByLun(executor, iscsiPaths(), pool)
    if (rollbackHeld) {
      reply.code(409)
      return ahrHeldByLunConflict(`AHR pool '${pool.name}'`, 'Rolling back', rollbackHeld)
    }

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'ahr.snapshot.rollback',
      params: { pool: pool.name, snap },
      message: `Rolling pool '${pool.name}' back to snapshot '${snap}'`,
      warnings: [
        `The pool at '${pool.mountpoint}' is briefly UNMOUNTED during the swap — anything serving from it (shares, backups, mounts) stalls; open files block the unmount (retry after closing them). It remounts automatically at the end.`,
        `Nothing is destroyed: the current @data is PRESERVED as a 'pre-rollback-<timestamp>' snapshot, so you can roll back to it to undo this. Delete it later to reclaim its space.`,
        `After rollback, @data becomes a writable copy of '${snap}'; changes made since that snapshot are no longer live (but remain in the preserved pre-rollback snapshot).`,
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.snapshot.rollback',
      { ...identity, params: { pool: pool.name, snap } },
      async updateProgress => rollbackAhrSnapshot(executor, pool, snap, updateProgress, svc),
    )
    reply.code(202)
    return { job }
  })
}
