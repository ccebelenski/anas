import type { Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zfsListArgs, zfsSweepSnapshotListArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'

/**
 * Story cr.47e — the recursive dataset destroy's HOLD gate (routes/datasets.ts
 * `destroyHoldGate`), the no-partial-op rule of cr.47 (e) after the wave-2 node
 * row 6 proved `zfs destroy -r` is PARTIAL over a held child snapshot. The
 * gate reads one sweep list (`zfs list -H -t snapshot -r`) and ONE `zfs holds
 * -H` across every snapshot the sweep would destroy, and refuses before
 * anything unheld is destroyed. The fixtures are the r6 captures
 * (zfs/zfs-sweep-cr47e.txt, zfs/zfs-holds-cr47e.txt), re-pointed from `w2z/p`
 * to `testpool/media` the way datasets-guard.test.ts re-points its holds
 * capture: the node's names are never typed here.
 *
 * Harness: the cr.32/cr.37 one — the diagnostic jobs run in the REAL queue, so
 * "a hold that appears while the job waits" fails the JOB with the gate's code,
 * and the mock executor shows no `zfs destroy` argv.
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

/** Strip the fixture's `#` header, re-point the node's `w2z/p` root to `testpool/media`. */
function repointed(data: string): string {
  return data.split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.startsWith('w2z/p') ? `testpool/media${l.slice('w2z/p'.length)}` : l)
    .join('\n')
}

/** The r6 sweep: every snapshot `zfs destroy -r testpool/media` would destroy. */
const SWEEP_CAPTURE = `${repointed(fixture('zfs/zfs-sweep-cr47e.txt'))}\n`
/** The r6 holds: the ONE held snapshot of that sweep, under the tag `keep`. */
const HOLDS_CAPTURE = `${repointed(fixture('zfs/zfs-holds-cr47e.txt'))}\n`
/** The ONE `zfs holds -H` argv the gate runs over the whole sweep (r6-derived). */
const SWEEP_HOLDS_ARGS = ['holds', '-H', '--', ...SWEEP_CAPTURE.trimEnd().split('\n')]

const DESTROY_RECURSIVE: Verb = { name: 'recursive destroy', method: 'DELETE', url: '/v1/pools/testpool/datasets/media?recursive=true' }

