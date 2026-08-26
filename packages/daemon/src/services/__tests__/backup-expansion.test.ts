import type { BackupArchiveConsistency, BackupNestedEntry, BackupNestedScan } from '@anas/shared'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { expandedArchiveName } from '@anas/shared'
import { isSnapshottableChild, planExpansion, rebaseExcludes, snapshotRoot } from '../backup-expansion.js'

/**
 * backup2.3 — archive EXPANSION.
 *
 * The invariant every case here defends: the ROOT archive keeps its configured
 * name and the run keeps its `--backup-id`, because that pair is pbc's
 * change-detection identity (GT-47/48 — the live→snapshot switch reused 100% and
 * uploaded zero bytes precisely because neither moved).
 */

const SNAP = 'anas-backup-nightly-1756000000'

const ZFS: BackupArchiveConsistency = {
  consistency: 'snapshot',
  reason: 'on tank/media',
  backend: 'zfs',
  target: 'tank/media',
  mountpoint: '/tank/media',
  relativePath: '',
}

const ZFS_SUBDIR: BackupArchiveConsistency = { ...ZFS, relativePath: 'photos/raw' }

const AHR: BackupArchiveConsistency = {
  consistency: 'snapshot',
  reason: 'on AHR pool ahr1',
  backend: 'ahr',
  target: 'ahr1',
  mountpoint: '/mnt/ahr1',
  relativePath: '',
}

const LIVE: BackupArchiveConsistency = { consistency: 'live', reason: 'ext4' }

