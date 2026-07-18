import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyKind, isPseudoFstype, isSystemMountTarget, optionsReadOnly, parseFindmnt } from '../findmnt.js'

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

describe('classifyKind', () => {
  it('disambiguates from fstype/source (ground truth §1)', () => {
    assert.equal(classifyKind('cifs', '//127.0.0.1/anastest'), 'cifs')
    assert.equal(classifyKind('nfs4', '127.0.0.1:/srv/nfs/export1'), 'nfs')
    assert.equal(classifyKind('zfs', 'mnttest'), 'zfs')
    assert.equal(classifyKind('autofs', 'systemd-1'), 'autofs')
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
