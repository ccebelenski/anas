import type { Disk, PoolSummary, StatusSummary } from '@anas/shared'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { createServer } from '../../server.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { collectDiskInventory } from '../disks.js'

/**
 * cr3.pools-disks — the second delta review (2026-11-14). The reviewer's
 * reproducing rows (`t/review2/probes/probe8-shapes.ts`, `probe9-byid.ts`,
 * `probe10-kernel.ts`), each a regression against the wave's rule: a read that
 * failed never reads absent, empty or healthy.
 */

const ZPOOL = '/usr/sbin/zpool'
const r = (exitCode: number, stdout: string, stderr = ''): ExecResult => ({ stdout, stderr, exitCode })
const NO_LIO = { configfsRoot: '/nonexistent-anas-cr3', saveconfigPath: '/nonexistent-anas-cr3' }

function headers(json = false) {
  return {
    'x-anas-user': 'root@pam',
    'x-anas-user-uid': '0',
    'x-anas-privileges': 'Sys.Audit,Sys.Modify',
    'x-anas-request-id': randomUUID(),
    ...(json ? { 'content-type': 'application/json' } : {}),
  }
}
type Srv = ReturnType<typeof createServer>
const mockOf = (srv: Srv): MockExecutor => (srv as unknown as { executor: MockExecutor }).executor

// ---------------------------------------------------------------------------
// Item 1 — probe10: a kernel-named pool's leaves in every state.
// ---------------------------------------------------------------------------

const proto = (JSON.parse(mockFixtures.lsblk().stdout) as { blockdevices: Record<string, unknown>[] }).blockdevices.find(d => d.name === 'sdf')!
function kdisk(name: string, serial: string, member: boolean) {
  return {
    ...proto,
    name,
    serial,
    wwn: null,
    children: member
      ? [
          { name: `${name}1`, type: 'part', size: 268300615680, fstype: 'zfs_member', mountpoint: null },
          { name: `${name}9`, type: 'part', size: 8388608, fstype: null, mountpoint: null },
        ]
      : undefined,
  }
}
function kleaf(name: string, state: string) {
  return { name, vdev_type: 'disk', path: `/dev/${name}1`, class: 'normal', state, read_errors: '0', write_errors: '0', checksum_errors: '0' }
}
function kstatus(sdcState: string, spareState = 'AVAIL'): string {
  const st = sdcState === 'ONLINE' ? 'ONLINE' : 'DEGRADED'
  return JSON.stringify({ output_version: { command: 'zpool status', vers_major: 0, vers_minor: 1 }, pools: { ktank: {
    name: 'ktank',
    state: st,
    pool_guid: '1234',
    error_count: '0',
    vdevs: { ktank: { name: 'ktank', vdev_type: 'root', class: 'normal', state: st, vdevs: {
      'mirror-0': { name: 'mirror-0', vdev_type: 'mirror', class: 'normal', state: st, vdevs: { sdb: kleaf('sdb', 'ONLINE'), sdc: kleaf('sdc', sdcState) } },
    } } },
    spares: { sdd: { ...kleaf('sdd', spareState), class: 'spare' } },
  } } })
}

async function kernelWorld(sdcState: string, sdcPresent: boolean, spareState = 'AVAIL'): Promise<Map<string, Disk>> {
  const ex = new MockExecutor()
  const blk = { blockdevices: [kdisk('sdb', 'K-SDB', true), kdisk('sdc', sdcPresent ? 'K-SDC' : 'K-NEWBLANK', sdcPresent), kdisk('sdd', 'K-SDD', true)] }
  ex.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: r(0, JSON.stringify(blk)) })
  ex.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: r(0, ['sdb', 'sdc', 'sdd'].map(n => `lrwxrwxrwx 1 root root 9 Mar 15 22:12 ata-X_${n} -> ../../${n}`).join('\n')) })
  ex.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: r(0, kstatus(sdcState, spareState)) })
  ex.addFixture({ command: '/usr/bin/cat', result: r(0, 'Personalities :\nunused devices: <none>\n') })
  const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO)
  return new Map(inv.disks.map(d => [d.name, d]))
}

