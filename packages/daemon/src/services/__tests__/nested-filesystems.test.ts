import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import {
  buildWalkArgs,
  DEFAULT_NESTED_MAX_DEPTH,
  isZfsSnapshotMount,
  kindOfMount,
  mountIndex,
  nestedRunWarnings,
  normalizePath,
  parseSubvolumeShow,
  parseWalk,
  prunePathsUnder,
  relativeTo,
  resolveNestedIncludes,
  scanArchives,
  scanNestedFilesystems,
} from '../nested-filesystems.js'

/**
 * backup2.2 — nested-filesystem detection.
 *
 * The fake filesystem root is the REAL capture from the stunt node
 * (`fixtures/backup/nested-filesystems.txt` + `findmnt-nested.json`): the same
 * `findmnt --json` tree and the same `find -xdev -printf '%D\t%p\n'` rows the
 * node actually produced, replayed through the MockExecutor. Synthetic trees are
 * used only for shapes the node could not be asked for read-only (a live btrfs,
 * a dead NFS mount).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/backup')
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

const FIND = '/usr/bin/find'
const FINDMNT = '/usr/bin/findmnt'
const BTRFS = '/usr/bin/btrfs'
const TIMEOUT = '/usr/bin/timeout'

const REAL_FINDMNT = fixture('findmnt-nested.json')

/** REAL rows: `find -P /gtbackup -xdev -maxdepth 8 -type d -printf '%D\t%p\n'`. */
const REAL_WALK_GTBACKUP = [
  '46\t/gtbackup',
  '46\t/gtbackup/images',
  '49\t/gtbackup/cdm',
  '46\t/gtbackup/data',
  '46\t/gtbackup/data/empty',
  '46\t/gtbackup/data/sub',
  '46\t/gtbackup/data/sub/deep',
  '46\t/gtbackup/data/docs',
  '',
].join('\n')

/** REAL rows for /etc, trimmed to the root plus the one foreign device. */
const REAL_WALK_ETC = ['2049\t/etc', '2049\t/etc/skel', '55\t/etc/pve', ''].join('\n')

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

/** A mock wired with the real findmnt tree plus a chosen walk result. */
function makeExecutor(walk: ExecResult, findmnt = REAL_FINDMNT): MockExecutor {
  const ex = new MockExecutor()
  ex.addFixture({ command: FINDMNT, args: ['--json'], result: ok(findmnt) })
  ex.addFixture({ command: TIMEOUT, result: walk })
  return ex
}

// ---------------------------------------------------------------------------

