import type { AhrPool, SnapshotScheduleRunResult, SnapshotSchedule as SnapshotScheduleT, SnapshotTarget } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import { PRUNED_NAMES_PER_DATASET, ScheduleId, SnapshotSchedule } from '@anas/shared'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { loadPveFootprint, pveDescendantsUnlistedMessage, pveRecursiveRefusalMessage } from '../services/pve-footprint.js'
import { notifyScheduleRun } from '../services/snapshot-notify.js'
import {
  collectScheduleStatuses,
  deriveScheduleDetail,
  readSchedule,
  readScheduleList,
  removeScheduleUnits,
  scheduleFileExists,
  writeScheduleUnits,
} from '../services/snapshot-schedule-units.js'
import { pruneRecursiveSchedule, pruneSnapshots, recursiveRunResult, takeSnapshot } from '../services/snapshot-schedules.js'
import { sweepSet, zfsTreeListArgs } from '../services/zfs-snapshot.js'
import { requireIdentity } from './identity.js'

const ZFS = '/usr/sbin/zfs'
const ZPOOL = '/usr/sbin/zpool'

/**
 * Uniform snapshot SCHEDULES (Epic 17.3/17.4). The store IS the systemd units
 * (see services/snapshot-schedule-units.ts) — these routes generate/parse/rewrite
 * them; there is no second config source. One uniform surface for a ZFS dataset
 * and an AHR pool; only `target.kind` decides the backend.
 *
 *   GET    /v1/schedules            → derived statuses (systemd + the store)
 *   POST   /v1/schedules            → create (write units, enable timer)
 *   GET    /v1/schedules/:id        → one schedule
 *   PUT    /v1/schedules/:id        → update/rewrite (incl. toggle enabled); the
 *                                     TARGET is immutable — retarget = delete + create
 *   DELETE /v1/schedules/:id        → remove units (NEVER touches snapshots)
 *   POST   /v1/schedules/:id/run    → fire now: take + prune (the timer's own path)
 *
 * These are CONFIG mutations (surgical unit-file writes), identity-gated and
 * journald-audited exactly like replication/backup tasks: each write runs through
 * the job queue (202 → { job }); a fire returns 202 → { job } whose result is the
 * take+prune outcome. Reads are plain (no job, no identity).
 */
export interface ScheduleRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  /** systemd unit directory (the schedule store). Overridable for tests. */
  systemdDir: string
  /** On-demand AHR top-level mount base (tests point at a temp dir). */
  subvolRuntimeDir?: string
}

