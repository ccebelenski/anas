import type { ExecResult } from '../../executor/types.js'
import type { RemotesPaths } from '../replication-remotes.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { parseTreeList, parseTreeProps, parseTreeSnapshots, zfsTreeGetArgs, zfsTreeSnapshotsArgs } from '../../parsers/zfs-tree.js'
import { buildSshArgv, createTransport, resolvedRemoteFields } from '../replication-transport.js'
import { readTreeFacts } from '../replication-tree-read.js'
import { isAtOrUnder, zfsTreeListArgs } from '../zfs-snapshot.js'

/**
 * Story rrep.1b (#84), the fact reader: every read of the captured
 * recursive-replication fixtures (`fixtures/zfs/replication-tree/`, rrep.0
 * ground truth) is one command, judged by exit code, and a failed read refuses
 * the run instead of being read as "absent"/"empty" (R5's fail-closed rule).
 * The exact argv and ORDER are pinned; so is the "no later read after a
 * failure" property.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/zfs/replication-tree')
const ZFS = '/usr/sbin/zfs'
const SSH = '/usr/bin/ssh'

const SOURCE = 'rpool/rrsrc'
const TARGET = 'datapool/rrdst'
const TARGET_POOL = 'datapool'
const EXCLUDE = ['rpool/rrsrc/skipme']

const PATHS: RemotesPaths = {
  registryFile: '/nonexistent/remotes.json',
  keyPath: '/nonexistent/replication_key',
  knownHostsFile: '/nonexistent/known_hosts',
}
const REMOTE = resolvedRemoteFields(PATHS, '10.0.0.9', 22, 'root')

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

/**
 * Register the six reads of the captured run. A `local` target is a second
 * local `zfs`; a remote one goes over ssh (the same argv buildSshArgv emits).
 */
function armed(local = true): MockExecutor {
  const mock = new MockExecutor()
  const targetFix = (args: string[], result: ExecResult) => {
    if (local) {
      mock.addFixture({ command: ZFS, args, result })
    }
    else {
      const argv = buildSshArgv(REMOTE, ['zfs', ...args])
      mock.addFixture({ command: argv[0], args: argv.slice(1), result })
    }
  }
  mock.addFixture({ command: ZFS, args: zfsTreeListArgs(SOURCE), result: ok(fixture('src-tree.txt')) })
  mock.addFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(SOURCE), result: ok(fixture('src-snaps-p.txt')) })
  mock.addFixture({ command: ZFS, args: zfsTreeGetArgs(SOURCE, ['keystatus']), result: ok(fixture('src-keystatus.txt')) })
  // The POOL's listing: its own row, then the captured root listing (the
  // capture `dst-tree.txt` is the root's and is never edited; the pool held
  // only `rrdst`, see `after-dst-pool-tree.txt`).
  targetFix(zfsTreeListArgs(TARGET_POOL), ok(`datapool\n${fixture('dst-tree.txt')}`))
  targetFix(zfsTreeSnapshotsArgs(TARGET), ok(fixture('dst-snaps-p.txt')))
  targetFix(zfsTreeGetArgs(TARGET, ['written']), ok(fixture('dst-written.txt')))
  return mock
}

function transportOf(mock: MockExecutor) {
  return createTransport(mock, { paths: PATHS, membersFile: '/nonexistent/.members' })
}

function input(local = true) {
  return {
    sourceRoot: SOURCE,
    targetRoot: TARGET,
    exclude: EXCLUDE,
    placement: local ? ({ isRemote: false } as const) : ({ isRemote: true, resolved: REMOTE } as const),
  }
}

/** The executor calls that are zfs reads, in order (ssh target reads included). */
function readCalls(mock: MockExecutor) {
  return mock.calls.filter(c => c.command === ZFS || c.command === SSH)
}

