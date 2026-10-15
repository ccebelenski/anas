import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { dmsetupStatusArgs } from '../../parsers/dmsetup.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { LVS_ARGS, PVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { ahrMutationRoutes } from '../ahr-mutate.js'
import { jobRoutes } from '../jobs.js'

/**
 * Story cr.23 — the AHR destroy and remount routes decide "system pool" from
 * the LIVE mount table, never from a name. An AHR pool has no boot facts, so
 * the table is its whole answer: one of the pool's own filesystems AT a system
 * path is a hard 409 (`system-pool`, no confirm bypass), and an unreadable
 * table is treated as a system pool — a missing fact may only tighten the
 * gate. Mounted only at its ordinary `/mnt/anas-ahr/<pool>` base, the pool
 * meets the normal confirm gate like any other.
 *
 * The synthetic one-band pool `tank` and its topology fixtures are the
 * ahr-remount suite's; only the mount table varies per test.
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2

const X = 'ata-TANK_X'
const Y = 'ata-TANK_Y'

const DISK_SIZE = 2 * GIB + 8 * MIB
const BAND_SIZE = 2 * GIB - MIB
const LV_SIZE = 2143289344
const MOUNTPOINT = '/mnt/anas-ahr/tank'
const DM_NAME = 'tank-tank--vol'
const MAPPER = `/dev/mapper/${DM_NAME}`

const MDSTAT = `Personalities : [raid1]
md127 : active raid1 sdr1[1] sdq1[0]
      2096128 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`
const MD_EXPORT = `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_METADATA=1.2\nMD_UUID=aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa\nMD_DEVNAME=tank-r1\nMD_NAME=anas-test:tank-r1\n`

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

const RW_OPTIONS = 'rw,relatime,space_cache=v2,subvolid=256,subvol=/@data'
const RO_OPTIONS = 'ro,relatime,space_cache=v2,subvolid=256,subvol=/@data'

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

/** A `findmnt --json --real` table from flat rows. */
function findmntJson(rows: { target: string, source: string, fstype: string, options?: string }[]): string {
  return JSON.stringify({
    filesystems: rows.map(r => ({ target: r.target, source: r.source, fstype: r.fstype, options: r.options ?? RW_OPTIONS })),
  })
}

/** Every world starts from an ordinary PVE-ish root the pool has nothing to do with. */
function table(...rows: { target: string, source: string, fstype: string, options?: string }[]): string {
  return findmntJson(
    [{ target: '/', source: '/dev/mapper/pve-root', fstype: 'ext4', options: 'rw,relatime' }, ...rows],
  )
}

const UNREADABLE: ExecResult = { stdout: '', stderr: 'findmnt: cannot read mount table', exitCode: 1 }

const BTRFS_USAGE = [
  'Overall:',
  `    Device size:\t\t${LV_SIZE}`,
  '    Used:\t\t1048576',
  `    Free (estimated):\t\t${LV_SIZE - 2 * MIB}\t(min: ${LV_SIZE - 4 * MIB})`,
  '',
].join('\n')

const BY_ID_LISTING = [
  `lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${X} -> ../../sdq`,
  `lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${X}-part1 -> ../../sdq1`,
  `lrwxrwxrwx 1 root root 9 Sep 24 20:00 ${Y} -> ../../sdr`,
  `lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${Y}-part1 -> ../../sdr1`,
  '',
].join('\n')

/**
 * The `tank` topology, mounted read-write at MOUNTPOINT (lsblk's view always
 * agrees it is mounted; the findmnt table decides the STATE and may name
 * additional mounts of the same volume, e.g. a subvolume at /home).
 */
function buildExecutor(findmnt: ExecResult): MockExecutor {
  const executor = new MockExecutor()
  const lvmNode = { name: DM_NAME, type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: MOUNTPOINT, partlabel: null }
  const member = (kernel: string, id: string, n: number) => ({
    name: kernel,
    type: 'disk',
    size: DISK_SIZE,
    fstype: null,
    mountpoint: null,
    partlabel: null,
    model: 'SYNTH DISK',
    serial: id,
    children: [{
      name: `${kernel}1`,
      type: 'part',
      size: BAND_SIZE,
      fstype: 'linux_raid_member',
      mountpoint: null,
      partlabel: `tank-d${n}-b1`,
      children: [{ name: 'md127', type: 'raid1', size: 2096128 * 1024, fstype: 'LVM2_member', mountpoint: null, partlabel: null, children: [lvmNode] }],
    }],
  })
  const ahrLsblk = JSON.stringify({ blockdevices: [member('sdq', X, 1), member('sdr', Y, 2)] })
  const flat = (kernel: string, id: string) => ({
    'name': kernel,
    'type': 'disk',
    'size': DISK_SIZE,
    'model': 'SYNTH DISK',
    'serial': id,
    'tran': 'sata',
    'fstype': null,
    'mountpoint': null,
    'rota': true,
    'phy-sec': 512,
    'log-sec': 512,
    'children': [{ name: `${kernel}1`, type: 'part', size: BAND_SIZE, fstype: 'linux_raid_member', mountpoint: null }],
  })
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: ok(MDSTAT) })
  executor.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: ok(MD_EXPORT) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: ok(ahrLsblk) })
  executor.addFixture({ command: '/usr/bin/lsblk', args: [...LSBLK_ARGS], result: ok(JSON.stringify({ blockdevices: [flat('sdq', X), flat('sdr', Y)] })) })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(BY_ID_LISTING) })
  executor.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: ok(JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '1', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] })) })
  executor.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: ok(JSON.stringify({ report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: '-wi-ao----', lv_size: String(LV_SIZE) }] }] })) })
  executor.addFixture({ command: '/usr/sbin/pvs', args: [...PVS_ARGS], result: ok(JSON.stringify({ report: [{ pv: [{ pv_name: '/dev/md127', vg_name: 'tank', pv_size: String(LV_SIZE), pv_free: '0', dev_size: String(LV_SIZE + 2 * MIB) }] }] })) })
  executor.addFixture({ command: '/usr/sbin/dmsetup', args: dmsetupStatusArgs(DM_NAME), result: ok('0 4186624 linear \n') })
  executor.addFixture({ command: '/usr/bin/findmnt', args: [...AHR_FINDMNT_ARGS], result: findmnt })
  executor.addFixture({ command: '/usr/bin/btrfs', args: ['filesystem', 'usage', '-b', MOUNTPOINT], result: ok(BTRFS_USAGE) })
  executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '', stderr: '', exitCode: 1 } })
  executor.addFixture({ command: '/usr/bin/perl', result: ok('') })
  return executor
}

