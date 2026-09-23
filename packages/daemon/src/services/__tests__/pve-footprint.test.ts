import type { SystemPoolFacts } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { parsePveStorageCfg } from '../../parsers/pve-storage.js'
import { buildSystemPoolFacts, loadPveFootprint, ownedDescendantIn, ownershipFromFootprintData, parseBootfsGet, parseRootMount, pveDescendantsUnlistedMessage, pveRecursiveRefusalMessage, readSystemPoolFacts, systemPoolRefusal } from '../pve-footprint.js'

/**
 * Story pvepool.1 — the system-pool half of the footprint service. The boot
 * facts come from two command outputs, so the parsers are proven against
 * LITERAL output, and the pure predicate assembly is checked over the story's
 * fixture set (the predicate itself has its table in @anas/shared).
 */

describe('parseBootfsGet — `zpool get -H -o name,value bootfs`', () => {
  it('reads one row per imported pool, omitting bootfs when the value is `-`', () => {
    const rows = parseBootfsGet(
      'rpool\trpool/ROOT/pve-1\n'
      + 'tank\t-\n'
      + 'ahr0\t-\n',
    )
    assert.deepEqual(rows, [
      { pool: 'rpool', bootfs: 'rpool/ROOT/pve-1' },
      { pool: 'tank' },
      { pool: 'ahr0' },
    ])
  })

  it('a pool whose bootfs IS the pool root is kept verbatim', () => {
    assert.deepEqual(parseBootfsGet('bpool\tbpool'), [{ pool: 'bpool', bootfs: 'bpool' }])
  })

  it('malformed rows and blank lines are skipped, never thrown on', () => {
    assert.deepEqual(parseBootfsGet('\n\ngarbage with no tab\nrpool\tkeep-value'), [
      { pool: 'rpool', bootfs: 'keep-value' },
    ])
    assert.deepEqual(parseBootfsGet(''), [])
  })
})

describe('parseRootMount — `findmnt -n -o SOURCE,FSTYPE /`', () => {
  it('reads the zfs dataset mounted at /', () => {
    assert.deepEqual(parseRootMount('rpool/ROOT/pve-1 zfs\n'), {
      dataset: 'rpool/ROOT/pve-1',
      fstype: 'zfs',
    })
  })

  it('any other filesystem at / is no boot dataset at all', () => {
    assert.equal(parseRootMount('/dev/sda1 ext4\n'), null)
    assert.equal(parseRootMount('//server/share cifs\n'), null)
  })

  it('an unreadable answer is no boot dataset', () => {
    assert.equal(parseRootMount(''), null)
  })
})

describe('buildSystemPoolFacts — the boot rows + the root mount, one entry per pool', () => {
  it('tags rootDataset on the pool that actually hosts /', () => {
    const facts = buildSystemPoolFacts(
      parseBootfsGet('rpool\trpool/ROOT/pve-1\ntank\t-\n'),
      parseRootMount('rpool/ROOT/pve-1 zfs\n'),
    )
    assert.equal(facts.length, 2)
    assert.equal(facts[0].rootDataset, 'rpool/ROOT/pve-1')
    assert.equal(facts[1].rootDataset, undefined)
    assert.equal(facts[1].bootfs, undefined)
  })

  it('a non-zfs / contributes no rootDataset to any pool', () => {
    const facts = buildSystemPoolFacts(parseBootfsGet('rpool\t-\n'), null)
    assert.deepEqual(facts, [{ pool: 'rpool' }])
  })
})

