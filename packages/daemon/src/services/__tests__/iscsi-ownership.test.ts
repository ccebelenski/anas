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
  it('generates a conforming IQN from a node domain', () => {
    const iqn = anasIqn('vmstore', { domain: 'nas.example.com', date: new Date(Date.UTC(2026, 7, 25)) })
    assert.equal(iqn, 'iqn.2026-08.com.example.nas.anas:vmstore')
    assert.equal(isAnasIqn(iqn), true)
    assert.equal(anasTargetName(iqn), 'vmstore')
    // …and what it generates is a legal iSCSI name.
    assert.equal(IscsiIqn.safeParse(iqn).success, true)
  })

  it('falls back to the bare `anas` authority on a domainless node', () => {
    assert.equal(anasIqnAuthority(undefined), 'anas')
    assert.equal(anasIqnAuthority(''), 'anas')
    const iqn = anasIqn('vmstore', { date: new Date(Date.UTC(2026, 0, 1)) })
    assert.equal(iqn, 'iqn.2026-01.anas:vmstore')
    assert.equal(isAnasIqn(iqn), true)
  })

  it('drops domain labels that are not legal IQN labels', () => {
    assert.equal(anasIqnAuthority('Nas.Example.COM'), 'com.example.nas.anas')
    assert.equal(anasIqnAuthority('nas..example.com'), 'com.example.nas.anas')
    assert.equal(anasIqnAuthority('nas.exa_mple.com'), 'com.nas.anas')
  })

  it('recognition is date- and domain-agnostic', () => {
    assert.equal(isAnasIqn('iqn.1999-12.org.example.host.anas:x'), true)
    assert.equal(isAnasIqn('iqn.2030-06.anas:x'), true)
  })

  it('rejects everything that is not an ANAS target', () => {
    // The GT run's hand-built target: the authority ends in `.gtiscsi`.
    assert.equal(isAnasIqn('iqn.2026-08.dev.anas.gtiscsi:target1'), false)
    // A stock Debian initiator.
    assert.equal(isAnasIqn('iqn.1993-08.org.debian:01:ae3d2ec18ad'), false)
    // targetcli's own generated form (it embeds the hostname — GT-10).
    assert.equal(isAnasIqn('iqn.2003-01.org.linux-iscsi.anas-pve.x8664:sn.0123456789ab'), false)
    // No unique string at all.
    assert.equal(isAnasIqn('iqn.2026-08.anas'), false)
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
      'iqn.26-08.anas:x', // two-digit year
      'iqn.2026-08.ANAS:x', // uppercase
      'iqn.2026-08.anas:x\ny', // control character
      `iqn.2026-08.anas:${'x'.repeat(300)}`, // over the 223-byte cap
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
  const anas = anasIqn('vmstore', { domain: 'nas.example.com', date: new Date(Date.UTC(2026, 7, 25)) })

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

  it('foreign: a target with no LUNs has nothing tying it to ANAS storage', () => {
    const tag = deriveOwnership(anas, [], inputs())
    assert.equal(tag.ownership, 'foreign')
    assert.equal(tag.reason, 'no-luns')
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
