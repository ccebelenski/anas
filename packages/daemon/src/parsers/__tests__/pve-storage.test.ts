import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { parsePbsStorages, parsePveStorageCfg, parseZfsMountpoints, readPbsStorages, readPveStorages, readZfsMountpoints, zfsMountTargets } from '../pve-storage.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/pve')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parsePveStorageCfg', () => {
  it('maps a zfspool stanza to its pool root and ignores dir stanzas', () => {
    const map = parsePveStorageCfg(loadFixture('storage.cfg')).byPool
    // datapool → one zfspool ref; local (dir) → ignored.
    assert.deepEqual([...map.keys()], ['datapool'])
    const refs = map.get('datapool')!
    assert.equal(refs.length, 1)
    assert.deepEqual(refs[0], {
      storage: 'datapool',
      type: 'zfspool',
      dataset: 'datapool',
      content: ['images', 'rootdir'],
    })
  })

  it('keys a dataset-path pool by its root but keeps the full dataset', () => {
    const map = parsePveStorageCfg('zfspool: sub\n\tpool tank/data\n\tcontent images\n').byPool
    const refs = map.get('tank')!
    assert.equal(refs.length, 1)
    assert.equal(refs[0].dataset, 'tank/data')
    assert.deepEqual(refs[0].content, ['images'])
  })

  it('accumulates multiple zfspool storages under the same pool root', () => {
    const text = [
      'zfspool: a',
      '\tpool tank',
      '\tcontent images',
      '',
      'zfspool: b',
      '\tpool tank/vms',
      '\tcontent rootdir',
      '',
    ].join('\n')
    const refs = parsePveStorageCfg(text).byPool.get('tank')!
    assert.deepEqual(refs.map(r => r.storage), ['a', 'b'])
  })

  it('yields empty content when the content line is absent', () => {
    const refs = parsePveStorageCfg('zfspool: c\n\tpool tank\n').byPool.get('tank')!
    assert.deepEqual(refs[0].content, [])
  })

  it('skips a zfspool stanza with no pool line', () => {
    const map = parsePveStorageCfg('zfspool: broken\n\tcontent images\n').byPool
    assert.equal(map.size, 0)
  })

  it('ignores commented-out stanzas and comment lines', () => {
    const text = [
      '#zfspool: old',
      '#\tpool ghost',
      '#\tcontent images',
      '',
      'zfspool: real',
      '\tpool tank',
      '\t# inline-ish comment line',
      '\tcontent images',
    ].join('\n')
    const map = parsePveStorageCfg(text).byPool
    assert.deepEqual([...map.keys()], ['tank'])
    assert.equal(map.get('tank')!.length, 1)
  })

  it('parses a final stanza with no trailing blank line', () => {
    const map = parsePveStorageCfg('zfspool: last\n\tpool tank\n\tcontent images').byPool
    assert.equal(map.get('tank')![0].storage, 'last')
  })

  it('returns an empty map for empty input', () => {
    assert.equal(parsePveStorageCfg('').byPool.size, 0)
    assert.deepEqual(parsePveStorageCfg('').unresolvedDirs, [])
  })
})

