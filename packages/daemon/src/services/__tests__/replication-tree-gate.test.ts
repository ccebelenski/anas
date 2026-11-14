import type { PveOwnership } from '@anas/shared'
import type { PveFootprint } from '../pve-footprint.js'
import type { TargetGuardDeps } from '../replication-target.js'
import type { Transport } from '../replication-transport.js'
import type { TreeFacts } from '../replication-tree.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseTreeList, parseTreeProps, parseTreeSnapshots } from '../../parsers/zfs-tree.js'
import { ownedDescendantIn } from '../pve-footprint.js'
import { gateTreeRun } from '../replication-tree-gate.js'
import { planTreeReplication } from '../replication-tree.js'
import { isAtOrUnder, sweepSet } from '../zfs-snapshot.js'

/**
 * Story rrep.1b (#84), the gates around the planner (R5). Every sentence is
 * pinned; gates a and b must refuse BEFORE the planner is consulted; an
 * excluded PVE-owned child is the operator's explicit answer and runs.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/zfs/replication-tree')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

const SOURCE = 'rpool/rrsrc'
const TARGET = 'datapool/rrdst'
const EXCLUDE = ['rpool/rrsrc/skipme']

function fixtureFacts(overrides: Partial<TreeFacts> = {}): TreeFacts {
  return {
    sourceRoot: SOURCE,
    targetRoot: TARGET,
    exclude: EXCLUDE,
    localTarget: true,
    sourceTree: parseTreeList(loadFixture('src-tree.txt')),
    sourceSnaps: parseTreeSnapshots(loadFixture('src-snaps-p.txt')),
    sourceProps: parseTreeProps(loadFixture('src-keystatus.txt')),
    // The reader's target fact is the pool listing filtered to the root
    // (`dst-tree.txt` is the capture of the root's own listing; the filter
    // is what the reader applies to the pool's).
    targetTree: parseTreeList(loadFixture('dst-tree.txt')).filter(name => isAtOrUnder(name, TARGET)),
    targetSnaps: parseTreeSnapshots(loadFixture('dst-snaps-p.txt')),
    targetProps: parseTreeProps(loadFixture('dst-written.txt')),
    ...overrides,
  }
}

const REASON = 'PVE storage \'local-zfs\' holds this dataset'

/** A footprint whose only verdicts are the ones a test hands it. */
function footprint(owned: Record<string, string> = {}): PveFootprint {
  const ownershipOf = (dataset: string): PveOwnership | null =>
    owned[dataset] ? { kind: 'storage-root', storage: 'local-zfs', reason: owned[dataset] } : null
  return {
    ownershipOf,
    ownedDescendant: (candidates: string[] | { name: string }[], dataset: string) =>
      ownedDescendantIn(candidates, dataset, ownershipOf),
    claimedByPve: () => null,
  } as unknown as PveFootprint
}

interface GuardSpy {
  deps: TargetGuardDeps
  /** How many times the per-dataset guard's pool check ran. */
  calls: () => number
}

function guardSpy(pve: PveFootprint): GuardSpy {
  let calls = 0
  return {
    deps: {
      transport: {} as Transport,
      poolExists: async () => {
        calls++
        return { ok: true, exists: true }
      },
      pveFootprint: async () => pve,
    },
    calls: () => calls,
  }
}

const TARGET_REQ = { pool: 'datapool' }

async function gate(
  facts: TreeFacts,
  pve: PveFootprint = footprint(),
  target: { pool: string } = TARGET_REQ,
) {
  const spy = guardSpy(pve)
  const result = await gateTreeRun({ pve, guard: spy.deps }, { facts, target })
  return { result, spy }
}

describe('the fixture run through the gates', () => {
  it('passes every gate and returns the planner plan plus the schedule sweep', async () => {
    const { result } = await gate(fixtureFacts())
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok)
      return
    assert.deepEqual(result.plan, planTreeReplication(fixtureFacts()))
    assert.deepEqual(result.sweep, sweepSet(
      { target: { kind: 'zfs', dataset: SOURCE }, recursive: true, exclude: EXCLUDE },
      fixtureFacts().sourceTree,
    ))
    // skipme is excluded; late is swept (the planner skips it, the lock covers it).
    assert.deepEqual(result.sweep, [
      SOURCE,
      'rpool/rrsrc/a',
      'rpool/rrsrc/a/deep',
      'rpool/rrsrc/enc',
      'rpool/rrsrc/late',
      'rpool/rrsrc/new',
      'rpool/rrsrc/vol',
    ])
  })

  // rrep.2 fold P2: the guard still runs once per PLANNED dataset (counted by
  // its naming check, which only the per-dataset guard asks), but the target
  // POOL's existence is asked ONCE per pass. This test used to pin the pool
  // check at 6 — one per dataset — which is what the fold removes.
  it('the local target guard runs once per PLANNED dataset; the pool is asked once (fold P2)', async () => {
    let guardRuns = 0
    const base = footprint()
    const counted = { ...base, claimedByPve: (d: string) => {
      guardRuns++
      return base.claimedByPve(d)
    } } as unknown as PveFootprint
    const { result, spy } = await gate(fixtureFacts(), counted)
    assert.equal(result.ok, true)
    assert.equal(guardRuns, 6)
    assert.equal(spy.calls(), 1)
  })

  it('fold P2: a pool read that says no is asked once and refuses the pass (fail-closed)', async () => {
    let asked = 0
    const pve = footprint()
    const result = await gateTreeRun({
      pve,
      guard: { transport: {} as Transport, poolExists: async () => {
        asked++
        return { ok: true, exists: false }
      }, pveFootprint: async () => pve },
    }, { facts: fixtureFacts(), target: TARGET_REQ })
    assert.equal(result.ok, false)
    assert.equal(asked, 1)
    if (!result.ok)
      assert.ok(result.refusals.every(r => r.message === 'Target pool \'datapool\' does not exist'))
  })
})

