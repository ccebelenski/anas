import type { ReplicatePlan } from '@anas/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { CommandExecutor, ExecResult, PipelineResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import type { PveFootprint } from '../../services/pve-footprint.js'
import type { Transport } from '../../services/replication-transport.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { parseSnapshotList, zfsSnapshotDetailArgs } from '../../parsers/zfs-list.js'
import { replicationHoldTag } from '../../services/replication-holds.js'
import { createTransport } from '../../services/replication-transport.js'
import { createReplicationHandlers } from '../replication.js'

/**
 * cr3 (the 2026-11-14 review, area `replication`): the single-dataset run.
 *
 *   REPLICATION-M1 — a Replicate Once of a snapshot the target ALREADY has
 *     sent an incremental ZFS ignored and moved the chain's hold BACK onto it
 *     (the reviewer's probe-older-snapshot-hold.mts is the first test here).
 *   Failed listings — a snapshot listing that failed read as `[]`: the target
 *     "diverged — remove the target dataset".
 *   The newest snapshot was unfiltered — a backup run's transient was sent.
 *   Order — "newer than" follows createtxg, not the creation clock.
 *   Route-level refusals notify (the recursive branch's rule since rrep.2).
 *   REPLICATION-L5 — a remote stderr reaches the job error and the mail as ONE line.
 *
 * The executor is a hand fake that keeps the holds as state, so a test reads
 * what ZFS would hold afterwards, not only which commands ran.
 */

const ZFS = '/usr/sbin/zfs'
const PERL = '/usr/bin/perl'
const SRC = 'tank/data'
const TGT = 'backup/data'

const HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': '11111111-1111-4111-8111-111111111111',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
}

interface Snap { name: string, txg: number, creation?: string }

/** `zfs list -j -t snapshot` JSON as ZFS prints it (the key is the full name). */
function snapJson(dataset: string, snaps: Snap[]): string {
  const datasets: Record<string, unknown> = {}
  for (const s of snaps) {
    const full = `${dataset}@${s.name}`
    datasets[full] = {
      name: full,
      type: 'SNAPSHOT',
      pool: dataset.split('/')[0],
      createtxg: String(s.txg),
      dataset,
      snapshot_name: s.name,
      properties: {
        creation: { value: s.creation ?? 'Mon Jul 13 10:00:00 UTC 2026', source: { type: 'NONE', data: '-' } },
        used: { value: '0B', source: { type: 'NONE', data: '-' } },
        referenced: { value: '0B', source: { type: 'NONE', data: '-' } },
      },
    }
  }
  return JSON.stringify({ output_version: { command: 'zfs list', vers_major: 0, vers_minor: 1 }, datasets })
}

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

interface World {
  /** dataset → its `zfs list -j -t snapshot` answer. */
  listings: Map<string, ExecResult>
  /** Datasets `datasetExists` answers true for. */
  present: Set<string>
  /** full snapshot → hold tags. */
  holds: Map<string, Set<string>>
  /** `zfs holds` fails (cr4): a read that could not see is unknown, never "no holds". */
  holdsFail?: boolean
  pipelineResult?: PipelineResult
  /** This node's `zpool list -j` answer (default: tank and backup). */
  zpoolList?: ExecResult
  /** ssh (remote) answers, keyed by the remote command joined with spaces. */
  remote?: Map<string, ExecResult>
  /**
   * repl.drift: the target's `zfs get written@<base>,readonly` answer (local
   * or over ssh). Absent: a clean read-only replica (`0`, `on`), the state
   * every world here models.
   */
  targetState?: ExecResult
}

/** A clean read-only replica's answer to the drift read (the captured rows' shape). */
function cleanTargetState(args: string[]): ExecResult {
  const props = args[args.indexOf('--') - 1].split(',')
  return ok(`${props[0]}\t0\t-\nreadonly\ton\tlocal\n`)
}

function hold(world: World, snap: string, tag: string): void {
  const set = world.holds.get(snap) ?? new Set<string>()
  set.add(tag)
  world.holds.set(snap, set)
}

function holdsOf(world: World): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of world.holds) {
    if (v.size)
      // eslint-disable-next-line e18e/prefer-array-to-sorted -- Set → sorted list
      out[k] = [...v].sort()
  }
  return out
}

