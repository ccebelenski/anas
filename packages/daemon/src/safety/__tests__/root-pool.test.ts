import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isRootPool, rootPoolFromMounts } from '../root-pool.js'

const ZFS_ROOT_MOUNTS = [
  'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
  'tank/ROOT/pve-1 / zfs rw,relatime,xattr,noacl 0 0',
  'tank/data /tank/data zfs rw,relatime,xattr,noacl 0 0',
].join('\n')

const NON_ZFS_ROOT_MOUNTS = [
  '/dev/sda2 / ext4 rw,relatime 0 0',
  'tank/data /tank/data zfs rw,relatime 0 0',
].join('\n')

describe('rootPoolFromMounts', () => {
  it('extracts the pool backing a zfs root filesystem', () => {
    assert.equal(rootPoolFromMounts(ZFS_ROOT_MOUNTS), 'tank')
  })

  it('returns null when root is not a zfs filesystem', () => {
    assert.equal(rootPoolFromMounts(NON_ZFS_ROOT_MOUNTS), null)
  })

  it('returns null for empty input', () => {
    assert.equal(rootPoolFromMounts(''), null)
  })
})

describe('isRootPool', () => {
  it('blocks the well-known rpool by name regardless of mounts', () => {
    assert.equal(isRootPool('rpool', () => ''), true)
  })

  it('blocks the well-known bpool by name', () => {
    assert.equal(isRootPool('bpool', () => ''), true)
  })

  it('blocks the live root pool discovered from mounts', () => {
    assert.equal(isRootPool('tank', () => ZFS_ROOT_MOUNTS), true)
  })

  it('does not block an unrelated pool', () => {
    assert.equal(isRootPool('backup', () => ZFS_ROOT_MOUNTS), false)
  })

  it('does not block when mounts are unreadable and the name is not well-known', () => {
    const throwing = (): string => {
      throw new Error('unreadable')
    }
    assert.equal(isRootPool('backup', throwing), false)
  })
})
