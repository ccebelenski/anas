import type { Job, ReplicatePlan } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { RemotesPaths } from '../../services/replication-remotes.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { zfsListArgs, zfsSnapshotDetailArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { buildSshArgv, resolvedRemoteFields } from '../../services/replication-transport.js'

const ZFS = '/usr/sbin/zfs'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

const SOURCE = 'testpool/media'
const TARGET = 'backup/media'
const SNAP = 'repl-base'
const REMOTE = { name: 'nas1', host: '10.0.0.9', port: 22, user: 'root' }
const FULL_DRYRUN = `full\t${SOURCE}@${SNAP}\t13424\nsize\t13424\n`

function zfsListJson(names: string[]): string {
  const datasets: Record<string, unknown> = {}
  for (const name of names)
    datasets[name] = { name, type: 'FILESYSTEM', pool: name.split('/')[0], properties: {} }
  return JSON.stringify({ datasets })
}

function snapshotListJson(dataset: string, snaps: string[]): string {
  const datasets: Record<string, unknown> = {}
  for (const [i, s] of snaps.entries())
    datasets[`${dataset}@${s}`] = { name: `${dataset}@${s}`, type: 'SNAPSHOT', pool: dataset.split('/')[0], dataset, snapshot_name: s, createtxg: String(i + 1), properties: {} }
  return JSON.stringify({ datasets })
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

describe('replication to a REMOTE target (Epic 5.5.2)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  let paths: RemotesPaths
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  /** Register an `ssh <opts> <cmd…>` fixture for the resolved nas1 remote. */
  function sshFix(mock: MockExecutor, cmd: string[], result: { stdout: string, stderr: string, exitCode: number }) {
    const resolved = resolvedRemoteFields(paths, REMOTE.host, REMOTE.port, REMOTE.user)
    const argv = buildSshArgv(resolved, cmd)
    mock.addFixture({ command: argv[0], args: argv.slice(1), result })
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-remotetarget-'))
    paths = {
      registryFile: join(dir, 'remotes.json'),
      keyPath: join(dir, 'replication_key'),
      knownHostsFile: join(dir, 'known_hosts'),
    }
    setEnv('ANAS_REMOTES_FILE', paths.registryFile)
    setEnv('ANAS_REPL_KEY', paths.keyPath)
    setEnv('ANAS_REPL_KNOWN_HOSTS', paths.knownHostsFile)
    setEnv('ANAS_PVE_MEMBERS', join(dir, 'members.json'))
    setEnv('ANAS_NODENAME', 'node1')
    // Seed the registry with nas1 (version 1).
    await writeFile(paths.registryFile, JSON.stringify({
      version: 1,
      updatedBy: 'node1',
      updatedAt: new Date().toISOString(),
      remotes: [REMOTE],
    }), 'utf-8')

    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    // Local source state.
    mock.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: { stdout: zfsListJson([SOURCE]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs(SOURCE), result: { stdout: snapshotListJson(SOURCE, [SNAP]), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['send', '-nvP', `${SOURCE}@${SNAP}`], result: { stdout: FULL_DRYRUN, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['hold', 'anas-repl', `${SOURCE}@${SNAP}`], result: { stdout: '', stderr: '', exitCode: 0 } })
    // Remote (ssh) state: pool exists, target dataset absent (→ full), holds ok.
    sshFix(mock, ['zpool', 'list', '-H', '-o', 'name'], { stdout: 'backup\n', stderr: '', exitCode: 0 })
    sshFix(mock, ['zfs', 'list', '-H', '-o', 'name', TARGET], { stdout: '', stderr: 'dataset does not exist', exitCode: 1 })
    sshFix(mock, ['zfs', 'hold', 'anas-repl', `${TARGET}@${SNAP}`], { stdout: '', stderr: '', exitCode: 0 })
    sshFix(mock, ['zfs', 'list', '-H', '-t', 'snapshot', '-o', 'name,creation', TARGET], { stdout: '', stderr: '', exitCode: 0 })
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

  it('plan against a remote target: full send, remote pool checked via ssh', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/testpool/datasets/media/replicate/plan`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ target: { pool: 'backup', location: { kind: 'remote', name: 'nas1' } } }),
    })
    assert.equal(res.statusCode, 200)
    const plan = res.json().data as ReplicatePlan
    assert.equal(plan.mode, 'full')
    assert.equal(plan.snapshot, SNAP)
    assert.equal(plan.targetExists, false)
    assert.equal(plan.estimatedBytes, 13424)
  })

  it('plan: unknown remote name → 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/testpool/datasets/media/replicate/plan`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ target: { pool: 'backup', location: { kind: 'remote', name: 'ghost' } } }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /not registered/)
  })

  it('run: pipeline is `zfs send | ssh … zfs recv -o readonly=on <target>` with -i/known_hosts/user@host', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/v1/pools/testpool/datasets/media/replicate`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ target: { pool: 'backup', location: { kind: 'remote', name: 'nas1' } } }),
    })
    assert.equal(res.statusCode, 202)
    const done = await waitForJob(server, res.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))

    const mock = mockOf(server)
    assert.equal(mock.pipelineCalls.length, 1)
    const call = mock.pipelineCalls[0]
    // Left (producer) is a LOCAL zfs send of the source snapshot.
    assert.equal(call.cmd1, ZFS)
    assert.deepEqual(call.args1, ['send', `${SOURCE}@${SNAP}`])
    // Right (consumer) is ssh into the remote running `zfs recv -o readonly=on`.
    const resolved = resolvedRemoteFields(paths, REMOTE.host, REMOTE.port, REMOTE.user)
    const expected = buildSshArgv(resolved, ['zfs', 'recv', '-o', 'readonly=on', TARGET])
    assert.equal(call.cmd2, expected[0])
    assert.deepEqual(call.args2, expected.slice(1))

    // The remote-side hold on the replicated base went over ssh.
    const heldOverSsh = mock.calls.some(c =>
      c.command === '/usr/bin/ssh' && c.args.includes('zfs') && c.args.includes('hold') && c.args.includes(`${TARGET}@${SNAP}`))
    assert.ok(heldOverSsh, 'expected a remote `ssh … zfs hold` on the target base snapshot')
  })
})
