import type { Job } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { createServer } from '../../server.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrMutationRoutes } from '../ahr-mutate.js'
import { jobRoutes } from '../jobs.js'

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
const UUID_R1 = 'aaaaaaaa:bbbbbbbb:cccccccc:dddddddd'

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
    assert.deepEqual(job.result, { scrubbed: 'ahr0', btrfsErrors: null, checkedArrays: 2 })
  })
})

describe('POST /v1/ahr — create success path (controlled inventory)', () => {
  let server: TestServer
  let executor: MockExecutor
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-create-route-'))
    await writeFile(join(dir, 'fstab'), '# empty\n')

    executor = new MockExecutor()
    // Inventory: two genuinely blank disks (status 'available').
    const lsblk = {
      blockdevices: [
        { 'name': 'sdx', 'type': 'disk', 'size': 2 * GIB, 'model': 'BLANK SM', 'serial': 'A', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 4096, 'log-sec': 512 },
        { 'name': 'sdy', 'type': 'disk', 'size': 3 * GIB, 'model': 'BLANK BG', 'serial': 'B', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 4096, 'log-sec': 512 },
      ],
    }
    executor.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: { stdout: JSON.stringify(lsblk), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: {
      stdout: [
        `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${BLANK_SMALL} -> ../../sdx`,
        `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${BLANK_BIG} -> ../../sdy`,
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } })
    executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 0 } })
    // The create job's commands.
    for (const command of ['/usr/sbin/wipefs', '/usr/sbin/sgdisk', '/usr/bin/udevadm', '/usr/sbin/pvcreate', '/usr/sbin/vgcreate', '/usr/sbin/lvcreate', '/usr/sbin/mkfs.btrfs', '/usr/bin/btrfs', '/usr/sbin/update-initramfs', '/usr/bin/systemctl', '/usr/bin/mount', '/usr/bin/umount', '/usr/bin/perl', '/usr/sbin/mdadm'])
      executor.addFixture({ command, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md/tpool-r1'], result: { stdout: `MD_NAME=tpool-r1\nMD_UUID=${UUID_R1}\n`, stderr: '', exitCode: 0 } })

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

  it('409 confirm listing EVERY disk (id + model + size), then 202 and the built pool', async () => {
    const payload = JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_SMALL, BLANK_BIG] })

    const first = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload })
    assert.equal(first.statusCode, 409)
    const body = first.json()
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(body.error.message.includes('WIPE'))
    assert.equal(body.error.warnings.length, 2)
    assert.ok(body.error.warnings.some((w: string) => w.includes(BLANK_SMALL) && w.includes('BLANK SM') && w.includes('2.0 GiB')))
    assert.ok(body.error.warnings.some((w: string) => w.includes(BLANK_BIG) && w.includes('BLANK BG') && w.includes('3.0 GiB')))
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
    assert.ok(fstab.includes(`/dev/tpool/tpool-vol ${join(dir, 'mnt', 'tpool')} btrfs nofail,subvol=@data 0 0`))
    const conf = await readFile(join(dir, 'mdadm.conf'), 'utf8')
    assert.ok(conf.includes('/dev/md/tpool-r1') && conf.includes(UUID_R1))
  })

  it('minimum-disk rule: a 1-disk selection is rejected before any gate', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'tpool', tier: 'ahr1', disks: [BLANK_SMALL] }) })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.ok(res.json().error.message.includes('at least 2 disks'))
  })
})
