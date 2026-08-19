import type { AhrPool, SnapshotSchedule as SnapshotScheduleT, SnapshotTarget } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import { ScheduleId, SnapshotSchedule } from '@anas/shared'
import { PVE_STORAGE_CFG, readPveStorages, readZfsMountpoints } from '../parsers/pve-storage.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { notifyScheduleRun } from '../services/snapshot-notify.js'
import {
  collectScheduleStatuses,
  deriveScheduleDetail,
  readSchedule,
  removeScheduleUnits,
  scheduleFileExists,
  writeScheduleUnits,
} from '../services/snapshot-schedule-units.js'
import { pruneSnapshots, takeSnapshot } from '../services/snapshot-schedules.js'
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
 *   PUT    /v1/schedules/:id        → update/rewrite (incl. toggle enabled)
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
   * Story 3.25 boundary guard: is the pool PVE-managed (referenced by
   * storage.cfg)? Fail-open (non-PVE host / unreadable config → false), exactly
   * as the replication task guard.
   */
  async function isPveManagedPool(poolName: string): Promise<boolean> {
    try {
      const refs = await readPveStorages(PVE_STORAGE_CFG, await readZfsMountpoints())
      return (refs.get(poolName) ?? []).length > 0
    }
    catch {
      return false
    }
  }

  /** Resolve an AHR target's pool from live topology, or null. */
  async function resolveAhrPool(poolName: string): Promise<AhrPool | null> {
    return (await readAhrPools(executor)).find(p => p.name === poolName) ?? null
  }

  /**
   * Validate that a schedule's target exists and is ANAS-manageable (SCHEDULES-
   * DESIGN: ANAS-managed pools/datasets only; PVE-managed pools stay hands-off).
   * Sends the appropriate 4xx and returns false on the first failure.
   */
  async function guardTarget(target: SnapshotTarget, reply: FastifyReply): Promise<boolean> {
    if (target.kind === 'zfs') {
      const pool = target.dataset.split('/')[0]
      if (!(await zpoolExists(pool))) {
        reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Pool '${pool}' does not exist` } })
        return false
      }
      if (await isPveManagedPool(pool)) {
        reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Pool '${pool}' is PVE-managed — ANAS does not schedule snapshots there` } })
        return false
      }
      if (!(await zfsDatasetExists(target.dataset))) {
        reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Dataset '${target.dataset}' does not exist` } })
        return false
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

  /** Fire a schedule once: take a snapshot into its cadence bucket, then prune. */
  async function fireSchedule(
    schedule: SnapshotScheduleT,
    updateProgress: (message: string) => void,
  ): Promise<{ schedule: string, taken: string, pruned: string[], skippedHeld: string[] }> {
    const svcOpts = schedule.target.kind === 'ahr'
      ? { pool: (await resolveAhrPool(schedule.target.pool)) ?? undefined, runtimeDir: subvolRuntimeDir, updateProgress }
      : { recursive: schedule.recursive, updateProgress, runtimeDir: subvolRuntimeDir }
    const take = await takeSnapshot(executor, schedule.target, schedule.cadence, svcOpts)
    updateProgress(`Took ${take.name}; pruning per retention`)
    const prune = await pruneSnapshots(executor, schedule.target, schedule.retention, svcOpts)
    return {
      schedule: schedule.id,
      taken: take.name,
      pruned: prune.pruned.map(s => s.name),
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
    if (!(await guardTarget(schedule.target, reply)))
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
    if (!(await guardTarget(schedule.target, reply)))
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
