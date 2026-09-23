import type { SystemPoolFacts } from '@anas/shared'
import type { ZfsMountpoint } from '../../parsers/pve-storage.js'
import type { OwnershipInputs } from '../iscsi-ownership.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { anasIqn, anasIqnAuthority, anasTargetName, isAnasIqn, IscsiIqn, PVE_GUEST_VOLUME_RE } from '@anas/shared'
import { parsePveStorageCfg } from '../../parsers/pve-storage.js'
import { classifyBacking, deriveOwnership } from '../iscsi-ownership.js'

// A stock PVE storage.cfg: `datapool` is PVE's, `tank` is not mentioned at all.
const STORAGE_CFG = [
  'zfspool: local-zfs',
  '\tpool datapool',
  '\tcontent images,rootdir',
  '',
  'dir: local',
  '\tpath /var/lib/vz',
  '\tcontent vztmpl,iso,backup',
  '',
].join('\n')

const MOUNTPOINTS: ZfsMountpoint[] = [
  { mountpoint: '/tank', dataset: 'tank', pool: 'tank' },
  { mountpoint: '/tank/images', dataset: 'tank/images', pool: 'tank' },
  { mountpoint: '/datapool', dataset: 'datapool', pool: 'datapool' },
]

function inputs(overrides: Partial<OwnershipInputs> = {}): OwnershipInputs {
  return {
    pveStorages: parsePveStorageCfg(STORAGE_CFG, MOUNTPOINTS).byPool,
    zfsMountpoints: MOUNTPOINTS,
    // A READABLE answer (the probe succeeded, no pool boots) — these fixtures
    // ask the per-dataset rules, not the unreadable-facts fallback.
    systemFacts: [],
    ...overrides,
  }
}

