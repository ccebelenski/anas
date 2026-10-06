import type { CommandExecutor, ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BACKUP_UNIT_KIND } from '../backup-units.js'
import { readUnitState } from '../mounts.js'
import { deriveTaskStatus as deriveReplicationStatus } from '../replication-units.js'
import { readScrubTimerNext, SCRUB_TIMER_NAME } from '../scrub-schedule-units.js'
import { deriveScheduleStatus } from '../snapshot-schedule-units.js'
import { parseSystemdTimestamp } from '../systemd-status.js'
import {
  deriveTaskStatus,
  deriveTriggerSource,
  readRunActive,
  serviceUnitName as taskServiceUnit,
  timerUnitName as taskTimerUnit,
} from '../task-units.js'
import { deriveUnitRunStatus, SYSTEMCTL_SHOW_ENV } from '../unit-run-status.js'

/**
 * Zone independence of every systemd timestamp the daemon reads (0.4.2
 * test-review C1).
 *
 * `systemctl show` prints timestamps in the printing process's local zone with
 * a zone ABBREVIATION (`Mon 2026-10-05 04:00:00 CEST`), and Node's `Date.parse`
 * returns NaN for every abbreviation outside UTC/GMT and the US zones — so on a
 * node in Europe or Asia every last run, next run and overdue verdict went
 * blank. The fix runs every show with `TZ=UTC` in the child's environment.
 *
 * The fake systemd below behaves the way systemd 257 does (verified on the
 * stunt node): it renders a timestamp in the HOST's zone unless the child's
 * environment says `TZ=UTC`; journalctl `short-iso` always carries a numeric
 * offset. Every rung of the shared derivation, nextRunAt, and every store's
 * reads are exercised on a Berlin (CEST) host and a Tokyo (JST) host.
 *
 * No wall clock: every instant is a literal (snapshot-schedule overdue compares
 * with the real clock, so its fixtures sit years either side of it).
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const JOURNALCTL = '/usr/bin/journalctl'
const SYSTEMD_ESCAPE = '/usr/bin/systemd-escape'

interface HostZone { name: string, offsetMin: number, abbr: string }
const BERLIN: HostZone = { name: 'Europe/Berlin', offsetMin: 120, abbr: 'CEST' }
const TOKYO: HostZone = { name: 'Asia/Tokyo', offsetMin: 540, abbr: 'JST' }
const UTC_ZONE: HostZone = { name: 'UTC', offsetMin: 0, abbr: 'UTC' }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number): string => String(n).padStart(2, '0')

/** An instant rendered the way `systemctl show` prints it in `zone`. */
function systemdHuman(ms: number, zone: HostZone): string {
  const d = new Date(ms + zone.offsetMin * 60_000)
  const iso = d.toISOString()
  return `${WEEKDAYS[d.getUTCDay()]} ${iso.slice(0, 10)} ${iso.slice(11, 19)} ${zone.abbr}`
}

