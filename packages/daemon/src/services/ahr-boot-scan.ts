import type { AhrPool } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { LvmPv } from '../parsers/lvm-report.js'
import type { GuardSpec } from '../safety/guard.js'
import type { NamedMdArray } from './ahr-identity.js'
import type { DiskIdentityCache } from './disk-identity-cache.js'
import { readFile } from 'node:fs/promises'
import { mountOptionTokens } from '../parsers/fstab.js'
import { isLvmReport, parsePvsReport, parseVgsReport, PVS_ARGS, VGS_ARGS } from '../parsers/lvm-report.js'
import { getProgram, parseMdadmConfDoc } from '../parsers/mdadm-conf.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { guardCheck, guarded, GuardRefusalError } from '../safety/guard.js'
import { IdentityMismatchError } from '../safety/stable-id.js'
import { cachedVgNames, notifyCacheRecoveryFailed, recoverFailedAhrCache } from './ahr-cache.js'
import { resumeExpansion } from './ahr-expand-resume.js'
import { defaultAhrFstabPath, mountAhrPool, readAhrPoolLine } from './ahr-fstab.js'
import { ahrGuard } from './ahr-guard.js'
import { isIntentStale, isOwnedArray, normalizeMdUuid, pinnedUuids, poolPvNames, readAhrPoolIdentity, readMdadmConfDoc, readNamedMdArrays, resolveMdadmConfPath } from './ahr-identity.js'
import { defaultAhrIntentDir, listIntents, writeIntent } from './ahr-intent.js'
import { ANAS_MD_EVENT_HOOK, installProgramHook } from './ahr-mdadm-conf.js'
import { isSubvolLayoutMount } from './ahr-snapshots.js'
import { AhrTopologyUnreadableError, readAhrPools } from './ahr-topology.js'
import { mountTargetRefusal } from './mounts.js'
import { pveNotify } from './pve-notify.js'
import { UDEVADM, UDEVADM_SETTLE_BUDGET_MS, udevSettleArgs } from './udev-settle.js'

/**
 * AHR daemon-start scan (Epic 11.6, docs/AHR-DESIGN.md §5.1/§5.3/§8, GT-8) —
 * runs ONCE after the daemon starts listening. Non-blocking and fail-soft:
 * every failure is logged (journald via the unit), none is fatal to the daemon.
 *
 * Four branches, each deliberately minimal:
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
 *
 *  (d) A pool whose READ CACHE device is missing (story ahrcache.1 slice 2,
 *      §13). LVM refuses to activate a partial cached LV, so such a pool comes
 *      up with its volume inactive and its fstab mount failed — and if it did
 *      come up, every read would return EIO, because dm-cache does not fall
 *      through to the origin (GT-19). The same recovery the udev rung runs
 *      (`lvconvert --uncache` → guarded `vgreduce --removemissing` →
 *      notification) happens here, then `vgchange -ay` and the fstab mount, so
 *      the pool comes up UNCACHED rather than serving errors. It runs after
 *      (a) on purpose: the `--removemissing` guard needs the band arrays
 *      present to tell a dead cache from an unassembled band. It acts ONLY on
 *      `cache.state: 'failed'`, which needs evidence the cache is the
 *      problem; a cached volume that is merely inactive (a band that did not
 *      assemble, the cache SSD fine) reads `inactive` and is left alone, and
 *      one whose `dmsetup status` could not be read reads `unknown` — nothing
 *      acts on a health that was not read.
 *      Like the udev and operator doors it refuses under an expansion intent
 *      (cr.61), and when the topology cannot be read while a VG carries a
 *      cache it tells the operator the cache went unchecked (cr.61).
 */

const CAT = '/usr/bin/cat'
const SYSTEMCTL = '/usr/bin/systemctl'
const MDADM = '/usr/sbin/mdadm'
const VGCHANGE = '/usr/sbin/vgchange'
const PVS = '/usr/sbin/pvs'
const VGS = '/usr/sbin/vgs'

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
  /** mdadm.conf override (else ANAS_MDADM_CONF / the Debian default) — the pins the ladder is gated on. */
  mdadmConfPath?: string
  /**
   * fstab path override (else ANAS_FSTAB_PATH / /etc/fstab). The cache-recover
   * rung re-mounts a pool that came up DOWN — and a down pool's topology
   * mountpoint reads as its LV device path, not the directory it mounts at. The
   * pool's OWN fstab line is where its real configured mountpoint lives; the
   * rung read it here, gates it and mounts DIRECTLY through it (cr.52r D3/P2).
   */
  fstabPath?: string
}

