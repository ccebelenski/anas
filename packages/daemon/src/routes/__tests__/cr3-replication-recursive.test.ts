import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { zfsListArgs } from '../../parsers/zfs-list.js'
import { zfsTreeGetArgs, zfsTreeSnapshotsArgs } from '../../parsers/zfs-tree.js'
import { createServer } from '../../server.js'
import { zfsTreeListArgs } from '../../services/zfs-snapshot.js'

/**
 * cr3 REPLICATION-L4 (R9): the recursive run's claims are taken on the
 * ROUTE's sweep; a child created while the job waited was swept by the job's
 * fresh read but never claimed, so a destroy or rename of it would not wait
 * for the send. The run now refuses STATE_CHANGED before the first send.
 * Built on the captured `fixtures/zfs/replication-tree/` before-state, as
 * replication-recursive.test.ts is.
 */

const fixturesDir = join(import.meta.dirname, '../../fixtures/zfs/replication-tree')
const ZFS = '/usr/sbin/zfs'
const ZPOOL = '/usr/sbin/zpool'
const PERL = '/usr/bin/perl'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

const SOURCE = 'rpool/rrsrc'
const TARGET_ROOT = 'datapool/rrdst'
const TARGET_POOL = 'datapool'
const S1 = 'anas-daily-2026-11-13_01.00.00--1d'
const S2 = 'anas-daily-2026-11-14_01.00.00--1d'
const PLANNED = ['rpool/rrsrc', 'rpool/rrsrc/a', 'rpool/rrsrc/a/deep', 'rpool/rrsrc/enc', 'rpool/rrsrc/new', 'rpool/rrsrc/vol']

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('cr3 REPLICATION-L4 — the job sweeps only what the route claimed', () => {
  let server: ReturnType<typeof createServer>
  let mock: MockExecutor
  let dir: string
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-recrrep-'))
    setEnv('ANAS_STORAGE_CFG', join(dir, 'absent-storage.cfg'))
    setEnv('ANAS_SYSTEMD_DIR', join(dir, 'units'))
    await mkdir(join(dir, 'units'), { recursive: true })
    server = createServer({ mock: true, logger: false })
    mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: PERL, result: ok('') })
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: ok(JSON.stringify({ pools: { rpool: { name: 'rpool', state: 'ONLINE', properties: {} }, datapool: { name: 'datapool', state: 'ONLINE', properties: {} } } })) })
    mock.addFixture({ command: ZFS, args: zfsListArgs('rpool'), result: ok(JSON.stringify({ datasets: { 'rpool': { name: 'rpool', type: 'FILESYSTEM', pool: 'rpool', properties: {} }, 'rpool/rrsrc': { name: 'rpool/rrsrc', type: 'FILESYSTEM', pool: 'rpool', properties: {} } } })) })
    mock.addFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(SOURCE), result: ok(fixture('src-snaps-p.txt')) })
    mock.addFixture({ command: ZFS, args: zfsTreeGetArgs(SOURCE, ['keystatus']), result: ok(fixture('src-keystatus.txt')) })
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', 'rpool'], result: ok('111\n') })
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', TARGET_POOL], result: ok('222\n') })
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: ok('rpool\t-\ndatapool\t-\n') })
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['-n', '-o', 'SOURCE,FSTYPE', '/'], result: { stdout: '', stderr: '', exitCode: 1 } })
    mock.addFixture({ command: ZFS, args: zfsTreeListArgs(TARGET_POOL), result: ok(`datapool\n${fixture('dst-tree.txt')}`) })
    mock.addFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(TARGET_ROOT), result: ok(fixture('dst-snaps-p.txt')) })
    mock.addFixture({ command: ZFS, args: zfsTreeGetArgs(TARGET_ROOT, ['written', 'readonly']), result: ok(fixture('dst-written.txt')) })
    for (const dataset of PLANNED) {
      const args = dataset !== 'rpool/rrsrc/new'
        ? ['send', '-nvP', '-i', `@${S1}`, '--', `${dataset}@${S2}`]
        : ['send', '-nvP', '--', `${dataset}@${S2}`]
      mock.addFixture({ command: ZFS, args, result: ok('size\t1000\n') })
    }
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

  async function run() {
    // hold / holds / release and any remaining read fall through to success.
    mock.addFixture({ command: ZFS, result: ok('') })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/rpool/datasets/rrsrc/replicate',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ target: { pool: TARGET_POOL, dataset: 'rrdst' }, recursive: true, exclude: ['rpool/rrsrc/skipme'], notify: 'always' }),
    })
    assert.equal(res.statusCode, 202, res.body)
    return waitForJob(server, (res.json() as JobAccepted).job.id)
  }

  it('a child born between the route and the job refuses STATE_CHANGED naming it; nothing is sent', async () => {
    const tree = fixture('src-tree.txt')
    mock.prependFixture({ command: ZFS, args: zfsTreeListArgs(SOURCE), results: [ok(tree), ok(`${tree}rpool/rrsrc/born\n`)] })
    const job = await run()
    assert.equal(job.status, 'failed', JSON.stringify(job))
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.equal(job.error?.message, 'The tree under \'rpool/rrsrc\' changed after the run was accepted: \'rpool/rrsrc/born\' is not claimed by this run — nothing was sent; run it again')
    assert.equal(mock.pipelineCalls.length, 0)
  })

  it('the same tree at both reads runs (the control)', async () => {
    mock.addFixture({ command: ZFS, args: zfsTreeListArgs(SOURCE), result: ok(fixture('src-tree.txt')) })
    const job = await run()
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal(mock.pipelineCalls.length, PLANNED.length)
  })
})
