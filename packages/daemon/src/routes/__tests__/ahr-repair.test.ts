import type { Job } from '@anas/shared'
import type { MockFixture } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import type { ZfsMountpoint } from '../../parsers/pve-storage.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { JobQueue } from '../../jobs/queue.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrMutationRoutes, repairFindmntArgs } from '../ahr-mutate.js'
import { jobRoutes } from '../jobs.js'

/**
 * POST /v1/ahr/:name/repair — Repair from parity (story selfheal.6).
 *
 * The route's whole job is to refuse everything that must not be repaired
 * BEFORE a confirm code exists, then to hand the engine an explicit list. The
 * engine itself is covered by `services/__tests__/selfheal-repair.test.ts` and
 * the job around it by `services/__tests__/ahr-repair.test.ts`; what is
 * asserted here is the door.
 */

const ISCSI_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/iscsi')

const MOUNTPOINT = '/mnt/anas-ahr/ahr0'
const FILE = `${MOUNTPOINT}/movies/a very long name.mkv`

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

/**
 * The dev-mock AHR topology (`ahr0`) with a swappable /proc/mdstat and a
 * swappable findmnt — the mount's `subvol=` option is what decides whether the
 * pool is a §12 layout, and therefore whether it has a top-level mount at all.
 */
/**
 * `pre` fixtures register FIRST, so an exact-args fixture here SHADOWS the
 * helper's own answer for the same argv (mock matching is first-match-wins) —
 * that is how a test makes a confinement step fail (D12).
 */