describe('the ANAS IQN naming convention (defined once, in @anas/shared)', () => {
  it('generates a conforming IQN from a fully-qualified node name', () => {
    const iqn = anasIqn('vmstore', { nodeName: 'nas.example.com', date: new Date(Date.UTC(2026, 7, 25)) })
    assert.equal(iqn, 'iqn.2026-08.com.example.nas.anas:vmstore')
    assert.equal(isAnasIqn(iqn), true)
    assert.equal(anasTargetName(iqn), 'vmstore')
    // …and what it generates is a legal iSCSI name.
    assert.equal(IscsiIqn.safeParse(iqn).success, true)
  })

  it('a domainless node keeps its hostname as the leading label', () => {
    // The short hostname is a label like any other, NOT a missing domain:
    // dropping it would leave the single-label authority `anas`, which rtslib
    // refuses to create. So a domainless node's IQN carries its own name.
    assert.equal(anasIqnAuthority('nas'), 'nas.anas')
    const iqn = anasIqn('vmstore', { nodeName: 'nas', date: new Date(Date.UTC(2026, 0, 1)) })
    assert.equal(iqn, 'iqn.2026-01.nas.anas:vmstore')
    assert.equal(isAnasIqn(iqn), true)
    assert.equal(IscsiIqn.safeParse(iqn).success, true)
  })

  it('a node name that yields no usable label still produces a legal authority', () => {
    // Never expected on a real node, but the authority must never come out with
    // a single label — that is the one shape rtslib will not create.
    assert.equal(anasIqnAuthority(undefined), 'node.anas')
    assert.equal(anasIqnAuthority(''), 'node.anas')
    assert.equal(anasIqnAuthority('_'), 'node.anas')
    const iqn = anasIqn('vmstore', { nodeName: '', date: new Date(Date.UTC(2026, 0, 1)) })
    assert.equal(IscsiIqn.safeParse(iqn).success, true)
  })

  it('drops node-name labels that are not legal IQN labels', () => {
    assert.equal(anasIqnAuthority('Nas.Example.COM'), 'com.example.nas.anas')
    assert.equal(anasIqnAuthority('nas..example.com'), 'com.example.nas.anas')
    assert.equal(anasIqnAuthority('nas.exa_mple.com'), 'com.nas.anas')
  })

  it('recognition is date- and node-agnostic', () => {
    assert.equal(isAnasIqn('iqn.1999-12.org.example.host.anas:x'), true)
    // A renamed node still recognises the targets it created: only the LAST
    // authority label is asked about, never which node label precedes it.
    assert.equal(isAnasIqn('iqn.2030-06.othernode.anas:x'), true)
  })

  it('rejects everything that is not an ANAS target', () => {
    // The GT run's hand-built target: the authority ends in `.gtiscsi`.
    assert.equal(isAnasIqn('iqn.2026-08.dev.anas.gtiscsi:target1'), false)
    // A stock Debian initiator.
    assert.equal(isAnasIqn('iqn.1993-08.org.debian:01:ae3d2ec18ad'), false)
    // targetcli's own generated form (it embeds the hostname — GT-10).
    assert.equal(isAnasIqn('iqn.2003-01.org.linux-iscsi.anas-pve.x8664:sn.0123456789ab'), false)
    // No unique string at all.
    assert.equal(isAnasIqn('iqn.2026-08.host.anas'), false)
    // A single-label authority: `anas` alone is not a name rtslib would create.
    assert.equal(isAnasIqn('iqn.2030-06.anas:x'), false)
    assert.equal(IscsiIqn.safeParse('iqn.2030-06.anas:x').success, false)
    // Not an IQN.
    assert.equal(isAnasIqn('eui.0123456789abcdef'), false)
    assert.equal(anasTargetName('iqn.2026-08.dev.anas.gtiscsi:target1'), null)
  })

  it('IscsiIqn accepts all three RFC 3720 formats and rejects junk', () => {
    for (const ok of [
      'iqn.2026-08.com.example.nas.anas:vmstore',
      'iqn.1993-08.org.debian:01:ae3d2ec18ad',
      'iqn.2026-08.dev.anas.gtiscsi:target1',
      'eui.0123456789abcdef',
      'naa.60014059bc6e90760154267be4f5a061',
    ])
      assert.equal(IscsiIqn.safeParse(ok).success, true, ok)

    for (const bad of [
      '',
      'not-an-iqn',
      'iqn.26-08.host.anas:x', // two-digit year
      'iqn.2026-08.HOST.ANAS:x', // uppercase
      'iqn.2026-08.host.anas:x\ny', // control character
      `iqn.2026-08.host.anas:${'x'.repeat(300)}`, // over the 223-byte cap
      // A single-label naming authority: rtslib's own wwn pattern requires at
      // least two, so accepting it here would only turn a clean 400 into an
      // opaque targetcli exit 1 half-way through a create.
      'iqn.2026-08.anas:vmstore',
      'iqn.2026-08.example:vmstore',
    ])
      assert.equal(IscsiIqn.safeParse(bad).success, false, JSON.stringify(bad))
  })
})

