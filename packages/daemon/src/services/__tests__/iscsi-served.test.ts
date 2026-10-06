import type { ConfigfsBackstore, LioLiveState } from '../iscsi-configfs.js'
import type { IscsiRepairPlan } from '../iscsi-repair.js'
import type { DeviceStat } from '../iscsi-served.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseBackstoreInfo } from '../iscsi-configfs.js'
import { assertRepairable, guardRepairPlan } from '../iscsi-repair.js'
import {
  decodeDevT,
  deviceStatSeamFromEnv,
  SERVED_DEVICE_MISMATCH,
  servedDevice,
  servedElsewhere,
} from '../iscsi-served.js'

/**
 * Story ident.2 (audit #8): the served device is a LUN's identity. These are
 * the pure halves — the device-number decode, the ONE comparison, the repair
 * guard and the test seam's env form. The route-level proofs (409s, confirm
 * binding, the job re-read under the lock) live in the route tests.
 */

function backstore(over: Partial<ConfigfsBackstore> = {}): ConfigfsBackstore {
  return {
    name: 'vmdisk1',
    plugin: 'iblock',
    hbaIndex: 0,
    udevPath: '/dev/zvol/tank/vol1',
    serial: '9bc6e907-6015-4267-be4f-5a0617cb3d71',
    productId: 'vmdisk1',
    vendorId: 'LIO-ORG',
    enabled: true,
    status: 'ACTIVATED',
    claimed: 'IBLOCK',
    kernelDevice: 'zd16',
    size: 4294967296,
    devMajor: 230,
    devMinor: 16,
    attributes: {},
    ...over,
  }
}

function blockStat(major: number, minor: number): DeviceStat {
  return { type: 'block', rdevMajor: major, rdevMinor: minor, dev: '5', ino: '900', size: 0 }
}

const ZVOL_LUN = { index: 0, name: 'vmdisk1', plugin: 'block', backingPath: '/dev/zvol/tank/vol1' }
const FILE_LUN = { index: 1, name: 'imgdisk', plugin: 'fileio', backingPath: '/tank/images/imgdisk.raw' }

describe('decodeDevT — glibc major/minor split', () => {
  it('decodes a small device number (zd16 = 230:16)', () => {
    assert.deepEqual(decodeDevT((230n << 8n) | 16n), { major: 230, minor: 16 })
  })

  it('decodes a minor above 255 (the high minor bits live above the major)', () => {
    // makedev(230, 4096): minor low 8 bits in 0..7, the rest from bit 20 up.
    const rdev = ((4096n & 0xFFn) | ((230n & 0xFFFn) << 8n) | ((4096n & ~0xFFn) << 12n))
    assert.deepEqual(decodeDevT(rdev), { major: 230, minor: 4096 })
  })
})

describe('parseBackstoreInfo — the opened device number (ident.2)', () => {
  it('reads Major/Minor from a block backstore (the real reboot capture)', () => {
    const info = parseBackstoreInfo(
      'Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 32768\n'
      + '        iBlock device: zd16  UDEV PATH: /dev/zvol/gtiscsi/vol1  readonly: 0\n'
      + '  exclusive: 1\n'
      + '        Major: 230 Minor: 16  CLAIMED: IBLOCK',
    )
    assert.equal(info.major, 230)
    assert.equal(info.minor, 16)
  })

  it('fileio reports none', () => {
    const info = parseBackstoreInfo(
      'Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 16384\n'
      + '        TCM FILEIO ID: 0        File: /gtiscsi/images/lun2.raw  Size: 1073741824  Mode: O_DSYNC Async: 0',
    )
    assert.equal(info.major, null)
    assert.equal(info.minor, null)
  })
})

