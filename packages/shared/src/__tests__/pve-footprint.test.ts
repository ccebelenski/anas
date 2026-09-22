import type { PveOwnership, PveStorageRef, SystemPoolFacts } from '../schemas/zfs.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isPveGuestName,
  PVE_GUEST_VOLUME_RE,
  pveOwnership,
  pveStoragePath,
  wouldBeClaimedByPve,
} from '../pve-footprint.js'

// One fixture set, per the pvepool.1 acceptance table: a bare pool storage, a
// nested storage, a dir storage on a dataset, and a system pool with bootfs.
const REFS: PveStorageRef[] = [
  { storage: 'local-zfs', type: 'zfspool', dataset: 'tank', content: ['images', 'rootdir'] },
  { storage: 'pve-data', type: 'zfspool', dataset: 'rpool/data', content: ['images', 'rootdir'] },
  { storage: 'dump', type: 'dir', dataset: 'tank/dump', content: ['backup'] },
]

const SYSTEM: SystemPoolFacts = {
  pool: 'rpool',
  bootfs: 'rpool/ROOT/pve-1',
  rootDataset: 'rpool/ROOT/pve-1',
}

const NO_REFS: PveStorageRef[] = []

/** Assert kind + storage for each table row (null ⇒ no ownership object). */
function expectOwned(
  refs: PveStorageRef[],
  dataset: string,
  expected: { kind: PveOwnership['kind'], storage?: string } | null,
  system?: SystemPoolFacts,
) {
  const verdict = pveOwnership(refs, dataset, system)
  if (expected === null) {
    assert.equal(verdict, null, `${dataset}: expected no ownership, got ${JSON.stringify(verdict)}`)
  }
  else {
    assert.ok(verdict, `${dataset}: expected ${expected.kind}, got null`)
    assert.equal(verdict.kind, expected.kind, dataset)
    assert.equal(verdict.storage, expected.storage, dataset)
  }
}

describe('pveOwnership — pool tank (zfspool storage-root + dir storage)', () => {
  const cases: Array<[string, { kind: PveOwnership['kind'], storage?: string } | null]> = [
    ['tank', { kind: 'storage-root', storage: 'local-zfs' }],
    ['tank/vm-100-disk-0', { kind: 'guest-volume', storage: 'local-zfs' }],
    ['tank/base-100-disk-0', { kind: 'guest-volume', storage: 'local-zfs' }],
    ['tank/subvol-101-disk-0', { kind: 'guest-volume', storage: 'local-zfs' }],
    ['tank/basevol-102-disk-0', { kind: 'guest-volume', storage: 'local-zfs' }],
    ['tank/subvol-100-foo', { kind: 'guest-volume', storage: 'local-zfs' }],
    // Subtree inheritance: a guest volume's children carry the same claim.
    ['tank/subvol-101-disk-0/child', { kind: 'guest-volume', storage: 'local-zfs' }],
    ['tank/subvol-101-disk-0/child/grand', { kind: 'guest-volume', storage: 'local-zfs' }],
    // Children of a storage root that are not guest-named are NOT owned —
    // rule (a) never propagates.
    ['tank/media', null],
    ['tank/media/child', null],
    // Dir storage: the dataset itself and its whole tree.
    ['tank/dump', { kind: 'dir-storage', storage: 'dump' }],
    ['tank/dump/x/y', { kind: 'dir-storage', storage: 'dump' }],
    // A guest-shaped name under a dir storage is dir's, not a guest volume.
    ['tank/dump/vm-100-disk-0', { kind: 'dir-storage', storage: 'dump' }],
  ]
  for (const [dataset, expected] of cases) {
    it(`${dataset} → ${expected ? expected.kind : 'null'}`, () => {
      expectOwned(REFS, dataset, expected, SYSTEM)
    })
  }
})

describe('pveOwnership — pool rpool (system pool + nested storage)', () => {
  const cases: Array<[string, { kind: PveOwnership['kind'], storage?: string } | null]> = [
    // The boot tree: pool root, ROOT, every ROOT child, and everything below.
    ['rpool', { kind: 'system' }],
    ['rpool/ROOT', { kind: 'system' }],
    ['rpool/ROOT/pve-1', { kind: 'system' }],
    ['rpool/ROOT/other', { kind: 'system' }],
    ['rpool/ROOT/pve-1/data', { kind: 'system' }],
    ['rpool/ROOT/other/vm-99-disk-0', { kind: 'system' }],
    // The nested storage path is a plain storage root — not the boot tree.
    ['rpool/data', { kind: 'storage-root', storage: 'pve-data' }],
    ['rpool/data/vm-100-disk-0', { kind: 'guest-volume', storage: 'pve-data' }],
    // Siblings outside both footprints stay manageable.
    ['rpool/media', null],
    // Guest-shaped but NOT a direct child of the storage path — not listed.
    ['rpool/vm-100-disk-0', null],
  ]
  for (const [dataset, expected] of cases) {
    it(`${dataset} → ${expected ? expected.kind : 'null'}`, () => {
      expectOwned(REFS, dataset, expected, SYSTEM)
    })
  }
})

