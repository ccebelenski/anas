import type { FastifyReply, FastifyRequest } from 'fastify'
import type { JobQueue } from '../jobs/queue.js'
import type { AccessService } from '../services/access.js'
import { SetAccessRequest } from '@anas/shared'
import { targetBacking } from '../services/access.js'
import { requireIdentity } from './identity.js'

/**
 * The share row's Permissions button (access.1): the SAME editor, opened on a
 * share's path. Both share routes (SMB by name, NFS by path) resolve their
 * share from the config file first — the file is the source of truth — and
 * hand the path here. The path resolves onto its home (ZFS dataset, AHR pool,
 * or neither) and every gate and difference follows from that home, exactly
 * as for the datasets and AHR editors.
 */
export function shareAccessHandlers(opts: { access: AccessService, jobQueue: JobQueue }) {
  const { access, jobQueue } = opts

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

    const target = await access.resolveShareTarget(path)
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
    const job = jobQueue.submit(
      'fs.setAccess',
      { ...identity, params: { ...audit, ...access.jobParams(plan) } },
      async updateProgress => access.runSetAccess(plan, updateProgress),
    )
    reply.code(202)
    return { job }
  }

  return { get, put }
}
