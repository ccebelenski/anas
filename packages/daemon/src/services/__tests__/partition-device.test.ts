import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { blkidContentSignatures, blkidPartEntryName } from '../partition-device.js'

/**
 * The `blkid -p` parsers the ZFS partition gate (routes/pools.ts) and the AHR
 * classifier (ahr-identity.ts `classifyPartition`) share, over the stunt-node
 * captures in `fixtures/zfs` (NOTES.md, nf.1) and the wave-3 n6 capture of a
 * NAMED partition (`docs/probes/wave3-node/out/n6-zpool-create.log`).
 */

const ZFS_FIXTURES = join(import.meta.dirname, '../../fixtures/zfs')
const capture = (name: string): string => readFileSync(join(ZFS_FIXTURES, name), 'utf-8')
const N6_LOG = join(import.meta.dirname, '../../../../../docs/probes/wave3-node/out/n6-zpool-create.log')

/** The one `blkid -p` line of the n6 log (HOT21-part1, GPT name `zfs-<hex>`). */
function n6BlkidLine(): string {
  const line = readFileSync(N6_LOG, 'utf-8').split('\n').find(l => l.startsWith('/dev/disk/by-id/') && l.includes('PART_ENTRY_NAME='))
  assert.ok(line, 'the n6 capture carries a named blkid -p line')
  return `${line}\n`
}

describe('blkidPartEntryName (cr.57)', () => {
  it('reads the GPT name of the captured named partition', () => {
    assert.equal(blkidPartEntryName(n6BlkidLine()), 'zfs-be7977a25d6c0c32')
  })

  it('an unnamed partition (the captured blank, zfs-member and freed-spare lines) has none', () => {
    for (const f of ['blkid-p-blank-partition.txt', 'blkid-p-zfs-member-partition.txt', 'blkid-p-freed-spare-partition.txt'])
      assert.equal(blkidPartEntryName(capture(f)), null, f)
  })

  it('empty output (blkid exit 2) has none', () => {
    assert.equal(blkidPartEntryName(''), null)
  })
})

describe('blkidContentSignatures', () => {
  it('the GPT name is not content: the captured named blank partition is blank', () => {
    assert.deepEqual(blkidContentSignatures(n6BlkidLine()), [])
  })

  it('a ZFS leaf is content (captured)', () => {
    assert.ok(blkidContentSignatures(capture('blkid-p-zfs-member-partition.txt')).includes('TYPE=zfs_member'))
  })
})
