import type { Job } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { dmsetupStatusArgs } from '../../parsers/dmsetup.js'
import { optionsReadOnly } from '../../parsers/findmnt.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { LVS_ARGS, PVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { cacheRecoveryNotification, poolOfCacheLabel } from '../../services/ahr-cache-state.js'
import { AHR_CACHE_LSBLK_ARGS } from '../../services/ahr-cache.js'
import { writeIntent } from '../../services/ahr-intent.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrCacheRoutes } from '../ahr-cache.js'
import { jobRoutes } from '../jobs.js'

/**
 * The udev auto-uncache rung — `POST /v1/ahr/:name/cache/event` (story
 * ahrcache.1 slice 2, AHR-DESIGN §13 "Resolved 2026-09-24").
 *
 * The endpoint the shipped udev rule's hook calls when a disk carrying a
 * `<pool>-cache<n>` slice is removed. It exists because dm-cache does NOT fall
 * through to the origin (GT-19): the instant the cache device goes, every read
 * on the pool returns EIO within the second, promoted or not. `lvconvert
 * --uncache` is the whole repair, it works with the device absent and the pool
 * mounted, and it takes under a third of a second (GT-20) — so it runs
 * unattended, through an event rather than a poller.
 *
 * Four worlds over a synthetic one-band pool `tank` (md127 across X and Y):
 *   'failed'    a dead cache device: dm says `cache Fail`, `pvs` shows the
 *               band's md PV plus one `[unknown]` → the recovery runs
 *   'absent'    no cache target at all → a no-op 200, whatever the body says
 *   'bandsdown' a dead cache AND an unassembled band: `pvs` shows TWO
 *               `[unknown]` rows → `vgreduce --removemissing` is REFUSED
 *   'readonly'  'failed', plus btrfs already forced read-only by a write that
 *               met the dead cache → the notification says writes are stopped
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2

const X = 'ata-TANK_X' // band member → sdq
const Y = 'ata-TANK_Y' // band member → sdr

const DISK_SIZE = 2 * GIB + 8 * MIB
const BAND_SIZE = 2 * GIB - MIB
const LV_SIZE = 2143289344
const CACHE_PV_SIZE = 4 * GIB - 3 * MIB

const MOUNTPOINT = '/mnt/anas-ahr/tank'
const DM_NAME = 'tank-tank--vol'

const MDSTAT = `Personalities : [raid1]
md127 : active raid1 sdr1[1] sdq1[0]
      2096128 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`
const MD_EXPORT = `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_METADATA=1.2\nMD_UUID=aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa\nMD_DEVNAME=tank-r1\nMD_NAME=anas-test:tank-r1\n`

const IDENTITY_HEADERS = {
  'x-anas-user': 'system:udev-cache-event',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

/**
 * The mount options btrfs leaves behind after an I/O error aborts a metadata
 * transaction, copied from the shape `/proc/mounts` prints (field 4 of the
 * line, which is the same comma list `findmnt --json` returns as `options`):
 *
 *   /dev/mapper/tank-tank--vol /mnt/anas-ahr/tank btrfs \
 *     ro,relatime,space_cache=v2,subvolid=256,subvol=/@data 0 0
 *
 * `ro` leads the list, which is exactly why the test is on the PARSE and not on
 * a substring: `space_cache` contains no `ro`, but `errors=remount-ro` would,
 * and a naive `.includes('ro')` reads a read-WRITE mount as read-only.
 */
const RO_OPTIONS = 'ro,relatime,space_cache=v2,subvolid=256,subvol=/@data'
const RW_OPTIONS = 'rw,relatime,space_cache=v2,subvolid=256,subvol=/@data'

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

type World = 'failed' | 'absent' | 'bandsdown' | 'readonly'

/** A dead cache device is GONE — the LV is a cache target, dm says so. */
function cacheTarget(world: World): boolean {
  return world !== 'absent'
}

