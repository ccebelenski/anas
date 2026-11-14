import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { JobQueue } from '../../jobs/queue.js'
import type { RemotesPaths } from '../../services/replication-remotes.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { zfsListArgs } from '../../parsers/zfs-list.js'
import { zfsTreeGetArgs, zfsTreeSnapshotsArgs } from '../../parsers/zfs-tree.js'
import { createServer } from '../../server.js'
import { replicationHoldTag } from '../../services/replication-holds.js'
import { buildReplicationNotifyBody } from '../../services/replication-notify.js'
import { buildSshArgv, resolvedRemoteFields } from '../../services/replication-transport.js'
import { zfsTreeListArgs } from '../../services/zfs-snapshot.js'

/**
 * Story rrep.1b (#84), the recursive RUN, end to end on the captured
 * `fixtures/zfs/replication-tree/` before-state (rrep.0 ground truth): one
 * today's-shape send|recv per planned dataset in sweep order, holds settled
 * per dataset under the ROOT's one tag, a failure that stops the run, and a
 * fail-closed read at both doors. Everything is asserted on the recorded argv.
 */

const __dirname = import.meta.dirname
const fixturesDir = join(__dirname, '../../fixtures/zfs/replication-tree')
const ZFS = '/usr/sbin/zfs'
const ZPOOL = '/usr/sbin/zpool'
const SSH = '/usr/bin/ssh'
const PERL = '/usr/bin/perl'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

const SOURCE = 'rpool/rrsrc'
const TARGET_ROOT = 'datapool/rrdst'
const TARGET_POOL = 'datapool'
const S1 = 'anas-daily-2026-11-13_01.00.00--1d'
const S2 = 'anas-daily-2026-11-14_01.00.00--1d'
const EXCLUDE = ['rpool/rrsrc/skipme']
const GUID_RPOOL = '111'
const GUID_DATAPOOL = '222'
const TAG = replicationHoldTag(undefined, TARGET_ROOT)
const BYTES = 1000

/** The plan order the fixture before-state gives (five incrementals, one full). */
const PLANNED = ['rpool/rrsrc', 'rpool/rrsrc/a', 'rpool/rrsrc/a/deep', 'rpool/rrsrc/enc', 'rpool/rrsrc/new', 'rpool/rrsrc/vol']
/** The schema's R3 sentence for recursive + snapshot-first. */
const SNAPSHOT_FIRST = 'Recursive replication sends the snapshots a recursive snapshot schedule takes'

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/**
 * What `zfs list -r -- datapool` (the reader's target read: the POOL's tree)
 * answered in the captured before-state: the pool's own row, then the root's
 * tree. `dst-tree.txt` is the capture of the ROOT's listing and is never
 * edited; the pool held nothing but `rrdst` (see `after-dst-pool-tree.txt`,
 * the same command captured from the node after run 2), so the pool listing
 * is exactly the pool row plus those bytes.
 */
function targetPoolListing(): string {
  return `datapool\n${fixture('dst-tree.txt')}`
}

function zpoolListJson(names: string[]): string {
  const pools: Record<string, unknown> = {}
  for (const name of names)
    pools[name] = { name, state: 'ONLINE', properties: {} }
  return JSON.stringify({ pools })
}

function zfsListJson(names: string[]): string {
  const datasets: Record<string, unknown> = {}
  for (const name of names)
    datasets[name] = { name, type: 'FILESYSTEM', pool: name.split('/')[0], properties: {} }
  return JSON.stringify({ datasets })
}

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 }
}

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** Every PVE notification the run emitted, as the existing replication tests read them. */
function notifications(mock: MockExecutor): { severity: string, title: string, body: string }[] {
  return mock.calls
    .filter(c => c.command === PERL)
    .map(c => ({ severity: c.args[2], title: c.args[3], body: c.args[4] }))
}

/** The argv of every dangerous verb the run issued (never a read). */
function mutatingCalls(mock: MockExecutor): { command: string, args: string[] }[] {
  const out: { command: string, args: string[] }[] = []
  for (const call of mock.calls) {
    if (['send', 'recv', 'hold', 'release'].includes(call.args[0] ?? ''))
      out.push({ command: call.command, args: call.args })
  }
  for (const p of mock.pipelineCalls) {
    out.push({ command: p.cmd1, args: p.args1 })
    out.push({ command: p.cmd2, args: p.args2 })
  }
  return out
}

const REMOTE = { name: 'nas1', host: '10.0.0.9', port: 22, user: 'root' }

