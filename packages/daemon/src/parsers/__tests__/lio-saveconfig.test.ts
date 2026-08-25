import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  EMPTY_SAVECONFIG,
  normalizePortalAddress,
  parseLioSaveconfig,
  parseStorageObjectRef,
  readLioSaveconfig,
  storageObjectsByName,
} from '../lio-saveconfig.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/iscsi')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

function parseFixture(name: string) {
  return parseLioSaveconfig(loadFixture(name))
}

// Every assertion below is against a REAL capture from the iscsi.1 stunt-node
// run (fixtures/iscsi/NOTES.md). Values are asserted exactly — the point of a
// ground-truth fixture is that it pins the real bytes, not a shape.

describe('parseLioSaveconfig — storage objects (the persisted backstores)', () => {
  const cfg = parseFixture('saveconfig-final.json')

  it('reads both backing kinds with their exact dev, plugin and serial', () => {
    assert.equal(cfg.storageObjects.length, 2)

    const block = cfg.storageObjects.find(s => s.name === 'gtiscsi_vol1')!
    assert.equal(block.plugin, 'block')
    // GT-48: the STABLE zvol path, never /dev/zdN — the kernel number moves
    // across a reboot and only this path survives.
    assert.equal(block.dev, '/dev/zvol/gtiscsi/vol1')
    assert.equal(block.wwn, '9bc6e907-6015-4267-be4f-5a0617cb3d71')
    assert.equal(block.size, null) // block backstores carry no size (GT-29 contrast)
    assert.equal(block.readOnly, false)
    assert.equal(block.writeBack, false)

    const fileio = cfg.storageObjects.find(s => s.name === 'gtiscsi_lun2')!
    assert.equal(fileio.plugin, 'fileio')
    assert.equal(fileio.dev, '/gtiscsi/images/lun2.raw')
    assert.equal(fileio.wwn, '689844a4-1d20-4cba-8516-bdc52a402645')
    // GT-29: a fileio LUN's size is fixed at creation and IS persisted.
    assert.equal(fileio.size, 1073741824)
    assert.equal(fileio.aio, false)
  })

  it('carries the raw attributes map (GT-12: NOT the `get attribute` set)', () => {
    const block = cfg.storageObjects.find(s => s.name === 'gtiscsi_vol1')!
    assert.equal(block.attributes.emulate_tpu, 1)
    assert.equal(block.attributes.emulate_tpws, 1)
    assert.equal(block.attributes.block_size, 512)
    assert.equal(block.attributes.max_unmap_lba_count, 524288)
    assert.equal(block.attributes.unmap_granularity, 32) // = the 16K volblocksize
    // `emulate_3pc` is in saveconfig and configfs but not in `get attribute`.
    assert.equal(block.attributes.emulate_3pc, 1)
  })

  it('indexes storage objects by backstore name', () => {
    const byName = storageObjectsByName(cfg)
    const names = [...byName.keys()]
    names.sort()
    assert.deepEqual(names, ['gtiscsi_lun2', 'gtiscsi_vol1'])
    assert.equal(byName.get('gtiscsi_vol1')!.dev, '/dev/zvol/gtiscsi/vol1')
  })

  it('reads the shipped fileio defaults from the pre-tuning capture (GT-26)', () => {
    // saveconfig-acl-nochap is state A: before any attribute was touched.
    const before = parseFixture('saveconfig-acl-nochap.json')
    const fileio = before.storageObjects.find(s => s.name === 'gtiscsi_lun2')!
    // Thin reclaim ships OFF on BOTH kinds…
    assert.equal(fileio.attributes.emulate_tpu, 0)
    assert.equal(fileio.attributes.emulate_tpws, 0)
    // …and fileio ships write-back ON, which is a crash-data-loss default.
    assert.equal(fileio.writeBack, true)
    assert.equal(fileio.attributes.emulate_write_cache, 1)
    // The 8192-LBA (4 MiB) default that makes a whole-device discard fail.
    assert.equal(fileio.attributes.max_unmap_lba_count, 8192)

    const block = before.storageObjects.find(s => s.name === 'gtiscsi_vol1')!
    assert.equal(block.attributes.emulate_tpu, 0)
    assert.equal(block.attributes.emulate_tpws, 0)
    assert.equal(block.attributes.emulate_write_cache, 0)
  })

  it('sees the fileio size change across the delete+recreate resize (GT-29)', () => {
    // 512 MiB in state A/B, 1 GiB in state C/D after the recreate — and the
    // SERIAL is identical across it, which is the whole point of GT-17.
    const a = parseFixture('saveconfig-acl-nochap.json').storageObjects.find(s => s.name === 'gtiscsi_lun2')!
    const c = parseFixture('saveconfig-chap-mutual.json').storageObjects.find(s => s.name === 'gtiscsi_lun2')!
    assert.equal(a.size, 536870912)
    assert.equal(c.size, 1073741824)
    assert.equal(a.wwn, c.wwn)
    assert.equal(a.wwn, '689844a4-1d20-4cba-8516-bdc52a402645')
  })
})

