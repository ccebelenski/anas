import type { ReplicationTask } from '@anas/shared'
import type { ResolvedLocation, Transport } from '../replication-transport.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  describeHolds,
  LEGACY_REPLICATION_HOLD_TAG,
  legacyReleasableOnSource,
  parseHolds,
  readLocalHoldsChecked,
  replicationHoldTag,
  settleReplicationHolds,
} from '../replication-holds.js'
import { renderServiceUnit } from '../replication-units.js'

/**
 * Story ident.4 (a), audit #13 — the replication hold tag is per CHAIN
 * (`anas-repl-<hash(location, target)>`). Two tasks replicating one source to
 * two targets used to share the one global `anas-repl` tag, and each run
 * released it on every older snapshot — unpinning the other task's base, which
 * retention then destroyed ("diverged" on the other task's next run).
 */

const ZFS = '/usr/sbin/zfs'
const SRC = 'tank/media'
const TGT_A = 'backup/media-a'
const TGT_B = 'backup/media-b'
const TAG_A = replicationHoldTag(undefined, TGT_A)
const TAG_B = replicationHoldTag(undefined, TGT_B)

const NO_TRANSPORT = {} as Transport

/** `zfs holds -H` text for a map of snapshot → tags. */
function holdsText(holds: Record<string, string[]>): string {
  return Object.entries(holds)
    .flatMap(([snap, tags]) => tags.map(t => `${snap}\t${t}\tWed Oct  1 02:00 2026`))
    .join('\n')
}

/** A fresh mock; `failHold` ("<tag> <snapshot>") makes that one `zfs hold` fail. */
function wire(opts: { failHold?: string } = {}): MockExecutor {
  const mock = new MockExecutor()
  if (opts.failHold)
    mock.addFixture({ command: ZFS, args: ['hold', '--', ...opts.failHold.split(' ')], result: { stdout: '', stderr: 'cannot hold: permission denied', exitCode: 1 } })
  return mock
}

/** `zfs holds -H <snap…>` for exactly this snapshot list. */
function holdsFixture(mock: MockExecutor, snapFulls: string[], holds: Record<string, string[]>): void {
  mock.addFixture({ command: ZFS, args: ['holds', '-H', '--', ...snapFulls], result: { stdout: holdsText(holds), stderr: '', exitCode: 0 } })
}

function okZfs(mock: MockExecutor): void {
  mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
}

/** The (verb, tag, snapshot) triples of every hold/release issued (the `--` separator sits between verb and tag). */
function verbs(mock: MockExecutor, verb: 'hold' | 'release'): string[] {
  return mock.calls.filter(c => c.command === ZFS && c.args[0] === verb).map(c => `${c.args[2]} ${c.args[3]}`)
}

describe('replicationHoldTag', () => {
  it('is per chain: deterministic, distinct per target and per location', () => {
    assert.match(TAG_A, /^anas-repl-[0-9a-f]{12}$/)
    assert.equal(TAG_A, replicationHoldTag({ kind: 'local' }, TGT_A), 'absent location = local')
    assert.notEqual(TAG_A, TAG_B)
    assert.notEqual(replicationHoldTag({ kind: 'remote', name: 'nas1' }, TGT_A), TAG_A)
    assert.notEqual(replicationHoldTag({ kind: 'remote', name: 'nas1' }, TGT_A), replicationHoldTag({ kind: 'remote', name: 'nas2' }, TGT_A))
    assert.notEqual(TAG_A, LEGACY_REPLICATION_HOLD_TAG)
  })

  it('parseHolds groups tags per snapshot and skips junk', () => {
    const m = parseHolds(`${holdsText({ 'a@1': ['x', 'y'], 'a@2': ['z'] })}\njunk\n`)
    assert.deepEqual(m.get('a@1'), ['x', 'y'])
    assert.deepEqual(m.get('a@2'), ['z'])
    assert.equal(m.size, 2)
  })
})

