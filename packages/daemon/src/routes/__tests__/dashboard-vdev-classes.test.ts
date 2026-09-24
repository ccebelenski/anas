import type { Telemetry } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../server.js'

/**
 * vdevs.1 consumer audit (GitHub #66), consumer (c): the dashboard's telemetry
 * tree joins each iostat vdev row to `zpool status` for its type/role/state and
 * falls back to role `data` when it finds no match. A pool carrying log, cache,
 * special or dedup vdevs broke that join in TWO ways, both visible only against
 * real command output:
 *
 *   1. `zpool iostat -plv` prints those section headers UNINDENTED, in the pool
 *      column — read positionally they became four phantom pools ("logs",
 *      "cache", "special", "dedup") and the real pool lost the vdevs under them;
 *   2. the status parser names a single-leaf pool-level vdev after its SECTION
 *      (`special`), while iostat prints the LEAF (`sdb5`), so even once the rows
 *      landed under the right pool the join missed and every one of them was
 *      labelled a data vdev.
 *
 * Both fixtures are stunt-node captures of the same throwaway six-class pool
 * (ZFS 2.4.4 / PVE 9.2.20, 2026-09-24): `zpool-iostat-plv-all-vdev-classes-
 * 2.4.4.txt` verbatim, and the status capture `zpool-status-all-vdev-classes-
 * 2.4.4.json` with its pool name rewritten to the one the iostat capture used.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')

const POOL = 'gtvdev'

const IOSTAT = readFileSync(join(FIXTURES, 'telemetry/zpool-iostat-plv-all-vdev-classes-2.4.4.txt'), 'utf-8')

/** The all-classes status capture, under the name the iostat capture carries. */
const STATUS = (() => {
  const raw = JSON.parse(readFileSync(join(FIXTURES, 'zfs/zpool-status-all-vdev-classes-2.4.4.json'), 'utf-8'))
  const pool = raw.pools.gt66
  pool.name = POOL
  pool.vdevs[POOL] = { ...pool.vdevs.gt66, name: POOL }
  delete pool.vdevs.gt66
  return JSON.stringify({ pools: { [POOL]: pool } })
})()

const LIST = JSON.stringify({ pools: { [POOL]: { name: POOL, state: 'ONLINE', properties: {} } } })

const BY_ID = [
  `lrwxrwxrwx 1 root root 9 Sep 24 06:20 scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9 -> ../../sdb`,
  ...[1, 2, 3, 4, 5, 6].map(n =>
    `lrwxrwxrwx 1 root root 10 Sep 24 06:20 scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9-part${n} -> ../../sdb${n}`),
  '',
].join('\n')

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

describe('GET /v1/telemetry — every vdev class joins with its own role (vdevs.1)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function telemetry(): Promise<Telemetry> {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.clearFixtures()
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: { stdout: LIST, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['iostat', '-plv', POOL, '1', '2'], result: { stdout: IOSTAT, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: STATUS, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: BY_ID, stderr: '', exitCode: 0 } })
    const res = await server.inject({ method: 'GET', url: '/v1/telemetry', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    return (res.json() as { data: Telemetry }).data
  }

  it('the vdev-class sections are NOT read as pools of their own', async () => {
    const t = await telemetry()
    assert.deepEqual(t.pools.map(p => p.name), [POOL])
  })

  it('special, log and dedup vdevs carry their OWN role — never the data fallback', async () => {
    const t = await telemetry()
    const pool = t.pools.find(p => p.name === POOL)!
    const roleOf = (vdev: string) => pool.vdevs.find(v => v.name === vdev)?.role
    // One vdev per class, named by its leaf (that is what iostat prints).
    assert.equal(roleOf('sdb1'), 'data')
    assert.equal(roleOf('sdb2'), 'log')
    assert.equal(roleOf('sdb3'), 'cache')
    assert.equal(roleOf('sdb5'), 'special')
    assert.equal(roleOf('sdb6'), 'dedup')
    // The whole point: not one of them fell back to 'data'.
    assert.equal(pool.vdevs.filter(v => v.role === 'data').length, 1)
  })

  it('each class keeps its own state and its I/O row', async () => {
    const t = await telemetry()
    const pool = t.pools.find(p => p.name === POOL)!
    const special = pool.vdevs.find(v => v.name === 'sdb5')!
    assert.equal(special.state, 'ONLINE')
    assert.equal(special.type, 'disk')
    // A bare leaf is both vdev and disk — it carries its single disk.
    assert.equal(special.disks.length, 1)
    // KNOWN LIMIT, recorded rather than fixed: the by-id map is whole-disk
    // only, so a PARTITION leaf is shown under its kernel name and does not
    // cross-reference to the Disks list. Partition-backed vdevs are displayed,
    // never managed (vdevs.1), so the tree stays honest about what ZFS named.
    assert.equal(special.disks[0].id, 'sdb5')
  })

  it('a spare has no iostat row at all — the tree simply omits it', async () => {
    const t = await telemetry()
    const pool = t.pools.find(p => p.name === POOL)!
    assert.equal(pool.vdevs.find(v => v.name === 'sdb4'), undefined)
  })
})