describe('cr3 re-review 2 item 1 — a present FAULTED / DEGRADED / OFFLINE member keeps its pool; a hot spare stays its pool\'s (probe10)', () => {
  for (const state of ['FAULTED', 'DEGRADED', 'OFFLINE']) {
    it(`sdc ${state}, the same disk present (it carries its zfs label): pool_member of ktank, never other/healthy`, async () => {
      const disks = await kernelWorld(state, true)
      const sdc = disks.get('sdc')!
      assert.equal(sdc.status, 'pool_member')
      assert.equal(sdc.poolName, 'ktank')
      assert.notEqual(sdc.healthStatus, 'healthy')
    })
  }

  for (const state of ['OFFLINE', 'FAULTED', 'REMOVED', 'UNAVAIL']) {
    it(`sdc ${state}, replaced by a BLANK disk under the same name: available, no pool`, async () => {
      const sdc = (await kernelWorld(state, false)).get('sdc')!
      assert.equal(sdc.status, 'available')
      assert.equal(sdc.poolName, null)
    })
  }

  for (const spare of ['AVAIL', 'INUSE']) {
    it(`an ${spare} hot spare stays ktank's spare`, async () => {
      const sdd = (await kernelWorld('ONLINE', true, spare)).get('sdd')!
      assert.equal(sdd.status, 'pool_member')
      assert.equal(sdd.poolName, 'ktank')
      assert.equal(sdd.vdevRole, 'spare')
    })
  }
})

// ---------------------------------------------------------------------------
// Items 2, 3 — probe8 rows E4, E6, E8 and the pool named like the sentence.
// ---------------------------------------------------------------------------

async function withServer(fn: (srv: Srv) => Promise<void>): Promise<void> {
  const srv = createServer({ mock: true, logger: false })
  try {
    await fn(srv)
  }
  finally {
    await srv.close()
  }
}

describe('cr3 re-review 2 items 2 and 3 — only zpool\'s exact answers mean "no pools" / "no ZFS" (probe8)', () => {
  it('E4: exit 0 JSON without a pools object is unreadable — no disk available, GET /pools 503, create refused', async () => {
    await withServer(async (srv) => {
      const doc = (cmd: string) => r(0, `{"output_version":{"command":"${cmd}","vers_major":1,"vers_minor":0},"pool_list":{"testpool":{}}}\n`)
      mockOf(srv).prependFixture({ command: ZPOOL, args: ['status', '-jv'], result: doc('zpool status') })
      mockOf(srv).prependFixture({ command: ZPOOL, args: ['list', '-j'], result: doc('zpool list') })
      const disks = ((await srv.inject({ method: 'GET', url: '/v1/disks', headers: headers() })).json() as { data: Disk[] }).data
      assert.ok(!disks.some(d => d.status === 'available'), disks.map(d => `${d.name}:${d.status}`).join(' '))
      assert.equal((await srv.inject({ method: 'GET', url: '/v1/pools', headers: headers() })).statusCode, 503)
    })
  })

  it('E6: exit 0 pools JSON with a libzfs sentence on stderr lists the pools (the sentence is never consulted after JSON)', async () => {
    await withServer(async (srv) => {
      mockOf(srv).prependFixture({ command: ZPOOL, args: ['status', '-jv'], result: { ...mockFixtures.zpoolStatus(), stderr: 'The ZFS modules are not loaded.\n' } })
      mockOf(srv).prependFixture({ command: ZPOOL, args: ['list', '-j'], result: { ...mockFixtures.zpoolList(), stderr: 'The ZFS modules are not loaded.\n' } })
      const res = await srv.inject({ method: 'GET', url: '/v1/pools', headers: headers() })
      const body = res.json() as { data: PoolSummary[], zfsUnavailable?: string }
      assert.ok(body.data.some(p => p.name === 'testpool'), res.body)
      assert.equal(body.zfsUnavailable, undefined)
    })
  })

  it('E8: an I/O error line FIRST and the sentence later is a failed read — disks unknown, GET /pools 503', async () => {
    await withServer(async (srv) => {
      const answer = r(1, '', 'internal error: something\nThe ZFS modules are not loaded.\n')
      for (const args of [['status', '-jv'], ['list', '-j']])
        mockOf(srv).prependFixture({ command: ZPOOL, args, result: answer })
      mockOf(srv).prependFixture({ command: '/usr/bin/test', args: ['-d', '/sys/module/zfs'], result: r(1, '') })
      const disks = ((await srv.inject({ method: 'GET', url: '/v1/disks', headers: headers() })).json() as { data: Disk[] }).data
      assert.ok(!disks.some(d => d.status === 'available'))
      assert.equal((await srv.inject({ method: 'GET', url: '/v1/pools', headers: headers() })).statusCode, 503)
    })
  })

  it('a pool NAMED like the sentence never empties the list', async () => {
    await withServer(async (srv) => {
      const doc = JSON.parse(mockFixtures.zpoolList().stdout) as { pools: Record<string, { name: string }> }
      const copy = JSON.parse(JSON.stringify(doc.pools.testpool)) as { name: string }
      copy.name = 'The ZFS modules are not loaded.'
      doc.pools[copy.name] = copy
      mockOf(srv).prependFixture({ command: ZPOOL, args: ['list', '-j'], result: r(0, JSON.stringify(doc)) })
      const res = await srv.inject({ method: 'GET', url: '/v1/pools', headers: headers() })
      const body = res.json() as { data: PoolSummary[], zfsUnavailable?: string }
      assert.equal(body.zfsUnavailable, undefined)
      assert.ok(body.data.some(p => p.name === 'testpool'))
      assert.ok(body.data.some(p => p.name === 'The ZFS modules are not loaded.' && p.unmanaged))
    })
  })
})

