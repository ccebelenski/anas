import type { ExecResult } from '../../executor/types.js'
import type { PveFootprint } from '../../services/pve-footprint.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { jobRoutes } from '../jobs.js'
import { poolRoutes, poolStamp } from '../pools.js'

/**
 * Story cr.23 — the destroy route's system-pool guard decides on FACTS, never
 * names. The well-known-name block is gone; what remains is the boot facts
 * (`bootfs`, root dataset) plus the live mount table (one of the pool's own
 * filesystems AT a system path), and a hard refusal when BOTH went dark.
 *
 * A controlled executor drives the footprint reads (the stock mock seeds
 * `findmnt --json` and an exact-args fixture can't be overridden from a
 * test); storage.cfg is pointed at an absent path, so the storages read fails
 * open exactly like a non-PVE host.
 */

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const FINDMNT = '/usr/bin/findmnt'
const BY_ID = '/dev/disk/by-id/'
const ABSENT_STORAGE_CFG = '/nonexistent.anas-cr23-test.cfg'
const POOL_GUID = '9183729100142233021'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

const OK: ExecResult = { stdout: '', stderr: '', exitCode: 0 }

/** Build a `findmnt --json` table from flat rows (the shape util-linux emits). */
function findmntJson(rows: { target: string, source: string, fstype: string }[]): string {
  return JSON.stringify({
    filesystems: rows.map(r => ({ target: r.target, source: r.source, fstype: r.fstype, options: 'rw,relatime' })),
  })
}

/** The ext4/LVM root every ordinary PVE install has — no pool filesystem in it. */
const EXT4_ROOT_TABLE = findmntJson([
  { target: '/', source: '/dev/mapper/pve-root', fstype: 'ext4' },
  { target: '/boot', source: '/dev/sda2', fstype: 'ext4' },
])

function listJson(pool: string): string {
  return JSON.stringify({ pools: { [pool]: { name: pool, state: 'ONLINE', properties: {} } } })
}

interface BaseOpts {
  /** stdout for `zpool get -H -o name,value bootfs`; omitted = the probe FAILS. */
  bootfs?: string
  /** result for `findmnt --json`; defaults to the readable ext4-root table. */
  findmnt?: ExecResult
  /** result for `zfs list -H -o name,mountpoint`; defaults to readable. */
  zfsList?: ExecResult
}

/**
 * Executor reaching the confirm gate: pool exists, boot/mount facts as given,
 * guid readable, plus the catch-alls the warning reads expect.
 */
function baseExecutor(pool: string, opts: BaseOpts = {}): MockExecutor {
  const ex = new MockExecutor()
  ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: { stdout: listJson(pool), stderr: '', exitCode: 0 } })
  ex.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: { stdout: JSON.stringify({ pools: { [pool]: { name: pool, state: 'ONLINE' } } }), stderr: '', exitCode: 0 } })
  ex.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', pool], result: { stdout: `${POOL_GUID}\n`, stderr: '', exitCode: 0 } })
  ex.addFixture({ command: '/usr/bin/ls', args: ['-la', BY_ID], result: { stdout: '', stderr: '', exitCode: 0 } })
  // The footprint reads, exactly as loadPveFootprint issues them. No bootfs
  // fixture means the probe EXITS 1 — UNREADABLE, never "no system pool".
  ex.addFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint'], result: opts.zfsList ?? { stdout: `${pool}\t/${pool}\n`, stderr: '', exitCode: 0 } })
  ex.addFixture({ command: FINDMNT, args: ['--json'], result: opts.findmnt ?? { stdout: EXT4_ROOT_TABLE, stderr: '', exitCode: 0 } })
  ex.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: opts.bootfs !== undefined
    ? { stdout: opts.bootfs, stderr: '', exitCode: 0 }
    : { stdout: '', stderr: 'cannot open', exitCode: 1 } })
  // Catch-alls for the non-refused paths' reads (status warnings etc.).
  ex.addFixture({ command: ZPOOL, result: OK })
  ex.addFixture({ command: ZFS, result: OK })
  return ex
}

async function build(ex: MockExecutor): Promise<ReturnType<typeof Fastify>> {
  const jobQueue = new JobQueue()
  const server = Fastify({ logger: false })
  await server.register(jobRoutes, { prefix: '/v1', jobQueue })
  await server.register(poolRoutes, {
    prefix: '/v1',
    executor: ex,
    jobQueue,
    confirmStore: new ConfirmStore(),
    pveStoragePath: ABSENT_STORAGE_CFG,
  })
  return server
}

/** Assert the hard system-pool 409 (no confirm code offered) and return the message. */
function systemPoolMessage(res: { statusCode: number, headers: Record<string, string | string[] | undefined>, json: () => { error: { code: string, reason?: string, message: string } } }): string {
  assert.equal(res.statusCode, 409)
  const body = res.json()
  assert.equal(body.error.code, 'CONFLICT')
  assert.equal(body.error.reason, 'system-pool')
  assert.equal(res.headers['x-anas-confirm-code'], undefined, 'a hard refusal never offers a confirm code')
  return body.error.message
}

