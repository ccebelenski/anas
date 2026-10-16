import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { classifyKind, effectiveMountAt, effectiveMounts, isFindmntTable, isPseudoFstype, isSystemMountTarget, optionsReadOnly, parseFindmnt, parseFindmntTable, readFindmntTable } from '../findmnt.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/mounts')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parseFindmnt', () => {
  const nodes = parseFindmnt(loadFixture('findmnt-full.json'))

  it('flattens the whole tree depth-first (incl. stacked children)', () => {
    // The automount target appears twice: autofs placeholder + real nfs4 child.
    const auto = nodes.filter(n => n.target === '/mnt/anas-auto')
    assert.equal(auto.length, 2)
    assert.deepEqual(auto.map(n => n.fstype).sort(), ['autofs', 'nfs4'])
  })

  it('returns the effective (negotiated) options string', () => {
    const nfs = nodes.find(n => n.target === '/mnt/anas-nfs')!
    assert.ok(nfs.options.includes('vers=4.2'))
    assert.ok(nfs.options.includes('hard'))
  })

  it('is total: malformed JSON yields an empty list', () => {
    assert.deepEqual(parseFindmnt('not json'), [])
    assert.deepEqual(parseFindmnt(''), [])
  })
})

describe('isFindmntTable — the ONE shape gate the fail-closed readers share (cr.30r)', () => {
  it('only an object with a filesystems ARRAY reads as findmnt\'s shape', () => {
    assert.equal(isFindmntTable('{"filesystems":[]}'), true)
    assert.equal(isFindmntTable('{"filesystems":[{"target":"/"}]}'), true)
    for (const text of ['', 'not json', '{}', '[]', 'null', '"str"', '42', '{"report":[]}', '{"filesystems":42}', '{"filesystems":null}', '{"filesystems":"[]"}'])
      assert.equal(isFindmntTable(text), false, text)
  })
  it('never throws on any input', () => {
    assert.doesNotThrow(() => isFindmntTable('{"filesystems":'))
  })
})

describe('classifyKind', () => {
  it('disambiguates from fstype/source (ground truth §1)', () => {
    assert.equal(classifyKind('cifs', '//127.0.0.1/anastest'), 'cifs')
    assert.equal(classifyKind('nfs4', '127.0.0.1:/srv/nfs/export1'), 'nfs')
    assert.equal(classifyKind('zfs', 'mnttest'), 'zfs')
    assert.equal(classifyKind('autofs', 'systemd-1'), 'autofs')
    // A kernel CephFS mon-list source matches the NFS `host:/path` shape —
    // fstype must win, so the row never mis-reports as nfs.
    assert.equal(classifyKind('ceph', '10.0.0.101,10.0.0.102,10.0.0.105:/'), 'ceph')
    assert.equal(classifyKind('fuse.ceph-fuse', 'ceph-fuse'), 'ceph')
    assert.equal(classifyKind('ext4', '/dev/sda1'), 'local')
    assert.equal(classifyKind('vfat', '/dev/sda15'), 'local')
    assert.equal(classifyKind('ext4', 'UUID=abc'), 'local')
  })
})

describe('isPseudoFstype', () => {
  it('drops kernel pseudo-fs but keeps autofs and real filesystems', () => {
    for (const fs of ['sysfs', 'proc', 'tmpfs', 'cgroup2', 'fuse.lxcfs', 'fuse'])
      assert.equal(isPseudoFstype(fs), true, fs)
    for (const fs of ['ext4', 'nfs4', 'cifs', 'zfs', 'autofs', 'vfat', 'xfs'])
      assert.equal(isPseudoFstype(fs), false, fs)
  })
})

describe('isSystemMountTarget', () => {
  it('drops OS-plumbing targets (incl. the binfmt_misc autofs placeholder)', () => {
    // A systemd autofs placeholder over binfmt_misc reports fstype `autofs`
    // (which we keep for real automounts) but lives under /proc — filter it.
    assert.equal(isSystemMountTarget('/proc/sys/fs/binfmt_misc'), true)
    assert.equal(isSystemMountTarget('/sys/kernel/config'), true)
    assert.equal(isSystemMountTarget('/dev/shm'), true)
    assert.equal(isSystemMountTarget('/run/user/0'), true)
  })
  it('keeps real user storage targets', () => {
    for (const t of ['/', '/boot/efi', '/mnt/anas-nfs', '/mnttest', '/srv/data'])
      assert.equal(isSystemMountTarget(t), false, t)
  })
})