function ahrExecutor(mdstat: ExecResult = mockFixtures.ahrMdstat(), findmnt: ExecResult = mockFixtures.ahrFindmnt(), pre: MockFixture[] = []): MockExecutor {
  const executor = new MockExecutor()
  for (const fixture of pre)
    executor.addFixture(fixture)
  executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mdstat })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
  executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: mockFixtures.ahrLsblk() })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
  executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
  executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
  executor.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: findmnt })
  executor.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs(MOUNTPOINT), result: mockFixtures.ahrBtrfsUsage() })
  // D12 confinement: the mountpoint and the pool's LV resolve (no symlinks in
  // the mock), the LV device identity agrees, and the FILE sits on that LV.
  executor.addFixture({ command: '/usr/bin/realpath', args: ['-e', MOUNTPOINT], result: { stdout: `${MOUNTPOINT}\n`, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/realpath', args: ['-e', '/dev/ahr0/ahr0-vol'], result: { stdout: '/dev/dm-9\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/realpath', args: ['-e', FILE], result: { stdout: `${FILE}\n`, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: repairFindmntArgs(FILE), result: { stdout: '/dev/ahr0/ahr0-vol\n', stderr: '', exitCode: 0 } })
  return executor
}

/** `stat -c %s` answers for the paths that exist; everything else is gone. */
function withFiles(executor: MockExecutor, paths: string[]): MockExecutor {
  for (const path of paths)
    executor.addFixture({ command: '/usr/bin/stat', args: ['-c', '%s', path], result: { stdout: '4096\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/stat', result: { stdout: '', stderr: 'No such file or directory', exitCode: 1 } })
  return executor
}

interface TestServer {
  inject: ReturnType<typeof Fastify>['inject']
  close: () => Promise<unknown>
  jobQueue: JobQueue
}

async function serverWith(executor: MockExecutor): Promise<TestServer> {
  const app = Fastify({ logger: false })
  const jobQueue = new JobQueue()
  await app.register(jobRoutes, { prefix: '/v1', jobQueue })
  await app.register(ahrMutationRoutes, {
    prefix: '/v1',
    executor,
    jobQueue,
    confirmStore: new ConfirmStore(),
    diskIdentityCache: new DiskIdentityCache(executor),
    fstabPath: '/nonexistent/fstab',
    kernelRelease: '7.0.14-8-pve',
  })
  const server = app as unknown as TestServer
  server.jobQueue = jobQueue
  return server
}

function body(files: { path: string, blocks: number[] }[]): string {
  return JSON.stringify({ files })
}

async function waitForJob(server: TestServer, id: string): Promise<Job> {
  for (let i = 0; i < 300; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('POST /v1/ahr/:name/repair — validation', () => {
  it('400 on a body that names no file, no block, or a path that is not absolute', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    for (const payload of [
      body([]),
      body([{ path: FILE, blocks: [] }]),
      JSON.stringify({ files: [{ path: '@snapshots/nightly/x.mkv', blocks: [1] }] }),
      JSON.stringify({}),
    ]) {
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload })
      assert.equal(res.statusCode, 400, payload)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR', payload)
    }
    // …and the message says what a repair CAN take, including why a snapshot
    // finding is not it.
    const snap = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: JSON.stringify({ files: [{ path: '@snapshots/nightly/x.mkv', blocks: [1] }] }) })
    assert.match(snap.json().error.message, /@snapshots/)
    await server.close()
  })

  it('401 without identity headers, 404 for a pool that is not there', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    const anon = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: { 'content-type': 'application/json' }, payload: body([{ path: FILE, blocks: [1] }]) })
    assert.equal(anon.statusCode, 401)
    const gone = await server.inject({ method: 'POST', url: '/v1/ahr/nosuch/repair', headers: JSON_HEADERS, payload: body([{ path: '/mnt/anas-ahr/nosuch/a.bin', blocks: [1] }]) })
    assert.equal(gone.statusCode, 404)
    await server.close()
  })

  it('400 for a path outside the pool\'s mountpoint — repair is the live @data tree only', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE, '/etc/hosts']))
    for (const path of ['/etc/hosts', MOUNTPOINT]) {
      const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path, blocks: [1] }]) })
      assert.equal(res.statusCode, 400, path)
      assert.match(res.json().error.message, /live @data tree only/, path)
    }
    await server.close()
  })

  it('409 for a path that no longer exists — deleted since the scrub named it', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: `${MOUNTPOINT}/gone.bin`, blocks: [1] }]) })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /deleted since the scrub/)
    await server.close()
  })

  // Design review 2026-09-14, D12 — lexical confinement is not enough. A
  // symlink inside the tree passes the string test while pointing somewhere
  // else; a bind mount laid over part of the tree sits inside the string but
  // not on the pool's LV; and a path that cannot be resolved at all must never
  // be written against.
  it('400 for a symlink that resolves OUTSIDE the pool\'s tree, though the string is inside (D12)', async () => {
    const LINK = `${MOUNTPOINT}/link.bin`
    const server = await serverWith(withFiles(ahrExecutor(mockFixtures.ahrMdstat(), mockFixtures.ahrFindmnt(), [
      { command: '/usr/bin/realpath', args: ['-e', LINK], result: { stdout: '/etc/hosts\n', stderr: '', exitCode: 0 } },
    ]), [FILE, LINK]))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: LINK, blocks: [1] }]) })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /resolves to '\/etc\/hosts', which is not a file under/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    await server.close()
  })

  it('400 for a path whose filesystem is NOT the pool\'s own LV — a bind mount inside the tree is not the pool\'s to write (D12)', async () => {
    const FOREIGN = `${MOUNTPOINT}/bind-mount.bin`
    const server = await serverWith(withFiles(ahrExecutor(mockFixtures.ahrMdstat(), mockFixtures.ahrFindmnt(), [
      { command: '/usr/bin/findmnt', args: repairFindmntArgs(FOREIGN), result: { stdout: '/dev/sdz1\n', stderr: '', exitCode: 0 } },
      { command: '/usr/bin/realpath', args: ['-e', FOREIGN], result: { stdout: `${FOREIGN}\n`, stderr: '', exitCode: 0 } },
      { command: '/usr/bin/realpath', args: ['-e', '/dev/sdz1'], result: { stdout: '/dev/sdz1\n', stderr: '', exitCode: 0 } },
    ]), [FILE, FOREIGN]))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FOREIGN, blocks: [1] }]) })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /sits on \/dev\/sdz1, not on AHR pool 'ahr0's own device \(\/dev\/dm-9\)/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    await server.close()
  })

  it('202 when findmnt reports the btrfs fs root in brackets — every §12 pool\'s SOURCE looks like that (N2)', async () => {
    // `findmnt -o SOURCE` appends the filesystem root for a btrfs subvolume
    // mount, and EVERY §12 AHR pool mounts `subvol=@data`:
    //     /dev/mapper/ahr0-ahr0--vol[/@data]
    // `realpath` of that string fails, so the confinement check answered "the
    // filesystem holding this path could not be determined" and the route 400'd
    // on every file of every subvol-layout pool — Repair was dead there.
    const BRACKETED = '/dev/mapper/ahr0-ahr0--vol[/@data]'
    const executor = ahrExecutor(mockFixtures.ahrMdstat(), mockFixtures.ahrFindmnt(), [
      { command: '/usr/bin/findmnt', args: repairFindmntArgs(FILE), result: { stdout: `${BRACKETED}\n`, stderr: '', exitCode: 0 } },
    ])
    // The pool's LV and the bracket-stripped source resolve to the same device.
    executor.addFixture({ command: '/usr/bin/realpath', args: ['-e', '/dev/mapper/ahr0-ahr0--vol'], result: { stdout: '/dev/dm-9\n', stderr: '', exitCode: 0 } })
    const server = await serverWith(withFiles(executor, [FILE]))
    const payload = body([{ path: FILE, blocks: [300] }])
    const first = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload })
    assert.equal(first.statusCode, 409, JSON.stringify(first.json()))
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    const code = first.headers['x-anas-confirm-code'] as string
    const second = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload })
    assert.equal(second.statusCode, 202, JSON.stringify(second.json()))
    // The flag is what does it — the bracket strip is only the second line.
    assert.ok(repairFindmntArgs(FILE).includes('--nofsroot'), repairFindmntArgs(FILE).join(' '))
    await server.close()
  })

  it('400 for a path that cannot be resolved at all — nothing is written against an unresolvable name (D12)', async () => {
    const BROKEN = `${MOUNTPOINT}/broken.bin`
    const server = await serverWith(withFiles(ahrExecutor(mockFixtures.ahrMdstat(), mockFixtures.ahrFindmnt(), [
      { command: '/usr/bin/realpath', args: ['-e', BROKEN], result: { stdout: '', stderr: 'realpath: No such file or directory', exitCode: 1 } },
    ]), [FILE, BROKEN]))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: BROKEN, blocks: [1] }]) })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /could not be resolved on the filesystem \(realpath -e failed\)/)
    await server.close()
  })

  it('409 when the MOUNTPOINT itself will not resolve — no repair is minted against it (D12)', async () => {
    const server = await serverWith(withFiles(ahrExecutor(mockFixtures.ahrMdstat(), mockFixtures.ahrFindmnt(), [
      { command: '/usr/bin/realpath', args: ['-e', MOUNTPOINT], result: { stdout: '', stderr: 'realpath: No such file or directory', exitCode: 1 } },
    ]), [FILE]))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [1] }]) })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /could not be resolved on the filesystem. Refusing to repair against an unresolvable root/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    await server.close()
  })
})