describe('parsePveStorageCfg — dir on ZFS (secondary signal)', () => {
  const mountpoints = [
    { mountpoint: '/datapool', dataset: 'datapool', pool: 'datapool' },
  ]

  it('ignores dir stanzas entirely when no mountpoints are supplied', () => {
    // Fixture has a dir on /datapool/backups; without the map it must not appear —
    // not even as an unresolved dir (zfspool-only mode is the zfspool-only answer).
    const parse = parsePveStorageCfg(loadFixture('storage.cfg'))
    assert.deepEqual([...parse.byPool.keys()], ['datapool'])
    assert.deepEqual(parse.byPool.get('datapool')!.map(r => r.type), ['zfspool'])
    assert.deepEqual(parse.unresolvedDirs, [])
  })

  it('attaches a dir on a ZFS mountpoint to the pool, keyed by pool root', () => {
    const parse = parsePveStorageCfg(loadFixture('storage.cfg'), mountpoints)
    // /var/lib/vz is on no ZFS dataset → unresolved; /datapool/backups → datapool.
    assert.deepEqual([...parse.byPool.keys()], ['datapool'])
    assert.deepEqual(parse.unresolvedDirs, [{ storage: 'local', path: '/var/lib/vz' }])
    const refs = parse.byPool.get('datapool')!
    assert.equal(refs.length, 2)
    const dir = refs.find(r => r.type === 'dir')!
    assert.deepEqual(dir, {
      storage: 'backups',
      type: 'dir',
      dataset: 'datapool',
      content: ['backup', 'iso'],
    })
  })

  it('records a dir path that is on no ZFS dataset (e.g. /var/lib/vz) as an unresolved dir', () => {
    // pvepool.1 review fix 5: it does not VANISH — the share-path backstop
    // matches a share against the configured path directly.
    const text = 'dir: local\n\tpath /var/lib/vz\n\tcontent backup,iso\n'
    const parse = parsePveStorageCfg(text, mountpoints)
    assert.equal(parse.byPool.size, 0)
    assert.deepEqual(parse.unresolvedDirs, [{ storage: 'local', path: '/var/lib/vz' }])
  })

  it('resolves a dir on a legacy dataset via a findmnt-resolved mountpoint', () => {
    // pvepool.1 review fix 5: the dataset's `zfs list` mountpoint is `legacy`;
    // the table row carries the target findmnt actually reports.
    const legacyTable = [{ mountpoint: '/srv/dump', dataset: 'tank/dump', pool: 'tank' }]
    const text = 'dir: dump\n\tpath /srv/dump\n\tcontent backup,iso\n'
    const parse = parsePveStorageCfg(text, legacyTable)
    assert.deepEqual(parse.byPool.get('tank')!, [{
      storage: 'dump',
      type: 'dir',
      dataset: 'tank/dump',
      content: ['backup', 'iso'],
    }])
    assert.deepEqual(parse.unresolvedDirs, [])
  })

  it('keeps a dir on an unresolvable (empty-target) dataset row in unresolvedDirs', () => {
    // `legacy`/`none` dataset with no live mount: the row is in the table but
    // can never win a match — the configured path is the backstop's fact.
    const unmounted = [{ mountpoint: '', dataset: 'tank/dump', pool: 'tank' }]
    const text = 'dir: dump\n\tpath /srv/dump\n\tcontent backup\n'
    const parse = parsePveStorageCfg(text, unmounted)
    assert.equal(parse.byPool.size, 0)
    assert.deepEqual(parse.unresolvedDirs, [{ storage: 'dump', path: '/srv/dump' }])
  })

  it('treats an empty supplied table like a read that found no datasets', () => {
    // An EMPTY table (zfs ran, nothing mounted) still resolves dirs — to
    // nothing, into unresolvedDirs. Only the ABSENT table (undefined) is the
    // zfspool-only mode.
    const text = 'dir: local\n\tpath /var/lib/vz\n\tcontent backup\n'
    const parse = parsePveStorageCfg(text, [])
    assert.equal(parse.byPool.size, 0)
    assert.deepEqual(parse.unresolvedDirs, [{ storage: 'local', path: '/var/lib/vz' }])
  })

  it('picks the longest matching mountpoint (most specific dataset)', () => {
    const nested = [
      { mountpoint: '/tank', dataset: 'tank', pool: 'tank' },
      { mountpoint: '/tank/backups', dataset: 'tank/backups', pool: 'tank' },
    ]
    const text = 'dir: bk\n\tpath /tank/backups/dump\n\tcontent backup\n'
    const dir = parsePveStorageCfg(text, nested).byPool.get('tank')![0]
    assert.equal(dir.dataset, 'tank/backups')
  })

  it('matches a dir path equal to the dataset mountpoint itself', () => {
    const text = 'dir: bk\n\tpath /datapool\n\tcontent iso\n'
    const dir = parsePveStorageCfg(text, mountpoints).byPool.get('datapool')![0]
    assert.equal(dir.dataset, 'datapool')
  })

  it('does not let /tank swallow a sibling path like /tank-other', () => {
    const mps = [{ mountpoint: '/tank', dataset: 'tank', pool: 'tank' }]
    const text = 'dir: x\n\tpath /tank-other/dump\n\tcontent backup\n'
    const parse = parsePveStorageCfg(text, mps)
    assert.equal(parse.byPool.size, 0)
    assert.deepEqual(parse.unresolvedDirs, [{ storage: 'x', path: '/tank-other/dump' }])
  })

  it('skips a dir stanza with no path line', () => {
    const text = 'dir: x\n\tcontent backup\n'
    const parse = parsePveStorageCfg(text, mountpoints)
    assert.equal(parse.byPool.size, 0)
    assert.deepEqual(parse.unresolvedDirs, [])
  })
})

