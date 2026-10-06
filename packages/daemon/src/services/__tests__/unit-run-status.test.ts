import type { CommandExecutor, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  deriveLastRun,
  deriveUnitRunStatus,
  lastRunFromJournal,
  lastSuccessFromJournal,
  parseHelperResult,
  readOnce,
  readUnitFileBirth,
  readUnitJournal,
  resultNotRetainedNote,
  SERVICE_STATUS_PROPS,
  TIMER_STATUS_PROPS,
  toSystemdRunResult,
  unitFileBirthMs,
} from '../unit-run-status.js'

/**
 * taskstatus.1 — the ONE last-run / verdict / next-run derivation every
 * units-as-store kind calls (backup, cloud sync, replication, snapshot
 * schedules). systemd keeps no service runtime property across a boot, so
 * after a reboot every row read "never run"; the precedence below is what each
 * kind now gets, proven here once (each store's suite proves only its wiring).
 *
 * No wall clock anywhere: every instant is a literal.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const JOURNALCTL = '/usr/bin/journalctl'
const SERVICE = 'anas-x-demo.service'
const TIMER = 'anas-x-demo.timer'

/** The post-reboot service snapshot (captured live on a production node). */
const REBOOTED = {
  ActiveState: 'inactive',
  Result: 'success',
  ExecMainStatus: '0',
  ExecMainExitTimestamp: '',
  InactiveEnterTimestamp: '',
}

const SUCCESS_LINE = '2026-10-05T02:00:07+0000 pve anas-x-demo[900]: {"task":"demo","result":{"status":"success","bytes":4096}}'
const SKIPPED_LINE = '2026-10-05T02:00:01+0000 pve anas-x-demo[901]: {"task":"demo","result":{"status":"skipped-off-week","reason":"ISO week 41 is odd"}}'
const CANCELLED_LINE = '2026-10-05T02:03:20+0000 pve anas-x-demo[902]: {"task":"demo","result":{"status":"cancelled","reason":"cancelled by alice@pve at 2026-10-05T02:03:11.000Z","cancelledBy":"alice@pve"}}'
const FAILURE_LINE = '2026-10-05T02:00:09+0000 pve anas-x-demo[903]: {"task":"demo","result":{"status":"failure"}}'
/** The snapshot runner prints the job result, which carries no `status`. */
const SCHEDULE_LINE = '2026-10-05T02:00:04+0000 pve anas-snap-demo[904]: {"schedule":"demo","result":{"schedule":"demo","taken":"anas-hourly-20261005T020000Z","pruned":[],"skippedHeld":[]}}'
const SYSTEMD_TRAILER = '2026-10-05T02:00:09+0000 pve systemd[1]: anas-x-demo.service: Deactivated successfully.'

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

function blob(props: Record<string, string>): string {
  return `${Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n')}\n`
}

/** A unit whose service, timer and journal answer as given. */
function unitMock(opts: {
  service: Record<string, string>
  nextRaw?: string
  lastTrigger?: string
  journal?: string
}): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: SYSTEMCTL, args: ['show', SERVICE, '-p', SERVICE_STATUS_PROPS], result: ok(blob(opts.service)) })
  mock.addFixture({ command: SYSTEMCTL, args: ['show', TIMER, '-p', TIMER_STATUS_PROPS], result: ok(`NextElapseUSecRealtime=${opts.nextRaw ?? ''}\nLastTriggerUSec=${opts.lastTrigger ?? ''}\n`) })
  mock.addFixture({ command: JOURNALCTL, args: ['-u', SERVICE, '-n', '200', '-o', 'short-iso', '--no-pager'], result: ok(opts.journal ?? '') })
  return mock
}

function derive(mock: MockExecutor, enabled = true): ReturnType<typeof deriveUnitRunStatus> {
  return deriveUnitRunStatus(mock, { serviceUnit: SERVICE, timerUnit: TIMER, enabled })
}

