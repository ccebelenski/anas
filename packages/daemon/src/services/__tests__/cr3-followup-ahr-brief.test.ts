import type { AhrPool } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AhrPoolBrief } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS, buildAhrCapacityWarnings, buildAhrPoolBriefs, readAhrPools } from '../ahr-topology.js'

/**
 * cr3.followup item 7 — the dashboard's AHR brief invented 0 bytes where the
 * topology read could not say (`usableBytes: pool.capacity.usableBytes ?? 0`,
 * and a member's size `?? 0` when its disk is not in the pool's disk list):
 * GET /v1/ahr said null, GET /v1/status said 0. Unknown is null now, and the
 * panel's `knownNumber` / `bytesOrUnknown` already render null as unknown.
 */

const AHR = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/ahr')
const fx = (name: string) => readFileSync(join(AHR, name), 'utf-8')
const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })

/** The stage-0 ahr0 capture (as ahr-dashboard.test.ts's healthy world). */
async function capturedPool(): Promise<AhrPool> {
  const mock = new MockExecutor()
  mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: ok(fx('mdstat-clean.txt')) })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: ok(fx('mdadm-export-r1.txt')) })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: ok(fx('mdadm-export-r2.txt')) })
  mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: ok(fx('lsblk-ahr0.json')) })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(fx('disk-by-id-ahr.txt')) })
  mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: ok(fx('lvm-vgs.json')) })
  mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: ok(fx('lvm-lvs.json')) })
  mock.addFixture({ command: '/usr/sbin/pvs', result: ok(fx('lvm-pvs.json')) })
  mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: ok(fx('findmnt-ahr0.json')) })
  mock.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: ok(fx('btrfs-usage.txt')) })
  const pools = await readAhrPools(mock)
  assert.equal(pools.length, 1)
  return pools[0]
}

describe('cr3.followup — the AHR dashboard brief never invents 0 bytes', () => {
  it('a capacity the topology read could not say is null in the brief, never 0', async () => {
    const pool = await capturedPool()
    const unknown: AhrPool = { ...pool, capacity: { ...pool.capacity, usableBytes: null, usedBytes: null } }
    const [brief] = buildAhrPoolBriefs([unknown])
    assert.equal(brief.usableBytes, null)
    assert.equal(brief.usedBytes, undefined)
    assert.ok(AhrPoolBrief.safeParse(brief).success)
    assert.deepEqual(buildAhrCapacityWarnings([brief]), [], 'no percentage from an unknown capacity')
  })

  it('a band member whose disk the pool does not list has an unknown size, never 0', async () => {
    const pool = await capturedPool()
    const member = pool.arrays[0].members[0].disk
    const missing: AhrPool = { ...pool, disks: pool.disks.filter(d => d.id !== member) }
    const [brief] = buildAhrPoolBriefs([missing])
    const row = brief.bands.flatMap(b => b.members).find(m => m.id === member)
    assert.ok(row)
    assert.equal(row.sizeBytes, null)
  })

  it('control: a read capacity and a listed member keep their numbers', async () => {
    const pool = await capturedPool()
    const [brief] = buildAhrPoolBriefs([pool])
    assert.equal(brief.usableBytes, pool.capacity.usableBytes)
    assert.ok(brief.bands.every(b => b.members.every(m => typeof m.sizeBytes === 'number' && m.sizeBytes > 0)))
  })
})
