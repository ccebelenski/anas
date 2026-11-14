import type { Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { SnapshotSchedule } from '@anas/shared'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { createServer } from '../../server.js'
import { renderServiceUnit, renderTimerUnit } from '../../services/snapshot-schedule-units.js'
import { parseZfsStampSources, parseZfsTreeSnapshots, planZfsSchedulePrune, PVE_OWNED_LEFT } from '../../services/snapshot-schedules.js'

/**
 * cr3 DATASETS-SCHEDULES-H2 (a new schedule with a deleted schedule's id
 * adopts its stamped snapshots: the create is confirm-gated, binding the id
 * and the adopted set) and DATASETS-SCHEDULES-L3 (the prune never destroys on
 * a PVE-owned dataset, excluded or not; it notes what it left).
 */

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
}
const json = (extra: Record<string, string> = {}) => ({ ...IDENTITY, 'x-anas-request-id': randomUUID(), 'content-type': 'application/json', ...extra })

const STAMP_ARGS = (dataset: string) => ['get', '-Hp', '-t', 'snapshot', '-r', '-o', 'name,value,source', 'anas:schedule', '--', dataset]
const TREE_ARGS = ['list', '-H', '-o', 'name', '-r', '-t', 'filesystem,volume', '--', 'testpool/x']
const D1 = 'anas-daily-2026-10-01T000000Z'
const D2 = 'anas-daily-2026-10-02T000000Z'

