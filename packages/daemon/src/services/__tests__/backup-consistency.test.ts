import type { AhrPool } from '@anas/shared'
import type { ConsistencyFacts } from '../backup-consistency.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { deriveArchiveConsistency, deriveConsistency, filesystemOf, isZvolConsistency, readConsistencyFacts } from '../backup-consistency.js'
import { mountIndex } from '../nested-filesystems.js'

/**
 * backup2.3 — the DERIVED per-source consistency matrix.
 *
 * Every case in the story's matrix is expressible as a mount table plus an AHR
 * pool list, which is exactly why the derivation is pure over those two facts:
 * a ZFS dataset root, a plain SUBDIRECTORY of a dataset, an AHR pool on the
 * subvolume layout, a FLAT (pre-layout) AHR pool, a remote mount, and a plain
 * path on a foreign filesystem.
 */

const FINDMNT = '/usr/bin/findmnt'

/** A findmnt tree covering the whole matrix in one table. */
const TABLE = JSON.stringify({
  filesystems: [{
    target: '/',
    source: '/dev/sda1',
    fstype: 'ext4',
    options: 'rw,relatime',
    children: [
      { target: '/tank', source: 'tank', fstype: 'zfs', options: 'rw,xattr' },
      { target: '/tank/media', source: 'tank/media', fstype: 'zfs', options: 'rw,xattr' },
      // A `.zfs/snapshot` automount — its SOURCE carries the `@`.
      {
        target: '/tank/media/.zfs/snapshot/s1',
        source: 'tank/media@s1',
        fstype: 'zfs',
        options: 'ro',
      },
      { target: '/mnt/ahr1', source: '/dev/ahr1/data', fstype: 'btrfs', options: 'rw,subvol=/@data' },
      { target: '/mnt/ahrflat', source: '/dev/ahrflat/data', fstype: 'btrfs', options: 'rw,subvol=/' },
      { target: '/mnt/foreignbtrfs', source: '/dev/sdz1', fstype: 'btrfs', options: 'rw,subvol=/' },
      { target: '/mnt/nas', source: '10.0.0.9:/export', fstype: 'nfs4', options: 'rw' },
      { target: '/mnt/win', source: '//server/share', fstype: 'cifs', options: 'rw' },
      { target: '/etc/pve', source: '/dev/fuse', fstype: 'fuse', options: 'rw' },
    ],
  }],
})

function pool(name: string, mountpoint: string, subvolLayout: boolean, mounted = true): AhrPool {
  // Only the four fields the derivation reads are meaningful; the rest of
  // AhrPool is structural and irrelevant here.
  return { name, mountpoint, subvolLayout, mounted } as unknown as AhrPool
}

const FACTS: ConsistencyFacts = {
  mounts: mountIndex(TABLE),
  ahrPools: [
    pool('ahr1', '/mnt/ahr1', true),
    pool('ahrflat', '/mnt/ahrflat', false),
  ],
  // backup2.4 — the zvol branch's PVE-territory guard. `pvepool` is a pool PVE
  // manages (a `zfspool` storage in storage.cfg); `tank` is ANAS's.
  pvePools: new Set(['pvepool']),
}

