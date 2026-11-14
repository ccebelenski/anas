import type { ReplicationTask } from '@anas/shared'
import type { ExecResult } from '../executor/types.js'
import type { ReplicationNotifyContext } from '../services/replication-notify.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../executor/mock.js'
import { zfsSnapshotDetailArgs } from '../parsers/zfs-list.js'
import { runDriftCheck } from '../repl-drift-check.js'
import { DRIFT_CHECK_SERVICE, DRIFT_CHECK_TIMER, renderDriftCheckService, renderDriftCheckTimer, syncDriftCheckUnits } from '../services/replication-check-units.js'
import { renderServiceUnit, serviceUnitName, timerUnitName } from '../services/replication-units.js'

/**
 * repl.drift, ruling 3 (operator 2026-11-15: "Daily alerts could be useful,
 * if a bit nag-like - I would reserve them for critical things only"): ONE
 * node-wide daily timer checks every ENABLED replication task whose last run
 * is older than 24 hours and alerts ONLY for `modified`. It sends nothing,
 * moves no hold, keeps no state; a task that ran within 24 hours is skipped
 * (its own run was the check). The units exist only while a task exists.
 */

const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const NOW = Date.parse('2026-11-15T12:00:00Z')

function snapJson(dataset: string, names: string[]): string {
  const datasets: Record<string, unknown> = {}
  names.forEach((n, i) => {
    datasets[`${dataset}@${n}`] = { name: `${dataset}@${n}`, type: 'SNAPSHOT', pool: dataset.split('/')[0], dataset, snapshot_name: n, createtxg: String(i + 1), properties: {} }
  })
  return JSON.stringify({ datasets })
}
const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

function task(name: string, over: Partial<ReplicationTask> = {}): ReplicationTask {
  return {
    name,
    source: { pool: 'tank', dataset: name },
    target: { pool: 'backup', dataset: name },
    schedule: 'weekly',
    snapshotFirst: true,
    enabled: true,
    notify: 'on-failure',
    ...over,
  }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'anas-repl-check-'))
  await mkdir(join(dir, 'units'), { recursive: true })
  await mkdir(join(dir, 'stamps'), { recursive: true })
  process.env.ANAS_TIMERS_STAMP_DIR = join(dir, 'stamps')
})
afterEach(async () => {
  delete process.env.ANAS_TIMERS_STAMP_DIR
  await rm(dir, { recursive: true, force: true })
})

async function store(...tasks: ReplicationTask[]): Promise<string> {
  const units = join(dir, 'units')
  for (const t of tasks)
    await writeFile(join(units, serviceUnitName(t.name)), renderServiceUnit(t))
  return units
}

