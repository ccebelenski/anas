import type { Disk, PoolDetail, Telemetry } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { CommandTimeoutError } from '../../executor/deadline.js'
import { MockExecutor } from '../../executor/mock.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { readPbsStoragesChecked } from '../../parsers/pve-storage.js'
import { parseZpoolGet } from '../../parsers/zpool-get.js'
import { execZpool, parseZpoolList, ZFS_MODULE_ABSENT_TAG, ZPOOL_ABSENT_STDERR, zpoolListUnreadable } from '../../parsers/zpool-list.js'
import { readZpoolStatusAnswer } from '../../parsers/zpool-status.js'
import { createServer } from '../../server.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { collectDiskInventory } from '../disks.js'

/**
 * cr3.pools-disks follow-ups (coordinator, after the first report):
 *  (3) the honest "no pools" answer of a pool-less node, without a capture:
 *      every plausible shape reads "no pools", and only a real failure reads
 *      unreadable — an AHR-only node must never read every disk `unknown`;
 *  (2) `zpool import` with nothing importable exits 0 (node capture);
 *  (4) a pool property the read did not return is null, never a default;
 *  (5) /v1/telemetry says when the pool I/O tree could not be sampled;
 *  (6) GET /pools/:name answers an unmanaged name read-only with its marker;
 *  (7) the PBS storage read can say unreadable.
 */

const ZPOOL = '/usr/sbin/zpool'
const VERSION = '"output_version":{"command":"zpool status","vers_major":0,"vers_minor":1}'

const r = (exitCode: number, stdout: string, stderr = ''): ExecResult => ({ stdout, stderr, exitCode })
const LIBZFS_ENOEXEC = 'The ZFS modules cannot be auto-loaded.\nTry running \'modprobe zfs\' as root to manually load them.\n'
const LIBZFS_ENXIO = 'The ZFS modules are not loaded.\nTry running \'modprobe zfs\' as root to load them.\n'
const LIBZFS_ENOENT = '/dev/zfs and /proc/self/mounts are required.\nTry running \'udevadm trigger\' and \'mount -t proc proc /proc\' as root.\n'

/**
 * Every shape this daemon reads as zpool ANSWERING "no pools". The first
 * group is OpenZFS 2.4.x's own (read from the source by the cr3 re-review,
 * `/usr/src/zfs-2.4.2` and `-2.4.5`): `zpool_do_status` -j with no pools
 * (exit 0, `pools:{}`), `zpool_do_list` -j with no pools (exit 0, nothing),
 * and `libzfs_init`'s three refusals (`libzfs_error_init`, exit 1) AS
 * execZpool hands them on once it has also seen `/sys/module/zfs` absent
 * (cr3 re-review 2 item 3: the raw sentence alone is unreadable — see
 * UNREADABLE). The rest are tolerated legacy / non-`-j` shapes (the sentence
 * is printed only without `-j`), and `zpool` not installed.
 */
const NO_POOLS: [string, ExecResult][] = [
  ['source: zpool_do_status -j, no pools (exit 0, empty pools object)', r(0, `{${VERSION},"pools":{}}\n`)],
  ['source: zpool_do_list -j, no pools (exit 0, nothing printed)', r(0, '')],
  ['source: libzfs_init ENOEXEC + no /sys/module/zfs', r(1, '', `${ZFS_MODULE_ABSENT_TAG}${LIBZFS_ENOEXEC}`)],
  ['source: libzfs_init ENXIO + no /sys/module/zfs', r(1, '', `${ZFS_MODULE_ABSENT_TAG}${LIBZFS_ENXIO}`)],
  ['source: libzfs_init ENOENT + no /sys/module/zfs', r(1, '', `${ZFS_MODULE_ABSENT_TAG}${LIBZFS_ENOENT}`)],
  ['tolerated: exit 0, the sentence on stdout', r(0, 'no pools available\n')],
  ['tolerated: exit 0, the sentence on stderr', r(0, '', 'no pools available\n')],
  ['tolerated: exit 1, the sentence on stderr', r(1, '', 'no pools available\n')],
  ['tolerated: exit 1, the sentence on stdout', r(1, 'no pools available\n')],
  ['zpool not installed (execZpool on a spawn ENOENT)', r(127, '', ZPOOL_ABSENT_STDERR)],
]

/** Shapes that are reads that FAILED. */
const UNREADABLE: [string, ExecResult][] = [
  ['exit 1 with an error', r(1, '', 'internal error: Bad file descriptor\n')],
  ['exit 1 saying nothing', r(1, '')],
  ['exit 0 with output that is neither JSON nor the sentence', r(0, 'Segmentation fault\n')],
  ['exit 0 with a JSON array', r(0, '[]')],
  ['exit 127 from a shell (not execZpool\'s absent marker)', r(127, '', 'sh: zpool: not found\n')],
  // cr3 re-review 2 item 2: OpenZFS always emits `pools` when it prints JSON.
  ['exit 0, JSON with no pools key (was "tolerated" before re-review 2)', r(0, `{${VERSION}}`)],
  // cr3 re-review 2 item 3: libzfs's sentence alone (the module may be
  // loaded: a missing /dev/zfs, minor exhaustion) is a failed read.
  ['libzfs_init ENOEXEC, not confirmed by /sys/module/zfs', r(1, '', LIBZFS_ENOEXEC)],
  ['libzfs_init ENXIO, not confirmed', r(1, '', LIBZFS_ENXIO)],
  ['libzfs_init ENOENT, not confirmed', r(1, '', LIBZFS_ENOENT)],
]

