import type { ReplicationTask } from '@anas/shared'
import type { ExecResult } from '../executor/types.js'
import type { ReplicationNotifyContext } from '../services/replication-notify.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../executor/mock.js'
import { zfsSnapshotDetailArgs } from '../parsers/zfs-list.js'
import { zfsTreeGetArgs, zfsTreeSnapshotsArgs } from '../parsers/zfs-tree.js'
import { runDriftCheck } from '../repl-drift-check.js'
import { readTaskTarget, renderServiceUnit, serviceUnitName, timerUnitName } from '../services/replication-units.js'
import { zfsTreeListArgs } from '../services/zfs-snapshot.js'

/**
 * repl.drift review P1: a RECURSIVE task's target is every copy its run
 * receives into or finds up to date. The status read and the daily check
 * judged the ROOT only, so a changed child neither showed nor alerted. They
 * now ask the run's own per-copy judgement (`judgeTreeTargets`, the gate's
 * planner + checks + judge) over the run's own tree read. Every listing here
 * is the captured `fixtures/zfs/replication-tree/` before-state (source at
 * @S2, every copy at @S1); a change is a captured byte count from
 * `zfs-written-replica.zfs2.4.2.txt` (14336: one small file written) written
 * into one `written` row.
 */

const fixturesDir = join(import.meta.dirname, '../fixtures/zfs/replication-tree')
const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const NOW = Date.parse('2026-11-15T12:00:00Z')
const SOURCE = 'rpool/rrsrc'
const TARGET = 'datapool/rrdst'
const S1 = 'anas-daily-2026-11-13_01.00.00--1d'
const S2 = 'anas-daily-2026-11-14_01.00.00--1d'
const DRIFT_WRITE = '14336'

const fixture = (name: string): string => readFileSync(join(fixturesDir, name), 'utf-8')
const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** `zfs list -j -t snapshot` JSON for the captured names, oldest first (createtxg order). */
function snapJson(dataset: string, names: string[]): string {
  const datasets: Record<string, unknown> = {}
  names.forEach((n, i) => {
    datasets[`${dataset}@${n}`] = { name: `${dataset}@${n}`, type: 'SNAPSHOT', pool: dataset.split('/')[0], dataset, snapshot_name: n, createtxg: String(i + 1), properties: {} }
  })
  return JSON.stringify({ datasets })
}

const TREE_TASK: ReplicationTask = {
  name: 'tree',
  source: { pool: 'rpool', dataset: 'rrsrc' },
  target: { pool: 'datapool', dataset: 'rrdst' },
  schedule: 'daily',
  snapshotFirst: false,
  enabled: true,
  notify: 'on-failure',
  recursive: true,
  exclude: ['rpool/rrsrc/skipme'],
}

/** One `written` / `readonly` row of the captured target tree replaced. */
function editRow(dataset: string, prop: 'written' | 'readonly', value: string): (text: string) => string {
  return text => text.split('\n').map(l => (l.startsWith(`${dataset}\t${prop}\t`) ? `${dataset}\t${prop}\t${value}` : l)).join('\n')
}