describe('ownershipFromFootprintData — the service-level assembly over the fixture set', () => {
  // The story's shape: nested storage root, bare storage, a dir storage, and
  // the system pool.
  const CFG = 'zfspool: local-zfs\n\tpool rpool/data\n\tcontent images,rootdir\n\n'
  const MPS = [
    { mountpoint: '/rpool/data', dataset: 'rpool/data', pool: 'rpool' },
    { mountpoint: '/rpool/media', dataset: 'rpool/media', pool: 'rpool' },
  ]
  const storages = parsePveStorageCfg(CFG, MPS).byPool
  const system: SystemPoolFacts[] = [{ pool: 'rpool', bootfs: 'rpool/ROOT/pve-1' }]

  it('the boot dataset and its ancestors are system-owned', () => {
    for (const dataset of ['rpool', 'rpool/ROOT', 'rpool/ROOT/pve-1'])
      assert.equal(ownershipFromFootprintData(storages, system, dataset)?.kind, 'system', dataset)
  })

  it('the storage root and its guests are PVE-owned; the sibling is NOT', () => {
    assert.equal(ownershipFromFootprintData(storages, system, 'rpool/data')?.kind, 'storage-root')
    assert.equal(ownershipFromFootprintData(storages, system, 'rpool/data/vm-100-disk-0')?.kind, 'guest-volume')
    // rpool/media is neither under ROOT nor a storage path — the manageable one.
    assert.equal(ownershipFromFootprintData(storages, system, 'rpool/media'), null)
  })

  it('no system facts (failed boot probe) fails open to the plain footprint rules', () => {
    // Without boot facts the system rule is undetectable — rpool/ROOT is
    // outside any storage's footprint, so it answers manageable.
    assert.equal(ownershipFromFootprintData(storages, [], 'rpool/ROOT'), null)
    assert.equal(ownershipFromFootprintData(storages, [], 'rpool/data')?.kind, 'storage-root')
  })
})

describe('readSystemPoolFacts — null when the probe fails (unreadable ≠ no system pool)', () => {
  it('a failing `zpool get bootfs` yields null, not []', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['get', '-H', '-o', 'name,value', 'bootfs'],
      result: { stdout: '', stderr: 'zpool get: cannot open pool: no such pool', exitCode: 1 },
    })
    assert.equal(await readSystemPoolFacts(mock), null)
  })
})

describe('loadPveFootprint — unreadable boot facts fall back to the whole-pool rule', () => {
  // A zfspool storage on a bare pool root: before pvepool.1 this pool was
  // PVE's WHOLE pool — the fallback must reproduce exactly that.
  const CFG = 'zfspool: local-zfs\n\tpool tank\n\tcontent images,rootdir\n\n'
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-pve-footprint-'))
    await writeFile(join(dir, 'storage.cfg'), CFG, 'utf8')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('a pool with a zfspool ref is hands-off across the board; no-ref pools are untouched', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['get', '-H', '-o', 'name,value', 'bootfs'],
      result: { stdout: '', stderr: 'zpool get: cannot open pool: no such pool', exitCode: 1 },
    })
    const fp = await loadPveFootprint(mock, { pveStorageCfg: join(dir, 'storage.cfg') })
    assert.equal(fp.systemFactsUnavailable, true)

    // The normal answer still wins first — the fallback only tightens what
    // the per-dataset rules would call manageable.
    assert.equal(fp.ownershipOf('tank')?.kind, 'storage-root')
    assert.equal(fp.ownershipOf('tank/vm-100-disk-0')?.kind, 'guest-volume')

    // ...and the rest of the pool is PVE's whole pool.
    const owned = fp.ownershipOf('tank/media')
    assert.equal(owned?.kind, 'system')
    assert.equal(
      owned?.reason,
      `boot facts unavailable (zpool get bootfs failed) — pool 'tank' is treated as PVE's whole pool until the daemon can read them`,
    )

    // A pool with no zfspool ref is unaffected by the unavailable facts.
    assert.equal(fp.ownershipOf('other/x'), null)
    assert.equal(fp.isSystemPool('other'), false)
    assert.equal(fp.isSystemPool('tank'), true)
  })

  it('with facts available the flag is false and the per-dataset rules apply unchanged', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['get', '-H', '-o', 'name,value', 'bootfs'],
      result: { stdout: 'tank\ttank/ROOT/pve-1\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: '/usr/bin/findmnt',
      args: ['-n', '-o', 'SOURCE,FSTYPE', '/'],
      result: { stdout: '', stderr: '', exitCode: 1 },
    })
    const fp = await loadPveFootprint(mock, { pveStorageCfg: join(dir, 'storage.cfg') })
    assert.equal(fp.systemFactsUnavailable, false)
    assert.equal(fp.ownershipOf('tank/ROOT/pve-1')?.kind, 'system')
    // The sibling outside the boot tree stays manageable — the relaxation.
    assert.equal(fp.ownershipOf('tank/media'), null)
    assert.equal(fp.isSystemPool('tank'), true)
  })
})

// --- pvepool.1 review fix 1: storage.cfg UNREADABLE fails closed ------------

