import type { AhrPool } from '@anas/shared'
import type { LockClaim } from '../../jobs/locks.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { conflicts, covers, normaliseClaims } from '../../jobs/locks.js'
import { JobQueue, otherJobsClaims } from '../../jobs/queue.js'
import { ahrSourceClaims, datasetSourceClaims, pathSourceClaims } from '../../services/source-claims.js'
import {
  ahrClaim,
  ahrnameClaim,
  ahrPoolClaims,
  diskClaim,
  iscsiLunClaim,
  mountClaim,
  poolClaims,
  scheduleClaim,
  taskClaim,
  unheldClaimsRefusal,
  zfsClaims,
  zfsDatasetClaims,
  znameClaim,
  zpoolClaim,
} from '../guard.js'

/**
 * Story cr.64b1r (1) — `covers()` is SOUND without the `within` promise.
 *
 * The property, with the lock table's own rule ({@link conflicts}) as the
 * oracle: for a job holding H whose re-read needs N, and ANY other job S the
 * queue knows, if `covers` says H covers every claim of N (asked with S as the
 * other job), then every S that N would exclude, H excludes too —
 *
 *     ∀ H, N, S:  N ⊑ H given [S]  ⇒  (S conflicts N ⇒ S conflicts H)
 *
 * swept over every claim-set shape the builders make: guard.ts's pool,
 * dataset, fallback, AHR, name-key and bare-key builders (INCLUDING the
 * import by guid's bare `zpool:<guid>` exclusive, pools.ts, which carries no
 * name key), the composites the guard doors submit (a destroy with its disks,
 * a LUN on its backing, an AHR verb with its disks, a schedule fire), and
 * services/source-claims.ts's three readers run against captured fixtures
 * (`datasetSourceClaims` with the guid read answering and failing,
 * `ahrSourceClaims` with and without the VG UUID, `pathSourceClaims` over a
 * ZFS dataset, a pool root, a remote mount and an AHR pool's btrfs mount).
 * The universe has two pools under one NAME (a pool re-created under its
 * name: two guids) and two AHR pools under one name, so a name key that
 * covers the wrong guid would show.
 *
 * The cr.64b1 review's sweep was 4802 (H, N) pairs against a brute-force
 * oracle; this one asks every (H, N) pair against every S. With `others`
 * empty (cr.64b1's `covers`) the same sweep finds the review's unsound
 * shape — every one with S holding a guid key without its name key — so the
 * sweep has teeth; with the queue's other jobs passed it finds none.
 *
 * FIXTURES (ruling (l)): `mounts/findmnt-full.json` (the stunt node's mount
 * tree: ZFS pool `mnttest`, NFS and CIFS mounts), `ahr/findmnt-ahr0.json`
 * (an AHR pool's btrfs mount), the dev mock's `zpool get guid` line served
 * for `mnttest`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string => readFileSync(join(__dirname, '../../fixtures', rel), 'utf-8')

const FINDMNT = '/usr/bin/findmnt'
const ZPOOL = '/usr/sbin/zpool'
const FULL = fixture('mounts/findmnt-full.json')
const AHR_TABLE = fixture('ahr/findmnt-ahr0.json')
/** mnttest's guid, and a namesake pool's (the pool re-created under its name). */
const G = '5823146802312415237'
const G2 = '2000000000000000001'
/** Another pool. */
const G3 = '3000000000000000003'
const U = 'c4Wd2E-1lQp-KdV8-fQ2k-3HbN-9zQe-Lx7T9a'
const U2 = 'Zz9Zz9-0000-0000-0000-0000-0000-000000'
const AHR0 = { name: 'ahr0', mountpoint: '/mnt/anas-ahr/ahr0', vg: { uuid: U } } as unknown as AhrPool

const MODES = ['shared', 'exclusive'] as const

function executor(opts: { findmnt?: string, guid?: boolean } = {}): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: opts.findmnt ?? FULL, stderr: '', exitCode: 0 } })
  mock.addFixture({
    command: ZPOOL,
    args: ['get', '-H', '-o', 'value', 'guid', '--', 'mnttest'],
    result: opts.guid === false
      ? { stdout: '', stderr: 'cannot open \'mnttest\': no such pool\n', exitCode: 1 }
      : { stdout: `${G}\n`, stderr: '', exitCode: 0 },
  })
  return mock
}

interface Shape { name: string, claims: LockClaim[] }