/**
 * The same join over a BY-ID PARTITION-BACKED pool (GitHub #66's own layout).
 * The status parser strips `-partN` to get a leaf's DISK identity, while
 * iostat prints the leaf exactly as `zpool status` names it —
 * `…ANAS_HOT9-part2`. Indexing the stripped id alone matched nothing, so every
 * by-id partition leaf fell back to role `data`.
 *
 * Both fixtures are a matched pair captured from `vdev-fixture.sh up-multi` on
 * the stunt node (ZFS 2.4.4 / PVE 9.2.20, 2026-09-24): one data leaf, one log
 * leaf and TWO cache leaves, all by-id partitions of one disk.
 */
describe('GET /v1/telemetry — by-id partition leaves join by their own name', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const MULTI_POOL = 'gtvdev'
  const DISK = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9'
  const MULTI_IOSTAT = readFileSync(join(FIXTURES, 'telemetry/zpool-iostat-plv-multi-cache-spare-2.4.4.txt'), 'utf-8')
  const MULTI_STATUS = readFileSync(join(FIXTURES, 'zfs/zpool-status-multi-cache-spare-2.4.4.json'), 'utf-8')
  const MULTI_LIST = JSON.stringify({ pools: { [MULTI_POOL]: { name: MULTI_POOL, state: 'ONLINE', properties: {} } } })

  async function telemetry(): Promise<Telemetry> {
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.clearFixtures()
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['list', '-j'], result: { stdout: MULTI_LIST, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['iostat', '-plv', MULTI_POOL, '1', '2'], result: { stdout: MULTI_IOSTAT, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: MULTI_STATUS, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: BY_ID, stderr: '', exitCode: 0 } })
    const res = await server.inject({ method: 'GET', url: '/v1/telemetry', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    return (res.json() as { data: Telemetry }).data
  }

  it('the log and cache partitions carry their OWN role, not the data fallback', async () => {
    const t = await telemetry()
    const pool = t.pools.find(p => p.name === MULTI_POOL)!
    const roleOf = (vdev: string) => pool.vdevs.find(v => v.name === vdev)?.role
    assert.equal(roleOf(`${DISK}-part1`), 'data')
    assert.equal(roleOf(`${DISK}-part2`), 'log')
    assert.equal(roleOf(`${DISK}-part3`), 'cache')
    assert.equal(roleOf(`${DISK}-part6`), 'cache')
    assert.equal(pool.vdevs.filter(v => v.role === 'data').length, 1)
  })

  it('and their own state — one container, both its leaves joined', async () => {
    const t = await telemetry()
    const pool = t.pools.find(p => p.name === MULTI_POOL)!
    for (const part of [2, 3, 6])
      assert.equal(pool.vdevs.find(v => v.name === `${DISK}-part${part}`)?.state, 'ONLINE', `part${part}`)
  })
})
