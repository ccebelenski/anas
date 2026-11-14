import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { poolRoutes } from '../../routes/pools.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { loadPveFootprint } from '../pve-footprint.js'

/**
 * cr3.pools-disks — POOLS-DISKS-H1 (and the shares review's SHARES-M4, the
 * same root): a failed `zfs list` used to drop every PVE `dir` storage from
 * the footprint, so the pool-level PVE gate opened and DELETE /pools/tank
 * reached the ordinary destroy confirm. A missing fact may only tighten.
 */

const CFG = 'dir: local\n\tpath /var/lib/vz\n\tcontent iso,vztmpl,backup\n\ndir: tank-backup\n\tpath /tank/backup\n\tcontent backup,images\n'

/** /var/lib/vz on the ext4 root; tank and tank/backup mounted from ZFS. */
const MOUNTS = JSON.stringify({ filesystems: [{ target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw', children: [
  { target: '/tank', source: 'tank', fstype: 'zfs', options: 'rw,xattr,noacl', children: [{ target: '/tank/backup', source: 'tank/backup', fstype: 'zfs', options: 'rw,xattr,noacl' }] },
] }] })

const ZFS_LIST_ARGS = ['list', '-H', '-o', 'name,mountpoint']
const ZFS_LIST_OK = { stdout: 'tank\t/tank\ntank/backup\t/tank/backup\n', stderr: '', exitCode: 0 }
const ZFS_LIST_FAILED = { stdout: '', stderr: 'cannot iterate filesystems: I/O error', exitCode: 1 }
const FINDMNT_FAILED = { stdout: '', stderr: 'findmnt: can\'t read /proc/self/mountinfo', exitCode: 1 }

function world(zfsList: typeof ZFS_LIST_OK, findmnt: { stdout: string, stderr: string, exitCode: number }): MockExecutor {
  const ex = new MockExecutor()
  ex.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: { stdout: JSON.stringify({ pools: { tank: { name: 'tank', state: 'ONLINE', properties: {} } } }), stderr: '', exitCode: 0 } })
  ex.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'value', 'guid', '--', 'tank'], result: { stdout: '123\n', stderr: '', exitCode: 0 } })
  ex.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'tank\t-\n', stderr: '', exitCode: 0 } })
  ex.addFixture({ command: '/usr/bin/findmnt', args: ['-n', '-o', 'SOURCE,FSTYPE', '/'], result: { stdout: '/dev/mapper/pve-root ext4\n', stderr: '', exitCode: 0 } })
  ex.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: findmnt })
  ex.addFixture({ command: '/usr/sbin/zfs', args: ZFS_LIST_ARGS, result: zfsList })
  return ex
}