function fakeExecutor(world: World, log: string[]): CommandExecutor {
  const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
    log.push(`${cmd} ${args.join(' ')}`)
    if (cmd === PERL)
      return ok()
    if (cmd === '/usr/sbin/zpool' && args[0] === 'list')
      return world.zpoolList ?? ok(JSON.stringify({ pools: { tank: { name: 'tank', state: 'ONLINE', properties: {} }, backup: { name: 'backup', state: 'ONLINE', properties: {} } } }))
    if (cmd === ZFS && args[0] === 'list' && args.includes('snapshot')) {
      const ds = args.at(-1)!
      return world.listings.get(ds) ?? { stdout: '', stderr: `cannot open '${ds}': dataset does not exist`, exitCode: 1 }
    }
    if (cmd === ZFS && args[0] === 'holds') {
      const ops = args.slice(args.indexOf('--') + 1)
      if (world.holdsFail)
        return { stdout: '', stderr: 'cannot open \'tank/data@anas-backup-nightly-1794618000\': permission denied', exitCode: 1 }
      return ok(ops.flatMap(s => Array.from(world.holds.get(s) ?? [], t => `${s}\t${t}\tMon Jul 13 10:00 2026`)).join('\n'))
    }
    if (cmd === ZFS && args[0] === 'hold') {
      hold(world, args[3], args[2])
      return ok()
    }
    if (cmd === ZFS && args[0] === 'release') {
      world.holds.get(args[3])?.delete(args[2])
      return ok()
    }
    if (cmd === ZFS && args[0] === 'send')
      return ok('size\t1000\n')
    if (cmd === ZFS && args[0] === 'get')
      return world.targetState ?? cleanTargetState(args)
    if (cmd === '/usr/bin/ssh') {
      const remoteArgs = args.slice(args.indexOf('--') + 2)
      const remoteCmd = remoteArgs.join(' ')
      if (remoteArgs[1] === 'get' && !world.remote?.has(remoteCmd))
        return world.targetState ?? cleanTargetState(remoteArgs.slice(1))
      return world.remote?.get(remoteCmd) ?? { stdout: '', stderr: 'no fixture', exitCode: 127 }
    }
    return { stdout: '', stderr: 'no fixture', exitCode: 127 }
  }
  return {
    exec,
    async pipeline(_c1: string, a1: string[], _c2: string, a2: string[]) {
      log.push(`PIPE ${a1.join(' ')} | ${a2.join(' ')}`)
      return world.pipelineResult ?? { leftExitCode: 0, rightExitCode: 0, leftStderr: '', rightStderr: '', stdout: '' }
    },
  } as unknown as CommandExecutor
}

const unowned = { ownershipOf: () => null, claimedByPve: () => null, ownedDescendant: () => null, storagesByPool: new Map() } as unknown as PveFootprint

/**
 * The REAL transport over the fake executor (so its own reads run the argv
 * they always ran), with location resolution and the pool listing answered:
 * a remote `nas1` that is registered and has the pool `backup`.
 */
function fakeTransport(executor: CommandExecutor): Transport {
  const resolved = { kind: 'remote' as const, host: '10.0.0.9', port: 22, user: 'root', keyPath: '/k', knownHostsFile: '/kh' }
  const real = createTransport(executor, { paths: { registryFile: '/nonexistent/remotes.json', keyPath: '/k', knownHostsFile: '/kh' }, membersFile: '/nonexistent/.members' })
  return {
    ...real,
    resolveLocation: async () => ({ ok: true, resolved }),
    remotePoolNames: async () => ({ ok: true, pools: ['backup'] }),
    remotePoolExists: async () => ({ ok: true, exists: true }),
  }
}

let unitsDir: string
before(async () => {
  unitsDir = await mkdtemp(join(tmpdir(), 'anas-cr3-repl-'))
})
after(async () => {
  await rm(unitsDir, { recursive: true, force: true })
})

/** Run one request through the real handlers; the job runs inline and is awaited. */
async function run(world: World, body: Record<string, unknown>, opts: { plan?: boolean, sourceExists?: boolean } = {}) {
  const log: string[] = []
  const executor = fakeExecutor(world, log)
  let jobPromise: Promise<unknown> | undefined
  const jobQueue = {
    submit(_op: string, _s: unknown, handler: (p: (m: string) => void) => Promise<unknown>) {
      jobPromise = handler(() => {})
      return { id: 'job-1' }
    },
  } as unknown as JobQueue
  const handlers = createReplicationHandlers({
    executor,
    jobQueue,
    resolveDatasetName: (pool, p) => (p ? `${pool}/${p}` : pool),
    poolExists: async () => true,
    datasetExists: async (_pool, full) => (full === SRC ? opts.sourceExists !== false : world.present.has(full)),
    // The datasets wiring's own helper, as routes/datasets.ts builds it
    // (fail-open to [] and creation-time order) — what the run read before.
    listSnapshotsDetail: async (full) => {
      const r = await executor.exec(ZFS, zfsSnapshotDetailArgs(full))
      return r.exitCode !== 0 || !r.stdout.trim() ? [] : parseSnapshotList(r.stdout)
    },
    pveFootprint: async () => unowned,
    transport: fakeTransport(executor),
    systemdDir: unitsDir,
  })
  let code = 200
  const reply = {
    code(c: number) {
      code = c
      return reply
    },
    send() {
      return reply
    },
  } as unknown as FastifyReply
  const request = { body, headers: HEADERS, log: { warn() {} } } as unknown as FastifyRequest
  const answer = opts.plan
    ? await handlers.planReplication('tank', 'data', request, reply)
    : await handlers.runReplication('tank', 'data', request, reply)
  let result: unknown
  let error: Error | undefined
  if (jobPromise) {
    try {
      result = await jobPromise
    }
    catch (err) {
      error = err as Error
    }
  }
  const notifications = log.filter(l => l.startsWith(PERL))
  return { code, answer, result, error, log, notifications }
}

