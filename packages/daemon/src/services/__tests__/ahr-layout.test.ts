import type { AhrType } from '@anas/shared'
import type { AhrLayoutDisk, ExistingBand } from '../ahr-layout.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AhrExpansionStep, AhrLayoutPreview } from '@anas/shared'
import {
  AHR_MIN_DISKS,
  AHR_SIZE_GRANULARITY_BYTES,
  AhrPlanError,
  floorToGranularity,
  planExpansion,
  planFreshLayout,
} from '../ahr-layout.js'

const GiB = AHR_SIZE_GRANULARITY_BYTES
const TiB = 1024 * GiB

/** A disk of `tib` whole TiB (granularity-aligned, so rounding is a no-op). */
function disk(id: string, tib: number): AhrLayoutDisk {
  return { id, usableBytes: tib * TiB }
}

/** Independent §2.1 usable-capacity recompute: Σ h×(m−parity) over used bands. */
function expectedUsableBytes(sizesTiB: number[], tier: AhrType): number {
  const sizes = [...sizesTiB]
  sizes.sort((a, b) => a - b)
  const minMembers = tier === 'ahr1' ? 2 : 4
  const parity = tier === 'ahr1' ? 1 : 2
  let usable = 0
  let prev = 0
  for (const boundary of [...new Set(sizes)]) {
    const m = sizes.filter(s => s >= boundary).length
    if (m >= minMembers)
      usable += (boundary - prev) * (m - parity)
    prev = boundary
  }
  return usable * TiB
}

/** Assert the exact capacity identity: raw = usable + overhead + wasted + pending. */
function assertCapacityIdentity(preview: AhrLayoutPreview): void {
  const c = preview.capacity
  assert.equal(
    c.usableBytes + c.redundancyOverheadBytes + c.unprotectedWastedBytes + c.pendingBytes,
    c.rawBytes,
    'capacity identity must hold exactly',
  )
  assert.ok(c.usableBytes <= c.rawBytes, 'usable never exceeds raw')
}

/** The existing 2+3+4 TiB AHR-1 pool of §2.2/§2.3 (arrays r1, r2; [3–4] has none). */
function existing234(): ExistingBand[] {
  return [
    { band: 1, startBytes: 0, endBytes: 2 * TiB, level: 'raid5', members: ['d2', 'd3', 'd4'] },
    { band: 2, startBytes: 2 * TiB, endBytes: 3 * TiB, level: 'raid1', members: ['d3', 'd4'] },
  ]
}