describe('nested filesystems — pure helpers', () => {
  it('normalizePath / relativeTo produce the archive-relative form pbc quotes', () => {
    assert.equal(normalizePath('/etc/'), '/etc')
    assert.equal(normalizePath('/'), '/')
    assert.equal(normalizePath('///'), '/')
    // GT-54: `skipping mount point: "photos"` is relative to the archive root.
    assert.equal(relativeTo('/mnt/gtbtrfs/@data', '/mnt/gtbtrfs/@data/photos'), 'photos')
    assert.equal(relativeTo('/etc', '/etc/pve'), 'pve')
    assert.equal(relativeTo('/', '/etc/pve'), 'etc/pve')
    assert.equal(relativeTo('/etc', '/etc'), '')
  })

  it('the walk argv is symlink-free, directory-only, device-bounded and depth-capped', () => {
    const args = buildWalkArgs('/gtbackup/', ['/mnt/remote'], 8)
    assert.deepEqual(args, [
      '-P',
      '/gtbackup',
      '-xdev',
      '-maxdepth',
      '8',
      '(',
      '-name',
      '.zfs',
      '-o',
      '-path',
      '/mnt/remote',
      ')',
      '-prune',
      '-o',
      '-type',
      'd',
      '-printf',
      '%D\\t%p\\n',
    ])
    // -P (never follow a symlink) comes FIRST, before the path — find requires it.
    assert.equal(args[0], '-P')
    // The walk never stats a file: only directories are matched.
    assert.ok(args.includes('-type') && args[args.indexOf('-type') + 1] === 'd')
  })

  it('parseWalk reads the REAL `%D\\t%p` rows and drops anything malformed', () => {
    const rows = parseWalk(`${REAL_WALK_GTBACKUP}not a row\nxx\t/nope\n`)
    assert.deepEqual(rows[0], { dev: 46, path: '/gtbackup' })
    assert.deepEqual(rows[2], { dev: 49, path: '/gtbackup/cdm' })
    assert.equal(rows.length, 8, 'the two malformed lines are dropped')
  })

  it('a `.zfs/snapshot/<s>` automount is recognised and excluded (GT-51)', () => {
    assert.ok(isZfsSnapshotMount({
      target: '/gtbackup/cdm/.zfs/snapshot/s1',
      source: 'gtbackup/cdm@s1',
      fstype: 'zfs',
      options: 'ro,relatime',
    }))
    assert.ok(!isZfsSnapshotMount({ target: '/gtbackup/cdm', source: 'gtbackup/cdm', fstype: 'zfs', options: 'rw' }))
    // The index drops it outright, so it can never be named as a nested dataset.
    const idx = mountIndex(JSON.stringify({
      filesystems: [
        { target: '/gtbackup/cdm', source: 'gtbackup/cdm', fstype: 'zfs', options: 'rw' },
        { target: '/gtbackup/cdm/.zfs/snapshot/s1', source: 'gtbackup/cdm@s1', fstype: 'zfs', options: 'ro' },
      ],
    }))
    assert.ok(idx.has('/gtbackup/cdm'))
    assert.ok(!idx.has('/gtbackup/cdm/.zfs/snapshot/s1'))
  })

  it('kindOfMount names each family, and /etc/pve is pmxcfs (the product example)', () => {
    const k = (fstype: string, target = '/x', source = '') => kindOfMount({ target, source, fstype, options: '' })
    assert.equal(k('zfs', '/gtbackup/cdm', 'gtbackup/cdm'), 'dataset')
    assert.equal(k('btrfs'), 'subvolume')
    assert.equal(k('nfs4'), 'nfs')
    assert.equal(k('cifs'), 'cifs')
    assert.equal(k('smb3'), 'cifs')
    // An armed automount is ARMED, never 'local' (the mounts-family rule, #35).
    assert.equal(k('autofs', '/mnt/media', 'systemd-1'), 'automount')
    assert.equal(k('fuse', '/etc/pve', '/dev/fuse'), 'pmxcfs')
    assert.equal(k('ext4', '/mnt/other', '/dev/sdb1'), 'local')
  })

  it('the prune list is exactly the mounts the walk must never touch', () => {
    const idx = mountIndex(JSON.stringify({
      filesystems: [
        { target: '/srv', source: '/dev/sda2', fstype: 'ext4', options: 'rw' },
        { target: '/srv/nfs', source: 'server:/export', fstype: 'nfs4', options: 'rw' },
        { target: '/srv/smb', source: '//server/share', fstype: 'cifs', options: 'rw' },
        { target: '/srv/auto', source: 'systemd-1', fstype: 'autofs', options: 'rw' },
        { target: '/srv/child', source: 'tank/child', fstype: 'zfs', options: 'rw' },
        { target: '/elsewhere/nfs', source: 'server:/other', fstype: 'nfs4', options: 'rw' },
      ],
    }))
    // Remote + armed automount are pruned; a local ZFS child is walked normally;
    // a remote OUTSIDE the source is none of our business.
    assert.deepEqual(prunePathsUnder('/srv', idx), ['/srv/auto', '/srv/nfs', '/srv/smb'])
  })

  it('parseSubvolumeShow reads the REAL btrfs output, and says no for the placeholder', () => {
    const capture = fixture('btrfs-nested-subvol.txt')
    // The real `btrfs subvolume show /mnt/gtbtrfs/@data` block from backup2.1.
    const block = capture.slice(capture.indexOf('@data\n\tName:'))
    const parsed = parseSubvolumeShow(block)
    assert.equal(parsed?.name, '@data')
    assert.equal(parsed?.id, 256)
    // GT-52: the ro-snapshot placeholder is NOT a subvolume.
    assert.equal(parseSubvolumeShow('ERROR: Not a Btrfs subvolume: Invalid argument\n'), null)
  })
})