/** A node: each task's source s1,s2 and target s1; systemd says its last run ended at `lastRun` (ISO). */
function node(tasks: { t: ReplicationTask, lastRun: string | null, state?: ExecResult, targetListings?: ExecResult[] }[]): MockExecutor {
  const m = new MockExecutor()
  m.clearFixtures()
  for (const { t, lastRun, state, targetListings } of tasks) {
    const src = `tank/${t.name}`
    const tgt = `backup/${t.name}`
    m.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs(src), result: ok(snapJson(src, ['s1', 's2'])) })
    // `targetListings`: the target's listing answers in call order (review P4's re-read).
    m.addFixture({ command: ZFS, args: zfsSnapshotDetailArgs(tgt), ...(targetListings ? { results: targetListings } : { result: ok(snapJson(tgt, ['s1'])) }) })
    m.addFixture({ command: ZFS, args: ['get', '-Hp', '-o', 'property,value,source', 'written@s1,readonly', '--', tgt], result: state ?? ok('written@s1\t0\tlocal\nreadonly\ton\tlocal\n') })
    // systemd's own form under TZ=UTC: `Thu 2026-11-12 03:00:00 UTC`.
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const stamp = lastRun === null ? '' : `${day[new Date(lastRun).getUTCDay()]} ${lastRun.slice(0, 10)} ${lastRun.slice(11, 19)} UTC`
    m.addFixture({ command: SYSTEMCTL, args: ['show', serviceUnitName(t.name), '-p', 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'], result: ok(`ActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=${stamp}\nInactiveEnterTimestamp=${stamp}\n`) })
    m.addFixture({ command: SYSTEMCTL, args: ['show', timerUnitName(t.name), '-p', 'NextElapseUSecRealtime,LastTriggerUSec'], result: ok('NextElapseUSecRealtime=0\nLastTriggerUSec=\n') })
  }
  m.addFixture({ command: ZFS, args: ['holds', '-H', '--'], result: ok('') })
  m.addFixture({ command: '/usr/bin/journalctl', result: ok('') })
  return m
}

const MODIFIED = ok('written@s1\t12288\tlocal\nreadonly\toff\tlocal\n')
const EXPOSED = ok('written@s1\t0\tlocal\nreadonly\toff\tlocal\n')

describe('repl.drift daily check — who is checked, who is told', () => {
  it('a task whose last run is within 24 hours is skipped: no read of its target at all', async () => {
    const t = task('recent')
    const m = node([{ t, lastRun: '2026-11-15T03:00:00Z', state: MODIFIED }])
    const sent: ReplicationNotifyContext[] = []
    const r = await runDriftCheck({ executor: m, systemdDir: await store(t), now: () => NOW, notify: async ctx => void sent.push(ctx) })
    assert.deepEqual(r.skipped, ['recent'])
    assert.deepEqual(sent, [])
    assert.deepEqual(m.calls.filter(c => c.command === ZFS), [], 'not even the listing')
  })

  it('a task last run 3 days ago whose target was changed: ONE notification with the drift sentence, as a failed run', async () => {
    const t = task('old')
    const m = node([{ t, lastRun: '2026-11-12T03:00:00Z', state: MODIFIED }])
    const sent: ReplicationNotifyContext[] = []
    const r = await runDriftCheck({ executor: m, systemdDir: await store(t), now: () => NOW, notify: async ctx => void sent.push(ctx) })
    assert.deepEqual(r.alerted, ['old'])
    assert.equal(sent.length, 1)
    assert.equal(sent[0].source, 'tank/old')
    assert.equal(sent[0].target, 'backup/old')
    assert.equal(sent[0].notify, 'on-failure')
    assert.equal(sent[0].result, undefined)
    // Review 2 (note a): no replication ran, so the notice carries the daily check's own verdict.
    assert.equal(sent[0].dailyCheck, true)
    assert.match(sent[0].error ?? '', /^The daily check of replication task 'old' found its target changed; no replication ran: Target 'backup\/old' has been changed since '@s1': 12\.00 KiB written/)
    // It only READ: no send, no receive, no hold, no release, no set.
    assert.deepEqual(m.pipelineCalls, [])
    assert.deepEqual(m.calls.filter(c => c.command === ZFS && ['hold', 'release', 'set', 'send', 'recv', 'rollback', 'snapshot'].includes(c.args[0])), [])
  })

  it('exposed and unknown are silent; clean is silent', async () => {
    const a = task('exposed')
    const b = task('unknown')
    const c = task('clean')
    const m = node([
      { t: a, lastRun: '2026-11-10T03:00:00Z', state: EXPOSED },
      { t: b, lastRun: '2026-11-10T03:00:00Z', state: { stdout: '', stderr: 'ssh: connect to host nas1 port 22: No route to host', exitCode: 255 } },
      { t: c, lastRun: '2026-11-10T03:00:00Z' },
    ])
    const sent: ReplicationNotifyContext[] = []
    const r = await runDriftCheck({ executor: m, systemdDir: await store(a, b, c), now: () => NOW, notify: async ctx => void sent.push(ctx) })
    assert.deepEqual(sent, [])
    assert.deepEqual(r.alerted, [])
    assert.deepEqual(new Set(r.checked), new Set(['clean', 'exposed', 'unknown']))
  })

  // Review N10 (reviewer probe p4, task 'futurelast'): a last run 48 hours
  // AHEAD of now counted as "ran within 24 hours" and was skipped.
  it('a last run in the future is not a run within 24 hours: the task is checked', async () => {
    const t = task('ahead')
    const m = node([{ t, lastRun: '2026-11-17T12:00:00Z', state: MODIFIED }])
    const sent: ReplicationNotifyContext[] = []
    const r = await runDriftCheck({ executor: m, systemdDir: await store(t), now: () => NOW, notify: async ctx => void sent.push(ctx) })
    assert.deepEqual(r.skipped, [])
    assert.deepEqual(r.checked, ['ahead'])
    assert.deepEqual(r.alerted, ['ahead'])
  })

  it('a last run exactly now, and one 23 hours ago, are within 24 hours: skipped', async () => {
    const a = task('justnow')
    const b = task('yesterday')
    const m = node([{ t: a, lastRun: '2026-11-15T12:00:00Z', state: MODIFIED }, { t: b, lastRun: '2026-11-14T13:00:00Z', state: MODIFIED }])
    const r = await runDriftCheck({ executor: m, systemdDir: await store(a, b), now: () => NOW, notify: async () => {} })
    assert.deepEqual(new Set(r.skipped), new Set(['justnow', 'yesterday']))
  })

  it('a disabled task is never checked; a task never run is checked', async () => {
    const off = task('off', { enabled: false })
    const fresh = task('fresh')
    const m = node([{ t: off, lastRun: null, state: MODIFIED }, { t: fresh, lastRun: null, state: MODIFIED }])
    const sent: ReplicationNotifyContext[] = []
    const r = await runDriftCheck({ executor: m, systemdDir: await store(off, fresh), now: () => NOW, notify: async ctx => void sent.push(ctx) })
    assert.deepEqual(r.alerted, ['fresh'])
    assert.ok(!m.calls.some(c => c.args.includes('tank/off') || c.args.includes('backup/off')))
  })

  it('one remote that is down (its read THROWS) does not stop the others', async () => {
    const down = task('down', { target: { pool: 'backup', dataset: 'down', location: { kind: 'remote', name: 'nas1' } } })
    const local = task('local')
    const m = node([{ t: local, lastRun: '2026-11-10T03:00:00Z', state: MODIFIED }, { t: down, lastRun: '2026-11-10T03:00:00Z' }])
    const sent: ReplicationNotifyContext[] = []
    const r = await runDriftCheck({
      executor: m,
      systemdDir: await store(down, local),
      now: () => NOW,
      notify: async ctx => void sent.push(ctx),
      readers: {
        names: async () => {
          throw new Error('ssh: connect to host nas1 port 22: Connection timed out')
        },
        zfs: async () => {
          throw new Error('unreachable')
        },
      },
    })
    assert.deepEqual(r.alerted, ['local'])
    assert.ok(r.checked.includes('down'))
    assert.equal(sent.length, 1)
  })

  it('no ssh at all when no task needs checking (every task ran within 24 hours)', async () => {
    const remote = task('r', { target: { pool: 'backup', dataset: 'r', location: { kind: 'remote', name: 'nas1' } } })
    const m = node([{ t: remote, lastRun: '2026-11-15T06:00:00Z' }])
    let opened = 0
    await runDriftCheck({
      executor: m,
      systemdDir: await store(remote),
      now: () => NOW,
      notify: async () => {},
      readers: {
        names: async () => {
          opened++
          return ['s1']
        },
        zfs: async () => {
          opened++
          return ok('')
        },
      },
    })
    assert.equal(opened, 0)
    assert.deepEqual(m.calls.filter(c => c.command === '/usr/bin/ssh'), [])
  })
})

// Review P4 (rule: the daily check never alerts on a verdict it cannot
// confirm). An ad-hoc Replicate is no unit, so `runActive` does not see it;
// its receive of s2 landing between the check's target listing ([s1]) and
// its `written@s1` read made an untouched target read `modified` and alert
// (reviewer probe p4, task 'inflight').
describe('repl.drift review P4 — a modified verdict is confirmed before it alerts', () => {
  /** After the receive of s2 lands, `written@s1` counts the received delta (the captured written-then-snapshotted value). */
  const RECEIVED = ok('written@s1\t14336\tlocal\nreadonly\ton\tlocal\n')

  it('a receive landing between the listing and the read: the listing changed, the verdict is dropped silently', async () => {
    const t = task('inflight')
    const m = node([{ t, lastRun: '2026-11-12T03:00:00Z', state: RECEIVED, targetListings: [ok(snapJson('backup/inflight', ['s1'])), ok(snapJson('backup/inflight', ['s1', 's2']))] }])
    const sent: ReplicationNotifyContext[] = []
    const lines: string[] = []
    const r = await runDriftCheck({ executor: m, systemdDir: await store(t), now: () => NOW, notify: async ctx => void sent.push(ctx), log: l => void lines.push(l) })
    assert.deepEqual(sent, [])
    assert.deepEqual(r.alerted, [])
    assert.deepEqual(r.checked, ['inflight'])
    assert.ok(lines.includes('task=inflight target=modified not confirmed: its snapshot listing changed or could not be read again; no alert'), lines.join('\n'))
    assert.equal(m.calls.filter(c => c.command === ZFS && c.args.join(' ') === zfsSnapshotDetailArgs('backup/inflight').join(' ')).length, 2, 'the listing is read twice')
  })

  it('a re-read that fails cannot confirm: no alert', async () => {
    const t = task('reread')
    const m = node([{ t, lastRun: '2026-11-12T03:00:00Z', state: MODIFIED, targetListings: [ok(snapJson('backup/reread', ['s1'])), { stdout: '', stderr: 'cannot open \'backup/reread\': I/O error', exitCode: 1 }] }])
    const sent: ReplicationNotifyContext[] = []
    await runDriftCheck({ executor: m, systemdDir: await store(t), now: () => NOW, notify: async ctx => void sent.push(ctx) })
    assert.deepEqual(sent, [])
  })

  it('an unchanged listing confirms: ONE alert, at the cost of one more listing', async () => {
    const t = task('still')
    const m = node([{ t, lastRun: '2026-11-12T03:00:00Z', state: MODIFIED }])
    const sent: ReplicationNotifyContext[] = []
    const r = await runDriftCheck({ executor: m, systemdDir: await store(t), now: () => NOW, notify: async ctx => void sent.push(ctx) })
    assert.deepEqual(r.alerted, ['still'])
    assert.equal(sent.length, 1)
    assert.equal(m.calls.filter(c => c.command === ZFS && c.args.join(' ') === zfsSnapshotDetailArgs('backup/still').join(' ')).length, 2)
  })

  it('a clean, exposed or unknown verdict costs no second listing', async () => {
    const t = task('calm')
    const m = node([{ t, lastRun: '2026-11-12T03:00:00Z', state: EXPOSED }])
    await runDriftCheck({ executor: m, systemdDir: await store(t), now: () => NOW, notify: async () => {} })
    assert.equal(m.calls.filter(c => c.command === ZFS && c.args.join(' ') === zfsSnapshotDetailArgs('backup/calm').join(' ')).length, 1)
  })
})

describe('repl.drift daily check — the node-wide units come with the first task and go with the last', () => {
  function systemctl(): MockExecutor {
    const m = new MockExecutor()
    m.clearFixtures()
    m.addFixture({ command: SYSTEMCTL, result: ok('') })
    return m
  }

  it('the unit contents: one oneshot service firing the runner, one daily Persistent timer, both marked', () => {
    assert.equal(renderDriftCheckService(), [
      '[Unit]',
      'Description=ANAS daily replication target check',
      '# X-ANAS-Unit=replication-drift-check',
      '',
      '[Service]',
      'Type=oneshot',
      'ExecStart=/usr/bin/node /opt/anas/packages/daemon/dist/repl-drift-check.js',
      '',
    ].join('\n'))
    assert.equal(renderDriftCheckTimer(), [
      '[Unit]',
      'Description=ANAS daily replication target check timer',
      '# X-ANAS-Unit=replication-drift-check',
      '',
      '[Timer]',
      'OnCalendar=daily',
      'Persistent=true',
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n'))
    assert.ok(!DRIFT_CHECK_SERVICE.startsWith('anas-repl-'), 'never inside the task store\'s unit prefix')
  })

  it('the first task installs and enables them; the last one\'s removal removes them, stamp and all', async () => {
    const units = await store(task('one'))
    const m = systemctl()
    assert.equal(await syncDriftCheckUnits(m, units), 'installed')
    assert.equal(await readFile(join(units, DRIFT_CHECK_SERVICE), 'utf-8'), renderDriftCheckService())
    assert.equal(await readFile(join(units, DRIFT_CHECK_TIMER), 'utf-8'), renderDriftCheckTimer())
    assert.deepEqual(m.calls.map(c => c.args.join(' ')), ['daemon-reload', `enable --now ${DRIFT_CHECK_TIMER}`])

    // A second task: nothing to do.
    await writeFile(join(units, serviceUnitName('two')), renderServiceUnit(task('two')))
    m.calls.length = 0
    assert.equal(await syncDriftCheckUnits(m, units), 'unchanged')
    assert.deepEqual(m.calls, [])

    // The last task goes.
    await rm(join(units, serviceUnitName('one')))
    await rm(join(units, serviceUnitName('two')))
    await writeFile(join(dir, 'stamps', `stamp-${DRIFT_CHECK_TIMER}`), '')
    assert.equal(await syncDriftCheckUnits(m, units), 'removed')
    await assert.rejects(readFile(join(units, DRIFT_CHECK_SERVICE)))
    await assert.rejects(readFile(join(units, DRIFT_CHECK_TIMER)))
    await assert.rejects(readFile(join(dir, 'stamps', `stamp-${DRIFT_CHECK_TIMER}`)))
    const calls: { args: string[] }[] = m.calls
    assert.ok(calls.some(c => c.args.join(' ') === `disable --now ${DRIFT_CHECK_TIMER}`))
  })

  it('a unit of that name without ANAS\'s marker is never overwritten or removed', async () => {
    const units = await store(task('one'))
    await writeFile(join(units, DRIFT_CHECK_SERVICE), '[Service]\nExecStart=/bin/true\n')
    const m = systemctl()
    assert.equal(await syncDriftCheckUnits(m, units), 'foreign')
    assert.equal(await readFile(join(units, DRIFT_CHECK_SERVICE), 'utf-8'), '[Service]\nExecStart=/bin/true\n')
    assert.deepEqual(m.calls, [])
  })

  // Review P6 (reviewer probe p6 step 7): the last task's delete overlapping
  // another task's create left one task and no daily-check units.
  it('a delete\'s sync and a create\'s sync that overlap leave the units installed for the task that remains', async () => {
    const units = join(dir, 'units')
    await writeFile(join(units, DRIFT_CHECK_SERVICE), renderDriftCheckService())
    await writeFile(join(units, DRIFT_CHECK_TIMER), renderDriftCheckTimer())
    const m = systemctl()
    // The delete's best-effort `disable` takes a while (the window the race lived in).
    const slow = m.exec.bind(m)
    m.exec = (async (cmd: string, args: string[], o?: unknown) => {
      if (args[0] === 'disable')
        await new Promise(r => setTimeout(r, 50))
      return slow(cmd, args, o as never)
    }) as typeof m.exec
    const deleting = syncDriftCheckUnits(m, units) // the store has no task
    await new Promise(r => setTimeout(r, 10))
    await writeFile(join(units, serviceUnitName('b')), renderServiceUnit(task('b'))) // the create job wrote its units
    const creating = syncDriftCheckUnits(m, units)
    assert.equal(await deleting, 'removed')
    assert.equal(await creating, 'installed')
    assert.equal(await readFile(join(units, DRIFT_CHECK_SERVICE), 'utf-8'), renderDriftCheckService())
    assert.equal(await readFile(join(units, DRIFT_CHECK_TIMER), 'utf-8'), renderDriftCheckTimer())
  })

  it('a sync that fails does not block the next one', async () => {
    const units = await store(task('one'))
    const failing = { exec: async () => {
      throw new Error('spawn EAGAIN')
    } } as unknown as MockExecutor
    await assert.rejects(syncDriftCheckUnits(failing, units))
    await rm(join(units, DRIFT_CHECK_SERVICE), { force: true })
    await rm(join(units, DRIFT_CHECK_TIMER), { force: true })
    assert.equal(await syncDriftCheckUnits(systemctl(), units), 'installed')
  })

  it('a task store that could not be read in full and lists nothing leaves the units as they are', async () => {
    const units = join(dir, 'units')
    await writeFile(join(units, serviceUnitName('broken')), 'not a task')
    await writeFile(join(units, DRIFT_CHECK_SERVICE), renderDriftCheckService())
    await writeFile(join(units, DRIFT_CHECK_TIMER), renderDriftCheckTimer())
    const m = systemctl()
    assert.equal(await syncDriftCheckUnits(m, units), 'unchanged')
    assert.equal(await readFile(join(units, DRIFT_CHECK_SERVICE), 'utf-8'), renderDriftCheckService())
  })
})
