import type { SnapshotSchedule } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../../services/ahr-topology.js'
import {
  ahrSnapshotsMountpoint,
  ensureAhrSnapshotsMount,
  pickBucket,
  resolveSelfService,
  resolveSelfServiceTarget,
  touchesSelfService,
} from '../share-selfservice.js'

// ============================================================================
// share-selfservice — the DECISIONS behind the SMB self-service features
// (smbsvc.1): target resolution (ZFS dataset vs AHR pool), the bucket pick,
// the refusal sentences, and the AHR `@snapshots` mount.
// ============================================================================

function schedule(partial: Partial<SnapshotSchedule>): SnapshotSchedule {
  return {
    id: 's',
    name: 'S',
    target: { kind: 'zfs', dataset: 'testpool/media' },
    cadence: 'daily',
    retention: { daily: 7 },
    notify: 'on-failure',
    enabled: true,
    ...partial,
  }
}

describe('pickBucket — the finest enabled cadence on the target (smbsvc.1)', () => {
  const ZFS = { kind: 'zfs' as const, dataset: 'testpool/media' }

  it('picks the FINEST among several schedules on the dataset', () => {
    const schedules = [
      schedule({ id: 'd', cadence: 'daily', target: ZFS }),
      schedule({ id: 'h', cadence: 'hourly', target: ZFS }),
      schedule({ id: 'w', cadence: 'weekly', target: ZFS }),
    ]
    assert.equal(pickBucket(schedules, ZFS), 'hourly')
  })

  it('`daily` when no schedule targets the dataset', () => {
    assert.equal(pickBucket([], ZFS), 'daily')
    assert.equal(
      pickBucket([schedule({ target: { kind: 'zfs', dataset: 'other/x' } })], ZFS),
      'daily',
    )
  })

  it('a DISABLED schedule exposes nothing (it takes no snapshots)', () => {
    const schedules = [
      schedule({ id: 'h', cadence: 'hourly', enabled: false, target: ZFS }),
      schedule({ id: 'd', cadence: 'daily', target: ZFS }),
    ]
    assert.equal(pickBucket(schedules, ZFS), 'daily')
  })

  it('an AHR target matches only pool schedules, finest first', () => {
    const AHR = { kind: 'ahr' as const, pool: 'tank' }
    const schedules = [
      schedule({ id: 'm', cadence: 'monthly', target: AHR }),
      schedule({ id: 'h', cadence: 'hourly', target: { kind: 'zfs', dataset: 'testpool/media' } }),
    ]
    assert.equal(pickBucket(schedules, AHR), 'monthly')
  })
})

describe('touchesSelfService', () => {
  it('true when any feature field is present (set or clear), false for a plain edit', () => {
    assert.equal(touchesSelfService({}), false)
    assert.equal(touchesSelfService({ readOnly: true }), false)
    assert.equal(touchesSelfService({ previousVersions: { enabled: true } }), true)
    assert.equal(touchesSelfService({ previousVersions: null }), true)
    assert.equal(touchesSelfService({ recycle: null }), true)
    assert.equal(touchesSelfService({ timeMachine: null }), true)
  })
})

// --- Executor fixtures --------------------------------------------------------

const ZFS = '/usr/sbin/zfs'
const ZPOOL = '/usr/sbin/zpool'
const FINDMNT = '/usr/bin/findmnt'

/** The footprint reads datasetOfPath needs: the mountpoint table + boot probe. */
function addZfsFootprintFixtures(mock: MockExecutor, table: string): void {
  mock.addFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint'], result: { stdout: table, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: JSON.stringify({ filesystems: [] }), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: 'testpool\t-\n', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: FINDMNT, args: ['-n', '-o', 'SOURCE,FSTYPE', '/'], result: { stdout: '/dev/sda1\text4\n', stderr: '', exitCode: 0 } })
}

// The single-band raid5×3 pool "tank" recipe (mirrors ahr-snapshots.test.ts):
// mounted subvol=@data, so subvolLayout reads true.
const GIB = 1024 ** 3
const X = 'ata-TANK_X'
const Y = 'ata-TANK_Y'
const Z = 'ata-TANK_Z'
const LV_SIZE = 4 * GIB