function treeNode(edit: (text: string) => string = t => t, opts: { poolListFails?: true, targetWrittenFails?: true, keystatusFails?: true, keystatus?: string, rootWritten?: string, targetSnapsAfter?: string } = {}): MockExecutor {
  const lastRun = '2026-11-12T03:00:00Z'
  const m = new MockExecutor()
  m.clearFixtures()
  // The root's lag listings (the status read's own, unchanged).
  m.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs(SOURCE), result: ok(snapJson(SOURCE, [S1, S2])) })
  m.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs(TARGET), result: ok(snapJson(TARGET, [S1])) })
  // The run's tree read: captured listings.
  m.addFixture({ command: ZFS, args: zfsTreeListArgs(SOURCE), result: ok(fixture('src-tree.txt')) })
  m.addFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(SOURCE), result: ok(fixture('src-snaps-p.txt')) })
  m.addFixture({ command: ZFS, args: zfsTreeGetArgs(SOURCE, ['keystatus']), result: opts.keystatusFails ? { stdout: '', stderr: 'I/O error', exitCode: 1 } : ok(fixture(opts.keystatus ?? 'src-keystatus.txt')) })
  m.addFixture({
    command: ZFS,
    args: zfsTreeListArgs('datapool'),
    result: opts.poolListFails
      ? { stdout: '', stderr: 'ssh: connect to host nas1 port 22: Connection timed out', exitCode: 255 }
      : ok(`datapool\n${fixture('dst-tree.txt')}`),
  })
  m.addFixture({ command: ZFS, args: zfsTreeSnapshotsArgs(TARGET), results: [ok(fixture('dst-snaps-p.txt')), ok(opts.targetSnapsAfter ?? fixture('dst-snaps-p.txt'))] })
  m.addFixture({
    command: ZFS,
    args: zfsTreeGetArgs(TARGET, ['written', 'readonly']),
    result: opts.targetWrittenFails ? { stdout: '', stderr: 'cannot open \'datapool/rrdst\': I/O error', exitCode: 1 } : ok(edit(fixture('dst-written.txt'))),
  })
  m.addFixture({ command: ZFS, args: ['holds', '-H', '--'], result: ok('') })
  // The root's own read (third capture A's rows, re-keyed to the base): asked only when the tree is not judged.
  m.addFixture({ command: ZFS, args: ['get', '-Hp', '-o', 'property,value,source', `written@${S1},readonly`, '--', TARGET], result: ok(`written@${S1}\t${opts.rootWritten ?? '0'}\tlocal\nreadonly\ton\tlocal\n`) })
  const stamp = `Thu ${lastRun.slice(0, 10)} ${lastRun.slice(11, 19)} UTC`
  m.addFixture({ command: SYSTEMCTL, args: ['show', serviceUnitName('tree'), '-p', 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'], result: ok(`ActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=${stamp}\nInactiveEnterTimestamp=${stamp}\n`) })
  m.addFixture({ command: SYSTEMCTL, args: ['show', timerUnitName('tree'), '-p', 'NextElapseUSecRealtime,LastTriggerUSec'], result: ok('NextElapseUSecRealtime=0\nLastTriggerUSec=\n') })
  m.addFixture({ command: '/usr/bin/journalctl', result: ok('') })
  return m
}

const zfsCalls = (m: MockExecutor): string[] => m.calls.filter(c => c.command === ZFS).map(c => c.args.join(' '))

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'anas-repl-tree-read-'))
  await mkdir(join(dir, 'units'), { recursive: true })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('repl.drift review P1 — a recursive task\'s status judges every copy', () => {
  it('a changed CHILD is the task\'s state: modified, naming the child, the root clean', async () => {
    const m = treeNode(editRow('datapool/rrdst/a', 'written', DRIFT_WRITE))
    const read = await readTaskTarget(m, TREE_TASK)
    assert.equal(read.targetDrift?.state, 'modified')
    assert.equal(read.targetDrift?.dataset, 'datapool/rrdst/a')
    assert.equal(read.targetDrift?.base, S1)
    assert.match(read.targetDrift?.message ?? '', /^Target 'datapool\/rrdst\/a' has been changed since '@anas-daily-2026-11-13_01\.00\.00--1d': 14\.00 KiB written with no new snapshot/)
    // The lag is still the root's.
    assert.equal(read.lastReplicatedSnapshot, S1)
    assert.equal(read.snapshotsBehind, 1)
  })

  it('two changed copies: both sentences ride the one row', async () => {
    const m = treeNode(t => editRow('datapool/rrdst/vol', 'written', DRIFT_WRITE)(editRow('datapool/rrdst/a', 'written', DRIFT_WRITE)(t)))
    const read = await readTaskTarget(m, TREE_TASK)
    assert.equal(read.targetDrift?.state, 'modified')
    assert.match(read.targetDrift?.message ?? '', /^Target 'datapool\/rrdst\/a' has been changed.* Target 'datapool\/rrdst\/vol' has been changed/)
  })

  it('a child that is not read-only reads exposed, and the read never says a receive sealed it (nothing was received)', async () => {
    const m = treeNode(editRow('datapool/rrdst/vol', 'readonly', 'off'))
    const read = await readTaskTarget(m, TREE_TASK)
    assert.equal(read.targetDrift?.state, 'exposed')
    assert.equal(read.targetDrift?.dataset, 'datapool/rrdst/vol')
    assert.match(read.targetDrift?.message ?? '', /^Target 'datapool\/rrdst\/vol' is not read-only \(readonly=off\): /)
    assert.ok(!read.targetDrift?.message?.includes('this run\'s receive'))
  })

  it('the cost: the captured tree read (six commands) beside the root\'s two listings; no separate root read, and the holds only for a changed copy', async () => {
    const m = treeNode()
    const read = await readTaskTarget(m, TREE_TASK)
    assert.equal(read.targetDrift?.state, 'clean')
    assert.deepEqual(zfsCalls(m), [
      zfsSnapshotDetailArgs(SOURCE).join(' '),
      zfsSnapshotDetailArgs(TARGET).join(' '),
      zfsTreeListArgs(SOURCE).join(' '),
      zfsTreeSnapshotsArgs(SOURCE).join(' '),
      zfsTreeGetArgs(SOURCE, ['keystatus']).join(' '),
      zfsTreeListArgs('datapool').join(' '),
      zfsTreeSnapshotsArgs(TARGET).join(' '),
      zfsTreeGetArgs(TARGET, ['written', 'readonly']).join(' '),
    ])
  })

  // Review 2, defect 1 (rule: a read that could not see never says clean).
  // The probe (t/review2/p1.out) read "clean" for each of these with child
  // `a` changed: the root alone was judged and its clean row stood for the tree.
  const UNCHECKED = `Could not check whether the copies under target '${TARGET}' were changed since their last replication: `
  for (const [label, opts, reason] of [
    ['the target pool cannot be listed', { poolListFails: true }, 'could not list the datasets of pool \'datapool\' on the target'],
    ['the target tree\'s written/readonly read fails', { targetWrittenFails: true }, `could not read the modification state under '${TARGET}' on the target`],
  ] as const) {
    it(`a tree that cannot be read (${label}) with a changed child: unknown, saying what could not be read, never clean`, async () => {
      const m = treeNode(editRow('datapool/rrdst/a', 'written', DRIFT_WRITE), opts)
      const read = await readTaskTarget(m, TREE_TASK)
      assert.equal(read.targetDrift?.state, 'unknown')
      assert.equal(read.targetDrift?.dataset, TARGET)
      assert.equal(read.targetDrift?.base, S1)
      assert.equal(read.targetDrift?.message, `${UNCHECKED}${reason}`)
      // The root's own read is still asked (a changed root says so, below).
      assert.ok(zfsCalls(m).includes(`get -Hp -o property,value,source written@${S1},readonly -- ${TARGET}`))
    })
  }

  it('a source tree whose encryption state cannot be read: unknown with that sentence', async () => {
    const m = treeNode(editRow('datapool/rrdst/a', 'written', DRIFT_WRITE), { keystatusFails: true })
    const read = await readTaskTarget(m, TREE_TASK)
    assert.equal(read.targetDrift?.state, 'unknown')
    assert.equal(read.targetDrift?.message, `${UNCHECKED}could not read the encryption state under '${SOURCE}'`)
  })

  it('a tree a run would refuse (a key not loaded, captured): unknown with the run\'s own refusal, never clean', async () => {
    const m = treeNode(editRow('datapool/rrdst/a', 'written', DRIFT_WRITE), { keystatus: 'src-keystatus-unloaded.txt' })
    const read = await readTaskTarget(m, TREE_TASK)
    assert.equal(read.targetDrift?.state, 'unknown')
    assert.equal(read.targetDrift?.message, `${UNCHECKED}a run would refuse this tree as it stands: 'rpool/rrsrc/enc' is encrypted and its key is not loaded — load it or exclude the dataset`)
  })

  it('a tree that cannot be read and a CHANGED ROOT: modified, and the sentence says the copies below could not be checked', async () => {
    const m = treeNode(t => t, { poolListFails: true, rootWritten: DRIFT_WRITE })
    const read = await readTaskTarget(m, TREE_TASK)
    assert.equal(read.targetDrift?.state, 'modified')
    assert.equal(read.targetDrift?.dataset, TARGET)
    assert.match(read.targetDrift?.message ?? '', /^Target 'datapool\/rrdst' has been changed since '@anas-daily-2026-11-13_01\.00\.00--1d': 14\.00 KiB written/)
    assert.ok(read.targetDrift?.message?.endsWith(` Whether the copies below '${TARGET}' were changed could not be checked: could not list the datasets of pool 'datapool' on the target.`), read.targetDrift?.message)
  })
})

