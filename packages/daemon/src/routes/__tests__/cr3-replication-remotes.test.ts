import type { Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { RemotesPaths } from '../../services/replication-remotes.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zfsSnapshotDetailArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { fingerprintFromBlob, pinHostKey } from '../../services/replication-remotes.js'
import { buildSshArgv, resolvedRemoteFields } from '../../services/replication-transport.js'
import { renderServiceUnit } from '../../services/replication-units.js'

/**
 * cr3 (the 2026-11-14 review, area `replication`): the remotes doors.
 *
 *   REPLICATION-M2 — a pin or re-trust writes ONLY the confirmed key's line
 *     (the reviewer's probe-pin-extra-keys.mts is the first test here).
 *   REPLICATION-M3 — a remote's `zpool list` line is a pool only when it
 *     passes PoolName (the picker rendered it as HTML); a peer name read from
 *     /etc/pve/.members only when it is a host name.
 *   The remote-delete check fails closed on a task store it cannot read in
 *     full, and its result says other nodes' tasks were not read.
 */

const SSH_KEYSCAN = '/usr/bin/ssh-keyscan'
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/zfs')

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

const ED_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExamp1'
const NEW_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIRebuiltRebuiltRebuiltRebuiltRebuiltReb2'
/** A key of another type the same scan returned — nobody was shown it. */
const RSA_BLOB = 'AAAAB3NzaC1yc2EAAAADAQABAAABgExampleRsaKeyBlobExampleRsaKeyBlob00'

const REMOTE = { name: 'nas1', host: '10.0.0.9', port: 22, user: 'root' }

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

describe('cr3 replication remotes', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  let paths: RemotesPaths
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-remotes-'))
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
    await writeFile(join(dir, 'members.json'), JSON.stringify({
      nodename: 'node1',
      nodelist: { 'node1': {}, 'node2': {}, '<img src=x onerror=alert(1)>': {} },
    }), 'utf-8')
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

  async function createRemote() {
    const res = await server.inject({ method: 'POST', url: '/v1/replication/remotes', headers: JSON_HEADERS, payload: JSON.stringify({ remote: REMOTE, expectedVersion: 0 }) })
    assert.equal(res.statusCode, 202, res.body)
    await waitForJob(server, res.json().job.id)
  }

  function sshFix(mock: MockExecutor, cmd: string[], result: { stdout: string, stderr: string, exitCode: number }) {
    const argv = buildSshArgv(resolvedRemoteFields(paths, REMOTE.host, REMOTE.port, REMOTE.user), cmd)
    mock.addFixture({ command: argv[0], args: argv.slice(1), result })
  }

  function scanFix(mock: MockExecutor, stdout: string) {
    mock.addFixture({ command: SSH_KEYSCAN, args: ['-T', '10', '-p', '22', '--', REMOTE.host], result: { stdout, stderr: '', exitCode: 0 } })
  }

  // --- REPLICATION-M2 ---------------------------------------------------------
  it('M2 (the reviewer\'s probe): pinHostKey bound to the confirmed fingerprint writes only that key\'s line', async () => {
    const mock = mockOf(server)
    scanFix(mock, `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n${REMOTE.host} ssh-rsa ${RSA_BLOB}\n`)
    const wrote = await pinHostKey(mock, paths, REMOTE.host, 22, { onlyFingerprint: fingerprintFromBlob(ED_BLOB) })
    assert.equal(wrote, fingerprintFromBlob(ED_BLOB))
    assert.equal(await readFile(paths.knownHostsFile, 'utf-8'), `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`)
  })

  it('M2: a scan that carries no line of the confirmed fingerprint writes nothing and answers the key it saw', async () => {
    const mock = mockOf(server)
    scanFix(mock, `${REMOTE.host} ssh-rsa ${RSA_BLOB}\n`)
    const wrote = await pinHostKey(mock, paths, REMOTE.host, 22, { onlyFingerprint: fingerprintFromBlob(ED_BLOB) })
    assert.equal(wrote, fingerprintFromBlob(RSA_BLOB))
    await assert.rejects(readFile(paths.knownHostsFile, 'utf-8'), /ENOENT/)
  })

  it('M2: the ?pin=true job pins the shown ed25519 key and NOT the rsa key the same scan returned', async () => {
    const mock = mockOf(server)
    scanFix(mock, `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n${REMOTE.host} ssh-rsa ${RSA_BLOB}\n`)
    sshFix(mock, ['true'], { stdout: '', stderr: '', exitCode: 0 })
    sshFix(mock, ['zfs', '--version'], { stdout: 'zfs-2.2.3\n', stderr: '', exitCode: 0 })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/replication/remotes/test?pin=true',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ host: REMOTE.host, fingerprint: fingerprintFromBlob(ED_BLOB) }),
    })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal(await readFile(paths.knownHostsFile, 'utf-8'), `${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`)
  })

  it('M2: a re-trust replaces the host\'s line with the confirmed key only; another host is untouched', async () => {
    await createRemote()
    const mock = mockOf(server)
    await writeFile(paths.knownHostsFile, `other.example ssh-rsa ${RSA_BLOB}\n${REMOTE.host} ssh-ed25519 ${ED_BLOB}\n`, 'utf-8')
    scanFix(mock, `${REMOTE.host} ssh-rsa ${RSA_BLOB}\n${REMOTE.host} ssh-ed25519 ${NEW_BLOB}\n`)
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
    assert.equal(await readFile(paths.knownHostsFile, 'utf-8'), `other.example ssh-rsa ${RSA_BLOB}\n${REMOTE.host} ssh-ed25519 ${NEW_BLOB}\n`)
  })

  // --- REPLICATION-M3 ---------------------------------------------------------
  it('M3: a remote pool line that is not a PoolName never reaches the picker; the real pools do', async () => {
    await createRemote()
    const mock = mockOf(server)
    sshFix(mock, ['zpool', 'list', '-H', '-o', 'name'], {
      stdout: 'backup\n<b id="inj1">p</b>\nWelcome to the NAS\ntank\n',
      stderr: '',
      exitCode: 0,
    })
    const res = await server.inject({ method: 'GET', url: '/v1/replication/remotes/nas1/pools', headers: IDENTITY })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json().data, ['backup', 'tank'])
  })

  it('M3: a peer whose node name is not a host name is not offered as a location', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/replication/locations', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().data.peers, ['node2'])
  })

  // --- REPLICATION-L6's remote twin: the task lag over ssh --------------------
  it('L6: a remote target whose snapshot listing fails over ssh reads unknown lag, never "every snapshot behind"', async () => {
    await createRemote()
    const mock = mockOf(server)
    await writeFile(join(dir, 'anas-repl-to-nas1.service'), renderServiceUnit({
      name: 'to-nas1',
      source: { pool: 'testpool', dataset: 'media' },
      target: { pool: 'backup', dataset: 'media', location: { kind: 'remote', name: 'nas1' } },
      schedule: 'daily',
      snapshotFirst: true,
      enabled: true,
      notify: 'on-failure',
    }), 'utf-8')
    mock.addFixture({ command: '/usr/sbin/zfs', args: zfsSnapshotDetailArgs('testpool/media'), result: { stdout: readFileSync(join(FIXTURES, 'zfs-snapshots-media.json'), 'utf-8'), stderr: '', exitCode: 0 } })
    sshFix(mock, ['zfs', 'list', '-H', '-o', 'name', '--', 'backup/media'], { stdout: 'backup/media\n', stderr: '', exitCode: 0 })
    sshFix(mock, ['zfs', 'list', '-H', '-t', 'snapshot', '-o', 'name,creation', '-s', 'createtxg', '--', 'backup/media'], { stdout: '', stderr: 'Connection closed by 10.0.0.9 port 22', exitCode: 255 })
    const res = await server.inject({ method: 'GET', url: '/v1/replication/tasks', headers: IDENTITY })
    assert.equal(res.statusCode, 200, res.body)
    const [status] = res.json().data
    assert.equal(status.task.name, 'to-nas1')
    assert.equal(status.snapshotsBehind, null)
    assert.equal(status.lastReplicatedSnapshot, null)
  })

  // --- the remote-delete check ----------------------------------------------
  it('a task unit that cannot be read refuses the delete (503), never "no task uses it"', async () => {
    await createRemote()
    await writeFile(join(dir, 'anas-repl-broken.service'), '[Unit]\nDescription=hand edited\n', 'utf-8')
    const res = await server.inject({ method: 'DELETE', url: '/v1/replication/remotes/nas1?expectedVersion=1', headers: IDENTITY })
    assert.equal(res.statusCode, 503, res.body)
    assert.equal(res.json().error.code, 'UNAVAILABLE')
    assert.match(res.json().error.message, /Could not read every replication task on this node.*remote 'nas1'/)
    const reg = (await server.inject({ method: 'GET', url: '/v1/replication/remotes', headers: IDENTITY })).json()
    assert.equal(reg.data.remotes.length, 1, 'the remote is still registered')
  })

  it('a delete that goes through says that only this node\'s tasks were checked', async () => {
    await createRemote()
    const res = await server.inject({ method: 'DELETE', url: '/v1/replication/remotes/nas1?expectedVersion=1', headers: IDENTITY })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.match((job.result as { note?: string }).note ?? '', /Only this node's replication tasks were checked/)
  })
})
