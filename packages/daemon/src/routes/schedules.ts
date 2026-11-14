import type { AhrPool, SnapshotCadence, SnapshotScheduleRunResult, SnapshotSchedule as SnapshotScheduleT, SnapshotTarget } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { LockClaim } from '../jobs/locks.js'
import type { JobQueue } from '../jobs/queue.js'
import type { GuardSpec, ObjectView, Refusal } from '../safety/guard.js'
import type { UnitTaskObject } from '../services/task-units.js'
import { createHash } from 'node:crypto'
import { PRUNED_NAMES_PER_DATASET, ScheduleId, snapshotFireShapeIssues, SnapshotSchedule } from '@anas/shared'
import { readZpoolNames, zfsUnavailableRefusal } from '../parsers/zpool-list.js'
import { ConfirmStore } from '../safety/confirm.js'
import { guardCheck, guardConfirm, guarded, scheduleClaim, sendRefusal } from '../safety/guard.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { loadPveFootprint, ownershipRefusal, pveDescendantsUnlistedMessage, pveRecursiveRefusalMessage } from '../services/pve-footprint.js'
import { notifyScheduleRun } from '../services/snapshot-notify.js'
import { effectiveRetention } from '../services/snapshot-retention.js'
import {
  collectScheduleStatuses,
  deriveScheduleDetail,
  readSchedule,
  readScheduleList,
  readScheduleUnitTexts,
  removeScheduleUnits,
  serviceUnitName,
  writeScheduleUnits,
} from '../services/snapshot-schedule-units.js'
import { parseZfsStampSources, pruneSnapshots, pruneZfsSchedule, takeSnapshot, zfsRunResult, zfsStampSourceArgs } from '../services/snapshot-schedules.js'
import { ahrSourceClaims, datasetSourceClaims } from '../services/source-claims.js'
import { activeRunDeleteRefusal, readUnitStoreEntry, readUnitTaskObject, runStateUnreadableRefusal, serviceUnitRevision } from '../services/task-units.js'
import { isRunActive, showUnitPropsStrict } from '../services/unit-run-status.js'
import { inSweep, isAtOrUnder, sweepSet, zfsTreeListArgs } from '../services/zfs-snapshot.js'
import { requireIdentity } from './identity.js'

const ZFS = '/usr/sbin/zfs'

/** The four optional fire fields (snaptime.1, #83), in the order a PUT inherits them. */
type FireField = 'time' | 'weekday' | 'dayOfMonth' | 'month'

/** A representative value per field, for asking the shared shape helper whether a cadence allows it. */
const FIRE_FIELD_PROBE: Record<FireField, { time?: string, weekday?: string, dayOfMonth?: number, month?: number }> = {
  time: { time: '00:00' },
  weekday: { weekday: 'Mon' },
  dayOfMonth: { dayOfMonth: 1 },
  month: { month: 1 },
}

/** Does this cadence accept this fire field at all? — the schema's one answer, reused. */
function fireFieldAllowed(cadence: SnapshotCadence, field: FireField): boolean {
  return snapshotFireShapeIssues({ cadence, ...FIRE_FIELD_PROBE[field] }).length === 0
}

/**
 * The PUT's fire-field contract (snaptime.1, #83) — the `exclude` rule beside
 * it in the handler, for the four fields:
 *
 *   - key ABSENT from the body: keep the STORED value where the new cadence
 *     still allows the field; drop it silently where it does not, so a
 *     weekly-to-daily edit never fails on a stored weekday. A cadence CHANGE
 *     drops exactly what the new cadence refuses: monthly-to-yearly keeps the
 *     day (`dayOfMonth` is a yearly field too), yearly-to-monthly keeps the day
 *     and drops the month, yearly-to-daily drops both and keeps the time;
 *   - key PRESENT: the body's value stands — a value is validated as on
 *     create (the schema), a `null` CLEARS the stored field, which the unit
 *     writer turns into absence.
 */
function mergeFireFields(
  schedule: SnapshotScheduleT,
  stored: SnapshotScheduleT,
  body: Record<string, unknown>,
): SnapshotScheduleT {
  const keep = (field: FireField): boolean =>
    !Object.hasOwn(body, field) && stored[field] != null && fireFieldAllowed(schedule.cadence, field)
  return {
    ...schedule,
    ...(keep('time') && stored.time != null ? { time: stored.time } : {}),
    ...(keep('weekday') && stored.weekday != null ? { weekday: stored.weekday } : {}),
    ...(keep('dayOfMonth') && stored.dayOfMonth != null ? { dayOfMonth: stored.dayOfMonth } : {}),
    ...(keep('month') && stored.month != null ? { month: stored.month } : {}),
  }
}

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
  /**
   * The daemon's confirm store (cr3 H2: a create that adopts stamped
   * snapshots is confirm-gated). Absent = a store of this route's own (the
   * only route that mints or verifies `schedule.create` codes).
   */
  confirmStore?: ConfirmStore
}