/** The pool LV's dm status, verbatim in shape from the live captures. */
const DM_STATUS: Record<World, string> = {
  absent: '0 4186624 linear \n',
  // Pulling the cache device under a pure READ load gives `Fail`; `Error` comes
  // from the generic target-error path after a write aborted the metadata
  // transaction. Both are failure words; the parser's test is structural.
  failed: '0 4186624 cache Fail\n',
  bandsdown: '0 4186624 cache Fail\n',
  readonly: '0 4186624 cache Error\n',
}

function ahrLsblkJson(): string {
  const lvmNode = { name: DM_NAME, type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: MOUNTPOINT, partlabel: null }
  const member = (kernel: string, id: string, n: number) => ({
    name: kernel,
    type: 'disk',
    size: DISK_SIZE,
    fstype: null,
    mountpoint: null,
    partlabel: null,
    model: 'SYNTH DISK',
    serial: id,
    children: [{
      name: `${kernel}1`,
      type: 'part',
      size: BAND_SIZE,
      fstype: 'linux_raid_member',
      mountpoint: null,
      partlabel: `tank-d${n}-b1`,
      children: [{ name: 'md127', type: 'raid1', size: 2096128 * 1024, fstype: 'LVM2_member', mountpoint: null, partlabel: null, children: [lvmNode] }],
    }],
  })
  // The cache disk is simply not in the tree — it was removed, which is the
  // whole event. Its `tank-cache1` slice went with it.
  return JSON.stringify({ blockdevices: [member('sdq', X, 1), member('sdr', Y, 2)] })
}

function inventoryLsblkJson(): string {
  const flat = (kernel: string, id: string) => ({
    'name': kernel,
    'type': 'disk',
    'size': DISK_SIZE,
    'model': 'SYNTH DISK',
    'serial': id,
    'tran': 'sata',
    'fstype': null,
    'mountpoint': null,
    'rota': true,
    'phy-sec': 512,
    'log-sec': 512,
    'children': [{ name: `${kernel}1`, type: 'part', size: BAND_SIZE, fstype: 'linux_raid_member', mountpoint: null }],
  })
  return JSON.stringify({ blockdevices: [flat('sdq', X), flat('sdr', Y)] })
}

function pvsJson(world: World): string {
  const rows: Record<string, string>[] = []
  // GT-19's exact trap: a STOPPED band array reads `[unknown]` in `pvs`
  // exactly as a dead cache device does. In 'bandsdown' the band's own named
  // md PV is missing, so `--removemissing` would drop the band's PV with the
  // cache's — and the guard must refuse.
  if (world !== 'bandsdown')
    rows.push({ pv_name: '/dev/md127', vg_name: 'tank', pv_size: String(LV_SIZE), pv_free: '0', dev_size: String(LV_SIZE + 2 * MIB) })
  else
    rows.push({ pv_name: '[unknown]', vg_name: 'tank', pv_size: String(LV_SIZE), pv_free: '0', dev_size: '0' })
  if (cacheTarget(world))
    rows.push({ pv_name: '[unknown]', vg_name: 'tank', pv_size: String(CACHE_PV_SIZE), pv_free: '0', dev_size: '0' })
  return JSON.stringify({ report: [{ pv: rows }] })
}

function lvsJson(world: World): string {
  const cached = cacheTarget(world)
  return JSON.stringify({
    report: [{
      lv: [{
        lv_name: 'tank-vol',
        vg_name: 'tank',
        // `p` in the last attribute field = partial: a PV of this LV is missing.
        lv_attr: cached ? 'Cwi-aoC-p-' : '-wi-ao----',
        lv_size: String(LV_SIZE),
        ...(cached
          ? {
              cache_mode: 'writethrough',
              cache_policy: 'smq',
              // STALE, not absent — the GT-23 reading the state gate exists for.
              cache_total_blocks: '8000',
              cache_used_blocks: '3881',
              cache_read_hits: '25632',
              cache_read_misses: '3585',
              cache_dirty_blocks: '0',
            }
          : {}),
      }],
    }],
  })
}

