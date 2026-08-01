import type { AhrPool } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { DiskIdentityCache } from './disk-identity-cache.js'
import { matchAhrArrayName, mdadmDetailExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { resumeExpansion } from './ahr-expand-resume.js'
import { defaultAhrIntentDir, listIntents, writeIntent } from './ahr-intent.js'
import { readAhrPools } from './ahr-topology.js'
import { pveNotify } from './pve-notify.js'

/**
 * AHR daemon-start scan (Epic 11.6, docs/AHR-DESIGN.md §5.1/§5.3/§8, GT-8) —
 * runs ONCE after the daemon starts listening. Non-blocking and fail-soft:
 * every failure is logged (journald via the unit), none is fatal to the daemon.
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
 *  (b) Intent files still in state 'running' — the daemon died mid-drive
 *      (most commonly an ANAS upgrade). Nothing was "paused": the kernel reshape
 *      was NEVER interrupted (§5.1), only ANAS's job tracking dropped (issue #1).
 *      So ANAS RE-ATTACHES to the in-flight expansion — it does not restart a
 *      stopped operation. Behavior depends NARROWLY on the pool's array health,
 *      gathered in the (a)+(c) pass:
 *        • HEALTHY (arrays active, not degraded/failed/inactive — an in-flight
 *          reshape or a clean/complete-with-post-steps-pending array): ANAS
 *          re-attaches via the SHARED §5.3 resume core under a synthetic system
 *          identity — which observes the kernel-owned reshape (never re-issued)
 *          and drives only the idempotent remainder. This is the issue's exact
 *          scenario (a healthy reshape interrupted only by a daemon restart).
 *          It is a NON-EVENT: journald records it, but no PVE notification fires
 *          — the correct signal is simply the UI showing the expansion running
 *          again. resumeExpansion's own fail-closed prechecks (missing approved
 *          disk / planner refusal) are a SECOND safety layer — if they trip, the
 *          intent falls back to halted (and THAT warns).
 *        • DEGRADED / FAILED / INACTIVE / GT-8 recovery path: NO re-attach. The
 *          intent flips to 'halted' and a PVE warning tells the operator to
 *          Resume or Abandon. Driving an expansion onto a degraded/failed array
 *          stays an operator verb.
 *
 *  (c) Arrays reshaping healthily — logged as a re-attached observation only.
 *      The kernel owns a running reshape (§5.1); ANAS re-issues NOTHING.
 */

const CAT = '/usr/bin/cat'
const MDADM = '/usr/sbin/mdadm'
const VGCHANGE = '/usr/sbin/vgchange'

/** Synthetic identity for a boot-time re-attach's driving job (audit-traceable). */
const BOOT_IDENTITY = { user: 'system:boot-reattach', uid: 0 } as const

export interface BootScanOptions {
  /** Intent store directory (default ANAS_AHR_INTENT_DIR / /etc/anas/ahr). */
  intentDir?: string
  /** Log sink (default console — journald via the daemon unit). */
  log?: (line: string) => void
  /**
   * Job queue for submitting a re-attach's driving job. When absent, the boot
   * scan CANNOT re-attach and falls back to the halt-and-warn behavior (a
   * request-less caller / legacy test). Injected — never a global.
   */
  jobQueue?: JobQueue
  /** Disk-identity cache the shared resume core needs to resolve NEW disks. */
  diskCache?: DiskIdentityCache
}

export interface BootScanReport {
  /** Arrays the GT-8 ladder was driven for, as `<pool>-r<band>`. */
  recovered: string[]
  /** Pools whose 'running' intent was flipped to 'halted'. */
  haltedIntents: string[]
  /** Pools whose in-flight expansion was re-attached and driven on after the restart. */
  reattached: string[]
  /** Healthy in-flight reshapes observed (re-attached, nothing issued). */
  observedReshapes: string[]
}

/**
 * The existing halt-and-warn message body, optionally appended with WHY a
 * re-attach could not proceed. Kept in one place so the two halt call sites
 * never drift (single source).
 */
function haltBody(pool: string, reason?: string): string {
  const base = `The daemon restarted while an expansion of pool '${pool}' was being driven. The recorded intent is now `
    + `halted; completed steps are safe (each step is idempotent). Review the pool, then Resume the expansion `
    + `(recompute-and-continue) or Abandon it.`
  return reason
    ? `${base} ANAS tried to re-attach automatically after the restart but could not proceed: ${reason}`
    : base
}

/** One daemon-start pass over md state + the intent store. */
export async function ahrBootScan(executor: CommandExecutor, opts: BootScanOptions = {}): Promise<BootScanReport> {
  const intentDir = opts.intentDir ?? defaultAhrIntentDir()
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const report: BootScanReport = { recovered: [], haltedIntents: [], reattached: [], observedReshapes: [] }

  // Per-pool array health, folded across every AHR array seen in the md view.
  // A pool is re-attach-eligible only if it was SEEN and EVERY one of its
  // arrays is active and not degraded/failed/inactive (a reshape in flight is
  // still healthy). Any inactive/degraded array (incl. the GT-8 branch-(a)
  // ladder case) makes the pool ineligible → operator verb only.
  const poolHealthy = new Map<string, boolean>()
  const noteArrayHealth = (pool: string, healthy: boolean) => {
    poolHealthy.set(pool, (poolHealthy.get(pool) ?? true) && healthy)
  }

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

      // Classify this array's health for the (b) re-attach gate. Inactive OR
      // count-degraded (activeDevices < raidDevices) OR any faulted member ⇒
      // not healthy. An active reshaping/auto-read-only array is healthy.
      const countDegraded = md.raidDevices !== null && md.activeDevices !== null && md.activeDevices < md.raidDevices
      const faulted = md.members.some(m => m.faulty)
      noteArrayHealth(named.pool, md.active && !countDegraded && !faulted)

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
  // Loaded lazily and once — only when a healthy pool is actually eligible to
  // re-attach (the topology read is not free; most boots have no orphan).
  let poolsByName: Map<string, AhrPool> | null = null
  const loadPools = async (): Promise<Map<string, AhrPool>> => {
    if (!poolsByName)
      poolsByName = new Map((await readAhrPools(executor)).map(p => [p.name, p]))
    return poolsByName
  }

  const halt = async (pool: string, intent: Awaited<ReturnType<typeof listIntents>>[number]['intent'], reason?: string) => {
    await writeIntent(pool, { ...intent, state: 'halted' }, { dir: intentDir })
    log(`ahr.boot pool=${pool} intent=${intent.id} state=running->halted${reason ? ` reason=${reason}` : ''}`)
    await pveNotify(executor, 'warning', `AHR expansion interrupted: ${pool}`, haltBody(pool, reason))
    report.haltedIntents.push(pool)
  }

  for (const { pool, intent } of await listIntents(intentDir)) {
    if (intent.state !== 'running')
      continue

    const eligible = poolHealthy.get(pool) === true && !!opts.jobQueue && !!opts.diskCache
    if (!eligible) {
      // Degraded / failed / inactive / GT-8 recovery path (or resume deps not
      // injected): driving an expansion stays an operator verb — UNCHANGED.
      await halt(pool, intent)
      continue
    }

    // Healthy interrupted reshape (the issue's scenario): the kernel reshape
    // never stopped — only this daemon's job tracking died — so ANAS RE-ATTACHES
    // to the in-flight expansion rather than restarting anything. The on-disk
    // 'running' is stale (its driver is gone), so flip it to 'halted' and
    // re-enter the SHARED resume core, which recomputes the plan, WAITS on the
    // kernel-owned reshape (never re-issued), and drives only the idempotent
    // remainder — flipping 'halted'→'running' on success. On any fail-closed
    // refusal it stays halted and we warn with the reason.
    await writeIntent(pool, { ...intent, state: 'halted' }, { dir: intentDir })
    const halted = { ...intent, state: 'halted' as const }
    let outcome: Awaited<ReturnType<typeof resumeExpansion>>
    try {
      const p = (await loadPools()).get(pool)
      outcome = p
        ? await resumeExpansion({ pool: p, intent: halted, executor, jobQueue: opts.jobQueue!, diskCache: opts.diskCache!, intentDir, identity: BOOT_IDENTITY })
        : { ok: false, reason: 'missing-disk', message: `pool '${pool}' topology could not be read` }
    }
    catch (err) {
      // A read/plan failure must never crash the daemon or block startup.
      outcome = { ok: false, reason: 'plan-error', message: err instanceof Error ? err.message : String(err) }
    }

    if (outcome.ok) {
      // The kernel reshape never stopped; ANAS only lost its job tracking on
      // restart. Re-attaching to the in-flight expansion and driving the
      // idempotent remainder is a NON-EVENT — journald records it (audit), but
      // it warrants no PVE notification: the UI already shows the expansion
      // running again, which is the correct representation.
      log(`ahr.boot pool=${pool} intent=${intent.id} state=running action=reattached`)
      report.reattached.push(pool)
      continue
    }
    // Re-attach could not proceed (fail-closed): the intent is already
    // halted — warn with the reason so the operator can Resume/Abandon.
    log(`ahr.boot pool=${pool} intent=${intent.id} state=running->halted reason=${outcome.reason}`)
    await pveNotify(executor, 'warning', `AHR expansion interrupted: ${pool}`, haltBody(pool, outcome.message))
    report.haltedIntents.push(pool)
  }

  return report
}