describe('pveOwnership — no refs / no system facts', () => {
  it('unmanaged pool with a guest-shaped name → null', () => {
    expectOwned(NO_REFS, 'other/vm-100-disk-0', null, SYSTEM)
  })

  it('system facts without bootfs or rootDataset own nothing', () => {
    const empty: SystemPoolFacts = { pool: 'rpool' }
    expectOwned(NO_REFS, 'rpool', null, empty)
    expectOwned(NO_REFS, 'rpool/ROOT/pve-1', null, empty)
  })

  it('system facts for a different pool are ignored', () => {
    const elsewhere: SystemPoolFacts = { pool: 'otherpool', bootfs: 'otherpool/ROOT/pve-1' }
    expectOwned(NO_REFS, 'rpool/ROOT/pve-1', null, elsewhere)
  })
})

describe('pveOwnership — reason sentences', () => {
  it('storage-root names the storage and dataset', () => {
    assert.equal(
      pveOwnership(REFS, 'rpool/data', SYSTEM)?.reason,
      `PVE storage 'pve-data' owns rpool/data as a storage root`,
    )
  })

  it('guest-volume names the storage and dataset', () => {
    assert.equal(
      pveOwnership(REFS, 'tank/vm-100-disk-0', SYSTEM)?.reason,
      `PVE storage 'local-zfs' owns tank/vm-100-disk-0 as a guest volume`,
    )
  })

  it('inherited guest-volume names the owning ancestor', () => {
    assert.equal(
      pveOwnership(REFS, 'tank/subvol-101-disk-0/child', SYSTEM)?.reason,
      `PVE storage 'local-zfs' owns tank/subvol-101-disk-0/child under guest volume tank/subvol-101-disk-0`,
    )
  })

  it('dir-storage names the storage and dataset', () => {
    assert.equal(
      pveOwnership(REFS, 'tank/dump/x/y', SYSTEM)?.reason,
      `PVE storage 'dump' owns tank/dump/x/y as directory storage`,
    )
  })

  it('system: boot dataset, its parent, the pool root, a sibling', () => {
    assert.equal(
      pveOwnership(REFS, 'rpool/ROOT/pve-1', SYSTEM)?.reason,
      'rpool/ROOT/pve-1 is the boot filesystem of pool rpool',
    )
    assert.equal(
      pveOwnership(REFS, 'rpool/ROOT', SYSTEM)?.reason,
      'rpool/ROOT holds the boot filesystems of pool rpool',
    )
    assert.equal(
      pveOwnership(REFS, 'rpool', SYSTEM)?.reason,
      'rpool holds the boot filesystems of pool rpool',
    )
    assert.equal(
      pveOwnership(REFS, 'rpool/ROOT/other', SYSTEM)?.reason,
      'rpool/ROOT/other is under rpool/ROOT, which holds the boot filesystems of pool rpool',
    )
  })

  it('system ownership carries no storage id', () => {
    const verdict = pveOwnership(REFS, 'rpool/ROOT/pve-1', SYSTEM)
    assert.ok(verdict)
    assert.equal(verdict.storage, undefined)
  })
})

describe('wouldBeClaimedByPve — naming guard', () => {
  const cases: Array<[string, { storage: string } | null]> = [
    ['tank/vm-200-disk-0', { storage: 'local-zfs' }],
    ['rpool/data/vm-300-disk-1', { storage: 'pve-data' }],
    ['tank/media/vm-200-disk-0', null],
    ['tank/media', null],
    ['tank/dump/vm-200-disk-0', null],
    ['tank/vm-abc-disk-0', null],
    ['tank', null],
  ]
  for (const [dataset, expected] of cases) {
    it(`${dataset} → ${expected ? expected.storage : 'null'}`, () => {
      assert.deepEqual(wouldBeClaimedByPve(REFS, dataset), expected)
    })
  }
})

describe('isPveGuestName', () => {
  const positive = ['vm-100-disk-0', 'base-100-disk-0', 'subvol-101-disk-0', 'basevol-5-x', 'vm-1-x']
  const negative = ['vm-abc-disk', 'vmx-100-disk-0', 'media', 'vm-100-', 'vm-100-disk 0', 'VM-100-disk-0']
  for (const name of positive) {
    it(`matches ${name}`, () => {
      assert.equal(isPveGuestName(name), true)
      assert.match(name, PVE_GUEST_VOLUME_RE)
    })
  }
  for (const name of negative) {
    it(`rejects ${name}`, () => {
      assert.equal(isPveGuestName(name), false)
    })
  }
})

describe('pveStoragePath', () => {
  const poolRoot = 'tank'
  it('zfspool ref with a configured path', () => {
    assert.equal(pveStoragePath({ storage: 's', type: 'zfspool', dataset: 'tank/data', content: [] }, poolRoot), 'tank/data')
  })
  it('zfspool ref without a configured path falls back to the pool root', () => {
    assert.equal(pveStoragePath({ storage: 's', type: 'zfspool', content: [] }, poolRoot), 'tank')
  })
  it('dir ref resolves onto its dataset', () => {
    assert.equal(pveStoragePath({ storage: 's', type: 'dir', dataset: 'tank/dump', content: [] }, poolRoot), 'tank/dump')
  })
  it('dir ref without a resolved dataset has no footprint', () => {
    assert.equal(pveStoragePath({ storage: 's', type: 'dir', content: [] }, poolRoot), undefined)
  })
  it('zfs ref is not a footprint', () => {
    assert.equal(pveStoragePath({ storage: 's', type: 'zfs', dataset: 'tank', content: [] }, poolRoot), undefined)
  })
})