const LOCAL_TAG = replicationHoldTag(undefined, TGT)

/** Three snapshots replicated, newest-first Sn, S0, Sbase on BOTH sides; the chain's hold on @Sn. */
function replicatedWorld(): World {
  const snaps = [{ name: 'Sbase', txg: 100 }, { name: 'S0', txg: 200 }, { name: 'Sn', txg: 300 }]
  const world: World = {
    listings: new Map([[SRC, ok(snapJson(SRC, snaps))], [TGT, ok(snapJson(TGT, snaps))]]),
    present: new Set([TGT]),
    holds: new Map(),
  }
  hold(world, `${SRC}@Sn`, LOCAL_TAG)
  hold(world, `${TGT}@Sn`, LOCAL_TAG)
  return world
}

describe('cr3 REPLICATION-M1 — a target that already has S is up to date', () => {
  it('the reviewer\'s probe: Replicate Once of an OLDER snapshot the target has sends nothing and moves no hold', async () => {
    const world = replicatedWorld()
    const before = holdsOf(world)
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' }, snapshot: 'S0' })
    assert.equal(r.error, undefined, r.error?.message)
    // Before the fix: PIPE send -i @Sbase -- tank/data@S0, then the tag moved
    // to @S0 and came off @Sn on BOTH sides.
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [], 'nothing is sent')
    assert.deepEqual(r.log.filter(l => / (?:hold|release) /.test(l)), [], 'no hold or release is issued')
    assert.deepEqual(holdsOf(world), before, 'the chain\'s hold stays on @Sn on both sides')
    const result = r.result as { mode?: string, upToDate?: string[], note?: string, bytesEstimated: number }
    assert.equal(result.mode, undefined)
    assert.deepEqual(result.upToDate, [SRC])
    assert.equal(result.bytesEstimated, 0)
    assert.match(result.note ?? '', /already has '@Sn', which is newer than '@S0': nothing was sent and no hold was moved/)
  })

  it('the NEWEST common snapshot asked for again: nothing sent, its hold is settled where it already is', async () => {
    const world = replicatedWorld()
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' }, snapshot: 'Sn' })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [])
    assert.deepEqual(holdsOf(world), { [`${SRC}@Sn`]: [LOCAL_TAG], [`${TGT}@Sn`]: [LOCAL_TAG] })
    assert.equal((r.result as { note?: string }).note, undefined)
  })

  it('a hold an earlier run failed to place on the newest common snapshot is placed (the recursive run\'s repair)', async () => {
    const world = replicatedWorld()
    world.holds.clear()
    hold(world, `${SRC}@S0`, LOCAL_TAG) // stale: the earlier run held S0 and never moved on
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [])
    assert.deepEqual(holdsOf(world), { [`${SRC}@Sn`]: [LOCAL_TAG], [`${TGT}@Sn`]: [LOCAL_TAG] })
  })

  it('an older snapshot the target LACKS while it has a newer one is refused before any send', async () => {
    const world = replicatedWorld()
    world.listings.set(TGT, ok(snapJson(TGT, [{ name: 'Sbase', txg: 100 }, { name: 'Sn', txg: 300 }])))
    const before = holdsOf(world)
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' }, snapshot: 'S0' })
    assert.match(r.error?.message ?? '', /Target 'backup\/data' already has '@Sn', which is newer than '@S0'/)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [])
    assert.deepEqual(holdsOf(world), before)
  })

  it('the plan says so: upToDate, nothing to estimate', async () => {
    const world = replicatedWorld()
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' }, snapshot: 'S0' }, { plan: true })
    const plan = (r.answer as { data: ReplicatePlan }).data
    assert.equal(plan.upToDate, true)
    assert.equal(plan.estimatedBytes, 0)
    assert.equal(plan.targetDiverged, false)
    assert.equal(plan.baseSnapshot, undefined)
    assert.deepEqual(r.log.filter(l => l.includes('send -nvP')), [])
  })

  it('a plan with something to send carries no upToDate field (additive)', async () => {
    const world = replicatedWorld()
    world.listings.set(TGT, ok(snapJson(TGT, [{ name: 'Sbase', txg: 100 }])))
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } }, { plan: true })
    const plan = (r.answer as { data: ReplicatePlan }).data
    assert.equal(plan.upToDate, undefined)
    assert.equal(plan.mode, 'incremental')
    assert.equal(plan.baseSnapshot, 'Sbase')
    assert.equal(plan.snapshot, 'Sn')
  })
})