describe('backup consistency derivation (backup2.3)', () => {
  it('a ZFS dataset ROOT is snapshot-consistent and names its dataset', () => {
    const c = deriveConsistency('/tank/media', FACTS)
    assert.equal(c.consistency, 'snapshot')
    assert.equal(c.backend, 'zfs')
    assert.equal(c.target, 'tank/media')
    assert.equal(c.mountpoint, '/tank/media')
    assert.equal(c.relativePath, '')
    assert.match(c.reason, /recursive snapshot/)
  })

  it('a plain SUBDIRECTORY of a dataset maps to <dataset> + the relative path', () => {
    // The whole point: `/tank/media/photos/raw` is not a dataset, so the run
    // snapshots `tank/media` and points the archive at
    // `/tank/media/.zfs/snapshot/<s>/photos/raw`.
    const c = deriveConsistency('/tank/media/photos/raw', FACTS)
    assert.equal(c.consistency, 'snapshot')
    assert.equal(c.target, 'tank/media')
    assert.equal(c.mountpoint, '/tank/media')
    assert.equal(c.relativePath, 'photos/raw')
  })

  it('the LONGEST matching mount wins — a child dataset is not attributed to its parent', () => {
    assert.equal(deriveConsistency('/tank/media', FACTS).target, 'tank/media')
    assert.equal(deriveConsistency('/tank/other', FACTS).target, 'tank')
  })

  it('a path already INSIDE a .zfs snapshot is live, and says so', () => {
    const c = deriveConsistency('/tank/media/.zfs/snapshot/s1/tree', FACTS)
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /already inside a ZFS snapshot/)
  })

  it('an AHR pool on the @data/@snapshots layout is snapshot-consistent', () => {
    const c = deriveConsistency('/mnt/ahr1/share', FACTS)
    assert.equal(c.consistency, 'snapshot')
    assert.equal(c.backend, 'ahr')
    assert.equal(c.target, 'ahr1')
    assert.equal(c.mountpoint, '/mnt/ahr1')
    assert.equal(c.relativePath, 'share')
    // GT-52: the reason must NOT promise that nested subvolumes ride along for
    // free — they get their own snapshots.
    assert.match(c.reason, /nested subvolume/)
  })

  it('a FLAT (pre-layout) AHR pool is live, naming the layout as the reason', () => {
    const c = deriveConsistency('/mnt/ahrflat/share', FACTS)
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /subvolume layout/)
    assert.equal(c.backend, undefined)
  })

  it('an UNMOUNTED AHR pool is live, not a snapshot claim', () => {
    const facts = { ...FACTS, ahrPools: [pool('ahr1', '/mnt/ahr1', true, false)] }
    const c = deriveConsistency('/mnt/ahr1/share', facts)
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /not mounted/)
  })

  it('a btrfs filesystem that is NOT an ANAS pool is live — we do not snapshot what we do not manage', () => {
    const c = deriveConsistency('/mnt/foreignbtrfs/data', FACTS)
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /not an ANAS AHR pool/)
  })

  it('a remote mount is live and names the server as the owner of its snapshots', () => {
    for (const path of ['/mnt/nas/pictures', '/mnt/win/share']) {
      const c = deriveConsistency(path, FACTS)
      assert.equal(c.consistency, 'live', path)
      assert.match(c.reason, /remote mount/, path)
    }
  })

  it('a plain path on a foreign local filesystem is live', () => {
    const c = deriveConsistency('/srv/data', FACTS)
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /no snapshot mechanism/)
  })

  it('a FUSE mount (pmxcfs) is live', () => {
    const c = deriveConsistency('/etc/pve', FACTS)
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /FUSE/)
  })

  it('an unreadable mount table derives LIVE and says the derivation could not see the system', () => {
    const c = deriveConsistency('/tank/media', { mounts: new Map(), ahrPools: [], pvePools: new Set() })
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /mount table could not be read/)
  })

  it('filesystemOf is longest-prefix, and the root filesystem is the floor', () => {
    assert.equal(filesystemOf('/tank/media/x', FACTS.mounts)?.source, 'tank/media')
    assert.equal(filesystemOf('/var/log', FACTS.mounts)?.source, '/dev/sda1')
  })

  it('reads its facts once and never stats a path (the hang trap)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: TABLE, stderr: '', exitCode: 0 } })
    const facts = await readConsistencyFacts(mock, async () => FACTS.ahrPools, { pveStorageCfg: '/nonexistent/storage.cfg' })
    assert.ok(facts.mounts.size > 0)
    // storage.cfg is a FILE read (fail-open), so the executor still sees exactly
    // one command and no path is ever stat'ed.
    assert.deepEqual(mock.calls, [{ command: FINDMNT, args: ['--json'] }])
    assert.equal(facts.pvePools.size, 0)
  })

  it('both probes fail OPEN — a throwing AHR read never fails the derivation', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: TABLE, stderr: '', exitCode: 0 } })
    const facts = await readConsistencyFacts(mock, async () => {
      throw new Error('lvm is unhappy')
    })
    assert.deepEqual(facts.ahrPools, [])
    // A btrfs pool with no topology to identify it degrades to live, not a crash.
    assert.equal(deriveConsistency('/mnt/ahr1', facts).consistency, 'live')
  })

  it('derives a whole archive list in order from ONE fact read', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: TABLE, stderr: '', exitCode: 0 } })
    const out = await deriveArchiveConsistency(
      mock,
      [{ path: '/tank/media' }, { path: '/mnt/nas/x' }, { path: '/mnt/ahr1' }],
      async () => FACTS.ahrPools,
    )
    assert.deepEqual(out.map(c => c.consistency), ['snapshot', 'live', 'snapshot'])
    assert.equal(mock.calls.filter(c => c.command === FINDMNT).length, 1)
  })
})