describe('parseZfsMountpoints', () => {
  it('parses tab-separated name,mountpoint rows and derives the pool root', () => {
    const out = parseZfsMountpoints('datapool\t/datapool\ndatapool/backups\t/datapool/backups\n')
    assert.deepEqual(out, [
      { mountpoint: '/datapool', dataset: 'datapool', pool: 'datapool' },
      { mountpoint: '/datapool/backups', dataset: 'datapool/backups', pool: 'datapool' },
    ])
  })

  it('drops volumes but KEEPS none/legacy rows (pvepool.1 review fix 5)', () => {
    // A `legacy`/`none` mountpoint is a marker, not a path — the row stays in
    // the table so a `dir` storage on the dataset is visible, with `''` until
    // findmnt says where it actually sits.
    const out = parseZfsMountpoints([
      'tank\t/tank',
      'tank/vm-100-disk-0\t-',
      'tank/legacy\tlegacy',
      'tank/nomount\tnone',
      '',
    ].join('\n'))
    assert.deepEqual(out, [
      { mountpoint: '/tank', dataset: 'tank', pool: 'tank' },
      { mountpoint: '', dataset: 'tank/legacy', pool: 'tank' },
      { mountpoint: '', dataset: 'tank/nomount', pool: 'tank' },
    ])
  })

  it('resolves kept none/legacy rows from the findmnt targets map', () => {
    const out = parseZfsMountpoints(
      ['tank/legacy\tlegacy', 'tank/nomount\tnone', 'tank\t/tank'].join('\n'),
      new Map([['tank/legacy', '/srv/legacy'], ['tank/nomount', '/mnt/none']]),
    )
    assert.deepEqual(out, [
      { mountpoint: '/srv/legacy', dataset: 'tank/legacy', pool: 'tank' },
      { mountpoint: '/mnt/none', dataset: 'tank/nomount', pool: 'tank' },
      { mountpoint: '/tank', dataset: 'tank', pool: 'tank' },
    ])
  })

  it('returns an empty array for empty input', () => {
    assert.deepEqual(parseZfsMountpoints(''), [])
  })
})

describe('zfsMountTargets', () => {
  it('keys zfs mounts by dataset source; first target wins; non-zfs rows are skipped', () => {
    const nodes = [
      { target: '/srv/dump', source: 'tank/dump', fstype: 'zfs', options: 'rw' },
      { target: '/mnt/pve/local', source: '/dev/sda1', fstype: 'ext4', options: 'rw' },
      { target: '/tank', source: 'tank', fstype: 'zfs', options: 'rw' },
      // a second mount of the same dataset never overwrites the first.
      { target: '/srv/dump/again', source: 'tank/dump', fstype: 'zfs', options: 'rw' },
      // a row missing its source is malformed — skipped.
      { target: '/ghost', source: '', fstype: 'zfs', options: 'rw' },
    ]
    assert.deepEqual(zfsMountTargets(nodes), new Map([
      ['tank/dump', '/srv/dump'],
      ['tank', '/tank'],
    ]))
  })
})