describe('cr3 — a snapshot listing that failed is never "no snapshots"', () => {
  it('a LOCAL target listing that fails refuses the run with the read, never "diverged — remove the target"', async () => {
    const world = replicatedWorld()
    world.listings.set(TGT, { stdout: '', stderr: 'cannot iterate filesystems: I/O error', exitCode: 1 })
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.match(r.error?.message ?? '', /Could not list the snapshots of target 'backup\/data': cannot iterate filesystems: I\/O error — refusing the replication; nothing was sent/)
    assert.doesNotMatch(r.error?.message ?? '', /diverged|remove the target/)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [])
  })

  it('a REMOTE target listing whose ssh fails (255) refuses with ssh\'s own last line', async () => {
    const world = replicatedWorld()
    world.remote = new Map([
      ['zfs list -H -o name -- backup/data', ok('backup/data\n')],
      ['zfs list -H -t snapshot -o name,creation -s createtxg -- backup/data', { stdout: '', stderr: 'Connection closed by 10.0.0.9 port 22\r\n', exitCode: 255 }],
    ])
    const r = await run(world, { target: { pool: 'backup', dataset: 'data', location: { kind: 'remote', name: 'nas1' } } })
    assert.match(r.error?.message ?? '', /Could not list the snapshots of target 'backup\/data' on remote 'nas1': Connection closed by 10\.0\.0\.9 port 22 — refusing/)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [])
  })

  it('a REMOTE existence check whose ssh fails is not "absent" (no full send is attempted)', async () => {
    const world = replicatedWorld()
    world.remote = new Map([
      ['zfs list -H -o name -- backup/data', { stdout: '', stderr: 'Permission denied (publickey).', exitCode: 255 }],
    ])
    const r = await run(world, { target: { pool: 'backup', dataset: 'data', location: { kind: 'remote', name: 'nas1' } } })
    assert.match(r.error?.message ?? '', /Permission denied \(publickey\)/)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [])
  })

  it('a REMOTE target that does not exist (ZFS says so) is still a full send', async () => {
    const world = replicatedWorld()
    world.remote = new Map([
      ['zfs list -H -o name -- backup/data', { stdout: '', stderr: 'cannot open \'backup/data\': dataset does not exist', exitCode: 1 }],
    ])
    const r = await run(world, { target: { pool: 'backup', dataset: 'data', location: { kind: 'remote', name: 'nas1' } } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.equal(r.log.filter(l => l.startsWith('PIPE')).length, 1)
    assert.equal((r.result as { mode: string }).mode, 'full')
  })

  it('a SOURCE listing that fails names the read, never "create a snapshot first"', async () => {
    const world = replicatedWorld()
    world.listings.set(SRC, { stdout: '', stderr: 'cannot iterate filesystems: I/O error', exitCode: 1 })
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.match(r.error?.message ?? '', /Could not list the snapshots of 'tank\/data': cannot iterate filesystems: I\/O error/)
    assert.doesNotMatch(r.error?.message ?? '', /create a snapshot first/)
  })
})

