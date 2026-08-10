import type { AhrCapacity, AhrDisk, AhrExpansionIntent, AhrPool, AhrPoolBrief } from '@anas/shared'
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
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS, buildAhrCapacityWarnings, buildAhrPoolBriefs, buildAhrWarnings, collectAhrPoolBriefs, collectAhrWarnings, readAhrPools } from '../ahr-topology.js'

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
const HOT4 = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT4'

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

  it('offline: exactly one CRITICAL card saying the data is unavailable (issue #18)', async () => {
    // The LV half of the offline evidence, live-derived: the arrays are fine but
    // the volume is not active (`-wi-----p-` — an LV over a partial VG), so the
    // pool serves nothing. It must card CRITICAL, never as amber degraded.
    const lvs = JSON.stringify({
      report: [{ lv: [{ lv_name: 'ahr0-vol', vg_name: 'ahr0', lv_attr: '-wi-----p-', lv_size: '<2.49g' }] }],
      log: [],
    })
    const pools = await readAhrPools(healthyExecutor({ lvs }))
    assert.equal(pools[0].state, 'offline')
    const warnings = buildAhrWarnings(pools)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].level, 'critical')
    assert.equal(warnings[0].category, 'ahr')
    assert.equal(warnings[0].ref, 'ahr0')
    assert.ok(warnings[0].message.includes('is OFFLINE'))
    assert.ok(warnings[0].message.includes(`the logical volume 'ahr0-vol' is not active`), warnings[0].message)
    assert.ok(warnings[0].message.includes('its data is unavailable'), warnings[0].message)
    assert.ok(warnings[0].message.includes('see the Hybrid RAID view'))
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
    // A healthy pool that carries advisories still adds nothing — only the bad
    // states card (spare-consumed/snapshot advisories stay view-level).
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

describe('buildAhrPoolBriefs (story 11.13, AHR-DESIGN §10 revision)', () => {
  /**
   * Attach a hot-spare disk (§11 shape) to a base pool: a role:'spare' disk plus
   *  a memberState:'spare' member row on every band array.
   */
  function withSpare(base: AhrPool): AhrPool {
    const spare: AhrDisk = {
      id: HOT4,
      sizeBytes: 2147483648,
      usableBytes: 2147483648,
      model: 'QEMU HARDDISK',
      serial: 'ANAS_HOT4',
      role: 'spare',
      partitions: [],
    }
    return {
      ...base,
      disks: [...base.disks, spare],
      arrays: base.arrays.map(a => ({
        ...a,
        members: [
          ...a.members,
          { disk: HOT4, partition: `/dev/disk/by-id/${HOT4}-part${a.band}`, memberState: 'spare' as const },
        ],
      })),
    }
  }

  // 11.19 — the three fields are a PURE PROJECTION of the AhrArray the brief is
  // built from: already read, previously dropped. No extra system read.
  it('projects each band\'s height, state and sync from the array it derives from', async () => {
    const pool = await healthyPool()
    const b = buildAhrPoolBriefs([pool])[0]

    for (let i = 0; i < b.bands.length; i++) {
      const array = pool.arrays[i]
      assert.equal(b.bands[i].band, array.band)
      // The SLICE size — what a member contributes to this band — not the
      // member's whole disk size, which the tiles used to show against it.
      assert.equal(b.bands[i].heightBytes, array.heightBytes)
      assert.ok(b.bands[i].heightBytes! > 0)
      assert.notEqual(b.bands[i].heightBytes, b.bands[i].members[0].sizeBytes)
      assert.equal(b.bands[i].state, array.state)
    }
    // An idle pool has no sync to report — the field is ABSENT, never a zeroed
    // placeholder the UI would render as a stalled 0% strip.
    assert.ok(b.bands.every(band => band.sync === undefined))
  })

  it('carries a running sync, and marks a QUEUED band by its absence (issue #9)', async () => {
    const pool = await healthyPool()
    // Band 1 is rebuilding with live progress; band 2 is queued behind it —
    // state 'recovering' with NO sync, which is exactly what the dashboard
    // reads to say "queued behind another band".
    const withSync = {
      ...pool,
      arrays: [
        { ...pool.arrays[0], state: 'recovering' as const, sync: { action: 'recover' as const, percent: 1.8, speedBytesSec: 206465024, etaSeconds: 38016 } },
        { ...pool.arrays[1], state: 'recovering' as const },
      ],
    }
    const b = buildAhrPoolBriefs([withSync])[0]

    assert.equal(b.bands[0].state, 'recovering')
    assert.deepEqual(b.bands[0].sync, { action: 'recover', percent: 1.8, speedBytesSec: 206465024, etaSeconds: 38016 })
    assert.equal(b.bands[1].state, 'recovering')
    assert.equal(b.bands[1].sync, undefined, 'a queued band has no progress to report')
  })

  it('derives the healthy pool: bands (level × members) + capacity + mount, no spare', async () => {
    const pool = await healthyPool()
    const briefs = buildAhrPoolBriefs([pool])
    assert.equal(briefs.length, 1)
    const b = briefs[0]

    assert.equal(b.name, 'ahr0')
    assert.equal(b.state, 'healthy')
    assert.equal(b.mounted, true)
    assert.equal(b.mountpoint, '/mnt/anas-ahr/ahr0')
    assert.equal(b.subvolLayout, pool.subvolLayout)
    // usable from the LV; used from btrfs (mounted → present, not a wrong number).
    assert.equal(b.usableBytes, pool.capacity.usableBytes)
    assert.ok(b.usableBytes > 0)
    assert.equal(b.usedBytes, pool.capacity.usedBytes)
    assert.notEqual(b.usedBytes, undefined)

    // Two bands: r1 raid5×3, r2 raid1×2 — ascending, redundant members only.
    assert.equal(b.bands.length, 2)
    assert.equal(b.bands[0].band, 1)
    assert.equal(b.bands[0].level, 'raid5')
    assert.equal(b.bands[0].memberCount, 3)
    assert.equal(b.bands[0].members.length, 3)
    // Full member ids (never truncated) + their raw disk sizes for the tiles.
    assert.deepEqual(b.bands[0].members.map(m => m.id).sort(), [HOT1, HOT2, HOT3])
    for (const m of b.bands[0].members)
      assert.ok(m.sizeBytes > 0, `${m.id} carries a disk size`)
    assert.equal(b.bands[1].level, 'raid1')
    assert.equal(b.bands[1].memberCount, 2)

    // No spare attached in the stage-0 fixture.
    assert.deepEqual(b.spares, [])
  })

  it('reports a hot spare at pool level and excludes it from band member counts', async () => {
    const briefs = buildAhrPoolBriefs([withSpare(await healthyPool())])
    const b = briefs[0]
    // The spare is NOT a band member — "RAID5 × 3" stays three, not four.
    assert.equal(b.bands[0].memberCount, 3)
    assert.ok(!b.bands[0].members.some(m => m.id === HOT4), 'spare not a band member')
    assert.equal(b.bands[1].memberCount, 2)
    // It is reported once, at pool level, with its raw size (labeled spare bay).
    assert.deepEqual(b.spares, [{ id: HOT4, sizeBytes: 2147483648 }])
  })

  it('OMITS usedBytes for an unmounted pool (never a wrong number)', async () => {
    const base = await healthyPool()
    const unmounted: AhrPool = { ...base, mounted: false }
    const b = buildAhrPoolBriefs([unmounted])[0]
    assert.equal(b.mounted, false)
    assert.equal(b.usedBytes, undefined)
    // Usable still reports — it comes from the LV, not the (absent) btrfs read.
    assert.ok(b.usableBytes > 0)
  })
})