describe('parsePbsStorages (Epic 16.8: tier-1 PVE-defined repos)', () => {
  it('parses every pbs stanza from the real captured storage.cfg fixture', () => {
    const defs = parsePbsStorages(loadFixture('storage-pbs.cfg'))
    assert.deepEqual(defs.map(d => d.id), ['anastest-pw', 'anastest-tok', 'anastest-port'])
    // password-auth entry with a namespace, no explicit port.
    assert.deepEqual(defs[0], {
      id: 'anastest-pw',
      server: '127.0.0.1',
      datastore: 'anastest-store',
      fingerprint: 'cc:b8:a0:35:60:b9:5f:77:10:e8:c2:62:ce:1e:dd:08:b8:03:0a:82:f7:62:09:bf:e8:f5:44:7e:8b:3e:2c:1d',
      namespace: 'anastest',
      username: 'root@pam',
    })
  })

  it('preserves a token username (the !tokenname suffix is the auth discriminator)', () => {
    const tok = parsePbsStorages(loadFixture('storage-pbs.cfg')).find(d => d.id === 'anastest-tok')!
    assert.equal(tok.username, 'root@pam!anas-test')
    assert.equal(tok.namespace, undefined) // no namespace line → undefined
    assert.equal(tok.port, undefined)
  })

  it('parses an explicit non-default port as a number', () => {
    const p = parsePbsStorages(loadFixture('storage-pbs.cfg')).find(d => d.id === 'anastest-port')!
    assert.equal(p.port, 8007)
    assert.equal(typeof p.port, 'number')
  })

  it('ignores non-pbs stanzas (zfspool / dir) entirely', () => {
    const defs = parsePbsStorages(loadFixture('storage-pbs.cfg'))
    assert.equal(defs.length, 3) // datapool + local are not counted
  })

  it('skips a pbs stanza missing server or datastore (unusable)', () => {
    assert.equal(parsePbsStorages('pbs: broken\n\tusername root@pam\n').length, 0)
    assert.equal(parsePbsStorages('pbs: nods\n\tserver 10.0.0.1\n').length, 0)
    assert.equal(parsePbsStorages('pbs: nosrv\n\tdatastore ds\n').length, 0)
  })

  it('ignores a commented-out pbs stanza', () => {
    const text = '#pbs: ghost\n#\tserver 10.0.0.1\n#\tdatastore ds\n'
    assert.equal(parsePbsStorages(text).length, 0)
  })

  it('parses a final stanza with no trailing blank line', () => {
    const text = 'pbs: last\n\tserver 10.0.0.1\n\tdatastore ds'
    assert.equal(parsePbsStorages(text)[0].id, 'last')
  })

  it('drops an out-of-range port rather than emitting garbage', () => {
    const text = 'pbs: p\n\tserver h\n\tdatastore d\n\tport 99999\n'
    assert.equal(parsePbsStorages(text)[0].port, undefined)
  })

  it('returns an empty array for empty input', () => {
    assert.deepEqual(parsePbsStorages(''), [])
  })
})

describe('readPbsStorages (fail-open)', () => {
  it('reads and parses the pbs stanzas from a real fixture file', async () => {
    const defs = await readPbsStorages(join(fixturesDir, 'storage-pbs.cfg'))
    assert.deepEqual(defs.map(d => d.id), ['anastest-pw', 'anastest-tok', 'anastest-port'])
  })

  it('returns an empty array when the file is missing (non-PVE host)', async () => {
    assert.deepEqual(await readPbsStorages(join(fixturesDir, 'nope.cfg')), [])
  })
})

