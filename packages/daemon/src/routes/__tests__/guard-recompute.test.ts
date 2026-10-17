import type { Job, JobAccepted } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { SnapshotSchedule } from '@anas/shared'
import { currentLane } from '../../executor/deadline.js'
import { createServer } from '../../server.js'
import { writeScheduleUnits } from '../../services/snapshot-schedule-units.js'

/**
 * Story cr.64b1 — the guard core's second pass, over the REAL routes and the
 * dev mock's executor (the cr.64a review's construct-it requests) — and
 * cr.64b1r, its third pass (the cr.64b1 review's three defects).
 *
 * (A) DOMINANCE. A route whose pool-guid read fails takes cr.33b's fallback,
 * the pool's name key EXCLUSIVE; the job re-reads the guid and its recompute
 * needs the `zfs:<guid>/…` keys. Every guid-keyed claim set the builders
 * make carries the name key shared (cr.33b), so the held exclusive name key
 * excludes every job that could touch those keys — the recompute must say the
 * run holds them (the lock table's own rule, `covers` in jobs/locks.ts), not
 * refuse key by key. cr.64b1r (1): unless another job holds one of those keys
 * WITHOUT the name key — the import by guid holds a bare `zpool:<guid>` — in
 * which case the cover is void and the run refuses.
 *
 * cr.64b1r (2): a claim builder that throws the AHR topology's typed
 * unreadable error in the JOB (a schedule fire on an AHR pool, `mdadm
 * --detail --export` exiting 1) is a guard refusal — 503 UNAVAILABLE naming
 * the read, the fire notifies, nothing runs; at the route it is the server's
 * 503 with the error's own sentence.
 *
 * cr.64b1r (3): a guid read that fails in the JOB only is "could not be
 * read" (503 UNAVAILABLE), never "changed while this run waited"; a pool
 * whose guid really changed under the name still is STATE_CHANGED.
 *
 * FIXTURES (ruling (l)): the dev mock's ZFS world (testpool, testpool/media,
 * the `zpool get -H -o value guid -- testpool` line server.ts serves) and its
 * AHR world (the ahr0 cap: mdstat, `mdadm --detail --export` per array). The
 * injected failures are that guid line answering exit 1 with zpool's own
 * missing-pool sentence, and `mdadm --detail --export` answering exit 1 with
 * mdadm's open error, each in the doors the test names ('' = the route, no
 * job lane); one control answers another guid (a pool re-created under the
 * name). Schedules are written through the store's own writer.
 */

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const MDADM = '/usr/sbin/mdadm'
const BTRFS = '/usr/bin/btrfs'
const PERL = '/usr/bin/perl'
const TESTPOOL_GUID = '5823146802312415237'
const NAMESAKE_GUID = '2000000000000000001'
const GUID_ARGS = ['get', '-H', '-o', 'value', 'guid', '--', 'testpool']

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

const QUIET: CommandExecutor = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } as unknown as CommandExecutor

/** What the injected `zpool get guid testpool` answers in a door: the mock's line, a failure, or another guid. */
type GuidAnswer = 'mock' | 'fail' | string

interface Faults {
  /** The pool-guid answer per door (the job's operation; '' = the route). */
  guid?: (op: string) => GuidAnswer
  /** `mdadm --detail --export` exits 1 in these doors. */
  mdadm?: (op: string) => boolean
  /** Park every command of this operation's job until `unpark()`. */
  park?: string
}

