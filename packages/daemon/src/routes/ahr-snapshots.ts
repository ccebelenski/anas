import type { AhrPool } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { Gate, GuardReads, GuardSpec } from '../safety/guard.js'
import type { IscsiPaths } from '../services/iscsi.js'
import { AhrCreateSnapshotRequest, AhrSnapshotName, PoolName } from '@anas/shared'
import { guardCheck, guardConfirm, guarded, sendRefusal } from '../safety/guard.js'
import { ahrGuard } from '../services/ahr-guard.js'
import {
  createAhrSnapshot,
  defaultSnapshotName,
  deleteAhrSnapshot,
  listAhrSnapshots,
  rollbackAhrSnapshot,
} from '../services/ahr-snapshots.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { lioUnreadableAdvisory } from '../services/iscsi-held.js'
import { mountTargetRefusal } from '../services/mounts.js'
import { requireIdentity } from './identity.js'

/**
 * The fields the snapshot delete and rollback confirms leave out of their
 * signature (story cr.38, WAVE3-DESIGN §5.2 rule 1): none. A test lists them.
 */
export const AHR_SNAPSHOT_DELETE_PRESENTATION_ONLY: Record<string, string> = {}
export const AHR_SNAPSHOT_ROLLBACK_PRESENTATION_ONLY: Record<string, string> = {}