describe('loadPveFootprint — unreadable storage.cfg tightens EVERY pool (review fix 1)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-pve-unreadable-'))
    // `dir` itself is the cfg path: readFile rejects with EISDIR — any
    // non-ENOENT failure stands in for pmxcfs being down.
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function mockWithReadableBootFacts(): MockExecutor {
    const mock = new MockExecutor()
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['get', '-H', '-o', 'name,value', 'bootfs'],
      result: { stdout: 'tank\t-\nother\t-\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: '/usr/bin/findmnt',
      args: ['-n', '-o', 'SOURCE,FSTYPE', '/'],
      result: { stdout: '', stderr: '', exitCode: 1 },
    })
    return mock
  }

  it('a dataset on a pool with NO storage ref is owned with the unreadable reason', async () => {
    const fp = await loadPveFootprint(mockWithReadableBootFacts(), { pveStorageCfg: dir })
    assert.equal(fp.storagesUnavailable, true)
    const owned = fp.ownershipOf('tank/media')
    assert.equal(owned?.kind, 'config-unreadable')
    assert.equal(
      owned?.reason,
      `PVE storage configuration is unreadable (/etc/pve/storage.cfg) — pool 'tank' is treated as PVE's until it can be read`,
    )
    // Nothing can be judged, so no owned node's children are manageable either.
    assert.equal(owned?.childrenManageable, false)
  })

  it('every pool is a system pool and the naming guard judges nothing', async () => {
    const fp = await loadPveFootprint(mockWithReadableBootFacts(), { pveStorageCfg: dir })
    assert.equal(fp.isSystemPool('tank'), true)
    assert.equal(fp.isSystemPool('other'), true)
    assert.equal(fp.claimedByPve('tank/vm-100-disk-0'), null)
  })

  it('an ABSENT storage.cfg (ENOENT) stays fail-open — unchanged behaviour', async () => {
    const fp = await loadPveFootprint(mockWithReadableBootFacts(), { pveStorageCfg: join(dir, 'absent.cfg') })
    assert.equal(fp.storagesUnavailable, false)
    assert.equal(fp.ownershipOf('tank/media'), null)
    assert.equal(fp.isSystemPool('tank'), false)
    assert.equal(fp.claimedByPve('tank/vm-100-disk-0'), null)
  })
})

// --- pvepool.1 review fix 3: childrenManageable stamped on OWNED answers ----

