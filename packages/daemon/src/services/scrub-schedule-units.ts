import type { AhrScrubSchedule, ScrubCadence } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AhrScrubSchedule as AhrScrubScheduleSchema } from '@anas/shared'
import { parseSystemdTimestamp } from './systemd-status.js'
// The unit-store plumbing (marker parse, unlink, systemctl) is the ONE shared
// copy in systemd-unit-store.ts — this store was its fourth hand-copy.
import { parseMarkedJson, readUnitFile, runSystemctl, systemdTimersStampDir, unlinkQuiet } from './systemd-unit-store.js'
import { readTimerNextRaw } from './unit-run-status.js'

/**
 * The node-level AHR periodic-scrub UNITS (story selfheal.4) — the
 * snapshot-schedule unit pattern applied to the whole two-phase scrub: ONE
 * `anas-scrub.service` + `anas-scrub.timer` pair per NODE (not per pool). The
 * unit files ARE the store: the canonical AhrScrubSchedule JSON
 * (`{ kind: 'ahr-scrub', cadence, pools: [...] }`) is embedded as an
 * `X-ANAS-Schedule=` comment — the SINGLE source of truth parsed back, never
 * reverse-engineered from ExecStart. There is no second config file and no
 * custom scheduler (the standing scheduling ruling).
 *
 * The .service fires the compiled runner beside dist/snapshot-task.js
 * (dist/scrub-task.js), which POSTs `/ahr/<pool>/scrub` for each pool in the
 * list IN SEQUENCE — AHR pools on one node share spindles, so pools never scrub
 * concurrently. `Persistent=true` catches a fire missed across a reboot.
 *
 * Per-pool toggles rewrite this one pair (add/remove the pool from the list);
 * the cadence is node-level, so setting it from any pool rewrites the one
 * timer. When the pool list empties, both units are removed. A unit file
 * without our marker is never overwritten — parse-or-skip, and a WRITE that
 * would land on such a file is REFUSED (`foreign-unit`), not merely skipped
 * (review R10): the store reads before it writes, the way the snapshot store's
 * parser already reads before it adopts.
 */

const SYSTEMCTL = '/usr/bin/systemctl'
/** The timer executes this compiled runner (ships in dist — see scrub-task.ts). */
const RUNNER_NODE = '/usr/bin/node'
const RUNNER_SCRIPT = '/opt/anas/packages/daemon/dist/scrub-task.js'

export const SCRUB_SERVICE_NAME = 'anas-scrub.service'
export const SCRUB_TIMER_NAME = 'anas-scrub.timer'

/** The service-file line that carries the canonical schedule JSON (as a comment). */
const SCHEDULE_MARKER = 'X-ANAS-Schedule='
/** Any marker line at all — its PRESENCE marks the file as ours (review R10). */
const SCHEDULE_MARKER_RE_LINE = /^#?\s*X-ANAS-Schedule=.*$/m

/**
 * Where systemd records a Persistent timer's last fire. `Persistent=true` +
 * a leftover stamp means re-enabling the timer after a MISSED occurrence
 * starts the service immediately (that is the point of Persistent) — a full
 * multi-hour two-phase scrub, possibly in the middle of a workday. So
 * `removeScrubUnits` clears the stamp alongside the units (review R10), and
 * the enable-confirm dialog warns the operator anyway (belt and braces).
 * Verified live: `/var/lib/systemd/timers/stamp-anas-scrub.timer` on the
 * stunt node. The dir comes from the shared {@link systemdTimersStampDir} —
 * ONE place knows the path — and is env-overridable so tests never touch the
 * real one.
 */
export function scrubStampPath(): string {
  return `${systemdTimersStampDir()}/stamp-${SCRUB_TIMER_NAME}`
}

/**
 * Thrown when an `anas-scrub` unit file exists WITHOUT our marker — someone
 * else's unit squatting on ANAS's fixed names. Never overwritten, never
 * deleted; the route surfaces it as 409 `reason: 'foreign-unit'` (review R10).
 */
