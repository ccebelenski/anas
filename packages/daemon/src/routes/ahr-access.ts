import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { AccessService, AhrAccessTarget } from '../services/access.js'
import type { IscsiPaths } from '../services/iscsi.js'
import { PoolName, SetAccessRequest } from '@anas/shared'
import { confirmGate } from '../safety/gate.js'
import { createAccessService } from '../services/access.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { requireIdentity } from './identity.js'

/**
 * The AHR permissions editor (story access.2, GitHub #75):
 *
 *   GET /v1/ahr/:name/access — the layered access state of the pool's mount
 *   PUT /v1/ahr/:name/access — set it (202 job, `fs.setAccess`)
 *
 * The SAME writer the datasets editor runs (services/access.ts), the same
 * request/response schemas, and only the differences the filesystem forces:
 * btrfs carries POSIX ACLs natively, so there is no `acltype` step (never a
 * `zfs set` here), and a recursive apply sweeps the subvolumes under `@data`
 * as one tree — `@snapshots` is a sibling outside the mountpoint (AHR-DESIGN
 * §12), so it is never entered. PVE territory is the storage paths
 * storage.cfg names. A pool holding an iSCSI LUN image is NOT refused
 * (operator ruling 2026-10-11): a permission change leaves the image's
 * contents alone, and the recursive apply's confirm names the LUN.
 */
export async function ahrAccessRoutes(
  server: FastifyInstance,
  opts: {
    executor: CommandExecutor
    jobQueue: JobQueue
    /** The recursive apply's 409 + X-Anas-Confirm-Code (ruling 2026-10-11). */
    confirmStore: ConfirmStore
    iscsiPaths?: IscsiPaths
    accessService?: AccessService
  },
) {
  const { executor, jobQueue, confirmStore } = opts
  const access = opts.accessService ?? createAccessService({ executor, iscsiPaths: opts.iscsiPaths ?? {} })

  /**
   * Pool name → the pool's mounted directory, or the refusal already sent.
   * 404 for an unknown pool and for an unmounted one — the same answer the
   * datasets editor gives an unmounted dataset: access applies to a directory.
   */
  async function resolveTarget(raw: string, reply: FastifyReply): Promise<AhrAccessTarget | null> {
    const parsed = PoolName.safeParse(raw)
    if (!parsed.success) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${parsed.error.issues[0]?.message}` } })
      return null
    }
    const name = parsed.data
    const pool = (await readAhrPools(executor)).find(p => p.name === name)
    if (!pool) {
      reply.code(404)
      reply.send({ error: { code: 'NOT_FOUND', message: `AHR pool '${name}' not found` } })
      return null
    }
    if (!pool.mounted || !pool.mountpoint.startsWith('/')) {
      reply.code(404)
      reply.send({ error: { code: 'NOT_FOUND', message: `AHR pool '${name}' is not a mounted filesystem` } })
      return null
    }
    return {
      kind: 'ahr',
      pool: name,
      mountpoint: pool.mountpoint,
      record: { name: pool.name, mountpoint: pool.mountpoint, mounted: pool.mounted },
    }
  }

  // --- GET /ahr/:name/access ----------------------------------------------
  server.get<{ Params: { name: string } }>('/ahr/:name/access', async (request, reply) => {
    const target = await resolveTarget(request.params.name, reply)
    if (!target)
      return reply
    const read = await access.readAccess(target)
    if (!read.ok) {
      reply.code(read.failure.status)
      return read.failure.body
    }
    return { data: { ...read.value, backing: 'ahr' } }
  })

  // --- PUT /ahr/:name/access ----------------------------------------------
  server.put<{ Params: { name: string } }>('/ahr/:name/access', async (request, reply) => {
    const bodyParsed = SetAccessRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid access request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const target = await resolveTarget(request.params.name, reply)
    if (!target)
      return reply

    // PVE storage path at or above the mount (400), and — for
    // applyToExisting — a PVE storage path inside the tree (400), before any
    // command runs.
    const refused = await access.guardPathTarget(target, req)
    if (refused) {
      reply.code(refused.status)
      return refused.body
    }

    const planned = await access.planSetAccess(target, req)
    if (!planned.ok) {
      reply.code(planned.failure.status)
      return planned.failure.body
    }
    const plan = planned.value

    // A recursive apply is confirm-gated (ruling 2026-10-11), asked last.
    if (plan.recursive && !confirmGate(confirmStore, request, reply, await access.recursiveConfirm(plan.target, { named: plan.hasNamed })))
      return reply

    const job = jobQueue.submit(
      'fs.setAccess',
      { ...identity, params: access.jobParams(plan) },
      async updateProgress => access.runSetAccess(plan, updateProgress),
    )
    reply.code(202)
    return { job }
  })
}