interface Verb {
  name: string
  method: 'POST' | 'DELETE' | 'PUT'
  url: string
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

describe('cr.47e — a recursive dataset destroy is refused over a held snapshot (HOLD gate, both doors)', () => {
  let dir: string
  let storageCfg: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** What `zfs holds -H -- <sweep…>` answers (cr.47e): no hold, a hold, an error exit, an exec that throws. */
  let holds: ExecResult | 'throws' = ok('')
  /** What the sweep list answers; null = the read failed. */
  let sweep: string | null = SWEEP_CAPTURE
  const savedEnv: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    if (!(k in savedEnv))
      savedEnv[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr47e-'))
    await mkdir(join(dir, 'units'), { recursive: true })
    storageCfg = join(dir, 'storage.cfg')
    setEnv('ANAS_SYSTEMD_DIR', join(dir, 'units'))
    setEnv('ANAS_STORAGE_CFG', storageCfg)
    setEnv('ANAS_PVE_PRIV_STORAGE_DIR', join(dir, 'priv-storage'))
    setEnv('ANAS_ISCSI_CONFIGFS', join(dir, 'absent-configfs'))
    setEnv('ANAS_ISCSI_SAVECONFIG', join(dir, 'absent-saveconfig.json'))
    setEnv('ANAS_ISCSI_SYS_BLOCK', join(dir, 'absent-block'))
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

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  /** The dev mock, no storage.cfg, reads routed through the flippable state. */
  async function serve(): Promise<void> {
    holds = ok('')
    sweep = SWEEP_CAPTURE
    await rm(storageCfg, { force: true })
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    const listArgs = zfsListArgs('testpool').join('\0')
    const sweepArgs = zfsSweepSnapshotListArgs('testpool/media').join('\0')
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      if (command === ZFS && args.join('\0') === listArgs)
        return ok(fixture('zfs/zfs-list.json'))
      if (command === ZFS && args.join('\0') === sweepArgs)
        return sweep === null ? { stdout: '', stderr: 'pool suspended', exitCode: 1 } : ok(sweep)
      if (command === ZFS && args[0] === 'holds') {
        if (holds === 'throws')
          throw Object.assign(new Error('spawn /usr/sbin/zfs EAGAIN'), { code: 'EAGAIN' })
        return holds
      }
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function inject(verb: Verb, confirm?: string) {
    const headers: Record<string, string> = { ...IDENTITY_HEADERS }
    if (confirm)
      headers['x-anas-confirm'] = confirm
    return server!.inject({
      method: verb.method,
      url: verb.url,
      headers,
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

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = queue().get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  const SWEEP_ARGS = zfsSweepSnapshotListArgs('testpool/media').join('\0')
  const destruction = (): { command: string, args: string[] }[] => calls.filter(c => c.command === ZFS && c.args[0] === 'destroy')
  const sweepCalls = (): { command: string, args: string[] }[] => calls.filter(c => c.command === ZFS && c.args.join('\0') === SWEEP_ARGS)
  const holdsCalls = (): { command: string, args: string[] }[] => calls.filter(c => c.command === ZFS && c.args[0] === 'holds')

  const DESCRIBE_HOLDS = `testpool/media/c@s held by 'keep'`
  const HELD_REFUSAL = `A recursive destroy of 'testpool/media' is refused: it would destroy held snapshots, `
    + `and ZFS stops at a held snapshot only after destroying the unheld ones — nothing was done. ${DESCRIBE_HOLDS}.`
  const HOLDS_UNREADABLE = `Could not read the holds on the snapshots a recursive destroy of 'testpool/media' would destroy — `
    + 'refusing: a held one would stop the destroy only after the unheld ones were gone'
  const SWEEP_UNREADABLE = `Could not read the snapshots a recursive destroy of 'testpool/media' would sweep — refusing: `
    + 'a held one would stop the destroy only after the unheld ones were gone'

  it('(a) a recursive destroy over a held child snapshot is refused 409 naming the snapshot and the holder — nothing runs', async () => {
    await serve()
    holds = ok(HOLDS_CAPTURE)
    const res = await inject(DESTROY_RECURSIVE)
    assert.equal(res.statusCode, 409, res.body)
    assert.deepEqual(res.json().error, { code: 'CONFLICT', message: HELD_REFUSAL, reason: 'snapshot-held' })
    assert.equal(res.headers['x-anas-confirm-code'], undefined, 'refused before a confirm is minted')
    // ONE sweep read, ONE holds call covering EVERY snapshot the sweep would destroy.
    assert.equal(sweepCalls().length, 1, 'the sweep list, read once at the route')
    assert.deepEqual(holdsCalls().map(c => c.args), [SWEEP_HOLDS_ARGS], 'the holds of the whole sweep, read once')
    assert.deepEqual(destruction(), [], 'no zfs destroy argv ran')
  })

  it('(b) a hold that appears while the confirmed destroy waits fails the job with the same code — no zfs destroy', async () => {
    await serve()
    const first = await inject(DESTROY_RECURSIVE)
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    const release = fillSlots()
    const res = await inject(DESTROY_RECURSIVE, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    assert.equal(queue().get(id)?.status, 'queued', 'the confirmed job waits behind the held slots')
    holds = ok(HOLDS_CAPTURE)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.equal(job.error?.message, HELD_REFUSAL)
    assert.deepEqual(destruction(), [], 'no zfs destroy argv ran')
  })

  it('(c) holds that cannot be read refuse the recursive destroy — and a sweep that cannot be listed — nothing runs', async () => {
    for (const answer of [{ stdout: '', stderr: 'cannot open \'testpool/media@x\': dataset does not exist', exitCode: 1 }, 'throws'] as const) {
      await serve()
      holds = answer
      const res = await inject(DESTROY_RECURSIVE)
      assert.equal(res.statusCode, 409, res.body)
      assert.deepEqual(res.json().error, { code: 'CONFLICT', message: HOLDS_UNREADABLE, reason: 'snapshot-holds-unreadable' })
      assert.deepEqual(destruction(), [])
      await server!.close()
      server = undefined
    }
    await serve()
    sweep = null // the sweep list fails → the gate cannot even enumerate what would be destroyed.
    const res = await inject(DESTROY_RECURSIVE)
    assert.equal(res.statusCode, 409, res.body)
    assert.deepEqual(res.json().error, { code: 'CONFLICT', message: SWEEP_UNREADABLE, reason: 'snapshot-holds-unreadable' })
    assert.deepEqual(destruction(), [])
  })

  it('(d) control: with no holds the destroy runs with the same argv as before — and the gate re-read in the job', async () => {
    await serve()
    holds = ok('')
    const first = await inject(DESTROY_RECURSIVE)
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    const res = await inject(DESTROY_RECURSIVE, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202, res.body)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(destruction().map(c => c.args), [['destroy', '-r', '--', 'testpool/media']], 'the same destroy argv as before the gate')
    // The gate is in the spec list, so it re-ran at every door: the route on the
    // challenge, the route again on the resend, and the job before `zfs destroy`.
    assert.equal(sweepCalls().length, 3, 'the sweep list at the route (twice) and in the job')
    assert.equal(holdsCalls().length, 3, 'the holds at the route (twice) and in the job')
  })
})
