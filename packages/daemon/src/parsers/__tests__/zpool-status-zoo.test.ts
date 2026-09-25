import type { VdevRole } from '@anas/shared'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseZpoolIostat } from '../zpool-iostat.js'
import { parseZpoolStatus } from '../zpool-status.js'

/**
 * The topology zoo (topology.1, 0.3.5 post-mortem ruling (b)).
 *
 * ONE test suite over EVERY `zpool-status-*.json` in `fixtures/zfs/` and every
 * `zpool-iostat-*.txt` in `fixtures/telemetry/` — the fixtures/zfs/NOTES.md zoo
 * table is the provenance half of the same contract. Two layers:
 *
 *   - INVARIANTS every fixture must hold (roles from the known set in the fixed
 *     order, non-empty identities, every vdev carrying its leaves) — a parser
 *     change that drops a section or shifts the output shape fails here, BY
 *     FIXTURE NAME, whatever fixture pins it;
 *   - a per-fixture EXPECTED table (roles with vdev/leaf counts, scan record,
 *     health block, error counts) — the facts each capture PINS, read off the
 *     capture itself, so a regression cannot quietly pass another fixture's
 *     shape.
 *
 * A fixture file without a table entry is itself a failure: the zoo table in
 * NOTES.md and this test are updated together, so no capture lands undocumented.
 * New shapes arrive as real captures (test/stunt-node/topology-zoo.sh capture)
 * — never as hand-built files (the ground-truth-first ruling).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATUS_DIR = join(__dirname, '../../fixtures/zfs')
const IOSTAT_DIR = join(__dirname, '../../fixtures/telemetry')

/** The VdevRole order the parser promises (data first, then the sections). */
const ROLE_ORDER: readonly VdevRole[] = ['data', 'log', 'cache', 'spare', 'special', 'dedup']

/** [role, vdevCount, leafCount] — leaf = disks summed over the group's vdevs. */
type RoleFacts = readonly [VdevRole, number, number]

interface PoolExpected {
  name: string
  state: string
  roles: readonly RoleFacts[]
  /** `FUNCTION/STATE` of the single scan record, or undefined for none. */
  scan?: string
  health?: boolean
  errorCount?: number
  errorDetail?: boolean
}

