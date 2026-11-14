import type { Disk, StatusSummary } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { CommandTimeoutError } from '../../executor/deadline.js'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { JobQueue } from '../../jobs/queue.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { createServer } from '../../server.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { PARTITION_PROBE_ARGS } from '../../services/partition-device.js'
import { collectComposableInventory, collectDiskInventory, DiskInventoryUnreadableError, inventoryUnreadableFor, inventoryUnreadableRefusal } from '../disks.js'
import { poolRoutes } from '../pools.js'
import { capturedRootMountTable } from './pool-guard-reads.js'

/**
 * cr3.pools-disks — the independent re-review's items (2026-11-14).
 *
 * The zpool shapes are OpenZFS 2.4.x's own, read from the source by the
 * reviewer (`/usr/src/zfs-2.4.2`, `-2.4.5`; identical in both):
 *  - `zpool_do_status` (cmd/zpool/zpool_main.c) with `-j` and no pools: exit 0,
 *    stdout `{"output_version":{...},"pools":{}}`, nothing on stderr — the "no
 *    pools available" line is printed only WITHOUT `-j`;
 *  - `zpool_do_list` with `-j` and no pools: exit 0, nothing printed;
 *  - `zpool_do_import` with nothing importable: exit 0, empty stdout, "no pools
 *    available to import" on stderr;
 *  - `libzfs_init` failing (lib/libzfs/os/linux/libzfs_util_os.c,
 *    `libzfs_error_init`, printed by zpool_main.c as `fprintf(stderr,
 *    "%s\n", ...); return (1);`): exit 1, nothing on stdout, the first stderr
 *    line one of "The ZFS modules cannot be auto-loaded." (ENOEXEC — modprobe
 *    failed, the likely one on a node without ZFS), "The ZFS modules are not
 *    loaded." (ENXIO), "/dev/zfs and /proc/self/mounts are required."
 *    (ENOENT). Re-review 2: that is "ZFS is not available" only when
 *    `/sys/module/zfs` is ALSO absent (`test -d` exits 1); with the module
 *    present the same output is a failed read.
 */

const ZPOOL = '/usr/sbin/zpool'
const HERE = dirname(fileURLToPath(import.meta.url))

const r = (exitCode: number, stdout: string, stderr = ''): ExecResult => ({ stdout, stderr, exitCode })

/** `zpool_do_status` -j, no pools. */
export const STATUS_NO_POOLS = r(0, '{"output_version":{"command":"zpool status","vers_major":0,"vers_minor":1},"pools":{}}\n')
/** `zpool_do_list` -j, no pools. */
export const LIST_NO_POOLS = r(0, '')

/** libzfs_init's three refusals, with libzfs's own second line where it prints one. */
const NO_ZFS: [string, ExecResult | 'ENOENT'][] = [
  ['the module cannot be auto-loaded (ENOEXEC)', r(1, '', 'The ZFS modules cannot be auto-loaded.\nTry running \'modprobe zfs\' as root to manually load them.\n')],
  ['the module is not loaded (ENXIO)', r(1, '', 'The ZFS modules are not loaded.\nTry running \'modprobe zfs\' as root to load them.\n')],
  ['/dev/zfs and /proc/self/mounts missing (ENOENT)', r(1, '', '/dev/zfs and /proc/self/mounts are required.\nTry running \'udevadm trigger\' and \'mount -t proc proc /proc\' as root.\n')],
  ['zpool not installed (spawn ENOENT)', 'ENOENT'],
]

const enoent = (): Error => Object.assign(new Error(`spawn ${ZPOOL} ENOENT`), { code: 'ENOENT', path: ZPOOL })
/** `test -d /sys/module/zfs`: 1 = no zfs module on the node, 0 = loaded. */
const MODULE_CHECK = { command: '/usr/bin/test', args: ['-d', '/sys/module/zfs'] }
const NO_MODULE = { ...MODULE_CHECK, result: r(1, '') }
const MODULE_LOADED = { ...MODULE_CHECK, result: r(0, '') }

function headers(json = false) {
  return {
    'x-anas-user': 'root@pam',
    'x-anas-user-uid': '0',
    'x-anas-privileges': 'Sys.Audit,Sys.Modify',
    'x-anas-request-id': randomUUID(),
    ...(json ? { 'content-type': 'application/json' } : {}),
  }
}

