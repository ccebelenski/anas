import type { FastifyReply, FastifyRequest } from 'fastify'
import type { JobSubmitter } from '../jobs/queue.js'
import { RequestHeaders } from '@anas/shared'

/**
 * Extract the authenticated user's identity from X-Anas-* headers.
 *
 * Every mutation requires identity — anasd never executes an operation
 * without knowing who requested it (Principle 3). Returns null after
 * sending a 401 if the headers are missing or invalid.
 *
 * Since cr.28 the identity includes `x-anas-privileges` (what PVE granted on
 * `/`): a request without it, or with one that is not a privilege list, is
 * refused here like a missing user (fail closed) and the refusal is logged
 * with the header that failed. The privileges themselves are enforced at the
 * job queue (jobs/authority.ts), which reads them from the request, not from
 * the submitter a route builds.
 */
export function requireIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
): JobSubmitter | null {
  const parsed = RequestHeaders.safeParse(request.headers)

  if (!parsed.success) {
    const reason = parsed.error.issues
      .map(i => `${i.path.join('.') || '(headers)'}: ${i.message}`)
      .join('; ')
    request.log.warn(`[authz] refused ${request.method} ${request.url.split('?', 1)[0]}: invalid identity headers (${reason})`)
    reply.code(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid identity headers (x-anas-user, x-anas-user-uid, x-anas-request-id, x-anas-privileges)',
      },
    })
    return null
  }

  return {
    user: parsed.data['x-anas-user'],
    uid: parsed.data['x-anas-user-uid'],
    requestId: parsed.data['x-anas-request-id'],
  }
}
