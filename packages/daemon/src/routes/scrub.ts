import type { AhrPool, LastScrub, PeriodicScrubState, ScrubRunning } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { Gate, GuardSpec } from '../safety/guard.js'
import { AhrScrubToggleRequest, PoolName, ScrubToggleRequest } from '@anas/shared'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { parseScrubScans } from '../parsers/zpool-status.js'
import { ahrPoolClaims, guardCheck, guarded, poolClaims, sendRefusal } from '../safety/guard.js'
import { readPoolGuid } from '../safety/stable-id.js'
import { poolArrayUuids } from '../services/ahr-guard.js'
import { AhrTopologyUnreadableError, readAhrPools } from '../services/ahr-topology.js'
import { ForeignUnitError, scrubUnitsAreForeign } from '../services/scrub-schedule-units.js'
import {
  ahrScrubRunning,
  readAhrScrubState,
  readZfsScrubState,
  setAhrScrubEnabled,
  setZfsScrubEnabled,
} from '../services/scrub-schedules.js'
import { DEFAULT_SYSTEMD_DIR } from '../services/snapshot-schedule-units.js'
import { requireIdentity } from './identity.js'

const ZPOOL = '/usr/sbin/zpool'
const CAT = '/usr/bin/cat'

/**
 * The ZFS pool list could not be READ: `zpool list -j` exited non-zero, so
 * "there are no ZFS pools" cannot be asserted — the ZFS twin of cr.63's L15
 * (cr.64c). An EMPTY list from a successful read is honestly no pools; this is
 * a read that could not see, and the doors answer 503 UNAVAILABLE with its
 * sentence instead of 404-ing a live pool or dropping every ZFS row.
 */
class ZfsPoolListUnreadableError extends Error {
  constructor(
    /** The command whose non-zero exit made the pool list unreadable — names what could not be read. */
    readonly command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`the ZFS pool list could not be read (${command} exited ${exitCode}: ${stderr.trim().split('\n')[0] || 'no stderr'})`)
    this.name = 'ZfsPoolListUnreadableError'
  }
}

/**
 * Periodic SCRUB — uniform surface, filesystem-native backend (Epic 17.5 +
 * story selfheal.4, docs/SCHEDULES-DESIGN.md §Scrub). One "periodic scrub:
 * on/off" control for a ZFS pool and an AHR pool; the toggle flips the
 * filesystem's own mechanism (ZFS: `org.debian:periodic-scrub` property; AHR:
 * ANAS's node-level `anas-scrub.timer`, the whole two-phase scrub).
 *
 *   GET /v1/scrub                → uniform state for every ZFS + AHR pool
 *   PUT /v1/scrub/zfs/:pool  {enabled}         → flip the ZFS property (202 job)
 *   PUT /v1/scrub/ahr/:pool  {enabled, cadence?} → edit the node timer's pool
 *                                 list + cadence; disables mdcheck on enable
 *                                 (202 job)
 *
 * Each state also carries `lastScrub` — the pool's last COMPLETED verify pass
 * (17.3's "`zpool status` scrub dates"). ZFS records one; md records NONE, so an
 * AHR state's `lastScrub` is always null and the screen says so in words rather
 * than inventing a record from journald or a state file.
 *
 * …and `running` when a pass is in flight (stage 6), so the screen keeps saying
 * something while a scrub runs instead of going quiet exactly then. Both halves
 * come out of reads this route ALREADY makes: ZFS from the one `zpool status
 * -jv` the verdict comes from, AHR from the topology read that enumerates the
 * pools. No new system read, no new endpoint — the run/stop verbs on the Scrubs
 * screen are a second door to `POST /v1/pools/:name/scrub` and
 * `POST /v1/ahr/:name/scrub`.
 *
 * Toggles are jobs (Principle 4), and since cr.64b2-ii guard doors: the pool
 * as the live list names it now, bound to its guid / array+VG identity, the
 * PVE-territory gate, the pool's shared keys (§4.2), and the same checks
 * re-run by the job at its turn (the toggles used to take no lock, no PVE
 * gate and no job re-read — L22). ANAS deliberately does NOT touch the (disabled)
 * systemd `zfs-scrub-*@.timer` for ZFS, so the property remains the single lever
 * and there is no double-scrub (GT-4). The AHR toggle edits the node-level
 * timer's embedded schedule (selfheal.4) — its `note` stays honest about an
 * mdcheck timer still on, and about md arrays that are no AHR band.
 */
