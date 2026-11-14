import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseTreeList, parseTreeProps, parseTreeSnapshots, zfsTreeGetArgs, zfsTreeSnapshotsArgs } from '../zfs-tree.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/zfs/replication-tree')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/** The two recursive snapshots of the captured tree (fixture README: S1, S2). */
const S1 = 'anas-daily-2026-11-13_01.00.00--1d'
const S2 = 'anas-daily-2026-11-14_01.00.00--1d'

describe('parseTreeList — zfs list -H -o name -r (fixture src-tree.txt)', () => {
  it('keeps the listing order exactly: root first, parents before children', () => {
    assert.deepEqual(parseTreeList(loadFixture('src-tree.txt')), [
      'rpool/rrsrc',
      'rpool/rrsrc/a',
      'rpool/rrsrc/a/deep',
      'rpool/rrsrc/enc',
      'rpool/rrsrc/late',
      'rpool/rrsrc/new',
      'rpool/rrsrc/skipme',
      'rpool/rrsrc/vol',
    ])
  })

  it('the target tree parses too, targetonly included', () => {
    assert.deepEqual(parseTreeList(loadFixture('dst-tree.txt')), [
      'datapool/rrdst',
      'datapool/rrdst/a',
      'datapool/rrdst/a/deep',
      'datapool/rrdst/enc',
      'datapool/rrdst/targetonly',
      'datapool/rrdst/vol',
    ])
  })

  it('empty stdout is an empty listing (a dataset with no children lists only itself; "" = nothing there)', () => {
    assert.deepEqual(parseTreeList(''), [])
    assert.deepEqual(parseTreeList('\n'), [])
  })

  it('a line with a tab is unreadable and throws with the line quoted (never "nothing there")', () => {
    assert.throws(() => parseTreeList('rpool/rrsrc\textra\n'), /Unreadable zfs tree listing line: 'rpool\/rrsrc\textra'/)
  })
})

describe('parseTreeSnapshots — zfs list -Hp -t snapshot -o name,creation,guid -r (fixture src-snaps-p.txt)', () => {
  it('maps the source tree exactly: every dataset newest-first, new alone, late absent', () => {
    const got = parseTreeSnapshots(loadFixture('src-snaps-p.txt'))
    assert.deepEqual(got, new Map<string, string[]>([
      ['rpool/rrsrc', [S2, S1]],
      ['rpool/rrsrc/a', [S2, S1]],
      ['rpool/rrsrc/a/deep', [S2, S1]],
      ['rpool/rrsrc/enc', [S2, S1]],
      ['rpool/rrsrc/new', [S2]],
      ['rpool/rrsrc/skipme', [S2, S1]],
      ['rpool/rrsrc/vol', [S2, S1]],
    ]))
  })

  it('rpool/rrsrc/new has EXACTLY one snapshot; rpool/rrsrc/late has no key at all', () => {
    const got = parseTreeSnapshots(loadFixture('src-snaps-p.txt'))
    assert.deepEqual(got.get('rpool/rrsrc/new'), [S2])
    assert.equal(got.has('rpool/rrsrc/late'), false)
  })

  it('every other dataset lists the 11-14 name first (creation epoch orders, not listing order)', () => {
    const got = parseTreeSnapshots(loadFixture('src-snaps-p.txt'))
    for (const [dataset, names] of got)
      assert.equal(names[0], S2, dataset)
  })

  it('the target tree: only the 11-13 name, on the five received datasets', () => {
    assert.deepEqual(parseTreeSnapshots(loadFixture('dst-snaps-p.txt')), new Map<string, string[]>([
      ['datapool/rrdst', [S1]],
      ['datapool/rrdst/a', [S1]],
      ['datapool/rrdst/a/deep', [S1]],
      ['datapool/rrdst/enc', [S1]],
      ['datapool/rrdst/vol', [S1]],
    ]))
  })

  it('two snapshots of one dataset sharing an epoch keep the listing order: the LATER line is the newer one, so it comes first', () => {
    const tied = 'tank/a@earlier-line\t100\t1\ntank/a@later-line\t100\t2\n'
    assert.deepEqual(parseTreeSnapshots(tied).get('tank/a'), ['later-line', 'earlier-line'])
  })

  it('empty stdout gives an empty map (a dataset with no snapshots exits 0 with empty stdout)', () => {
    assert.equal(parseTreeSnapshots('').size, 0)
  })

  it('a short line or a non-numeric creation throws with the line quoted', () => {
    assert.throws(
      () => parseTreeSnapshots('tank/a@s\t100\n'),
      /Unreadable zfs snapshot listing line: 'tank\/a@s\t100'/,
    )
    assert.throws(
      () => parseTreeSnapshots('tank/a@s\tJan 1 00:00\t1\n'),
      /Unreadable zfs snapshot listing line: 'tank\/a@s\tJan 1 00:00\t1'/,
    )
    assert.throws(() => parseTreeSnapshots('tank/a\n'), /Unreadable zfs snapshot listing/)
  })
})

