import type { StatusSummary } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { StatusSummary as StatusSummarySchema } from '@anas/shared'
import Fastify from 'fastify'
import { abandonedChildren, runInLane } from '../../executor/deadline.js'
import { MockExecutor as Mock } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { createServer } from '../../server.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { buildUnavailableWarnings, DASHBOARD_SECTION_BUDGET_MS, dashboardRoutes, readDashboardSection } from '../dashboard.js'

/**
 * cr.35 — GET /v1/status fails open PER SECTION, and says so (WAVE3-DESIGN
 * §6.2 "Display: the section reads 'unavailable: <command> did not answer
 * within <n> s' — never empty, never 404. The dashboard turns it into a
 * warning card, so a suspended pool is visible instead of absent").
 *
 * The never-answering command is the MockExecutor's `timesOut` fixture (the
 * CommandTimeoutError the real executor raises at the deadline) or a `live`
 * child that ignores every signal (a process stuck in the kernel, which the
 * section's wall budget has to give up on). Everything else replays the dev
 * server's captured fixtures (ruling (l)).
 */

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const ZPOOL = '/usr/sbin/zpool'

describe('cr.35 readDashboardSection: done, timed out, failed, late', () => {
  it('a read that answers is the section, with nothing unavailable', async () => {
    const r = await readDashboardSection(new Mock(), 1_000, 'jobs', [] as string[], async () => ['a'])
    assert.deepEqual(r, { value: ['a'] })
  })

  it('a timeout the collector CAUGHT still marks the section unavailable, naming the command (its value is kept, never presented as complete)', async () => {
    const mock = new Mock().addFixture({ command: ZPOOL, timesOut: {} })
    const r = await runInLane({ lane: 'request' }, () => readDashboardSection(mock, 1_000, 'pools', ['fallback'], async (exec) => {
      try {
        await exec.exec(ZPOOL, ['list', '-j'])
      }
      catch { /* the collector's fail-open catch */ }
      return [] as string[]
    }))
    assert.deepEqual(r.value, [])
    assert.equal(r.unavailable?.section, 'pools')
    assert.match(r.unavailable?.reason ?? '', /^'zpool list' did not finish within 10 s and was stopped/)
  })

  it('a read that throws is the fallback plus the reason', async () => {
    const r = await readDashboardSection(new Mock(), 1_000, 'backup', ['fallback'], async () => {
      throw new Error('boom')
    })
    assert.deepEqual(r, { value: ['fallback'], unavailable: { section: 'backup', reason: 'its read failed: boom' } })
  })

  it('a read that overruns the wall budget (a child no signal stops) is the fallback, naming the command it waits on — and answers at the budget', { timeout: 5_000 }, async () => {
    const mock = new Mock().addFixture({ command: ZPOOL, live: { signalsToExit: Infinity } })
    const started = Date.now()
    const r = await readDashboardSection(mock, 30, 'pools', ['fallback'], async (exec) => {
      await exec.exec(ZPOOL, ['status', '-jv'])
      return ['never']
    })
    assert.ok(Date.now() - started < 1_000)
    assert.deepEqual(r, { value: ['fallback'], unavailable: { section: 'pools', reason: '\'zpool status\' had not answered after 30 ms' } })
    mock.finishLive()
  })

  it('an overrun with no command in flight says the read did not finish', async () => {
    const r = await readDashboardSection(new Mock(), 30, 'mounts', [] as string[], () => new Promise<string[]>(() => {}))
    assert.equal(r.unavailable?.reason, 'its read did not finish within 30 ms')
  })

  it('the card: what is missing, why, and that the rest is current', () => {
    assert.deepEqual(buildUnavailableWarnings([{ section: 'disks', reason: '\'zpool status\' did not finish within 10 s and was stopped' }]), [{
      level: 'warning',
      category: 'unavailable',
      message: 'Disk health is unavailable: \'zpool status\' did not finish within 10 s and was stopped. The rest of the dashboard is current.',
    }])
    assert.equal(DASHBOARD_SECTION_BUDGET_MS, 12_000)
  })
})