/** One blank disk sdb; the zpool answer given; no LIO. */
function blankWorld(zpool: ExecResult | 'ENOENT', byId: ExecResult = r(0, 'lrwxrwxrwx 1 root root 9 Nov 14 10:00 ata-BLANK_B1 -> ../../sdb\n')): MockExecutor {
  const ex = new MockExecutor()
  ex.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: r(0, JSON.stringify({ blockdevices: [{ 'name': 'sdb', 'type': 'disk', 'size': 1073741824, 'model': 'BLANK', 'serial': 'B1', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 512, 'log-sec': 512, 'wwn': null, 'vendor': null, 'rev': null }] })) })
  ex.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: byId })
  for (const args of [['status', '-jv'], ['list', '-j']]) {
    ex.addFixture(zpool === 'ENOENT'
      ? { command: ZPOOL, args, result: r(0, ''), throws: enoent() }
      : { command: ZPOOL, args, result: zpool })
  }
  ex.addFixture({ command: '/usr/bin/cat', result: r(0, 'Personalities :\nunused devices: <none>\n') })
  ex.addFixture(NO_MODULE)
  return ex
}

const NO_LIO = { configfsRoot: '/nonexistent-anas-cr3', saveconfigPath: '/nonexistent-anas-cr3' }

describe('cr3 re-review 1 — a node without ZFS: no pools, disks available, ZFS verbs refuse with the statement', () => {
  it('control: the source shape of a pool-less node (status `pools:{}`, list prints nothing) keeps the blank disk available', async () => {
    const ex = blankWorld(STATUS_NO_POOLS)
    ex.prependFixture({ command: ZPOOL, args: ['list', '-j'], result: LIST_NO_POOLS })
    const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO)
    assert.equal(inv.zfsUnreadable, undefined)
    assert.equal(inv.disks[0].status, 'available')
  })

  for (const [label, answer] of NO_ZFS) {
    it(`${label}: the inventory answers "no pools" — the blank disk stays available`, async () => {
      const ex = blankWorld(answer)
      const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO)
      assert.equal(inv.zfsUnreadable, undefined)
      assert.equal(inv.disks[0].status, 'available')
    })

    it(`${label}: GET /pools is [] with zfsUnavailable; /status has no pool or disk card; DELETE and create refuse 409 zfs-unavailable`, async () => {
      const server = createServer({ mock: true, logger: false })
      const mock = (server as unknown as { executor: MockExecutor }).executor
      for (const args of [['status', '-jv'], ['list', '-j'], ['upgrade']]) {
        mock.prependFixture(answer === 'ENOENT'
          ? { command: ZPOOL, args, result: r(0, ''), throws: enoent() }
          : { command: ZPOOL, args, result: answer })
      }
      mock.prependFixture(NO_MODULE)
      try {
        const pools = await server.inject({ method: 'GET', url: '/v1/pools', headers: headers() })
        assert.equal(pools.statusCode, 200, pools.body)
        const body = pools.json() as { data: unknown[], zfsUnavailable?: string }
        assert.deepEqual(body.data, [])
        assert.match(body.zfsUnavailable ?? '', /^ZFS is not available on this node/)

        const status = (await server.inject({ method: 'GET', url: '/v1/status', headers: headers() })).json() as { data: StatusSummary }
        assert.deepEqual(status.data.pools, [])
        assert.match(status.data.zfsUnavailable ?? '', /^ZFS is not available on this node/)
        assert.ok(!status.data.unavailable?.includes('pools'), JSON.stringify(status.data.unavailable))
        assert.ok(!status.data.unavailable?.includes('disks'), JSON.stringify(status.data.unavailable))

        const del = await server.inject({ method: 'DELETE', url: '/v1/pools/testpool', headers: headers() })
        assert.equal(del.statusCode, 409, del.body)
        assert.equal((del.json() as { error: { reason: string } }).error.reason, 'zfs-unavailable')

        const disks = ((await server.inject({ method: 'GET', url: '/v1/disks', headers: headers() })).json() as { data: Disk[] }).data
        const free = disks.filter(d => d.status === 'available').map(d => d.id).slice(0, 2)
        assert.ok(!disks.some(d => d.status === 'unknown'), 'no disk reads unknown')
        const create = await server.inject({ method: 'POST', url: '/v1/pools', headers: headers(true), payload: JSON.stringify({ name: 'newz', dataVdevs: [{ type: 'stripe', disks: free.length > 0 ? free : ['ata-NONE'] }] }) })
        assert.ok(!create.body.includes('status: unknown'), create.body)
        if (free.length > 0) {
          assert.equal(create.statusCode, 409, create.body)
          assert.equal((create.json() as { error: { reason: string } }).error.reason, 'zfs-unavailable')
        }
        if (free.length > 0) {
          const preview = await server.inject({ method: 'POST', url: '/v1/ahr/layout/preview', headers: headers(true), payload: JSON.stringify({ tier: 'ahr1', disks: free }) })
          assert.ok(!preview.body.includes('status: unknown'), `AHR preview: ${preview.body}`)
        }
      }
      finally {
        await server.close()
      }
    })
  }
})