const STATUS_ZOO: Record<string, readonly PoolExpected[]> = {
  'zpool-status-all-vdev-classes-2.4.4.json': [{
    name: 'gt66',
    state: 'ONLINE',
    errorCount: 0,
    roles: [['data', 1, 1], ['log', 1, 1], ['cache', 1, 1], ['spare', 1, 1], ['special', 1, 1], ['dedup', 1, 1]],
  }],
  'zpool-status-degraded.json': [{
    name: 'testpool',
    state: 'DEGRADED',
    errorCount: 0,
    health: true,
    roles: [['data', 1, 2]],
  }],
  'zpool-status-degraded-offline.json': [{
    name: 'testpool',
    state: 'DEGRADED',
    errorCount: 0,
    health: true,
    scan: 'RESILVER/FINISHED',
    roles: [['data', 1, 2]],
  }],
  'zpool-status-degraded-removed.json': [{
    name: 'testpool',
    state: 'DEGRADED',
    errorCount: 0,
    health: true,
    scan: 'RESILVER/FINISHED',
    roles: [['data', 1, 2]],
  }],
  'zpool-status-mirrored-log-partitions-2.4.4.json': [{
    name: 'gtbackup',
    state: 'ONLINE',
    errorCount: 0,
    roles: [['data', 1, 0], ['log', 1, 2], ['cache', 1, 1]],
  }],
  'zpool-status-multi-cache-spare-2.4.4.json': [{
    name: 'gtvdev',
    state: 'ONLINE',
    errorCount: 0,
    roles: [['data', 1, 1], ['log', 1, 1], ['cache', 1, 2], ['spare', 1, 2]],
  }],
  'zpool-status-online.json': [{
    name: 'testpool',
    state: 'ONLINE',
    errorCount: 0,
    scan: 'SCRUB/FINISHED',
    roles: [['data', 2, 4], ['spare', 1, 1]],
  }],
  'zpool-status-online-fresh.json': [{
    name: 'testpool',
    state: 'ONLINE',
    errorCount: 0,
    roles: [['data', 1, 2]],
  }],
  'zpool-status-raidz.json': [{
    name: 'testpool-rz',
    state: 'ONLINE',
    errorCount: 0,
    roles: [['data', 1, 3]],
  }],
  'zpool-status-raidz-degraded.json': [{
    name: 'testpool-rz',
    state: 'DEGRADED',
    errorCount: 0,
    health: true,
    scan: 'SCRUB/FINISHED',
    roles: [['data', 1, 3]],
  }],
  'zpool-status-resilvering.json': [{
    name: 'testpool',
    state: 'ONLINE',
    errorCount: 0,
    scan: 'RESILVER/FINISHED',
    roles: [['data', 1, 2]],
  }],
  'zpool-status-scrub-verdicts.json': [
    {
      name: 'repairpool',
      state: 'ONLINE',
      errorCount: 2,
      scan: 'SCRUB/FINISHED',
      roles: [['data', 1, 2]],
    },
    {
      name: 'cancelpool',
      state: 'ONLINE',
      errorCount: 0,
      scan: 'SCRUB/CANCELED',
      roles: [['data', 1, 1]],
    },
  ],
  'zpool-status-scrubbing.json': [{
    name: 'testpool-rz',
    state: 'ONLINE',
    errorCount: 0,
    scan: 'SCRUB/SCANNING',
    roles: [['data', 1, 3]],
  }],
  'zpool-status-spare-active.json': [{
    name: 'testpool',
    state: 'DEGRADED',
    errorCount: 0,
    health: true,
    scan: 'RESILVER/FINISHED',
    roles: [['data', 1, 3], ['spare', 1, 1]],
  }],
  'zpool-status-suspended.json': [{
    name: 'testpool',
    state: 'SUSPENDED',
    errorCount: 4,
    health: true,
    scan: 'RESILVER/FINISHED',
    roles: [['data', 1, 2]],
  }],
  'zpool-status-suspended-verbose.json': [{
    name: 'testpool',
    state: 'SUSPENDED',
    errorCount: 4,
    health: true,
    errorDetail: true,
    scan: 'RESILVER/FINISHED',
    roles: [['data', 1, 2]],
  }],
  'zpool-status-with-spare.json': [{
    name: 'testpool',
    state: 'ONLINE',
    errorCount: 0,
    roles: [['data', 1, 2], ['spare', 1, 1]],
  }],
}

