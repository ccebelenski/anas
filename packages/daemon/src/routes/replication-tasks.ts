import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { GuardSpec, ObjectView, Refusal } from '../safety/guard.js'
import type { Transport } from '../services/replication-transport.js'
import type { TargetNamesResolver } from '../services/replication-units.js'
import type { UnitTaskObject } from '../services/task-units.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ReplicationTask, ReplicationTaskName } from '@anas/shared'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { guardCheck, guarded, sendRefusal, taskClaim } from '../safety/guard.js'
import { loadPveFootprint } from '../services/pve-footprint.js'
import { guardReplicationTarget } from '../services/replication-target.js'
import {
  collectTaskStatuses,
  readTask,
  removeTaskUnits,
  resolveTaskDatasets,
  serviceUnitName,
  taskFileExists,
  timerUnitName,
  validateSchedule,
  writeTaskUnits,
} from '../services/replication-units.js'
import { activeRunDeleteRefusal, readUnitStoreEntry, readUnitTaskObject, runStateUnreadableRefusal, serviceUnitRevision } from '../services/task-units.js'
import { isRunActive, showUnitPropsStrict } from '../services/unit-run-status.js'
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
  /**
   * Stage-3 SSH transport. It lets task STATUS read a non-local target's
   * snapshots (so lag/last-replicated are real for remote tasks) AND it is how
   * a task's target is validated where it actually lives — a peer's pool is not
   * in this node's `zpool list` (issue #46). Required: without it a non-local
   * task could only be judged against the wrong machine.
   */
  transport: Transport
}

