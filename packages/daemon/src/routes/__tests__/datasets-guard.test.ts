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
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { zfsListArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { replicationHoldTag } from '../../services/replication-holds.js'
import { renderServiceUnit } from '../../services/replication-units.js'
import { DATASET_DESTROY_PRESENTATION_ONLY, SNAPSHOT_ROLLBACK_PRESENTATION_ONLY } from '../datasets.js'

/**
 * Story cr.37 — the ZFS dataset and snapshot verbs on the guard
 * (docs/WAVE3-DESIGN.md §2.1 dataset rows, §5, §8.2). The H8 property: a gate
 * that would refuse at the route but only becomes true AFTER the request was
 * accepted — while the job waits in the queue — refuses the job, and the mock
 * executor shows no mutating argv. One race per "Missing" cell of §2.1.
 *
 * The job is held in the REAL queue (the cr.32 harness): four placeholder jobs
 * fill the four slots, the request is accepted behind them (`queued`), the
 * test changes the node's state, then releases the slots.
 *
 * FIXTURES (ruling (l): fakes print captured output). Each state flip serves
 * a capture, with the one rewrite it needs spelled out at the call site:
 *  - LIO: `iscsi/configfs-restore-empty.manifest` (a target, no LUNs) at the
 *    request; `iscsi/configfs-live.manifest` with its fileio LUN's image
 *    re-pointed from `/gtiscsi/images/lun2.raw` into testpool/media's
 *    mountpoint when the job runs.
 *  - PVE: no storage.cfg at the request; `pve/storage.cfg` with its zfspool
 *    storage re-pointed from `datapool` to `testpool/media` when the job runs.
 *  - the pool listing: `zfs/zfs-list.json` (the dev mock's own answer) at the
 *    request; the same capture with `testpool/vm-100-disk-0` re-parented to
 *    `testpool/media/vm-100-disk-0` (createtxg 88 kept) when the job runs —
 *    a child dataset appeared; or `zfs/zfs-list-with-snapshots.json` (the same
 *    pool carrying `testpool/data`) — a name was taken.
 *  - a volume: `zfs/zfs-list-volumes.json` (real capture, `gtiscsi/vol1` 2G)
 *    at the request; the same capture with vol1's volsize `2G` → `4G` when the
 *    job runs — someone grew it past the requested size.
 *  - bookmarks: no capture exists (no bookmark on the stunt node or on any
 *    captured pool); the one line served is TYPED in the `zfs list -Hp -o
 *    name,createtxg` shape the dev mock already serves for snapshots
 *    (server.ts), and says so here.
 *  - holds (nf.3 D11): `zfs/zfs-holds-replication-base.txt`, the wave-3b
 *    capture of the replication base's hold (header form; zfs/NOTES.md), served
 *    in the `-H` shape (header dropped, columns tab-joined — zfs-hold(8)) with
 *    the snapshot re-pointed from `w3r5s/src@snapshot-…` to the swept
 *    `testpool/media@snap2`; the tag is the capture's.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const ZFS = '/usr/sbin/zfs'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

/** Replace exactly `count` occurrences of `from` in a capture. */
function rewrite(text: string, from: string, to: string, count = 1): string {
  assert.equal(text.split(from).length, count + 1, `capture has not exactly ${count} '${from}'`)
  return text.split(from).join(to)
}

const LIO_NO_LUNS = fixture('iscsi/configfs-restore-empty.manifest')
const LIO_IMAGE_IN_MEDIA = rewrite(fixture('iscsi/configfs-live.manifest'), '= /gtiscsi/images/lun2.raw', '= /testpool/media/lun2.raw')

const STORAGE_ON_DATA = rewrite(rewrite(fixture('pve/storage.cfg'), '\tpool datapool\n', '\tpool testpool/data\n'), '\tmountpoint /datapool\n', '\tmountpoint /testpool/data\n')
const STORAGE_ON_MEDIA = rewrite(rewrite(fixture('pve/storage.cfg'), '\tpool datapool\n', '\tpool testpool/media\n'), '\tmountpoint /datapool\n', '\tmountpoint /testpool/media\n')

const ZFS_LIST = fixture('zfs/zfs-list.json')
/** The same pool once `testpool/data` exists (a capture of that pool with the dataset). */
const ZFS_LIST_WITH_DATA = fixture('zfs/zfs-list-with-snapshots.json')
/** The real gtiscsi capture: `gtiscsi/vol1` is a 2G volume, volblocksize 16K. */
const ZFS_LIST_VOL1_2G = fixture('zfs/zfs-list-volumes.json')
/** The same capture with vol1 grown to 4G by someone else. */
const ZFS_LIST_VOL1_4G = rewrite(ZFS_LIST_VOL1_2G, '"value": "2G"', '"value": "4G"')
const ZFS_LIST_CHILD_UNDER_MEDIA = rewrite(ZFS_LIST, '"testpool/vm-100-disk-0"', '"testpool/media/vm-100-disk-0"', 2)

/** TYPED (see the header): one bookmark of testpool/media made after snap2 (createtxg 240). */
const BOOKMARK_AFTER_SNAP2 = 'testpool/media#after-snap2\t300\n'

/** The wave-3b capture of a replication base's hold (zfs/NOTES.md): one row under a header. */
const HOLDS_CAPTURE = fixture('zfs/zfs-holds-replication-base.txt')
/** The capture's tag: the per-chain tag of a local replication into `w3r5d/rep` (task `w3r5rep`). */
const CAPTURED_TAG = 'anas-repl-684abe8ac24d'
/** `zfs holds -H -- testpool/media@snap2` once the capture's hold sits on snap2. */
const HOLDS_ON_SNAP2 = (() => {
  const [header, ...rows] = HOLDS_CAPTURE.trimEnd().split('\n')
  assert.match(header, /^NAME +TAG +TIMESTAMP$/)
  assert.equal(rows.length, 1)
  const cols = rows[0].split(/ {2,}/)
  assert.equal(cols[1], CAPTURED_TAG)
  return `${rewrite(cols[0], 'w3r5s/src@snapshot-2026-10-15T16-58-26-312Z', 'testpool/media@snap2')}\t${cols[1]}\t${cols[2]}\n`
})()

/** The dev mock's `zpool get guid` answer for testpool (server.ts). */
const TESTPOOL_GUID = '5823146802312415237'

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

const MUTATING_ZFS = new Set(['destroy', 'rollback', 'create', 'snapshot', 'clone', 'rename', 'set'])
/** A call that would mean a dataset or snapshot verb acted. */
function isMutation(c: { command: string, args: string[] }): boolean {
  return c.command === ZFS && MUTATING_ZFS.has(c.args[0])
}

interface Verb {
  name: string
  method: 'POST' | 'DELETE' | 'PUT'
  url: string
  payload?: unknown
}
const DESTROY_RECURSIVE: Verb = { name: 'recursive destroy', method: 'DELETE', url: '/v1/pools/testpool/datasets/media?recursive=true' }
const ROLLBACK_FORCE: Verb = { name: 'forced rollback', method: 'POST', url: '/v1/pools/testpool/datasets/media/snapshots/snap1/rollback?force=true' }
const ROLLBACK: Verb = { name: 'rollback', method: 'POST', url: '/v1/pools/testpool/datasets/media/snapshots/snap2/rollback' }

describe('cr.37 — dataset and snapshot verbs re-gate in the job (ruling (j))', () => {
  let dir: string
  let configfs: string
  let storageCfg: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** What the node answers right now; a test flips these while the job waits. */
  let zfsList = ZFS_LIST
  let bookmarks = ''
  let gtiscsiList = ZFS_LIST_VOL1_2G
  /** What `zfs holds -H -- <snap…>` answers (nf.3 D11): no hold, a hold, an error exit, or an exec that throws. */
  let holds: ExecResult | 'throws' = ok('')
  /** A `zfs <verb>` that does not return until the test releases it. */
  const paused = new Map<string, Promise<void>>()

  const savedEnv = {
    configfs: process.env.ANAS_ISCSI_CONFIGFS,
    block: process.env.ANAS_ISCSI_SYS_BLOCK,
    saveconfig: process.env.ANAS_ISCSI_SAVECONFIG,
    storage: process.env.ANAS_STORAGE_CFG,
    systemd: process.env.ANAS_SYSTEMD_DIR,
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr37-race-'))
    configfs = join(dir, 'target')
    storageCfg = join(dir, 'storage.cfg')
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const [key, value] of [
      ['ANAS_ISCSI_CONFIGFS', savedEnv.configfs],
      ['ANAS_ISCSI_SYS_BLOCK', savedEnv.block],
      ['ANAS_ISCSI_SAVECONFIG', savedEnv.saveconfig],
      ['ANAS_STORAGE_CFG', savedEnv.storage],
      ['ANAS_SYSTEMD_DIR', savedEnv.systemd],
    ] as const) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
  })

  /** The dev mock, its LIO tree the LUN-less capture, no storage.cfg, reads routed through the flippable state. */
  async function serve(): Promise<void> {
    zfsList = ZFS_LIST
    bookmarks = ''
    gtiscsiList = ZFS_LIST_VOL1_2G
    holds = ok('')
    paused.clear()
    await rm(configfs, { recursive: true, force: true })
    await rm(storageCfg, { force: true })
    await materializeConfigfsManifest(LIO_NO_LUNS, configfs)
    process.env.ANAS_ISCSI_CONFIGFS = configfs
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')
    process.env.ANAS_STORAGE_CFG = storageCfg
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    const listArgs = zfsListArgs('testpool').join('\0')
    const gtiscsiArgs = zfsListArgs('gtiscsi').join('\0')
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      if (command === ZFS && args.join('\0') === listArgs)
        return ok(zfsList)
      if (command === ZFS && args.join('\0') === gtiscsiArgs)
        return ok(gtiscsiList)
      if (command === ZFS && args[0] === 'list' && args[1] === '-t' && args[2] === 'bookmark')
        return ok(bookmarks)
      if (command === ZFS && args[0] === 'holds') {
        if (holds === 'throws')
          throw Object.assign(new Error('spawn /usr/sbin/zfs EAGAIN'), { code: 'EAGAIN' })
        return holds
      }
      const hold = command === ZFS ? paused.get(args[0]) : undefined
      if (hold)
        await hold
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  function inject(verb: Verb, confirm?: string) {
    const headers: Record<string, string> = { ...IDENTITY_HEADERS }
    if (verb.payload !== undefined)
      headers['content-type'] = 'application/json'
    if (confirm)
      headers['x-anas-confirm'] = confirm
    return server!.inject({
      method: verb.method,
      url: verb.url,
      headers,
      ...(verb.payload !== undefined ? { payload: JSON.stringify(verb.payload) } : {}),
    })
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

  /**
   * Challenge, then resend with the code while all four slots are held: the
   * confirmed job is accepted and sits `queued`. Returns its id and the
   * release for the slots.
   */
  async function confirmBehindFullQueue(verb: Verb): Promise<{ id: string, release: () => void }> {
    const first = await inject(verb)
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    const release = fillSlots()
    const res = await inject(verb, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    assert.equal(queue().get(id)?.status, 'queued', 'the confirmed job waits behind the held slots')
    return { id, release }
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

  /** Pause `zfs <verb>` inside its job until the returned release is called. */
  function pause(verb: string): () => void {
    let release!: () => void
    paused.set(verb, new Promise<void>((resolve) => {
      release = resolve
    }))
    return release
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(cond(), 'condition not reached')
  }

  /** Run one confirmed race: confirm behind a full queue, flip, release, return the finished job. */
  async function confirmedRace(verb: Verb, flip: () => Promise<void> | void): Promise<Job> {
    await serve()
    const { id, release } = await confirmBehindFullQueue(verb)
    await flip()
    release()
    return finished(id)
  }

  const lunAppears = async (): Promise<void> => {
    await rm(configfs, { recursive: true, force: true })
    await materializeConfigfsManifest(LIO_IMAGE_IN_MEDIA, configfs)
  }
  const pveClaimsMedia = async (): Promise<void> => {
    await writeFile(storageCfg, STORAGE_ON_MEDIA)
  }

  // --- the confirmed verbs: dataset destroy and rollback ---------------------

  it('control: with nothing changed the held destroy and rollback run and act — the harness does not refuse on its own', async () => {
    for (const verb of [DESTROY_RECURSIVE, ROLLBACK_FORCE]) {
      const job = await confirmedRace(verb, () => {})
      assert.equal(job.status, 'completed', `${verb.name}: ${JSON.stringify(job.error)}`)
      assert.equal(calls.filter(isMutation).length, 1, `${verb.name} ran`)
      await server!.close()
      server = undefined
    }
  })

  it('destroy (recursive): a child created between the challenge and the resend is 409 CONFIRM_SCOPE_CHANGED naming it — nothing runs', async () => {
    await serve()
    const first = await inject(DESTROY_RECURSIVE)
    assert.equal(first.statusCode, 409)
    zfsList = ZFS_LIST_CHILD_UNDER_MEDIA
    const res = await inject(DESTROY_RECURSIVE, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(res.json().error.changed, ['children'])
    assert.equal(res.json().error.message, 'the child datasets changed since you confirmed (was: none; now: testpool/media/vm-100-disk-0 (createtxg 88)) — confirm again')
    assert.ok((res.json().error.warnings as string[]).includes('Child datasets destroyed with it: testpool/media/vm-100-disk-0.'))
    assert.ok(res.headers['x-anas-confirm-code'], 'a fresh code for what is there now')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('destroy (recursive): a child created while the job waits fails it STATE_CHANGED naming the child — no zfs destroy', async () => {
    const job = await confirmedRace(DESTROY_RECURSIVE, () => {
      zfsList = ZFS_LIST_CHILD_UNDER_MEDIA
    })
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.equal(job.error?.message, 'Dataset \'testpool/media\' changed since you confirmed (was: none; now: testpool/media/vm-100-disk-0 (createtxg 88)) — nothing was done; confirm again')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('destroy: a LUN image that appears in the dataset while the job waits refuses it — the gate runs at both doors', async () => {
    const job = await confirmedRace(DESTROY_RECURSIVE, lunAppears)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /^Destroying dataset 'testpool\/media' \(recursive\) is refused: it is held by iSCSI LUN \d+ 'gtiscsi_lun2'/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('destroy: a PVE storage registered on the dataset while the job waits refuses it with the predicate\'s reason', async () => {
    const job = await confirmedRace(DESTROY_RECURSIVE, pveClaimsMedia)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'PVE_MANAGED')
    assert.match(job.error!.message, /datapool/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('rollback: a PVE storage registered on the dataset while the job waits refuses it (ownership re-run) — no zfs rollback', async () => {
    const job = await confirmedRace(ROLLBACK, pveClaimsMedia)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'PVE_MANAGED')
    assert.match(job.error!.message, /datapool/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('rollback: a LUN image that appears in the dataset while the job waits refuses it (LUN-held re-run) — no zfs rollback', async () => {
    const job = await confirmedRace(ROLLBACK, lunAppears)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /^Rolling back dataset 'testpool\/media' to snapshot 'snap2' is refused: it is held by iSCSI LUN \d+ 'gtiscsi_lun2'/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('rollback (force): a bookmark made between the challenge and the resend is CONFIRM_SCOPE_CHANGED; one made while the job waits fails it STATE_CHANGED', async () => {
    await serve()
    const first = await inject(ROLLBACK_FORCE)
    assert.ok((first.json().error.warnings as string[]).includes('Destroyed by force: testpool/media@snap2.'))
    bookmarks = BOOKMARK_AFTER_SNAP2
    const res = await inject(ROLLBACK_FORCE, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(res.json().error.changed, ['destroys'])
    assert.ok((res.json().error.warnings as string[]).includes('Destroyed by force: testpool/media#after-snap2, testpool/media@snap2.'))
    await server!.close()
    server = undefined

    const job = await confirmedRace(ROLLBACK_FORCE, () => {
      bookmarks = BOOKMARK_AFTER_SNAP2
    })
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.match(job.error!.message, /was: testpool\/media@snap2; now: testpool\/media#after-snap2, testpool\/media@snap2\)/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // --- nf.3 D11: a forced rollback over a held snapshot ----------------------

  /** A replication task `w3r5rep` into `w3r5d/rep` — the record's task, whose chain tag is the captured one. */
  async function replicationTaskW3r5rep(): Promise<void> {
    const units = join(dir, 'units')
    await mkdir(units, { recursive: true })
    await writeFile(join(units, 'anas-repl-w3r5rep.service'), renderServiceUnit({
      name: 'w3r5rep',
      source: { pool: 'testpool', dataset: 'media' },
      target: { pool: 'w3r5d', dataset: 'rep' },
      schedule: 'daily',
      snapshotFirst: true,
      enabled: true,
      notify: 'on-failure',
    }))
    process.env.ANAS_SYSTEMD_DIR = units
  }

  const HELD_REFUSAL = 'A forced rollback of \'testpool/media\' to \'snap1\' is refused: it would destroy held snapshots, and ZFS stops at a held '
    + `snapshot only after destroying the newer unheld ones — nothing was done. testpool/media@snap2 held by replication task 'w3r5rep': ${CAPTURED_TAG}.`
  const holdsCalls = (): { command: string, args: string[] }[] => calls.filter(c => c.command === ZFS && c.args[0] === 'holds')

  it('nf.3 D11: a forced rollback whose sweep includes a replication-held snapshot is refused 409 naming the snapshot, the task and the tag — no challenge, nothing runs', async () => {
    assert.equal(replicationHoldTag(undefined, 'w3r5d/rep'), CAPTURED_TAG, 'the captured tag is the one the task derives')
    await replicationTaskW3r5rep()
    await serve()
    holds = ok(HOLDS_ON_SNAP2)
    const res = await inject(ROLLBACK_FORCE)
    assert.equal(res.statusCode, 409, res.body)
    assert.deepEqual(res.json().error, { code: 'CONFLICT', message: HELD_REFUSAL, reason: 'snapshot-held' })
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'refused before a confirm is minted')
    assert.deepEqual(holdsCalls().map(c => c.args), [['holds', '-H', '--', 'testpool/media@snap2']], 'the holds of the swept snapshots, read once')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('nf.3 D11: a hold that appears while the confirmed forced rollback waits refuses the job (the gate re-runs) — no zfs rollback', async () => {
    await replicationTaskW3r5rep()
    const job = await confirmedRace(ROLLBACK_FORCE, () => {
      holds = ok(HOLDS_ON_SNAP2)
    })
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.equal(job.error?.message, HELD_REFUSAL)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('nf.3 D11: holds that cannot be read refuse the forced rollback — at the route, and in the job when they become unreadable while it waits', async () => {
    const unreadable = 'Could not read the holds on the snapshots a forced rollback of \'testpool/media\' to \'snap1\' destroys — refusing: '
      + 'a held one would stop the rollback only after the newer unheld ones were destroyed'
    for (const answer of [{ stdout: '', stderr: 'cannot open \'testpool/media@snap2\': dataset does not exist', exitCode: 1 }, 'throws'] as const) {
      await serve()
      holds = answer
      const res = await inject(ROLLBACK_FORCE)
      assert.equal(res.statusCode, 409, res.body)
      assert.deepEqual(res.json().error, { code: 'CONFLICT', message: unreadable, reason: 'snapshot-holds-unreadable' })
      assert.deepEqual(calls.filter(isMutation), [])
      await server!.close()
      server = undefined
    }
    const job = await confirmedRace(ROLLBACK_FORCE, () => {
      holds = { stdout: '', stderr: 'internal error', exitCode: 1 }
    })
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.message, unreadable)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('nf.3 D11: a rollback that destroys nothing reads no holds — without force, and with force to the newest snapshot', async () => {
    await serve()
    holds = ok(HOLDS_ON_SNAP2)
    const plain = await inject(ROLLBACK)
    assert.equal(plain.statusCode, 409, plain.body)
    assert.equal(plain.json().error.code, 'CONFIRMATION_REQUIRED')
    const newest = await inject({ ...ROLLBACK, url: `${ROLLBACK.url}?force=true` })
    assert.equal(newest.statusCode, 409, newest.body)
    assert.equal(newest.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.deepEqual(holdsCalls(), [])
  })

  it('a bookmark OLDER than the target is not destroyed by force and is not bound', async () => {
    await serve()
    bookmarks = 'testpool/media#before-snap1\t100\n'
    const res = await inject(ROLLBACK_FORCE)
    assert.ok((res.json().error.warnings as string[]).includes('Destroyed by force: testpool/media@snap2.'), res.body)
  })

  it('cr.33: a recursive destroy holds the dataset exclusive, the pool shared, while it runs', async () => {
    await serve()
    const release = pause('destroy')
    const first = await inject(DESTROY_RECURSIVE)
    const res = await inject(DESTROY_RECURSIVE, first.headers['x-anas-confirm-code'] as string)
    const id = (res.json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === ZFS && c.args[0] === 'destroy'))
    assert.deepEqual(queue().heldLocks(), [
      { key: `zfs:${TESTPOOL_GUID}/media`, mode: 'exclusive', holders: [id] },
      { key: `zfs:${TESTPOOL_GUID}`, mode: 'shared', holders: [id] },
      { key: `zpool:${TESTPOOL_GUID}`, mode: 'shared', holders: [id] },
      { key: 'zname:testpool', mode: 'shared', holders: [id] },
    ])
    release()
    assert.equal((await finished(id)).status, 'completed')
    assert.deepEqual(queue().heldLocks(), [])
  })

  // --- the unconfirmed verbs: create, snapshot, rename, snapshot destroy, clone, set --

  /** Accept an unconfirmed request while all four slots are held, flip, release; return the finished job. */
  async function acceptedRace(verb: Verb, flip: () => Promise<void> | void): Promise<Job> {
    await serve()
    const release = fillSlots()
    const res = await inject(verb)
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    assert.equal(queue().get(id)?.status, 'queued', 'the job waits behind the held slots')
    await flip()
    release()
    return finished(id)
  }

  const CREATE_DATA: Verb = { name: 'create', method: 'POST', url: '/v1/pools/testpool/datasets', payload: { path: 'data' } }
  const SNAPSHOT_MEDIA: Verb = { name: 'snapshot', method: 'POST', url: '/v1/pools/testpool/datasets/media/snapshots', payload: { name: 'fresh' } }
  const SNAPSHOT_POOL_RECURSIVE: Verb = { name: 'recursive snapshot', method: 'POST', url: '/v1/pools/testpool/datasets/snapshots', payload: { name: 'fresh', recursive: true } }
  const RENAME_SNAP1: Verb = { name: 'rename', method: 'PUT', url: '/v1/pools/testpool/datasets/media/snapshots/snap1', payload: { newName: 'renamed' } }
  const DESTROY_SNAP1: Verb = { name: 'snapshot destroy', method: 'DELETE', url: '/v1/pools/testpool/datasets/media/snapshots/snap1' }
  const CLONE_TO_DATA: Verb = { name: 'clone', method: 'POST', url: '/v1/pools/testpool/datasets/media/snapshots/snap1/clone', payload: { target: 'testpool/data' } }
  const SET_MEDIA: Verb = { name: 'set', method: 'PUT', url: '/v1/pools/testpool/datasets/media', payload: { properties: { compression: 'lz4' } } }
  const GROW_VOL1_3G: Verb = { name: 'grow', method: 'PUT', url: '/v1/pools/gtiscsi/datasets/vol1', payload: { properties: { volsize: 3 * 1024 ** 3 } } }

  it('control: with nothing changed every held unconfirmed verb runs and acts', async () => {
    for (const verb of [CREATE_DATA, SNAPSHOT_MEDIA, SNAPSHOT_POOL_RECURSIVE, RENAME_SNAP1, DESTROY_SNAP1, CLONE_TO_DATA, SET_MEDIA, GROW_VOL1_3G]) {
      const job = await acceptedRace(verb, () => {})
      assert.equal(job.status, 'completed', `${verb.name}: ${JSON.stringify(job.error)}`)
      assert.equal(calls.filter(isMutation).length, 1, `${verb.name} ran once`)
      await server!.close()
      server = undefined
    }
  })

  it('create: the name taken while the job waits refuses it 409 CONFLICT (collision re-run) — no zfs create', async () => {
    const job = await acceptedRace(CREATE_DATA, () => {
      zfsList = ZFS_LIST_WITH_DATA
    })
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.equal(job.error?.message, 'Dataset \'testpool/data\' already exists')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('create: a PVE storage registered on the new name while the job waits refuses it (ownership re-run) — no zfs create', async () => {
    const job = await acceptedRace(CREATE_DATA, () => writeFile(storageCfg, STORAGE_ON_DATA))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'PVE_MANAGED')
    assert.match(job.error!.message, /datapool/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('snapshot: a PVE storage registered on the dataset while the job waits refuses it (ownership re-run) — no zfs snapshot', async () => {
    const job = await acceptedRace(SNAPSHOT_MEDIA, pveClaimsMedia)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'PVE_MANAGED')
    assert.match(job.error!.message, /datapool/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('recursive snapshot: a PVE storage registered on a DESCENDANT while the job waits refuses it (descendants re-run)', async () => {
    const job = await acceptedRace(SNAPSHOT_POOL_RECURSIVE, pveClaimsMedia)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'PVE_MANAGED')
    assert.match(job.error!.message, /^Recursive snapshot of 'testpool'.*testpool\/media/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('snapshot rename and destroy: a PVE storage registered on the dataset while the job waits refuses both (ownership re-run)', async () => {
    for (const verb of [RENAME_SNAP1, DESTROY_SNAP1]) {
      const job = await acceptedRace(verb, pveClaimsMedia)
      assert.equal(job.status, 'failed', verb.name)
      assert.equal(job.error?.code, 'PVE_MANAGED', verb.name)
      assert.match(job.error!.message, /datapool/, verb.name)
      assert.deepEqual(calls.filter(isMutation), [], verb.name)
      await server!.close()
      server = undefined
    }
  })

  it('clone: the source dataset claimed by PVE, or the target name taken, while the job waits refuses it — no zfs clone', async () => {
    const owned = await acceptedRace(CLONE_TO_DATA, pveClaimsMedia)
    assert.equal(owned.status, 'failed')
    assert.equal(owned.error?.code, 'PVE_MANAGED')
    assert.match(owned.error!.message, /datapool/)
    assert.deepEqual(calls.filter(isMutation), [])
    await server!.close()
    server = undefined

    const taken = await acceptedRace(CLONE_TO_DATA, () => {
      zfsList = ZFS_LIST_WITH_DATA
    })
    assert.equal(taken.status, 'failed')
    assert.equal(taken.error?.code, 'CONFLICT')
    assert.equal(taken.error?.message, 'Dataset \'testpool/data\' already exists')
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('set: a PVE storage registered on the dataset while the job waits refuses it (ownership re-run) — no zfs set', async () => {
    const job = await acceptedRace(SET_MEDIA, pveClaimsMedia)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'PVE_MANAGED')
    assert.match(job.error!.message, /datapool/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('set: a volume grown past the requested size while the job waits makes the request a SHRINK — refused, no zfs set', async () => {
    const job = await acceptedRace(GROW_VOL1_3G, () => {
      gtiscsiList = ZFS_LIST_VOL1_4G
    })
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.match(job.error!.message, /^Volume 'gtiscsi\/vol1' is 4294967296 bytes; a volsize of 3221225472 bytes would SHRINK it/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('cr.33: a snapshot holds the dataset shared; a clone holds its source shared and its target exclusive', async () => {
    await serve()
    const releaseSnap = pause('snapshot')
    const snap = await inject(SNAPSHOT_MEDIA)
    const snapId = (snap.json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === ZFS && c.args[0] === 'snapshot'))
    assert.deepEqual(queue().heldLocks().map(l => [l.key, l.mode]), [
      [`zfs:${TESTPOOL_GUID}/media`, 'shared'],
      [`zfs:${TESTPOOL_GUID}`, 'shared'],
      [`zpool:${TESTPOOL_GUID}`, 'shared'],
      ['zname:testpool', 'shared'],
    ])
    releaseSnap()
    assert.equal((await finished(snapId)).status, 'completed')

    const releaseClone = pause('clone')
    const clone = await inject(CLONE_TO_DATA)
    const cloneId = (clone.json() as JobAccepted).job.id
    await until(() => calls.some(c => c.command === ZFS && c.args[0] === 'clone'))
    assert.deepEqual(queue().heldLocks().map(l => [l.key, l.mode]), [
      [`zfs:${TESTPOOL_GUID}/media`, 'shared'],
      [`zfs:${TESTPOOL_GUID}`, 'shared'],
      [`zpool:${TESTPOOL_GUID}`, 'shared'],
      ['zname:testpool', 'shared'],
      [`zfs:${TESTPOOL_GUID}/data`, 'exclusive'],
    ])
    releaseClone()
    assert.equal((await finished(cloneId)).status, 'completed')
    assert.deepEqual(queue().heldLocks(), [])
  })

  it('neither confirm leaves a request field out of the signature', () => {
    assert.deepEqual(DATASET_DESTROY_PRESENTATION_ONLY, {})
    assert.deepEqual(SNAPSHOT_ROLLBACK_PRESENTATION_ONLY, {})
  })
})