describe('recursive replication run (rrep.1b): the captured before-state', () => {
  let server: ReturnType<typeof createServer>
  let mock: MockExecutor
  let dir: string
  let paths: RemotesPaths
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  function sshFix(cmd: string[], result: { stdout: string, stderr: string, exitCode: number }) {
    const resolved = resolvedRemoteFields(paths, REMOTE.host, REMOTE.port, REMOTE.user)
    const argv = buildSshArgv(resolved, cmd)
    mock.addFixture({ command: argv[0], args: argv.slice(1), result })
  }

  function sshArgs(cmd: string[]): string[] {
    const resolved = resolvedRemoteFields(paths, REMOTE.host, REMOTE.port, REMOTE.user)
    return buildSshArgv(resolved, cmd).slice(1)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-recrrep-'))
    paths = {
      registryFile: join(dir, 'remotes.json'),
      keyPath: join(dir, 'replication_key'),
      knownHostsFile: join(dir, 'known_hosts'),
    }
    setEnv('ANAS_REMOTES_FILE', paths.registryFile)
    setEnv('ANAS_REPL_KEY', paths.keyPath)
    setEnv('ANAS_REPL_KNOWN_HOSTS', paths.knownHostsFile)
    setEnv('ANAS_PVE_MEMBERS', join(dir, 'members.json'))
    setEnv('ANAS_NODENAME', 'node1')
    // The fail-open posture for PVE's storage.cfg (nothing claimed), and an
    // empty unit store so the legacy-hold migration reads "no other task".
    setEnv('ANAS_STORAGE_CFG', join(dir, 'absent-storage.cfg'))
    setEnv('ANAS_SYSTEMD_DIR', join(dir, 'units'))
    await mkdir(join(dir, 'units'), { recursive: true })
    await writeFile(paths.registryFile, JSON.stringify({
      version: 1,
      updatedBy: 'node1',
      updatedAt: new Date().toISOString(),
      remotes: [REMOTE],
    }), 'utf-8')

    server = createServer({ mock: true, logger: false })
    mock = mockOf(server)
    mock.clearFixtures()
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else
        process.env[k] = v
    }
  })

  /** The captured before-state, read locally or through ssh for the target. */
  function arm(local = true): void {
    mock.addFixture({ command: PERL, result: ok('') })
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: ok(zpoolListJson(['rpool', TARGET_POOL])) })
    mock.addFixture({ command: ZFS, args: zfsListArgs('rpool'), result: ok(zfsListJson(['rpool', SOURCE])) })
    mock.addFixture({ command: ZFS, args: zfsTreeListArgs(SOURCE), result: ok(fixture('src-tree.txt')) })
    mock.addFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(SOURCE), result: ok(fixture('src-snaps-p.txt')) })
    mock.addFixture({ command: ZFS, args: zfsTreeGetArgs(SOURCE, ['keystatus']), result: ok(fixture('src-keystatus.txt')) })
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', 'rpool'], result: ok(`${GUID_RPOOL}\n`) })
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'value', 'guid', '--', TARGET_POOL], result: ok(`${GUID_DATAPOOL}\n`) })
    // The boot facts READ (so a storage claim is judged per-dataset, never by
    // the whole-pool unreadable-facts fallback); `/` is not a zfs mount here.
    mock.addFixture({ command: ZPOOL, args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: ok('rpool\t-\ndatapool\t-\n') })
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['-n', '-o', 'SOURCE,FSTYPE', '/'], result: { stdout: '', stderr: '', exitCode: 1 } })
    if (local) {
      mock.addFixture({ command: ZFS, args: zfsTreeListArgs(TARGET_POOL), result: ok(targetPoolListing()) })
      mock.addFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(TARGET_ROOT), result: ok(fixture('dst-snaps-p.txt')) })
      mock.addFixture({ command: ZFS, args: zfsTreeGetArgs(TARGET_ROOT, ['written']), result: ok(fixture('dst-written.txt')) })
    }
    else {
      sshFix(['zpool', 'list', '-H', '-o', 'name'], ok('datapool\n'))
      sshFix(['zfs', ...zfsTreeListArgs(TARGET_POOL)], ok(targetPoolListing()))
      sshFix(['zfs', ...zfsTreeSnapshotsArgs(TARGET_ROOT)], ok(fixture('dst-snaps-p.txt')))
      sshFix(['zfs', ...zfsTreeGetArgs(TARGET_ROOT, ['written'])], ok(fixture('dst-written.txt')))
      // The post-receive target read (fail-open; nothing held there yet).
      sshFix(['zfs', 'list', '-H', '-t', 'snapshot', '-o', 'name,creation', '--', TARGET_ROOT], ok(''))
    }
    // Per-dataset dry-run estimates.
    for (const dataset of PLANNED) {
      const incremental = dataset !== 'rpool/rrsrc/new'
      const args = incremental
        ? ['send', '-nvP', '-i', `@${S1}`, '--', `${dataset}@${S2}`]
        : ['send', '-nvP', '--', `${dataset}@${S2}`]
      mock.addFixture({ command: ZFS, args, result: ok(`size\t${BYTES}\n`) })
    }
    // hold / holds / release and any remaining read fall through to success.
    mock.addFixture({ command: ZFS, result: ok('') })
  }

  function url(withPlan = false): string {
    return `/v1/pools/rpool/datasets/rrsrc/replicate${withPlan ? '/plan' : ''}`
  }

  function payload(over: Record<string, unknown> = {}, target: Record<string, unknown> = { pool: TARGET_POOL, dataset: 'rrdst' }) {
    return JSON.stringify({ target, recursive: true, exclude: EXCLUDE, notify: 'always', ...over })
  }

  async function run(over: Record<string, unknown> = {}, target?: Record<string, unknown>) {
    const res = await server.inject({ method: 'POST', url: url(), headers: JSON_HEADERS, payload: payload(over, target) })
    if (res.statusCode !== 202)
      return { res, job: null as Job | null }
    return { res, job: await waitForJob(server, (res.json() as JobAccepted).job.id) }
  }

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it('LOCAL: exact ordered pipelines, one tag, late warned, targetonly untouched', async () => {
    arm(true)
    const { res, job } = await run()
    assert.equal(res.statusCode, 202)
    assert.equal(job?.status, 'completed', JSON.stringify(job?.error))

    assert.deepEqual(mock.pipelineCalls, [
      { cmd1: ZFS, args1: ['send', '-i', `@${S1}`, '--', `${SOURCE}@${S2}`], cmd2: ZFS, args2: ['recv', '--', TARGET_ROOT] },
      { cmd1: ZFS, args1: ['send', '-i', `@${S1}`, '--', `rpool/rrsrc/a@${S2}`], cmd2: ZFS, args2: ['recv', '--', 'datapool/rrdst/a'] },
      { cmd1: ZFS, args1: ['send', '-i', `@${S1}`, '--', `rpool/rrsrc/a/deep@${S2}`], cmd2: ZFS, args2: ['recv', '--', 'datapool/rrdst/a/deep'] },
      { cmd1: ZFS, args1: ['send', '-i', `@${S1}`, '--', `rpool/rrsrc/enc@${S2}`], cmd2: ZFS, args2: ['recv', '--', 'datapool/rrdst/enc'] },
      { cmd1: ZFS, args1: ['send', '--', `rpool/rrsrc/new@${S2}`], cmd2: ZFS, args2: ['recv', '-o', 'readonly=on', '--', 'datapool/rrdst/new'] },
      { cmd1: ZFS, args1: ['send', '-i', `@${S1}`, '--', `rpool/rrsrc/vol@${S2}`], cmd2: ZFS, args2: ['recv', '--', 'datapool/rrdst/vol'] },
    ])

    const result = job!.result as {
      recursive: true
      mode: string
      snapshot: string
      target: string
      holdTag: string
      datasets: { dataset: string, target: string, mode: string, baseSnapshot?: string, bytesEstimated: number }[]
      upToDate: string[]
      skipped: string[]
      targetOnly: string[]
      bytesEstimated: number
      warnings?: string[]
    }
    assert.equal(result.recursive, true)
    assert.equal(result.mode, 'full') // `new` was a full send
    assert.equal(result.snapshot, S2)
    assert.equal(result.target, TARGET_ROOT)
    assert.equal(result.holdTag, TAG)
    assert.deepEqual(result.datasets.map(d => d.dataset), PLANNED)
    assert.deepEqual(result.datasets.map(d => d.mode), ['incremental', 'incremental', 'incremental', 'incremental', 'full', 'incremental'])
    assert.deepEqual(result.upToDate, [])
    assert.deepEqual(result.skipped, ['rpool/rrsrc/late'])
    assert.deepEqual(result.targetOnly, ['datapool/rrdst/targetonly'])
    assert.equal(result.bytesEstimated, PLANNED.length * BYTES)

    // late is a warning (its planner sentence), never an error.
    assert.equal(result.warnings?.length, 1)
    assert.match(result.warnings![0], /^'rpool\/rrsrc\/late' has no '@anas-daily-2026-11-14_01\.00\.00--1d'/)

    // Every hold carried the ONE run tag — the ROOT's chain tag.
    const holds = mock.calls.filter(c => c.command === ZFS && c.args[0] === 'hold')
    assert.equal(holds.length, PLANNED.length * 2)
    assert.deepEqual([...new Set(holds.map(h => h.args[2]))], [TAG])
    holds.forEach(h => assert.equal(h.args[2], TAG))

    // targetonly is listed and appears in no command at all.
    for (const call of mutatingCalls(mock))
      assert.ok(!call.args.some(a => a.includes('targetonly')), `targetonly in ${JSON.stringify(call)}`)

    // R1: no destructive or chain-breaking flag on any mutating/send argv.
    for (const call of mutatingCalls(mock)) {
      for (const bad of ['destroy', 'rollback', '-F', '-R', '-w', '-p', '-I'])
        assert.ok(!call.args.includes(bad), `${bad} in ${JSON.stringify(call)}`)
    }
    // Every exclude names a live dataset: the note is absent, not empty.
    assert.ok(!('excludeMissing' in (job!.result as object)))
  })

  // rrep.2 fold E1 (ruled): a stored task's exclude whose dataset was destroyed
  // after the task was saved is INERT at the run, as for a snapshot schedule —
  // it used to refuse every fire. The body is the one a stored task's runner
  // sends (`--recursive --exclude <live> --exclude <gone>`).
  it('fold E1: one live and one gone exclude — the run completes, skips the live one, notes the gone one', async () => {
    arm(true)
    const { res, job } = await run({ exclude: ['rpool/rrsrc/skipme', 'rpool/rrsrc/gone'] })
    assert.equal(res.statusCode, 202, res.body)
    assert.equal(job?.status, 'completed', JSON.stringify(job?.error))
    const result = job!.result as { datasets: { dataset: string }[], excludeMissing?: string[], warnings?: string[] }
    assert.deepEqual(result.datasets.map(d => d.dataset), PLANNED)
    assert.ok(!mock.pipelineCalls.some(p => p.args1.some(a => a.startsWith('rpool/rrsrc/skipme'))), 'the live exclude is not sent')
    assert.deepEqual(result.excludeMissing, ['rpool/rrsrc/gone'])
    // A NOTE, never a warning: the only warning is late's planner sentence.
    assert.equal(result.warnings?.length, 1)
    assert.ok(!result.warnings!.some(w => w.includes('gone')))
  })

  it('REMOTE: every recv is `ssh ... zfs recv`, the send stays local', async () => {
    arm(false)
    const target = { pool: TARGET_POOL, dataset: 'rrdst', location: { kind: 'remote', name: 'nas1' } }
    const { res, job } = await run({}, target)
    assert.equal(res.statusCode, 202)
    assert.equal(job?.status, 'completed', JSON.stringify(job?.error))

    assert.equal(mock.pipelineCalls.length, PLANNED.length)
    const remoteTag = replicationHoldTag({ kind: 'remote', name: 'nas1' }, TARGET_ROOT)
    const expected = [
      ['recv', '--', TARGET_ROOT],
      ['recv', '--', 'datapool/rrdst/a'],
      ['recv', '--', 'datapool/rrdst/a/deep'],
      ['recv', '--', 'datapool/rrdst/enc'],
      ['recv', '-o', 'readonly=on', '--', 'datapool/rrdst/new'],
      ['recv', '--', 'datapool/rrdst/vol'],
    ]
    mock.pipelineCalls.forEach((call, i) => {
      assert.equal(call.cmd1, ZFS)
      assert.equal(call.cmd2, SSH)
      assert.deepEqual(call.args2, sshArgs(['zfs', ...expected[i]]))
    })
    const result = job!.result as { holdTag: string }
    assert.equal(result.holdTag, remoteTag)

    // The target-side holds went over ssh, under the run's one tag.
    const remoteHolds = mock.calls.filter(c => c.command === SSH && c.args.includes('hold'))
    assert.equal(remoteHolds.length, PLANNED.length)
    remoteHolds.forEach(h => assert.equal(h.args.at(-2), remoteTag))
  })

  // ---------------------------------------------------------------------------
  // R6: the first failure stops the run
  // ---------------------------------------------------------------------------

  it('the THIRD pipeline fails: three ran, the sentence names it and the two sent, holds for the first two only', async () => {
    arm(true)
    mock.addPipelineFixture({
      cmd1: ZFS,
      args1: ['send', '-i', `@${S1}`, '--', `rpool/rrsrc/a/deep@${S2}`],
      cmd2: ZFS,
      args2: ['recv', '--', 'datapool/rrdst/a/deep'],
      result: { leftExitCode: 0, rightExitCode: 1, leftStderr: '', rightStderr: 'cannot receive incremental stream: destination datapool/rrdst/a/deep has been modified since most recent snapshot', stdout: '' },
    })
    const { job } = await run()
    assert.equal(job?.status, 'failed')
    assert.match(job?.error?.message ?? '', /Replication failed at 'rpool\/rrsrc\/a\/deep' — recv: cannot receive incremental stream/)
    assert.match(job?.error?.message ?? '', /already sent this run: rpool\/rrsrc, rpool\/rrsrc\/a; the next run continues from each dataset's own base/)

    assert.equal(mock.pipelineCalls.length, 3)
    // Holds were settled for the first two datasets only (2 per dataset).
    const holds = mock.calls.filter(c => c.command === ZFS && c.args[0] === 'hold')
    assert.equal(holds.length, 4)
    // Exactly the first two datasets, source then target each — nothing for a/deep.
    assert.deepEqual(holds.map(h => h.args[3]), [
      `${SOURCE}@${S2}`,
      `${TARGET_ROOT}@${S2}`,
      `rpool/rrsrc/a@${S2}`,
      `datapool/rrdst/a@${S2}`,
    ])
    // The failure reached the notification verbatim.
    const sent = notifications(mock)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].severity, 'error')
    assert.ok(sent[0].body.includes('Replication failed at \'rpool/rrsrc/a/deep\''))
  })

  it('the THIRD pipeline THROWS (a spawn error): R6\'s sentence names it and the two sent (fold 4, review B8)', async () => {
    // The executor contract: REJECT on a spawn failure (ENOENT/EACCES/EAGAIN),
    // RESOLVE on a non-zero exit. The loop read only the exits, so a throw
    // escaped as a bare `spawn EAGAIN` naming no dataset and no progress.
    arm(true)
    const orig = mock.pipeline.bind(mock)
    let sends = 0
    mock.pipeline = async (...a: Parameters<typeof orig>) => {
      sends++
      if (sends === 3) {
        mock.pipelineCalls.push({ cmd1: a[0], args1: a[1], cmd2: a[2], args2: a[3] })
        throw new Error('spawn EAGAIN')
      }
      return orig(...a)
    }
    const { job } = await run()
    assert.equal(job?.status, 'failed')
    assert.equal(job?.error?.message, `Replication failed at 'rpool/rrsrc/a/deep' — spawn EAGAIN; already sent this run: rpool/rrsrc, rpool/rrsrc/a; the next run continues from each dataset's own base`)
    assert.equal(mock.pipelineCalls.length, 3)
    assert.equal(mock.calls.filter(c => c.command === ZFS && c.args[0] === 'hold').length, 4)
    const sent = notifications(mock)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].severity, 'error')
    assert.ok(sent[0].body.includes('Replication failed at \'rpool/rrsrc/a/deep\' — spawn EAGAIN'))
  })

  it('with EVERY copy up to date the result carries NO mode and the body no Mode line (fold 5, review J)', async () => {
    // 'incremental' over zero sends would claim a send shape that never
    // happened — the mode is omitted, so the notification prints no Mode line.
    arm(true)
    const tree = `${targetPoolListing().trimEnd()}\ndatapool/rrdst/new\n`
    const snaps = `${fixture('dst-snaps-p.txt').replaceAll(S1, S2)}datapool/rrdst/new@${S2}\t1794618284\t77\n`
    const written = `${fixture('dst-written.txt').trimEnd()}\ndatapool/rrdst/new\twritten\t0\ndatapool/rrdst/new\treadonly\ton\n`
    mock.prependFixture({ command: ZFS, args: zfsTreeListArgs(TARGET_POOL), result: ok(tree) })
    mock.prependFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(TARGET_ROOT), result: ok(snaps) })
    mock.prependFixture({ command: ZFS, args: zfsTreeGetArgs(TARGET_ROOT, ['written']), result: ok(written) })
    const { job } = await run()
    assert.equal(job?.status, 'completed', JSON.stringify(job?.error))
    const result = job!.result as Record<string, unknown>
    assert.equal('mode' in result, false)
    assert.equal((result.datasets as unknown[]).length, 0)
    assert.equal((result.upToDate as string[]).length, PLANNED.length)
    assert.equal(mock.pipelineCalls.length, 0)
    const sent = notifications(mock)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].body.includes('Datasets:    0 sent, 6 up to date'))
    assert.ok(!sent[0].body.includes('Mode:'), sent[0].body)
  })

  // Verification of the fold: a throw from the per-dataset ESTIMATE escaped as
  // a bare "spawn EAGAIN" (no dataset, no progress). RULE: the estimate is
  // best-effort for a throw as for a non-zero exit; only the send can fail a run.
  it('an estimate that THROWS is an estimate of 0: the dataset is still sent and the run completes', async () => {
    arm(true)
    // Exact args: the mock resolves an exact-args fixture before any matcher.
    mock.prependFixture({ command: ZFS, args: ['send', '-nvP', '-i', `@${S1}`, '--', `rpool/rrsrc/a/deep@${S2}`], throws: new Error('spawn EAGAIN') })
    const { job } = await run()
    assert.equal(job?.status, 'completed', JSON.stringify(job?.error))
    assert.equal(mock.pipelineCalls.length, PLANNED.length)
    const datasets = (job!.result as { datasets: { dataset: string, bytesEstimated: number }[] }).datasets
    assert.equal(datasets.find(d => d.dataset === 'rpool/rrsrc/a/deep')?.bytesEstimated, 0)
  })

  // Verification of the fold: the same settle that is a warning after a
  // receive failed the whole job when it threw for an UP-TO-DATE copy, before
  // any send, on every retry. RULE: a hold that cannot be settled never stops
  // the datasets behind it.
  it('a settle that THROWS for an up-to-date copy is a warning, and the run goes on', async () => {
    arm(true)
    const tree = `${targetPoolListing().trimEnd()}\ndatapool/rrdst/new\n`
    const snaps = `${fixture('dst-snaps-p.txt').replaceAll(S1, S2)}datapool/rrdst/new@${S2}\t1794618284\t77\n`
    const written = `${fixture('dst-written.txt').trimEnd()}\ndatapool/rrdst/new\twritten\t0\ndatapool/rrdst/new\treadonly\ton\n`
    mock.prependFixture({ command: ZFS, args: zfsTreeListArgs(TARGET_POOL), result: ok(tree) })
    mock.prependFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(TARGET_ROOT), result: ok(snaps) })
    mock.prependFixture({ command: ZFS, args: zfsTreeGetArgs(TARGET_ROOT, ['written']), result: ok(written) })
    mock.prependFixture({ command: ZFS, argsMatch: a => a[0] === 'hold', throws: new Error('spawn EAGAIN') })
    const { job } = await run()
    assert.equal(job?.status, 'completed', JSON.stringify(job?.error))
    const warnings = (job!.result as { warnings?: string[] }).warnings ?? []
    assert.deepEqual(
      warnings.filter(w => w.includes('holds could not be settled')),
      PLANNED.map(d => `${d}: holds could not be settled — spawn EAGAIN`),
    )
  })

  it('holds that THROW after a good receive are a warning per dataset, not a failed send (fold 4, review B8)', async () => {
    // settleReplicationHolds runs unguarded exec (a spawn failure rejects).
    // The stream already landed — that must never read as a send failure:
    // warn, keep the run going, and let the next run re-settle.
    arm(true)
    mock.addFixture({ command: ZFS, argsMatch: a => a[0] === 'hold', throws: new Error('spawn EAGAIN') })
    const { job } = await run()
    assert.equal(job?.status, 'completed', JSON.stringify(job?.error))
    const warnings = (job!.result as { warnings?: string[] }).warnings ?? []
    assert.deepEqual(
      warnings.filter(w => w.includes('holds could not be settled')),
      PLANNED.map(d => `${d}: holds could not be settled — spawn EAGAIN`),
    )
    assert.equal(mock.pipelineCalls.length, PLANNED.length)
  })

  // ---------------------------------------------------------------------------
  // Fail-closed reads, at BOTH doors
  // ---------------------------------------------------------------------------

  const READS: { args: string[], okContent: string, sentence: string }[] = [
    { args: zfsTreeListArgs(SOURCE), okContent: fixture('src-tree.txt'), sentence: `Could not list descendants of '${SOURCE}' — refusing the recursive replication` },
    { args: zfsTreeSnapshotsArgs(SOURCE), okContent: fixture('src-snaps-p.txt'), sentence: `Could not list the snapshots under '${SOURCE}' — refusing the recursive replication` },
    { args: zfsTreeGetArgs(SOURCE, ['keystatus']), okContent: fixture('src-keystatus.txt'), sentence: `Could not read the encryption state under '${SOURCE}' — refusing the recursive replication` },
    { args: zfsTreeListArgs(TARGET_POOL), okContent: targetPoolListing(), sentence: `Could not list the datasets of pool '${TARGET_POOL}' on the target — refusing the recursive replication` },
    { args: zfsTreeSnapshotsArgs(TARGET_ROOT), okContent: fixture('dst-snaps-p.txt'), sentence: `Could not list the snapshots under '${TARGET_ROOT}' on the target — refusing the recursive replication` },
    { args: zfsTreeGetArgs(TARGET_ROOT, ['written']), okContent: fixture('dst-written.txt'), sentence: `Could not read the modification state under '${TARGET_ROOT}' on the target — refusing the recursive replication` },
  ]

  for (const read of READS) {
    it(`a failed read at the route is a 400 — ${read.sentence.slice(0, 30)} — and zero pipelines`, async () => {
      arm(true)
      mock.prependFixture({ command: ZFS, args: read.args, result: { stdout: '', stderr: 'boom', exitCode: 1 } })
      const { res } = await run()
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.message, read.sentence)
      assert.equal(mock.pipelineCalls.length, 0)
    })

    it(`the same read failing IN THE JOB fails STATE_CHANGED — ${read.sentence.slice(0, 22)} — and zero pipelines`, async () => {
      arm(true)
      mock.prependFixture({
        command: ZFS,
        args: read.args,
        results: [ok(read.okContent), { stdout: '', stderr: 'boom', exitCode: 1 }],
      })
      const { job } = await run()
      assert.equal(job?.status, 'failed', JSON.stringify(job))
      assert.equal(job?.error?.code, 'STATE_CHANGED')
      assert.equal(job?.error?.message, read.sentence)
      assert.equal(mock.pipelineCalls.length, 0)
      assert.ok(!mock.calls.some(c => c.command === ZFS && c.args[0] === 'send'), 'a zfs send ran anyway')
    })
  }

  it('ssh exit 255 on the target pool listing refuses, and does NOT say the target is absent', async () => {
    arm(false)
    const argv = buildSshArgv(resolvedRemoteFields(paths, REMOTE.host, REMOTE.port, REMOTE.user), ['zfs', ...zfsTreeListArgs(TARGET_POOL)])
    mock.prependFixture({ command: argv[0], args: argv.slice(1), result: { stdout: '', stderr: 'ssh: connect to host 10.0.0.9 port 22: Connection timed out', exitCode: 255 } })
    const target = { pool: TARGET_POOL, dataset: 'rrdst', location: { kind: 'remote', name: 'nas1' } }
    const { res } = await run({}, target)
    assert.equal(res.statusCode, 400)
    const message = res.json().error.message as string
    assert.equal(message, `Could not list the datasets of pool '${TARGET_POOL}' on the target — refusing the recursive replication`)
    assert.ok(!/does not exist|absent|not exist/i.test(message), 'a failed read must not read as absent')
    assert.equal(mock.pipelineCalls.length, 0)
  })

  it('a target pool listing that exits 0 but does not start with the pool is a 400, not six full sends (fold 1, review B1/B2)', async () => {
    for (const bad of ['', 'otherpool\notherpool/x\n']) {
      mock.clearFixtures()
      arm(true)
      mock.prependFixture({ command: ZFS, args: zfsTreeListArgs(TARGET_POOL), result: ok(bad) })
      const { res } = await run()
      assert.equal(res.statusCode, 400, `stdout ${JSON.stringify(bad)}: ${JSON.stringify(res.json())}`)
      assert.equal(res.json().error.message, `Could not list the datasets of pool '${TARGET_POOL}' on the target — refusing the recursive replication`)
      assert.equal(mock.pipelineCalls.length, 0)
    }
  })

  it('an unloaded key refuses 400 and sends nothing', async () => {
    arm(true)
    mock.prependFixture({ command: ZFS, args: zfsTreeGetArgs(SOURCE, ['keystatus']), result: ok(fixture('src-keystatus-unloaded.txt')) })
    const { res } = await run()
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, `'rpool/rrsrc/enc' is encrypted and its key is not loaded — load it or exclude the dataset`)
    assert.equal(mock.pipelineCalls.length, 0)
  })

  // rrep.2 fold N1 (ruled): a recursive run refused AT THE ROUTE notifies like
  // a failed run — a nightly task's runner meets these refusals before any job
  // exists, and they used to send nothing whatever the notify mode. The HTTP
  // answer is unchanged.
  for (const mode of ['on-failure', 'always'] as const) {
    it(`fold N1: a gate refusal at the route sends ONE error notification (notify: ${mode}), the answer unchanged`, async () => {
      arm(true)
      mock.prependFixture({ command: ZFS, args: zfsTreeGetArgs(SOURCE, ['keystatus']), result: ok(fixture('src-keystatus-unloaded.txt')) })
      const { res } = await run({ notify: mode })
      assert.equal(res.statusCode, 400)
      const message = `'rpool/rrsrc/enc' is encrypted and its key is not loaded — load it or exclude the dataset`
      assert.equal(res.json().error.message, message)
      const sent = notifications(mock)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].severity, 'error')
      assert.match(sent[0].title, /^replication rpool\/rrsrc -> datapool\/rrdst FAILED$/)
      assert.match(sent[0].body, /^Source: {6}rpool\/rrsrc$/m)
      assert.match(sent[0].body, /^Target: {6}datapool\/rrdst$/m)
      assert.ok(sent[0].body.includes(message))
    })
  }

  it('fold N1: a read refusal and a named-snapshot refusal at the route notify too', async () => {
    arm(true)
    mock.prependFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(SOURCE), result: { stdout: '', stderr: 'I/O error', exitCode: 1 } })
    const read = await run({ notify: 'on-failure' })
    assert.equal(read.res.statusCode, 400)
    assert.equal(read.res.json().error.message, `Could not list the snapshots under '${SOURCE}' — refusing the recursive replication`)
    assert.equal(notifications(mock).length, 1)

    const named = await run({ snapshot: S2, notify: 'always' })
    assert.equal(named.res.statusCode, 400)
    assert.match(named.res.json().error.message, /cannot be combined with a named snapshot/)
    assert.equal(notifications(mock).length, 2)
    assert.ok(notifications(mock)[1].body.includes('cannot be combined with a named snapshot'))
  })

  // Review of the rrep.2 fold: the two refusals BEFORE the placement is known
  // sent nothing. RULE: every way a recursive run is refused at the route
  // notifies — a destroyed source and an exported target pool most of all.
  it('fold N1: a missing source and a refused root target guard notify too', async () => {
    arm(true)
    mock.prependFixture({ command: ZPOOL, args: ['list', '-j'], result: ok(zpoolListJson(['rpool'])) })
    const noPool = await run({ notify: 'on-failure' })
    assert.equal(noPool.res.statusCode, 400)
    assert.match(noPool.res.json().error.message, /Target pool 'datapool' does not exist/)
    assert.equal(notifications(mock).length, 1)
    assert.equal(notifications(mock)[0].severity, 'error')
    assert.ok(notifications(mock)[0].body.includes('datapool/rrdst'), notifications(mock)[0].body)
    assert.equal(mock.pipelineCalls.length, 0)
  })

  it('fold N1: an ownership refusal (409) notifies with the same sentence it answers', async () => {
    const cfg = join(dir, 'storage.cfg')
    await writeFile(cfg, 'zfspool: local-zfs\n\tpool rpool/rrsrc/a\n\tcontent images,rootdir\n\n', 'utf8')
    setEnv('ANAS_STORAGE_CFG', cfg)
    arm(true)
    const { res } = await run({ notify: 'on-failure' })
    assert.equal(res.statusCode, 409)
    const sent = notifications(mock)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].body.includes(res.json().error.message))
  })

  // ---------------------------------------------------------------------------
  // PVE territory
  // ---------------------------------------------------------------------------

  it('a PVE-owned child in the sweep refuses 409 PVE_MANAGED; the same child EXCLUDED runs', async () => {
    const cfg = join(dir, 'storage.cfg')
    await writeFile(cfg, 'zfspool: local-zfs\n\tpool rpool/rrsrc/a\n\tcontent images,rootdir\n\n', 'utf8')
    process.env.ANAS_STORAGE_CFG = cfg
    arm(true)

    const refused = await run()
    assert.equal(refused.res.statusCode, 409)
    assert.equal(refused.res.json().error.code, 'PVE_MANAGED')
    assert.match(refused.res.json().error.message, /^Recursive replication of 'rpool\/rrsrc' would include rpool\/rrsrc\/a —/)
    assert.match(refused.res.json().error.message, /exclude it, or replicate a dataset below it/)
    assert.equal(mock.pipelineCalls.length, 0)

    const allowed = await run({ exclude: [...EXCLUDE, 'rpool/rrsrc/a'] })
    assert.equal(allowed.res.statusCode, 202)
    assert.equal(allowed.job?.status, 'completed', JSON.stringify(allowed.job?.error))
    assert.ok(!mock.pipelineCalls.some(p => p.args1.some(a => a.startsWith('rpool/rrsrc/a@'))))
  })

  it('an UP-TO-DATE child whose TARGET PVE owns is a 400, with no hold and no send (fold 2, review I2)', async () => {
    // `a`'s copy already carries S, so the planner puts it in upToDate and
    // the job places holds on its TARGET snapshot. Gate d must guard that
    // target name too — the run never reaches a hold on a PVE-owned snapshot.
    const cfg = join(dir, 'storage.cfg')
    await writeFile(cfg, 'zfspool: local-zfs\n\tpool datapool/rrdst/a\n\tcontent images,rootdir\n\n', 'utf8')
    process.env.ANAS_STORAGE_CFG = cfg
    arm(true)
    mock.prependFixture({
      command: ZFS,
      args: zfsTreeSnapshotsArgs(TARGET_ROOT),
      result: ok(`${fixture('dst-snaps-p.txt')}datapool/rrdst/a@${S2}\t1794618284\t77\n`),
    })
    const { res } = await run()
    assert.equal(res.statusCode, 400, JSON.stringify(res.json()))
    assert.equal(res.json().error.message, `Replication target 'datapool/rrdst/a' is PVE-owned — PVE storage 'local-zfs' owns datapool/rrdst/a as a storage root`)
    assert.equal(mock.pipelineCalls.length, 0)
    assert.deepEqual(mutatingCalls(mock), [])
  })

  it('an S named `nightly 2` is a 400 at the door: no pipeline, no hold (fold 3, review H)', async () => {
    // The probe-h scenario: the name survives the listing reads (it is a legal
    // ZFS name) and would reach `zfs hold`/`send @<name>`, where the remote
    // shell splits it. The shared SnapshotName schema is the door.
    arm(true)
    mock.prependFixture({
      command: ZFS,
      args: zfsTreeSnapshotsArgs(SOURCE),
      result: ok(fixture('src-snaps-p.txt').replaceAll(S2, 'nightly 2')),
    })
    const { res } = await run()
    assert.equal(res.statusCode, 400, JSON.stringify(res.json()))
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.equal(res.json().error.message, `Snapshot 'nightly 2' has a name ANAS does not pass to a remote command (a space or another character outside letters, digits and _ - . :) — rename it with 'zfs rename', or take a new recursive snapshot of '${SOURCE}'`)
    assert.equal(mock.pipelineCalls.length, 0)
    assert.deepEqual(mutatingCalls(mock), [])
  })

  // ---------------------------------------------------------------------------
  // Schema-level refusals
  // ---------------------------------------------------------------------------

  it('recursive with a NAMED snapshot is a 400', async () => {
    arm(true)
    const { res } = await run({ snapshot: S2 })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /cannot be combined with a named snapshot/)
    assert.equal(mock.pipelineCalls.length, 0)
  })

  it('recursive with snapshot-first is the schema\'s 400', async () => {
    arm(true)
    const { res } = await run({ snapshotFirst: true })
    assert.equal(res.statusCode, 400)
    assert.ok(res.json().error.message.includes(SNAPSHOT_FIRST))
  })

  // ---------------------------------------------------------------------------
  // R9 locks
  // ---------------------------------------------------------------------------

  it('locks: shared on every swept dataset, exclusive on the local target root', async () => {
    arm(true)
    // Park the job on the first dry-run so the lock table can be read.
    mock.prependFixture({
      command: ZFS,
      args: ['send', '-nvP', '-i', `@${S1}`, '--', `${SOURCE}@${S2}`],
      live: { signalsToExit: Number.POSITIVE_INFINITY },
      result: ok(`size\t${BYTES}\n`),
    })
    const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
    const res = await server.inject({ method: 'POST', url: url(), headers: JSON_HEADERS, payload: payload() })
    assert.equal(res.statusCode, 202)
    const id = (res.json() as JobAccepted).job.id
    for (let i = 0; i < 100 && queue.get(id)?.status !== 'running'; i++)
      await new Promise(r => setTimeout(r, 10))
    assert.equal(queue.get(id)?.status, 'running', 'the run job never started')

    const held = queue.heldLocks().filter(h => h.holders.includes(id))
    const SWEEP = ['rpool/rrsrc', 'rpool/rrsrc/a', 'rpool/rrsrc/a/deep', 'rpool/rrsrc/enc', 'rpool/rrsrc/late', 'rpool/rrsrc/new', 'rpool/rrsrc/vol']
    for (const dataset of SWEEP) {
      const key = `zfs:${GUID_RPOOL}/${dataset.slice('rpool/'.length)}`
      assert.ok(held.some(h => h.key === key && h.mode === 'shared'), `missing shared claim ${key} in ${JSON.stringify(held)}`)
    }
    assert.ok(held.some(h => h.key === `zfs:${GUID_DATAPOOL}/rrdst` && h.mode === 'exclusive'), `missing exclusive target claim in ${JSON.stringify(held)}`)

    for (let i = 0; i < 100 && !mock.calls.some(c => c.command === ZFS && c.args[1] === '-nvP'); i++)
      await new Promise(r => setTimeout(r, 10))
    mock.finishLive(ok(`size\t${BYTES}\n`))
    const done = await waitForJob(server, id)
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
  })

  // ---------------------------------------------------------------------------
  // R0 — the non-recursive path is untouched
  // ---------------------------------------------------------------------------

  it('R0: the non-recursive call list is IDENTICAL with `recursive` absent and with `recursive: false`', async () => {
    /** The existing single-dataset happy path (testpool/share1 → testpool2), armed. */
    async function runSingle(recursiveField: boolean | undefined) {
      const srv = createServer({ mock: true, logger: false })
      try {
        const m = mockOf(srv)
        m.clearFixtures()
        m.addFixture({ command: PERL, result: ok('') })
        m.addFixture({ command: ZPOOL, args: ['list', '-j'], result: ok(zpoolListJson(['testpool', 'testpool2'])) })
        m.addFixture({ command: ZFS, args: zfsListArgs('testpool'), result: ok(zfsListJson(['testpool', 'testpool/share1'])) })
        m.addFixture({ command: ZFS, args: zfsListArgs('testpool2'), result: ok(zfsListJson(['testpool2'])) })
        m.addFixture({ command: ZFS, args: ['list', '-j', '-o', 'name,creation,used,referenced', '-t', 'snapshot', '--', 'testpool/share1'], result: ok(JSON.stringify({ datasets: { 'testpool/share1@repl-base': { name: 'testpool/share1@repl-base', type: 'SNAPSHOT', pool: 'testpool', dataset: 'testpool/share1', snapshot_name: 'repl-base', createtxg: '100', properties: {} } } })) })
        m.addFixture({ command: ZFS, args: ['send', '-nvP', '--', 'testpool/share1@repl-base'], result: ok('full\ttestpool/share1@repl-base\t13424\nsize\t13424\n') })
        m.addFixture({ command: ZFS, result: ok('') })

        const body: Record<string, unknown> = { target: { pool: 'testpool2' } }
        if (recursiveField !== undefined)
          body.recursive = recursiveField
        const res = await srv.inject({ method: 'POST', url: '/v1/pools/testpool/datasets/share1/replicate', headers: JSON_HEADERS, payload: JSON.stringify(body) })
        assert.equal(res.statusCode, 202)
        const done = await waitForJob(srv, (res.json() as JobAccepted).job.id)
        assert.equal(done.status, 'completed', JSON.stringify(done.error))
        return {
          calls: m.calls.map(c => ({ command: c.command, args: c.args })),
          pipelines: m.pipelineCalls.map(p => ({ cmd1: p.cmd1, args1: p.args1, cmd2: p.cmd2, args2: p.args2 })),
        }
      }
      finally {
        await srv.close()
      }
    }

    const absent = await runSingle(undefined)
    const explicitFalse = await runSingle(false)
    assert.deepEqual(explicitFalse, absent)
    // And the shape is the single-dataset run's: one pipeline, readonly recv.
    assert.equal(absent.pipelines.length, 1)
    assert.deepEqual(absent.pipelines[0].args2, ['recv', '-o', 'readonly=on', '--', 'testpool2/share1'])
  })
})