describe('cr.35 GET /v1/status with zpool hung', () => {
  let server: ReturnType<typeof createServer> | Awaited<ReturnType<typeof bare>> | undefined
  let tmp: string | undefined
  const STUCK_PID = 999_999_035

  afterEach(async () => {
    await server?.close()
    server = undefined
    abandonedChildren.remove(STUCK_PID)
    if (tmp)
      rmSync(tmp, { recursive: true, force: true })
    tmp = undefined
  })

  async function status(srv: NonNullable<typeof server>): Promise<StatusSummary> {
    const res = await srv.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200, res.body)
    return StatusSummarySchema.parse((res.json() as { data: unknown }).data)
  }

  /** Only the dashboard routes, with a short section budget. */
  async function bare(executor: MockExecutor, dir: string, sectionBudgetMs: number) {
    const srv = Fastify({ logger: false })
    await srv.register(dashboardRoutes, {
      prefix: '/v1',
      executor,
      jobQueue: new JobQueue(),
      diskIdentityCache: new DiskIdentityCache(executor),
      smbConfPath: join(dir, 'smb.conf'),
      exportsPath: join(dir, 'exports'),
      systemdDir: join(dir, 'systemd'),
      fstabPath: join(dir, 'fstab'),
      sectionBudgetMs,
    })
    return srv
  }

  it('control: every section answers — nothing unavailable, no unavailable card, the pools are listed', async () => {
    server = createServer({ mock: true, logger: false })
    const summary = await status(server)
    assert.deepEqual(summary.unavailable, [])
    assert.equal(summary.warnings.filter(w => w.category === 'unavailable').length, 0)
    assert.ok(summary.pools.length > 0)
  })

  it('a zpool that times out: 200, pools and disk health UNAVAILABLE with a card naming zpool — not "no pools"; the other sections render', async () => {
    server = createServer({ mock: true, logger: false })
    await server.ready()
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const healthy = await status(server)
    mock.prependFixture({ command: ZPOOL, args: ['list', '-j'], timesOut: {} })
    mock.prependFixture({ command: ZPOOL, args: ['status', '-jv'], timesOut: {} })
    const summary = await status(server)
    assert.deepEqual(new Set(summary.unavailable), new Set(['disks', 'pools']))
    assert.deepEqual(summary.pools, [])
    const cards = summary.warnings.filter(w => w.category === 'unavailable')
    assert.equal(cards.length, 2)
    assert.match(cards[0].message, /^Pool status is unavailable: 'zpool list' did not finish within 10 s and was stopped .*The rest of the dashboard is current\.$/)
    assert.match(cards[1].message, /^Disk health is unavailable: 'zpool status' did not finish within 10 s/)
    // The cards lead the warnings.
    assert.equal(summary.warnings[0].category, 'unavailable')
    // Everything that did not need zpool is as it was.
    assert.deepEqual(summary.shares, healthy.shares)
    assert.deepEqual(summary.ahrPools, healthy.ahrPools)
  })

  it('a zpool stuck in the kernel: the section budget answers for it — and cr.34\'s abandoned-command card renders beside it', { timeout: 5_000 }, async () => {
    tmp = mkdtempSync(join(tmpdir(), 'anas-dash-sections-'))
    const mock = new Mock().addFixture({ command: ZPOOL, live: { signalsToExit: Infinity } })
    server = await bare(mock, tmp, 50)
    abandonedChildren.add({ pid: STUCK_PID, label: 'zpool status', command: ZPOOL, args: ['status', '-jv'], lane: 'request', budgetMs: 10_000, since: '2026-10-15T09:00:00.000Z' })
    const started = Date.now()
    const summary = await status(server)
    assert.ok(Date.now() - started < 2_000, 'the dashboard answered at its section budget, not at the hung command')
    assert.ok(summary.unavailable?.includes('pools'))
    assert.ok(summary.unavailable?.includes('disks'))
    const pools = summary.warnings.find(w => w.category === 'unavailable' && w.message.startsWith('Pool status'))
    assert.equal(pools?.message, 'Pool status is unavailable: \'zpool list\' had not answered after 50 ms. The rest of the dashboard is current.')
    // Before cr.35 a hung collector held the whole summary, so this card,
    // which exists for exactly that hang, could never reach the screen.
    assert.equal(summary.warnings.filter(w => w.category === 'command').length, 1)
    mock.finishLive()
  })
})