export interface AhrSnapshotRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  confirmStore: ConfirmStore
  /** AhrExpansionIntent store dir — snapshot mutations refuse mid-expansion. */
  intentDir: string
  /** On-demand top-level mount base override (tests point at a temp dir). */
  subvolRuntimeDir?: string
  /**
   * The server's fstab (cr.52s-c): the rollback's remount carries the pool's
   * OWN line from THIS file. Unset, the service falls back to the daemon
   * default (ANAS_FSTAB_PATH then /etc/fstab) exactly as before.
   */
  fstabPath?: string
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
  const { executor, jobQueue, confirmStore, intentDir, subvolRuntimeDir, fstabPath } = opts
  const svc = { runtimeDir: subvolRuntimeDir, ...(fstabPath !== undefined ? { fstabPath } : {}) }

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

  // ---- the guard (story cr.38 session A, WAVE3-DESIGN §2.3 "snapshot
  // create / delete / rollback": every gate was request-time only) ----------
  //
  // One gate list per verb, run at the route and again in the job against
  // facts the job reads itself: the §12 layout, no expansion intent, a pool
  // state with a filesystem to act on, the snapshot (not) there — and for a
  // rollback the system-pool hard 409 (cr.38 adds it: the swap unmounts the
  // pool) and the LUN-held hard 409 (iscsi.6). The jobs hold the pool's key:
  // exclusive for a rollback (it swaps `@data`), shared for create and delete
  // (§4.2), so a rollback never runs under a snapshot verb and two snapshot
  // verbs never wait for each other.

  const guard = ahrGuard({ executor, intentDir, iscsiPaths })

  /** The pool's snapshots, once per guard run; an unmounted pool lists none. */
  const snapshotsOnce = (pool: AhrPool, reads: GuardReads) => reads.once(`ahr-snapshots:${pool.name}`, () => listAhrSnapshots(executor, pool, svc))

  /**
   * The shared gates of a snapshot MUTATION (create/delete/rollback): the pool
   * must carry the §12 subvolume layout, have no expansion intent, and not be
   * in an offline/failed/read-only state.
   */
  const SNAPSHOT_GATES: Gate<AhrPool>[] = [
    async pool => !pool.subvolLayout
      ? { status: 409, code: 'CONFLICT', message: `Pool '${pool.name}' uses the pre-snapshot flat layout — btrfs snapshots are unavailable. There is no in-place migration (moving data across subvolume boundaries is a copy); destroy and recreate the pool to gain the @data/@snapshots layout (§12).` }
      : null,
    // This pool's intent only — a stale one refuses nothing (story ident.3).
    guard.intentGate('snapshots can change once it completes or is abandoned'),
    // `offline` (issue #18) belongs in this gate for the same reason `failed`
    // does: no filesystem is mounted, so a snapshot create/delete/rollback has
    // nothing to act on. A pool-state refusal that names the actual condition
    // beats an errno from a subcommand.
    async pool => pool.state === 'offline'
      ? { status: 409, code: 'CONFLICT', message: `Pool '${pool.name}' is offline — the volume is not assembled, so there is no filesystem to snapshot. See the Hybrid RAID view for which band arrays cannot start.` }
      : null,
    async pool => pool.state === 'failed' || pool.state === 'readonly'
      ? { status: 409, code: 'CONFLICT', message: `Pool '${pool.name}' is ${pool.state} — resolve that before snapshot operations.` }
      : null,
  ]

  /** The snapshot a delete or rollback names must exist (404 at the route, NOT_FOUND in the job). */
  function snapshotExistsGate(snap: string): Gate<AhrPool> {
    return async (pool, reads) => (await snapshotsOnce(pool, reads)).some(s => s.name === snap)
      ? null
      : { status: 404, code: 'NOT_FOUND', message: `Snapshot '${snap}' not found in pool '${pool.name}'` }
  }

  /** Parse the pool-name param, or 400 → null (the guard's view answers the 404). */
  function parsePoolName(raw: string, reply: FastifyReply): string | null {
    const parsed = PoolName.safeParse(raw)
    if (!parsed.success) {
      reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${parsed.error.issues[0]?.message}` } })
      return null
    }
    return parsed.data
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
    const poolName = parsePoolName(request.params.name, reply)
    if (!poolName)
      return

    const name = bodyParsed.data.name ?? defaultSnapshotName()
    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.snapshot.create',
      object: guard.poolView(poolName, 'a snapshot'),
      gates: [
        ...SNAPSHOT_GATES,
        // Reject a name that already exists (a snapshot create should never clobber).
        async (pool, reads) => (await snapshotsOnce(pool, reads)).some(s => s.name === name)
          ? { status: 409, code: 'CONFLICT', message: `Snapshot '${name}' already exists in pool '${pool.name}'` }
          : null,
      ],
      locks: async (pool, bound) => guard.claims(pool, bound, 'shared'),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'ahr.snapshot.create',
      { ...identity, params: { pool: poolName, name } },
      guarded(spec, pre, async (live, { updateProgress }) => createAhrSnapshot(executor, live, name, updateProgress, svc)),
      { locks: pre.locks },
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
    const poolName = parsePoolName(request.params.name, reply)
    if (!poolName)
      return

    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.snapshot.delete',
      object: guard.poolView(poolName, 'a snapshot delete'),
      gates: [...SNAPSHOT_GATES, snapshotExistsGate(snap)],
      locks: async (pool, bound) => guard.claims(pool, bound, 'shared'),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { pool: poolName, snap },
      address: ['pool', 'snap'],
      presentationOnly: AHR_SNAPSHOT_DELETE_PRESENTATION_ONLY,
      message: `Deleting snapshot '${snap}' from pool '${poolName}'`,
      warnings: [
        `Snapshot '${snap}' is permanently removed — its point-in-time copy is gone.`,
        `The live @data and every other snapshot are untouched; only this snapshot's exclusive space is freed.`,
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.snapshot.delete',
      { ...identity, params: { pool: poolName, snap } },
      guarded(spec, pre, async (live, { updateProgress }) => deleteAhrSnapshot(executor, live, snap, updateProgress, svc)),
      { locks: pre.locks },
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
    const poolName = parsePoolName(request.params.name, reply)
    if (!poolName)
      return

    // Story iscsi.6 (issue #51): a LUN's image file on this pool makes the
    // rollback unsafe NOW — the swap unmounts the pool and RENAMES `@data` —
    // LIO's open inode — out from under a live fileio backstore. A mounted pool
    // dies mid-job on EBUSY; an UNMOUNTED one diverges silently, LIO still
    // serving the preserved subvolume while the live `@data` goes stale. The
    // same hard 409 the destroy/mountpoint routes use — no confirm bypass,
    // before the confirm code is minted, and again in the job (cr.38), beside
    // the system-pool gate the unmount needs as much as destroy does.
    const spec: GuardSpec<AhrPool> = {
      operation: 'ahr.snapshot.rollback',
      object: guard.poolView(poolName, 'a rollback'),
      gates: [
        ...SNAPSHOT_GATES,
        guard.systemPoolGate,
        guard.lunGate('Rolling back'),
        snapshotExistsGate(snap),
        // cr.52r P2: the rollback REMOUNTS the pool's stored path in its finally
        // — the stored path runs the mount-target refusal before the swap, at
        // the route and again in the job.
        async pool => mountTargetRefusal(pool.mountpoint),
      ],
      // D3, cr.38r: the system-pool and LUN gates just ran on a claims read
      // that may have FAILED OPEN — warn, never refuse; the job reports any
      // the confirm did not list.
      advisories: async (_pool, reads) => lioUnreadableAdvisory(await guard.reads.claims(reads), 'pool'),
      locks: async (pool, bound) => guard.claims(pool, bound, 'exclusive'),
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { pool: poolName, snap },
      address: ['pool', 'snap'],
      presentationOnly: AHR_SNAPSHOT_ROLLBACK_PRESENTATION_ONLY,
      message: `Rolling pool '${poolName}' back to snapshot '${snap}'`,
      warnings: [
        `The pool at '${pre.object.mountpoint}' is briefly UNMOUNTED during the swap — anything serving from it (shares, backups, mounts) stalls; open files block the unmount (retry after closing them). It remounts automatically at the end.`,
        `Nothing is destroyed: the current @data is PRESERVED as a 'pre-rollback-<timestamp>' snapshot, so you can roll back to it to undo this. Delete it later to reclaim its space.`,
        `After rollback, @data becomes a writable copy of '${snap}'; changes made since that snapshot are no longer live (but remain in the preserved pre-rollback snapshot).`,
        // D3: the LIO-unreadable disclosure rides the confirm warnings too.
        ...pre.advisories.map(a => a.warning),
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'ahr.snapshot.rollback',
      { ...identity, params: { pool: poolName, snap } },
      // The pool as the job read it (§2.3: the swap's unmount used the
      // request-time `mounted`, outside the lock).
      guarded(spec, pre, async (live, { updateProgress, newAdvisories }) => {
        const result = await rollbackAhrSnapshot(executor, live, snap, updateProgress, svc)
        // D3 (cr.38r): a claims read that broke since the confirm rides the
        // result, as destroy's does.
        return newAdvisories.length > 0
          ? { ...result, warnings: [...((result as { warnings?: string[] }).warnings ?? []), ...newAdvisories] }
          : result
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })
}
