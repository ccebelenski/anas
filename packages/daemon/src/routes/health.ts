import type { FastifyInstance } from 'fastify'
import { VERSION } from '@anas/shared'

export async function healthRoutes(server: FastifyInstance) {
  server.get('/health', async () => {
    return {
      status: 'ok',
      version: VERSION,
    }
  })
}
