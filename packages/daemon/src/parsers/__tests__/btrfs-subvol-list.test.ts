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
  subvolumesBelowMount,
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

/**
 * cr3.nodefix D2 (second cr3 node pass): which listed subvolumes lie BELOW a
 * btrfs mount, and where. Two CAPTURES, two mount shapes:
 *  - `ahr/btrfs-subvol-list-nested-mounted.txt` (anas-pve, btrfs-progs 6.14):
 *    an AHR pool mounted the way ANAS mounts it (`subvol=/@data`); the
 *    subvolumes below `@data` print RELATIVE TO THE MOUNTED ONE (`sv`,
 *    `plain/sv2`, `sv/deep`), its siblings from the top level (`@data`,
 *    `@snapshots`);
 *  - `backup/btrfs-nested-subvol.txt` (backup2.1, btrfs-progs 6.14): a
 *    TOP-LEVEL mount (`subvol=/`), where everything prints from the top level
 *    (`@data`, `@data/photos`, `snap1`).
 * The old consumers assumed the second shape everywhere (`@data/<sub>`), so on
 * a real AHR mount they placed no nested subvolume at all.
 */
describe('subvolumesBelowMount — both captured mount shapes (cr3.nodefix D2)', () => {
  /** The output of `### $ <cmd>` in a capture file, up to its `### exit=` line. */
  function block(text: string, cmd: string): string {
    const lines = text.split('\n')
    const at = lines.indexOf(`### $ ${cmd}`)
    assert.ok(at >= 0, `the capture holds \`${cmd}\``)
    const end = lines.findIndex((l, i) => i > at && l.startsWith('### exit='))
    return lines.slice(at + 1, end).map(l => `${l}\n`).join('')
  }
  const NESTED = loadFixture('btrfs-subvol-list-nested-mounted.txt')
  const TOP = readFileSync(join(__dirname, '../../fixtures/backup/btrfs-nested-subvol.txt'), 'utf-8')
  /** The captured findmnt line of the AHR mount: TARGET SOURCE FSTYPE OPTIONS. */
  const [target, , , options] = block(NESTED, 'findmnt -n -o TARGET,SOURCE,FSTYPE,OPTIONS /mnt/anas-ahr/n2ahr').trim().split(' ')
  const ahrMount = { target, options }
  const ahrList = block(NESTED, 'btrfs subvolume list /mnt/anas-ahr/n2ahr')
  /** The captured `findmnt -R` row of the top-level mount (TARGET SOURCE FSTYPE OPTIONS, header dropped). */
  const topRow = block(TOP, 'findmnt -R /mnt/gtbtrfs -o TARGET,SOURCE,FSTYPE,OPTIONS').trim().split('\n')[1].trim().split(/\s+/)
  const topMount = { target: topRow[0], options: topRow[3] }
  const topList = block(TOP, 'btrfs subvolume list /mnt/gtbtrfs').split('### exit=')[0]

  it('the captures are the shapes this block says they are', () => {
    assert.equal(ahrMount.target, '/mnt/anas-ahr/n2ahr')
    assert.match(ahrMount.options, /(?:^|,)subvolid=256,subvol=\/@data$/)
    assert.deepEqual(parseBtrfsSubvolList(ahrList).map(s => s.path), ['@data', '@snapshots', 'sv', 'plain/sv2', 'sv/deep'])
    assert.equal(topMount.target, '/mnt/gtbtrfs')
    assert.match(topMount.options, /subvolid=5,subvol=\/$/)
    assert.deepEqual(parseBtrfsSubvolList(topList).map(s => s.path), ['@data', '@data/photos'])
  })

  it('RED: on the AHR mount (subvol=/@data) every nested subvolume is placed under the mount, @data and @snapshots are not', () => {
    assert.deepEqual(subvolumesBelowMount(ahrList, ahrMount), { below: [
      { path: '/mnt/anas-ahr/n2ahr/sv', subvol: '@data/sv' },
      { path: '/mnt/anas-ahr/n2ahr/plain/sv2', subvol: '@data/plain/sv2' },
      { path: '/mnt/anas-ahr/n2ahr/sv/deep', subvol: '@data/sv/deep' },
    ] })
  })

  it('on a top-level mount (subvol=/) every subvolume is below it, from the top level', () => {
    assert.deepEqual(subvolumesBelowMount(topList, topMount), { below: [
      { path: '/mnt/gtbtrfs/@data', subvol: '@data' },
      { path: '/mnt/gtbtrfs/@data/photos', subvol: '@data/photos' },
    ] })
  })

  it('a mount row without subvolid= finds its subvolume by the subvol= path', () => {
    const noId = { target: ahrMount.target, options: 'rw,relatime,subvol=/@data' }
    assert.deepEqual(subvolumesBelowMount(ahrList, noId), subvolumesBelowMount(ahrList, ahrMount))
  })

  it('a list it cannot place is a failed read, never "no nested subvolumes"', () => {
    // An unreadable line; the mounted subvolume missing (an empty list included);
    // a subvolume under a parent the list does not hold.
    // Review R2: the unreadable line is named, with what to do (pin moved: was the bare 'answered lines it could not read').
    assert.deepEqual(subvolumesBelowMount(`${ahrList}ERROR: odd\n`, ahrMount), { problem: `answered lines it could not read ("ERROR: odd"): a subvolume with a line break in its name makes the list unreadable; rename or delete it (find '/mnt/anas-ahr/n2ahr' -inum 256 -name '*[[:cntrl:]]*' lists them)` })
    assert.deepEqual(subvolumesBelowMount('', ahrMount), { problem: 'did not list the mounted subvolume \'@data\' itself' })
    const orphan = ahrList.split('\n').filter(l => !l.includes('path sv\n') && !l.endsWith('path sv')).join('\n')
    assert.deepEqual(subvolumesBelowMount(orphan, ahrMount), { problem: 'listed subvolume 264 (\'sv/deep\') under subvolume 262, which it did not list' })
  })
})