describe('ownershipOf childrenManageable — the probe table over the pvepool fixture (review fix 3)', () => {
  // The full story shape: a NESTED storage root (`rpool/data`), a dir storage
  // resolved onto `rpool/media/dirstore`, and the system/boot tree
  // (`rpool/ROOT/pve-1`). The probe is a non-guest child: `childrenManageable`
  // is true exactly when `<dataset>/anas-probe` would sit OUTSIDE the
  // footprint.
  const CFG = 'zfspool: local-zfs\n\tpool rpool/data\n\tcontent images,rootdir\n\n'
    + 'dir: local-dir\n\tpath /rpool/media/dirstore\n\tcontent backup\n\n'
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-pve-children-'))
    await writeFile(join(dir, 'storage.cfg'), CFG, 'utf8')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function footprint() {
    const mock = new MockExecutor()
    mock.addFixture({
      command: '/usr/sbin/zfs',
      args: ['list', '-H', '-o', 'name,mountpoint'],
      result: {
        stdout: 'rpool\t/rpool\nrpool/data\t/rpool/data\nrpool/media\t/rpool/media\nrpool/media/dirstore\t/rpool/media/dirstore\n',
        stderr: '',
        exitCode: 0,
      },
    })
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['get', '-H', '-o', 'name,value', 'bootfs'],
      result: { stdout: 'rpool\trpool/ROOT/pve-1\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: '/usr/bin/findmnt',
      args: ['-n', '-o', 'SOURCE,FSTYPE', '/'],
      result: { stdout: '', stderr: '', exitCode: 1 },
    })
    return loadPveFootprint(mock, { pveStorageCfg: join(dir, 'storage.cfg') })
  }

  it('the table: storage root and system pool root true; ROOT, guest, dir and unreadable false', async () => {
    const fp = await footprint()

    // Storage root: a plain child of it is NOT PVE's (the story's whole point).
    const root = fp.ownershipOf('rpool/data')
    assert.equal(root?.kind, 'storage-root')
    assert.equal(root?.childrenManageable, true)

    // System POOL ROOT: the boot tree lives under rpool/ROOT, a sibling of any
    // non-guest child ANAS would create.
    const pool = fp.ownershipOf('rpool')
    assert.equal(pool?.kind, 'system')
    assert.equal(pool?.childrenManageable, true)

    // The boot-tree interior: everything under rpool/ROOT is PVE's.
    assert.equal(fp.ownershipOf('rpool/ROOT')?.childrenManageable, false)
    assert.equal(fp.ownershipOf('rpool/ROOT/pve-1')?.childrenManageable, false)

    // Guest volume: children inherit the guest claim through the subtree rule.
    const guest = fp.ownershipOf('rpool/data/vm-100-disk-0')
    assert.equal(guest?.kind, 'guest-volume')
    assert.equal(guest?.childrenManageable, false)

    // Dir storage: the whole tree under its path is PVE's.
    const dirOwned = fp.ownershipOf('rpool/media/dirstore')
    assert.equal(dirOwned?.kind, 'dir-storage')
    assert.equal(dirOwned?.childrenManageable, false)

    // UNOWNED nodes carry no verdict at all — no field, no probe answer.
    assert.equal(fp.ownershipOf('rpool/media'), null)
  })

  it('a config-unreadable footprint answers false — nothing can be judged', async () => {
    // The cfg PATH is the temp directory itself: readFile rejects EISDIR —
    // the same stand-in for pmxcfs being down the fix-1 tests use.
    const mock = new MockExecutor()
    mock.addFixture({
      command: '/usr/sbin/zfs',
      args: ['list', '-H', '-o', 'name,mountpoint'],
      result: { stdout: '', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['get', '-H', '-o', 'name,value', 'bootfs'],
      result: { stdout: 'rpool\t-\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: '/usr/bin/findmnt',
      args: ['-n', '-o', 'SOURCE,FSTYPE', '/'],
      result: { stdout: '', stderr: '', exitCode: 1 },
    })
    const fp = await loadPveFootprint(mock, { pveStorageCfg: dir })
    const owned = fp.ownershipOf('rpool/media')
    assert.equal(owned?.kind, 'config-unreadable')
    assert.equal(owned?.childrenManageable, false)
  })
})

// --- pvepool.1 review fix 2: the recursive-verb descendant guard ------------

describe('ownedDescendant — the first strict descendant PVE owns (review fix 2)', () => {
  // The nested-storage shape: the storage root is `tank/x/data`, so the tree
  // ABOVE it (`tank/x`) is unowned — yet a recursive verb on `tank/x` sweeps
  // the storage root and its guest disk.
  const CFG = 'zfspool: local-zfs\n\tpool tank/x/data\n\tcontent images,rootdir\n\n'
  const NAMES = ['tank', 'tank/x', 'tank/x/data', 'tank/x/data/vm-100-disk-0', 'tank/x/media']
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-pve-descendant-'))
    await writeFile(join(dir, 'storage.cfg'), CFG, 'utf8')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function footprint() {
    const mock = new MockExecutor()
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['get', '-H', '-o', 'name,value', 'bootfs'],
      result: { stdout: 'tank\t-\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: '/usr/bin/findmnt',
      args: ['-n', '-o', 'SOURCE,FSTYPE', '/'],
      result: { stdout: '', stderr: '', exitCode: 1 },
    })
    return loadPveFootprint(mock, { pveStorageCfg: join(dir, 'storage.cfg') })
  }

  it('the parent above a nested storage root is NOT owned, but its descendant scan hits the root', async () => {
    const fp = await footprint()
    assert.equal(fp.ownershipOf('tank/x'), null)
    const hit = fp.ownedDescendant(NAMES, 'tank/x')
    assert.equal(hit?.name, 'tank/x/data')
    assert.equal(hit?.ownership.kind, 'storage-root')
    assert.match(hit?.ownership.reason ?? '', /local-zfs/)
  })

  it('a sibling with no owned descendants scans clean; the pool root hits the same root', async () => {
    const fp = await footprint()
    assert.equal(fp.ownedDescendant(NAMES, 'tank/x/media'), null)
    assert.equal(fp.ownedDescendant(NAMES, 'tank')?.name, 'tank/x/data')
  })

  it('the strictness is on path SEGMENTS — `tank/x-other` is not a descendant of `tank/x`', async () => {
    const fp = await footprint()
    assert.equal(fp.ownedDescendant(['tank/x-other'], 'tank/x'), null)
  })

  it('the pure core answers the same for a plain string list and Dataset rows', async () => {
    const fp = await footprint()
    const asRows = NAMES.map(name => ({ name }))
    assert.equal(ownedDescendantIn(asRows, 'tank/x', fp.ownershipOf)?.name, 'tank/x/data')
    assert.equal(ownedDescendantIn(NAMES, 'tank/x', fp.ownershipOf)?.name, 'tank/x/data')
  })

  it('the refusal sentence names the verb, the swept descendant and the reason', async () => {
    const fp = await footprint()
    const hit = fp.ownedDescendant(NAMES, 'tank/x')!
    assert.equal(
      pveRecursiveRefusalMessage('Destroy', 'tank/x', hit),
      `Destroy of 'tank/x' would include tank/x/data — PVE storage 'local-zfs' owns tank/x/data as a storage root`,
    )
  })

  it('a FAILED descendant probe is its own refusal sentence (review fix 4)', () => {
    assert.equal(
      pveDescendantsUnlistedMessage('destroy', 'tank/x'),
      `Could not list descendants of 'tank/x' — refusing the recursive destroy`,
    )
  })
})