const BTRFS_USAGE = [
  'Overall:',
  `    Device size:\t\t${LV_SIZE}`,
  '    Used:\t\t1048576',
  `    Free (estimated):\t\t${LV_SIZE - 2 * MIB}\t(min: ${LV_SIZE - 4 * MIB})`,
  '',
].join('\n')

const BY_ID_LISTING = [
  `lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${X} -> ../../sdq`,
  `lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${X}-part1 -> ../../sdq1`,
  `lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${Y} -> ../../sdr`,
  `lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${Y}-part1 -> ../../sdr1`,
  '',
].join('\n')

function buildExecutor(world: World): MockExecutor {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: ok(MDSTAT) })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: ok(MD_EXPORT) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: ok(ahrLsblkJson()) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...LSBLK_ARGS], result: ok(inventoryLsblkJson()) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_CACHE_LSBLK_ARGS], result: ok(ahrLsblkJson()) })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(BY_ID_LISTING) })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: ok(JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '2', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] })) })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: ok(lvsJson(world)) })
  executor.addFixture({ command: '/usr/sbin/lvs', args: ['--reportformat', 'json', '--units', 'b', '--nosuffix'], result: ok(lvsJson(world)) })
  executor.addFixture({ command: '/usr/sbin/pvs', args: [...PVS_ARGS], result: ok(pvsJson(world)) })
  executor.addFixture({ command: '/usr/sbin/dmsetup', args: dmsetupStatusArgs(DM_NAME), result: ok(DM_STATUS[world]) })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: ok(JSON.stringify({
    filesystems: [{ target: MOUNTPOINT, source: `/dev/mapper/${DM_NAME}`, fstype: 'btrfs', options: world === 'readonly' ? RO_OPTIONS : RW_OPTIONS }],
  })) })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', MOUNTPOINT], result: ok(BTRFS_USAGE) })
  executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 1 } })
  executor.addFixture({ command: '/usr/bin/perl', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/lvconvert', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/vgreduce', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/lvremove', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/pvremove', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/wipefs', result: ok('') })
  executor.addFixture({ command: '/usr/sbin/sgdisk', result: ok('') })
  executor.addFixture({ command: '/usr/bin/udevadm', result: ok('') })
  return executor
}

async function waitForJob(jobQueue: JobQueue, id: string): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const job = jobQueue.get(id)
    if (job && (job.status === 'completed' || job.status === 'failed'))
      return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`job ${id} did not finish`)
}