describe('cr3 — which snapshot a run sends when none is named', () => {
  it('a backup run\'s transient that is the newest snapshot is not sent; the newest real one is', async () => {
    const world = replicatedWorld()
    world.listings.set(TGT, ok(snapJson(TGT, [{ name: 'Sbase', txg: 100 }])))
    world.listings.set(SRC, ok(snapJson(SRC, [
      { name: 'Sbase', txg: 100 },
      { name: 'Sn', txg: 300 },
      { name: 'anas-backup-nightly-1794618281', txg: 400 },
    ])))
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), ['PIPE send -i @Sbase -- tank/data@Sn | recv -o readonly=on -- backup/data'])
    assert.equal(world.holds.get(`${SRC}@anas-backup-nightly-1794618281`), undefined, 'the transient carries no hold')
  })

  it('"newest" is the latest createtxg, not the latest creation clock (a clock stepped back)', async () => {
    const world = replicatedWorld()
    world.listings.set(TGT, ok(snapJson(TGT, [{ name: 'Sbase', txg: 100, creation: 'Mon Jul 13 09:00:00 UTC 2026' }])))
    world.listings.set(SRC, ok(snapJson(SRC, [
      { name: 'Sbase', txg: 100, creation: 'Mon Jul 13 09:00:00 UTC 2026' },
      // taken FIRST, while the clock read later
      { name: 'early', txg: 200, creation: 'Mon Jul 13 12:00:00 UTC 2026' },
      // taken AFTER `early`, once the clock had been stepped back
      { name: 'late', txg: 300, creation: 'Mon Jul 13 11:00:00 UTC 2026' },
    ])))
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), ['PIPE send -i @Sbase -- tank/data@late | recv -o readonly=on -- backup/data'])
  })
})

describe('cr3 — a refusal at the route is a failed run and notifies', () => {
  it('a source that is gone answers 404 AND notifies, as the recursive branch does', async () => {
    const world = replicatedWorld()
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } }, { sourceExists: false })
    assert.equal(r.code, 404)
    assert.equal(r.notifications.length, 1)
    assert.ok(r.notifications[0].includes('Dataset \'tank/data\' not found'))
  })

  it('a target guard refusal (a remote that is not registered) answers 400 AND notifies, naming the location', async () => {
    const world = replicatedWorld()
    const log: string[] = []
    const executor = fakeExecutor(world, log)
    const transport = fakeTransport(executor)
    transport.resolveLocation = async () => ({ ok: false, error: 'remote \'gone\' is not registered' })
    const handlers = createReplicationHandlers({
      executor,
      jobQueue: { submit() {
        throw new Error('no job may be submitted')
      } } as unknown as JobQueue,
      resolveDatasetName: (pool, p) => `${pool}/${p}`,
      poolExists: async () => true,
      datasetExists: async () => true,
      listSnapshotsDetail: async () => [],
      pveFootprint: async () => unowned,
      transport,
      systemdDir: unitsDir,
    })
    let code = 0
    const reply = { code(c: number) {
      code = c
      return reply
    }, send() {
      return reply
    } } as unknown as FastifyReply
    const request = { body: { target: { pool: 'backup', location: { kind: 'remote', name: 'gone' } } }, headers: HEADERS, log: { warn() {} } } as unknown as FastifyRequest
    await handlers.runReplication('tank', 'data', request, reply)
    assert.equal(code, 400)
    const sent = log.filter(l => l.startsWith(PERL))
    assert.equal(sent.length, 1)
    assert.ok(sent[0].includes('not registered'))
    assert.ok(sent[0].includes('(remote \'gone\')'), sent[0])
  })
})

describe('cr3 — a LOCAL pool listing that failed is never "the pool does not exist"', () => {
  it('a failing `zpool list` on this node refuses with its own line, at the plan and at the run', async () => {
    for (const plan of [true, false]) {
      const world = replicatedWorld()
      world.zpoolList = { stdout: '', stderr: 'internal error: failed to initialize ZFS library\n', exitCode: 1 }
      const r = await run(world, { target: { pool: 'backup', dataset: 'data' } }, { plan })
      assert.equal(r.code, 400)
      const message = (r.answer as { error: { message: string } }).error.message
      assert.equal(message, 'Could not list the pools on this node: internal error: failed to initialize ZFS library')
      assert.doesNotMatch(message, /does not exist/)
      assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [])
    }
  })

  it('a listing that answered without the pool keeps the does-not-exist sentence', async () => {
    const world = replicatedWorld()
    world.zpoolList = ok(JSON.stringify({ pools: { tank: { name: 'tank', state: 'ONLINE', properties: {} } } }))
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } }, { plan: true })
    assert.equal(r.code, 400)
    assert.equal((r.answer as { error: { message: string } }).error.message, 'Target pool \'backup\' does not exist')
  })
})