describe('cr3 re-review 2 (item 3) — libzfs\'s sentence with the zfs module LOADED is a failed read, not "no ZFS"', () => {
  for (const [label, answer] of NO_ZFS.filter(([, a]) => a !== 'ENOENT') as [string, ExecResult][]) {
    it(`${label}, /sys/module/zfs present: the inventory is unreadable, GET /pools 503`, async () => {
      const ex = blankWorld(answer)
      ex.prependFixture(MODULE_LOADED)
      const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO)
      assert.ok(inv.zfsUnreadable, 'unreadable, never "no pools"')
      assert.equal(inv.disks[0].status, 'unknown')

      const server = createServer({ mock: true, logger: false })
      const mock = (server as unknown as { executor: MockExecutor }).executor
      for (const args of [['status', '-jv'], ['list', '-j'], ['upgrade']])
        mock.prependFixture({ command: ZPOOL, args, result: answer })
      mock.prependFixture(MODULE_LOADED)
      try {
        const pools = await server.inject({ method: 'GET', url: '/v1/pools', headers: headers() })
        assert.equal(pools.statusCode, 503, pools.body)
      }
      finally {
        await server.close()
      }
    })
  }

  it('the module check itself unanswered (not exit 1) is a failed read too', async () => {
    const ex = blankWorld(NO_ZFS[0][1] as ExecResult)
    ex.prependFixture({ ...MODULE_CHECK, result: r(2, '', 'test: something odd\n') })
    const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO)
    assert.ok(inv.zfsUnreadable)
  })
})

describe('cr3 re-review 2 — the composability helpers the AHR doors call', () => {
  it('collectComposableInventory throws the typed unreadable when status failed; the refusal is 409 unreadable', async () => {
    const ex = blankWorld(r(1, '', 'internal error: Bad file descriptor\n'))
    await assert.rejects(collectComposableInventory(ex, new DiskIdentityCache(ex), ['ata-BLANK_B1'], NO_LIO), (err: unknown) => {
      assert.ok(err instanceof DiskInventoryUnreadableError)
      assert.match(err.reason, /could not tell pool members from free disks/)
      assert.deepEqual(inventoryUnreadableRefusal(err.reason), { status: 409, code: 'CONFLICT', reason: 'unreadable', message: `${err.reason}; refusing a disk it cannot judge` })
      return true
    })
  })

  it('control: a readable inventory is returned as the disk list', async () => {
    const ex = blankWorld(STATUS_NO_POOLS)
    const disks = await collectComposableInventory(ex, new DiskIdentityCache(ex), ['ata-BLANK_B1'], NO_LIO)
    assert.equal(disks[0].status, 'available')
    assert.equal(inventoryUnreadableFor(await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO), ['ata-BLANK_B1']), null)
  })
})

describe('cr3 re-review 3 — a by-id listing that could not be read makes membership unknown', () => {
  it('a failed listing: the blank-looking disk is unknown, never available; an ABSENT directory is the honest empty', async () => {
    const failed = blankWorld(STATUS_NO_POOLS, r(2, '', 'ls: reading directory \'/dev/disk/by-id/\': Input/output error\n'))
    const inv = await collectDiskInventory(failed, new DiskIdentityCache(failed), NO_LIO)
    assert.match(inv.byIdUnreadable ?? '', /\/dev\/disk\/by-id\/ listing could not be read \(ls exited 2: ls: reading directory/)
    assert.equal(inv.disks[0].status, 'unknown')
    assert.equal(inv.disks[0].healthStatus, 'unknown')

    const absent = blankWorld(STATUS_NO_POOLS, r(2, '', 'ls: cannot access \'/dev/disk/by-id/\': No such file or directory\n'))
    const inv2 = await collectDiskInventory(absent, new DiskIdentityCache(absent), NO_LIO)
    assert.equal(inv2.byIdUnreadable, undefined)
    assert.equal(inv2.disks[0].status, 'available')
  })

  it('a FAULTED by-id member reads unknown (never healthy) and a create naming it is 409 unreadable when the listing failed', async () => {
    const server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.prependFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: r(2, '', 'ls: reading directory \'/dev/disk/by-id/\': Input/output error\n') })
    try {
      const disks = ((await server.inject({ method: 'GET', url: '/v1/disks', headers: headers() })).json() as { data: Disk[] }).data
      assert.ok(!disks.some(d => d.status === 'available'), disks.map(d => `${d.name}:${d.status}`).join(' '))
      const id = disks.find(d => d.status === 'unknown')!.id
      const create = await server.inject({ method: 'POST', url: '/v1/pools', headers: headers(true), payload: JSON.stringify({ name: 'newz', dataVdevs: [{ type: 'stripe', disks: [id] }] }) })
      assert.equal(create.statusCode, 409, create.body)
      assert.equal((create.json() as { error: { reason: string } }).error.reason, 'unreadable')
    }
    finally {
      await server.close()
    }
  })
})

