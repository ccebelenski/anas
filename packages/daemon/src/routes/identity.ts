import type { FastifyReply, FastifyRequest } from 'fastify'
import type { JobSubmitter } from '../jobs/queue.js'
import { RequestHeaders } from '@anas/shared'

/**
 * Extract the authenticated user's identity from X-Anas-* headers.
 *
 * Every mutation requires identity — anasd never executes an operation
 * without knowing who requested it (Principle 3). Returns null after
 * sending a 401 if the headers are missing or invalid.
 */
export function requireIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
): JobSubmitter | null {
  const parsed = RequestHeaders.safeParse(request.headers)

  if (!parsed.success) {
    reply.code(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid identity headers (x-anas-user, x-anas-user-uid, x-anas-request-id)',
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
