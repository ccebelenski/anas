import type { AhrExpansionIntent, Job } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { JobQueue } from '../../jobs/queue.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { LVS_ARGS, PVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs, mdadmExamineExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { createServer } from '../../server.js'
import { readIntent, writeIntent } from '../../services/ahr-intent.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrMutationRoutes, reconcileLunWarnings, rewriteLunWarnings } from '../ahr-mutate.js'
import { jobRoutes } from '../jobs.js'

/** Where the shipped md/lvm captures live — `mdstat-check.txt` among them. */
const AHR_FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '../../fixtures/ahr')

/**
 * AHR mutation routes (Epic 11 + AHR) — POST /v1/ahr, DELETE /v1/ahr/:name,
 * POST /v1/ahr/:name/scrub. Validation and 404s run against the stock dev
 * mock (which carries the read-layer pool `ahr0` and an all-in-use disk
 * inventory); the create-success path runs on a bare server with a controlled
 * blank-disk inventory so the confirm-gate shape and the executed argv can be
 * asserted exactly.
 */

const GIB = 1024 ** 3
const BLANK_SMALL = 'ata-ANAS_TEST_BLANK_SMALL'
const BLANK_BIG = 'ata-ANAS_TEST_BLANK_BIG'
const BLANK_4KN = 'ata-ANAS_TEST_BLANK_4KN'
const UUID_R1 = 'aaaaaaaa:bbbbbbbb:cccccccc:dddddddd'
const UUID_R2 = '11111111:22222222:33333333:44444444'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

interface TestServer {
  inject: ReturnType<typeof createServer>['inject']
  close: () => Promise<unknown>
}

async function waitForJob(server: TestServer, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('AHR mutation routes — validation & 404s (stock dev mock)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-mut-'))
    process.env.ANAS_FSTAB_PATH = join(dir, 'fstab')
    process.env.ANAS_MDADM_CONF = join(dir, 'mdadm.conf')
    process.env.ANAS_AHR_MOUNT_BASE = join(dir, 'mnt')
    await writeFile(join(dir, 'fstab'), '# empty\n')
    server = createServer({ mock: true, logger: false })
  })
  afterEach(async () => {
    await server.close()
    delete process.env.ANAS_FSTAB_PATH
    delete process.env.ANAS_MDADM_CONF
    delete process.env.ANAS_AHR_MOUNT_BASE
    await rm(dir, { recursive: true, force: true })
  })

  it('POST /v1/ahr — 400 on an invalid body (bad pool name)', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload: JSON.stringify({ name: '9bad', tier: 'ahr1', disks: ['ata-x'] }) })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('POST /v1/ahr — 401 without identity headers', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'newpool', tier: 'ahr1', disks: ['ata-x'] }) })
    assert.equal(res.statusCode, 401)
  })

  it('POST /v1/ahr — mountpoint override: /mnt/pve namespace and relative paths are rejected', async () => {
    for (const mountpoint of ['/mnt/pve', '/mnt/pve/x', '/']) {
      const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'newpool', tier: 'ahr1', disks: ['ata-x'], mountpoint }) })
      assert.equal(res.statusCode, 400, mountpoint)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR', mountpoint)
    }
    const rel = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'newpool', tier: 'ahr1', disks: ['ata-x'], mountpoint: 'not/absolute' }) })
    assert.equal(rel.statusCode, 400)
  })

  it('PUT /v1/ahr/:name/mountpoint — 404 unknown pool; reserved and same-path rejected; confirm shape on a valid move', async () => {
    const gone = await server.inject({ method: 'PUT', url: '/v1/ahr/nosuch/mountpoint', headers: JSON_HEADERS, payload: JSON.stringify({ mountpoint: '/srv/x' }) })
    assert.equal(gone.statusCode, 404)
    const reserved = await server.inject({ method: 'PUT', url: '/v1/ahr/ahr0/mountpoint', headers: JSON_HEADERS, payload: JSON.stringify({ mountpoint: '/mnt/pve/x' }) })
    assert.equal(reserved.statusCode, 400)
    const same = await server.inject({ method: 'PUT', url: '/v1/ahr/ahr0/mountpoint', headers: JSON_HEADERS, payload: JSON.stringify({ mountpoint: '/mnt/anas-ahr/ahr0' }) })
    assert.equal(same.statusCode, 400)
    assert.ok(same.json().error.message.includes('already'))
    const move = await server.inject({ method: 'PUT', url: '/v1/ahr/ahr0/mountpoint', headers: JSON_HEADERS, payload: JSON.stringify({ mountpoint: '/srv/newhome' }) })
    assert.equal(move.statusCode, 409)
    assert.ok(move.headers['x-anas-confirm-code'])
    assert.ok(move.json().error.warnings.some((w: string) => w.includes('/mnt/anas-ahr/ahr0')))
  })

  it('POST /v1/ahr — 409 CONFLICT when the pool name already exists', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'ahr0', tier: 'ahr1', disks: ['ata-x'] }) })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.ok(res.json().error.message.includes('ahr0'))
  })

  it('POST /v1/ahr — 400 naming every ineligible disk', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload: JSON.stringify({
      name: 'newpool',
      tier: 'ahr1',
      disks: ['ata-DOES_NOT_EXIST', 'ata-WDC_WD2003FZEX-00SRLA0_WD-12345678'],
    }) })
    assert.equal(res.statusCode, 400)
    const { message } = res.json().error
    assert.ok(message.includes(`'ata-DOES_NOT_EXIST' not found`))
    assert.ok(message.includes('not available'))
  })

  it('DELETE /v1/ahr/:name — 400 invalid name, 404 unknown pool', async () => {
    const bad = await server.inject({ method: 'DELETE', url: '/v1/ahr/9bad', headers: IDENTITY_HEADERS })
    assert.equal(bad.statusCode, 400)
    const missing = await server.inject({ method: 'DELETE', url: '/v1/ahr/nope', headers: IDENTITY_HEADERS })
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.json().error.code, 'NOT_FOUND')
  })

  it('DELETE /v1/ahr/ahr0 — 409 confirm shape, then 202 and a completing job', async () => {
    const first = await server.inject({ method: 'DELETE', url: '/v1/ahr/ahr0', headers: IDENTITY_HEADERS })
    assert.equal(first.statusCode, 409)
    const body = first.json()
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
    // Concrete consequences: pool name + usable size + service stop.
    assert.ok(body.error.warnings.some((w: string) => w.includes(`'ahr0'`) && w.includes('usable')))
    assert.ok(body.error.warnings.some((w: string) => w.includes('stops working')))
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code)

    const second = await server.inject({ method: 'DELETE', url: '/v1/ahr/ahr0', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
    assert.equal(second.statusCode, 202)
    const job = await waitForJob(server, second.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(job.result, { destroyed: 'ahr0' })
  })

  it('POST /v1/ahr/:name/scrub — 404 unknown; 202 + completing job for ahr0 (no confirm)', async () => {
    const missing = await server.inject({ method: 'POST', url: '/v1/ahr/nope/scrub', headers: IDENTITY_HEADERS })
    assert.equal(missing.statusCode, 404)

    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 202)
    const job = await waitForJob(server, res.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(job.result, { scrubbed: 'ahr0', btrfsErrors: null, checkedArrays: 2, bandsChecked: ['ahr0-r1', 'ahr0-r2'] })
  })
})