/** Every claim-set shape, normalised as the queue records it. */
async function universe(): Promise<Shape[]> {
  const out: Shape[] = []
  const add = (name: string, claims: LockClaim[]): void => {
    out.push({ name, claims: normaliseClaims(claims) })
  }
  // guard.ts — pool verbs: guid known (two guids under one name), or the fallback.
  for (const [pool, guids] of [['mnttest', [G, G2, null]], ['tank', [G3, null]]] as const) {
    for (const guid of guids) {
      for (const mode of MODES) {
        add(`poolClaims(${pool}, ${guid}, ${mode})`, poolClaims(pool, guid, mode))
        add(`poolClaims(${pool}, ${guid}, ${mode}, namespace)`, poolClaims(pool, guid, mode, { namespace: true }))
      }
    }
  }
  // guard.ts — dataset verbs (a snapshot locks its dataset), both guids, and the fallback.
  for (const dataset of ['mnttest', 'mnttest/data', 'mnttest/data/photos', 'mnttest/other', 'mnttest/data@snap1', 'tank/a']) {
    const guids = dataset.startsWith('tank') ? [G3] : [G, G2]
    for (const mode of MODES) {
      for (const guid of guids)
        add(`zfsClaims(${guid}, ${dataset}, ${mode})`, zfsClaims(guid, dataset, mode))
      add(`zfsDatasetClaims(null, ${dataset}, ${mode})`, zfsDatasetClaims(null, dataset, mode))
    }
  }
  // guard.ts — the bare keys: the import by guid (pools.ts: `zpoolClaim(target, 'exclusive', target)`, no name key),
  // the namespace verbs' name keys alone (create, import by name), and the AHR twins.
  for (const guid of [G, G2, G3]) {
    for (const mode of MODES)
      add(`bare zpoolClaim(${guid}, ${mode})`, [zpoolClaim(guid, mode, guid)])
  }
  for (const pool of ['mnttest', 'tank']) {
    for (const mode of MODES)
      add(`znameClaim(${pool}, ${mode})`, [znameClaim(pool, mode)])
  }
  for (const uuid of [U, U2, null]) {
    for (const mode of MODES) {
      add(`ahrPoolClaims(ahr0, ${uuid}, ${mode})`, ahrPoolClaims('ahr0', uuid, mode))
      add(`ahrPoolClaims(ahr0, ${uuid}, ${mode}, namespace)`, ahrPoolClaims('ahr0', uuid, mode, { namespace: true }))
    }
  }
  for (const uuid of [U, U2]) {
    for (const mode of MODES)
      add(`bare ahrClaim(${uuid}, ${mode})`, [ahrClaim(uuid, mode, 'ahr0')])
  }
  for (const mode of MODES)
    add(`ahrnameClaim(ahr0, ${mode})`, [ahrnameClaim('ahr0', mode)])
  // The guard doors' composites.
  add('pool destroy with cleanup', [...poolClaims('mnttest', G, 'exclusive', { namespace: true }), diskClaim('ata-DISK1')])
  add('pool create', [znameClaim('mnttest'), mountClaim('/mnttest'), diskClaim('ata-DISK1')])
  add('LUN on a zvol backing', [iscsiLunClaim('SERIAL1'), ...zfsDatasetClaims(G, 'mnttest/vol1', 'exclusive')])
  add('LUN on a zvol backing, guid unread', [iscsiLunClaim('SERIAL1'), ...zfsDatasetClaims(null, 'mnttest/vol1', 'exclusive')])
  add('AHR verb with disks', [...ahrPoolClaims('ahr0', U, 'exclusive'), diskClaim('ata-DISK2')])
  add('access on a dataset path', [mountClaim('/mnttest/data', 'shared'), ...zfsDatasetClaims(G, 'mnttest/data', 'exclusive')])
  add('access on an AHR path', [mountClaim('/mnt/anas-ahr/ahr0', 'shared'), ...ahrPoolClaims('ahr0', U, 'shared')])
  add('mount verb', [mountClaim('/mnttest/data')])
  add('task run', [taskClaim('backup', 'nightly', 'shared')])
  // services/source-claims.ts — the readers, against the fixtures.
  for (const guid of [true, false]) {
    add(`datasetSourceClaims(mnttest/data, guid ${guid ? 'read' : 'unread'})`, await datasetSourceClaims(executor({ guid }), ['mnttest/data']))
    add(`schedule fire on mnttest/data, guid ${guid ? 'read' : 'unread'}`, [...await datasetSourceClaims(executor({ guid }), ['mnttest/data']), scheduleClaim('nightly', 'shared')])
    for (const path of ['/mnttest/data/photos', '/mnttest', '/mnt/anas-nfs/docs'])
      add(`pathSourceClaims(${path}, guid ${guid ? 'read' : 'unread'})`, (await pathSourceClaims(executor({ guid }), [path], async () => [])).claims)
  }
  add('pathSourceClaims(AHR path)', (await pathSourceClaims(executor({ findmnt: AHR_TABLE }), ['/mnt/anas-ahr/ahr0/shares/media'], async () => [AHR0])).claims)
  for (const uuid of [U, null])
    add(`ahrSourceClaims(ahr0, ${uuid})`, ahrSourceClaims('ahr0', uuid))
  return out
}

function conflictsSet(a: readonly LockClaim[], b: readonly LockClaim[]): boolean {
  return a.some(x => b.some(y => x.key === y.key && conflicts(x.mode, y.mode)))
}

interface Unsound { held: string, needed: string, other: string }