/** An instant rendered the way `journalctl -o short-iso` prints it in `zone`. */
function shortIso(ms: number, zone: HostZone): string {
  const d = new Date(ms + zone.offsetMin * 60_000)
  const sign = zone.offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(zone.offsetMin)
  return `${d.toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
}

type PropValue = string | { at: number }

/** A fake systemd + journald on a host in `zone`. */
class ZonedHost implements CommandExecutor {
  readonly shows: { unit: string, tz: string | undefined }[] = []
  readonly units = new Map<string, Record<string, PropValue>>()
  readonly journals = new Map<string, { at: number, msg: string }[]>()

  constructor(readonly zone: HostZone, readonly honourTz = true) {}

  unit(name: string, props: Record<string, PropValue>): this {
    this.units.set(name, props)
    return this
  }

  journal(unit: string, lines: { at: number, msg: string }[]): this {
    this.journals.set(unit, lines)
    return this
  }

  async exec(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (command === SYSTEMCTL && args[0] === 'show') {
      const unit = args[1]
      const tz = opts?.env?.TZ
      this.shows.push({ unit, tz })
      const zone = this.honourTz && tz === 'UTC' ? UTC_ZONE : this.zone
      const wanted = args[args.indexOf('-p') + 1].split(',')
      const props = this.units.get(unit) ?? {}
      const lines = wanted.map((k) => {
        const v = props[k]
        return `${k}=${v === undefined ? '' : typeof v === 'string' ? v : systemdHuman(v.at, zone)}`
      })
      return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 }
    }
    if (command === JOURNALCTL) {
      const unit = args[args.indexOf('-u') + 1]
      const out = (this.journals.get(unit) ?? [])
        .map(l => `${shortIso(l.at, this.zone)} pve ${unit.replace('.service', '')}[900]: ${l.msg}`)
        .join('\n')
      return { stdout: out, stderr: '', exitCode: 0 }
    }
    if (command === SYSTEMD_ESCAPE)
      return { stdout: 'mnt-x.mount\n', stderr: '', exitCode: 0 }
    return { stdout: '', stderr: 'not faked', exitCode: 1 }
  }

  pipeline(): never {
    throw new Error('not faked')
  }

  execToStream(): never {
    throw new Error('not faked')
  }
}

/** 2026-10-05 02:00:07 UTC — 04:00:07 in Berlin, 11:00:07 in Tokyo. */
const RAN = Date.UTC(2026, 9, 5, 2, 0, 7)
const NEXT = Date.UTC(2026, 9, 6, 2, 0, 0)
const SUCCESS_MSG = '{"task":"demo","result":{"status":"success"}}'
const REBOOTED: Record<string, PropValue> = {
  ActiveState: 'inactive',
  Result: 'success',
  ExecMainStatus: '0',
  ExecMainExitTimestamp: '',
  InactiveEnterTimestamp: '',
}
const SERVICE = 'anas-x-demo.service'
const TIMER = 'anas-x-demo.timer'

function derive(host: ZonedHost): ReturnType<typeof deriveUnitRunStatus> {
  return deriveUnitRunStatus(host, { serviceUnit: SERVICE, timerUnit: TIMER, enabled: true })
}

function assertAllShowsUtc(host: ZonedHost): void {
  assert.ok(host.shows.length > 0, 'at least one systemctl show was issued')
  for (const s of host.shows)
    assert.equal(s.tz, 'UTC', `systemctl show ${s.unit} ran without TZ=UTC`)
}

describe('systemd timestamps — the parser is zone-strict', () => {
  it('a CEST or JST abbreviation is rejected (null), never NaN and never guessed', () => {
    for (const zone of [BERLIN, TOKYO]) {
      const raw = systemdHuman(RAN, zone)
      assert.match(raw, new RegExp(` ${zone.abbr}$`))
      assert.equal(parseSystemdTimestamp(raw), null, raw)
    }
    // The US abbreviations Date.parse happens to know are refused too: every
    // show runs TZ=UTC, so anything else is a zone this process did not ask for.
    assert.equal(parseSystemdTimestamp('Mon 2026-10-05 04:00:00 EDT'), null)
    assert.equal(parseSystemdTimestamp('2026-10-05 04:00:00'), null, 'no zone = local time, refused')
    assert.equal(parseSystemdTimestamp('Mon 2026-10-05 04:00:00 Garbage'), null)
  })

  it('the UTC form, a numeric offset and the µs form parse exactly', () => {
    assert.equal(parseSystemdTimestamp(systemdHuman(RAN, UTC_ZONE)), '2026-10-05T02:00:07.000Z')
    assert.equal(parseSystemdTimestamp('Mon 2026-10-05 04:00:07 +0200'), '2026-10-05T02:00:07.000Z')
    assert.equal(parseSystemdTimestamp('Mon 2026-10-05 11:00:07 +09:00'), '2026-10-05T02:00:07.000Z')
    assert.equal(parseSystemdTimestamp('Mon 2026-10-05 02:00:07.123456 UTC'), '2026-10-05T02:00:07.123Z')
    assert.equal(parseSystemdTimestamp('Mon 2026-10-05 02:00:07 GMT'), '2026-10-05T02:00:07.000Z')
    assert.equal(parseSystemdTimestamp(String(RAN * 1000)), '2026-10-05T02:00:07.000Z')
  })

  it('every show runs with TZ=UTC in the child environment', () => {
    assert.deepEqual({ ...SYSTEMCTL_SHOW_ENV }, { TZ: 'UTC' })
  })
})

for (const zone of [BERLIN, TOKYO]) {
  describe(`systemd timestamps on a ${zone.name} host (${zone.abbr}) — every rung`, () => {
    it('rung 1 (live): last run and next run read correctly', async () => {
      const host = new ZonedHost(zone)
        .unit(SERVICE, { ...REBOOTED, ExecMainExitTimestamp: { at: RAN } })
        .unit(TIMER, { NextElapseUSecRealtime: { at: NEXT }, LastTriggerUSec: { at: RAN - 7000 } })
      const st = await derive(host)
      assert.equal(st.source, 'live')
      assert.equal(st.lastRunAt, '2026-10-05T02:00:07.000Z')
      assert.equal(st.nextRunAt, '2026-10-06T02:00:00.000Z')
      assertAllShowsUtc(host)
    })

    it('rung 2 (journal): the result line answers; the timer guard compares in one zone', async () => {
      const host = new ZonedHost(zone)
        .unit(SERVICE, REBOOTED)
        .unit(TIMER, { NextElapseUSecRealtime: { at: NEXT }, LastTriggerUSec: { at: RAN - 7000 } })
        .journal(SERVICE, [{ at: RAN, msg: SUCCESS_MSG }])
      const st = await derive(host)
      assert.equal(st.source, 'journal')
      assert.equal(st.lastRunResult, 'success')
      assert.equal(st.lastRunAt, '2026-10-05T02:00:07.000Z')
      assert.equal(st.nextRunAt, '2026-10-06T02:00:00.000Z')
      assertAllShowsUtc(host)
    })

    it('rung 2 guard: a trigger newer than the result line falls to the timer rung', async () => {
      const host = new ZonedHost(zone)
        .unit(SERVICE, REBOOTED)
        .unit(TIMER, { NextElapseUSecRealtime: { at: NEXT }, LastTriggerUSec: { at: RAN + 3_600_000 } })
        .journal(SERVICE, [{ at: RAN, msg: SUCCESS_MSG }])
      const st = await derive(host)
      assert.equal(st.source, 'timer')
      assert.equal(st.lastRunAt, '2026-10-05T03:00:07.000Z')
    })

    it('rung 3 (timer): the trigger stamp answers with the not-retained note in UTC', async () => {
      const host = new ZonedHost(zone)
        .unit(SERVICE, REBOOTED)
        .unit(TIMER, { NextElapseUSecRealtime: { at: NEXT }, LastTriggerUSec: { at: RAN } })
      const st = await derive(host)
      assert.equal(st.source, 'timer')
      assert.equal(st.lastRunResult, 'unknown')
      assert.equal(st.lastRunAt, '2026-10-05T02:00:07.000Z')
      assert.equal(st.lastRunNote, 'ran at 2026-10-05 02:00 UTC; result not retained across the reboot')
      assertAllShowsUtc(host)
    })

    it('rung 4 (none): never-run, with the next run still read', async () => {
      const host = new ZonedHost(zone)
        .unit(SERVICE, REBOOTED)
        .unit(TIMER, { NextElapseUSecRealtime: { at: NEXT }, LastTriggerUSec: 'n/a' })
      const st = await derive(host)
      assert.equal(st.source, 'none')
      assert.equal(st.lastRunResult, 'never-run')
      assert.equal(st.lastRunAt, null)
      assert.equal(st.nextRunAt, '2026-10-06T02:00:00.000Z')
    })

    it('control: a systemctl that ignored TZ yields nulls (rejected), never NaN or a throw', async () => {
      const host = new ZonedHost(zone, false)
        .unit(SERVICE, { ...REBOOTED, ExecMainExitTimestamp: { at: RAN } })
        .unit(TIMER, { NextElapseUSecRealtime: { at: NEXT }, LastTriggerUSec: { at: RAN } })
      const st = await derive(host)
      assert.equal(st.nextRunAt, null)
      assert.equal(st.lastRunAt, null)
    })
  })

  describe(`systemd timestamps on a ${zone.name} host — every store's reads`, () => {
    it('backup/cloud: last run, next run and the stale-timer overdue', async () => {
      const name = 'nightly'
      const svc = taskServiceUnit(BACKUP_UNIT_KIND, name)
      const tmr = taskTimerUnit(BACKUP_UNIT_KIND, name)
      const host = new ZonedHost(zone)
        .unit(svc, { ...REBOOTED, ExecMainExitTimestamp: { at: RAN } })
        .unit(tmr, { NextElapseUSecRealtime: { at: NEXT }, LastTriggerUSec: { at: RAN - 7000 } })
      const st = await deriveTaskStatus(BACKUP_UNIT_KIND, host, { name, enabled: true, schedule: 'daily' }, NEXT + 3_600_000)
      assert.equal(st.lastRunAt, '2026-10-05T02:00:07.000Z')
      assert.equal(st.nextRunAt, '2026-10-06T02:00:00.000Z')
      assert.equal(st.overdue, true, 'a next elapse an hour in the past is overdue')
      assertAllShowsUtc(host)
    })

    it('backup/cloud: the trigger classification and the running-since read', async () => {
      const name = 'nightly'
      const svc = taskServiceUnit(BACKUP_UNIT_KIND, name)
      const tmr = taskTimerUnit(BACKUP_UNIT_KIND, name)
      const host = new ZonedHost(zone)
        .unit(svc, { ActiveState: 'activating', InactiveExitTimestamp: { at: RAN } })
        .unit(tmr, { LastTriggerUSec: { at: RAN - 1000 } })
      assert.equal(await deriveTriggerSource(BACKUP_UNIT_KIND, host, name), 'scheduled')
      assert.deepEqual(await readRunActive(host, BACKUP_UNIT_KIND, name), { active: true, since: '2026-10-05T02:00:07.000Z' })
      assertAllShowsUtc(host)
    })

    it('snapshot schedules: last run, next run, overdue', async () => {
      const longAgo = Date.UTC(2020, 0, 1, 0, 0, 0)
      const host = new ZonedHost(zone)
        .unit('anas-snap-nightly.service', { ...REBOOTED, ExecMainExitTimestamp: { at: RAN } })
        .unit('anas-snap-nightly.timer', { NextElapseUSecRealtime: { at: longAgo }, LastTriggerUSec: { at: RAN } })
      const st = await deriveScheduleStatus(host, {
        id: 'nightly',
        name: 'Nightly',
        target: { kind: 'zfs', dataset: 'tank/media' },
        cadence: 'daily',
        retention: { daily: 7 },
        recursive: false,
        enabled: true,
        notify: 'on-failure',
      })
      assert.equal(st.lastRunAt, '2026-10-05T02:00:07.000Z')
      assert.equal(st.nextRunAt, '2020-01-01T00:00:00.000Z')
      assert.equal(st.overdue, true)
      assertAllShowsUtc(host)
    })

    it('replication: next run and the timer-rung verdict', async () => {
      const host = new ZonedHost(zone)
        .unit('anas-repl-nightly-media.service', REBOOTED)
        .unit('anas-repl-nightly-media.timer', { NextElapseUSecRealtime: { at: NEXT }, LastTriggerUSec: { at: RAN } })
      const st = await deriveReplicationStatus(host, {
        name: 'nightly-media',
        source: { pool: 'testpool', dataset: 'media' },
        target: { pool: 'backup', dataset: 'media' },
        schedule: 'daily',
        snapshotFirst: true,
        enabled: true,
        notify: 'on-failure',
      })
      assert.equal(st.nextRunAt, '2026-10-06T02:00:00.000Z')
      assert.equal(st.lastRunResult, 'unknown')
      assert.match(st.lastRunNote ?? '', /^ran at 2026-10-05 02:00 UTC/)
      assertAllShowsUtc(host)
    })

    it('AHR scrub schedule: next run', async () => {
      const host = new ZonedHost(zone).unit(SCRUB_TIMER_NAME, { NextElapseUSecRealtime: { at: NEXT } })
      assert.equal(await readScrubTimerNext(host), '2026-10-06T02:00:00.000Z')
      assertAllShowsUtc(host)
    })

    it('mounts: the mount unit show goes through the same helper', async () => {
      const host = new ZonedHost(zone).unit('mnt-x.mount', { LoadState: 'loaded', ActiveState: 'active', SubState: 'mounted', Result: 'success' })
      const st = await readUnitState(host, '/mnt/x')
      assert.equal(st?.name, 'mnt-x.mount')
      assertAllShowsUtc(host)
    })
  })
}
