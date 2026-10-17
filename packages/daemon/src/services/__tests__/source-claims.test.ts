import type { AhrPool } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { guardCheck, LockClaimsUnreadableError } from '../../safety/guard.js'
import { sourceFilesystemOf } from '../backup-consistency.js'
import { mountIndex } from '../nested-filesystems.js'
import { datasetSourceClaims, pathSourceClaims, realSourcePath } from '../source-claims.js'

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

describe('cr.64b1 (B) — inside a guard door the reader fails CLOSED; outside it, cr.33b\'s fail-open with the unread paths named', () => {
  it('outside a guard door: no key, the sentence, and the path listed as unread (a read failed — not a fact about the path)', async () => {
    const { claims, unread } = await pathSourceClaims(executor({ findmnt: null }), ['/mnttest/data/photos'], async () => [])
    assert.deepEqual(claims, [])
    assert.deepEqual(unread, ['/mnttest/data/photos'])
    const ahr = await pathSourceClaims(executor({ findmnt: AHR }), ['/mnt/anas-ahr/ahr0/shares/media'], async () => {
      throw new Error('mdstat did not answer')
    })
    assert.deepEqual(ahr.unread, ['/mnt/anas-ahr/ahr0/shares/media'])
    const readable = await pathSourceClaims(executor(), ['/mnttest/data/photos'], async () => [])
    assert.deepEqual(readable.unread, [])
  })

  it('inside a guard door (a spec\'s `locks`): the route door answers 503 UNAVAILABLE naming the read, never a lock on nothing', async () => {
    const pre = await guardCheck({
      operation: 'test.verb',
      object: { what: 'Thing \'x\'', read: async () => ({}), id: async () => ({ x: '1' }), unbound: () => 'unbound' },
      gates: [],
      locks: async () => (await pathSourceClaims(executor({ findmnt: null }), ['/mnttest/data/photos'], async () => [])).claims,
    })
    assert.ok('refusal' in pre)
    assert.equal(pre.refusal.status, 503)
    assert.equal(pre.refusal.code, 'UNAVAILABLE')
    assert.match(pre.refusal.message, /^Thing 'x': the mount table could not be read \(findmnt --json exited 1: [^)]*\), so the filesystem \/mnttest\/data\/photos lives on cannot be locked — nothing was done; try again$/)
  })

  it('the error type is the guard\'s, so the door can tell it from any other failure', () => {
    assert.ok(new LockClaimsUnreadableError('x') instanceof Error)
  })
})

describe('cr.64b1 (H) — realSourcePath: realpath over every EXISTING component, the missing tail appended', () => {
  /** A fake filesystem: `links` maps a path to its target; `exists` lists real directories. */
  function fakeFs(links: Record<string, string>, exists: string[]): (p: string) => Promise<string> {
    return async (p) => {
      const resolve = (path: string): string => {
        for (const [from, to] of Object.entries(links)) {
          if (path === from || path.startsWith(`${from}/`))
            return resolve(to + path.slice(from.length))
        }
        return path
      }
      const real = resolve(p)
      if (!exists.includes(real))
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return real
    }
  }

  it('a symlinked source resolves to its target; a plain path is itself', async () => {
    const fs = fakeFs({ '/srv/link': '/tank/media' }, ['/', '/srv', '/tank', '/tank/media', '/tank/media/photos'])
    assert.equal(await realSourcePath('/srv/link', fs), '/tank/media')
    assert.equal(await realSourcePath('/srv/link/photos/', fs), '/tank/media/photos')
    assert.equal(await realSourcePath('/tank/media', fs), '/tank/media')
  })

  it('a missing tail resolves its LONGEST EXISTING ancestor — through a symlink there too', async () => {
    const fs = fakeFs({ '/srv/link': '/tank/media' }, ['/', '/srv', '/tank', '/tank/media'])
    assert.equal(await realSourcePath('/srv/link/not/yet', fs), '/tank/media/not/yet')
    assert.equal(await realSourcePath('/nowhere/at/all', fs), '/nowhere/at/all')
  })

  it('a zvol device path stays its own name (its realpath, /dev/zdN, would lose the dataset); another failure keeps the text', async () => {
    assert.equal(await realSourcePath('/dev/zvol/tank/vol1', async () => '/dev/zd16'), '/dev/zvol/tank/vol1')
    const loop = async (): Promise<string> => {
      throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' })
    }
    assert.equal(await realSourcePath('/srv/loop/x', loop), '/srv/loop/x')
  })
})
