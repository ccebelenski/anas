import type { AhrCapacity, AhrExpansionIntent, AhrPool } from '@anas/shared'
import type { CommandExecutor } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { writeIntent } from '../ahr-intent.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS, buildAhrWarnings, collectAhrWarnings, readAhrPools } from '../ahr-topology.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}
function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

const HOT1 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1'
const HOT2 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT2'
const HOT3 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT3'

/** The stage-0 phase-A pool `ahr0`, healthy and mounted (topology-test twin). */
function healthyExecutor(overrides?: { mdstat?: string, findmnt?: string, vgs?: string, lvs?: string }): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: ok(overrides?.mdstat ?? loadFixture('mdstat-clean.txt')) })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: ok(loadFixture('mdadm-export-r1.txt')) })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: ok(loadFixture('mdadm-export-r2.txt')) })
  mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: ok(loadFixture('lsblk-ahr0.json')) })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(loadFixture('disk-by-id-ahr.txt')) })
  mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: ok(overrides?.vgs ?? loadFixture('lvm-vgs.json')) })
  mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: ok(overrides?.lvs ?? loadFixture('lvm-lvs.json')) })
  mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: ok(overrides?.findmnt ?? loadFixture('findmnt-ahr0.json')) })
  mock.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: ok(loadFixture('btrfs-usage.txt')) })
  return mock
}

const EMPTY_CAPACITY: AhrCapacity = {
  rawBytes: 0,
  usableBytes: 0,
  usedBytes: 0,
  freeBytes: 0,
  redundancyOverheadBytes: 0,
  unprotectedWastedBytes: 0,
  pendingBytes: 0,
}

function intent(state: AhrExpansionIntent['state']): AhrExpansionIntent {
  return {
    id: randomUUID(),
    trigger: 'add-disk',
    approvedDisks: [HOT1, HOT2, HOT3],
    before: EMPTY_CAPACITY,
    after: EMPTY_CAPACITY,
    state,
  }
}

async function healthyPool(): Promise<AhrPool> {
  const pools = await readAhrPools(healthyExecutor())
  assert.equal(pools.length, 1)
  return pools[0]
}

describe('buildAhrWarnings (story 11.10, AHR-DESIGN §10)', () => {
  it('a healthy/idle pool adds NOTHING', async () => {
    assert.deepEqual(buildAhrWarnings([await healthyPool()]), [])
  })

  it('degraded: exactly one warning card naming which array/band + which member', async () => {
    const pools = await readAhrPools(healthyExecutor({ mdstat: loadFixture('mdstat-reshape-degraded.txt') }))
    const warnings = buildAhrWarnings(pools)
    assert.equal(warnings.length, 1)
    const w = warnings[0]
    assert.equal(w.level, 'warning')
    assert.equal(w.category, 'ahr')
    assert.equal(w.ref, 'ahr0')
    // Target-first: the pool, then the array/band, then the FULL member id
    // (ids are never truncated — UI discipline).
    assert.ok(w.message.includes(`AHR pool 'ahr0'`), 'names the pool')
    assert.ok(w.message.includes('ahr0-r1'), 'names the degraded array')
    assert.ok(w.message.includes('band 1'), 'names the band with a label')
    assert.ok(w.message.includes(`'${HOT1}'`), 'names the faulty member, untruncated')
  })

  it('failed: exactly one critical card', async () => {
    const failed: AhrPool = { ...(await healthyPool()), state: 'failed' }
    const warnings = buildAhrWarnings([failed])
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].level, 'critical')
    assert.equal(warnings[0].category, 'ahr')
    assert.equal(warnings[0].ref, 'ahr0')
    assert.ok(warnings[0].message.includes('FAILED'))
  })

  it('readonly (btrfs forced ro, reconstructed live): exactly one critical card', async () => {
    const findmnt = JSON.stringify({
      filesystems: [{
        target: '/mnt/anas-ahr/ahr0',
        source: '/dev/mapper/ahr0-ahr0--vol',
        fstype: 'btrfs',
        options: 'ro,relatime,space_cache=v2,subvolid=5,subvol=/',
      }],
    })
    const pools = await readAhrPools(healthyExecutor({ findmnt }))
    assert.equal(pools[0].state, 'readonly')
    const warnings = buildAhrWarnings(pools)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].level, 'critical')
    assert.equal(warnings[0].ref, 'ahr0')
    assert.ok(warnings[0].message.includes('READ-ONLY'))
  })

  it('halted expansion: exactly one card naming the Resume/Abandon verbs', async () => {
    const pool: AhrPool = { ...(await healthyPool()), expansion: intent('halted') }
    const warnings = buildAhrWarnings([pool])
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].level, 'warning')
    assert.equal(warnings[0].category, 'ahr')
    assert.equal(warnings[0].ref, 'ahr0')
    assert.ok(warnings[0].message.includes('Resume'), 'names Resume')
    assert.ok(warnings[0].message.includes('Abandon'), 'names Abandon')
  })

  it('degraded + halted expansion: still ONE card per pool, naming both', async () => {
    const pools = await readAhrPools(healthyExecutor({ mdstat: loadFixture('mdstat-reshape-degraded.txt') }))
    const pool: AhrPool = { ...pools[0], expansion: intent('halted') }
    const warnings = buildAhrWarnings([pool])
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].message.includes('degraded'))
    assert.ok(warnings[0].message.includes('Resume'))
  })

  it('a RUNNING expansion does not card (it rides the jobs strip)', async () => {
    const pool: AhrPool = { ...(await healthyPool()), expansion: intent('running') }
    assert.deepEqual(buildAhrWarnings([pool]), [])
  })

  it('in-progress expanding/rebuilding/scrubbing states do not card (jobs strip)', async () => {
    const base = await healthyPool()
    for (const state of ['expanding', 'rebuilding', 'scrubbing'] as const)
      assert.deepEqual(buildAhrWarnings([{ ...base, state }]), [], `${state} adds nothing`)
  })

  it('view-level advisories (pending capacity etc.) do not card', async () => {
    // A healthy pool that carries advisories still adds nothing — only the
    // four bad states card (spare-consumed/snapshot advisories stay view-level).
    const pool: AhrPool = { ...(await healthyPool()), advisories: ['spare consumed', 'flat-layout snapshot advisory'] }
    assert.deepEqual(buildAhrWarnings([pool]), [])
  })
})

describe('collectAhrWarnings (fail-open source for GET /v1/status)', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  it('an AHR read error degrades the source to no warnings, never a throw', async () => {
    const throwing: CommandExecutor = {
      exec: async () => {
        throw new Error('boom')
      },
      pipeline: async () => {
        throw new Error('boom')
      },
    }
    assert.deepEqual(await collectAhrWarnings(throwing), [])
  })

  it('joins the persisted halted intent onto the live pool (one card)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'anas-ahr-dash-'))
    await writeIntent('ahr0', intent('halted'), { dir })
    const warnings = await collectAhrWarnings(healthyExecutor(), dir)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].ref, 'ahr0')
    assert.ok(warnings[0].message.includes('Resume'))
  })

  it('an unreadable intent file degrades only that pool\'s halted card', async () => {
    dir = mkdtempSync(join(tmpdir(), 'anas-ahr-dash-'))
    writeFileSync(join(dir, 'ahr0.json'), '{ not json', 'utf-8')
    // The pool itself still reads healthy → no card, and no throw.
    assert.deepEqual(await collectAhrWarnings(healthyExecutor(), dir), [])
  })
})