const AHR_MDSTAT = `Personalities : [raid5]
md127 : active raid5 sds1[2] sdr1[1] sdq1[0]
      4190208 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

unused devices: <none>
`

function ahrLsblkJson(): string {
  const lvmNode = { name: 'tank-tank--vol', type: 'lvm', size: LV_SIZE, fstype: 'btrfs', mountpoint: '/mnt/anas-ahr/tank', partlabel: null }
  return JSON.stringify({ blockdevices: [X, Y, Z].map(kernel => ({
    name: kernel.replace('ata-TANK_', 'sd').toLowerCase().replace('x', 'q').replace('y', 'r').replace('z', 's'),
    type: 'disk',
    size: 2 * GIB,
    fstype: null,
    mountpoint: null,
    partlabel: null,
    model: 'SYNTH',
    serial: kernel,
    children: [{
      name: `${kernel.replace('ata-TANK_', 'sd').toLowerCase()}-part1`,
      type: 'part',
      size: 2 * GIB - 1024 ** 2,
      fstype: 'linux_raid_member',
      mountpoint: null,
      partlabel: 'tank-d1-b1',
      children: [{ name: 'md127', type: 'raid5', size: 4190208 * 1024, fstype: 'LVM2_member', mountpoint: null, partlabel: null, children: [lvmNode] }],
    }],
  })) })
}

/** Add the full readAhrPools fixture set; `subvol` decides subvolLayout. */
function addAhrPoolFixtures(mock: MockExecutor, opts: { subvol?: string, lvAttr?: string } = {}): void {
  const subvol = opts.subvol ?? 'subvolid=256,subvol=/@data'
  mock.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: AHR_MDSTAT, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: ['--detail', '--export', '/dev/md127'], result: { stdout: 'MD_LEVEL=raid5\nMD_DEVICES=3\nMD_METADATA=1.2\nMD_UUID=aaaa:aaaa:aaaa:aaaa\nMD_DEVNAME=tank-r1\nMD_NAME=anas-test:tank-r1\n', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/bin/lsblk', args: [...AHR_LSBLK_ARGS], result: { stdout: ahrLsblkJson(), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: { stdout: `${[X, Y, Z].map(id => `lrwxrwxrwx 1 root root 9 Jul 23 10:00 ${id} -> ../../sd${id.slice(-1) === 'X' ? 'q' : id.slice(-1) === 'Y' ? 'r' : 's'}`).join('\n')}\n`, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/sbin/vgs', args: [...VGS_ARGS], result: { stdout: JSON.stringify({ report: [{ vg: [{ vg_name: 'tank', pv_count: '1', lv_count: '1', vg_size: String(LV_SIZE), vg_free: '0' }] }] }), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/sbin/lvs', args: [...LVS_ARGS], result: { stdout: JSON.stringify({ report: [{ lv: [{ lv_name: 'tank-vol', vg_name: 'tank', lv_attr: opts.lvAttr ?? '-wi-ao----', lv_size: String(LV_SIZE) }] }] }), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: FINDMNT, args: [...AHR_FINDMNT_ARGS], result: { stdout: JSON.stringify({ filesystems: [{
    target: '/mnt/anas-ahr/tank',
    source: '/dev/mapper/tank-tank--vol',
    fstype: 'btrfs',
    options: `rw,relatime,space_cache=v2,${subvol}`,
  }] }), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/bin/btrfs', result: { stdout: '', stderr: '', exitCode: 0 } })
}

