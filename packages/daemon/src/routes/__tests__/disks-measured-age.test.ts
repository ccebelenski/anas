import type { Disk } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { collectDisks } from '../disks.js'

/**
 * disks.1 — the list and detail payloads date the reading and carry the power
 * mode. `smartMeasuredAt` is the ISO timestamp of the probe that produced the
 * values on THIS payload (its own probe when fresh, the last measured one on a
 * standby/probe-failed carry-over — the cache spreads it), absent on a disk
 * never measured. `powerMode` is `power_mode.string` from the ATA identity
 * JSON when the disk reports one (never inferred), absent otherwise. Both are
 * additive and drop from the JSON when absent, so an older daemon / a SAS disk
 * simply leaves the UI rows out (version-skew ruling).
 */

const SMARTCTL = '/usr/sbin/smartctl'

const ATA_IDENTITY = {
  model_family: 'Western Digital Red Pro',
  model_name: 'WDC WD6003FRYZ-01GDEB1',
  form_factor: { name: '3.5 inches' },
  firmware_version: '82.00A82',
  sata_version: { string: 'SATA 3.3, 6.0 Gb/s' },
  power_mode: { string: 'ACTIVE or IDLE' },
  smart_status: { passed: true },
}

// One genuinely blank disk, sdb — no pools, no AHR, no iSCSI in this world.
const FLAT_LSBLK = JSON.stringify({
  blockdevices: [{
    'name': 'sdb',
    'type': 'disk',
    'size': 1073741824,
    'model': 'QEMU HARDDISK',
    'serial': 'AGE1',
    'tran': 'sata',
    'fstype': null,
    'mountpoint': null,
    'rota': true,
    'phy-sec': 512,
    'log-sec': 512,
    'wwn': null,
    'vendor': 'QEMU',
    'rev': '2.5+',
    'children': [],
  }],
})

const BY_ID = `lrwxrwxrwx 1 root root   9 Jul 22 22:43 scsi-0QEMU_QEMU_HARDDISK_AGE1 -> ../../sdb
`

const SDB_ID = 'scsi-0QEMU_QEMU_HARDDISK_AGE1'

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

function world(
  results: ExecResult[],
  cacheOpts: ConstructorParameters<typeof DiskIdentityCache>[1] = {},
) {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: ok(FLAT_LSBLK) })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(BY_ID) })
  executor.addFixture({
    command: SMARTCTL,
    args: ['-n', 'standby', '-iH', '--json', '/dev/sdb'],
    results,
  })
  const cache = new DiskIdentityCache(executor, cacheOpts)
  return {
    async fetch(): Promise<Disk> {
      const disks = await collectDisks(executor, cache)
      const disk = disks.find(d => d.id === SDB_ID)
      assert.ok(disk, 'sdb is in the payload')
      return disk
    },
  }
}

describe('GET /v1/disks — the payload dates the reading and carries the power mode (disks.1)', () => {
  it('a measured ATA reading carries smartMeasuredAt (ISO) and the power mode', async () => {
    const before = Date.now()
    const { fetch } = world([ok(JSON.stringify(ATA_IDENTITY))])

    const disk = await fetch()
    assert.equal(disk.powerMode, 'ACTIVE or IDLE', 'power_mode.string passes through verbatim')
    assert.ok(disk.smartMeasuredAt, 'the reading is dated')
    const at = Date.parse(disk.smartMeasuredAt!)
    assert.ok(!Number.isNaN(at) && at >= before - 1000 && at <= Date.now(), 'smartMeasuredAt is a real ISO timestamp near now')
  })

  it('a standby skip keeps the MEASURED reading\'s age and power mode on the payload', async () => {
    // reprobeMs: 0 = every reading is already past its cadence, so the second
    // pull re-probes (a fresh measured reading would be a hit and the skip
    // would never happen this fast).
    const { fetch } = world([
      ok(JSON.stringify(ATA_IDENTITY)),
      {
        stdout: '',
        stderr: 'Device is in STANDBY (OS) mode, exit(2)\n',
        exitCode: 2,
      },
    ], { reprobeMs: 0 })

    await fetch() // measured
    const stale = await fetch() // aged? no — asleep, and the skip is not a cache hit
    assert.equal(stale.smartStale, true)
    assert.equal(stale.smartStaleReason, 'standby')
    assert.equal(stale.powerMode, 'ACTIVE or IDLE', 'the measured power mode is kept')
    assert.ok(stale.smartMeasuredAt, 'the age of the MEASURED reading is reported')
  })

  it('a never-measured disk invents neither field', async () => {
    const { fetch } = world([{
      stdout: '',
      stderr: 'smartctl: Open "/dev/sdb" failed: Input/output error\n',
      exitCode: 1,
    }])

    const disk = await fetch()
    assert.equal(disk.powerMode, undefined, 'no power mode was ever measured')
    assert.equal(disk.smartMeasuredAt, undefined, 'no reading, no date')
  })

  it('a SAS-shaped identity (no power_mode) leaves powerMode out of the JSON entirely', async () => {
    const identity: Record<string, unknown> = { ...ATA_IDENTITY }
    delete identity.power_mode
    const { fetch } = world([ok(JSON.stringify(identity))])

    const disk = await fetch()
    assert.ok(disk.smartMeasuredAt, 'the reading is still dated')
    assert.equal(disk.powerMode, undefined, 'absent, never inferred')
    const raw = JSON.parse(JSON.stringify(disk)) as Record<string, unknown>
    assert.ok(!('powerMode' in raw), 'the key drops from the wire payload')
  })
})