describe('classifyBacking — where a LUN\'s backing object actually lives', () => {
  it('reads a zvol\'s pool and dataset straight out of the stable path', () => {
    assert.deepEqual(classifyBacking('/dev/zvol/tank/block/lun0', inputs()), {
      kind: 'zvol',
      pool: 'tank',
      dataset: 'tank/block/lun0',
      // A device path has no mountpoint — only a FILE backing can sit on the
      // wrong filesystem (story `iscsi.8`).
      mountpoint: null,
      pveOwned: false,
      pveOwnership: null,
      pveGuestVolume: false,
    })
  })

  it('tags a backing on a PVE storage root as owned — the DATASET, not the pool (pvepool.1)', () => {
    // `/datapool` is the bare root's mountpoint, so the file form names the
    // storage root dataset itself.
    const c = classifyBacking('/datapool/scratch/lun.raw', inputs())
    assert.equal(c.pveOwned, true)
    assert.equal(c.pool, 'datapool')
    assert.equal(c.pveOwnership?.kind, 'storage-root')
    assert.match(c.pveOwnership?.reason ?? '', /local-zfs/)
    assert.match(c.pveOwnership?.reason ?? '', /datapool/)
  })

  it('guest-volume ownership needs the PVE storage, not just the name (pvepool.1)', () => {
    // Under PVE's storage root the plugin inventories every guest prefix…
    for (const name of ['vm-101-disk-0', 'base-9000-disk-1', 'subvol-105-disk-0', 'basevol-102-disk-0']) {
      assert.equal(PVE_GUEST_VOLUME_RE.test(name), true, name)
      const c = classifyBacking(`/dev/zvol/datapool/${name}`, inputs())
      assert.equal(c.pveGuestVolume, true, name)
      assert.equal(c.pveOwnership?.kind, 'guest-volume', name)
    }
    // …including the arbitrary-tail forms the old iscsi regex rejected.
    assert.equal(classifyBacking('/dev/zvol/datapool/subvol-100-foo', inputs()).pveGuestVolume, true)
    // …but the SAME name on a pool PVE has no storage for is ordinary ANAS
    // storage — PVE would never list it.
    for (const name of ['vm-101-disk-0', 'subvol-100-foo'])
      assert.equal(classifyBacking(`/dev/zvol/tank/${name}`, inputs()).pveOwned, false, name)
    // Names that merely look similar are not guest volumes anywhere.
    for (const name of ['vm-disk-0', 'vmstore', 'my-vm-101-disk-0'])
      assert.equal(PVE_GUEST_VOLUME_RE.test(name), false, name)
  })

  it('a sibling dataset under a PVE storage root is ordinary ANAS storage', () => {
    const c = classifyBacking('/dev/zvol/datapool/media/lun0', inputs())
    assert.equal(c.kind, 'zvol')
    assert.equal(c.pveOwned, false)
    assert.equal(c.pveOwnership, null)
  })

  it('resolves an image file onto its ZFS dataset, most specific mountpoint wins', () => {
    assert.deepEqual(classifyBacking('/tank/images/lun2.raw', inputs()), {
      kind: 'file',
      pool: 'tank',
      dataset: 'tank/images', // not `tank` — the nested dataset is more specific
      // The dataset's mountpoint IS the expected filesystem for that file: a
      // placeholder created while `tank/images` was unmounted would report
      // `/tank` as its containing mount instead (story `iscsi.8`).
      mountpoint: '/tank/images',
      pveOwned: false,
      pveOwnership: null,
      pveGuestVolume: false,
    })
  })

  it('resolves an image file on an AHR pool', () => {
    const c = classifyBacking('/ahr0/blocks/lun.raw', inputs({
      ahrMountpoints: new Map([['ahr0', '/ahr0']]),
    }))
    assert.equal(c.kind, 'file')
    assert.equal(c.pool, 'ahr0')
  })

  it('calls everything else foreign', () => {
    // A raw block device someone pointed LIO at by hand.
    assert.equal(classifyBacking('/dev/sdb', inputs()).kind, 'foreign')
    // A file on storage ANAS does not manage.
    assert.equal(classifyBacking('/srv/exports/lun.img', inputs()).kind, 'foreign')
    // A relative path (never legal, but never a crash either).
    assert.equal(classifyBacking('lun.img', inputs()).kind, 'foreign')
    assert.equal(classifyBacking('', inputs()).kind, 'foreign')
  })

  it('a nested-name pool does not swallow a sibling', () => {
    const mps: ZfsMountpoint[] = [{ mountpoint: '/tank', dataset: 'tank', pool: 'tank' }]
    assert.equal(classifyBacking('/tank-other/lun.raw', inputs({ zfsMountpoints: mps })).kind, 'foreign')
  })
})

