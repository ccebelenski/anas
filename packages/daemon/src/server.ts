import Fastify from 'fastify'
import { healthRoutes } from './routes/health.js'
import { jobRoutes } from './routes/jobs.js'
import { JobQueue } from './jobs/queue.js'

export function createServer() {
  const server = Fastify({
    logger: true,
  })

  const jobQueue = new JobQueue()

  server.register(healthRoutes, { prefix: '/v1' })
  server.register(jobRoutes, { prefix: '/v1', jobQueue })

  // Expose jobQueue on the server instance so route plugins can access it
  server.decorate('jobQueue', jobQueue)

  return server
}