describe('unit run status — shape 1: live service properties win', () => {
  it('a run since boot answers from the service exactly as before — no journal, no trigger read', async () => {
    const mock = unitMock({
      service: { ...REBOOTED, ExecMainExitTimestamp: 'Mon 2026-10-05 14:00:09 UTC' },
      nextRaw: 'Mon 2026-10-05 15:00:00 UTC',
      lastTrigger: 'Mon 2026-10-05 14:00:00 UTC',
      journal: FAILURE_LINE,
    })
    const st = await derive(mock)
    assert.equal(st.source, 'live')
    assert.equal(st.lastRunResult, 'success')
    assert.equal(st.lastRunAt, '2026-10-05T14:00:09.000Z')
    assert.equal(st.nextRunAt, '2026-10-05T15:00:00.000Z')
    assert.equal(st.lastRunNote, undefined)
    assert.equal(st.runActive, false)
    assert.equal(mock.calls.some(c => c.command === JOURNALCTL), false)
    // One timer show answers both the next elapse and the last trigger.
    assert.equal(mock.calls.filter(c => c.args.includes(TIMER)).length, 1)
  })

  it('a unit running right now is live (running), whatever the journal holds', async () => {
    const st = await derive(unitMock({ service: { ...REBOOTED, ActiveState: 'activating' }, journal: SUCCESS_LINE }))
    assert.equal(st.source, 'live')
    assert.equal(st.lastRunResult, 'running')
    assert.equal(st.runActive, true)
  })

  it('a live cancelled run keeps its "cancelled by" note from the journal', async () => {
    const st = await deriveLastRun({
      serviceProps: { ...REBOOTED, ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: '130', ExecMainExitTimestamp: 'Mon 2026-10-05 02:03:20 UTC' },
      liveResult: 'cancelled',
      readJournal: async () => CANCELLED_LINE,
      lastTriggerRaw: undefined,
    })
    assert.equal(st.source, 'live')
    assert.equal(st.lastRunNote, 'cancelled by alice@pve at 2026-10-05T02:03:11.000Z')
  })
})

describe('unit run status — shape 2: empty props, the journal\'s last result line answers', () => {
  const cases: [string, string, string, string | undefined][] = [
    ['success', SUCCESS_LINE, '2026-10-05T02:00:07.000Z', undefined],
    ['skipped', SKIPPED_LINE, '2026-10-05T02:00:01.000Z', undefined],
    ['failure', FAILURE_LINE, '2026-10-05T02:00:09.000Z', undefined],
    ['cancelled', CANCELLED_LINE, '2026-10-05T02:03:20.000Z', 'cancelled by alice@pve at 2026-10-05T02:03:11.000Z'],
  ]
  for (const [status, line, at, note] of cases) {
    it(`a ${status} result line → ${status} at the line's time`, async () => {
      const st = await derive(unitMock({ service: REBOOTED, lastTrigger: 'Mon 2026-10-05 02:00:00 UTC', journal: [line, SYSTEMD_TRAILER].join('\n') }))
      assert.equal(st.source, 'journal')
      assert.equal(st.lastRunResult, status)
      assert.equal(st.lastRunAt, at)
      assert.equal(st.lastRunNote, note)
    })
  }

  it('a result line without a status (the snapshot/replication runners) is a completed run', async () => {
    const st = await derive(unitMock({ service: REBOOTED, journal: SCHEDULE_LINE }))
    assert.equal(st.lastRunResult, 'success')
    assert.equal(st.lastRunAt, '2026-10-05T02:00:04.000Z')
  })

  it('the NEWEST result line wins over older ones', async () => {
    const st = await derive(unitMock({ service: REBOOTED, journal: [SUCCESS_LINE, CANCELLED_LINE, SYSTEMD_TRAILER].join('\n') }))
    assert.equal(st.lastRunResult, 'cancelled')
  })

  it('a DISABLED unit with no live record reads `disabled` — the journal and timer rungs are not consulted', async () => {
    const mock = unitMock({ service: REBOOTED, lastTrigger: 'Mon 2026-10-05 02:00:00 UTC', journal: SUCCESS_LINE })
    const st = await derive(mock, false)
    assert.equal(st.lastRunResult, 'disabled')
    assert.equal(st.lastRunAt, null)
    assert.equal(st.source, 'none')
    assert.equal(st.lastRunNote, undefined)
    assert.equal(mock.calls.some(c => c.command === JOURNALCTL), false)
  })

  it('a DISABLED unit that ran since boot still reports that run (live wins)', async () => {
    const st = await derive(unitMock({ service: { ...REBOOTED, ExecMainExitTimestamp: 'Mon 2026-10-05 14:00:09 UTC' } }), false)
    assert.equal(st.source, 'live')
    assert.equal(st.lastRunResult, 'success')
  })

  it('a timer that fired AFTER the last result line means a newer run printed none → unknown at the trigger', async () => {
    const st = await derive(unitMock({ service: REBOOTED, lastTrigger: 'Tue 2026-10-06 02:00:00 UTC', journal: SUCCESS_LINE }))
    assert.equal(st.source, 'timer')
    assert.equal(st.lastRunResult, 'unknown')
    assert.equal(st.lastRunAt, '2026-10-06T02:00:00.000Z')
  })
})