describe('cr3 — zpool\'s honest "no pools" vs a read that failed (follow-up 3)', () => {
  for (const [label, res] of NO_POOLS) {
    it(`answered, no pools: ${label}`, () => {
      assert.equal(zpoolListUnreadable(res), null)
      if (res.exitCode === 0)
        assert.deepEqual(parseZpoolList(res.stdout), [])
      assert.deepEqual(readZpoolStatusAnswer(res), { pools: [] })
    })
  }
  for (const [label, res] of UNREADABLE) {
    it(`unreadable: ${label}`, () => {
      assert.ok(zpoolListUnreadable(res))
      assert.ok('unreadable' in readZpoolStatusAnswer(res))
    })
  }

  it('execZpool: a spawn ENOENT is "not installed"; EACCES resolves as a failed read naming it (re-review 2 item 6); a timeout still rejects', async () => {
    const enoent = Object.assign(new Error('spawn /usr/sbin/zpool ENOENT'), { code: 'ENOENT' })
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: r(0, ''), throws: enoent })
    assert.deepEqual(await execZpool(ex, ['status', '-jv']), r(127, '', ZPOOL_ABSENT_STDERR))

    const ex2 = new MockExecutor()
    ex2.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: r(0, ''), throws: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) })
    const denied = await execZpool(ex2, ['status', '-jv'])
    assert.equal(denied.exitCode, 126)
    assert.match(denied.stderr, /the zpool command could not be run \(EACCES/)
    assert.ok(zpoolListUnreadable(denied))

    const ex3 = new MockExecutor()
    ex3.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: r(0, ''), timesOut: {} })
    await assert.rejects(execZpool(ex3, ['status', '-jv']), (err: unknown) => err instanceof CommandTimeoutError)
  })
})

describe('cr3 — a pool-less node keeps its blank disks available (the AHR-only node)', () => {
  /** One genuinely blank disk, sdb; `status` is zpool's answer (or a throw). */
  async function blankDisk(status: ExecResult, throws?: Error): Promise<{ disk: Disk, zfsUnreadable?: string }> {
    const ex = new MockExecutor()
    ex.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: r(0, JSON.stringify({ blockdevices: [{ 'name': 'sdb', 'type': 'disk', 'size': 1073741824, 'model': 'BLANK', 'serial': 'B1', 'tran': 'sata', 'fstype': null, 'mountpoint': null, 'rota': true, 'phy-sec': 512, 'log-sec': 512, 'wwn': null, 'vendor': null, 'rev': null }] })) })
    ex.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: r(0, 'lrwxrwxrwx 1 root root 9 Nov 14 10:00 ata-BLANK_B1 -> ../../sdb\n') })
    ex.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: status, ...(throws && { throws }) })
    ex.addFixture({ command: '/usr/bin/cat', result: r(0, 'Personalities :\nunused devices: <none>\n') })
    const inv = await collectDiskInventory(ex, new DiskIdentityCache(ex), { configfsRoot: '/nonexistent-anas-cr3', saveconfigPath: '/nonexistent-anas-cr3' } as never)
    return { disk: inv.disks[0], ...(inv.zfsUnreadable && { zfsUnreadable: inv.zfsUnreadable }) }
  }

  for (const [label, res] of NO_POOLS.filter(([, x]) => x.stderr !== ZPOOL_ABSENT_STDERR)) {
    it(`${label}: the blank disk is available`, async () => {
      const { disk, zfsUnreadable } = await blankDisk(res)
      assert.equal(zfsUnreadable, undefined)
      assert.equal(disk.status, 'available')
    })
  }

  it('zpool not installed (spawn ENOENT): the blank disk is available, the inventory answers', async () => {
    const { disk, zfsUnreadable } = await blankDisk(r(0, ''), Object.assign(new Error('spawn /usr/sbin/zpool ENOENT'), { code: 'ENOENT' }))
    assert.equal(zfsUnreadable, undefined)
    assert.equal(disk.status, 'available')
  })

  it('control: a real failure still leaves it unknown', async () => {
    const { disk, zfsUnreadable } = await blankDisk(r(1, '', 'internal error\n'))
    assert.ok(zfsUnreadable)
    assert.equal(disk.status, 'unknown')
  })
})

