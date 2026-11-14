import type { MockExecutor as MockExecutorType } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { isComposableDisk } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { parseZfsVersion } from '../../parsers/zfs-version.js'
import { createServer } from '../../server.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { collectDisks, resolveLeafKernel } from '../disks.js'
import { serveBlankInventoryDisks } from './inventory-stub.js'

/**
 * cr3.pools-disks — leaf-to-disk identity and the composability pre-flight.
 */

const NO_LIO = { configfsRoot: '/nonexistent-anas-cr3', saveconfigPath: '/nonexistent-anas-cr3' }

/**
 * POOLS-DISKS-M7 (the review probe): a pool built on kernel names (`/dev/sdb1`)
 * loses its disk; ZFS keeps the leaf UNAVAIL with its old devid and its old
 * kernel path; a NEW blank disk comes up as `sdb`. The ZFS output premise is
 * the reviewer's (unverified on a node: see the report's "Needs the node").
 */
function staleKernelLeafWorld(leafState: 'UNAVAIL' | 'ONLINE'): MockExecutorType {
  const ex = new MockExecutor()
  const disk = (name: string, model: string, serial: string, children?: unknown[]) => ({
    'name': name,
    'type': 'disk',
    'size': 4e12,
    'model': model,
    'serial': serial,
    'tran': 'sata',
    'fstype': null,
    'mountpoint': null,
    'rota': true,
    'phy-sec': 4096,
    'log-sec': 512,
    'wwn': null,
    'vendor': null,
    'rev': null,
    ...(children && { children }),
  })
  ex.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: { stdout: JSON.stringify({ blockdevices: [
    disk('sdb', 'NEW', 'NEW1'),
    disk('sdc', 'MATE', 'MATE1', [{ name: 'sdc1', type: 'part', size: 4e12, fstype: 'zfs_member', mountpoint: null }]),
  ] }), stderr: '', exitCode: 0 } })
  ex.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: [
    'lrwxrwxrwx 1 root root 9 Nov 14 10:00 ata-NEW -> ../../sdb',
    'lrwxrwxrwx 1 root root 9 Nov 14 10:00 ata-MATE -> ../../sdc',
    'lrwxrwxrwx 1 root root 10 Nov 14 10:00 ata-MATE-part1 -> ../../sdc1',
  ].join('\n'), stderr: '', exitCode: 0 } })
  ex.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-partuuid/'], result: { stdout: '', stderr: '', exitCode: 0 } })
  ex.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: JSON.stringify({ pools: { tank: { name: 'tank', state: 'DEGRADED', pool_guid: '9', error_count: '0', vdevs: { tank: { name: 'tank', vdev_type: 'root', state: 'DEGRADED', vdevs: {
    'mirror-0': { name: 'mirror-0', vdev_type: 'mirror', state: 'DEGRADED', vdevs: {
      sdb1: { name: 'sdb1', vdev_type: 'disk', state: leafState, path: '/dev/sdb1', devid: 'ata-OLD-part1' },
      sdc1: { name: 'sdc1', vdev_type: 'disk', state: 'ONLINE', path: '/dev/sdc1', devid: 'ata-MATE-part1' },
    } },
  } } } } } }), stderr: '', exitCode: 0 } })
  ex.addFixture({ command: '/usr/bin/cat', result: { stdout: 'Personalities :\nunused devices: <none>\n', stderr: '', exitCode: 0 } })
  return ex
}