describe('destroy system-pool guard (cr.23) — facts, never names', () => {
  let server: ReturnType<typeof Fastify> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('a data pool NAMED rpool on an ext4-root node meets the normal confirm gate', async () => {
    // Boot facts readable with bootfs unset, mount table readable with no
    // pool filesystem at a system path — nothing fires: the name is not a fact.
    server = await build(baseExecutor('rpool', { bootfs: 'rpool\t-\n' }))
    const res = await server.inject({ method: 'DELETE', url: '/v1/pools/rpool', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'], 'the ordinary dangerous-op gate, not a system-pool refusal')
  })

  it('the boot pool is refused under ANY name, and a confirm code does not bypass', async () => {
    // Pool named `tank` holds the bootfs — the mount table says nothing.
    server = await build(baseExecutor('tank', { bootfs: 'otherpool\t-\ntank\ttank/ROOT/pve-1\n' }))
    const message = systemPoolMessage(await server.inject({ method: 'DELETE', url: '/v1/pools/tank', headers: IDENTITY_HEADERS }))
    assert.match(message, /^Pool 'tank' holds this node's boot filesystem \(tank\/ROOT\/pve-1\) —/)
    // Resending with a confirm code changes nothing — Level-1, no bypass.
    const again = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/tank',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': 'anything' },
    })
    assert.equal(again.json().error.reason, 'system-pool')
  })

  it('a pool with a dataset mounted at /var is refused — the sentence names the path', async () => {
    // Boot facts readable and quiet — the MOUNT fact is what fires here.
    server = await build(baseExecutor('tank', {
      bootfs: 'tank\t-\n',
      findmnt: { stdout: findmntJson([
        { target: '/', source: '/dev/mapper/pve-root', fstype: 'ext4' },
        { target: '/var', source: 'tank/var', fstype: 'zfs' },
      ]), stderr: '', exitCode: 0 },
    }))
    const message = systemPoolMessage(await server.inject({ method: 'DELETE', url: '/v1/pools/tank', headers: IDENTITY_HEADERS }))
    assert.match(message, /^Pool 'tank' is mounted at \/var —/)
  })

  it('when BOTH the mount table and the boot facts are unreadable, the verb is refused', async () => {
    // bootfs probe exits 1 (the BaseOpts default), zfs list exits 1, and the
    // mount table exits 1 — no fact readable anywhere, so the gate tightens.
    server = await build(baseExecutor('tank', {
      zfsList: { stdout: '', stderr: 'cannot list datasets', exitCode: 1 },
      findmnt: { stdout: '', stderr: 'findmnt: cannot read mount table', exitCode: 1 },
    }))
    const message = systemPoolMessage(await server.inject({ method: 'DELETE', url: '/v1/pools/tank', headers: IDENTITY_HEADERS }))
    assert.match(message, /the mount table and boot facts are unreadable/)
    // A confirm code buys nothing here either.
    const again = await server.inject({
      method: 'DELETE',
      url: '/v1/pools/tank',
      headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': 'anything' },
    })
    assert.equal(again.json().error.reason, 'system-pool')
  })
})

describe('poolStamp — the panel\'s pool verdict follows the one system-pool rule (coordinator, cr.23)', () => {
  // A fake footprint: only the members poolStamp and systemPoolRefusalFrom read.
  function fake(over: Partial<PveFootprint>): PveFootprint {
    return {
      ownershipOf: () => null,
      isSystemPool: () => false,
      systemPoolFacts: () => null,
      systemMountTarget: () => null,
      systemMountFacts: { zfs: new Map(), ahr: new Map() },
      systemFactsUnavailable: false,
      storagesUnavailable: false,
      ...over,
    } as unknown as PveFootprint
  }

  it('a pool mounted at /var is stamped system, its children stay manageable', () => {
    const stamp = poolStamp(fake({ isSystemPool: () => true, systemMountTarget: () => '/var' }), 'tank')
    assert.equal(stamp?.kind, 'system')
    assert.match(stamp?.reason ?? '', /mounted at \/var/)
    assert.equal(stamp?.childrenManageable, true)
  })

  it('PVE\'s own ownership answer wins when there is one', () => {
    const owned = { kind: 'storage-root' as const, storage: 'local-zfs', reason: 'PVE storage' }
    assert.deepEqual(poolStamp(fake({ ownershipOf: () => owned, isSystemPool: () => true }), 'rpool'), owned)
  })

  it('an ordinary data pool carries no stamp', () => {
    assert.equal(poolStamp(fake({}), 'tank'), null)
  })
})
