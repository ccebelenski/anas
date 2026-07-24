import type { AhrExpansionIntent, Job } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { writeIntent } from '../../services/ahr-intent.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { ahrSnapshotRoutes } from '../ahr-snapshots.js'
import { jobRoutes } from '../jobs.js'

/**
 * AHR snapshot routes (story 11.12, AHR-DESIGN §12/§4). A minimal single-band
 * raid5×3 pool "tank", mounted subvol=@data (so subvolLayout is true), with two
 * snapshots (`nightly` read-only, `pre-rollback-…` writable).
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2
const X = 'ata-TANK_X'
const Y = 'ata-TANK_Y'
const Z = 'ata-TANK_Z'
const SIZE = 2 * GIB + 8 * MIB
const B1 = 2 * GIB - MIB
const LV_SIZE = 4 * GIB

const MDSTAT = `Personalities : [raid5]
md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

const SUBVOL_LIST_S = [
  'ID 258 gen 42 cgen 42 top level 5 otime 2026-07-23 14:23:01 path @snapshots/nightly',
  'ID 261 gen 57 cgen 57 top level 5 otime 2026-07-24 09:00:00 path @snapshots/pre-rollback-2026-07-24T090000Z',
  '',
].join('\n')
const SUBVOL_LIST_R = 'ID 258 gen 42 top level 5 path @snapshots/nightly\n'
// The PLAIN list is the membership source listAhrSnapshots reads (a writable
// pre-rollback preserve is invisible to `-s`): @data + @snapshots + both snaps.
const SUBVOL_LIST_ALL = [
  'ID 256 gen 9 top level 5 path @data',
  'ID 257 gen 9 top level 5 path @snapshots',
  'ID 258 gen 42 top level 257 path @snapshots/nightly',
  'ID 261 gen 57 top level 257 path @snapshots/pre-rollback-2026-07-24T090000Z',
  '',
].join('\n')

const BTRFS_USAGE = [
  'Overall:',
  `    Device size:\t\t${LV_SIZE}`,
  '    Used:\t\t1048576',
  `    Free (estimated):\t\t${LV_SIZE - 2 * MIB}\t(min: ${LV_SIZE - 4 * MIB})`,
  '',
].join('\n')

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

const CAP = {
  rawBytes: 0,
  usableBytes: 0,
  usedBytes: 0,
  freeBytes: 0,
  redundancyOverheadBytes: 0,
  unprotectedWastedBytes: 0,
  pendingBytes: 0,
}

function mkIntent(state: AhrExpansionIntent['state']): AhrExpansionIntent {
  return { id: randomUUID(), trigger: 'add-disk', approvedDisks: [X, Y, Z], before: CAP, after: CAP, state }
}

const DISKS = [
  { kernel: 'sdq', id: X, part: 'sdq1' },
  { kernel: 'sdr', id: Y, part: 'sdr1' },
  { kernel: 'sds', id: Z, part: 'sds1' },
]

function ahrLsblkJson(): string {
  const lvmNode = { name: 'tank-tank--vol', type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: '/mnt/anas-ahr/tank', partlabel: null }
  return JSON.stringify({ blockdevices: DISKS.map(d => ({
    name: d.kernel,
    type: 'disk',
    size: SIZE,
    fstype: null,
    mountpoint: null,
    partlabel: null,
    model: 'SYNTH',
    serial: d.id,
    children: [{
      name: d.part,
      type: 'part',
      size: B1,
      fstype: 'linux_raid_member',
      mountpoint: null,
      partlabel: 'tank-d1-b1',
      children: [{ name: 'md127', type: 'raid5', size: 4190208 * 1024, fstype: 'LVM2_member', mountpoint: null, partlabel: null, children: [lvmNode] }],
    }],
  })) })
}

/** subvolLayout is derived from the mount subvol= option (§12). */
function findmntJson(subvol: string): string {
  return JSON.stringify({ filesystems: [{
    target: '/mnt/anas-ahr/tank',
    source: '/dev/mapper/tank-tank--vol',
    fstype: 'btrfs',
    options: `rw,relatime,space_cache=v2,${subvol}`,
  }] })
}