describe('gate a: the request\'s excludes', () => {
  it('a non-child entry is the shared schema sentence, and the planner is never consulted', async () => {
    // The facts have NO snapshots: the planner would refuse. Only gate a's
    // sentence comes back, and the target guard never runs.
    const { result, spy } = await gate(fixtureFacts({ exclude: ['rpool/other'], sourceSnaps: new Map() }))
    assert.deepEqual(result, { ok: false, refusals: [{ message: `Exclude 'rpool/other' is not a child dataset of '${SOURCE}'` }] })
    assert.equal(spy.calls(), 0)
  })

  // rrep.2 fold E1 (ruled): an entry the source tree does not hold is INERT
  // at the run, as it is for a snapshot schedule — it used to refuse the run
  // ("Exclude '<name>' does not exist under '<root>'"), so a stored task whose excluded
  // child was destroyed failed on every fire. It is reported, never refused.
  it('fold E1: an entry that does not exist in the source tree is inert and reported in excludeMissing', async () => {
    const { result } = await gate(fixtureFacts({ exclude: ['rpool/rrsrc/ghost'] }))
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok)
      return
    assert.deepEqual(result.excludeMissing, ['rpool/rrsrc/ghost'])
    assert.deepEqual(result.plan, planTreeReplication(fixtureFacts({ exclude: ['rpool/rrsrc/ghost'] })))
  })

  // Found while folding E1: placement EXCUSES a local target under an excluded
  // dataset. RULE: only an exclude that exists can excuse it — a vanished one
  // excludes nothing, so the target is inside the tree being copied.
  it('a vanished exclude does not excuse a local target inside the source tree', async () => {
    const inside = { sourceTree: fixtureFacts().sourceTree, localTarget: true }
    const gone = await gate(fixtureFacts({ ...inside, targetRoot: 'rpool/rrsrc/bk/copy', targetTree: [], targetSnaps: new Map(), targetProps: new Map(), exclude: ['rpool/rrsrc/bk'] }))
    assert.equal(gone.result.ok, false)
    if (!gone.result.ok)
      assert.match(gone.result.refusals.map(r => r.message).join('; '), /The target 'rpool\/rrsrc\/bk\/copy' is inside the source tree 'rpool\/rrsrc'/)
    // The live exclude still excuses it (the proven row: a copy under skipme).
    const live = await gate(fixtureFacts({ ...inside, targetRoot: 'rpool/rrsrc/skipme/copy', targetTree: [], targetSnaps: new Map(), targetProps: new Map(), exclude: ['rpool/rrsrc/skipme'] }))
    const placement = live.result.ok ? [] : live.result.refusals.map(r => r.message).filter(m => m.includes('inside the source tree'))
    assert.deepEqual(placement, [])
  })

  it('fold E1: one live and one gone entry — the live one is excluded, only the gone one is reported', async () => {
    const { result } = await gate(fixtureFacts({ exclude: ['rpool/rrsrc/skipme', 'rpool/rrsrc/ghost'] }))
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok)
      return
    assert.ok(!result.sweep.includes('rpool/rrsrc/skipme'))
    assert.deepEqual(result.excludeMissing, ['rpool/rrsrc/ghost'])
  })

  it('fold E1: every entry live → excludeMissing is empty', async () => {
    const { result } = await gate(fixtureFacts())
    assert.equal(result.ok, true)
    if (result.ok)
      assert.deepEqual(result.excludeMissing, [])
  })

  it('fold E1: the SHAPE rule still refuses, and a malformed list reports nothing missing', async () => {
    const { result } = await gate(fixtureFacts({ exclude: ['rpool/rrsrc/ghost', 'rpool/other'] }))
    assert.deepEqual(result, { ok: false, refusals: [{ message: `Exclude 'rpool/other' is not a child dataset of '${SOURCE}'` }] })
  })
})