export interface BootScanReport {
  /** Arrays the GT-8 ladder was driven for, as `<pool>-r<band>`. */
  recovered: string[]
  /** Pools whose failed/missing read cache was dropped before mount (§13). */
  cacheRecovered: string[]
  /** Pools whose 'running' intent was flipped to 'halted'. */
  haltedIntents: string[]
  /** Pools whose in-flight expansion was re-attached and driven on after the restart. */
  reattached: string[]
  /** Healthy in-flight reshapes observed (re-attached, nothing issued). */
  observedReshapes: string[]
  /**
   * Pools whose intent recorded a DIFFERENT pool's identity (story ident.3) —
   * an earlier pool of the same name. Left alone: never halted, never driven.
   */
  staleIntents: string[]
  /**
   * The md hook re-wire (cr3): what the pass decided about ANAS's mdadm.conf
   * PROGRAM line. Optional so an older reader of the report is unaffected.
   */
  mdHook?: MdHookOutcome
}

/** What the md hook re-wire found and did (cr3). One word, logged with its detail. */
export type MdHookOutcome
  = | 'installed' // pools are ANAS's, no PROGRAM line: ANAS's hook was written
    | 'present' // ANAS's own line is already there
    | 'foreign' // another PROGRAM line — never replaced
    | 'opted-out' // ANAS's line is COMMENTED OUT: the operator's deliberate choice
    | 'no-pools' // no AHR pool this daemon identifies as its own
    | 'unreadable' // the topology or mdadm.conf could not be read: unknown is no reason to edit
    | 'failed' // the edit itself failed (logged; never fails the boot scan)

/**
 * ANAS's own PROGRAM line, commented out by the operator
 * (`#PROGRAM /usr/local/bin/anas-md-event`) — in the spellings mdadm accepts
 * for the live line (cr3 review2 4): case-insensitive, the keyword abbreviated
 * to three or more letters (`#prog`), a trailing `# note`, CRLF.
 */
const COMMENTED_ANAS_HOOK_RE = /^[\t ]*#[\t ]*pro(?:g(?:r(?:am?)?)?)?[\t ]+\/usr\/local\/bin\/anas-md-event(?:[\t ]+#[^\n]*|[\t ]*\r?)$/im

/**
 * The md hook re-wire (cr3, moved here from the installer by the
 * coordinator's decision): the uninstaller removes ANAS's own PROGRAM line
 * (so it never points at a deleted binary); after a reinstall on a node with
 * surviving AHR pools nothing put it back — `installProgramHook` ran only at
 * pool create — and md events for those pools silently stopped reaching ANAS.
 *
 * At daemon start, after the md view is read: when this node has at least
 * one AHR pool the daemon identifies AS ITS OWN (the md pass's `isOwnedArray`
 * — the pinned array UUIDs or the VG's PVs, the one identity rule `readAhrPools`
 * also applies; never a name pattern)
 * and mdadm.conf carries no PROGRAM line, the same surgical, atomic edit pool
 * create makes is made (`installProgramHook`), then `systemctl try-restart
 * mdmonitor.service` so a monitor already running reads it (try-restart: a
 * monitor that is not running is not started). No `update-initramfs`: the
 * initramfs copy of mdadm.conf serves early-boot ASSEMBLY, and the monitor
 * runs from the root filesystem — a PROGRAM-only change does not concern it.
 *
 * Nothing is edited when: there is no such pool; ANAS's line is present; a
 * FOREIGN PROGRAM line exists (logged, named); ANAS's line is commented out
 * (the operator's opt-out — logged); mdadm.conf or the topology could not be
 * read (unknown is not a reason to edit). Never throws.
 */
