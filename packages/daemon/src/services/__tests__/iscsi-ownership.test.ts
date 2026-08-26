import type { PveStorageRef } from '@anas/shared'
import type { ZfsMountpoint } from '../../parsers/pve-storage.js'
import type { OwnershipInputs } from '../iscsi-ownership.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { anasIqn, anasIqnAuthority, anasTargetName, isAnasIqn, IscsiIqn } from '@anas/shared'
import { parsePveStorageCfg } from '../../parsers/pve-storage.js'
import { classifyBacking, deriveOwnership, PVE_GUEST_VOLUME_RE } from '../iscsi-ownership.js'

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
    pveStorages: parsePveStorageCfg(STORAGE_CFG, MOUNTPOINTS) as Map<string, PveStorageRef[]>,
    zfsMountpoints: MOUNTPOINTS,
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
      pveManaged: false,
      pveGuestVolume: false,
    })
  })

  it('tags a zvol on a PVE-managed pool (the 3.25 pattern)', () => {
    const c = classifyBacking('/dev/zvol/datapool/mylun', inputs())
    assert.equal(c.pveManaged, true)
    assert.equal(c.pool, 'datapool')
  })

  it('tags a PVE guest volume by NAME, on any pool', () => {
    for (const name of ['vm-101-disk-0', 'base-9000-disk-1', 'subvol-105-disk-0']) {
      assert.equal(PVE_GUEST_VOLUME_RE.test(name), true, name)
      assert.equal(classifyBacking(`/dev/zvol/tank/${name}`, inputs()).pveGuestVolume, true, name)
    }
    // Names that merely look similar are not guest volumes.
    for (const name of ['vm-disk-0', 'vmstore', 'my-vm-101-disk-0'])
      assert.equal(PVE_GUEST_VOLUME_RE.test(name), false, name)
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
      pveManaged: false,
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

  it('foreign: an ANAS IQN whose LUN sits on a PVE-managed pool', () => {
    const tag = deriveOwnership(anas, [
      { name: 'lun0', backingPath: '/dev/zvol/datapool/mylun' },
    ], inputs())
    assert.equal(tag.ownership, 'foreign')
    assert.equal(tag.reason, 'backing-pve-storage')
    assert.match(tag.detail, /which PVE manages \(local-zfs\)/)
  })

  it('foreign: a PVE guest volume is NEVER a candidate', () => {
    const tag = deriveOwnership(anas, [
      { name: 'lun0', backingPath: '/dev/zvol/tank/vm-101-disk-0' },
    ], inputs())
    assert.equal(tag.ownership, 'foreign')
    assert.equal(tag.reason, 'backing-pve-guest-disk')
    assert.match(tag.detail, /tank\/vm-101-disk-0/)
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

  it('a PVE-managed backing flips even when it is absent — the pool is named, not guessed', () => {
    // `/dev/zvol/datapool/...` names its pool from the path, so `storage.cfg`
    // answers the question without the device being there at all.
    const tag = deriveOwnership(anas, [
      { name: 'lun0', backingPath: '/dev/zvol/datapool/mylun', backingExists: false },
    ], inputs())
    assert.equal(tag.ownership, 'foreign')
    assert.equal(tag.reason, 'backing-pve-storage')
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
