import type { PeriodicScrubState } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'

/**
 * Periodic SCRUB — uniform surface, filesystem-native backend (Epic 17.5,
 * docs/SCHEDULES-DESIGN.md §Scrub). The operator sees one "periodic scrub:
 * on/off (monthly)" control for a ZFS pool and an AHR pool; ANAS flips the
 * filesystem's OWN switch behind it (guest philosophy — we surface + adjust the
 * distro's existing mechanism, never build a parallel one, never double-schedule):
 *
 *   | fs  | read state            | mechanism                                   |
 *   |-----|-----------------------|---------------------------------------------|
 *   | ZFS | org.debian:periodic-scrub property (GT-2) | PVE's monthly cron, per-pool-gated |
 *   | AHR | mdcheck_start.timer is-enabled            | mdadm's mdcheck timers (NODE-GLOBAL) |
 *
 * ZFS: the property gates PVE's 2nd-Sunday monthly cron. `-`/unset, `auto`,
 * `enable` all SCRUB (default = on); only `disable` turns it off. ANAS sets
 * `enable`/`disable` — a surgical property write, never a config/unit edit, and
 * never touches the (disabled) systemd `zfs-scrub-*@.timer` so no collision (GT-4).
 *
 * AHR/md: mdadm ships `mdcheck_start.timer` + `mdcheck_continue.timer` (1st
 * Sunday monthly, Persistent). They are NODE-GLOBAL — a check verifies every md
 * array on the host — so this toggle governs md checks for ALL AHR pools at once
 * (the one visible divergence from ZFS's per-pool knob; surfaced via `note`). The
 * on-demand AHR Scrub verb (11.x) is untouched — this is the PERIODIC toggle only.
 */

const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const SCRUB_PROPERTY = 'org.debian:periodic-scrub'
/** The mdadm timers to toggle together (`start` fires the check, `continue` resumes it). */
const MDCHECK_TIMERS = ['mdcheck_start.timer', 'mdcheck_continue.timer']
/** The one we READ state from (`Also=mdcheck_continue.timer` keeps them in lockstep). */
const MDCHECK_PRIMARY = 'mdcheck_start.timer'

const MDCHECK_NOTE
  = 'md checks are node-global (every array on the host); this toggle governs md periodic checks for all AHR pools.'

// --- ZFS: org.debian:periodic-scrub property --------------------------------

/**
 * Interpret a `org.debian:periodic-scrub` property VALUE as scrub on/off. Only
 * `disable` turns the monthly cron off; unset (`-`), empty, `auto`, and `enable`
 * all scrub (the distro default is ON) — GT-2.
 */
export function parseZfsScrubEnabled(value: string): boolean {
  return value.trim() !== 'disable'
}

/** `zfs get -Hp -o value org.debian:periodic-scrub <pool>` argv. */
export function zfsScrubGetArgs(pool: string): string[] {
  return ['get', '-Hp', '-o', 'value', SCRUB_PROPERTY, pool]
}

/** `zfs set org.debian:periodic-scrub=<enable|disable> <pool>` argv. */
export function zfsScrubSetArgs(pool: string, enabled: boolean): string[] {
  return ['set', `${SCRUB_PROPERTY}=${enabled ? 'enable' : 'disable'}`, pool]
}

/**
 * Read a ZFS pool's periodic-scrub state (fail-open to enabled = the distro
 * default, so an unreadable property never falsely claims scrubbing is off).
 */
export async function readZfsScrubState(
  executor: CommandExecutor,
  pool: string,
): Promise<PeriodicScrubState> {
  let enabled = true
  try {
    const r = await executor.exec(ZFS, zfsScrubGetArgs(pool))
    if (r.exitCode === 0)
      enabled = parseZfsScrubEnabled(r.stdout)
  }
  catch {
    // fail-open to the distro default (on)
  }
  return { target: { kind: 'zfs', pool }, enabled, cadence: 'monthly', mechanism: 'zfs-property' }
}

/** Flip a ZFS pool's periodic-scrub property (surgical `zfs set`). Throws on failure. */
export async function setZfsScrubEnabled(
  executor: CommandExecutor,
  pool: string,
  enabled: boolean,
): Promise<void> {
  const r = await executor.exec(ZFS, zfsScrubSetArgs(pool, enabled))
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `zfs set ${SCRUB_PROPERTY} on '${pool}' exited with code ${r.exitCode}`)
}

// --- AHR/md: mdcheck timers -------------------------------------------------

/** Interpret `systemctl is-enabled` output for the mdcheck timer as on/off. */
export function parseMdcheckEnabled(isEnabledStdout: string): boolean {
  // `enabled`, `enabled-runtime` → on; `disabled`, `static`, `masked`, '' → off.
  return isEnabledStdout.trim().startsWith('enabled')
}

/**
 * Read the node's mdcheck (AHR periodic scrub) state for a given AHR pool. The
 * state is node-global (see MDCHECK_NOTE); each AHR pool reflects it. Fail-open
 * to disabled — an unreadable/absent mdcheck timer means no periodic md check.
 */
export async function readAhrScrubState(
  executor: CommandExecutor,
  pool: string,
): Promise<PeriodicScrubState> {
  let enabled = false
  try {
    const r = await executor.exec(SYSTEMCTL, ['is-enabled', MDCHECK_PRIMARY])
    // is-enabled exits nonzero for `disabled`/`static` but still prints the word.
    enabled = parseMdcheckEnabled(r.stdout)
  }
  catch {
    // fail-open to off
  }
  return { target: { kind: 'ahr', pool }, enabled, cadence: 'monthly', mechanism: 'mdcheck-timer', note: MDCHECK_NOTE }
}

/**
 * Enable/disable the node's mdcheck timers (both, `--now`). NODE-GLOBAL — this is
 * the mdadm-shipped periodic md check for every array on the host. Throws on
 * failure so the mutation surfaces it.
 */
export async function setAhrScrubEnabled(
  executor: CommandExecutor,
  enabled: boolean,
): Promise<void> {
  const verb = enabled ? 'enable' : 'disable'
  const r = await executor.exec(SYSTEMCTL, [verb, '--now', ...MDCHECK_TIMERS])
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `systemctl ${verb} mdcheck timers exited with code ${r.exitCode}`)
}
