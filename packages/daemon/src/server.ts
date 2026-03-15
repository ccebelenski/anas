import Fastify from 'fastify'
import { healthRoutes } from './routes/health.js'

export function createServer() {
  const server = Fastify({
    logger: true,
  })

  server.register(healthRoutes, { prefix: '/v1' })

  return server
}