function buildExecutor(opts: { subvol?: string } = {}): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: MDSTAT, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: 'MD_LEVEL=raid5\nMD_DEVICES=3\nMD_METADATA=1.2\nMD_UUID=aaaa:aaaa:aaaa:aaaa\nMD_DEVNAME=tank-r1\nMD_NAME=anas-test:tank-r1\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: { stdout: ahrLsblkJson(), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: `${DISKS.map(d => `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${d.id} -> ../../${d.kernel}`).join('\n')}\n`, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: { stdout: JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '1', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: { stdout: JSON.stringify({ report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: '-wi-ao----', lv_size: String(LV_SIZE) }] }] }), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: { stdout: findmntJson(opts.subvol ?? 'subvolid=256,subvol=/@data'), stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', '/mnt/anas-ahr/tank'], result: { stdout: BTRFS_USAGE, stderr: '', exitCode: 0 } })
  // Snapshot listing against the live @data mount: the plain list is the
  // membership source; `-s` supplies otime, `-r` the readonly set.
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['subvolume', 'list', '/mnt/anas-ahr/tank'], result: { stdout: SUBVOL_LIST_ALL, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['subvolume', 'list', '-s', '/mnt/anas-ahr/tank'], result: { stdout: SUBVOL_LIST_S, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['subvolume', 'list', '-r', '/mnt/anas-ahr/tank'], result: { stdout: SUBVOL_LIST_R, stderr: '', exitCode: 0 } })
  // Mutation plumbing — the on-demand top-level mount + btrfs + rename succeed.
  executor.addFixture({ command: '/usr/bin/btrfs', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/mount', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/umount', result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/mv', result: { stdout: '', stderr: '', exitCode: 0 } })
  return executor
}

async function waitForJob(jobQueue: JobQueue, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const job = jobQueue.get(id)
    if (job && (job.status === 'completed' || job.status === 'failed'))
      return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`job ${id} did not finish`)
}