export async function rewireMdHook(
  executor: CommandExecutor,
  opts: {
    mdadmConfPath?: string
    log: (line: string) => void
    /**
     * The arrays the boot scan's md pass identified as ANAS's own (pinned
     * UUID, or a PV of the pool's VG — `isOwnedArray`, the one rule); `null`
     * when that md view could not be read.
     */
    ownedArrays: { pool: string, band: number, kernelName: string }[] | null
  },
): Promise<MdHookOutcome> {
  const { log } = opts
  try {
    if (opts.ownedArrays === null) {
      log('ahr.boot md-hook=unchanged reason=topology-unreadable')
      return 'unreadable'
    }
    if (opts.ownedArrays.length === 0)
      return 'no-pools'
    const confPath = resolveMdadmConfPath(opts.mdadmConfPath)
    let text: string
    try {
      text = await readFile(confPath, 'utf8')
    }
    catch (err) {
      log(`ahr.boot md-hook=unchanged reason=conf-unreadable path=${confPath} detail=${err instanceof Error ? err.message : String(err)}`)
      return 'unreadable'
    }
    const program = getProgram(parseMdadmConfDoc(text))
    if (program === ANAS_MD_EVENT_HOOK)
      return 'present'
    if (program !== undefined) {
      log(`ahr.boot md-hook=unchanged reason=foreign-program program=${program} — mdadm allows one PROGRAM line and ANAS never replaces one it does not own`)
      return 'foreign'
    }
    if (COMMENTED_ANAS_HOOK_RE.test(text)) {
      log(`ahr.boot md-hook=unchanged reason=operator-opt-out — ANAS's PROGRAM line is commented out in ${confPath}`)
      return 'opted-out'
    }
    // An EDIT needs the whole stack, not a pin alone: an ARRAY line in the
    // ANAS form is something an operator can write by hand for their own
    // `backup-r1` (the installer-review case), so the array must also be a PV
    // of the VG named for its pool — the md → LVM shape only ANAS builds. A
    // pvs that cannot be read is unknown: no edit.
    const pvsRes = await executor.exec(PVS, PVS_ARGS)
    // cr3 review2 6: exit 0 in the wrong shape is as unreadable as a failure.
    if (pvsRes.exitCode !== 0 || !isLvmReport(pvsRes.stdout, 'pv')) {
      log(`ahr.boot md-hook=unchanged reason=pvs-unreadable exit=${pvsRes.exitCode}${pvsRes.exitCode === 0 ? ' shape=not-a-pv-report' : ''}`)
      return 'unreadable'
    }
    const pvs = parsePvsReport(pvsRes.stdout)
    const pools = [...new Set(opts.ownedArrays
      .filter(a => [`/dev/${a.kernelName}`, `/dev/md/${a.pool}-r${a.band}`].some(n => poolPvNames(pvs, a.pool).has(n)))
      .map(a => a.pool))]
    if (pools.length === 0) {
      log(`ahr.boot md-hook=unchanged reason=no-full-stack arrays=${opts.ownedArrays.map(a => `${a.pool}-r${a.band}`).join(',')} — no array is a PV of its pool's volume group`)
      return 'no-pools'
    }
    await installProgramHook(ANAS_MD_EVENT_HOOK, confPath)
    // The line is written; a monitor restart that fails is logged with it —
    // the next mdmonitor start reads the line either way.
    let restarted: string
    try {
      const restart = await executor.exec(SYSTEMCTL, ['try-restart', 'mdmonitor.service'])
      restarted = restart.exitCode === 0 ? 'ok' : `exit-${restart.exitCode}`
    }
    catch (err) {
      restarted = `failed(${err instanceof Error ? err.message : String(err)})`
    }
    log(`ahr.boot md-hook=installed pools=${pools.join(',')} path=${confPath} mdmonitor-try-restart=${restarted}`)
    return 'installed'
  }
  catch (err) {
    log(`ahr.boot md-hook=failed detail=${err instanceof Error ? err.message : String(err)}`)
    return 'failed'
  }
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
  const report: BootScanReport = { recovered: [], cacheRecovered: [], haltedIntents: [], reattached: [], observedReshapes: [], staleIntents: [] }

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
  // Identity first (story ident.3, identity audit #5): a `<pool>-r<N>` NAME
  // proves nothing — a hand-built `media-r1` mirror, or an ANAS pool moved in
  // from another node, carries the same name. The ladder FORCE-STARTS an array
  // (`mdadm --run` drops whatever member is missing), so it runs only on an
  // array whose UUID is pinned for its pool in mdadm.conf. Health accounting
  // for the (b) re-attach gate counts only the pool's own arrays too (pinned,
  // or a PV of its VG — the shared rule). Both reads fail closed: an
  // unreadable conf pins nothing, an unreadable `pvs` claims nothing.
  // LVM is asked only for an array the pins do not already vouch for (most
  // boots: none), and at most once.
  const confDoc = await readMdadmConfDoc(opts.mdadmConfPath)
  let lvm: { pvs: LvmPv[], vgNames: Set<string> } | null = null
  const lvmFacts = async (): Promise<{ pvs: LvmPv[], vgNames: Set<string> }> => {
    if (!lvm) {
      const pvsRes = await executor.exec(PVS, PVS_ARGS)
      const vgsRes = await executor.exec(VGS, VGS_ARGS)
      lvm = {
        pvs: pvsRes.exitCode === 0 ? parsePvsReport(pvsRes.stdout) : [],
        vgNames: new Set(vgsRes.exitCode === 0 ? parseVgsReport(vgsRes.stdout).map(v => v.name) : []),
      }
    }
    return lvm
  }
  // The array list comes from cr.63's typed reader (cr.61r): a `/proc/mdstat`
  // or `--detail` read that could not SEE throws AhrTopologyUnreadableError
  // rather than reading as "no arrays" — or, as the old direct `mdadm` call
  // did, as "not our array" (an empty detail matches no AHR name). The ladder
  // force-starts arrays, so it must never run on a half-seen md view: the
  // whole pass skips, with a journald line naming the read (the shape the
  // unreadable-mdstat case always had), and the (b) gate then finds no healthy
  // pool — the fail-closed direction. An ABSENT /proc/mdstat is honestly "no
  // md arrays" (cr.33e) and the reader returns empty for it.
  let namedArrays: NamedMdArray[]
  // The pools the md pass identifies as ANAS's own — the md hook re-wire's
  // evidence (cr3); null when the md view could not be read.
  let ownedArrays: { pool: string, band: number, kernelName: string }[] | null = []
  try {
    namedArrays = await readNamedMdArrays(executor)
  }
  catch (err) {
    const read = err instanceof AhrTopologyUnreadableError ? err.command : 'md view'
    log(`ahr.boot md-arrays=unreadable read=${read} detail=${err instanceof Error ? err.message : String(err)}`)
    namedArrays = []
    ownedArrays = null
  }
  const vgActivated = new Set<string>()
  for (const arr of namedArrays) {
    const md = arr.mdstat
    const detail = arr.detail
    const named = { pool: arr.pool, band: arr.band }
    const label = `${named.pool}-r${named.band}`
    const pinned = pinnedUuids(confDoc, named.pool)
    const facts = { pool: named.pool, band: named.band, uuid: detail.uuid, kernelName: md.kernelName }
    const vouched = detail.uuid !== null && pinned.has(normalizeMdUuid(detail.uuid))
    const owned = vouched || await lvmFacts().then(f => isOwnedArray(facts, pinned, poolPvNames(f.pvs, named.pool), f.vgNames.has(named.pool)))
    if (!owned) {
      // A named-but-not-ours array (a hand-built `media-r1`): not ours to
      // touch (guest philosophy) — but its detail ANSWERED, unlike the
      // unreadable case above, which threw.
      log(`ahr.boot array=${label} kernel=${md.kernelName} uuid=${detail.uuid ?? 'unknown'} action=ignored reason=not-pinned-not-in-vg`)
      continue
    }
    ownedArrays?.push({ pool: named.pool, band: named.band, kernelName: md.kernelName })

    // Classify this array's health for the (b) re-attach gate. Inactive OR
    // count-degraded (activeDevices < raidDevices) OR any faulted member ⇒
    // not healthy. An active reshaping/auto-read-only array is healthy.
    const countDegraded = md.raidDevices !== null && md.activeDevices !== null && md.activeDevices < md.raidDevices
    const faulted = md.members.some(m => m.faulty)
    noteArrayHealth(named.pool, md.active && !countDegraded && !faulted)

    if (!md.active && md.members.length > 0 && md.members.every(m => m.spare)) {
      // (a) GT-8: inactive, all-spares. Drive the verified ladder — but only
      // on a PINNED array: a PV-of-VG proof needs the array active, and an
      // unpinned inactive array is exactly the shape a foreign one has.
      if (detail.uuid === null || !pinned.has(normalizeMdUuid(detail.uuid))) {
        log(`ahr.boot array=${label} state=inactive-all-spares action=skipped reason=not-pinned`)
        continue
      }
      // cr3 AHR-CORE-L7: inactive with every member `(S)` is ALSO what an
      // incremental assembly still waiting for a slow disk looks like, and
      // `--run` would start that array degraded, dropping the late member.
      // Let udev finish delivering the members first, then read mdstat again:
      // an array that assembled on its own is not this ladder's.
      // cr3 review 8: neither read may throw out of the boot scan (the other
      // arrays, the cache rung and the re-attach would all be skipped), and a
      // settle or a re-read that did not answer is unknown — never a reason
      // to start the array degraded.
      let now: ReturnType<typeof parseMdstat>[number] | undefined
      try {
        await executor.exec(UDEVADM, udevSettleArgs(), { timeoutMs: UDEVADM_SETTLE_BUDGET_MS })
        const again = await executor.exec(CAT, MDSTAT_CAT_ARGS)
        if (again.exitCode !== 0) {
          log(`ahr.boot array=${label} state=inactive-all-spares action=skipped reason=mdstat-unreadable-after-settle exit=${again.exitCode}`)
          continue
        }
        now = parseMdstat(again.stdout).find(a => a.kernelName === md.kernelName)
      }
      catch (err) {
        log(`ahr.boot array=${label} state=inactive-all-spares action=skipped reason=settle-or-reread-failed detail=${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (now === undefined) {
        log(`ahr.boot array=${label} state=vanished-after-settle action=none`)
        continue
      }
      if (now.active) {
        log(`ahr.boot array=${label} state=assembled-after-settle action=none`)
        continue
      }
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
        // cr3 AHR-CORE-L7: say what was READ — inactive, every member a
        // spare, still so after udev settled — never a reshape nobody read.
        `Array ${label} assembled INACTIVE with every member listed as a spare, and stayed so after udev settled — the shape `
        + `GT-8 recorded after a power loss during a degraded reshape. ANAS ran the recovery ladder: mdadm --run (array `
        + `started, degraded), mdadm --readwrite (an interrupted reshape resumes from its kernel checkpoint), vgchange -ay `
        + `${named.pool}. Check the array in the Hybrid RAID view and replace any failed disk once md is idle.`,
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

  // ---- (b): expansions orphaned by a daemon death -------------------------
  // Loaded lazily and once — only when a healthy pool is actually eligible to
  // re-attach (the topology read is not free; most boots have no orphan).
  let poolsByName: Map<string, AhrPool> | null = null
  const loadPools = async (): Promise<Map<string, AhrPool>> => {
    if (!poolsByName)
      poolsByName = new Map((await readAhrPools(executor)).map(p => [p.name, p]))
    return poolsByName
  }

  // ---- (d): a pool whose cache PV is MISSING, recovered BEFORE the mount ---
  // Story ahrcache.1 slice 2, AHR-DESIGN §13. LVM REFUSES to activate a pool LV
  // whose cache metadata is gone — "Refusing activation of partial LV", in
  // normal mode AND under `--activationmode degraded` (GT §18) — so a node that
  // boots with the cache SSD dead comes up with the volume inactive, the fstab
  // mount failed and the pool serving nothing. And if it did activate, every
  // read would return EIO: dm-cache does not fall through to the origin
  // (GT-19). A pool must never come up serving EIO, so the same recovery the
  // udev rung runs happens here, before anything tries to use the filesystem.
  //
  // It runs AFTER the md pass above, and that order is load-bearing: the
  // `vgreduce --removemissing` guard requires every band to be present as its
  // own named md PV, because an unassembled band reads `[unknown]` in `pvs`
  // exactly as a dead cache device does (GT-19). Driving the GT-8 ladder first
  // gives the guard the band arrays it needs to tell the two apart; a pool
  // whose bands are still down fails the guard and is left alone, loudly.
  //
  // A HEALTHY cached pool is untouched — `cache.state` comes from
  // `dmsetup status`, the one signal that can tell a working cache from a dead
  // one (`lvs` counters go stale rather than absent, GT-23). So is an
  // INACTIVE one: a cached volume that could not activate because a BAND
  // array is down reads `inactive`, and uncaching a partial VG over a healthy
  // SSD — then announcing the SSD missing — is exactly what this rung must not
  // do. Only `failed` (a failure word from dm, or the cache PV's device gone
  // under the band guard) is evidence enough to act on. `unknown` is not
  // evidence: an ACTIVE cache target whose `dmsetup status` did not answer has
  // no verdict at all, and uncaching on it would drop a healthy, mounted cache
  // (and announce a cache device failure that nobody read) — the rung says the
  // cache went unchecked instead, exactly as it does for an unreadable
  // topology.
  //
  // ONE `lvs` call gates the whole rung: most daemon starts have no cache on
  // the node at all, and the topology read this needs is a dozen commands.
  //
  // A topology that cannot be read while a VG carries a cache is NOT silent
  // (cr.61, review M8): the rung cannot tell a dead cache from a healthy one
  // without it, so it acts on nothing — and says so to the operator, once per
  // cached VG, because nothing else will. The udev rung may have been refused
  // for the same unreadable topology (the script logs that as undelivered),
  // and the pool can be returning EIO on every read. The sentence claims only
  // what is known: the VG carries a cache and its state was not checked.
  const cachedVgs = await cachedVgNames(executor)
  let cacheCandidates: AhrPool[] = []
  if (cachedVgs.size > 0) {
    try {
      cacheCandidates = [...(await loadPools()).values()].filter(p => cachedVgs.has(p.name))
    }
    catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      log(`ahr.boot cache-rung=skipped reason=topology-unreadable vgs=${[...cachedVgs].join(',')} detail=${detail}`)
      for (const vg of cachedVgs)
        await notifyCacheUnchecked(executor, vg, { kind: 'topology', detail })
    }
  }
  const bootGuard = ahrGuard({ executor, intentDir, iscsiPaths: () => ({}) })
  for (const pool of cacheCandidates) {
    // An ACTIVE cache target whose `dmsetup status` did not answer carries no
    // verdict (cr4 D-28). Nothing acts on it — and the operator is told the
    // cache went unchecked, once per pool: silence would leave a pool that may
    // be serving EIO with no signal at all, and a `failed` here would uncache
    // a healthy cache. The body names this cause, not the unreadable topology
    // above: the pool WAS read, which is how its cache state is known.
    if (pool.cache?.state === 'unknown') {
      log(`ahr.boot pool=${pool.name} cache-rung=skipped reason=status-unreadable`)
      await notifyCacheUnchecked(executor, pool.name, { kind: 'pool-cache' })
      continue
    }
    if (pool.cache?.state !== 'failed')
      continue
    // "missing" only on the evidence of a missing device; a cache that is
    // present but failed is described as failed, never as a device that is gone.
    const cause = pool.cache.deviceMissing === true ? 'missing' as const : 'failed' as const
    log(`ahr.boot pool=${pool.name} cache=failed cause=${cause} action=recover-before-mount`)

    /** The rung on the pool as `target` reads it; throws (after logging and notifying) when it fails. */
    const rung = async (target: AhrPool): Promise<void> => {
      try {
        const outcome = await recoverFailedAhrCache(
          executor,
          { pool: target, reason: cause },
          message => log(`ahr.boot pool=${target.name} rung=cache-recover progress=${message}`),
          { log },
        )
        // The volume could not activate while the cache metadata was missing, so
        // the pool is almost certainly down: activate it, then mount the pool's
        // own configured entry directly through a directory the daemon opened
        // (cr.52r D3) — the kernel resolves /proc/self/fd/3, so a swapped parent
        // cannot redirect the boot mount either.
        if (!target.mounted) {
          const vg = await executor.exec(VGCHANGE, ['-ay', target.name])
          log(`ahr.boot pool=${target.name} rung=vgchange-ay result=${vg.exitCode === 0 ? 'ok' : `failed detail=${vg.stderr.trim()}`}`)
          // cr.52r P2: the boot re-attach MOUNTS the stored path again — the
          // refusal runs on it first. The boot path must never take the daemon
          // down: a refused (or otherwise unmountable) pool is logged and left
          // for the operator, never thrown.
          //
          // A DOWN pool reads its mountpoint as its LV device path (ahr-topology's
          // honest "where the filesystem lives" fallback) — not a directory, and
          // not the path the refusal can gate. The pool's OWN fstab line is where
          // its real configured mountpoint lives; the rung mounts that line
          // directly, so the kernel neither pivots a device-path lookup nor mounts
          // at a place the gate never checked. No line: never invent a mount —
          // log and leave the pool for the operator.
          //
          // cr.52s-a (review defect 7): EVERY outcome of this mount step is
          // logged and kept here — nothing it does throws into the
          // cache-recover catch below. By now the cache WAS dropped (uncache +
          // removemissing succeeded), so the recovery is reported as done; a
          // pool left unmounted gets its own notice naming the mount step,
          // never "could not drop the cache". And an fstab that could not be
          // READ is said so (P1), never reported as "no line".
          const fstabPath = opts.fstabPath ?? defaultAhrFstabPath()
          const line = await readAhrPoolLine(fstabPath, target.name)
          const leftUnmounted = async (why: string): Promise<void> => {
            await pveNotify(
              executor,
              'warning',
              `AHR pool not re-mounted: ${target.name}`,
              `ANAS dropped the failed read cache of pool '${target.name}' at start-up (the pool now runs uncached), but did not mount the pool: ${why} `
              + `The pool's data is intact; it serves nothing until it is mounted — check its line in ${fstabPath} and mount it from the Hybrid RAID view.`,
            )
          }
          if (line.kind === 'unreadable') {
            log(`ahr.boot pool=${target.name} rung=mount result=skipped fstab=unreadable read=${line.detail}`)
            await leftUnmounted(`${fstabPath} could not be read (${line.detail}), so the pool's configured mountpoint is unknown.`)
          }
          else if (line.kind === 'none') {
            log(`ahr.boot pool=${target.name} rung=mount result=no-fstab-entry`)
            await leftUnmounted(`${fstabPath} has no active line for the pool, and ANAS never invents a mount.`)
          }
          else {
            const entry = line.entry
            const refusal = await mountTargetRefusal(entry.mountpoint)
            if (refusal) {
              log(`ahr.boot pool=${target.name} rung=mount result=refused detail=${refusal.message}`)
              await leftUnmounted(`${refusal.message}.`)
            }
            else {
              try {
                // cr.52s-a: the line AS STORED rides the argv (its spec, type and
                // every option the operator gave it), never ANAS's rebuilt defaults.
                await mountAhrPool(executor, {
                  name: target.name,
                  mountpoint: entry.mountpoint,
                  subvolLayout: isSubvolLayoutMount(mountOptionTokens(entry)),
                }, entry)
                log(`ahr.boot pool=${target.name} rung=mount result=ok`)
              }
              catch (err) {
                const detail = err instanceof Error ? err.message : String(err)
                log(`ahr.boot pool=${target.name} rung=mount result=failed detail=${detail}`)
                await leftUnmounted(`mounting it at '${entry.mountpoint}' failed: ${detail}.`)
              }
            }
          }
        }
        log(`ahr.boot pool=${target.name} rung=cache-recover uncached=${outcome.uncached} vgreduced=${outcome.vgReduced}`)
        report.cacheRecovered.push(target.name)
      }
      catch (err) {
        // The guard refusing (bands still down) lands here, and so does any LVM
        // failure. Never fatal to the daemon; loud, because the pool is serving
        // nothing until someone acts. The notification body is the shared one —
        // the udev rung's event job announces the identical failure.
        const message = err instanceof Error ? err.message : String(err)
        log(`ahr.boot pool=${target.name} rung=cache-recover result=failed detail=${message}`)
        await notifyCacheRecoveryFailed(executor, target.name, 'boot', message, cause)
        throw err
      }
    }

    if (opts.jobQueue) {
      // Story cr.38 (§4.4 "work outside the queue"): the rung is a JOB with
      // the pool's key, like the udev rung's and an operator's detach — so it
      // never runs beside a cache verb an operator submitted while the scan
      // was still walking md (the socket serves before the scan ends), and
      // the pool it acts on is the one the job reads under that key, still
      // failed. The scan waits for it: the intent branch below reads the pool
      // this rung may just have brought up.
      await runCacheRungAsJob(opts.jobQueue, bootGuard, pool, rung, log).catch(() => {})
    }
    else {
      // No queue injected (a request-less caller / legacy test): the rung runs
      // in the scan, as it did before cr.38 — behind the same gates the job
      // runs (cr.61: the expansion-intent gate included). The daemon always
      // injects a queue.
      const pre = await guardCheck(bootCacheSpec(bootGuard, pool.name))
      if ('refusal' in pre)
        log(`ahr.boot pool=${pool.name} rung=cache-recover result=skipped detail=${pre.refusal.message}`)
      else
        await rung(pre.object).catch(() => {})
    }
    // Whatever happened, this pool's record is stale now.
    poolsByName = null
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

    // An intent that recorded another pool's identity is that pool's — a
    // destroy-then-recreate under the same name (story ident.3). It is never
    // this pool's halted expansion and never drives this pool's disks.
    if (intent.arrayUuids?.length || intent.vgUuid) {
      const identity = await readAhrPoolIdentity(executor, pool, { mdadmConfPath: opts.mdadmConfPath, withVgUuid: true }).catch(() => null)
      if (identity && isIntentStale(intent, identity)) {
        log(`ahr.boot pool=${pool} intent=${intent.id} state=running action=ignored reason=stale-identity`)
        report.staleIntents.push(pool)
        continue
      }
    }

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

  // ---- (e): the md hook re-wire (cr3) — never fails the scan --------------
  report.mdHook = await rewireMdHook(executor, { mdadmConfPath: opts.mdadmConfPath, log, ownedArrays })

  return report
}

