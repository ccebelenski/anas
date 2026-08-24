import type { Job, ReplicationTaskStatus } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'
import { parseServiceUnit } from '../../services/replication-units.js'

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'

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

const TASK = {
  name: 'nightly-media',
  source: { pool: 'testpool', dataset: 'media' },
  target: { pool: 'backup', dataset: 'media' },
  schedule: 'daily',
  snapshotFirst: true,
  enabled: true,
}

describe('replication task routes (Epic 5.5.3)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-repltasks-'))
    prevEnv = process.env.ANAS_SYSTEMD_DIR
    process.env.ANAS_SYSTEMD_DIR = dir
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'backup']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMD_ANALYZE, args: ['calendar', 'daily'], result: { stdout: 'Normalized form: *-*-* 00:00:00\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMD_ANALYZE, args: ['calendar', 'notacal'], result: { stdout: '', stderr: 'Failed to parse calendar specification: Invalid argument', exitCode: 1 } })
    // systemctl (daemon-reload / enable / disable / start / show) + zfs snapshot
    // lists: command-only success (status derivation reads empty → nulls).
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    if (prevEnv === undefined)
      delete process.env.ANAS_SYSTEMD_DIR
    else
      process.env.ANAS_SYSTEMD_DIR = prevEnv
  })

  async function create(payload: unknown = TASK) {
    return server.inject({ method: 'POST', url: '/v1/replication/tasks', headers: JSON_HEADERS, payload: JSON.stringify(payload) })
  }

  it('POST creates a task → 202, writes the unit files', async () => {
    const res = await create()
    assert.equal(res.statusCode, 202)
    const { job } = res.json() as { job: { id: string } }
    const done = await waitForJob(server, job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))

    const files = await readdir(dir)
    assert.ok(files.includes('anas-repl-nightly-media.service'))
    assert.ok(files.includes('anas-repl-nightly-media.timer'))
    const parsed = parseServiceUnit(await readFile(join(dir, 'anas-repl-nightly-media.service'), 'utf-8'))
    // A body that omits `notify` (9.4) is STORED with the schema's default, so
    // the unit always spells the mode out rather than leaving it implicit.
    assert.deepEqual(parsed, { ...TASK, notify: 'on-failure' })
  })

  it('9.4: the notify mode round-trips through the unit store — an edit sticks', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const put = await server.inject({
      method: 'PUT',
      url: '/v1/replication/tasks/nightly-media',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...TASK, notify: 'always' }),
    })
    await waitForJob(server, put.json().job.id)
    const stored = parseServiceUnit(await readFile(join(dir, 'anas-repl-nightly-media.service'), 'utf-8'))
    assert.equal(stored?.notify, 'always')
    // The runner has to CARRY it to the endpoint that actually notifies.
    assert.match(await readFile(join(dir, 'anas-repl-nightly-media.service'), 'utf-8'), /--notify always/)
  })

  it('POST a duplicate name → 409', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await create()
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /already exists/)
  })

  it('POST with an invalid schedule → 400 carrying systemd stderr', async () => {
    const res = await create({ ...TASK, schedule: 'notacal' })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /Failed to parse calendar/)
  })

  // Strict-on-WRITE: the lenient read path never loosens create. A dataset that
  // fails the narrowed ReplicationDataset regex is still rejected at the boundary.
  it('POST with a dataset that fails the narrowed regex → 400 (create stays strict)', async () => {
    const res = await create({ ...TASK, source: { pool: 'testpool', dataset: 'media/movies/' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /Invalid replication task/)
  })

  it('POST replicating a dataset onto itself → 400', async () => {
    const res = await create({ ...TASK, target: { pool: 'testpool', dataset: 'media' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /onto itself/)
  })

  it('POST to a non-existent target pool → 400', async () => {
    const res = await create({ ...TASK, target: { pool: 'nopool', dataset: 'media' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /does not exist/)
  })

  // The SOURCE was never validated (#39): a task could be stored reading from a
  // pool that does not exist and only fail at 03:00, in a timer run nobody watches.
  it('POST from a non-existent SOURCE pool → 400, naming the source', async () => {
    const res = await create({ ...TASK, source: { pool: 'nopool', dataset: 'media' } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /Source pool 'nopool' does not exist/)
  })

  it('PUT onto a non-existent SOURCE pool → 400 (the guard holds on edit too)', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/replication/tasks/nightly-media?retarget=true',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...TASK, source: { pool: 'nopool', dataset: 'media' } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /Source pool 'nopool' does not exist/)
  })

  // ==========================================================================
  //  Retarget guard (#39) — an edit may not MOVE a task without saying so
  // ==========================================================================
  // A dialog that silently substitutes a pool it could not find in a
  // freshly-loaded inventory would rewrite the destination with nobody deciding
  // to. The daemon compares against the STORED unit, so the guard holds however
  // the request was built; `?retarget=true` is the client declaring intent.

  /** The task as the unit store holds it right now. */
  async function stored() {
    return parseServiceUnit(await readFile(join(dir, 'anas-repl-nightly-media.service'), 'utf-8'))
  }

  it('PUT that moves the TARGET without ?retarget=true → 400, unit untouched', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/replication/tasks/nightly-media',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...TASK, target: { pool: 'testpool', dataset: 'elsewhere' } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /would move replication task 'nightly-media'/)
    assert.match(res.json().error.message, /target local:backup\/media → local:testpool\/elsewhere/)
    assert.match(res.json().error.message, /\?retarget=true/)
    // Nothing was written: the stored task still points where it did.
    assert.deepEqual((await stored())?.target, { pool: 'backup', dataset: 'media' })
  })

  it('PUT that moves the SOURCE without ?retarget=true → 400, unit untouched', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/replication/tasks/nightly-media',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...TASK, source: { pool: 'testpool', dataset: 'other' } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /source testpool\/media → testpool\/other/)
    assert.deepEqual((await stored())?.source, { pool: 'testpool', dataset: 'media' })
  })

  it('PUT that adds a REMOTE location without ?retarget=true → 400 (location is part of the target)', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/replication/tasks/nightly-media',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...TASK, target: { ...TASK.target, location: { kind: 'remote', name: 'nas1' } } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /target local:backup\/media → remote:nas1:backup\/media/)
    assert.equal((await stored())?.target.location, undefined)
  })

  it('PUT with ?retarget=true performs the move — a deliberate retarget still works', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/replication/tasks/nightly-media?retarget=true',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...TASK, target: { pool: 'testpool', dataset: 'elsewhere' } }),
    })
    assert.equal(res.statusCode, 202)
    await waitForJob(server, res.json().job.id)
    assert.deepEqual((await stored())?.target, { pool: 'testpool', dataset: 'elsewhere' })
  })

  it('an edit that changes only policy needs no flag — and an absent target dataset is not a move', async () => {
    await waitForJob(server, (await create()).json().job.id)
    // Same endpoints, different schedule + notify: routine, unflagged, allowed.
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/replication/tasks/nightly-media',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...TASK, schedule: 'daily', notify: 'always', enabled: false }),
    })
    assert.equal(res.statusCode, 202)
    await waitForJob(server, res.json().job.id)
    assert.equal((await stored())?.notify, 'always')

    // An OMITTED target dataset means "the source's own relative path" — for
    // this task, exactly the 'media' it already stores. Same destination, so no
    // flag is demanded: the guard tests where the data goes, not JSON shape.
    const same = await server.inject({
      method: 'PUT',
      url: '/v1/replication/tasks/nightly-media',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...TASK, target: { pool: 'backup' } }),
    })
    assert.equal(same.statusCode, 202)
    await waitForJob(server, same.json().job.id)
  })

  it('POST without identity → 401', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/replication/tasks', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(TASK) })
    assert.equal(res.statusCode, 401)
  })

  it('GET lists derived statuses for the stored tasks', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await server.inject({ method: 'GET', url: '/v1/replication/tasks', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: ReplicationTaskStatus[] }
    assert.equal(data.length, 1)
    assert.equal(data[0].task.name, 'nightly-media')
    // ZFS + systemd mocked empty → fail-open nulls / 'unknown'.
    assert.equal(data[0].lastReplicatedSnapshot, null)
    assert.equal(data[0].lastRunResult, 'unknown')
  })

  it('PUT rewrites a task and toggles enabled → disable --now', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const mock = mockOf(server)
    mock.calls.length = 0
    const res = await server.inject({ method: 'PUT', url: '/v1/replication/tasks/nightly-media', headers: JSON_HEADERS, payload: JSON.stringify({ ...TASK, enabled: false }) })
    assert.equal(res.statusCode, 202)
    await waitForJob(server, res.json().job.id)
    const parsed = parseServiceUnit(await readFile(join(dir, 'anas-repl-nightly-media.service'), 'utf-8'))
    assert.equal(parsed?.enabled, false)
    assert.ok(mock.calls.some(c => c.command === SYSTEMCTL && c.args.join(' ') === 'disable --now anas-repl-nightly-media.timer'))
  })

  it('PUT with a name mismatch → 400', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await server.inject({ method: 'PUT', url: '/v1/replication/tasks/nightly-media', headers: JSON_HEADERS, payload: JSON.stringify({ ...TASK, name: 'other' }) })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /does not match URL/)
  })

  it('PUT a non-existent task → 404', async () => {
    const res = await server.inject({ method: 'PUT', url: '/v1/replication/tasks/ghost', headers: JSON_HEADERS, payload: JSON.stringify({ ...TASK, name: 'ghost' }) })
    assert.equal(res.statusCode, 404)
  })

  it('DELETE removes the unit files → 202', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const res = await server.inject({ method: 'DELETE', url: '/v1/replication/tasks/nightly-media', headers: IDENTITY })
    assert.equal(res.statusCode, 202)
    await waitForJob(server, res.json().job.id)
    assert.deepEqual(await readdir(dir), [])
  })

  it('DELETE a non-existent task → 404', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/v1/replication/tasks/ghost', headers: IDENTITY })
    assert.equal(res.statusCode, 404)
  })

  it('run fires the real unit and returns { started: true }', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const mock = mockOf(server)
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/replication/tasks/nightly-media/run', headers: IDENTITY })
    assert.equal(res.statusCode, 202)
    assert.deepEqual(res.json(), { started: true })
    // Give the quick job a tick to fire systemctl start.
    await new Promise(r => setTimeout(r, 20))
    assert.ok(mock.calls.some(c => c.command === SYSTEMCTL && c.args.join(' ') === 'start --no-block anas-repl-nightly-media.service'))
  })

  it('run a non-existent task → 404', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/replication/tasks/ghost/run', headers: IDENTITY })
    assert.equal(res.statusCode, 404)
  })
})
