import type { Disk } from '@anas/shared'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { createServer } from '../../server.js'
import { readNamedMdArrays } from '../../services/ahr-identity.js'
import { readAhrPools } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { collectDiskInventory, inventoryUnreadableFor } from '../disks.js'
import { serveBlankInventoryDisks } from './inventory-stub.js'
import { MD_ABSENT, serveMdAbsent } from './md-absent.js'

/**
 * cr3.followup item 1 — an AHR topology read that FAILED never reads as "no
 * AHR members". It used to (`readAhrPools(...).catch(() => [])`): a disk that
 * is an AHR member md could not report read `available`, and the create
 * doors offered it. Now it reads `unknown` exactly as a failed `zpool status`
 * makes it, and the doors refuse 409 `unreadable`. An ABSENT `/proc/mdstat`
 * (a node with no md stack) stays the honest "no AHR members".
 */

const CAT = '/usr/bin/cat'
const r = (exitCode: number, stdout: string, stderr = ''): ExecResult => ({ stdout, stderr, exitCode })
/** coreutils `cat` on a /proc/mdstat it could open but not read. */
const MDSTAT_IO_ERROR = r(1, '', 'cat: /proc/mdstat: Input/output error\n')
/** `zpool_do_status` -j, no pools (OpenZFS 2.4.x). */
const STATUS_NO_POOLS = r(0, '{"output_version":{"command":"zpool status","vers_major":0,"vers_minor":1},"pools":{}}\n')
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

/** One blank disk sdb, no pools; the mdstat answer given (none = md absent). */
function blankWorld(mdstat?: ExecResult): MockExecutor {
  const ex = new MockExecutor()
  ex.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: r(0, JSON.stringify({ blockdevices: [{ 'name': 'sdb', 'type': 'disk', 'size': 1073741824, 'model': 'BLANK', 'serial': 'B1', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 512, 'log-sec': 512, 'wwn': null, 'vendor': null, 'rev': null }] })) })
  ex.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: r(0, 'lrwxrwxrwx 1 root root 9 Nov 14 10:00 ata-BLANK_B1 -> ../../sdb\n') })
  ex.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: STATUS_NO_POOLS })
  if (mdstat)
    ex.addFixture({ command: CAT, args: MDSTAT_CAT_ARGS, result: mdstat })
  return serveMdAbsent(ex)
}

describe('cr3.followup — a failed AHR read makes disk membership unknown', () => {
  it('mdstat I/O error: the blank disk reads unknown (status and health), the inventory names the read', async () => {
    const ex = blankWorld(MDSTAT_IO_ERROR)
    const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO)
    assert.match(inv.ahrUnreadable ?? '', /the AHR topology could not be read \(cat \/proc\/mdstat exited 1: cat: \/proc\/mdstat: Input\/output error\)/)
    assert.equal(inv.disks[0].status, 'unknown')
    assert.equal(inv.disks[0].healthStatus, 'unknown')
    assert.match(inventoryUnreadableFor(inv, ['ata-BLANK_B1']) ?? '', /could not tell pool members from free disks \(the AHR topology could not be read/)
  })

  it('a failed mdadm --detail behind a readable mdstat is unreadable too', async () => {
    const ex = blankWorld(r(0, 'Personalities : [raid1]\nmd127 : active raid1 sdc1[1] sdd1[0]\n      1047552 blocks super 1.2 [2/2] [UU]\n\nunused devices: <none>\n'))
    ex.addFixture({ command: '/usr/sbin/mdadm', result: r(1, '', 'mdadm: cannot open /dev/md127: Input/output error\n') })
    const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO)
    assert.match(inv.ahrUnreadable ?? '', /mdadm --detail --export \/dev\/md127 exited 1/)
    assert.equal(inv.disks[0].status, 'unknown')
  })

  it('control: md ABSENT (cat ENOENT, exit 1) is no AHR members — the same disk reads available', async () => {
    const ex = blankWorld()
    const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO)
    assert.equal(inv.ahrUnreadable, undefined)
    assert.equal(inv.disks[0].status, 'available')
    assert.equal(inventoryUnreadableFor(inv, ['ata-BLANK_B1']), null)
  })

  it('a spawn failure of the mdstat read is unreadable, never absent', async () => {
    const ex = blankWorld()
    ex.prependFixture({ command: CAT, args: MDSTAT_CAT_ARGS, result: r(0, ''), throws: Object.assign(new Error(`spawn ${CAT} EACCES`), { code: 'EACCES' }) })
    const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), NO_LIO)
    assert.match(inv.ahrUnreadable ?? '', /EACCES/)
    assert.equal(inv.disks[0].status, 'unknown')
  })
})