describe('POST /v1/ahr/:name/repair — hard refusals, before any confirm code', () => {
  it('409 while the pool is busy — no X-Anas-Confirm-Code to bypass it with', async () => {
    const server = await serverWith(withFiles(ahrExecutor(mockFixtures.ahrMdstatCheck()), [FILE]))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /scrubbing|degraded|rebuilding|expanding|building/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    await server.close()
  })

  it('409 while a backup holds the pool\'s top-level mount — said at the door, not by the engine', async () => {
    // A §12 pool: the mount carries `subvol=/@data`, which is what makes the
    // on-demand top-level mount (and therefore the contention) real.
    const layout = JSON.stringify({
      filesystems: [{ target: MOUNTPOINT, source: '/dev/mapper/ahr0-ahr0--vol', fstype: 'btrfs', options: 'rw,relatime,subvol=/@data' }],
    })
    const executor = ahrExecutor(mockFixtures.ahrMdstat(), { stdout: layout, stderr: '', exitCode: 0 })
    // The held mount: `findmnt --mountpoint` answers 0 while someone holds it.
    executor.addFixture({ command: '/usr/bin/findmnt', args: ['--mountpoint', '/run/anas-ahr/ahr0.toplevel'], result: { stdout: '/run/anas-ahr/ahr0.toplevel\n', stderr: '', exitCode: 0 } })
    const server = await serverWith(withFiles(executor, [FILE]))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /top-level mount .* is already held/)
    assert.match(res.json().error.message, /backup or snapshot job is in flight/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    await server.close()
  })

  it('409 while a scrub job for this pool is in flight, naming the job', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    // A scrub that never finishes — the queue's own record is what the route reads.
    server.jobQueue.submit('ahr.scrub', { user: 'root@pam', uid: 0, params: { name: 'ahr0' } }, () => new Promise(() => {}))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /a scrub is in flight/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    // …and the same guard the other way round: no scrub starts mid-repair.
    const server2 = await serverWith(withFiles(ahrExecutor(), [FILE]))
    server2.jobQueue.submit('ahr.repair', { user: 'root@pam', uid: 0, params: { name: 'ahr0' } }, () => new Promise(() => {}))
    const scrub = await server2.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: JSON_HEADERS, payload: '{}' })
    assert.equal(scrub.statusCode, 409)
    assert.match(scrub.json().error.message, /repair job is in flight/)
    await server.close()
    await server2.close()
  })
})