/** Synthetic identity of the boot cache rung's job (audit-traceable, like the re-attach's). */
const BOOT_CACHE_IDENTITY = { user: 'system:boot-cache', uid: 0 } as const

/**
 * A cached VG the boot scan could not judge, said to the operator once per VG.
 * Two causes, two bodies:
 *
 *  - `topology` (cr.61, review M8): the AHR topology was unreadable, so whether
 *    the VG's cache failed is unknown. `lvs` names every cached VG on the node,
 *    an operator's own lvmcache VG included, so whether the VG is an AHR pool
 *    is not established here and the body says "if".
 *  - `pool-cache` (cr4 D-28): the pool WAS read and its cache state is
 *    `unknown` because `dmsetup status` on the pool volume did not answer, so
 *    only the cache status could not be checked.
 *
 * Not {@link notifyCacheRecoveryFailed}: that body asserts a failed or missing
 * cache and a pool that cannot serve reads, which the scan has no evidence for
 * here.
 */
async function notifyCacheUnchecked(
  executor: CommandExecutor,
  vg: string,
  cause: { kind: 'topology', detail: string } | { kind: 'pool-cache' },
): Promise<void> {
  const body = cause.kind === 'topology'
    ? `Volume group '${vg}' carries a read cache, and ANAS could not read the AHR pools at start-up (${cause.detail}), `
    + `so it could not check whether that cache has failed; the automatic recovery of a failed or missing cache device did not run. `
    + `If '${vg}' is an AHR pool whose cache device has failed, every read on the pool returns an I/O error until the cache is removed. `
    + `Check the pool in the Hybrid RAID view and Detach the cache there if it reads failed.`
    : `The read cache of AHR pool '${vg}' could not be checked at start-up because dmsetup status for the pool volume did not answer. `
      + `The automatic recovery of a failed or missing cache device did not run. `
      + `If the cache device has failed, every read on the pool returns an I/O error until the cache is removed. `
      + `Open the Hybrid RAID view and reload it, and Detach the cache there if it reads failed.`
  await pveNotify(executor, 'warning', `AHR read cache not checked: ${vg}`, body)
}

