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

import type { IscsiDisabledTarget, IscsiForeignChange, IscsiHealth, IscsiMissingLun, IscsiPortalWithoutInterface, IscsiStubLun, IscsiTargetDetail, IscsiTargetServingNothing } from '@anas/shared'
import type { IscsiReadContext } from './iscsi.js'
import { iscsiAvailability, normalizePlugin } from './iscsi.js'

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
}

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

  for (const target of targets) {
    // --- LUNs in saveconfig with no configfs counterpart: the restore hole ---
    for (const lun of target.luns) {
      if (lun.present)
        continue
      // Only a PERSISTED LUN can be a restore hole. A LUN that is in neither
      // source cannot exist, and one that is live-only is a different finding.
      const persistedTpg = persistedByIqn.get(target.iqn)?.tpgs.find(t => t.tag === target.tpgTag)
      const persistedLun = persistedTpg?.luns.find(l => l.index === lun.index)
      if (!persistedLun)
        continue
      const backstore = persistedLun.backstoreName ? persistedBackstores.get(persistedLun.backstoreName) : undefined
      const backingPath = backstore?.dev ?? lun.backingPath
      missingLuns.push({
        targetIqn: target.iqn,
        tpgTag: target.tpgTag,
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
      })
    }

    // --- LUNs being served over a PLACEHOLDER (story iscsi.8) ---------------
    // Not a hole: the LUN is ACTIVATED, the right size, the right serial — and
    // full of zeros, because `targetctl restore` CREATED the backing file when
    // the filesystem that should hold it was not mounted (live-proof F2). The
    // verdict was reached during the build (it decides the LUN's kind); this
    // only reports it, with the numbers that produced it so the card can say
    // WHY rather than just that something is wrong.
    for (const lun of target.luns) {
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
        tpgTag: target.tpgTag,
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

    // --- a target that restored with NONE of its LUNs (GT-21) ---------------
    // Worse in kind than the holes it is made of: the target is live, the TPG is
    // enabled and the portals are listening, so an initiator logs in
    // successfully and sees no disks at all. systemd reported success.
    {
      const persistedLuns = persistedByIqn.get(target.iqn)?.tpgs.find(t => t.tag === target.tpgTag)?.luns ?? []
      const liveLunCount = target.luns.filter(l => l.present).length
      if (target.present && persistedLuns.length > 0 && liveLunCount === 0) {
        targetsServingNothing.push({
          targetIqn: target.iqn,
          tpgTag: target.tpgTag,
          persistedLunCount: persistedLuns.length,
          enabled: target.enabled,
        })
      }
    }

    // --- portals bound to addresses no interface carries --------------------
    if (ctx.nodeAddresses !== null) {
      for (const portal of target.portals) {
        if (portal.carriedByInterface === false) {
          portalsWithoutInterface.push({
            targetIqn: target.iqn,
            tpgTag: target.tpgTag,
            address: portal.address,
            port: portal.port,
          })
        }
      }
    }

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

    const persistedTpg = persistedByIqn.get(target.iqn)?.tpgs.find(t => t.tag === target.tpgTag)
    const liveTpg = liveByIqn.get(target.iqn)?.tpgs.find(t => t.tag === target.tpgTag)

    if (persistedTpg && liveTpg) {
      const persistedLunIndexes = new Set(persistedTpg.luns.map(l => l.index))
      for (const lun of liveTpg.luns) {
        if (!persistedLunIndexes.has(lun.index)) {
          foreignChanges.push({
            kind: 'lun-not-persisted',
            targetIqn: target.iqn,
            detail: `LUN ${lun.index} (${lun.backstoreName ?? 'unnamed'}) of ${target.iqn} is live but not in the saved configuration — it will not come back after a reboot`,
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
            detail: `Portal ${p.address}:${p.port} of ${target.iqn} is live but not in the saved configuration`,
          })
        }
      }
      for (const p of persistedTpg.portals) {
        if (!livePortals.has(`${p.address.toLowerCase()}:${p.port}`)) {
          foreignChanges.push({
            kind: 'portal-not-restored',
            targetIqn: target.iqn,
            detail: `Portal ${p.address}:${p.port} of ${target.iqn} is in the saved configuration but is not live`,
          })
        }
      }
    }

    // --- a backstore whose live backing path no longer matches the saved one -
    for (const lun of target.luns) {
      if (!lun.name || !liveBackstoreNames.has(lun.name))
        continue
      const persisted = persistedBackstores.get(lun.name)
      if (persisted && persisted.dev !== lun.backingPath) {
        foreignChanges.push({
          kind: 'backing-path-changed',
          targetIqn: target.iqn,
          detail: `LUN ${lun.index} (${lun.name}) is serving ${lun.backingPath} but the saved configuration says ${persisted.dev} — the next restore would use the saved path`,
        })
      }
    }
  }

  return {
    ...iscsiAvailability(ctx),
    missingLuns,
    targetsServingNothing,
    stubLuns,
    disabledTargets,
    portalsWithoutInterface,
    foreignChanges,
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
    degraded: missingLuns.length > 0 || stubLuns.some(s => s.ownership === 'anas'),
    interfacesUnknown: ctx.nodeAddresses === null,
    checkedAt: now.toISOString(),
  }
}