/**
 * A QUEUED check (`resync=PENDING`) on band r1 — md has taken the check and
 * parked it until the array's first write (GT-9).
 *
 * It is the one shape that separates the node-wide exclusion from the pool's
 * own state: `anyCheck` needs a progress line, so the pool still reads
 * `healthy` and the state gate lets the request through, while
 * `runningAhrCheck` sees the pending check for exactly what it is.
 */
const MDSTAT_PENDING_CHECK = [
  'Personalities : [raid0] [raid1] [raid4] [raid5] [raid6] [raid10] [linear] ',
  'md126 : active raid1 sdd2[1] sdc2[0]',
  '      523200 blocks super 1.2 [2/2] [UU]',
  '      ',
  'md127 : active raid5 sdd1[3] sdc1[1] sdb1[0]',
  '      2089984 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]',
  '      \tresync=PENDING',
  '      ',
  'unused devices: <none>',
  '',
].join('\n')

describe('the node-wide md-check exclusion reaches all three verbs (N10)', () => {
  it('409s a REPAIR while md holds a queued check on a band — the job queue cannot see that check', async () => {
    // The queue's exclusion is in-process. A check left running by a previous
    // daemon, or started by mdcheck's timer, survives it — and the repair's own
    // bounded check would fight it for md's one sync thread. Only the scrub
    // route used to ask /proc/mdstat; all three do now.
    const executor = ahrExecutor({ stdout: MDSTAT_PENDING_CHECK, stderr: '', exitCode: 0 })
    const server = await serverWith(withFiles(executor, [FILE]))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(res.statusCode, 409, JSON.stringify(res.json()))
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /an md check is running on ahr0-r1/)
    assert.match(res.json().error.message, /one parity check at a time across the node's AHR bands/)
    // "Unsafe now" has no bypass (Principle 14).
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    await server.close()
  })

  it('409s a PARITY REWRITE on the same check, with the same sentence', async () => {
    const executor = ahrExecutor({ stdout: MDSTAT_PENDING_CHECK, stderr: '', exitCode: 0 })
    const server = await serverWith(withFiles(executor, [FILE]))
    // The evidence gate runs first, so the pool needs a completed scrub whose
    // phase 1 counted a mismatch on r1 and whose phase 2 was clean.
    server.jobQueue.submit('ahr.scrub', { user: 'root@pam', uid: 0, params: { name: 'ahr0' } }, async () => ({
      scrubbed: 'ahr0',
      btrfsErrors: null,
      checkedArrays: 2,
      parityMismatches: [{ band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 8, level: 'raid5' }],
    }))
    for (let i = 0; i < 200 && !server.jobQueue.findLastCompleted('ahr.scrub', 'ahr0'); i++)
      await new Promise(resolve => setTimeout(resolve, 10))

    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/parity-rewrite', headers: JSON_HEADERS, payload: JSON.stringify({ band: 1 }) })
    assert.equal(res.statusCode, 409, JSON.stringify(res.json()))
    assert.match(res.json().error.message, /an md check is running on ahr0-r1/)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    await server.close()
  })
})