describe('cr.64b1 (A) / cr.64b1r — the job door\'s lock recompute: dominance, the other jobs, and why the sets differ', () => {
  let server: ReturnType<typeof createServer> | undefined
  let calls: { op: string, command: string, args: string[] }[] = []
  let dir: string
  let systemdDir: string
  let unpark: () => void = () => {}
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    if (!(k in saved))
      saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr64b1r-'))
    systemdDir = join(dir, 'systemd')
    await mkdir(systemdDir, { recursive: true })
    setEnv('ANAS_SYSTEMD_DIR', systemdDir)
    setEnv('ANAS_STORAGE_CFG', join(dir, 'absent-storage.cfg'))
  })

  afterEach(async () => {
    unpark()
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else
        process.env[k] = v
    }
  })

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  /** The dev mock with the faults injected per door; every command recorded with its job's operation. */
  async function serve(faults: Faults): Promise<void> {
    calls = []
    let parked = Promise.resolve()
    if (faults.park) {
      parked = new Promise<void>((resolve) => {
        unpark = resolve
      })
    }
    server = createServer({ mock: true, logger: false })
    const jobs = queue()
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    mock.exec = async (command, args, opts) => {
      const jobId = currentLane().jobId
      const op = jobId ? (jobs.get(jobId)?.operation ?? '') : ''
      if (faults.park && op === faults.park)
        await parked
      calls.push({ op, command, args })
      if (command === ZPOOL && args.length === GUID_ARGS.length && args.every((a, i) => a === GUID_ARGS[i])) {
        const answer = faults.guid?.(op) ?? 'mock'
        if (answer === 'fail')
          return { stdout: '', stderr: 'cannot open \'testpool\': no such pool\n', exitCode: 1 }
        if (answer !== 'mock')
          return { stdout: `${answer}\n`, stderr: '', exitCode: 0 }
      }
      if (command === MDADM && args[0] === '--detail' && args[1] === '--export' && faults.mdadm?.(op))
        return { stdout: '', stderr: `mdadm: cannot open ${args[2]}: injected\n`, exitCode: 1 }
      return orig(command, args, opts)
    }
    await server.ready()
  }

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = queue().get(id)
      if (job && ['completed', 'failed', 'cancelled'].includes(job.status))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  function snapshot(name: string) {
    return server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets/media/snapshots',
      headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ name }),
    })
  }

  function claimsOf(id: string): string[] {
    const record = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs.get(id)!
    return record.claims.map(c => `${c.key} ${c.mode}`)
  }

  const snapshotArgv = (op: string) => calls.filter(c => c.op === op && c.command === ZFS && c.args[0] === 'snapshot')

  async function schedule(id: string, target: SnapshotSchedule['target']): Promise<void> {
    await writeScheduleUnits(QUIET, systemdDir, SnapshotSchedule.parse({
      id,
      name: id,
      target,
      cadence: 'daily',
      retention: { daily: 7 },
      recursive: false,
      enabled: true,
    }))
  }

  function fire(id: string) {
    return server!.inject({ method: 'POST', url: `/v1/schedules/${id}/run`, headers: IDENTITY_HEADERS })
  }

  it('the review\'s request: a dataset snapshot whose pool-guid read fails at the ROUTE only — the route holds `zname:testpool` exclusive, the job needs the guid keys, and the job RUNS (`zfs snapshot` issued)', async () => {
    await serve({ guid: op => (op === '' ? 'fail' : 'mock') })
    const res = await snapshot('probe1')
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    // The route took the fallback: the name key, exclusive, and nothing else.
    assert.deepEqual(claimsOf(id), ['zname:testpool exclusive'])
    const job = await finished(id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    // The job's own re-read DID read the guid (the claims it needs are the guid keys).
    assert.ok(calls.some(c => c.op === 'zfs.snapshot' && c.command === ZPOOL && c.args.join(' ') === GUID_ARGS.join(' ')), 'the job re-read the guid')
    assert.deepEqual(snapshotArgv('zfs.snapshot').map(c => c.args.join(' ')), ['snapshot -- testpool/media@probe1'])
  })

  describe('cr.64b1r (1) — a `within` cover is void while another job holds the guid key without the name key', () => {
    it('the review\'s pair: an import by guid RUNNING (a bare `zpool:<guid>` exclusive, pools.ts) and a dataset snapshot whose guid read failed at the ROUTE only — the snapshot is granted beside it (no shared key), its recompute refuses 503 UNAVAILABLE naming the route\'s read and the import, and no `zfs snapshot` runs', async () => {
      await serve({ guid: op => (op === '' ? 'fail' : 'mock'), park: 'zpool.import' })
      const imp = await server!.inject({
        method: 'POST',
        url: '/v1/pools/import',
        headers: { ...IDENTITY_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ guid: TESTPOOL_GUID }),
      })
      assert.equal(imp.statusCode, 202, imp.body)
      const importId = (imp.json() as JobAccepted).job.id
      assert.deepEqual(claimsOf(importId), [`zpool:${TESTPOOL_GUID} exclusive`])
      const res = await snapshot('probe1')
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as JobAccepted).job.id
      assert.deepEqual(claimsOf(id), ['zname:testpool exclusive'])
      const job = await finished(id)
      assert.equal(queue().get(importId)?.status, 'running', 'the import still runs')
      assert.equal(job.status, 'failed', JSON.stringify(job.result))
      assert.equal(job.error?.code, 'UNAVAILABLE')
      assert.equal(job.error?.message, `Dataset 'testpool/media': the guid of pool 'testpool' could not be read when the run was requested, `
      + `so the run holds a lock on the pool name 'testpool' instead, which does not cover Pool 'testpool' while another job holds it without that name `
      + `— nothing was done; try again`)
      assert.deepEqual(snapshotArgv('zfs.snapshot'), [])
      unpark()
      await finished(importId)
    })
  })

  describe('cr.64b1r (3) — a read that failed in the JOB only is "could not be read", never "changed while this run waited"', () => {
    it('the dataset snapshot: the route read the guid (name key shared), the job\'s read fails → 503 UNAVAILABLE naming the read — no `zfs snapshot`', async () => {
      await serve({ guid: op => (op === 'zfs.snapshot' ? 'fail' : 'mock') })
      const res = await snapshot('probe1')
      assert.equal(res.statusCode, 202, res.body)
      const job = await finished((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed', JSON.stringify(job.result))
      assert.equal(job.error?.code, 'UNAVAILABLE')
      assert.equal(job.error?.message, `Dataset 'testpool/media': the guid of pool 'testpool' could not be read in the job, so the run cannot tell which locks it needs — nothing was done; try again`)
      assert.deepEqual(snapshotArgv('zfs.snapshot'), [])
    })

    it('control: the pool really moved — the job reads ANOTHER guid under the name (re-created) → STATE_CHANGED naming the two claim sets, as before — no `zfs snapshot`', async () => {
      await serve({ guid: op => (op === 'zfs.snapshot' ? NAMESAKE_GUID : 'mock') })
      const res = await snapshot('probe1')
      assert.equal(res.statusCode, 202, res.body)
      const job = await finished((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed', JSON.stringify(job.result))
      assert.equal(job.error?.code, 'STATE_CHANGED')
      assert.match(job.error!.message, new RegExp(`^Dataset 'testpool/media' changed while this run waited \\(lock claims were zfs:${TESTPOOL_GUID}/media, .*; now zfs:${NAMESAKE_GUID}/media, `))
      assert.deepEqual(snapshotArgv('zfs.snapshot'), [])
    })

    it('the schedule run: a fire on testpool/media whose guid read fails in the JOB only → 503 UNAVAILABLE "could not be read", the fire NOTIFIES that sentence (not "changed while this run waited") — no `zfs snapshot`', async () => {
      await schedule('nightly-media', { kind: 'zfs', dataset: 'testpool/media' })
      await serve({ guid: op => (op === 'schedule.run' ? 'fail' : 'mock') })
      const res = await fire('nightly-media')
      assert.equal(res.statusCode, 202, res.body)
      const job = await finished((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed', JSON.stringify(job.result))
      assert.equal(job.error?.code, 'UNAVAILABLE')
      const sentence = `Snapshot schedule 'nightly-media': the guid of pool 'testpool' could not be read in the job, so the run cannot tell which locks it needs — nothing was done; try again`
      assert.equal(job.error?.message, sentence)
      const perl = calls.filter(c => c.op === 'schedule.run' && c.command === PERL)
      assert.equal(perl.length, 1, 'one notification for the refused fire')
      assert.ok(perl[0].args.some(a => a.includes('the guid of pool \'testpool\' could not be read in the job')), JSON.stringify(perl[0].args.slice(1)))
      assert.ok(!perl[0].args.some(a => a.includes('changed while this run waited')))
      assert.deepEqual(snapshotArgv('schedule.run'), [])
    })
  })

  describe('cr.64b1r (2) — a claim builder\'s typed unreadable error in the JOB is a guard refusal', () => {
    it('the review\'s `nightly-ahr` fire with `mdadm --detail --export` failing in the JOB only: refused 503 UNAVAILABLE naming the read, the fire NOTIFIES once with that sentence, and no btrfs snapshot runs', async () => {
      await schedule('nightly-ahr', { kind: 'ahr', pool: 'ahr0' })
      await serve({ mdadm: op => op === 'schedule.run' })
      const res = await fire('nightly-ahr')
      assert.equal(res.statusCode, 202, res.body)
      const job = await finished((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed', JSON.stringify(job.result))
      assert.equal(job.error?.code, 'UNAVAILABLE')
      assert.match(job.error!.message, /^Snapshot schedule 'nightly-ahr': the AHR topology could not be read \(mdadm --detail --export \/dev\/md\S+ exited 1: mdadm: cannot open \/dev\/md\S+: injected\) — nothing was done; try again$/)
      // The route's read succeeded; the failure was the job's own.
      assert.ok(calls.some(c => c.op === '' && c.command === MDADM && c.args[0] === '--detail'), 'the route read the topology')
      const perl = calls.filter(c => c.op === 'schedule.run' && c.command === PERL)
      assert.equal(perl.length, 1, 'one notification for the refused fire')
      assert.ok(perl[0].args.some(a => a.includes('the AHR topology could not be read (mdadm --detail --export')), JSON.stringify(perl[0].args.slice(1)))
      assert.deepEqual(calls.filter(c => c.op === 'schedule.run' && c.command === BTRFS && c.args[0] === 'subvolume' && c.args[1] === 'snapshot'), [], 'no btrfs snapshot')
    })

    it('at the ROUTE the same failure answers the door\'s own 503: UNAVAILABLE with the topology error\'s sentence (the server\'s handler, cr.64c) — no job', async () => {
      await schedule('nightly-ahr', { kind: 'ahr', pool: 'ahr0' })
      await serve({ mdadm: op => op === '' })
      const res = await fire('nightly-ahr')
      assert.equal(res.statusCode, 503, res.body)
      const body = res.json() as { error: { code: string, message: string } }
      assert.equal(body.error.code, 'UNAVAILABLE')
      assert.match(body.error.message, /^the AHR topology could not be read \(mdadm --detail --export \/dev\/md\S+ exited 1: mdadm: cannot open \/dev\/md\S+: injected\)$/)
      assert.deepEqual(queue().list().filter(j => j.operation === 'schedule.run'), [])
    })
  })
})
