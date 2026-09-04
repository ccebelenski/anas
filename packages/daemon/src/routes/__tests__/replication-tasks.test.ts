import type { Job, ReplicationTaskStatus } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'
import { buildSshArgv, resolvedRemoteFields } from '../../services/replication-transport.js'
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