describe('gate b: R5a, no swept dataset is PVE-owned', () => {
  it('an owned child in the sweep refuses with the ownership verdict attached', async () => {
    const { result } = await gate(fixtureFacts(), footprint({ 'rpool/rrsrc/a': REASON }))
    assert.deepEqual(result, {
      ok: false,
      refusals: [{
        message: `Recursive replication of '${SOURCE}' would include rpool/rrsrc/a — ${REASON} — exclude it, or replicate a dataset below it`,
        ownership: { kind: 'storage-root', storage: 'local-zfs', reason: REASON },
      }],
    })
  })

  it('the SAME child EXCLUDED passes — the operator\'s explicit answer', async () => {
    const { result } = await gate(fixtureFacts({ exclude: [...EXCLUDE, 'rpool/rrsrc/a'] }), footprint({ 'rpool/rrsrc/a': REASON }))
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok)
      return
    assert.ok(!result.plan.datasets.some(d => d.dataset === 'rpool/rrsrc/a'))
    assert.ok(!result.plan.datasets.some(d => d.dataset === 'rpool/rrsrc/a/deep'))
  })

  it('an owned ROOT is the same sentence with the root as the hit', async () => {
    const { result } = await gate(fixtureFacts(), footprint({ [SOURCE]: REASON }))
    assert.deepEqual(result, {
      ok: false,
      refusals: [{
        message: `Recursive replication of '${SOURCE}' would include ${SOURCE} — ${REASON} — exclude it, or replicate a dataset below it`,
        ownership: { kind: 'storage-root', storage: 'local-zfs', reason: REASON },
      }],
    })
  })
})

describe('gate c: the planner\'s refusals pass through verbatim', () => {
  it('a key-unloaded dataset is the planner\'s sentence, unchanged', async () => {
    const unloaded = parseTreeProps(loadFixture('src-keystatus-unloaded.txt'))
    const { result } = await gate(fixtureFacts({ sourceProps: unloaded }))
    assert.deepEqual(result, {
      ok: false,
      refusals: [{ message: `'rpool/rrsrc/enc' is encrypted and its key is not loaded — load it or exclude the dataset` }],
    })
  })
})

describe('the plan\'s snapshot names: a name ANAS does not pass to a remote command refuses (fold 3, review H)', () => {
  const S1 = 'anas-daily-2026-11-13_01.00.00--1d'
  const S2 = 'anas-daily-2026-11-14_01.00.00--1d'

  function nameSentence(name: string): string {
    return `Snapshot '${name}' has a name ANAS does not pass to a remote command (a space or another character outside letters, digits and _ - . :) — rename it with 'zfs rename', or take a new recursive snapshot of '${SOURCE}'`
  }

  it('an S with a space in its name refuses, once, and gate d never runs', async () => {
    const BAD_S = 'nightly 2'
    const sourceSnaps = parseTreeSnapshots(loadFixture('src-snaps-p.txt').replaceAll(S2, BAD_S))
    const { result, spy } = await gate(fixtureFacts({ sourceSnaps }))
    assert.deepEqual(result, { ok: false, refusals: [{ message: nameSentence(BAD_S) }] })
    assert.equal(spy.calls(), 0)
  })

  it('a base with a space refuses too — ONCE, though five datasets carry it as their base', async () => {
    const BAD_BASE = 'base 1'
    const sourceSnaps = parseTreeSnapshots(loadFixture('src-snaps-p.txt').replaceAll(S1, BAD_BASE))
    const targetSnaps = parseTreeSnapshots(loadFixture('dst-snaps-p.txt').replaceAll(S1, BAD_BASE))
    const { result } = await gate(fixtureFacts({ sourceSnaps, targetSnaps }))
    assert.deepEqual(result, { ok: false, refusals: [{ message: nameSentence(BAD_BASE) }] })
  })
})

describe('gate d: R5b\'s local half, one target this run touches at a time', () => {
  it('a planned target PVE owns refuses with the target guard\'s own sentence', async () => {
    const { result } = await gate(fixtureFacts(), footprint({ 'datapool/rrdst/new': REASON }))
    assert.deepEqual(result, {
      ok: false,
      refusals: [{ message: `Replication target 'datapool/rrdst/new' is PVE-owned — ${REASON}` }],
    })
  })

  it('an UP-TO-DATE target PVE owns refuses too — the job holds its target snapshot (review I2)', async () => {
    // `a`'s copy already carries S: the planner puts it in upToDate, and the
    // job places holds on its TARGET snapshot. The guard judges it as much
    // as a planned receive.
    const S2 = 'anas-daily-2026-11-14_01.00.00--1d'
    const targetSnaps = parseTreeSnapshots(loadFixture('dst-snaps-p.txt'))
    targetSnaps.set('datapool/rrdst/a', [S2])
    const { result } = await gate(fixtureFacts({ targetSnaps }), footprint({ 'datapool/rrdst/a': REASON }))
    assert.deepEqual(result, {
      ok: false,
      refusals: [{ message: `Replication target 'datapool/rrdst/a' is PVE-owned — ${REASON}` }],
    })
  })

  it('a REMOTE target skips the local guard entirely', async () => {
    const { result, spy } = await gate(
      fixtureFacts({ localTarget: false }),
      footprint({ 'datapool/rrdst': REASON }),
      { pool: 'datapool' },
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(spy.calls(), 0)
  })
})
