/**
 * `/v1/iscsi/health` — the persisted ⟷ live diff (story `iscsi.2`).
 *
 * This endpoint exists because of one ground-truth finding: **a boot restore
 * whose backing device was missing reports systemd SUCCESS** and comes up with a
 * hole in it (GT-20/GT-21). `targetctl` collects the per-object errors and
 * prints them without ever turning one into an exit code, so `Restart=` and
 * `OnFailure=` can never catch it; with a whole pool late, the target comes up
 * enabled, listening, and serving ZERO LUNs while an initiator logs in happily
 * and sees no disks.
 *
 * The only detector is to compare what `saveconfig.json` says should exist
 * against what configfs actually has. That comparison is this file.
 *
 * Two other things LIO will never tell anyone:
 *
 *  - **A portal on an address that does not exist.** Creating one succeeds,
 *    `targetcli ls` shows `[OK]`, `ss` shows the listener, and deleting the
 *    interface produces no error and no log line — ever (GT-24). So ANAS diffs
 *    the configured portal addresses against the node's own addresses itself.
 *  - **Live changes nobody persisted.** Anything created outside ANAS and never
 *    saved simply disappears at the next boot.
 *
 * And one thing this diff GUARDS: `degraded` is the flag that must stop any
 * `saveconfig` (stories `iscsi.4`/`iscsi.5`). After a degraded restore, LIO's
 * in-memory config no longer contains the missing LUN, so a save — including the
 * AUTOMATIC one when a stdin-mode targetcli session exits — writes the truncated
 * config over the file and the LUN is gone for good (GT-22).
 *
 * `iscsi.2` stopped at the shape; `iscsi.5` added the two consumers, and neither
 * re-reads anything this file already knows:
 *
 *  - `services/iscsi-warnings.ts` turns this into `iscsi` dashboard cards;
 *  - `services/iscsi-repair.ts` turns `missingLuns` into the surgical replay
 *    that puts the holes back once their backing devices are present.
 *
 * `iscsi.5` also added `targetsServingNothing` — the GT-21 whole-pool-late case,
 * where the target restores enabled and listening with ZERO LUNs. It is not just
 * a count of `missingLuns`: the consequence is different in kind (an initiator
 * logs in successfully and sees nothing), so it is its own finding and its own
 * card.
 */

import type { IscsiDisabledTarget, IscsiForeignChange, IscsiHealth, IscsiMissingLun, IscsiPortalWithoutInterface, IscsiRestoreMarkRow, IscsiRestoreMarkState, IscsiStubLun, IscsiTargetDetail, IscsiTargetServingNothing, IscsiUnmappedBackstore } from '@anas/shared'
import type { BackingClassification } from './iscsi-ownership.js'
import type { IscsiReadContext } from './iscsi.js'
import type { RestoreJobFacts, RestoreMarkRead } from './restore-mark.js'
import { classifyBacking } from './iscsi-ownership.js'
import { iscsiAvailability, liveUnreadablePaths, normalizePlugin, targetTpgs } from './iscsi.js'
import { fileRestoreAgain, restoreMarkDetail, restoreMarkState } from './restore-mark.js'

/** One live backstore that no live LUN maps (cr3.lunrestore). */
export interface UnmappedBackstoreFacts {
  name: string
  /** Normalised plugin (`block`, `fileio`, ...). */
  plugin: string
  /** `udev_path` — the backing object it holds. */
  backingPath: string
  serial: string | null
  /** In the saved configuration too; null when that file could not be read. */
  persisted: boolean | null
  /** Where the backing resolves — ownership, pool and dataset. */
  classification: BackingClassification
}