describe('unit run status — shape 3: empty props, no result line, the timer stamp answers', () => {
  it('→ unknown at LastTriggerUSec with the not-retained note', async () => {
    const st = await derive(unitMock({ service: REBOOTED, lastTrigger: 'Mon 2026-10-05 02:00:00 UTC', journal: SYSTEMD_TRAILER }))
    assert.equal(st.source, 'timer')
    assert.equal(st.lastRunResult, 'unknown')
    assert.equal(st.lastRunAt, '2026-10-05T02:00:00.000Z')
    assert.equal(st.lastRunNote, 'ran at 2026-10-05 02:00 UTC; result not retained across the reboot')
    assert.equal(resultNotRetainedNote('2026-10-05T02:00:00.000Z'), st.lastRunNote)
  })
})

describe('unit run status — shape 4: nothing anywhere', () => {
  it('enabled → never-run, disabled → disabled, unreadable → unknown; no time', async () => {
    const on = await derive(unitMock({ service: REBOOTED }))
    assert.equal(on.source, 'none')
    assert.equal(on.lastRunResult, 'never-run')
    assert.equal(on.lastRunAt, null)
    assert.equal(on.lastRunNote, undefined)
    const off = await derive(unitMock({ service: REBOOTED }), false)
    assert.equal(off.lastRunResult, 'disabled')
    const blind = await derive(new MockExecutor())
    assert.equal(blind.lastRunResult, 'unknown')
    assert.equal(blind.nextRunAt, null)
  })
})

describe('unit run status — pure pieces', () => {
  it('lastRunFromJournal ignores non-result JSON and plain lines', () => {
    assert.equal(lastRunFromJournal(''), null)
    assert.equal(lastRunFromJournal(`${SYSTEMD_TRAILER}\n2026-10-05T02:00:09+0000 pve x[1]: {"progress":1}`), null)
  })

  it('ONE scanner, ONE status rule: an absent status is a success for the last run AND the last success', () => {
    assert.equal(lastSuccessFromJournal(SCHEDULE_LINE), '2026-10-05T02:00:04.000Z')
    assert.equal(lastSuccessFromJournal([SUCCESS_LINE, SKIPPED_LINE, FAILURE_LINE, CANCELLED_LINE].join('\n')), '2026-10-05T02:00:07.000Z')
    assert.equal(lastSuccessFromJournal([SKIPPED_LINE, FAILURE_LINE].join('\n')), null)
    assert.equal(lastSuccessFromJournal(''), null)
    // parseHelperResult finds the same newest line the derivation reads.
    assert.equal(parseHelperResult<{ status?: string }>([SUCCESS_LINE, FAILURE_LINE, SYSTEMD_TRAILER].join('\n'))?.status, 'failure')
    assert.equal(parseHelperResult(SYSTEMD_TRAILER), null)
  })

  it('readOnce makes one read however many callers ask', async () => {
    let reads = 0
    const read = readOnce(async () => {
      reads++
      return 'x'
    })
    assert.deepEqual(await Promise.all([read(), read(), read()]), ['x', 'x', 'x'])
    assert.equal(reads, 1)
  })

  it('toSystemdRunResult narrows skipped/cancelled to unknown for the systemd-vocabulary rows', () => {
    assert.equal(toSystemdRunResult('skipped'), 'unknown')
    assert.equal(toSystemdRunResult('cancelled'), 'unknown')
    assert.equal(toSystemdRunResult('success'), 'success')
    assert.equal(toSystemdRunResult('never-run'), 'never-run')
  })
})

// --- B1: the journal is bounded by the unit file's birth ---------------------

