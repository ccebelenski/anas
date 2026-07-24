import type { CommandExecutor } from '../executor/index.js'

/**
 * PVE notification emission (AHR-DESIGN §7.2, GT-17).
 *
 * ANAS emits, PVE delivers: `PVE::Notify::notify(severity, template, data,
 * fields)` renders the ANAS-shipped handlebars templates
 * (`anas-ahr-{subject,body}.txt.hbs` under /usr/share/pve-manager/templates/
 * default/, installed by packaging) and routes through the operator's own
 * notification matchers/targets. The `fields` carry `type=anas-ahr` so
 * operators can write matcher rules for ANAS events specifically.
 *
 * Delivery is BEST-EFFORT by design: a notification failure must never fail
 * the job that emitted it (a degraded pool with a broken mail target still
 * completed its rebuild). Failures are logged to stderr (journald via the
 * daemon unit) and swallowed.
 */

export type PveNotifySeverity = 'info' | 'notice' | 'warning' | 'error'

/** Template name — matches packaging/templates/anas-ahr-*.txt.hbs. */
export const ANAS_NOTIFY_TEMPLATE = 'anas-ahr'

/**
 * Argument-safe Perl body: severity/title/message arrive via @ARGV (never
 * interpolated into code), so no quoting/injection surface exists.
 */
const PERL_NOTIFY = 'use PVE::Notify; my ($sev, $title, $msg) = @ARGV; '
  + `PVE::Notify::notify($sev, '${ANAS_NOTIFY_TEMPLATE}', { title => $title, message => $msg }, { type => '${ANAS_NOTIFY_TEMPLATE}' });`

/** Emit a PVE notification; resolves regardless of delivery outcome. */
export async function pveNotify(
  executor: CommandExecutor,
  severity: PveNotifySeverity,
  title: string,
  message: string,
): Promise<void> {
  try {
    const result = await executor.exec('/usr/bin/perl', ['-e', PERL_NOTIFY, severity, title, message])
    if (result.exitCode !== 0)
      console.error(`pve-notify: delivery failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
  catch (err) {
    console.error(`pve-notify: could not invoke perl: ${err instanceof Error ? err.message : String(err)}`)
  }
}
