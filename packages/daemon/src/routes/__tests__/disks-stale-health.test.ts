import type { Disk } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { DiskIdentityCache } from '../../services/disk-identity-cache.js'
import { collectDisks } from '../disks.js'

/**
 * The disk payload must tell the UI when a SMART reading is the disk's LAST
 * KNOWN state, not a fresh probe: `smartStale` + `smartStaleReason`
 * ('standby' | 'probe-failed'), absent on a fresh reading. The daemon's
 * identity cache is what carries the marks — this drives the SAME cache
 * instance across several /disks fetches, which is how a disk's reading moves
 * through the states in a daemon's lifetime (seen asleep → probe fails →
 * recovers), and asserts the payload at each step.
 */

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

const SMARTCTL = '/usr/sbin/smartctl'
const SMART_ARGS = ['-n', 'standby', '-iH', '--json', '/dev/sdb']

const NORMAL_IDENTITY = {
  model_family: 'Western Digital Red Pro',
  model_name: 'WDC WD2003FZEX-00SRLA0',
  form_factor: { name: '3.5 inches' },
  firmware_version: '81.00A81',
  sata_version: { string: 'SATA 3.2, 6.0 Gb/s' },
  smart_status: { passed: true },
}

function standbyResult() {
  return {
    stdout: JSON.stringify({
      smartctl: { messages: [{ string: 'Device is in STANDBY mode, exit(2)', severity: 'information' }] },
    }),
    stderr: '',
    exitCode: 2,
  }
}

function failureResult() {
  return {
    stdout: '',
    stderr: 'smartctl: Open "/dev/sdb" failed: Input/output error\n',
    exitCode: 1,
  }
}

const NORMAL_IDENTITY_JSON = JSON.stringify(NORMAL_IDENTITY)

// One genuinely blank disk, sdb — no pools, no AHR, no iSCSI in this world.
const FLAT_LSBLK = JSON.stringify({
  blockdevices: [{
    'name': 'sdb',
    'type': 'disk',
    'size': 1073741824,
    'model': 'QEMU HARDDISK',
    'serial': 'STALE1',
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

const BY_ID = `lrwxrwxrwx 1 root root   9 Jul 22 22:43 scsi-0QEMU_QEMU_HARDDISK_STALE1 -> ../../sdb
`

const SDB_ID = 'scsi-0QEMU_QEMU_HARDDISK_STALE1'

/**
 * One world, one cache: each call to collectDisks is a /disks fetch. The
 * smartctl fixture's `results` sequence is what the disk answers with, probe
 * by probe.
 */
function world(results: ExecResult[]) {
  const executor = new MockExecutor()
  executor.addFixture({ command: '/usr/bin/lsblk', args: LSBLK_ARGS, result: ok(FLAT_LSBLK) })
  executor.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(BY_ID) })
  // No pools, said the way zpool says it (cr3: an unmocked status is a failed
  // read, and a disk ZFS could not be asked about is health unknown) — the
  // OpenZFS 2.4.x `zpool_do_status` -j shape: exit 0, an empty `pools` object.
  executor.addFixture({ command: '/usr/sbin/zpool', args: ['status', '-jv'], result: { stdout: '{"output_version":{"command":"zpool status","vers_major":0,"vers_minor":1},"pools":{}}\n', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: SMARTCTL, args: SMART_ARGS, results })
  const cache = new DiskIdentityCache(executor)
  async function fetch(): Promise<Disk> {
    const disks = await collectDisks(executor, cache)
    const disk = disks.find(d => d.id === SDB_ID)
    assert.ok(disk, 'sdb is in the payload')
    return disk
  }
  const smartCallCount = () => executor.calls.filter(c => c.command === SMARTCTL).length
  return { fetch, smartCallCount }
}

describe('GET /v1/disks — stale/standby health is marked in the payload', () => {
  it('a fresh measured reading carries no stale marker', async () => {
    const { fetch } = world([{ stdout: NORMAL_IDENTITY_JSON, stderr: '', exitCode: 0 }])

    const disk = await fetch()
    assert.equal(disk.modelFamily, 'Western Digital Red Pro')
    assert.equal(disk.smartHealthy, true)
    assert.equal(disk.healthStatus, 'healthy')
    assert.equal(disk.smartStale, undefined, 'a fresh reading is not stale')
    assert.equal(disk.smartStaleReason, undefined)
  })

  it('a first-ever probe failure is the plain unknown, unmarked — and the retry is alive, bounded', async () => {
    const { fetch, smartCallCount } = world([
      failureResult(),
      { stdout: NORMAL_IDENTITY_JSON, stderr: '', exitCode: 0 },
    ])

    const disk = await fetch()
    assert.equal(disk.smartHealthy, null, 'nothing was read — unknown, as before')
    assert.equal(disk.healthStatus, 'unknown')
    assert.equal(disk.smartStale, undefined, 'no prior reading — nothing to call stale')

    // failure 1 waits one pass: the next fetch probes again, and the disk
    // answers — a transient first failure must not blank the disk for the
    // daemon's lifetime
    const recovered = await fetch()
    assert.equal(recovered.modelFamily, 'Western Digital Red Pro')
    assert.equal(recovered.smartHealthy, true)
    assert.equal(recovered.smartStale, undefined)
    assert.equal(smartCallCount(), 2)
  })

  it('a seen disk whose probe fails is reported, re-probed with backoff, and recovers', async () => {
    const { fetch, smartCallCount } = world([
      standbyResult(),
      failureResult(),
      failureResult(),
      { stdout: NORMAL_IDENTITY_JSON, stderr: '', exitCode: 0 },
    ])

    // 1 — seen asleep: a reading with no health claim, not yet stale-marked
    //    (there is no prior reading to be stale relative to).
    const asleep = await fetch()
    assert.equal(asleep.smartHealthy, null)
    assert.equal(asleep.smartStale, undefined)

    // 2 — the probe failed: nothing was ever measured, so the payload is the
    //    plain unknown — UNMARKED ("last known" would be a claim about a
    //    reading that never happened). The disk IS re-probed (a standby
    //    reading is not a cache hit).
    const failed = await fetch()
    assert.equal(failed.smartStale, undefined, 'nothing was ever measured — nothing to call stale')
    assert.equal(failed.smartStaleReason, undefined)
    assert.equal(failed.smartHealthy, null, 'nothing was ever measured — the unknown stands, unmarked')
    assert.equal(smartCallCount(), 2)

    // 3 — failure 1 waited one pass: the next fetch probes again, and it
    //    fails again — still the plain unknown, still re-probing
    const failedAgain = await fetch()
    assert.equal(failedAgain.smartStale, undefined)
    assert.equal(failedAgain.smartStaleReason, undefined)
    assert.equal(smartCallCount(), 3)

    // 4 — failure 2 waits two passes: this fetch does not probe
    const waiting = await fetch()
    assert.equal(waiting.smartHealthy, null)
    assert.equal(smartCallCount(), 3, 'backoff — a disk that keeps failing is not probed on every pass')

    // 5 — smartctl answers: a fresh measured reading, the marks gone
    const recovered = await fetch()
    assert.equal(recovered.modelFamily, 'Western Digital Red Pro')
    assert.equal(recovered.smartHealthy, true)
    assert.equal(recovered.healthStatus, 'healthy')
    assert.equal(recovered.smartStale, undefined)
    assert.equal(recovered.smartStaleReason, undefined)
    assert.equal(smartCallCount(), 4)
  })
})
