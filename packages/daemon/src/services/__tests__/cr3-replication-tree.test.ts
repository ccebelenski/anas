import type { TreeFacts } from '../replication-tree.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideBase, modifiedTargetHint, planTreeReplication } from '../replication-tree.js'

/**
 * Review 2 of cr3: the base rule for a target that ends on a backup/cloud
 * TRANSIENT (an older build sent one) is ONE function, `decideBase`, asked by
 * the single-dataset run and by the recursive planner alike. These pin the
 * planner's side; cr3-replication.test.ts pins the run's.
 */

const T = 'anas-backup-nightly-1794618000'

function facts(sourceSnaps: string[], targetSnaps: string[]): TreeFacts {
  return {
    sourceRoot: 'tank',
    targetRoot: 'backup',
    exclude: [],
    localTarget: false,
    sourceTree: ['tank'],
    sourceSnaps: new Map([['tank', sourceSnaps]]),
    sourceProps: new Map([['tank', { keystatus: '-' }]]),
    targetTree: ['backup'],
    targetSnaps: new Map([['backup', targetSnaps]]),
    targetProps: new Map([['backup', { written: '0' }]]),
  }
}

describe('review 2 of cr3 — the recursive planner agrees with the single-dataset run', () => {
  it('(a) the target ends on a transient the source has: the base is that transient for this send', () => {
    const plan = planTreeReplication(facts(['S4', T, 'S3', 'S2'], [T, 'S3', 'S2']))
    assert.ok(plan.ok, JSON.stringify(plan))
    assert.deepEqual(plan.datasets, [{ dataset: 'tank', target: 'backup', mode: 'incremental', baseSnapshot: T }])
  })

  // Review 3 of cr3: a transient the source does not have is any target-only
  // snapshot (R1: a backup run on the target node; R5: an older build's
  // leftover). The base is the newest common non-transient; ZFS arbitrates.
  it('(D) the target ends on a transient the source does not have: the base is @S3, nothing refused', () => {
    const plan = planTreeReplication(facts(['S4', 'S3', 'S2'], [T, 'S3', 'S2']))
    assert.ok(plan.ok, JSON.stringify(plan))
    assert.deepEqual(plan.datasets, [{ dataset: 'tank', target: 'backup', mode: 'incremental', baseSnapshot: 'S3' }])
  })

  it('modifiedTargetHint: only ZFS\'s "modified since most recent snapshot" (captured, wrapped) gets the rollback; never "destroy"', () => {
    const captured = 'cannot receive incremental stream: destination cr3dst/d has been modified\nsince most recent snapshot'
    const hint = modifiedTargetHint(captured, 'cr3dst/d', 'S3', [T, 'S3', 'S2'])
    assert.match(hint, /newer snapshot\(s\) '@anas-backup-nightly-1794618000'/)
    assert.match(hint, /'zfs rollback -r cr3dst\/d@S3'/)
    assert.doesNotMatch(hint, /destroy '/)
    assert.equal(modifiedTargetHint('cannot receive: out of space', 'cr3dst/d', 'S3', [T, 'S3']), '')
    assert.equal(modifiedTargetHint(captured, 'cr3dst/d', undefined, [T, 'S3']), '')
  })

  it('(c) only a transient in common, not the target\'s newest: refused naming it, never "remove the target dataset"', () => {
    const plan = planTreeReplication(facts(['S4', T, 'S1'], ['X', T]))
    assert.equal(plan.ok, false)
    const message = plan.ok ? '' : plan.refusals.join(' | ')
    assert.match(message, /shares with the source \('@anas-backup-nightly-1794618000'\)/)
    assert.doesNotMatch(message, /remove the target dataset/)
  })

  it('up to date while the target ends on a transient the source has: listed up to date, its holds kept', () => {
    const plan = planTreeReplication(facts([T, 'S3', 'S2'], [T, 'S3', 'S2']))
    assert.ok(plan.ok, JSON.stringify(plan))
    assert.deepEqual(plan.upToDate, ['tank'])
    assert.deepEqual(plan.holdsKept, ['tank'])
  })

  it('decideBase answers the run and the planner identically (the same lists, the same decision)', () => {
    const cases: [string[], string[], string][] = [
      [['S4', T, 'S3'], [T, 'S3'], 'S4'],
      [['S4', 'S3'], [T, 'S3'], 'S4'],
      [['S4', T, 'S1'], ['X', T], 'S4'],
      [['S2', 'S1'], ['S1'], 'S2'],
      [['S2', 'S1'], ['X'], 'S2'],
    ]
    for (const [src, tgt, S] of cases) {
      const d = decideBase(src, tgt, S, { target: 'backup' })
      const plan = planTreeReplication(facts(src, tgt))
      if (d.kind === 'incremental')
        assert.ok(plan.ok && plan.datasets[0]?.baseSnapshot === d.base, JSON.stringify({ d, plan }))
      else
        assert.equal(plan.ok, false, JSON.stringify({ d, plan }))
    }
  })
})
