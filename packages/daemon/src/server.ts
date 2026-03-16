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
import { DiskIdentityCache } from './services/disk-identity-cache.js'

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
    // Identity + health call used by DiskIdentityCache (smartctl -iH)
    const wdIdentity = { model_family: 'Western Digital Black', model_name: 'WDC WD2003FZEX-00SRLA0', form_factor: { name: '3.5 inches' }, firmware_version: '81.00A81', sata_version: { string: 'SATA 3.1, 6.0 Gb/s' }, smart_status: { passed: true } }
    mock.addFixture({ command: '/usr/sbin/smartctl', args: ['-iH', '--json', '/dev/sda'], result: {
      stdout: JSON.stringify({ model_family: 'Samsung 870 EVO', model_name: 'Samsung SSD 870 EVO 250GB', form_factor: { name: '2.5 inches' }, firmware_version: 'SVT02B6Q', sata_version: { string: 'SATA 3.2, 6.0 Gb/s' }, trim: { supported: true }, smart_status: { passed: true } }),
      stderr: '', exitCode: 0,
    } })
    for (const dev of ['/dev/sdb', '/dev/sdc', '/dev/sdd', '/dev/sde', '/dev/sdf']) {
      mock.addFixture({ command: '/usr/sbin/smartctl', args: ['-iH', '--json', dev], result: {
        stdout: JSON.stringify(wdIdentity), stderr: '', exitCode: 0,
      } })
    }
  }

  server.register(healthRoutes, { prefix: '/v1' })
  server.register(jobRoutes, { prefix: '/v1', jobQueue })
  server.register(poolRoutes, { prefix: '/v1', executor })
  const diskIdentityCache = new DiskIdentityCache(executor)
  server.register(diskRoutes, { prefix: '/v1', executor, diskIdentityCache })

  server.decorate('jobQueue', jobQueue)
  server.decorate('executor', executor)

  return server
}