describe('readTreeFacts: the captured run, local target', () => {
  it('issues the six reads as exact argv, in order, and yields the planner fixture facts', async () => {
    const mock = armed(true)
    const result = await readTreeFacts({ executor: mock, transport: transportOf(mock) }, input(true))
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok)
      return

    assert.deepEqual(readCalls(mock).map(c => ({ command: c.command, args: c.args })), [
      { command: ZFS, args: zfsTreeListArgs(SOURCE) },
      { command: ZFS, args: zfsTreeSnapshotsArgs(SOURCE) },
      { command: ZFS, args: zfsTreeGetArgs(SOURCE, ['keystatus']) },
      { command: ZFS, args: zfsTreeListArgs(TARGET_POOL) },
      { command: ZFS, args: zfsTreeSnapshotsArgs(TARGET) },
      { command: ZFS, args: zfsTreeGetArgs(TARGET, ['written']) },
    ])

    // The fixtures parse back into exactly the fact set the planner's own
    // fixture test builds (services/__tests__/replication-tree.test.ts).
    assert.deepEqual(result.facts, {
      sourceRoot: SOURCE,
      targetRoot: TARGET,
      exclude: EXCLUDE,
      localTarget: true,
      sourceTree: parseTreeList(fixture('src-tree.txt')),
      sourceSnaps: parseTreeSnapshots(fixture('src-snaps-p.txt')),
      sourceProps: parseTreeProps(fixture('src-keystatus.txt')),
      targetTree: parseTreeList(fixture('dst-tree.txt')).filter(name => isAtOrUnder(name, TARGET)),
      targetSnaps: parseTreeSnapshots(fixture('dst-snaps-p.txt')),
      targetProps: parseTreeProps(fixture('dst-written.txt')),
    })
  })

  it('a target pool listing without the root gives targetTree [] and exactly four commands', async () => {
    const mock = armed(true)
    mock.prependFixture({ command: ZFS, args: zfsTreeListArgs(TARGET_POOL), result: ok('datapool\n') })
    const result = await readTreeFacts({ executor: mock, transport: transportOf(mock) }, input(true))
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok)
      return
    assert.deepEqual(result.facts.targetTree, [])
    assert.deepEqual(result.facts.targetSnaps, new Map())
    assert.deepEqual(result.facts.targetProps, new Map())
    assert.equal(readCalls(mock).length, 4, JSON.stringify(readCalls(mock)))
  })
})

describe('readTreeFacts: the captured run through ssh', () => {
  it('the target reads are ssh zfs, the source reads stay local, exact argv', async () => {
    const mock = armed(false)
    const result = await readTreeFacts({ executor: mock, transport: transportOf(mock) }, input(false))
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok)
      return

    const sshArgv = (args: string[]) => buildSshArgv(REMOTE, ['zfs', ...args])
    assert.deepEqual(readCalls(mock).map(c => ({ command: c.command, args: c.args })), [
      { command: ZFS, args: zfsTreeListArgs(SOURCE) },
      { command: ZFS, args: zfsTreeSnapshotsArgs(SOURCE) },
      { command: ZFS, args: zfsTreeGetArgs(SOURCE, ['keystatus']) },
      { command: SSH, args: sshArgv(zfsTreeListArgs(TARGET_POOL)).slice(1) },
      { command: SSH, args: sshArgv(zfsTreeSnapshotsArgs(TARGET)).slice(1) },
      { command: SSH, args: sshArgv(zfsTreeGetArgs(TARGET, ['written'])).slice(1) },
    ])
    assert.equal(result.facts.localTarget, false)
    assert.deepEqual(result.facts.targetTree, parseTreeList(fixture('dst-tree.txt')).filter(name => isAtOrUnder(name, TARGET)))
  })

  it('ssh exit 255 on the target pool listing is a refusal that does NOT say the target is absent', async () => {
    const mock = armed(false)
    const argv = buildSshArgv(REMOTE, ['zfs', ...zfsTreeListArgs(TARGET_POOL)])
    mock.prependFixture({ command: argv[0], args: argv.slice(1), result: { stdout: '', stderr: 'ssh: connect to host 10.0.0.9 port 22: Connection timed out', exitCode: 255 } })
    const result = await readTreeFacts({ executor: mock, transport: transportOf(mock) }, input(false))
    assert.deepEqual(result, {
      ok: false,
      message: `Could not list the datasets of pool '${TARGET_POOL}' on the target — refusing the recursive replication`,
    })
    // Source reads ran; nothing past the failed target listing did.
    assert.equal(readCalls(mock).length, 4)
  })
})