describe('POST /v1/ahr — create success path (controlled inventory)', () => {
  let server: TestServer
  let executor: MockExecutor
  let dir: string

  /** The controlled-inventory executor; `lsblkInventory` overrides the inventory read(s). */
  function controlledExecutor(lsblkInventory?: object[]): MockExecutor {
    const ex = new MockExecutor()
    // Inventory: two genuinely blank disks (status 'available').
    const lsblk = {
      blockdevices: [
        { 'name': 'sdx', 'type': 'disk', 'size': 2 * GIB, 'model': 'BLANK SM', 'serial': 'A', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 4096, 'log-sec': 512 },
        { 'name': 'sdy', 'type': 'disk', 'size': 3 * GIB, 'model': 'BLANK BG', 'serial': 'B', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 4096, 'log-sec': 512 },
        // A 4Kn disk, and the SMALLEST — so it reaches only the bottom band
        // (issue #8): band 1 becomes a 4096-block array, band 2 stays 512.
        { 'name': 'sdz', 'type': 'disk', 'size': 1 * GIB, 'model': 'BLANK 4KN', 'serial': 'C', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 4096, 'log-sec': 4096 },
      ],
    }
    if (lsblkInventory)
      ex.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, results: lsblkInventory.map(tree => ({ stdout: JSON.stringify(tree), stderr: '', exitCode: 0 })) })
    ex.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: { stdout: JSON.stringify(lsblk), stderr: '', exitCode: 0 } })
    ex.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: {
      stdout: [
        `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${BLANK_SMALL} -> ../../sdx`,
        `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${BLANK_BIG} -> ../../sdy`,
        `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${BLANK_4KN} -> ../../sdz`,
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    ex.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 0 } })
    // The create job's commands.
    for (const command of ['/usr/sbin/wipefs', '/usr/sbin/sgdisk', '/usr/bin/udevadm', '/usr/sbin/pvcreate', '/usr/sbin/vgcreate', '/usr/sbin/lvcreate', '/usr/sbin/mkfs.btrfs', '/usr/bin/btrfs', '/usr/sbin/update-initramfs', '/usr/bin/systemctl', '/usr/bin/mount', '/usr/bin/umount', '/usr/bin/perl', '/usr/sbin/mdadm'])
      ex.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })
    ex.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/tpool-r1'], result: { stdout: `MD_NAME=tpool-r1\nMD_UUID=${UUID_R1}\n`, stderr: '', exitCode: 0 } })
    return ex
  }

  async function buildServer(exec: MockExecutor): Promise<TestServer> {
    const app = Fastify({ logger: false })
    const jobQueue = new JobQueue()
    await app.register(jobRoutes, { prefix: '/v1', jobQueue })
    await app.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor: exec,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(exec),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
      // Pinned: without this the suite reads the RUNNER's kernel, and the
      // mixed-geometry tests flip between 409-gate and 400-refusal depending
      // on whether the host clears the 6.19 LBS floor (caught by CI on a
      // 6.x runner while dev machines pass on 7.x).
      kernelRelease: '7.0.14-8-pve',
    })
    return app as unknown as TestServer
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-create-route-'))
    await writeFile(join(dir, 'fstab'), '# empty\n')
    executor = controlledExecutor()
    server = await buildServer(executor)
  })
  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('409 confirm listing EVERY disk (id + model + size), then 202 and the built pool', async () => {
    const payload = JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_SMALL, BLANK_BIG] })

    const first = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload })
    assert.equal(first.statusCode, 409)
    const body = first.json()
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(body.error.message.includes('WIPE'))
    assert.equal(body.error.warnings.length, 2)
    assert.ok(body.error.warnings.some((w: string) => w.includes(BLANK_SMALL) && w.includes('BLANK SM') && w.includes('2 GiB')))
    assert.ok(body.error.warnings.some((w: string) => w.includes(BLANK_BIG) && w.includes('BLANK BG') && w.includes('3 GiB')))
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code)
    // A 409 must not have executed anything destructive.
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/wipefs'))

    const second = await server.inject({ method: 'POST', url: '/v1/ahr', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload })
    assert.equal(second.statusCode, 202)
    const job = await waitForJob(server, second.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(job.result, { created: 'tpool', mountpoint: join(dir, 'mnt', 'tpool'), arrays: ['tpool-r1'] })

    // The create ran with the explicit data offset and by-id member paths.
    const create = executor.calls.find(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--create')!
    assert.deepEqual(create.args, [
      '--create',
      '/dev/md/tpool-r1',
      '--level=raid1',
      '--raid-devices=2',
      '--metadata=1.2',
      '--name=tpool-r1',
      '--data-offset=8192s',
      '--bitmap=internal',
      '--run',
      `/dev/disk/by-id/${BLANK_SMALL}-part1`,
      `/dev/disk/by-id/${BLANK_BIG}-part1`,
    ])

    // fstab + mdadm.conf persisted.
    const fstab = await readFile(join(dir, 'fstab'), 'utf8')
    // …carrying the `iscsi.8` boot-ordering option: a `nofail` AHR mount is
    // otherwise unordered against the LIO restore service, and losing that race
    // makes LIO serve a 0-byte placeholder for any image LUN on the pool.
    assert.ok(fstab.includes(`/dev/tpool/tpool-vol ${join(dir, 'mnt', 'tpool')} btrfs nofail,subvol=@data,x-systemd.before=rtslib-fb-targetctl.service,x-systemd.device-timeout=45s 0 0`), fstab)
    const conf = await readFile(join(dir, 'mdadm.conf'), 'utf8')
    assert.ok(conf.includes('/dev/md/tpool-r1') && conf.includes(UUID_R1))
  })

  // Issue #8: a mixed 4Kn/512e selection is PROCEEDED with (the LVM stack is
  // built with allow_mixed_block_sizes) but never silently — the operator meets
  // the fact at the confirm gate, before the wipe, instead of as a job failure
  // hours into the initial sync.
  it('a mixed 4Kn/512e selection is labeled in the confirm gate, then proceeds', async () => {
    const payload = JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_4KN, BLANK_SMALL, BLANK_BIG] })

    const first = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload })
    assert.equal(first.statusCode, 409)
    const warnings = first.json().error.warnings as string[]
    // Three wipe warnings + the geometry label.
    assert.equal(warnings.length, 4)
    const mixed = warnings.find(w => w.startsWith('mixed sector geometries'))
    assert.ok(mixed, `expected a mixed-geometry warning, got: ${JSON.stringify(warnings)}`)
    assert.match(mixed, /band 1: 4096/)
    assert.match(mixed, /band 2: 512/)
    assert.match(mixed, /allow_mixed_block_sizes/)
    // Nothing destructive ran for a 409.
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/wipefs'))

    // Confirmed → it proceeds, and the LVM calls carry the flag.
    const code = first.headers['x-anas-confirm-code'] as string
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/tpool-r2'], result: { stdout: `MD_NAME=tpool-r2\nMD_UUID=${UUID_R2}\n`, stderr: '', exitCode: 0 } })
    const second = await server.inject({ method: 'POST', url: '/v1/ahr', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload })
    assert.equal(second.statusCode, 202)
    const job = await waitForJob(server, second.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))

    const vgcreate = executor.calls.find(c => c.command === '/usr/sbin/vgcreate')!
    assert.deepEqual(vgcreate.args.slice(0, 2), ['--config', 'devices/allow_mixed_block_sizes=1'])
  })

  // The gate is on the KERNEL, not the PVE version: PVE 9 shipped with 6.14.8,
  // so a fully supported node can sit below the md configurable-LBS floor.
  it('REFUSES a mixed selection below the 6.19 floor — 400, no confirm code, nothing touched', async () => {
    const app = Fastify({ logger: false })
    const jobQueue = new JobQueue()
    await app.register(jobRoutes, { prefix: '/v1', jobQueue })
    await app.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
      kernelRelease: '6.14.8-1-pve',
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/ahr',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_4KN, BLANK_SMALL, BLANK_BIG] }),
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
      assert.match(res.json().error.message, /needs kernel 6\.19\+ \(running: 6\.14\.8-1-pve\)/)
      // A refusal, not a gate: no confirm code is minted, so there is nothing
      // for the operator to override.
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/wipefs'))
    }
    finally {
      await app.close()
    }
  })

  it('a UNIFORM selection is accepted on that same old kernel', async () => {
    const app = Fastify({ logger: false })
    const jobQueue = new JobQueue()
    await app.register(jobRoutes, { prefix: '/v1', jobQueue })
    await app.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
      kernelRelease: '6.14.8-1-pve',
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/ahr',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_SMALL, BLANK_BIG] }),
      })
      // Reaches the confirm gate normally — the floor only ever gates a MIX.
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    }
    finally {
      await app.close()
    }
  })

  it('a uniform 512e selection is NOT labeled — no phantom geometry warning', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_SMALL, BLANK_BIG] }) })
    assert.equal(res.statusCode, 409)
    const warnings = res.json().error.warnings as string[]
    assert.ok(!warnings.some(w => w.startsWith('mixed sector geometries')))
  })

  it('minimum-disk rule: a 1-disk selection is rejected before any gate', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_SMALL] }) })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.ok(res.json().error.message.includes('at least 2 disks'))
  })

  // Bug #5 (code review): the pool name becomes the LVM VG name, and vgcreate
  // runs only AFTER the disks are wiped — so a name colliding with an existing
  // VG (e.g. 'pve') would pass confirm, wipe disks, then die at vgcreate. The
  // route must refuse BEFORE the confirm gate, with nothing touched.
  it('refuses (409) when the pool name collides with an existing LVM VG — before wiping', async () => {
    // A VG named 'tpool' already exists (and it is NOT an AHR pool).
    executor.addFixture({ command: '/usr/sbin/vgs', result: { stdout: JSON.stringify({ report: [{ vg: [
      { vg_name: 'tpool', pv_count: '1', lv_count: '0', snap_count: '0', vg_attr: 'wz--n-', vg_size: '<2.49g', vg_free: '0 ' },
    ] }] }), stderr: '', exitCode: 0 } })

    const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_SMALL, BLANK_BIG] }) })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT', 'a hard block, not a confirm')
    assert.ok(res.json().error.message.includes('volume group'))
    assert.ok(!res.headers['x-anas-confirm-code'], 'refused before the confirm gate')
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/wipefs'), 'no disk was wiped')
  })

  // ---- story ident.3: the name must be free, the disks still available -----

  it('refuses (409) a name mdadm.conf already pins — before the confirm', async () => {
    await writeFile(join(dir, 'mdadm.conf'), `ARRAY /dev/md/tpool-r1 metadata=1.2 UUID=${UUID_R1}\n`)
    const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_SMALL, BLANK_BIG] }) })
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.match(res.json().error.message, /already in use on this node/)
    assert.match(res.json().error.message, /mdadm\.conf already pins/)
    assert.ok(!res.headers['x-anas-confirm-code'])
  })

  it('refuses (409) a name a LIVE foreign array already carries, and one partition labels carry', async () => {
    // A hand-built `tpool-r1` (no VG, not pinned) is still an occupied name.
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: 'Personalities : [raid1]\nmd9 : active raid1 sdq1[1] sdp1[0]\n      1047552 blocks super 1.2 [2/2] [UU]\n\nunused devices: <none>\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md9'), result: { stdout: 'MD_LEVEL=raid1\nMD_UUID=99999999:99999999:99999999:99999999\nMD_NAME=otherbox:tpool-r1\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/lsblk', args: ['-J', '-o', 'NAME,PARTLABEL'], result: { stdout: JSON.stringify({ blockdevices: [{ name: 'sdw', children: [{ name: 'sdw1', partlabel: 'tpool-cache1' }] }] }), stderr: '', exitCode: 0 } })
    const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_SMALL, BLANK_BIG] }) })
    assert.equal(res.statusCode, 409, res.body)
    const { message } = res.json().error
    assert.match(message, /tpool-r1 \(\/dev\/md9\)/)
    assert.match(message, /tpool-cache1/)
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/wipefs'), 'no disk was wiped')
  })

  it('the JOB re-checks every disk: one that stopped being available while queued fails the job with nothing wiped', async () => {
    const blank = (name: string, size: number, serial: string) => ({ 'name': name, 'type': 'disk', 'size': size, 'model': 'BLANK', 'serial': serial, 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 4096, 'log-sec': 512 })
    const before = { blockdevices: [blank('sdx', 2 * GIB, 'A'), blank('sdy', 3 * GIB, 'B')] }
    // By the time the job runs, sdy carries a filesystem (someone else's now).
    const after = { blockdevices: [blank('sdx', 2 * GIB, 'A'), { ...blank('sdy', 3 * GIB, 'B'), children: [{ name: 'sdy1', type: 'part', size: 3 * GIB, fstype: 'ext4', mountpoint: null }] }] }
    const exec = controlledExecutor([before, before, after])
    await server.close()
    server = await buildServer(exec)

    const payload = JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_SMALL, BLANK_BIG] })
    const first = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload })
    assert.equal(first.statusCode, 409)
    const code = first.headers['x-anas-confirm-code'] as string
    const second = await server.inject({ method: 'POST', url: '/v1/ahr', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload })
    assert.equal(second.statusCode, 202, second.body)
    const job = await waitForJob(server, second.json().job.id)
    assert.equal(job.status, 'failed')
    assert.match(JSON.stringify(job.error), /changed since it was confirmed — nothing was touched/)
    assert.match(JSON.stringify(job.error), new RegExp(BLANK_BIG))
    assert.ok(!exec.calls.some(c => c.command === '/usr/sbin/wipefs' || c.command === '/usr/sbin/sgdisk'), 'no disk was wiped')
  })
})

