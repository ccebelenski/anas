import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  btrfsSubvolListReadonlyArgs,
  btrfsSubvolListSnapshotsArgs,
  otimeToIso,
  parseBtrfsSubvolList,
} from '../btrfs-subvol-list.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('btrfs subvolume list args', () => {
  it('builds the -s (snapshot) and -r (readonly) argv against a path', () => {
    assert.deepEqual(btrfsSubvolListSnapshotsArgs('/run/x'), ['subvolume', 'list', '-s', '/run/x'])
    assert.deepEqual(btrfsSubvolListReadonlyArgs('/run/x'), ['subvolume', 'list', '-r', '/run/x'])
  })
})

describe('parseBtrfsSubvolList', () => {
  it('parses the -s form with cgen + otime + path (real btrfs-progs 6.14 capture)', () => {
    const subs = parseBtrfsSubvolList(loadFixture('btrfs-subvol-list-s.txt'))
    assert.equal(subs.length, 3)
    assert.deepEqual(subs[0], {
      id: 258,
      gen: 16,
      cgen: 12,
      // Real snapshots sit under @snapshots (id 257) — top level is NOT 5.
      topLevel: 257,
      otime: '2026-07-23 23:52:50',
      path: '@snapshots/2026-07-23T235250Z',
    })
    assert.equal(subs[1].path, '@snapshots/before-upgrade')
    // Post-rollback the new writable @data is itself a snapshot (top level 5).
    assert.equal(subs[2].path, '@data')
    assert.equal(subs[2].otime, '2026-07-23 23:54:07')
  })

  it('parses the -r form (no cgen/otime column) — the readonly set', () => {
    const subs = parseBtrfsSubvolList(loadFixture('btrfs-subvol-list-r.txt'))
    const paths = subs.map(s => s.path)
    assert.deepEqual(paths, ['@snapshots/2026-07-23T235250Z', '@snapshots/before-upgrade'])
    // -r carries no otime/cgen.
    assert.equal(subs[0].cgen, null)
    assert.equal(subs[0].otime, null)
  })

  it('parses a subvol-layout listing incl. @data / @snapshots + a writable pre-rollback', () => {
    const subs = parseBtrfsSubvolList(loadFixture('btrfs-subvol-list-layout.txt'))
    const paths = subs.map(s => s.path)
    assert.ok(paths.includes('@data'))
    assert.ok(paths.includes('@snapshots'))
    assert.ok(paths.includes('@snapshots/2026-07-23T235250Z'))
    // The plain list is the ONLY place the writable pre-rollback preserve shows
    // (it is absent from `-s`) — the membership source listAhrSnapshots relies on.
    assert.ok(paths.includes('@snapshots/pre-rollback-2026-07-23T235407Z'))
  })

  it('an empty (flat-layout) listing parses to nothing, never throws', () => {
    assert.deepEqual(parseBtrfsSubvolList(loadFixture('btrfs-subvol-list-flat.txt')), [])
  })

  it('skips non-ID and malformed lines rather than throwing', () => {
    const subs = parseBtrfsSubvolList('garbage\nID 258 gen 42 top level 5 path @snapshots/x\nID not-a-number\n')
    assert.equal(subs.length, 1)
    assert.equal(subs[0].path, '@snapshots/x')
  })
})

describe('otimeToIso', () => {
  it('renders btrfs otime as ISO-8601 local (no timezone), null passes through', () => {
    assert.equal(otimeToIso('2026-07-23 14:23:01'), '2026-07-23T14:23:01')
    assert.equal(otimeToIso(null), null)
  })
})
