import type { Job, SnapshotScheduleStatus } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'
import { parseServiceUnit } from '../../services/snapshot-schedule-units.js'

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const JOURNALCTL = '/usr/bin/journalctl'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

function zpoolListJson(names: string[]): string {
  const pools: Record<string, unknown> = {}
  for (const name of names)
    pools[name] = { name, state: 'ONLINE', properties: {} }
  return JSON.stringify({ pools })
}

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

const SCHEDULE = {
  id: 'nightly-media',
  name: 'Nightly media',
  target: { kind: 'zfs' as const, dataset: 'testpool/media' },
  cadence: 'daily' as const,
  retention: { daily: 7 },
  recursive: false,
  enabled: true,
}

describe('snapshot schedule routes (Epic 17.3/17.4)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-schedules-'))
    prevEnv = process.env.ANAS_SYSTEMD_DIR
    process.env.ANAS_SYSTEMD_DIR = dir
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool']), stderr: '', exitCode: 0 } })
    // systemctl (daemon-reload/enable/disable/show) + zfs (list/snapshot/destroy):
    // command-only success. zfs list -t snapshot returns empty → prune no-ops.
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    // journalctl backs the schedule DETAIL (last-run log) — command-only default.
    mock.addFixture({ command: JOURNALCTL, result: { stdout: 'recent snap output', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    if (prevEnv === undefined)
      delete process.env.ANAS_SYSTEMD_DIR
    else
      process.env.ANAS_SYSTEMD_DIR = prevEnv
  })

  async function create(payload: unknown = SCHEDULE) {
    return server.inject({ method: 'POST', url: '/v1/schedules', headers: JSON_HEADERS, payload: JSON.stringify(payload) })
  }

  it('POST creates a schedule → 202, writes the unit files with the embedded JSON', async () => {
    const res = await create()
    assert.equal(res.statusCode, 202)
    const done = await waitForJob(server, (res.json() as { job: { id: string } }).job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))

    const files = await readdir(dir)
    assert.ok(files.includes('anas-snap-nightly-media.service'))
    assert.ok(files.includes('anas-snap-nightly-media.timer'))
    // A body that omits `notify` (9.4) is STORED with the schema's default, so
    // the unit always spells the mode out rather than leaving it implicit.
    assert.deepEqual(
      parseServiceUnit(await readFile(join(dir, 'anas-snap-nightly-media.service'), 'utf-8')),
      { ...SCHEDULE, notify: 'on-failure' },
    )
    // The timer carries the cadence→OnCalendar translation.
    assert.match(await readFile(join(dir, 'anas-snap-nightly-media.timer'), 'utf-8'), /OnCalendar=daily/)
  })

  it('POST a duplicate id → 409', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await create()
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /already exists/)
  })

  it('POST with an invalid body → 400', async () => {
    const res = await create({ ...SCHEDULE, cadence: 'fortnightly' })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /Invalid snapshot schedule/)
  })

  it('POST onto a non-existent pool → 400', async () => {
    const res = await create({ ...SCHEDULE, target: { kind: 'zfs', dataset: 'ghost/media' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /does not exist/)
  })

  it('POST without identity → 401', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/schedules', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(SCHEDULE) })
    assert.equal(res.statusCode, 401)
  })

  it('GET lists derived statuses; GET :id returns the schedule; 404 for unknown', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const list = await server.inject({ method: 'GET', url: '/v1/schedules' })
    assert.equal(list.statusCode, 200)
    const statuses = (list.json() as { data: SnapshotScheduleStatus[] }).data
    assert.equal(statuses.length, 1)
    assert.equal(statuses[0].schedule.id, 'nightly-media')

    const one = await server.inject({ method: 'GET', url: '/v1/schedules/nightly-media' })
    assert.equal(one.statusCode, 200)
    // GET :id is now the DETAIL shape (schedule nested, mirrors backup detail).
    assert.equal(one.json().data.schedule.name, 'Nightly media')

    const missing = await server.inject({ method: 'GET', url: '/v1/schedules/nope' })
    assert.equal(missing.statusCode, 404)
  })

  it('GET :id detail surfaces the unit/timer text + recent journald + exit code', async () => {
    await waitForJob(server, (await create()).json().job.id)
    // Assert the EXACT journalctl args (mirrors backup.test.ts) so the last-run
    // log query stays parallel: -u anas-snap-<id>.service -n 200 -o short-iso.
    mockOf(server).addFixture({
      command: JOURNALCTL,
      args: ['-u', 'anas-snap-nightly-media.service', '-n', '200', '-o', 'short-iso', '--no-pager'],
      result: { stdout: 'snap run log line 1\nsnap run log line 2', stderr: '', exitCode: 0 },
    })

    const res = await server.inject({ method: 'GET', url: '/v1/schedules/nightly-media' })
    assert.equal(res.statusCode, 200)
    const d = res.json().data as {
      schedule: { id: string }
      lastRunResult: string
      lastRunExitCode: number | null
      unit: string
      timer: string
      journal?: string
    }
    assert.equal(d.schedule.id, 'nightly-media')
    // The units, verbatim: the service carries the embedded schedule JSON; the
    // timer carries the cadence→OnCalendar translation.
    assert.match(d.unit, /X-ANAS-Schedule=/)
    assert.match(d.timer, /OnCalendar=daily/)
    // The recent journald blob flows straight through from journalctl.
    assert.equal(d.journal, 'snap run log line 1\nsnap run log line 2')
    // Never run in this test (empty `systemctl show`) → exit code is null, not 0.
    assert.equal(d.lastRunResult, 'unknown')
    assert.equal(d.lastRunExitCode, null)
  })

  it('PUT toggles enabled (rewrites units); id mismatch → 400; unknown → 404', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const put = await server.inject({ method: 'PUT', url: '/v1/schedules/nightly-media', headers: JSON_HEADERS, payload: JSON.stringify({ ...SCHEDULE, enabled: false }) })
    assert.equal(put.statusCode, 202)
    const done = await waitForJob(server, put.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(parseServiceUnit(await readFile(join(dir, 'anas-snap-nightly-media.service'), 'utf-8'))?.enabled, false)

    const mismatch = await server.inject({ method: 'PUT', url: '/v1/schedules/nightly-media', headers: JSON_HEADERS, payload: JSON.stringify({ ...SCHEDULE, id: 'other' }) })
    assert.equal(mismatch.statusCode, 400)

    const unknown = await server.inject({ method: 'PUT', url: '/v1/schedules/ghost', headers: JSON_HEADERS, payload: JSON.stringify({ ...SCHEDULE, id: 'ghost' }) })
    assert.equal(unknown.statusCode, 404)
  })

  // ==========================================================================
  //  Target immutability (#40) — an edit changes POLICY, never the filesystem
  // ==========================================================================
  // Both target inventories the dialog reads are fail-open: a failed /pools or
  // /ahr answers []. An edit dialog that then fell back to "the first thing that
  // did answer" would repoint the schedule at a different filesystem. What a
  // schedule snapshots is part of its identity, exactly like its id — so the
  // daemon refuses to move it at all, however the request was built.

  it('PUT that moves the target dataset → 400, units untouched', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/schedules/nightly-media',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...SCHEDULE, target: { kind: 'zfs', dataset: 'testpool/other' } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /targets zfs:testpool\/media/)
    assert.match(res.json().error.message, /cannot move it to zfs:testpool\/other/)
    assert.deepEqual(
      parseServiceUnit(await readFile(join(dir, 'anas-snap-nightly-media.service'), 'utf-8'))?.target,
      { kind: 'zfs', dataset: 'testpool/media' },
    )
  })

  it('PUT that flips the filesystem KIND → 400 (the #40 substitution, refused at the API)', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/schedules/nightly-media',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...SCHEDULE, target: { kind: 'ahr', pool: 'vault' } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /cannot move it to ahr:vault/)
  })

  it('PUT keeping the same target still edits policy → 202', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/schedules/nightly-media',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...SCHEDULE, cadence: 'hourly', retention: { hourly: 24 } }),
    })
    assert.equal(res.statusCode, 202)
    await waitForJob(server, res.json().job.id)
    assert.equal(
      parseServiceUnit(await readFile(join(dir, 'anas-snap-nightly-media.service'), 'utf-8'))?.cadence,
      'hourly',
    )
  })

  it('POST onto an AHR pool that live topology does not list → 400 (fail-open inventory never creates)', async () => {
    // No mdstat/mdadm fixtures → readAhrPools sees nothing, exactly what the UI's
    // fail-open loader would have shown as an empty list.
    const res = await create({ ...SCHEDULE, id: 'ahr-sched', target: { kind: 'ahr', pool: 'vault' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /AHR pool 'vault' not found/)
  })

  it('DELETE removes the units → 202; unknown → 404', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const del = await server.inject({ method: 'DELETE', url: '/v1/schedules/nightly-media', headers: IDENTITY })
    assert.equal(del.statusCode, 202)
    await waitForJob(server, del.json().job.id)
    assert.deepEqual(await readdir(dir), [])

    const again = await server.inject({ method: 'DELETE', url: '/v1/schedules/nightly-media', headers: IDENTITY })
    assert.equal(again.statusCode, 404)
  })

  it('POST :id/run fires take+prune → 202 job whose result is the take outcome', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const run = await server.inject({ method: 'POST', url: '/v1/schedules/nightly-media/run', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(run.statusCode, 202)
    const done = await waitForJob(server, run.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const result = done.result as { schedule: string, taken: string, pruned: string[], skippedHeld: string[] }
    assert.equal(result.schedule, 'nightly-media')
    assert.match(result.taken, /^anas-daily-\d{4}-\d{2}-\d{2}T\d{6}Z$/)
    assert.deepEqual(result.pruned, [])
    assert.deepEqual(result.skippedHeld, [])
    // The take issued a `zfs snapshot testpool/media@anas-daily-…`.
    const snapCall = mockOf(server).calls.find(c => c.args[0] === 'snapshot')
    assert.ok(snapCall && snapCall.args.some(a => a.startsWith('testpool/media@anas-daily-')))
  })

  it('POST :id/run on an unknown schedule → 404', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/schedules/ghost/run', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(res.statusCode, 404)
  })

  // ==========================================================================
  //  Run notifications (story 9.4) — the per-schedule mode, one emission point
  // ==========================================================================
  // A timer fire and a UI Run Now both reach the daemon's run job, so that job
  // is where the notification is emitted — one site, both triggers. The mode is
  // the SCHEDULE's own (`notify`, riding the unit JSON): the default
  // `on-failure` keeps a healthy hourly schedule silent (17.7's policy), and the
  // opt-in `always` mails the take/prune receipt too.

  const PERL = '/usr/bin/perl'

  /** Every PVE notification the fire emitted (template, severity, title, body). */
  function notifications(mock: MockExecutor): { perl: string, severity: string, title: string, body: string }[] {
    return mock.calls
      .filter(c => c.command === PERL)
      .map(c => ({ perl: c.args[1], severity: c.args[2], title: c.args[3], body: c.args[4] }))
  }

  /** Re-arm the fixtures with perl allowed, and (optionally) a failing zfs. */
  function armNotify(opts: { zfs?: { stderr: string, exitCode: number }, perlExit?: number } = {}): MockExecutor {
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: PERL, result: { stdout: '', stderr: '', exitCode: opts.perlExit ?? 0 } })
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: JOURNALCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({
      command: ZFS,
      result: opts.zfs
        ? { stdout: '', stderr: opts.zfs.stderr, exitCode: opts.zfs.exitCode }
        : { stdout: '', stderr: '', exitCode: 0 },
    })
    return mock
  }

  it('a FAILED fire notifies `error` through the anas-snapshot template, error verbatim', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const failure = 'cannot create snapshot \'testpool/media@anas-daily-x\': out of space'
    const mock = armNotify({ zfs: { stderr: failure, exitCode: 1 } })
    const run = await server.inject({ method: 'POST', url: '/v1/schedules/nightly-media/run', headers: JSON_HEADERS, payload: '{}' })
    const done = await waitForJob(server, run.json().job.id)
    assert.equal(done.status, 'failed')
    const sent = notifications(mock)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].severity, 'error')
    assert.match(sent[0].title, /snapshot schedule 'Nightly media' FAILED/)
    assert.match(sent[0].body, /Target:\s+ZFS dataset testpool\/media/)
    assert.match(sent[0].body, /Cadence:\s+daily/)
    assert.ok(sent[0].body.includes(failure))
    // Snapshot events carry their own template + matcher type.
    assert.ok(sent[0].perl.includes('anas-snapshot'))
  })

  it('a SUCCESSFUL fire is silent on the DEFAULT mode — healthy schedules never mail', async () => {
    // SCHEDULE carries no `notify`, so the schema's `on-failure` applies: the
    // behaviour 9.4 first shipped, unchanged by the arrival of the knob.
    await waitForJob(server, (await create()).json().job.id)
    const mock = armNotify()
    const run = await server.inject({ method: 'POST', url: '/v1/schedules/nightly-media/run', headers: JSON_HEADERS, payload: '{}' })
    assert.equal((await waitForJob(server, run.json().job.id)).status, 'completed')
    assert.deepEqual(notifications(mock), [])
  })

  it('an `always` schedule mails a SUCCESSFUL fire as `info`, with the take/prune receipt', async () => {
    await waitForJob(server, (await create({ ...SCHEDULE, notify: 'always' })).json().job.id)
    const mock = armNotify()
    const run = await server.inject({ method: 'POST', url: '/v1/schedules/nightly-media/run', headers: JSON_HEADERS, payload: '{}' })
    assert.equal((await waitForJob(server, run.json().job.id)).status, 'completed')
    const sent = notifications(mock)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].severity, 'info')
    assert.match(sent[0].title, /snapshot schedule 'Nightly media' succeeded/)
    assert.match(sent[0].body, /Result:\s+success/)
    assert.match(sent[0].body, /Snapshot:\s+anas-daily-/)
    assert.match(sent[0].body, /Pruned:\s+0 destroyed/)
    assert.ok(sent[0].perl.includes('anas-snapshot'))
  })

  it('an `always` schedule still mails a FAILED fire as `error`', async () => {
    await waitForJob(server, (await create({ ...SCHEDULE, notify: 'always' })).json().job.id)
    const mock = armNotify({ zfs: { stderr: 'out of space', exitCode: 1 } })
    const run = await server.inject({ method: 'POST', url: '/v1/schedules/nightly-media/run', headers: JSON_HEADERS, payload: '{}' })
    assert.equal((await waitForJob(server, run.json().job.id)).status, 'failed')
    const sent = notifications(mock)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].severity, 'error')
  })

  it('the mode round-trips through the unit store — an edit that sets it sticks', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const put = await server.inject({
      method: 'PUT',
      url: '/v1/schedules/nightly-media',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...SCHEDULE, notify: 'always' }),
    })
    await waitForJob(server, put.json().job.id)
    const detail = await server.inject({ method: 'GET', url: '/v1/schedules/nightly-media' })
    assert.equal(detail.json().data.schedule.notify, 'always')
  })

  it('a notification that cannot be delivered leaves the failed job exactly as it was', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const mock = armNotify({ zfs: { stderr: 'dataset is busy', exitCode: 1 }, perlExit: 255 })
    const run = await server.inject({ method: 'POST', url: '/v1/schedules/nightly-media/run', headers: JSON_HEADERS, payload: '{}' })
    const done = await waitForJob(server, run.json().job.id)
    assert.equal(done.status, 'failed')
    assert.match(done.error?.message ?? '', /dataset is busy/)
    assert.equal(notifications(mock).length, 1)
  })
})
