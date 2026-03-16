import type { CommandExecutor } from './executor/types.js'
import Fastify from 'fastify'
import { AuditLogger } from './audit/logger.js'
import { MockExecutor } from './executor/mock.js'
import { ProdExecutor } from './executor/prod.js'
import { mockFixtures } from './fixtures/loader.js'
import { JobQueue } from './jobs/queue.js'
import { LSBLK_ARGS } from './parsers/lsblk.js'
import { healthRoutes } from './routes/health.js'
import { jobRoutes } from './routes/jobs.js'
import { diskRoutes } from './routes/disks.js'
import { poolRoutes } from './routes/pools.js'

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

  // Register mock fixtures for dev mode
  if (opts?.mock) {
    const mock = executor as MockExecutor
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: mockFixtures.zpoolList() })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: mockFixtures.zpoolStatus() })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['get', 'all', '-j'], result: mockFixtures.zpoolGetAll('testpool') })
    mock.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: mockFixtures.lsblk() })
    mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    mock.addFixture({ command: '/usr/sbin/smartctl', result: mockFixtures.smartctl() })
  }

  server.register(healthRoutes, { prefix: '/v1' })
  server.register(jobRoutes, { prefix: '/v1', jobQueue })
  server.register(poolRoutes, { prefix: '/v1', executor })
  server.register(diskRoutes, { prefix: '/v1', executor })

  server.decorate('jobQueue', jobQueue)
  server.decorate('executor', executor)

  return server
}