describe('review of cr3 — a backup or cloud TRANSIENT never carries the chain\'s hold', () => {
  const T = 'anas-backup-nightly-1794618000'

  /** The reviewer's case: S1..S3 replicated, the hold on @S3, a backup run's @T newest on the source. */
  function transientWorld(targetHasT: boolean): World {
    const src = [{ name: 'S1', txg: 100 }, { name: 'S2', txg: 200 }, { name: 'S3', txg: 300 }, { name: T, txg: 400 }]
    const tgt = targetHasT ? src : src.slice(0, 3)
    const world: World = {
      listings: new Map([[SRC, ok(snapJson(SRC, src))], [TGT, ok(snapJson(TGT, tgt))]]),
      present: new Set([TGT]),
      holds: new Map(),
    }
    hold(world, `${SRC}@S3`, LOCAL_TAG)
    hold(world, `${TGT}@S3`, LOCAL_TAG)
    return world
  }

  for (const targetHasT of [true, false]) {
    it(`a NAMED transient is refused at the request, nothing sent, the hold stays on @S3 (target ${targetHasT ? 'has' : 'lacks'} it)`, async () => {
      const world = transientWorld(targetHasT)
      const before = holdsOf(world)
      const r = await run(world, { target: { pool: 'backup', dataset: 'data' }, snapshot: T })
      // Before: PIPE send -i @S3 -- tank/data@T, the tag moved onto @T on both
      // sides and came off @S3; once retention pruned @S3 the next run read
      // "diverged — remove the target dataset".
      assert.equal(r.code, 400)
      assert.match((r.answer as { error: { message: string } }).error.message, /'tank\/data@anas-backup-nightly-1794618000': snapshot names beginning with 'anas-backup-' or 'anas-cloud-' are reserved for backup and cloud runs and are never replicated by name/)
      assert.equal(r.result, undefined, 'no job ran')
      assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [])
      assert.deepEqual(holdsOf(world), before)
      assert.equal(r.notifications.length, 1, 'a refusal at the route notifies')
    })
  }

  it('the plan refuses a named transient too', async () => {
    const r = await run(transientWorld(true), { target: { pool: 'backup', dataset: 'data' }, snapshot: T }, { plan: true })
    assert.equal(r.code, 400)
  })

  it('the same state with the hold on @S3 (the transient not held on the source) says it is sent from only while the source keeps it', async () => {
    const world = transientWorld(true)
    const before = holdsOf(world)
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(holdsOf(world), before)
    assert.match((r.result as { note?: string }).note ?? '', /sent from it only while the source still has it — it is not held there, so the run that took it may destroy it first, and the run then sends from '@S3'/)
  })

  it('a FAILED holds read says the holds could not be read and gives the command (cr4)', async () => {
    const world = transientWorld(true)
    world.holdsFail = true
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    const note = (r.result as { note?: string }).note ?? ''
    assert.match(note, /The holds on 'tank\/data@anas-backup-nightly-1794618000' could not be read, so ANAS cannot say whether it is protected; check with: zfs holds tank\/data@anas-backup-nightly-1794618000/)
    assert.doesNotMatch(note, /it is not held there/)
  })

  it('with nothing named and the target\'s newest snapshot a transient the source still has, nothing is sent and the holds stay (the next send starts from it)', async () => {
    // Review 2 of cr3: an older build sent @T and held it on both sides.
    // Moving the hold off @T here would let the backup run's cleanup destroy
    // it on the source, and the next night would need the operator.
    const world = transientWorld(true)
    world.holds.clear()
    hold(world, `${SRC}@${T}`, LOCAL_TAG)
    hold(world, `${TGT}@${T}`, LOCAL_TAG)
    const before = holdsOf(world)
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [])
    assert.deepEqual(holdsOf(world), before)
    assert.match((r.result as { note?: string }).note ?? '', /newest snapshot is '@anas-backup-nightly-1794618000'.*the next new snapshot is sent from it/)
  })
})