describe('nested filesystems — the scan against the REAL captured node', () => {
  it('finds the child dataset under a ZFS pool root and names it from findmnt', async () => {
    const ex = makeExecutor(ok(REAL_WALK_GTBACKUP))
    const scan = await scanNestedFilesystems(ex, '/gtbackup')

    assert.equal(scan.exists, true)
    assert.equal(scan.truncated, false)
    assert.equal(scan.includeNested, 'none')
    assert.equal(scan.nested.length, 1)
    assert.deepEqual(scan.nested[0], {
      path: '/gtbackup/cdm',
      relativePath: 'cdm',
      kind: 'dataset',
      source: 'gtbackup/cdm',
      fstype: 'zfs',
      included: false,
    })
    // The walk is one bounded command through the executor, wrapped in `timeout`.
    const walkCall = ex.calls.find(c => c.command === TIMEOUT)
    assert.ok(walkCall, 'the walk ran through timeout')
    assert.equal(walkCall.args[1], FIND)
    assert.ok(walkCall.args.includes('-xdev'))
    assert.ok(walkCall.args.includes('-maxdepth'))
    // No `stat` anywhere — the walk carries st_dev itself.
    assert.ok(!ex.calls.some(c => c.command.endsWith('/stat')))
  })

  it('the product-level example: /etc reports /etc/pve (pmxcfs) as NOT included', async () => {
    const ex = makeExecutor(ok(REAL_WALK_ETC))
    const scan = await scanNestedFilesystems(ex, '/etc', { archive: 'etc' })
    assert.equal(scan.archive, 'etc')
    assert.equal(scan.nested.length, 1)
    assert.equal(scan.nested[0].path, '/etc/pve')
    assert.equal(scan.nested[0].relativePath, 'pve')
    assert.equal(scan.nested[0].kind, 'pmxcfs')
    assert.equal(scan.nested[0].included, false)
  })

  it('`all` and a matching `--include-dev` path both mark the boundary INCLUDED', async () => {
    const all = await scanNestedFilesystems(makeExecutor(ok(REAL_WALK_ETC)), '/etc', { includeNested: 'all' })
    assert.equal(all.nested[0].included, true)

    const listed = await scanNestedFilesystems(makeExecutor(ok(REAL_WALK_ETC)), '/etc', { includeNested: ['/etc/pve'] })
    assert.equal(listed.nested[0].included, true)

    const other = await scanNestedFilesystems(makeExecutor(ok(REAL_WALK_ETC)), '/etc', { includeNested: ['/etc/other'] })
    assert.equal(other.nested[0].included, false)
  })

  it('a REMOTE mount is recorded from findmnt and NEVER walked into (the hang trap)', async () => {
    const findmnt = JSON.stringify({
      filesystems: [
        { target: '/srv', source: '/dev/sda2', fstype: 'ext4', options: 'rw' },
        { target: '/srv/dead', source: 'deadserver:/export', fstype: 'nfs4', options: 'rw' },
      ],
    })
    // The walk output deliberately does NOT mention /srv/dead: it was pruned.
    const ex = makeExecutor(ok('2049\t/srv\n2049\t/srv/local\n'), findmnt)
    const scan = await scanNestedFilesystems(ex, '/srv')

    assert.equal(scan.nested.length, 1)
    assert.equal(scan.nested[0].path, '/srv/dead')
    assert.equal(scan.nested[0].kind, 'nfs')
    assert.match(scan.nested[0].detail ?? '', /hang trap/)
    // The dead mount is PRUNED in the argv — find never gets to stat it.
    const walkCall = ex.calls.find(c => c.command === TIMEOUT)
    assert.ok(walkCall, 'the walk ran')
    assert.ok(walkCall.args.includes('/srv/dead'))
    assert.ok(walkCall.args.includes('-prune'))
  })

  it('an armed autofs placeholder is reported armed, and is not walked into', async () => {
    const findmnt = JSON.stringify({
      filesystems: [
        { target: '/srv', source: '/dev/sda2', fstype: 'ext4', options: 'rw' },
        { target: '/srv/media', source: 'systemd-1', fstype: 'autofs', options: 'rw' },
      ],
    })
    const ex = makeExecutor(ok('2049\t/srv\n'), findmnt)
    const scan = await scanNestedFilesystems(ex, '/srv')
    assert.equal(scan.nested[0].kind, 'automount')
    assert.match(scan.nested[0].detail ?? '', /armed/)
  })

  it('a btrfs subvolume has NO mount line, so `btrfs subvolume show` names it (GT-52/53)', async () => {
    const findmnt = JSON.stringify({
      filesystems: [{ target: '/mnt/gtbtrfs', source: '/dev/loop0', fstype: 'btrfs', options: 'rw' }],
    })
    // The REAL st_dev numbers from GT-53: @data=66, @data/photos=67.
    const ex = makeExecutor(ok('66\t/mnt/gtbtrfs/@data\n66\t/mnt/gtbtrfs/@data/plaindir\n67\t/mnt/gtbtrfs/@data/photos\n'), findmnt)
    ex.addFixture({
      command: BTRFS,
      args: ['subvolume', 'show', '/mnt/gtbtrfs/@data/photos'],
      result: ok('@data/photos\n\tName: \t\t\tphotos\n\tSubvolume ID: \t\t257\n'),
    })
    const scan = await scanNestedFilesystems(ex, '/mnt/gtbtrfs/@data')
    assert.equal(scan.nested.length, 1)
    assert.equal(scan.nested[0].path, '/mnt/gtbtrfs/@data/photos')
    assert.equal(scan.nested[0].kind, 'subvolume')
    assert.equal(scan.nested[0].source, 'photos')
    assert.match(scan.nested[0].detail ?? '', /id 257/)
  })

  it('the ro-snapshot EMPTY PLACEHOLDER is still surfaced, and says what it is (GT-52/55)', async () => {
    const findmnt = JSON.stringify({
      filesystems: [{ target: '/mnt/gtbtrfs', source: '/dev/loop0', fstype: 'btrfs', options: 'rw' }],
    })
    // GT-53: the placeholder reports the fs-root device (64), not the subvol's.
    const ex = makeExecutor(ok('68\t/mnt/gtbtrfs/snap1\n68\t/mnt/gtbtrfs/snap1/plaindir\n64\t/mnt/gtbtrfs/snap1/photos\n'), findmnt)
    ex.addFixture({
      command: BTRFS,
      args: ['subvolume', 'show', '/mnt/gtbtrfs/snap1/photos'],
      result: { stdout: '', stderr: 'ERROR: Not a Btrfs subvolume: Invalid argument\n', exitCode: 1 },
    })
    const scan = await scanNestedFilesystems(ex, '/mnt/gtbtrfs/snap1')
    assert.equal(scan.nested.length, 1)
    assert.equal(scan.nested[0].kind, 'subvolume')
    assert.match(scan.nested[0].detail ?? '', /empty placeholder/)
  })

  it('a foreign device on a NON-btrfs parent is honestly `unknown`, never guessed', async () => {
    const findmnt = JSON.stringify({
      filesystems: [{ target: '/srv', source: '/dev/sda2', fstype: 'ext4', options: 'rw' }],
    })
    const ex = makeExecutor(ok('2049\t/srv\n77\t/srv/mystery\n'), findmnt)
    const scan = await scanNestedFilesystems(ex, '/srv')
    assert.equal(scan.nested[0].kind, 'unknown')
    // btrfs is never consulted for a non-btrfs parent.
    assert.ok(!ex.calls.some(c => c.command === BTRFS))
  })

  it('a missing path reports exists:false with the real find message, and never throws', async () => {
    const ex = makeExecutor({
      stdout: '',
      stderr: 'find: ‘/gtbackup/nope’: No such file or directory\n',
      exitCode: 1,
    })
    const scan = await scanNestedFilesystems(ex, '/gtbackup/nope')
    assert.equal(scan.exists, false)
    assert.equal(scan.nested.length, 0)
    assert.match(scan.warnings[0], /No such file or directory/)
  })

  it('a walk that TIMED OUT is truncated and says so — never a silent "none found"', async () => {
    const ex = makeExecutor({ stdout: '46\t/gtbackup\n', stderr: '', exitCode: 124 })
    const scan = await scanNestedFilesystems(ex, '/gtbackup', { timeoutSeconds: 3 })
    assert.equal(scan.truncated, true)
    assert.match(scan.warnings.join(' '), /did not finish within 3s/)
  })

  it('hitting the DEPTH budget marks the scan truncated', async () => {
    const ex = makeExecutor(ok('46\t/gtbackup\n46\t/gtbackup/a\n46\t/gtbackup/a/b\n'))
    const deep = await scanNestedFilesystems(ex, '/gtbackup', { maxDepth: 2 })
    assert.equal(deep.truncated, true)
    const shallow = await scanNestedFilesystems(makeExecutor(ok('46\t/gtbackup\n46\t/gtbackup/a\n')), '/gtbackup', { maxDepth: 9 })
    assert.equal(shallow.truncated, false)
    assert.equal(DEFAULT_NESTED_MAX_DEPTH, 12)
  })

  it('a walk whose output never names the source root refuses to guess', async () => {
    const ex = makeExecutor(ok('49\t/gtbackup/cdm\n'))
    const scan = await scanNestedFilesystems(ex, '/gtbackup')
    assert.equal(scan.truncated, true)
    assert.equal(scan.nested.length, 0)
    assert.match(scan.warnings.join(' '), /did not report the source root/)
  })

  it('a `.zfs/snapshot` path that DOES surface in the walk is filtered out (GT-51)', async () => {
    // REAL devices: the dataset is 49, its automounted snapshot root is 61.
    const ex = makeExecutor(ok('49\t/gtbackup/cdm\n61\t/gtbackup/cdm/.zfs/snapshot/s1\n'))
    const scan = await scanNestedFilesystems(ex, '/gtbackup/cdm')
    assert.equal(scan.nested.length, 0)
  })

  it('scanArchives scans each archive against its OWN choice, in order', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: FINDMNT, args: ['--json'], result: ok(REAL_FINDMNT) })
    ex.addFixture({ command: TIMEOUT, args: undefined, results: [ok(REAL_WALK_ETC), ok(REAL_WALK_GTBACKUP)] })
    const scans = await scanArchives(ex, [
      { name: 'etc', path: '/etc', includeNested: ['/etc/pve'] },
      { name: 'pool', path: '/gtbackup' },
    ])
    assert.equal(scans.length, 2)
    assert.equal(scans[0].archive, 'etc')
    assert.equal(scans[0].nested[0].included, true)
    assert.equal(scans[1].archive, 'pool')
    assert.equal(scans[1].nested[0].included, false)
  })
})

