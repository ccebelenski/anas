import type { AhrScrubSchedule } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  ForeignUnitError,
  parseScrubServiceUnit,
  readScrubSchedule,
  readScrubTimerNext,
  removeScrubUnits,
  renderScrubServiceUnit,
  renderScrubTimerUnit,
  SCRUB_SERVICE_NAME,
  SCRUB_TIMER_NAME,
  scrubCadenceToOnCalendar,
  scrubStampPath,
  scrubUnitsAreForeign,
  writeScrubUnits,
} from '../scrub-schedule-units.js'
import { useStampDir } from './stamp-dir.js'

const SYSTEMCTL = '/usr/bin/systemctl'

function schedule(over: Partial<AhrScrubSchedule> = {}): AhrScrubSchedule {
  return { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0'], ...over }
}

describe('scrub schedule units — cadence → OnCalendar (selfheal.4)', () => {
  it('monthly = 1st Sunday 03:00 (matches PVE\'s ZFS cron and old mdcheck)', () => {
    assert.equal(scrubCadenceToOnCalendar('monthly'), 'Sun *-*-01..07 03:00:00')
  })

  it('quarterly = 1st Sunday of Jan/Apr/Jul/Oct 03:00', () => {
    assert.equal(scrubCadenceToOnCalendar('quarterly'), 'Sun *-01,04,07,10-01..07 03:00:00')
  })

  it('the timer unit carries the OnCalendar, Persistent=true and the install target', () => {
    for (const cadence of ['monthly', 'quarterly'] as const) {
      const timer = renderScrubTimerUnit(schedule({ cadence }))
      assert.match(timer, new RegExp(`OnCalendar=${scrubCadenceToOnCalendar(cadence).replace(/\*/g, '\\*')}`))
      assert.match(timer, /Persistent=true/)
      assert.match(timer, /WantedBy=timers\.target/)
    }
  })
})

describe('scrub schedule units — the unit files ARE the store', () => {
  it('schedule ⇄ service unit round-trips through the X-ANAS-Schedule JSON', () => {
    for (const s of [
      schedule(),
      schedule({ cadence: 'quarterly', pools: ['ahr0', 'ahr1'] }),
      schedule({ pools: [] }),
    ]) {
      const unit = renderScrubServiceUnit(s)
      assert.deepEqual(parseScrubServiceUnit(unit), s)
      // ExecStart fires the runner with the pool list as argv; never parsed back.
      assert.match(unit, new RegExp(`ExecStart=.*scrub-task\\.js( ${s.pools.join(' ')})?$`, 'm'))
      assert.match(unit, /Type=oneshot/)
      // The marker rides a comment — a file systemd itself parses never chokes.
      assert.match(unit, /^# X-ANAS-Schedule=/m)
    }
  })

  it('parseScrubServiceUnit returns null without the marker or with bad JSON/schema', () => {
    assert.equal(parseScrubServiceUnit('[Unit]\nDescription=x\n'), null)
    assert.equal(parseScrubServiceUnit('# X-ANAS-Schedule={not json\n'), null)
    // A marker with the WRONG kind (a snapshot schedule copy-pasted in) never adopts.
    assert.equal(parseScrubServiceUnit('# X-ANAS-Schedule={"kind":"snapshot","id":"x"}\n'), null)
  })

  it('a unit without our marker is never adopted (readScrubSchedule → null)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-scrub-units-'))
    try {
      await writeFile(join(dir, SCRUB_SERVICE_NAME), '[Unit]\nDescription=someone else\'s\n')
      assert.equal(await readScrubSchedule(dir), null)
      assert.equal(await readScrubSchedule(join(dir, 'nope')), null)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('scrub schedule units — CRUD lifecycle (temp dir + mocked systemctl)', () => {
  let dir: string
  let stampDir: string
  let restoreStampDir: () => void
  let mock: MockExecutor

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-scrub-units-'))
    // The stamp path is computed per call from this env override, so the test
    // never touches the real /var/lib/systemd/timers — and it sits OUTSIDE the
    // unit dir, whose contents the lifecycle tests assert on. The save/restore
    // is the ONE shared helper (review D1 — the hand-copied dance is where the
    // omission happened).
    ;({ stampDir, restore: restoreStampDir } = await useStampDir())
    mock = new MockExecutor()
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
  })
  afterEach(async () => {
    restoreStampDir()
    await rm(dir, { recursive: true, force: true })
    await rm(stampDir, { recursive: true, force: true })
  })

  it('writeScrubUnits writes both files, reloads, enables the timer', async () => {
    await writeScrubUnits(mock, dir, schedule({ pools: ['ahr0', 'ahr1'] }))
    assert.deepEqual((await readdir(dir)).sort(), [SCRUB_SERVICE_NAME, SCRUB_TIMER_NAME].sort())
    assert.deepEqual(await readScrubSchedule(dir), schedule({ pools: ['ahr0', 'ahr1'] }))
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes('daemon-reload'))
    assert.ok(cmds.includes(`enable --now ${SCRUB_TIMER_NAME}`))
  })

  it('removeScrubUnits disables the timer, deletes stamp + both files, resets failed, reloads', async () => {
    // The stamp is systemd's own bookkeeping — a leftover one makes the next
    // enable start the whole scrub immediately (review R10).
    await writeFile(join(stampDir, `stamp-${SCRUB_TIMER_NAME}`), '')
    await writeFile(join(stampDir, 'stamp-anas-scrub-untouched.timer'), '')
    await writeScrubUnits(mock, dir, schedule())
    await removeScrubUnits(mock, dir)
    assert.deepEqual(await readdir(dir), [])
    assert.deepEqual(await readdir(stampDir), ['stamp-anas-scrub-untouched.timer'])
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes(`disable --now ${SCRUB_TIMER_NAME}`))
    assert.equal(cmds.filter(c => c === 'daemon-reload').length, 2)
    // The failed-state ghost goes too (review R2, the task stores' shape):
    // one reset-failed per unit, each exit ignored.
    assert.ok(cmds.includes(`reset-failed ${SCRUB_SERVICE_NAME}`))
    assert.ok(cmds.includes(`reset-failed ${SCRUB_TIMER_NAME}`))
  })

  it('writeScrubUnits throws on a systemctl failure so the mutation surfaces it', async () => {
    // Exact-args match wins over the beforeEach success fixture.
    mock.addFixture({ command: SYSTEMCTL, args: ['daemon-reload'], result: { stdout: '', stderr: 'failed to reload', exitCode: 1 } })
    await assert.rejects(() => writeScrubUnits(mock, dir, schedule()), /failed to reload/)
  })

  it('writeScrubUnits REFUSES a marker-less existing unit — never overwritten (review R10)', async () => {
    const foreign = '[Unit]\nDescription=someone else\'s unit on ANAS\'s fixed name\n'
    await writeFile(join(dir, SCRUB_SERVICE_NAME), foreign)
    await assert.rejects(
      () => writeScrubUnits(mock, dir, schedule()),
      (err: Error) => err instanceof ForeignUnitError && err.code === 'foreign-unit',
    )
    // The file is byte-identical, the timer file was never created, and systemd
    // was never asked to do anything.
    assert.equal(await readFile(join(dir, SCRUB_SERVICE_NAME), 'utf-8'), foreign)
    assert.deepEqual(await readdir(dir), [SCRUB_SERVICE_NAME])
    assert.equal(mock.calls.length, 0)
    // The route's pre-check reads the same answer.
    assert.equal(await scrubUnitsAreForeign(dir), true)
  })

  it('a file WITH the marker is ours to rewrite, even with corrupt JSON inside', async () => {
    await writeFile(join(dir, SCRUB_SERVICE_NAME), '# X-ANAS-Schedule={not json\n')
    assert.equal(await scrubUnitsAreForeign(dir), false, 'corrupt but OURS — not foreign')
    await writeScrubUnits(mock, dir, schedule())
    assert.deepEqual(await readScrubSchedule(dir), schedule())
  })

  it('the rendered timer carries the marker too (review F13)', () => {
    assert.match(renderScrubTimerUnit(schedule()), /X-ANAS-Schedule=/)
    // And a written pair leaves BOTH files marked.
    return writeScrubUnits(mock, dir, schedule()).then(async () => {
      const timer = await readFile(join(dir, SCRUB_TIMER_NAME), 'utf-8')
      assert.match(timer, /X-ANAS-Schedule=/)
    })
  })

  it('a TIMER-only foreign unit is refused (review F13) — the check covers both files', async () => {
    await writeFile(join(dir, SCRUB_TIMER_NAME), '[Timer]\nOnCalendar=daily\n')
    await assert.rejects(
      () => writeScrubUnits(mock, dir, schedule()),
      (err: Error) => err instanceof ForeignUnitError && err.code === 'foreign-unit',
    )
    assert.equal(await readFile(join(dir, SCRUB_TIMER_NAME), 'utf-8'), '[Timer]\nOnCalendar=daily\n')
    assert.equal(await readdir(dir).then(f => f.length), 1, 'the service was never created')
    assert.equal(mock.calls.length, 0)
  })

  it('a SERVICE-only foreign unit is refused even with no timer present (review F13)', async () => {
    await writeFile(join(dir, SCRUB_SERVICE_NAME), '[Service]\nExecStart=/bin/true\n')
    assert.equal(await scrubUnitsAreForeign(dir), true)
    await assert.rejects(() => writeScrubUnits(mock, dir, schedule()), ForeignUnitError)
  })

  it('a marker-less TIMER beside an OURS service is the LEGACY pre-F13 pair — adopted, not foreign (review F13, third pass)', async () => {
    // The stunt node's on-disk pair: the intermediate build rendered the
    // schedule marker into the service only, so the timer beside it carries
    // none. Refusing it made every toggle PUT 409 foreign-unit in BOTH
    // directions — the timer could never be turned off from the UI.
    await writeFile(join(dir, SCRUB_SERVICE_NAME), renderScrubServiceUnit(schedule()))
    await writeFile(
      join(dir, SCRUB_TIMER_NAME),
      '[Unit]\nDescription=ANAS periodic AHR scrub timer\n\n[Timer]\nOnCalendar=daily\nPersistent=true\n',
    )
    assert.equal(await scrubUnitsAreForeign(dir), false, 'a marked service vouches for the timer beside it')
    assert.equal(mock.calls.length, 0, 'the read alone touched nothing')
    // Adoption: the next write re-renders BOTH files, the timer with its marker.
    await writeScrubUnits(mock, dir, schedule({ pools: ['ahr0', 'ahr1'] }))
    assert.match(await readFile(join(dir, SCRUB_TIMER_NAME), 'utf-8'), /X-ANAS-Schedule=/)
    assert.deepEqual(await readScrubSchedule(dir), schedule({ pools: ['ahr0', 'ahr1'] }))
  })

  it('a failed enable ROLLS BACK both files (review F14) — the next attempt is clean', async () => {
    mock.addFixture({ command: SYSTEMCTL, args: ['enable', '--now', SCRUB_TIMER_NAME], result: { stdout: '', stderr: 'enable failed', exitCode: 1 } })
    await assert.rejects(() => writeScrubUnits(mock, dir, schedule()), /enable failed/)
    assert.deepEqual(await readdir(dir), [], 'no half-written pair left behind')
    // Clean next attempt: the store reads no schedule, the foreign check is false.
    assert.equal(await scrubUnitsAreForeign(dir), false)
  })

  it('a failed enable RESTORES the previous pair (review F14) — an update does not destroy the old schedule', async () => {
    await writeScrubUnits(mock, dir, schedule({ pools: ['ahr0', 'ahr1'] }))
    mock.addFixture({ command: SYSTEMCTL, args: ['enable', '--now', SCRUB_TIMER_NAME], result: { stdout: '', stderr: 'enable failed', exitCode: 1 } })
    await assert.rejects(() => writeScrubUnits(mock, dir, schedule({ pools: ['ahr0'] })), /enable failed/)
    assert.deepEqual(await readScrubSchedule(dir), { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0', 'ahr1'] }, 'the previous schedule survived the failed rewrite')
    assert.deepEqual((await readdir(dir)).sort(), [SCRUB_SERVICE_NAME, SCRUB_TIMER_NAME].sort())
  })

  it('a failed FIRST write also DISABLES the half-enabled timer (third pass) — no dangling wants symlink', async () => {
    // `enable --now` enables BEFORE it starts: a failed start leaves the
    // timers.target.wants symlink pointing at a file the rollback deletes —
    // enablement must ride the files back down.
    mock.addFixture({ command: SYSTEMCTL, args: ['enable', '--now', SCRUB_TIMER_NAME], result: { stdout: '', stderr: 'enable failed', exitCode: 1 } })
    await assert.rejects(() => writeScrubUnits(mock, dir, schedule()), /enable failed/)
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes(`disable --now ${SCRUB_TIMER_NAME}`), 'the rollback takes the half-enabled timer back down')
    assert.deepEqual(await readdir(dir), [], 'both files and the enablement are gone')
  })

  it('a failed update RESTORES the previous pair AND its enablement (third pass)', async () => {
    // is-enabled is read before every write: the setup write reads the catch-all
    // ('' → not enabled), the failing rewrite reads the live 'enabled'.
    mock.addFixture({
      command: SYSTEMCTL,
      args: ['is-enabled', SCRUB_TIMER_NAME],
      results: [
        { stdout: '', stderr: '', exitCode: 0 },
        { stdout: 'enabled\n', stderr: '', exitCode: 0 },
      ],
    })
    await writeScrubUnits(mock, dir, schedule({ pools: ['ahr0', 'ahr1'] }))
    mock.addFixture({ command: SYSTEMCTL, args: ['enable', '--now', SCRUB_TIMER_NAME], result: { stdout: '', stderr: 'enable failed', exitCode: 1 } })
    await assert.rejects(() => writeScrubUnits(mock, dir, schedule({ pools: ['ahr0'] })), /enable failed/)
    assert.deepEqual(await readScrubSchedule(dir), { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0', 'ahr1'] }, 'the previous schedule survived')
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(cmds.includes(`is-enabled ${SCRUB_TIMER_NAME}`), 'enablement is read before the write')
    assert.ok(
      cmds.lastIndexOf(`enable --now ${SCRUB_TIMER_NAME}`) > cmds.indexOf(`enable --now ${SCRUB_TIMER_NAME}`),
      'the restored pair was re-enabled after the files came back (best-effort — the mock fails it too)',
    )
    // Fourth pass: the rollback's reload lands BEFORE the enablement call.
    assert.ok(
      cmds.lastIndexOf('daemon-reload') < cmds.lastIndexOf(`enable --now ${SCRUB_TIMER_NAME}`),
      'systemd reloads the restored files before enablement acts on them',
    )
  })

  it('a failed rewrite of a DISABLED timer takes the timer back DOWN (fourth pass)', async () => {
    // The write arms the timer with `enable --now` whatever it was before — so
    // a rewrite of a disabled timer (or one whose is-enabled read failed
    // closed) that fails after the enable must not leave it ARMED: the
    // rollback disable is not reserved for first writes.
    mock.addFixture({
      command: SYSTEMCTL,
      args: ['is-enabled', SCRUB_TIMER_NAME],
      results: [
        { stdout: '', stderr: '', exitCode: 0 },
        { stdout: 'disabled\n', stderr: '', exitCode: 1 },
      ],
    })
    await writeScrubUnits(mock, dir, schedule({ pools: ['ahr0', 'ahr1'] }))
    mock.addFixture({ command: SYSTEMCTL, args: ['enable', '--now', SCRUB_TIMER_NAME], result: { stdout: '', stderr: 'enable failed', exitCode: 1 } })
    await assert.rejects(() => writeScrubUnits(mock, dir, schedule({ pools: ['ahr0'] })), /enable failed/)
    assert.deepEqual(await readScrubSchedule(dir), { kind: 'ahr-scrub', cadence: 'monthly', pools: ['ahr0', 'ahr1'] }, 'the previous schedule survived')
    const cmds = mock.calls.map(c => c.args.join(' '))
    assert.ok(
      cmds.lastIndexOf(`enable --now ${SCRUB_TIMER_NAME}`) < cmds.indexOf(`disable --now ${SCRUB_TIMER_NAME}`),
      'the rollback does not re-enable a timer that was off before the write',
    )
    assert.ok(cmds.includes(`disable --now ${SCRUB_TIMER_NAME}`), 'the rollback takes the armed timer back down')
    assert.ok(
      cmds.indexOf(`disable --now ${SCRUB_TIMER_NAME}`) > cmds.lastIndexOf(`enable --now ${SCRUB_TIMER_NAME}`),
      'the disable follows the enable that armed it',
    )
    assert.ok(
      cmds.lastIndexOf('daemon-reload') < cmds.indexOf(`disable --now ${SCRUB_TIMER_NAME}`),
      'and systemd reloads the restored files before the disable acts on them',
    )
  })

  it('removeScrubUnits clears the timer\'s Persistent stamp (review R10)', async () => {
    await writeScrubUnits(mock, dir, schedule())
    // The stamp lives outside the unit dir; create it where the module points.
    const stamp = scrubStampPath()
    await mkdir(dirname(stamp), { recursive: true })
    await writeFile(stamp, '')
    try {
      await removeScrubUnits(mock, dir)
      assert.deepEqual(await readdir(dir), [], 'both unit files are gone')
      await assert.rejects(() => readFile(stamp, 'utf-8'), /ENOENT/, 'the stamp is gone — the next enable cannot catch up a stale occurrence')
    }
    finally {
      await rm(dirname(stamp), { recursive: true, force: true })
    }
  })

  it('removeScrubUnits tolerates an absent stamp (idempotent)', async () => {
    await writeScrubUnits(mock, dir, schedule())
    await removeScrubUnits(mock, dir)
    await removeScrubUnits(mock, dir)
    assert.deepEqual(await readdir(dir), [])
  })

  it('readScrubTimerNext parses the NextElapseUSecRealtime property (null when absent)', async () => {
    const next = new MockExecutor()
    next.addFixture({
      command: SYSTEMCTL,
      args: ['show', SCRUB_TIMER_NAME, '-p', 'NextElapseUSecRealtime'],
      result: { stdout: 'NextElapseUSecRealtime=Sun 2026-10-04 03:00:00 UTC\n', stderr: '', exitCode: 0 },
    })
    assert.equal(await readScrubTimerNext(next), '2026-10-04T03:00:00.000Z')

    const none = new MockExecutor()
    none.addFixture({
      command: SYSTEMCTL,
      result: { stdout: 'NextElapseUSecRealtime=0\n', stderr: '', exitCode: 1 },
    })
    assert.equal(await readScrubTimerNext(none), null)
  })
})