describe('readPveStorages (fail-open)', () => {
  it('reads and parses a real storage.cfg fixture', async () => {
    const map = await readPveStorages(join(fixturesDir, 'storage.cfg'))
    assert.ok(map)
    assert.deepEqual([...map.byPool.keys()], ['datapool'])
    assert.deepEqual(map.unresolvedDirs, []) // no mountpoints → zfspool-only mode
  })

  it('returns an empty parse when the file is missing (non-PVE host)', async () => {
    const map = await readPveStorages(join(fixturesDir, 'does-not-exist.cfg'))
    assert.ok(map)
    assert.equal(map.byPool.size, 0)
    assert.deepEqual(map.unresolvedDirs, [])
  })

  // pvepool.1 review fix 1: ENOENT (absent = not a PVE host) stays fail-open;
  // ANY OTHER read failure is UNREADABLE — null, never an empty map that would
  // read as "no PVE storages" and loosen the hands-off gate.
  it('returns null (unreadable) when the read fails with anything but ENOENT', async () => {
    // A DIRECTORY: readFile rejects with EISDIR, not ENOENT.
    assert.equal(await readPveStorages(fixturesDir), null)
  })
})

describe('readZfsMountpoints (ENOENT vs unreadable)', () => {
  // pvepool.1 review fix 1: the same three-valued posture as the storage.cfg
  // read — a missing `zfs` binary is a genuine "no ZFS here" (fail-open, []),
  // a command that RAN and failed is UNREADABLE (null).
  it('returns [] when the zfs binary is missing (ENOENT)', async () => {
    assert.deepEqual(await readZfsMountpoints('/nonexistent/anas-no-zfs-here'), [])
  })

  it('returns null (unreadable) when the command fails with anything but ENOENT', async () => {
    assert.equal(await readZfsMountpoints('/bin/false'), null)
  })
})

describe('readZfsMountpoints (executor path, pvepool.1 review fix 5)', () => {
  const ZFS = '/usr/sbin/zfs'
  const FINDMNT = '/usr/bin/findmnt'

  it('resolves a legacy dataset from findmnt and keeps the rest of the table', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      args: ['list', '-H', '-o', 'name,mountpoint'],
      result: { stdout: 'tank/dump\tlegacy\ntank/vm-100-disk-0\t-\ntank\t/tank\n', stderr: '', exitCode: 0 },
    })
    mock.addFixture({
      command: FINDMNT,
      args: ['--json'],
      result: {
        stdout: '{"filesystems":[{"target":"/srv/dump","source":"tank/dump","fstype":"zfs","options":"rw"},{"target":"/","source":"/dev/sda1","fstype":"ext4","options":"rw"}]}',
        stderr: '',
        exitCode: 0,
      },
    })
    const out = await readZfsMountpoints(mock)
    assert.deepEqual(out, [
      { mountpoint: '/srv/dump', dataset: 'tank/dump', pool: 'tank' },
      { mountpoint: '/tank', dataset: 'tank', pool: 'tank' },
    ])
  })

  it('keeps a legacy row unresolvable (empty target) when findmnt fails', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      args: ['list', '-H', '-o', 'name,mountpoint'],
      result: { stdout: 'tank/dump\tlegacy\n', stderr: '', exitCode: 0 },
    })
    // No findmnt fixture → exit 127 → the legacy row stays, with no target.
    const out = await readZfsMountpoints(mock)
    assert.deepEqual(out, [{ mountpoint: '', dataset: 'tank/dump', pool: 'tank' }])
  })

  it('returns null when zfs list RAN and failed (executor path)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      args: ['list', '-H', '-o', 'name,mountpoint'],
      result: { stdout: '', stderr: 'no permission', exitCode: 1 },
    })
    mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: '{"filesystems":[]}', stderr: '', exitCode: 0 } })
    assert.equal(await readZfsMountpoints(mock), null)
  })
})