describe('deriveOwnership — both halves are required, and the reason is shown', () => {
  const anas = anasIqn('vmstore', { nodeName: 'nas.example.com', date: new Date(Date.UTC(2026, 7, 25)) })

  it('anas: an ANAS IQN with every LUN on ANAS-managed storage', () => {
    const tag = deriveOwnership(anas, [
      { name: 'vmstore-lun0', backingPath: '/dev/zvol/tank/lun0' },
      { name: 'vmstore-lun1', backingPath: '/tank/images/lun1.raw' },
    ], inputs())
    assert.equal(tag.ownership, 'anas')
    assert.equal(tag.reason, 'anas-managed')
    assert.match(tag.detail, /all 2 LUNs/)
  })

  it('foreign: the IQN is checked first and names itself as the reason', () => {
    const tag = deriveOwnership('iqn.2026-08.dev.anas.gtiscsi:target1', [
      { name: 'gtiscsi_vol1', backingPath: '/dev/zvol/tank/vol1' },
    ], inputs())
    assert.equal(tag.ownership, 'foreign')
    assert.equal(tag.reason, 'iqn-not-anas')
    assert.match(tag.detail, /was not generated by ANAS/)
  })

  it('foreign: an ANAS IQN whose LUN sits on a PVE storage root (pvepool.1)', () => {
    // The storage root shows through the FILE form (`/datapool` is the bare
    // pool root's mountpoint; a bare root is never itself a zvol path).
    const tag = deriveOwnership(anas, [
      { name: 'lun0', backingPath: '/datapool/mylun' },
    ], inputs())
    assert.equal(tag.ownership, 'foreign')
    assert.equal(tag.reason, 'backing-pve-storage')
    // The sentence names the storage AND the dataset — never "this pool".
    assert.match(tag.detail, /PVE storage 'local-zfs' owns datapool as a storage root/)
  })

  it('foreign: a PVE guest volume is NEVER a candidate', () => {
    const tag = deriveOwnership(anas, [
      { name: 'lun0', backingPath: '/dev/zvol/datapool/vm-101-disk-0' },
    ], inputs())
    assert.equal(tag.ownership, 'foreign')
    assert.equal(tag.reason, 'backing-pve-guest-disk')
    assert.match(tag.detail, /datapool\/vm-101-disk-0/)
  })

  it('anas: a guest-LOOKING zvol on a pool PVE has no storage for stays ANAS\'s (pvepool.1)', () => {
    // PVE inventories the direct children of a storage's configured path only —
    // `tank` is in no storage.cfg, so `vm-101-disk-0` there is invisible to it.
    const tag = deriveOwnership(anas, [
      { name: 'lun0', backingPath: '/dev/zvol/tank/vm-101-disk-0' },
    ], inputs())
    assert.equal(tag.ownership, 'anas')
  })

  it('foreign: one LUN off ANAS storage makes the whole target foreign', () => {
    const tag = deriveOwnership(anas, [
      { name: 'ok', backingPath: '/dev/zvol/tank/lun0' },
      { name: 'not-ok', backingPath: '/dev/sdb' },
    ], inputs())
    assert.equal(tag.ownership, 'foreign')
    assert.equal(tag.reason, 'backing-not-anas-storage')
    assert.match(tag.detail, /'not-ok'/)
  })

  it('anas: a target with no LUNs is still ANAS\'s (iscsi.5)', () => {
    // Two real states produce this: a target created a second ago, and one whose
    // whole pool was late at boot (GT-21). Neither is evidence of anyone else's
    // ownership, and calling it foreign made the first one impossible to add a
    // LUN to.
    const tag = deriveOwnership(anas, [], inputs())
    assert.equal(tag.ownership, 'anas')
    assert.equal(tag.reason, 'no-luns')
    assert.match(tag.detail, /has no LUNs/)
  })

  it('a STALE backing path does not change hands — it stays ANAS\'s to fix', () => {
    // `zfs rename` under a live LUN succeeds silently (GT-40) and leaves the
    // path dangling. The pool is still ANAS's, so the target stays ANAS's; the
    // brokenness is reported as `backingExists: false` on the LUN instead.
    const tag = deriveOwnership(anas, [
      { name: 'lun0', backingPath: '/dev/zvol/tank/renamed-away' },
    ], inputs())
    assert.equal(tag.ownership, 'anas')
  })
})

// ---------------------------------------------------------------------------
// The `unresolved` tier — story iscsi.5, live-proof finding F2
// ---------------------------------------------------------------------------