function sweep(shapes: readonly Shape[], withOthers: boolean): { pairs: number, triples: number, unsound: Unsound[] } {
  const unsound: Unsound[] = []
  let triples = 0
  for (const h of shapes) {
    for (const n of shapes) {
      for (const s of shapes) {
        triples++
        const covered = n.claims.every(c => covers(h.claims, c, withOthers ? [s.claims] : []))
        if (covered && conflictsSet(s.claims, n.claims) && !conflictsSet(s.claims, h.claims))
          unsound.push({ held: h.name, needed: n.name, other: s.name })
      }
    }
  }
  return { pairs: shapes.length * shapes.length, triples, unsound }
}

describe('cr.64b1r (1) — `covers` against `conflicts` over every builder shape: sound without the `within` promise', () => {
  it('the sweep: every (held, needed) pair against every other job — 0 unsound with the other jobs passed', async () => {
    const shapes = await universe()
    assert.ok(shapes.length >= 90, `universe of ${shapes.length} shapes`)
    const { pairs, triples, unsound } = sweep(shapes, true)
    assert.ok(pairs > 4802, `${pairs} pairs (the review swept 4802)`)
    assert.ok(triples > 700_000, `${triples} triples`)
    assert.deepEqual(unsound.slice(0, 5), [], `${unsound.length} unsound triples`)
  })

  it('the sweep has teeth: cr.64b1\'s `covers` (no other jobs asked) is unsound exactly where another job holds a guid key WITHOUT its name key — the import by guid\'s bare `zpool:<guid>` and the bare `ahr:` twin', async () => {
    const shapes = await universe()
    const { unsound } = sweep(shapes, false)
    assert.ok(unsound.length > 0, 'the old rule is unsound somewhere')
    const others = new Set(unsound.map(u => u.other))
    assert.deepEqual([...others].filter(o => !o.startsWith('bare ')), [], 'every unsound triple is a bare guid or VG-UUID key')
    // The review's own pair: the dataset snapshot's route fallback held, the guid keys needed, the import running.
    assert.ok(unsound.some(u => u.held === 'zfsDatasetClaims(null, mnttest/data, shared)'
      && u.needed === `zfsClaims(${G}, mnttest/data, shared)` && u.other === `bare zpoolClaim(${G}, exclusive)`))
  })

  it('liveness: the route-only fallback still covers the guid keys when no other job breaks the promise (cr.64b1 (A)\'s run) — and stops covering them while the import by guid runs', async () => {
    const fallback = normaliseClaims(zfsDatasetClaims(null, 'mnttest/data', 'shared'))
    const guidKeyed = normaliseClaims(zfsDatasetClaims(G, 'mnttest/data', 'shared'))
    assert.equal(unheldClaimsRefusal('Dataset \'mnttest/data\'', 'x', fallback, guidKeyed, []), null)
    // Every promise-keeping shape running beside it: still covered.
    const keepers = (await universe()).filter(s => !s.name.startsWith('bare ')).map(s => s.claims)
    assert.ok(guidKeyed.every(c => covers(fallback, c, keepers)))
    // The import by guid of THIS pool: the cover is void, the recompute refuses.
    const importing = [zpoolClaim(G, 'exclusive', G)]
    assert.equal(covers(fallback, guidKeyed.find(c => c.key === `zpool:${G}`)!, [importing]), false)
    assert.ok(unheldClaimsRefusal('Dataset \'mnttest/data\'', 'x', fallback, guidKeyed, [importing]))
    // The import of ANOTHER guid (the namesake's) does not void it.
    assert.ok(guidKeyed.every(c => covers(fallback, c, [[zpoolClaim(G2, 'exclusive', G2)]])))
  })

  it('the queue\'s read-only holder query: a job body sees every OTHER job\'s claims (holding or waiting), never its own; outside a job, none', async () => {
    assert.deepEqual(otherJobsClaims(), [])
    const queue = new JobQueue()
    let endImport!: () => void
    const importDone = new Promise<void>((resolve) => {
      endImport = resolve
    })
    const importing = queue.submit('zpool.import', { user: 'root@pam', uid: 0 }, async () => importDone, { locks: [zpoolClaim(G, 'exclusive', G)] })
    let seen: string[][] = []
    const snapshot = queue.submit('zfs.snapshot', { user: 'root@pam', uid: 0 }, async () => {
      seen = otherJobsClaims().map(set => set.map(c => `${c.key} ${c.mode}`))
    }, { locks: zfsDatasetClaims(null, 'mnttest/data', 'shared') })
    for (let i = 0; i < 20 && queue.get(snapshot.id)?.status !== 'completed'; i++)
      await new Promise(resolve => setImmediate(resolve))
    assert.equal(queue.get(snapshot.id)?.status, 'completed')
    assert.deepEqual(seen, [[`zpool:${G} exclusive`]])
    endImport()
    for (let i = 0; i < 20 && queue.get(importing.id)?.status !== 'completed'; i++)
      await new Promise(resolve => setImmediate(resolve))
  })
})
