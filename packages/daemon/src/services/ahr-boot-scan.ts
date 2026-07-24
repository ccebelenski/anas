import type { CommandExecutor } from '../executor/types.js'
import { matchAhrArrayName, mdadmDetailExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { defaultAhrIntentDir, listIntents, writeIntent } from './ahr-intent.js'
import { pveNotify } from './pve-notify.js'

/**
 * AHR daemon-start scan (Epic 11.6, docs/AHR-DESIGN.md §5.1/§8, GT-8) — runs
 * ONCE after the daemon starts listening. Non-blocking and fail-soft: every
 * failure is logged (journald via the unit), none is fatal to the daemon.
 *
 * Three branches, each deliberately minimal:
 *
 *  (a) INACTIVE all-spares AHR arrays — the GT-8 post-power-loss state (udev
 *      assembles a degraded mid-reshape array inactive, every member listed as
 *      a spare). The stage-0-verified recovery ladder runs, gentlest first:
 *      `mdadm --run` (starts the array, drops the failed member, lands
 *      active/auto-read-only/degraded), `mdadm --readwrite` (the reshape
 *      resumes from its kernel checkpoint), `vgchange -ay <pool>` once the PV
 *      is back. Each rung is checked; a PVE warning names what happened.
 *
 *  (b) Intent files still in state 'running' — the daemon died mid-drive.
 *      The intent flips to 'halted' and a PVE warning tells the operator the
 *      expansion needs an explicit Resume (recompute-and-continue, §5.3).
 *      The scan NEVER auto-resumes: driving mutations is an operator verb.
 *
 *  (c) Arrays reshaping healthily — logged as a re-attached observation only.
 *      The kernel owns a running reshape (§5.1); ANAS re-issues NOTHING.
 */

const CAT = '/usr/bin/cat'
const MDADM = '/usr/sbin/mdadm'
const VGCHANGE = '/usr/sbin/vgchange'

export interface BootScanOptions {
  /** Intent store directory (default ANAS_AHR_INTENT_DIR / /etc/anas/ahr). */
  intentDir?: string
  /** Log sink (default console — journald via the daemon unit). */
  log?: (line: string) => void
}

export interface BootScanReport {
  /** Arrays the GT-8 ladder was driven for, as `<pool>-r<band>`. */
  recovered: string[]
  /** Pools whose 'running' intent was flipped to 'halted'. */
  haltedIntents: string[]
  /** Healthy in-flight reshapes observed (re-attached, nothing issued). */
  observedReshapes: string[]
}

/** One daemon-start pass over md state + the intent store. */
export async function ahrBootScan(executor: CommandExecutor, opts: BootScanOptions = {}): Promise<BootScanReport> {
  const intentDir = opts.intentDir ?? defaultAhrIntentDir()
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const report: BootScanReport = { recovered: [], haltedIntents: [], observedReshapes: [] }

  // ---- (a) + (c): the md view ---------------------------------------------
  const mdstatRes = await executor.exec(CAT, MDSTAT_CAT_ARGS)
  if (mdstatRes.exitCode === 0) {
    const vgActivated = new Set<string>()
    for (const md of parseMdstat(mdstatRes.stdout)) {
      const detailRes = await executor.exec(MDADM, mdadmDetailExportArgs(`/dev/${md.kernelName}`))
      const named = matchAhrArrayName(parseMdadmDetailExport(detailRes.stdout).name
        ?? parseMdadmDetailExport(detailRes.stdout).devName ?? '')
      if (!named)
        continue // foreign array — not ours to touch (guest philosophy)
      const label = `${named.pool}-r${named.band}`

      if (!md.active && md.members.length > 0 && md.members.every(m => m.spare)) {
        // (a) GT-8: inactive, all-spares. Drive the verified ladder.
        log(`ahr.boot array=${label} state=inactive-all-spares action=recovery-ladder`)
        const run = await executor.exec(MDADM, ['--run', `/dev/${md.kernelName}`])
        if (run.exitCode !== 0) {
          log(`ahr.boot array=${label} rung=mdadm-run result=failed detail=${run.stderr.trim()}`)
          await pveNotify(executor, 'error', `AHR boot recovery FAILED: ${label}`, `Array ${label} assembled inactive (all members as spares — the post-power-loss degraded-reshape state, GT-8) and 'mdadm --run' failed: ${run.stderr.trim() || `exit ${run.exitCode}`}. The pool's data is intact on disk but the array needs manual attention.`)
          continue
        }
        log(`ahr.boot array=${label} rung=mdadm-run result=ok`)
        const rw = await executor.exec(MDADM, ['--readwrite', `/dev/${md.kernelName}`])
        log(`ahr.boot array=${label} rung=mdadm-readwrite result=${rw.exitCode === 0 ? 'ok' : `failed detail=${rw.stderr.trim()}`}`)
        if (!vgActivated.has(named.pool)) {
          vgActivated.add(named.pool)
          const vg = await executor.exec(VGCHANGE, ['-ay', named.pool])
          log(`ahr.boot pool=${named.pool} rung=vgchange-ay result=${vg.exitCode === 0 ? 'ok' : `failed detail=${vg.stderr.trim()}`}`)
        }
        await pveNotify(
          executor,
          'warning',
          `AHR boot recovery: ${label}`,
          `Array ${label} assembled INACTIVE after an interrupted degraded reshape (all members listed as spares — GT-8). `
          + `ANAS ran the recovery ladder: mdadm --run (array started, degraded), mdadm --readwrite (reshape resumes from `
          + `its kernel checkpoint), vgchange -ay ${named.pool}. Replace the failed disk once the reshape completes.`,
        )
        report.recovered.push(label)
        continue
      }

      if (md.active && md.sync?.action === 'reshape') {
        // (c) Kernel-owned reshape in flight — observe, never re-issue (§5.1).
        log(`ahr.boot array=${label} state=reshaping progress=${md.sync.percent.toFixed(1)}% action=observe-only`)
        report.observedReshapes.push(label)
      }
    }
  }
  else {
    log(`ahr.boot mdstat=unreadable detail=${mdstatRes.stderr.trim()}`)
  }

  // ---- (b): expansions orphaned by a daemon death -------------------------
  for (const { pool, intent } of await listIntents(intentDir)) {
    if (intent.state !== 'running')
      continue
    await writeIntent(pool, { ...intent, state: 'halted' }, { dir: intentDir })
    log(`ahr.boot pool=${pool} intent=${intent.id} state=running->halted`)
    await pveNotify(
      executor,
      'warning',
      `AHR expansion interrupted: ${pool}`,
      `The daemon restarted while an expansion of pool '${pool}' was being driven. The recorded intent is now `
      + `halted; completed steps are safe (each step is idempotent). Review the pool, then Resume the expansion `
      + `(recompute-and-continue) or Abandon it.`,
    )
    report.haltedIntents.push(pool)
  }

  return report
}
