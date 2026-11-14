import type { PlannedDataset, TreeFacts, TreePlan } from '../replication-tree.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseTreeList, parseTreeProps, parseTreeSnapshots } from '../../parsers/zfs-tree.js'
import { planTreeReplication } from '../replication-tree.js'

/**
 * Story rrep.1a (#84), planner half: {@link planTreeReplication} over the
 * captured recursive-replication fixtures (`fixtures/zfs/replication-tree/`,
 * read with the step-2 parsers so the fixtures' exact bytes drive the plan)
 * plus one hand-built fact set per rule the fixtures cannot express (illegal
 * names, inside placements, diverged targets). Every refusal sentence is
 * pinned byte-for-byte: the operator reads these in the run dialog and fixes
 * from them.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/zfs/replication-tree')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/** The two recursive snapshots of the captured tree (fixture README: S1, S2). */
const S1 = 'anas-daily-2026-11-13_01.00.00--1d'
const S2 = 'anas-daily-2026-11-14_01.00.00--1d'

/** The fixture run: rpool/rrsrc -> datapool/rrdst, skipme excluded. */
function fixtureFacts(overrides: Partial<TreeFacts> = {}): TreeFacts {
  return {
    sourceRoot: 'rpool/rrsrc',
    targetRoot: 'datapool/rrdst',
    exclude: ['rpool/rrsrc/skipme'],
    localTarget: true,
    sourceTree: parseTreeList(loadFixture('src-tree.txt')),
    sourceSnaps: parseTreeSnapshots(loadFixture('src-snaps-p.txt')),
    sourceProps: parseTreeProps(loadFixture('src-keystatus.txt')),
    targetTree: parseTreeList(loadFixture('dst-tree.txt')),
    targetSnaps: parseTreeSnapshots(loadFixture('dst-snaps-p.txt')),
    targetProps: parseTreeProps(loadFixture('dst-written.txt')),
    ...overrides,
  }
}

/** The smallest everything-is-fine fact set: one dataset, nothing on the target. */
function baseFacts(overrides: Partial<TreeFacts> = {}): TreeFacts {
  return {
    sourceRoot: 'tank',
    targetRoot: 'backup',
    exclude: [],
    localTarget: true,
    sourceTree: ['tank'],
    sourceSnaps: new Map([['tank', [S2]]]),
    sourceProps: new Map([['tank', { keystatus: '-' }]]),
    targetTree: [],
    targetSnaps: new Map(),
    targetProps: new Map(),
    ...overrides,
  }
}

function planOf(facts: TreeFacts): Extract<TreePlan, { ok: true }> {
  const plan = planTreeReplication(facts)
  if (!plan.ok)
    assert.fail(`expected a plan, got refusals: ${plan.refusals.join(' | ')}`)
  return plan
}

function refusalsOf(facts: TreeFacts): string[] {
  const plan = planTreeReplication(facts)
  if (plan.ok)
    assert.fail(`expected refusals, got plan ${JSON.stringify(plan)}`)
  return plan.refusals
}

function inc(dataset: string, target: string, baseSnapshot: string): PlannedDataset {
  return { dataset, target, mode: 'incremental', baseSnapshot }
}

function full(dataset: string, target: string): PlannedDataset {
  return { dataset, target, mode: 'full' }
}