export class ForeignUnitError extends Error {
  readonly code = 'foreign-unit'
  constructor(message: string) {
    super(message)
    this.name = 'ForeignUnitError'
  }
}

/**
 * Does either of the node's `anas-scrub` units exist WITHOUT our marker line (a
 * foreign file)? A file carrying the marker — even with corrupt JSON inside,
 * e.g. a write interrupted mid-flight — is OURS to rewrite; one without it is
 * someone else's and is neither overwritten nor deleted (review R10). BOTH
 * files are checked (review F13), with one adoption exception (review F13's
 * third pass): the .service is the pair's anchor, and a MARKED service vouches
 * for a marker-less timer beside it — the pre-F13 pair an intermediate build
 * wrote (the service carried the schedule marker, the timer did not yet) is
 * OURS, adopted rather than refused forever: the next write re-renders the
 * timer with its marker. Without the vouch, that pair read as foreign and
 * every toggle PUT 409'd in both directions — the timer could never be turned
 * off from the UI. A marker-less SERVICE, or a marker-less timer with no
 * marked service beside it, is still foreign.
 */
export async function scrubUnitsAreForeign(dir: string): Promise<boolean> {
  const service = await readUnitFile(dir, SCRUB_SERVICE_NAME)
  const timer = await readUnitFile(dir, SCRUB_TIMER_NAME)
  const serviceOurs = service !== null && SCHEDULE_MARKER_RE_LINE.test(service)
  if (service !== null && !serviceOurs)
    return true
  if (timer !== null && !SCHEDULE_MARKER_RE_LINE.test(timer) && !serviceOurs)
    return true
  return false
}

// --- Cadence → OnCalendar ----------------------------------------------------

/**
 * Both calendars fire the first Sunday of the window at 03:00:
 *   monthly   — 1st Sunday of every month (matches PVE's ZFS cron and mdcheck's
 *               old 1st-Sunday timer).
 *   quarterly — 1st Sunday of Jan/Apr/Jul/Oct.
 * Range days 01..07 with `Sun` are the systemd idiom for "first <weekday>".
 */
const SCRUB_CADENCE_ONCALENDAR: Record<ScrubCadence, string> = {
  monthly: 'Sun *-*-01..07 03:00:00',
  quarterly: 'Sun *-01,04,07,10-01..07 03:00:00',
}

export function scrubCadenceToOnCalendar(cadence: ScrubCadence): string {
  return SCRUB_CADENCE_ONCALENDAR[cadence]
}

// --- Unit rendering ----------------------------------------------------------

/**
 * Render the `.service` unit. The `X-ANAS-Schedule=` comment embeds the
 * canonical schedule JSON (single line) — the ONLY thing the parser reads back.
 * ExecStart fires the runner with the pool list as argv; it is for systemd to
 * actually run and is never parsed by us.
 */
