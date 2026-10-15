import type { AbandonedCommand, HealthResponse } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { AbandonedChild } from '../executor/deadline.js'
import { VERSION } from '@anas/shared'
import { abandonedChildren } from '../executor/deadline.js'

/**
 * What GET /v1/health says about one abandoned child (cr.34r): the label and
 * the executable, the way the audit log names a command that timed out (its
 * job error is the `CommandTimeoutError` sentence, built on the label alone)
 * — never the raw argv, which the registry keeps for the daemon only.
 */
export function servedAbandoned(c: AbandonedChild): AbandonedCommand {
  return {
    pid: c.pid,
    label: c.label,
    command: c.command,
    cause: c.cause ?? 'deadline',
    lane: c.lane,
    ...(c.jobId !== undefined ? { jobId: c.jobId } : {}),
    budgetMs: c.budgetMs,
    since: c.since,
  }
}

export async function healthRoutes(server: FastifyInstance) {
  server.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      version: VERSION,
      // cr.34: commands the executor gave up on (they outlived their deadline
      // and its SIGKILL) and that are still running. The daemon itself is
      // fine — the status stays 'ok' — but whatever they hang on is not.
      abandonedCommands: abandonedChildren.list().map(servedAbandoned),
    }
  })
}