describe('settleReplicationHolds', () => {
  const srcNames = ['s1', 's2', 's3']
  const srcFulls = srcNames.map(n => `${SRC}@${n}`)

  it('THE BUG: chain A\'s run never releases chain B\'s hold on the source', async () => {
    const mock = wire()
    // s1 is B's base (held by B), s2 is A's previous base (held by A).
    holdsFixture(mock, srcFulls, { [`${SRC}@s1`]: [TAG_B], [`${SRC}@s2`]: [TAG_A] })
    holdsFixture(mock, [`${TGT_A}@s2`, `${TGT_A}@s3`], { [`${TGT_A}@s2`]: [TAG_A] })
    okZfs(mock)
    const warnings = await settleReplicationHolds({ executor: mock, transport: NO_TRANSPORT }, {
      tag: TAG_A,
      snapName: 's3',
      baseSnapshot: 's2',
      source: { dataset: SRC, snapshotNames: srcNames },
      target: { dataset: TGT_A, snapshotNames: ['s2', 's3'] },
      releaseLegacyOnSource: true,
    })
    assert.deepEqual(warnings, [])
    assert.deepEqual(verbs(mock, 'hold'), [`${TAG_A} ${SRC}@s3`, `${TAG_A} ${TGT_A}@s3`])
    assert.deepEqual(verbs(mock, 'release'), [`${TAG_A} ${SRC}@s2`, `${TAG_A} ${TGT_A}@s2`])
    assert.ok(!verbs(mock, 'release').some(v => v.startsWith(TAG_B)), 'B\'s hold is never touched')
  })

  it('migration: the legacy tag comes off this chain\'s own base — after its own hold is in place', async () => {
    const mock = wire()
    holdsFixture(mock, srcFulls, { [`${SRC}@s2`]: [LEGACY_REPLICATION_HOLD_TAG] })
    holdsFixture(mock, [`${TGT_A}@s2`, `${TGT_A}@s3`], { [`${TGT_A}@s2`]: [LEGACY_REPLICATION_HOLD_TAG] })
    okZfs(mock)
    await settleReplicationHolds({ executor: mock, transport: NO_TRANSPORT }, {
      tag: TAG_A,
      snapName: 's3',
      baseSnapshot: 's2',
      source: { dataset: SRC, snapshotNames: srcNames },
      target: { dataset: TGT_A, snapshotNames: ['s2', 's3'] },
      releaseLegacyOnSource: true,
    })
    const order = mock.calls.filter(c => c.command === ZFS && (c.args[0] === 'hold' || c.args[0] === 'release')).map(c => `${c.args[0]} ${c.args[2]} ${c.args[3]}`)
    assert.deepEqual(order, [
      `hold ${TAG_A} ${SRC}@s3`,
      `hold ${TAG_A} ${TGT_A}@s3`,
      `release ${LEGACY_REPLICATION_HOLD_TAG} ${SRC}@s2`,
      `release ${LEGACY_REPLICATION_HOLD_TAG} ${TGT_A}@s2`,
    ])
  })

  it('migration: the source keeps the legacy hold while another chain has not migrated', async () => {
    const mock = wire()
    holdsFixture(mock, srcFulls, { [`${SRC}@s2`]: [LEGACY_REPLICATION_HOLD_TAG] })
    holdsFixture(mock, [`${TGT_A}@s2`, `${TGT_A}@s3`], { [`${TGT_A}@s2`]: [LEGACY_REPLICATION_HOLD_TAG] })
    okZfs(mock)
    await settleReplicationHolds({ executor: mock, transport: NO_TRANSPORT }, {
      tag: TAG_A,
      snapName: 's3',
      baseSnapshot: 's2',
      source: { dataset: SRC, snapshotNames: srcNames },
      target: { dataset: TGT_A, snapshotNames: ['s2', 's3'] },
      releaseLegacyOnSource: false,
    })
    // The target is this chain's alone — its legacy hold goes; the source's stays.
    assert.deepEqual(verbs(mock, 'release'), [`${LEGACY_REPLICATION_HOLD_TAG} ${TGT_A}@s2`])
  })

  it('migration: a failed own hold leaves the legacy hold in place (never unheld in between)', async () => {
    const mock = wire({ failHold: `${TAG_A} ${SRC}@s3` })
    holdsFixture(mock, srcFulls, { [`${SRC}@s2`]: [LEGACY_REPLICATION_HOLD_TAG] })
    holdsFixture(mock, [`${TGT_A}@s2`, `${TGT_A}@s3`], { [`${TGT_A}@s2`]: [LEGACY_REPLICATION_HOLD_TAG] })
    okZfs(mock)
    const warnings = await settleReplicationHolds({ executor: mock, transport: NO_TRANSPORT }, {
      tag: TAG_A,
      snapName: 's3',
      baseSnapshot: 's2',
      source: { dataset: SRC, snapshotNames: srcNames },
      target: { dataset: TGT_A, snapshotNames: ['s2', 's3'] },
      releaseLegacyOnSource: true,
    })
    assert.equal(warnings.length, 2)
    assert.match(warnings[0], /Could not place .* hold on tank\/media@s3/)
    assert.match(warnings[1], /Kept every hold on tank\/media/)
    assert.ok(!verbs(mock, 'release').includes(`${LEGACY_REPLICATION_HOLD_TAG} ${SRC}@s2`), 'source legacy hold kept')
    // The target's own hold succeeded, so the target migrates.
    assert.ok(verbs(mock, 'release').includes(`${LEGACY_REPLICATION_HOLD_TAG} ${TGT_A}@s2`))
  })

  it('a failed own hold on the new source base releases NOTHING on the source — the old base keeps this chain\'s tag', async () => {
    const mock = wire({ failHold: `${TAG_A} ${SRC}@s3` })
    // The previous base carries this chain's OWN tag (and the legacy one).
    holdsFixture(mock, srcFulls, { [`${SRC}@s2`]: [TAG_A, LEGACY_REPLICATION_HOLD_TAG] })
    holdsFixture(mock, [`${TGT_A}@s2`, `${TGT_A}@s3`], { [`${TGT_A}@s2`]: [TAG_A] })
    okZfs(mock)
    const warnings = await settleReplicationHolds({ executor: mock, transport: NO_TRANSPORT }, {
      tag: TAG_A,
      snapName: 's3',
      baseSnapshot: 's2',
      source: { dataset: SRC, snapshotNames: srcNames },
      target: { dataset: TGT_A, snapshotNames: ['s2', 's3'] },
      releaseLegacyOnSource: true,
    })
    assert.deepEqual(verbs(mock, 'release').filter(v => v.endsWith(`${SRC}@s2`)), [], 'no release of any tag on the source')
    assert.ok(warnings.some(w => /Kept every hold on tank\/media:/.test(w)), 'the run says why')
    // The target side held its new base, so it moves on as usual.
    assert.deepEqual(verbs(mock, 'release'), [`${TAG_A} ${TGT_A}@s2`])
  })

  it('a failed own hold on the new target base releases NOTHING on the target', async () => {
    const mock = wire({ failHold: `${TAG_A} ${TGT_A}@s3` })
    holdsFixture(mock, srcFulls, { [`${SRC}@s2`]: [TAG_A] })
    holdsFixture(mock, [`${TGT_A}@s2`, `${TGT_A}@s3`], { [`${TGT_A}@s2`]: [TAG_A, LEGACY_REPLICATION_HOLD_TAG] })
    okZfs(mock)
    const warnings = await settleReplicationHolds({ executor: mock, transport: NO_TRANSPORT }, {
      tag: TAG_A,
      snapName: 's3',
      baseSnapshot: 's2',
      source: { dataset: SRC, snapshotNames: srcNames },
      target: { dataset: TGT_A, snapshotNames: ['s2', 's3'] },
      releaseLegacyOnSource: true,
    })
    assert.deepEqual(verbs(mock, 'release'), [`${TAG_A} ${SRC}@s2`], 'only the source (held) side releases')
    assert.ok(warnings.some(w => /Kept every hold on backup\/media-a:/.test(w)))
  })

  it('a failed remote target hold releases nothing over the transport', async () => {
    const mock = wire()
    holdsFixture(mock, srcFulls, {})
    okZfs(mock)
    const remoteCalls: string[] = []
    const transport = {
      remoteHold: async (_r: ResolvedLocation, snap: string, tag: string) => {
        remoteCalls.push(`hold ${tag} ${snap}`)
        return { stdout: '', stderr: 'ssh: connection reset', exitCode: 255 }
      },
      remoteRelease: async (_r: ResolvedLocation, snap: string, tag: string) => {
        remoteCalls.push(`release ${tag} ${snap}`)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      remoteHeldTags: async () => [TAG_A, LEGACY_REPLICATION_HOLD_TAG],
    } as unknown as Transport
    const warnings = await settleReplicationHolds({ executor: mock, transport }, {
      tag: TAG_A,
      snapName: 's3',
      baseSnapshot: 's2',
      source: { dataset: SRC, snapshotNames: srcNames },
      target: { dataset: TGT_A, snapshotNames: ['s2', 's3'] },
      remote: {} as ResolvedLocation,
      releaseLegacyOnSource: true,
    })
    assert.deepEqual(remoteCalls, [`hold ${TAG_A} ${TGT_A}@s3`])
    assert.ok(warnings.some(w => /Kept every hold on backup\/media-a:/.test(w)))
  })

  it('a remote target settles over the transport with the same rules', async () => {
    const mock = wire()
    holdsFixture(mock, srcFulls, {})
    okZfs(mock)
    const remoteCalls: string[] = []
    const transport = {
      remoteHold: async (_r: ResolvedLocation, snap: string, tag: string) => {
        remoteCalls.push(`hold ${tag} ${snap}`)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      remoteRelease: async (_r: ResolvedLocation, snap: string, tag: string) => {
        remoteCalls.push(`release ${tag} ${snap}`)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      remoteHeldTags: async (_r: ResolvedLocation, snap: string) =>
        snap.endsWith('@s2') ? [TAG_A, LEGACY_REPLICATION_HOLD_TAG, 'operator-own'] : [],
    } as unknown as Transport
    await settleReplicationHolds({ executor: mock, transport }, {
      tag: TAG_A,
      snapName: 's3',
      baseSnapshot: 's2',
      source: { dataset: SRC, snapshotNames: srcNames },
      target: { dataset: TGT_A, snapshotNames: ['s2', 's3'] },
      remote: {} as ResolvedLocation,
      releaseLegacyOnSource: true,
    })
    assert.deepEqual(remoteCalls, [
      `hold ${TAG_A} ${TGT_A}@s3`,
      `release ${TAG_A} ${TGT_A}@s2`,
      `release ${LEGACY_REPLICATION_HOLD_TAG} ${TGT_A}@s2`,
    ], 'an operator\'s own hold is never released')
  })
})

describe('legacyReleasableOnSource', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-repl-holds-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function task(name: string, targetDataset: string): Promise<void> {
    const t: ReplicationTask = {
      name,
      source: { pool: 'tank', dataset: 'media' },
      target: { pool: 'backup', dataset: targetDataset },
      schedule: 'daily',
      snapshotFirst: true,
      enabled: true,
      notify: 'on-failure',
    }
    await writeFile(join(dir, `anas-repl-${name}.service`), renderServiceUnit(t), 'utf-8')
  }

  it('true when no other task replicates this source', async () => {
    await task('a', 'media-a')
    const mock = new MockExecutor()
    assert.deepEqual(await legacyReleasableOnSource(mock, { sourceFull: SRC, ownTag: TAG_A, sourceSnapshotNames: ['s1'], systemdDir: dir }), { releasable: true })
  })

  it('an unreadable task store is never "no other tasks": keep the legacy hold, say why', async () => {
    const mock = new MockExecutor()
    const verdict = await legacyReleasableOnSource(mock, { sourceFull: SRC, ownTag: TAG_A, sourceSnapshotNames: ['s1'], systemdDir: join(dir, 'missing') })
    assert.equal(verdict.releasable, false)
    assert.match(verdict.warning ?? '', /Kept the legacy anas-repl hold on tank\/media: the replication task list could not be read in full/)
    assert.equal(mock.calls.length, 0, 'no holds read — the verdict is already "keep"')
  })

  it('an unparseable task file makes the list incomplete: keep the legacy hold', async () => {
    await task('a', 'media-a')
    await writeFile(join(dir, 'anas-repl-b.service'), '[Unit]\nX-ANAS-Task=not json\n', 'utf-8')
    const verdict = await legacyReleasableOnSource(new MockExecutor(), { sourceFull: SRC, ownTag: TAG_A, sourceSnapshotNames: ['s1'], systemdDir: dir })
    assert.equal(verdict.releasable, false)
    assert.ok(verdict.warning)
  })

  it('false while another task of the same source has not placed its own tag; true once it has', async () => {
    await task('a', 'media-a')
    await task('b', 'media-b')
    const mock = new MockExecutor()
    holdsFixture(mock, [`${SRC}@s1`, `${SRC}@s2`], { [`${SRC}@s1`]: [LEGACY_REPLICATION_HOLD_TAG] })
    assert.deepEqual(await legacyReleasableOnSource(mock, { sourceFull: SRC, ownTag: TAG_A, sourceSnapshotNames: ['s1', 's2'], systemdDir: dir }), { releasable: false })

    const migrated = new MockExecutor()
    holdsFixture(migrated, [`${SRC}@s1`, `${SRC}@s2`], { [`${SRC}@s1`]: [LEGACY_REPLICATION_HOLD_TAG, TAG_B] })
    assert.deepEqual(await legacyReleasableOnSource(migrated, { sourceFull: SRC, ownTag: TAG_A, sourceSnapshotNames: ['s1', 's2'], systemdDir: dir }), { releasable: true })
  })
})

describe('nf.3 D11 — readLocalHoldsChecked and describeHolds (the forced-rollback hold gate)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-repl-holds-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('readLocalHoldsChecked: the holds when zfs answers; null — never "no holds" — when it exits non-zero or cannot run', async () => {
    const answered = new MockExecutor()
    holdsFixture(answered, [`${SRC}@s1`, `${SRC}@s2`], { [`${SRC}@s2`]: [TAG_A] })
    assert.deepEqual(await readLocalHoldsChecked(answered, [`${SRC}@s1`, `${SRC}@s2`]), new Map([[`${SRC}@s2`, [TAG_A]]]))

    const failed = new MockExecutor()
    failed.addFixture({ command: ZFS, args: ['holds', '-H', '--', `${SRC}@s1`], result: { stdout: '', stderr: `cannot open '${SRC}@s1': dataset does not exist`, exitCode: 1 } })
    assert.equal(await readLocalHoldsChecked(failed, [`${SRC}@s1`]), null)

    const missing = new MockExecutor() // no fixture: the mock answers 127, as for a tool that is not there
    assert.equal(await readLocalHoldsChecked(missing, [`${SRC}@s1`]), null)

    const thrown = new MockExecutor()
    thrown.addFixture({ command: ZFS, args: ['holds', '-H', '--', `${SRC}@s1`], throws: new Error('spawn EAGAIN') })
    assert.equal(await readLocalHoldsChecked(thrown, [`${SRC}@s1`]), null)

    assert.deepEqual(await readLocalHoldsChecked(new MockExecutor(), []), new Map(), 'nothing to read, nothing run')
  })

  it('describeHolds names a task\'s chain by the task, an unclaimed chain, the legacy tag and anyone else\'s tag', async () => {
    const t: ReplicationTask = {
      name: 'nightly',
      source: { pool: 'tank', dataset: 'media' },
      target: { pool: 'backup', dataset: 'media-a' },
      schedule: 'daily',
      snapshotFirst: true,
      enabled: true,
      notify: 'on-failure',
    }
    await writeFile(join(dir, 'anas-repl-nightly.service'), renderServiceUnit(t), 'utf-8')
    assert.deepEqual(await describeHolds([TAG_A, TAG_B, LEGACY_REPLICATION_HOLD_TAG, 'keep'], dir), [
      `held by replication task 'nightly': ${TAG_A}`,
      `held by a replication no task names (an interactive replicate, or a removed task): ${TAG_B}`,
      'held by replication (the shared tag from before per-chain tags): anas-repl',
      'held by \'keep\'',
    ])
    // An unreadable task store only loses the task's name, never the hold.
    assert.deepEqual(await describeHolds([TAG_A], join(dir, 'missing')), [
      `held by a replication no task names (an interactive replicate, or a removed task): ${TAG_A}`,
    ])
  })

  // rrep.2 (#84, R7): a recursive task's holds on EVERY dataset it sent are
  // placed under the ROOT's one tag (the route derives it from the root's
  // target name), so a CHILD's snapshot is held under a tag that names the
  // root — and `describeHolds` maps the TAG to the task, not the dataset. A
  // child's hold therefore names the task with no change to the code; this
  // pins that.
  it('rrep.2: a child snapshot held under a stored recursive task\'s root tag names the task', async () => {
    const tree: ReplicationTask = {
      name: 'nightly-tree',
      source: { pool: 'tank', dataset: 'media' },
      target: { pool: 'backup', dataset: 'media-a' },
      schedule: 'daily',
      snapshotFirst: false,
      enabled: true,
      notify: 'on-failure',
      recursive: true,
      exclude: ['tank/media/skip'],
    }
    await writeFile(join(dir, 'anas-repl-nightly-tree.service'), renderServiceUnit(tree), 'utf-8')
    // TAG_A is the root chain's tag (target `backup/media-a`); the snapshot
    // it is on belongs to a child (`tank/media/a`), which the arguments do
    // not have to name — the tag is what describeHolds resolves.
    assert.deepEqual(await describeHolds([TAG_A], dir), [`held by replication task 'nightly-tree': ${TAG_A}`])
  })

  // rrep.2 fold D2: a task stored with `target.dataset: ''` (the schema's
  // "default") replicates to `<pool>/<source rel>` — the runner drops the
  // empty string — so its run holds under THAT name's tag. describeHolds used
  // to derive the tag from `backup/` and named no task.
  it('fold D2: a hold placed by the run of a task stored with target dataset \'\' is named by the task', async () => {
    const t: ReplicationTask = {
      name: 'nightly-default',
      source: { pool: 'tank', dataset: 'media' },
      target: { pool: 'backup', dataset: '' },
      schedule: 'daily',
      snapshotFirst: true,
      enabled: true,
      notify: 'on-failure',
    }
    await writeFile(join(dir, 'anas-repl-nightly-default.service'), renderServiceUnit(t), 'utf-8')
    const runTag = replicationHoldTag(undefined, 'backup/media')
    assert.deepEqual(await describeHolds([runTag], dir), [`held by replication task 'nightly-default': ${runTag}`])
  })
})