describe('parseTreeProps — zfs get -Hp -r -o name,property,value (fixtures src-keystatus.txt, dst-written.txt)', () => {
  it('keystatus + encryptionroot map exactly: enc is the only encrypted row', () => {
    assert.deepEqual(parseTreeProps(loadFixture('src-keystatus.txt')), new Map<string, Record<string, string>>([
      ['rpool/rrsrc', { keystatus: '-', encryptionroot: '-' }],
      ['rpool/rrsrc/a', { keystatus: '-', encryptionroot: '-' }],
      ['rpool/rrsrc/a/deep', { keystatus: '-', encryptionroot: '-' }],
      ['rpool/rrsrc/enc', { keystatus: 'available', encryptionroot: 'rpool/rrsrc/enc' }],
      ['rpool/rrsrc/late', { keystatus: '-', encryptionroot: '-' }],
      ['rpool/rrsrc/new', { keystatus: '-', encryptionroot: '-' }],
      ['rpool/rrsrc/skipme', { keystatus: '-', encryptionroot: '-' }],
      ['rpool/rrsrc/vol', { keystatus: '-', encryptionroot: '-' }],
    ]))
  })

  it('after zfs unload-key: rpool/rrsrc/enc keystatus is unavailable', () => {
    const got = parseTreeProps(loadFixture('src-keystatus-unloaded.txt'))
    assert.equal(got.get('rpool/rrsrc/enc')?.keystatus, 'unavailable')
    assert.equal(got.get('rpool/rrsrc')?.keystatus, '-')
  })

  it('written stays a printed STRING: datapool/rrdst/targetonly is 24576, everything else 0', () => {
    const got = parseTreeProps(loadFixture('dst-written.txt'))
    assert.equal(got.get('datapool/rrdst/targetonly')?.written, '24576')
    assert.equal(got.get('datapool/rrdst')?.written, '0')
    assert.equal(got.get('datapool/rrdst/enc')?.written, '0')
    assert.equal(got.get('datapool/rrdst/vol')?.readonly, 'on')
  })

  it('empty stdout gives an empty map', () => {
    assert.equal(parseTreeProps('').size, 0)
  })

  it('a short line throws with the line quoted', () => {
    assert.throws(
      () => parseTreeProps('datapool/rrdst\twritten\n'),
      /Unreadable zfs property listing line: 'datapool\/rrdst\twritten'/,
    )
  })
})

describe('tree-listing argv builders', () => {
  it('zfsTreeSnapshotsArgs: -Hp snapshot listing with name,creation,guid', () => {
    assert.deepEqual(zfsTreeSnapshotsArgs('rpool/rrsrc'), ['list', '-Hp', '-t', 'snapshot', '-o', 'name,creation,guid', '-r', '--', 'rpool/rrsrc'])
  })

  it('zfsTreeGetArgs: -Hp property listing, the requested props joined', () => {
    assert.deepEqual(zfsTreeGetArgs('datapool/rrdst', ['written']), ['get', '-Hp', '-r', '-t', 'filesystem,volume', '-o', 'name,property,value', 'written', '--', 'datapool/rrdst'])
    assert.deepEqual(zfsTreeGetArgs('rpool/rrsrc', ['keystatus', 'encryptionroot'])[7], 'keystatus,encryptionroot')
  })
})

// Review of rrep.1a (constructed lines): each of these returned a quietly
// wrong value. RULE: a line `zfs -H` would not print is unreadable, never data.
describe('lines zfs would not print are refused, not read', () => {
  it('a carriage return anywhere throws in all three parsers', () => {
    assert.throws(() => parseTreeList('tank\r\ntank/a\r\n'), /Unreadable zfs tree listing line/)
    assert.throws(() => parseTreeSnapshots('tank@s1\t100\t1\r\n'), /Unreadable zfs snapshot listing line/)
    assert.throws(() => parseTreeProps('tank\twritten\t0\r\n'), /Unreadable zfs property listing line/)
  })

  it('an empty or non-digit creation is unreadable, not epoch 0', () => {
    assert.throws(() => parseTreeSnapshots('tank@s1\t\t1\n'), /Unreadable zfs snapshot listing line/)
    assert.throws(() => parseTreeSnapshots('tank@s1\t1e3\t1\n'), /Unreadable zfs snapshot listing line/)
    assert.throws(() => parseTreeSnapshots('tank@s1\t-5\t1\n'), /Unreadable zfs snapshot listing line/)
  })

  it('a repeated dataset, snapshot or property row is unreadable', () => {
    assert.throws(() => parseTreeList('tank\ntank/a\ntank\n'), /Unreadable zfs tree listing line/)
    assert.throws(() => parseTreeSnapshots('tank@s1\t100\t1\ntank@s1\t200\t1\n'), /Unreadable zfs snapshot listing line/)
    assert.throws(() => parseTreeProps('tank\twritten\t0\ntank\twritten\t5\n'), /Unreadable zfs property listing line/)
  })
})