/**
 * The scrub/repair exclusion (selfheal.6, review R7). Both verbs are full-array
 * operations on ONE pool and must never overlap — the repair turns md's
 * `rmw_level`, `sync_min`/`sync_max` and `stripe_cache_size` aside for the
 * duration of each block, and a check re-reads every stripe underneath it.
 *
 * The exclusion is a job-queue query, and the query has to filter by STATUS: a
 * newer TERMINAL job for the same pool must not hide an older running one.
 */
describe('POST /v1/ahr/:name/{scrub,repair} — the in-flight exclusion', () => {
  let server: TestServer
  let jobQueue: JobQueue
  let dir: string

  /** A job that never finishes — an operation still in flight on the pool. */
  function inFlight(operation: string, name: string): string {
    return jobQueue.submit(operation, { user: 'u', uid: 0, params: { name } }, async () => new Promise(() => {})).id
  }

  /** A job that is already over — the kind that used to HIDE a running one. */
  async function finished(operation: string, name: string): Promise<void> {
    jobQueue.submit(operation, { user: 'u', uid: 0, params: { name } }, async () => ({ done: true }))
    await new Promise(resolve => setImmediate(resolve))
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-exclusion-'))
    await writeFile(join(dir, 'fstab'), '# empty\n')

    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mockFixtures.ahrMdstat() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
    executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: mockFixtures.ahrLsblk() })
    executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
    executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
    executor.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: mockFixtures.ahrFindmnt() })
    executor.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: mockFixtures.ahrBtrfsUsage() })

    const app = Fastify({ logger: false })
    jobQueue = new JobQueue()
    await app.register(jobRoutes, { prefix: '/v1', jobQueue })
    await app.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
    })
    server = app as unknown as TestServer
  })
  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  const repairBody = { files: [{ path: '/mnt/anas-ahr/ahr0/f1.bin', blocks: [300] }] }

  it('a scrub is refused while a repair runs — even behind a newer finished repair', async () => {
    const running = inFlight('ahr.repair', 'ahr0')
    await finished('ahr.repair', 'ahr0')

    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 409)
    const { message } = res.json().error
    assert.ok(message.includes(running), `the RUNNING job is named: ${message}`)
    assert.ok(message.includes('a repair job is in flight'), message)
  })

  it('a repair is refused while a scrub runs — even behind a newer finished scrub', async () => {
    const running = inFlight('ahr.scrub', 'ahr0')
    await finished('ahr.scrub', 'ahr0')

    const res = await server.inject({
      method: 'POST',
      url: '/v1/ahr/ahr0/repair',
      headers: JSON_HEADERS,
      payload: repairBody,
    })
    assert.equal(res.statusCode, 409)
    const { message } = res.json().error
    assert.ok(message.includes(running), `the RUNNING job is named: ${message}`)
    assert.ok(message.includes('a scrub is in flight'), message)
    // Refused BEFORE a confirm code is minted: "unsafe now" has no bypass.
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  it('a SECOND scrub of the same pool is refused while the first runs', async () => {
    const running = inFlight('ahr.scrub', 'ahr0')
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 409)
    assert.ok(res.json().error.message.includes(running))
  })

  it('a finished job on its own blocks nothing', async () => {
    await finished('ahr.repair', 'ahr0')
    await finished('ahr.scrub', 'ahr0')
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 202)
  })

  it('a job in flight on ANOTHER pool blocks nothing', async () => {
    inFlight('ahr.repair', 'other')
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 202)
  })

  /**
   * S6 — the exclusions above are BOTH in-process, and a daemon restart takes
   * both with it: md's check on band r1 keeps running while the job that
   * issued it is gone. /proc/mdstat is the one thing that still knows, so the
   * route reads it at submit time and refuses.
   *
   * Staged with two mdstat reads: the topology read sees the clean node the
   * route-time state came from, and the exclusion read — a separate read, a
   * moment later — sees the check. That separation is the whole point: what md
   * is doing at the instant of the gate is the authority, not what a snapshot
   * taken earlier said.
   */
  it('refuses while an md check is running on a band, with no ANAS job behind it', async () => {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, results: [
      mockFixtures.ahrMdstat(),
      { stdout: readFileSync(join(AHR_FIXTURES, 'mdstat-check.txt'), 'utf-8'), stderr: '', exitCode: 0 },
    ] })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
    executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: mockFixtures.ahrLsblk() })
    executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
    executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
    executor.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: mockFixtures.ahrFindmnt() })
    executor.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: mockFixtures.ahrBtrfsUsage() })

    const app = Fastify({ logger: false })
    await app.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue: new JobQueue(),
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
    })
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409)
      const { message } = res.json().error
      assert.match(message, /^an md check is running on ahr0-r\d/)
      assert.match(message, /started outside this job or by a previous daemon/)
      assert.equal(res.headers['x-anas-confirm-code'], undefined, 'no bypass for "unsafe now"')
    }
    finally {
      await app.close()
    }
  })
})

