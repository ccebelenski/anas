import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BackupNestedScan, UnmountedMount } from '../schemas/backup.js'

/**
 * backup2.11 — the ONE `UnmountedMount` shape, and the additive, optional key
 * that carries it out to the backup wizard on the boundary scan.
 *
 * The contract being pinned is compatibility: a scan WITHOUT the key must keep
 * parsing (an older daemon answers that way, and the guard fails open to it),
 * and nothing in a request body may ever set it.
 */

/** A minimal, valid scan — the shape every consumer already speaks. */
const SCAN = {
  path: '/mnt/pictures',
  exists: true,
  includeNested: 'none' as const,
  nested: [],
  truncated: false,
  warnings: [],
}

const MOUNT = {
  mountpoint: '/mnt/pictures',
  source: '//nas/pictures',
  fstype: 'cifs',
  disabled: false,
}

describe('UnmountedMount (backup2.11)', () => {
  it('carries the mountpoint plus the two FSTAB fields a refusal names', () => {
    const parsed = UnmountedMount.parse(MOUNT)
    assert.deepEqual(parsed, MOUNT)
  })

  it('`disabled` is optional — an older answer without it still parses', () => {
    const parsed = UnmountedMount.parse({ mountpoint: '/mnt/old', source: '//nas/old', fstype: 'cifs' })
    assert.equal(parsed.disabled, undefined)
  })

  it('the mountpoint must be ABSOLUTE — a relative one is not a mountpoint', () => {
    assert.equal(UnmountedMount.safeParse({ ...MOUNT, mountpoint: 'mnt/pictures' }).success, false)
  })

  it('every named field is required — a half-answer cannot be built', () => {
    assert.equal(UnmountedMount.safeParse({ mountpoint: '/mnt/pictures' }).success, false)
    assert.equal(UnmountedMount.safeParse({ mountpoint: '/mnt/pictures', source: '//nas/pictures' }).success, false)
  })
})

describe('BackupNestedScan.unmounted (backup2.11)', () => {
  it('a scan WITHOUT the key parses — the field is additive and optional', () => {
    const parsed = BackupNestedScan.parse(SCAN)
    assert.equal(parsed.unmounted, undefined)
  })

  it('a scan WITH the key round-trips it verbatim', () => {
    const parsed = BackupNestedScan.parse({ ...SCAN, unmounted: MOUNT })
    assert.deepEqual(parsed.unmounted, MOUNT)
  })

  it('a malformed `unmounted` is rejected rather than quietly dropped', () => {
    assert.equal(BackupNestedScan.safeParse({ ...SCAN, unmounted: { mountpoint: '/mnt/x' } }).success, false)
    assert.equal(BackupNestedScan.safeParse({ ...SCAN, unmounted: true }).success, false)
  })
})
