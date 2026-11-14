import type { Job, ReplicationTaskStatus } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'
import { buildSshArgv, resolvedRemoteFields } from '../../services/replication-transport.js'
import { parseServiceUnit } from '../../services/replication-units.js'
import { zfsTreeListArgs } from '../../services/zfs-snapshot.js'

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
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

  const RUN_ARGV = 'start --no-block anas-repl-nightly-media.service'

  it('cr.64b2-ii: run answers its job reference like the file\'s other 202s and the job fires the unit', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const mock = mockOf(server)
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/replication/tasks/nightly-media/run', headers: IDENTITY })
    assert.equal(res.statusCode, 202)
    // The SAME reply shape as create/update/delete: { job } with a pollable id.
    const { job } = res.json() as { job: { id: string } }
    assert.ok(job?.id, `202 body: ${res.body}`)
    const done = await waitForJob(server, job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.ok(mock.calls.some(c => c.command === SYSTEMCTL && c.args.join(' ') === RUN_ARGV))
  })

  it('cr.64b2-ii: the run job holds task:replication:<name> SHARED (queue state)', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const mock = mockOf(server)
    const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
    // Park the job mid-`systemctl start` with a live child, read the lock
    // table while it runs, then release it.
    mock.addFixture({ command: SYSTEMCTL, args: ['start', '--no-block', 'anas-repl-nightly-media.service'], live: { signalsToExit: Number.POSITIVE_INFINITY } })
    const res = await server.inject({ method: 'POST', url: '/v1/replication/tasks/nightly-media/run', headers: IDENTITY })
    assert.equal(res.statusCode, 202)
    const id = (res.json() as { job: { id: string } }).job.id
    for (let i = 0; i < 50 && queue.get(id)?.status !== 'running'; i++)
      await new Promise(r => setTimeout(r, 10))
    assert.equal(queue.get(id)?.status, 'running', 'the run job never started')
    // Queue state while the run job is in flight:
    //   heldLocks() → [{ key: 'task:replication:nightly-media', mode: 'shared', holders: ['<run job id>'] }]
    const held = queue.heldLocks().filter(h => h.key.startsWith('task:'))
    assert.deepEqual(held, [{ key: 'task:replication:nightly-media', mode: 'shared', holders: [id] }])
    // The live child spawns only after the job door's re-checks — release
    // only once it is actually running, or finishLive ends nothing.
    for (let i = 0; i < 50 && !mock.calls.some(c => c.args.join(' ') === RUN_ARGV); i++)
      await new Promise(r => setTimeout(r, 10))
    mock.finishLive()
    const done = await waitForJob(server, id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
  })

  it('cr.64b2-ii: a task deleted between the route and the job → the job refuses, systemctl start never ran', async () => {
    await waitForJob(server, (await create()).json().job.id)
    const mock = mockOf(server)
    const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
    // Paused-queue pattern (cr.33): the four slots are held, so the run job
    // sits QUEUED after its route gate passed; the unit files go behind it.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue.submit('test.hold', { user: 'root@pam', uid: 0 }, () => held)
    mock.calls.length = 0
    const res = await server.inject({ method: 'POST', url: '/v1/replication/tasks/nightly-media/run', headers: IDENTITY })
    assert.equal(res.statusCode, 202)
    const id = (res.json() as { job: { id: string } }).job.id
    assert.equal(queue.get(id)?.status, 'queued', 'the run waits behind the held slots')

    await rm(join(dir, 'anas-repl-nightly-media.service'), { force: true })
    await rm(join(dir, 'anas-repl-nightly-media.timer'), { force: true })
    release()
    const done = await waitForJob(server, id)
    assert.equal(done.status, 'failed', JSON.stringify(done))
    // The guard's gone-object answer (stable-id.ts): a task that existed at
    // the route and not at the job is an identity mismatch, refused with
    // "nothing was done" — the code every other gone-while-queued door gives.
    assert.equal(done.error?.code, 'IDENTITY_MISMATCH', JSON.stringify(done.error))
    assert.match(done.error?.message ?? '', /Replication task 'nightly-media' is not the one that was confirmed/)
    assert.match(done.error?.message ?? '', /unreadable now/)
    assert.match(done.error?.message ?? '', /nothing was done/)
    assert.ok(!mock.calls.some(c => c.command === SYSTEMCTL && c.args.join(' ') === RUN_ARGV), 'systemctl start never ran')
  })

  it('run a non-existent task → 404', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/replication/tasks/ghost/run', headers: IDENTITY })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })
})

