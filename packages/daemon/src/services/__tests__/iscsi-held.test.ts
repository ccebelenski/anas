import type { IscsiClaim } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import {
  claimHoldsSubject,
  configfsOptionsFrom,
  createIscsiClaimCache,
  heldByLun,
  heldByLunOnce,
  heldByLunRefusal,
  iscsiServedSerials,
  normalizeSerial,
  pickHolder,
  toHeldByLun,
} from '../iscsi-held.js'

/**
 * `heldByLun` — the ONE question the rest of ANAS asks before it destroys,
 * exports, rolls back, renames, shrinks or unmounts anything (story `iscsi.6`).
 *
 * The MATRIX is the point of this file. A LUN's backing object can be named in
 * four different vocabularies depending on which screen is asking —
 *
 *   Pools    → a pool name        ("is anything on `tank` served?")
 *   Datasets → a dataset name     (the zvol, its parent, an image's dataset)
 *   AHR      → a pool name + its mountpoint
 *   Mounts   → a mountpoint path
 *
 * — and every one of them has to reach the same claim. The matching itself is
 * pure, so it is exercised directly here; the configfs read behind it is
 * exercised against the REAL `iscsi.1` capture at the bottom.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ISCSI_FIXTURES = join(__dirname, '../../fixtures/iscsi')

/** The zvol LUN from the real capture, as a claim. */
const ZVOL_CLAIM: IscsiClaim = {
  backingPath: '/dev/zvol/tank/vol1',
  kind: 'zvol',
  pool: 'tank',
  dataset: 'tank/vol1',
  targetIqn: 'iqn.2026-08.nas.anas:vmstore',
  tpgTag: 1,
  lunIndex: 0,
  backstoreName: 'vmdisk1',
  connectedInitiators: [],
  detail: `held by iSCSI LUN 0 'vmdisk1' of target iqn.2026-08.nas.anas:vmstore (/dev/zvol/tank/vol1)`,
}

/** A file-backed LUN on a ZFS dataset. */
const FILE_CLAIM: IscsiClaim = {
  backingPath: '/tank/images/lun2.raw',
  kind: 'file',
  pool: 'tank',
  dataset: 'tank/images',
  targetIqn: 'iqn.2026-08.nas.anas:vmstore',
  tpgTag: 1,
  lunIndex: 1,
  backstoreName: 'vmdisk2',
  connectedInitiators: ['iqn.1993-08.org.debian:01:abc'],
  detail: `held by iSCSI LUN 1 'vmdisk2' of target iqn.2026-08.nas.anas:vmstore (/tank/images/lun2.raw) with 1 live session`,
}

/** A file-backed LUN on an AHR pool — AHR's only block kind (no dataset). */
const AHR_CLAIM: IscsiClaim = {
  backingPath: '/mnt/anas-ahr/ahr0/images/block1.raw',
  kind: 'file',
  pool: 'ahr0',
  targetIqn: 'iqn.2026-08.nas.anas:blockstore',
  tpgTag: 1,
  lunIndex: 0,
  backstoreName: 'ahrblock1',
  connectedInitiators: [],
  detail: `held by iSCSI LUN 0 'ahrblock1' of target iqn.2026-08.nas.anas:blockstore (/mnt/anas-ahr/ahr0/images/block1.raw)`,
}

/** A file-backed LUN on a remote mount — resolves onto neither ZFS nor AHR. */
const MOUNT_CLAIM: IscsiClaim = {
  backingPath: '/mnt/anas-nfs/blocks/lun.raw',
  kind: 'file',
  targetIqn: 'iqn.2026-08.nas.anas:remote',
  tpgTag: 1,
  lunIndex: 0,
  backstoreName: 'remoteblock',
  connectedInitiators: [],
  detail: `held by iSCSI LUN 0 'remoteblock' of target iqn.2026-08.nas.anas:remote (/mnt/anas-nfs/blocks/lun.raw)`,
}

const ALL = [ZVOL_CLAIM, FILE_CLAIM, AHR_CLAIM, MOUNT_CLAIM]