describe('the unresolved backing tier (iscsi.5 / F2)', () => {
  const anas = anasIqn('vmstore', { nodeName: 'nas.example.com', date: new Date(Date.UTC(2026, 7, 25)) })

  it('classifyBacking: absent + unmatched is unresolved, present + unmatched is foreign', () => {
    // The SAME path (an EXPORTED pool: no mountpoint matches it), and only the
    // existence answer differs.
    assert.equal(classifyBacking('/coldpool/images/lun.raw', inputs(), false).kind, 'unresolved')
    assert.equal(classifyBacking('/coldpool/images/lun.raw', inputs(), true).kind, 'foreign')
  })

  it('classifyBacking: unchecked (undefined / null) keeps the pre-iscsi.5 foreign verdict', () => {
    // The create paths call it this way on purpose: an image that does not exist
    // YET must still be refused when its directory is not ANAS's.
    assert.equal(classifyBacking('/srv/exports/lun.img', inputs()).kind, 'foreign')
    assert.equal(classifyBacking('/srv/exports/lun.img', inputs(), null).kind, 'foreign')
  })

  it('classifyBacking: existence never overrides a path that DID resolve', () => {
    const mps: ZfsMountpoint[] = [{ mountpoint: '/tank', dataset: 'tank', pool: 'tank' }]
    // A file on a mounted ANAS dataset stays `file` even when the file is gone…
    assert.equal(classifyBacking('/tank/images/lun.raw', inputs({ zfsMountpoints: mps }), false).kind, 'file')
    // …and a zvol path names its own pool, so it is never `unresolved` (GT-40).
    assert.equal(classifyBacking('/dev/zvol/tank/vol1', inputs(), false).kind, 'zvol')
    // A raw block device that has gone away IS unresolved, not foreign.
    assert.equal(classifyBacking('/dev/sdb', inputs(), false).kind, 'unresolved')
  })

  it('F2: an ANAS target whose file LUN sits on an EXPORTED pool stays ANAS\'s', () => {
    // The exact live-proof state: the pool is not imported, so no mountpoint
    // matches and the image file is not there. Before iscsi.5 this read
    // `foreign` and flipped the whole target to hands-off — removing the tools
    // at the moment they were needed.
    const tag = deriveOwnership(anas, [
      { name: 'vmstore-lun0', backingPath: '/coldpool/images/lun0.raw', backingExists: false },
    ], inputs())
    assert.equal(tag.ownership, 'anas')
    assert.equal(tag.reason, 'backing-unresolved')
    assert.match(tag.detail, /coldpool\/images\/lun0\.raw/)
    assert.match(tag.detail, /not a change of ownership/)
  })

  it('a genuinely foreign backing STILL flips the target', () => {
    // Same shape, one difference: the backing is actually there. That is a
    // positive verdict about someone else's storage, and it still wins.
    const tag = deriveOwnership(anas, [
      { name: 'vmstore-lun0', backingPath: '/srv/exports/lun0.raw', backingExists: true },
    ], inputs())
    assert.equal(tag.ownership, 'foreign')
    assert.equal(tag.reason, 'backing-not-anas-storage')
  })

  it('a PVE-owned backing flips even when it is absent — the storage is named, not guessed', () => {
    // A guest volume under the storage root names its dataset from the path,
    // so `storage.cfg` answers the question without the volume being there.
    const tag = deriveOwnership(anas, [
      { name: 'lun0', backingPath: '/dev/zvol/datapool/vm-100-disk-0', backingExists: false },
    ], inputs())
    assert.equal(tag.ownership, 'foreign')
    assert.equal(tag.reason, 'backing-pve-guest-disk')
  })

  it('one resolvable-foreign LUN outranks an unresolved sibling', () => {
    const tag = deriveOwnership(anas, [
      { name: 'gone', backingPath: '/coldpool/images/a.raw', backingExists: false },
      { name: 'theirs', backingPath: '/dev/sdb', backingExists: true },
    ], inputs())
    assert.equal(tag.ownership, 'foreign')
    assert.equal(tag.reason, 'backing-not-anas-storage')
    assert.match(tag.detail, /'theirs'/)
  })

  it('a mix of healthy and unresolved LUNs stays anas and counts honestly', () => {
    const mps: ZfsMountpoint[] = [{ mountpoint: '/tank', dataset: 'tank', pool: 'tank' }]
    const tag = deriveOwnership(anas, [
      { name: 'ok', backingPath: '/dev/zvol/tank/lun0', backingExists: true },
      { name: 'gone', backingPath: '/coldpool/images/a.raw', backingExists: false },
    ], inputs({ zfsMountpoints: mps }))
    assert.equal(tag.ownership, 'anas')
    assert.equal(tag.reason, 'backing-unresolved')
    assert.match(tag.detail, /1 of 2 LUNs/)
  })
})

// ---------------------------------------------------------------------------
// Story pvepool.1 — the footprint fixture set, answered per DATASET
// ---------------------------------------------------------------------------