/**
 * The boot rung's guard spec — the job's and the inline path's, one list.
 *
 * THE EXPANSION-INTENT GATE FIRST (cr.61, review L19), as the udev door and
 * the operator's detach apply it: `vgreduce --removemissing` must not run
 * while the VG's shape is in flight, and a half-done expansion's unassembled
 * band reads `[unknown]` in `pvs` exactly as a dead cache device does. The rung
 * skips and logs; it loses nothing — once the expansion completes or is
 * abandoned, the next daemon start or cache event runs it.
 */
function bootCacheSpec(guard: ReturnType<typeof ahrGuard>, poolName: string): GuardSpec<AhrPool> {
  return {
    operation: 'ahr.cache.detach',
    object: guard.poolView(poolName, 'a boot cache recovery'),
    gates: [
      guard.intentGate('the automatic cache recovery is skipped at start-up; it re-runs at the next daemon start or cache event once the expansion completes or is abandoned'),
      // The evidence, asked again on the pool each door reads: only `failed`
      // is evidence enough to act on (see the rung's comment above).
      async p => p.cache?.state === 'failed'
        ? null
        : { status: 409, code: 'STATE_CHANGED', message: `the read cache on AHR pool '${p.name}' reads '${p.cache?.state ?? 'absent'}' now — nothing to recover` },
    ],
    locks: async (p, bound) => guard.claims(p, bound, 'exclusive'),
  }
}