describe('readTreeFacts: every failed read refuses with its own sentence, and stops', () => {
  /** The reads in order, with the failure placed at `index`. */
  const READS: { at: number, args: string[], message: string }[] = [
    { at: 0, args: zfsTreeListArgs(SOURCE), message: `Could not list descendants of '${SOURCE}' — refusing the recursive replication` },
    { at: 1, args: zfsTreeSnapshotsArgs(SOURCE), message: `Could not list the snapshots under '${SOURCE}' — refusing the recursive replication` },
    { at: 2, args: zfsTreeGetArgs(SOURCE, ['keystatus']), message: `Could not read the encryption state under '${SOURCE}' — refusing the recursive replication` },
    { at: 3, args: zfsTreeListArgs(TARGET_POOL), message: `Could not list the datasets of pool '${TARGET_POOL}' on the target — refusing the recursive replication` },
    { at: 4, args: zfsTreeSnapshotsArgs(TARGET), message: `Could not list the snapshots under '${TARGET}' on the target — refusing the recursive replication` },
    { at: 5, args: zfsTreeGetArgs(TARGET, ['written']), message: `Could not read the modification state under '${TARGET}' on the target — refusing the recursive replication` },
  ]

  for (const read of READS) {
    it(`read ${read.at + 1} fails: '${read.message.slice(0, 40)}', and no later read runs`, async () => {
      const mock = armed(true)
      // Override the failing read with a plain non-zero exit — prepend so the
      // exact-args override wins over the armed fixture.
      mock.prependFixture({ command: ZFS, args: read.args, result: { stdout: '', stderr: 'boom', exitCode: 1 } })
      const result = await readTreeFacts({ executor: mock, transport: transportOf(mock) }, input(true))
      assert.deepEqual(result, { ok: false, message: read.message })
      assert.equal(readCalls(mock).length, read.at + 1, `expected the run to stop at read ${read.at + 1}`)
    })
  }

  it('a parser that refuses a line refuses the run, naming the line', async () => {
    const mock = armed(true)
    mock.prependFixture({
      command: ZFS,
      args: zfsTreeListArgs(SOURCE),
      result: ok(`${SOURCE}\n${SOURCE}/a\twith-a-tab\n`),
    })
    const result = await readTreeFacts({ executor: mock, transport: transportOf(mock) }, input(true))
    assert.equal(result.ok, false)
    if (result.ok)
      return
    assert.match(result.message, /^Unreadable zfs tree listing line: 'rpool\/rrsrc\/a\twith-a-tab' — refusing the recursive replication$/)
    assert.equal(readCalls(mock).length, 1)
  })
})

describe('readTreeFacts: an exit 0 whose listing does not start with the asked dataset did not answer (fold 1, reviews B1/B2/B7)', () => {
  const POOL_SENTENCE = `Could not list the datasets of pool '${TARGET_POOL}' on the target — refusing the recursive replication`
  const SOURCE_SENTENCE = `Could not list descendants of '${SOURCE}' — refusing the recursive replication`

  // `zfs list -r -- <x>` always prints <x>'s own row first. An exit 0 that
  // does not start with it (empty stdout, or rows of another dataset) did not
  // answer the question: it refuses the run with the failed-read sentence and
  // is never read as "the root is absent" / "the subtree is empty".
  const BAD_LISTINGS = [
    { label: 'empty stdout', stdout: '' },
    { label: 'rows of another pool', stdout: 'otherpool\notherpool/x\n' },
  ]

  for (const bad of BAD_LISTINGS) {
    it(`target pool listing, local: ${bad.label} refuses and reads 5-6 are not attempted`, async () => {
      const mock = armed(true)
      mock.prependFixture({ command: ZFS, args: zfsTreeListArgs(TARGET_POOL), result: ok(bad.stdout) })
      const result = await readTreeFacts({ executor: mock, transport: transportOf(mock) }, input(true))
      assert.deepEqual(result, { ok: false, message: POOL_SENTENCE })
      assert.equal(readCalls(mock).length, 4, JSON.stringify(readCalls(mock)))
    })

    it(`target pool listing through ssh: ${bad.label} refuses and reads 5-6 are not attempted`, async () => {
      const mock = armed(false)
      const argv = buildSshArgv(REMOTE, ['zfs', ...zfsTreeListArgs(TARGET_POOL)])
      mock.prependFixture({ command: argv[0], args: argv.slice(1), result: ok(bad.stdout) })
      const result = await readTreeFacts({ executor: mock, transport: transportOf(mock) }, input(false))
      assert.deepEqual(result, { ok: false, message: POOL_SENTENCE })
      assert.equal(readCalls(mock).length, 4, JSON.stringify(readCalls(mock)))
    })

    it(`source tree listing: ${bad.label} refuses with the unlisted sentence, not the planner's exclude question`, async () => {
      const mock = armed(true)
      mock.prependFixture({ command: ZFS, args: zfsTreeListArgs(SOURCE), result: ok(bad.stdout) })
      const result = await readTreeFacts({ executor: mock, transport: transportOf(mock) }, input(true))
      assert.deepEqual(result, { ok: false, message: SOURCE_SENTENCE })
      assert.equal(readCalls(mock).length, 1, JSON.stringify(readCalls(mock)))
    })
  }
})