/**
 * The scrub gate against an OFFLINE pool (issue #18 follow-up). The stock dev
 * mock's `ahr0` is healthy, so this builds the same read layer from the same
 * shipped fixtures with ONE byte changed: the LV's attr state field, 'a' →
 * '-', which is exactly what an LV that is present but not active reports.
 */
describe('POST /v1/ahr/:name/scrub — an OFFLINE pool is refused', () => {
  let server: TestServer
  let executor: MockExecutor
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-scrub-offline-'))
    await writeFile(join(dir, 'fstab'), '# empty\n')

    executor = new MockExecutor()
    const lvs = mockFixtures.ahrLvs()
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mockFixtures.ahrMdstat() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
    executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: mockFixtures.ahrLsblk() })
    executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
    executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: { ...lvs, stdout: lvs.stdout.replace('"-wi-a-----"', '"-wi-------"') } })
    executor.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: mockFixtures.ahrFindmnt() })
    executor.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: mockFixtures.ahrBtrfsUsage() })

    const app = Fastify({ logger: false })
    const jobQueue = new JobQueue()
    await app.register(jobRoutes, { prefix: '/v1', jobQueue })
    await app.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
    })
    server = app as unknown as TestServer
  })
  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('409s naming the condition, and starts no scrub', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    const { message } = res.json().error
    // The condition, not a symptom: "is offline" + why, never "is not mounted".
    assert.ok(message.includes('is offline'), message)
    assert.ok(message.includes('the volume is not assembled'), message)
    // This gate predates `offline` — the pool used to arrive here reading
    // `degraded`, which is not in the busy list, so the scrub was ALLOWED.
    assert.ok(!message.includes('would thrash'), message)
    // Nothing was started: no btrfs scrub, no md check.
    assert.ok(!executor.calls.some(c => c.command === '/usr/bin/btrfs' && c.args[0] === 'scrub'), 'no btrfs scrub')
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && c.args[0] === '--action=check'), 'no md check')
  })
})

/**
 * POST /v1/ahr/:name/parity-rewrite (story selfheal.10) — the confirm-gated
 * band rewrite. Every precondition is a HARD 409 with its own `reason` code:
 * the proof lives in the last completed scrub, and none of these is a risk an
 * operator is allowed to accept.
 */