describe('cr3 — a failed `zfs list` never drops a PVE dir storage from the footprint (POOLS-DISKS-H1)', () => {
  let dir: string
  let cfg: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-footprint-'))
    cfg = join(dir, 'storage.cfg')
    await writeFile(cfg, CFG)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function destroy(ex: MockExecutor): Promise<{ status: number, code?: string, reason?: string, message?: string }> {
    const server = Fastify({ logger: false })
    await server.register(poolRoutes, { prefix: '/v1', executor: ex, jobQueue: new JobQueue(), confirmStore: new ConfirmStore(), pveStoragePath: cfg })
    const r = await server.inject({ method: 'DELETE', url: '/v1/pools/tank', headers: { 'x-anas-user': 'root@pam', 'x-anas-user-uid': '0', 'x-anas-privileges': 'Sys.Audit,Sys.Modify', 'x-anas-request-id': randomUUID() } })
    await server.close()
    const b = r.json() as { error?: { code?: string, reason?: string, message?: string } }
    return { status: r.statusCode, code: b.error?.code, reason: b.error?.reason, message: b.error?.message }
  }

  it('control: zfs list answers — DELETE /pools/tank is 409 PVE_MANAGED naming the dir storage', async () => {
    const r = await destroy(world(ZFS_LIST_OK, { stdout: MOUNTS, stderr: '', exitCode: 0 }))
    assert.equal(r.status, 409)
    assert.equal(r.code, 'PVE_MANAGED')
    assert.match(r.message!, /tank-backup/)
  })

  it('zfs list failed, the mount table readable: the live mount places the dir storage — still 409 PVE_MANAGED (the review probe)', async () => {
    const r = await destroy(world(ZFS_LIST_FAILED, { stdout: MOUNTS, stderr: '', exitCode: 0 }))
    assert.equal(r.status, 409)
    assert.equal(r.code, 'PVE_MANAGED')
    assert.match(r.message!, /tank-backup/)
  })

  it('zfs list AND the mount table failed: every pool answers as for an unreadable config — refused, never the destroy confirm', async () => {
    const r = await destroy(world(ZFS_LIST_FAILED, FINDMNT_FAILED))
    assert.equal(r.status, 409)
    assert.notEqual(r.code, 'CONFIRMATION_REQUIRED')
    const ex = world(ZFS_LIST_FAILED, FINDMNT_FAILED)
    const fp = await loadPveFootprint(ex, { pveStorageCfg: cfg })
    assert.equal(fp.storagesUnavailable, true)
    assert.match(fp.storagesUnavailableCause!, /zfs list failed/)
    assert.match(fp.storagesUnavailableCause!, /'tank-backup' \(\/tank\/backup\)/)
    const owned = fp.ownershipOf('anotherpool')
    assert.equal(owned?.kind, 'config-unreadable', 'every pool, not only the one the path names')
    assert.match(owned!.reason, /zfs list failed/)
    assert.equal(fp.isSystemPool('anotherpool'), true)
  })

  it('a dir storage the mount table proves non-ZFS (/var/lib/vz on ext4) blinds nothing', async () => {
    await writeFile(cfg, 'dir: local\n\tpath /var/lib/vz\n\tcontent iso,vztmpl,backup\n')
    const fp = await loadPveFootprint(world(ZFS_LIST_FAILED, { stdout: MOUNTS, stderr: '', exitCode: 0 }), { pveStorageCfg: cfg })
    assert.equal(fp.storagesUnavailable, false)
    assert.equal(fp.ownershipOf('tank'), null)
  })

  it('a storage.cfg with no dir stanza is not blinded by a failed zfs list (zfspool refs need no mountpoint)', async () => {
    await writeFile(cfg, 'zfspool: tank-vm\n\tpool tank/vm\n\tcontent images,rootdir\n')
    const fp = await loadPveFootprint(world(ZFS_LIST_FAILED, FINDMNT_FAILED), { pveStorageCfg: cfg })
    assert.equal(fp.storagesUnavailable, false)
    assert.ok(fp.storagesByPool.get('tank')?.some(r => r.storage === 'tank-vm'))
  })
})

describe('cr3 — the share-path backstop says "cannot see", never "no claim", when it could not look (SHARES-M4 root)', () => {
  let dir: string
  let cfg: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-sharepath-'))
    cfg = join(dir, 'storage.cfg')
    await writeFile(cfg, 'zfspool: tank-vm\n\tpool tank/vm\n\tcontent images,rootdir\n')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('zfs list and findmnt failed: a path on a PVE guest subvol is cannot-see, and sharePathClaim refuses it fail-closed', async () => {
    const fp = await loadPveFootprint(world(ZFS_LIST_FAILED, FINDMNT_FAILED), { pveStorageCfg: cfg })
    const path = '/tank/vm/subvol-100-disk-0'
    const verdict = fp.sharePathVerdict(path)
    assert.equal(verdict.kind, 'cannot-see')
    assert.match((verdict as { reason: string }).reason, /zfs list failed/)
    const claim = fp.sharePathClaim(path)
    assert.ok(claim, 'never null — null is "no claim"')
    assert.equal(claim.kind, 'dataset')
    assert.equal((claim as { ownership: { kind: string } }).ownership.kind, 'config-unreadable')
    const ds = fp.datasetOfPathVerdict(path)
    assert.ok('unreadable' in ds)
  })

  it('zfs list failed but the mount table proves the path non-ZFS: no-claim (caveat emptor, a reading)', async () => {
    const fp = await loadPveFootprint(world(ZFS_LIST_FAILED, { stdout: MOUNTS, stderr: '', exitCode: 0 }), { pveStorageCfg: cfg })
    assert.deepEqual(fp.sharePathVerdict('/srv/share'), { kind: 'no-claim' })
    assert.equal(fp.sharePathClaim('/srv/share'), null)
    assert.deepEqual(fp.datasetOfPathVerdict('/srv/share'), { dataset: null })
  })

  it('control: everything read — a path on an ANAS dataset is no-claim, on the guest subvol a claim', async () => {
    const ex = world({ stdout: 'tank\t/tank\ntank/vm\t/tank/vm\ntank/vm/subvol-100-disk-0\t/tank/vm/subvol-100-disk-0\ntank/media\t/tank/media\n', stderr: '', exitCode: 0 }, { stdout: MOUNTS, stderr: '', exitCode: 0 })
    const fp = await loadPveFootprint(ex, { pveStorageCfg: cfg })
    assert.deepEqual(fp.sharePathVerdict('/tank/media'), { kind: 'no-claim' })
    assert.equal(fp.sharePathVerdict('/tank/vm/subvol-100-disk-0').kind, 'claim')
  })
})
