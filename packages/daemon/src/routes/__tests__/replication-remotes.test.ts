import type { Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { RemotesPaths } from '../../services/replication-remotes.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'
import { fingerprintFromBlob } from '../../services/replication-remotes.js'
import { buildSshArgv, resolvedRemoteFields } from '../../services/replication-transport.js'
import { renderServiceUnit } from '../../services/replication-units.js'

const SSH_KEYSCAN = '/usr/bin/ssh-keyscan'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

const ED_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExamp1'

const REMOTE = { name: 'nas1', host: '10.0.0.9', port: 22, user: 'root' }

const MEMBERS = JSON.stringify({
  nodename: 'node1',
  nodelist: { node1: {}, node2: {}, node3: {} },
})

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

describe('replication remotes routes (Epic 5.5.2)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  let paths: RemotesPaths
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-remoteroutes-'))
    paths = {
      registryFile: join(dir, 'remotes.json'),
      keyPath: join(dir, 'replication_key'),
      knownHostsFile: join(dir, 'known_hosts'),
    }
    setEnv('ANAS_REMOTES_FILE', paths.registryFile)
    setEnv('ANAS_REPL_KEY', paths.keyPath)
    setEnv('ANAS_REPL_KNOWN_HOSTS', paths.knownHostsFile)
    setEnv('ANAS_PVE_MEMBERS', join(dir, 'members.json'))
    setEnv('ANAS_SYSTEMD_DIR', dir)
    setEnv('ANAS_NODENAME', 'node1')
    await writeFile(join(dir, 'members.json'), MEMBERS, 'utf-8')
    // Seed the public key so GET returns it without a real ssh-keygen.
    await writeFile(`${paths.keyPath}.pub`, 'ssh-ed25519 AAAAPUB anas-replication\n', 'utf-8')

    server = createServer({ mock: true, logger: false })
    mockOf(server).clearFixtures()
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

  async function createRemote(expectedVersion = 0, remote = REMOTE) {
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes', headers: JSON_HEADERS, payload: JSON.stringify({ remote, expectedVersion }) })
    if (res.statusCode === 202)
      await waitForJob(server, res.json().job.id)
    return res
  }

  // --- GET -------------------------------------------------------------------
  it('GET returns version 0, empty remotes, and the public key', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/replication/remotes', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    const { data } = res.json()
    assert.equal(data.version, 0)
    assert.deepEqual(data.remotes, [])
    assert.equal(data.publicKey, 'ssh-ed25519 AAAAPUB anas-replication')
  })

  // --- POST create + CAS -----------------------------------------------------
  it('POST registers a remote (202 job); GET then shows it at version 1', async () => {
    const res = await createRemote(0)
    assert.equal(res.statusCode, 202)
    const { data } = (await server.inject({ method: 'GET', url: '/v1/replication/remotes', headers: IDENTITY })).json()
    assert.equal(data.version, 1)
    assert.deepEqual(data.remotes, [REMOTE])
  })

  it('POST with a stale expectedVersion → 409 CONFLICT, no confirm-code header', async () => {
    await createRemote(0) // → version 1
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes', headers: JSON_HEADERS, payload: JSON.stringify({ remote: { ...REMOTE, name: 'nas2' }, expectedVersion: 0 }) })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /reload and retry/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  it('POST a duplicate name → 409 already exists', async () => {
    await createRemote(0)
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes', headers: JSON_HEADERS, payload: JSON.stringify({ remote: REMOTE, expectedVersion: 1 }) })
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /already exists/)
  })

  it('POST without identity → 401', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ remote: REMOTE, expectedVersion: 0 }) })
    assert.equal(res.statusCode, 401)
  })

  // --- PUT upsert ------------------------------------------------------------
  it('PUT upserts an existing remote (CAS) and rejects a body/URL name mismatch', async () => {
    await createRemote(0) // version 1
    const ok = await server.inject({ method: 'PUT', url: '/v1/replication/remotes/nas1', headers: JSON_HEADERS, payload: JSON.stringify({ remote: { ...REMOTE, host: '10.9.9.9' }, expectedVersion: 1 }) })
    assert.equal(ok.statusCode, 202)
    await waitForJob(server, ok.json().job.id)
    const { data } = (await server.inject({ method: 'GET', url: '/v1/replication/remotes', headers: IDENTITY })).json()
    assert.equal(data.remotes[0].host, '10.9.9.9')

    const mismatch = await server.inject({ method: 'PUT', url: '/v1/replication/remotes/nas1', headers: JSON_HEADERS, payload: JSON.stringify({ remote: { ...REMOTE, name: 'other' }, expectedVersion: 2 }) })
    assert.equal(mismatch.statusCode, 400)
    assert.match(mismatch.json().error.message, /does not match URL/)
  })

  // --- DELETE ----------------------------------------------------------------
  it('DELETE removes a remote with ?expectedVersion; stale version → 409', async () => {
    await createRemote(0) // version 1
    const stale = await server.inject({ method: 'DELETE', url: '/v1/replication/remotes/nas1?expectedVersion=0', headers: IDENTITY })
    assert.equal(stale.statusCode, 409)

    const ok = await server.inject({ method: 'DELETE', url: '/v1/replication/remotes/nas1?expectedVersion=1', headers: IDENTITY })
    assert.equal(ok.statusCode, 202)
    await waitForJob(server, ok.json().job.id)
    const { data } = (await server.inject({ method: 'GET', url: '/v1/replication/remotes', headers: IDENTITY })).json()
    assert.deepEqual(data.remotes, [])
  })

  it('DELETE refuses (400) while a replication TASK still references the remote', async () => {
    await createRemote(0) // version 1
    // Drop a task unit that targets this remote into the (temp) systemd dir.
    const task = {
      name: 'to-nas1',
      source: { pool: 'testpool', dataset: 'media' },
      target: { pool: 'backup', dataset: 'media', location: { kind: 'remote', name: 'nas1' } },
      schedule: 'daily',
      snapshotFirst: true,
      enabled: true,
    }
    await writeFile(join(dir, 'anas-repl-to-nas1.service'), renderServiceUnit(task as never), 'utf-8')

    const res = await server.inject({ method: 'DELETE', url: '/v1/replication/remotes/nas1?expectedVersion=1', headers: IDENTITY })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /still used by replication task\(s\): to-nas1/)
  })

  it('DELETE without ?expectedVersion → 400', async () => {
    await createRemote(0)
    const res = await server.inject({ method: 'DELETE', url: '/v1/replication/remotes/nas1', headers: IDENTITY })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /expectedVersion/)
  })

  // --- test-connection staging ----------------------------------------------
  function sshFix(mock: MockExecutor, cmd: string[], result: { stdout: string, stderr: string, exitCode: number }, host = REMOTE.host, port = REMOTE.port, user = REMOTE.user) {
    const resolved = resolvedRemoteFields(paths, host, port, user)
    const argv = buildSshArgv(resolved, cmd)
    mock.addFixture({ command: argv[0], args: argv.slice(1), result })
  }

  it('test (pre-registration): unknown host key → hostkey-unknown + fingerprint', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: SSH_KEYSCAN, args: ['-p', '22', REMOTE.host], result: { stdout: `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, stderr: '', exitCode: 0 } })
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes/test', headers: JSON_HEADERS, payload: JSON.stringify({ host: REMOTE.host }) })
    assert.equal(res.statusCode, 200)
    const { data } = res.json()
    assert.equal(data.stage, 'hostkey-unknown')
    assert.equal(data.fingerprint, fingerprintFromBlob(ED_BLOB))
  })

  it('test with ?pin=true pins the host key, then advances to ok + zfsVersion', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: SSH_KEYSCAN, args: ['-p', '22', REMOTE.host], result: { stdout: `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, stderr: '', exitCode: 0 } })
    sshFix(mock, ['true'], { stdout: '', stderr: '', exitCode: 0 })
    sshFix(mock, ['zfs', '--version'], { stdout: 'zfs-2.2.3\nzfs-kmod-2.2.3\n', stderr: '', exitCode: 0 })
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes/test?pin=true', headers: JSON_HEADERS, payload: JSON.stringify({ host: REMOTE.host }) })
    assert.equal(res.statusCode, 200)
    const { data } = res.json()
    assert.equal(data.stage, 'ok')
    assert.equal(data.zfsVersion, 'zfs-2.2.3')
    assert.equal(data.fingerprint, fingerprintFromBlob(ED_BLOB))
  })

  it('test: auth-failed vs no-zfs distinguished from stderr/exit', async () => {
    const mock = mockOf(server)
    // Pre-pin so stage 1 is satisfied.
    await writeFile(paths.knownHostsFile, `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, 'utf-8')
    sshFix(mock, ['true'], { stdout: '', stderr: 'Permission denied (publickey).', exitCode: 255 })
    const authRes = await server.inject({ method: 'POST', url: '/v1/replication/remotes/test', headers: JSON_HEADERS, payload: JSON.stringify({ host: REMOTE.host }) })
    assert.equal(authRes.json().data.stage, 'auth-failed')

    mock.clearFixtures()
    await writeFile(paths.knownHostsFile, `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, 'utf-8')
    sshFix(mock, ['true'], { stdout: '', stderr: '', exitCode: 0 })
    sshFix(mock, ['zfs', '--version'], { stdout: '', stderr: 'zfs: command not found', exitCode: 127 })
    const noZfsRes = await server.inject({ method: 'POST', url: '/v1/replication/remotes/test', headers: JSON_HEADERS, payload: JSON.stringify({ host: REMOTE.host }) })
    assert.equal(noZfsRes.json().data.stage, 'no-zfs')
  })

  it('named-remote test (:name/test) probes the registered remote → ok', async () => {
    await createRemote(0)
    const mock = mockOf(server)
    await writeFile(paths.knownHostsFile, `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, 'utf-8')
    sshFix(mock, ['true'], { stdout: '', stderr: '', exitCode: 0 })
    sshFix(mock, ['zfs', '--version'], { stdout: 'zfs-2.2.0\n', stderr: '', exitCode: 0 })
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes/nas1/test', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(res.json().data.stage, 'ok')
  })

  // --- locations + pool pickers ---------------------------------------------
  it('GET /replication/locations lists peers (minus self) and remote names', async () => {
    await createRemote(0)
    const res = await server.inject({ method: 'GET', url: '/v1/replication/locations', headers: IDENTITY })
    const { data } = res.json()
    assert.deepEqual(data.peers, ['node2', 'node3'])
    assert.deepEqual(data.remotes, ['nas1'])
  })

  it('GET remote/peer pools → { data: string[] } (fail-open [])', async () => {
    await createRemote(0)
    const mock = mockOf(server)
    sshFix(mock, ['zpool', 'list', '-H', '-o', 'name'], { stdout: 'backup\ntank\n', stderr: '', exitCode: 0 })
    const remotePools = await server.inject({ method: 'GET', url: '/v1/replication/remotes/nas1/pools', headers: IDENTITY })
    assert.deepEqual(remotePools.json().data, ['backup', 'tank'])

    const peerResolved = buildSshArgv({ kind: 'peer', host: 'node2' }, ['zpool', 'list', '-H', '-o', 'name'])
    mock.addFixture({ command: peerResolved[0], args: peerResolved.slice(1), result: { stdout: 'rpool\n', stderr: '', exitCode: 0 } })
    const peerPools = await server.inject({ method: 'GET', url: '/v1/replication/peers/node2/pools', headers: IDENTITY })
    assert.deepEqual(peerPools.json().data, ['rpool'])
  })
})
