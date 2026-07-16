import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import { ReplicationTask, ReplicationTaskName } from '@anas/shared'
import { PVE_STORAGE_CFG, readPveStorages, readZfsMountpoints } from '../parsers/pve-storage.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import {
  collectTaskStatuses,
  removeTaskUnits,
  resolveTaskDatasets,
  serviceUnitName,
  taskFileExists,
  validateSchedule,
  writeTaskUnits,
} from '../services/replication-units.js'
import { requireIdentity } from './identity.js'

const ZPOOL = '/usr/sbin/zpool'
const SYSTEMCTL = '/usr/bin/systemctl'

/**
 * Recurring replication TASKS (Epic 5.5.3). The store IS the systemd units
 * (see services/replication-units.ts) — these routes generate/parse/rewrite
 * them; there is no second config source.
 *
 *   GET    /v1/replication/tasks          → derived statuses (ZFS + systemd)
 *   POST   /v1/replication/tasks          → create (write units, enable timer)
 *   PUT    /v1/replication/tasks/:name    → update/rewrite (incl. toggle enabled)
 *   DELETE /v1/replication/tasks/:name    → remove units (NEVER touches data)
 *   POST   /v1/replication/tasks/:name/run→ fire the real unit (systemctl start)
 *
 * These are CONFIG mutations (surgical unit-file writes), not storage mutations.
 * They are identity-gated and journald-audited exactly like the share routes:
 * each write runs through the job queue as a quick job (202 → { job }); the
 * run trigger returns { started: true }. Reads are plain (no job, no identity),
 * and every guard reuses the stage-1 reasoning.
 */
export interface ReplicationTaskRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  /** systemd unit directory (the task store). Overridable for tests. */
  systemdDir: string
}

export async function replicationTaskRoutes(
  server: FastifyInstance,
  opts: ReplicationTaskRouteOptions,
) {
  const { executor, jobQueue, systemdDir } = opts

  /**
   * Does the named pool exist? (source of truth is `zpool list`). Same probe
   *  the stage-1 replicate guard uses.
   */
  async function poolExists(poolName: string): Promise<boolean> {
    const r = await executor.exec(ZPOOL, ['list', '-j'])
    const pools = r.exitCode === 0 && r.stdout.trim() ? parseZpoolList(r.stdout) : []
    return pools.some(p => p.name === poolName)
  }

  /**
   * Story 3.25 boundary guard: is the pool PVE-managed (referenced by
   *  storage.cfg)? Fail-open (non-PVE host / unreadable config → false), exactly
   *  as the stage-1 replicate guard.
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

  /**
   * The shared create/update guards (reused from the stage-1 replicate handler):
   * the schedule must be valid systemd calendar syntax, the target pool must
   * exist and NOT be PVE-managed, and a task may not replicate a dataset onto
   * itself. Sends the appropriate 4xx and returns false on the first failure.
   */
  async function guardTask(task: ReplicationTask, reply: FastifyReply): Promise<boolean> {
    const schedule = await validateSchedule(executor, task.schedule)
    if (!schedule.ok) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid schedule '${task.schedule}': ${schedule.error}` } })
      return false
    }
    if (!(await poolExists(task.target.pool))) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Target pool '${task.target.pool}' does not exist` } })
      return false
    }
    if (await isPveManagedPool(task.target.pool)) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Target pool '${task.target.pool}' is PVE-managed — ANAS does not create datasets there` } })
      return false
    }
    const { sourceFull, targetFull } = resolveTaskDatasets(task)
    if (sourceFull === targetFull) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Cannot replicate '${sourceFull}' onto itself — choose a different target` } })
      return false
    }
    return true
  }

  // --- GET /replication/tasks — derived statuses (read-only) ----------------
  server.get('/replication/tasks', async () => {
    return { data: await collectTaskStatuses(executor, systemdDir) }
  })

  // --- POST /replication/tasks — create -------------------------------------
  server.post('/replication/tasks', async (request, reply) => {
    const bodyParsed = ReplicationTask.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid replication task: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const task = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // 409 if the task already exists — the unit files are the source of truth.
    if (await taskFileExists(systemdDir, task.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Replication task '${task.name}' already exists` } }
    }

    if (!(await guardTask(task, reply)))
      return reply

    const job = jobQueue.submit(
      'replication.task.create',
      { ...identity, params: { task: task.name } },
      async () => {
        await writeTaskUnits(executor, systemdDir, task)
        return { created: task.name }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- PUT /replication/tasks/:name — update / rewrite ----------------------
  server.put<{ Params: { name: string } }>('/replication/tasks/:name', async (request, reply) => {
    const nameParsed = ReplicationTaskName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = ReplicationTask.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid replication task: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const task = bodyParsed.data
    // The URL is the identity; a body renaming the task is rejected (rename =
    // delete + create, not an in-place edit).
    if (task.name !== name) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Task name in body ('${task.name}') does not match URL ('${name}')` } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await taskFileExists(systemdDir, name))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Replication task '${name}' not found` } }
    }

    if (!(await guardTask(task, reply)))
      return reply

    const job = jobQueue.submit(
      'replication.task.update',
      { ...identity, params: { task: name } },
      async () => {
        // Rewrite both units and re-sync the timer to `enabled` (toggle support).
        await writeTaskUnits(executor, systemdDir, task)
        return { updated: name }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- DELETE /replication/tasks/:name — remove the units -------------------
  // Removes the service + timer only. It DOES NOT touch replicated data,
  // snapshots, or the `anas-repl` holds — deleting a schedule is not deleting a
  // backup. The target dataset and its snapshots remain exactly as they are.
  server.delete<{ Params: { name: string } }>('/replication/tasks/:name', async (request, reply) => {
    const nameParsed = ReplicationTaskName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await taskFileExists(systemdDir, name))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Replication task '${name}' not found` } }
    }

    const job = jobQueue.submit(
      'replication.task.remove',
      { ...identity, params: { task: name } },
      async () => {
        await removeTaskUnits(executor, systemdDir, name)
        return { removed: name }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /replication/tasks/:name/run — fire the real unit now -----------
  // Triggers the actual systemd service so systemd records this run (and the
  // job history / lag update flow from the same units the timer uses).
  server.post<{ Params: { name: string } }>('/replication/tasks/:name/run', async (request, reply) => {
    const nameParsed = ReplicationTaskName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await taskFileExists(systemdDir, name))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Replication task '${name}' not found` } }
    }

    // Fire-and-return: `--no-block` starts the oneshot without waiting for it to
    // finish, so the trigger is instant and systemd owns the run. Audited via the
    // quick job below.
    jobQueue.submit(
      'replication.task.run',
      { ...identity, params: { task: name } },
      async () => {
        const r = await executor.exec(SYSTEMCTL, ['start', '--no-block', serviceUnitName(name)])
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `systemctl start ${serviceUnitName(name)} exited with code ${r.exitCode}`)
        return { started: name }
      },
    )
    reply.code(202)
    return { started: true }
  })
}
