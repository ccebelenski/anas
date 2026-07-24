import type { ReplicationTask } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { zfsSnapshotDetailArgs } from '../../parsers/zfs-list.js'
import {
  buildReplicationWarnings,
  collectTaskStatuses,
  deriveTaskStatus,
  parseServiceUnit,
  readAllTasks,
  removeTaskUnits,
  renderServiceUnit,
  renderTimerUnit,
  serviceUnitName,
  timerUnitName,
  validateSchedule,
  writeTaskUnits,
} from '../replication-units.js'

const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'
const ZFS = '/usr/sbin/zfs'

/** Minimal `zfs list -t snapshot -j`; higher txg = newer (parser sorts by it). */
function snapshotListJson(dataset: string, snaps: { name: string, txg: number, creation?: string }[]): string {
  const datasets: Record<string, unknown> = {}
  for (const s of snaps) {
    const full = `${dataset}@${s.name}`
    datasets[full] = {
      name: full,
      type: 'SNAPSHOT',
      pool: dataset.split('/')[0],
      dataset,
      snapshot_name: s.name,
      createtxg: String(s.txg),
      properties: s.creation ? { creation: { value: s.creation } } : {},
    }
  }
  return JSON.stringify({ datasets })
}

function makeTask(over: Partial<ReplicationTask> = {}): ReplicationTask {
  return {
    name: 'nightly-media',
    source: { pool: 'testpool', dataset: 'media' },
    target: { pool: 'backup', dataset: 'media' },
    schedule: 'daily',
    snapshotFirst: true,
    enabled: true,
    ...over,
  }
}

