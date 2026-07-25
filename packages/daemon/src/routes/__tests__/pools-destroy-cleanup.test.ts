import type { Job } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { jobRoutes } from '../jobs.js'
import { poolRoutes } from '../pools.js'

/**
 * Destroy-with-cleanup disk hygiene (story 3.14). Proves the production bug fix:
 * `wipefs -a` alone left ZFS's trailing labels AND only ever touched the
 * partition, so a "cleaned" disk still read as zfs_member and stayed
 * `partitioned`. The fix runs `zpool labelclear` (all four labels) + wipefs per
 * leaf, THEN an ownership-guarded `sgdisk --zap-all` on the whole disk — never
 * on shared physical media.
 */

const ZPOOL = '/usr/sbin/zpool'
const WIPEFS = '/usr/sbin/wipefs'
const SGDISK = '/usr/sbin/sgdisk'
const LSBLK = '/usr/bin/lsblk'
const BY_ID = '/dev/disk/by-id/'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const OK: ExecResult = { stdout: '', stderr: '', exitCode: 0 }

function listJson(pool: string): string {
  return JSON.stringify({ pools: { [pool]: { name: pool, state: 'ONLINE', properties: {} } } })
}

/** A pool status with one root whose children are the given leaf disk vdevs. */
function statusJson(pool: string, leaves: { name: string, path: string }[]): string {
  const vdevs: Record<string, unknown> = {}
  for (const leaf of leaves)
    vdevs[leaf.name] = { name: leaf.name, vdev_type: 'disk', state: 'ONLINE', path: leaf.path }
  return JSON.stringify({
    pools: {
      [pool]: {
        name: pool,
        state: 'ONLINE',
        pool_guid: '1',
        vdevs: { [pool]: { name: pool, vdev_type: 'root', state: 'ONLINE', vdevs } },
      },
    },
  })
}

interface OwnChild { name: string, fstype?: string | null, mountpoint?: string | null }
function ownLsblk(diskKernel: string, children: OwnChild[]): string {
  return JSON.stringify({
    blockdevices: [{
      name: diskKernel,
      type: 'disk',
      fstype: null,
      mountpoint: null,
      children: children.map(c => ({ name: c.name, type: 'part', fstype: c.fstype ?? null, mountpoint: c.mountpoint ?? null })),
    }],
  })
}

function byIdListing(lines: [byId: string, kernel: string][]): string {
  return `${lines.map(([id, k]) => `lrwxrwxrwx 1 root root 9 Jul 25 10:00 ${id} -> ../../${k}`).join('\n')}\n`
}

/** Base executor: existence + status + destroy + listing + best-effort success. */
function baseExecutor(pool: string, status: string, listing: string): MockExecutor {
  const ex = new MockExecutor()
  ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: listJson(pool), stderr: '', exitCode: 0 } })
  ex.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: { stdout: status, stderr: '', exitCode: 0 } })
  ex.addFixture({ command: ZPOOL, args: ['destroy', pool], result: OK })
  ex.addFixture({ command: '/usr/bin/ls', args: ['-la', BY_ID], result: { stdout: listing, stderr: '', exitCode: 0 } })
  // Best-effort mutation fallbacks — labelclear / wipefs / sgdisk succeed unless
  // an exact fixture overrides (MockExecutor: exact match wins).
  ex.addFixture({ command: ZPOOL, result: OK }) // labelclear
  ex.addFixture({ command: WIPEFS, result: OK })
  ex.addFixture({ command: SGDISK, result: OK })
  return ex
}

