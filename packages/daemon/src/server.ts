import type { CommandExecutor } from './executor/types.js'
import Fastify from 'fastify'
import { AuditLogger } from './audit/logger.js'
import { MockExecutor } from './executor/mock.js'
import { ProdExecutor } from './executor/prod.js'
import { JobQueue } from './jobs/queue.js'
import { healthRoutes } from './routes/health.js'
import { jobRoutes } from './routes/jobs.js'

export interface ServerOptions {
  /** Use mock executor instead of real commands. Default: false. */
  mock?: boolean
}

export function createServer(opts?: ServerOptions) {
  const server = Fastify({
    logger: true,
  })

  const audit = new AuditLogger(server.log)
  const jobQueue = new JobQueue({ audit })
  const executor: CommandExecutor = opts?.mock
    ? new MockExecutor()
    : new ProdExecutor()

  server.register(healthRoutes, { prefix: '/v1' })
  server.register(jobRoutes, { prefix: '/v1', jobQueue })

  server.decorate('jobQueue', jobQueue)
  server.decorate('executor', executor)

  return server
}