// ---------------------------------------------------------------------------
// Items 4, 5 — the by-id listing (probe9).
// ---------------------------------------------------------------------------

describe('cr3 re-review 2 items 4 and 5 — the by-id listing', () => {
  it('item 4: an ABSENT by-id directory while zpool status names /dev/disk/by-id/ leaves is unreadable — no disk available, create 409', async () => {
    await withServer(async (srv) => {
      mockOf(srv).prependFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: r(2, '', 'ls: cannot access \'/dev/disk/by-id/\': No such file or directory\n') })
      const disks = ((await srv.inject({ method: 'GET', url: '/v1/disks', headers: headers() })).json() as { data: Disk[] }).data
      assert.ok(!disks.some(d => d.status === 'available'), disks.map(d => `${d.name}:${d.status}`).join(' '))
      const id = disks.find(d => d.status === 'unknown')!.id
      const create = await srv.inject({ method: 'POST', url: '/v1/pools', headers: headers(true), payload: JSON.stringify({ name: 'newz', dataVdevs: [{ type: 'stripe', disks: [id] }] }) })
      assert.equal(create.statusCode, 409, create.body)
    })
  })

  it('item 4: an EMPTY by-id listing with by-id leaves is unreadable too', async () => {
    await withServer(async (srv) => {
      mockOf(srv).prependFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: r(0, 'total 0\n') })
      const disks = ((await srv.inject({ method: 'GET', url: '/v1/disks', headers: headers() })).json() as { data: Disk[] }).data
      assert.ok(!disks.some(d => d.status === 'available'))
    })
  })

  it('item 5: the by-id and by-partuuid listings run in the C locale (the absent verdict reads coreutils\' English text)', async () => {
    const ex = new MockExecutor()
    const seen: { args: string[], opts?: ExecOptions }[] = []
    const orig = ex.exec.bind(ex)
    ex.exec = async (command: string, args: string[], opts?: ExecOptions) => {
      if (command === '/usr/bin/ls' || command === ZPOOL)
        seen.push({ args, opts })
      return orig(command, args, opts)
    }
    ex.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: r(0, '{"blockdevices":[]}') })
    await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO).catch(() => null)
    assert.ok(seen.length >= 3)
    for (const call of seen)
      assert.equal(call.opts?.env?.LC_ALL, 'C', `${call.args.join(' ')} forces the C locale`)
  })
})