describe('heldByLun — the matrix (story iscsi.6)', () => {
  describe('a zvol', () => {
    it('is held when named as its own dataset', () => {
      assert.equal(claimHoldsSubject(ZVOL_CLAIM, { dataset: 'tank/vol1' }), true)
    })

    it('is held when named by its device path', () => {
      assert.equal(claimHoldsSubject(ZVOL_CLAIM, { path: '/dev/zvol/tank/vol1' }), true)
    })

    it('is held when its POOL is named — the Pools screen\'s question', () => {
      assert.equal(claimHoldsSubject(ZVOL_CLAIM, { pool: 'tank' }), true)
    })

    it('is held when an ANCESTOR dataset is named — the `-r` destroy case', () => {
      assert.equal(claimHoldsSubject({ ...ZVOL_CLAIM, dataset: 'tank/vms/lun1' }, { dataset: 'tank/vms' }), true)
    })

    it('is NOT held by a sibling with a shared prefix (tank/vm must not match tank/vms)', () => {
      assert.equal(claimHoldsSubject({ ...ZVOL_CLAIM, dataset: 'tank/vms' }, { dataset: 'tank/vm' }), false)
    })

    it('is NOT held by another pool of a similar name', () => {
      assert.equal(claimHoldsSubject(ZVOL_CLAIM, { pool: 'tank-other' }), false)
    })
  })

  describe('an image file', () => {
    it('is held by its exact path', () => {
      assert.equal(claimHoldsSubject(FILE_CLAIM, { path: '/tank/images/lun2.raw' }), true)
    })

    it('is held by the DIRECTORY it sits in — a dataset mountpoint or a mount', () => {
      assert.equal(claimHoldsSubject(FILE_CLAIM, { path: '/tank/images' }), true)
      assert.equal(claimHoldsSubject(FILE_CLAIM, { path: '/tank/images/' }), true)
    })

    it('is held by the DATASET that hosts it', () => {
      assert.equal(claimHoldsSubject(FILE_CLAIM, { dataset: 'tank/images' }), true)
      assert.equal(claimHoldsSubject(FILE_CLAIM, { dataset: 'tank' }), true)
    })

    it('is NOT held by a directory that merely shares a prefix', () => {
      assert.equal(claimHoldsSubject(FILE_CLAIM, { path: '/tank/image' }), false)
    })
  })

  describe('an AHR pool', () => {
    it('is held by the pool NAME (the read layer resolves an AHR-hosted file onto it)', () => {
      assert.equal(claimHoldsSubject(AHR_CLAIM, { pool: 'ahr0' }), true)
    })

    it('is held by the pool MOUNTPOINT (the answer when classification could not run)', () => {
      assert.equal(claimHoldsSubject(AHR_CLAIM, { path: '/mnt/anas-ahr/ahr0' }), true)
    })

    it('has no dataset, so a dataset question never matches it', () => {
      assert.equal(claimHoldsSubject(AHR_CLAIM, { dataset: 'ahr0' }), false)
    })
  })

  describe('a mountpoint', () => {
    it('holds an image sitting under it', () => {
      assert.equal(claimHoldsSubject(MOUNT_CLAIM, { path: '/mnt/anas-nfs' }), true)
      assert.equal(claimHoldsSubject(MOUNT_CLAIM, { path: '/mnt/anas-nfs/blocks' }), true)
    })

    it('does not hold a DIFFERENT mountpoint', () => {
      assert.equal(claimHoldsSubject(MOUNT_CLAIM, { path: '/mnt/anas-cifs' }), false)
    })
  })

  describe('nothing named', () => {
    it('an empty subject holds nothing (never a blanket refusal)', () => {
      for (const claim of ALL)
        assert.equal(claimHoldsSubject(claim, {}), false)
    })

    it('an empty-string pool/dataset holds nothing', () => {
      assert.equal(claimHoldsSubject(ZVOL_CLAIM, { pool: '' }), false)
      assert.equal(claimHoldsSubject(ZVOL_CLAIM, { dataset: '' }), false)
    })

    it('a relative path holds nothing (only absolute paths are compared)', () => {
      assert.equal(claimHoldsSubject(FILE_CLAIM, { path: 'tank/images' }), false)
    })
  })
})

