import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { parseFindmnt } from '../../parsers/findmnt.js'
import {
  ahrPoolFromMountSource,
  ahrSystemMountRefusal,
  decodeDmName,
  readSystemMountPools,
  systemMountPoolsFromJson,
  systemMountPoolsFromNodes,
  zfsPoolFromMountSource,
} from '../system-mounts.js'

/**
 * Story cr.23 — the live-mount-table facts behind the system-pool refusal.
 * The captures are the shapes real `findmnt --json` output takes on the node
 * forms the ruling names: ext4/LVM root (the ordinary PVE install), ZFS root
 * (`rpool/ROOT/pve-1` at `/`, a boot pool at `/boot`), and a data pool parked
 * on a system path (the case the name list never saw).
 */

/** Build a `findmnt --json` table from flat rows (the shape util-linux emits). */
function findmntJson(rows: { target: string, source: string, fstype: string, options?: string }[]): string {
  return JSON.stringify({
    filesystems: rows.map(r => ({
      target: r.target,
      source: r.source,
      fstype: r.fstype,
      options: r.options ?? 'rw,relatime',
    })),
  })
}

describe('systemMountPoolsFromNodes — the captures', () => {
  it('an ext4/LVM root (/dev/mapper/pve-root at /) flags NO pool', () => {
    const facts = systemMountPoolsFromNodes(parseFindmnt(findmntJson([
      { target: '/', source: '/dev/mapper/pve-root', fstype: 'ext4' },
      { target: '/boot', source: '/dev/sda2', fstype: 'ext4' },
      { target: '/boot/efi', source: '/dev/sda1', fstype: 'vfat' },
    ])))
    assert.equal(facts.zfs.size, 0)
    assert.equal(facts.ahr.size, 0)
  })

  it('a ZFS root flags both the root pool and the boot pool dataset', () => {
    const facts = systemMountPoolsFromNodes(parseFindmnt(findmntJson([
      { target: '/', source: 'rpool/ROOT/pve-1', fstype: 'zfs' },
      { target: '/boot', source: 'bpool/BOOT/ubuntu', fstype: 'zfs' },
      { target: '/tank/data', source: 'tank/data', fstype: 'zfs' },
    ])))
    assert.deepEqual([...facts.zfs], [['rpool', '/'], ['bpool', '/boot']])
    assert.equal(facts.ahr.size, 0)
  })

  it('a data pool dataset parked at /var or /home is flagged', () => {
    const facts = systemMountPoolsFromNodes(parseFindmnt(findmntJson([
      { target: '/', source: '/dev/sda1', fstype: 'ext4' },
      { target: '/var', source: 'tank/var', fstype: 'zfs' },
      { target: '/home', source: 'data/home', fstype: 'zfs' },
    ])))
    assert.deepEqual([...facts.zfs], [['tank', '/var'], ['data', '/home']])
  })

  it('a dataset at /var/lib/remote is NOT flagged — only exact system paths are', () => {
    const facts = systemMountPoolsFromNodes(parseFindmnt(findmntJson([
      { target: '/var/lib/remote', source: 'tank/remote', fstype: 'zfs' },
      { target: '/home/shares/nas', source: 'tank/shares', fstype: 'zfs' },
    ])))
    assert.equal(facts.zfs.size, 0)
  })

  it('an AHR pool mounted at a system path is flagged — mapper path, subvol suffix, and /dev/<vg>/<lv>', () => {
    const facts = systemMountPoolsFromNodes(parseFindmnt(findmntJson([
      { target: '/home', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs' },
      { target: '/srv', source: '/dev/mapper/backup-backup--vol[/@data]', fstype: 'btrfs' },
      { target: '/tmp', source: '/dev/spares/spares-vol', fstype: 'btrfs' },
    ])))
    assert.deepEqual([...facts.ahr], [['tank', '/home'], ['backup', '/srv'], ['spares', '/tmp']])
    assert.equal(facts.zfs.size, 0)
  })

  it('an AHR pool at its ordinary /mnt base is NOT flagged', () => {
    const facts = systemMountPoolsFromNodes(parseFindmnt(findmntJson([
      { target: '/mnt/anas-ahr/tank', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs' },
    ])))
    assert.equal(facts.ahr.size, 0)
  })

  it('a pool name that needs dm escaping resolves through the decode', () => {
    // dmName('data-1', 'data-1-vol') === 'data--1-data--1--vol'
    const facts = systemMountPoolsFromNodes(parseFindmnt(findmntJson([
      { target: '/root', source: '/dev/mapper/data--1-data--1--vol', fstype: 'btrfs' },
    ])))
    assert.deepEqual([...facts.ahr], [['data-1', '/root']])
  })

  it('non-pool mounts at system paths (tmpfs, devtmpfs, plain LVM) flag nothing', () => {
    const facts = systemMountPoolsFromNodes(parseFindmnt(findmntJson([
      { target: '/run', source: 'tmpfs', fstype: 'tmpfs' },
      { target: '/dev', source: 'devtmpfs', fstype: 'devtmpfs' },
      { target: '/var', source: '/dev/mapper/vg-root', fstype: 'xfs' },
      { target: '/boot', source: '/dev/sda15', fstype: 'vfat' },
      { target: '/usr', source: '/dev/sda3', fstype: 'ext4' },
    ])))
    assert.equal(facts.zfs.size, 0)
    assert.equal(facts.ahr.size, 0)
  })
})

describe('zfsPoolFromMountSource — a bind of the pool ROOT dataset (cr.60, review L23)', () => {
  it('strips findmnt\'s `[fsroot]` bind suffix before taking the dataset head', () => {
    // `mnttest` is the captured root-dataset source (findmnt-full.json); the
    // suffix is the form the AHR captures show (`…--vol[/@data]`).
    assert.equal(zfsPoolFromMountSource('mnttest[/home]'), 'mnttest')
    assert.equal(zfsPoolFromMountSource('mnttest/data[/sub]'), 'mnttest')
    assert.equal(zfsPoolFromMountSource('mnttest'), 'mnttest')
    assert.equal(zfsPoolFromMountSource(''), null)
  })

  it('a pool whose ROOT dataset is bound at /home is a system pool', () => {
    const facts = systemMountPoolsFromNodes(parseFindmnt(findmntJson([
      { target: '/', source: '/dev/mapper/pve-root', fstype: 'ext4' },
      { target: '/mnttest', source: 'mnttest', fstype: 'zfs' },
      { target: '/home', source: 'mnttest[/home]', fstype: 'zfs' },
    ])))
    assert.deepEqual([...facts.zfs], [['mnttest', '/home']])
  })
})

describe('decodeDmName / ahrPoolFromMountSource', () => {
  it('dmName round-trips: the first single dash separates, `--` is a literal dash', () => {
    assert.deepEqual(decodeDmName('pve-root'), { vg: 'pve', lv: 'root' })
    assert.deepEqual(decodeDmName('data--1-data--1--vol'), { vg: 'data-1', lv: 'data-1-vol' })
    assert.equal(decodeDmName('nosep'), null)
  })

  it('only the vol-LV convention answers a pool', () => {
    assert.equal(ahrPoolFromMountSource('/dev/mapper/pve-root'), null)
    assert.equal(ahrPoolFromMountSource('/dev/mapper/tank-tank--cache'), null)
    assert.equal(ahrPoolFromMountSource('/dev/mapper/tank-tank--vol[/@data]'), 'tank')
    assert.equal(ahrPoolFromMountSource('/dev/tank/tank-vol'), 'tank')
    assert.equal(ahrPoolFromMountSource('/dev/sda1'), null)
    assert.equal(ahrPoolFromMountSource('tmpfs'), null)
  })
})

describe('readSystemMountPools — fail-closed reads', () => {
  it('reads the table through the executor', async () => {
    const exec = new MockExecutor()
    exec.addFixture({
      command: '/usr/bin/findmnt',
      args: ['--json'],
      result: { stdout: findmntJson([{ target: '/var', source: 'tank/var', fstype: 'zfs' }]), stderr: '', exitCode: 0 },
    })
    const facts = await readSystemMountPools(exec)
    assert.deepEqual([...facts!.zfs], [['tank', '/var']])
  })

  it('a non-zero exit is UNREADABLE (null), not empty', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: '', stderr: 'findmnt: boom', exitCode: 1 } })
    assert.equal(await readSystemMountPools(exec), null)
  })

  it('an unmatched command (findmnt missing, exit 127) is UNREADABLE', async () => {
    assert.equal(await readSystemMountPools(new MockExecutor()), null)
  })

  it('garbage output is UNREADABLE (null) — never the empty answer', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: 'not json at all', stderr: '', exitCode: 0 } })
    assert.equal(await readSystemMountPools(exec), null)
    assert.equal(systemMountPoolsFromJson('{ "filesystems": [ },'), null)
  })

  it('valid JSON of the wrong shape is UNREADABLE too, and never throws (cr.23 review)', () => {
    for (const text of ['{}', '[]', 'null', '"str"', '42', '{"report":[]}', '{"filesystems":42}', '{"filesystems":null}', '{"filesystems":[null]}', '{"filesystems":[{"target":"/","children":42}]}'])
      assert.equal(systemMountPoolsFromJson(text), null, text)
    // The genuinely empty table stays a readable "no pool at a system path".
    assert.deepEqual(systemMountPoolsFromJson('{"filesystems":[]}'), { zfs: new Map(), ahr: new Map() })
  })

  it('the caller can pass the AHR table args', async () => {
    const exec = new MockExecutor()
    exec.addFixture({
      command: '/usr/bin/findmnt',
      args: ['--json', '--real'],
      result: { stdout: findmntJson([{ target: '/home', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs' }]), stderr: '', exitCode: 0 },
    })
    const facts = await readSystemMountPools(exec, ['--json', '--real'])
    assert.deepEqual([...facts!.ahr], [['tank', '/home']])
  })
})

describe('ahrSystemMountRefusal', () => {
  it('names the mount path when the pool holds one', () => {
    const facts = systemMountPoolsFromNodes(parseFindmnt(findmntJson([
      { target: '/home', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs' },
    ])))
    const refusal = ahrSystemMountRefusal('tank', facts)
    assert.equal(refusal?.reason, 'system-pool')
    assert.match(refusal!.message, /^AHR pool 'tank' is mounted at \/home/)
  })

  it('an unreadable mount table refuses', () => {
    const refusal = ahrSystemMountRefusal('tank', null)
    assert.equal(refusal?.reason, 'system-pool')
    assert.match(refusal!.message, /mount table is unreadable/)
  })

  it('a pool with no system-path mount is free', () => {
    const facts = systemMountPoolsFromNodes(parseFindmnt(findmntJson([
      { target: '/mnt/anas-ahr/tank', source: '/dev/mapper/tank-tank--vol', fstype: 'btrfs' },
    ])))
    assert.equal(ahrSystemMountRefusal('tank', facts), null)
  })
})
