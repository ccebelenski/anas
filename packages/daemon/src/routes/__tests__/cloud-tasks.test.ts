import type { CloudSyncTaskDetail, CloudSyncTaskView, Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'
import { RCLONE, rcloneBaseArgs } from '../../services/rclone-config.js'

/**
 * The cloud sync TASK routes (rclone.2). The store is the unit files in a temp
 * systemd dir; every systemd call is the mock's. What is proved here is the
 * doors: validation, the remote-must-exist refusal, the schedule check through
 * `systemd-analyze`, the 202 jobs, and the remotes DELETE 409 now that the real
 * task store answers it.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

/** A saved sftp remote exactly as ANAS would have written it. */
const GT_SECTION = '[gt]\ntype = sftp\nhost = 127.0.0.1\nuser = rclonegt\npass = obscured\n'

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string, attempts = 50): Promise<Job> {
  for (let i = 0; i < attempts; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

function taskBody(over: Record<string, unknown> = {}) {
  return {
    name: 'offsite',
    source: '/tank/pictures',
    remote: 'gt',
    path: 'pve1/pictures',
    schedule: 'Tue *-*-* 02:00:00',
    ...over,
  }
}

describe('cloud sync task routes (rclone.2)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  let systemdDir: string
  let configFile: string
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cloudtasks-'))
    systemdDir = await mkdtemp(join(dir, 'systemd-'))
    configFile = join(dir, 'rclone.conf')
    await writeFile(configFile, GT_SECTION, 'utf-8')
    setEnv('ANAS_RCLONE_CONFIG', configFile)
    setEnv('ANAS_SYSTEMD_DIR', systemdDir)
    server = createServer({ mock: true, logger: false })

    const mock = mockOf(server)
    mock.clearFixtures()
    const base = rcloneBaseArgs(configFile)
    // `config dump` reads the file ANAS holds, like the real binary.
    mock.addFixture({
      command: RCLONE,
      args: [...base, 'config', 'dump'],
      result: { stdout: JSON.stringify({ gt: { type: 'sftp', host: '127.0.0.1', user: 'rclonegt', pass: 'obscured' } }), stderr: '', exitCode: 0 },
    })
    mock.addFixture({ command: RCLONE, args: ['version'], result: { stdout: 'rclone v1.60.1\n', stderr: '', exitCode: 0 } })
    // systemd accepts the schedules these tests use, and every systemctl succeeds.
    mock.addFixture({ command: SYSTEMD_ANALYZE, result: { stdout: 'Normalized form: Tue *-*-* 02:00:00\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else
        process.env[k] = v
    }
  })

  async function createTask(over: Record<string, unknown> = {}): Promise<Job> {
    const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks', headers: JSON_HEADERS, payload: taskBody(over) })
    assert.equal(res.statusCode, 202, res.body)
    const { job } = res.json() as JobAccepted
    return waitForJob(server, job.id)
  }

  describe('POST /v1/cloud/tasks', () => {
    it('writes the unit pair and enables the timer', async () => {
      const job = await createTask()
      assert.equal(job.status, 'completed', JSON.stringify(job.error))

      const unit = await readFile(join(systemdDir, 'anas-cloud-offsite.service'), 'utf-8')
      assert.match(unit, /^# X-ANAS-Task=\{.*"remote":"gt".*\}$/m)
      assert.match(unit, /ExecStart=.*cloud-task\.js --name offsite/)
      const timer = await readFile(join(systemdDir, 'anas-cloud-offsite.timer'), 'utf-8')
      assert.match(timer, /^OnCalendar=Tue \*-\*-\* 02:00:00$/m)

      const argv = mockOf(server).calls.filter(c => c.command === SYSTEMCTL).map(c => c.args.join(' '))
      assert.ok(argv.includes('enable --now anas-cloud-offsite.timer'), argv.join(' | '))
    })

    it('400s on a remote the config file does not carry, naming it and the fix', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/tasks',
        headers: JSON_HEADERS,
        payload: taskBody({ remote: 'nosuch' }),
      })
      assert.equal(res.statusCode, 400)
      assert.match((res.json() as { error: { message: string } }).error.message, /remote 'nosuch' is not configured — add it under Remotes first/)
    })

    it('400s on a schedule systemd refuses, quoting systemd', async () => {
      mockOf(server).addFixture({
        command: SYSTEMD_ANALYZE,
        args: ['calendar', 'every other tuesday'],
        result: { stdout: '', stderr: 'Failed to parse calendar specification: Invalid argument', exitCode: 1 },
      })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/tasks',
        headers: JSON_HEADERS,
        payload: taskBody({ schedule: 'every other tuesday' }),
      })
      assert.equal(res.statusCode, 400)
      assert.match((res.json() as { error: { message: string } }).error.message, /Failed to parse calendar specification/)
    })

    it('a cadence GENERATES the schedule, and that is what systemd is asked about', async () => {
      const analyze: string[][] = []
      const mock = mockOf(server)
      const orig = mock.exec.bind(mock)
      mock.exec = async (command, args, o): Promise<ExecResult> => {
        if (command === SYSTEMD_ANALYZE)
          analyze.push(args)
        return orig(command, args, o)
      }
      const job = await createTask({ cadence: { kind: 'weekly', days: ['Thu', 'Tue'], time: '03:30' }, schedule: 'Mon *-*-* 09:00:00' })
      assert.equal(job.status, 'completed')
      assert.deepEqual(analyze.at(-1), ['calendar', 'Tue,Thu 03:30'])
      const timer = await readFile(join(systemdDir, 'anas-cloud-offsite.timer'), 'utf-8')
      assert.match(timer, /^OnCalendar=Tue,Thu 03:30$/m)
    })

    it('409s on a duplicate name', async () => {
      await createTask()
      const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks', headers: JSON_HEADERS, payload: taskBody() })
      assert.equal(res.statusCode, 409)
      assert.match((res.json() as { error: { message: string } }).error.message, /already exists/)
    })

    it('400s on a bad body: a relative source, a bogus bwlimit, an illegal name', async () => {
      for (const payload of [
        taskBody({ source: 'relative/path' }),
        taskBody({ bwlimit: 'fast' }),
        taskBody({ name: 'Not Valid' }),
        taskBody({ mode: 'two-way' }),
      ]) {
        const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks', headers: JSON_HEADERS, payload })
        assert.equal(res.statusCode, 400, JSON.stringify(payload))
      }
    })

    it('401s without identity', async () => {
      const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks', headers: { 'content-type': 'application/json' }, payload: taskBody() })
      assert.equal(res.statusCode, 401)
    })
  })

  describe('GET /v1/cloud/tasks', () => {
    it('is an empty grid with no units, and carries the derived status once there is one', async () => {
      const empty = await server.inject({ method: 'GET', url: '/v1/cloud/tasks', headers: IDENTITY })
      assert.equal(empty.statusCode, 200)
      assert.deepEqual((empty.json() as { data: CloudSyncTaskView[] }).data, [])

      await createTask()
      const res = await server.inject({ method: 'GET', url: '/v1/cloud/tasks', headers: IDENTITY })
      const rows = (res.json() as { data: CloudSyncTaskView[] }).data
      assert.equal(rows.length, 1)
      assert.equal(rows[0].name, 'offsite')
      assert.equal(rows[0].remote, 'gt')
      assert.equal(rows[0].mode, 'copy', 'copy is the default mode')
      assert.equal(rows[0].notify, 'always', 'backup parity')
      assert.ok('lastRunResult' in rows[0] && 'nextRunAt' in rows[0] && 'overdue' in rows[0])
    })
  })

  describe('GET /v1/cloud/tasks/:name', () => {
    it('404s for an unknown task and 400s for an illegal name', async () => {
      const missing = await server.inject({ method: 'GET', url: '/v1/cloud/tasks/nosuch', headers: IDENTITY })
      assert.equal(missing.statusCode, 404)
      const bad = await server.inject({ method: 'GET', url: '/v1/cloud/tasks/NOT%20VALID', headers: IDENTITY })
      assert.equal(bad.statusCode, 400)
    })

    it('returns the units as written plus the derived facts', async () => {
      await createTask()
      const res = await server.inject({ method: 'GET', url: '/v1/cloud/tasks/offsite', headers: IDENTITY })
      assert.equal(res.statusCode, 200)
      const detail = (res.json() as { data: CloudSyncTaskDetail }).data
      assert.equal(detail.task.name, 'offsite')
      assert.match(detail.unit, /X-ANAS-Task=/)
      assert.match(detail.timer, /OnCalendar=/)
      // The consistency derivation fails OPEN on a mock node with no findmnt —
      // absent or `live`, never a snapshot claim it cannot back up.
      assert.ok(detail.consistency === undefined || detail.consistency.consistency === 'live')
    })
  })

  describe('PUT /v1/cloud/tasks/:name', () => {
    it('rewrites the units', async () => {
      await createTask()
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/cloud/tasks/offsite',
        headers: JSON_HEADERS,
        payload: taskBody({ mode: 'sync', excludes: ['*.tmp'], enabled: false }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const unit = await readFile(join(systemdDir, 'anas-cloud-offsite.service'), 'utf-8')
      assert.match(unit, /"mode":"sync"/)
      assert.match(unit, /"excludes":\["\*\.tmp"\]/)
      const argv = mockOf(server).calls.filter(c => c.command === SYSTEMCTL).map(c => c.args.join(' '))
      assert.ok(argv.includes('disable --now anas-cloud-offsite.timer'))
    })

    it('404s for a task that does not exist, 400s on a name mismatch', async () => {
      const missing = await server.inject({ method: 'PUT', url: '/v1/cloud/tasks/nosuch', headers: JSON_HEADERS, payload: taskBody({ name: 'nosuch' }) })
      assert.equal(missing.statusCode, 404)

      await createTask()
      const mismatch = await server.inject({ method: 'PUT', url: '/v1/cloud/tasks/offsite', headers: JSON_HEADERS, payload: taskBody({ name: 'other' }) })
      assert.equal(mismatch.statusCode, 400)
      assert.match((mismatch.json() as { error: { message: string } }).error.message, /does not match URL/)
    })

    it('still refuses an unknown remote on an update', async () => {
      await createTask()
      const res = await server.inject({ method: 'PUT', url: '/v1/cloud/tasks/offsite', headers: JSON_HEADERS, payload: taskBody({ remote: 'nosuch' }) })
      assert.equal(res.statusCode, 400)
    })
  })

  describe('DELETE /v1/cloud/tasks/:name', () => {
    it('removes both units and touches nothing at the remote', async () => {
      await createTask()
      const res = await server.inject({ method: 'DELETE', url: '/v1/cloud/tasks/offsite', headers: IDENTITY })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')

      const grid = await server.inject({ method: 'GET', url: '/v1/cloud/tasks', headers: IDENTITY })
      assert.deepEqual((grid.json() as { data: CloudSyncTaskView[] }).data, [])
      // No rclone verb ran: deleting a schedule is not deleting data.
      assert.ok(!mockOf(server).calls.some(c => c.command === RCLONE && (c.args.includes('purge') || c.args.includes('delete'))))
    })

    it('404s for an unknown task', async () => {
      const res = await server.inject({ method: 'DELETE', url: '/v1/cloud/tasks/nosuch', headers: IDENTITY })
      assert.equal(res.statusCode, 404)
    })
  })

  describe('POST /v1/cloud/tasks/:name/run', () => {
    it('404s for an unknown task, 400s on a bad body', async () => {
      const missing = await server.inject({ method: 'POST', url: '/v1/cloud/tasks/nosuch/run', headers: JSON_HEADERS, payload: {} })
      assert.equal(missing.statusCode, 404)

      await createTask()
      const bad = await server.inject({ method: 'POST', url: '/v1/cloud/tasks/offsite/run', headers: JSON_HEADERS, payload: { direct: 'yes' } })
      assert.equal(bad.statusCode, 400)
    })

    it('a UI Run-Now (no direct) starts and supervises the task\'s own unit', async () => {
      await createTask()
      const mock = mockOf(server)
      // The supervised run as systemd reports it: idle, then a fresh invocation
      // that goes terminal with a success.
      mock.addFixture({
        command: SYSTEMCTL,
        args: ['show', 'anas-cloud-offsite.service', '-p', 'ActiveState,Result,ExecMainStatus,InvocationID'],
        results: [
          { stdout: 'ActiveState=inactive\nResult=success\nInvocationID=OLD\n', stderr: '', exitCode: 0 },
          { stdout: 'ActiveState=activating\nResult=success\nInvocationID=NEW\n', stderr: '', exitCode: 0 },
          { stdout: 'ActiveState=inactive\nResult=success\nExecMainStatus=0\nInvocationID=NEW\n', stderr: '', exitCode: 0 },
        ],
      })
      mock.addFixture({
        command: '/usr/bin/journalctl',
        result: {
          stdout: '2026-09-24T02:00:07+0000 pve1 anas-cloud-offsite[9]: '
            + '{"task":"offsite","result":{"status":"success","mode":"copy","bytes":4096,"transfers":1}}',
          stderr: '',
          exitCode: 0,
        },
      })

      const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks/offsite/run', headers: JSON_HEADERS, payload: {} })
      assert.equal(res.statusCode, 202)
      // Supervision polls systemd every 2s, so this takes a few seconds.
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id, 2000)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const argv = mock.calls.filter(c => c.command === SYSTEMCTL).map(c => c.args.join(' '))
      assert.ok(argv.includes('start --no-block anas-cloud-offsite.service'), argv.join(' | '))
      // rclone's counters travel back from the runner's journal result.
      assert.deepEqual(
        (job.result as { status: string, run?: { bytes?: number } }),
        { status: 'success', alreadyRunning: false, run: { status: 'success', mode: 'copy', bytes: 4096, transfers: 1 } } as never,
      )
    })

    it('a DIRECT run never re-enters systemctl — the recursion guard', async () => {
      await createTask({ source: '/nonexistent/source' })
      const before = mockOf(server).calls.filter(c => c.command === SYSTEMCTL).length
      const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks/offsite/run', headers: JSON_HEADERS, payload: { direct: true } })
      assert.equal(res.statusCode, 202)
      // The source does not exist, so the run FAILS at the guard — which is
      // exactly what proves the direct path ran the work rather than the unit.
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error?.message ?? '', /does not exist or is not a directory/)
      const after = mockOf(server).calls.filter(c => c.command === SYSTEMCTL && c.args[0] === 'start')
      assert.deepEqual(after, [], 'no systemctl start from the direct path')
      assert.ok(before >= 0)
    })
  })

  describe('the remotes DELETE refusal now reads the real task store', () => {
    it('409s naming every task that references the remote', async () => {
      await createTask({ name: 'zeta' })
      await createTask({ name: 'alpha' })
      const res = await server.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: IDENTITY })
      assert.equal(res.statusCode, 409)
      const message = (res.json() as { error: { message: string } }).error.message
      assert.match(message, /remote 'gt' is used by cloud sync task\(s\): alpha, zeta/)
      assert.match(message, /remove or retarget them first/)
      // The section is still in the file.
      assert.match(await readFile(configFile, 'utf-8'), /^\[gt\]$/m)
    })

    it('lets the delete through once no task names the remote', async () => {
      await createTask()
      const removeTask = await server.inject({ method: 'DELETE', url: '/v1/cloud/tasks/offsite', headers: IDENTITY })
      await waitForJob(server, (removeTask.json() as JobAccepted).job.id)

      const res = await server.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: IDENTITY })
      assert.equal(res.statusCode, 202, res.body)
      // Let the section removal finish before the fixture directory goes away.
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.ok(!(await readFile(configFile, 'utf-8')).includes('[gt]'))
    })
  })
})