describe('heldByLun — which holder is named (pickHolder)', () => {
  it('null when nothing matches', () => {
    assert.equal(pickHolder(ALL, { pool: 'other' }), null)
  })

  it('reduces the claim to the wire shape, keeping the ONE holder sentence', () => {
    const held = toHeldByLun(ZVOL_CLAIM)
    assert.deepEqual(held, {
      targetIqn: ZVOL_CLAIM.targetIqn,
      index: 0,
      name: 'vmdisk1',
      backingPath: '/dev/zvol/tank/vol1',
      connectedInitiators: [],
      detail: ZVOL_CLAIM.detail,
    })
  })

  it('prefers the LUN WITH LIVE SESSIONS — naming an idle one understates the blast radius', () => {
    // Both are on `tank`; the file LUN is the one with an initiator logged in.
    const held = pickHolder([ZVOL_CLAIM, FILE_CLAIM], { pool: 'tank' })
    assert.equal(held?.name, 'vmdisk2')
    assert.deepEqual(held?.connectedInitiators, ['iqn.1993-08.org.debian:01:abc'])
  })

  it('otherwise the first match in read order (stable across calls)', () => {
    const idle = { ...FILE_CLAIM, connectedInitiators: [] }
    assert.equal(pickHolder([ZVOL_CLAIM, idle], { pool: 'tank' })?.name, 'vmdisk1')
    assert.equal(pickHolder([idle, ZVOL_CLAIM], { pool: 'tank' })?.name, 'vmdisk2')
  })
})

describe('heldByLunRefusal — the guiding 409 body', () => {
  it('names the target, the LUN number AND the LUN name', () => {
    const r = heldByLunRefusal(`pool 'tank'`, 'Destroying', toHeldByLun(ZVOL_CLAIM))
    assert.equal(r.reason, 'held-by-lun')
    assert.match(r.message, /Destroying pool 'tank' is refused/)
    assert.match(r.message, /LUN 0 \('vmdisk1'\) of target iqn\.2026-08\.nas\.anas:vmstore/)
  })

  it('names BOTH ways out — delete the LUN, or delete it with the backing', () => {
    const r = heldByLunRefusal(`pool 'tank'`, 'Destroying', toHeldByLun(ZVOL_CLAIM))
    assert.match(r.message, /Delete LUN 0/)
    assert.match(r.message, /destroyBacking=true/)
  })

  it('says there is NO confirm bypass (safety altitude: unsafe now, not confirm-gated)', () => {
    const r = heldByLunRefusal(`pool 'tank'`, 'Exporting', toHeldByLun(ZVOL_CLAIM))
    assert.match(r.message, /no confirm bypass/)
  })

  it('names the logged-in initiators when there are live sessions', () => {
    const r = heldByLunRefusal(`dataset 'tank/images'`, 'Destroying', toHeldByLun(FILE_CLAIM))
    assert.match(r.message, /1 initiator is logged in right now/)
    assert.match(r.message, /iqn\.1993-08\.org\.debian:01:abc/)
  })

  it('says nothing about sessions when there are none', () => {
    const r = heldByLunRefusal(`pool 'tank'`, 'Destroying', toHeldByLun(ZVOL_CLAIM))
    assert.ok(!r.message.includes('logged in right now'), r.message)
  })

  it('carries the holder back, so a caller can put it on the wire unchanged', () => {
    const held = toHeldByLun(ZVOL_CLAIM)
    assert.deepEqual(heldByLunRefusal('x', 'Destroying', held).heldByLun, held)
  })

  it('names no backend — the same sentence serves ZFS, AHR and mounts (live-proof wave 2)', () => {
    // Rendered verbatim for AHR (btrfs on LVM on md) pools and for remote
    // mounts as well as for ZFS, so a ZFS-specific claim was simply false there.
    const r = heldByLunRefusal(`AHR pool 'lpahr'`, 'Destroying', toHeldByLun(FILE_CLAIM))
    assert.ok(!r.message.includes('ZFS'), 'the refusal blames no particular backend')
    assert.ok(!r.message.includes('dataset is busy'))
    assert.ok(r.message.includes('Nothing underneath stops this on its own'))
  })
})

