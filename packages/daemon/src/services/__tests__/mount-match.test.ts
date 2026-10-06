import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseFindmnt } from '../../parsers/findmnt.js'
import { describeLive, liveAtTarget, specMatchesLive } from '../mount-match.js'

/**
 * ident.4 (c)/(e): "is what is mounted at the target what is configured
 * there?" — over the REAL findmnt captures (fixtures/mounts, ground truth
 * 2026-07-18) wherever a capture has the shape.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/mounts')
const capture = (name: string) => parseFindmnt(readFileSync(join(FIXTURES, name), 'utf8'))

describe('mount-match (ident.4)', () => {
  it('the captured CIFS mount matches its fstab spec; a different share or a local disk does not', () => {
    const live = liveAtTarget(capture('findmnt-cifs.json'), '/mnt/anas-cifs')
    assert.ok(live.real)
    assert.ok(specMatchesLive({ spec: '//127.0.0.1/anastest', fstype: 'cifs' }, live.real))
    assert.ok(specMatchesLive({ spec: '//127.0.0.1/ANASTEST/', fstype: 'cifs' }, live.real), 'share names are case-insensitive; trailing slash')
    assert.ok(!specMatchesLive({ spec: '//127.0.0.1/other', fstype: 'cifs' }, live.real))
    assert.ok(!specMatchesLive({ spec: '//127.0.0.1/anastest', fstype: 'nfs' }, live.real))
  })

  it('the captured NFS mount (kernel nfs4) matches an fstab `nfs` line', () => {
    const live = liveAtTarget(capture('findmnt-nfs.json'), '/mnt/anas-nfs')
    assert.ok(live.real)
    assert.ok(specMatchesLive({ spec: '127.0.0.1:/srv/nfs/export1', fstype: 'nfs' }, live.real))
    assert.ok(specMatchesLive({ spec: '127.0.0.1:/srv/nfs/export1/', fstype: 'nfs4' }, live.real))
    assert.ok(!specMatchesLive({ spec: '127.0.0.1:/srv/nfs/export2', fstype: 'nfs' }, live.real))
  })

  it('an automount target: the placeholder is "armed", the stacked real mount is what matches', () => {
    const live = liveAtTarget(capture('findmnt-automount-mounted.json'), '/mnt/anas-auto')
    assert.equal(live.armed, true)
    assert.equal(live.real?.fstype, 'nfs4')
    const armed = liveAtTarget(capture('findmnt-automount-armed.json'), '/mnt/anas-auto')
    assert.equal(armed.armed, true)
    assert.equal(armed.real, undefined)
  })

  it('a local disk at a CIFS target is a mismatch, and is named by source and type', () => {
    const node = { target: '/mnt/media', source: '/dev/loop3', fstype: 'ext4', options: 'rw' }
    assert.ok(!specMatchesLive({ spec: '//nas/media', fstype: 'cifs' }, node))
    assert.equal(describeLive(node), '/dev/loop3 (ext4)')
  })

  it('a tag/device spec compares the fstype only; auto/none (bind) compare nothing; zfs compares the dataset', () => {
    const ext4 = { target: '/data', source: '/dev/sdb1', fstype: 'ext4', options: 'rw' }
    assert.ok(specMatchesLive({ spec: 'UUID=1234', fstype: 'ext4' }, ext4))
    assert.ok(!specMatchesLive({ spec: 'UUID=1234', fstype: 'xfs' }, ext4))
    assert.ok(specMatchesLive({ spec: '/srv/a', fstype: 'none' }, ext4))
    assert.ok(specMatchesLive({ spec: 'UUID=1234', fstype: 'auto' }, ext4))
    const zfs = { target: '/tank/a', source: 'tank/a', fstype: 'zfs', options: 'rw' }
    assert.ok(specMatchesLive({ spec: 'tank/a', fstype: 'zfs' }, zfs))
    assert.ok(!specMatchesLive({ spec: 'tank/b', fstype: 'zfs' }, zfs))
  })

  it('the top of a stack is what counts (what umount would take off)', () => {
    const nodes = [
      { target: '/mnt/x', source: '//nas/x', fstype: 'cifs', options: 'rw' },
      { target: '/mnt/x', source: '/dev/loop1', fstype: 'ext4', options: 'rw' },
    ]
    assert.equal(liveAtTarget(nodes, '/mnt/x').real?.source, '/dev/loop1')
  })
})
