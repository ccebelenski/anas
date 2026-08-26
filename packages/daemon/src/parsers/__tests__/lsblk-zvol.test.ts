import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isInventoryDisk, parseLsblk } from '../lsblk.js'

/**
 * The one candidate filter — story `iscsi.6`.
 *
 * `lsblk` reports a ZFS zvol as `{"name": "zd16", "type": "disk"}` with no
 * transport and no signature, so a BLANK zvol has always come back from
 * `/v1/disks` as `status: "available"` — a genuine composer candidate (GT-43).
 * Offer it and the operator can build a ZFS pool inside a ZFS pool. A zvol is a
 * ZFS OBJECT: it belongs to Datasets (where `iscsi.3` made it first-class) and
 * to the iSCSI screen (which exports it), and it is not inventory — exactly like
 * the loop devices already excluded beside it.
 *
 * Driven against `fixtures/iscsi/lsblk-zd-tran.json`, a REAL read-only capture
 * from the stunt node (`lsblk -J -o NAME,TYPE,KNAME,SERIAL,SIZE,TRAN`) taken
 * with the node's own initiator logged OUT — three `zd*` rows, one real disk,
 * one CD-ROM. See `fixtures/iscsi/NOTES.md`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ISCSI_FIXTURES = join(__dirname, '../../fixtures/iscsi')

function loadJson(name: string) {
  return JSON.parse(readFileSync(join(ISCSI_FIXTURES, name), 'utf-8'))
}

describe('parseLsblk — zvols are never inventory (story iscsi.6, GT-43)', () => {
  it('the REAL capture does contain zvols reported as type "disk" (the hazard)', () => {
    const raw = loadJson('lsblk-zd-tran.json') as { blockdevices: { name: string, type: string }[] }
    const zvols = raw.blockdevices.filter(d => d.name.startsWith('zd'))
    assert.equal(zvols.length, 3)
    for (const z of zvols)
      assert.equal(z.type, 'disk')
  })

  it('excludes every zd* device from the parsed inventory', () => {
    const disks = parseLsblk(loadJson('lsblk-zd-tran.json'), new Map())
    assert.deepEqual(disks.filter(d => d.name.startsWith('zd')), [])
  })

  it('keeps the real disk beside them (the filter is surgical, not a blanket)', () => {
    const disks = parseLsblk(loadJson('lsblk-zd-tran.json'), new Map())
    assert.deepEqual(disks.map(d => d.name), ['sda'])
  })

  it('a zvol can therefore never be a composer/AHR/spare candidate — it is not there at all', () => {
    const disks = parseLsblk(loadJson('lsblk-zd-tran.json'), new Map())
    // Every candidacy check in the daemon and the UI starts from this list.
    assert.equal(disks.some(d => d.name.startsWith('zd')), false)
    assert.equal(disks.filter(d => d.status === 'available').length, 0)
  })

  describe('isInventoryDisk — the predicate itself', () => {
    it('excludes zd<N>, loop<N> and zram<N>', () => {
      for (const name of ['zd0', 'zd16', 'zd4096', 'loop0', 'zram0'])
        assert.equal(isInventoryDisk({ type: 'disk', name }), false, name)
    })

    it('keeps ordinary disks, including one whose name merely starts with "zd"', () => {
      // Anchored on digits: a hypothetical real device named `zdisk0` stays.
      for (const name of ['sda', 'nvme0n1', 'vdb', 'zdisk0'])
        assert.equal(isInventoryDisk({ type: 'disk', name }), true, name)
    })

    it('excludes anything that is not a whole disk (partitions, ROMs)', () => {
      assert.equal(isInventoryDisk({ type: 'part', name: 'sda1' }), false)
      assert.equal(isInventoryDisk({ type: 'rom', name: 'sr0' }), false)
    })
  })
})