describe('POST /v1/ahr/:name/parity-rewrite', () => {
  let server: TestServer
  let jobQueue: JobQueue
  let executor: MockExecutor
  let dir: string
  let sys: string

  /** A scrub job that COMPLETED with the given result — the evidence. */
  async function completedScrub(result: unknown, name = 'ahr0'): Promise<void> {
    jobQueue.submit('ahr.scrub', { user: 'u', uid: 0, params: { name } }, async () => result)
    await new Promise(resolve => setImmediate(resolve))
  }

  /** A job that never finishes — an operation still in flight on the pool. */
  function inFlight(operation: string, name: string): string {
    return jobQueue.submit(operation, { user: 'u', uid: 0, params: { name } }, async () => new Promise(() => {})).id
  }

  /** The proof: mismatches on r1, a clean checksum pass across the pool. */
  const CLEAN_WITH_MISMATCH = { scrubbed: 'ahr0', btrfsErrors: null, checkedArrays: 2, parityMismatches: [{ band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 8 }] }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-parity-'))
    await writeFile(join(dir, 'fstab'), '# empty\n')
    // A real md sysfs tree for band r1: the route reads the BAND's state, not
    // the pool rollup, and it reads it through the engine's own md layer.
    sys = join(dir, 'sys/block/md127/md')
    await mkdir(join(sys, 'rd0'), { recursive: true })
    await mkdir(join(sys, 'rd1'), { recursive: true })
    await mkdir(join(sys, 'rd2'), { recursive: true })
    const knobs: Record<string, string> = {
      'level': 'raid5',
      'chunk_size': '524288',
      'layout': '2',
      'raid_disks': '3',
      'sync_action': 'idle',
      'last_sync_action': 'check',
      'sync_min': '0',
      'sync_max': 'max',
      'sync_completed': '2089984 / 2089984',
      'mismatch_cnt': '8',
      'degraded': '0',
      'array_state': 'clean',
      'reshape_position': 'none',
      'rd0/offset': '2048',
      'rd0/size': '1044992',
      'rd0/state': 'in_sync',
      'rd1/offset': '2048',
      'rd1/size': '1044992',
      'rd1/state': 'in_sync',
      'rd2/offset': '2048',
      'rd2/size': '1044992',
      'rd2/state': 'in_sync',
    }
    for (const [key, value] of Object.entries(knobs))
      await writeFile(join(sys, key), `${value}\n`)
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = dir

    executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mockFixtures.ahrMdstat() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md/ahr0-r1'), result: mockFixtures.ahrMdadmExportR1() })
    executor.addFixture({ command: '/usr/bin/readlink', args: ['-f', '/dev/md/ahr0-r1'], result: { stdout: '/dev/md127\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: mockFixtures.ahrLsblk() })
    executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
    executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
    executor.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: mockFixtures.ahrFindmnt() })
    executor.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: mockFixtures.ahrBtrfsUsage() })

    const app = Fastify({ logger: false })
    jobQueue = new JobQueue()
    await app.register(jobRoutes, { prefix: '/v1', jobQueue })
    await app.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
    })
    server = app as unknown as TestServer
  })
  afterEach(async () => {
    delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/parity-rewrite', headers: { ...JSON_HEADERS, ...headers }, payload: body })
  }

  it('400 on a body that names no band, and on a band the pool does not have', async () => {
    await completedScrub(CLEAN_WITH_MISMATCH)
    const empty = await post({})
    assert.equal(empty.statusCode, 400)
    assert.equal(empty.json().error.code, 'VALIDATION_ERROR')

    const unknown = await post({ band: 9 })
    assert.equal(unknown.statusCode, 400)
    assert.ok(unknown.json().error.message.includes('no band r9'), unknown.json().error.message)
    assert.ok(unknown.json().error.message.includes('r1'), 'the bands it does have are named')
  })

  it('404 on an unknown pool', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/nope/parity-rewrite', headers: JSON_HEADERS, payload: { band: 1 } })
    assert.equal(res.statusCode, 404)
  })

  it('409 no-parity-mismatch when no completed scrub proves anything', async () => {
    const res = await post({ band: 1 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'no-parity-mismatch')
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'no bypass for "unsafe now"')
  })

  it('409 no-parity-mismatch when the scrub counted mismatches on ANOTHER band', async () => {
    await completedScrub({ scrubbed: 'ahr0', btrfsErrors: null, parityMismatches: [{ band: 'ahr0-r2', bandIndex: 2, array: '/dev/md/ahr0-r2', mismatchCnt: 4 }] })
    const res = await post({ band: 1 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'no-parity-mismatch')
  })

  it('409 data-findings-present when the last scrub found data corruption', async () => {
    await completedScrub({ scrubbed: 'ahr0', btrfsErrors: 'csum_errors=3', parityMismatches: [{ band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 8 }] })
    const res = await post({ band: 1 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'data-findings-present')
    assert.ok(res.json().error.message.includes('Repair those files from parity first'), res.json().error.message)
  })

  it('409 job-active while a scrub is in flight on the pool', async () => {
    await completedScrub(CLEAN_WITH_MISMATCH)
    const running = inFlight('ahr.scrub', 'ahr0')
    const res = await post({ band: 1 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'job-active')
    assert.ok(res.json().error.message.includes(running), res.json().error.message)
  })

  it('409 array-busy when the band is not idle', async () => {
    await completedScrub(CLEAN_WITH_MISMATCH)
    await writeFile(join(sys, 'sync_action'), 'recover\n')
    const res = await post({ band: 1 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'array-busy')
    assert.ok(res.json().error.message.includes('recover'), res.json().error.message)
  })

  it('409 confirm with the consequences spelled out, then 202 and a job', async () => {
    await completedScrub(CLEAN_WITH_MISMATCH)
    const first = await post({ band: 1 })
    assert.equal(first.statusCode, 409)
    const body = first.json()
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(body.error.message.includes('8 mismatch'), body.error.message)
    const warnings: string[] = body.error.warnings
    assert.ok(warnings.some(w => w.includes('AS IT IS NOW')), 'what parity is recomputed from')
    assert.ok(warnings.some(w => w.includes('fresh btrfs scrub')), 'the scrub that runs first')
    assert.ok(warnings.some(w => w.includes('NOCOW')), 'the files without checksums')
    assert.ok(warnings.some(w => w.includes('60 MiB/s')), 'the estimate and its assumption')
    assert.ok(warnings.some(w => w.includes('never automatic')), 'never automatic')
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code)

    const second = await post({ band: 1 }, { 'x-anas-confirm': code })
    assert.equal(second.statusCode, 202)
    assert.equal(second.json().job.operation, 'ahr.parity-rewrite')

    // A code minted for r1 is not a code for r2 — the signature carries the band.
    const other = await post({ band: 2 }, { 'x-anas-confirm': code })
    assert.notEqual(other.statusCode, 202)
  })

  // --- Seventh pass -------------------------------------------------------

  it('F2: a completed REPAIR\'s parity residual is proof enough — no fresh scrub needed', async () => {
    // No scrub on record at all, and the operator still gets the verb: the
    // repair wrote a block, proved it cold against its stored checksum, and saw
    // md still counting the stripe. That IS the measurement.
    jobQueue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'ahr0' } }, async () => ({
      pool: 'ahr0',
      files: [],
      repaired: 1,
      unrepairable: 0,
      aboveMd: 0,
      mappingAbort: 0,
      notExamined: 0,
      parityResiduals: [{ band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 8, level: 'raid5' }],
      blocks: 1,
    }))
    await new Promise(resolve => setImmediate(resolve))
    const res = await post({ band: 1 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.json().error.message.includes('8 mismatch'), res.json().error.message)
  })

  it('F2: …but not from a repair that left blocks unrepaired', async () => {
    jobQueue.submit('ahr.repair', { user: 'u', uid: 0, params: { name: 'ahr0' } }, async () => ({
      pool: 'ahr0',
      files: [],
      repaired: 1,
      unrepairable: 1,
      aboveMd: 0,
      mappingAbort: 0,
      notExamined: 0,
      parityResiduals: [{ band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 8 }],
      blocks: 2,
    }))
    await new Promise(resolve => setImmediate(resolve))
    const res = await post({ band: 1 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'data-findings-present')
  })

  it('F8: 409 bad-blocks-present when a member of the band has recorded bad blocks', async () => {
    await completedScrub(CLEAN_WITH_MISMATCH)
    await writeFile(join(sys, 'rd1/bad_blocks'), '6368 8\n')
    const res = await post({ band: 1 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'bad-blocks-present')
    assert.ok(res.json().error.message.includes('Replace the member first'), res.json().error.message)
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'no bypass — this is not a risk to accept')
  })

  it('the exclusion is mutual: a rewrite blocks a scrub and a repair, and they block it', async () => {
    await completedScrub(CLEAN_WITH_MISMATCH)
    const rewrite = inFlight('ahr.parity-rewrite', 'ahr0')

    const scrub = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: IDENTITY_HEADERS })
    assert.equal(scrub.statusCode, 409)
    assert.ok(scrub.json().error.message.includes('a parity rewrite job is in flight'), scrub.json().error.message)
    assert.ok(scrub.json().error.message.includes(rewrite))

    const repair = await server.inject({
      method: 'POST',
      url: '/v1/ahr/ahr0/repair',
      headers: JSON_HEADERS,
      payload: { files: [{ path: '/mnt/anas-ahr/ahr0/f1.bin', blocks: [300] }] },
    })
    assert.equal(repair.statusCode, 409)
    assert.ok(repair.json().error.message.includes('a parity rewrite is in flight'), repair.json().error.message)

    const blocked = await post({ band: 1 })
    assert.equal(blocked.statusCode, 409)
    assert.equal(blocked.json().error.reason, 'job-active')
  })
})

