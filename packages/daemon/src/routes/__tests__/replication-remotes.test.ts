import type { Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { JobQueue } from '../../jobs/queue.js'
import type { RemotesPaths } from '../../services/replication-remotes.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'
import { fingerprintFromBlob } from '../../services/replication-remotes.js'
import { buildSshArgv, resolvedRemoteFields } from '../../services/replication-transport.js'
import { renderServiceUnit } from '../../services/replication-units.js'

const SSH = '/usr/bin/ssh'
const SSH_KEYSCAN = '/usr/bin/ssh-keyscan'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

const ED_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExamp1'
/** A DIFFERENT host key — the one a rebuilt/rekeyed remote presents. */
const NEW_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIRebuiltRebuiltRebuiltRebuiltRebuiltReb2'

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

  // --- cr.62 (review L9): the GET never writes the key; the POST does --------
  it('GET with no key answers publicKey \'\' and runs no ssh-keygen (cr.62)', async () => {
    await rm(`${paths.keyPath}.pub`)
    const res = await server.inject({ method: 'GET', url: '/v1/replication/remotes', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().data.publicKey, '')
    assert.deepEqual(mockOf(server).calls.filter(c => c.command.endsWith('ssh-keygen')), [], 'a GET never creates the cluster key')
  })

  it('POST /replication/remotes/keypair creates the key in a job; GET then shows it (cr.62)', async () => {
    await rm(`${paths.keyPath}.pub`)
    mockOf(server).addFixture({ command: '/usr/bin/ssh-keygen', result: { stdout: '', stderr: '', exitCode: 0 } })
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes/keypair', headers: IDENTITY })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, res.json().job.id)
    assert.equal(job.status, 'completed')
    const keygen = mockOf(server).calls.filter(c => c.command.endsWith('ssh-keygen'))
    assert.equal(keygen.length, 1)
    assert.deepEqual(keygen[0].args, ['-t', 'ed25519', '-N', '', '-C', 'anas-replication', '-f', paths.keyPath])
    // What the real ssh-keygen leaves behind, then the read the window makes.
    await writeFile(`${paths.keyPath}.pub`, 'ssh-ed25519 AAAANEW anas-replication\n', 'utf-8')
    const { data } = (await server.inject({ method: 'GET', url: '/v1/replication/remotes', headers: IDENTITY })).json()
    assert.equal(data.publicKey, 'ssh-ed25519 AAAANEW anas-replication')
  })

  it('POST /replication/remotes/keypair never regenerates an existing key (cr.62)', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes/keypair', headers: IDENTITY })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, res.json().job.id)
    assert.deepEqual(job.result, { publicKey: 'ssh-ed25519 AAAAPUB anas-replication' })
    assert.deepEqual(mockOf(server).calls.filter(c => c.command.endsWith('ssh-keygen')), [])
  })

  it('POST /replication/remotes/keypair from a Sys.Audit-only request is refused by the job backstop (cr.62)', async () => {
    await rm(`${paths.keyPath}.pub`)
    const res = await server.inject({
      method: 'POST',
      url: '/v1/replication/remotes/keypair',
      headers: { ...IDENTITY, 'x-anas-user': 'audit@pve', 'x-anas-privileges': 'Sys.Audit' },
    })
    assert.equal(res.statusCode, 403, res.body)
    assert.deepEqual(mockOf(server).calls.filter(c => c.command.endsWith('ssh-keygen')), [])
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
    mock.addFixture({ command: SSH_KEYSCAN, args: ['-T', '10', '-p', '22', '--', REMOTE.host], result: { stdout: `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, stderr: '', exitCode: 0 } })
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes/test', headers: JSON_HEADERS, payload: JSON.stringify({ host: REMOTE.host }) })
    assert.equal(res.statusCode, 200)
    const { data } = res.json()
    assert.equal(data.stage, 'hostkey-unknown')
    assert.equal(data.fingerprint, fingerprintFromBlob(ED_BLOB))
  })

  // --- cr.64b2-ii (L22): pin/retrust are jobs BOUND to the shown fingerprint -
  it('cr.64b2-ii: pin without a fingerprint → 400 VALIDATION_ERROR naming it, ssh never executed', async () => {
    const mock = mockOf(server)
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes/test?pin=true', headers: JSON_HEADERS, payload: JSON.stringify({ host: REMOTE.host }) })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /fingerprint/)
    await createRemote(0)
    const res2 = await server.inject({ method: 'POST', url: '/v1/replication/remotes/nas1/test?retrust=true', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(res2.statusCode, 400)
    assert.equal(res2.json().error.code, 'VALIDATION_ERROR')
    assert.match(res2.json().error.message, /fingerprint/)
    assertNoSsh(mock)
  })

  it('cr.64b2-ii: ?pin=true is a JOB that pins ONLY the shown fingerprint, then advances to ok + zfsVersion', async () => {
    const mock = mockOf(server)
    mock.addFixture({ command: SSH_KEYSCAN, args: ['-T', '10', '-p', '22', '--', REMOTE.host], result: { stdout: `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, stderr: '', exitCode: 0 } })
    sshFix(mock, ['true'], { stdout: '', stderr: '', exitCode: 0 })
    sshFix(mock, ['zfs', '--version'], { stdout: 'zfs-2.2.3\nzfs-kmod-2.2.3\n', stderr: '', exitCode: 0 })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/replication/remotes/test?pin=true',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ host: REMOTE.host, fingerprint: fingerprintFromBlob(ED_BLOB) }),
    })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { stage?: string, zfsVersion?: string, fingerprint?: string, warnings?: string[] }
    assert.equal(result.stage, 'ok')
    assert.equal(result.zfsVersion, 'zfs-2.2.3')
    assert.equal(result.fingerprint, fingerprintFromBlob(ED_BLOB))
    // The known_hosts write landed inside the job, byte for byte the pinned line:
    //   10.0.0.9 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExamp1
    assert.equal(await readFile(paths.knownHostsFile, 'utf-8'), `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`)
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

  // --- C1 (review 2026-10-14): ssh-option injection refused at both doors ----
  // user/host = `-oProxyCommand=id` used to reach ssh AS AN OPTION (both on the
  // pre-registration probe and, once stored, on every later sshExec) — root
  // command execution. The schemas reject it before the executor ever runs.
  const HOSTILE = '-oProxyCommand=id'

  /** No ssh (or ssh-keyscan) invocation may have reached the executor. */
  function assertNoSsh(mock: MockExecutor): void {
    const sshCalls = mock.calls.filter(c => c.command === SSH || c.command === SSH_KEYSCAN)
    assert.deepEqual(sshCalls, [], `expected no ssh calls, got ${JSON.stringify(sshCalls)}`)
  }

  it('test (pre-registration): hostile user rejected 400, ssh never executed', async () => {
    const mock = mockOf(server)
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes/test', headers: JSON_HEADERS, payload: JSON.stringify({ host: REMOTE.host, user: HOSTILE }) })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assertNoSsh(mock)
  })

  it('test (pre-registration): hostile host rejected 400, ssh never executed', async () => {
    const mock = mockOf(server)
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes/test', headers: JSON_HEADERS, payload: JSON.stringify({ host: HOSTILE }) })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assertNoSsh(mock)
  })

  it('create/update: hostile user rejected 400 at both doors, ssh never executed', async () => {
    const mock = mockOf(server)
    const create = await server.inject({ method: 'POST', url: '/v1/replication/remotes', headers: JSON_HEADERS, payload: JSON.stringify({ remote: { ...REMOTE, user: HOSTILE }, expectedVersion: 0 }) })
    assert.equal(create.statusCode, 400)
    assert.equal(create.json().error.code, 'VALIDATION_ERROR')

    await createRemote(0)
    const update = await server.inject({ method: 'PUT', url: '/v1/replication/remotes/nas1', headers: JSON_HEADERS, payload: JSON.stringify({ remote: { ...REMOTE, user: HOSTILE }, expectedVersion: 1 }) })
    assert.equal(update.statusCode, 400)
    assert.equal(update.json().error.code, 'VALIDATION_ERROR')
    assertNoSsh(mock)
  })

  it('create/update: hostile host rejected 400 at both doors, ssh never executed', async () => {
    const mock = mockOf(server)
    const create = await server.inject({ method: 'POST', url: '/v1/replication/remotes', headers: JSON_HEADERS, payload: JSON.stringify({ remote: { ...REMOTE, host: HOSTILE }, expectedVersion: 0 }) })
    assert.equal(create.statusCode, 400)
    assert.equal(create.json().error.code, 'VALIDATION_ERROR')

    await createRemote(0)
    const update = await server.inject({ method: 'PUT', url: '/v1/replication/remotes/nas1', headers: JSON_HEADERS, payload: JSON.stringify({ remote: { ...REMOTE, host: HOSTILE }, expectedVersion: 1 }) })
    assert.equal(update.statusCode, 400)
    assert.equal(update.json().error.code, 'VALIDATION_ERROR')
    assertNoSsh(mock)
  })

  it('named-remote test (:name/test) probes the registered remote → ok, and MIRRORS the pinned fingerprint', async () => {
    await createRemote(0)
    const mock = mockOf(server)
    await writeFile(paths.knownHostsFile, `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, 'utf-8')
    sshFix(mock, ['true'], { stdout: '', stderr: '', exitCode: 0 })
    sshFix(mock, ['zfs', '--version'], { stdout: 'zfs-2.2.0\n', stderr: '', exitCode: 0 })
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes/nas1/test', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(res.json().data.stage, 'ok')
    // hostKeyFingerprint was never written by any daemon code, so the Remotes
    // grid's Host key column said "not pinned" forever. The probe now records
    // what known_hosts actually holds.
    const { data } = (await server.inject({ method: 'GET', url: '/v1/replication/remotes', headers: IDENTITY })).json()
    assert.equal(data.remotes[0].hostKeyFingerprint, fingerprintFromBlob(ED_BLOB))
  })

  // --- rekeyed remote: its own stage, and a deliberate re-trust --------------
  // A rebuilt/rekeyed remote used to report 'unreachable' forever: pinning is
  // append-only, so the stale line kept failing verification and the only repair
  // was hand-editing known_hosts.

  /** ssh's answer when the presented host key is not the pinned one. */
  const CHANGED_STDERR = '@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@\n'
    + 'Host key verification failed.'

  it('a rekeyed host reports hostkey-changed with BOTH fingerprints, and pins nothing', async () => {
    const mock = mockOf(server)
    await writeFile(paths.knownHostsFile, `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, 'utf-8')
    mock.addFixture({ command: SSH_KEYSCAN, args: ['-T', '10', '-p', '22', '--', REMOTE.host], result: { stdout: `${REMOTE.host} ssh-ed25519 ${NEW_BLOB}\n`, stderr: '', exitCode: 0 } })
    sshFix(mock, ['true'], { stdout: '', stderr: CHANGED_STDERR, exitCode: 255 })

    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes/test', headers: JSON_HEADERS, payload: JSON.stringify({ host: REMOTE.host }) })
    const { data } = res.json()
    assert.equal(data.stage, 'hostkey-changed')
    // Distinct from 'hostkey-unknown' (nothing pinned) and from 'unreachable'.
    assert.equal(data.knownFingerprint, fingerprintFromBlob(ED_BLOB), 'the key we pinned')
    assert.equal(data.fingerprint, fingerprintFromBlob(NEW_BLOB), 'the key the host presents now')
    // Diagnosing must never trust: known_hosts is byte-for-byte unchanged.
    assert.equal(await readFile(paths.knownHostsFile, 'utf-8'), `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`)
  })

  it('cr.64b2-ii: a pin whose shown fingerprint the host no longer presents → job refuses STATE_CHANGED naming both, known_hosts untouched', async () => {
    const mock = mockOf(server)
    await writeFile(paths.knownHostsFile, `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, 'utf-8')
    mock.addFixture({ command: SSH_KEYSCAN, args: ['-T', '10', '-p', '22', '--', REMOTE.host], result: { stdout: `${REMOTE.host} ssh-ed25519 ${NEW_BLOB}\n`, stderr: '', exitCode: 0 } })

    // The operator was shown the OLD key (or any string that is not what the
    // host now presents) — before cr.64b2-ii this request pinned NEW_BLOB
    // whatever it was; now it is a refusal.
    const res = await server.inject({
      method: 'POST',
      url: '/v1/replication/remotes/test?pin=true',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ host: REMOTE.host, fingerprint: fingerprintFromBlob(ED_BLOB) }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, res.json().job.id)
    assert.equal(job.status, 'failed', JSON.stringify(job))
    assert.equal(job.error?.code, 'STATE_CHANGED', JSON.stringify(job.error))
    assert.ok((job.error?.message ?? '').includes(fingerprintFromBlob(NEW_BLOB)), 'names the presented fingerprint')
    assert.ok((job.error?.message ?? '').includes(fingerprintFromBlob(ED_BLOB)), 'names the confirmed fingerprint')
    assert.equal(await readFile(paths.knownHostsFile, 'utf-8'), `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`)
  })

  it('cr.64b2-ii: an ordinary pin never replaces an existing pin — shown key IS presented but another is pinned → STATE_CHANGED', async () => {
    const mock = mockOf(server)
    await writeFile(paths.knownHostsFile, `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, 'utf-8')
    mock.addFixture({ command: SSH_KEYSCAN, args: ['-T', '10', '-p', '22', '--', REMOTE.host], result: { stdout: `${REMOTE.host} ssh-ed25519 ${NEW_BLOB}\n`, stderr: '', exitCode: 0 } })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/replication/remotes/test?pin=true',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ host: REMOTE.host, fingerprint: fingerprintFromBlob(NEW_BLOB) }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, res.json().job.id)
    assert.equal(job.status, 'failed', JSON.stringify(job))
    assert.equal(job.error?.code, 'STATE_CHANGED', JSON.stringify(job.error))
    assert.match(job.error?.message ?? '', /never replaces a key/)
    assert.equal(await readFile(paths.knownHostsFile, 'utf-8'), `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`)
  })

  it('cr.64b2-ii: ?retrust=true REPLACES the pinned key (other hosts untouched) in a job, and the probe completes', async () => {
    await createRemote(0)
    const mock = mockOf(server)
    await writeFile(
      paths.knownHostsFile,
      `other.example ssh-ed25519 ${ED_BLOB}\n${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`,
      'utf-8',
    )
    mock.addFixture({ command: SSH_KEYSCAN, args: ['-T', '10', '-p', '22', '--', REMOTE.host], result: { stdout: `${REMOTE.host} ssh-ed25519 ${NEW_BLOB}\n`, stderr: '', exitCode: 0 } })
    sshFix(mock, ['true'], { stdout: '', stderr: '', exitCode: 0 })
    sshFix(mock, ['zfs', '--version'], { stdout: 'zfs-2.2.3\n', stderr: '', exitCode: 0 })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/replication/remotes/nas1/test?retrust=true',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ fingerprint: fingerprintFromBlob(NEW_BLOB) }),
    })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { stage?: string, fingerprint?: string }
    assert.equal(result.stage, 'ok')
    assert.equal(result.fingerprint, fingerprintFromBlob(NEW_BLOB))

    // known_hosts after the job (pasted):
    //   other.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExamp1
    //   10.0.0.9 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRebuiltRebuiltRebuiltRebuiltRebuiltReb2
    const known = await readFile(paths.knownHostsFile, 'utf-8')
    assert.ok(known.includes(`${REMOTE.host} ssh-ed25519 ${NEW_BLOB}`), 'the new key is pinned')
    assert.ok(!known.includes(`${REMOTE.host} ssh-ed25519 ${ED_BLOB}`), 'the stale key is gone — replaced, not appended')
    assert.ok(known.includes(`other.example ssh-ed25519 ${ED_BLOB}`), 'another host\'s pin is untouched')

    // And the registry now shows the key the grid should display.
    const reg = (await server.inject({ method: 'GET', url: '/v1/replication/remotes', headers: IDENTITY })).json()
    assert.equal(reg.data.remotes[0].hostKeyFingerprint, fingerprintFromBlob(NEW_BLOB))
  })

  it('cr.64b2-ii: a re-trust whose keyscan comes back empty changes nothing — a flaky network cannot un-trust a host', async () => {
    const mock = mockOf(server)
    await writeFile(paths.knownHostsFile, `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, 'utf-8')
    mock.addFixture({ command: SSH_KEYSCAN, args: ['-T', '10', '-p', '22', '--', REMOTE.host], result: { stdout: '', stderr: 'timed out', exitCode: 1 } })

    const res = await server.inject({
      method: 'POST',
      url: '/v1/replication/remotes/test?retrust=true',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ host: REMOTE.host, fingerprint: fingerprintFromBlob(ED_BLOB) }),
    })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { stage?: string, knownFingerprint?: string }
    assert.equal(result.stage, 'unreachable')
    assert.equal(result.knownFingerprint, fingerprintFromBlob(ED_BLOB))
    assert.equal(await readFile(paths.knownHostsFile, 'utf-8'), `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`)
  })

  it('cr.64b2-ii: a failed registry mirror lands in the job result\'s warnings, not swallowed', async () => {
    await createRemote(0)
    const mock = mockOf(server)
    const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
    await writeFile(paths.knownHostsFile, `other.example ssh-ed25519 ${ED_BLOB}\n${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, 'utf-8')
    mock.addFixture({ command: SSH_KEYSCAN, args: ['-T', '10', '-p', '22', '--', REMOTE.host], result: { stdout: `${REMOTE.host} ssh-ed25519 ${NEW_BLOB}\n`, stderr: '', exitCode: 0 } })
    sshFix(mock, ['true'], { stdout: '', stderr: '', exitCode: 0 })
    sshFix(mock, ['zfs', '--version'], { stdout: 'zfs-2.2.3\n', stderr: '', exitCode: 0 })

    // Paused-queue pattern: the route reads the registry (fine), the job waits
    // behind the held slots; while it waits the registry store goes unreadable,
    // so the job's mirror write must report, not swallow.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue.submit('test.hold', { user: 'root@pam', uid: 0 }, () => held)
    const res = await server.inject({
      method: 'POST',
      url: '/v1/replication/remotes/nas1/test?retrust=true',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ fingerprint: fingerprintFromBlob(NEW_BLOB) }),
    })
    assert.equal(res.statusCode, 202)
    const id = res.json().job.id
    await chmod(paths.registryFile, 0o000)
    release()
    const job = await waitForJob(server, id)
    await chmod(paths.registryFile, 0o600)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { stage?: string, warnings?: string[] }
    assert.equal(result.stage, 'ok', 'the probe itself succeeded; only the bookkeeping failed')
    assert.ok(result.warnings?.some(w => /mirror/.test(w)), JSON.stringify(result))
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