describe('replication units (Epic 5.5.3 — units are the store)', () => {
  // --- round-trip: generate → parse → deep-equal ---------------------------
  it('task ⇄ service unit round-trips through the X-ANAS-Task JSON', () => {
    for (const task of [
      makeTask(),
      makeTask({ name: 'poolroot', source: { pool: 'testpool', dataset: '' }, target: { pool: 'backup' }, snapshotFirst: false, enabled: false }),
      makeTask({ schedule: 'Mon *-*-* 03:00:00', target: { pool: 'backup', dataset: 'archive/media' } }),
    ]) {
      const unit = renderServiceUnit(task)
      const parsed = parseServiceUnit(unit)
      assert.deepEqual(parsed, task)
    }
  })

  it('renders a oneshot service with an ExecStart into the dist runner', () => {
    const unit = renderServiceUnit(makeTask())
    assert.match(unit, /Type=oneshot/)
    assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/anas\/packages\/daemon\/dist\/replicate-task\.js/)
    assert.match(unit, /--pool testpool --dataset media --target-pool backup --target-dataset media --snapshot-first/)
    assert.match(unit, /Description=ANAS replication task nightly-media/)
  })

  it('renders a timer with OnCalendar + Persistent + timers.target', () => {
    const unit = renderTimerUnit(makeTask({ schedule: '02:00' }))
    assert.match(unit, /OnCalendar=02:00/)
    assert.match(unit, /Persistent=true/)
    assert.match(unit, /WantedBy=timers\.target/)
  })

  it('stage-3: X-ANAS-Task round-trips a target.location and ExecStart emits it', () => {
    const remote = makeTask({ target: { pool: 'backup', dataset: 'media', location: { kind: 'remote', name: 'nas1' } } })
    assert.deepEqual(parseServiceUnit(renderServiceUnit(remote)), remote)
    assert.match(renderServiceUnit(remote), /--location-kind remote --location-name nas1/)

    const peer = makeTask({ target: { pool: 'backup', dataset: 'media', location: { kind: 'peer', name: 'node2' } } })
    assert.match(renderServiceUnit(peer), /--location-kind peer --location-name node2/)
  })

  it('stage-3: a local (default) target emits NO --location-* args', () => {
    const unit = renderServiceUnit(makeTask({ target: { pool: 'backup', dataset: 'media', location: { kind: 'local' } } }))
    assert.doesNotMatch(unit, /--location-kind/)
  })

  it('pool-root source emits --dataset "" and no --target-dataset by default', () => {
    const unit = renderServiceUnit(makeTask({ source: { pool: 'testpool', dataset: '' }, target: { pool: 'backup' }, snapshotFirst: false }))
    assert.match(unit, /--pool testpool --dataset "" --target-pool backup(\n|$)/)
    assert.doesNotMatch(unit, /--target-dataset/)
    assert.doesNotMatch(unit, /--snapshot-first/)
  })

  it('parseServiceUnit returns null for a file without the marker', () => {
    assert.equal(parseServiceUnit('[Unit]\nDescription=something else\n'), null)
  })

  // --- belt-and-suspenders: the unit writer refuses newline-bearing argv ----
  // (the schema already forbids such datasets from reaching here — this proves
  // the ExecStart writer is a hard boundary in its own right).
  it('renderServiceUnit throws on a newline in a runner argument (unit injection)', () => {
    const evil = makeTask({ source: { pool: 'testpool', dataset: 'media\nExecStart=/bin/sh -c id' } })
    assert.throws(() => renderServiceUnit(evil), /newline or carriage return/)
    const evilCr = makeTask({ target: { pool: 'backup', dataset: 'media\rfoo' } })
    assert.throws(() => renderServiceUnit(evilCr), /newline or carriage return/)
  })

  it('parseServiceUnit returns null for invalid task JSON', () => {
    assert.equal(parseServiceUnit('# X-ANAS-Task={"name":"BAD NAME","schedule":""}\n'), null)
  })

  // --- schedule validation via systemd-analyze -----------------------------
  it('validateSchedule → ok on exit 0', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMD_ANALYZE, args: ['calendar', 'daily'], result: { stdout: '  Normalized form: *-*-* 00:00:00\n', stderr: '', exitCode: 0 } })
    assert.deepEqual(await validateSchedule(mock, 'daily'), { ok: true })
  })

  it('validateSchedule → surfaces systemd stderr on failure', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMD_ANALYZE, args: ['calendar', 'notacal'], result: { stdout: '', stderr: 'Failed to parse calendar specification: Invalid argument', exitCode: 1 } })
    const r = await validateSchedule(mock, 'notacal')
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /Failed to parse calendar/)
  })

  // --- CRUD file lifecycle against a temp SYSTEMD dir ----------------------
  describe('CRUD lifecycle (temp dir + mocked systemctl)', () => {
    let dir: string
    let mock: MockExecutor

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'anas-units-'))
      mock = new MockExecutor()
      // systemctl daemon-reload / enable / disable all succeed (command-only).
      mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('writeTaskUnits writes both files, reloads, and enables the timer', async () => {
      const task = makeTask({ enabled: true })
      await writeTaskUnits(mock, dir, task)

      const files = (await readdir(dir)).sort()
      assert.deepEqual(files, [serviceUnitName(task.name), timerUnitName(task.name)].sort())
      // Round-trips from what we wrote.
      const parsed = parseServiceUnit(await readFile(join(dir, serviceUnitName(task.name)), 'utf-8'))
      assert.deepEqual(parsed, task)

      const cmds = mock.calls.map(c => c.args.join(' '))
      assert.ok(cmds.includes('daemon-reload'))
      assert.ok(cmds.includes(`enable --now ${timerUnitName(task.name)}`))
    })

    it('writeTaskUnits with enabled=false disables the timer', async () => {
      const task = makeTask({ enabled: false })
      await writeTaskUnits(mock, dir, task)
      const cmds = mock.calls.map(c => c.args.join(' '))
      assert.ok(cmds.includes(`disable --now ${timerUnitName(task.name)}`))
      assert.ok(!cmds.some(c => c.startsWith('enable ')))
    })

    it('removeTaskUnits deletes both files and disables the timer; leaves nothing else', async () => {
      const task = makeTask()
      await writeTaskUnits(mock, dir, task)
      // A stray unrelated file must survive removal.
      await writeFile(join(dir, 'keep.txt'), 'x')
      await removeTaskUnits(mock, dir, task.name)

      assert.deepEqual(await readdir(dir), ['keep.txt'])
      const cmds = mock.calls.map(c => c.args.join(' '))
      assert.ok(cmds.includes(`disable --now ${timerUnitName(task.name)}`))
    })

    it('readAllTasks parses valid units and skips invalid ones (fail-open)', async () => {
      await writeTaskUnits(mock, dir, makeTask({ name: 'one' }))
      await writeTaskUnits(mock, dir, makeTask({ name: 'two' }))
      // An anas-repl service file with no marker → skipped, not fatal.
      await writeFile(join(dir, serviceUnitName('broken')), '[Unit]\nDescription=broken\n')
      const names = (await readAllTasks(dir)).map(t => t.name).sort()
      assert.deepEqual(names, ['one', 'two'])
    })

    it('readAllTasks on a missing dir returns []', async () => {
      assert.deepEqual(await readAllTasks(join(dir, 'does-not-exist')), [])
    })
  })

  // --- status derivation ---------------------------------------------------
  describe('deriveTaskStatus (ZFS lag + systemd result mocked)', () => {
    function statusMock(opts: {
      source?: { name: string, txg: number, creation?: string }[]
      target?: { name: string, txg: number }[]
      active?: string
      result?: string
      nextUsec?: string
    }): MockExecutor {
      const mock = new MockExecutor()
      mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/media'), result: { stdout: opts.source ? snapshotListJson('testpool/media', opts.source) : '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs('backup/media'), result: { stdout: opts.target ? snapshotListJson('backup/media', opts.target) : '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: SYSTEMCTL, args: ['show', serviceUnitName('nightly-media'), '-p', 'ActiveState,Result,ExecMainStatus'], result: { stdout: `ActiveState=${opts.active ?? 'inactive'}\nResult=${opts.result ?? 'success'}\nExecMainStatus=0\n`, stderr: '', exitCode: 0 } })
      mock.addFixture({ command: SYSTEMCTL, args: ['show', timerUnitName('nightly-media'), '-p', 'NextElapseUSecRealtime'], result: { stdout: `NextElapseUSecRealtime=${opts.nextUsec ?? '0'}\n`, stderr: '', exitCode: 0 } })
      return mock
    }

    it('current: newest source snapshot is on the target → 0 behind', async () => {
      const mock = statusMock({
        source: [{ name: 's2', txg: 200, creation: 'Wed Jul 15 3:00 2026' }, { name: 's1', txg: 100, creation: 'Tue Jul 14 3:00 2026' }],
        target: [{ name: 's2', txg: 200 }, { name: 's1', txg: 100 }],
        result: 'success',
      })
      const st = await deriveTaskStatus(mock, makeTask())
      assert.equal(st.lastReplicatedSnapshot, 's2')
      assert.equal(st.snapshotsBehind, 0)
      assert.equal(st.lastRunResult, 'success')
      assert.notEqual(st.lastReplicatedAt, null)
    })

    it('behind: target has the older snapshot only → 1 behind', async () => {
      const mock = statusMock({
        source: [{ name: 's2', txg: 200 }, { name: 's1', txg: 100 }],
        target: [{ name: 's1', txg: 100 }],
      })
      const st = await deriveTaskStatus(mock, makeTask())
      assert.equal(st.lastReplicatedSnapshot, 's1')
      assert.equal(st.snapshotsBehind, 1)
    })

    it('never replicated: no common snapshot → all source snaps behind, null last', async () => {
      const mock = statusMock({
        source: [{ name: 's2', txg: 200 }, { name: 's1', txg: 100 }],
        target: [],
      })
      const st = await deriveTaskStatus(mock, makeTask())
      assert.equal(st.lastReplicatedSnapshot, null)
      assert.equal(st.lastReplicatedAt, null)
      assert.equal(st.snapshotsBehind, 2)
    })

    it('source gone / no snapshots → nulls', async () => {
      const mock = statusMock({ source: undefined })
      const st = await deriveTaskStatus(mock, makeTask())
      assert.equal(st.lastReplicatedSnapshot, null)
      assert.equal(st.snapshotsBehind, null)
    })

    it('systemd failure result → lastRunResult failure; running while active', async () => {
      const failed = await deriveTaskStatus(statusMock({ source: [{ name: 's1', txg: 1 }], target: [], active: 'failed', result: 'exit-code' }), makeTask())
      assert.equal(failed.lastRunResult, 'failure')
      const running = await deriveTaskStatus(statusMock({ source: [{ name: 's1', txg: 1 }], target: [], active: 'activating', result: '' }), makeTask())
      assert.equal(running.lastRunResult, 'running')
    })

    it('nextRunAt derived from NextElapseUSecRealtime (µs since epoch)', async () => {
      const usec = String(Date.UTC(2026, 6, 20, 2, 0, 0) * 1000)
      const st = await deriveTaskStatus(statusMock({ source: [{ name: 's1', txg: 1 }], target: [{ name: 's1', txg: 1 }], nextUsec: usec }), makeTask())
      assert.equal(st.nextRunAt, '2026-07-20T02:00:00.000Z')
    })

    it('nextRunAt parses the HUMAN date string systemctl actually prints', async () => {
      // Verified live on PVE 9 / systemd 257: `systemctl show -p
      // NextElapseUSecRealtime` prints "Fri 2026-07-17 00:00:00 UTC", not µs.
      const st = await deriveTaskStatus(statusMock({ source: [{ name: 's1', txg: 1 }], target: [{ name: 's1', txg: 1 }], nextUsec: 'Fri 2026-07-17 00:00:00 UTC' }), makeTask())
      assert.equal(st.nextRunAt, '2026-07-17T00:00:00.000Z')
    })

    it('nextRunAt null on n/a and infinity sentinels', async () => {
      for (const v of ['n/a', 'infinity', '0']) {
        const st = await deriveTaskStatus(statusMock({ source: [{ name: 's1', txg: 1 }], target: [{ name: 's1', txg: 1 }], nextUsec: v }), makeTask())
        assert.equal(st.nextRunAt, null, `sentinel ${v}`)
      }
    })
  })

  // --- warnings ------------------------------------------------------------
  it('buildReplicationWarnings emits one replication warning per failed task', () => {
    const warnings = buildReplicationWarnings([
      { task: makeTask({ name: 'good' }), lastReplicatedSnapshot: 's', lastReplicatedAt: null, snapshotsBehind: 0, lastRunResult: 'success', nextRunAt: null },
      { task: makeTask({ name: 'bad' }), lastReplicatedSnapshot: null, lastReplicatedAt: null, snapshotsBehind: 3, lastRunResult: 'failure', nextRunAt: null },
    ])
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].category, 'replication')
    assert.equal(warnings[0].level, 'warning')
    assert.equal(warnings[0].ref, 'bad')
    assert.match(warnings[0].message, /Replication task 'bad' last run failed/)
  })

  it('collectTaskStatuses reads the store and derives each task', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-units-'))
    try {
      const mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      await writeTaskUnits(mock, dir, makeTask({ name: 'a' }))
      await writeTaskUnits(mock, dir, makeTask({ name: 'b' }))
      const statuses = await collectTaskStatuses(mock, dir)
      assert.deepEqual(statuses.map(s => s.task.name).sort(), ['a', 'b'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
