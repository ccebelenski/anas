import type { AhrPool, LastScrub, PeriodicScrubState, ScrubRunning } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import { AhrScrubToggleRequest, PoolName, ScrubToggleRequest } from '@anas/shared'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { parseScrubScans } from '../parsers/zpool-status.js'
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
 * Toggles are jobs (Principle 4). ANAS deliberately does NOT touch the (disabled)
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

  /** Live ZFS pool names (fail-open to []). */
  async function zfsPoolNames(): Promise<string[]> {
    try {
      const r = await executor.exec(ZPOOL, ['list', '-j'])
      return r.exitCode === 0 && r.stdout.trim() ? parseZpoolList(r.stdout).map(p => p.name) : []
    }
    catch {
      return []
    }
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
    const [zfsPools, scans, mdstat] = await Promise.all([
      zfsPoolNames(),
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

    if (!(await zfsPoolNames()).includes(pool)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `ZFS pool '${pool}' not found` } }
    }

    const job = jobQueue.submit(
      'scrub.zfs.toggle',
      { ...identity, params: { pool, enabled: String(enabled) } },
      async () => {
        await setZfsScrubEnabled(executor, pool, enabled)
        return { pool, periodicScrub: enabled }
      },
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

    let ahr: AhrPool[]
    try {
      ahr = await ahrPools()
    }
    catch (err) {
      if (err instanceof AhrTopologyUnreadableError)
        return ahrUnreadable(reply, err)
      throw err
    }
    if (!ahr.some(p => p.name === pool)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `AHR pool '${pool}' not found` } }
    }

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
      async () => {
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
      },
    )
    reply.code(202)
    return { job }
  })
}