describe('zpool-status zoo — every fixture, one stable shape', () => {
  const files = readdirSync(STATUS_DIR).filter(f => /^zpool-status-.*\.json$/.test(f)).sort()

  it('every zoo file has an EXPECTED entry (and vice versa)', () => {
    assert.ok(files.length > 0, 'the zoo is empty — no captures?')
    const tabled = Object.keys(STATUS_ZOO).sort()
    assert.deepEqual(files, tabled, 'fixtures/zfs and the zoo test table drifted — a capture landed without its row (NOTES.md) or its facts')
  })

  for (const file of files) {
    const expected = STATUS_ZOO[file]
    if (!expected)
      continue // named by the drift test above

    describe(file, () => {
      const text = readFileSync(join(STATUS_DIR, file), 'utf-8')

      it('parses without throwing, into the pools the table names', () => {
        const pools = parseZpoolStatus(text) // throws → the failure names this file
        assert.deepEqual(pools.map(p => p.name), expected.map(p => p.name))
      })

      for (const [i, exp] of expected.entries()) {
        const pools = parseZpoolStatus(text)
        const pool = pools[i]

        it(`${exp.name}: state, error count, health${exp.errorDetail ? ' + error detail' : ''}`, () => {
          assert.equal(pool.state, exp.state)
          assert.equal(pool.errorCount, exp.errorCount ?? 0)
          // CROSS-FIXTURE FACT the zoo exposes: the older fixtures carry the
          // pool_guid QUOTED (a string), the 2.4.4 captures UNQUOTED (a JSON
          // number — libzfs emits a uint64 and only the pretty-printed older
          // files wrapped it in quotes). The parser passes it through verbatim,
          // so `guid` is number-typed on exactly the real 2.4.4 captures. Pinned
          // as presence, never as type.
          assert.ok(pool.guid != null && String(pool.guid).length > 0, 'no pool guid')
          assert.equal(!!pool.health, exp.health ?? false)
          assert.equal(!!pool.errorDetail, exp.errorDetail ?? false)
        })

        it(`${exp.name}: vdevGroups roles in the fixed order, vdev/leaf counts as pinned`, () => {
          const roles = pool.vdevGroups.map(g => g.role)
          // Every role is from the known set, and the sequence is a subsequence
          // of the fixed ROLE_ORDER — same relative order, none out of place,
          // none repeated.
          let lastIdx = -1
          for (const role of roles) {
            const idx = ROLE_ORDER.indexOf(role)
            assert.ok(idx !== -1, `unknown role ${role}`)
            assert.ok(idx > lastIdx, `role ${role} out of the fixed order (${ROLE_ORDER.join(' < ')})`)
            lastIdx = idx
          }
          assert.deepEqual(
            pool.vdevGroups.map(g => [g.role, g.vdevs.length, g.vdevs.reduce((n, v) => n + v.disks.length, 0)] as RoleFacts),
            exp.roles,
          )
        })

        it(`${exp.name}: every vdev named/typed/stated, every leaf identified${exp.roles.some(r => r[2] === 0) ? ' (zero-leaf vdevs are exactly the ones the table pins)' : ''}`, () => {
          for (const group of pool.vdevGroups) {
            for (const vdev of group.vdevs) {
              assert.ok(vdev.name.length > 0, `${group.role}: unnamed vdev`)
              assert.ok(vdev.type.length > 0, `${group.role}/${vdev.name}: untyped`)
              assert.ok(vdev.state.length > 0, `${group.role}/${vdev.name}: no state`)
              if (vdev.disks.length === 0) {
                // A vdev without leaves is the pinned exception (the in-tree
                // file vdev) and nothing else.
                const pinned = exp.roles.find(([role]) => role === group.role)
                assert.ok(pinned && pinned[2] === 0, `${group.role}/${vdev.name}: zero leaves is not a shape this fixture pins`)
                continue
              }
              for (const disk of vdev.disks) {
                assert.ok(disk.id.length > 0, `${group.role}/${vdev.name}: leaf without an id`)
                assert.ok(disk.path.length > 0, `${group.role}/${vdev.name}/${disk.id}: leaf without a path`)
                assert.ok(disk.state.length > 0, `${group.role}/${vdev.name}/${disk.id}: leaf without a state`)
              }
            }
          }
        })

        it(`${exp.name}: scan record ${exp.scan ?? 'absent'}`, () => {
          if (!exp.scan) {
            assert.equal(pool.scan, null)
            return
          }
          const [fn, state] = exp.scan.split('/')
          assert.ok(pool.scan)
          assert.equal(pool.scan.function, fn)
          assert.equal(pool.scan.state, state)
        })
      }
    })
  }
})

/**
 * The iostat half. `knownPools` is the pools the command was ASKED about — the
 * captures are of named pools, so the table carries them; the parser needs
 * them only as the secondary header check.
 */
interface IostatExpected {
  /** The pools, for `knownPools`. */
  pools: readonly string[]
  samples: number
  /** [pool, depth1Rows, depth2Rows] per sample — identical across samples. */
  shape: readonly [string, number, number][]
  /** The capture prints all-dash vdev-class section headers (the 2.4.4 pair). */
  hasSectionHeaders?: boolean
}