// --- pvepool.1 review fix 4: the system-pool refusal names the CAUSE --------

describe('systemPoolRefusal — the sentence matches the cause that fired (review fix 4)', () => {
  it('unreadable storage configuration: says the CONFIG is unreadable — not a zfspool claim', () => {
    // The old sentence claimed "it hosts a PVE zfspool storage" even when the
    // config itself was the unreadable fact — with it gone, no one could have
    // verified the claim. The sentence must say what was actually true.
    const r = systemPoolRefusal('tank', null, { storagesUnavailable: true })
    assert.equal(r.reason, 'system-pool')
    assert.equal(r.message, 'PVE storage configuration is unreadable (/etc/pve/storage.cfg) — pool \'tank\' is treated as a system pool until it can be read — ANAS never destroys, exports or remounts a system pool')
    // The config cause WINS even when the boot facts happened to be readable —
    // the pool's system-ness is being refused on the config, not the boot tree.
    const withFacts = systemPoolRefusal('tank', { pool: 'tank', bootfs: 'tank/ROOT/pve-1' }, { storagesUnavailable: true })
    assert.equal(withFacts.message, r.message)
  })

  it('unreadable boot facts (a zfspool pool): the whole-pool fallback sentence', () => {
    const r = systemPoolRefusal('tank', null)
    assert.equal(r.message, 'Pool \'tank\' is treated as a system pool (boot facts unreadable; it hosts a PVE zfspool storage) — ANAS never destroys, exports or remounts a system pool')
  })

  it('a readable boot tree: names the boot filesystem', () => {
    const r = systemPoolRefusal('rpool', { pool: 'rpool', bootfs: 'rpool/ROOT/pve-1', rootDataset: 'rpool/ROOT/pve-1' })
    assert.equal(r.message, 'Pool \'rpool\' holds this node\'s boot filesystem (rpool/ROOT/pve-1) — ANAS never destroys, exports or remounts a system pool')
  })
})

// --- pvepool.1 review fix 5: the share-path backstop over unresolvable dirs -