describe('resolveSelfServiceTarget (smbsvc.1)', () => {
  it('a share path under a ZFS dataset mountpoint resolves to that dataset', async () => {
    const mock = new MockExecutor()
    addZfsFootprintFixtures(mock, 'testpool\t/testpool\ntestpool/media\t/testpool/media\n')
    assert.deepEqual(await resolveSelfServiceTarget(mock, '/testpool/media/sub'), { kind: 'zfs', dataset: 'testpool/media' })
  })

  it('a share path under an AHR pool mountpoint resolves to that pool', async () => {
    const mock = new MockExecutor()
    addZfsFootprintFixtures(mock, '') // no ZFS datasets at all
    addAhrPoolFixtures(mock)
    assert.deepEqual(await resolveSelfServiceTarget(mock, '/mnt/anas-ahr/tank/media'), { kind: 'ahr', pool: 'tank' })
  })

  it('a path on neither stack resolves to null', async () => {
    const mock = new MockExecutor()
    addZfsFootprintFixtures(mock, '')
    assert.equal(await resolveSelfServiceTarget(mock, '/srv/scratch'), null)
  })
})

describe('resolveSelfService — keys, shapes, refusals (smbsvc.1)', () => {
  it('a request touching no feature resolves to undefined', async () => {
    const mock = new MockExecutor()
    assert.equal(await resolveSelfService(mock, '/x', {}, { systemdDir: '/tmp' }), undefined)
    assert.equal(await resolveSelfService(mock, '/x', { readOnly: true }, { systemdDir: '/tmp' }), undefined)
  })

  it('the ZFS shape: relative snapdir + snapdirseverywhere, bucket picked from the schedules', async () => {
    const mock = new MockExecutor()
    addZfsFootprintFixtures(mock, 'testpool\t/testpool\ntestpool/media\t/testpool/media\n')
    const dir = await mkdtemp(join(tmpdir(), 'anas-ss-sched-'))
    // One HOURLY schedule on the share's dataset → the finest bucket.
    await writeFile(join(dir, 'anas-snap-hourly.service'), [
      '[Unit]',
      `# X-ANAS-Schedule=${JSON.stringify(schedule({ id: 'hourly', cadence: 'hourly', enabled: true }))}`,
      '',
      '[Service]',
      'Type=oneshot',
      '',
    ].join('\n'), 'utf8')
    const res = await resolveSelfService(mock, '/testpool/media/sub', { previousVersions: { enabled: true } }, { systemdDir: dir })
    assert.deepEqual(res?.keys, { previousVersions: { bucket: 'hourly', snapdir: '.zfs/snapshot', snapdirseverywhere: true } })
    assert.equal(res?.ahrPool, undefined)
    await rm(dir, { recursive: true, force: true })
  })

  it('the AHR shape: absolute snapdir into the pool\'s @snapshots mount, ahrPool named', async () => {
    const mock = new MockExecutor()
    addZfsFootprintFixtures(mock, '')
    addAhrPoolFixtures(mock)
    const res = await resolveSelfService(mock, '/mnt/anas-ahr/tank/media', { previousVersions: { enabled: true } }, { systemdDir: '/nonexistent-units' })
    assert.deepEqual(res?.keys, { previousVersions: { bucket: 'daily', snapdir: ahrSnapshotsMountpoint('tank'), snapdirseverywhere: false } })
    assert.equal(res?.ahrPool, 'tank')
  })

  it(`refuses a path on neither stack: "…no snapshots to expose"`, async () => {
    const mock = new MockExecutor()
    addZfsFootprintFixtures(mock, '')
    await assert.rejects(
      resolveSelfService(mock, '/srv/scratch', { previousVersions: { enabled: true } }, { systemdDir: '/tmp' }),
      (err: Error) => err.message === `'/srv/scratch' is not on a ZFS dataset or an AHR pool — there are no snapshots to expose`,
    )
  })

  it(`refuses a FLAT-layout AHR pool: "pool 'tank' predates the snapshot layout…"`, async () => {
    const mock = new MockExecutor()
    addZfsFootprintFixtures(mock, '')
    // subvol=/ (no @data) → subvolLayout false; the pool still resolves.
    addAhrPoolFixtures(mock, { subvol: 'subvolid=5,subvol=/' })
    await assert.rejects(
      resolveSelfService(mock, '/mnt/anas-ahr/tank/media', { previousVersions: { enabled: true } }, { systemdDir: '/nonexistent-units' }),
      (err: Error) => err.message === `pool 'tank' predates the snapshot layout — Previous Versions needs @snapshots`,
    )
  })

  it('refuses a request that SETS recycle or timeMachine (slice 1 ships Previous Versions only)', async () => {
    const mock = new MockExecutor()
    await assert.rejects(
      resolveSelfService(mock, '/x', { recycle: { purgeDays: 30 } }, { systemdDir: '/tmp' }),
      (err: Error) => /recycle bin is not available/.test(err.message),
    )
    await assert.rejects(
      resolveSelfService(mock, '/x', { timeMachine: { maxSize: 1000 } }, { systemdDir: '/tmp' }),
      (err: Error) => /Time Machine target is not available/.test(err.message),
    )
  })

  it('clearing stays a permitted no-op shape (previousVersions/recycle/timeMachine = null)', async () => {
    const mock = new MockExecutor()
    const pv = await resolveSelfService(mock, '/x', { previousVersions: null }, { systemdDir: '/tmp' })
    assert.deepEqual(pv?.keys, { previousVersions: null })
    const clearAll = await resolveSelfService(mock, '/x', { previousVersions: { enabled: false }, recycle: null, timeMachine: null }, { systemdDir: '/tmp' })
    assert.deepEqual(clearAll?.keys, { previousVersions: null, recycle: null, timeMachine: null })
  })
})

