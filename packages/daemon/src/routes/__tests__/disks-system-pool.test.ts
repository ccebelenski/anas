import type { Disk } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { createServer } from '../../server.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { collectDisks } from '../disks.js'

/**
 * disks.r1 — the boot disk of a ZFS-root node reads `system`.
 *
 * Ground truth is four captures of ONE PVE 9 VM that boots from ZFS
 * (fixtures/system/NOTES.md, last section): `sda` is the boot disk, no
 * partition of it is mounted, `sda3` is the one leaf of `rpool`, and the
 * mount table says `/` is `rpool/ROOT/pve-1`. `collectDisks` reads the mount
 * table's answer and hands the pool names to `parseLsblk`; every other field
 * on the disk is exactly a pool member's.
 *
 * A mock executor that has no fixture for a command answers
 * `{ stdout: '', stderr: 'mock: command not found: …', exitCode: 127 }`
 * (executor/mock.ts), which is how the "mount table could not be read" runs
 * below are built — an older test that never fixtured findmnt gets the same
 * answer, so `readSystemMountPools` returns null and labels nothing.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const sysFixtures = join(__dirname, '../../fixtures/system')
const mountFixtures = join(__dirname, '../../fixtures/mounts')

function loadText(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf-8')
}

const LSBLK_ZFS_ROOT = loadText(sysFixtures, 'lsblk-zfs-root.json')
const ZPOOL_ZFS_ROOT = loadText(sysFixtures, 'zpool-status-zfs-root.json')
const BY_ID_ZFS_ROOT = loadText(sysFixtures, 'disk-by-id-zfs-root.txt')
const FINDMNT_ZFS_ROOT = loadText(mountFixtures, 'findmnt-zfs-root.json')

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

/** The four captures, with `findmnt` overridden by the case under test. */
function makeExecutor(findmnt?: 'capture' | 'exit1' | 'throws' | 'none'): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: ok(LSBLK_ZFS_ROOT) })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(BY_ID_ZFS_ROOT) })
  mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: ok(ZPOOL_ZFS_ROOT) })
  if (findmnt === 'capture')
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: ok(FINDMNT_ZFS_ROOT) })
  else if (findmnt === 'exit1')
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: '', stderr: 'findmnt: failed', exitCode: 1 } })
  else if (findmnt === 'throws')
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], throws: new Error('findmnt could not start') })
  // 'none' (and the default): the mock's command-not-found answer → unreadable.
  return mock
}

async function collect(findmnt: 'capture' | 'exit1' | 'throws' | 'none'): Promise<Map<string, Disk>> {
  const mock = makeExecutor(findmnt)
  const disks = await collectDisks(mock, new DiskIdentityCache(mock))
  return new Map(disks.map(d => [d.name, d]))
}

describe('collectDisks — the boot disk of a ZFS-root node (disks.r1)', () => {
  it('reads system with its pool name when the mount table says a system path is on its pool', async () => {
    const sda = (await collect('capture')).get('sda')!
    assert.ok(sda)
    assert.equal(sda.status, 'system')
    assert.equal(sda.poolName, 'rpool')
  })

  it('keeps every pool-member field identically — vdev, role, ZFS errors, health', async () => {
    const withTable = (await collect('capture')).get('sda')!
    // The same world with the mount table unreadable: today's answer.
    const withoutTable = (await collect('none')).get('sda')!
    assert.equal(withoutTable.status, 'pool_member')
    assert.equal(withoutTable.poolName, 'rpool')
    assert.equal(withTable.vdevName, withoutTable.vdevName)
    assert.equal(withTable.vdevRole, withoutTable.vdevRole)
    assert.deepEqual(withTable.zfsErrors, withoutTable.zfsErrors)
    assert.equal(withTable.healthStatus, withoutTable.healthStatus)
    // …and the pool context is really populated (not two nulls agreeing).
    assert.notEqual(withTable.vdevName, null)
    assert.notEqual(withTable.zfsErrors, null)
  })

  it('a mount table exiting non-zero labels nothing — the disk stays pool_member', async () => {
    const sda = (await collect('exit1')).get('sda')!
    assert.equal(sda.status, 'pool_member')
    assert.equal(sda.poolName, 'rpool')
  })

  it('a mount table that throws labels nothing — the disk stays pool_member', async () => {
    const sda = (await collect('throws')).get('sda')!
    assert.equal(sda.status, 'pool_member')
    assert.equal(sda.poolName, 'rpool')
  })

  it('the data disks are unaffected by the label (other, not system)', async () => {
    const byName = await collect('capture')
    assert.equal(byName.get('sdb')!.status, 'other')
    assert.equal(byName.get('sdc')!.status, 'other')
  })
})

describe('GET /v1/disks — a findmnt that throws still answers 200 (disks.r1)', () => {
  it('the disks endpoint renders pool_member rather than failing', async () => {
    const server = createServer({ mock: true, logger: false })
    await server.ready()
    try {
      const mock = (server as unknown as { executor: MockExecutor }).executor
      // The dev mock already fixtures findmnt --json (an ext4-root table);
      // prepend the four ZFS-root captures and the throwing read.
      mock.prependFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: ok(LSBLK_ZFS_ROOT) })
      mock.prependFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(BY_ID_ZFS_ROOT) })
      mock.prependFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: ok(ZPOOL_ZFS_ROOT) })
      mock.prependFixture({ command: '/usr/bin/findmnt', args: ['--json'], throws: new Error('findmnt could not start') })
      const res = await server.inject({
        method: 'GET',
        url: '/v1/disks',
        headers: {
          'x-anas-user': 'root@pam',
          'x-anas-user-uid': '0',
          'x-anas-privileges': 'Sys.Audit,Sys.Modify',
          'x-anas-request-id': randomUUID(),
        },
      })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: Disk[] }
      const sda = data.find(d => d.name === 'sda')!
      assert.equal(sda.status, 'pool_member')
      assert.equal(sda.poolName, 'rpool')
    }
    finally {
      await server.close()
    }
  })
})