/**
 * The snapshots under a ZFS target that already carry a schedule id as a
 * LOCAL `anas:schedule` stamp (cr3 DATASETS-SCHEDULES-H2) — the ones a new
 * schedule of that id would own from its first prune. `names` sorted.
 */
interface AdoptedStamps {
  names: string[]
  /** dataset → how many of `names` sit on it. */
  perDataset: Map<string, number>
}

/** The confirm-scope string of an adopted set: the counts plus a digest of the names (the set itself is bound, not only its size). */
function adoptedScope(adopted: AdoptedStamps): string {
  if (adopted.names.length === 0)
    return 'none'
  const digest = createHash('sha256').update(adopted.names.join('\n')).digest('hex').slice(0, 16)
  return `${adopted.names.length} snapshot(s) on ${adopted.perDataset.size} dataset(s), set ${digest}`
}

export async function scheduleRoutes(server: FastifyInstance, opts: ScheduleRouteOptions) {
  const { executor, jobQueue, systemdDir, subvolRuntimeDir } = opts
  const confirmStore = opts.confirmStore ?? new ConfirmStore()

  /**
   * cr3 H2: the snapshots anywhere under `dataset` stamped LOCALLY with
   * `id`, read with the prune's own reader (`zfsStampSourceArgs` +
   * `parseZfsStampSources`, the read that decides what a prune owns), always
   * recursive: a schedule made recursive later reaches the whole tree. Null
   * when the read failed — a create that cannot see what it would adopt is
   * refused, never read as "nothing stamped".
   */
  async function readAdoptedStamps(dataset: string, id: string): Promise<AdoptedStamps | null> {
    const r = await executor.exec(ZFS, zfsStampSourceArgs(dataset, true))
    if (r.exitCode !== 0)
      return null
    const names: string[] = []
    const perDataset = new Map<string, number>()
    for (const [name, stamp] of parseZfsStampSources(r.stdout)) {
      if (stamp.value !== id || stamp.source !== 'local')
        continue
      names.push(name)
      const ds = name.slice(0, name.indexOf('@'))
      perDataset.set(ds, (perDataset.get(ds) ?? 0) + 1)
    }
    names.sort()
    return { names, perDataset }
  }

  /** Does a ZFS dataset exist? (`zfs list -H -o name <ds>` exit 0). */
  async function zfsDatasetExists(dataset: string): Promise<boolean> {
    // cr.21: `--` ends option parsing so `dataset` is always the operand.
    const r = await executor.exec(ZFS, ['list', '-H', '-o', 'name', '--', dataset])
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
      // cr3.followup: the pool list through the wave's one reader — ZFS not
      // available on the node is said (409 zfs-unavailable), a list that
      // could not be read is 503, and only a list that answered says "does
      // not exist".
      const listed = await readZpoolNames(executor)
      if ('zfsUnavailable' in listed) {
        reply.send(sendRefusal(reply, zfsUnavailableRefusal(listed.zfsUnavailable)))
        return false
      }
      if ('unreadable' in listed) {
        reply.code(503).send({ error: { code: 'UNAVAILABLE', message: `Could not list the pools on this node: ${listed.unreadable} — refusing a schedule whose pool cannot be checked` } })
        return false
      }
      if (!listed.names.includes(pool)) {
        reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Pool '${pool}' does not exist` } })
        return false
      }
      // A storage root IS owned (kind 'storage-root'), so this one check covers
      // both: an owned target of any kind, and the recursive schedule on a
      // storage root that sweeps guest zvols.
      const pve = await pveFootprint()
      const owned = pve.ownershipOf(target.dataset)
      if (owned) {
        // cr.47b (review of 8ce39eb0): a schedule's target is the same
        // ownership fact as the snapshot door's — 409 PVE_MANAGED, one answer;
        // the config-unreadable verdict keeps its 400.
        reply.send(sendRefusal(reply, ownershipRefusal(owned, `Cannot schedule snapshots of '${target.dataset}' — ${owned.reason}`)))
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
          reply.send(sendRefusal(reply, ownershipRefusal(descendant.ownership, ownedDescendantRefusal('Snapshot schedule', target.dataset, descendant))))
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
    // cr3 (merge): null is "the mount table could not be read", not the flat layout.
    if (pool.subvolLayout === null) {
      reply.code(503).send({ error: { code: 'UNAVAILABLE', message: `The layout of AHR pool '${target.pool}' could not be read (the kernel mount table did not answer), so whether it can hold snapshots is not known - nothing was changed; try again` } })
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

  /**
   * The guard specs of the schedule verbs (story cr.41, WAVE3-DESIGN §3.3
   * Unit-store row + the operator's cr.41 Q1 ruling). One spec per verb, both
   * doors: the route answers a refusal in the request, the job re-reads the
   * unit store and refuses again before it writes or fires.
   *
   * The unit-store object (the parsed schedule + its service text) is the HALF
   * every mutating verb shares; the run reads the bare schedule (there is no
   * unit text to bind a fire to). Locks are `schedule:<id>` — exclusive for
   * create, update and delete, SHARED for a fire (§4.2) — so a delete queued
   * while a fire runs or waits waits instead for the fire and re-gates, and
   * two fires of one schedule still run beside each other.
   */
  const scheduleUnitView = (id: string): ObjectView<UnitTaskObject<SnapshotScheduleT>> => ({
    what: `Snapshot schedule '${id}'`,
    read: () => readUnitTaskObject(readSchedule, readScheduleUnitTexts, systemdDir, id),
    id: async o => ({ schedule: o.task.id }),
    notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `Snapshot schedule '${id}' not found` }),
    unbound: () => `Could not read snapshot schedule '${id}' — refusing`,
  })

  /**
   * The Q1 refusal when a schedule's fire is active (a run job, or the unit a
   * timer started). cr.41b: the read FAILS CLOSED — a `systemctl show` that
   * cannot answer refuses (a fire can snap + prune for a while and shows only
   * as the unit), because an unreadable run state is not evidence it is over.
   */
  async function scheduleActiveRunRefusal(id: string): Promise<Refusal | null> {
    const runJob = jobQueue.findActive('schedule.run', id, 'schedule')
    if (runJob)
      return activeRunDeleteRefusal(`Snapshot schedule '${id}'`, { job: runJob })
    try {
      const props = await showUnitPropsStrict(executor, serviceUnitName(id), 'ActiveState')
      if (isRunActive(props))
        return activeRunDeleteRefusal(`Snapshot schedule '${id}'`, { unit: { service: serviceUnitName(id), since: null } })
      return null
    }
    catch {
      return runStateUnreadableRefusal(`Snapshot schedule '${id}'`)
    }
  }

  /**
   * A create's object is the id SLOT (the mounts/shares create precedent):
   * existence is a gate, not the read-null.
   *
   * cr3 DATASETS-SCHEDULES-H2: the id is an operator-typed slug and the
   * `anas:schedule=<id>` stamps a deleted schedule left on its snapshots
   * outlive it ("the snapshots it already took are kept"); a NEW schedule of
   * that id owns them from its first prune — retention cuts them to its
   * policy, and on a dataset it excludes it destroys them all. So a ZFS
   * create reads the stamps under its target (the prune's reader) as part of
   * the object: an unreadable read refuses; a non-empty set is the confirm's
   * SCOPE (the counts and a digest of the names), so the job, re-reading,
   * refuses a set that changed after the confirm.
   *
   * Accepted residual (coordinator ruling): snapshots carrying the id that a
   * `zfs rename` moves INTO the target's tree after the create are adopted
   * without a confirm — the stamp travels with the snapshot, and nothing
   * ANAS does is involved in the move.
   */
  function scheduleCreateSpec(id: string, target: SnapshotTarget): GuardSpec<{ existing: SnapshotScheduleT | null, adopted: AdoptedStamps | null }> {
    return {
      operation: 'schedule.create',
      object: {
        what: `Snapshot schedule '${id}'`,
        read: async () => ({
          existing: await readSchedule(systemdDir, id),
          adopted: target.kind === 'zfs' ? await readAdoptedStamps(target.dataset, id) : { names: [], perDataset: new Map() },
        }),
        id: async () => ({ schedule: id }),
        scope: async o => (o.adopted ? { adopts: adoptedScope(o.adopted) } : null),
        scopeLabels: { adopts: 'the snapshots already stamped with this id' },
        unbound: part => part === 'scope'
          ? `Could not read which snapshots carry the schedule id '${id}' — refusing`
          : `Could not read snapshot schedules — refusing`,
      },
      gates: [
        async o => (o.existing
          ? { status: 409, code: 'CONFLICT', message: `Snapshot schedule '${id}' already exists` }
          : null),
        async o => (o.adopted
          ? null
          : {
              status: 409,
              code: 'CONFLICT',
              message: `Could not read the snapshots under '${target.kind === 'zfs' ? target.dataset : target.pool}' that carry the schedule id '${id}' — `
                + 'refusing: a new schedule owns every snapshot already stamped with its id, and that cannot be checked',
              reason: 'schedule-stamps-unreadable',
            }),
      ],
      locks: async () => [scheduleClaim(id, 'exclusive')],
    }
  }

  /** The confirm's warnings for an edit that newly excludes datasets carrying this schedule's stamped snapshots (cr3 review fold). */
  function exclusionWarnings(schedule: SnapshotScheduleT, doomed: AdoptedStamps): string[] {
    const datasets = [...doomed.perDataset.keys()]
    datasets.sort()
    const listed = datasets.slice(0, 10).map(ds => `${ds} (${doomed.perDataset.get(ds)})`)
    const more = datasets.length > 10 ? ` and ${datasets.length - 10} more dataset(s)` : ''
    return [
      `${doomed.names.length} snapshot(s) this schedule took on ${datasets.length} dataset(s) it will now exclude will be destroyed at its next run: ${listed.join(', ')}${more}.`,
      'Held snapshots and PVE-owned datasets are left alone. Snapshots on those datasets that this schedule did not take are never touched.',
      `To keep them, cancel, or leave those datasets in the schedule.`,
    ]
  }

  /** The confirm's warnings for a create that adopts stamped snapshots (cr3 H2). */
  function adoptionWarnings(schedule: SnapshotScheduleT, adopted: AdoptedStamps): string[] {
    const dataset = schedule.target.kind === 'zfs' ? schedule.target.dataset : ''
    const onTarget = adopted.perDataset.get(dataset) ?? 0
    const below = adopted.names.length - onTarget
    const datasets = [...adopted.perDataset.keys()]
    datasets.sort()
    const listed = datasets.slice(0, 10).map(ds => `${ds} (${adopted.perDataset.get(ds)})`)
    const more = adopted.perDataset.size > 10 ? ` and ${adopted.perDataset.size - 10} more dataset(s)` : ''
    return [
      `${adopted.names.length} snapshot(s) on ${adopted.perDataset.size} dataset(s) under '${dataset}' already carry the schedule id '${schedule.id}' — left by an earlier schedule of that id: ${listed.join(', ')}${more}.`,
      `This schedule's retention will apply to them from its first run: on every dataset it snapshots it destroys those beyond its policy, and on a dataset it excludes it destroys all of them (held snapshots and PVE-owned datasets are left alone).${
        below > 0 && schedule.recursive !== true ? ` ${below} of them are below '${dataset}', which this schedule reaches only if it is made recursive.` : ''}`,
      `To leave them alone, cancel and choose another id.`,
    ]
  }

  /**
   * The update spec. `merged` turns the stored schedule into the schedule
   * this PUT would write (the body with the PUT contract applied).
   *
   * cr3 (review fold, coordinator ruling): an edit that NEWLY EXCLUDES a
   * dataset — puts it in the prune's excluded scope, where this schedule's
   * own stamped snapshots are destroyed outright at the next fire — is a
   * destructive consequence of a PUT. The snapshots stamped with this id on
   * the newly excluded datasets are the confirm's SCOPE (counts and a digest
   * of the names, as the create's), so the job refuses a set that changed; a
   * read that fails refuses (unbound). An edit that newly excludes nothing
   * reads nothing and binds 'none'.
   */
  function scheduleUpdateSpec(
    id: string,
    merged?: (stored: SnapshotScheduleT) => SnapshotScheduleT,
    seen?: (doomed: AdoptedStamps) => void,
  ): GuardSpec<UnitTaskObject<SnapshotScheduleT>> {
    return {
      operation: 'schedule.update',
      object: {
        ...scheduleUnitView(id),
        revision: async o => serviceUnitRevision(o.unit),
        ...(merged
          ? {
              scope: async (o: UnitTaskObject<SnapshotScheduleT>) => {
                const doomed = await readNewlyExcludedStamps(o.task, merged(o.task))
                if (doomed)
                  seen?.(doomed)
                return doomed ? { excludes: adoptedScope(doomed) } : null
              },
              scopeLabels: { excludes: 'this schedule\'s snapshots on the datasets the edit newly excludes' },
              unbound: () => `Could not read the snapshots this edit of snapshot schedule '${id}' would destroy — refusing`,
            }
          : {}),
      },
      gates: [],
      locks: async () => [scheduleClaim(id, 'exclusive')],
    }
  }

  /**
   * Is `dataset` in a schedule's EXCLUDED prune scope — under the target of a
   * recursive schedule and outside its sweep (planZfsSchedulePrune's own
   * rule)? Only there are its stamped snapshots destroyed outright.
   */
  function inExcludedScope(s: SnapshotScheduleT, dataset: string): boolean {
    return s.target.kind === 'zfs' && s.recursive === true && dataset.startsWith(`${s.target.dataset}/`) && !inSweep(s, dataset)
  }

  /**
   * Could the edit put any dataset newly in the excluded scope? Only a
   * recursive result can; a stored recursive schedule whose every new exclude
   * entry is at or under an old one excludes nothing new. Avoids the stamp
   * read for the common edit (cadence, retention, a toggle).
   */
  function mayNewlyExclude(stored: SnapshotScheduleT, next: SnapshotScheduleT): boolean {
    if (next.target.kind !== 'zfs' || next.recursive !== true || targetKey(stored.target) !== targetKey(next.target))
      return false
    // A recursive schedule with no exclude list sweeps everything under its
    // target: nothing is outside its sweep (second review (4)).
    if ((next.exclude ?? []).length === 0)
      return false
    if (stored.recursive !== true)
      return true
    const old = stored.exclude ?? []
    return (next.exclude ?? []).some(ex => !old.some(o => isAtOrUnder(ex, o)))
  }

  /**
   * The snapshots stamped (locally) with this schedule's id on the datasets
   * the edit newly excludes — empty when it excludes nothing new; null when
   * the read failed.
   */
  async function readNewlyExcludedStamps(stored: SnapshotScheduleT, next: SnapshotScheduleT): Promise<AdoptedStamps | null> {
    const none: AdoptedStamps = { names: [], perDataset: new Map() }
    if (!mayNewlyExclude(stored, next) || next.target.kind !== 'zfs')
      return none
    const all = await readAdoptedStamps(next.target.dataset, next.id)
    if (!all)
      return null
    const names: string[] = []
    const perDataset = new Map<string, number>()
    for (const name of all.names) {
      const ds = name.slice(0, name.indexOf('@'))
      if (!inExcludedScope(next, ds) || inExcludedScope(stored, ds))
        continue
      names.push(name)
      perDataset.set(ds, (perDataset.get(ds) ?? 0) + 1)
    }
    return { names, perDataset }
  }

  /** The PUT contract applied: the stored exclude list and fire fields kept where the body omits them. */
  function mergeForUpdate(schedule: SnapshotScheduleT, stored: SnapshotScheduleT, body: Record<string, unknown> | null | undefined): SnapshotScheduleT {
    // Mixed-version safety (0.4.2): a 0.4.1 UI knows nothing of `exclude`, and
    // its toggle/edit PUT rebuilds the body without the key — on a full
    // replace that silently dropped the stored list. An ABSENT key therefore
    // keeps the stored list (a recursive ZFS schedule only — the only kind
    // that can carry one); a PRESENT key, `[]` included, is the new list. The
    // 0.4.2 UI always sends the key on a recursive ZFS schedule.
    let next = schedule
    const excludeAbsent = !body || typeof body !== 'object' || !Object.hasOwn(body, 'exclude')
    if (excludeAbsent && next.recursive === true && next.target.kind === 'zfs' && stored.exclude?.length)
      next = { ...next, exclude: stored.exclude }
    // snaptime.1 (#83): the fire fields follow the same contract just above —
    // an absent key keeps the stored value where the NEW cadence allows the
    // field and drops it silently where it does not; a present `null` clears.
    return mergeFireFields(next, stored, body && typeof body === 'object' ? body : {})
  }

  function scheduleDeleteSpec(id: string): GuardSpec<{ unit: string, timer: string }> {
    return {
      operation: 'schedule.remove',
      // cr.41b: the delete's object is the unit AS STORED — the store's own
      // existence (a `.service` on disk), never the parsed schedule. A unit
      // whose X-ANAS-Schedule no longer parses (a hand edit; a schedule an
      // older ANAS wrote) is skipped by the list AND by a parsed-object read,
      // which would answer 404 on exactly the unit the operator needs to remove
      // — this read makes it deletable. The UPDATE spec above stays bound to
      // the parsed object: an edit cannot be bound to bytes that do not parse —
      // 404 not-found is right there.
      object: {
        what: `Snapshot schedule '${id}'`,
        read: () => readUnitStoreEntry(readScheduleUnitTexts, systemdDir, id),
        id: async () => ({ schedule: id }),
        notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `Snapshot schedule '${id}' not found` }),
        unbound: () => `Could not read snapshot schedule '${id}' — refusing`,
      },
      gates: [async () => scheduleActiveRunRefusal(id)],
      locks: async () => [scheduleClaim(id, 'exclusive')],
    }
  }

  /**
   * A fire's object is the schedule itself, re-read in the job (Cap → re-read, §2.4).
   *
   * cr.56 (review M2) → cr.64a → cr.64b1 (F): the claim-bearing field is the
   * TARGET (kind + dataset or AHR pool, resolved to the pool's guid / VG
   * UUID). An edit cannot move it (PUT refuses a retarget), but a delete and a
   * re-create under the same id can, and so can a pool re-created under its
   * name: the guard's job door recomputes `locks` from its own re-read and
   * refuses STATE_CHANGED when the fire needs a key the queue did not grant —
   * the guard's rule, so the door's own in-body copy of it is gone, and
   * `locksMoved` gives that refusal the door's sentence (`target was …; now
   * …`, or the same target on another pool).
   */
  function scheduleRunSpec(id: string): GuardSpec<SnapshotScheduleT> {
    return {
      operation: 'schedule.run',
      object: {
        what: `Snapshot schedule '${id}'`,
        read: async () => readSchedule(systemdDir, id),
        id: async o => ({ schedule: o.id }),
        notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `Snapshot schedule '${id}' not found` }),
        unbound: () => `Could not read snapshot schedule '${id}' — refusing the run`,
      },
      gates: [],
      locks: async o => scheduleRunClaims(o),
      locksMoved: (o, _reads, was) => (was ? targetMoved(was.target, o.target) : `target ${targetKey(o.target)} moved`),
    }
  }

  /**
   * A fire's claims (cr.33b): its target shared — the dataset (its ancestors
   * and the pool shared) or the AHR pool — and its own `schedule:<id>` shared.
   * The ONE builder; the guard calls it at the route door and again in the
   * job door's recompute.
   *
   * A recursive schedule claims its TARGET, not each descendant it sweeps —
   * deliberately (cr3, coordinator 2026-11-14, after a measured trial of the
   * per-descendant claims): accepted residual, a scheduled snapshot taken in
   * the moment between a forced child rollback's re-read and its `zfs
   * rollback -r` is destroyed unconfirmed — a snapshot of data the operator is
   * discarding anyway; claiming every swept child instead made one long
   * exclusive job on ONE child (a replication receive, a set-access, a LUN
   * restore: hours) stall every fire of the parent, and the FIFO lock table
   * then queued unrelated verbs on other children behind the waiting fire. Do
   * not re-add the per-descendant claims without weighing that stall.
   */
  async function scheduleRunClaims(o: SnapshotScheduleT): Promise<LockClaim[]> {
    return [
      ...(o.target.kind === 'zfs'
        ? await datasetSourceClaims(executor, [o.target.dataset])
        : ahrSourceClaims(o.target.pool, (await resolveAhrPool(o.target.pool))?.vg.uuid)),
      scheduleClaim(o.id, 'shared'),
    ]
  }

  /** What moved under a fire's target between the route read and the job read (cr.56). */
  function targetMoved(was: SnapshotTarget, now: SnapshotTarget): string {
    return targetKey(was) !== targetKey(now)
      ? `target was ${targetKey(was)}; now ${targetKey(now)}`
      : `target ${targetKey(now)} now resolves to a different pool`
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
    let pveOwned: ((dataset: string) => string | null) | undefined
    if (schedule.target.kind === 'zfs') {
      const pve = await pveFootprint()
      // cr3 L3: the prune asks the same footprint for every dataset it reaches.
      pveOwned = dataset => pve.ownershipOf(dataset)?.reason ?? null
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
      : { recursive: schedule.recursive, exclude: schedule.exclude, updateProgress, runtimeDir: subvolRuntimeDir, scheduleId: schedule.id }
    // ident.1: a ZFS take stamps `anas:schedule=<id>` on every snapshot it
    // creates (the same atomic verb), which is what the prune below keys on.
    const take = await takeSnapshot(executor, schedule.target, schedule.cadence, svcOpts)
    updateProgress(`Took ${take.name}; pruning per retention`)
    if (schedule.target.kind === 'zfs') {
      // ident.1 over snapprune.1: retention destroys only snapshots stamped
      // with THIS schedule's id, per dataset across everything it snapshots
      // (the whole sweep for a recursive schedule). An unstamped (pre-0.4.2)
      // snapshot is a candidate only where this is the one enabled schedule
      // covering the dataset — which the other schedules decide, read from
      // the unit files (the store). The read says whether it is COMPLETE: on
      // a partial list (unlistable dir, unreadable or unparseable unit) no
      // unstamped snapshot is destroyed that run (noted, a warning). A
      // destroy ZFS refuses on a swept or excluded dataset is noted there
      // and the run completes with warnings. The result names at most
      // PRUNED_NAMES_PER_DATASET destroyed snapshots per dataset.
      const prune = await pruneZfsSchedule(executor, schedule, {
        others: await readScheduleList(systemdDir),
        updateProgress,
        ...(pveOwned ? { pveOwned } : {}),
      })
      return zfsRunResult(schedule, take.name, prune)
    }
    // AHR: whole @data, no stamp (btrfs has no user properties); the policy's
    // absent buckets are left alone, its own cadence bucket always planned.
    const prune = await pruneSnapshots(executor, schedule.target, effectiveRetention(schedule), svcOpts)
    return {
      schedule: schedule.id,
      taken: take.name,
      pruned: prune.pruned.slice(0, PRUNED_NAMES_PER_DATASET).map(s => s.name),
      prunedCount: prune.pruned.length,
      skippedHeld: prune.skippedHeld.slice(0, PRUNED_NAMES_PER_DATASET).map(s => s.name),
      heldCount: prune.skippedHeld.length,
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

    // 409 if the schedule already exists — the unit files are the source of
    // truth at the route, and the create job re-runs the same gate under its
    // `schedule:<id>` name key (cr.41: two creates of one id cannot both pass
    // a check made before either wrote).
    //
    // cr3 (review fold): "already exists" answers first, as before H2 — a
    // plain read of the store ahead of the target check. The spec's read
    // (which the job repeats) lists the stamps under the target, so it runs
    // only AFTER the target check: a target that does not exist answers its
    // own 400, never "could not read the stamps".
    if (await readSchedule(systemdDir, schedule.id)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Snapshot schedule '${schedule.id}' already exists` } }
    }
    if (!(await guardTarget(schedule.target, schedule.recursive === true, reply, schedule.exclude)))
      return reply
    const spec = scheduleCreateSpec(schedule.id, schedule.target)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // cr3 H2: snapshots already stamped with this id are adopted — said, and
    // confirmed, before anything is written. The code binds the whole body
    // (the id among it) and the adopted set (the scope).
    const adopted = pre.object.adopted
    if (adopted && adopted.names.length > 0) {
      if (!guardConfirm(confirmStore, request, reply, spec, pre, {
        validated: { ...schedule },
        address: ['id'],
        message: `Snapshot schedule id '${schedule.id}' is already stamped on existing snapshots — this schedule will own them`,
        warnings: adoptionWarnings(schedule, adopted),
      })) {
        return reply
      }
    }

    const job = jobQueue.submit(
      'schedule.create',
      { ...identity, params: { schedule: schedule.id } },
      guarded(spec, pre, async () => {
        await writeScheduleUnits(executor, systemdDir, schedule)
        return { created: schedule.id }
      }),
      { locks: pre.locks },
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
    const parsed = bodyParsed.data
    let schedule = parsed
    // The URL is the identity; a body renaming the id is rejected (rename =
    // delete + create, not an in-place edit).
    if (schedule.id !== id) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Schedule id in body ('${schedule.id}') does not match URL ('${id}')` } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story cr.41: the update is BOUND to the stored schedule's revision (the
    // service unit's sha256) — an edit whose unit changed meanwhile refuses
    // STATE_CHANGED, and one whose schedule was deleted refuses not-found, so
    // an update can never resurrect a deleted schedule. The id and rev are
    // read here and RE-READ in the job (guarded). The TARGET checks below use
    // the same re-read as `stored`.
    const body = request.body as Record<string, unknown> | null | undefined
    // The set the route door's scope read: the warnings name exactly what the
    // confirm binds (one read, not two).
    let doomed: AdoptedStamps = { names: [], perDataset: new Map() }
    const spec = scheduleUpdateSpec(id, stored => mergeForUpdate(parsed, stored, body), (d) => {
      doomed = d
    })
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const stored = pre.object.task

    // The TARGET is part of a schedule's identity, exactly like its id: what it
    // snapshots is what it IS. An in-place edit changes policy — cadence,
    // retention, notify, enabled — never the filesystem underneath. Repointing
    // is delete + create, which the UI already assumes (the target fields are
    // read-only on edit), so enforcing it here costs nothing and closes the
    // whole class: a dialog that fell back to the first pool of a
    // fail-open-empty inventory can no longer rewrite a schedule onto a
    // different filesystem.
    if (targetKey(stored.target) !== targetKey(schedule.target)) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: `Snapshot schedule '${id}' targets ${targetKey(stored.target)}; an edit cannot move it to `
            + `${targetKey(schedule.target)} — delete the schedule and create one for the new target`,
        },
      }
    }
    // The PUT contract (exclude and the fire fields kept where the body
    // omits them) — the same function the spec's scope reads.
    schedule = mergeForUpdate(schedule, stored, body)

    if (!(await guardTarget(schedule.target, schedule.recursive === true, reply, schedule.exclude, stored.exclude)))
      return reply

    // cr3 (review fold): an edit that newly excludes datasets carrying this
    // schedule's own stamped snapshots destroys them at the next fire — said,
    // and confirmed, before anything is written. The code binds the whole
    // merged schedule and the set (the spec's scope).
    if (doomed.names.length > 0) {
      if (!guardConfirm(confirmStore, request, reply, spec, pre, {
        validated: { ...schedule },
        address: ['id'],
        message: `This edit excludes datasets that carry snapshots snapshot schedule '${id}' took — they will be destroyed at its next run`,
        warnings: exclusionWarnings(schedule, doomed),
      })) {
        return reply
      }
    }

    const job = jobQueue.submit(
      'schedule.update',
      { ...identity, params: { schedule: id } },
      guarded(spec, pre, async () => {
        await writeScheduleUnits(executor, systemdDir, schedule)
        return { updated: id }
      }),
      { locks: pre.locks },
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

    // Q1 (cr.41): a delete during an ACTIVE fire refuses at the route AND again
    // in the job — a fire that started while the delete waited for a slot (or
    // for the schedule's key) is seen and refused, not run over. The sentence
    // names the run and how to cancel it.
    const spec = scheduleDeleteSpec(id)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'schedule.remove',
      { ...identity, params: { schedule: id } },
      guarded(spec, pre, async () => {
        await removeScheduleUnits(executor, systemdDir, id)
        return { removed: id }
      }),
      { locks: pre.locks },
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

    // Story cr.41 (§2.4 "schedule run" row): the fire RE-READS the schedule in
    // the job — the route-read schedule was a Cap. The PVE-ownership gates were
    // already re-run inside fireSchedule; what was missing was the schedule
    // ITSELF, so a fire whose schedule was deleted while it waited refuses
    // not-found, and the run reads a fresh one (a re-created schedule with the
    // same id is the current schedule).
    // cr3 (second review (5)): a fire refused at the ROUTE — a read its lock
    // claims need could not be made (an AHR topology that cannot be read
    // throws past the guard into the server's 503), or any refusal — is a
    // failed fire like one refused in the job, so the schedule's own
    // notification says why. The timer's runner gets the HTTP answer and no
    // job, so this is the only place it can be said. Best-effort; a schedule
    // that cannot be read (404 / unreadable) has no one to notify.
    const notifyRefused = async (message: string): Promise<void> => {
      const schedule = await readSchedule(systemdDir, id).catch(() => null)
      if (schedule)
        await notifyScheduleRun(executor, { schedule, error: message, elapsedMs: 0 })
    }
    const spec = scheduleRunSpec(id)
    let pre: Awaited<ReturnType<typeof guardCheck<SnapshotScheduleT>>>
    try {
      pre = await guardCheck(spec)
    }
    catch (err) {
      await notifyRefused(err instanceof Error ? err.message : String(err))
      throw err
    }
    if ('refusal' in pre) {
      await notifyRefused(pre.refusal.message)
      return sendRefusal(reply, pre.refusal)
    }

    // cr.64b1 (F): a fire the GUARD refuses (its lock recompute, before any
    // body runs) is a failed fire like any other, so it notifies — the
    // schedule's own mode, the re-read schedule, the refusal's sentence —
    // exactly as the in-body check did before cr.64a moved it into the guard.
    let firedAt = 0
    const fire = guarded(spec, pre, async (schedule, { updateProgress }) => {
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
    }, {
      refused: async (refusal, schedule) => {
        await notifyScheduleRun(executor, { schedule, error: refusal.message, elapsedMs: Date.now() - firedAt })
      },
    })

    const job = jobQueue.submit(
      'schedule.run',
      { ...identity, params: { schedule: id } },
      (updateProgress, ctx) => {
        firedAt = Date.now()
        return fire(updateProgress, ctx)
      },
      // cr.33b (§4.2 "schedule fire", S): the fire holds a SHARED claim on its
      // target — the dataset (its ancestors and the pool shared) or the AHR
      // pool — so a destroy, rename or rollback of the target accepted while it
      // takes and prunes waits for it and re-gates after; other snapshots of
      // the target still run beside it. A recursive schedule claims its target
      // (whose recursive destroy or rename takes it exclusive), not each
      // descendant it sweeps — see scheduleRunClaims for the accepted residual
      // and the measured stall that keeps it that way.
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })
}
