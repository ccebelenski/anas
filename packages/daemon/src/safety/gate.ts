import type { FastifyReply, FastifyRequest } from 'fastify'
import type { BoundId, ConfirmStore } from './confirm.js'

/**
 * Confirmation gate for a dangerous operation (Principle 14, Level 2).
 *
 * If the request carries a valid `x-anas-confirm` header for this exact
 * operation signature, consume it and return true — the caller proceeds to
 * submit the job. Otherwise mint a fresh code, send a 409 CONFIRMATION_REQUIRED
 * with the warnings and the `X-Anas-Confirm-Code` / `X-Anas-Confirm-Expires`
 * headers, and return false — the caller must `return reply`.
 *
 * A wrong or expired code follows the same no-valid-confirm path: a new code is
 * issued and the client retries. The confirm code is tied to `operation` +
 * `params` (resource + method), not to incidental request options.
 */
export function confirmGate(
  store: ConfirmStore,
  request: FastifyRequest,
  reply: FastifyReply,
  opts: {
    operation: string
    params: Record<string, unknown>
    /** Story ident.1: a stable id bound into the signature (see stable-id.ts). */
    bound?: BoundId
    message: string
    warnings: string[]
  },
): boolean {
  const provided = request.headers['x-anas-confirm']
  if (typeof provided === 'string' && store.verifyCode(provided, opts.operation, opts.params, opts.bound))
    return true

  const { code, expiresAt } = store.generateCode(opts.operation, opts.params, opts.bound)
  reply.code(409)
  reply.header('X-Anas-Confirm-Code', code)
  reply.header('X-Anas-Confirm-Expires', expiresAt)
  reply.send({
    error: {
      code: 'CONFIRMATION_REQUIRED',
      message: opts.message,
      warnings: opts.warnings,
    },
  })
  return false
}