describe('the fixture run: rpool/rrsrc -> datapool/rrdst, skipme excluded', () => {
  it('the whole plan, byte for byte: five incremental, one full, late skipped, targetonly listed', () => {
    assert.deepEqual(planOf(fixtureFacts()), {
      ok: true,
      snapshot: S2,
      datasets: [
        inc('rpool/rrsrc', 'datapool/rrdst', S1),
        inc('rpool/rrsrc/a', 'datapool/rrdst/a', S1),
        inc('rpool/rrsrc/a/deep', 'datapool/rrdst/a/deep', S1),
        inc('rpool/rrsrc/enc', 'datapool/rrdst/enc', S1),
        full('rpool/rrsrc/new', 'datapool/rrdst/new'),
        inc('rpool/rrsrc/vol', 'datapool/rrdst/vol', S1),
      ],
      skipped: [{
        dataset: 'rpool/rrsrc/late',
        message: `'rpool/rrsrc/late' has no '@${S2}' (created after that snapshot?) — skipped with everything below it; it is sent once a recursive snapshot of 'rpool/rrsrc' includes it`,
      }],
      targetOnly: ['datapool/rrdst/targetonly'],
      upToDate: [],
    })
  })

  it('after zfs unload-key: exactly one refusal, the key sentence for rpool/rrsrc/enc', () => {
    const unloaded = parseTreeProps(loadFixture('src-keystatus-unloaded.txt'))
    assert.deepEqual(refusalsOf(fixtureFacts({ sourceProps: unloaded })), [
      `'rpool/rrsrc/enc' is encrypted and its key is not loaded — load it or exclude the dataset`,
    ])
  })

  it('NO exclude: skipme joins the run as a full send (it has both snapshots, no target copy)', () => {
    const plan = planOf(fixtureFacts({ exclude: [] }))
    assert.deepEqual(plan.datasets, [
      inc('rpool/rrsrc', 'datapool/rrdst', S1),
      inc('rpool/rrsrc/a', 'datapool/rrdst/a', S1),
      inc('rpool/rrsrc/a/deep', 'datapool/rrdst/a/deep', S1),
      inc('rpool/rrsrc/enc', 'datapool/rrdst/enc', S1),
      full('rpool/rrsrc/new', 'datapool/rrdst/new'),
      full('rpool/rrsrc/skipme', 'datapool/rrdst/skipme'),
      inc('rpool/rrsrc/vol', 'datapool/rrdst/vol', S1),
    ])
    assert.deepEqual(plan.targetOnly, ['datapool/rrdst/targetonly'])
  })

  it('placement on the fixture tree: equal roots are the self-copy refusal', () => {
    assert.deepEqual(refusalsOf(fixtureFacts({ targetRoot: 'rpool/rrsrc' })), [
      `The target 'rpool/rrsrc' is inside the source tree 'rpool/rrsrc' — a recursive replication would copy its own replica; choose a target outside it, or exclude the dataset that contains it`,
    ])
  })

  it('the root not being its own listing is the one refusal that returns at once (rule 1)', () => {
    assert.deepEqual(refusalsOf(fixtureFacts({ sourceRoot: 'rpool/typo' })), [
      `Source 'rpool/typo' was not in its own listing — refusing the recursive replication`,
    ])
  })

  it('a root listing with no snapshots at all is the one refusal that returns at once (rule 2)', () => {
    assert.deepEqual(refusalsOf(fixtureFacts({ sourceSnaps: new Map() })), [
      `Dataset 'rpool/rrsrc' has no snapshots — take a recursive snapshot of it, or let its recursive schedule run`,
    ])
  })

  it('a transient NEWEST snapshot on the root is not S; the newest real name is (real anas-backup- prefix)', () => {
    const snaps = parseTreeSnapshots(loadFixture('src-snaps-p.txt'))
    snaps.set('rpool/rrsrc', ['anas-backup-nightly-1794699999', S2, S1])
    const plan = planOf(fixtureFacts({ sourceSnaps: snaps }))
    assert.equal(plan.snapshot, S2)
    assert.equal(plan.datasets[0].baseSnapshot, S1)
  })

  it('a root whose ONLY snapshots are transient has no S at all (rule 2)', () => {
    const snaps = parseTreeSnapshots(loadFixture('src-snaps-p.txt'))
    snaps.set('rpool/rrsrc', ['anas-backup-nightly-1794699999'])
    assert.deepEqual(refusalsOf(fixtureFacts({ sourceSnaps: snaps })), [
      `Dataset 'rpool/rrsrc' has no snapshots — take a recursive snapshot of it, or let its recursive schedule run`,
    ])
  })
})