describe('AHR cache removal event (ahrcache.1 slice 2)', () => {
  let dir: string
  let executor: MockExecutor
  let jobQueue: JobQueue
  let server: ReturnType<typeof Fastify>

  async function build(world: World) {
    executor = buildExecutor(world)
    jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    await server.register(jobRoutes, { prefix: '/v1', jobQueue })
    await server.register(ahrCacheRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      diskIdentityCache: new DiskIdentityCache(executor),
      intentDir: dir,
    })
    await server.ready()
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cache-event-'))
  })

  afterEach(async () => {
    await server?.close()
    await rm(dir, { recursive: true, force: true })
  })

  /** Post one removal event, as the shipped hook posts it. */
  async function postEvent(body: unknown = { event: 'device-removed', slice: 'tank-cache1', kernel: 'sdd1' }, headers = IDENTITY_HEADERS) {
    return server.inject({ method: 'POST', url: '/v1/ahr/tank/cache/event', headers, payload: body })
  }

  // ---- authentication ------------------------------------------------------

  it('401s without identity headers — the socket proves root, the headers name the rung', async () => {
    await build('failed')
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/tank/cache/event', payload: { event: 'device-removed' } })
    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
    // NOTHING ran: an unauthenticated caller must not even cost a pool read.
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/lvconvert').length, 0)
  })

  it('400s on a body that is not a removal report', async () => {
    await build('failed')
    const res = await postEvent({ event: 'device-added' })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/lvconvert').length, 0)
  })

  it('404s for a pool this node does not have', async () => {
    await build('failed')
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/nosuch/cache/event', headers: IDENTITY_HEADERS, payload: { event: 'device-removed' } })
    assert.equal(res.statusCode, 404)
  })

  // ---- idempotency ---------------------------------------------------------

  it('is a no-op on a pool with no cache — a replayed event costs nothing', async () => {
    await build('absent')
    const res = await postEvent()
    assert.equal(res.statusCode, 200)
    const data = res.json().data
    assert.equal(data.recovered, false)
    assert.equal(data.cacheState, 'absent')
    assert.match(data.detail, /nothing to recover/)
    // udev re-runs rules and one disk can raise several removal events.
    // Neither may cost the pool a second `lvconvert --uncache`.
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/lvconvert').length, 0)
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/vgreduce').length, 0)
  })

  it('the SECOND event, after the recovery, is the same no-op', async () => {
    // Pass 1: the failure, repaired.
    await build('failed')
    const first = await postEvent()
    assert.equal(first.statusCode, 202)
    const firstJob = await waitForJob(jobQueue, first.json().job.id)
    assert.equal(firstJob.status, 'completed', JSON.stringify(firstJob.error))
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/lvconvert').length, 1)
    await server.close()

    // Pass 2: the node as the repair left it — the LV is no longer a cache
    // target, dm reports a plain linear volume, the ghost PV is gone. udev
    // re-runs rules and one disk can raise several removal events, so this is
    // the ordinary case, not an edge one.
    await build('absent')
    const second = await postEvent()
    assert.equal(second.statusCode, 200)
    assert.equal(second.json().data.recovered, false)
    assert.equal(second.json().data.cacheState, 'absent')
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/lvconvert').length, 0)
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/perl').length, 0, 'a no-op event notifies nobody')
  })

  // ---- the recovery itself -------------------------------------------------

  it('runs uncache then the guarded --removemissing, in that order', async () => {
    await build('failed')
    const res = await postEvent()
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(jobQueue, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))

    const lvm = executor.calls.filter(c => c.command === '/usr/sbin/lvconvert' || c.command === '/usr/sbin/vgreduce')
    assert.deepEqual(lvm, [
      // No `--force`, and no unmount first: `--uncache` is live with the device
      // absent, and writethrough guarantees there is nothing to flush (GT-20).
      { command: '/usr/sbin/lvconvert', args: ['--config', 'devices/allow_mixed_block_sizes=1', '-y', '--uncache', 'tank/tank-vol'] },
      { command: '/usr/sbin/vgreduce', args: ['--config', 'devices/allow_mixed_block_sizes=1', '--removemissing', 'tank'] },
    ])
  })

  it('LEAVES the slice alone — the disk keeps its mark for the UI to reclaim', async () => {
    await build('failed')
    const res = await postEvent()
    await waitForJob(jobQueue, res.json().job.id)
    // The recovery is deliberately narrower than Detach: a device that comes
    // back carries its `<pool>-cache<n>` slice, and that slice is what keeps
    // the disk attributed to its pool instead of reading as a foreign disk.
    // Deleting a partition is a destructive step, and no machine takes it here.
    for (const cmd of ['/usr/sbin/sgdisk', '/usr/sbin/wipefs', '/usr/sbin/pvremove'])
      assert.equal(executor.calls.filter(c => c.command === cmd).length, 0, cmd)
  })

  it('REFUSES --removemissing while a band PV is also missing', async () => {
    await build('bandsdown')
    const res = await postEvent()
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(jobQueue, res.json().job.id)
    assert.equal(job.status, 'failed')
    // GT-19: a stopped band array reads `[unknown]` exactly as a dead cache
    // device does, and `--removemissing` drops EVERY absent PV — it would evict
    // the band's PV from a pool that was merely not assembled.
    assert.match(job.error!.message, /a stopped band array is indistinguishable/)
    assert.match(job.error!.message, /Bring the band arrays up first/)
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/vgreduce').length, 0)
    // The uncache DID run — it is safe and it restores reads; only the VG edit
    // is held back.
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/lvconvert').length, 1)
  })

  it('announces the failed auto-recovery with the boot rung\'s error notification', async () => {
    // This rung runs with nobody at a keyboard — a silent failure leaves the
    // pool serving I/O errors with no trace outside the job list. Parallel
    // construction with ahr-boot-scan: same severity, same title, same body.
    await build('bandsdown')
    const res = await postEvent()
    const job = await waitForJob(jobQueue, res.json().job.id)
    assert.equal(job.status, 'failed')
    const perlCalls = executor.calls.filter(c => c.command === '/usr/bin/perl')
    // EXACTLY one: the recovery's own success notification never ran (the job
    // failed before it), so the failure announcement is the only one.
    assert.equal(perlCalls.length, 1)
    const [, , severity, title, body] = perlCalls[0]!.args
    assert.equal(severity, 'error')
    assert.equal(title, 'AHR read cache recovery FAILED: tank')
    assert.match(body, /Pool 'tank' has a read cache whose device is missing/)
    // The reason, verbatim from the guard that refused the recovery.
    assert.match(body, /a stopped band array is indistinguishable/)
    assert.match(body, /Bring the band arrays up first/)
  })

  it('refuses while a cache job is already in flight on the pool', async () => {
    await build('failed')
    let release = (): void => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    jobQueue.submit('ahr.cache.detach', { user: 'root@pam', uid: 0, params: { pool: 'tank' } }, async () => {
      await blocked
      return {}
    })
    const res = await postEvent()
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /already in flight on AHR pool 'tank'/)
    release()
  })

  it('refuses while an expansion intent exists — the rung comes round again on its own', async () => {
    // The same gate attach and detach apply: the VG's shape is in flight and
    // the recovery's `vgreduce --removemissing` must not run under it.
    await writeIntent('tank', {
      id: randomUUID(),
      trigger: 'add-disk',
      approvedDisks: [X, Y],
      before: { rawBytes: 2 * GIB, usableBytes: 2 * GIB, usedBytes: 0, freeBytes: 2 * GIB, redundancyOverheadBytes: 0, unprotectedWastedBytes: 0, pendingBytes: 0 },
      after: { rawBytes: 3 * GIB, usableBytes: 3 * GIB, usedBytes: 0, freeBytes: 3 * GIB, redundancyOverheadBytes: 0, unprotectedWastedBytes: 0, pendingBytes: 0 },
      state: 'running',
    }, { dir })
    await build('failed')
    const res = await postEvent()
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /expansion intent/)
    // And it runs NOTHING: the recovery is skipped, not queued — udev
    // re-raises the event and the boot rung re-runs it at the next start.
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/lvconvert').length, 0)
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/vgreduce').length, 0)
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/perl').length, 0)
  })

  // ---- what the operator is told -------------------------------------------

  it('notifies with the device named and the no-data-lost fact', async () => {
    await build('failed')
    const res = await postEvent()
    await waitForJob(jobQueue, res.json().job.id)
    const perl = executor.calls.find(c => c.command === '/usr/bin/perl')
    assert.ok(perl, 'a notification was emitted')
    const [, , severity, title, body] = perl!.args
    assert.equal(severity, 'warning')
    assert.equal(title, 'AHR read cache failed: tank')
    // The disk is GONE, so its by-id cannot be recovered — the slice label udev
    // reported is the honest name for it.
    assert.match(body, /Cache device tank-cache1 failed on pool 'tank'/)
    assert.match(body, /reads are restored uncached and no data was lost/)
    // Read-WRITE in this world: the pool never took a write during the window,
    // so the Remount sentence must NOT appear (it would send the operator to
    // break every open handle for nothing).
    assert.ok(!body.includes('READ-ONLY'), body)
    assert.ok(!body.includes('Remount'), body)
  })

  it('adds the writes-are-stopped sentence when btrfs went read-only', async () => {
    await build('readonly')
    const res = await postEvent()
    await waitForJob(jobQueue, res.json().job.id)
    const body = executor.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    // GT-20: `--uncache` restores reads in the same second but cannot undo
    // btrfs's forced-readonly flag, and `remount,rw` is refused after an error.
    assert.match(body, /forced READ-ONLY/)
    assert.match(body, /writes are stopped until the pool is remounted/)
    assert.match(body, /breaks open share handles/)
  })

  it('reads the read-only flag from the mount table, after the uncache', async () => {
    await build('readonly')
    const res = await postEvent()
    await waitForJob(jobQueue, res.json().job.id)
    // btrfs flips read-only on the first WRITE after the cache dies, which can
    // land between the request and the repair — so the flag is re-read rather
    // than taken from the pool record the route loaded.
    const findmntCalls = executor.calls.filter(c => c.command === '/usr/bin/findmnt').length
    const uncacheAt = executor.calls.findIndex(c => c.command === '/usr/sbin/lvconvert')
    const lastFindmnt = executor.calls.map(c => c.command).lastIndexOf('/usr/bin/findmnt')
    assert.ok(findmntCalls >= 2, 'the mount table is read again for the verdict')
    assert.ok(lastFindmnt > uncacheAt, 'the read-only verdict is taken AFTER the uncache')
  })
})