describe('cr3 — a stale kernel-named leaf never claims the disk that now holds its name (POOLS-DISKS-M7)', () => {
  it('the blank replacement that came up as sdb reads available, not tank\'s critical member', async () => {
    const ex = staleKernelLeafWorld('UNAVAIL')
    const disks = await collectDisks(ex, new DiskIdentityCache(ex), NO_LIO)
    const fresh = disks.find(d => d.id === 'ata-NEW')
    assert.ok(fresh)
    assert.equal(fresh.status, 'available')
    assert.equal(fresh.poolName, null)
    assert.notEqual(fresh.healthStatus, 'critical')
    assert.equal(isComposableDisk(fresh), true)
    // The surviving mirror leg still joins through its by-id.
    const mate = disks.find(d => d.id === 'ata-MATE')
    assert.equal(mate?.status, 'pool_member')
    assert.equal(mate?.poolName, 'tank')
  })

  it('an ONLINE kernel-named leaf still joins through its kernel path (control: the device-named-pool shape)', async () => {
    const ex = staleKernelLeafWorld('ONLINE')
    const disks = await collectDisks(ex, new DiskIdentityCache(ex), NO_LIO)
    assert.equal(disks.find(d => d.id === 'ata-NEW')?.status, 'pool_member')
  })

  it('resolveLeafKernel: UNAVAIL and REMOVED resolve through by-id forms only', () => {
    const map = new Map([['ata-MATE', 'sdc']])
    assert.equal(resolveLeafKernel('ata-OLD', '/dev/sdb1', map, 'UNAVAIL'), null)
    assert.equal(resolveLeafKernel('ata-OLD', '/dev/sdb1', map, 'REMOVED'), null)
    assert.equal(resolveLeafKernel('sdb1', '/dev/sdb1', map, 'UNAVAIL'), null)
    assert.equal(resolveLeafKernel('ata-OLD', '/dev/sdb1', map, 'ONLINE'), 'sdb')
    // cr3 re-reviews: ONLINE, DEGRADED, AVAIL and INUSE resolve by kernel
    // name; FAULTED / OFFLINE / REMOVED / UNAVAIL only onto a disk that
    // carries the evidence (its ZFS label per lsblk, or an ONLINE sibling).
    assert.equal(resolveLeafKernel('ata-OLD', '/dev/sdb1', map, 'FAULTED', new Set(['sdb'])), 'sdb', 'a faulted leaf is still the device at its path (the disk carries its zfs label)')
    assert.equal(resolveLeafKernel('ata-OLD', '/dev/sdb1', map, 'FAULTED', new Set()), null, 'a blank replacement in the same slot carries no label')
    assert.equal(resolveLeafKernel('ata-OLD', '/dev/sdb1', map, 'OFFLINE', new Set()), null)
    assert.equal(resolveLeafKernel('ata-OLD', '/dev/sdb1', map, 'DEGRADED'), 'sdb')
    assert.equal(resolveLeafKernel('ata-OLD', '/dev/sdb1', map, 'AVAIL'), 'sdb')
    assert.equal(resolveLeafKernel('ata-OLD', '/dev/sdb1', map, 'INUSE'), 'sdb')
    assert.equal(resolveLeafKernel('ata-MATE', '/dev/sdc1', map, 'UNAVAIL'), 'sdc', 'a present disk resolves by its by-id')
  })
})

describe('cr3 — the composability pre-flight on a status it could not read', () => {
  let server: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('adding a vdev of blank disks while `zpool status` fails is 409 unreadable, never accepted', async () => {
    const ids = ['ata-CR3_BLANK_1', 'ata-CR3_BLANK_2']
    server = createServer({ mock: true, logger: false })
    serveBlankInventoryDisks(server, ids)
    const mock = (server as unknown as { executor: MockExecutorType }).executor
    mock.prependFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: 'internal error', exitCode: 1 } })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: { 'x-anas-user': 'root@pam', 'x-anas-user-uid': '0', 'x-anas-privileges': 'Sys.Audit,Sys.Modify', 'x-anas-request-id': randomUUID(), 'content-type': 'application/json' },
      payload: JSON.stringify({ vdev: { type: 'mirror', disks: ids } }),
    })
    assert.equal(res.statusCode, 409, res.body)
    const { error } = res.json() as { error: { reason: string, message: string } }
    assert.equal(error.reason, 'unreadable')
    assert.match(error.message, /could not tell pool members from free disks/)
  })
})

describe('cr3 — the local ZFS version is the kernel module\'s (POOLS-DISKS-L12)', () => {
  it('a userland upgraded without a reboot answers the older module', () => {
    assert.deepEqual(parseZfsVersion('zfs-2.3.1-pve1\nzfs-kmod-2.2.7-pve2\n'), { raw: '2.2.7', major: 2, minor: 2, patch: 7 })
  })

  it('an output with no kmod line falls back to the userland line', () => {
    assert.deepEqual(parseZfsVersion('zfs-2.3.1-1\n'), { raw: '2.3.1', major: 2, minor: 3, patch: 1 })
  })
})
