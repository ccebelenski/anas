import type { ReplicationTask } from '@anas/shared'
import type { ResolvedLocation, Transport } from '../replication-transport.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  LEGACY_REPLICATION_HOLD_TAG,
  legacyReleasableOnSource,
  parseHolds,
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
    mock.addFixture({ command: ZFS, args: ['hold', ...opts.failHold.split(' ')], result: { stdout: '', stderr: 'cannot hold: permission denied', exitCode: 1 } })
  return mock
}

/** `zfs holds -H <snap…>` for exactly this snapshot list. */
function holdsFixture(mock: MockExecutor, snapFulls: string[], holds: Record<string, string[]>): void {
  mock.addFixture({ command: ZFS, args: ['holds', '-H', ...snapFulls], result: { stdout: holdsText(holds), stderr: '', exitCode: 0 } })
}

function okZfs(mock: MockExecutor): void {
  mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
}

/** The (verb, tag, snapshot) triples of every hold/release issued. */
function verbs(mock: MockExecutor, verb: 'hold' | 'release'): string[] {
  return mock.calls.filter(c => c.command === ZFS && c.args[0] === verb).map(c => `${c.args[1]} ${c.args[2]}`)
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
    const order = mock.calls.filter(c => c.command === ZFS && (c.args[0] === 'hold' || c.args[0] === 'release')).map(c => `${c.args[0]} ${c.args[1]} ${c.args[2]}`)
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