describe('read-only detection over the real mount-options string', () => {
  it('reads `ro` as read-only and `rw` as not, on a btrfs subvol mount', () => {
    // The captured shape, from /proc/mounts (field 4) — identical to what
    // `findmnt --json` returns as `options`:
    //   /dev/mapper/gtcache-gtcache--vol /mnt/anas-ahr/gtcache btrfs \
    //     ro,relatime,space_cache=v2,subvolid=256,subvol=/@data 0 0
    assert.equal(optionsReadOnly(RO_OPTIONS), true)
    assert.equal(optionsReadOnly(RW_OPTIONS), false)
  })

  it('is not fooled by an option that merely CONTAINS `ro`', () => {
    // `errors=remount-ro` is the ext-family default and appears on plenty of
    // read-WRITE mounts; a substring test would call every one of them broken.
    assert.equal(optionsReadOnly('rw,relatime,errors=remount-ro'), false)
    assert.equal(optionsReadOnly('rw,nosuid,nodev,prjquota'), false)
  })
})

describe('the cache-slice label the udev hook hands back', () => {
  it('resolves a cache slice to its pool', () => {
    assert.equal(poolOfCacheLabel('gtcache-cache1'), 'gtcache')
    assert.equal(poolOfCacheLabel('tank-cache12'), 'tank')
    // A pool name may contain a dash of its own; the TAIL is what decides.
    assert.equal(poolOfCacheLabel('my-pool-cache2'), 'my-pool')
  })

  it('resolves a BAND member slice to nothing — md owns those', () => {
    for (const label of ['tank-d1-b1', 'tank-d12-b3', 'tank-cache', 'tank-cacheX', 'cache1', ''])
      assert.equal(poolOfCacheLabel(label), null, label)
  })
})

describe('the recovery notification body (one home, three surfaces)', () => {
  it('names the disk by its by-id when the daemon still knows it', () => {
    const { title, body } = cacheRecoveryNotification({ pool: 'tank', device: 'ata-SSD_1', readOnly: false, reason: 'failed' })
    assert.equal(title, 'AHR read cache failed: tank')
    assert.match(body, /^Cache device ata-SSD_1 failed on pool 'tank'\./)
  })

  it('says "The cache device" rather than inventing an id it does not have', () => {
    const { body } = cacheRecoveryNotification({ pool: 'tank', device: null, readOnly: false, reason: 'failed' })
    assert.match(body, /^The cache device failed on pool 'tank'\./)
  })

  it('has its own wording for the boot rung — missing, not failed', () => {
    const { title, body } = cacheRecoveryNotification({ pool: 'tank', device: null, readOnly: false, reason: 'missing' })
    assert.equal(title, 'AHR read cache missing: tank')
    assert.match(body, /was missing when pool 'tank' was activated/)
  })
})
