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
 * repl.drift — the single-dataset run judges the target before it sends:
 * `zfs get -Hp -o property,value,source written@<base>,readonly -- <target>`
 * where the target lives (fixture: zfs-written-replica.zfs2.4.2.txt). A
 * changed target fails the run with the drift sentence and ONE notification;
 * a writable one is sent to and warned about; an up-to-date run warns when the
 * next send would fail; an unreadable state goes ahead and says so. The harness
 * is cr3-replication.test.ts's hand fake (it keeps holds as state).
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
  /** The drift read rejects (a deadline), as the executor does on a timeout. */
  targetThrows?: true
  /** Review P3: the local `zfs set` answer (default: exit 0). */
  setAnswer?: ExecResult
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
      return ok(ops.flatMap(s => Array.from(world.holds.get(s) ?? [], t => `${s}\t${t}\tMon Jul 13 10:00 2026`)).join('\n'))
    }
    if (cmd === ZFS && args[0] === 'hold') {
      // A tag already on the snapshot is refused, as OpenZFS 2.4 words it
      // (replication-holds.ts TAG_EXISTS_RE): such a hold changed nothing.
      if (world.holds.get(args[3])?.has(args[2]))
        return { stdout: '', stderr: `cannot hold snapshot '${args[3]}': tag already exists on this dataset\n`, exitCode: 1 }
      hold(world, args[3], args[2])
      return ok()
    }
    if (cmd === ZFS && args[0] === 'release') {
      world.holds.get(args[3])?.delete(args[2])
      return ok()
    }
    if (cmd === ZFS && args[0] === 'send')
      return ok('size\t1000\n')
    if (cmd === ZFS && args[0] === 'snapshot')
      return ok()
    if (cmd === ZFS && args[0] === 'set')
      return world.setAnswer ?? ok()
    if (cmd === ZFS && args[0] === 'get') {
      if (world.targetThrows)
        throw new Error('zfs get: had not answered after 300 s')
      return world.targetState ?? cleanTargetState(args)
    }
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
  unitsDir = await mkdtemp(join(tmpdir(), 'anas-repl-drift-'))
})
after(async () => {
  await rm(unitsDir, { recursive: true, force: true })
})

