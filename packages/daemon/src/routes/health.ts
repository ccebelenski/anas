import type { FastifyInstance } from 'fastify'

const VERSION = '0.1.0'

export async function healthRoutes(server: FastifyInstance) {
  server.get('/health', async () => {
    return {
      status: 'ok',
      version: VERSION,
    }
  })
}