describe('POST /v1/ahr/:name/repair — the confirm gate and the job', () => {
  it('409 CONFIRMATION_REQUIRED saying exactly what the repair does, then 202', async () => {
    const executor = withFiles(ahrExecutor(), [FILE])
    const server = await serverWith(executor)
    const payload = body([{ path: FILE, blocks: [300, 300, 12] }])

    const first = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload })
    assert.equal(first.statusCode, 409)
    const error = first.json().error
    assert.equal(error.code, 'CONFIRMATION_REQUIRED')
    // The duplicate block is collapsed, so the count is the work, not the ask.
    assert.match(error.message, /2 block\(s\) in 1 file\(s\)/)
    const warnings = (error.warnings as string[]).join('\n')
    assert.match(warnings, /read-only snapshot/)
    assert.match(warnings, /rmw_level, sync_min, sync_max and stripe_cache_size/)
    assert.match(warnings, /restored afterwards/)
    assert.match(warnings, /written THROUGH md/)
    assert.match(warnings, /matches the checksum btrfs stored/)
    assert.match(warnings, /Nothing else on the array is touched/)
    assert.match(warnings, /left untouched/)
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code)
    assert.ok(first.headers['x-anas-confirm-expires'])
    // Nothing was touched on the 409 — the read layer and the stat, and that is all.
    assert.deepEqual(executor.calls.filter(c => ['/usr/bin/dd', '/usr/bin/tee', '/usr/bin/btrfs'].includes(c.command) && c.args[0] === 'subvolume'), [])
    assert.ok(!executor.calls.some(c => c.command === '/usr/bin/dd'))

    const second = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload })
    assert.equal(second.statusCode, 202)
    const ref = second.json().job
    assert.equal(ref.operation, 'ahr.repair')
    const job = await waitForJob(server, ref.id)
    // The engine cannot resolve anything against a mock read layer, so every
    // block comes back unrepairable with its reason — which is the point: a
    // block that cannot be proven is never reported as repaired, and a failing
    // engine never fails the JOB.
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const result = job.result as { pool: string, repaired: number, unrepairable: number, aboveMd: number, mappingAbort: number, notExamined: number, blocks: number, files: { path: string, blocks: { block: number }[] }[] }
    assert.equal(result.pool, 'ahr0')
    assert.equal(result.blocks, 2)
    assert.equal(result.repaired, 0)
    // review R9 + seventh pass F3 — the buckets sum WITH the mapping-abort
    // count (a block the read layer found not corrupt at the mapped location)
    // and the not-examined one (a block whose mapping could not be followed at
    // all, which is what a mock read layer produces).
    assert.equal(
      result.repaired + result.unrepairable + result.aboveMd + (result.mappingAbort ?? 0) + (result.notExamined ?? 0),
      result.blocks,
    )
    assert.equal(result.files[0].path, FILE)
    assert.deepEqual(result.files[0].blocks.map(b => b.block), [12, 300])
    await server.close()
  })

  it('a confirm code minted for one selection does not authorize another', async () => {
    const OTHER = `${MOUNTPOINT}/other.bin`
    const executor = ahrExecutor()
    executor.addFixture({ command: '/usr/bin/realpath', args: ['-e', OTHER], result: { stdout: `${OTHER}\n`, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: repairFindmntArgs(OTHER), result: { stdout: '/dev/ahr0/ahr0-vol\n', stderr: '', exitCode: 0 } })
    const server = await serverWith(withFiles(executor, [FILE, OTHER]))
    const first = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    const code = first.headers['x-anas-confirm-code'] as string
    const swapped = await server.inject({
      method: 'POST',
      url: '/v1/ahr/ahr0/repair',
      headers: { ...JSON_HEADERS, 'x-anas-confirm': code },
      payload: body([{ path: `${MOUNTPOINT}/other.bin`, blocks: [300] }]),
    })
    assert.equal(swapped.statusCode, 409)
    assert.equal(swapped.json().error.code, 'CONFIRMATION_REQUIRED')
    await server.close()
  })

  // Design review 2026-09-14, D13 — "there will be page-cache drops" under
  // states the cost; the operator decides with numbers. The mock's chunk is
  // unreadable, so mdadm's 512 KiB default applies: 400 stripes × 512 KiB of
  // O_DIRECT reads, twice per block, ≈ 200 MiB per sweep.
  it('the confirm warnings state the per-block cost CONCRETELY (D13)', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    const first = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(first.statusCode, 409)
    const warnings = (first.json().error.warnings as string[]).join('\n')
    assert.match(warnings, /Per block: two node-wide page-cache drops \(drop_caches\), two ~200 MiB read sweeps over the array/)
    // ahr0's bands are striped (raid5), so the stripe-cache clause rides.
    assert.match(warnings, /the band's stripe cache held at its floor for the duration. A busy node will feel it/)
    assert.match(warnings, /Bring latency-sensitive workloads down first/)
    await server.close()
  })
})

