import type { CommandExecutor } from '../executor/index.js'

/**
 * PVE notification emission (AHR-DESIGN §7.2, GT-17).
 *
 * ANAS emits, PVE delivers: `PVE::Notify::notify(severity, template, data,
 * fields)` renders the ANAS-shipped handlebars templates
 * (`<template>-{subject,body}.txt.hbs` under /usr/share/pve-manager/templates/
 * default/, installed by packaging) and routes through the operator's own
 * notification matchers/targets. The `fields` carry `type=<template>` so
 * operators can write matcher rules for ANAS events specifically — and, since
 * 16.12, for a specific KIND of ANAS event (`anas-ahr` array/pool events vs
 * `anas-backup` backup-run events).
 *
 * Delivery is BEST-EFFORT by design: a notification failure must never fail
 * the job that emitted it (a degraded pool with a broken mail target still
 * completed its rebuild). Failures are logged to stderr (journald via the
 * daemon unit) and swallowed.
 */

export type PveNotifySeverity = 'info' | 'notice' | 'warning' | 'error'

/** Template name — matches packaging/templates/anas-ahr-*.txt.hbs. */
export const ANAS_NOTIFY_TEMPLATE = 'anas-ahr'

/** Backup-run template (16.12) — packaging/templates/anas-backup-*.txt.hbs. */
export const ANAS_BACKUP_NOTIFY_TEMPLATE = 'anas-backup'

/**
 * A template name is the ONE value interpolated into the perl body (PVE::Notify
 * takes it as a literal, not via @ARGV), so it is constrained to the shape our
 * own shipped templates use. Anything else is refused rather than executed.
 */
const TEMPLATE_RE = /^[a-z0-9-]+$/

/**
 * Argument-safe Perl body: severity/title/message arrive via @ARGV (never
 * interpolated into code), so no quoting/injection surface exists. The template
 * name is validated against {@link TEMPLATE_RE} before it lands here.
 */
function perlNotifyBody(template: string): string {
  return 'use PVE::Notify; my ($sev, $title, $msg) = @ARGV; '
    + `PVE::Notify::notify($sev, '${template}', { title => $title, message => $msg }, { type => '${template}' });`
}

/**
 * Emit a PVE notification; resolves regardless of delivery outcome.
 *
 * `template` selects which shipped template pair renders the mail and which
 * `type` field the matcher rules see. It defaults to the AHR template, so every
 * pre-16.12 caller is unchanged.
 */
export async function pveNotify(
  executor: CommandExecutor,
  severity: PveNotifySeverity,
  title: string,
  message: string,
  template: string = ANAS_NOTIFY_TEMPLATE,
): Promise<void> {
  if (!TEMPLATE_RE.test(template)) {
    console.error(`pve-notify: refusing to emit with an invalid template name '${template}'`)
    return
  }
  try {
    const result = await executor.exec('/usr/bin/perl', ['-e', perlNotifyBody(template), severity, title, message])
    if (result.exitCode !== 0)
      console.error(`pve-notify: delivery failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
  catch (err) {
    console.error(`pve-notify: could not invoke perl: ${err instanceof Error ? err.message : String(err)}`)
  }
}