/**
 * backup2.4 — the same derivation, asked about BLOCK sources.
 *
 * Two shapes, and they answer for different reasons: a ZVOL is not in the mount
 * table at all (so it is answered before the table is consulted, or `/dev`'s own
 * devtmpfs row would claim it), and an IMAGE FILE is answered by exactly the
 * directory rules — its filesystem's snapshot, with the file's own relative path
 * under the snapshot root.
 */
describe('backup consistency derivation — block sources (backup2.4)', () => {
  it('a zvol on an ANAS pool is snapshot-consistent, via its snapshot DEVICE', () => {
    const c = deriveConsistency('/dev/zvol/tank/vol1', FACTS)
    assert.equal(c.consistency, 'snapshot')
    assert.equal(c.backend, 'zfs')
    assert.equal(c.target, 'tank/vol1')
    assert.equal(c.zvolDevice, '/dev/zvol/tank/vol1')
    // A volume has no mountpoint and no `.zfs/snapshot` tree — claiming either
    // would send the runner at a path that does not exist.
    assert.equal(c.mountpoint, undefined)
    assert.equal(c.relativePath, undefined)
    assert.match(c.reason, /snapdev/)
  })

  it('a nested zvol path keeps its FULL dataset name', () => {
    const c = deriveConsistency('/dev/zvol/tank/luns/vm1', FACTS)
    assert.equal(c.target, 'tank/luns/vm1')
    assert.equal(c.zvolDevice, '/dev/zvol/tank/luns/vm1')
  })

  it('a zvol on a PVE-managed pool is LIVE and hands-off (3.25)', () => {
    const c = deriveConsistency('/dev/zvol/pvepool/somevol', FACTS)
    assert.equal(c.consistency, 'live')
    assert.equal(c.zvolDevice, undefined)
    assert.match(c.reason, /PVE manages/)
  })

  it('a PVE GUEST volume is LIVE whatever pool it is on', () => {
    const c = deriveConsistency('/dev/zvol/tank/vm-101-disk-0', FACTS)
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /PVE guest volume/)
  })

  it('a plain block device is LIVE, and says the image is crash-consistent', () => {
    const c = deriveConsistency('/dev/sdb', FACTS)
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /crash-consistent/)
    // NOT "on udev (devtmpfs)": the device branch answers before the mount table.
    assert.doesNotMatch(c.reason, /devtmpfs/)
  })

  it('an image FILE on a ZFS dataset follows the directory rules exactly', () => {
    const c = deriveConsistency('/tank/media/images/lun.raw', FACTS)
    assert.equal(c.consistency, 'snapshot')
    assert.equal(c.backend, 'zfs')
    assert.equal(c.target, 'tank/media')
    assert.equal(c.mountpoint, '/tank/media')
    assert.equal(c.relativePath, 'images/lun.raw')
    assert.equal(c.zvolDevice, undefined)
  })

  it('an image FILE on an AHR @data pool is snapshot-consistent, on the pool', () => {
    const c = deriveConsistency('/mnt/ahr1/images/lun.raw', FACTS)
    assert.equal(c.consistency, 'snapshot')
    assert.equal(c.backend, 'ahr')
    assert.equal(c.target, 'ahr1')
    assert.equal(c.relativePath, 'images/lun.raw')
  })

  it('an image FILE on a remote mount is LIVE, named as a remote mount', () => {
    const c = deriveConsistency('/mnt/nas/images/lun.raw', FACTS)
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /remote mount/)
  })

  it('isZvolConsistency is the ONE predicate for "this source is a zvol"', () => {
    assert.equal(isZvolConsistency(deriveConsistency('/dev/zvol/tank/vol1', FACTS)), true)
    assert.equal(isZvolConsistency(deriveConsistency('/tank/media', FACTS)), false)
    assert.equal(isZvolConsistency(deriveConsistency('/dev/sdb', FACTS)), false)
  })
})
