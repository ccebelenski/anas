import type { FastifyReply, FastifyRequest } from 'fastify'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { AccessService, SetAccessPlan } from '../services/access.js'
import { SetAccessRequest } from '@anas/shared'
import { guardCheck, guardConfirm, guarded, sendRefusal } from '../safety/guard.js'
import { SET_ACCESS_PRESENTATION_ONLY, signedAccessRequest, targetBacking } from '../services/access.js'
import { requireIdentity } from './identity.js'

/**
 * The share row's Permissions button (access.1): the SAME editor, opened on a
 * share's path. Both share routes (SMB by name, NFS by path) resolve their
 * share from the config file first — the file is the source of truth — and
 * hand the path here. The path resolves onto its home (ZFS dataset, AHR pool,
 * or neither) and every gate and difference follows from that home, exactly
 * as for the datasets and AHR editors.
 */
export function shareAccessHandlers(opts: { access: AccessService, jobQueue: JobQueue, confirmStore: ConfirmStore }) {
  const { access, jobQueue, confirmStore } = opts

  /** GET …/access on a share path. */
  async function get(path: string, reply: FastifyReply) {
    const target = await access.resolveShareTarget(path)
    const read = await access.readAccess(target)
    if (!read.ok) {
      reply.code(read.failure.status)
      return read.failure.body
    }
    return { data: { ...read.value, backing: targetBacking(target) } }
  }

  /** PUT …/access on a share path — `audit` names the share in the job params. */
  async function put(path: string, audit: Record<string, string>, request: FastifyRequest, reply: FastifyReply) {
    const bodyParsed = SetAccessRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid access request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story cr.37: the one `fs.setAccess` guard spec — the path resolves onto
    // its home, the path gates (PVE territory at or above it, and for
    // applyToExisting inside it), the directory read and the plan from its
    // live state, whose revision the confirm and the job bind. The job runs
    // them all again before anything is written.
    const spec = access.setAccessGuardSpec({
      what: `Share path '${path}'`,
      address: { path },
      req,
      resolve: async () => ({ ok: true, value: await access.resolveShareTarget(path) }),
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
        validated: { path, ...signedAccessRequest(req) },
        address: ['path'],
        presentationOnly: SET_ACCESS_PRESENTATION_ONLY,
        message: confirm.message,
        warnings: confirm.warnings,
      })) {
        return reply
      }
    }
    const job = jobQueue.submit(
      'fs.setAccess',
      { ...identity, params: { ...audit, ...access.jobParams(plan) } },
      guarded(spec, pre, async (_o, ctx) => access.runSetAccess(plan, ctx.updateProgress)),
      { locks: pre.locks },
    )
    reply.code(202)
    return { job }
  }

  return { get, put }
}