describe('AHR layout (Epic 11 + AHR — docs/AHR-DESIGN.md §2)', () => {
  // --- §2.5 rounding --------------------------------------------------------
  describe('replacement-slack rounding (§2.5)', () => {
    it('floors to the granularity constant', () => {
      assert.equal(floorToGranularity(4 * TiB + 500_000_000), 4 * TiB)
      assert.equal(floorToGranularity(GiB - 1), 0)
      assert.equal(floorToGranularity(GiB), GiB)
      assert.equal(floorToGranularity(0), 0)
      assert.equal(floorToGranularity(-5), 0)
    })

    it('nominally-same disks with tens-of-MB variance land on one boundary', () => {
      const preview = planFreshLayout([
        { id: 'a', usableBytes: 4 * TiB + 700 * 1024 ** 2 },
        { id: 'b', usableBytes: 4 * TiB + 13 * 1024 ** 2 },
      ], 'ahr1')
      assert.equal(preview.bands.length, 1)
      assert.equal(preview.bands[0]!.level, 'raid1')
      assert.equal(preview.bands[0]!.range.endBytes, 4 * TiB)
      assert.equal(preview.capacity.usableBytes, 4 * TiB)
    })
  })

  // --- §2.1 fresh-create banding (the §2.2 worked examples) -----------------
  describe('fresh-create banding (§2.1, worked examples §2.2)', () => {
    it('2+3+4 TiB AHR-1 → RAID5×3 + RAID1×2 + wasted = 5 TiB', () => {
      const preview = planFreshLayout([disk('d2', 2), disk('d3', 3), disk('d4', 4)], 'ahr1')
      AhrLayoutPreview.parse(preview)

      assert.equal(preview.bands.length, 3)
      assert.deepEqual(preview.bands[0], {
        band: 1,
        range: { startBytes: 0, endBytes: 2 * TiB },
        memberCount: 3,
        level: 'raid5',
        heightBytes: 2 * TiB,
        usableBytes: 4 * TiB,
        protected: true,
      })
      assert.deepEqual(preview.bands[1], {
        band: 2,
        range: { startBytes: 2 * TiB, endBytes: 3 * TiB },
        memberCount: 2,
        level: 'raid1',
        heightBytes: 1 * TiB,
        usableBytes: 1 * TiB,
        protected: true,
      })
      assert.deepEqual(preview.bands[2], {
        band: 3,
        range: { startBytes: 3 * TiB, endBytes: 4 * TiB },
        memberCount: 1,
        level: null,
        heightBytes: 1 * TiB,
        usableBytes: 0,
        protected: false,
      })

      assert.equal(preview.capacity.rawBytes, 9 * TiB)
      assert.equal(preview.capacity.usableBytes, 5 * TiB)
      assert.equal(preview.capacity.redundancyOverheadBytes, 3 * TiB)
      assert.equal(preview.capacity.unprotectedWastedBytes, 1 * TiB)
      assert.equal(preview.capacity.pendingBytes, 0)
      assert.equal(preview.minDisksMet, true)
      assertCapacityIdentity(preview)
    })

    it('1+2+3+4 TiB AHR-1 → 3+2+1+0 = 6 TiB across four bands', () => {
      const preview = planFreshLayout(
        [disk('d1', 1), disk('d2', 2), disk('d3', 3), disk('d4', 4)],
        'ahr1',
      )
      assert.deepEqual(
        preview.bands.map(b => [b.band, b.memberCount, b.level, b.usableBytes / TiB, b.protected]),
        [
          [1, 4, 'raid5', 3, true],
          [2, 3, 'raid5', 2, true],
          [3, 2, 'raid1', 1, true],
          [4, 1, null, 0, false],
        ],
      )
      assert.equal(preview.capacity.usableBytes, 6 * TiB)
      assert.equal(preview.capacity.rawBytes, 10 * TiB)
      assert.equal(preview.capacity.unprotectedWastedBytes, 1 * TiB)
      assertCapacityIdentity(preview)
    })

    it('4+4 TiB AHR-1 → one RAID1 band = 4 TiB, nothing wasted', () => {
      const preview = planFreshLayout([disk('a', 4), disk('b', 4)], 'ahr1')
      assert.equal(preview.bands.length, 1)
      assert.deepEqual(preview.bands[0], {
        band: 1,
        range: { startBytes: 0, endBytes: 4 * TiB },
        memberCount: 2,
        level: 'raid1',
        heightBytes: 4 * TiB,
        usableBytes: 4 * TiB,
        protected: true,
      })
      assert.equal(preview.capacity.usableBytes, 4 * TiB)
      assert.equal(preview.capacity.unprotectedWastedBytes, 0)
      assert.deepEqual(preview.warnings, [])
      assertCapacityIdentity(preview)
    })

    it('4×4 TiB AHR-2 → one RAID6 band = 8 TiB', () => {
      const preview = planFreshLayout(
        [disk('a', 4), disk('b', 4), disk('c', 4), disk('d', 4)],
        'ahr2',
      )
      assert.equal(preview.bands.length, 1)
      assert.deepEqual(preview.bands[0], {
        band: 1,
        range: { startBytes: 0, endBytes: 4 * TiB },
        memberCount: 4,
        level: 'raid6',
        heightBytes: 4 * TiB,
        usableBytes: 8 * TiB,
        protected: true,
      })
      assert.equal(preview.capacity.usableBytes, 8 * TiB)
      assert.equal(preview.capacity.redundancyOverheadBytes, 8 * TiB)
      assert.equal(preview.minDisksMet, true)
      assertCapacityIdentity(preview)
    })

    it('AHR-1 with a unique largest disk always has a labeled wasted top slice (§2.4)', () => {
      const preview = planFreshLayout([disk('a', 2), disk('b', 2), disk('c', 6)], 'ahr1')
      const top = preview.bands.at(-1)!
      assert.equal(top.protected, false)
      assert.equal(top.level, null)
      assert.equal(top.memberCount, 1)
      assert.equal(preview.capacity.unprotectedWastedBytes, 4 * TiB)
      assert.ok(
        preview.warnings.some(w => w.includes('unprotected capacity') && w.includes('≥6 TiB')),
        `warnings must label the wasted slice and its unlock size, got: ${JSON.stringify(preview.warnings)}`,
      )
      assertCapacityIdentity(preview)
    })

    it('AHR-2 below 4 disks → minDisksMet false, everything unprotected', () => {
      const preview = planFreshLayout([disk('a', 4), disk('b', 4), disk('c', 4)], 'ahr2')
      assert.equal(preview.minDisksMet, false)
      assert.equal(preview.capacity.usableBytes, 0)
      assert.equal(preview.capacity.unprotectedWastedBytes, 12 * TiB)
      assert.ok(preview.bands.every(b => !b.protected))
      assert.ok(preview.warnings.some(w => w.includes('at least 4 disks')))
      assertCapacityIdentity(preview)
    })
  })

  // --- §2.3 incremental expansion planner -----------------------------------
  describe('incremental expansion planner (§2.3)', () => {
    it('canonical case: replace the 2 TiB with a 4 TiB → keep r1, convert r2, create r3, capacity 7', () => {
      const plan = planExpansion({
        poolName: 'tank',
        tier: 'ahr1',
        existingBands: existing234(),
        approvedDisks: [disk('d3', 3), disk('d4', 4), disk('dnew', 4)],
        replaced: { oldDiskId: 'd2', newDiskId: 'dnew' },
      })
      AhrLayoutPreview.parse(plan.preview)
      plan.steps.forEach(s => AhrExpansionStep.parse(s))

      // The full ordered pipeline: partitions → md (+wait) → single pv/vg/lv/fs tail.
      assert.deepEqual(
        plan.steps.map(s => [s.kind, s.target]),
        [
          ['partition', 'd4'], // gains the new r3 slice
          ['partition', 'dnew'], // full slice set (r1, r2, r3)
          ['array-convert', 'md/tank-r2'],
          ['reshape-wait', 'md/tank-r2'],
          ['array-create', 'md/tank-r3'],
          ['reshape-wait', 'md/tank-r3'],
          ['pv-resize', 'md/tank-r2'],
          ['pv-create', 'md/tank-r3'],
          ['vg-extend', 'tank'],
          ['lv-extend', 'tank-vol'],
          ['fs-grow', 'tank-vol'],
        ],
      )
      assert.deepEqual(plan.steps.map(s => s.index), plan.steps.map((_, i) => i))
      assert.ok(plan.steps.every(s => s.status === 'pending'))
      assert.equal(plan.steps.find(s => s.kind === 'array-convert')!.detail, 'raid1×2 → raid5×3')

      // No step touches r1 — kept, not rebuilt (membership swap is --replace's job).
      assert.ok(!plan.steps.some(s => s.target === 'md/tank-r1'))

      // Resulting reachable layout: [0–2] r5×3, [2–3] r5×3, [3–4] r1×2 → 7 TiB.
      assert.deepEqual(
        plan.preview.bands.map(b => [b.band, b.memberCount, b.level, b.usableBytes / TiB, b.protected]),
        [
          [1, 3, 'raid5', 4, true],
          [2, 3, 'raid5', 2, true],
          [3, 2, 'raid1', 1, true],
        ],
      )
      assert.equal(plan.preview.capacity.usableBytes, 7 * TiB)
      assert.equal(plan.preview.capacity.rawBytes, 11 * TiB)
      assert.equal(plan.preview.capacity.pendingBytes, 0)
      assert.equal(plan.preview.capacity.unprotectedWastedBytes, 0)
      assertCapacityIdentity(plan.preview)
    })

    it('add-one-disk: 2+3+4 + 4 → grow r1 3→4, convert r2, create r3', () => {
      const plan = planExpansion({
        poolName: 'tank',
        tier: 'ahr1',
        existingBands: existing234(),
        approvedDisks: [disk('d2', 2), disk('d3', 3), disk('d4', 4), disk('dnew', 4)],
      })
      assert.deepEqual(
        plan.steps.map(s => [s.kind, s.target]),
        [
          ['partition', 'd4'],
          ['partition', 'dnew'],
          ['array-grow', 'md/tank-r1'],
          ['reshape-wait', 'md/tank-r1'],
          ['array-convert', 'md/tank-r2'],
          ['reshape-wait', 'md/tank-r2'],
          ['array-create', 'md/tank-r3'],
          ['reshape-wait', 'md/tank-r3'],
          ['pv-resize', 'md/tank-r1'],
          ['pv-resize', 'md/tank-r2'],
          ['pv-create', 'md/tank-r3'],
          ['vg-extend', 'tank'],
          ['lv-extend', 'tank-vol'],
          ['fs-grow', 'tank-vol'],
        ],
      )
      assert.equal(plan.steps.find(s => s.kind === 'array-grow')!.detail, 'raid5×3 → raid5×4')
      assert.deepEqual(
        plan.preview.bands.map(b => [b.band, b.memberCount, b.level, b.usableBytes / TiB]),
        [
          [1, 4, 'raid5', 6],
          [2, 3, 'raid5', 2],
          [3, 2, 'raid1', 1],
        ],
      )
      assert.equal(plan.preview.capacity.usableBytes, 9 * TiB)
      assertCapacityIdentity(plan.preview)
    })

    it('pending capacity (§5.2): replace one 4 with an 8 in a 4+4 pool → zero new usable, pendingBytes > 0', () => {
      const plan = planExpansion({
        poolName: 'tank',
        tier: 'ahr1',
        existingBands: [
          { band: 1, startBytes: 0, endBytes: 4 * TiB, level: 'raid1', members: ['a', 'b'] },
        ],
        approvedDisks: [disk('a', 4), disk('c', 8)],
        replaced: { oldDiskId: 'b', newDiskId: 'c' },
      })
      // Only the replacement disk's r1 slice is partitioned — the locked [4–8]
      // region gets no partition, no array, and no lv/fs tail.
      assert.deepEqual(plan.steps.map(s => [s.kind, s.target]), [['partition', 'c']])

      assert.deepEqual(
        plan.preview.bands.map(b => [b.band, b.memberCount, b.level, b.protected]),
        [
          [1, 2, 'raid1', true],
          [2, 1, null, false],
        ],
      )
      assert.equal(plan.preview.capacity.usableBytes, 4 * TiB, 'no new usable space yet')
      assert.equal(plan.preview.capacity.pendingBytes, 4 * TiB)
      assert.ok(plan.preview.capacity.pendingBytes > 0)
      assert.ok(
        plan.preview.warnings.some(w => w.includes('pending') && w.includes('≥8 TiB')),
        `warnings must state the unlock condition, got: ${JSON.stringify(plan.preview.warnings)}`,
      )
      assertCapacityIdentity(plan.preview)
    })

    it('REFUSES an approved set missing an existing member — never intent to shrink', () => {
      assert.throws(
        () => planExpansion({
          poolName: 'tank',
          tier: 'ahr1',
          existingBands: existing234(),
          approvedDisks: [disk('d2', 2), disk('d4', 4)],
        }),
        (err: unknown) => {
          assert.ok(err instanceof AhrPlanError)
          assert.match(err.message, /'d3'/)
          assert.match(err.message, /never treated as intent to shrink/)
          return true
        },
      )
    })

    it('REFUSES a replacement disk too small for the bands it must join (§2.5)', () => {
      assert.throws(
        () => planExpansion({
          poolName: 'tank',
          tier: 'ahr1',
          existingBands: existing234(),
          approvedDisks: [disk('d3', 3), disk('d4', 4), disk('tiny', 1)],
          replaced: { oldDiskId: 'd2', newDiskId: 'tiny' },
        }),
        (err: unknown) => {
          assert.ok(err instanceof AhrPlanError)
          assert.match(err.message, /too small/)
          return true
        },
      )
    })
  })

  // --- Property-style sanity over generated disk sets -----------------------
  describe('generated-layout invariants', () => {
    /** Deterministic LCG so failures reproduce. */
    function makeRng(seed: number): () => number {
      let s = seed
      return () => {
        s = (s * 1103515245 + 12345) % 2 ** 31
        return s / 2 ** 31
      }
    }

    it('fresh layouts: usable = Σ h×(m−parity), identity exact, usable ≤ raw', () => {
      const rng = makeRng(1)
      for (let round = 0; round < 40; round++) {
        const tier: AhrType = round % 2 === 0 ? 'ahr1' : 'ahr2'
        const count = 1 + Math.floor(rng() * 6)
        const sizes: number[] = []
        for (let i = 0; i < count; i++)
          sizes.push(1 + Math.floor(rng() * 12))
        const preview = planFreshLayout(sizes.map((s, i) => disk(`d${i}`, s)), tier)
        AhrLayoutPreview.parse(preview)
        assert.equal(
          preview.capacity.usableBytes,
          expectedUsableBytes(sizes, tier),
          `sizes=[${sizes}] tier=${tier}`,
        )
        assertCapacityIdentity(preview)
        assert.equal(preview.minDisksMet, count >= AHR_MIN_DISKS[tier])
      }
    })

    it('incremental plans: append-only bands, upgrade-only levels, ordered steps', () => {
      const rng = makeRng(2)
      let exercised = 0
      for (let round = 0; round < 40; round++) {
        const tier: AhrType = round % 2 === 0 ? 'ahr1' : 'ahr2'
        const baseCount = AHR_MIN_DISKS[tier] + Math.floor(rng() * 3)
        const baseSizes: number[] = []
        for (let i = 0; i < baseCount; i++)
          baseSizes.push(1 + Math.floor(rng() * 12))
        const baseDisks = baseSizes.map((s, i) => disk(`d${i}`, s))
        const fresh = planFreshLayout(baseDisks, tier)
        const protectedBands = fresh.bands.filter(b => b.protected)
        if (protectedBands.length === 0)
          continue
        const existingBands: ExistingBand[] = protectedBands.map(b => ({
          band: b.band,
          startBytes: b.range.startBytes,
          endBytes: b.range.endBytes,
          level: b.level!,
          members: baseDisks.filter(d => d.usableBytes >= b.range.endBytes).map(d => d.id),
        }))
        const addCount = 1 + Math.floor(rng() * 3)
        const added = Array.from({ length: addCount }, (_, i) => disk(`n${i}`, 1 + Math.floor(rng() * 12)))
        const plan = planExpansion({
          poolName: 'tank',
          tier,
          existingBands,
          approvedDisks: [...baseDisks, ...added],
        })
        exercised++
        AhrLayoutPreview.parse(plan.preview)
        plan.steps.forEach(s => AhrExpansionStep.parse(s))
        assertCapacityIdentity(plan.preview)

        // Append-only: the existing band list is a PREFIX of the result —
        // same indices, same boundaries, same heights; members may only grow
        // and levels may only upgrade (raid1 → raid5, AHR-1 only).
        assert.ok(plan.preview.bands.length >= existingBands.length)
        existingBands.forEach((before, i) => {
          const after = plan.preview.bands[i]!
          assert.equal(after.band, before.band)
          assert.equal(after.range.startBytes, before.startBytes)
          assert.equal(after.range.endBytes, before.endBytes)
          assert.equal(after.heightBytes, before.endBytes - before.startBytes)
          assert.ok(after.memberCount >= before.members.length, 'bands never shrink')
          assert.ok(
            after.level === before.level || (before.level === 'raid1' && after.level === 'raid5'),
            `level may only upgrade raid1→raid5, got ${before.level}→${after.level}`,
          )
        })
        // New bands live strictly above the old top boundary, indices appended.
        const topBoundary = existingBands.at(-1)!.endBytes
        for (const b of plan.preview.bands.slice(existingBands.length)) {
          assert.ok(b.range.startBytes >= topBoundary)
          assert.ok(b.band > existingBands.at(-1)!.band)
        }
        // Usable capacity never decreases across an expansion.
        assert.ok(plan.preview.capacity.usableBytes >= fresh.capacity.usableBytes)

        // §5.1 ordering: partitions, then md each followed by its reshape-wait,
        // then a single pv/vg/lv/fs tail with fs-grow LAST.
        const kinds = plan.steps.map(s => s.kind)
        const phase = (k: string): number => {
          if (k === 'partition')
            return 0
          if (k === 'array-create' || k === 'array-grow' || k === 'array-convert' || k === 'reshape-wait')
            return 1
          if (k === 'pv-create' || k === 'pv-resize')
            return 2
          if (k === 'vg-extend')
            return 3
          if (k === 'lv-extend')
            return 4
          return 5 // fs-grow
        }
        for (let i = 1; i < kinds.length; i++)
          assert.ok(phase(kinds[i]!) >= phase(kinds[i - 1]!), `step order violation: ${kinds.join(' → ')}`)
        kinds.forEach((k, i) => {
          if (k === 'array-create' || k === 'array-grow' || k === 'array-convert')
            assert.equal(kinds[i + 1], 'reshape-wait', 'every md mutation is followed by reshape-wait')
        })
        for (const tail of ['vg-extend', 'lv-extend', 'fs-grow'])
          assert.ok(kinds.filter(k => k === tail).length <= 1, `at most one ${tail}`)
        if (kinds.some(k => k === 'pv-create' || k === 'pv-resize'))
          assert.equal(kinds.at(-1), 'fs-grow', 'the filesystem grows last')
        assert.deepEqual(plan.steps.map(s => s.index), plan.steps.map((_, i) => i))
      }
      assert.ok(exercised >= 24, `expected a few dozen exercised combos, got ${exercised}`)
    })
  })
})