describe('cr3 — the import scan, the property read, telemetry, the detail and PBS (follow-ups 2, 4, 5, 6, 7)', () => {
  let server: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })
  const headers = () => ({ 'x-anas-user': 'root@pam', 'x-anas-user-uid': '0', 'x-anas-privileges': 'Sys.Audit,Sys.Modify', 'x-anas-request-id': randomUUID() })
  const mockOf = (srv: ReturnType<typeof createServer>) => (srv as unknown as { executor: MockExecutor }).executor

  it('(2) `zpool import` with nothing importable — exit 0 and the sentence (node capture) — is []', async () => {
    // The first is OpenZFS 2.4.x `zpool_do_import`'s own (exit 0, stderr); the others tolerated.
    for (const res of [r(0, '', 'no pools available to import\n'), r(0, 'no pools available to import\n'), r(1, '', 'no pools available to import\n')]) {
      server = createServer({ mock: true, logger: false })
      mockOf(server).prependFixture({ command: ZPOOL, args: ['import'], result: res })
      const out = await server.inject({ method: 'GET', url: '/v1/pools/import', headers: headers() })
      assert.equal(out.statusCode, 200, `${JSON.stringify(res)} → ${out.body}`)
      assert.deepEqual((out.json() as { data: unknown[] }).data, [])
      await server.close()
      server = undefined
    }
  })

  it('(4) a property the read did not return, or out of its domain, is null — never wait / false / 0', () => {
    const doc = { pools: { tank: { properties: { autotrim: { value: 'on', source: { type: 'LOCAL', data: '-' } }, autoexpand: { value: 'off', source: { type: 'DEFAULT', data: '-' } }, failmode: { value: 'bogus', source: { type: 'LOCAL', data: '-' } } } } } }
    const props = parseZpoolGet(doc, 'tank')
    assert.deepEqual(props, { ashift: null, autoexpand: false, autoreplace: null, autotrim: true, failmode: null })
    // control: the captured `zpool get all -j` reads every property.
    const full = parseZpoolGet(mockFixtures.zpoolGetAll('testpool').stdout, 'testpool')
    for (const [k, v] of Object.entries(full!))
      assert.notEqual(v, null, `captured ${k}`)
  })

  it('(5) a failed `zpool list` in the telemetry sample sets poolsUnavailable; a good sample omits it', async () => {
    server = createServer({ mock: true, logger: false })
    const good = (await server.inject({ method: 'GET', url: '/v1/telemetry', headers: headers() })).json() as { data: Telemetry }
    assert.equal(good.data.poolsUnavailable, undefined)
    mockOf(server).prependFixture({ command: ZPOOL, args: ['list', '-j'], result: r(1, '', 'internal error: Bad file descriptor\n') })
    const bad = (await server.inject({ method: 'GET', url: '/v1/telemetry', headers: headers() })).json() as { data: Telemetry }
    assert.deepEqual(bad.data.pools, [])
    assert.match(bad.data.poolsUnavailable!, /zpool list -j could not be read/)
  })

  it('(5) a failed `zpool iostat` sets poolsUnavailable too', async () => {
    server = createServer({ mock: true, logger: false })
    mockOf(server).prependFixture({ command: ZPOOL, args: ['iostat', '-plv', '--', 'testpool', '1', '2'], result: r(1, '', 'cannot open \'testpool\': I/O error\n') })
    const t = (await server.inject({ method: 'GET', url: '/v1/telemetry', headers: headers() })).json() as { data: Telemetry }
    assert.match(t.data.poolsUnavailable!, /zpool iostat exited 1/)
  })

  it('(6) GET /pools/:name for a name PoolName refuses answers the detail read-only, with the marker', async () => {
    server = createServer({ mock: true, logger: false })
    const rename = (stdout: string) => stdout.replaceAll('"testpool"', '"tank.v2"')
    const mock = mockOf(server)
    for (const args of [['list', '-j'], ['status', '-jv'], ['get', 'all', '-j']]) {
      const seeded = await mock.exec(ZPOOL, args)
      mock.prependFixture({ command: ZPOOL, args, result: { ...seeded, stdout: rename(seeded.stdout) } })
    }
    const res = await server.inject({ method: 'GET', url: '/v1/pools/tank.v2', headers: headers() })
    assert.equal(res.statusCode, 200, res.body)
    const detail = (res.json() as { data: PoolDetail }).data
    assert.equal(detail.name, 'tank.v2')
    assert.equal(detail.unmanaged?.reason, 'pool-name')
    assert.match(detail.unmanaged!.message, /zpool export 'tank\.v2', then zpool import 'tank\.v2' <new name>/)
  })

  it('(7) the PBS storage read says unreadable; a missing file is the honest []', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anas-cr3-pbs-'))
    try {
      mkdirSync(join(dir, 'storage.cfg'))
      const bad = await readPbsStoragesChecked(join(dir, 'storage.cfg'))
      assert.ok('unreadable' in bad)
      assert.deepEqual(await readPbsStoragesChecked(join(dir, 'absent.cfg')), { defs: [] })
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