/**
 * Every LIVE backstore that no LIVE LUN of any target, in any TPG, maps
 * (cr3.lunrestore). Pure over the gathered context.
 *
 * Why it matters: LIO holds a backing object because the BACKSTORE exists,
 * not because a LUN or a session does (GT-40: the refusals "are all-or-nothing
 * and identical whether or not an initiator is connected"), and a new-LUN image
 * restore keeps exactly such a backstore while the image streams — mapped as a
 * LUN only once the image is complete. The claims (every dataset, pool and AHR
 * verb) and the health read both start here.
 *
 * A LUN whose plugin could not be read from its symlink is matched by name
 * alone: the backstore is then counted as mapped, never reported as stray.
 * Returns `[]` when the live tree could not be listed in full — a mapping that
 * was not seen is not proof of none (the node is degraded for that already).
 */
export function unmappedLiveBackstores(ctx: IscsiReadContext): UnmappedBackstoreFacts[] {
  if (!ctx.live.present || liveUnreadablePaths(ctx).length > 0)
    return []
  const mapped = (name: string, plugin: string): boolean =>
    ctx.live.targets.some(t => t.tpgs.some(g => g.luns.some(l =>
      l.backstoreName === name && (l.plugin === null || normalizePlugin(l.plugin) === plugin))))
  const out: UnmappedBackstoreFacts[] = []
  for (const b of ctx.live.backstores) {
    const plugin = normalizePlugin(b.plugin)
    if (!b.udevPath || mapped(b.name, plugin))
      continue
    out.push({
      name: b.name,
      plugin,
      backingPath: b.udevPath,
      serial: b.serial,
      persisted: ctx.persistedUnreadable
        ? null
        : (ctx.persisted?.storageObjects ?? []).some(o => o.name === b.name && normalizePlugin(o.plugin) === plugin),
      classification: classifyBacking(b.udevPath, ctx.inputs, ctx.backing.get(b.udevPath)?.exists ?? null),
    })
  }
  return out
}

/**
 * Is this unmapped backstore ANAS's to report? Its backing resolves onto
 * storage ANAS manages (a zvol or an image on an ANAS dataset or AHR pool),
 * outside PVE's footprint — the same rule that makes a LUN's backing ANAS's
 * (`deriveOwnership`, rule 2). A backstore on a raw device, on PVE storage or
 * on storage that could not be judged is hands-off: still a claim, never a card.
 */
export function isAnasUnmappedBackstore(b: UnmappedBackstoreFacts): boolean {
  const c = b.classification
  return (c.kind === 'zvol' || c.kind === 'file') && !c.pveOwned && c.ownershipUnknown !== true
}

/** ` (TPG <n>)` for any TPG but the target's first — whose sentences stay as they were. */
function tpgClause(tag: number, firstTag: number): string {
  return tag === firstTag ? '' : ` (TPG ${tag})`
}

/** What the health diff needs beyond the gathered state. */
export interface IscsiHealthOptions {
  /** Timestamp for `checkedAt`; defaults to now. */
  now?: Date
  /**
   * Why an ANAS target is disabled, when something retained the reason
   * (live-proof F12). ANAS stores no state of its own to answer this, so the
   * caller supplies it from the job queue — the dashboard route does, the read
   * route does not, and both are honest.
   */
  disabledDetail?: (target: IscsiTargetDetail) => string | undefined
  /**
   * Stub LUNs already acted on in this pass, keyed by backing path. The
   * quarantine hands these back so the health it returns AFTER the tear-down
   * still says what was found and what was done — by the time it runs again the
   * stub is an ordinary missing LUN and the explanation would be gone.
   */
  quarantined?: Map<string, { quarantined: boolean, fileRemoved: boolean }>
  /**
   * cr3.lunrestore (review N5): the id of a whole-image restore job RUNNING
   * onto this backing path now, as the caller's job view says. A queued job
   * writes nothing and never counts. Every caller that reads marks passes it
   * (the health route, the dashboard): a mark with no running job is an
   * interrupted restore.
   */
  restoreRunning?: (backingPath: string) => string | undefined
  /**
   * cr3.lunrestore (review2 D): the retained failed restore onto a backing
   * that carries no mark (an image file), as the caller's job view says —
   * `restoreJobsOf(queue).restoreFailed`. Forgotten on a daemon restart.
   */
  restoreFailed?: RestoreJobFacts['restoreFailed']
  /**
   * cr3.lunrestore: the restore mark read for each zvol backing (by backing
   * path) — `readRestoreMarks`. Absent = marks were not read: no mark row.
   */
  marks?: Map<string, RestoreMarkRead>
}