describe('heldByLun — against the REAL configfs capture (iscsi.1)', () => {
  let dir: string
  let configfsRoot: string
  const exec = new MockExecutor()

  /** The saveconfig half is not needed: configfs alone carries both LUNs. */
  function paths() {
    return {
      configfsRoot,
      saveconfigPath: join(dir, 'absent-saveconfig.json'),
      pveStorageCfg: join(dir, 'absent-storage.cfg'),
      blockRoot: join(dir, 'absent-block'),
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-held-'))
    configfsRoot = join(dir, 'target')
    await materializeConfigfsManifest(
      readFileSync(join(ISCSI_FIXTURES, 'configfs-live.manifest'), 'utf-8'),
      configfsRoot,
    )
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('answers for the real zvol LUN, by dataset', async () => {
    const held = await heldByLunOnce(exec, { dataset: 'gtiscsi/vol1' }, paths())
    assert.equal(held?.name, 'gtiscsi_vol1')
    assert.equal(held?.index, 0)
    assert.equal(held?.targetIqn, 'iqn.2026-08.dev.anas.gtiscsi:target1')
  })

  it('answers for the real fileio LUN, by the directory it lives in', async () => {
    const held = await heldByLunOnce(exec, { path: '/gtiscsi/images' }, paths())
    assert.equal(held?.name, 'gtiscsi_lun2')
    assert.equal(held?.backingPath, '/gtiscsi/images/lun2.raw')
  })

  it('answers for the pool both LUNs sit on', async () => {
    const held = await heldByLunOnce(exec, { pool: 'gtiscsi' }, paths())
    assert.ok(held)
  })

  it('holds nothing for an object no LUN references', async () => {
    assert.equal(await heldByLunOnce(exec, { dataset: 'tank/media' }, paths()), null)
  })

  it('FAIL-OPEN: a node with no LIO holds nothing', async () => {
    const held = await heldByLunOnce(exec, { pool: 'gtiscsi' }, {
      ...paths(),
      configfsRoot: join(dir, 'no-such-configfs'),
    })
    assert.equal(held, null)
  })

  it('reads ONCE per cache, however many rows ask (never a request per row)', async () => {
    const cache = createIscsiClaimCache(exec, paths())
    const answers = await Promise.all([
      heldByLun(cache, { dataset: 'gtiscsi/vol1' }),
      heldByLun(cache, { path: '/gtiscsi/images' }),
      heldByLun(cache, { pool: 'gtiscsi' }),
      heldByLun(cache, { dataset: 'tank/media' }),
    ])
    assert.equal(answers[0]?.name, 'gtiscsi_vol1')
    assert.equal(answers[1]?.name, 'gtiscsi_lun2')
    assert.ok(answers[2])
    assert.equal(answers[3], null)
    // The cache holds the RESULT, so a second round asks nothing new either.
    assert.equal((await heldByLun(cache, { dataset: 'gtiscsi/vol1' }))?.name, 'gtiscsi_vol1')
  })

  it('a NEW cache re-reads — nothing survives the request (Principle 11)', async () => {
    const first = createIscsiClaimCache(exec, paths())
    const second = createIscsiClaimCache(exec, paths())
    assert.notEqual(await first.claims(), await second.claims())
  })
})

describe('iscsiServedSerials — the disk-inventory seam', () => {
  let dir: string
  let configfsRoot: string
  const exec = new MockExecutor()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-served-'))
    configfsRoot = join(dir, 'target')
    await materializeConfigfsManifest(
      readFileSync(join(ISCSI_FIXTURES, 'configfs-live.manifest'), 'utf-8'),
      configfsRoot,
    )
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('normalises a serial to the form both renderings share', () => {
    // LIO stores the UUID with dashes; the T10/by-id form drops them.
    assert.equal(normalizeSerial('9BC6E907-6015-4267-BE4F-5A0617CB3D71'), '9bc6e90760154267be4f5a0617cb3d71')
  })

  it('lists both real LUN serials from the capture', async () => {
    const serials = await iscsiServedSerials(exec, {
      configfsRoot,
      saveconfigPath: join(dir, 'absent.json'),
      pveStorageCfg: join(dir, 'absent.cfg'),
      blockRoot: join(dir, 'absent-block'),
    })
    assert.ok(serials.has(normalizeSerial('9bc6e907-6015-4267-be4f-5a0617cb3d71')))
    assert.ok(serials.has(normalizeSerial('689844a4-1d20-4cba-8516-bdc52a402645')))
  })

  it('FAIL-OPEN: no LIO ⇒ an empty set ⇒ nothing is ever tagged', async () => {
    const serials = await iscsiServedSerials(exec, {
      configfsRoot: join(dir, 'no-such-configfs'),
      saveconfigPath: join(dir, 'absent.json'),
      pveStorageCfg: join(dir, 'absent.cfg'),
      blockRoot: join(dir, 'absent-block'),
    })
    assert.equal(serials.size, 0)
  })
})

describe('configfsOptionsFrom — one conversion, no field-name duplication', () => {
  it('passes the configfs and block roots through', () => {
    assert.deepEqual(configfsOptionsFrom({ configfsRoot: '/x', blockRoot: '/y' }), { root: '/x', blockRoot: '/y' })
  })

  it('omits what was not overridden, so the service defaults still apply', () => {
    assert.deepEqual(configfsOptionsFrom({}), {})
  })
})