describe('nested filesystems — `all` DESCENDS, so nested-inside-nested is found', () => {
  const LOCAL_ONLY = [
    { target: '/gtbackup', source: 'gtbackup', fstype: 'zfs', options: 'rw' },
    { target: '/gtbackup/cdm', source: 'gtbackup/cdm', fstype: 'zfs', options: 'rw' },
    { target: '/gtbackup/cdm/inner', source: 'gtbackup/cdm/inner', fstype: 'zfs', options: 'rw' },
  ]
  const WITH_REMOTE = [
    ...LOCAL_ONLY,
    { target: '/gtbackup/cdm/remote', source: 'server:/export', fstype: 'nfs4', options: 'rw' },
  ]

  /**
   * A mock that routes each walk to rows keyed on the ROOT it starts from —
   * `timeout <s> find -P <root> …`, so argv index 3 is the walk root. That is
   * what lets a test see the DESCENT: a second walk rooted at the boundary the
   * first one found.
   */
  function layered(walks: Record<string, ExecResult>, filesystems = LOCAL_ONLY): MockExecutor {
    const ex = new MockExecutor()
    ex.addFixture({ command: FINDMNT, args: ['--json'], result: ok(JSON.stringify({ filesystems })) })
    const inner = ex.exec.bind(ex)
    ex.exec = async (command: string, args: string[]) => {
      if (command === TIMEOUT) {
        ex.calls.push({ command, args })
        return walks[args[3]] ?? { stdout: '', stderr: `find: '${args[3]}': No such file or directory\n`, exitCode: 1 }
      }
      return inner(command, args)
    }
    return ex
  }

  /** The roots the scan actually walked, in order. */
  function walkRoots(ex: MockExecutor): string[] {
    return ex.calls.filter(c => c.command === TIMEOUT).map(c => c.args[3])
  }

  it('`none` stops at the FIRST boundary — the inner one is never walked for', async () => {
    const ex = layered({ '/gtbackup': ok('46\t/gtbackup\n49\t/gtbackup/cdm\n') })
    const scan = await scanNestedFilesystems(ex, '/gtbackup', { includeNested: 'none' })
    assert.deepEqual(scan.nested.map(n => n.path), ['/gtbackup/cdm'])
    // Exactly one walk: no descent for a choice that crosses nothing.
    assert.deepEqual(walkRoots(ex), ['/gtbackup'])
  })

  it('`all` walks INTO each included boundary and finds the one nested inside it', async () => {
    const ex = layered({
      '/gtbackup': ok('46\t/gtbackup\n49\t/gtbackup/cdm\n'),
      '/gtbackup/cdm': ok('49\t/gtbackup/cdm\n49\t/gtbackup/cdm/tree\n52\t/gtbackup/cdm/inner\n'),
      '/gtbackup/cdm/inner': ok('52\t/gtbackup/cdm/inner\n'),
    })
    const scan = await scanNestedFilesystems(ex, '/gtbackup', { includeNested: 'all' })
    assert.deepEqual(scan.nested.map(n => n.path), ['/gtbackup/cdm', '/gtbackup/cdm/inner'])
    assert.ok(scan.nested.every(n => n.included), 'all covers both')
    // relativePath stays relative to the ORIGINAL source, at every depth.
    assert.deepEqual(scan.nested.map(n => n.relativePath), ['cdm', 'cdm/inner'])
    assert.equal(scan.truncated, false)
    // The proof of descent: a walk rooted at the boundary the first walk found.
    assert.deepEqual(walkRoots(ex), ['/gtbackup', '/gtbackup/cdm', '/gtbackup/cdm/inner'])
    // And the resolution names BOTH — pbc includes devices, not trees, so the
    // inner one would still be lost if only the outer one were passed.
    const resolution = resolveNestedIncludes(
      [{ name: 'pool', path: '/gtbackup', includeNested: 'all' }],
      [scan],
    )
    assert.deepEqual(resolution.byArchive.pool, ['/gtbackup/cdm', '/gtbackup/cdm/inner'])
    assert.deepEqual(resolution.warnings, [])
  })

  it('`all` still never walks into a REMOTE mount, and says what that costs', async () => {
    const ex = layered({
      '/gtbackup': ok('46\t/gtbackup\n49\t/gtbackup/cdm\n'),
      // /gtbackup/cdm/remote is PRUNED, so the walk of cdm never reports it.
      '/gtbackup/cdm': ok('49\t/gtbackup/cdm\n'),
    }, WITH_REMOTE)
    const scan = await scanNestedFilesystems(ex, '/gtbackup', { includeNested: 'all' })
    assert.deepEqual(scan.nested.map(n => n.path), ['/gtbackup/cdm', '/gtbackup/cdm/remote'])
    // It is attributed to the boundary it actually sits under, not to the source.
    assert.equal(scan.nested[1].relativePath, 'cdm/remote')
    // NO walk is ever rooted at it — it is named from the mount table only …
    assert.ok(!walkRoots(ex).includes('/gtbackup/cdm/remote'), walkRoots(ex).join(' '))
    // … and it is PRUNED out of the walks that pass near it.
    const cdmWalk = ex.calls.find(c => c.command === TIMEOUT && c.args[3] === '/gtbackup/cdm')
    assert.ok(cdmWalk?.args.includes('/gtbackup/cdm/remote') && cdmWalk.args.includes('-prune'))
    const resolution = resolveNestedIncludes(
      [{ name: 'pool', path: '/gtbackup', includeNested: 'all' }],
      [scan],
    )
    assert.deepEqual(resolution.byArchive.pool, ['/gtbackup/cdm', '/gtbackup/cdm/remote'])
    assert.match(resolution.warnings.join(' '), /nested INSIDE those were not enumerated/)
  })

  it('the descent shares ONE depth budget, measured from the original source', async () => {
    const ex = layered({
      '/gtbackup': ok('46\t/gtbackup\n49\t/gtbackup/cdm\n'),
      '/gtbackup/cdm': ok('49\t/gtbackup/cdm\n52\t/gtbackup/cdm/inner\n'),
      '/gtbackup/cdm/inner': ok('52\t/gtbackup/cdm/inner\n'),
    })
    await scanNestedFilesystems(ex, '/gtbackup', { includeNested: 'all', maxDepth: 4 })
    const depths = ex.calls
      .filter(c => c.command === TIMEOUT)
      .map(c => Number(c.args[c.args.indexOf('-maxdepth') + 1]))
    // 4 at the root, 3 one level down, 2 two levels down — never a fresh budget.
    assert.deepEqual(depths, [4, 3, 2])
  })
})