/**
 * Seventh pass, F10 — LUN awareness on the repair route.
 *
 * `ahr-repair.ts` already called `heldByLunOnce`, but only AFTER the fact, to
 * word the advice on a block that could not be repaired. A file backing a LUN
 * with a LIVE initiator session was repaired under that session without the
 * operator ever being told. A repair writes 4 KiB it has proven correct and
 * btrfs's copy-on-write leaves the old extent alone — so this is not the
 * "corrupt what the initiator sees" hazard — but the initiator is holding its
 * own cache of the file and has no idea the bytes moved.
 *
 * D3 rides the same claims read: a BROKEN read fail-opens to "nothing held",
 * which a node genuinely serving a LUN would look exactly like — repair then
 * writes reconstructed data through md over a possibly live session. Fail-open
 * is not fail-silent: the advisory is disclosed at the confirm and, when the
 * break lands after the confirm, on the job's result (cr.24 ruling (j)).
 */
describe('POST /v1/ahr/:name/repair — a file backing a live LUN (F10)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-repair-lun-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** The captured LIO tree, with LUN 1's image path pointed at the repair FILE. */
  async function configfsServing(path: string, loggedIn: boolean): Promise<string> {
    const root = join(dir, 'target')
    let manifest = readFileSync(join(ISCSI_FIXTURES, 'configfs-live.manifest'), 'utf-8')
    manifest = manifest.replace('udev_path = /gtiscsi/images/lun2.raw', `udev_path = ${path}`)
    if (loggedIn) {
      const info = readFileSync(join(ISCSI_FIXTURES, 'configfs-acl-info-loggedin.txt'), 'utf-8')
        .trimEnd()
        .replaceAll('\\', '\\\\')
        .replaceAll('\n', '\\n')
      manifest = manifest.replace(
        /F (iscsi\/[^\n]*acls\/iqn\.1993-08[^\n]*\/info) = [^\n]*/,
        `F $1 = ${info}`,
      )
    }
    await materializeConfigfsManifest(manifest, root)
    return root
  }

  async function serverServing(root: string, zfsMountpoints?: () => Promise<ZfsMountpoint[]>): Promise<TestServer> {
    const executor = withFiles(ahrExecutor(), [FILE])
    const app = Fastify({ logger: false })
    const jobQueue = new JobQueue()
    await app.register(jobRoutes, { prefix: '/v1', jobQueue })
    await app.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: '/nonexistent/fstab',
      kernelRelease: '7.0.14-8-pve',
      iscsiPaths: {
        configfsRoot: root,
        saveconfigPath: join(dir, 'absent-saveconfig.json'),
        pveStorageCfg: join(dir, 'absent-storage.cfg'),
        blockRoot: join(dir, 'absent-block'),
        ...(zfsMountpoints ? { zfsMountpoints } : {}),
      },
    })
    const server = app as unknown as TestServer
    server.jobQueue = jobQueue
    return server
  }

  it('409 lun-session-active BEFORE a confirm code exists', async () => {
    const server = await serverServing(await configfsServing(FILE, true))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(res.statusCode, 409)
    const error = res.json().error
    assert.equal(error.reason, 'lun-session-active')
    assert.match(error.message, /backs iSCSI LUN/)
    assert.match(error.message, /logged in right now/)
    assert.match(error.message, /Log the initiator out/)
    assert.match(error.message, /copy-on-write leaves the old extent untouched/)
    assert.ok(!res.headers['x-anas-confirm-code'], 'no confirm code is minted for an unsafe-now refusal')
    await server.close()
  })

  it('a LUN with NO session is not refused — the repair proceeds to its confirm gate', async () => {
    const server = await serverServing(await configfsServing(FILE, false))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'])
    await server.close()
  })

  it('a file no LUN backs is not refused either', async () => {
    const server = await serverServing(await configfsServing('/gtiscsi/images/lun2.raw', true))
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    await server.close()
  })

  // D3 — a broken claims read fail-opens the gate, but it is DISCLOSED, never
  // a silent pass-over-a-live-session. The zfs mountpoint read is the seam the
  // iscsi-held suite already throws to produce a genuinely broken read.
  it('a failed LIO read puts the lio-unreadable advisory in the repair confirm (D3)', async () => {
    const server = await serverServing(await configfsServing(FILE, false), () => {
      throw new Error('zfs list exploded')
    })
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: body([{ path: FILE, blocks: [300] }]) })
    assert.equal(res.statusCode, 409, JSON.stringify(res.json()))
    const error = res.json().error
    assert.equal(error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'], 'a normal confirm challenge, not a refusal')
    const warnings = (error.warnings as string[]).join('\n')
    const line = warnings.split('\n').find(w => w.includes('could not check whether an iSCSI LUN'))
    assert.match(line ?? '', /served from this pool/, warnings)
    assert.match(line ?? '', /LIO configuration was unreadable/)
    assert.match(line ?? '', /verify by hand/)
    await server.close()
  })

  it('a LIO read that breaks after the confirm rides the repair job result (cr.24 ruling (j))', async () => {
    // The route's two passes read claims while the read is healthy, so the
    // confirm discloses nothing; the JOB's fresh read — after the confirm —
    // is the broken one, and its advisory rides the result, never a failed job.
    let reads = 0
    const zfsMountpoints = async (): Promise<ZfsMountpoint[]> => {
      reads += 1
      if (reads >= 3)
        throw new Error('zfs list exploded')
      return []
    }
    const server = await serverServing(await configfsServing(FILE, false), zfsMountpoints)
    const payload = body([{ path: FILE, blocks: [300] }])
    const first = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload })
    assert.equal(first.statusCode, 409, JSON.stringify(first.json()))
    const confirmWarnings = (first.json().error.warnings as string[]).join('\n')
    assert.ok(!confirmWarnings.includes('could not check whether an iSCSI LUN'), 'the confirm reads a HEALTHY LIO — nothing to disclose yet')
    const code = first.headers['x-anas-confirm-code'] as string
    const second = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload })
    assert.equal(second.statusCode, 202, JSON.stringify(second.json()))
    const job = await waitForJob(server, (second.json() as { job: { id: string } }).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    // The engine also asks the LIO question per unrepairable file (D10), so
    // `reads` is at LEAST the three guard doors, not exactly three.
    assert.ok(reads >= 3, `expected ≥3 claims reads, saw ${reads}`)
    const line = (job.result as { warnings?: string[] }).warnings?.find(w => w.includes('could not check whether an iSCSI LUN'))
    assert.match(line ?? '', /LIO configuration was unreadable/)
    await server.close()
  })
})

