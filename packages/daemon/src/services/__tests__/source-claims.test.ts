import type { AhrPool } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { sourceFilesystemOf } from '../backup-consistency.js'
import { mountIndex } from '../nested-filesystems.js'
import { datasetSourceClaims, pathSourceClaims } from '../source-claims.js'

/**
 * Story cr.33b — a data mover's source PATH resolved to the lock keys the
 * destructive verbs take (docs/WAVE3-DESIGN.md §4.3).
 *
 * FIXTURES (ruling (l): fakes print captured output):
 *  - `mounts/findmnt-full.json` — the stunt node's full mount tree (a ZFS
 *    pool `mnttest` with `mnttest/data`, NFS and CIFS mounts, an armed and
 *    mounted automount, `/` on ext4);
 *  - `ahr/findmnt-ahr0.json` — an AHR pool's btrfs mount;
 *  - the `zpool get guid` answer is the dev mock's own line for testpool
 *    (server.ts), served for `mnttest` here.
 * The AHR pool record is the four fields the resolver reads (name, mountpoint,
 * VG UUID), as backup-consistency.test.ts builds its pools.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string => readFileSync(join(__dirname, '../../fixtures', rel), 'utf-8')

const FINDMNT = '/usr/bin/findmnt'
const ZPOOL = '/usr/sbin/zpool'
const FULL = fixture('mounts/findmnt-full.json')
const AHR = fixture('ahr/findmnt-ahr0.json')
const GUID = '5823146802312415237'
const VG_UUID = 'c4Wd2E-1lQp-KdV8-fQ2k-3HbN-9zQe-Lx7T9a'
const AHR0 = { name: 'ahr0', mountpoint: '/mnt/anas-ahr/ahr0', vg: { uuid: VG_UUID } } as unknown as AhrPool

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string) => ({ stdout: '', stderr, exitCode: 1 })

function executor(opts: { findmnt?: string | null, guid?: boolean } = {}): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: FINDMNT, args: ['--json'], result: opts.findmnt === null ? fail('findmnt: failed') : ok(opts.findmnt ?? FULL) })
  mock.addFixture({
    command: ZPOOL,
    args: ['get', '-H', '-o', 'value', 'guid', '--', 'mnttest'],
    result: opts.guid === false ? fail(`cannot open 'mnttest': no such pool`) : ok(`${GUID}\n`),
  })
  return mock
}

const short = (claims: { key: string, mode: string }[]): string[] => claims.map(c => `${c.key} ${c.mode}`)

describe('cr.33b — sourceFilesystemOf: the consistency derivation\'s resolver, asked about the filesystem', () => {
  const facts = { mounts: mountIndex(FULL), ahrPools: [] }

  it('a path on a dataset is the dataset; a remote mount is its mount; a plain path is the root filesystem', () => {
    assert.deepEqual(sourceFilesystemOf('/mnttest/data/photos', facts), { kind: 'zfs', dataset: 'mnttest/data', mountpoint: '/mnttest/data' })
    assert.deepEqual(sourceFilesystemOf('/mnttest', facts), { kind: 'zfs', dataset: 'mnttest', mountpoint: '/mnttest' })
    assert.deepEqual(sourceFilesystemOf('/mnt/anas-nfs/docs', facts), { kind: 'other', mountpoint: '/mnt/anas-nfs' })
    assert.deepEqual(sourceFilesystemOf('/mnt/anas-cifs', facts), { kind: 'other', mountpoint: '/mnt/anas-cifs' })
    assert.deepEqual(sourceFilesystemOf('/etc', facts), { kind: 'other', mountpoint: '/' })
  })

  it('a zvol device path is its volume (no mount); an AHR pool\'s btrfs mount is the pool', () => {
    assert.deepEqual(sourceFilesystemOf('/dev/zvol/mnttest/vol1', facts), { kind: 'zfs', dataset: 'mnttest/vol1' })
    assert.deepEqual(
      sourceFilesystemOf('/mnt/anas-ahr/ahr0/shares/media', { mounts: mountIndex(AHR), ahrPools: [AHR0] }),
      { kind: 'ahr', pool: AHR0, mountpoint: '/mnt/anas-ahr/ahr0' },
    )
    // A btrfs mount that is no ANAS pool is just a mount.
    assert.deepEqual(sourceFilesystemOf('/mnt/anas-ahr/ahr0/x', { mounts: mountIndex(AHR), ahrPools: [] }), { kind: 'other', mountpoint: '/mnt/anas-ahr/ahr0' })
  })

  it('no table, no filesystem', () => {
    assert.equal(sourceFilesystemOf('/mnttest/data', { mounts: new Map(), ahrPools: [] }), null)
  })
})

describe('cr.33b — pathSourceClaims: the keys the destructive verbs take, shared', () => {
  it('a dataset path: the dataset, its ancestors, the pool and its name key, and its mount — all shared', async () => {
    const { claims, unlocked } = await pathSourceClaims(executor(), ['/mnttest/data/photos', '/mnt/anas-nfs/docs'], async () => [])
    assert.deepEqual(short(claims), [
      `zfs:${GUID}/data shared`,
      `zfs:${GUID} shared`,
      `zpool:${GUID} shared`,
      'zname:mnttest shared',
      'mount:/mnttest/data shared',
      'mount:/mnt/anas-nfs shared',
    ])
    assert.deepEqual(unlocked, [])
  })

  it('an AHR path: the VG UUID key and the name key shared, and the pool\'s mount', async () => {
    const { claims } = await pathSourceClaims(executor({ findmnt: AHR }), ['/mnt/anas-ahr/ahr0/shares/media'], async () => [AHR0])
    assert.deepEqual(short(claims), [`ahr:${VG_UUID} shared`, 'ahrname:ahr0 shared', 'mount:/mnt/anas-ahr/ahr0 shared'])
  })

  it('a pool guid that cannot be read falls back to the name key EXCLUSIVE — the dataset verbs\' own fallback', async () => {
    const { claims } = await pathSourceClaims(executor({ guid: false }), ['/mnttest/data/photos'], async () => [])
    assert.deepEqual(short(claims), ['zname:mnttest exclusive', 'mount:/mnttest/data shared'])
    assert.deepEqual(short(await datasetSourceClaims(executor({ guid: false }), ['mnttest/data'])), ['zname:mnttest exclusive'])
  })

  it('an unreadable mount table locks nothing and says so, per path', async () => {
    const { claims, unlocked } = await pathSourceClaims(executor({ findmnt: null }), ['/mnttest/data/photos'], async () => [])
    assert.deepEqual(claims, [])
    assert.deepEqual(unlocked, ['/mnttest/data/photos: no lock on the source - the mount table could not be read, so its filesystem is unknown'])
  })

  it('cr.33c F1: an unreadable AHR topology keeps the mount key, takes no ahr: key, and says why — like the mount-table failure', async () => {
    const { claims, unlocked } = await pathSourceClaims(
      executor({ findmnt: AHR }),
      ['/mnt/anas-ahr/ahr0/shares/media'],
      async () => { throw new Error('mdstat did not answer') },
    )
    assert.deepEqual(short(claims), ['mount:/mnt/anas-ahr/ahr0 shared'])
    assert.deepEqual(unlocked, ['/mnt/anas-ahr/ahr0/shares/media: no lock on the source - the AHR topology could not be read, so it is unknown whether the filesystem is an ANAS AHR pool'])
  })

  it('a btrfs mount that a READABLE topology names no ANAS pool is just a mount — no unlocked sentence', async () => {
    const { claims, unlocked } = await pathSourceClaims(executor({ findmnt: AHR }), ['/mnt/anas-ahr/ahr0/shares'], async () => [])
    assert.deepEqual(short(claims), ['mount:/mnt/anas-ahr/ahr0 shared'])
    assert.deepEqual(unlocked, [])
  })

  it('a replication source or a schedule target: the dataset\'s keys, shared', async () => {
    assert.deepEqual(short(await datasetSourceClaims(executor(), ['mnttest/data'])), [
      `zfs:${GUID}/data shared`,
      `zfs:${GUID} shared`,
      `zpool:${GUID} shared`,
      'zname:mnttest shared',
    ])
  })
})
