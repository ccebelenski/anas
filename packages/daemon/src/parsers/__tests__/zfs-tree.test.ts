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
    // The message shows the carriage return; it never carries one.
    assert.throws(() => parseTreeList('tank\r\n'), (err: Error) => err.message === 'Unreadable zfs tree listing line: \'tank\\x0d\'')
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

// The monkey on the keyboard (operator, 2026-11-14): random listings. The
// property for each parser: it either refuses the listing BY NAME
// ("Unreadable ... line") or what it returns accounts for every non-empty
// line exactly once — it never half-reads. Seeded; a failure prints the seed.
describe('random listings are refused or fully accounted for (seeded)', () => {
  const SEED = 0x5EED_0084
  function rng(seed: number): () => number {
    let state = seed
    return () => {
      // mulberry32
      state = (state + 0x6D2B79F5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const POOL = [...'abzAZ09_-.:/@', '\t', '\t', '\n', '\n', ' ', '\r', '1', '7', '', 'é', '\0', '-', '@', '@']
  const pick = <T>(next: () => number, from: readonly T[]): T => from[Math.floor(next() * from.length)] as T
  const NAMES = ['tank', 'tank/a', 'tank/a b', 'tank/-x', 'p/q/r'] as const
  const SNAPS = ['s1', 's 2', '-x', 'anas-daily-2026-11-13_01.00.00--1d', ''] as const
  const NUMS = ['0', '17', '1794618281', '', '-5', '1e3'] as const
  const PROPS = ['written', 'keystatus', ''] as const
  /**
   * Half the listings are pure noise; the other half are built from lines of
   * the right SHAPE for the parser (so the accept side is exercised: measured,
   * a pure-noise generator produced one accepted snapshot listing in 4000),
   * then hit with a few random character edits.
   */
  function listing(next: () => number, shape: 'list' | 'snaps' | 'props'): string {
    let s = ''
    if (next() < 0.5) {
      const len = Math.floor(next() * 60)
      for (let i = 0; i < len; i++)
        s += pick(next, POOL)
      return s
    }
    const rows = Math.floor(next() * 5)
    for (let i = 0; i < rows; i++) {
      if (shape === 'list')
        s += `${pick(next, NAMES)}\n`
      else if (shape === 'snaps')
        s += `${pick(next, NAMES)}@${pick(next, SNAPS)}\t${pick(next, NUMS)}\t${pick(next, NUMS)}\n`
      else
        s += `${pick(next, NAMES)}\t${pick(next, PROPS)}\t${pick(next, NUMS)}\n`
    }
    const edits = Math.floor(next() * 3)
    for (let i = 0; i < edits && s.length > 0; i++) {
      const at = Math.floor(next() * s.length)
      s = s.slice(0, at) + pick(next, POOL) + s.slice(at + 1)
    }
    return s
  }
  const DIGITS = /^\d+$/
  const UNREADABLE = /^Unreadable zfs (?:tree|snapshot|property) listing line/
  const nonEmptyLines = (s: string): string[] => s.split('\n').filter(l => l.length > 0)

  function attempt<T>(fn: () => T, input: string, i: number): T | undefined {
    try {
      return fn()
    }
    catch (err) {
      assert.match((err as Error).message, UNREADABLE, `seed ${SEED}, case ${i}: threw something else for ${JSON.stringify(input)}`)
      return undefined
    }
  }

  it('parseTreeList', () => {
    const next = rng(SEED)
    let accepted = 0
    for (let i = 0; i < 4000; i++) {
      const input = listing(next, 'list')
      const out = attempt(() => parseTreeList(input), input, i)
      if (out === undefined)
        continue
      accepted += out.length > 0 ? 1 : 0
      assert.deepEqual(out, nonEmptyLines(input), `seed ${SEED}, case ${i}: ${JSON.stringify(input)}`)
    }
    assert.ok(accepted > 100, `only ${accepted} non-empty listings were accepted: the generator went vacuous`)
  })

  it('parseTreeSnapshots', () => {
    const next = rng(SEED + 1)
    let accepted = 0
    for (let i = 0; i < 4000; i++) {
      const input = listing(next, 'snaps')
      const out = attempt(() => parseTreeSnapshots(input), input, i)
      if (out === undefined)
        continue
      // The shape an ACCEPTED listing must have, stated independently of the parser.
      for (const line of nonEmptyLines(input)) {
        const f = line.split('\t')
        assert.ok(f.length === 3 && DIGITS.test(f[1] as string) && !line.includes('\r'), `seed ${SEED + 1}, case ${i}: accepted ${JSON.stringify(line)}`)
      }
      const got = [...out].flatMap(([ds, names]) => names.map(n => `${ds}@${n}`)).sort()
      const want = nonEmptyLines(input).map(l => l.split('\t')[0]).sort()
      assert.deepEqual(got, want, `seed ${SEED + 1}, case ${i}: ${JSON.stringify(input)}`)
      accepted += got.length > 0 ? 1 : 0
    }
    assert.ok(accepted > 100, `only ${accepted} non-empty listings were accepted: the generator went vacuous`)
  })

  it('parseTreeProps', () => {
    const next = rng(SEED + 2)
    let accepted = 0
    for (let i = 0; i < 4000; i++) {
      const input = listing(next, 'props')
      const out = attempt(() => parseTreeProps(input), input, i)
      if (out === undefined)
        continue
      for (const line of nonEmptyLines(input)) {
        const f = line.split('\t')
        assert.ok(f.length === 3 && f[0] !== '' && f[1] !== '' && !line.includes('\r'), `seed ${SEED + 2}, case ${i}: accepted ${JSON.stringify(line)}`)
      }
      const got = [...out].flatMap(([ds, row]) => Object.entries(row).map(([k, v]) => `${ds}\t${k}\t${v}`)).sort()
      assert.deepEqual(got, nonEmptyLines(input).sort(), `seed ${SEED + 2}, case ${i}: ${JSON.stringify(input)}`)
      accepted += got.length > 0 ? 1 : 0
    }
    assert.ok(accepted > 100, `only ${accepted} non-empty listings were accepted: the generator went vacuous`)
  })
})