/**
 * Seventh pass, F11 — the finding's inode reaches the engine through the route.
 *
 * It is part of the SELECTION, so it is part of what the confirm code binds: a
 * code minted for "these blocks of this path" must not authorize "these blocks
 * of whatever is at this path now".
 */
describe('POST /v1/ahr/:name/repair — the finding\'s inode (F11)', () => {
  function withInode(inode?: number): string {
    return JSON.stringify({ files: [{ path: FILE, blocks: [300], ...(inode === undefined ? {} : { inode }) }] })
  }

  it('rides the request and the confirm signature', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    const first = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: withInode(4711) })
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code)
    // The SAME selection is authorized…
    const same = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload: withInode(4711) })
    assert.equal(same.statusCode, 202)
    await server.close()
  })

  it('…and a code minted for one inode does not authorize another', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    const first = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: withInode(4711) })
    const code = first.headers['x-anas-confirm-code'] as string
    const other = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload: withInode(4712) })
    assert.equal(other.statusCode, 409)
    assert.equal(other.json().error.code, 'CONFIRMATION_REQUIRED')
    await server.close()
  })

  it('stays optional — a request without it behaves exactly as before', async () => {
    const server = await serverWith(withFiles(ahrExecutor(), [FILE]))
    const first = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: JSON_HEADERS, payload: withInode() })
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string
    const second = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/repair', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload: withInode() })
    assert.equal(second.statusCode, 202)
    await server.close()
  })
})