/**
 * Seventh pass, F10 — the LUN disclosure on the parity-rewrite confirm gate.
 *
 * A rewrite writes no file byte, so a guest's live disk is not a refusal here —
 * it is the fact an operator being asked to agree to hours of whole-band
 * reading cannot discover anywhere else on the screen. (The repair route's
 * matching REFUSAL is in `routes/__tests__/ahr-repair.test.ts`.)
 */
describe('rewriteLunWarnings — the parity-rewrite LUN disclosure (F10)', () => {
  const HELD = {
    targetIqn: 'iqn.2026-08.dev.anas.ahr0:target1',
    index: 1,
    name: 'ahr0_lun1',
    backingPath: '/mnt/anas-ahr/ahr0/images/lun1.raw',
    connectedInitiators: [] as string[],
    detail: 'held by LUN 1',
  }

  it('says nothing when nothing is served from the pool', () => {
    assert.deepEqual(rewriteLunWarnings(null), [])
  })

  it('names the LUN and its live sessions, and says the guest sees nothing this run writes', () => {
    const [line] = rewriteLunWarnings({ ...HELD, connectedInitiators: ['iqn.1993-08.org.debian:01:abc'] })
    assert.match(line, /A guest's disk is live on this pool/)
    assert.match(line, /LUN 1 \('ahr0_lun1'\)/)
    assert.match(line, /1 initiator logged in right now/)
    assert.match(line, /Nothing this run writes is visible to them/)
    assert.match(line, /reading flat out underneath that disk/)
    // It is a disclosure, not a refusal: no verb telling the operator to stop.
    assert.ok(!/refused/i.test(line), line)
  })

  it('an idle LUN still gets the line, with the honest "no initiator" clause', () => {
    const [line] = rewriteLunWarnings(HELD)
    assert.match(line, /No initiator is logged in right now/)
    assert.match(line, /and it writes no file/)
  })

  it('the mirror reconcile discloses it too, and says why a guest sees no change', () => {
    assert.deepEqual(reconcileLunWarnings(null), [])
    const [line] = reconcileLunWarnings({ ...HELD, connectedInitiators: ['iqn.1993-08.org.debian:01:abc'] })
    assert.match(line, /A guest's disk is live on this pool/)
    assert.match(line, /already matches the checksum btrfs stored for it/)
    assert.match(line, /reading both legs flat out/)
    assert.ok(!/refused/i.test(line), line)
  })
})

/**
 * POST /v1/ahr/:name/mirror-reconcile (story selfheal.11) — the confirm-gated
 * mirror band reconcile.
 *
 * Band r2 of the dev mock's `ahr0` IS a RAID1 band (`mdadm-export-r2.txt`,
 * `md126` in mdstat), which is what makes this route testable against the same
 * topology the parity rewrite's tests use — and what lets the two verbs'
 * mutually exclusive gates be asserted against each other for real.
 */
describe('POST /v1/ahr/:name/mirror-reconcile', () => {
  let server: TestServer
  let jobQueue: JobQueue
  let executor: MockExecutor
  let dir: string
  let sys: string

  async function completedScrub(result: unknown, name = 'ahr0'): Promise<void> {
    jobQueue.submit('ahr.scrub', { user: 'u', uid: 0, params: { name } }, async () => result)
    await new Promise(resolve => setImmediate(resolve))
  }

  function inFlight(operation: string, name: string): string {
    return jobQueue.submit(operation, { user: 'u', uid: 0, params: { name } }, async () => new Promise(() => {})).id
  }

  /** The proof: disagreeing legs on the RAID1 band r2, a clean checksum pass. */
  const MIRROR_MISMATCH = {
    scrubbed: 'ahr0',
    btrfsErrors: null,
    checkedArrays: 2,
    parityMismatches: [{ band: 'ahr0-r2', bandIndex: 2, array: '/dev/md/ahr0-r2', mismatchCnt: 128, level: 'raid1' }],
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-mirror-'))
    await writeFile(join(dir, 'fstab'), '# empty\n')
    // A real md sysfs tree for band r2 — a two-leg mirror, GT-16's shape:
    // no rmw_level, no stripe_cache_size, chunk_size 0, layout meaningless.
    sys = join(dir, 'sys/block/md126/md')
    await mkdir(join(sys, 'rd0'), { recursive: true })
    await mkdir(join(sys, 'rd1'), { recursive: true })
    const knobs: Record<string, string> = {
      'level': 'raid1',
      'chunk_size': '0',
      'layout': '0',
      'raid_disks': '2',
      'sync_action': 'idle',
      'last_sync_action': 'check',
      'sync_min': '0',
      'sync_max': 'max',
      'sync_completed': '1046400 / 1046400',
      'mismatch_cnt': '128',
      'degraded': '0',
      'array_state': 'clean',
      'reshape_position': 'none',
      'rd0/offset': '2048',
      'rd0/size': '523200',
      'rd0/state': 'in_sync',
      'rd1/offset': '2048',
      'rd1/size': '523200',
      'rd1/state': 'in_sync',
    }
    for (const [key, value] of Object.entries(knobs))
      await writeFile(join(sys, key), `${value}\n`)
    process.env.ANAS_SELFHEAL_KERNEL_ROOT = dir

    executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mockFixtures.ahrMdstat() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md/ahr0-r2'), result: mockFixtures.ahrMdadmExportR2() })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md/ahr0-r1'), result: mockFixtures.ahrMdadmExportR1() })
    executor.addFixture({ command: '/usr/bin/readlink', args: ['-f', '/dev/md/ahr0-r2'], result: { stdout: '/dev/md126\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/readlink', args: ['-f', '/dev/md/ahr0-r1'], result: { stdout: '/dev/md127\n', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: mockFixtures.ahrLsblk() })
    executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
    executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
    executor.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: mockFixtures.ahrFindmnt() })
    executor.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: mockFixtures.ahrBtrfsUsage() })

    const app = Fastify({ logger: false })
    jobQueue = new JobQueue()
    await app.register(jobRoutes, { prefix: '/v1', jobQueue })
    await app.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
    })
    server = app as unknown as TestServer
  })
  afterEach(async () => {
    delete process.env.ANAS_SELFHEAL_KERNEL_ROOT
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/mirror-reconcile', headers: { ...JSON_HEADERS, ...headers }, payload: body })
  }

  it('400 on a body that names no band, and on a band the pool does not have', async () => {
    await completedScrub(MIRROR_MISMATCH)
    const empty = await post({})
    assert.equal(empty.statusCode, 400)
    assert.equal(empty.json().error.code, 'VALIDATION_ERROR')

    const unknown = await post({ band: 9 })
    assert.equal(unknown.statusCode, 400)
    assert.ok(unknown.json().error.message.includes('no band r9'), unknown.json().error.message)
  })

  it('404 on an unknown pool', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/nope/mirror-reconcile', headers: JSON_HEADERS, payload: { band: 2 } })
    assert.equal(res.statusCode, 404)
  })

  it('409 no-mirror-mismatch when no completed scrub proves anything', async () => {
    const res = await post({ band: 2 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'no-mirror-mismatch')
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'no bypass for "unsafe now"')
  })

  it('409 not-a-mirror-band on a PARITY band — that mismatch has a verb of its own', async () => {
    await completedScrub({
      scrubbed: 'ahr0',
      btrfsErrors: null,
      parityMismatches: [{ band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 8, level: 'raid5' }],
    })
    const res = await post({ band: 1 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'not-a-mirror-band')
    assert.ok(res.json().error.message.includes('Rewrite parity'), res.json().error.message)
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'never becomes true — no bypass')
  })

  it('409 data-findings-present when the same scrub named corrupt files', async () => {
    await completedScrub({ ...MIRROR_MISMATCH, btrfsErrors: 'csum_errors=3' })
    const res = await post({ band: 2 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'data-findings-present')
    assert.ok(res.json().error.message.includes('Repair those files first'), res.json().error.message)
  })

  it('409 array-busy when the band is not idle', async () => {
    await completedScrub(MIRROR_MISMATCH)
    await writeFile(join(sys, 'sync_action'), 'recover\n')
    const res = await post({ band: 2 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'array-busy')
    assert.ok(res.json().error.message.includes('recover'), res.json().error.message)
  })

  it('409 bad-blocks-present when a leg carries recorded md bad blocks', async () => {
    await completedScrub(MIRROR_MISMATCH)
    await writeFile(join(sys, 'rd1/bad_blocks'), '6368 8\n')
    const res = await post({ band: 2 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'bad-blocks-present')
    assert.ok(res.json().error.message.includes('Replace the member first'), res.json().error.message)
  })

  it('409 job-active while a scrub is in flight on the pool', async () => {
    await completedScrub(MIRROR_MISMATCH)
    const running = inFlight('ahr.scrub', 'ahr0')
    const res = await post({ band: 2 })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'job-active')
    assert.ok(res.json().error.message.includes(running), res.json().error.message)
  })

  it('409 confirm with both arms spelled out, then 202 and a job', async () => {
    await completedScrub(MIRROR_MISMATCH)
    const first = await post({ band: 2 })
    assert.equal(first.statusCode, 409)
    const body = first.json()
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(body.error.message.includes('128 disagreeing unit(s)'), body.error.message)
    const warnings: string[] = body.error.warnings
    assert.ok(warnings.some(w => w.includes('Arm A runs an ordinary btrfs checksum scrub')), 'arm A')
    assert.ok(warnings.some(w => w.includes('reads BOTH legs of band r2 in full')), 'arm B')
    assert.ok(warnings.some(w => w.includes('NOCOW')), 'the rows it cannot arbitrate')
    assert.ok(warnings.some(w => w.includes('no single-copy window')), 'the pool stays online')
    assert.ok(warnings.some(w => w.includes('md\'s own repair is NOT used')), 'the invariant is stated')
    assert.ok(warnings.some(w => w.includes('never automatic')), 'never automatic')
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code)

    const second = await post({ band: 2 }, { 'x-anas-confirm': code })
    assert.equal(second.statusCode, 202)
    assert.equal(second.json().job.operation, 'ahr.mirror-reconcile')

    // A code minted for r2 is not a code for r1 — the signature carries the band.
    const other = await post({ band: 1 }, { 'x-anas-confirm': code })
    assert.notEqual(other.statusCode, 202)
  })

  it('the exclusion is mutual: a reconcile blocks a scrub, a repair and a rewrite, and they block it', async () => {
    await completedScrub(MIRROR_MISMATCH)
    const reconcile = inFlight('ahr.mirror-reconcile', 'ahr0')

    const scrub = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: IDENTITY_HEADERS })
    assert.equal(scrub.statusCode, 409)
    assert.ok(scrub.json().error.message.includes(reconcile), scrub.json().error.message)

    const repair = await server.inject({
      method: 'POST',
      url: '/v1/ahr/ahr0/repair',
      headers: JSON_HEADERS,
      payload: { files: [{ path: '/mnt/anas-ahr/ahr0/f1.bin', blocks: [300] }] },
    })
    assert.equal(repair.statusCode, 409)
    assert.ok(repair.json().error.message.includes('a mirror reconcile is in flight'), repair.json().error.message)

    const rewrite = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/parity-rewrite', headers: JSON_HEADERS, payload: { band: 1 } })
    assert.equal(rewrite.statusCode, 409)

    const blocked = await post({ band: 2 })
    assert.equal(blocked.statusCode, 409)
    assert.equal(blocked.json().error.reason, 'job-active')
  })
})