// ---------------------------------------------------------------------------
// Items 6, 7, 8.
// ---------------------------------------------------------------------------

const eacces = (): Error => Object.assign(new Error(`spawn ${ZPOOL} EACCES`), { code: 'EACCES', path: ZPOOL })
const enoent = (): Error => Object.assign(new Error(`spawn ${ZPOOL} ENOENT`), { code: 'ENOENT', path: ZPOOL })

describe('cr3 re-review 2 items 6, 7, 8 — spawn failures and the import scan', () => {
  it('item 6: a zpool spawn EACCES is a failed read naming it — /pools 503, /pools/import 503, POST /pools 503, /disks unknown (never a 500)', async () => {
    await withServer(async (srv) => {
      for (const args of [['status', '-jv'], ['list', '-j'], ['upgrade'], ['import']])
        mockOf(srv).prependFixture({ command: ZPOOL, args, result: r(0, ''), throws: eacces() })
      const pools = await srv.inject({ method: 'GET', url: '/v1/pools', headers: headers() })
      assert.equal(pools.statusCode, 503, pools.body)
      assert.match(pools.body, /the zpool command could not be run \(EACCES/)
      const imp = await srv.inject({ method: 'GET', url: '/v1/pools/import', headers: headers() })
      assert.equal(imp.statusCode, 503, imp.body)
      const disksRes = await srv.inject({ method: 'GET', url: '/v1/disks', headers: headers() })
      assert.equal(disksRes.statusCode, 200)
      const disks = (disksRes.json() as { data: Disk[] }).data
      assert.ok(!disks.some(d => d.status === 'available'))
      const status = (await srv.inject({ method: 'GET', url: '/v1/status', headers: headers() })).json() as { data: StatusSummary }
      assert.ok(status.data.unavailable?.includes('pools'))
      const create = await srv.inject({ method: 'POST', url: '/v1/pools', headers: headers(true), payload: JSON.stringify({ name: 'newz', dataVdevs: [{ type: 'stripe', disks: [disks[0].id] }] }) })
      assert.equal(create.statusCode, 503, create.body)
    })
  })

  it('item 7: an import-scan block with no id is not offered, and the scan says it could not be read', async () => {
    await withServer(async (srv) => {
      const scan = [
        '   pool: good',
        '     id: 1234567890',
        '  state: ONLINE',
        ' action: The pool can be imported using its name or numeric identifier.',
        '',
        '   pool: broken',
        '  state: UNAVAIL',
        '',
      ].join('\n')
      mockOf(srv).prependFixture({ command: ZPOOL, args: ['import'], result: r(0, scan) })
      const res = await srv.inject({ method: 'GET', url: '/v1/pools/import', headers: headers() })
      const body = res.json() as { data: { name: string, guid: string }[], unreadableEntries?: string[] }
      assert.deepEqual(body.data.map(p => p.name), ['good'])
      assert.ok(!body.data.some(p => p.guid === ''))
      assert.equal(body.unreadableEntries?.length, 1)
      assert.match(body.unreadableEntries![0], /'broken'/)
    })
  })

  it('item 8: GET /pools/:name with no zpool binary is the 409 zfs-unavailable, never a 500', async () => {
    await withServer(async (srv) => {
      for (const args of [['status', '-jv'], ['list', '-j'], ['get', 'all', '-j']])
        mockOf(srv).prependFixture({ command: ZPOOL, args, result: r(0, ''), throws: enoent() })
      const res = await srv.inject({ method: 'GET', url: '/v1/pools/testpool', headers: headers() })
      assert.equal(res.statusCode, 409, res.body)
      assert.equal((res.json() as { error: { reason: string } }).error.reason, 'zfs-unavailable')
    })
  })
})