describe('rule 4: target names the remote recv cannot take', () => {
  it('a target name DatasetPath refuses is one refusal', () => {
    assert.deepEqual(refusalsOf(baseFacts({
      sourceTree: ['tank', 'tank/bad name'],
      sourceSnaps: new Map([['tank', [S2]], ['tank/bad name', [S2]]]),
      sourceProps: new Map([['tank', { keystatus: '-' }], ['tank/bad name', { keystatus: '-' }]]),
    })), [
      `'tank/bad name' cannot be replicated: its target name 'backup/bad name' is longer than ZFS allows (255) or contains characters ANAS does not pass to a remote command`,
    ])
  })

  it('a target name past ZFS 255 is one refusal', () => {
    const deep = `tank/${'x'.repeat(250)}`
    assert.deepEqual(refusalsOf(baseFacts({
      sourceTree: ['tank', deep],
      sourceSnaps: new Map([['tank', [S2]], [deep, [S2]]]),
      sourceProps: new Map([['tank', { keystatus: '-' }], [deep, { keystatus: '-' }]]),
    })), [
      `'${deep}' cannot be replicated: its target name 'backup/${'x'.repeat(250)}' is longer than ZFS allows (255) or contains characters ANAS does not pass to a remote command`,
    ])
  })
})

describe('rule 5: placement (local targets only)', () => {
  it('target inside the source tree refuses with the self-copy sentence', () => {
    assert.deepEqual(refusalsOf(baseFacts({
      targetRoot: 'tank/backup',
      sourceTree: ['tank', 'tank/data'],
      sourceSnaps: new Map([['tank', [S2]], ['tank/data', [S2]]]),
      sourceProps: new Map([['tank', { keystatus: '-' }], ['tank/data', { keystatus: '-' }]]),
    })), [
      `The target 'tank/backup' is inside the source tree 'tank' — a recursive replication would copy its own replica; choose a target outside it, or exclude the dataset that contains it`,
    ])
  })

  it('target inside the source but EXCLUDED is the operator explicit answer: no refusal', () => {
    const plan = planOf(baseFacts({
      targetRoot: 'tank/backup',
      exclude: ['tank/backup'],
      sourceTree: ['tank', 'tank/data'],
      sourceSnaps: new Map([['tank', [S2]], ['tank/data', [S2]]]),
      sourceProps: new Map([['tank', { keystatus: '-' }], ['tank/data', { keystatus: '-' }]]),
    }))
    assert.deepEqual(plan.datasets, [full('tank', 'tank/backup'), full('tank/data', 'tank/backup/data')])
  })

  it('source inside the target tree refuses with the second sentence', () => {
    assert.deepEqual(refusalsOf(baseFacts({
      sourceRoot: 'tank/media',
      targetRoot: 'tank',
      sourceTree: ['tank/media'],
      sourceSnaps: new Map([['tank/media', [S2]]]),
      sourceProps: new Map([['tank/media', { keystatus: '-' }]]),
    })), [
      `The source 'tank/media' is inside the target tree 'tank'`,
    ])
  })

  it('a remote target gets no placement refusal for the same geometry', () => {
    const plan = planOf(baseFacts({
      targetRoot: 'tank/backup',
      localTarget: false,
      sourceTree: ['tank', 'tank/data'],
      sourceSnaps: new Map([['tank', [S2]], ['tank/data', [S2]]]),
      sourceProps: new Map([['tank', { keystatus: '-' }], ['tank/data', { keystatus: '-' }]]),
    }))
    assert.equal(plan.datasets.length, 2)
  })
})

describe('rule 6: keys', () => {
  it('a swept dataset with NO keystatus row is the unreadable refusal, never "unencrypted"', () => {
    assert.deepEqual(refusalsOf(baseFacts({ sourceProps: new Map() })), [
      `Could not read 'keystatus' of 'tank' — refusing the recursive replication`,
    ])
  })
})