/** Run one request through the real handlers; the job runs inline and is awaited. */
async function run(world: World, body: Record<string, unknown>, opts: { plan?: boolean, sourceExists?: boolean } = {}) {
  const log: string[] = []
  const executor = fakeExecutor(world, log)
  let jobPromise: Promise<unknown> | undefined
  let detail: unknown = null
  const jobQueue = {
    submit(_op: string, _s: unknown, handler: (p: (m: string) => void, ctx: { updateDetail: (d: unknown) => void }) => Promise<unknown>) {
      jobPromise = handler(() => {}, {
        updateDetail: (d: unknown) => {
          detail = d
        },
      })
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
  return { code, answer, result, error, log, notifications, detail }
}

const LOCAL_TAG = replicationHoldTag(undefined, TGT)
const REMOTE = { kind: 'remote' as const, name: 'nas1' }
const REMOTE_TAG = replicationHoldTag(REMOTE, TGT)
const READ = `${ZFS} get -Hp -o property,value,source written@S0,readonly -- ${TGT}`

/** Rows of the drift read: captured values in the captured `property\tvalue\tsource` shape. */
function state(base: string, written: number, readonly: string): ExecResult {
  return ok(`written@${base}\t${written}\t-\nreadonly\t${readonly}\tlocal\n`)
}

/**
 * Source Sbase, S0, Sn; the target holds Sbase and S0 (the chain's hold on
 * @S0 both sides) — the next run sends Sn from @S0.
 */
function behindWorld(targetSnaps: { name: string, txg: number }[] = [{ name: 'Sbase', txg: 100 }, { name: 'S0', txg: 200 }]): World {
  const world: World = {
    listings: new Map([
      [SRC, ok(snapJson(SRC, [{ name: 'Sbase', txg: 100 }, { name: 'S0', txg: 200 }, { name: 'Sn', txg: 300 }]))],
      [TGT, ok(snapJson(TGT, targetSnaps))],
    ]),
    present: new Set([TGT]),
    holds: new Map(),
  }
  hold(world, `${SRC}@S0`, LOCAL_TAG)
  hold(world, `${TGT}@S0`, LOCAL_TAG)
  return world
}

/** The target already has Sn (up to date); the chain's hold on @Sn. */
function upToDateWorld(): World {
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

const pipes = (log: string[]) => log.filter(l => l.startsWith('PIPE'))
const holdVerbs = (log: string[]) => log.filter(l => l.startsWith(`${ZFS} hold `) || l.startsWith(`${ZFS} release `))

describe('repl.drift — a healthy run', () => {
  it('a healthy read-only target: exactly one extra read, after the target listing and before the estimate; the rest is today\'s argv', async () => {
    const world = behindWorld()
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    const zfs = r.log.filter(l => l.startsWith(ZFS) || l.startsWith('PIPE'))
    // The run before repl.drift issued exactly this list without READ
    // (checked by running this test over routes/replication.ts at 491730819).
    const before = [
      `${ZFS} list -j -o name,creation,used,referenced -t snapshot -- ${SRC}`,
      `${ZFS} list -j -o name,creation,used,referenced -t snapshot -- ${TGT}`,
      `${ZFS} send -nvP -i @S0 -- ${SRC}@Sn`,
      `PIPE send -i @S0 -- ${SRC}@Sn | recv -o readonly=on -- ${TGT}`,
      `${ZFS} list -j -o name,creation,used,referenced -t snapshot -- ${TGT}`,
      `${ZFS} hold -- ${LOCAL_TAG} ${SRC}@Sn`,
      `${ZFS} hold -- ${LOCAL_TAG} ${TGT}@Sn`,
      `${ZFS} holds -H -- ${SRC}@Sn ${SRC}@S0 ${SRC}@Sbase`,
      `${ZFS} release -- ${LOCAL_TAG} ${SRC}@S0`,
      `${ZFS} holds -H -- ${TGT}@S0 ${TGT}@Sbase`,
      `${ZFS} release -- ${LOCAL_TAG} ${TGT}@S0`,
    ]
    assert.deepEqual(zfs, [...before.slice(0, 2), READ, ...before.slice(2)])
    const result = r.result as { warnings?: string[], note?: string, mode: string }
    assert.equal(result.mode, 'incremental')
    assert.equal(result.warnings, undefined)
    assert.equal(result.note, undefined)
    assert.equal((r.result as { targetDrift?: unknown }).targetDrift, undefined, 'a healthy run records nothing')
    assert.equal(r.detail, null)
    assert.deepEqual(r.notifications, [], 'on-failure: a healthy run notifies nothing')
  })
})

describe('repl.drift — a target changed since the base', () => {
  it('fails before any send with the drift sentence, ONE notification, no hold moved', async () => {
    const world = behindWorld([{ name: 'Sbase', txg: 100 }, { name: 'S0', txg: 200 }, { name: 'local1', txg: 250 }])
    world.targetState = state('S0', 14336, 'on')
    const before = holdsOf(world)
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error?.message, 'Target \'backup/data\' has been changed since \'@S0\': 14.00 KiB written and newer snapshot(s) \'@local1\'. Replication into it stops until those changes are discarded: to continue the chain, on the target release any hold on that snapshot (\'zfs holds backup/data@local1\' lists them; \'zfs release <tag> <snapshot>\' for each), then roll it back to \'@S0\' (\'zfs rollback -r backup/data@S0\', which destroys the snapshots newer than it there and anything written since). Nothing was sent and no hold was moved or released: the source and its snapshots are untouched, and \'@S0\' stays held on both sides.')
    assert.deepEqual(pipes(r.log), [], 'no send is attempted')
    assert.deepEqual(r.log.filter(l => l.startsWith(`${ZFS} send`)), [], 'not even the estimate')
    assert.deepEqual(holdVerbs(r.log), [], 'no hold or release is issued')
    assert.deepEqual(holdsOf(world), before, 'the base stays held on both sides')
    assert.equal(r.notifications.length, 1, 'exactly one notification')
    // Recorded on the job for the dashboard (the runner prints it to journald).
    assert.deepEqual(r.detail, { targetDrift: [{ state: 'modified', dataset: TGT, base: 'S0' }] })
  })

  it('the base it judges is the one decideBase picked: the receive\'s own base, read once', async () => {
    const world = behindWorld()
    world.targetState = state('S0', 12288, 'off')
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.deepEqual(r.log.filter(l => l.startsWith(`${ZFS} get`)), [READ])
    assert.match(r.error?.message ?? '', /12\.00 KiB written with no new snapshot \(a dataset that is not read-only also changes when a file on it is only read, while access-time updates are on\)/)
    assert.match(r.error?.message ?? '', /It is not read-only \(readonly=off, local\): the next successful receive sets it read-only again; until then, after the rollback, a write there, or a read with access-time updates on, changes it again \('zfs set readonly=on backup\/data' on the target prevents that\)\./)
  })

  it('the run is the periodic check: a second run alerts again (nothing is remembered)', async () => {
    const world = behindWorld()
    world.targetState = state('S0', 14336, 'on')
    const one = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    const two = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(one.notifications.length, 1)
    assert.equal(two.notifications.length, 1)
    assert.equal(one.error?.message, two.error?.message)
  })

  it('a remote target is read over the same ssh argv as its listing, and its sentence names the remote', async () => {
    const world = behindWorld()
    world.holds.clear()
    hold(world, `${SRC}@S0`, REMOTE_TAG)
    world.remote = new Map([
      [`zfs list -H -o name -- ${TGT}`, ok(`${TGT}\n`)],
      [`zfs list -H -t snapshot -o name,creation -s createtxg -- ${TGT}`, ok(`${TGT}@Sbase\tMon Jul 13 10:00 2026\n${TGT}@S0\tMon Jul 13 11:00 2026\n`)],
      [`zfs get -Hp -o property,value,source written@S0,readonly -- ${TGT}`, state('S0', 14336, 'on')],
      [`zfs holds -H -- ${TGT}@S0`, ok(`${TGT}@S0\t${REMOTE_TAG}\tMon Jul 13 10:00 2026\n`)],
    ])
    const r = await run(world, { target: { pool: 'backup', dataset: 'data', location: REMOTE } })
    assert.match(r.error?.message ?? '', /^Target 'backup\/data' on remote 'nas1' has been changed since '@S0': 14\.00 KiB written/)
    assert.match(r.error?.message ?? '', /'@S0' stays held on both sides\.$/)
    const ssh = r.log.filter(l => l.startsWith('/usr/bin/ssh') && l.includes(' get '))
    assert.equal(ssh.length, 1)
    assert.match(ssh[0], / -- root@10\.0\.0\.9 zfs get -Hp -o property,value,source written@S0,readonly -- backup\/data$/)
    assert.deepEqual(pipes(r.log), [])
    assert.equal(r.notifications.length, 1)
  })

  it('an up-to-date target that was changed: nothing sent, the run completes, and the drift is ALERTED (one ERROR notification, review P2)', async () => {
    const world = upToDateWorld()
    world.targetState = ok(`written@Sn\t12288\t-\nreadonly\toff\tlocal\n`)
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(pipes(r.log), [])
    const result = r.result as { warnings?: string[], upToDate?: string[] }
    assert.deepEqual(result.upToDate, [SRC])
    assert.equal(result.warnings?.length, 1)
    assert.match(result.warnings![0], /^Target 'backup\/data' has been changed since '@Sn': 12\.00 KiB written with no new snapshot/)
    assert.equal(r.notifications.length, 1, 'on-failure still hears of it')
    // Review P2: a changed target is critical — ERROR severity, from this path too.
    assert.ok(r.notifications[0].includes(' error replication tank/data -> backup/data completed, target changed '), r.notifications[0].slice(0, 400))
    assert.deepEqual((r.result as { targetDrift?: unknown }).targetDrift, [{ state: 'modified', dataset: TGT, base: 'Sn' }])
    assert.deepEqual(holdsOf(world), { [`${SRC}@Sn`]: [LOCAL_TAG], [`${TGT}@Sn`]: [LOCAL_TAG] })
  })
})

// Review D1 (rule: no precondition that can refuse runs after the first act).
// Before the fix the snapshot was taken first and a refused run left an
// unheld `snapshot-<iso>` on the source while its sentence said "the source
// and its snapshots are untouched" (reviewer probe p2, "LOCAL behind modified
// + snapshotFirst": `zfs snapshot -- tank/data@snapshot-...` then the refusal).
describe('repl.drift review D1 — a snapshot-first run takes its snapshot only after every refusal', () => {
  const snapshotVerbs = (log: string[]) => log.filter(l => l.startsWith(`${ZFS} snapshot `))
  const SNAP_FIRST = { target: { pool: 'backup', dataset: 'data' }, snapshotFirst: true }

  it('a changed target refuses with ZERO snapshot commands, and the notification names no snapshot', async () => {
    const world = behindWorld([{ name: 'Sbase', txg: 100 }, { name: 'S0', txg: 200 }, { name: 'local1', txg: 250 }])
    world.targetState = state('S0', 14336, 'on')
    const r = await run(world, SNAP_FIRST)
    assert.match(r.error?.message ?? '', /^Target 'backup\/data' has been changed since '@S0': 14\.00 KiB written and newer snapshot\(s\) '@local1'\./)
    assert.match(r.error?.message ?? '', /Nothing was sent and no hold was moved or released: the source and its snapshots are untouched, and '@S0' stays held on both sides\.$/)
    assert.deepEqual(snapshotVerbs(r.log), [], 'no snapshot is taken')
    assert.deepEqual(pipes(r.log), [])
    assert.deepEqual(holdVerbs(r.log), [])
    assert.equal(r.notifications.length, 1)
    assert.ok(!r.notifications[0].includes('Snapshot:'), 'a snapshot that was never taken is not named')
  })

  it('a target with nothing in common (diverged) refuses with zero snapshot commands too', async () => {
    const world = behindWorld([{ name: 'elsewhere', txg: 50 }])
    const r = await run(world, SNAP_FIRST)
    assert.match(r.error?.message ?? '', /^Target 'backup\/data' has diverged/)
    assert.deepEqual(snapshotVerbs(r.log), [])
  })

  it('a healthy run: the drift read, THEN the snapshot, then the estimate and the send of it, judged against the same base', async () => {
    const world = behindWorld()
    const r = await run(world, SNAP_FIRST)
    assert.equal(r.error, undefined, r.error?.message)
    const zfs = r.log.filter(l => l.startsWith(ZFS) || l.startsWith('PIPE'))
    const snap = snapshotVerbs(r.log)
    assert.equal(snap.length, 1)
    const name = /@(snapshot-\S+)$/.exec(snap[0])![1]
    assert.deepEqual(zfs.slice(0, 6), [
      `${ZFS} list -j -o name,creation,used,referenced -t snapshot -- ${SRC}`,
      `${ZFS} list -j -o name,creation,used,referenced -t snapshot -- ${TGT}`,
      READ,
      `${ZFS} snapshot -- ${SRC}@${name}`,
      `${ZFS} send -nvP -i @S0 -- ${SRC}@${name}`,
      `PIPE send -i @S0 -- ${SRC}@${name} | recv -o readonly=on -- ${TGT}`,
    ])
    assert.equal((r.result as { snapshot: string }).snapshot, name)
  })
})

// Review D2 (rule: the sentence says what happened). An up-to-date run
// settles its holds before it reads the target; with the chain's hold still
// on an older snapshot (a stopped run received Sn and did not hold it) the
// settle MOVES the hold, and the sentence used to say "no hold was moved or
// released" (reviewer probe p2-stopped). The move itself stays (it pins the
// rollback point).
describe('repl.drift review D2 — an up-to-date run\'s sentence says what its settle did', () => {
  /** The captured atime-read answer (third capture D: 12288, readonly off) re-keyed to @Sn. */
  const MODIFIED_AT_SN = ok(`written@Sn\t12288\tlocal\nreadonly\toff\tlocal\n`)

  it('the chain\'s hold still on @S0: the hold moves to @Sn and the sentence names both moves', async () => {
    const world = upToDateWorld()
    world.holds.clear()
    hold(world, `${SRC}@S0`, LOCAL_TAG)
    hold(world, `${TGT}@S0`, LOCAL_TAG)
    world.targetState = MODIFIED_AT_SN
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(holdVerbs(r.log), [
      `${ZFS} hold -- ${LOCAL_TAG} ${SRC}@Sn`,
      `${ZFS} hold -- ${LOCAL_TAG} ${TGT}@Sn`,
      `${ZFS} release -- ${LOCAL_TAG} ${SRC}@S0`,
      `${ZFS} release -- ${LOCAL_TAG} ${TGT}@S0`,
    ], 'the move is kept')
    const warning = (r.result as { warnings?: string[] }).warnings?.[0] ?? ''
    assert.ok(!warning.includes('no hold was moved'), warning)
    assert.match(warning, / Nothing was sent; this run placed this replication's hold on 'tank\/data@Sn', 'backup\/data@Sn' and released a replication hold from 'tank\/data@S0', 'backup\/data@S0', and '@Sn' stays held on both sides\.$/)
  })

  it('the hold already on @Sn: the two holds are answered "tag already exists" (nothing changed), and the sentence says nothing moved', async () => {
    const world = upToDateWorld()
    world.targetState = MODIFIED_AT_SN
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.deepEqual(holdVerbs(r.log), [`${ZFS} hold -- ${LOCAL_TAG} ${SRC}@Sn`, `${ZFS} hold -- ${LOCAL_TAG} ${TGT}@Sn`])
    const warning = (r.result as { warnings?: string[] }).warnings?.[0] ?? ''
    assert.match(warning, / Nothing was sent and no hold was moved or released: the source and its snapshots are untouched, and '@Sn' stays held on both sides\.$/)
  })
})

// Review N7, through the run: the base's hold on the target is another tag's.
describe('repl.drift review N7 — a base held by another tag is not "removable by retention"', () => {
  it('the run reads every tag on the base and says another hold keeps it on the target', async () => {
    const world = behindWorld()
    world.holds.set(`${TGT}@S0`, new Set(['keep']))
    world.targetState = state('S0', 14336, 'on')
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.match(r.error?.message ?? '', /'@S0' is not held by this replication on the target; another hold keeps it there \(ZFS does not destroy a held snapshot\)\.$/)
  })
})

describe('repl.drift — the transient-base exception is unaffected', () => {
  it('the target\'s newest snapshot is a backup run\'s transient the source has: judged against IT, and the send goes from it', async () => {
    const world = behindWorld()
    world.listings.set(SRC, ok(snapJson(SRC, [{ name: 'Sbase', txg: 100 }, { name: 'S0', txg: 200 }, { name: 'anas-backup-t-1', txg: 250 }, { name: 'Sn', txg: 300 }])))
    world.listings.set(TGT, ok(snapJson(TGT, [{ name: 'Sbase', txg: 100 }, { name: 'S0', txg: 200 }, { name: 'anas-backup-t-1', txg: 250 }])))
    // `written@S0` would be non-zero (the transient carried changes); the
    // receive starts from the transient, so only `written@<transient>` counts.
    world.targetState = state('anas-backup-t-1', 0, 'on')
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(r.log.filter(l => l.startsWith(`${ZFS} get`)), [`${ZFS} get -Hp -o property,value,source written@anas-backup-t-1,readonly -- ${TGT}`])
    assert.deepEqual(pipes(r.log), [`PIPE send -i @anas-backup-t-1 -- ${SRC}@Sn | recv -o readonly=on -- ${TGT}`])
  })
})

describe('repl.drift — a writable target (exposed)', () => {
  it('sends (the receive seals it read-only again), completes, and raises ONE warning saying so; nothing is recorded (it is healed)', async () => {
    const world = behindWorld()
    world.targetState = state('S0', 0, 'off')
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(pipes(r.log), [`PIPE send -i @S0 -- ${SRC}@Sn | recv -o readonly=on -- ${TGT}`])
    const result = r.result as { warnings?: string[] }
    assert.deepEqual(result.warnings, ['Target \'backup/data\' was not read-only (readonly=off, local); this run\'s receive set it read-only again. A replication task keeps its target read-only: to use this copy as a live dataset, remove the replication task into it.'])
    assert.equal(r.notifications.length, 1)
    assert.equal((r.result as { targetDrift?: unknown }).targetDrift, undefined)
    assert.ok(!r.log.some(l => l.startsWith(`${ZFS} set`)), 'ANAS never sets the property itself')
  })

  // Review P3 (proposed; its own commit): an up-to-date exposed target is
  // set read-only by the run, said once and notified once at warning.
  it('an up-to-date exposed target: the run sets it read-only itself, says so once, notifies once at warning, records nothing', async () => {
    const world = upToDateWorld()
    world.targetState = ok(`written@Sn\t0\t-\nreadonly\toff\tlocal\n`)
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.deepEqual(r.log.filter(l => l.startsWith(`${ZFS} set`)), [`${ZFS} set -- readonly=on ${TGT}`])
    assert.deepEqual((r.result as { warnings?: string[] }).warnings, ['Target \'backup/data\' was not read-only (readonly=off, local); this run set it read-only on \'backup/data\' itself (\'zfs set readonly=on backup/data\'); datasets below it that inherit the property are read-only too. A replication task keeps its target read-only: to use this copy as a live dataset, remove the replication task into it.'])
    assert.equal(r.notifications.length, 1)
    assert.ok(r.notifications[0].includes(' warning replication tank/data -> backup/data completed with warnings '), 'exposed is informational: a warning')
    assert.equal((r.result as { targetDrift?: unknown }).targetDrift, undefined, 'set read-only: nothing to record')
    assert.deepEqual(pipes(r.log), [])
    // The order: the settle, the read, then the set.
    const verbs = r.log.filter(l => / (?:hold|get|set) /.test(l) && l.startsWith(ZFS))
    assert.deepEqual(verbs.map(l => l.split(' ')[1]), ['hold', 'hold', 'get', 'set'])
  })

  // Review 2: `zfs set` sets the property ON the target; a value it
  // inherited before is now its own, and what inherits from it follows.
  it('an up-to-date exposed target whose readonly was INHERITED: the sentence says it is now set on the target itself, and what was inherited before', async () => {
    const world = upToDateWorld()
    world.targetState = ok(`written@Sn\t0\t-\nreadonly\toff\tinherited from backup\n`)
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.deepEqual(r.log.filter(l => l.startsWith(`${ZFS} set`)), [`${ZFS} set -- readonly=on ${TGT}`])
    assert.deepEqual((r.result as { warnings?: string[] }).warnings, ['Target \'backup/data\' was not read-only (readonly=off, inherited from backup); this run set it read-only on \'backup/data\' itself (\'zfs set readonly=on backup/data\'), where the property was inherited from \'backup\' before; datasets below it that inherit the property are read-only too. A replication task keeps its target read-only: to use this copy as a live dataset, remove the replication task into it.'])
  })

  it('the next run reads it read-only (clean): silent', async () => {
    const world = upToDateWorld()
    world.targetState = ok(`written@Sn\t0\t-\nreadonly\ton\tlocal\n`)
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.deepEqual(r.notifications, [])
    assert.deepEqual(r.log.filter(l => l.startsWith(`${ZFS} set`)), [])
  })

  it('a set that fails says it failed and why, warns, and the target stays recorded', async () => {
    const world = upToDateWorld()
    world.targetState = ok(`written@Sn\t0\t-\nreadonly\toff\tlocal\n`)
    world.setAnswer = { stdout: '', stderr: 'cannot set property for \'backup/data\': permission denied\n', exitCode: 1 }
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.deepEqual((r.result as { warnings?: string[] }).warnings, ['Target \'backup/data\' is not read-only (readonly=off, local), and this run could not set it read-only: cannot set property for \'backup/data\': permission denied. Until it is read-only, a write there, or a read with access-time updates on, stops the next send; \'zfs set readonly=on backup/data\' on the target sets it now, and does not undo a change already made. A replication task keeps its target read-only: to use this copy as a live dataset, remove the replication task into it.'])
    assert.deepEqual((r.result as { targetDrift?: unknown }).targetDrift, [{ state: 'exposed', dataset: TGT, base: 'Sn' }])
    assert.equal(r.notifications.length, 1)
  })

  it('a remote target is set over the same ssh argv as its read', async () => {
    const world = upToDateWorld()
    world.holds.clear()
    hold(world, `${SRC}@Sn`, REMOTE_TAG)
    world.remote = new Map([
      [`zfs list -H -o name -- ${TGT}`, ok(`${TGT}\n`)],
      [`zfs list -H -t snapshot -o name,creation -s createtxg -- ${TGT}`, ok(`${TGT}@Sbase\tMon Jul 13 10:00 2026\n${TGT}@S0\tMon Jul 13 11:00 2026\n${TGT}@Sn\tMon Jul 13 12:00 2026\n`)],
      [`zfs get -Hp -o property,value,source written@Sn,readonly -- ${TGT}`, ok(`written@Sn\t0\t-\nreadonly\toff\tlocal\n`)],
      [`zfs set -- readonly=on ${TGT}`, ok('')],
      [`zfs hold -- ${REMOTE_TAG} ${TGT}@Sn`, ok('')],
    ])
    const r = await run(world, { target: { pool: 'backup', dataset: 'data', location: REMOTE } })
    assert.equal(r.error, undefined, r.error?.message)
    const sets = r.log.filter(l => l.startsWith('/usr/bin/ssh') && l.includes(' set '))
    assert.equal(sets.length, 1)
    assert.match(sets[0], / -- root@10\.0\.0\.9 zfs set -- readonly=on backup\/data$/)
    assert.match((r.result as { warnings?: string[] }).warnings?.at(-1) ?? '', /^Target 'backup\/data' on remote 'nas1' was not read-only \(readonly=off, local\); this run set it read-only/)
  })

  it('modified and unknown never trigger a set', async () => {
    for (const answer of [ok(`written@Sn\t12288\tlocal\nreadonly\toff\tlocal\n`), { stdout: '', stderr: 'cannot open \'backup/data\': dataset does not exist', exitCode: 1 }]) {
      const world = upToDateWorld()
      world.targetState = answer
      const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
      assert.deepEqual(r.log.filter(l => l.startsWith(`${ZFS} set`)), [])
    }
  })

  it('a target that is BEHIND and exposed is sealed by its receive, never by a separate set', async () => {
    const world = behindWorld()
    world.targetState = state('S0', 0, 'off')
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.deepEqual(r.log.filter(l => l.startsWith(`${ZFS} set`)), [])
  })
})

describe('repl.drift — a state that could not be read', () => {
  for (const [what, answer] of [
    ['a failed read', { stdout: '', stderr: 'cannot open \'backup/data\': permission denied', exitCode: 1 }],
    ['a garbage answer', ok('Welcome to nas1\n')],
  ] as const) {
    it(`${what}: the run goes ahead (ZFS decides) and the result says the target could not be checked`, async () => {
      const world = behindWorld()
      world.targetState = answer
      const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
      assert.equal(r.error, undefined, r.error?.message)
      assert.deepEqual(pipes(r.log), [`PIPE send -i @S0 -- ${SRC}@Sn | recv -o readonly=on -- ${TGT}`])
      assert.match((r.result as { note?: string }).note ?? '', /^Could not check whether target 'backup\/data' was changed since '@S0': .+; the send went ahead, and ZFS refuses it if the target was changed$/)
      assert.deepEqual(r.notifications, [], 'not a failure, not a warning')
    })
  }

  it('a read that THROWS (a timeout) is the same unknown: the run goes ahead and says so', async () => {
    const world = behindWorld()
    world.targetThrows = true
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(pipes(r.log), [`PIPE send -i @S0 -- ${SRC}@Sn | recv -o readonly=on -- ${TGT}`])
    assert.match((r.result as { note?: string }).note ?? '', /: zfs get: had not answered after 300 s; the send went ahead/)
  })
})

describe('repl.drift — the first receive makes the replica read-only', () => {
  it('an older ZFS that refuses -o on an incremental: the failure is ZFS\'s own line', async () => {
    const world = behindWorld()
    world.pipelineResult = { leftExitCode: 141, rightExitCode: 2, leftStderr: '', rightStderr: 'invalid option \'o\'\nusage:\n\treceive [-vnsFhu] <filesystem|volume|snapshot>\n', stdout: '' }
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.match(r.error?.message ?? '', /^Replication failed — recv: invalid option 'o' usage: {2}receive \[-vnsFhu\]/)
  })

  it('a full send (no target yet) receives with -o readonly=on, and no drift read is made (nothing to judge)', async () => {
    const world = behindWorld()
    world.listings.delete(TGT)
    const r = await run(world, { target: { pool: 'backup', dataset: 'data' } })
    assert.equal(r.error, undefined, r.error?.message)
    assert.deepEqual(pipes(r.log), [`PIPE send -- ${SRC}@Sn | recv -o readonly=on -- ${TGT}`])
    assert.deepEqual(r.log.filter(l => l.startsWith(`${ZFS} get`)), [])
  })

  // Ruling 1 (operator, 2026-11-15): EVERY receive re-asserts read-only —
  // captured on ZFS 2.4.2: `-o readonly=on` on an incremental exits 0 and
  // sets the property `local`.
  it('an incremental receive re-asserts read-only too (ruling 1)', async () => {
    const r = await run(behindWorld(), { target: { pool: 'backup', dataset: 'data' } })
    assert.deepEqual(pipes(r.log), [`PIPE send -i @S0 -- ${SRC}@Sn | recv -o readonly=on -- ${TGT}`])
  })
})