/**
 * Story ident.3 — the destroy doors. A destroy that is queued behind other
 * work, or replayed against a pool recreated under the same name, must act on
 * the pool that was confirmed or not at all; and the expansion intent (keyed
 * by NAME) goes with the pool.
 */
describe('DELETE /v1/ahr/:name — identity doors (ident.3)', () => {
  let dir: string
  let intentDir: string
  let confirmStore: ConfirmStore

  const AHR0_PARTS: [string, 'r1' | 'r2' | null][] = [
    ['ata-WDC_WD2003FZEX-00SRLA0_WD-12345678-part1', 'r1'],
    ['ata-WDC_WD2003FZEX-00SRLA0_WD-23456789-part1', 'r1'],
    ['ata-WDC_WD2003FZEX-00SRLA0_WD-34567890-part1', 'r1'],
    ['ata-WDC_WD2003FZEX-00SRLA0_WD-23456789-part2', 'r2'],
    ['ata-WDC_WD2003FZEX-00SRLA0_WD-34567890-part2', 'r2'],
    ['ata-WDC_WD2003FZEX-00SRLA0_WD-34567890-part3', null],
  ]

  /**
   * The ahr0 world, with band 1's UUID overridable (a recreated pool). With
   * `r1Sequence`, successive `--detail` reads of band 1 answer in turn (the
   * last repeats) — a pool that changes between the confirm and the job.
   */
  function ahr0World(r1Uuid?: string, r1Sequence?: string[]): MockExecutor {
    const executor = new MockExecutor()
    const r1 = mockFixtures.ahrMdadmExportR1()
    const withUuid = (uuid: string) => ({ ...r1, stdout: r1.stdout.replace(/MD_UUID=.*/, `MD_UUID=${uuid}`) })
    const r1Export = r1Uuid ? withUuid(r1Uuid) : r1
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mockFixtures.ahrMdstat() })
    if (r1Sequence)
      executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), results: r1Sequence.map(withUuid) })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: r1Export })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
    for (const [part, band] of AHR0_PARTS) {
      executor.addFixture({
        command: '/usr/sbin/mdadm',
        args: mdadmExamineExportArgs(`/dev/disk/by-id/${part}`),
        result: band === 'r1' ? r1Export : band === 'r2' ? mockFixtures.ahrMdadmExportR2() : { stdout: '', stderr: 'no superblock', exitCode: 1 },
      })
    }
    executor.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: mockFixtures.ahrLsblk() })
    executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
    executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
    executor.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
    executor.addFixture({ command: '/usr/sbin/pvs', args: PVS_ARGS, result: mockFixtures.ahrPvs() })
    executor.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: mockFixtures.ahrFindmnt() })
    executor.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: mockFixtures.ahrBtrfsUsage() })
    for (const command of ['/usr/bin/umount', '/usr/bin/systemctl', '/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/pvremove', '/usr/sbin/sgdisk', '/usr/sbin/update-initramfs', '/usr/sbin/mdadm'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })
    return executor
  }

  async function build(executor: MockExecutor, jobQueue = new JobQueue()): Promise<{ server: TestServer, jobQueue: JobQueue }> {
    const app = Fastify({ logger: false })
    await app.register(jobRoutes, { prefix: '/v1', jobQueue })
    await app.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore,
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
      intentDir,
    })
    return { server: app as unknown as TestServer, jobQueue }
  }

  function intent(state: AhrExpansionIntent['state']): AhrExpansionIntent {
    const cap = { rawBytes: 0, usableBytes: 0, usedBytes: 0, freeBytes: 0, redundancyOverheadBytes: 0, unprotectedWastedBytes: 0, pendingBytes: 0 }
    return { id: randomUUID(), trigger: 'add-disk', approvedDisks: ['ata-x'], before: cap, after: cap, state }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-destroy-doors-'))
    intentDir = join(dir, 'intent')
    confirmStore = new ConfirmStore()
    await writeFile(join(dir, 'fstab'), '# empty\n')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('409 (no confirm code) while ANY ahr.* job is in flight on the pool — `name`- and `pool`-keyed alike', async () => {
    for (const [operation, params] of [['ahr.scrub', { name: 'ahr0' }], ['ahr.spare.add', { pool: 'ahr0', diskId: 'ata-x' }]] as const) {
      const { server, jobQueue } = await build(ahr0World())
      const running = jobQueue.submit(operation, { user: 'u', uid: 0, params }, async () => new Promise(() => {})).id
      const res = await server.inject({ method: 'DELETE', url: '/v1/ahr/ahr0', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 409, res.body)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.ok(res.json().error.message.includes(running), res.json().error.message)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      await server.close()
    }
  })

  it('409 while an expansion is being driven (intent running)', async () => {
    await writeIntent('ahr0', intent('running'), { dir: intentDir })
    const { server } = await build(ahr0World())
    const res = await server.inject({ method: 'DELETE', url: '/v1/ahr/ahr0', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 409)
    assert.match(res.json().error.message, /expansion being driven/)
    await server.close()
  })

  it('a HALTED intent does not block the destroy — and the destroy clears it with the pool', async () => {
    await writeIntent('ahr0', intent('halted'), { dir: intentDir })
    const { server } = await build(ahr0World())
    const first = await server.inject({ method: 'DELETE', url: '/v1/ahr/ahr0', headers: IDENTITY_HEADERS })
    assert.equal(first.statusCode, 409)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    const code = first.headers['x-anas-confirm-code'] as string
    const second = await server.inject({ method: 'DELETE', url: '/v1/ahr/ahr0', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
    assert.equal(second.statusCode, 202, second.body)
    const job = await waitForJob(server, second.json().job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.equal(await readIntent('ahr0', intentDir), null, 'the intent went with the pool')
    await server.close()
  })

  it('the JOB re-reads the pool: one whose arrays changed while the job was queued is not destroyed', async () => {
    const ORIGINAL = '8f425218:8811d919:db5d4baa:f414bbac'
    const RECREATED = '11111111:22222222:33333333:44444444'
    // Two route reads see the original pool; the job's read sees another.
    const executor = ahr0World(undefined, [ORIGINAL, ORIGINAL, RECREATED])
    const { server } = await build(executor)
    const first = await server.inject({ method: 'DELETE', url: '/v1/ahr/ahr0', headers: IDENTITY_HEADERS })
    const code = first.headers['x-anas-confirm-code'] as string
    const second = await server.inject({ method: 'DELETE', url: '/v1/ahr/ahr0', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
    assert.equal(second.statusCode, 202, second.body)
    const job = await waitForJob(server, second.json().job.id)
    assert.equal(job.status, 'failed')
    assert.match(JSON.stringify(job.error), /not the pool that was confirmed/)
    for (const destructive of ['/usr/bin/umount', '/usr/sbin/lvremove', '/usr/sbin/vgremove', '/usr/sbin/sgdisk'])
      assert.ok(!executor.calls.some(c => c.command === destructive), `${destructive} must not run`)
    assert.ok(!executor.calls.some(c => c.command === '/usr/sbin/mdadm' && (c.args[0] === '--stop' || c.args[0] === '--zero-superblock')))
    await server.close()
  })

  it('a confirm code is bound to the pool\'s array UUIDs — it cannot destroy a recreated pool of the same name', async () => {
    const before = await build(ahr0World())
    const first = await before.server.inject({ method: 'DELETE', url: '/v1/ahr/ahr0', headers: IDENTITY_HEADERS })
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    const code = first.headers['x-anas-confirm-code'] as string
    await before.server.close()

    // Same name, same store — but band 1 is a different array now.
    const after = await build(ahr0World('11111111:22222222:33333333:44444444'))
    const replay = await after.server.inject({ method: 'DELETE', url: '/v1/ahr/ahr0', headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code } })
    assert.equal(replay.statusCode, 409, replay.body)
    assert.equal(replay.json().error.code, 'CONFIRMATION_REQUIRED', 'a fresh confirm, never a 202')
    await after.server.close()
  })
})