function entry(path: string, over: Partial<BackupNestedEntry> = {}): BackupNestedEntry {
  return {
    path,
    relativePath: path.replace(/^\/[^/]+\/[^/]+\//, ''),
    kind: 'dataset',
    included: true,
    ...over,
  }
}

function scan(path: string, nested: BackupNestedEntry[]): BackupNestedScan {
  return { path, exists: true, includeNested: 'all', nested, truncated: false, warnings: [] }
}

describe('backup expansion — deterministic archive roots (backup2.3)', () => {
  it('the ZFS root archive keeps its NAME and points at .zfs/snapshot', () => {
    const plan = planExpansion({
      archive: { name: 'media', path: '/tank/media', excludes: [] },
      consistency: ZFS,
      snapshot: SNAP,
    })
    assert.equal(plan.archives.length, 1)
    assert.equal(plan.archives[0].name, 'media')
    assert.equal(plan.archives[0].root, `/tank/media/.zfs/snapshot/${SNAP}`)
    assert.equal(plan.archives[0].relativePath, '')
  })

  it('a plain SUBDIRECTORY source lands under .zfs/snapshot/<s>/<relative>', () => {
    const root = snapshotRoot(ZFS_SUBDIR, SNAP)
    assert.equal(root, `/tank/media/.zfs/snapshot/${SNAP}/photos/raw`)
  })

  it('the AHR root archive points into the top-level mount\'s @snapshots', () => {
    const plan = planExpansion({
      archive: { name: 'share', path: '/mnt/ahr1', excludes: [] },
      consistency: AHR,
      snapshot: SNAP,
      topLevel: '/run/anas-ahr/ahr1.toplevel',
    })
    assert.equal(plan.archives[0].root, `/run/anas-ahr/ahr1.toplevel/@snapshots/${SNAP}`)
  })

  it('a LIVE archive expands into exactly itself — no snapshot path, no children', () => {
    const plan = planExpansion({
      archive: { name: 'etc', path: '/etc', excludes: ['/pve'] },
      consistency: LIVE,
      scan: scan('/etc', [entry('/etc/pve', { kind: 'pmxcfs' })]),
      snapshot: SNAP,
    })
    assert.deepEqual(plan.archives, [{ name: 'etc', from: 'etc', root: '/etc', relativePath: '', excludes: ['/pve'] }])
    assert.deepEqual(plan.warnings, [])
  })

  // ---- Children ----------------------------------------------------------

  it('an included ZFS child dataset becomes its OWN archive at its own .zfs/snapshot', () => {
    const plan = planExpansion({
      archive: { name: 'media', path: '/tank/media', excludes: [], includeNested: 'all' },
      consistency: ZFS,
      scan: scan('/tank/media', [entry('/tank/media/photos', { source: 'tank/media/photos' })]),
      snapshot: SNAP,
    })
    assert.deepEqual(plan.archives.map(a => a.name), ['media', 'media__photos'])
    assert.equal(plan.archives[1].root, `/tank/media/photos/.zfs/snapshot/${SNAP}`)
    assert.equal(plan.archives[1].from, 'media')
    assert.equal(plan.archives[1].relativePath, 'photos')
  })

  it('a child dataset from ANOTHER pool was not covered by our -r snapshot and is refused by name', () => {
    const plan = planExpansion({
      archive: { name: 'media', path: '/tank/media', excludes: [], includeNested: 'all' },
      consistency: ZFS,
      // `other/pool` is mounted underneath but is NOT a descendant of tank/media.
      scan: scan('/tank/media', [entry('/tank/media/guest', { source: 'other/guest' })]),
      snapshot: SNAP,
    })
    assert.deepEqual(plan.archives.map(a => a.name), ['media'])
    assert.equal(plan.warnings.length, 1)
    assert.match(plan.warnings[0], /NOT backed up by this run/)
  })

  it('a non-snapshottable nested mount under a snapshot root is NAMED, not silently dropped', () => {
    // GT: under `.zfs/snapshot/<s>/` the mountpoint is an empty directory, and
    // `--include-dev` there names no foreign device — nothing can reach the live
    // mount from a snapshot root, so the honest answer is a warning.
    const plan = planExpansion({
      archive: { name: 'media', path: '/tank/media', excludes: [], includeNested: 'all' },
      consistency: ZFS,
      scan: scan('/tank/media', [entry('/tank/media/nas', { kind: 'nfs', source: '10.0.0.9:/e' })]),
      snapshot: SNAP,
    })
    assert.deepEqual(plan.archives.map(a => a.name), ['media'])
    assert.match(plan.warnings[0], /empty directory/)
    assert.match(plan.warnings[0], /own archive/)
  })

  it('`includeNested: none` keeps exactly one archive — children are backup2.2\'s warning, not ours', () => {
    const plan = planExpansion({
      archive: { name: 'media', path: '/tank/media', excludes: [], includeNested: 'none' },
      consistency: ZFS,
      scan: {
        ...scan('/tank/media', [entry('/tank/media/photos', { source: 'tank/media/photos', included: false })]),
        includeNested: 'none',
      },
      snapshot: SNAP,
    })
    assert.deepEqual(plan.archives.map(a => a.name), ['media'])
    assert.deepEqual(plan.warnings, [])
  })

  it('AHR asks for ONE ro snapshot per nested subvolume (GT-52)', () => {
    const plan = planExpansion({
      archive: { name: 'share', path: '/mnt/ahr1', excludes: [], includeNested: 'all' },
      consistency: AHR,
      scan: scan('/mnt/ahr1', [
        entry('/mnt/ahr1/photos', { kind: 'subvolume', fstype: 'btrfs' }),
        entry('/mnt/ahr1/photos/sub', { kind: 'subvolume', fstype: 'btrfs' }),
      ]),
      snapshot: SNAP,
      topLevel: '/run/anas-ahr/ahr1.toplevel',
    })
    assert.deepEqual(plan.archives.map(a => a.name), ['share', 'share__photos', 'share__photos_sub'])
    assert.deepEqual(plan.ahrSubvolumeSnapshots, [
      { label: `${SNAP}__photos`, subvolume: 'photos' },
      { label: `${SNAP}__photos_sub`, subvolume: 'photos/sub' },
    ])
    assert.equal(plan.archives[2].root, `/run/anas-ahr/ahr1.toplevel/@snapshots/${SNAP}__photos_sub`)
  })

  // ---- Naming ------------------------------------------------------------

  it('derived names are `<name>__<path with / → _>` and stay in PBS\'s charset', () => {
    assert.equal(expandedArchiveName('data', 'photos'), 'data__photos')
    assert.equal(expandedArchiveName('data', 'photos/raw'), 'data__photos_raw')
    // `.` and any other character outside [A-Za-z0-9_-] is sanitised.
    assert.equal(expandedArchiveName('data', 'my photos/2024.raw'), 'data__my_photos_2024_raw')
    assert.match(expandedArchiveName('a.b', 'c d/e'), /^[\w-]+$/)
  })

  it('a derived name that collides is DE-DUPLICATED, deterministically', () => {
    const plan = planExpansion({
      archive: { name: 'd', path: '/tank/media', excludes: [], includeNested: 'all' },
      consistency: ZFS,
      scan: scan('/tank/media', [
        // Both sanitise to `d__a_b`.
        entry('/tank/media/a/b', { source: 'tank/media/a/b' }),
        entry('/tank/media/a b', { source: 'tank/media/ab2' }),
      ]),
      snapshot: SNAP,
    })
    const names = plan.archives.map(a => a.name)
    assert.deepEqual(names, ['d', 'd__a_b', 'd__a_b-2'])
    assert.equal(new Set(names).size, names.length)
  })

  it('a child can never steal the ROOT archive\'s name', () => {
    const plan = planExpansion({
      archive: { name: 'd__x', path: '/tank/media', excludes: [], includeNested: 'all' },
      consistency: ZFS,
      scan: scan('/tank/media', [entry('/tank/media/x', { source: 'tank/media/x' })]),
      snapshot: SNAP,
    })
    assert.equal(plan.archives[0].name, 'd__x')
    assert.notEqual(plan.archives[1].name, 'd__x')
  })

  it('isSnapshottableChild keys on the BACKEND, not on wishful thinking', () => {
    assert.equal(isSnapshottableChild(entry('/tank/media/p', { source: 'tank/media/p' }), ZFS), true)
    assert.equal(isSnapshottableChild(entry('/tank/media/p', { source: 'tank2/p' }), ZFS), false)
    assert.equal(isSnapshottableChild(entry('/tank/media/p', { kind: 'nfs' }), ZFS), false)
    assert.equal(isSnapshottableChild(entry('/mnt/ahr1/p', { kind: 'subvolume' }), AHR), true)
    assert.equal(isSnapshottableChild(entry('/mnt/ahr1/p', { kind: 'local' }), AHR), false)
    assert.equal(isSnapshottableChild(entry('/x/p'), LIVE), false)
  })

  // ---- Excludes ----------------------------------------------------------

  it('an ANCHORED exclude inside a child root is REBASED onto that child', () => {
    const out = rebaseExcludes('/tank/media', ['/photos/tmp'], [
      { name: 'media', livePath: '/tank/media' },
      { name: 'media__photos', livePath: '/tank/media/photos' },
    ])
    assert.deepEqual(out.byName.media, [])
    assert.deepEqual(out.byName.media__photos, ['/tmp'])
    assert.match(out.warnings[0], /per invocation/)
  })

  it('the DEEPEST containing root owns an anchored exclude', () => {
    const out = rebaseExcludes('/tank/media', ['/a/b/c'], [
      { name: 'root', livePath: '/tank/media' },
      { name: 'a', livePath: '/tank/media/a' },
      { name: 'ab', livePath: '/tank/media/a/b' },
    ])
    assert.deepEqual(out.byName.ab, ['/c'])
    assert.deepEqual(out.byName.a, [])
    assert.deepEqual(out.byName.root, [])
  })

  it('an anchored exclude with no child root stays on the root, unchanged', () => {
    const out = rebaseExcludes('/tank/media', ['/cache'], [
      { name: 'media', livePath: '/tank/media' },
      { name: 'media__photos', livePath: '/tank/media/photos' },
    ])
    assert.deepEqual(out.byName.media, ['/cache'])
    assert.deepEqual(out.byName.media__photos, [])
    assert.deepEqual(out.warnings, [])
  })

  it('an UNANCHORED exclude matches at any depth, so every root gets it verbatim', () => {
    const out = rebaseExcludes('/tank/media', ['**/*.tmp', 'cache'], [
      { name: 'media', livePath: '/tank/media' },
      { name: 'media__photos', livePath: '/tank/media/photos' },
    ])
    assert.deepEqual(out.byName.media, ['**/*.tmp', 'cache'])
    assert.deepEqual(out.byName.media__photos, ['**/*.tmp', 'cache'])
    assert.deepEqual(out.warnings, [])
  })

  it('planExpansion applies the rebasing to the roots it produced', () => {
    const plan = planExpansion({
      archive: {
        name: 'media',
        path: '/tank/media',
        excludes: ['/photos/thumbs', '/cache', '*.tmp'],
        includeNested: 'all',
      },
      consistency: ZFS,
      scan: scan('/tank/media', [entry('/tank/media/photos', { source: 'tank/media/photos' })]),
      snapshot: SNAP,
    })
    assert.deepEqual(plan.archives[0].excludes, ['/cache', '*.tmp'])
    assert.deepEqual(plan.archives[1].excludes, ['/thumbs', '*.tmp'])
  })
})

/**
 * backup2.4 — an `img` archive never expands. A block image is one object: no
 * nested filesystems, no excludes (the schema refuses both), and exactly one
 * root whether the run is live or snapshot-consistent.
 */
describe('backup expansion — block images (backup2.4)', () => {
  const ZVOL: BackupArchiveConsistency = {
    consistency: 'snapshot',
    reason: 'the ZFS volume tank/vol1',
    backend: 'zfs',
    target: 'tank/vol1',
    zvolDevice: '/dev/zvol/tank/vol1',
  }

  it('a zvol image root is the snapshot DEVICE, not a .zfs/snapshot path', () => {
    assert.equal(snapshotRoot(ZVOL, SNAP), `/dev/zvol/tank/vol1@${SNAP}`)
  })

  it('a zvol plan is exactly one root, named `img`, with no excludes', () => {
    const plan = planExpansion({
      archive: { name: 'lun0', path: '/dev/zvol/tank/vol1', excludes: [], kind: 'img' },
      consistency: ZVOL,
      snapshot: SNAP,
    })
    assert.deepEqual(plan.archives, [{
      name: 'lun0',
      from: 'lun0',
      root: `/dev/zvol/tank/vol1@${SNAP}`,
      relativePath: '',
      excludes: [],
      kind: 'img',
    }])
    assert.deepEqual(plan.warnings, [])
    assert.deepEqual(plan.ahrSubvolumeSnapshots, [])
  })

  it('an image FILE on a dataset takes the .zfs/snapshot root, still one archive', () => {
    const plan = planExpansion({
      archive: { name: 'lun0', path: '/tank/media/images/lun.raw', excludes: [], kind: 'img' },
      consistency: { ...ZFS, relativePath: 'images/lun.raw' },
      snapshot: SNAP,
    })
    assert.equal(plan.archives.length, 1)
    assert.equal(plan.archives[0].root, `/tank/media/.zfs/snapshot/${SNAP}/images/lun.raw`)
    assert.equal(plan.archives[0].kind, 'img')
  })

  it('an image never expands, even when a scan somehow reports nested entries', () => {
    const plan = planExpansion({
      archive: { name: 'lun0', path: '/tank/media/images/lun.raw', excludes: [], kind: 'img' },
      consistency: { ...ZFS, relativePath: 'images/lun.raw' },
      scan: scan('/tank/media/images/lun.raw', [entry('/tank/media/images/lun.raw/child')]),
      snapshot: SNAP,
    })
    assert.equal(plan.archives.length, 1)
  })

  it('a LIVE image is read where it is, and still carries its kind', () => {
    const plan = planExpansion({
      archive: { name: 'lun0', path: '/dev/sdb', excludes: [], kind: 'img' },
      consistency: LIVE,
      snapshot: SNAP,
    })
    assert.deepEqual(plan.archives, [{
      name: 'lun0',
      from: 'lun0',
      root: '/dev/sdb',
      relativePath: '',
      excludes: [],
      kind: 'img',
    }])
  })

  it('a pxar archive still carries NO kind key at all (version skew: absent = pxar)', () => {
    const plan = planExpansion({
      archive: { name: 'media', path: '/tank/media', excludes: [] },
      consistency: ZFS,
      snapshot: SNAP,
    })
    assert.equal('kind' in plan.archives[0], false, JSON.stringify(plan.archives[0]))
  })
})