describe('review 2 of cr3 — a transient the TARGET ends on (an older build sent it)', () => {
  const T = 'anas-backup-nightly-1794618000'

  /** The reviewer's p1b state: an older build sent @T and held it on both sides. */
  function oldBuildWorld(src: string[], tgt: string[]): World {
    const world: World = {
      listings: new Map([
        [SRC, ok(snapJson(SRC, src.map((name, i) => ({ name, txg: (i + 1) * 100 }))))],
        [TGT, ok(snapJson(TGT, tgt.map((name, i) => ({ name, txg: (i + 1) * 100 }))))],
      ]),
      present: new Set([TGT]),
      holds: new Map(),
    }
    if (src.includes(T))
      hold(world, `${SRC}@${T}`, LOCAL_TAG)
    hold(world, `${TGT}@${T}`, LOCAL_TAG)
    return world
  }

  it('(a) a new snapshot is sent FROM the transient the target ends on; the hold then sits on the new snapshot, off @T on both sides', async () => {
    // Before: `-i @S3` every night, refused by the receive (the target's
    // newest is @T); the hold stayed on @T, @S3 was pruned, and the run then
    // said "diverged — remove the target dataset".
    const world = oldBuildWorld(['S1', 'S2', 'S3', T, 'S4'], ['S1', 'S2', 'S3', T])
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [`PIPE send -i @${T} -- tank/data@S4 | recv -o readonly=on -- backup/data`])
    // The fake receive changes nothing on the target listing, so the target
    // side holds S4 by name; what matters: no hold is left on the transient.
    assert.equal(world.holds.get(`${SRC}@${T}`)?.size ?? 0, 0, 'the source transient is released')
    assert.equal(world.holds.get(`${TGT}@${T}`)?.size ?? 0, 0, 'the target transient is released')
    assert.deepEqual([...(world.holds.get(`${SRC}@S4`) ?? [])], [LOCAL_TAG])
    assert.deepEqual([...(world.holds.get(`${TGT}@S4`) ?? [])], [LOCAL_TAG])
  })

  // Review 3 of cr3: a transient the SOURCE does not have is any target-only
  // snapshot — ZFS (no -F) receives `-i @S3` while the target is unmodified
  // since its newest snapshot (ground truth on the node pair, ZFS 2.4.2:
  // `anas-backup-x-1` on a readonly replica, `send -i @S4 S5` exit 0).
  for (const [label, tName] of [
    ['R1: a backup run on the TARGET node of the replica', 'anas-backup-replica-1794619000'],
    ['R5: an older build\'s transient the source has since destroyed', T],
  ] as const) {
    it(`${label}: the target ending on it is sent to from @S3, never refused`, async () => {
      const world = oldBuildWorld(['S1', 'S2', 'S3', 'S4'], ['S1', 'S2', 'S3', tName])
      world.holds.clear()
      hold(world, `${SRC}@S3`, LOCAL_TAG)
      hold(world, `${TGT}@S3`, LOCAL_TAG)
      const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
      assert.equal(r.error, undefined, r.error?.message)
      assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), ['PIPE send -i @S3 -- tank/data@S4 | recv -o readonly=on -- backup/data'])
      assert.deepEqual([...(world.holds.get(`${SRC}@S4`) ?? [])], [LOCAL_TAG])
      assert.equal(world.holds.get(`${SRC}@S3`)?.size ?? 0, 0)
    })
  }

  it('a receive ZFS refuses as "modified since most recent snapshot" keeps the raw stderr and ADDS the rollback hint, never "destroy"', async () => {
    const world = oldBuildWorld(['S1', 'S2', 'S3', 'S4'], ['S1', 'S2', 'S3', T])
    world.holds.clear()
    // Captured verbatim on the node pair (ZFS 2.4.2): the line WRAPS.
    world.pipelineResult = {
      leftExitCode: 0,
      rightExitCode: 1,
      leftStderr: '',
      rightStderr: 'cannot receive incremental stream: destination backup/data has been modified\nsince most recent snapshot\n',
      stdout: '',
    }
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    const message = r.error?.message ?? ''
    assert.match(message, /^Replication failed — recv: cannot receive incremental stream: destination backup\/data has been modified since most recent snapshot — /)
    assert.match(message, /the target was written to after '@S3' and has newer snapshot\(s\) '@anas-backup-nightly-1794618000'/)
    assert.match(message, /release any hold on that snapshot \('zfs holds backup\/data@anas-backup-nightly-1794618000' lists them/)
    assert.match(message, /'zfs rollback -r backup\/data@S3'/)
    assert.doesNotMatch(message, /zfs destroy/)
  })

  it('any other receive failure carries no rollback hint', async () => {
    const world = oldBuildWorld(['S1', 'S2', 'S3', 'S4'], ['S1', 'S2', 'S3'])
    world.holds.clear()
    world.pipelineResult = { leftExitCode: 0, rightExitCode: 1, leftStderr: '', rightStderr: 'cannot receive: out of space\n', stdout: '' }
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error?.message, 'Replication failed — recv: cannot receive: out of space')
  })

  it('(c) the only snapshot in common is a transient that is not the target\'s newest: refused NAMING it, never "remove the target dataset"', async () => {
    const world = oldBuildWorld(['S1', T, 'S4'], [T, 'X'])
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    const message = r.error?.message ?? ''
    assert.match(message, /shares with the source \('@anas-backup-nightly-1794618000'\)/)
    assert.match(message, /the target has not diverged/)
    assert.doesNotMatch(message, /remove the target dataset/)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [])
  })

  it('R5: the plan for a target ending on a transient the source lacks is an incremental from @S3, not a refusal', async () => {
    const world = oldBuildWorld(['S1', 'S2', 'S3', 'S4'], ['S1', 'S2', 'S3', T])
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } }, { plan: true })
    const plan = (r.answer as { data: ReplicatePlan }).data
    assert.equal(plan.mode, 'incremental')
    assert.equal(plan.baseSnapshot, 'S3')
  })

  it('nothing in common at all is still "diverged" (the one case that sentence is for)', async () => {
    const world = oldBuildWorld(['S1', 'S2'], ['X', 'Y'])
    world.holds.clear()
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.match(r.error?.message ?? '', /has diverged — no common snapshot/)
  })
})