describe('servedDevice — THE comparison', () => {
  it('a zvol whose path is the device LIO opened verifies, and binds the device', () => {
    const v = servedDevice(ZVOL_LUN, backstore(), blockStat(230, 16))
    assert.equal(v.refusal, null)
    assert.equal(v.device, 'block:230:16')
  })

  it('rename + re-create under the live LUN: the path is another device → mismatch naming both', () => {
    const v = servedDevice(ZVOL_LUN, backstore(), blockStat(230, 32))
    assert.equal(v.device, null)
    assert.equal(v.refusal?.reason, 'served-device-mismatch')
    assert.ok(v.refusal?.message.startsWith(SERVED_DEVICE_MISMATCH))
    assert.match(v.refusal!.message, /serves device 230:16 \(zd16\), but \/dev\/zvol\/tank\/vol1 is device 230:32/)
  })

  it('a path that no longer resolves (renamed away) is a mismatch too', () => {
    const v = servedDevice(ZVOL_LUN, backstore(), null)
    assert.equal(v.refusal?.reason, 'served-device-mismatch')
    assert.match(v.refusal!.message, /no longer resolves/)
  })

  it('a path that is not a block device is a mismatch', () => {
    const v = servedDevice(ZVOL_LUN, backstore(), { ...blockStat(0, 0), type: 'file' })
    assert.equal(v.refusal?.reason, 'served-device-mismatch')
    assert.match(v.refusal!.message, /is not a block device/)
  })

  it('no live backstore, or no Major/Minor in its info → unknown, never a guess', () => {
    assert.equal(servedDevice(ZVOL_LUN, undefined, blockStat(230, 16)).refusal?.reason, 'served-device-unknown')
    assert.equal(
      servedDevice(ZVOL_LUN, backstore({ devMajor: null, devMinor: null }), blockStat(230, 16)).refusal?.reason,
      'served-device-unknown',
    )
  })

  it('an image binds the file\'s dev:ino; a missing file is unknown', () => {
    const fileStore = backstore({ name: 'imgdisk', plugin: 'fileio', devMajor: null, devMinor: null, kernelDevice: null })
    const ok = servedDevice(FILE_LUN, fileStore, { type: 'file', rdevMajor: 0, rdevMinor: 0, dev: '2049', ino: '77', size: 1 })
    assert.equal(ok.device, 'file:2049:77')
    assert.equal(ok.refusal, null)
    assert.equal(servedDevice(FILE_LUN, fileStore, null).refusal?.reason, 'served-device-unknown')
  })
})

describe('servedElsewhere + guardRepairPlan — a hole is never recreated over a served device', () => {
  const live: LioLiveState = { present: true, backstores: [backstore()], targets: [] }

  it('finds the live block backstore serving a device', () => {
    assert.deepEqual(servedElsewhere(live, blockStat(230, 16)), { name: 'vmdisk1', device: '230:16' })
    assert.equal(servedElsewhere(live, blockStat(230, 48)), null)
    assert.equal(servedElsewhere(live, null), null)
  })

  function plan(path: string): IscsiRepairPlan {
    return {
      repairable: [{
        targetIqn: 'iqn.x',
        tpgTag: 1,
        lunIndex: 1,
        backstoreName: 'ghost',
        plugin: 'block',
        backingPath: path,
        backingPresent: true,
        stubBacking: false,
        serial: 'deadbeef',
        size: null,
        writeBack: false,
        attributes: { emulateTpu: true, emulateTpws: true, maxUnmapLbaCount: 524288, writeBack: false },
        aclInitiators: [],
      }],
      blocked: [],
    }
  }

  it('moves a hole whose path names a served device to blocked, with the reason', async () => {
    const guarded = await guardRepairPlan(plan('/dev/zvol/tank/gone'), live, async () => blockStat(230, 16))
    assert.equal(guarded.repairable.length, 0)
    assert.equal(guarded.blocked.length, 1)
    assert.equal(guarded.blocked[0].deviceServed, true)
    assert.match(guarded.blocked[0].blockedReason!, /already serves as backstore 'vmdisk1'/)
    const refusal = assertRepairable(guarded)
    assert.equal(refusal?.reason, 'served-device-mismatch')
    assert.match(refusal!.message, /path names a different device/)
  })

  it('leaves a hole over an unserved device repairable', async () => {
    const guarded = await guardRepairPlan(plan('/dev/zvol/tank/gone'), live, async () => blockStat(230, 48))
    assert.equal(guarded.repairable.length, 1)
    assert.equal(assertRepairable(guarded), null)
  })
})

describe('deviceStatSeamFromEnv — the test seam\'s env form', () => {
  it('is absent when nothing is listed (production never carries it)', () => {
    assert.equal(deviceStatSeamFromEnv(undefined), undefined)
    assert.equal(deviceStatSeamFromEnv(''), undefined)
  })

  it('answers listed block and file paths', async () => {
    const seam = deviceStatSeamFromEnv('/dev/zvol/tank/vol1=230:16;/img/a.raw=file:2049:77:4096')!
    assert.deepEqual(await seam('/dev/zvol/tank/vol1'), { type: 'block', rdevMajor: 230, rdevMinor: 16, dev: '0', ino: '0', size: 0 })
    assert.deepEqual(await seam('/img/a.raw'), { type: 'file', rdevMajor: 0, rdevMinor: 0, dev: '2049', ino: '77', size: 4096 })
  })
})