describe('ensureAhrSnapshotsMount — ONE fstab line, mounted once (smbsvc.1)', () => {
  let dir: string
  let fstabPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ss-fstab-'))
    fstabPath = join(dir, 'fstab')
    await writeFile(fstabPath, '# anas test fstab\n', 'utf8')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the read-only @snapshots line and mounts it now', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: FINDMNT, args: ['-n', '-o', 'TARGET', ahrSnapshotsMountpoint('tank')], result: { stdout: '', stderr: '', exitCode: 1 } })
    await ensureAhrSnapshotsMount(mock, fstabPath, 'tank')
    const fstab = await readFile(fstabPath, 'utf8')
    const line = fstab.split('\n').find(l => l.includes('anas-ahr-snapshots/tank'))
    assert.ok(line, 'the @snapshots mount line exists')
    assert.match(line!, /^\/dev\/tank\/tank-vol\s+\/mnt\/anas-ahr-snapshots\/tank\s+btrfs\s+ro,nofail,subvol=@snapshots\s+0 0$/)
    // The mount happened NOW, via the fstab entry.
    const mountCall = mock.calls.find(c => c.command === '/usr/bin/mount')
    assert.deepEqual(mountCall, { command: '/usr/bin/mount', args: [ahrSnapshotsMountpoint('tank')] })
  })

  it('a second ensure rewrites nothing and does not mount again (idempotent)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: FINDMNT, result: { stdout: `${ahrSnapshotsMountpoint('tank')}\n`, stderr: '', exitCode: 0 } })
    await ensureAhrSnapshotsMount(mock, fstabPath, 'tank')
    // The line is added; findmnt says it is mounted → no mount command.
    const once = await readFile(fstabPath, 'utf8')
    assert.match(once, /anas-ahr-snapshots\/tank/)
    assert.equal(mock.calls.filter(c => c.command === '/usr/bin/mount').length, 0)

    await ensureAhrSnapshotsMount(mock, fstabPath, 'tank')
    const twice = await readFile(fstabPath, 'utf8')
    assert.equal(twice, once, 'the fstab line is written ONCE')
  })

  it('the mount STAYS when the feature is later turned off (nothing removes it)', async () => {
    // By design the disable path never calls this service — the assertion is
    // the contract statement: there is no removal verb here to call.
    const mock = new MockExecutor()
    mock.addFixture({ command: FINDMNT, result: { stdout: `${ahrSnapshotsMountpoint('tank')}\n`, stderr: '', exitCode: 0 } })
    await ensureAhrSnapshotsMount(mock, fstabPath, 'tank')
    const after = await readFile(fstabPath, 'utf8')
    assert.match(after, /anas-ahr-snapshots\/tank/)
  })
})