describe('parseLioSaveconfig — targets, TPGs and portals', () => {
  const cfg = parseFixture('saveconfig-final.json')
  const target = cfg.targets[0]

  it('reads the IQN out of the target `wwn` key', () => {
    assert.equal(cfg.targets.length, 1)
    assert.equal(target.iqn, 'iqn.2026-08.dev.anas.gtiscsi:target1')
    assert.equal(target.fabric, 'iscsi')
  })

  it('reads the TPG tag, enable flag and security attributes', () => {
    const tpg = target.tpgs[0]
    assert.equal(tpg.tag, 1)
    assert.equal(tpg.enable, true)
    assert.equal(tpg.authentication, true)
    // GT-31: LIO's demo mode is off by default — nothing to disable…
    assert.equal(tpg.generateNodeAcls, false)
    // …but discovery is WIDE OPEN by default, which iscsi.4 must close.
    assert.equal(tpg.demoModeDiscovery, true)
  })

  it('maps LUN indexes to their backstores and IGNORES the throwaway alias', () => {
    const tpg = target.tpgs[0]
    assert.deepEqual(tpg.luns.map(l => [l.index, l.plugin, l.backstoreName]), [
      [0, 'block', 'gtiscsi_vol1'],
      [1, 'fileio', 'gtiscsi_lun2'],
    ])
    // GT-12: `alias` is a random 10-hex string regenerated on every create. It
    // must never reach the model — the field does not exist on SaveconfigLun.
    assert.equal('alias' in tpg.luns[0], false)
  })

  it('the alias really does change between two captures of the same LUN', () => {
    // Proof that ignoring it is not theoretical: state A and state C hold the
    // SAME lun 0 of the SAME backstore with different aliases.
    const a = JSON.parse(loadFixture('saveconfig-acl-nochap.json'))
    const c = JSON.parse(loadFixture('saveconfig-chap-mutual.json'))
    assert.equal(a.targets[0].tpgs[0].luns[0].alias, '6847ded961')
    assert.equal(c.targets[0].tpgs[0].luns[0].alias, '04fa9dfa05')
    assert.notEqual(a.targets[0].tpgs[0].luns[0].alias, c.targets[0].tpgs[0].luns[0].alias)
    // Both parse to the same LUN identity regardless.
    const pa = parseFixture('saveconfig-acl-nochap.json').targets[0].tpgs[0].luns[0]
    const pc = parseFixture('saveconfig-chap-mutual.json').targets[0].tpgs[0].luns[0]
    assert.deepEqual(pa, pc)
  })

  it('normalises the BRACKETED IPv6 portal address (GT-12)', () => {
    // The three-portal capture: v4, a ULA v6 (bracketed in the file) and a
    // dummy v4 that no interface carries.
    const tpg = parseFixture('saveconfig-acl-nochap.json').targets[0].tpgs[0]
    assert.deepEqual(tpg.portals.map(p => [p.address, p.port, p.ipv6]), [
      ['192.168.200.50', 3260, false],
      ['fd00:6774:0:1::1', 3260, true],
      ['10.99.99.1', 3260, false],
    ])
    // The raw file really does bracket it — this is what we normalised away.
    const raw = JSON.parse(loadFixture('saveconfig-acl-nochap.json'))
    assert.equal(raw.targets[0].tpgs[0].portals[1].ip_address, '[fd00:6774:0:1::1]')
    assert.equal(tpg.portals[1].iser, false)
    assert.equal(tpg.portals[1].offload, false)
  })
})

describe('parseLioSaveconfig — ACLs never carry a secret (GT-12/GT-35)', () => {
  it('reduces both CHAP secrets to booleans and keeps the userids', () => {
    const tpg = parseFixture('saveconfig-final.json').targets[0].tpgs[0]

    const debian = tpg.acls.find(a => a.initiatorIqn === 'iqn.1993-08.org.debian:01:ae3d2ec18ad')!
    assert.equal(debian.chapUserid, 'gtacluser')
    assert.equal(debian.chapCredentialsSet, true)
    assert.equal(debian.mutualUserid, 'gttargetuser')
    assert.equal(debian.mutualCredentialsSet, true)
    assert.deepEqual(debian.mappedLuns, [0, 1])

    const allowed2 = tpg.acls.find(a => a.initiatorIqn === 'iqn.2026-08.dev.anas.gtiscsi:allowed2')!
    assert.equal(allowed2.chapUserid, null)
    assert.equal(allowed2.chapCredentialsSet, false)
    assert.equal(allowed2.mutualUserid, null)
    assert.equal(allowed2.mutualCredentialsSet, false)
  })

  it('no serialised parse output contains any secret-bearing key', () => {
    // The blunt check: the plaintext keys are in the FILE (0600 root-only), and
    // the parse result must not carry them or their values anywhere.
    for (const name of ['saveconfig-final.json', 'saveconfig-chap-mutual.json', 'saveconfig-full-2luns-chap.json']) {
      const text = loadFixture(name)
      assert.ok(text.includes('"chap_password"'), `${name} should contain the plaintext key`)
      const serialised = JSON.stringify(parseFixture(name))
      for (const key of ['chap_password', 'chap_mutual_password', 'REDACTED-16char', 'password']) {
        assert.equal(serialised.includes(key), false, `${name}: parse output leaked '${key}'`)
      }
    }
  })

  it('reports the TPG-level CHAP secret as a boolean too (ignored under explicit ACLs — GT-32)', () => {
    const before = parseFixture('saveconfig-acl-nochap.json').targets[0].tpgs[0]
    assert.equal(before.tpgCredentialsSet, false)
    assert.equal(before.authentication, false)
    const after = parseFixture('saveconfig-chap-mutual.json').targets[0].tpgs[0]
    assert.equal(after.tpgCredentialsSet, true)
    assert.equal(after.authentication, true)
  })
})