export async function replicationTaskRoutes(
  server: FastifyInstance,
  opts: ReplicationTaskRouteOptions,
) {
  const { executor, jobQueue, systemdDir, transport } = opts

  /**
   * Resolve a NON-local task target's snapshot names over the SSH transport.
   * Any transport/resolution failure → null (unknown), never a false
   * "everything is behind".
   */
  const remoteTargetNames: TargetNamesResolver = async (task, targetFull) => {
    try {
      const res = await transport.resolveLocation(task.target.location!)
      if (!res.ok)
        return null
      const names = await transport.remoteSnapshotNames(res.resolved, targetFull)
      return new Set(names)
    }
    catch {
      return null
    }
  }

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
   * Story pvepool.1: the ONE footprint service answers "does PVE own this
   * dataset?" for the target guard — the target DATASET is judged, not the
   * pool (the old pool-level `isPveManagedPool` probe is gone).
   */
  const pveFootprint = () => loadPveFootprint(executor)

  /**
   * The create/update guards: the schedule must be valid systemd calendar
   * syntax, the SOURCE pool must exist HERE, and the target must pass the
   * location-aware target guards. Sends the appropriate 4xx and returns false on
   * the first failure.
   *
   * ⚠ The target guards are NOT re-derived here (issue #46). They used to be a
   * stage-1 copy that asked `zpool list` — this node's pools — about EVERY
   * target, so a task replicating to a peer or a registered remote was rejected
   * with "Target pool 'x' does not exist" whenever that pool's name did not also
   * exist locally, and could be rejected as PVE-managed or as replicating "onto
   * itself" on the strength of a same-named LOCAL dataset. One-shot replicate
   * and recurring task now call the SAME guard, which resolves the location
   * first and asks the machine the target actually lives on.
   */
  async function guardTask(task: ReplicationTask, reply: FastifyReply): Promise<boolean> {
    const schedule = await validateSchedule(executor, task.schedule)
    if (!schedule.ok) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid schedule '${task.schedule}': ${schedule.error}` } })
      return false
    }
    // The SOURCE is always local (a task reads from this node and sends outward),
    // so `zpool list` is authoritative for it. It was never checked: a task could
    // be written pointing at a pool that does not exist, and only fail at 03:00
    // in a timer run.
    if (!(await poolExists(task.source.pool))) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Source pool '${task.source.pool}' does not exist` } })
      return false
    }
    const { sourceFull, targetFull } = resolveTaskDatasets(task)
    const guard = await guardReplicationTarget(
      { transport, poolExists, pveFootprint },
      { target: task.target, sourceFull, targetFull },
    )
    if (!guard.ok) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: guard.message } })
      return false
    }
    return true
  }

  /**
   * A task's DATA IDENTITY: what it reads and where it writes. Rendered as one
   * comparable string so an edit can be checked against the stored task without
   * caring about key order or an absent-vs-'local' location.
   */
  function endpoints(task: ReplicationTask): { source: string, target: string } {
    const loc = task.target.location
    const where = loc && loc.kind !== 'local' ? `${loc.kind}:${loc.name ?? ''}` : 'local'
    const sourceRel = task.source.dataset || ''
    // An absent and an empty target dataset are the SAME instruction ("the
    // source's own relative path"), so they must compare equal — a round-trip
    // through a client that drops the empty string is not a move.
    const targetRel = task.target.dataset || sourceRel
    return {
      source: sourceRel ? `${task.source.pool}/${sourceRel}` : task.source.pool,
      target: `${where}:${task.target.pool}${targetRel ? `/${targetRel}` : ''}`,
    }
  }

  /**
   * The replication unit store's service/timer text — this store has no
   * `readUnitTexts` of its own (it predates the task-units extraction), and the
   * update spec's revision hashes the ACTUAL stored bytes, never a re-render.
   */
  async function readReplicationUnitText(dir: string, name: string): Promise<{ unit: string, timer: string }> {
    const [unit, timer] = await Promise.all([
      readFile(join(dir, serviceUnitName(name)), 'utf-8').catch(() => ''),
      readFile(join(dir, timerUnitName(name)), 'utf-8').catch(() => ''),
    ])
    return { unit, timer }
  }

  /**
   * The guard specs of the replication-task verbs (story cr.41, WAVE3-DESIGN
   * §3.3 Unit-store row + the operator's Q1 ruling). One spec per verb, both
   * doors; locks are `task:replication:<name>` — exclusive for create, update
   * and delete, shared for a run trigger (§4.2).
   */
  const replicationTaskView = (name: string): ObjectView<UnitTaskObject<ReplicationTask>> => ({
    what: `Replication task '${name}'`,
    read: () => readUnitTaskObject(readTask, readReplicationUnitText, systemdDir, name),
    id: async o => ({ task: o.task.name }),
    notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `Replication task '${name}' not found` }),
    unbound: () => `Could not read replication task '${name}' — refusing`,
  })

  /**
   * The Q1 active-run gate. A replication run's only durable "active" signal is
   * the unit systemd reports in a still-running state — the trigger job
   * (`replication.task.run`) is a fire-and-return, and the send itself is a
   * `zfs.replicate` job that carries no task name. The unit check covers both
   * (the runner keeps the unit active while it polls the send). cr.41b: the
   * read FAILS CLOSED — a `systemctl show` that cannot answer refuses (a
   * `zfs.replicate` send can run for hours and shows only as the unit), because
   * an unreadable run state is not evidence the run is over.
   */
  async function replicationTaskActiveRunRefusal(name: string): Promise<Refusal | null> {
    const runJob = jobQueue.findActive('replication.task.run', name, 'task')
    if (runJob)
      return activeRunDeleteRefusal(`Replication task '${name}'`, { job: runJob })
    try {
      const props = await showUnitPropsStrict(executor, serviceUnitName(name), 'ActiveState')
      if (isRunActive(props))
        return activeRunDeleteRefusal(`Replication task '${name}'`, { unit: { service: serviceUnitName(name), since: null } })
      return null
    }
    catch {
      return runStateUnreadableRefusal(`Replication task '${name}'`)
    }
  }

  function replicationTaskCreateSpec(name: string): GuardSpec<{ existing: ReplicationTask | null }> {
    return {
      operation: 'replication.task.create',
      object: {
        what: `Replication task '${name}'`,
        read: async () => ({ existing: await readTask(systemdDir, name) }),
        id: async () => ({ task: name }),
        unbound: () => `Could not read replication tasks — refusing`,
      },
      gates: [async o => (o.existing
        ? { status: 409, code: 'CONFLICT', message: `Replication task '${name}' already exists` }
        : null)],
      locks: async () => [taskClaim('replication', name, 'exclusive')],
    }
  }

  function replicationTaskUpdateSpec(name: string): GuardSpec<UnitTaskObject<ReplicationTask>> {
    return {
      operation: 'replication.task.update',
      object: { ...replicationTaskView(name), revision: async o => serviceUnitRevision(o.unit) },
      gates: [],
      locks: async () => [taskClaim('replication', name, 'exclusive')],
    }
  }

  function replicationTaskDeleteSpec(name: string): GuardSpec<{ unit: string, timer: string }> {
    return {
      operation: 'replication.task.remove',
      // cr.41b: the delete's object is the unit AS STORED — the stores' own
      // existence (a `.service` on disk), never the parsed task. A unit whose
      // X-ANAS-Task no longer parses (a hand edit; a task an older ANAS wrote)
      // is skipped by the list AND by a parsed-object read, which would answer
      // 404 on exactly the unit the operator needs to remove — this read makes
      // it deletable. The UPDATE spec above stays bound to the parsed object:
      // an edit cannot be bound to bytes that do not parse — 404 not-found is
      // right there.
      object: {
        what: `Replication task '${name}'`,
        read: () => readUnitStoreEntry(readReplicationUnitText, systemdDir, name),
        id: async () => ({ task: name }),
        notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `Replication task '${name}' not found` }),
        unbound: () => `Could not read replication task '${name}' — refusing`,
      },
      gates: [async () => replicationTaskActiveRunRefusal(name)],
      locks: async () => [taskClaim('replication', name, 'exclusive')],
    }
  }

  // --- GET /replication/tasks — derived statuses (read-only) ----------------
  server.get('/replication/tasks', async () => {
    return { data: await collectTaskStatuses(executor, systemdDir, remoteTargetNames) }
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

    // Story cr.41: the create's existence gate runs here AND again in the job
    // under the `task:replication:<name>` name key — two creates of one name
    // cannot both pass a check made before either wrote.
    const spec = replicationTaskCreateSpec(task.name)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    if (!(await guardTask(task, reply)))
      return reply

    const job = jobQueue.submit(
      'replication.task.create',
      { ...identity, params: { task: task.name } },
      guarded(spec, pre, async () => {
        await writeTaskUnits(executor, systemdDir, task)
        return { created: task.name }
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  // --- PUT /replication/tasks/:name — update / rewrite ----------------------
  // A PUT that MOVES the task's source or target must say so: `?retarget=true`.
  // Editing a schedule or a notify mode is routine; changing where the data
  // comes from or goes is a different operation wearing the same clothes, and an
  // edit dialog that silently substitutes a value it could not find in a
  // freshly-loaded inventory would otherwise rewrite the destination without
  // anyone deciding to. The flag is the CLIENT DECLARING INTENT, and it is
  // opt-in so that a client which knows nothing about it cannot retarget at all.
  server.put<{ Params: { name: string }, Querystring: { retarget?: string } }>('/replication/tasks/:name', async (request, reply) => {
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

    // Story cr.41: the update is BOUND to the stored task's revision (the
    // actual service unit bytes' sha256) — an edit whose unit changed meanwhile
    // refuses STATE_CHANGED, and one whose task was deleted refuses not-found,
    // so an update can never resurrect a deleted replication task.
    const spec = replicationTaskUpdateSpec(name)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const stored = pre.object.task

    // Retarget guard: compare against the STORED task, not against what the
    // client believes it loaded (cr.41: an unparseable unit now reads not-found
    // — an edit cannot be bound to bytes the guard could not read).
    if (request.query.retarget !== 'true') {
      const was = endpoints(stored)
      const now = endpoints(task)
      const moved = [
        ...(was.source !== now.source ? [`source ${was.source} → ${now.source}`] : []),
        ...(was.target !== now.target ? [`target ${was.target} → ${now.target}`] : []),
      ]
      if (moved.length) {
        reply.code(400)
        return {
          error: {
            code: 'VALIDATION_ERROR',
            message: `This edit would move replication task '${name}' (${moved.join('; ')}). `
              + 'Retargeting changes where data is read from and written to — resend with ?retarget=true to confirm it is intended.',
          },
        }
      }
    }

    if (!(await guardTask(task, reply)))
      return reply

    const job = jobQueue.submit(
      'replication.task.update',
      { ...identity, params: { task: name } },
      guarded(spec, pre, async () => {
        // Rewrite both units and re-sync the timer to `enabled` (toggle support).
        await writeTaskUnits(executor, systemdDir, task)
        return { updated: name }
      }),
      { locks: pre.locks },
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

    // Q1 (cr.41): a delete during an ACTIVE run refuses at the route AND again
    // in the job — a run that started while the delete waited is seen and
    // refused, not removed under. The sentence names the run and how to cancel.
    const spec = replicationTaskDeleteSpec(name)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'replication.task.remove',
      { ...identity, params: { task: name } },
      guarded(spec, pre, async () => {
        await removeTaskUnits(executor, systemdDir, name)
        return { removed: name }
      }),
      { locks: pre.locks },
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
    // quick job below. cr.41: the trigger holds the task's key briefly (shared),
    // so a delete queued between the trigger and the run it starts serialises.
    jobQueue.submit(
      'replication.task.run',
      { ...identity, params: { task: name } },
      async () => {
        const r = await executor.exec(SYSTEMCTL, ['start', '--no-block', serviceUnitName(name)])
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `systemctl start ${serviceUnitName(name)} exited with code ${r.exitCode}`)
        return { started: name }
      },
      { locks: [taskClaim('replication', name, 'shared')] },
    )
    reply.code(202)
    return { started: true }
  })
}