describe('the recursive notification body (rrep.1b)', () => {
  it('a NON-recursive body is byte-identical to today\'s (pinned)', () => {
    const body = buildReplicationNotifyBody({
      source: 'testpool/media',
      target: 'backuppool/media',
      notify: 'always',
      result: { mode: 'incremental', snapshot: 'anas-daily-b', baseSnapshot: 'anas-daily-a' },
      elapsedMs: 95_000,
    })
    assert.equal(body, [
      'Source:      testpool/media',
      'Target:      backuppool/media',
      'Result:      success',
      'Duration:    1m 35s (job elapsed)',
      'Snapshot:    testpool/media@anas-daily-b',
      'Mode:        incremental (from @anas-daily-a)',
    ].join('\n'))
  })

  it('a recursive body lists each dataset sent and the count up to date', () => {
    const body = buildReplicationNotifyBody({
      source: 'rpool/rrsrc',
      target: 'datapool/rrdst',
      notify: 'always',
      result: {
        recursive: true,
        mode: 'full',
        snapshot: 'anas-daily-b',
        datasets: [
          { dataset: 'rpool/rrsrc', target: 'datapool/rrdst', mode: 'incremental' },
          { dataset: 'rpool/rrsrc/new', target: 'datapool/rrdst/new', mode: 'full' },
        ],
        upToDate: ['rpool/rrsrc/a'],
      },
    })
    assert.ok(body.includes('Datasets:    2 sent, 1 up to date'))
    assert.ok(body.includes('  rpool/rrsrc -> datapool/rrdst (incremental)'))
    assert.ok(body.includes('  rpool/rrsrc/new -> datapool/rrdst/new (full)'))
  })

  it('a recursive result with NOTHING sent prints no Mode line (fold 5, review J)', () => {
    const body = buildReplicationNotifyBody({
      source: 'rpool/rrsrc',
      target: 'datapool/rrdst',
      notify: 'always',
      result: { recursive: true, snapshot: 'anas-daily-b', datasets: [], upToDate: ['rpool/rrsrc/a'] },
    })
    assert.ok(!body.includes('Mode:'), body)
    assert.ok(body.includes('Datasets:    0 sent, 1 up to date'))
    assert.ok(body.includes('Snapshot:    rpool/rrsrc@anas-daily-b'))
  })
})