describe('sharePathClaim — dataset claims first, then the unresolvable-dir path rule (review fix 5)', () => {
  // A `dir` storage on a `legacy` dataset — the finding's shape: its `zfs list`
  // mountpoint is a marker, so only findmnt (or nothing) says where it sits.
  const CFG = 'dir: dump\n\tpath /srv/dump\n\tcontent backup,iso\n\n'
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-pve-sharepath-'))
    await writeFile(join(dir, 'storage.cfg'), CFG, 'utf8')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function bootFactsMock(): MockExecutor {
    const mock = new MockExecutor()
    mock.addFixture({
      command: '/usr/sbin/zpool',
      args: ['get', '-H', '-o', 'name,value', 'bootfs'],
      result: { stdout: 'tank\t-\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: '/usr/bin/findmnt',
      args: ['-n', '-o', 'SOURCE,FSTYPE', '/'],
      result: { stdout: '', stderr: '', exitCode: 1 },
    })
    return mock
  }

  it('a mounted legacy dataset: the path resolves onto the DATASET, and the dir storage owns it', async () => {
    const mock = bootFactsMock()
    mock.addFixture({
      command: '/usr/sbin/zfs',
      args: ['list', '-H', '-o', 'name,mountpoint'],
      result: { stdout: 'tank/dump\tlegacy\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: '/usr/bin/findmnt',
      args: ['--json'],
      result: {
        stdout: '{"filesystems":[{"target":"/srv/dump","source":"tank/dump","fstype":"zfs","options":"rw"}]}',
        stderr: '',
        exitCode: 0,
      },
    })
    const fp = await loadPveFootprint(mock, { pveStorageCfg: join(dir, 'storage.cfg') })
    assert.deepEqual(fp.unresolvedDirPaths, []) // the dir resolved — it is a ref now

    // The path sits ON the dataset (via findmnt) and the dataset is PVE's dir
    // storage — a dataset claim quoting the ownership reason.
    const claim = fp.sharePathClaim('/srv/dump')!
    assert.equal(claim.kind, 'dataset')
    if (claim.kind !== 'dataset')
      throw new Error('unreachable')
    assert.equal(claim.dataset, 'tank/dump')
    assert.equal(claim.ownership.kind, 'dir-storage')
    assert.match(claim.ownership.reason, /dump/)

    // A subpath of the storage path is the same claim (the mount hosts it).
    assert.equal(fp.sharePathClaim('/srv/dump/some/file')!.kind, 'dataset')
    // A path on no PVE dataset and no PVE dir path opens the gate.
    assert.equal(fp.sharePathClaim('/data/plain'), null)
  })

  it('an unmounted legacy dataset: the dir path is unresolvable and the path rule refuses directly', async () => {
    const mock = bootFactsMock()
    mock.addFixture({
      command: '/usr/sbin/zfs',
      args: ['list', '-H', '-o', 'name,mountpoint'],
      result: { stdout: 'tank/dump\tlegacy\n', stderr: '', exitCode: 0 },
    })
    // No `findmnt --json` fixture → exit 127 → no live target known.
    const fp = await loadPveFootprint(mock, { pveStorageCfg: join(dir, 'storage.cfg') })
    // The dir storage could not resolve onto a dataset — it keeps its path.
    assert.deepEqual(fp.unresolvedDirPaths, [{ storage: 'dump', path: '/srv/dump' }])

    // The backstop's path rule: a share at or under the configured path is
    // refused against the storage — the same isPathWithin rule mounts use.
    const claim = fp.sharePathClaim('/srv/dump')!
    assert.deepEqual(claim, { kind: 'dir-path', storage: 'dump', path: '/srv/dump' })
    assert.deepEqual(fp.sharePathClaim('/srv/dump/sub'), claim)
    // A SIBLING path that merely shares the prefix is outside (segments, not
    // strings) — the rule is isPathWithin, not startsWith.
    assert.equal(fp.sharePathClaim('/srv/dump-other'), null)
    assert.equal(fp.sharePathClaim('/srv'), null)
  })

  it('a non-ZFS dir path (e.g. /var/lib/vz) also tightens the share gate via its path', async () => {
    // The finding's tightening rule: EVERY dir storage whose path fails to
    // resolve keeps its path as a backstop claim — including plain-ext4
    // /var/lib/vz — because "no dataset resolved" is a missing fact, and a
    // missing fact may only tighten.
    await writeFile(join(dir, 'storage.cfg'), 'dir: local\n\tpath /var/lib/vz\n\tcontent backup\n\n', 'utf8')
    const mock = bootFactsMock()
    mock.addFixture({
      command: '/usr/sbin/zfs',
      args: ['list', '-H', '-o', 'name,mountpoint'],
      result: { stdout: '', stderr: '', exitCode: 0 },
    })
    const fp = await loadPveFootprint(mock, { pveStorageCfg: join(dir, 'storage.cfg') })
    assert.deepEqual(fp.unresolvedDirPaths, [{ storage: 'local', path: '/var/lib/vz' }])
    assert.deepEqual(fp.sharePathClaim('/var/lib/vz'), { kind: 'dir-path', storage: 'local', path: '/var/lib/vz' })
    assert.equal(fp.sharePathClaim('/var/lib/vz/template-101')!.kind, 'dir-path')
  })
})