describe('rule 7: one snapshot name across the tree', () => {
  it('a dataset without S whose copy does not exist yet is skipped WITH its subtree: no entry, no plan, no refusal', () => {
    assert.deepEqual(planOf(baseFacts({
      sourceTree: ['tank', 'tank/p', 'tank/p/c'],
      sourceSnaps: new Map([['tank', [S2]], ['tank/p/c', [S2]]]),
      sourceProps: new Map([['tank', { keystatus: '-' }], ['tank/p/c', { keystatus: 'unavailable' }]]),
    })), {
      ok: true,
      snapshot: S2,
      datasets: [full('tank', 'backup')],
      skipped: [{
        dataset: 'tank/p',
        message: `'tank/p' has no '@${S2}' (created after that snapshot?) — skipped with everything below it; it is sent once a recursive snapshot of 'tank' includes it`,
      }],
      targetOnly: [],
      upToDate: [],
    })
  })

  it('a dataset without S whose copy EXISTS refuses: there is no name to send it at', () => {
    assert.deepEqual(refusalsOf(baseFacts({
      sourceTree: ['tank', 'tank/p'],
      sourceProps: new Map([['tank', { keystatus: '-' }], ['tank/p', { keystatus: '-' }]]),
      targetTree: ['backup/p'],
    })), [
      `'tank/p' has no '@${S2}', the newest snapshot of 'tank' — recursive replication sends one snapshot name across the tree; take a recursive snapshot of 'tank' (or let its recursive schedule run), or exclude 'tank/p'`,
    ])
  })
})

describe('rule 8: per-dataset full, incremental, up to date, refused', () => {
  it('a target modified since its last received snapshot refuses (written above 0)', () => {
    assert.deepEqual(refusalsOf(baseFacts({
      sourceSnaps: new Map([['tank', [S2, S1]]]),
      targetTree: ['backup'],
      targetSnaps: new Map([['backup', [S1]]]),
      targetProps: new Map([['backup', { written: '24576' }]]),
    })), [
      `Target 'backup' has been modified since its last replicated snapshot — a receive would fail; roll it back to that snapshot, or remove it`,
    ])
  })

  it('a target with no common snapshot diverged (R5e, today sentence per dataset)', () => {
    assert.deepEqual(refusalsOf(baseFacts({
      sourceSnaps: new Map([['tank', [S2, S1]]]),
      targetTree: ['backup'],
      targetSnaps: new Map([['backup', ['stray']]]),
      targetProps: new Map([['backup', { written: '0' }]]),
    })), [
      `Target 'backup' has diverged — no common snapshot; remove the target dataset or replicate to a new path`,
    ])
  })

  it('a target already AT S with no newer common base is up to date: listed, not planned, not refused', () => {
    assert.deepEqual(planOf(baseFacts({
      targetTree: ['backup'],
      targetSnaps: new Map([['backup', [S2]]]),
      targetProps: new Map([['backup', { written: '0' }]]),
    })), {
      ok: true,
      snapshot: S2,
      datasets: [],
      skipped: [],
      targetOnly: [],
      upToDate: ['tank'],
    })
  })

  it('a full send whose parent exists neither on the target nor earlier in this run refuses', () => {
    assert.deepEqual(refusalsOf(baseFacts({
      sourceTree: ['tank', 'tank/gone/child'],
      sourceSnaps: new Map([['tank', [S2]], ['tank/gone/child', [S2]]]),
      sourceProps: new Map([['tank', { keystatus: '-' }], ['tank/gone/child', { keystatus: '-' }]]),
    })), [
      `'backup/gone/child' cannot be created: its parent does not exist on the target and is not part of this run`,
    ])
  })

  it('a transient snapshot is never the base, on either side: the base skips to S1', () => {
    const plan = planOf(baseFacts({
      sourceSnaps: new Map([['tank', [S2, 'anas-backup-run-1794600000', S1]]]),
      targetTree: ['backup'],
      targetSnaps: new Map([['backup', ['anas-backup-run-1794600000', S1]]]),
      targetProps: new Map([['backup', { written: '0' }]]),
    }))
    assert.deepEqual(plan.datasets, [inc('tank', 'backup', S1)])
  })

  it('a planned target with NO written row is the unreadable refusal, never "0"', () => {
    assert.deepEqual(refusalsOf(baseFacts({
      targetTree: ['backup'],
    })), [
      `Could not read 'written' of 'backup' — refusing the recursive replication`,
    ])
  })
})

