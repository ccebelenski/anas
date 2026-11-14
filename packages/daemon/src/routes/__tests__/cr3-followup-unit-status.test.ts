import type { ReplicationTask, SnapshotSchedule, StatusSummary } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { deriveTaskStatus, writeTaskUnits } from '../../services/replication-units.js'
import { collectScheduleWarnings, deriveScheduleStatus, writeScheduleUnits } from '../../services/snapshot-schedule-units.js'
import { dashboardRoutes } from '../dashboard.js'

/**
 * cr3.followup item 6 — only the backup and cloud collectors noticed when
 * systemd could not be asked. A snapshot schedule's and a replication task's
 * status derived from a `systemctl show` that failed read `unknown`, which
 * warns about nothing: with systemd unreachable, the dashboard's schedules
 * and replication sections read all clear. Now each row says its status could
 * not be read (`statusUnreadable`, the name the task stores use), and the
 * sections are unavailable — or, with readable rows beside, incomplete.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const JOURNALCTL = '/usr/bin/journalctl'
const BUS_DOWN = { stdout: '', stderr: 'Failed to connect to bus: Connection refused', exitCode: 1 }
const NO_JOURNAL = { stdout: '', stderr: 'Failed to get journal access', exitCode: 1 }
const OK = { stdout: '', stderr: '', exitCode: 0 }

const SCHEDULE: SnapshotSchedule = {
  id: 'nightly-tank-media',
  name: 'Nightly tank/media',
  target: { kind: 'zfs', dataset: 'tank/media' },
  cadence: 'daily',
  retention: { daily: 7, weekly: 4, monthly: 6 },
  recursive: false,
  enabled: true,
  notify: 'on-failure',
} as SnapshotSchedule

const TASK = {
  name: 'nightly',
  source: { pool: 'testpool', dataset: 'media' },
  target: { pool: 'backup', dataset: 'media' },
  schedule: 'daily',
  snapshotFirst: true,
  enabled: true,
  notify: 'on-failure',
} as ReplicationTask

/** A unit directory holding one enabled schedule and one replication task. */
async function store(): Promise<{ root: string, dir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'anas-cr3-followup-units-'))
  const dir = join(root, 'systemd')
  await mkdir(dir, { recursive: true })
  const writer = new MockExecutor()
  writer.addFixture({ command: SYSTEMCTL, result: OK })
  await writeScheduleUnits(writer, dir, SCHEDULE)
  await writeTaskUnits(writer, dir, TASK)
  return { root, dir }
}

function blindSystemd(): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: SYSTEMCTL, result: BUS_DOWN })
  mock.addFixture({ command: JOURNALCTL, result: NO_JOURNAL })
  return mock
}

describe('cr3.followup — a unit status systemd could not answer is never "all clear"', () => {
  it('a schedule row says its status could not be read', async () => {
    const status = await deriveScheduleStatus(blindSystemd(), SCHEDULE)
    assert.equal(status.statusUnreadable, true)
  })

  it('a replication task row says its status could not be read', async () => {
    const status = await deriveTaskStatus(blindSystemd(), TASK)
    assert.equal(status.statusUnreadable, true)
  })

  it('control: a systemd that answers leaves no mark', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: 'ActiveState=inactive\nResult=success\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: JOURNALCTL, result: OK })
    assert.equal((await deriveScheduleStatus(mock, SCHEDULE)).statusUnreadable, undefined)
    assert.equal((await deriveTaskStatus(mock, TASK)).statusUnreadable, undefined)
  })

  it('the schedule collector THROWS when no row could be read (was: [] — nothing warned)', async () => {
    const { root, dir } = await store()
    try {
      await assert.rejects(collectScheduleWarnings(blindSystemd(), dir), /systemd could not be asked about snapshot schedule 'Nightly tank\/media'/)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a partial failure: the readable schedule still warns and the section says what it could not see', async () => {
    const { root, dir } = await store()
    try {
      const failing = { ...SCHEDULE, id: 'hourly-tank', name: 'Hourly tank' } as SnapshotSchedule
      const writer = new MockExecutor()
      writer.addFixture({ command: SYSTEMCTL, result: OK })
      await writeScheduleUnits(writer, dir, failing)
      const mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, argsMatch: a => a[0] === 'show' && a[1] === 'anas-snap-hourly-tank.service', result: BUS_DOWN })
      mock.addFixture({ command: SYSTEMCTL, argsMatch: a => a[0] === 'show' && a[1] === 'anas-snap-nightly-tank-media.service', result: { stdout: 'ActiveState=failed\nResult=exit-code\nExecMainStatus=1\n', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: SYSTEMCTL, result: OK })
      mock.addFixture({ command: JOURNALCTL, result: OK })
      const said: string[] = []
      const warnings = await collectScheduleWarnings(mock, dir, r => said.push(r))
      assert.deepEqual(warnings.map(w => w.ref), [SCHEDULE.id])
      assert.match(said.join(' '), /systemd could not be asked about snapshot schedule 'Hourly tank'/)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('GET /v1/status: with systemctl show and journalctl failing, both sections are listed unavailable', async () => {
    const { root, dir } = await store()
    const executor = blindSystemd()
    const srv = Fastify({ logger: false })
    try {
      await srv.register(dashboardRoutes, {
        prefix: '/v1',
        executor,
        jobQueue: new JobQueue(),
        diskIdentityCache: new DiskIdentityCache(executor),
        smbConfPath: join(root, 'smb.conf'),
        exportsPath: join(root, 'exports'),
        systemdDir: dir,
        fstabPath: join(root, 'fstab'),
        sectionBudgetMs: 5_000,
      })
      const res = await srv.inject({ method: 'GET', url: '/v1/status', headers: { 'x-anas-user': 'root@pam', 'x-anas-user-uid': '0', 'x-anas-privileges': 'Sys.Audit,Sys.Modify', 'x-anas-request-id': randomUUID() } })
      assert.equal(res.statusCode, 200, res.body)
      const data = (res.json() as { data: StatusSummary }).data
      assert.ok(data.unavailable?.includes('schedules'), JSON.stringify(data.unavailable))
      assert.ok(data.unavailable?.includes('replication'), JSON.stringify(data.unavailable))
      const cards = data.warnings.filter(w => w.category === 'unavailable').map(w => w.message).join(' | ')
      assert.match(cards, /systemd could not be asked about snapshot schedule 'Nightly tank\/media'/)
      assert.match(cards, /systemd could not be asked about replication task 'nightly'/)
    }
    finally {
      await srv.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
