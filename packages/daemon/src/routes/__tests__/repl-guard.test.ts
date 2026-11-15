import type { Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../server.js'
import { heldCountListArgs, LEGACY_REPLICATION_HOLD_TAG, REPLICA_HELD_SNAPSHOT_CAP, replicationHoldTag } from '../../services/replication-holds.js'
import { renderServiceUnit } from '../../services/replication-units.js'
import { destroyZfsSnapshotArgs } from '../../services/zfs-snapshot.js'
import { DATASET_SET_PRESENTATION_ONLY, replicaTargetConfirm } from '../datasets.js'

/**
 * Story repl.guard — three operator rulings of 2026-11-15, each at ONE door.
 *
 *  1. `readonly` on -> off on a dataset that is a replication TARGET gets a
 *     confirm (never a refusal); every other edit answers as before.
 *  2. A snapshot carrying a replication hold is not renamed (replication
 *     matches by name).
 *  3. A held snapshot's destroy is refused naming each hold, before ZFS's bare
 *     "dataset is busy".
 *
 * Holds are served from CAPTURES, never typed: the target side is
 * `zfs/replication-tree/dst-holds-batch.txt` (the rrep.0 capture of `zfs holds
 * -H` on a recursive replica, OpenZFS 2.4.4), one row re-pointed to
 * `testpool/media@snap2` with the case's tag; a non-replication hold is
 * `zfs/zfs-holds-cr47e.txt` (tag `keep`), re-pointed the same way. The
 * readonly read is the third capture's row shape (`zfs get -Hp -o
 * property,value,source readonly`: `readonly<TAB>on<TAB>local`). The
 * `name,userrefs` snapshot list is TYPED in the `-Hp` row shape of
 * `replication-tree/dst-snaps-p.txt` (tab-separated, exact integers): no
 * capture of that column pair exists yet (a node item).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const ZFS = '/usr/sbin/zfs'
/** U+2026, built from its code point so this file carries no ellipsis character. */
const ELLIPSIS = String.fromCharCode(0x2026)
const DS = 'testpool/media'
const SNAP2 = `${DS}@snap2`

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

/** One captured `zfs holds -H` row (`<snapshot>\t<tag>\t<timestamp>`), re-pointed to `snap` under `tag`. */
function capturedHoldRow(rel: string, snap: string, tag?: string): string {
  const row = fixture(rel).split('\n').find(l => l.trim() && !l.startsWith('#'))!
  const [, capturedTag, stamp] = row.split('\t')
  assert.ok(stamp, `${rel}: a three-column -H row`)
  return `${snap}\t${tag ?? capturedTag}\t${stamp}`
}
/** A replication hold on `snap` (the rrep.0 target capture's row). */
const replHold = (tag: string, snap = SNAP2): string => `${capturedHoldRow('zfs/replication-tree/dst-holds-batch.txt', snap, tag)}\n`
/** The cr.47e capture's own hold (`keep`) on `snap`. */
const keepHold = (snap = SNAP2): string => `${capturedHoldRow('zfs/zfs-holds-cr47e.txt', snap)}\n`

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
const failed = (stderr: string): ExecResult => ({ stdout: '', stderr, exitCode: 1 })

/** The third capture's readonly row. */
const READONLY_ON = ok('readonly\ton\tlocal\n')
const READONLY_OFF = ok('readonly\toff\tlocal\n')
/** `name\tuserrefs`, newest first: snap2 held once, snap1 not. */
const SNAP2_HELD = ok(`${SNAP2}\t1\n${DS}@snap1\t0\n`)
const NONE_HELD = ok(`${SNAP2}\t0\n${DS}@snap1\t0\n`)

const READONLY_ARGS = ['get', '-Hp', '-o', 'property,value,source', 'readonly', '--', DS]
const LIST_ARGS = heldCountListArgs(DS)

type Answer = ExecResult | 'throws'

const SET_URL = '/v1/pools/testpool/datasets/media'
const RENAME_URL = '/v1/pools/testpool/datasets/media/snapshots/snap2'
const DESTROY_URL = '/v1/pools/testpool/datasets/media/snapshots/snap2'

describe('repl.guard', () => {
  let dir: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  let logs: string[] = []
  let readonlyRead: Answer = READONLY_ON
  let heldList: Answer = SNAP2_HELD
  let holds: Answer = ok('')
  const savedEnv: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    if (!(k in savedEnv))
      savedEnv[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-replguard-'))
    await mkdir(join(dir, 'units'), { recursive: true })
    setEnv('ANAS_SYSTEMD_DIR', join(dir, 'units'))
    setEnv('ANAS_STORAGE_CFG', join(dir, 'storage.cfg'))
    setEnv('ANAS_PVE_PRIV_STORAGE_DIR', join(dir, 'priv-storage'))
    setEnv('ANAS_ISCSI_CONFIGFS', join(dir, 'absent-configfs'))
    setEnv('ANAS_ISCSI_SAVECONFIG', join(dir, 'absent-saveconfig.json'))
    setEnv('ANAS_ISCSI_SYS_BLOCK', join(dir, 'absent-block'))
    // This node is `pve-b` of a two-node cluster.
    setEnv('ANAS_PVE_MEMBERS', join(dir, 'members.json'))
    await writeFile(join(dir, 'members.json'), JSON.stringify({ nodename: 'pve-b', nodelist: { 'pve-a': {}, 'pve-b': {} } }))
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined)
        delete process.env[k]
      else
        process.env[k] = v
    }
  })

  async function serve(): Promise<void> {
    readonlyRead = READONLY_ON
    heldList = SNAP2_HELD
    holds = ok('')
    logs = []
    const stream = {
      write: (line: string): void => {
        logs.push(line)
      },
    }
    server = createServer({ mock: true, logger: { level: 'warn', stream } })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    const answer = (a: Answer): ExecResult => {
      if (a === 'throws')
        throw Object.assign(new Error('spawn /usr/sbin/zfs EAGAIN'), { code: 'EAGAIN' })
      return a
    }
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      if (command === ZFS && args.join('\0') === READONLY_ARGS.join('\0'))
        return answer(readonlyRead)
      if (command === ZFS && args.join('\0') === LIST_ARGS.join('\0'))
        return answer(heldList)
      if (command === ZFS && args[0] === 'holds')
        return answer(holds)
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  function inject(method: 'PUT' | 'DELETE', url: string, body?: unknown, confirm?: string) {
    const headers: Record<string, string> = { ...IDENTITY_HEADERS }
    if (confirm)
      headers['x-anas-confirm'] = confirm
    return server!.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) })
  }

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = queue().get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  /** Hold all four slots; returns the release. */
  function fillSlots(): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue().submit('test.hold', { user: 'test', uid: 0 }, () => held)
    return release
  }

  async function task(name: string, t: Record<string, unknown>): Promise<void> {
    await writeFile(join(dir, 'units', `anas-repl-${name}.service`), renderServiceUnit({
      name,
      schedule: 'daily',
      snapshotFirst: true,
      enabled: true,
      notify: 'on-failure',
      ...t,
    } as Parameters<typeof renderServiceUnit>[0]))
  }

  const zfsCalls = (verb: string) => calls.filter(c => c.command === ZFS && c.args[0] === verb)
  const readonlyReads = () => calls.filter(c => c.command === ZFS && c.args.join('\0') === READONLY_ARGS.join('\0'))
  const listReads = () => calls.filter(c => c.command === ZFS && c.args.join('\0') === LIST_ARGS.join('\0'))
  const setCalls = () => zfsCalls('set').filter(c => c.args.includes(DS))

  const LOCAL_TAG = replicationHoldTag({ kind: 'local' }, DS)
  const PEER_TAG = replicationHoldTag({ kind: 'peer', name: 'pve-b' }, DS)
  /** A registered remote's chain into this dataset, keyed by the sender's name for this node — not computable here. */
  const REMOTE_CHAIN_TAG = replicationHoldTag({ kind: 'remote', name: 'offsite' }, DS)
  /** This node SENDS testpool/media to backup/media locally: the hold on the source carries the target's tag. */
  const SOURCE_TAG = replicationHoldTag({ kind: 'local' }, 'backup/media')

  async function readonlyOff() {
    return inject('PUT', SET_URL, { properties: { readonly: false } })
  }

  // ---- item 1: the predicate table ------------------------------------------

  describe('item 1 — readonly on -> off on a replication target asks to confirm', () => {
    it('the confirm sentence names the dataset and says what turning read-only off does', () => {
      const c = replicaTargetConfirm(DS, { snapshot: SNAP2, tag: LOCAL_TAG })
      assert.equal(c.message, `'${DS}' is a replication target. While it is read-only nothing changes it.`)
      assert.deepEqual(c.warnings, [
        'Once it is not read-only, any write to it changes it, and so does any read of a file on it while access-time updates (atime) are on.',
        'Replication into it then stops until the target is rolled back to the last replicated snapshot, which discards what was written. Turning read-only back on does not undo a change already made.',
        'The next replication run sets it read-only again if nothing was written to it by then: its receive does when there is something to send, and the run itself when there is not.',
        'To keep this copy as the live dataset, remove the replication task that sends into it, on the sending node; until then each run sets this dataset read-only again, or fails once it was written to.',
        `It carries the replication hold ${LOCAL_TAG} on '${SNAP2}'.`,
      ])
      for (const s of [c.message, ...c.warnings])
        assert.ok(!s.includes(ELLIPSIS), 'no ellipsis character')
      // A hold no task on this node derives: the headline states the two facts read.
      const u = replicaTargetConfirm(DS, { snapshot: SNAP2, tag: LOCAL_TAG, via: 'unattributed' })
      assert.equal(u.message, `'${DS}' looks like a replication target: it is read-only and replication holds one of its snapshots. While it is read-only nothing changes it.`)
      assert.deepEqual(u.warnings, c.warnings)
    })

    it('presentation-only fields of the property confirm: none', () => {
      assert.deepEqual(DATASET_SET_PRESENTATION_ONLY, {})
    })

    const TARGETS: [string, () => Promise<string>][] = [
      ['target by the LOCAL tag', async () => replHold(LOCAL_TAG)],
      ['target by the PEER tag (this node is pve-b)', async () => replHold(PEER_TAG)],
      ['target by a recursive ROOT\'s tag (testpool replicated recursively, this a child)', async () => replHold(replicationHoldTag({ kind: 'local' }, 'testpool'))],
      ['a registered remote\'s chain, by the fallback (read-only, no task here sends it)', async () => replHold(REMOTE_CHAIN_TAG)],
      ['a replica with the LEGACY tag, by the fallback', async () => replHold(LEGACY_REPLICATION_HOLD_TAG)],
    ]
    for (const [name, world] of TARGETS) {
      it(`predicate: ${name} -> 409 CONFIRMATION_REQUIRED, nothing set`, async () => {
        await serve()
        holds = ok(await world())
        const res = await readonlyOff()
        assert.equal(res.statusCode, 409, res.body)
        const err = res.json().error
        assert.equal(err.code, 'CONFIRMATION_REQUIRED')
        // A tag this node derives says "is"; the fallback (a hold no task
        // here derives) states the two facts that were read.
        assert.equal(err.message, name.includes('by the fallback')
          ? `'${DS}' looks like a replication target: it is read-only and replication holds one of its snapshots. While it is read-only nothing changes it.`
          : `'${DS}' is a replication target. While it is read-only nothing changes it.`)
        assert.ok(typeof res.headers['x-anas-confirm-code'] === 'string')
        assert.deepEqual(setCalls(), [], 'no zfs set ran')
        // The holds read is ONE call, over the held snapshots only.
        assert.deepEqual(zfsCalls('holds').map(c => c.args), [['holds', '-H', '--', SNAP2]])
      })
    }

    it('predicate: a SOURCE carrying its chain\'s hold (a local task sends it) -> no confirm, 202', async () => {
      await serve()
      await task('to-backup', { source: { pool: 'testpool', dataset: 'media' }, target: { pool: 'backup', dataset: 'media' } })
      holds = ok(replHold(SOURCE_TAG))
      const res = await readonlyOff()
      assert.equal(res.statusCode, 202, res.body)
    })

    it('predicate: a read-only SOURCE sending to a registered remote by a task here -> no confirm, 202', async () => {
      await serve()
      await task('offsite', { source: { pool: 'testpool', dataset: 'media' }, target: { pool: 'tank', dataset: 'media', location: { kind: 'remote', name: 'nas1' } } })
      holds = ok(replHold(replicationHoldTag({ kind: 'remote', name: 'nas1' }, 'tank/media')))
      const res = await readonlyOff()
      assert.equal(res.statusCode, 202, res.body)
    })

    it('predicate: the legacy tag on a dataset a task here sends from -> no confirm, 202', async () => {
      await serve()
      await task('to-backup', { source: { pool: 'testpool', dataset: 'media' }, target: { pool: 'backup', dataset: 'media' } })
      holds = ok(replHold(LEGACY_REPLICATION_HOLD_TAG))
      const res = await readonlyOff()
      assert.equal(res.statusCode, 202, res.body)
    })

    it('predicate: an operator\'s own read-only dataset with no hold -> no confirm, 202, and no holds read', async () => {
      await serve()
      heldList = NONE_HELD
      const res = await readonlyOff()
      assert.equal(res.statusCode, 202, res.body)
      assert.deepEqual(zfsCalls('holds'), [], 'nothing held: no zfs holds')
    })

    it('predicate: a non-replication hold (`keep`, captured) -> no confirm, 202', async () => {
      await serve()
      holds = ok(keepHold())
      const res = await readonlyOff()
      assert.equal(res.statusCode, 202, res.body)
    })

    it('predicate: a read that FAILS neither blocks nor confirms — the edit proceeds, logged', async () => {
      const worlds: [string, () => void][] = [
        ['holds exit 1', () => { holds = failed('cannot open \'testpool/media@snap2\': dataset does not exist') }],
        ['holds throws', () => { holds = 'throws' }],
        ['snapshot list exit 1', () => { heldList = failed('pool I/O is currently suspended') }],
        ['readonly read exit 1', () => { readonlyRead = failed('pool I/O is currently suspended') }],
        ['readonly read throws', () => { readonlyRead = 'throws' }],
      ]
      for (const [name, world] of worlds) {
        await serve()
        world()
        const res = await readonlyOff()
        assert.equal(res.statusCode, 202, `${name}: ${res.body}`)
        const job = await finished((res.json() as JobAccepted).job.id)
        assert.equal(job.status, 'completed', `${name}: ${JSON.stringify(job.error)}`)
        assert.deepEqual(setCalls().map(c => c.args), [['set', '--', 'readonly=off', DS]], `${name}: the set ran`)
        assert.ok(logs.some(l => /repl\.guard: could not tell whether 'testpool\/media' is a replication target/.test(l)), `${name}: logged`)
        await server!.close()
        server = undefined
      }
    })

    it('predicate: a task list that cannot be read in full is a failed read for the fallback (no confirm, logged)', async () => {
      await serve()
      await writeFile(join(dir, 'units', 'anas-repl-broken.service'), '[Unit]\nDescription=not a task\n')
      holds = ok(replHold(REMOTE_CHAIN_TAG))
      const res = await readonlyOff()
      assert.equal(res.statusCode, 202, res.body)
      assert.ok(logs.some(l => /replication task list could not be read in full/.test(l)))
    })

    it('the confirm round trip through the real route: 409 with a code, the replay 202, `zfs set readonly=off` once', async () => {
      await serve()
      holds = ok(replHold(LOCAL_TAG))
      const first = await readonlyOff()
      assert.equal(first.statusCode, 409, first.body)
      const code = first.headers['x-anas-confirm-code'] as string
      assert.deepEqual(setCalls(), [])
      const res = await inject('PUT', SET_URL, { properties: { readonly: false } }, code)
      assert.equal(res.statusCode, 202, res.body)
      const job = await finished((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(setCalls().map(c => c.args), [['set', '--', 'readonly=off', DS]], 'zfs set readonly=off ran exactly once')
      // A code is for THIS request: the same code on another property set is re-challenged.
      const other = await inject('PUT', SET_URL, { properties: { readonly: false, atime: false } }, code)
      assert.equal(other.statusCode, 409, other.body)
    })

    it('a hold the predicate cannot see beyond the cap reads newest-first: one holds call over at most the cap', async () => {
      await serve()
      const rows: string[] = []
      for (let i = 0; i < REPLICA_HELD_SNAPSHOT_CAP + 10; i++)
        rows.push(`${DS}@s${String(1000 - i)}\t1`)
      heldList = ok(`${rows.join('\n')}\n`)
      const res = await readonlyOff()
      assert.equal(res.statusCode, 202, res.body)
      const hc = zfsCalls('holds')
      assert.equal(hc.length, 1)
      assert.equal(hc[0].args.length, 3 + REPLICA_HELD_SNAPSHOT_CAP, 'bounded')
      assert.equal(hc[0].args[3], `${DS}@s1000`, 'the newest held snapshot first')
    })

    // ---- no confirm, no extra command ----------------------------------------

    it('readonly off -> on: no confirm, and no extra command (no readonly read, no snapshot list, no holds)', async () => {
      await serve()
      holds = ok(replHold(LOCAL_TAG))
      const res = await inject('PUT', SET_URL, { properties: { readonly: true } })
      assert.equal(res.statusCode, 202, res.body)
      assert.deepEqual(readonlyReads(), [])
      assert.deepEqual(listReads(), [])
      assert.deepEqual(zfsCalls('holds'), [])
    })

    it('an edit that does not touch readonly runs the same argv sequence as before the guard — none of its reads', async () => {
      await serve()
      holds = ok(replHold(LOCAL_TAG))
      const res = await inject('PUT', SET_URL, { properties: { compression: 'lz4' } })
      assert.equal(res.statusCode, 202, res.body)
      const job = await finished((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(readonlyReads(), [])
      assert.deepEqual(listReads(), [])
      assert.deepEqual(zfsCalls('holds'), [])
      assert.deepEqual(setCalls().map(c => c.args), [['set', '--', 'compression=lz4', DS]])
    })

    it('readonly=off on a dataset already writable: one readonly read, nothing more, 202', async () => {
      await serve()
      readonlyRead = READONLY_OFF
      holds = ok(replHold(LOCAL_TAG))
      const res = await readonlyOff()
      assert.equal(res.statusCode, 202, res.body)
      assert.equal(readonlyReads().length, 1)
      assert.deepEqual(listReads(), [])
      assert.deepEqual(zfsCalls('holds'), [])
    })

    it('readonly on -> off on an ordinary dataset answers exactly as an ordinary edit (202, the one set)', async () => {
      await serve()
      heldList = NONE_HELD
      const res = await readonlyOff()
      assert.equal(res.statusCode, 202, res.body)
      assert.deepEqual(Object.keys(res.json()), ['job'])
      const job = await finished((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(setCalls().map(c => c.args), [['set', '--', 'readonly=off', DS]])
      assert.deepEqual(logs.filter(l => /repl\.guard/.test(l)), [], 'nothing logged: every read answered')
    })
  })

  // ---- item 2: rename -------------------------------------------------------

  describe('item 2 — renaming a snapshot that carries a replication hold is refused', () => {
    const RENAME = { newName: 'renamed' }
    const renames = () => zfsCalls('rename')

    it('refused on the TARGET side (a chain no task here names), naming the tag — nothing renamed', async () => {
      await serve()
      holds = ok(replHold(LOCAL_TAG))
      const res = await inject('PUT', RENAME_URL, RENAME)
      assert.equal(res.statusCode, 409, res.body)
      assert.deepEqual(res.json().error, {
        code: 'CONFLICT',
        reason: 'snapshot-held',
        message: `Renaming '${SNAP2}' is refused: it is held by a replication no task names (an interactive replicate, or a removed task): ${LOCAL_TAG}. `
          + `Replication into or from '${DS}' finds its common snapshot by this name; renamed, the next run cannot see it and may report the target as diverged. `
          + `Nothing was renamed. To rename it anyway, release that hold first (zfs release <tag> ${SNAP2}): `
          + 'the snapshot is then no longer protected from retention, and the chain may need a full send.',
      })
      assert.deepEqual(renames(), [])
    })

    it('refused on the SOURCE side, naming the task that holds it', async () => {
      await serve()
      await task('to-backup', { source: { pool: 'testpool', dataset: 'media' }, target: { pool: 'backup', dataset: 'media' } })
      holds = ok(replHold(SOURCE_TAG))
      const res = await inject('PUT', RENAME_URL, RENAME)
      assert.equal(res.statusCode, 409, res.body)
      assert.match(res.json().error.message, new RegExp(`^Renaming '${SNAP2}' is refused: it is held by replication task 'to-backup': ${SOURCE_TAG}\\. `))
      assert.deepEqual(renames(), [])
    })

    it('refused for the legacy tag too', async () => {
      await serve()
      holds = ok(replHold(LEGACY_REPLICATION_HOLD_TAG))
      const res = await inject('PUT', RENAME_URL, RENAME)
      assert.equal(res.statusCode, 409, res.body)
      assert.match(res.json().error.message, /held by replication \(the shared tag from before per-chain tags\): anas-repl\. /)
      assert.deepEqual(renames(), [])
    })

    it('allowed with no hold, and with a hold that is not a replication\'s (`keep`) — the rename argv unchanged', async () => {
      for (const answer of [ok(''), ok(keepHold())]) {
        await serve()
        holds = answer
        const res = await inject('PUT', RENAME_URL, RENAME)
        assert.equal(res.statusCode, 202, res.body)
        const job = await finished((res.json() as JobAccepted).job.id)
        assert.equal(job.status, 'completed', JSON.stringify(job.error))
        assert.deepEqual(renames().map(c => c.args), [['rename', '--', SNAP2, `${DS}@renamed`]])
        await server!.close()
        server = undefined
      }
    })

    it('a holds read that fails REFUSES (fail closed) — nothing renamed', async () => {
      for (const answer of [failed('pool I/O is currently suspended'), 'throws'] as const) {
        await serve()
        holds = answer
        const res = await inject('PUT', RENAME_URL, RENAME)
        assert.equal(res.statusCode, 409, res.body)
        assert.deepEqual(res.json().error, {
          code: 'CONFLICT',
          reason: 'snapshot-holds-unreadable',
          message: `Could not read the holds on '${SNAP2}' — refusing the rename: replication finds its common snapshot by name, `
            + 'and a replication base renamed cuts its chain. Nothing was renamed.',
        })
        assert.deepEqual(renames(), [])
        await server!.close()
        server = undefined
      }
    })

    it('a replication hold placed while the rename waits fails the job — no zfs rename (the gate runs in the job too)', async () => {
      await serve()
      const release = fillSlots()
      const res = await inject('PUT', RENAME_URL, RENAME)
      assert.equal(res.statusCode, 202, res.body)
      holds = ok(replHold(LOCAL_TAG))
      release()
      const job = await finished((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error?.code, 'CONFLICT')
      assert.match(job.error!.message, /^Renaming 'testpool\/media@snap2' is refused/)
      assert.deepEqual(renames(), [])
    })
  })

  // ---- item 3: destroy ------------------------------------------------------

  describe('item 3 — destroying a held snapshot is refused naming each hold', () => {
    const destroys = () => zfsCalls('destroy')

    it('a hold that is not a replication\'s (`keep`, captured): the D11 naming, no destroy argv', async () => {
      await serve()
      holds = ok(keepHold())
      const res = await inject('DELETE', DESTROY_URL)
      assert.equal(res.statusCode, 409, res.body)
      assert.deepEqual(res.json().error, {
        code: 'CONFLICT',
        reason: 'snapshot-held',
        message: `Destroying '${SNAP2}' is refused: ZFS does not destroy a held snapshot — nothing was done. ${SNAP2} held by 'keep'.`,
      })
      assert.deepEqual(destroys(), [])
    })

    it('a replication hold: names the task and says replication depends on this snapshot', async () => {
      await serve()
      await task('to-backup', { source: { pool: 'testpool', dataset: 'media' }, target: { pool: 'backup', dataset: 'media' } })
      holds = ok(replHold(SOURCE_TAG))
      const res = await inject('DELETE', DESTROY_URL)
      assert.equal(res.statusCode, 409, res.body)
      assert.equal(res.json().error.message, `Destroying '${SNAP2}' is refused: ZFS does not destroy a held snapshot — nothing was done. `
      + `${SNAP2} held by replication task 'to-backup': ${SOURCE_TAG}. `
      + 'Replication depends on this snapshot: it is the common snapshot the next incremental send starts from; '
      + 'released and destroyed, the chain needs a full send.')
      assert.deepEqual(destroys(), [])
    })

    it('an unheld destroy is unchanged: 202, the same argv', async () => {
      await serve()
      const res = await inject('DELETE', DESTROY_URL)
      assert.equal(res.statusCode, 202, res.body)
      const job = await finished((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(destroys().map(c => c.args), [destroyZfsSnapshotArgs({ dataset: DS, name: 'snap2' })])
    })

    it('a holds read that fails passes to ZFS (its own refusal is the fallback; nothing a hold protects is lost)', async () => {
      await serve()
      holds = failed('pool I/O is currently suspended')
      const res = await inject('DELETE', DESTROY_URL)
      assert.equal(res.statusCode, 202, res.body)
      const job = await finished((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(destroys().map(c => c.args), [destroyZfsSnapshotArgs({ dataset: DS, name: 'snap2' })])
    })
  })
})