export function renderScrubServiceUnit(schedule: AhrScrubSchedule): string {
  const execStart = [RUNNER_NODE, RUNNER_SCRIPT, ...schedule.pools].join(' ')
  return [
    '[Unit]',
    `Description=ANAS periodic AHR scrub (${schedule.cadence}) — md parity, then btrfs checksums`,
    `# ${SCHEDULE_MARKER}${JSON.stringify(schedule)}`,
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${execStart}`,
    '',
  ].join('\n')
}

/**
 * Render the `.timer` unit for the node's scrub cadence. It carries the same
 * `X-ANAS-Schedule=` marker comment as the service (review F13): the marker's
 * PRESENCE is how `scrubUnitsAreForeign` tells our files from someone else's,
 * and it checked the service only — a foreign timer squatting on
 * `anas-scrub.timer` would have sailed past the check and been deleted by
 * `removeScrubUnits`.
 */
export function renderScrubTimerUnit(schedule: AhrScrubSchedule): string {
  return [
    '[Unit]',
    'Description=ANAS periodic AHR scrub timer',
    `# ${SCHEDULE_MARKER}${JSON.stringify(schedule)}`,
    '',
    '[Timer]',
    `OnCalendar=${scrubCadenceToOnCalendar(schedule.cadence)}`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
}

/**
 * Parse the canonical AhrScrubSchedule out of the `.service` unit's body via
 * its `X-ANAS-Schedule=` line (with or without the leading `# `), zod-validated.
 * Returns null when the marker is absent or the JSON is invalid — a unit we did
 * not write is never adopted (and never overwritten by a toggle).
 */
export function parseScrubServiceUnit(content: string): AhrScrubSchedule | null {
  return parseMarkedJson(content, SCHEDULE_MARKER, AhrScrubScheduleSchema)
}

// --- Store: read ------------------------------------------------------------

/**
 * The node's scrub schedule, parsed from the unit files. Null when the units
 * are absent (no pool enabled yet) or carry no valid marker (not ours).
 */
export async function readScrubSchedule(dir: string): Promise<AhrScrubSchedule | null> {
  const content = await readUnitFile(dir, SCRUB_SERVICE_NAME)
  return content === null ? null : parseScrubServiceUnit(content)
}

/**
 * The timer's next elapse, parsed to ISO — or null when the unit is absent,
 * disabled, or unreadable. Fail-open: one broken read costs the date on the
 * screen, never the row.
 */
export async function readScrubTimerNext(executor: CommandExecutor): Promise<string | null> {
  return parseSystemdTimestamp(await readTimerNextRaw(executor, SCRUB_TIMER_NAME))
}

// --- Store: write + remove --------------------------------------------------

/**
 * Write (or rewrite) the node's service+timer pair — ALWAYS with the marker —
 * reload systemd, and enable the timer. Throws on any systemctl failure so the
 * mutation surfaces it.
 *
 * Read-before-write (review R10): an existing `anas-scrub` unit WITHOUT our
 * marker is someone else's unit on ANAS's fixed name — refuse with
 * {@link ForeignUnitError} (409 `foreign-unit` at the route), never overwrite.
 * A file carrying the marker (ours, even with corrupt JSON inside) is ours to
 * rewrite.
 *
 * Rollback (review F14): a failure after the first file lands — the timer write,
 * the reload, the enable — must not leave a HALF-WRITTEN pair for the next
 * attempt to trip over. Both previous files are restored byte-for-byte (or
 * removed, when this write was the pair's first), a best-effort reload drops the
 * half-registered units from systemd BEFORE the enablement call, so systemd does
 * not act on its cached half-written definition (fourth pass), and the original
 * error rethrows. The timer's enablement is restored with the files (third
 * pass): `enable --now` enables BEFORE it starts, so a failed start on a first
 * write leaves the `timers.target.wants` symlink dangling over a file the
 * rollback removes — the disable takes it back down; a restored previous pair is
 * re-enabled when the timer was enabled before the write (`is-enabled` is read
 * up front), and DISABLED again when it was not — on a rewrite of a disabled
 * timer the write's own `enable --now` armed it, and the rollback must take it
 * back down (fourth pass). A ForeignUnitError passes through untouched —
 * nothing was written, nothing to roll back.
 */
export async function writeScrubUnits(
  executor: CommandExecutor,
  dir: string,
  schedule: AhrScrubSchedule,
): Promise<void> {
  if (await scrubUnitsAreForeign(dir)) {
    throw new ForeignUnitError(
      `an anas-scrub unit in ${dir} exists without an X-ANAS-Schedule marker — `
      + 'not an ANAS unit; ANAS will not overwrite it',
    )
  }
  const timerWasEnabled = await readScrubTimerEnabled(executor)
  const previous = {
    [SCRUB_SERVICE_NAME]: await readUnitFile(dir, SCRUB_SERVICE_NAME),
    [SCRUB_TIMER_NAME]: await readUnitFile(dir, SCRUB_TIMER_NAME),
  }
  try {
    await writeFile(join(dir, SCRUB_SERVICE_NAME), renderScrubServiceUnit(schedule), 'utf-8')
    await writeFile(join(dir, SCRUB_TIMER_NAME), renderScrubTimerUnit(schedule), 'utf-8')
    await runSystemctl(executor, ['daemon-reload'])
    await runSystemctl(executor, ['enable', '--now', SCRUB_TIMER_NAME])
  }
  catch (err) {
    for (const [name, prev] of Object.entries(previous)) {
      if (prev === null)
        await unlinkQuiet(join(dir, name))
      else
        await writeFile(join(dir, name), prev, 'utf-8')
    }
    // Best-effort: systemd may be holding the CACHED half-written definition,
    // and the enablement call below acts on the restored files — reload FIRST,
    // so systemd cannot act on the pair it never should have seen (fourth
    // pass). A failure here is not fatal: the enablement call and the next
    // write's own daemon-reload both re-read from disk.
    await executor.exec(SYSTEMCTL, ['daemon-reload']).catch(() => undefined)
    // Enablement rides the files (third pass). Best-effort both ways — the
    // original failure below is what the operator sees; a rollback systemctl
    // hiccup on top of it would only bury the cause.
    if (previous[SCRUB_TIMER_NAME] !== null && timerWasEnabled) {
      // A rewrite of an ENABLED timer: the restored pair was live before — put
      // the enable back (--now also re-actives the timer; a start that fails
      // again changes nothing the original error does not already report).
      await executor.exec(SYSTEMCTL, ['enable', '--now', SCRUB_TIMER_NAME]).catch(() => undefined)
    }
    else {
      // A first write: enable --now may have linked the timer before its start
      // failed — the file is gone now, so the wants symlink must go too. Or a
      // rewrite of a DISABLED timer (or an unreadable is-enabled): the write's
      // own `enable --now` armed a timer that was off before, and the rollback
      // must take it back down rather than leave it enabled (fourth pass).
      await executor.exec(SYSTEMCTL, ['disable', '--now', SCRUB_TIMER_NAME]).catch(() => undefined)
    }
    throw err
  }
}

/**
 * Was the scrub timer enabled before a write (best-effort — an unreadable
 * `is-enabled` reads as not enabled, so a rollback never re-enables on a
 * guess)? `is-enabled` exits nonzero for `disabled`/`static` but still prints
 * the word; `enabled`/`enabled-runtime` (exit 0) are the enabled states.
 */
async function readScrubTimerEnabled(executor: CommandExecutor): Promise<boolean> {
  try {
    const r = await executor.exec(SYSTEMCTL, ['is-enabled', SCRUB_TIMER_NAME])
    return r.exitCode === 0 && r.stdout.trim().startsWith('enabled')
  }
  catch {
    return false
  }
}

/**
 * Remove the node's scrub units: stop+disable the timer, delete both files
 * AND the timer's Persistent stamp (review R10 — a leftover stamp makes the
 * next enable start the whole scrub immediately), reset the units' failed
 * state, reload systemd. Used when the pool list empties — the operator asked
 * for no scrubbing, so nothing is left firing and no stale catch-up is armed
 * for the next enable.
 *
 * The `reset-failed` pair is the task stores' shape (review R2): a removed
 * oneshot that failed stays in the failed state as a `not-found` ghost, so
 * `systemctl reset-failed` is issued as TWO calls — service first, then timer
 * — each with its exit IGNORED; a reset of nothing must never fail the
 * removal.
 */
export async function removeScrubUnits(executor: CommandExecutor, dir: string): Promise<void> {
  // Best-effort disable first (ignore failure — the unit may already be gone).
  await executor.exec(SYSTEMCTL, ['disable', '--now', SCRUB_TIMER_NAME])
  await Promise.all([
    unlinkQuiet(join(dir, SCRUB_SERVICE_NAME)),
    unlinkQuiet(join(dir, SCRUB_TIMER_NAME)),
    unlinkQuiet(scrubStampPath()),
  ])
  // Best-effort: not failed / already gone is exactly the goal state.
  await executor.exec(SYSTEMCTL, ['reset-failed', SCRUB_SERVICE_NAME]).catch(() => undefined)
  await executor.exec(SYSTEMCTL, ['reset-failed', SCRUB_TIMER_NAME]).catch(() => undefined)
  await runSystemctl(executor, ['daemon-reload'])
}