export interface ScrubRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  /** systemd unit dir for the `anas-scrub` units (tests override). */
  systemdDir?: string
}

export async function scrubRoutes(server: FastifyInstance, opts: ScrubRouteOptions) {
  const { executor, jobQueue } = opts
  const systemdDir = opts.systemdDir ?? DEFAULT_SYSTEMD_DIR

  /**
   * Live ZFS pool names. A `zpool list -j` that could not run throws
   * {@link ZfsPoolListUnreadableError} (cr.64c, the ZFS twin of cr.63's L15):
   * before, a failed read was an empty list, so `PUT /scrub/zfs/:pool`
   * answered 404 for a live pool and GET silently dropped every ZFS row.
   */
  async function zfsPoolNames(): Promise<string[]> {
    const r = await executor.exec(ZPOOL, ['list', '-j'])
    if (r.exitCode !== 0)
      throw new ZfsPoolListUnreadableError('zpool list -j', r.exitCode, r.stderr)
    return r.stdout.trim() ? parseZpoolList(r.stdout).map(p => p.name) : []
  }

  /**
   * Live AHR pools, topology and all. A topology that could not be READ throws
   * {@link AhrTopologyUnreadableError} through to the caller, which answers 503
   * (cr.63, review L15; cr.35's "unreadable is never empty"): before, a failed
   * read was an empty list, so `GET /scrub` silently dropped every AHR pool and
   * `PUT /scrub/ahr/:pool` answered 404 for a live one. A readable topology
   * that names no AHR array — and an absent /proc/mdstat (cr.33e) — is still
   * honestly no pools.
   */
  async function ahrPools(): Promise<AhrPool[]> {
    return readAhrPools(executor)
  }

  /** The 503 a read that could not see the AHR topology answers (the routes/ahr.ts sentence). */
  function ahrUnreadable(reply: FastifyReply, err: AhrTopologyUnreadableError): { error: { code: 'UNAVAILABLE', message: string } } {
    reply.code(503)
    return { error: { code: 'UNAVAILABLE', message: err.message } }
  }

  /** The 503 a read that could not see the ZFS pools answers (the same shape, cr.64c). */
  function zfsUnreadable(reply: FastifyReply, err: ZfsPoolListUnreadableError): { error: { code: 'UNAVAILABLE', message: string } } {
    reply.code(503)
    return { error: { code: 'UNAVAILABLE', message: err.message } }
  }

  /**
   * Each ZFS pool's scan-derived scrub facts — the last COMPLETED verify pass
   * and the one running now — from the one `zpool status` ZFS already reports
   * them in (no new source, one read for every pool, both halves of the same
   * record). Fail-open to an empty map: an unreadable status means "no record",
   * which is exactly how an idle, never-scrubbed pool reads.
   */
  async function zfsScrubScans(): Promise<Map<string, { lastScrub: LastScrub | null, running: ScrubRunning | null }>> {
    try {
      const r = await executor.exec(ZPOOL, ['status', '-jv'])
      return r.exitCode === 0 && r.stdout.trim() ? parseScrubScans(r.stdout) : new Map()
    }
    catch {
      return new Map()
    }
  }

  // The periodic-scrub toggle takes NO PVE-territory gate (cr.64b2-ii review,
  // DeepSeek 2026-10-17, probe q3a): the pools.ts scrub verb on a PVE-managed
  // pool answers 202 (a scrub is maintenance PVE does not do for us), and the
  // toggle shipped without one before cr.64b2-ii; the gate the first cut added
  // refused both PVE shapes and broke parity with its own verb. Whether a
  // `zfs set` of the pool's periodic-scrub property on a PVE pool should be
  // hands-off is an operator ruling, recorded on the EPICS line, not a door.

  /**
   * The ZFS toggle as a guard door (cr.64b2-ii, review L22 — it used to take
   * no lock, no PVE gate and no job re-read): the object is the pool the LIVE
   * `zpool list` names now, bound to its guid (an export/re-create under the
   * same name is a different pool), the PVE gate at both doors, and the job
   * holds `zpool:<guid>` + `zname:<pool>` SHARED (§4.2 — a property set
   * changes nothing about the pool's shape, and cr.36's pool scrub verb takes
   * the same shared key). `zpool list` that cannot read throws from the
   * object's own read and the route answers its 503, exactly as the doors
   * already did before the guard (cr.64c).
   */
  function zfsScrubToggleSpec(pool: string): GuardSpec<{ name: string }> {
    const guid = async (reads: Parameters<Gate<{ name: string }>>[1]) =>
      reads.once(`pool-guid:${pool}`, () => readPoolGuid(executor, pool))
    return {
      operation: 'scrub.zfs.toggle',
      object: {
        what: `ZFS pool '${pool}'`,
        read: async () => (await zfsPoolNames()).includes(pool) ? { name: pool } : null,
        id: async (_o, reads) => await guid(reads),
        revision: async (_o, reads) => (await guid(reads))?.guid ?? null,
        notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `ZFS pool '${pool}' not found` }),
        unbound: () => `Could not read the guid of pool '${pool}' — refusing a periodic-scrub toggle that cannot be bound to it`,
      },
      gates: [],
      locks: async (_o, bound) => poolClaims(pool, bound.id.guid, 'shared'),
    }
  }

  /**
   * The AHR toggle as a guard door (cr.64b2-ii): the object is the AHR pool AS
   * THE TOPOLOGY NAMES IT NOW, bound to the identity routes/ahr*.ts bind to
   * (the band array UUIDs + the VG UUID, the ahr-guard poolView's own answer),
   * the PVE gate at both doors, and the job holds `ahr:<vg uuid>` +
   * `ahrname:<pool>` SHARED (§4.2 — the toggle edits the node timer's pool
   * list; it never reshapes the pool). An unreadable topology throws from the
   * object's read → the route's 503 (cr.63 L15, unchanged).
   */
  function ahrScrubToggleSpec(pool: string): GuardSpec<AhrPool> {
    return {
      operation: 'scrub.ahr.toggle',
      object: {
        what: `AHR pool '${pool}'`,
        read: async () => (await ahrPools()).find(p => p.name === pool) ?? null,
        id: async p => ({
          arrays: poolArrayUuids(p).join(','),
          ...(p.vg.uuid ? { vgUuid: p.vg.uuid } : {}),
        }),
        revision: async p => [poolArrayUuids(p).join(','), p.vg.uuid ?? ''].join('/'),
        notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `AHR pool '${pool}' not found` }),
        unbound: () => `Could not read the identity of AHR pool '${pool}' — refusing a periodic-scrub toggle that cannot be bound to it`,
      },
      gates: [],
      locks: async (p, bound) => ahrPoolClaims(pool, bound.id.vgUuid ?? p.vg.uuid ?? null, 'shared'),
    }
  }

  // --- GET /scrub — uniform periodic-scrub state across ZFS + AHR pools ------
  server.get('/scrub', async (_request, reply) => {
    let ahr: AhrPool[]
    try {
      ahr = await ahrPools()
    }
    catch (err) {
      if (err instanceof AhrTopologyUnreadableError)
        return ahrUnreadable(reply, err)
      throw err
    }
    let zfsPools: string[]
    try {
      zfsPools = await zfsPoolNames()
    }
    catch (err) {
      if (err instanceof ZfsPoolListUnreadableError)
        return zfsUnreadable(reply, err)
      throw err
    }
    const [scans, mdstat] = await Promise.all([
      zfsScrubScans(),
      // The node's md arrays — diffed against the AHR bands so a foreign array
      // (one ANAS's scrub never covers) is said in the note, never silent.
      executor.exec(CAT, MDSTAT_CAT_ARGS).then(r => r.exitCode === 0 ? parseMdstat(r.stdout) : []).catch(() => []),
    ])
    const ctx = {
      dir: systemdDir,
      mdKernelNames: mdstat.map(a => a.kernelName),
      ahrKernelNames: ahr.flatMap(p => p.arrays.map(a => a.kernelName).filter((n): n is string => !!n)),
    }
    const states: PeriodicScrubState[] = [
      ...await Promise.all(zfsPools.map(p => readZfsScrubState(
        executor,
        p,
        scans.get(p)?.lastScrub ?? null,
        scans.get(p)?.running ?? null,
      ))),
      // The AHR running check comes out of the topology read this route already
      // makes to enumerate the pools — no extra mdstat read for it.
      ...await Promise.all(ahr.map(p => readAhrScrubState(executor, p.name, ahrScrubRunning(p), ctx))),
    ]
    return { data: states }
  })

  // --- PUT /scrub/zfs/:pool — flip the ZFS periodic-scrub property ----------
  server.put<{ Params: { pool: string } }>('/scrub/zfs/:pool', async (request, reply) => {
    const poolParsed = PoolName.safeParse(request.params.pool)
    if (!poolParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${poolParsed.error.issues[0]?.message}` } }
    }
    const bodyParsed = ScrubToggleRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid toggle: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const pool = poolParsed.data
    const { enabled } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // cr.64b2-ii (L22): the guard door — object as the live list names it
    // now (404 gone, 503 unreadable), the PVE gate, the shared pool keys, and
    // the SAME checks re-run by the job at its turn before the `zfs set`.
    const spec = zfsScrubToggleSpec(pool)
    let pre
    try {
      pre = await guardCheck(spec)
    }
    catch (err) {
      if (err instanceof ZfsPoolListUnreadableError)
        return zfsUnreadable(reply, err)
      throw err
    }
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'scrub.zfs.toggle',
      { ...identity, params: { pool, enabled: String(enabled) } },
      guarded(spec, pre, async () => {
        await setZfsScrubEnabled(executor, pool, enabled)
        return { pool, periodicScrub: enabled }
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })

  // --- PUT /scrub/ahr/:pool — edit the node timer's pool list (+ cadence) ----
  server.put<{ Params: { pool: string } }>('/scrub/ahr/:pool', async (request, reply) => {
    const poolParsed = PoolName.safeParse(request.params.pool)
    if (!poolParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${poolParsed.error.issues[0]?.message}` } }
    }
    const bodyParsed = AhrScrubToggleRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid toggle: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const pool = poolParsed.data
    const { enabled, cadence } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // cr.64b2-ii (L22): the guard door (see ahrScrubToggleSpec) — 404 gone,
    // 503 unreadable topology, the PVE gate, the shared ahr keys; the job
    // re-gates the identity at its turn before touching any unit.
    const spec = ahrScrubToggleSpec(pool)
    let pre
    try {
      pre = await guardCheck(spec)
    }
    catch (err) {
      if (err instanceof AhrTopologyUnreadableError)
        return ahrUnreadable(reply, err)
      throw err
    }
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // A unit file on ANAS's fixed anas-scrub names WITHOUT our marker is not
    // ours to rewrite (enable) or delete (disable) — refuse at the door, 409,
    // before a job exists (review R10). The job service checks again.
    if (await scrubUnitsAreForeign(systemdDir)) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'foreign-unit',
          message: `an anas-scrub unit without an X-ANAS-Schedule marker exists in ${systemdDir}. It is not an ANAS unit, so the periodic scrub toggle will not change it`,
        },
      }
    }

    const job = jobQueue.submit(
      'scrub.ahr.toggle',
      { ...identity, params: { pool, enabled: String(enabled), ...(cadence ? { cadence } : {}) } },
      guarded(spec, pre, async () => {
        // Node-level: edits the ONE anas-scrub timer's pool list; enabling also
        // takes mdcheck over (disable) — ANAS owns md checks on this node.
        try {
          await setAhrScrubEnabled(executor, pool, enabled, { dir: systemdDir, cadence })
        }
        catch (err) {
          // A foreign unit keeps its own identity (review F14): the message says
          // the name is not ours to touch. ANY other failure — a failed unit
          // write, a failed enable — is reported as exactly that, never as
          // `foreign-unit`; the door check above is the only thing that claims
          // foreign.
          if (err instanceof ForeignUnitError)
            throw err
          throw new Error(
            `periodic scrub ${enabled ? 'enable' : 'disable'} failed for '${pool}': ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        return { pool, periodicScrub: enabled, ...(cadence ? { cadence } : {}), scope: 'node-level' }
      }),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })
}