/** The callbacks and reads a health READ passes through. */
export type IscsiHealthReadOptions = Pick<IscsiHealthOptions, 'disabledDetail' | 'restoreRunning' | 'restoreFailed'>

// The mark-state rules live with the mark (`restore-mark.ts`); re-exported for the readers.
export { restoreMarkDetail, restoreMarkState }

/**
 * Compute the health diff from a gathered context and the targets already built
 * from it. Pure — no reads of its own, so the routes pay for one gather.
 */
export function computeIscsiHealth(
  ctx: IscsiReadContext,
  targets: IscsiTargetDetail[],
  opts: IscsiHealthOptions = {},
): IscsiHealth {
  const now = opts.now ?? new Date()
  const missingLuns: IscsiMissingLun[] = []
  const targetsServingNothing: IscsiTargetServingNothing[] = []
  const portalsWithoutInterface: IscsiPortalWithoutInterface[] = []
  const foreignChanges: IscsiForeignChange[] = []
  const stubLuns: IscsiStubLun[] = []
  const disabledTargets: IscsiDisabledTarget[] = []

  const liveByIqn = new Map(ctx.live.targets.map(t => [t.iqn, t]))
  const persistedByIqn = new Map((ctx.persisted?.targets ?? []).map(t => [t.iqn, t]))
  const liveBackstoreNames = new Set(ctx.live.backstores.map(b => b.name))
  const persistedBackstores = new Map((ctx.persisted?.storageObjects ?? []).map(s => [s.name, s]))
  const liveUnreadable = liveUnreadablePaths(ctx)

  for (const target of targets) {
    // --- live/persisted divergences that are not a restore hole -------------
    if (!target.persisted && target.present) {
      foreignChanges.push({
        kind: 'target-not-persisted',
        targetIqn: target.iqn,
        detail: `Target ${target.iqn} is live but absent from the saved configuration — it will not come back after a reboot`,
      })
    }
    else if (target.persisted && !target.present) {
      foreignChanges.push({
        kind: 'target-not-restored',
        targetIqn: target.iqn,
        detail: `Target ${target.iqn} is in the saved configuration but is not live — the restore did not bring it up`,
      })
    }

    // EVERY TPG (cr3, ISCSI-H2): a hole in a second TPG is as much a hole as
    // one in the first — a save over it drops that LUN for good (GT-22) — so
    // the diff walks them all, each against its own tag on both sides.
    for (const tpg of targetTpgs(target)) {
      const persistedTpg = persistedByIqn.get(target.iqn)?.tpgs.find(t => t.tag === tpg.tpgTag)
      const liveTpg = liveByIqn.get(target.iqn)?.tpgs.find(t => t.tag === tpg.tpgTag)

      // --- LUNs in saveconfig with no configfs counterpart: the restore hole ---
      for (const lun of tpg.luns) {
        if (lun.present)
          continue
        // cr3: a target whose configfs could not be listed has LUNs nobody
        // SAW — not holes. Reporting them would point Repair at LUNs that may
        // be live; the node is degraded by `configfsUnreadable` instead.
        if ((target.configfsUnreadable ?? []).length > 0)
          continue
        // Only a PERSISTED LUN can be a restore hole. A LUN that is in neither
        // source cannot exist, and one that is live-only is a different finding.
        const persistedLun = persistedTpg?.luns.find(l => l.index === lun.index)
        if (!persistedLun)
          continue
        const backstore = persistedLun.backstoreName ? persistedBackstores.get(persistedLun.backstoreName) : undefined
        const backingPath = backstore?.dev ?? lun.backingPath
        missingLuns.push({
          targetIqn: target.iqn,
          tpgTag: tpg.tpgTag,
          lunIndex: lun.index,
          backstoreName: persistedLun.backstoreName ?? lun.name,
          plugin: normalizePlugin(backstore?.plugin ?? persistedLun.plugin ?? lun.plugin),
          backingPath,
          backingExists: lun.backingExists,
          // A hole whose path holds a placeholder is a DIFFERENT thing to fix, and
          // the quarantine is what turned it into a hole in the first place. The
          // fact is re-derived from the filesystem here, so it keeps being told
          // for as long as it is true and stops the moment it is not.
          ...(ctx.stubs.has(backingPath) ? { stubBacking: true } : {}),
          targetOwnership: target.ownership,
        })
      }

      // --- LUNs being served over a PLACEHOLDER (story iscsi.8) ---------------
      // Not a hole: the LUN is ACTIVATED, the right size, the right serial — and
      // full of zeros, because `targetctl restore` CREATED the backing file when
      // the filesystem that should hold it was not mounted (live-proof F2). The
      // verdict was reached during the build (it decides the LUN's kind); this
      // only reports it, with the numbers that produced it so the card can say
      // WHY rather than just that something is wrong.
      for (const lun of tpg.luns) {
        const facts = lun.backingPath ? ctx.stubs.get(lun.backingPath) : undefined
        if (!facts)
          continue
        // Only a LIVE LUN is serving anything, and only a live LUN can be
        // quarantined. Once one has been, its persisted record still resolves onto
        // the leftover placeholder — which keeps the LUN `unresolved` and keeps
        // Repair refusing (that is deliberate) — but it is a `missingLuns` hole
        // now, and re-reporting it here would have the quarantine chase a LUN that
        // is already gone on every single health read.
        if (!lun.present)
          continue
        const acted = opts.quarantined?.get(lun.backingPath)
        stubLuns.push({
          targetIqn: target.iqn,
          tpgTag: tpg.tpgTag,
          lunIndex: lun.index,
          backstoreName: lun.name,
          backingPath: lun.backingPath,
          persistedSize: facts.persistedSize,
          actualSize: facts.actualSize,
          containingMount: facts.containingMount,
          expectedMount: facts.expectedMount,
          zeroSized: facts.zeroSized,
          wrongMount: facts.wrongMount,
          ownership: target.ownership,
          quarantined: acted?.quarantined ?? false,
          fileRemoved: acted?.fileRemoved ?? false,
        })
      }

      // --- a TPG that restored with NONE of its LUNs (GT-21) ------------------
      // Worse in kind than the holes it is made of: the target is live, the TPG is
      // enabled and the portals are listening, so an initiator logs in
      // successfully and sees no disks at all. systemd reported success.
      {
        const persistedLuns = persistedTpg?.luns ?? []
        const liveLunCount = tpg.luns.filter(l => l.present).length
        if (target.present && persistedLuns.length > 0 && liveLunCount === 0) {
          targetsServingNothing.push({
            targetIqn: target.iqn,
            tpgTag: tpg.tpgTag,
            persistedLunCount: persistedLuns.length,
            enabled: tpg.enabled,
          })
        }
      }

      // --- portals bound to addresses no interface carries --------------------
      if (ctx.nodeAddresses !== null) {
        for (const portal of tpg.portals) {
          if (portal.carriedByInterface === false) {
            portalsWithoutInterface.push({
              targetIqn: target.iqn,
              tpgTag: tpg.tpgTag,
              address: portal.address,
              port: portal.port,
            })
          }
        }
      }

      if (persistedTpg && liveTpg) {
        const persistedLunIndexes = new Set(persistedTpg.luns.map(l => l.index))
        for (const lun of liveTpg.luns) {
          if (!persistedLunIndexes.has(lun.index)) {
            foreignChanges.push({
              kind: 'lun-not-persisted',
              targetIqn: target.iqn,
              detail: `LUN ${lun.index} (${lun.backstoreName ?? 'unnamed'}) of ${target.iqn}${tpgClause(tpg.tpgTag, target.tpgTag)} is live but not in the saved configuration — it will not come back after a reboot`,
            })
          }
        }

        const persistedPortals = new Set(persistedTpg.portals.map(p => `${p.address.toLowerCase()}:${p.port}`))
        const livePortals = new Set(liveTpg.portals.map(p => `${p.address.toLowerCase()}:${p.port}`))
        for (const p of liveTpg.portals) {
          if (!persistedPortals.has(`${p.address.toLowerCase()}:${p.port}`)) {
            foreignChanges.push({
              kind: 'portal-not-persisted',
              targetIqn: target.iqn,
              detail: `Portal ${p.address}:${p.port} of ${target.iqn}${tpgClause(tpg.tpgTag, target.tpgTag)} is live but not in the saved configuration`,
            })
          }
        }
        for (const p of persistedTpg.portals) {
          if (!livePortals.has(`${p.address.toLowerCase()}:${p.port}`)) {
            foreignChanges.push({
              kind: 'portal-not-restored',
              targetIqn: target.iqn,
              detail: `Portal ${p.address}:${p.port} of ${target.iqn}${tpgClause(tpg.tpgTag, target.tpgTag)} is in the saved configuration but is not live`,
            })
          }
        }
      }

      // --- a backstore whose live backing path no longer matches the saved one -
      for (const lun of tpg.luns) {
        if (!lun.name || !liveBackstoreNames.has(lun.name))
          continue
        const persisted = persistedBackstores.get(lun.name)
        if (persisted && persisted.dev !== lun.backingPath) {
          foreignChanges.push({
            kind: 'backing-path-changed',
            targetIqn: target.iqn,
            detail: `LUN ${lun.index} (${lun.name})${tpgClause(tpg.tpgTag, target.tpgTag)} is serving ${lun.backingPath} but the saved configuration says ${persisted.dev} — the next restore would use the saved path`,
          })
        }
      }
    }

    // --- an ANAS target whose TPG is disabled (live-proof F12) --------------
    // ANAS creates targets enabled; the only thing that turns one off is a
    // deliberate act — most often the image-restore door, which leaves a target
    // dark on purpose after a partial write and says so in a job that is
    // ephemeral by design. A foreign target's enable flag is not ANAS's
    // business (hands-off), and a target that is not live has nothing to serve
    // with either way.
    if (target.ownership === 'anas' && target.present && !target.enabled) {
      const detail = opts.disabledDetail?.(target)
      disabledTargets.push({
        targetIqn: target.iqn,
        tpgTag: target.tpgTag,
        lunCount: target.lunCount,
        ...(detail ? { detail } : {}),
      })
    }
  }

  // --- live backstores no LUN maps, on ANAS storage (cr3.lunrestore) -------
  // NOT degraded: no initiator sees a backstore that is not a TPG LUN, so
  // nothing is being served wrongly, and a save persists it as what it is —
  // a storage object with no LUN — which never becomes a restore hole.
  const restoreMarks: IscsiRestoreMarkRow[] = []
  const markRow = (backingPath: string, backstoreName: string, what: string, lun?: { targetIqn: string, tpgTag: number, lunIndex: number }): IscsiRestoreMarkState | null => {
    const read = opts.marks?.get(backingPath)
    const running = opts.restoreRunning?.(backingPath)
    // review2 D: a backing that carries no mark (an image file) is judged
    // from this daemon's job records — a running restore, or the retained
    // failed one (forgotten on a restart).
    const record = read?.state === 'unsupported' ? opts.restoreFailed?.(backingPath, lun?.targetIqn) : undefined
    const state = restoreMarkState(read, running, record)
    if (state === null || !read)
      return null
    const source = read.state === 'present' || read.state === 'unknown' ? 'mark' as const : 'job' as const
    const mark = read.state === 'present' ? read.mark : null
    const dataset = read.state === 'unsupported' ? null : read.dataset
    const job = state === 'in-progress' ? running : record?.job
    // review3 2: an image file a LUN serves, whose failed restore stands —
    // restoring it again in place needs the file at the image's length first.
    const again = record && lun && state !== 'in-progress' ? fileRestoreAgain(backingPath, record.imageBytes) : undefined
    restoreMarks.push({
      backingPath,
      dataset,
      backstoreName,
      ...(lun ?? {}),
      state,
      source,
      mark,
      ...(job ? { job } : {}),
      detail: restoreMarkDetail({ state, source, mark, ...(job ? { job } : {}), what, dataset, ...(again ? { again } : {}) }),
    })
    return state
  }
  if (opts.marks) {
    for (const target of targets) {
      for (const tpg of targetTpgs(target)) {
        for (const lun of tpg.luns) {
          if (lun.present && lun.backingPath)
            markRow(lun.backingPath, lun.name, `LUN ${lun.index} ('${lun.name}') of ${target.iqn}`, { targetIqn: target.iqn, tpgTag: tpg.tpgTag, lunIndex: lun.index })
        }
      }
    }
  }

  const unmappedBackstores: IscsiUnmappedBackstore[] = unmappedLiveBackstores(ctx)
    .filter(isAnasUnmappedBackstore)
    .map((b) => {
      const inFlight = opts.restoreRunning?.(b.backingPath)
      const marked = markRow(b.backingPath, b.name, `backstore '${b.name}'`)
      return {
        name: b.name,
        plugin: b.plugin,
        backingPath: b.backingPath,
        serial: b.serial,
        persisted: b.persisted,
        ...(inFlight ? { restoreInFlight: `job ${inFlight}` } : {}),
        ...(marked ? { restoreMark: marked } : {}),
      }
    })

  return {
    ...iscsiAvailability(ctx),
    missingLuns,
    targetsServingNothing,
    stubLuns,
    disabledTargets,
    portalsWithoutInterface,
    foreignChanges,
    unmappedBackstores,
    ...(opts.marks ? { restoreMarks } : {}),
    // A hole in the live config makes every `saveconfig` destructive (GT-22) —
    // and so does an ANAS-OWNED stub, for the same reason with the sign flipped:
    // the live tree is about to LOSE that LUN to the quarantine, and a save
    // taken in between would write the loss into saveconfig.json permanently.
    // A FOREIGN stub does NOT degrade the node (F1): the quarantine never acts
    // on it (issue #54), so it can never be about to lose a LUN to a save ANAS
    // takes — and blocking every ANAS-owned mutation node-wide while a foreign
    // placeholder ANAS will never touch sits there accomplishes nothing but a
    // dead end (Repair answers nothing-to-repair; only hand-targetcli escapes).
    // The stub is still REPORTED as a health card either way.
    // cr3 (ISCSI-L15): an unreadable saveconfig.json is a diff against
    // nothing — no hole can be SEEN, and a save would overwrite the file.
    // cr3 (review): only a zero-size placeholder is about to be taken offline;
    // a wrong-mount-only report holds data and is never acted on.
    degraded: missingLuns.length > 0 || stubLuns.some(s => s.ownership === 'anas' && s.zeroSized) || !!ctx.persistedUnreadable
      || liveUnreadable.length > 0,
    interfacesUnknown: ctx.nodeAddresses === null,
    ...(ctx.persistedUnreadable ? { saveconfigUnreadable: ctx.persistedUnreadable } : {}),
    ...(liveUnreadable.length > 0 ? { configfsUnreadable: liveUnreadable } : {}),
    checkedAt: now.toISOString(),
  }
}