// ============================================================================
//  Issue #46 — a task's target is validated WHERE THE TARGET LIVES
// ============================================================================
// The create/update guards were a stage-1 copy that asked THIS node's `zpool
// list` about every target, so a recurring task pointed at a peer or a
// registered remote was rejected with "Target pool 'x' does not exist" whenever
// that pool name did not also exist locally — while the one-shot replicate path
// (which learned about locations in stage 3) accepted the very same target. The
// two paths now share services/replication-target.ts.
describe('replication task routes — NON-LOCAL targets (issue #46)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  const saved: Record<string, string | undefined> = {}

  const REMOTE = { name: 'nas1', host: '10.0.0.9', port: 22, user: 'root' }
  // A target pool that exists ONLY on the far side — the whole point of the bug.
  const REMOTE_TASK = {
    name: 'offsite-media',
    source: { pool: 'testpool', dataset: 'media' },
    target: { pool: 'tank', dataset: 'media', location: { kind: 'remote', name: 'nas1' } },
    schedule: 'daily',
    snapshotFirst: true,
    enabled: true,
  }

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  /** Fixture an `ssh …` invocation against the registered nas1 remote. */
  function remoteSshFix(mock: MockExecutor, cmd: string[], stdout: string, exitCode = 0) {
    const resolved = resolvedRemoteFields(
      { registryFile: join(dir, 'remotes.json'), keyPath: join(dir, 'replication_key'), knownHostsFile: join(dir, 'known_hosts') },
      REMOTE.host,
      REMOTE.port,
      REMOTE.user,
    )
    const argv = buildSshArgv(resolved, cmd)
    mock.addFixture({ command: argv[0], args: argv.slice(1), result: { stdout, stderr: '', exitCode } })
  }

  /** Fixture an `ssh root@<peer> …` invocation. */
  function peerSshFix(mock: MockExecutor, host: string, cmd: string[], stdout: string, exitCode = 0) {
    const argv = buildSshArgv({ kind: 'peer', host }, cmd)
    mock.addFixture({ command: argv[0], args: argv.slice(1), result: { stdout, stderr: '', exitCode } })
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-repltasks-remote-'))
    setEnv('ANAS_SYSTEMD_DIR', dir)
    setEnv('ANAS_REMOTES_FILE', join(dir, 'remotes.json'))
    setEnv('ANAS_REPL_KEY', join(dir, 'replication_key'))
    setEnv('ANAS_REPL_KNOWN_HOSTS', join(dir, 'known_hosts'))
    setEnv('ANAS_PVE_MEMBERS', join(dir, 'members.json'))
    await writeFile(join(dir, 'remotes.json'), JSON.stringify({
      version: 1,
      updatedBy: 'node1',
      updatedAt: new Date().toISOString(),
      remotes: [REMOTE],
    }), 'utf-8')
    await writeFile(join(dir, 'members.json'), JSON.stringify({
      nodename: 'node1',
      nodelist: { node1: {}, node2: {} },
    }), 'utf-8')

    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    // LOCAL truth: testpool + backup. Note there is NO local pool called 'tank'.
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['testpool', 'backup']), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMD_ANALYZE, args: ['calendar', 'daily'], result: { stdout: 'Normalized form: *-*-* 00:00:00\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    // FAR-SIDE truth: the remote and the peer both have 'tank', not 'backup'.
    remoteSshFix(mock, ['zpool', 'list', '-H', '-o', 'name'], 'tank\nrpool\n')
    peerSshFix(mock, 'node2', ['zpool', 'list', '-H', '-o', 'name'], 'tank\nrpool\n')
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

  async function create(payload: unknown) {
    return server.inject({ method: 'POST', url: '/v1/replication/tasks', headers: JSON_HEADERS, payload: JSON.stringify(payload) })
  }

  it('POST a task to a REMOTE pool that exists only on the remote → 202 (checked over ssh, not locally)', async () => {
    const res = await create(REMOTE_TASK)
    assert.equal(res.statusCode, 202, JSON.stringify(res.json()))
    const done = await waitForJob(server, res.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.ok((await readdir(dir)).includes('anas-repl-offsite-media.service'))
    // The existence probe was the REMOTE's `zpool list`, over ssh.
    const mock = mockOf(server)
    assert.ok(mock.calls.some(c => c.command.endsWith('/ssh') && c.args.join(' ').includes('zpool list -H -o name')))
  })

  it('POST a task to a PEER pool that exists only on the peer → 202', async () => {
    const res = await create({ ...REMOTE_TASK, name: 'peer-media', target: { pool: 'tank', dataset: 'media', location: { kind: 'peer', name: 'node2' } } })
    assert.equal(res.statusCode, 202, JSON.stringify(res.json()))
    assert.equal((await waitForJob(server, res.json().job.id)).status, 'completed')
  })

  it('POST a task to a pool the REMOTE does not have → 400 naming the remote', async () => {
    const res = await create({ ...REMOTE_TASK, target: { pool: 'backup', dataset: 'media', location: { kind: 'remote', name: 'nas1' } } })
    assert.equal(res.statusCode, 400)
    // 'backup' exists LOCALLY — the old guard would have accepted it.
    assert.match(res.json().error.message, /Target pool 'backup' does not exist on remote 'nas1'/)
  })

  // repl.r2: the remote's ssh did not answer — the task is refused with the
  // remote's own line, never with a missing-pool sentence, and no unit is
  // written.
  it('repl.r2: an ssh that did not answer on the remote\'s pool listing refuses with its line; no unit is written', async () => {
    const mock = mockOf(server)
    const resolved = resolvedRemoteFields(
      { registryFile: join(dir, 'remotes.json'), keyPath: join(dir, 'replication_key'), knownHostsFile: join(dir, 'known_hosts') },
      REMOTE.host,
      REMOTE.port,
      REMOTE.user,
    )
    const argv = buildSshArgv(resolved, ['zpool', 'list', '-H', '-o', 'name'])
    const line = 'root@10.0.0.9: Permission denied (publickey,password).'
    mock.prependFixture({ command: argv[0], args: argv.slice(1), result: { stdout: '', stderr: `${line}\n`, exitCode: 255 } })
    const before = await readdir(dir)

    const res = await create(REMOTE_TASK)
    assert.equal(res.statusCode, 400, res.body)
    assert.equal(res.json().error.message, `Could not list the pools on remote 'nas1': ${line}`)
    assert.doesNotMatch(res.json().error.message, /does not exist/)
    assert.deepEqual(await readdir(dir), before, 'nothing was written')
    assert.equal(mock.pipelineCalls.length, 0)
  })

  it('POST a task to an unregistered remote → 400 (the location must resolve)', async () => {
    const res = await create({ ...REMOTE_TASK, target: { pool: 'tank', dataset: 'media', location: { kind: 'remote', name: 'ghost' } } })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /remote 'ghost' is not registered/)
  })

  it('POST a peer task whose target path equals the source is NOT "onto itself" — it is another machine', async () => {
    const res = await create({
      ...REMOTE_TASK,
      name: 'same-name',
      source: { pool: 'testpool', dataset: 'media' },
      target: { pool: 'testpool', dataset: 'media', location: { kind: 'peer', name: 'node2' } },
    })
    assert.equal(res.statusCode, 400)
    // testpool is not on the peer, so it fails on POOL EXISTENCE — not on the
    // local-only self-replication check.
    assert.match(res.json().error.message, /does not exist on peer 'node2'/)
  })

  it('PUT retargeting an existing task onto a remote pool → 202 (the edit guard is location-aware too)', async () => {
    const local = {
      name: 'nightly-media',
      source: { pool: 'testpool', dataset: 'media' },
      target: { pool: 'backup', dataset: 'media' },
      schedule: 'daily',
      snapshotFirst: true,
      enabled: true,
    }
    await waitForJob(server, (await create(local)).json().job.id)
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/replication/tasks/nightly-media?retarget=true',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ ...local, target: { pool: 'tank', dataset: 'media', location: { kind: 'remote', name: 'nas1' } } }),
    })
    assert.equal(res.statusCode, 202, JSON.stringify(res.json()))
    assert.equal((await waitForJob(server, res.json().job.id)).status, 'completed')
    const stored = parseServiceUnit(await readFile(join(dir, 'anas-repl-nightly-media.service'), 'utf-8'))
    assert.deepEqual(stored?.target, { pool: 'tank', dataset: 'media', location: { kind: 'remote', name: 'nas1' } })
  })
})

