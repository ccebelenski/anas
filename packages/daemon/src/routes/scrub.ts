import type { LastScrub, PeriodicScrubState } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import { PoolName, ScrubToggleRequest } from '@anas/shared'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { parseLastScrubs } from '../parsers/zpool-status.js'
import { readAhrPools } from '../services/ahr-topology.js'
import {
  readAhrScrubState,
  readZfsScrubState,
  setAhrScrubEnabled,
  setZfsScrubEnabled,
} from '../services/scrub-schedules.js'
import { requireIdentity } from './identity.js'

const ZPOOL = '/usr/sbin/zpool'

/**
 * Periodic SCRUB — uniform surface, filesystem-native backend (Epic 17.5,
 * docs/SCHEDULES-DESIGN.md §Scrub). One "periodic scrub: on/off (monthly)"
 * control for a ZFS pool and an AHR pool; the toggle flips the filesystem's own
 * switch (ZFS: `org.debian:periodic-scrub` property; AHR: mdadm's mdcheck timers).
 *
 *   GET /v1/scrub                → uniform state for every ZFS + AHR pool
 *   PUT /v1/scrub/zfs/:pool  {enabled}  → flip the ZFS property (202 job)
 *   PUT /v1/scrub/ahr/:pool  {enabled}  → flip the node's mdcheck timers (202 job)
 *
 * Each state also carries `lastScrub` — the pool's last COMPLETED verify pass
 * (17.3's "`zpool status` scrub dates"). ZFS records one; md records NONE, so an
 * AHR state's `lastScrub` is always null and the screen says so in words rather
 * than inventing a record from journald or a state file.
 *
 * Toggles are jobs (Principle 4). ANAS deliberately does NOT touch the (disabled)
 * systemd `zfs-scrub-*@.timer` for ZFS, so the property remains the single lever
 * and there is no double-scrub (GT-4). The AHR toggle is NODE-GLOBAL (mdcheck
 * checks every array) — surfaced in each state's `note`.
 */
export interface ScrubRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
}

export async function scrubRoutes(server: FastifyInstance, opts: ScrubRouteOptions) {
  const { executor, jobQueue } = opts

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

  /** Live AHR pool names (fail-open to []). */
  async function ahrPoolNames(): Promise<string[]> {
    try {
      return (await readAhrPools(executor)).map(p => p.name)
    }
    catch {
      return []
    }
  }

  /**
   * Each ZFS pool's last COMPLETED verify pass, from the one `zpool status`
   * ZFS already reports it in (no new source, one read for every pool).
   * Fail-open to an empty map — an unreadable status means "no record", which
   * is exactly how a pool that has never scrubbed reads.
   */
  async function zfsLastScrubs(): Promise<Map<string, LastScrub | null>> {
    try {
      const r = await executor.exec(ZPOOL, ['status', '-jv'])
      return r.exitCode === 0 && r.stdout.trim() ? parseLastScrubs(r.stdout) : new Map()
    }
    catch {
      return new Map()
    }
  }

  // --- GET /scrub — uniform periodic-scrub state across ZFS + AHR pools ------
  server.get('/scrub', async () => {
    const [zfsPools, ahrPools, lastScrubs] = await Promise.all([zfsPoolNames(), ahrPoolNames(), zfsLastScrubs()])
    const states: PeriodicScrubState[] = [
      ...await Promise.all(zfsPools.map(p => readZfsScrubState(executor, p, lastScrubs.get(p) ?? null))),
      ...await Promise.all(ahrPools.map(p => readAhrScrubState(executor, p))),
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

  // --- PUT /scrub/ahr/:pool — flip the node's mdcheck timers (node-global) ---
  server.put<{ Params: { pool: string } }>('/scrub/ahr/:pool', async (request, reply) => {
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

    if (!(await ahrPoolNames()).includes(pool)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `AHR pool '${pool}' not found` } }
    }

    const job = jobQueue.submit(
      'scrub.ahr.toggle',
      { ...identity, params: { pool, enabled: String(enabled) } },
      async () => {
        // NODE-GLOBAL: this governs md periodic checks for every array on the host.
        await setAhrScrubEnabled(executor, enabled)
        return { pool, periodicScrub: enabled, scope: 'node-global' }
      },
    )
    reply.code(202)
    return { job }
  })
}