describe('repl.drift review P1 — the daily check alerts for a changed child', () => {
  it('ONE alert naming the child; the check sends, holds and sets nothing', async () => {
    const m = treeNode(editRow('datapool/rrdst/a', 'written', DRIFT_WRITE))
    await writeFile(join(dir, 'units', serviceUnitName('tree')), renderServiceUnit(TREE_TASK))
    const sent: ReplicationNotifyContext[] = []
    const r = await runDriftCheck({ executor: m, systemdDir: join(dir, 'units'), now: () => NOW, notify: async ctx => void sent.push(ctx) })
    assert.deepEqual(r.alerted, ['tree'])
    assert.equal(sent.length, 1)
    assert.equal(sent[0].source, SOURCE)
    assert.equal(sent[0].target, TARGET)
    assert.match(sent[0].error ?? '', /^The daily check of replication task 'tree' found its target changed; no replication ran: Target 'datapool\/rrdst\/a' has been changed since/)
    assert.deepEqual(m.pipelineCalls, [])
    assert.deepEqual(m.calls.filter(c => c.command === ZFS && ['hold', 'release', 'set', 'send', 'recv', 'rollback', 'snapshot'].includes(c.args[0])), [])
  })

  // Review P4 for a tree: a copy's receive (an ad-hoc recursive Replicate)
  // landing between the tree listing and the read is a changed listing.
  it('a changed CHILD whose tree listing changed before the confirming re-read: no alert', async () => {
    const landed = `${fixture('dst-snaps-p.txt')}datapool/rrdst/a@${S2}\t1794618284\t18418333994574013669\n`
    const m = treeNode(editRow('datapool/rrdst/a', 'written', DRIFT_WRITE), { targetSnapsAfter: landed })
    await writeFile(join(dir, 'units', serviceUnitName('tree')), renderServiceUnit(TREE_TASK))
    const sent: ReplicationNotifyContext[] = []
    const r = await runDriftCheck({ executor: m, systemdDir: join(dir, 'units'), now: () => NOW, notify: async ctx => void sent.push(ctx) })
    assert.deepEqual(sent, [])
    assert.deepEqual(r.alerted, [])
  })

  it('a tree that cannot be read with a changed child: unknown, and the daily check stays silent (it alerts only on a confirmed modified)', async () => {
    const m = treeNode(editRow('datapool/rrdst/a', 'written', DRIFT_WRITE), { poolListFails: true })
    await writeFile(join(dir, 'units', serviceUnitName('tree')), renderServiceUnit(TREE_TASK))
    const sent: ReplicationNotifyContext[] = []
    const lines: string[] = []
    const r = await runDriftCheck({ executor: m, systemdDir: join(dir, 'units'), now: () => NOW, notify: async ctx => void sent.push(ctx), log: l => void lines.push(l) })
    assert.deepEqual(r.checked, ['tree'])
    assert.deepEqual(sent, [])
    assert.deepEqual(r.alerted, [])
    assert.ok(lines.includes('task=tree target=unknown'), lines.join(' / '))
  })

  it('a clean tree alerts nothing', async () => {
    const m = treeNode()
    await writeFile(join(dir, 'units', serviceUnitName('tree')), renderServiceUnit(TREE_TASK))
    const sent: ReplicationNotifyContext[] = []
    const r = await runDriftCheck({ executor: m, systemdDir: join(dir, 'units'), now: () => NOW, notify: async ctx => void sent.push(ctx) })
    assert.deepEqual(r.checked, ['tree'])
    assert.deepEqual(sent, [])
  })
})
