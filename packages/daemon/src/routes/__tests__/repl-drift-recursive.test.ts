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
 * repl.drift, the recursive run: every copy is judged against its own base
 * before the first send. The tree's captured `written,readonly` read answers
 * for a copy whose newest snapshot is its base (no extra command); a copy
 * with a target-only snapshot after its base gets its own `written@<base>`
 * read. A changed copy refuses the run with the drift sentence and ONE
 * notification; a writable one is sent to and warned about. Built on the
 * captured `fixtures/zfs/replication-tree/` before-state (the harness of
 * cr3-replication-recursive.test.ts), with captured values from
 * `fixtures/zfs/zfs-written-replica.zfs2.4.2.txt` written into one row.
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
/** A write since the base, as captured (`zfs-written-replica.zfs2.4.2.txt`: one small file). */
const DRIFT_WRITE = 14336
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

describe('repl.drift — recursive runs', () => {
  let server: ReturnType<typeof createServer>
  let mock: MockExecutor
  let dir: string
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-repl-drift-r-'))
    setEnv('ANAS_STORAGE_CFG', join(dir, 'absent-storage.cfg'))
    setEnv('ANAS_SYSTEMD_DIR', join(dir, 'units'))
    await mkdir(join(dir, 'units'), { recursive: true })
    server = createServer({ mock: true, logger: false })
    mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: PERL, result: ok('') })
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: ok(JSON.stringify({ pools: { rpool: { name: 'rpool', state: 'ONLINE', properties: {} }, datapool: { name: 'datapool', state: 'ONLINE', properties: {} } } })) })
    mock.addFixture({ command: ZFS, args: zfsListArgs('rpool'), result: ok(JSON.stringify({ datasets: { 'rpool': { name: 'rpool', type: 'FILESYSTEM', pool: 'rpool', properties: {} }, 'rpool/rrsrc': { name: 'rpool/rrsrc', type: 'FILESYSTEM', pool: 'rpool', properties: {} } } })) })
    mock.addFixture({ command: ZFS, args: zfsTreeListArgs(SOURCE), result: ok(fixture('src-tree.txt')) })
    mock.addFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(SOURCE), result: ok(fixture('src-snaps-p.txt')) })
    mock.addFixture({ command: ZFS, args: zfsTreeGetArgs(SOURCE, ['keystatus']), result: ok(fixture('src-keystatus.txt')) })
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', 'rpool'], result: ok('111\n') })
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', TARGET_POOL], result: ok('222\n') })
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: ok('rpool\t-\ndatapool\t-\n') })
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['-n', '-o', 'SOURCE,FSTYPE', '/'], result: { stdout: '', stderr: '', exitCode: 1 } })
    mock.addFixture({ command: ZFS, args: zfsTreeListArgs(TARGET_POOL), result: ok(`datapool\n${fixture('dst-tree.txt')}`) })
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

  /** The target tree's reads: the captured snapshots (plus extra rows) and the captured `written,readonly` rows with `edit` applied. */
  function targetReads(opts: { extraSnaps?: string, edit?: (written: string) => string } = {}) {
    mock.addFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(TARGET_ROOT), result: ok(`${fixture('dst-snaps-p.txt')}${opts.extraSnaps ?? ''}`) })
    const written = fixture('dst-written.txt')
    mock.addFixture({ command: ZFS, args: zfsTreeGetArgs(TARGET_ROOT, ['written', 'readonly']), result: ok(opts.edit ? opts.edit(written) : written) })
  }

  async function post() {
    // hold / holds / release and any remaining read fall through to success.
    mock.addFixture({ command: ZFS, result: ok('') })
    return server.inject({
      method: 'POST',
      url: '/v1/pools/rpool/datasets/rrsrc/replicate',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ target: { pool: TARGET_POOL, dataset: 'rrdst' }, recursive: true, exclude: ['rpool/rrsrc/skipme'] }),
    })
  }

  const notifications = () => mock.calls.filter(c => c.command === PERL)
  const holdVerbs = () => mock.calls.filter(c => c.command === ZFS && (c.args[0] === 'hold' || c.args[0] === 'release'))
  const driftReads = () => mock.calls.filter(c => c.command === ZFS && c.args[0] === 'get' && c.args.includes('property,value,source'))

  it('a healthy tree: no extra command (the tree read answers every copy whose newest snapshot is its base), every dataset sent', async () => {
    targetReads()
    const res = await post()
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal(mock.pipelineCalls.length, PLANNED.length)
    assert.deepEqual(driftReads(), [])
    const result = job.result as { warnings?: string[], note?: string, targetDrift?: unknown }
    assert.equal(result.note, undefined)
    assert.equal(result.targetDrift, undefined, 'a healthy run records nothing')
    assert.ok(!(result.warnings ?? []).some(w => w.includes('read-only')))
  })

  // Coordinator's decision (dashboard opens no ssh): the drift is judged in
  // the JOB, so a changed copy fails the job, which records it on its detail
  // (the runner's journal line carries it to the dashboard).
  it('ONE modified child (a write since the base: the captured 14336): the JOB fails naming it, records it, sends nothing, moves no hold, notifies once', async () => {
    targetReads({ edit: w => w.replace('datapool/rrdst/a\twritten\t0', `datapool/rrdst/a\twritten\t${DRIFT_WRITE}`) })
    const res = await post()
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'JOB_FAILED')
    assert.deepEqual(job.detail, { targetDrift: [{ state: 'modified', dataset: 'datapool/rrdst/a', base: S1 }] })
    const message = job.error!.message
    assert.equal(message, `Target 'datapool/rrdst/a' has been changed since '@${S1}': 14.00 KiB written with no new snapshot (a dataset that is not read-only also changes when a file on it is only read, while access-time updates are on). Replication into it stops until those changes are discarded: to continue the chain, on the target roll it back to '@${S1}' ('zfs rollback -r datapool/rrdst/a@${S1}', which destroys the snapshots newer than it there and anything written since). Nothing was sent and no hold was moved or released: the source and its snapshots are untouched; '@${S1}' is not held by this replication on either side, so retention there can remove it.`)
    assert.doesNotMatch(message, /remove the target|, or remove it/)
    assert.equal(mock.pipelineCalls.length, 0)
    assert.deepEqual(holdVerbs(), [])
    assert.equal(notifications().length, 1)
  })

  it('a child changed and then snapshotted on the target (`written` 0, a target-only snapshot): its own written@<base> read finds it', async () => {
    targetReads({ extraSnaps: 'datapool/rrdst/a@local1\t1794618300\t42\n' })
    mock.prependFixture({ command: ZFS, args: ['get', '-Hp', '-o', 'property,value,source', `written@${S1},readonly`, '--', 'datapool/rrdst/a'], result: ok(`written@${S1}\t${DRIFT_WRITE}\t-\nreadonly\ton\tlocal\n`) })
    const res = await post()
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error?.message ?? '', new RegExp(`^Target 'datapool/rrdst/a' has been changed since '@${S1}': 14\\.00 KiB written and newer snapshot\\(s\\) '@local1'\\.`))
    assert.deepEqual(driftReads().map(c => c.args.at(-1)), ['datapool/rrdst/a'])
    assert.equal(mock.pipelineCalls.length, 0)
    assert.equal(notifications().length, 1)
  })

  it('an EMPTY target-only snapshot (written@<base> 0, read-only) is not drift: the run sends', async () => {
    targetReads({ extraSnaps: 'datapool/rrdst/a@anas-backup-x-1\t1794618300\t42\n' })
    mock.prependFixture({ command: ZFS, args: ['get', '-Hp', '-o', 'property,value,source', `written@${S1},readonly`, '--', 'datapool/rrdst/a'], result: ok(`written@${S1}\t0\t-\nreadonly\ton\tlocal\n`) })
    const res = await post()
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal(mock.pipelineCalls.length, PLANNED.length)
  })

  it('a child whose own read fails is noted, and the run goes ahead (ZFS decides)', async () => {
    targetReads({ extraSnaps: 'datapool/rrdst/a@local1\t1794618300\t42\n' })
    mock.prependFixture({ command: ZFS, args: ['get', '-Hp', '-o', 'property,value,source', `written@${S1},readonly`, '--', 'datapool/rrdst/a'], result: { stdout: '', stderr: 'cannot get property: I/O error', exitCode: 1 } })
    const res = await post()
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal((job.result as { note?: string }).note, `Could not check whether target 'datapool/rrdst/a' was changed since '@${S1}': cannot get property: I/O error`)
  })

  it('a writable child (exposed): sent (its receive seals it), the run completes with ONE warning saying so, one notification, nothing recorded', async () => {
    targetReads({ edit: w => w.replace('datapool/rrdst/enc\treadonly\ton', 'datapool/rrdst/enc\treadonly\toff') })
    const res = await post()
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal(mock.pipelineCalls.length, PLANNED.length)
    const warnings = (job.result as { warnings?: string[] }).warnings ?? []
    assert.equal((job.result as { targetDrift?: unknown }).targetDrift, undefined)
    assert.deepEqual(warnings.filter(w => w.includes('read-only')), ['Target \'datapool/rrdst/enc\' was not read-only (readonly=off); this run\'s receive set it read-only again. A replication task keeps its target read-only: to use this copy as a live dataset, remove the replication task into it.'])
    assert.equal(notifications().length, 1)
  })

  it('every receive, first or incremental, the root\'s and each child\'s, passes -o readonly=on (ruling 1)', async () => {
    targetReads()
    const res = await post()
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const full = mock.pipelineCalls.filter(p => !p.args1.includes('-i'))
    assert.ok(full.length > 0)
    for (const p of full)
      assert.deepEqual(p.args2.slice(0, 3), ['recv', '-o', 'readonly=on'])
    const incremental = mock.pipelineCalls.filter(p => p.args1.includes('-i'))
    assert.ok(incremental.length > 0)
    for (const p of incremental)
      assert.deepEqual(p.args2.slice(0, 4), ['recv', '-o', 'readonly=on', '--'])
  })
})