/** A live LIO tree (the captured manifest), with the iSCSI read made to fail through its zfs seam. */
async function lioThatFails(err: Error): Promise<{ paths: Record<string, unknown>, cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'anas-cr3-lio-'))
  const root = join(dir, 'target')
  await materializeConfigfsManifest(readFileSync(join(HERE, '../../fixtures/iscsi/configfs-live.manifest'), 'utf-8'), root)
  return {
    paths: {
      configfsRoot: root,
      saveconfigPath: join(HERE, '../../fixtures/iscsi/saveconfig-final.json'),
      blockRoot: join(dir, 'block'),
      pveStorageCfg: join(dir, 'absent-storage.cfg'),
      zfsMountpoints: () => Promise.reject(err),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** An iSCSI-transport disk sdz (serial ISCSI1) beside the blank sata sdb. */
function iscsiDiskWorld(): MockExecutor {
  const ex = blankWorld(STATUS_NO_POOLS)
  ex.prependFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: r(0, JSON.stringify({ blockdevices: [
    { 'name': 'sdb', 'type': 'disk', 'size': 1073741824, 'model': 'BLANK', 'serial': 'B1', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 512, 'log-sec': 512, 'wwn': null, 'vendor': null, 'rev': null },
    { 'name': 'sdz', 'type': 'disk', 'size': 1073741824, 'model': 'lun0', 'serial': 'ISCSI1', 'tran': 'iscsi', 'fstype': null, 'mountpoint': null, 'rota': false, 'phy-sec': 512, 'log-sec': 512, 'wwn': null, 'vendor': 'LIO-ORG', 'rev': null, 'children': [{ name: 'sdz1', type: 'part', size: 1000000000, fstype: null, mountpoint: null }] },
  ] })) })
  ex.prependFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: r(0, 'lrwxrwxrwx 1 root root 9 Nov 14 10:00 ata-BLANK_B1 -> ../../sdb\nlrwxrwxrwx 1 root root 9 Nov 14 10:00 scsi-ISCSI1 -> ../../sdz\nlrwxrwxrwx 1 root root 10 Nov 14 10:00 scsi-ISCSI1-part1 -> ../../sdz1\n') })
  return ex
}

describe('cr3 re-review 7 — a hung LIO read marks iSCSI disks unverified; it never fails the inventory', () => {
  it('a timeout in the served-serials read: the inventory answers, the iSCSI disk is iscsi-unverified, the sata disk untouched', async () => {
    const lio = await lioThatFails(new CommandTimeoutError('/usr/sbin/zfs', ['list'], 'request', 10_000, false))
    try {
      const ex = iscsiDiskWorld()
      const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), lio.paths)
      assert.match(inv.servedSerialsUnreadable ?? '', /did not finish within/)
      assert.equal(inv.disks.find(d => d.name === 'sdz')?.handsOff, 'iscsi-unverified')
      assert.equal(inv.disks.find(d => d.name === 'sdb')?.handsOff, undefined)
    }
    finally {
      lio.cleanup()
    }
  })
})

