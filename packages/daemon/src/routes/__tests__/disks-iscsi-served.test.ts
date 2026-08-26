import type { Disk } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isComposableDisk } from '@anas/shared'
import { normalizeSerial } from '../../services/iscsi-held.js'
import { handsOffContext } from '../disks.js'

/**
 * The loop-back hazard — story `iscsi.6`, clause 6.
 *
 * When the node's own `open-iscsi` initiator is logged in to the node's own LIO
 * target, its LUNs come back through `lsblk` as ordinary, pristine SCSI disks.
 * The wave-1 capture is the proof (`fixtures/iscsi/anasd-v1-disks.json`, a REAL
 * `/v1/disks` response from anasd 0.2.11 on the stunt node):
 *
 *     {"id":"scsi-36001405689844a41d204cba8516bdc52","name":"sdc",
 *      "transport":"iscsi","model":"gtiscsi_lun2","vendor":"LIO-ORG",
 *      "serial":"689844a4-1d20-4cba-8516-bdc52a402645","status":"available"}
 *
 * `status: available` — a genuine composer candidate. Nothing in the block layer
 * can tell that disk apart from a real remote array; only the SERIAL can,
 * because ANAS is the one that assigned it. So `status` stays honest (the disk
 * IS blank) and a hands-off TAG carries what ANAS knows on top.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAPTURE = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/iscsi/anasd-v1-disks.json'), 'utf-8'),
) as { data: Disk[] }

/** The two real LUN serials this node was serving during the capture. */
const SERVED = new Set([
  normalizeSerial('9bc6e907-6015-4267-be4f-5a0617cb3d71'),
  normalizeSerial('689844a4-1d20-4cba-8516-bdc52a402645'),
])

function diskNamed(name: string): Disk {
  const d = CAPTURE.data.find(row => row.name === name)
  assert.ok(d, `the capture has no disk '${name}'`)
  return d
}

describe('disks — the iscsi-served-here tag (story iscsi.6, GT-43)', () => {
  it('the REAL capture really does offer a self-served LUN as available (the hazard)', () => {
    const sdc = diskNamed('sdc')
    assert.equal(sdc.transport, 'iscsi')
    assert.equal(sdc.status, 'available')
    assert.equal(sdc.serial, '689844a4-1d20-4cba-8516-bdc52a402645')
  })

  it('tags an iSCSI disk whose serial is one of THIS node\'s LUN serials', () => {
    const ctx = handsOffContext(diskNamed('sdc'), SERVED)
    assert.equal(ctx.handsOff, 'iscsi-served-here')
    assert.match(ctx.handsOffReason ?? '', /served by THIS node/)
    // The reason names the backstore, which is the SCSI model string the
    // operator can see on the initiator (GT-15).
    assert.match(ctx.handsOffReason ?? '', /gtiscsi_lun2/)
    assert.match(ctx.handsOffReason ?? '', /iSCSI screen/)
  })

  it('tags the other served LUN too (both, not just the first)', () => {
    assert.equal(handsOffContext(diskNamed('sdb'), SERVED).handsOff, 'iscsi-served-here')
  })

  it('does NOT tag a local disk, whatever its serial', () => {
    const sda = diskNamed('sda')
    assert.notEqual(sda.transport, 'iscsi')
    assert.deepEqual(handsOffContext({ ...sda, serial: [...SERVED][0] }, SERVED), {})
  })

  it('does NOT tag a REMOTE iSCSI disk this node does not serve — that is legitimate storage', () => {
    const foreign = { ...diskNamed('sdc'), serial: 'aaaaaaaa-1111-2222-3333-444444444444' }
    assert.deepEqual(handsOffContext(foreign, SERVED), {})
  })

  it('matches across the dashed / undashed renderings of the same serial', () => {
    const undashed = { ...diskNamed('sdc'), serial: '689844a41d204cba8516bdc52a402645' }
    assert.equal(handsOffContext(undashed, SERVED).handsOff, 'iscsi-served-here')
  })

  it('matches case-insensitively', () => {
    const upper = { ...diskNamed('sdc'), serial: '689844A4-1D20-4CBA-8516-BDC52A402645' }
    assert.equal(handsOffContext(upper, SERVED).handsOff, 'iscsi-served-here')
  })

  it('FAIL-OPEN: an empty served set tags nothing (no LIO ⇒ no tag)', () => {
    assert.deepEqual(handsOffContext(diskNamed('sdc'), new Set()), {})
  })

  it('a disk with no serial is never tagged (there is nothing to match)', () => {
    assert.deepEqual(handsOffContext({ ...diskNamed('sdc'), serial: null }, SERVED), {})
  })
})

describe('isComposableDisk — hands-off means something (story iscsi.6)', () => {
  it('a blank, untagged disk is composable', () => {
    assert.equal(isComposableDisk({ status: 'available' }), true)
  })

  it('a self-served LUN is NOT composable, even though it is genuinely blank', () => {
    assert.equal(isComposableDisk({ status: 'available', handsOff: 'iscsi-served-here' }), false)
  })

  it('every in-use status stays non-composable, tag or no tag', () => {
    for (const status of ['pool_member', 'ahr_member', 'ceph_osd', 'system', 'other'] as const)
      assert.equal(isComposableDisk({ status }), false, status)
  })

  it('an old daemon (no tag field at all) behaves exactly as before — version skew', () => {
    const legacy = { status: 'available' } as { status: Disk['status'], handsOff?: Disk['handsOff'] }
    assert.equal(isComposableDisk(legacy), true)
  })
})