describe('buildAhrCapacityWarnings (parity with ZFS capacity cards)', () => {
  /** A minimal capacity-carrying brief; usedBytes omitted when `used` is null. */
  function brief(usableBytes: number, used: number | null): AhrPoolBrief {
    return {
      name: 'tank',
      state: 'healthy',
      usableBytes,
      ...(used === null ? {} : { usedBytes: used }),
      mountpoint: '/mnt/tank',
      mounted: used !== null,
      subvolLayout: false,
      bands: [],
      spares: [],
    }
  }

  it('≥95% full → one critical capacity card, wording mirrors ZFS', () => {
    const warnings = buildAhrCapacityWarnings([brief(100, 96)])
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].level, 'critical')
    assert.equal(warnings[0].category, 'capacity')
    assert.equal(warnings[0].ref, 'tank')
    assert.equal(warnings[0].message, `AHR pool 'tank' is 96% full`)
  })

  it('at the 95% threshold → critical', () => {
    const warnings = buildAhrCapacityWarnings([brief(100, 95)])
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].level, 'critical')
    assert.equal(warnings[0].message, `AHR pool 'tank' is 95% full`)
  })

  it('≥90% (but <95%) full → one warning capacity card', () => {
    const warnings = buildAhrCapacityWarnings([brief(100, 94)])
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].level, 'warning')
    assert.equal(warnings[0].category, 'capacity')
    assert.equal(warnings[0].message, `AHR pool 'tank' is 94% full`)
  })

  it('at the 90% threshold → warning', () => {
    const warnings = buildAhrCapacityWarnings([brief(100, 90)])
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].level, 'warning')
    assert.equal(warnings[0].message, `AHR pool 'tank' is 90% full`)
  })

  it('below the 90% threshold → NO card', () => {
    assert.deepEqual(buildAhrCapacityWarnings([brief(100, 89)]), [])
  })

  it('an unmounted pool (no usedBytes) → NO card, never a wrong number', () => {
    assert.deepEqual(buildAhrCapacityWarnings([brief(100, null)]), [])
  })

  it('zero usable capacity → NO card (no division by zero)', () => {
    assert.deepEqual(buildAhrCapacityWarnings([brief(0, 0)]), [])
  })

  it('end to end: the healthy fixture pool is not near-full → no capacity card', async () => {
    assert.deepEqual(buildAhrCapacityWarnings(buildAhrPoolBriefs([await healthyPool()])), [])
  })
})

describe('collectAhrPoolBriefs (fail-open source for GET /v1/status)', () => {
  it('an AHR read error degrades the source to [] (never a throw)', async () => {
    const throwing: CommandExecutor = {
      exec: async () => {
        throw new Error('boom')
      },
      pipeline: async () => {
        throw new Error('boom')
      },
    }
    assert.deepEqual(await collectAhrPoolBriefs(throwing), [])
  })

  it('reports [] when there are no AHR pools', async () => {
    // An executor with no mdstat match → readAhrPools bails early → no pools.
    assert.deepEqual(await collectAhrPoolBriefs(new MockExecutor()), [])
  })

  it('derives briefs from the live healthy pool end to end', async () => {
    const briefs = await collectAhrPoolBriefs(healthyExecutor())
    assert.equal(briefs.length, 1)
    assert.equal(briefs[0].name, 'ahr0')
    assert.equal(briefs[0].state, 'healthy')
    assert.equal(briefs[0].bands.length, 2)
  })
})
