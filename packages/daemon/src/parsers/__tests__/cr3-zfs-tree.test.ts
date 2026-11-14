import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseTreeSnapshots } from '../zfs-tree.js'

/**
 * cr3 (the datasets review's note on `parseSnapshotList`, applied to the
 * recursive run's own parser): "newer" is the order ZFS took the snapshots
 * in — the createtxg-sorted listing (`-s createtxg`) — never the creation
 * clock, which a clock stepped backwards makes disagree with it. Before, the
 * parser sorted by the epoch, so the root's "newest" snapshot S (R4) and every
 * dataset's base followed the clock.
 */
describe('cr3 parseTreeSnapshots — the listing order (createtxg) decides "newer"', () => {
  it('a snapshot taken AFTER another while the clock read EARLIER is still the newer one', () => {
    // As `-s createtxg` lists them: `early` was taken first (clock 12:00),
    // `late` after it, once the clock had been stepped back (clock 11:00).
    const listing = 'tank/a@base\t1000\t1\ntank/a@early\t43200\t2\ntank/a@late\t39600\t3\n'
    assert.deepEqual(parseTreeSnapshots(listing).get('tank/a'), ['late', 'early', 'base'])
  })

  it('the order is per dataset, whatever the interleaving of datasets', () => {
    const listing = 'tank/a@s1\t100\t1\ntank/b@s1\t100\t2\ntank/a@s2\t50\t3\ntank/b@s2\t50\t4\n'
    const got = parseTreeSnapshots(listing)
    assert.deepEqual(got.get('tank/a'), ['s2', 's1'])
    assert.deepEqual(got.get('tank/b'), ['s2', 's1'])
  })

  it('an unreadable epoch still refuses the line (the column is read, not trusted for order)', () => {
    assert.throws(() => parseTreeSnapshots('tank/a@s\t\t1\n'), /Unreadable zfs snapshot listing line/)
  })
})