describe('normalizePortalAddress', () => {
  it('strips brackets from IPv6 and leaves IPv4 alone', () => {
    assert.deepEqual(normalizePortalAddress('[fd00:6774:0:1::1]'), { address: 'fd00:6774:0:1::1', ipv6: true })
    assert.deepEqual(normalizePortalAddress('192.168.200.50'), { address: '192.168.200.50', ipv6: false })
    assert.deepEqual(normalizePortalAddress('0.0.0.0'), { address: '0.0.0.0', ipv6: false })
  })

  it('recognises an unbracketed v6 form as v6 without re-splitting it', () => {
    // targetcli's own create message prints this ambiguous form (GT-25).
    assert.deepEqual(normalizePortalAddress('fd00:6774:0:1::1'), { address: 'fd00:6774:0:1::1', ipv6: true })
  })
})

describe('parseStorageObjectRef', () => {
  it('splits a /backstores/<plugin>/<name> reference', () => {
    assert.deepEqual(parseStorageObjectRef('/backstores/block/gtiscsi_vol1'), { plugin: 'block', name: 'gtiscsi_vol1' })
    assert.deepEqual(parseStorageObjectRef('/backstores/fileio/gtiscsi_lun2'), { plugin: 'fileio', name: 'gtiscsi_lun2' })
  })

  it('returns null for a malformed reference', () => {
    assert.equal(parseStorageObjectRef('gtiscsi_vol1'), null)
    assert.equal(parseStorageObjectRef('/backstores/block'), null)
  })
})

describe('parseLioSaveconfig — totality and fail-open', () => {
  it('parses the empty configuration LIO writes when nothing is defined (GT-11)', () => {
    const cfg = parseLioSaveconfig('{\n  "fabric_modules": [],\n  "storage_objects": [],\n  "targets": []\n}')
    assert.deepEqual(cfg, EMPTY_SAVECONFIG)
  })

  it('drops malformed entries instead of throwing', () => {
    const cfg = parseLioSaveconfig(JSON.stringify({
      storage_objects: [
        { name: 'ok', plugin: 'block', dev: '/dev/zvol/p/v', wwn: 'x', attributes: { block_size: 512, bogus: 'nope' } },
        { plugin: 'block', dev: '/dev/x' }, // no name
        'not-an-object',
      ],
      targets: [
        { wwn: 'iqn.2026-01.anas:t', tpgs: [{ tag: 1, enable: true, luns: [{ index: 0 }], portals: [{ ip_address: 'x' }] }] },
        { tpgs: [] }, // no wwn
      ],
    }))
    assert.equal(cfg.storageObjects.length, 1)
    assert.equal(cfg.storageObjects[0].name, 'ok')
    // Non-numeric attribute values are not copied.
    assert.deepEqual(cfg.storageObjects[0].attributes, { block_size: 512 })
    assert.equal(cfg.targets.length, 1)
    // A LUN with no storage_object and a portal with no port are both dropped.
    assert.deepEqual(cfg.targets[0].tpgs[0].luns, [])
    assert.deepEqual(cfg.targets[0].tpgs[0].portals, [])
  })

  it('readLioSaveconfig returns null for a missing file — never throws', async () => {
    assert.equal(await readLioSaveconfig(join(fixturesDir, 'no-such-saveconfig.json')), null)
  })

  it('readLioSaveconfig returns null for unparseable content', async () => {
    // NOTES.md is right there and is definitely not JSON.
    assert.equal(await readLioSaveconfig(join(fixturesDir, 'NOTES.md')), null)
  })

  it('readLioSaveconfig reads the real capture end to end', async () => {
    const cfg = await readLioSaveconfig(join(fixturesDir, 'saveconfig-final.json'))
    assert.ok(cfg)
    assert.equal(cfg.targets[0].iqn, 'iqn.2026-08.dev.anas.gtiscsi:target1')
    assert.equal(cfg.storageObjects.length, 2)
  })
})