describe('AHR snapshot routes (story 11.12)', () => {
  let dir: string
  let runtimeDir: string
  let executor: MockExecutor
  let jobQueue: JobQueue
  let server: ReturnType<typeof Fastify>

  async function build(opts: { subvol?: string } = {}) {
    executor = buildExecutor(opts)
    jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    await server.register(jobRoutes, { prefix: '/v1', jobQueue })
    await server.register(ahrSnapshotRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      intentDir: dir,
      subvolRuntimeDir: runtimeDir,
    })
  }

  /** Commands that would MUTATE data — a refusal must issue NONE. */
  function mutatingCalls(): { command: string, args: string[] }[] {
    return executor.calls.filter(c =>
      c.command === '/usr/bin/mv'
      || (c.command === '/usr/bin/btrfs' && ['snapshot', 'delete'].includes(c.args[1])))
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-snaproute-intent-'))
    runtimeDir = await mkdtemp(join(tmpdir(), 'anas-snaproute-run-'))
  })
  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    await rm(runtimeDir, { recursive: true, force: true })
  })

  it('GET lists snapshots, joining otime (-s) with the readonly set (-r)', async () => {
    await build()
    const res = await server.inject({ method: 'GET', url: '/v1/ahr/tank/snapshots', headers: IDENTITY })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().data, [
      { name: 'nightly', createdAt: '2026-07-23T14:23:01', readonly: true },
      { name: 'pre-rollback-2026-07-24T090000Z', createdAt: '2026-07-24T09:00:00', readonly: false },
    ])
  })

  it('GET 404 for an unknown pool', async () => {
    await build()
    const res = await server.inject({ method: 'GET', url: '/v1/ahr/nope/snapshots', headers: IDENTITY })
    assert.equal(res.statusCode, 404)
  })

  it('POST create with no name defaults to a UTC-timestamp name (202 job)', async () => {
    await build()
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(jobQueue, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.match((job.result as { snapshot: string }).snapshot, /^\d{4}-\d{2}-\d{2}T\d{6}Z$/)
  })

  it('POST create rejects a charset-invalid name (400)', async () => {
    await build()
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots', headers: JSON_HEADERS, payload: JSON.stringify({ name: '../evil' }) })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.equal(mutatingCalls().length, 0)
  })

  it('POST create 409 when the snapshot name already exists', async () => {
    await build()
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'nightly' }) })
    assert.equal(res.statusCode, 409)
    assert.ok(res.json().error.message.includes('already exists'))
  })

  it('DELETE 409-confirms then 202s; the confirm carries the concrete consequence', async () => {
    await build()
    const first = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/snapshots/nightly', headers: IDENTITY })
    assert.equal(first.statusCode, 409)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(first.json().error.warnings.some((w: string) => w.includes('untouched')))
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code)
    assert.equal(mutatingCalls().length, 0) // a 409 mutated nothing

    const second = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/snapshots/nightly', headers: { ...IDENTITY, 'x-anas-confirm': code } })
    assert.equal(second.statusCode, 202)
    const job = await waitForJob(jobQueue, second.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(job.result, { pool: 'tank', deleted: 'nightly' })
  })

  it('DELETE 404 for a snapshot that does not exist', async () => {
    await build()
    const res = await server.inject({ method: 'DELETE', url: '/v1/ahr/tank/snapshots/ghost', headers: IDENTITY })
    assert.equal(res.statusCode, 404)
  })

  it('rollback 409-confirms (stating unmount + auto-preserve), then 202s', async () => {
    await build()
    const first = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots/nightly/rollback', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(first.statusCode, 409)
    const warnings: string[] = first.json().error.warnings
    assert.ok(warnings.some(w => w.toUpperCase().includes('UNMOUNT')), 'states the unmount')
    assert.ok(warnings.some(w => w.includes('pre-rollback')), 'states the auto-preserve')
    assert.ok(warnings.some(w => w.toLowerCase().includes('nothing is destroyed')))
    const code = first.headers['x-anas-confirm-code'] as string

    const second = await server.inject({ method: 'POST', url: '/v1/ahr/tank/snapshots/nightly/rollback', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload: '{}' })
    assert.equal(second.statusCode, 202)
    const job = await waitForJob(jobQueue, second.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { rolledBackTo: string, preserved: string }
    assert.equal(result.rolledBackTo, 'nightly')
    assert.match(result.preserved, /^pre-rollback-/)
  })

  it('flat-layout pool: GET is empty and every mutation is refused (no migration)', async () => {
    await build({ subvol: 'subvolid=5,subvol=/' })
    const list = await server.inject({ method: 'GET', url: '/v1/ahr/tank/snapshots', headers: IDENTITY })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(list.json().data, [])

    for (const req of [
      { method: 'POST' as const, url: '/v1/ahr/tank/snapshots', payload: '{}' },
      { method: 'DELETE' as const, url: '/v1/ahr/tank/snapshots/nightly' },
      { method: 'POST' as const, url: '/v1/ahr/tank/snapshots/nightly/rollback', payload: '{}' },
    ]) {
      const res = await server.inject({ ...req, headers: req.payload ? JSON_HEADERS : IDENTITY })
      assert.equal(res.statusCode, 409, `${req.method} ${req.url}`)
      assert.ok(res.json().error.message.includes('flat layout'), req.url)
    }
    assert.equal(mutatingCalls().length, 0)
  })

  it('refuses every mutation while an expansion intent exists', async () => {
    await build()
    await writeIntent('tank', mkIntent('running'), { dir })
    for (const req of [
      { method: 'POST' as const, url: '/v1/ahr/tank/snapshots', payload: '{}' },
      { method: 'DELETE' as const, url: '/v1/ahr/tank/snapshots/nightly' },
      { method: 'POST' as const, url: '/v1/ahr/tank/snapshots/nightly/rollback', payload: '{}' },
    ]) {
      const res = await server.inject({ ...req, headers: req.payload ? JSON_HEADERS : IDENTITY })
      assert.equal(res.statusCode, 409, `${req.method} ${req.url}`)
      assert.ok(res.json().error.message.includes('expansion intent'), req.url)
    }
    assert.equal(mutatingCalls().length, 0)
  })
})
