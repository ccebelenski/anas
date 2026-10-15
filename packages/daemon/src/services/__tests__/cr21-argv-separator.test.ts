import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { newLunZvolCreateArgs, volsizeArgs } from '../backup-restore.js'
import { zfsTransientListArgs } from '../backup-snapshots.js'
import { snapdevGetArgs, snapdevRestoreArgs } from '../backup-zvol.js'
import { zfsScrubGetArgs, zfsScrubSetArgs } from '../scrub-schedules.js'
import { zfsScheduledListArgs, zfsStampSourceArgs, zfsTreeSnapshotListArgs } from '../snapshot-schedules.js'
import {
  createZfsSnapshotArgs,
  createZfsSnapshotsArgs,
  destroyZfsSnapshotArgs,
  zfsTreeListArgs,
} from '../zfs-snapshot.js'

/**
 * cr.21 (EPICS §2 ruling i): `--` ends zfs/zpool option parsing immediately
 * before the first user-, record- or system-derived operand, so a derived
 * name can never be mistaken for a flag. Every exportable argv builder must
 * keep `--` between its options and the operand(s) it derives from the input.
 *
 * These are the pure builders; the verb words that live inline in services /
 * routes are covered BY the exact-argv pins in their own test files (which
 * would go stale the moment a `--` is dropped).
 */
function expectSeparated(label: string, argv: string[], ...derived: string[]): string[] {
  const sep = argv.indexOf('--')
  assert.ok(sep >= 0, `${label}: expected '--' in ${JSON.stringify(argv)}`)
  const before = argv.slice(0, sep)
  const after = argv.slice(sep + 1)
  for (const d of derived) {
    assert.ok(!before.some(a => a.includes(d)), `${label}: derived operand '${d}' leaked before '--' in ${JSON.stringify(argv)}`)
    assert.ok(after.some(a => a.includes(d)), `${label}: derived operand '${d}' missing after '--' in ${JSON.stringify(argv)}`)
  }
  return argv
}

describe('cr.21 — argv builders place every derived operand after `--`', () => {
  /** Distinctive dataset: an element that mentions it is the operand, never an option value. */
  const DS = 'testpool/data-z'
  const NAME = 'zz'
  const snap = `${DS}@${NAME}`
  const CASES: [label: string, argv: string[], derived: string[]][] = [
    ['snapshot (non-recursive)', createZfsSnapshotArgs({ dataset: DS, name: NAME }), [snap]],
    ['snapshot (recursive)', createZfsSnapshotArgs({ dataset: DS, name: NAME, recursive: true }), [snap]],
    ['snapshots (one)', createZfsSnapshotsArgs([DS], NAME), [snap]],
    ['snapshots (two datasets)', createZfsSnapshotsArgs([DS, 'testpool/data-y'], NAME), [snap, 'testpool/data-y@zz']],
    ['destroy', destroyZfsSnapshotArgs({ dataset: DS, name: NAME }), [snap]],
    ['destroy (recursive)', destroyZfsSnapshotArgs({ dataset: DS, name: NAME, recursive: true }), [snap]],
    ['tree list', zfsTreeListArgs(DS), [DS]],
    ['transient sweep list', zfsTransientListArgs(DS), [DS]],
    ['snapdev get', snapdevGetArgs(DS), [DS]],
    ['snapdev restore (local set)', snapdevRestoreArgs(DS, { value: 'hidden', source: 'local' }), [DS]],
    ['snapdev restore (inherit)', snapdevRestoreArgs(DS, { value: 'hidden', source: 'default' }), [DS]],
    ['volsize get', volsizeArgs(DS), [DS]],
    ['new LUN zvol create', newLunZvolCreateArgs(DS, 536870912), [DS]],
    ['scheduled list', zfsScheduledListArgs(DS), [DS]],
    ['scheduled tree list', zfsTreeSnapshotListArgs(DS), [DS]],
    ['scheduled stamp source', zfsStampSourceArgs(DS), [DS]],
    ['scheduled stamp source (direct)', zfsStampSourceArgs(DS, false), [DS]],
    ['scrub get', zfsScrubGetArgs(DS), [DS]],
    ['scrub set', zfsScrubSetArgs(DS, true), [DS]],
  ]

  it('derived operands are always after the separator, options before it', () => {
    for (const [label, argv, derived] of CASES)
      expectSeparated(label, argv, ...derived)
  })
})