/** short-iso stamp (UTC) for an epoch-ms instant, the format journalctl prints. */
function journalStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}+0000`
}

/**
 * A systemctl/journalctl double whose journalctl honours `--since @<s>` the way
 * the real one does (verified on PVE 9 / systemd 257), over a canned journal.
 */
function sinceAwareExecutor(service: Record<string, string>, journalLines: string[]): CommandExecutor & { journalArgs: string[][] } {
  const mock = unitMock({ service })
  const journalArgs: string[][] = []
  const exec: CommandExecutor['exec'] = async (command, args) => {
    if (command !== JOURNALCTL)
      return mock.exec(command, args)
    journalArgs.push(args)
    const i = args.indexOf('--since')
    const sinceMs = i >= 0 ? Number(args[i + 1].slice(1)) * 1000 : Number.NEGATIVE_INFINITY
    return ok(journalLines.filter(l => Date.parse(l.split(' ')[0].replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) >= sinceMs).join('\n'))
  }
  return Object.assign(Object.create(mock) as CommandExecutor, { exec, journalArgs })
}

describe('unit run status — a unit\'s journal starts at its unit file\'s birth', () => {
  it('birth time when the filesystem reports one, else ctime', () => {
    assert.equal(unitFileBirthMs({ birthtimeMs: 1000, ctimeMs: 5000 }), 1000)
    assert.equal(unitFileBirthMs({ birthtimeMs: 0, ctimeMs: 5000 }), 5000)
  })

  it('an in-place rewrite (the stores\' writeFile) keeps the birth time; delete + create gets a new one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-unit-birth-'))
    try {
      const path = join(dir, SERVICE)
      await writeFile(path, '[Service]\n', 'utf-8')
      const born = await readUnitFileBirth(SERVICE, dir)
      assert.notEqual(born, null)
      if ((await stat(path)).birthtimeMs === 0)
        return // No birth time on this filesystem — the ctime fallback is pinned above.
      await new Promise(r => setTimeout(r, 20))
      await writeFile(path, '[Service]\nDescription=edited\n', 'utf-8')
      assert.equal(await readUnitFileBirth(SERVICE, dir), born)
      await unlink(path)
      await new Promise(r => setTimeout(r, 20))
      await writeFile(path, '[Service]\n', 'utf-8')
      assert.ok((await readUnitFileBirth(SERVICE, dir))! > born!)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('no unit file → unbounded read (fail-open), same argv as before', async () => {
    const mock = unitMock({ service: REBOOTED, journal: SUCCESS_LINE })
    assert.equal(await readUnitJournal(mock, SERVICE, '/nonexistent-anas-dir'), SUCCESS_LINE)
  })

  it('a RE-CREATED unit with a predecessor\'s result lines in the journal reads never-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-unit-birth-'))
    try {
      // The predecessor ran and printed its result; then the task was deleted
      // (timer stamp unlinked) and re-created under the same name.
      await writeFile(join(dir, SERVICE), '[Service]\n', 'utf-8')
      const born = (await readUnitFileBirth(SERVICE, dir))!
      const before = journalStamp(born - 3600_000)
      const executor = sinceAwareExecutor(REBOOTED, [
        `${before} pve anas-x-demo[900]: {"task":"demo","result":{"status":"success"}}`,
        `${before} pve systemd[1]: anas-x-demo.service: Deactivated successfully.`,
      ])
      const st = await deriveUnitRunStatus(executor, {
        serviceUnit: SERVICE,
        timerUnit: TIMER,
        enabled: true,
        readJournal: () => readUnitJournal(executor, SERVICE, dir),
      })
      assert.equal(st.lastRunResult, 'never-run')
      assert.equal(st.lastRunAt, null)
      assert.equal(st.source, 'none')
      assert.deepEqual(executor.journalArgs[0].slice(0, 4), ['-u', SERVICE, '--since', `@${Math.floor(born / 1000)}`])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an EDITED-in-place unit keeps its history: the run after creation still answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-unit-birth-'))
    try {
      await writeFile(join(dir, SERVICE), '[Service]\n', 'utf-8')
      const born = (await readUnitFileBirth(SERVICE, dir))!
      const ran = journalStamp(born + 2000)
      const executor = sinceAwareExecutor(REBOOTED, [
        `${ran} pve anas-x-demo[900]: {"task":"demo","result":{"status":"failure"}}`,
      ])
      // The edit: the store's in-place writeFile of the same unit.
      await writeFile(join(dir, SERVICE), '[Service]\nDescription=edited\n', 'utf-8')
      const st = await deriveUnitRunStatus(executor, {
        serviceUnit: SERVICE,
        timerUnit: TIMER,
        enabled: true,
        readJournal: () => readUnitJournal(executor, SERVICE, dir),
      })
      assert.equal(st.source, 'journal')
      assert.equal(st.lastRunResult, 'failure')
      assert.equal(st.lastRunAt, new Date(Math.floor((born + 2000) / 1000) * 1000).toISOString())
      assert.equal(executor.journalArgs[0][3], `@${Math.floor(born / 1000)}`)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