describe('refusals collected in one pass', () => {
  it('a key refusal and a missing-S refusal on the same dataset come back together, rules in order', () => {
    assert.deepEqual(refusalsOf(baseFacts({
      sourceTree: ['tank', 'tank/x'],
      sourceSnaps: new Map([['tank', [S2]]]),
      sourceProps: new Map([['tank', { keystatus: '-' }], ['tank/x', { keystatus: 'unavailable' }]]),
      targetTree: ['backup/x'],
    })), [
      `'tank/x' is encrypted and its key is not loaded — load it or exclude the dataset`,
      `'tank/x' has no '@${S2}', the newest snapshot of 'tank' — recursive replication sends one snapshot name across the tree; take a recursive snapshot of 'tank' (or let its recursive schedule run), or exclude 'tank/x'`,
    ])
  })
})

// Review of rrep.1a (constructed from the captured state AFTER run 2, the run
// whose `enc` receive failed): every copy that already held S2 was planned as
// an incremental from S1. RULE (R6): a run resumed after a part-way stop sends
// only to the datasets that still lack S; a copy that holds S is up to date.
describe('a resumed run: copies that already hold S are up to date, the rest continue from their own base', () => {
  /** `after-dst-snaps.txt` is the plain listing (name, creation text): names only, newest first per dataset. */
  function namesNewestFirst(stdout: string): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const line of stdout.split('\n').filter(l => l.length > 0)) {
      const full = line.split('\t')[0]
      const at = full.lastIndexOf('@')
      const ds = full.slice(0, at)
      out.set(ds, [full.slice(at + 1), ...(out.get(ds) ?? [])])
    }
    return out
  }

  it('the captured part-way state plans enc alone', () => {
    const targetTree = parseTreeList(loadFixture('after-dst-tree.txt'))
    const plan = planTreeReplication(fixtureFacts({
      targetTree,
      targetSnaps: namesNewestFirst(loadFixture('after-dst-snaps.txt')),
      targetProps: new Map(targetTree.map(t => [t, { written: '0' }])),
    }))
    assert.equal(plan.ok, true)
    if (!plan.ok)
      return
    assert.deepEqual(plan.datasets, [
      { dataset: 'rpool/rrsrc/enc', target: 'datapool/rrdst/enc', mode: 'incremental', baseSnapshot: S1 },
    ])
    assert.deepEqual(plan.upToDate, ['rpool/rrsrc', 'rpool/rrsrc/a', 'rpool/rrsrc/a/deep', 'rpool/rrsrc/new', 'rpool/rrsrc/vol'])
    assert.deepEqual(plan.skipped.map(s => s.dataset), ['rpool/rrsrc/late'])
  })

  it('a copy holding S and an older common snapshot is up to date, never an incremental', () => {
    const plan = planTreeReplication({
      sourceRoot: 'tank',
      targetRoot: 'backup',
      exclude: [],
      localTarget: false,
      sourceTree: ['tank'],
      sourceSnaps: new Map([['tank', [S2, S1]]]),
      sourceProps: new Map([['tank', { keystatus: '-' }]]),
      targetTree: ['backup'],
      targetSnaps: new Map([['backup', [S2, S1]]]),
      targetProps: new Map([['backup', { written: '0' }]]),
    })
    assert.deepEqual(plan, { ok: true, snapshot: S2, datasets: [], skipped: [], targetOnly: [], upToDate: ['tank'] })
  })
})