describe('optionsReadOnly', () => {
  it('detects the ro flag', () => {
    assert.equal(optionsReadOnly('ro,nosuid,nodev'), true)
    assert.equal(optionsReadOnly('rw,relatime'), false)
  })
})

// ---------------------------------------------------------------------------
// cr.60 (review L26): ONE stacked-mount rule and ONE strict reader for every
// mount-family reader. The stacked table is built from CAPTURED rows: the
// `findmnt --json /mnt/anas-nfs` row (findmnt-nfs.json) as the bottom mount
// and the same row with its options flipped to `ro` stacked over it as its
// CHILD — the shape findmnt-full.json shows for a stacked mount (the nfs4 row
// at /mnt/anas-auto is the autofs row's child).
// ---------------------------------------------------------------------------

/** The captured `findmnt --json /mnt/anas-nfs` row. */
const NFS_ROW = (JSON.parse(loadFixture('findmnt-nfs.json')) as { filesystems: Array<Record<string, string>> }).filesystems[0]

/** Two NFS mounts stacked at /mnt/anas-nfs: the bottom `rw`, the top `ro`. */
function stackedNfsTable(): string {
  const top = { ...NFS_ROW, options: NFS_ROW.options.replace(/^rw,/, 'ro,') }
  return JSON.stringify({ filesystems: [{ ...NFS_ROW, children: [top] }] })
}

describe('effectiveMounts / effectiveMountAt — the ONE stacked-mount rule (cr.60, L26)', () => {
  it('two NFS rows at one target: the TOP (last, the child) is the target\'s row', () => {
    const nodes = parseFindmnt(stackedNfsTable())
    assert.equal(nodes.length, 2)
    assert.ok(effectiveMountAt(nodes, '/mnt/anas-nfs')!.options.startsWith('ro,'))
    assert.ok(effectiveMounts(nodes).get('/mnt/anas-nfs')!.options.startsWith('ro,'))
  })

  it('a real mount stacked on the automount placeholder is the identity; the placeholder alone is the row when nothing real sits there', () => {
    const full = parseFindmnt(loadFixture('findmnt-full.json'))
    assert.equal(effectiveMounts(full).get('/mnt/anas-auto')!.fstype, 'nfs4')
    assert.equal(effectiveMountAt(full, '/mnt/anas-auto')!.fstype, 'nfs4')
    const armed = parseFindmnt(loadFixture('findmnt-automount-armed.json'))
    assert.equal(effectiveMounts(armed).get('/mnt/anas-auto')!.fstype, 'autofs')
    assert.equal(effectiveMountAt(armed, '/mnt/anas-auto'), undefined)
  })
})

describe('parseFindmntTable — strict at every depth (cr.60, L26)', () => {
  it('reads every captured table exactly as the lenient parse does', () => {
    for (const name of ['findmnt-full.json', 'findmnt-real.json', 'findmnt-automount-mounted.json'])
      assert.deepEqual(parseFindmntTable(loadFixture(name)), parseFindmnt(loadFixture(name)), name)
  })

  it('a malformed row at ANY depth is unreadable (null), never "fewer mounts"', () => {
    for (const text of [
      '{"filesystems":[{"target":"/","children":42}]}',
      '{"filesystems":[{"target":"/"},null]}',
      '{"filesystems":[{"target":"/","children":[7]}]}',
      '{"filesystems":42}',
      'not json',
    ])
      assert.equal(parseFindmntTable(text), null, text)
  })
})

describe('readFindmntTable — honours the exit status (cr.60, L26)', () => {
  const FULL = loadFixture('findmnt-full.json')
  const exec = (result: { stdout: string, stderr: string, exitCode: number } | Error): MockExecutor => {
    const e = new MockExecutor()
    if (result instanceof Error)
      e.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], throws: result })
    else
      e.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result })
    return e
  }

  it('exit 0 + findmnt\'s shape → the text', async () => {
    assert.equal(await readFindmntTable(exec({ stdout: FULL, stderr: '', exitCode: 0 })), FULL)
  })

  it('a non-zero exit is unreadable WHATEVER its stdout carries; so is a failed start and a wrong shape', async () => {
    assert.equal(await readFindmntTable(exec({ stdout: FULL, stderr: 'findmnt: something failed', exitCode: 1 })), null)
    assert.equal(await readFindmntTable(exec({ stdout: '', stderr: '', exitCode: 1 })), null)
    assert.equal(await readFindmntTable(exec(new Error('spawn /usr/bin/findmnt ENOENT'))), null)
    assert.equal(await readFindmntTable(exec({ stdout: '{"filesystems":[{"target":"/","children":42}]}', stderr: '', exitCode: 0 })), null)
  })
})
