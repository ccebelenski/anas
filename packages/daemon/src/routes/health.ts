import type { HealthResponse } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import { VERSION } from '@anas/shared'
import { abandonedChildren } from '../executor/deadline.js'

export async function healthRoutes(server: FastifyInstance) {
  server.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      version: VERSION,
      // cr.34: commands the executor gave up on (they outlived their deadline
      // and its SIGKILL) and that are still running. The daemon itself is
      // fine — the status stays 'ok' — but whatever they hang on is not.
      abandonedCommands: abandonedChildren.list(),
    }
  })
}