const IOSTAT_ZOO: Record<string, IostatExpected> = {
  'zpool-iostat-plv.txt': {
    pools: ['testpool'],
    samples: 2,
    shape: [['testpool', 3, 6]],
  },
  'zpool-iostat-plv-all-vdev-classes-2.4.4.txt': {
    pools: ['gtvdev'],
    samples: 2,
    // The class sections' leaves print at the VDEV indent (depth 1) and the
    // spare prints no row at all — five rows, no depth-2 leaves.
    shape: [['gtvdev', 5, 0]],
    hasSectionHeaders: true,
  },
  'zpool-iostat-plv-multi-cache-spare-2.4.4.txt': {
    pools: ['gtvdev'],
    samples: 2,
    // One data leaf + one log + two cache leaves; the spares print no row at
    // all, exactly as in the all-classes capture.
    shape: [['gtvdev', 4, 0]],
    hasSectionHeaders: true,
  },
}

describe('zpool-iostat zoo — every pair, one stable shape', () => {
  const files = readdirSync(IOSTAT_DIR).filter(f => /^zpool-iostat-.*\.txt$/.test(f)).sort()

  it('every iostat fixture has an EXPECTED entry (and vice versa)', () => {
    assert.ok(files.length > 0, 'the iostat zoo is empty')
    assert.deepEqual(files, Object.keys(IOSTAT_ZOO).sort(), 'fixtures/telemetry and the zoo test table drifted')
  })

  for (const file of files) {
    const exp = IOSTAT_ZOO[file]
    if (!exp)
      continue

    describe(file, () => {
      const text = readFileSync(join(IOSTAT_DIR, file), 'utf-8')
      const samples = parseZpoolIostat(text, new Set(exp.pools))

      it('splits into the two samples (since-boot + interval)', () => {
        assert.equal(samples.length, exp.samples)
      })

      it('every row is positioned in the pool → vdev → leaf tree', () => {
        for (const sample of samples) {
          assert.ok(sample.length > 0, 'empty sample')
          for (const node of sample) {
            assert.ok(node.name.length > 0)
            assert.ok(node.depth >= 0 && node.depth <= 2, `${node.name}: depth ${node.depth}`)
            assert.ok(node.pool.length > 0, `${node.name}: no pool`)
            if (node.depth === 2)
              assert.ok(node.vdev, `${node.name}: a leaf must name its vdev`)
            else
              assert.equal(node.vdev, undefined, `${node.name}: depth-${node.depth} rows have no parent vdev`)
            for (const rate of [node.ops.read, node.ops.write, node.bandwidth.read, node.bandwidth.write]) {
              assert.ok(Number.isInteger(rate) && rate >= 0, `${node.name}: bad rate ${rate}`)
            }
            for (const latency of [node.totalWait.read, node.totalWait.write]) {
              assert.ok(latency === null || (Number.isInteger(latency) && latency >= 0), `${node.name}: bad latency ${latency}`)
            }
          }
        }
      })

      it('the pools and row counts are exactly as captured', () => {
        for (const sample of samples) {
          const depth0 = sample.filter(n => n.depth === 0).map(n => n.name)
          assert.deepEqual(depth0, exp.shape.map(([pool]) => pool))
          for (const [pool, d1, d2] of exp.shape) {
            const rows = sample.filter(n => n.pool === pool)
            assert.equal(rows.filter(n => n.depth === 1).length, d1, `${pool}: vdev rows`)
            assert.equal(rows.filter(n => n.depth === 2).length, d2, `${pool}: leaf rows`)
          }
        }
      })

      it('no section-header name survives as a row — all-dash rows named logs/cache/special/dedup/spares are dropped', () => {
        // The all-dash header rule: an unindented row that carries no statistics
        // AND is named like one of the five sections is a header, not a pool.
        for (const sample of samples) {
          for (const name of ['logs', 'cache', 'special', 'dedup', 'spares'])
            assert.equal(sample.find(n => n.name === name), undefined, `${name}: a section header leaked into the tree`)
        }
        // In the captures that carry the headers, the pool itself kept the
        // statistics that shape would have swallowed — the since-boot sample
        // always prints real numbers (the interval sample may honestly be idle).
        if (!exp.hasSectionHeaders)
          return
        const pool = samples[0].find(n => n.depth === 0)!
        assert.ok(
          pool.bandwidth.read > 0 || pool.bandwidth.write > 0 || pool.ops.read > 0 || pool.ops.write > 0,
          `${pool.name}: pool row lost its statistics`,
        )
      })
    })
  }
})
