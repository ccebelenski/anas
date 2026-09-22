import type { AhrPool, PveStorageRef, SystemPoolFacts } from '@anas/shared'
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
      // A `dir` storage's dataset (pvepool.1) — PVE's backup/ISO file tree.
      { target: '/tank/dump', source: 'tank/dump', fstype: 'zfs', options: 'rw,xattr' },
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
  // pvepool.1 — the PVE footprint refs the predicate judges each source's own
  // dataset by. `pvepool` carries a BARE zfspool storage (the pool root is the
  // storage root) and a NESTED one (`pvepool/data`); `tank/dump` is a `dir`
  // storage's tree. `tank` itself has no zfspool ref of its own here.
  pveStorages: new Map<string, PveStorageRef[]>([
    ['pvepool', [
      { storage: 'pvestore', type: 'zfspool', content: ['images', 'rootdir'] },
      { storage: 'local-zfs', type: 'zfspool', dataset: 'pvepool/data', content: ['images', 'rootdir'] },
    ]],
    ['tank', [
      { storage: 'vzdumps', type: 'dir', dataset: 'tank/dump', content: ['backup'] },
    ]],
  ]),
}

/** The same facts, with `tank` carrying this node's boot filesystem. */
const SYSFACTS: ConsistencyFacts = {
  ...FACTS,
  systemFacts: [{ pool: 'tank', bootfs: 'tank/ROOT/pve-1', rootDataset: 'tank/ROOT/pve-1' }] as SystemPoolFacts[],
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
    const c = deriveConsistency('/tank/media', { mounts: new Map(), ahrPools: [], pveStorages: new Map() })
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
    // The boot probe (pvepool.1) fails open on these fixtures — no system facts.
    mock.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: FINDMNT, args: ['-n', '-o', 'SOURCE,FSTYPE', '/'], result: { stdout: '', stderr: '', exitCode: 1 } })
    const facts = await readConsistencyFacts(mock, async () => FACTS.ahrPools, { pveStorageCfg: '/nonexistent/storage.cfg' })
    assert.ok(facts.mounts.size > 0)
    // storage.cfg is a FILE read (fail-open), so no path is ever stat'ed; the
    // only executor calls are the mount table and the two boot probes.
    assert.equal(mock.calls.filter(c => c.command === FINDMNT && c.args.includes('--json')).length, 1)
    assert.deepEqual(facts.pveStorages.size, 0)
    assert.deepEqual(facts.systemFacts, [])
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
    assert.equal(mock.calls.filter(c => c.command === FINDMNT && c.args.includes('--json')).length, 1)
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

  it('a zvol DIRECTLY under a PVE storage root but not guest-named is SNAPSHOTTED (pvepool.1)', () => {
    // Ownership is per dataset: `pvepool/somevol` is a child of the storage
    // root, invisible to PVE — the old whole-pool rule would have refused it.
    const c = deriveConsistency('/dev/zvol/pvepool/somevol', FACTS)
    assert.equal(c.consistency, 'snapshot')
    assert.equal(c.target, 'pvepool/somevol')
  })

  it('a zvol that IS a nested PVE storage root is LIVE and hands-off (pvepool.1)', () => {
    // `/dev/zvol/pvepool` (single label) is a pool, not a volume, and answers
    // on the /dev branch — but `pvepool/data` is a real volume naming the
    // storage root of `local-zfs`.
    const c = deriveConsistency('/dev/zvol/pvepool/data', FACTS)
    assert.equal(c.consistency, 'live')
    assert.equal(c.zvolDevice, undefined)
    // The sentence names the storage AND the dataset — never "this pool".
    assert.match(c.reason, /PVE storage 'local-zfs' owns pvepool\/data as a storage root/)
  })

  it('a zvol under a NESTED PVE storage root keeps its sibling allowed, its guests refused', () => {
    // Sibling of the storage root: ordinary ANAS storage.
    const sib = deriveConsistency('/dev/zvol/pvepool/media/vol0', FACTS)
    assert.equal(sib.consistency, 'snapshot')
    // Guest volume under the nested root: hands-off.
    const guest = deriveConsistency('/dev/zvol/pvepool/data/vm-100-disk-0', FACTS)
    assert.equal(guest.consistency, 'live')
    assert.match(guest.reason, /PVE guest volume/)
    // A guest-LOOKING name on the sibling is still snapshotted — PVE would
    // never list it.
    const lookalike = deriveConsistency('/dev/zvol/pvepool/media/vm-100-disk-0', FACTS)
    assert.equal(lookalike.consistency, 'snapshot')
  })

  it('a PVE GUEST volume under a storage root is LIVE with the guest sentence', () => {
    const c = deriveConsistency('/dev/zvol/pvepool/vm-101-disk-0', FACTS)
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /PVE guest volume/)
  })

  it('a file inside a `dir` storage tree is LIVE with the ownership reason (pvepool.1)', () => {
    const c = deriveConsistency('/tank/dump/iso/debian.iso', FACTS)
    assert.equal(c.consistency, 'live')
    assert.match(c.reason, /PVE storage 'vzdumps' owns tank\/dump as directory storage/)
  })

  it('a source whose HOSTING dataset is a dir-storage tree is LIVE, its sibling is not', () => {
    const owned = deriveConsistency('/tank/dump', FACTS)
    assert.equal(owned.consistency, 'live')
    assert.match(owned.reason, /directory storage/)
    const sibling = deriveConsistency('/tank/media', FACTS)
    assert.equal(sibling.consistency, 'snapshot')
  })

  it('the boot tree is LIVE even though the pool also holds ordinary datasets', () => {
    // The zvol form: everything under tank/ROOT is system-owned.
    const zvol = deriveConsistency('/dev/zvol/tank/ROOT/pve-1', SYSFACTS)
    assert.equal(zvol.consistency, 'live')
    assert.match(zvol.reason, /boot filesystem of pool tank/)
    // The filesystem form: the boot dataset itself.
    const fs = deriveConsistency('/', SYSFACTS)
    assert.equal(fs.consistency, 'live')
    // A sibling of the boot tree on the SAME pool is still snapshotted.
    assert.equal(deriveConsistency('/tank/media', SYSFACTS).consistency, 'snapshot')
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