// ============================================================================
//  rrep.2 (#84, R10 + R5a–c at the task's door)
// ============================================================================
// A RECURSIVE task's create/update gates ask the tree's questions the run will
// ask on every fire — the dialog's fast feedback, never the gate itself. The
// listings are the captured `fixtures/zfs/replication-tree/` bytes; the POOL
// listing every gate-1 test needs is COMPOSED as the pool's own row plus the
// captured root listing (`<pool>\n` + `src-tree.txt`), because the capture of
// the root's listing is what `zfs list -r -- <root>` printed while the pool
// held nothing else — the same composition the run's tests use.
describe('replication task routes — RECURSIVE tasks (rrep.2, #84)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  const saved: Record<string, string | undefined> = {}
  const fixturesDir = join(import.meta.dirname, '../../fixtures/zfs/replication-tree')
  const SOURCE = 'rpool/rrsrc'

  /** R3's sentence as the shared schema states it. */
  const R3 = 'Recursive replication sends the snapshots a recursive snapshot schedule takes — turn off \'Take a fresh snapshot before each run\' and schedule the source recursively in the Snapshots menu'

  const RECURSIVE_TASK = {
    name: 'nightly-tree',
    source: { pool: 'rpool', dataset: 'rrsrc' },
    target: { pool: 'datapool', dataset: 'rrdst' },
    schedule: 'daily',
    snapshotFirst: false,
    enabled: true,
    recursive: true,
    exclude: ['rpool/rrsrc/skipme'],
  }

  function fixture(name: string): string {
    return readFileSync(join(fixturesDir, name), 'utf-8')
  }

  /** The pool's listing: its own row, then the captured root tree. */
  function poolListing(): string {
    return `rpool\n${fixture('src-tree.txt')}`
  }

  function ok(stdout: string) {
    return { stdout, stderr: '', exitCode: 0 }
  }

  function tree(mock: MockExecutor, dataset: string, result: { stdout: string, stderr: string, exitCode: number }) {
    mock.addFixture({ command: ZFS, args: zfsTreeListArgs(dataset), result })
  }

  /** The captured source tree, readable and starting with the source root. */
  function sourceTree(mock: MockExecutor, stdout: string = fixture('src-tree.txt')) {
    tree(mock, SOURCE, ok(stdout))
  }

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  /** A storage.cfg owning exactly one zfspool storage on `dataset`. */
  async function ownStorage(dataset: string): Promise<void> {
    const path = join(dir, 'storage.cfg')
    await writeFile(path, `zfspool: local-zfs\n\tpool ${dataset}\n\tcontent images,rootdir\n`, 'utf-8')
    setEnv('ANAS_STORAGE_CFG', path)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-repltasks-rec-'))
    setEnv('ANAS_SYSTEMD_DIR', dir)
    // A storage.cfg that does not exist: a non-PVE host, storage empty, nothing owned.
    setEnv('ANAS_STORAGE_CFG', join(dir, 'absent-storage.cfg'))
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: zpoolListJson(['rpool', 'datapool', 'testpool', 'backup']), stderr: '', exitCode: 0 } })
    // READABLE boot facts with no system pool: otherwise the unreadable-facts
    // fallback would treat a whole pool with a zfspool storage as PVE's, which
    // is a different fact than the per-dataset ownership these tests probe.
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: ok('') })
    mock.addFixture({ command: SYSTEMD_ANALYZE, args: ['calendar', 'daily'], result: { stdout: 'Normalized form: *-*-* 00:00:00\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMCTL, result: ok('') })
    mock.addFixture({ command: ZFS, result: ok('') })
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

  async function create(payload: unknown = RECURSIVE_TASK) {
    return server.inject({ method: 'POST', url: '/v1/replication/tasks', headers: JSON_HEADERS, payload: JSON.stringify(payload) })
  }

  async function put(name: string, payload: unknown, query = '') {
    return server.inject({ method: 'PUT', url: `/v1/replication/tasks/${name}${query}`, headers: JSON_HEADERS, payload: JSON.stringify(payload) })
  }

  async function storedTask(name = RECURSIVE_TASK.name) {
    return parseServiceUnit(await readFile(join(dir, `anas-repl-${name}.service`), 'utf-8'))
  }

  it('POST a recursive task with excludes → 202, the unit carries the flags, GET returns the fields', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    const res = await create()
    assert.equal(res.statusCode, 202, res.body)
    assert.equal((await waitForJob(server, res.json().job.id)).status, 'completed')

    const unit = await readFile(join(dir, 'anas-repl-nightly-tree.service'), 'utf-8')
    assert.match(unit, /--recursive --exclude rpool\/rrsrc\/skipme( |\n)/)
    assert.deepEqual(await storedTask(), { ...RECURSIVE_TASK, notify: 'on-failure' })

    const list = await server.inject({ method: 'GET', url: '/v1/replication/tasks', headers: IDENTITY })
    assert.equal(list.statusCode, 200)
    const { data } = list.json() as { data: ReplicationTaskStatus[] }
    assert.equal(data.length, 1)
    assert.equal(data[0].task.recursive, true)
    assert.deepEqual(data[0].task.exclude, ['rpool/rrsrc/skipme'])
  })

  it('POST recursive with snapshotFirst omitted → 400 with R3\'s sentence (the default is true)', async () => {
    const { snapshotFirst: _omitted, ...payload } = RECURSIVE_TASK
    const res = await create(payload)
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, `Invalid replication task: ${R3}`)
    assert.deepEqual(await readdir(dir), [], 'nothing was written')
  })

  // ---- the gates, one test each, in the order the route asks them ----------

  it('gate 1: a source dataset the pool does not list → "does not exist", decided from the POOL listing', async () => {
    const mock = mockOf(server)
    // `zfs list -r -- rpool/nosuch`: the captured missing-dataset answer (exit 1).
    tree(mock, 'rpool/nosuch', { stdout: '', stderr: fixture('tree-missing.stderr.txt'), exitCode: 1 })
    tree(mock, 'rpool', ok(poolListing()))
    const res = await create({ ...RECURSIVE_TASK, source: { pool: 'rpool', dataset: 'nosuch' }, exclude: [] })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, 'Source dataset \'rpool/nosuch\' does not exist')
  })

  it('gate 1: a read that did not answer → the unlisted sentence, never "does not exist"', async () => {
    const mock = mockOf(server)
    // Both the dataset's listing and the POOL's fail: the read is UNREADABLE.
    tree(mock, SOURCE, { stdout: '', stderr: 'cannot open \'rpool\': I/O error', exitCode: 1 })
    tree(mock, 'rpool', { stdout: '', stderr: 'cannot open \'rpool\': I/O error', exitCode: 1 })
    const res = await create()
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, 'Could not list descendants of \'rpool/rrsrc\' — refusing the recursive replication task')
  })

  it('gate 2: an exclude that is not in the source tree → 400, its own sentence', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    const res = await create({ ...RECURSIVE_TASK, exclude: ['rpool/rrsrc/skipme', 'rpool/rrsrc/ghost'] })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, 'Exclude \'rpool/rrsrc/ghost\' does not exist under \'rpool/rrsrc\'')
  })

  it('gate 3: a PVE-owned swept dataset → 409 PVE_MANAGED with the run\'s sentence', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    await ownStorage('rpool/rrsrc/enc')
    const res = await create()
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'PVE_MANAGED')
    assert.equal(res.json().error.message, 'Recursive replication of \'rpool/rrsrc\' would include rpool/rrsrc/enc — PVE storage \'local-zfs\' owns rpool/rrsrc/enc as a storage root — exclude it, or replicate a dataset below it')
  })

  it('gate 4 (R5b): a swept dataset whose target name is longer than ZFS allows → the planner\'s name sentence', async () => {
    const mock = mockOf(server)
    // COMPOSED, differs from the capture: it adds one child with a 250-character
    // name so the target name (datapool/rrdst + the suffix) exceeds 255. The
    // capture has no such dataset (a real tree rarely does); the rule must
    // still refuse it at the task's door exactly as at the run's.
    const longName = `rpool/rrsrc/${'x'.repeat(250)}`
    sourceTree(mock, `${fixture('src-tree.txt')}${longName}\n`)
    const res = await create()
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, `'${longName}' cannot be replicated: its target name 'datapool/rrdst/${'x'.repeat(250)}' is longer than ZFS allows (255) or contains characters ANAS does not pass to a remote command`)
  })

  it('gate 4 (R5c): a local target inside the source tree → the planner\'s placement sentence', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    const res = await create({ ...RECURSIVE_TASK, target: { pool: 'rpool', dataset: 'rrsrc/copy' } })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, 'The target \'rpool/rrsrc/copy\' is inside the source tree \'rpool/rrsrc\' — a recursive replication would copy its own replica; choose a target outside it, or exclude the dataset that contains it')
  })

  it('gate 5 (R5b local half): a swept dataset\'s TARGET name PVE owns → the target guard\'s own sentence', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    await ownStorage('datapool/rrdst/enc')
    const res = await create()
    assert.equal(res.statusCode, 400, res.body)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /^Replication target 'datapool\/rrdst\/enc' is PVE-owned — PVE storage 'local-zfs' owns datapool\/rrdst\/enc as a storage root$/)
  })

  // rrep.2 fold P2: gate 5 guards every swept dataset's target name, but the
  // target POOL's existence is asked once for the pass — three `zpool list`
  // reads in all (the source pool, the root guard, gate 5's one), not one
  // per swept dataset (it was 8 for this six-child tree).
  it('fold P2: a recursive create reads `zpool list` once for gate 5, not once per swept dataset', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    const res = await create()
    assert.equal(res.statusCode, 202, res.body)
    await waitForJob(server, res.json().job.id)
    assert.equal(mock.calls.filter(c => c.command === ZPOOL && c.args[0] === 'list').length, 3)
  })

  // rrep.2 fold D2: an EMPTY target dataset is the schema's "default", the
  // same instruction as absent — the run replicates to `datapool/rrsrc` (the
  // runner drops ''), so the task door judges THAT tree, never `datapool/`.
  it('fold D2: a create with target dataset \'\' is judged against <pool>/<source rel>', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    const plain = await create({ ...RECURSIVE_TASK, target: { pool: 'datapool', dataset: '' } })
    assert.equal(plain.statusCode, 202, plain.body)
    assert.equal((await waitForJob(server, plain.json().job.id)).status, 'completed')

    // The per-dataset guard names the resolved child target, proving the root.
    await ownStorage('datapool/rrsrc/enc')
    const owned = await create({ ...RECURSIVE_TASK, name: 'tree-two', target: { pool: 'datapool', dataset: '' } })
    assert.equal(owned.statusCode, 400, owned.body)
    assert.equal(owned.json().error.message, 'Replication target \'datapool/rrsrc/enc\' is PVE-owned — PVE storage \'local-zfs\' owns datapool/rrsrc/enc as a storage root')
  })

  // Review of the rrep.2 fold: the door excused a LOCAL target inside the
  // source tree on the strength of a stored exclude that no longer existed,
  // and saved a task every run then refused. RULE: only a live exclude
  // excuses the placement, at the door as at the run.
  it('a stored exclude that is gone does not excuse a local target inside the source tree', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    await waitForJob(server, (await create()).json().job.id)
    // skipme is destroyed on the source: the listing no longer carries it.
    // (prepended: the mock answers with the first fixture that matches)
    mock.prependFixture({ command: ZFS, args: zfsTreeListArgs(SOURCE), result: ok(fixture('src-tree.txt').split('\n').filter(l => l !== 'rpool/rrsrc/skipme').join('\n')) })
    const moved = { ...RECURSIVE_TASK, target: { pool: 'rpool', dataset: 'rrsrc/skipme/copy' } }
    delete (moved as Record<string, unknown>).exclude
    const res = await put('nightly-tree', moved, '?retarget=true')
    assert.equal(res.statusCode, 400, res.body)
    assert.match(res.json().error.message, /The target 'rpool\/rrsrc\/skipme\/copy' is inside the source tree 'rpool\/rrsrc'/)
  })

  // ---- the PUT contract (R10) ---------------------------------------------

  it('PUT omitting recursive AND exclude keeps both stored values', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    await waitForJob(server, (await create()).json().job.id)

    // A body that names neither key: the 0.4.2-client shape. snapshotFirst is
    // sent false because the client knows the task it loaded.
    const { recursive: _r, exclude: _e, ...body } = RECURSIVE_TASK
    const res = await put('nightly-tree', { ...body, enabled: false })
    assert.equal(res.statusCode, 202, res.body)
    await waitForJob(server, res.json().job.id)
    const stored = await storedTask()
    assert.equal(stored?.recursive, true)
    assert.deepEqual(stored?.exclude, ['rpool/rrsrc/skipme'])
    assert.equal(stored?.enabled, false)
  })

  it('PUT exclude: [] clears the stored list (a present value stands)', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    await waitForJob(server, (await create()).json().job.id)
    const res = await put('nightly-tree', { ...RECURSIVE_TASK, exclude: [] })
    assert.equal(res.statusCode, 202, res.body)
    await waitForJob(server, res.json().job.id)
    assert.deepEqual((await storedTask())?.exclude, [])
  })

  it('PUT toggling recursive without ?retarget=true is refused with the existing sentence; with it, it succeeds', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    const plain = {
      name: 'tree-toggle',
      source: { pool: 'rpool', dataset: 'rrsrc' },
      target: { pool: 'datapool', dataset: 'rrdst' },
      schedule: 'daily',
      snapshotFirst: true,
      enabled: true,
    }
    await waitForJob(server, (await create(plain)).json().job.id)

    const recursiveBody = { ...plain, snapshotFirst: false, recursive: true, exclude: [] }
    const refused = await put('tree-toggle', recursiveBody)
    assert.equal(refused.statusCode, 400)
    assert.match(refused.json().error.message, /This edit would move replication task 'tree-toggle' \(recursive off → on\)/)
    assert.match(refused.json().error.message, /resend with \?retarget=true/)
    assert.equal((await storedTask('tree-toggle'))?.recursive, undefined)

    const moved = await put('tree-toggle', recursiveBody, '?retarget=true')
    assert.equal(moved.statusCode, 202, moved.body)
    await waitForJob(server, moved.json().job.id)
    assert.equal((await storedTask('tree-toggle'))?.recursive, true)
  })

  it('fold D1: PUT sending exclude WITHOUT recursive keeps the stored recursion and applies the list (R10)', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    await waitForJob(server, (await create()).json().job.id)
    // The body names `exclude` and omits `recursive`: the omitted key keeps the
    // stored `true`, so "exclude requires recursive" must not refuse it.
    const { recursive: _r, ...body } = RECURSIVE_TASK
    const res = await put('nightly-tree', { ...body, exclude: ['rpool/rrsrc/vol'] })
    assert.equal(res.statusCode, 202, res.body)
    await waitForJob(server, res.json().job.id)
    const stored = await storedTask()
    assert.equal(stored?.recursive, true)
    assert.deepEqual(stored?.exclude, ['rpool/rrsrc/vol'])
  })

  it('PUT changing only exclude needs no retarget', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    await waitForJob(server, (await create()).json().job.id)
    const res = await put('nightly-tree', { ...RECURSIVE_TASK, exclude: ['rpool/rrsrc/vol'] })
    assert.equal(res.statusCode, 202, res.body)
    await waitForJob(server, res.json().job.id)
    assert.deepEqual((await storedTask())?.exclude, ['rpool/rrsrc/vol'])
  })

  it('PUT: a STORED exclude that no longer exists is kept without refusal; a NEW nonexistent one is refused', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    await waitForJob(server, (await create()).json().job.id)

    // The child is destroyed after the task was saved: prepend the changed
    // listing (the mock takes the latest exact-args fixture first).
    const withoutSkipme = fixture('src-tree.txt').split('\n').filter(line => line !== 'rpool/rrsrc/skipme').join('\n')
    mock.prependFixture({ command: ZFS, args: zfsTreeListArgs(SOURCE), result: ok(withoutSkipme) })

    const { recursive: _r, exclude: _e, ...body } = RECURSIVE_TASK
    const kept = await put('nightly-tree', { ...body, enabled: false })
    assert.equal(kept.statusCode, 202, kept.body)
    await waitForJob(server, kept.json().job.id)
    assert.deepEqual((await storedTask())?.exclude, ['rpool/rrsrc/skipme'])

    const refused = await put('nightly-tree', { ...RECURSIVE_TASK, exclude: ['rpool/rrsrc/skipme', 'rpool/rrsrc/ghost'] })
    assert.equal(refused.statusCode, 400)
    assert.equal(refused.json().error.message, 'Exclude \'rpool/rrsrc/ghost\' does not exist under \'rpool/rrsrc\'')
  })

  it('PUT version skew (R12): an old client\'s snapshotFirst:true against a stored recursive task answers R3, never a silent flip', async () => {
    const mock = mockOf(server)
    sourceTree(mock)
    await waitForJob(server, (await create()).json().job.id)

    // The client knows nothing of `recursive`: it rebuilds the body without the
    // key and sends the dialog's default snapshot-first.
    const { recursive: _r, exclude: _e, ...body } = RECURSIVE_TASK
    const res = await put('nightly-tree', { ...body, snapshotFirst: true })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, `Invalid replication task: ${R3}`)
    // Nothing was rewritten, and neither field was flipped behind the client.
    const stored = await storedTask()
    assert.equal(stored?.recursive, true)
    assert.equal(stored?.snapshotFirst, false)
  })

  it('R0: a NON-recursive create and PUT issue exactly the commands they issued before the fields existed, IN ORDER', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: SYSTEMD_ANALYZE, args: ['calendar', 'weekly'], result: ok('Normalized form: Mon *-*-* 00:00:00\n') })
    const plain = { name: 'nightly-media', source: { pool: 'testpool', dataset: 'media' }, target: { pool: 'backup', dataset: 'media' }, schedule: 'daily', snapshotFirst: true, enabled: true }
    const res = await create(plain)
    assert.equal(res.statusCode, 202, res.body)
    await waitForJob(server, res.json().job.id)
    const createCalls = mock.calls.map(c => `${c.command} ${c.args.join(' ')}`)

    const before = mock.calls.length
    const edit = await put('nightly-media', { ...plain, schedule: 'weekly' })
    assert.equal(edit.statusCode, 202, edit.body)
    await waitForJob(server, edit.json().job.id)
    const putCalls = mock.calls.slice(before).map(c => `${c.command} ${c.args.join(' ')}`)

    // RECORDED from `main`'s routes/replication-tasks.ts (before rrep.2),
    // running this exact scenario through createServer with these fixtures
    // (fold N4). Compared IN ORDER: the mock records each call when it is
    // issued, and the order was the same on every one of 40 recorded runs —
    // a sorted compare would hide a reordering. No recursive gate ran.
    const footprintAndWrite = [
      '/usr/sbin/zpool list -j',
      '/usr/sbin/zpool list -j',
      '/usr/sbin/zfs list -H -o name,mountpoint',
      '/usr/bin/findmnt --json',
      '/usr/sbin/zpool get -H -o name,value bootfs',
      '/usr/bin/findmnt -n -o SOURCE,FSTYPE /',
      '/usr/bin/findmnt --json',
      '/usr/bin/systemctl daemon-reload',
      '/usr/bin/systemctl enable --now anas-repl-nightly-media.timer',
    ]
    // repl.drift ruling 3: the node's FIRST task also installs the node-wide
    // daily target check (`anas-replcheck.*`); the PUT finds it in place.
    assert.deepEqual(createCalls, ['/usr/bin/systemd-analyze calendar daily', ...footprintAndWrite, '/usr/bin/systemctl daemon-reload', '/usr/bin/systemctl enable --now anas-replcheck.timer'])
    assert.deepEqual(putCalls, ['/usr/bin/systemd-analyze calendar weekly', ...footprintAndWrite])
  })
})