describe('cr3 re-review 6 — a partition on an iscsi-unverified disk is 409 unreadable, not a 400', () => {
  it('attach of scsi-ISCSI1-part1 while this node\'s LUNs could not be read', async () => {
    const lio = await lioThatFails(new Error('configfs read failed'))
    const ex = iscsiDiskWorld()
    const POOL = 'tank'
    ex.prependFixture({ command: ZPOOL, args: ['list', '-j'], result: r(0, JSON.stringify({ pools: { [POOL]: { name: POOL, state: 'ONLINE', properties: {} } } })) })
    ex.prependFixture({ command: ZPOOL, args: ['status', '-jv'], result: r(0, JSON.stringify({ pools: { [POOL]: { name: POOL, state: 'ONLINE', pool_guid: '7', error_count: '0', vdevs: { [POOL]: { name: POOL, vdev_type: 'root', state: 'ONLINE', vdevs: {
      'ata-BLANK_B1': { name: 'ata-BLANK_B1', vdev_type: 'disk', state: 'ONLINE', path: '/dev/disk/by-id/ata-BLANK_B1', devid: 'ata-BLANK_B1' },
    } } } } } })) })
    ex.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', POOL], result: r(0, '7\n') })
    ex.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: r(0, `${POOL}\t-\n`) })
    ex.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: r(0, capturedRootMountTable()) })
    ex.addFixture({ command: '/usr/bin/lsblk', args: [...PARTITION_PROBE_ARGS, '/dev/disk/by-id/scsi-ISCSI1-part1'], result: r(0, JSON.stringify({ blockdevices: [{ name: 'sdz1', type: 'part', pkname: 'sdz', mountpoint: null }] })) })
    ex.addFixture({ command: '/usr/sbin/blkid', result: r(2, '/dev/sdz1: PART_ENTRY_SCHEME="gpt"\n') })
    const server = Fastify({ logger: false })
    await server.register(poolRoutes, { prefix: '/v1', executor: ex, jobQueue: new JobQueue(), confirmStore: new ConfirmStore(), iscsiPaths: lio.paths, diskIdentityCache: new DiskIdentityCache(ex) } as never)
    try {
      const res = await server.inject({ method: 'POST', url: `/v1/pools/${POOL}/attach`, headers: headers(true), payload: JSON.stringify({ existingDiskId: 'ata-BLANK_B1', newDiskId: 'scsi-ISCSI1-part1' }) })
      assert.equal(res.statusCode, 409, res.body)
      const { error } = res.json() as { error: { reason: string, message: string } }
      assert.equal(error.reason, 'unreadable')
      assert.match(error.message, /could not be checked against this node's own LUNs/)
    }
    finally {
      await server.close()
      lio.cleanup()
    }
  })
})

describe('cr3 re-review 8 — an OFFLINE kernel-named leaf never claims the disk that now holds its name', () => {
  it('zpool offline, swap, before zpool replace: the blank replacement under the old name reads available', async () => {
    const ex = new MockExecutor()
    const disk = (name: string, serial: string, children?: unknown[]) => ({ 'name': name, 'type': 'disk', 'size': 4e12, 'model': serial, 'serial': serial, 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 4096, 'log-sec': 512, 'wwn': null, 'vendor': null, 'rev': null, ...(children && { children }) })
    ex.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: r(0, JSON.stringify({ blockdevices: [disk('sdb', 'NEW1'), disk('sdc', 'MATE1', [{ name: 'sdc1', type: 'part', size: 4e12, fstype: 'zfs_member', mountpoint: null }])] })) })
    ex.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: r(0, ['ata-NEW -> ../../sdb', 'ata-MATE -> ../../sdc', 'ata-MATE-part1 -> ../../sdc1'].map(l => `lrwxrwxrwx 1 root root 9 Nov 14 10:00 ${l}`).join('\n')) })
    ex.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: r(0, JSON.stringify({ pools: { tank: { name: 'tank', state: 'DEGRADED', pool_guid: '9', error_count: '0', vdevs: { tank: { name: 'tank', vdev_type: 'root', state: 'DEGRADED', vdevs: {
      'mirror-0': { name: 'mirror-0', vdev_type: 'mirror', state: 'DEGRADED', vdevs: {
        sdb1: { name: 'sdb1', vdev_type: 'disk', state: 'OFFLINE', path: '/dev/sdb1', devid: 'ata-OLD-part1' },
        sdc1: { name: 'sdc1', vdev_type: 'disk', state: 'ONLINE', path: '/dev/sdc1', devid: 'ata-MATE-part1' },
      } },
    } } } } } })) })
    ex.addFixture({ command: '/usr/bin/cat', result: r(0, 'Personalities :\nunused devices: <none>\n') })
    const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO)
    const fresh = inv.disks.find(d => d.name === 'sdb')!
    assert.equal(fresh.status, 'available')
    assert.equal(fresh.poolName, null)
    assert.equal(inv.disks.find(d => d.name === 'sdc')?.poolName, 'tank')
  })
})