describe('cr3.followup — the create door refuses a disk whose AHR membership could not be read', () => {
  const BLANK = 'ata-AHRFOLLOWUP_BLANK'

  it('mdstat I/O error: GET /v1/disks offers no disk; POST /v1/pools naming the blank disk is 409 unreadable', async () => {
    const server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    serveBlankInventoryDisks(server, [BLANK])
    mock.prependFixture({ command: CAT, args: MDSTAT_CAT_ARGS, result: MDSTAT_IO_ERROR })
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/disks', headers: headers() })
      assert.equal(res.statusCode, 200, res.body)
      const disks = (res.json() as { data: Disk[] }).data
      assert.ok(!disks.some(d => d.status === 'available'), disks.map(d => `${d.name}:${d.status}`).join(' '))
      assert.equal(disks.find(d => d.id === BLANK)?.status, 'unknown')
      const create = await server.inject({ method: 'POST', url: '/v1/pools', headers: headers(true), payload: JSON.stringify({ name: 'newz', dataVdevs: [{ type: 'stripe', disks: [BLANK] }] }) })
      assert.equal(create.statusCode, 409, create.body)
      const error = (create.json() as { error: { reason: string, message: string } }).error
      assert.equal(error.reason, 'unreadable')
      assert.match(error.message, /the AHR topology could not be read/)

      // The dashboard's disk-health counts say why they hold unknowns.
      const status = await server.inject({ method: 'GET', url: '/v1/status', headers: headers() })
      assert.equal(status.statusCode, 200, status.body)
      const summary = (status.json() as { data: { unavailable?: string[], warnings: { category: string, message: string }[] } }).data
      assert.ok(summary.unavailable?.includes('disks'), JSON.stringify(summary.unavailable))
      const named = summary.warnings.some(w => w.category === 'unavailable' && w.message.startsWith('Disk health is unavailable: the AHR topology could not be read'))
      assert.ok(named, 'the disks section names the AHR read it could not do')
    }
    finally {
      await server.close()
    }
  })

  it('control: md absent — the same blank disk reads available', async () => {
    const server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    serveBlankInventoryDisks(server, [BLANK])
    mock.prependFixture({ command: CAT, args: MDSTAT_CAT_ARGS, result: MD_ABSENT })
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/disks', headers: headers() })
      assert.equal(res.statusCode, 200, res.body)
      assert.equal((res.json() as { data: Disk[] }).data.find(d => d.id === BLANK)?.status, 'available')
    }
    finally {
      await server.close()
    }
  })
})

describe('cr3.followup — the mdstat reads that match cat\'s English stderr run in the C locale', () => {
  /** Record the options every `cat /proc/mdstat` was given. */
  function recording(): { ex: MockExecutor, opts: (ExecOptions | undefined)[] } {
    const ex = new MockExecutor()
    ex.addFixture({ command: CAT, args: MDSTAT_CAT_ARGS, result: MD_ABSENT })
    const opts: (ExecOptions | undefined)[] = []
    const orig = ex.exec.bind(ex)
    ex.exec = async (command: string, args: string[], o?: ExecOptions): Promise<ExecResult> => {
      if (command === CAT && args.join(' ') === MDSTAT_CAT_ARGS.join(' '))
        opts.push(o)
      return orig(command, args, o)
    }
    return { ex, opts }
  }

  it('readAhrPools reads mdstat with LC_ALL=C (a localized ENOENT line would read as unreadable)', async () => {
    const { ex, opts } = recording()
    assert.deepEqual(await readAhrPools(ex), [])
    assert.equal(opts.length, 1)
    assert.equal(opts[0]?.env?.LC_ALL, 'C')
  })

  it('readNamedMdArrays reads mdstat with LC_ALL=C too', async () => {
    const { ex, opts } = recording()
    assert.deepEqual(await readNamedMdArrays(ex), [])
    assert.equal(opts.length, 1)
    assert.equal(opts[0]?.env?.LC_ALL, 'C')
  })
})
