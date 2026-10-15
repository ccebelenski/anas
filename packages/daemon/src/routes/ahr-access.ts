import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { AccessOutcome, AccessService, AhrAccessTarget, SetAccessPlan } from '../services/access.js'
import type { IscsiPaths } from '../services/iscsi.js'
import { PoolName, SetAccessRequest } from '@anas/shared'
import { guardCheck, guardConfirm, guarded, sendRefusal } from '../safety/guard.js'
import { createAccessService, SET_ACCESS_PRESENTATION_ONLY, signedAccessRequest } from '../services/access.js'
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
   * Pool name → the pool's mounted directory, or the refusal. 404 for an
   * unknown pool and for an unmounted one — the same answer the datasets
   * editor gives an unmounted dataset: access applies to a directory.
   */
  async function resolve(raw: string): Promise<AccessOutcome<AhrAccessTarget>> {
    const parsed = PoolName.safeParse(raw)
    if (!parsed.success)
      return { ok: false, failure: { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${parsed.error.issues[0]?.message}` } } } }
    const name = parsed.data
    const pool = (await readAhrPools(executor)).find(p => p.name === name)
    if (!pool)
      return { ok: false, failure: { status: 404, body: { error: { code: 'NOT_FOUND', message: `AHR pool '${name}' not found` } } } }
    if (!pool.mounted || !pool.mountpoint.startsWith('/'))
      return { ok: false, failure: { status: 404, body: { error: { code: 'NOT_FOUND', message: `AHR pool '${name}' is not a mounted filesystem` } } } }
    return {
      ok: true,
      value: {
        kind: 'ahr',
        pool: name,
        mountpoint: pool.mountpoint,
        record: { name: pool.name, mountpoint: pool.mountpoint, mounted: pool.mounted },
        // cr.33 §4.2: the pool's lock key.
        ...(pool.vg.uuid ? { vgUuid: pool.vg.uuid } : {}),
      },
    }
  }

  // --- GET /ahr/:name/access ----------------------------------------------
  server.get<{ Params: { name: string } }>('/ahr/:name/access', async (request, reply) => {
    const target = await resolve(request.params.name)
    if (!target.ok) {
      reply.code(target.failure.status)
      return target.failure.body
    }
    const read = await access.readAccess(target.value)
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

    // Story cr.37: the one `fs.setAccess` guard spec — the pool resolves to
    // its mount (404), a PVE storage path at or above the mount (400) and,
    // for applyToExisting, one inside the tree (400), the directory read and
    // the plan from its live state, whose revision the confirm and the job
    // bind. The job runs them all again before anything is written.
    const spec = access.setAccessGuardSpec({
      what: `AHR pool '${request.params.name}'`,
      address: { pool: request.params.name },
      req,
      resolve: () => resolve(request.params.name),
    })
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const plan = pre.object.plan as SetAccessPlan

    // A recursive apply is confirm-gated (ruling 2026-10-11), asked last;
    // cr.37: bound to the whole request and the ACL revision.
    if (plan.recursive) {
      const confirm = await access.recursiveConfirm(plan.target, { named: plan.hasNamed, walk: plan.walk })
      if (!guardConfirm(confirmStore, request, reply, spec, pre, {
        validated: { pool: request.params.name, ...signedAccessRequest(req) },
        address: ['pool'],
        presentationOnly: SET_ACCESS_PRESENTATION_ONLY,
        message: confirm.message,
        warnings: confirm.warnings,
      })) {
        return reply
      }
    }

    const job = jobQueue.submit(
      'fs.setAccess',
      { ...identity, params: access.jobParams(plan) },
      guarded(spec, pre, async (_o, ctx) => access.runSetAccess(plan, ctx.updateProgress)),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  })
}