/**
 * repl.r1 — "already held" means the snapshot we asked about.
 *
 * Ground truth (two real nodes, OpenZFS 2.4): the hold of `datapool/spc@nightly
 * 2` split by the remote shell at the space answers the tag-exists line for
 * `datapool/spc@nightly` PLUS `'2' is not a snapshot`, exit 1 — the spaced
 * snapshot is not held. Reading that stderr as "held" released the chain's tag
 * from the snapshot that was actually held.
 */
describe('repl.r1 — alreadyHeld means the snapshot asked about', () => {
  const DS = 'datapool/spc'
  const TGTP = 'backup/spc'
  const SPACED = 'nightly 2'
  const SPACED_FULL = `${DS}@${SPACED}`
  const CAPTURED_SPLIT = `cannot hold snapshot '${DS}@nightly': tag already exists on this dataset\n'2' is not a snapshot`

  it('a split spaced snapshot is NOT held: nothing is released on that side and the run warns', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, args: ['hold', '--', TAG_A, SPACED_FULL], result: { stdout: '', stderr: CAPTURED_SPLIT, exitCode: 1 } })
    okZfs(mock)
    const warnings = await settleReplicationHolds({ executor: mock, transport: NO_TRANSPORT }, {
      tag: TAG_A,
      snapName: SPACED,
      baseSnapshot: 'nightly',
      source: { dataset: DS, snapshotNames: ['nightly', SPACED] },
      target: { dataset: TGTP, snapshotNames: [SPACED] },
      releaseLegacyOnSource: true,
    })
    const holds = mock.calls.filter(c => c.command === ZFS && c.args[0] === 'hold')
    assert.deepEqual(holds.map(c => c.args[3]).filter(a => a.startsWith(`${DS}@`)), [SPACED_FULL], 'the source hold was asked for the ONE spaced snapshot')
    assert.deepEqual(warnings.length, 2)
    assert.match(warnings[0] as string, /Could not place .* hold on datapool\/spc@nightly 2/)
    assert.ok(warnings.some(w => /Kept every hold on datapool\/spc:/.test(w)))
    assert.deepEqual(verbs(mock, 'release'), [], 'a side whose own hold did not succeed releases NOTHING')
  })

  it('a tag-exists line naming a DIFFERENT snapshot is not held, even alone on stderr', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      args: ['hold', '--', TAG_A, SPACED_FULL],
      result: { stdout: '', stderr: `cannot hold snapshot '${DS}@nightly': tag already exists on this dataset`, exitCode: 1 },
    })
    okZfs(mock)
    const warnings = await settleReplicationHolds({ executor: mock, transport: NO_TRANSPORT }, {
      tag: TAG_A,
      snapName: SPACED,
      baseSnapshot: 'nightly',
      source: { dataset: DS, snapshotNames: ['nightly', SPACED] },
      target: { dataset: TGTP, snapshotNames: [SPACED] },
      releaseLegacyOnSource: true,
    })
    assert.ok(warnings.some(w => /Could not place .* hold on datapool\/spc@nightly 2/.test(w)))
    assert.deepEqual(verbs(mock, 'release'), [], 'the snapshot named in the line was never what we asked to hold')
  })

  it('the genuine case — the same snapshot named, nothing else on stderr — is held as today', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      args: ['hold', '--', TAG_A, SPACED_FULL],
      result: { stdout: '', stderr: `cannot hold snapshot '${SPACED_FULL}': tag already exists on this dataset`, exitCode: 1 },
    })
    holdsFixture(mock, [`${DS}@nightly`, SPACED_FULL], { [`${DS}@nightly`]: [TAG_A] })
    okZfs(mock)
    const warnings = await settleReplicationHolds({ executor: mock, transport: NO_TRANSPORT }, {
      tag: TAG_A,
      snapName: SPACED,
      baseSnapshot: 'nightly',
      source: { dataset: DS, snapshotNames: ['nightly', SPACED] },
      target: { dataset: TGTP, snapshotNames: [SPACED] },
      releaseLegacyOnSource: true,
    })
    assert.deepEqual(warnings, [])
    assert.deepEqual(verbs(mock, 'release'), [`${TAG_A} ${DS}@nightly`], 'only the older snapshot loses this chain\'s tag')
  })

  // Review of repl.r1: exit 255 is ssh's own failure. RULE: an answer that
  // arrives with it is the transport's, never zfs's, whatever stderr carries.
  it('exit 255 is never "already held", even with the right tag-exists line on stderr', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      args: ['hold', '--', TAG_A, SPACED_FULL],
      result: { stdout: '', stderr: `cannot hold snapshot '${SPACED_FULL}': tag already exists on this dataset`, exitCode: 255 },
    })
    holdsFixture(mock, [`${DS}@nightly`, SPACED_FULL], { [`${DS}@nightly`]: [TAG_A] })
    okZfs(mock)
    const warnings = await settleReplicationHolds({ executor: mock, transport: NO_TRANSPORT }, {
      tag: TAG_A,
      snapName: SPACED,
      baseSnapshot: 'nightly',
      source: { dataset: DS, snapshotNames: ['nightly', SPACED] },
      target: { dataset: TGTP, snapshotNames: [SPACED] },
      releaseLegacyOnSource: true,
    })
    assert.ok(warnings.some(w => w.includes('Could not place')), JSON.stringify(warnings))
    assert.deepEqual(verbs(mock, 'release').filter(v => v.includes(DS)), [], 'nothing comes off the source side')
  })

  it('the target side reads its own snapshot name too (the call site passes the full target name)', async () => {
    const mock = new MockExecutor()
    okZfs(mock)
    holdsFixture(mock, [`${DS}@nightly`, SPACED_FULL], {})
    const remoteCalls: string[] = []
    const transport = {
      remoteHold: async (_r: ResolvedLocation, snap: string, tag: string) => {
        remoteCalls.push(`hold ${tag} ${snap}`)
        // The split stderr of a spaced name, answered on the TARGET side.
        return { stdout: '', stderr: `cannot hold snapshot '${TGTP}@nightly': tag already exists on this dataset\n'2' is not a snapshot`, exitCode: 1 }
      },
      remoteRelease: async (_r: ResolvedLocation, snap: string, tag: string) => {
        remoteCalls.push(`release ${tag} ${snap}`)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      remoteHeldTags: async () => [TAG_A, LEGACY_REPLICATION_HOLD_TAG],
    } as unknown as Transport
    const warnings = await settleReplicationHolds({ executor: mock, transport }, {
      tag: TAG_A,
      snapName: SPACED,
      baseSnapshot: 'nightly',
      source: { dataset: DS, snapshotNames: ['nightly', SPACED] },
      target: { dataset: TGTP, snapshotNames: ['nightly', SPACED] },
      remote: {} as ResolvedLocation,
      releaseLegacyOnSource: true,
    })
    assert.deepEqual(remoteCalls, [`hold ${TAG_A} ${TGTP}@${SPACED}`], 'the unheld target releases nothing over the transport')
    assert.ok(warnings.some(w => /Kept every hold on backup\/spc:/.test(w)))
  })
})