/**
 * The boot cache rung as a JOB (story cr.38, WAVE3-DESIGN §4.4 "work outside
 * the queue"): the DETACH operation (it is the same work, and the cache verbs'
 * in-flight answer is keyed on that pair), the pool's key exclusive, and the
 * guard's two doors — the scan's read is the first, the job re-reads the pool
 * under the key and runs the rung only if it is the same pool and its cache
 * still reads failed. Resolves when the rung succeeded; rejects when it
 * failed (already logged and notified by the rung) or the guard refused
 * (logged here).
 */
async function runCacheRungAsJob(
  queue: JobQueue,
  guard: ReturnType<typeof ahrGuard>,
  pool: AhrPool,
  rung: (target: AhrPool) => Promise<void>,
  log: (line: string) => void,
): Promise<void> {
  const spec = bootCacheSpec(guard, pool.name)
  const pre = await guardCheck(spec)
  if ('refusal' in pre) {
    log(`ahr.boot pool=${pool.name} rung=cache-recover result=skipped detail=${pre.refusal.message}`)
    throw new GuardRefusalError(pre.refusal)
  }

  const handler = guarded(spec, pre, async (live) => {
    await rung(live)
    return { pool: live.name, recovered: true }
  })
  let failure: unknown = null
  let settle!: () => void
  const ended = new Promise<void>((resolve) => {
    settle = resolve
  })
  const job = queue.submit(
    'ahr.cache.detach',
    { ...BOOT_CACHE_IDENTITY, params: { pool: pool.name, trigger: 'boot' } },
    async (updateProgress, ctx) => {
      try {
        return await handler(updateProgress, ctx)
      }
      catch (err) {
        failure = err
        throw err
      }
      finally {
        settle()
      }
    },
    { locks: pre.locks },
  )
  log(`ahr.boot pool=${pool.name} rung=cache-recover job=${job.id}`)
  await ended
  if (failure !== null) {
    // A guard refusal never reached the rung, so it is logged here; the
    // rung's own failure was logged and notified inside it.
    if (failure instanceof GuardRefusalError || failure instanceof IdentityMismatchError)
      log(`ahr.boot pool=${pool.name} rung=cache-recover result=refused detail=${failure.message}`)
    throw failure
  }
}