describe('AHR system-pool guard (cr.23) — the live mount table decides', () => {
  let dir: string
  let server: ReturnType<typeof Fastify> | undefined

  async function build(findmnt: ExecResult) {
    const executor = buildExecutor(findmnt)
    const jobQueue = new JobQueue()
    server = Fastify({ logger: false })
    await server.register(jobRoutes, { prefix: '/v1', jobQueue })
    await server.register(ahrMutationRoutes, {
      prefix: '/v1',
      executor,
      jobQueue,
      confirmStore: new ConfirmStore(),
      diskIdentityCache: new DiskIdentityCache(executor),
      fstabPath: join(dir, 'fstab'),
      mdadmConfPath: join(dir, 'mdadm.conf'),
      mountBase: join(dir, 'mnt'),
      iscsiPaths: { saveConfigPath: join(dir, 'saveconfig.json'), configfsRoot: join(dir, 'configfs') },
    })
    await server.ready()
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-system-pool-'))
    await writeFile(join(dir, 'fstab'), `/dev/tank/tank-vol ${MOUNTPOINT} btrfs subvol=@data,nofail 0 0\n`)
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
  })

  /** Assert the hard system-pool 409 (never a confirm code) and return the message. */
  function systemPoolMessage(res: { statusCode: number, headers: Record<string, string | string[] | undefined>, json: () => { error: { code: string, reason?: string, message: string } } }): string {
    assert.equal(res.statusCode, 409)
    const body = res.json()
    assert.equal(body.error.code, 'CONFLICT')
    assert.equal(body.error.reason, 'system-pool')
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'a hard refusal never offers a confirm code')
    return body.error.message
  }

  const destroy = (headers: Record<string, string> = IDENTITY_HEADERS) =>
    server!.inject({ method: 'DELETE', url: '/v1/ahr/tank', headers })
  const remount = (headers: Record<string, string> = IDENTITY_HEADERS) =>
    server!.inject({ method: 'POST', url: '/v1/ahr/tank/remount', headers })

  it('destroy: a pool with one of its own filesystems mounted at /home is refused — the sentence names /home', async () => {
    // The subvolume mount form findmnt --real emits for a btrfs subvol; the
    // pool is tank by DECODED device identity, not by anything the name says.
    await build(ok(table(
      { target: MOUNTPOINT, source: MAPPER, fstype: 'btrfs' },
      { target: '/home', source: `${MAPPER}[/@home]`, fstype: 'btrfs' },
    )))
    const message = systemPoolMessage(await destroy())
    assert.match(message, /^AHR pool 'tank' is mounted at \/home —/)
    assert.match(message, /never destroys or remounts a system pool/)
    // A confirm code buys nothing — Level-1, no bypass.
    const again = await destroy({ ...IDENTITY_HEADERS, 'x-anas-confirm': 'anything' })
    assert.equal(again.json().error.reason, 'system-pool')
  })

  it('destroy: a pool mounted only at its ordinary /mnt/anas-ahr base meets the normal confirm gate', async () => {
    await build(ok(table({ target: MOUNTPOINT, source: MAPPER, fstype: 'btrfs' })))
    const res = await destroy()
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'], 'the ordinary dangerous-op gate, not a system-pool refusal')
  })

  it('destroy: an unreadable mount table is treated as a system pool (fail closed)', async () => {
    await build(UNREADABLE)
    const message = systemPoolMessage(await destroy())
    assert.match(message, /the mount table is unreadable/)
    assert.match(message, /never destroys or remounts a system pool/)
  })

  it('remount: a read-only pool with a subvolume at /home is refused BEFORE any confirm code is minted', async () => {
    await build(ok(table(
      { target: MOUNTPOINT, source: MAPPER, fstype: 'btrfs', options: RO_OPTIONS },
      { target: '/home', source: `${MAPPER}[/@home]`, fstype: 'btrfs', options: RO_OPTIONS },
    )))
    const message = systemPoolMessage(await remount())
    assert.match(message, /^AHR pool 'tank' is mounted at \/home —/)
  })
})