const NIGHTLY = {
  id: 'nightly',
  name: 'Nightly',
  target: { kind: 'zfs' as const, dataset: 'testpool/x' },
  cadence: 'daily' as const,
  retention: { daily: 7 },
  recursive: true,
  exclude: ['testpool/x/media'],
  enabled: true,
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

describe('cr3 datasets: schedule create over stamped snapshots (H2) and PVE-owned prune (L3)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  const saved = { systemd: process.env.ANAS_SYSTEMD_DIR, storage: process.env.ANAS_STORAGE_CFG }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-sched-'))
    process.env.ANAS_SYSTEMD_DIR = dir
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: JSON.stringify({ pools: { testpool: { name: 'testpool', state: 'ONLINE', properties: {} } } }), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'testpool\t-\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: TREE_ARGS, result: { stdout: 'testpool/x\ntestpool/x/data\ntestpool/x/media\n', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [key, value] of [['ANAS_SYSTEMD_DIR', saved.systemd], ['ANAS_STORAGE_CFG', saved.storage]] as const) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
  })

  /** Snapshots a deleted `nightly` left: two on the target, two on the (to be excluded) media child, one received copy. */
  function armLeftovers(): void {
    mockOf(server).addFixture({
      command: ZFS,
      args: STAMP_ARGS('testpool/x'),
      result: {
        stdout: [
          `testpool/x@${D1}\tnightly\tlocal`,
          `testpool/x@${D2}\tnightly\tlocal`,
          `testpool/x/media@${D1}\tnightly\tlocal`,
          `testpool/x/media@${D2}\tnightly\tlocal`,
          `testpool/x/data@${D1}\tnightly\treceived`,
          `testpool/x/data@${D2}\tother\tlocal`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    })
  }

  const create = (payload: unknown, extra: Record<string, string> = {}) =>
    server.inject({ method: 'POST', url: '/v1/schedules', headers: json(extra), payload: JSON.stringify(payload) })

  it('a create whose id is already stamped on snapshots under the target is a confirm-gated 409 naming the counts; nothing is written', async () => {
    armLeftovers()
    const res = await create(NIGHTLY)
    assert.equal(res.statusCode, 409, res.body)
    const error = res.json().error
    assert.equal(error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'])
    const warnings = error.warnings as string[]
    // Only LOCAL stamps of this id count: the received copy and another id's do not.
    assert.match(warnings[0], /^4 snapshot\(s\) on 2 dataset\(s\) under 'testpool\/x' already carry the schedule id 'nightly'/)
    assert.match(warnings[0], /testpool\/x \(2\), testpool\/x\/media \(2\)/)
    assert.match(warnings[1], /on a dataset it excludes it destroys all of them/)
    assert.deepEqual(await readdir(dir), [], 'no unit written before the confirm')
  })

  it('the confirmed resend creates the schedule', async () => {
    armLeftovers()
    const first = await create(NIGHTLY)
    const code = first.headers['x-anas-confirm-code'] as string
    const res = await create(NIGHTLY, { 'x-anas-confirm': code })
    assert.equal(res.statusCode, 202, res.body)
    const done = await waitForJob(server, res.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.ok((await readdir(dir)).includes('anas-snap-nightly.service'))
  })

  it('the confirm binds the adopted set: a different set at the resend re-challenges', async () => {
    armLeftovers()
    const first = await create(NIGHTLY)
    const code = first.headers['x-anas-confirm-code'] as string
    // One more stamped snapshot appeared between the challenge and the resend.
    mockOf(server).prependFixture({
      command: ZFS,
      args: STAMP_ARGS('testpool/x'),
      result: { stdout: `testpool/x@${D1}\tnightly\tlocal\ntestpool/x@${D2}\tnightly\tlocal\ntestpool/x/media@${D1}\tnightly\tlocal\ntestpool/x/media@${D2}\tnightly\tlocal\ntestpool/x/data@${D1}\tnightly\tlocal\n`, stderr: '', exitCode: 0 },
    })
    const res = await create(NIGHTLY, { 'x-anas-confirm': code })
    assert.equal(res.statusCode, 409, res.body)
    assert.match(JSON.stringify(res.json().error), /5 snapshot\(s\) on 3 dataset\(s\)/)
    assert.deepEqual(await readdir(dir), [])
  })

  it('a stamp read that fails refuses the create (never "nothing stamped")', async () => {
    mockOf(server).addFixture({ command: ZFS, args: STAMP_ARGS('testpool/x'), result: { stdout: '', stderr: 'I/O error', exitCode: 1 } })
    const res = await create(NIGHTLY)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.reason, 'schedule-stamps-unreadable')
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    assert.deepEqual(await readdir(dir), [])
  })

  it('a create with no stamped snapshot under its target needs no confirm', async () => {
    const res = await create(NIGHTLY)
    assert.equal(res.statusCode, 202, res.body)
  })

  it('L3: the prune leaves this schedule\'s stamped snapshots on an excluded PVE-owned dataset, with a note and a warning outcome', async () => {
    const cfg = join(dir, 'storage.cfg')
    await writeFile(cfg, 'zfspool: local-zfs\n\tpool testpool/x/media\n\tcontent images,rootdir\n\n', 'utf8')
    process.env.ANAS_STORAGE_CFG = cfg
    const created = await create(NIGHTLY)
    assert.equal(created.statusCode, 202, created.body)
    await waitForJob(server, created.json().job.id)
    // The schedule's own snapshots, taken before media was excluded and claimed by PVE.
    const rows = [`testpool/x/media@${D1}\t1790000000\t0\t100\tnightly`, `testpool/x/media@${D2}\t1790086400\t0\t200\tnightly`]
    const mock = mockOf(server)
    mock.addFixture({ command: ZFS, args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name,creation,userrefs,createtxg,anas:schedule', '-r', '--', 'testpool/x'], result: { stdout: `${rows.join('\n')}\n`, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: STAMP_ARGS('testpool/x'), result: { stdout: rows.map(r => `${r.split('\t')[0]}\tnightly\tlocal`).join('\n'), stderr: '', exitCode: 0 } })
    const run = await server.inject({ method: 'POST', url: '/v1/schedules/nightly/run', headers: json(), payload: '{}' })
    const done = await waitForJob(server, run.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const result = done.result as { datasets: { dataset: string, scope: string, pruned: number, note?: string }[] }
    const media = result.datasets.find(d => d.dataset === 'testpool/x/media')
    assert.equal(media?.scope, 'excluded')
    assert.equal(media?.pruned, 0)
    assert.match(media?.note ?? '', new RegExp(`^2 left: ${PVE_OWNED_LEFT} \\(`))
    assert.equal(mock.calls.some(c => c.command === ZFS && c.args[0] === 'destroy' && c.args.some(a => a.startsWith('testpool/x/media@'))), false)
  })
})

describe('cr3 review fold: create order, and an edit that newly excludes stamped snapshots', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  const saved = { systemd: process.env.ANAS_SYSTEMD_DIR, storage: process.env.ANAS_STORAGE_CFG }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-put-'))
    process.env.ANAS_SYSTEMD_DIR = dir
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: JSON.stringify({ pools: { testpool: { name: 'testpool', state: 'ONLINE', properties: {} } } }), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'testpool\t-\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: TREE_ARGS, result: { stdout: 'testpool/x\ntestpool/x/data\ntestpool/x/media\n', stderr: '', exitCode: 0 } })
    const created = await server.inject({ method: 'POST', url: '/v1/schedules', headers: json(), payload: JSON.stringify(NIGHTLY) })
    assert.equal(created.statusCode, 202, created.body)
    await waitForJob(server, created.json().job.id)
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [key, value] of [['ANAS_SYSTEMD_DIR', saved.systemd], ['ANAS_STORAGE_CFG', saved.storage]] as const) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
  })

  const put = (payload: unknown, extra: Record<string, string> = {}) =>
    server.inject({ method: 'PUT', url: '/v1/schedules/nightly', headers: json(extra), payload: JSON.stringify(payload) })
  const stampReads = () => mockOf(server).calls.filter(c => c.command === ZFS && c.args.join(' ') === STAMP_ARGS('testpool/x').join(' ')).length

  /** The schedule's own snapshots: on the target, on data (about to be excluded), on media (already excluded); one received. */
  function armStamps(): void {
    mockOf(server).prependFixture({
      command: ZFS,
      args: STAMP_ARGS('testpool/x'),
      result: {
        stdout: [
          `testpool/x@${D1}\tnightly\tlocal`,
          `testpool/x/data@${D1}\tnightly\tlocal`,
          `testpool/x/data@${D2}\tnightly\tlocal`,
          `testpool/x/data@anas-daily-2026-10-03T000000Z\tnightly\treceived`,
          `testpool/x/media@${D1}\tnightly\tlocal`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      },
    })
  }

  it('create: an existing id answers 409 "already exists" even with a bad target (the order before H2)', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/schedules', headers: json(), payload: JSON.stringify({ ...NIGHTLY, recursive: false, exclude: undefined, target: { kind: 'zfs', dataset: 'nopool/x' } }) })
    assert.equal(res.statusCode, 409, res.body)
    assert.match(res.json().error.message, /already exists/)
  })

  it('an edit that newly excludes a dataset holding this schedule\'s snapshots is confirm-gated, naming the count per dataset', async () => {
    armStamps()
    const body = { ...NIGHTLY, exclude: ['testpool/x/media', 'testpool/x/data'] }
    const res = await put(body)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    const warnings = res.json().error.warnings as string[]
    // data's two LOCAL stamps only: not the received copy, not media (already excluded), not the target.
    assert.match(warnings[0], /^2 snapshot\(s\) this schedule took on 1 dataset\(s\) it will now exclude will be destroyed at its next run: testpool\/x\/data \(2\)/)
    const unit = await readFile(join(dir, 'anas-snap-nightly.service'), 'utf-8')
    assert.ok(!unit.includes('testpool/x/data"]'), 'nothing written before the confirm')
    const ok = await put(body, { 'x-anas-confirm': res.headers['x-anas-confirm-code'] as string })
    assert.equal(ok.statusCode, 202, ok.body)
    const done = await waitForJob(server, ok.json().job.id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.match(await readFile(join(dir, 'anas-snap-nightly.service'), 'utf-8'), /"exclude":\["testpool\/x\/media","testpool\/x\/data"\]/)
  })

  it('the confirm binds the set: one more stamped snapshot there at the resend re-challenges', async () => {
    armStamps()
    const body = { ...NIGHTLY, exclude: ['testpool/x/media', 'testpool/x/data'] }
    const first = await put(body)
    mockOf(server).prependFixture({ command: ZFS, args: STAMP_ARGS('testpool/x'), result: { stdout: `testpool/x/data@${D1}\tnightly\tlocal\ntestpool/x/data@${D2}\tnightly\tlocal\ntestpool/x/data@anas-daily-2026-10-04T000000Z\tnightly\tlocal\n`, stderr: '', exitCode: 0 } })
    const res = await put(body, { 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string })
    assert.equal(res.statusCode, 409, res.body)
    assert.match(JSON.stringify(res.json().error), /3 snapshot\(s\)/)
  })

  it('an edit that newly excludes a dataset with none of this schedule\'s snapshots is not gated', async () => {
    // Only the target carries this schedule's snapshots: excluding data destroys nothing.
    mockOf(server).prependFixture({ command: ZFS, args: STAMP_ARGS('testpool/x'), result: { stdout: `testpool/x@${D1}\tnightly\tlocal\n`, stderr: '', exitCode: 0 } })
    const res2 = await put({ ...NIGHTLY, exclude: ['testpool/x/media', 'testpool/x/data'] })
    assert.equal(res2.statusCode, 202, res2.body)
  })

  it('an edit that excludes nothing new reads no stamps and is not gated', async () => {
    armStamps()
    const before = stampReads()
    const res = await put({ ...NIGHTLY, retention: { daily: 3 } })
    assert.equal(res.statusCode, 202, res.body)
    assert.equal(stampReads(), before)
  })

  it('turning recursion ON with no exclude list excludes nothing: no stamp read, no gate (second review (4))', async () => {
    const flat = await put({ ...NIGHTLY, recursive: false, exclude: undefined })
    assert.equal(flat.statusCode, 202, flat.body)
    await waitForJob(server, flat.json().job.id)
    mockOf(server).prependFixture({ command: ZFS, args: STAMP_ARGS('testpool/x'), result: { stdout: '', stderr: 'I/O error', exitCode: 1 } })
    const before = stampReads()
    const res = await put({ ...NIGHTLY, recursive: true, exclude: [] })
    assert.equal(res.statusCode, 202, res.body)
    assert.equal(stampReads(), before)
  })

  it('a stamp read that fails refuses an edit that newly excludes (never "nothing to destroy")', async () => {
    mockOf(server).prependFixture({ command: ZFS, args: STAMP_ARGS('testpool/x'), result: { stdout: '', stderr: 'I/O error', exitCode: 1 } })
    const res = await put({ ...NIGHTLY, exclude: ['testpool/x/media', 'testpool/x/data'] })
    assert.equal(res.statusCode, 409, res.body)
    assert.notEqual(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.match(res.json().error.message, /Could not read the snapshots this edit/)
  })
})

describe('cr3 second review (5): a fire refused at the route because a read failed still notifies', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  const saved = { systemd: process.env.ANAS_SYSTEMD_DIR }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-ahrfire-'))
    process.env.ANAS_SYSTEMD_DIR = dir
    server = createServer({ mock: true, logger: false })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    if (saved.systemd === undefined)
      delete process.env.ANAS_SYSTEMD_DIR
    else
      process.env.ANAS_SYSTEMD_DIR = saved.systemd
  })

  it('an AHR schedule whose topology cannot be read: 503, and the schedule\'s failure notification is sent', async () => {
    const schedule = SnapshotSchedule.parse({ id: 'ahr-nightly', name: 'AHR nightly', target: { kind: 'ahr', pool: 'ahr0' }, cadence: 'daily', retention: { daily: 7 }, enabled: true })
    await writeFile(join(dir, 'anas-snap-ahr-nightly.service'), renderServiceUnit(schedule))
    await writeFile(join(dir, 'anas-snap-ahr-nightly.timer'), renderTimerUnit(schedule))
    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: '', stderr: 'cat: /proc/mdstat: Input/output error', exitCode: 1 } })
    const run = await server.inject({ method: 'POST', url: '/v1/schedules/ahr-nightly/run', headers: json(), payload: '{}' })
    assert.equal(run.statusCode, 503, run.body)
    const sent = mock.calls.filter(c => c.command === '/usr/bin/perl')
    assert.equal(sent.length, 1, 'one failure notification')
    assert.equal(sent[0].args[2], 'error')
    assert.match(sent[0].args[3], /snapshot schedule 'AHR nightly' FAILED/)
  })
})