export async function scheduleRoutes(server: FastifyInstance, opts: ScheduleRouteOptions) {
  const { executor, jobQueue, systemdDir, subvolRuntimeDir } = opts

  /** Does the named ZFS pool exist? (source of truth is `zpool list`). */
  async function zpoolExists(poolName: string): Promise<boolean> {
    const r = await executor.exec(ZPOOL, ['list', '-j'])
    const pools = r.exitCode === 0 && r.stdout.trim() ? parseZpoolList(r.stdout) : []
    return pools.some(p => p.name === poolName)
  }

  /** Does a ZFS dataset exist? (`zfs list -H -o name <ds>` exit 0). */
  async function zfsDatasetExists(dataset: string): Promise<boolean> {
    const r = await executor.exec(ZFS, ['list', '-H', '-o', 'name', dataset])
    return r.exitCode === 0
  }

  /**
   * The dataset and every filesystem/volume beneath it (the take's own
   * `zfs list -H -o name -r -t filesystem,volume`; without `-t` a pool with
   * `listsnapshots=on` lists snapshots too) — the candidate list for the
   * recursive-schedule descendant guard (pvepool.1 review fix 2). `null`
   * when the probe FAILED (pvepool.1 review fix 4): a
   * failed probe must never read as "no descendants" — the guard refuses the
   * recursive verb with {@link pveDescendantsUnlistedMessage} instead of
   * letting a sweep it cannot see through. A successful read with no rows is
   * a genuine "no descendants" (`[]`).
   */
  async function descendantDatasetNames(dataset: string): Promise<string[] | null> {
    const r = await executor.exec(ZFS, zfsTreeListArgs(dataset))
    if (r.exitCode !== 0)
      return null
    return r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  }

  /**
   * Story pvepool.1 boundary guard: refuse only a schedule whose TARGET dataset
   * PVE owns — a storage root, a guest volume, a dir-storage tree or the boot
   * tree (the ownership reason names the storage AND the dataset). A sibling
   * dataset on a PVE pool is a legitimate schedule target; the pool itself is
   * never the question (the old pool-level `isPveManagedPool` probe is gone).
   * Fail-open (non-PVE host / unreadable config → no ownership), exactly as the
   * replication target guard.
   */
  async function pveFootprint() {
    return loadPveFootprint(executor)
  }

  /** Resolve an AHR target's pool from live topology, or null. */
  async function resolveAhrPool(poolName: string): Promise<AhrPool | null> {
    return (await readAhrPools(executor)).find(p => p.name === poolName) ?? null
  }

  /**
   * The recursive-schedule refusal for a PVE-owned descendant (pvepool.1
   * review fix 2) with the snapx.1 way out appended: the owned dataset can be
   * excluded from the schedule, which snapshots the rest of the tree.
   */
  function ownedDescendantRefusal(verb: string, dataset: string, hit: Parameters<typeof pveRecursiveRefusalMessage>[2]): string {
    return `${pveRecursiveRefusalMessage(verb, dataset, hit)}. Exclude '${hit.name}' from the schedule to snapshot the rest of '${dataset}'`
  }

  /**
   * Validate that a schedule's target exists and is ANAS-manageable (SCHEDULES-
   * DESIGN: ANAS-managed pools/datasets only; PVE-OWNED DATASETS stay hands-off —
   * pvepool.1). `recursive` schedules are additionally refused when any STRICT
   * descendant of the target is PVE-owned (pvepool.1 review fix 2): a recursive
   * schedule sweeps the subtree, and a storage registered on a nested path
   * leaves the tree above it unowned.
   *
   * snapx.1: the descendant guard runs on the tree MINUS the `exclude`
   * subtrees — what the schedule actually snapshots — so "hourly on the pool,
   * guest volumes excluded" is accepted. Each exclude entry must exist in the
   * live tree (its shape — strict descendant, recursive only — the shared
   * schema already holds), except an entry `priorExclude` already carried: a
   * child destroyed after the schedule was saved must not turn an enable
   * toggle into a 400 (the runner treats a vanished entry as inert).
   * Sends the appropriate 4xx and returns false on the first failure.
   */
  async function guardTarget(
    target: SnapshotTarget,
    recursive: boolean,
    reply: FastifyReply,
    exclude: string[] = [],
    priorExclude: string[] = [],
  ): Promise<boolean> {
    if (target.kind === 'zfs') {
      const pool = target.dataset.split('/')[0]
      if (!(await zpoolExists(pool))) {
        reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Pool '${pool}' does not exist` } })
        return false
      }
      // A storage root IS owned (kind 'storage-root'), so this one check covers
      // both: an owned target of any kind, and the recursive schedule on a
      // storage root that sweeps guest zvols.
      const pve = await pveFootprint()
      const owned = pve.ownershipOf(target.dataset)
      if (owned) {
        reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Cannot schedule snapshots of '${target.dataset}' — ${owned.reason}` } })
        return false
      }
      if (!(await zfsDatasetExists(target.dataset))) {
        reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Dataset '${target.dataset}' does not exist` } })
        return false
      }
      if (recursive) {
        // pvepool.1 review fix 4: a failed probe is not "no descendants" —
        // the recursive verb is refused until the subtree can be listed.
        const descendants = await descendantDatasetNames(target.dataset)
        if (descendants === null) {
          reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: pveDescendantsUnlistedMessage('snapshot schedule', target.dataset) } })
          return false
        }
        for (const name of exclude) {
          if (!priorExclude.includes(name) && !descendants.includes(name)) {
            reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Exclude '${name}' does not exist under '${target.dataset}'` } })
            return false
          }
        }
        const swept = sweepSet({ target, recursive: true, exclude }, descendants)
        const descendant = pve.ownedDescendant(swept, target.dataset)
        if (descendant) {
          reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: ownedDescendantRefusal('Snapshot schedule', target.dataset, descendant) } })
          return false
        }
      }
      return true
    }
    // AHR target: the pool must exist and carry the §12 subvolume layout (only
    // those pools can be snapshotted — mirrors the AHR snapshot routes).
    const pool = await resolveAhrPool(target.pool)
    if (!pool) {
      reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `AHR pool '${target.pool}' not found` } })
      return false
    }
    if (!pool.subvolLayout) {
      reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `AHR pool '${target.pool}' uses the pre-snapshot flat layout — snapshots are unavailable (§12)` } })
      return false
    }
    return true
  }

  /**
   * A target rendered as one comparable string ('zfs:tank/media' / 'ahr:media')
   * — what the schedule actually snapshots, independent of key order.
   */
  function targetKey(target: SnapshotTarget): string {
    return target.kind === 'zfs' ? `zfs:${target.dataset}` : `ahr:${target.pool}`
  }

  /** Fire a schedule once: take a snapshot into its cadence bucket, then prune. */
  async function fireSchedule(
    schedule: SnapshotScheduleT,
    updateProgress: (message: string) => void,
  ): Promise<SnapshotScheduleRunResult> {
    // pvepool.1 review fixes — the RUN-TIME re-check. Ownership was asked when
    // the schedule was created/updated, but storage.cfg is LIVE: PVE can claim
    // a dataset after the schedule exists. The timer's runner
    // (snapshot-task.js) and a manual Run Now both converge on THIS job, so
    // the re-check lives here, not in a route: an owned target — or, for a
    // recursive schedule, an owned descendant — FAILS the run with the reason
    // (the job error, and the 9.4 notification's), never a silent skip.
    // Reads/footprint may fail closed (unreadable storage.cfg = everything
    // owned) exactly like the create guard. An AHR target is not PVE-footprint
    // territory.
    let pve: Awaited<ReturnType<typeof pveFootprint>> | null = null
    if (schedule.target.kind === 'zfs') {
      pve = await pveFootprint()
      const owned = pve.ownershipOf(schedule.target.dataset)
      if (owned)
        throw new Error(`Snapshot run refused: '${schedule.target.dataset}' is PVE-owned — ${owned.reason}`)
      if (schedule.recursive === true) {
        // pvepool.1 review fix 4: a failed probe fails the run with the
        // refusal — never a sweep the daemon could not see.
        const descendants = await descendantDatasetNames(schedule.target.dataset)
        if (descendants === null)
          throw new Error(pveDescendantsUnlistedMessage('snapshot run', schedule.target.dataset))
        // snapx.1: the same tree the take covers — excluded subtrees are not
        // swept, so an owned dataset inside one does not fail the run.
        const swept = sweepSet(schedule, descendants)
        const descendant = pve.ownedDescendant(swept, schedule.target.dataset)
        if (descendant)
          throw new Error(ownedDescendantRefusal('Snapshot run', schedule.target.dataset, descendant))
      }
    }
    const svcOpts = schedule.target.kind === 'ahr'
      ? { pool: (await resolveAhrPool(schedule.target.pool)) ?? undefined, runtimeDir: subvolRuntimeDir, updateProgress }
      : { recursive: schedule.recursive, exclude: schedule.exclude, updateProgress, runtimeDir: subvolRuntimeDir }
    const take = await takeSnapshot(executor, schedule.target, schedule.cadence, svcOpts)
    updateProgress(`Took ${take.name}; pruning per retention`)
    if (schedule.target.kind === 'zfs' && schedule.recursive === true && pve) {
      // snapprune.1: retention reaches every dataset the schedule snapshots,
      // per dataset. The other schedules come from the unit files (the store)
      // so a dataset another enabled schedule covers is judged by its policy
      // too. The read says whether it is COMPLETE: a partial list (unlistable
      // dir, unreadable or unparseable unit) prunes the target only — nothing
      // is destroyed on swept children or excluded datasets that run. A
      // destroy ZFS refuses on a swept or excluded dataset is noted there
      // and the run completes with warnings. The result names at most
      // PRUNED_NAMES_PER_DATASET destroyed snapshots per dataset.
      const prune = await pruneRecursiveSchedule(executor, schedule, {
        others: await readScheduleList(systemdDir),
        updateProgress,
      })
      return recursiveRunResult(schedule, take.name, prune)
    }
    const prune = await pruneSnapshots(executor, schedule.target, schedule.retention, svcOpts)
    return {
      schedule: schedule.id,
      taken: take.name,
      pruned: prune.pruned.slice(0, PRUNED_NAMES_PER_DATASET).map(s => s.name),
      prunedCount: prune.pruned.length,
      skippedHeld: prune.skippedHeld.map(s => s.name),
    }
  }

  // --- GET /schedules — derived statuses (read-only) ------------------------
  server.get('/schedules', async () => {
    return { data: await collectScheduleStatuses(executor, systemdDir) }
  })

  // --- POST /schedules — create ---------------------------------------------
  server.post('/schedules', async (request, reply) => {
    const bodyParsed = SnapshotSchedule.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid snapshot schedule: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const schedule = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // 409 if the schedule already exists — the unit files are the source of truth.
    if (await scheduleFileExists(systemdDir, schedule.id)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Snapshot schedule '${schedule.id}' already exists` } }
    }
    if (!(await guardTarget(schedule.target, schedule.recursive === true, reply, schedule.exclude)))
      return reply

    const job = jobQueue.submit(
      'schedule.create',
      { ...identity, params: { schedule: schedule.id } },
      async () => {
        await writeScheduleUnits(executor, systemdDir, schedule)
        return { created: schedule.id }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- GET /schedules/:id — one schedule's DETAIL ---------------------------
  // The status fields PLUS the last run's exit code, the unit files as written,
  // and a recent journald blob — the SAME last-run logs + exit-status surface as
  // a backup task's detail (GET /backup/tasks/:name). Read-only (no job/identity).
  server.get<{ Params: { id: string } }>('/schedules/:id', async (request, reply) => {
    const idParsed = ScheduleId.safeParse(request.params.id)
    if (!idParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid schedule id: ${idParsed.error.issues[0]?.message}` } }
    }
    const schedule = await readSchedule(systemdDir, idParsed.data)
    if (!schedule) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot schedule '${idParsed.data}' not found` } }
    }
    return { data: await deriveScheduleDetail(executor, systemdDir, schedule) }
  })

  // --- PUT /schedules/:id — update / rewrite --------------------------------
  server.put<{ Params: { id: string } }>('/schedules/:id', async (request, reply) => {
    const idParsed = ScheduleId.safeParse(request.params.id)
    if (!idParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid schedule id: ${idParsed.error.issues[0]?.message}` } }
    }
    const id = idParsed.data

    const bodyParsed = SnapshotSchedule.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid snapshot schedule: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const schedule = bodyParsed.data
    // The URL is the identity; a body renaming the id is rejected (rename =
    // delete + create, not an in-place edit).
    if (schedule.id !== id) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Schedule id in body ('${schedule.id}') does not match URL ('${id}')` } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await scheduleFileExists(systemdDir, id))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot schedule '${id}' not found` } }
    }

    // The TARGET is part of a schedule's identity, exactly like its id: what it
    // snapshots is what it IS. An in-place edit changes policy — cadence,
    // retention, notify, enabled — never the filesystem underneath. Repointing
    // is delete + create, which the UI already assumes (the target fields are
    // read-only on edit), so enforcing it here costs nothing and closes the
    // whole class: a dialog that fell back to the first pool of a
    // fail-open-empty inventory can no longer rewrite a schedule onto a
    // different filesystem.
    const stored = await readSchedule(systemdDir, id)
    if (stored && targetKey(stored.target) !== targetKey(schedule.target)) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: `Snapshot schedule '${id}' targets ${targetKey(stored.target)}; an edit cannot move it to `
            + `${targetKey(schedule.target)} — delete the schedule and create one for the new target`,
        },
      }
    }
    if (!(await guardTarget(schedule.target, schedule.recursive === true, reply, schedule.exclude, stored?.exclude)))
      return reply

    const job = jobQueue.submit(
      'schedule.update',
      { ...identity, params: { schedule: id } },
      async () => {
        await writeScheduleUnits(executor, systemdDir, schedule)
        return { updated: id }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- DELETE /schedules/:id — remove the units -----------------------------
  // Removes the service + timer only. It DOES NOT touch the snapshots the
  // schedule created — deleting a schedule is not deleting its snapshots.
  server.delete<{ Params: { id: string } }>('/schedules/:id', async (request, reply) => {
    const idParsed = ScheduleId.safeParse(request.params.id)
    if (!idParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid schedule id: ${idParsed.error.issues[0]?.message}` } }
    }
    const id = idParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await scheduleFileExists(systemdDir, id))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot schedule '${id}' not found` } }
    }

    const job = jobQueue.submit(
      'schedule.remove',
      { ...identity, params: { schedule: id } },
      async () => {
        await removeScheduleUnits(executor, systemdDir, id)
        return { removed: id }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /schedules/:id/run — fire now: take + prune ---------------------
  // The SAME operation the timer's runner performs; a manual Run-Now and the
  // scheduled fire converge on one code path. Runs the take + prune directly in
  // the daemon (no systemctl re-entry).
  server.post<{ Params: { id: string } }>('/schedules/:id/run', async (request, reply) => {
    const idParsed = ScheduleId.safeParse(request.params.id)
    if (!idParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid schedule id: ${idParsed.error.issues[0]?.message}` } }
    }
    const id = idParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const schedule = await readSchedule(systemdDir, id)
    if (!schedule) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot schedule '${id}' not found` } }
    }

    const job = jobQueue.submit(
      'schedule.run',
      { ...identity, params: { schedule: id } },
      async (updateProgress) => {
        // 9.4: this job is the ONE place every fire converges (the timer's
        // runner and a UI Run Now both submit it), so it is also the one place
        // a run notification is emitted — success, warning (a prune that had to
        // skip held snapshots) or failure, gated by the SCHEDULE'S OWN mode
        // (`schedule.notify`, which rode in with the unit JSON). Best-effort by
        // contract: notifyScheduleRun never throws, so a broken mail target
        // cannot turn a good snapshot into a failed job.
        const startedAt = Date.now()
        try {
          const result = await fireSchedule(schedule, updateProgress)
          await notifyScheduleRun(executor, { schedule, result, elapsedMs: Date.now() - startedAt })
          return result
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await notifyScheduleRun(executor, { schedule, error: message, elapsedMs: Date.now() - startedAt })
          throw err
        }
      },
    )
    reply.code(202)
    return { job }
  })
}