async function build(ex: MockExecutor): Promise<{ server: ReturnType<typeof Fastify>, jobQueue: JobQueue }> {
  const jobQueue = new JobQueue()
  const server = Fastify({ logger: false })
  await server.register(jobRoutes, { prefix: '/v1', jobQueue })
  await server.register(poolRoutes, { prefix: '/v1', executor: ex, jobQueue, confirmStore: new ConfirmStore() })
  return { server, jobQueue }
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

/** DELETE with the confirm two-step, resending with cleanup=true. */
async function destroyWithCleanup(server: ReturnType<typeof Fastify>, jobQueue: JobQueue, pool: string): Promise<Job> {
  const first = await server.inject({ method: 'DELETE', url: `/v1/pools/${pool}`, headers: IDENTITY_HEADERS })
  assert.equal(first.statusCode, 409)
  const code = first.headers['x-anas-confirm-code'] as string
  const res = await server.inject({
    method: 'DELETE',
    url: `/v1/pools/${pool}?cleanup=true`,
    headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
  })
  assert.equal(res.statusCode, 202)
  const jobId = (res.json() as { job: { id: string } }).job.id
  return waitForJob(jobQueue, jobId)
}

interface Result {
  destroyed: string
  wiped?: string[]
  wipedFailed?: string[]
  zapped?: string[]
  preserved?: { disk: string, reason: string }[]
}

describe('destroy cleanup: labelclear + ownership-guarded GPT zap (story 3.14)', () => {
  let server: ReturnType<typeof Fastify> | undefined
  let jobQueue: JobQueue
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function run(ex: MockExecutor, pool: string): Promise<Job> {
    const built = await build(ex)
    server = built.server
    jobQueue = built.jobQueue
    return destroyWithCleanup(server, jobQueue, pool)
  }

  it('(a) exclusive single-disk pool: labelclear + wipefs leaf, THEN sgdisk zap + wipefs whole disk (correct argv order)', async () => {
    const status = statusJson('exclpool', [{ name: 'ata-EXCL-part1', path: `${BY_ID}ata-EXCL-part1` }])
    const listing = byIdListing([['ata-EXCL', 'sdx'], ['ata-EXCL-part1', 'sdx1'], ['ata-EXCL-part9', 'sdx9']])
    const ex = baseExecutor('exclpool', status, listing)
    // Post-wipe: part1 blank (ours), part9 ZFS-reserved blank — neither foreign.
    ex.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT', `${BY_ID}ata-EXCL`], result: {
      stdout: ownLsblk('sdx', [{ name: 'sdx1' }, { name: 'sdx9' }]),
      stderr: '',
      exitCode: 0,
    } })
    const job = await run(ex, 'exclpool')

    assert.equal(job.status, 'completed')
    const r = job.result as Result
    assert.deepEqual(r.wiped, ['ata-EXCL-part1'])
    assert.deepEqual(r.zapped, ['ata-EXCL'])
    assert.equal(r.preserved, undefined)

    // Exact argv issued.
    const idx = (pred: (c: { command: string, args: string[] }) => boolean) => ex.calls.findIndex(pred)
    const lc = idx(c => c.command === ZPOOL && c.args[0] === 'labelclear')
    const leafWipe = idx(c => c.command === WIPEFS && c.args.includes('--force') && c.args.at(-1) === `${BY_ID}ata-EXCL-part1`)
    const zap = idx(c => c.command === SGDISK && c.args[0] === '--zap-all')
    const diskWipe = idx(c => c.command === WIPEFS && !c.args.includes('--force') && c.args.at(-1) === `${BY_ID}ata-EXCL`)
    assert.ok(lc >= 0 && leafWipe >= 0 && zap >= 0 && diskWipe >= 0, 'all four steps ran')
    assert.deepEqual(ex.calls[lc].args, ['labelclear', '-f', `${BY_ID}ata-EXCL-part1`])
    assert.deepEqual(ex.calls[zap].args, ['--zap-all', `${BY_ID}ata-EXCL`])
    // labelclear BEFORE zap; leaf cleared before whole-disk touched.
    assert.ok(lc < zap, 'labelclear precedes sgdisk zap')
    assert.ok(leafWipe < zap, 'leaf wipe precedes zap')
  })

  for (const [label, foreign] of [
    ['mounted ext4', { name: 'sdy2', fstype: 'ext4', mountpoint: '/mnt/other' }],
    ['another imported zpool', { name: 'sdy2', fstype: 'zfs_member', mountpoint: null }],
    ['an LVM PV', { name: 'sdy2', fstype: 'LVM2_member', mountpoint: null }],
    ['an md member', { name: 'sdy2', fstype: 'linux_raid_member', mountpoint: null }],
  ] as const) {
    it(`(b) SHARED disk (${label}): leaf cleared but GPT NOT zapped, foreign partition untouched`, async () => {
      const status = statusJson('sharedpool', [{ name: 'ata-SHARED-part1', path: `${BY_ID}ata-SHARED-part1` }])
      const listing = byIdListing([['ata-SHARED', 'sdy'], ['ata-SHARED-part1', 'sdy1'], ['ata-SHARED-part2', 'sdy2']])
      const ex = baseExecutor('sharedpool', status, listing)
      ex.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT', `${BY_ID}ata-SHARED`], result: {
        stdout: ownLsblk('sdy', [{ name: 'sdy1' }, foreign]),
        stderr: '',
        exitCode: 0,
      } })
      const job = await run(ex, 'sharedpool')

      assert.equal(job.status, 'completed')
      const r = job.result as Result
      assert.deepEqual(r.wiped, ['ata-SHARED-part1'], 'leaf was labelcleared + wiped')
      assert.equal(r.zapped, undefined, 'no disk zapped')
      assert.deepEqual(r.preserved, [{ disk: 'ata-SHARED', reason: 'shared' }])

      // The whole disk / foreign partition were NEVER touched by a destructive op.
      const zap = ex.calls.find(c => c.command === SGDISK)
      assert.equal(zap, undefined, 'sgdisk was never called on a shared disk')
      const diskWipe = ex.calls.find(c => c.command === WIPEFS && c.args.at(-1) === `${BY_ID}ata-SHARED`)
      assert.equal(diskWipe, undefined, 'whole-disk wipefs never ran')
      const foreignTouch = ex.calls.find(c => c.args.some(a => a.includes('sdy2') || a.includes('ata-SHARED-part2')))
      assert.equal(foreignTouch, undefined, 'the foreign partition was never touched')
      // But the leaf WAS cleared.
      assert.ok(ex.calls.some(c => c.command === ZPOOL && c.args[0] === 'labelclear' && c.args[2] === `${BY_ID}ata-SHARED-part1`))
    })
  }

  it('(c) ownership probe error → conservative no-zap (preserved: uncertain)', async () => {
    const status = statusJson('probefail', [{ name: 'ata-PF-part1', path: `${BY_ID}ata-PF-part1` }])
    const listing = byIdListing([['ata-PF', 'sdz'], ['ata-PF-part1', 'sdz1']])
    const ex = baseExecutor('probefail', status, listing)
    ex.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT', `${BY_ID}ata-PF`], result: {
      stdout: '',
      stderr: 'lsblk: probe failed',
      exitCode: 1,
    } })
    const job = await run(ex, 'probefail')

    assert.equal(job.status, 'completed')
    const r = job.result as Result
    assert.deepEqual(r.wiped, ['ata-PF-part1'])
    assert.deepEqual(r.preserved, [{ disk: 'ata-PF', reason: 'uncertain' }])
    assert.equal(r.zapped, undefined)
    assert.equal(ex.calls.find(c => c.command === SGDISK), undefined, 'no zap when ownership uncertain')
  })

  it('(d) labelclear non-zero exit → reported in wipedFailed, job does NOT throw', async () => {
    const status = statusJson('lcfail', [{ name: 'ata-LC-part1', path: `${BY_ID}ata-LC-part1` }])
    const listing = byIdListing([['ata-LC', 'sdw'], ['ata-LC-part1', 'sdw1']])
    const ex = baseExecutor('lcfail', status, listing)
    // labelclear fails on this exact leaf.
    ex.addFixture({ command: ZPOOL, args: ['labelclear', '-f', `${BY_ID}ata-LC-part1`], result: { stdout: '', stderr: 'failed to clear label', exitCode: 1 } })
    ex.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT', `${BY_ID}ata-LC`], result: {
      stdout: ownLsblk('sdw', [{ name: 'sdw1' }]),
      stderr: '',
      exitCode: 0,
    } })
    const job = await run(ex, 'lcfail')

    assert.equal(job.status, 'completed', 'a wipe failure must not fail the job')
    assert.equal(job.error, null)
    const r = job.result as Result
    assert.deepEqual(r.wipedFailed, ['ata-LC-part1'])
    assert.equal(r.wiped, undefined)
    // The disk was still exclusively ours → GPT zapped regardless of the leaf failure.
    assert.deepEqual(r.zapped, ['ata-LC'])
  })

  it('(e) nvme-shaped leaf: whole disk derived without a p-concat leak', async () => {
    const status = statusJson('nvmepool', [{ name: 'nvme-SSD-part1', path: `${BY_ID}nvme-SSD-part1` }])
    const listing = byIdListing([['nvme-SSD', 'nvme0n1'], ['nvme-SSD-part1', 'nvme0n1p1']])
    const ex = baseExecutor('nvmepool', status, listing)
    ex.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT', `${BY_ID}nvme-SSD`], result: {
      stdout: ownLsblk('nvme0n1', [{ name: 'nvme0n1p1' }]),
      stderr: '',
      exitCode: 0,
    } })
    const job = await run(ex, 'nvmepool')

    assert.equal(job.status, 'completed')
    const r = job.result as Result
    assert.deepEqual(r.wiped, ['nvme-SSD-part1'])
    assert.deepEqual(r.zapped, ['nvme-SSD'])
    const zap = ex.calls.find(c => c.command === SGDISK && c.args[0] === '--zap-all')
    assert.ok(zap)
    assert.equal(zap!.args[1], `${BY_ID}nvme-SSD`, 'whole disk is the by-id sans -part1, never nvme-SSDp1')
    assert.equal(ex.calls.find(c => c.args.some(a => a.includes('SSDp'))), undefined, 'no p-concat leak anywhere')
  })

  it('(f) multi-leaf single pool on one disk (part1 + part9) → ONE zap, not two', async () => {
    const status = statusJson('multipool', [
      { name: 'ata-MULTI-part1', path: `${BY_ID}ata-MULTI-part1` },
      { name: 'ata-MULTI-part9', path: `${BY_ID}ata-MULTI-part9` },
    ])
    const listing = byIdListing([['ata-MULTI', 'sdm'], ['ata-MULTI-part1', 'sdm1'], ['ata-MULTI-part9', 'sdm9']])
    const ex = baseExecutor('multipool', status, listing)
    ex.addFixture({ command: LSBLK, args: ['-Jb', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT', `${BY_ID}ata-MULTI`], result: {
      stdout: ownLsblk('sdm', [{ name: 'sdm1' }, { name: 'sdm9' }]),
      stderr: '',
      exitCode: 0,
    } })
    const job = await run(ex, 'multipool')

    assert.equal(job.status, 'completed')
    const r = job.result as Result
    assert.deepEqual(r.wiped, ['ata-MULTI-part1', 'ata-MULTI-part9'], 'both leaves labelcleared')
    assert.deepEqual(r.zapped, ['ata-MULTI'])
    const zaps = ex.calls.filter(c => c.command === SGDISK && c.args[0] === '--zap-all')
    assert.equal(zaps.length, 1, 'the shared whole disk is zapped exactly once')
    const labelclears = ex.calls.filter(c => c.command === ZPOOL && c.args[0] === 'labelclear')
    assert.equal(labelclears.length, 2, 'labelclear ran per leaf')
  })
})