describe('cr3 L3: planZfsSchedulePrune never plans a destroy on a PVE-owned dataset', () => {
  it('excluded and swept datasets PVE owns are left with the note; the rest of the plan is unchanged', () => {
    const lines: string[] = []
    const stamps: string[] = []
    for (const ds of ['tank', 'tank/photos', 'tank/vm']) {
      for (let d = 1; d <= 10; d++) {
        const full = `${ds}@anas-daily-2026-10-${String(d).padStart(2, '0')}T000000Z`
        lines.push(`${full}\t${1790000000 + d * 86400}\t0\t${1000 + d}\tnightly`)
        stamps.push(`${full}\tnightly\tlocal`)
      }
    }
    const schedule = SnapshotSchedule.parse({ ...NIGHTLY, target: { kind: 'zfs', dataset: 'tank' }, exclude: ['tank/photos'] })
    const plans = planZfsSchedulePrune({
      schedule,
      inventory: parseZfsTreeSnapshots(lines.join('\n'), parseZfsStampSources(stamps.join('\n'))),
      others: { schedules: [schedule], complete: true, unparseable: [] },
      now: new Date('2026-11-14T00:00:05Z'),
      pveOwned: ds => (ds === 'tank/photos' || ds === 'tank/vm' ? `storage 'local-zfs'` : null),
    })
    const by = new Map(plans.map(p => [p.dataset, p]))
    assert.equal(by.get('tank')!.prune.length, 3, 'the target keeps its 7 dailies')
    for (const ds of ['tank/photos', 'tank/vm']) {
      assert.equal(by.get(ds)!.prune.length, 0, ds)
      assert.equal(by.get(ds)!.note, `10 left: ${PVE_OWNED_LEFT} (storage 'local-zfs')`)
    }
  })
})