describe('review 2 of cr3 — `no pools available` is the node\'s answer', () => {
  it('the legacy non-zero `no pools available` reads as "does not exist", not "could not list"', async () => {
    const world = replicatedWorld()
    world.zpoolList = { stdout: '', stderr: 'no pools available\n', exitCode: 1 }
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } }, { plan: true })
    assert.equal(r.code, 400)
    assert.equal((r.answer as { error: { message: string } }).error.message, 'Target pool \'backup\' does not exist')
  })

  it('exit 0 with nothing printed (OpenZFS 2.4 -j on a node with no pools) reads the same', async () => {
    const world = replicatedWorld()
    world.zpoolList = ok('')
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } }, { plan: true })
    assert.equal((r.answer as { error: { message: string } }).error.message, 'Target pool \'backup\' does not exist')
  })
})

describe('review of cr3 — reads that are not answers', () => {
  it('a LOCAL target whose existence probe said "no" while ZFS lists it is not a full send (absence is ZFS\'s own answer)', async () => {
    const world = replicatedWorld()
    world.present.delete(TGT) // the datasets helper's boolean: false on a failed pool listing
    world.listings.set(TGT, ok(snapJson(TGT, [{ name: 'Sbase', txg: 100 }])))
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } }, { plan: true })
    const plan = (r.answer as { data: ReplicatePlan }).data
    assert.equal(plan.mode, 'incremental')
    assert.equal(plan.targetExists, true)
    assert.equal(plan.baseSnapshot, 'Sbase')
  })

  it('a REMOTE snapshot listing that exits 0 with lines but no row of the dataset is "could not read", not "diverged"', async () => {
    const world = replicatedWorld()
    world.remote = new Map([
      ['zfs list -H -o name -- backup/data', ok('backup/data\n')],
      ['zfs list -H -t snapshot -o name,creation -s createtxg -- backup/data', ok('Welcome to the NAS\nLast login: never\n')],
    ])
    const r = await run(world, { target: { pool: 'backup', dataset: 'data', location: { kind: 'remote', name: 'nas1' } } })
    assert.match(r.error?.message ?? '', /Could not list the snapshots of target 'backup\/data' on remote 'nas1': unreadable snapshot listing \(no row of 'backup\/data'\): 'Welcome to the NAS'/)
    assert.doesNotMatch(r.error?.message ?? '', /diverged/)
    assert.deepEqual(r.log.filter(l => l.startsWith('PIPE')), [])
  })

  it('a banner line beside real rows is skipped; the rows are read', async () => {
    const world = replicatedWorld()
    world.remote = new Map([
      ['zfs list -H -o name -- backup/data', ok('backup/data\n')],
      ['zfs list -H -t snapshot -o name,creation -s createtxg -- backup/data', ok('Welcome to the NAS\nbackup/data@Sbase\t1\nbackup/data@S0\t2\nbackup/data@Sn\t3\n')],
    ])
    const r = await run(world, { target: { pool: 'backup', dataset: 'data', location: { kind: 'remote', name: 'nas1' } } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual((r.result as { upToDate?: string[] }).upToDate, [SRC])
  })
})

describe('cr3 REPLICATION-L5 — a remote stderr is one line in the job error and the mail', () => {
  it('a newline or carriage return in recv stderr writes no line of its own', async () => {
    const world = replicatedWorld()
    world.listings.set(TGT, ok(snapJson(TGT, [{ name: 'Sbase', txg: 100 }])))
    world.pipelineResult = {
      leftExitCode: 0,
      rightExitCode: 1,
      leftStderr: '',
      rightStderr: 'cannot receive: failed\nResult:      success\r\nWarnings:\n',
      stdout: '',
    }
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error?.message, 'Replication failed — recv: cannot receive: failed Result:      success  Warnings:')
    assert.equal(r.notifications.length, 1)
    // The mail body is the perl call's last argument: no line of it may start
    // with a forged key.
    const body = r.notifications[0]
    assert.doesNotMatch(body, /\nResult: {6}success/)
    assert.doesNotMatch(body, /\r/)
  })
})