describe('classifyBacking over the pvepool.1 fixture set', () => {
  // The stock layout the story fixes: a BARE pool storage (`tank`), a NESTED
  // one (`rpool/data`), a `dir` storage on `tank/dump`, and a system pool
  // (`rpool` boots from `rpool/ROOT/pve-1`) whose `rpool/media` sibling is
  // ordinary ANAS storage.
  const CFG = [
    'zfspool: tankstore',
    '\tpool tank',
    '\tcontent images,rootdir',
    '',
    'zfspool: local-zfs',
    '\tpool rpool/data',
    '\tcontent images,rootdir',
    '',
    'dir: backup',
    '\tpath /tank/dump',
    '\tcontent backup',
    '',
  ].join('\n')

  const MPS: ZfsMountpoint[] = [
    { mountpoint: '/tank', dataset: 'tank', pool: 'tank' },
    { mountpoint: '/tank/dump', dataset: 'tank/dump', pool: 'tank' },
    { mountpoint: '/rpool/data', dataset: 'rpool/data', pool: 'rpool' },
    { mountpoint: '/rpool/media', dataset: 'rpool/media', pool: 'rpool' },
    { mountpoint: '/rpool/apps/cache', dataset: 'rpool/apps/cache', pool: 'rpool' },
    { mountpoint: '/', dataset: 'rpool/ROOT/pve-1', pool: 'rpool' },
  ]

  const SYSTEM: SystemPoolFacts[] = [{ pool: 'rpool', bootfs: 'rpool/ROOT/pve-1', rootDataset: 'rpool/ROOT/pve-1' }]

  const fx = (overrides: Partial<OwnershipInputs> = {}): OwnershipInputs => ({
    pveStorages: parsePveStorageCfg(CFG, MPS).byPool,
    zfsMountpoints: MPS,
    systemFacts: SYSTEM,
    ...overrides,
  })

  it('REFUSED: the bare storage root `tank`', () => {
    // A bare pool root cannot be a zvol path (a single label is a pool, not a
    // volume), so the root shows up through the FILE form: the dataset mounted
    // at /tank IS the storage root.
    const c = classifyBacking('/tank/scratch/lun.raw', fx())
    assert.equal(c.kind, 'file')
    assert.equal(c.pveOwned, true)
    assert.equal(c.pveOwnership?.kind, 'storage-root')
    assert.match(c.pveOwnership?.reason ?? '', /tankstore.*owns tank as a storage root/)
  })

  it('REFUSED: the nested storage root `rpool/data`', () => {
    const c = classifyBacking('/dev/zvol/rpool/data', fx())
    assert.equal(c.pveOwnership?.kind, 'storage-root')
    assert.match(c.pveOwnership?.reason ?? '', /local-zfs.*owns rpool\/data/)
  })

  it('REFUSED: every guest prefix directly under a storage root, plus the loose-tail forms', () => {
    for (const name of ['vm-100-disk-0', 'base-100-disk-0', 'subvol-101-disk-0', 'basevol-102-disk-0', 'subvol-100-foo']) {
      const c = classifyBacking(`/dev/zvol/rpool/data/${name}`, fx())
      assert.equal(c.pveGuestVolume, true, name)
      assert.equal(c.pveOwnership?.kind, 'guest-volume', name)
      assert.match(c.pveOwnership?.reason ?? '', /local-zfs/, name)
      assert.match(c.pveOwnership?.reason ?? '', new RegExp(name.replace(/-/g, '\\-')), name)
    }
  })

  it('REFUSED: the `dir` storage tree and everything under it', () => {
    for (const dataset of ['tank/dump', 'tank/dump/iso', 'tank/dump/iso/deep']) {
      const c = classifyBacking(`/dev/zvol/${dataset}`, fx())
      assert.equal(c.pveOwned, true, dataset)
      assert.equal(c.pveOwnership?.kind, 'dir-storage', dataset)
      assert.match(c.pveOwnership?.reason ?? '', /backup/, dataset)
    }
    // …and a FILE in that tree is owned the same way (a file is never a guest
    // volume, but the dir-storage rule still applies).
    const f = classifyBacking('/tank/dump/iso/debian.iso', fx())
    assert.equal(f.pveOwned, true)
    assert.equal(f.pveOwnership?.kind, 'dir-storage')
  })

  it('REFUSED: the system tree — boot dataset, its ancestors, and the whole ROOT/* subtree', () => {
    for (const dataset of ['rpool', 'rpool/ROOT', 'rpool/ROOT/pve-1', 'rpool/ROOT/pve-1/etc']) {
      const c = classifyBacking(`/dev/zvol/${dataset}`, fx())
      assert.equal(c.pveOwned, true, dataset)
      assert.equal(c.pveOwnership?.kind, 'system', dataset)
    }
    // The system rule wins even over a storage-root/guest verdict on the same
    // dataset — rpool/data IS a storage root, but here the boot facts are the
    // stronger claim only when they apply (rpool/data is NOT under ROOT, so it
    // stays a plain storage root).
    assert.equal(classifyBacking('/dev/zvol/rpool/data', fx()).pveOwnership?.kind, 'storage-root')
  })

  it('ALLOWED: siblings at depth 1 and 2, children of a storage root, and off-PVE pools', () => {
    for (const dataset of ['rpool/media', 'rpool/apps/cache', 'tank/scratch', 'tank/media/lun0']) {
      const c = classifyBacking(`/dev/zvol/${dataset}`, fx())
      assert.equal(c.pveOwned, false, dataset)
      assert.equal(c.pveOwnership, null, dataset)
    }
    // A file on an allowed sibling likewise.
    assert.equal(classifyBacking('/rpool/media/lun.raw', fx()).pveOwned, false)
  })

  it('UNREADABLE boot facts (null or omitted) fall back to the whole-pool rule (pvepool.1)', () => {
    // `null` is the probe failing and `undefined` is the caller never having
    // read them — both are UNREADABLE. `rpool` hosts the zfspool storage
    // `local-zfs`, so its whole pool is answered hands-off, even the boot
    // tree the per-dataset rules could no longer name.
    for (const facts of [null, undefined] as const) {
      const c = classifyBacking('/dev/zvol/rpool/ROOT', fx({ systemFacts: facts }))
      assert.equal(c.pveOwned, true, `facts=${String(facts)}`)
      assert.equal(c.pveOwnership?.kind, 'system', `facts=${String(facts)}`)
      assert.match(c.pveOwnership?.reason ?? '', /boot facts unavailable/, `facts=${String(facts)}`)
    }
    // …while a READABLE answer — even "no system pool" — leaves the pool's
    // siblings alone (an empty array is readable, not unreadable).
    assert.equal(classifyBacking('/dev/zvol/rpool/media', fx({ systemFacts: [] })).pveOwned, false)
  })

  it('a SIBLING on a zfspool pool is hands-off when the boot facts are unreadable, allowed when they are', () => {
    // The per-dataset rules call `tank/media` manageable (the story's
    // relaxation); the fallback may only TIGHTEN, when the facts went dark.
    const owned = classifyBacking('/dev/zvol/tank/media', fx({ systemFacts: null }))
    assert.equal(owned.pveOwned, true)
    assert.equal(owned.pveOwnership?.kind, 'system')
    assert.match(owned.pveOwnership?.reason ?? '', /boot facts unavailable[\s\S]*whole pool/)
    // Facts present — any readable answer — the sibling is ANAS's again.
    assert.equal(classifyBacking('/dev/zvol/tank/media', fx()).pveOwned, false)
    assert.equal(classifyBacking('/dev/zvol/tank/media', fx({ systemFacts: [] })).pveOwned, false)
  })

  it('deriveOwnership sentences over the fixture set: storage and dataset are always named', () => {
    const anas = anasIqn('vmstore', { nodeName: 'nas.example.com', date: new Date(Date.UTC(2026, 7, 25)) })
    const cases: [string, string, string][] = [
      // [backing, expected reason, expected detail fragment]
      ['/tank/scratch/lun.raw', 'backing-pve-storage', 'tankstore\' owns tank as a storage root'],
      ['/dev/zvol/rpool/data/vm-100-disk-0', 'backing-pve-guest-disk', 'rpool/data/vm-100-disk-0'],
      ['/dev/zvol/rpool/ROOT', 'backing-pve-storage', 'rpool/ROOT holds the boot filesystems of pool rpool'],
    ]
    for (const [backing, reason, fragment] of cases) {
      const tag = deriveOwnership(anas, [{ name: 'lun0', backingPath: backing }], fx())
      assert.equal(tag.reason, reason, backing)
      assert.match(tag.detail, new RegExp(fragment.replace(/[/\\]/g, m => `\\${m}`)), backing)
    }
  })
})