describe('nested filesystems — resolving `all` into explicit --include-dev paths', () => {
  function scanOf(over: Partial<import('@anas/shared').BackupNestedScan> = {}) {
    return {
      archive: 'pool',
      path: '/gtbackup',
      exists: true,
      includeNested: 'all' as const,
      truncated: false,
      warnings: [],
      nested: [
        { path: '/gtbackup/cdm', relativePath: 'cdm', kind: 'dataset' as const, included: true },
        { path: '/gtbackup/cdm/inner', relativePath: 'cdm/inner', kind: 'dataset' as const, included: true },
      ],
      ...over,
    }
  }

  it('`all` becomes every boundary the scan found, in walk order', () => {
    const r = resolveNestedIncludes([{ name: 'pool', path: '/gtbackup', includeNested: 'all' }], [scanOf()])
    assert.deepEqual(r.byArchive.pool, ['/gtbackup/cdm', '/gtbackup/cdm/inner'])
    assert.deepEqual(r.warnings, [])
  })

  it('a TRUNCATED scan crosses NOTHING and says why — never a silent partial', () => {
    const r = resolveNestedIncludes(
      [{ name: 'pool', path: '/gtbackup', includeNested: 'all' }],
      [scanOf({ truncated: true })],
    )
    assert.deepEqual(r.byArchive.pool, [])
    assert.match(r.warnings[0], /'all' could not be resolved/)
    assert.match(r.warnings[0], /did not complete/)
    assert.match(r.warnings[0], /crossed NO filesystem boundary/)
    // And the screen stops claiming those are included.
    assert.ok(r.scans[0].nested.every(n => n.included === false))
  })

  it('a MISSING source crosses nothing and says why', () => {
    const r = resolveNestedIncludes(
      [{ name: 'pool', path: '/gtbackup', includeNested: 'all' }],
      [scanOf({ exists: false, nested: [] })],
    )
    assert.deepEqual(r.byArchive.pool, [])
    assert.match(r.warnings[0], /could not be read/)
  })

  it('a stored path list is passed through untouched; `none` resolves to nothing', () => {
    const r = resolveNestedIncludes([
      { name: 'listed', path: '/etc', includeNested: ['/etc/pve'] },
      { name: 'plain', path: '/srv' },
    ], [])
    assert.deepEqual(r.byArchive.listed, ['/etc/pve'])
    assert.deepEqual(r.byArchive.plain, [])
    assert.deepEqual(r.warnings, [])
  })

  it('one `all` archive next to a `none` archive resolves ONLY the first', () => {
    const r = resolveNestedIncludes([
      { name: 'pool', path: '/gtbackup', includeNested: 'all' },
      { name: 'plain', path: '/srv' },
    ], [scanOf(), { archive: 'plain', path: '/srv', exists: true, includeNested: 'none', truncated: false, warnings: [], nested: [] }])
    assert.deepEqual(r.byArchive.pool, ['/gtbackup/cdm', '/gtbackup/cdm/inner'])
    assert.deepEqual(r.byArchive.plain, [])
  })
})

describe('nested filesystems — run warnings', () => {
  it('one ASCII warning per EXCLUDED boundary, none for an included one', () => {
    const lines = nestedRunWarnings([
      {
        archive: 'etc',
        path: '/etc',
        exists: true,
        includeNested: 'none',
        truncated: false,
        warnings: [],
        nested: [
          { path: '/etc/pve', relativePath: 'pve', kind: 'pmxcfs', included: false },
          { path: '/etc/other', relativePath: 'other', kind: 'local', included: true },
        ],
      },
    ])
    assert.equal(lines.length, 1)
    assert.match(lines[0], /archive 'etc'/)
    assert.match(lines[0], /\/etc\/pve \(pmxcfs\)/)
    assert.match(lines[0], /empty directory/)
    // The notification body is plain ASCII (16.12's rule).
    assert.ok(/^[\x20-\x7E]*$/.test(lines[0]), lines[0])
  })

  it('a truncated scan adds its own honest line', () => {
    const lines = nestedRunWarnings([
      { archive: 'big', path: '/big', exists: true, includeNested: 'none', truncated: true, warnings: [], nested: [] },
    ])
    assert.equal(lines.length, 1)
    assert.match(lines[0], /incomplete/)
  })
})
